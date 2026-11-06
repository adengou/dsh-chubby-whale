/**
 * scripts/test-chat-abort.mjs —— B94「错误分类 + 聊天链路客户端断连」专项回归
 * （离线、不联网、不起子进程；只起 127.0.0.1 的临时端口）
 *
 * 为什么单独建这个文件：`scripts/test.mjs` [23] 与 `test-chat-limits.mjs` 只覆盖
 * 「缓存 / 记忆写回 / 流式中断」，没有钉住 B93 取证出来的这两条：
 *   ① `http.ts` 的 isTimeoutError 把 AbortError 与 TimeoutError 混在一起，
 *      「客户端断开」与「上游超时」在 http 层与日志里分不开；
 *   ② 普通 /chat 压根没盯客户端断连：客户端 30s 硬超时先放弃，宿主仍把模型跑完、
 *      记账、写记忆（白烧 token）。
 * package.json 与 scripts/test.mjs 均未改，用 `node scripts/test-chat-abort.mjs` 单跑。
 *
 * 覆盖：
 *   A. host/http.ts 错误分类（旧语义不破）
 *      A1 isTimeoutError 仍是「TimeoutError 或 AbortError」（既有测试口径）
 *      A2/A3 isTimeoutOnly / isAbortError 互斥、只认自己那一类
 *      A4 reason 被包一层时也能认（{name:'Error', reason:{name:'TimeoutError'}}）
 *      A5 真实 AbortSignal 的 reason.name：timeout → TimeoutError，手动 abort → AbortError
 *      A6 真实 fetch（本地不响应端点）：内部超时是 TimeoutError、外部 abort 是 AbortError，
 *         且 AbortSignal.any 与手写兜底两条路径都能区分
 *   B. /chat 正常路径不被误伤
 *      B1 正常请求（body 读完的 req close，complete=true）→ 不 abort、照常记账
 *      B2 正常结束的 res close（writableFinished=true）→ 不 abort、不产生 CLIENT-ABORT
 *      B3 上游超时（客户端还在）→ 仍是 error=timeout + CHAT-TIMEOUT，不是客户端断连
 *   C. /chat 客户端断连 → 立刻中止外呼、半截不入记忆
 *      C1 res close（响应没写完）→ 1s 内 abort、不回包、日志是 CHAT-CLIENT-ABORT
 *      C2 同一句重发 → 必须重新外呼（断连那次没留下缓存/记忆）
 *      C3 req aborted（body 读完但连接断）同样中止
 *      C4 请求体没收完就断（complete=false + ECONNRESET）→ 不外呼、不回包、不算上游失败
 *      C5 断开后 req/res 监听摘干净
 *      C6 语义决策：回复已完整生成（上游先返回）只是客户端走了 → 仍写记忆/记鱼粮
 *   D. /chat-stream 断连中止 + 半截不入记忆
 *      D1 正常流：done 帧、记账、写缓存、无 CLIENT-ABORT
 *      D2 上游半截抛错（客户端还在）：error 帧、无 done、不记账
 *      D3 客户端 res close（流读取途中）→ 立刻 abort、无 done、不记账、不回 error 帧
 *      D4 req aborted（流读取途中）→ 同样中止（基线只认 res close）
 *      D5 结束/断连后监听不残留
 *   E. 真实 socket 端到端 /chat：正常请求不被误 abort；客户端 destroy 后宿主外呼被 abort
 *
 * 负向验证（本批实测记录，见文件尾注释）：把 src/host/http.ts 与两条 chat 路由回退到基线
 * e9cd3c4 后单跑本文件，A2/A3/A4、C1~C4、C6、D3(日志/回帧)、D4、E2 全部失败；恢复改动后全过。
 *
 * 用法：node scripts/test-chat-abort.mjs
 * 退出码：0 = 全过；1 = 有失败
 */
import { register } from 'node:module'
import { getEventListeners } from 'node:events'
import http from 'node:http'

// 源码跨模块 import 写的是 `.js`，源码是 `.ts`：测试进程里注册解析钩子（与其它 test-*.mjs 同一套）
register(new URL('./ts-resolve.mjs', import.meta.url))

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else {
    fail++
    failures.push(name + (detail ? '  ' + detail : ''))
    console.log('  ❌ ' + name + (detail ? '  ' + detail : ''))
  }
}
function group(title) { console.log('\n' + title) }
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 2000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await tick(5)
  }
  return false
}
/** 把 promise 收口成「是否在 ms 内结束」，避免用例挂住 */
async function settlesWithin(p, ms) {
  const r = await Promise.race([Promise.resolve(p).then(() => true, () => true), tick(ms).then(() => false)])
  return r
}

// ---------- 假 req / res：形状与 Node 24 实测一致（同 test-asr-abort.mjs） ----------
function mkEmitter(base = {}) {
  const ls = new Map()
  const e = Object.assign(base, {
    on(ev, fn) { if (!ls.has(ev)) ls.set(ev, []); ls.get(ev).push(fn); return e },
    removeListener(ev, fn) { const a = ls.get(ev) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); return e },
    listenerCount(ev) { return (ls.get(ev) || []).length },
    emit(ev) { for (const fn of Array.from(ls.get(ev) || [])) fn() },
  })
  return e
}

/**
 * 假请求。默认照 Node 24 实测：**请求体读完时 req 立刻发 close**（complete=true）——
 * 这是「只看 close 就会把正常请求误判断连」的那个坑。
 * throwMidBody：请求体没收完客户端就断（先 aborted、complete=false，再抛 ECONNRESET）。
 */
function mkReq(body, opts = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  const req = mkEmitter({
    headers: Object.assign({ 'content-length': String(buf.length) }, opts.headers || {}),
    complete: opts.complete !== undefined ? opts.complete : true,
    destroy() { },
    resume() { },
    async *[Symbol.asyncIterator]() {
      if (opts.throwMidBody) {
        req.complete = false
        req.emit('aborted')
        const e = new Error('aborted')
        e.code = 'ECONNRESET'
        throw e
      }
      yield buf
      req.emit('close')
    },
  })
  return req
}

/** 假响应（JSON 路由）：像 Node 一样维护 headersSent / writableEnded / writableFinished，end 时发 close */
function mkJsonRes() {
  const out = mkEmitter({
    code: 0,
    headers: {},
    chunks: [],
    headersSent: false,
    writableEnded: false,
    writableFinished: false,
  })
  out.writeHead = (c, h) => { out.code = c; out.headers = h || {}; out.headersSent = true }
  out.end = (b) => {
    if (b) out.chunks.push(Buffer.isBuffer(b) ? b : Buffer.from(String(b)))
    out.writableEnded = true
    out.writableFinished = true
    out.emit('close')
  }
  out.setHeader = (k, v) => { out.headers[k] = v }
  out.text = () => Buffer.concat(out.chunks).toString('utf8')
  out.json = () => { try { return JSON.parse(out.text()) } catch { return null } }
  return out
}

/** 假响应（SSE 路由）：记录帧、可手动 emit close */
function mkSseRes() {
  const out = mkEmitter({
    code: 200,
    chunks: [],
    headersSent: false,
    writableEnded: false,
    writableFinished: false,
  })
  out.writeHead = (c, h) => { out.code = c; out.headers = h || {}; out.headersSent = true }
  out.write = (chunk) => { out.chunks.push(String(chunk)); return true }
  out.end = (chunk) => { if (chunk !== undefined) out.chunks.push(String(chunk)); out.writableEnded = true; out.writableFinished = true }
  out.setHeader = () => { }
  out.flushHeaders = () => { }
  out.raw = () => out.chunks.join('')
  out.events = () => out.raw().split('\n\n').map((block) => {
    const line = block.split('\n').find((x) => x.startsWith('data: '))
    if (!line) return null
    try { return JSON.parse(line.slice(6)) } catch { return null }
  }).filter(Boolean)
  return out
}

// ---------- 端口替身（记账探针） ----------
function mkLedger(over = {}) {
  const L = {
    state: { intimacy: Number(over.intimacy ?? 0) },
    loads: 0,
    saves: [],
    exp: [],
    tokens: [],
    turns: [],
    replies: 0,
    history: [],
    summary: '',
  }
  const cache = {
    sets: [], reads: [],
    async getJson(key) { cache.reads.push(key); return null },
    async setJson(key, value) { cache.sets.push({ key, value }) },
    memGet() { return undefined },
    memSet() { },
    async clear() { return 0 },
    async count() { return cache.sets.length },
  }
  L.cache = cache
  L.deps = Object.assign({
    getKey: () => 'test-key',
    loadHistory: () => L.history.slice(),
    appendTurns: (u, r) => { L.turns.push([u, r]) },
    loadState: () => { L.loads += 1; return L.state },
    saveState: (s) => { L.saves.push(s); L.state = s },
    systemPrompt: 'SYS',
    addExp: (n, source) => { L.exp.push([n, source]); return { upgraded: false, exp: Number(n) || 0 } },
    addTokens: (kind, n) => { L.tokens.push([kind, n]) },
    cache,
    loadMemorySummary: () => L.summary,
    saveMemorySummary: (s) => { L.summary = s },
    cacheEnabled: () => true,
    model: 'deepseek-flash',
    onReply: () => { L.replies += 1 },
  }, over.deps || {})
  return L
}

// ---------- 上游 fetch 桩 ----------
const REPLY = '主人，本鱼吃白饭去啦'
const USAGE = 13
const MESSAGE = '主人今天吃了几碗白饭呀'
const realFetch = globalThis.fetch
const UP = { calls: [], queue: [], manual: null }
function setPlan(...plan) { UP.queue = plan }
function resetUp() { UP.calls.length = 0; UP.queue = []; UP.manual = null }
/** 真实 fetch 的拒绝原因：signal.reason（可能是 TimeoutError DOMException），没有就补 AbortError */
function reasonOf(sig) {
  const reason = sig && sig.reason
  if (reason && typeof reason.name === 'string') return reason
  const e = new Error('This operation was aborted')
  e.name = 'AbortError'
  return e
}
function jsonBody(reply = REPLY) {
  return JSON.stringify({ choices: [{ message: { content: reply } }], usage: { total_tokens: USAGE } })
}
function sseOf(pieces) {
  const usage = 'data: ' + JSON.stringify({ choices: [], usage: { total_tokens: USAGE } }) + '\n\n'
  return pieces.map((p) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: p } }] }) + '\n\n').join('') + usage + 'data: [DONE]\n\n'
}

globalThis.fetch = (url, init = {}) => {
  const sig = init.signal
  const call = { url: String(url), signal: sig, body: init.body }
  UP.calls.push(call)
  const plan = UP.queue.length ? UP.queue.shift() : { mode: 'json' }
  if (plan.mode === 'pending' || plan.mode === 'manualNoAbort') {
    return new Promise((resolve, reject) => {
      UP.manual = { resolve, reject, call }
      if (plan.mode === 'pending' && sig) {
        const onAbort = () => reject(reasonOf(sig))
        if (sig.aborted) { onAbort(); return }
        sig.addEventListener('abort', onAbort, { once: true })
      }
    })
  }
  if (plan.mode === 'timeout') {
    const e = new Error('The operation was aborted due to timeout')
    e.name = 'TimeoutError'
    return Promise.reject(e)
  }
  if (plan.mode === 'sse') {
    return Promise.resolve(new Response(plan.body || sseOf(['你好', '呀']), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))
  }
  if (plan.mode === 'reader') {
    return Promise.resolve({
      ok: true,
      status: 200,
      body: { getReader: () => plan.reader(sig) },
    })
  }
  if (plan.mode === 'http') {
    return Promise.resolve({ ok: false, status: plan.status, text: async () => 'busy' })
  }
  const text = jsonBody(plan.reply)
  return Promise.resolve({ ok: true, status: 200, text: async () => text })
}

const H = await import('../src/host/http.ts')
const { fetchWithTimeout, fetchJson, isTimeoutError } = H
// 没有这两个导出时用「恒 false」占位：A2/A3/A4 会因此判负，但整轮用例还能跑完（负向验证要看 C/E 的失败）
const isAbortError = typeof H.isAbortError === 'function' ? H.isAbortError : () => false
const isTimeoutOnly = typeof H.isTimeoutOnly === 'function' ? H.isTimeoutOnly : () => false
const { createChatHandler } = await import('../src/host/routes/chat.ts')
const { createChatStreamHandler } = await import('../src/host/routes/chat-stream.ts')

// 收集日志（断言「断连有专用诊断、不被当成上游失败」）
const logs = []
const origError = console.error
console.error = (...a) => logs.push(a.join(' '))

// AbortSignal.timeout 的定时器是 unref 的：只挂 unref 定时器时事件循环会空掉，用 ref 的定时器吊住
const keepAlive = setInterval(() => { }, 1000)

try {
  // ======================================================================
  // A. host/http.ts：错误分类
  // ======================================================================
  group('[A] host/http.ts：timeout 与 abort 可区分（旧 isTimeoutError 语义不变）')
  {
    ok('A0 host/http.ts 导出 isAbortError / isTimeoutOnly（区分能力的入口）',
      typeof H.isAbortError === 'function' && typeof H.isTimeoutOnly === 'function')
    ok('A1 isTimeoutError 旧口径不变：TimeoutError 与 AbortError 都算',
      isTimeoutError({ name: 'TimeoutError' }) && isTimeoutError({ name: 'AbortError' }) && !isTimeoutError({ name: 'TypeError' }))
    ok('A2 isTimeoutOnly：只认 TimeoutError', isTimeoutOnly({ name: 'TimeoutError' }) === true
      && isTimeoutOnly({ name: 'AbortError' }) === false && isTimeoutOnly(new Error('x')) === false
      && isTimeoutOnly(null) === false)
    ok('A3 isAbortError：只认 AbortError', isAbortError({ name: 'AbortError' }) === true
      && isAbortError({ name: 'TimeoutError' }) === false && isAbortError(new Error('x')) === false
      && isAbortError(undefined) === false)
    ok('A4 reason 被包一层也能认（原因转发不是被吞掉）',
      isTimeoutOnly({ name: 'Error', reason: { name: 'TimeoutError' } }) === true
      && isAbortError({ name: 'Error', reason: { name: 'AbortError' } }) === true
      && isAbortError({ name: 'Error', reason: { name: 'TimeoutError' } }) === false)

    // A5：真实 AbortSignal 的 reason（要等它真的到点，不然 reason 还是 undefined）
    const tSig = AbortSignal.timeout(5)
    await new Promise((r) => tSig.addEventListener('abort', r, { once: true }))
    const tReason = tSig.reason
    const ctlR = new AbortController()
    ctlR.abort()
    ok('A5 AbortSignal.timeout 的 reason.name = TimeoutError', !!tReason && tReason.name === 'TimeoutError', String(tReason && tReason.name))
    ok('A5 手动 abort 的 reason.name = AbortError', ctlR.signal.reason && ctlR.signal.reason.name === 'AbortError', String(ctlR.signal.reason && ctlR.signal.reason.name))

    // A6：真实 fetch（本地不响应端点）+ 两条组合路径。注意这里要临时换回真 fetch（下面的用例要用桩）
    const stubFetch = globalThis.fetch
    const hang = http.createServer(() => { /* 永不响应 */ })
    await new Promise((r) => hang.listen(0, '127.0.0.1', r))
    const hangPort = hang.address().port
    const hangUrl = 'http://127.0.0.1:' + hangPort + '/hang'
    try {
      globalThis.fetch = realFetch
      resetUp()
      const e1 = await fetchWithTimeout(hangUrl, {}, 60).then(() => null, (e) => e)
      ok('A6 真实 fetch 内部超时 → TimeoutError（isTimeoutOnly 认、isAbortError 不认）',
        !!e1 && e1.name === 'TimeoutError' && isTimeoutOnly(e1) && !isAbortError(e1), String(e1 && e1.name))

      const ctl1 = new AbortController()
      const p2 = fetchWithTimeout(hangUrl, {}, 5000, ctl1.signal)
      await tick(30)
      ctl1.abort()
      const e2 = await p2.then(() => null, (e) => e)
      ok('A6 真实 fetch 外部 abort → AbortError（isAbortError 认、isTimeoutOnly 不认）',
        !!e2 && e2.name === 'AbortError' && isAbortError(e2) && !isTimeoutOnly(e2), String(e2 && e2.name))

      const ctl2 = new AbortController()
      const p3 = fetchJson(hangUrl, {}, 5000, ctl2.signal)
      await tick(30)
      ctl2.abort()
      const e3 = await p3.then(() => null, (e) => e)
      ok('A6 fetchJson 第 4 个参数 signal：外部 abort 仍是 AbortError', !!e3 && e3.name === 'AbortError' && isAbortError(e3), String(e3 && e3.name))

      // 手写兜底路径（没有 AbortSignal.any 的老运行时）：reason 必须原样转发，超时不能退化成 AbortError
      const anyDesc = Object.getOwnPropertyDescriptor(AbortSignal, 'any')
      Object.defineProperty(AbortSignal, 'any', { value: undefined, writable: true, configurable: true })
      try {
        const e4 = await fetchWithTimeout(hangUrl, {}, 80).then(() => null, (e) => e)
        ok('A6 兜底路径：内部超时仍是 TimeoutError（不会退化成 AbortError）',
          !!e4 && e4.name === 'TimeoutError' && isTimeoutOnly(e4) && !isAbortError(e4), String(e4 && e4.name))

        const ctl3 = new AbortController()
        const p5 = fetchWithTimeout(hangUrl, {}, 5000, ctl3.signal)
        await tick(30)
        ctl3.abort()
        const e5 = await p5.then(() => null, (e) => e)
        ok('A6 兜底路径：外部 abort 仍是 AbortError（reason 转发）',
          !!e5 && e5.name === 'AbortError' && isAbortError(e5) && !isTimeoutOnly(e5), String(e5 && e5.name))
      } finally {
        if (anyDesc) Object.defineProperty(AbortSignal, 'any', anyDesc)
      }
    } finally {
      globalThis.fetch = stubFetch
      try { hang.closeAllConnections() } catch { }
      await new Promise((r) => hang.close(r))
    }
  }

  // ======================================================================
  // B. /chat 正常路径不被误伤
  // ======================================================================
  group('[B] /chat 正常路径：不误 abort，既有记账语义不变')
  {
    // B1：正常请求（req close complete=true、res close writableFinished=true）
    resetUp(); setPlan({ mode: 'pending' })
    logs.length = 0
    const L = mkLedger()
    const req = mkReq({ message: MESSAGE })
    const res = mkJsonRes()
    const running = createChatHandler(L.deps)(req, res)
    ok('B1 前置：上游外呼已发出', await waitFor(() => UP.calls.length === 1), 'calls=' + UP.calls.length)
    ok('B1 正常请求：外呼 signal 没有被中止', UP.calls[0] && UP.calls[0].signal.aborted === false)
    UP.manual.resolve({ ok: true, status: 200, text: async () => jsonBody() })
    await running
    ok('B1 正常请求：200 + 回复', res.json() && res.json().ok === true && res.json().reply === REPLY, res.text().slice(0, 80))
    ok('B1 正常请求：照常写记忆 / 记鱼粮 / 加经验',
      L.turns.length === 1 && L.tokens.length === 1 && L.exp.length === 1, 'turns=' + L.turns.length + ' tokens=' + L.tokens.length)
    ok('B1 正常请求：不产生 CHAT-CLIENT-ABORT 日志', !logs.some((l) => l.includes('CHAT-CLIENT-ABORT')), JSON.stringify(logs))

    // B2：响应已写完的 res close（writableFinished=true）→ 不许 abort
    resetUp(); setPlan({ mode: 'pending' })
    logs.length = 0
    const L2 = mkLedger()
    const res2 = mkJsonRes()
    const running2 = createChatHandler(L2.deps)(mkReq({ message: MESSAGE + '二' }), res2)
    await waitFor(() => UP.calls.length === 1)
    res2.writableEnded = true
    res2.writableFinished = true
    res2.emit('close')
    await tick(10)
    ok('B2 已写完响应的 res close：不被当成断连（外呼没被 abort）', UP.calls[0].signal.aborted === false)
    UP.manual.resolve({ ok: true, status: 200, text: async () => jsonBody() })
    await running2
    ok('B2 之后照常记账、不产生 CLIENT-ABORT 日志',
      L2.turns.length === 1 && !logs.some((l) => l.includes('CHAT-CLIENT-ABORT')), JSON.stringify(logs))

    // B3：上游超时（客户端还在）→ 仍是 timeout，不许说成客户端断开
    resetUp(); setPlan({ mode: 'timeout' })
    logs.length = 0
    const L3 = mkLedger()
    const res3 = mkJsonRes()
    await createChatHandler(L3.deps)(mkReq({ message: MESSAGE + '三' }), res3)
    ok('B3 上游超时（客户端未断）：error=timeout + CHAT-TIMEOUT 日志',
      res3.json() && res3.json().ok === false && res3.json().error === 'timeout'
      && logs.some((l) => l.includes('CHAT-TIMEOUT')), JSON.stringify(logs))
    ok('B3 超时不算客户端断连：无 CHAT-CLIENT-ABORT 日志', !logs.some((l) => l.includes('CHAT-CLIENT-ABORT')))
    ok('B3 超时不写记忆、不记鱼粮', L3.turns.length === 0 && L3.tokens.length === 0)
  }

  // ======================================================================
  // C. /chat 客户端断连 → 立刻中止外呼
  // ======================================================================
  group('[C] /chat 客户端断连：立刻中止外呼 / 半截不入记忆')
  {
    // C1：客户端发完 body 就断（res close，writableFinished=false）
    resetUp(); setPlan({ mode: 'pending' })
    logs.length = 0
    const L = mkLedger()
    const res = mkJsonRes()
    const running = createChatHandler(L.deps)(mkReq({ message: MESSAGE }), res)
    ok('C1 前置：外呼已经发出', await waitFor(() => UP.calls.length === 1), 'calls=' + UP.calls.length)
    const call = UP.calls[0]
    ok('C1 前置：外呼在等上游（signal 未中止）', call.signal.aborted === false)
    res.emit('close')
    const settled = await settlesWithin(running, 1000)
    ok('C1 客户端断开 → 外呼在 1s 内 abort（不是跑满 30s 才超时）',
      settled === true && call.signal.aborted === true, 'settled=' + settled + ' aborted=' + call.signal.aborted)
    ok('C1 断开后不回包（连接已断，没人收）', res.code === 0 && res.chunks.length === 0, 'code=' + res.code)
    ok('C1 日志是专用诊断 CHAT-CLIENT-ABORT', logs.some((l) => l.includes('CHAT-CLIENT-ABORT')), JSON.stringify(logs))
    ok('C1 不被记成上游超时/网络失败',
      !logs.some((l) => l.includes('CHAT-TIMEOUT') || l.includes('CHAT-NETWORK')), JSON.stringify(logs))
    ok('C1 半截回复不入记忆：不 appendTurns / 不记鱼粮 / 不加经验 / 不动亲密度 / 不写缓存',
      L.turns.length === 0 && L.tokens.length === 0 && L.exp.length === 0 && L.saves.length === 0 && L.cache.sets.length === 0,
      'turns=' + L.turns.length + ' tokens=' + L.tokens.length + ' saves=' + L.saves.length + ' cache=' + L.cache.sets.length)

    // C2：同一句重发必须重新外呼（断连那次没留下半截缓存/记忆）
    resetUp(); setPlan({ mode: 'json' })
    const res2 = mkJsonRes()
    await createChatHandler(L.deps)(mkReq({ message: MESSAGE }), res2)
    ok('C2 同句重发：重新外呼（没有被断连那次的缓存吞掉）',
      UP.calls.length === 1 && res2.json() && res2.json().ok === true, 'calls=' + UP.calls.length)
    ok('C2 重发这次正常记账/写缓存', L.turns.length === 1 && L.cache.sets.length === 1,
      'turns=' + L.turns.length + ' cache=' + L.cache.sets.length)

    // C3：req 'aborted'（body 读完但连接断）也是断连
    resetUp(); setPlan({ mode: 'pending' })
    logs.length = 0
    const L3 = mkLedger()
    const res3 = mkJsonRes()
    const req3 = mkReq({ message: MESSAGE + '三' })
    const running3 = createChatHandler(L3.deps)(req3, res3)
    await waitFor(() => UP.calls.length === 1)
    req3.emit('aborted')
    const settled3 = await settlesWithin(running3, 1000)
    ok('C3 req aborted → 1s 内 abort、不回包、日志是 CHAT-CLIENT-ABORT、不记账',
      settled3 === true && UP.calls[0].signal.aborted === true && res3.code === 0
      && logs.some((l) => l.includes('CHAT-CLIENT-ABORT')) && L3.turns.length === 0,
      'settled=' + settled3 + ' aborted=' + UP.calls[0].signal.aborted + ' ' + JSON.stringify(logs))

    // C4：请求体没收完就断（complete=false + ECONNRESET）→ 根本不外呼、不回包
    resetUp(); setPlan({ mode: 'json' })
    logs.length = 0
    const L4 = mkLedger()
    const res4 = mkJsonRes()
    await createChatHandler(L4.deps)(mkReq({ message: MESSAGE }, { throwMidBody: true }), res4)
    ok('C4 请求体没收完就断：一个上游请求都不发', UP.calls.length === 0, 'calls=' + UP.calls.length)
    ok('C4 不回包、不算上游失败（日志 CHAT-CLIENT-ABORT，不是 CHAT-NETWORK）',
      res4.code === 0 && logs.some((l) => l.includes('CHAT-CLIENT-ABORT')) && !logs.some((l) => l.includes('CHAT-NETWORK')),
      'code=' + res4.code + ' ' + JSON.stringify(logs))

    // C5：监听不跨请求残留
    resetUp(); setPlan({ mode: 'json' })
    const L5 = mkLedger()
    const req5 = mkReq({ message: MESSAGE + '五' })
    const res5 = mkJsonRes()
    await createChatHandler(L5.deps)(req5, res5)
    ok('C5 请求结束：req/res 上的 close/aborted 监听全部摘掉',
      req5.listenerCount('close') === 0 && req5.listenerCount('aborted') === 0 && res5.listenerCount('close') === 0,
      'req.close=' + req5.listenerCount('close') + ' req.aborted=' + req5.listenerCount('aborted') +
      ' res.close=' + res5.listenerCount('close'))

    // C6：语义决策——回复已完整生成、只是回不去 → 记账是对的（不因客户端走了而丢掉已付费的完整回复）。
    // 造法：上游 promise 在 abort 之后才 resolve（真实世界对应「响应已经在路上，abort 晚到一步」），
    // fetchJson 拿到的是完整回复 → 走正常收尾。
    resetUp(); setPlan({ mode: 'manualNoAbort' })
    logs.length = 0
    const L6 = mkLedger()
    const res6 = mkJsonRes()
    const running6 = createChatHandler(L6.deps)(mkReq({ message: MESSAGE + '六' }), res6)
    await waitFor(() => UP.calls.length === 1 && !!UP.manual)
    res6.emit('close')
    await tick(10)
    UP.manual.resolve({ ok: true, status: 200, text: async () => jsonBody() })
    const settled6 = await settlesWithin(running6, 1500)
    ok('C6 完整回复只是回不去：仍然写记忆 + 记鱼粮（已付费的完整回复不浪费）',
      settled6 === true && L6.turns.length === 1 && L6.tokens.length === 1,
      'settled=' + settled6 + ' turns=' + L6.turns.length + ' tokens=' + L6.tokens.length)
  }

  // ======================================================================
  // D. /chat-stream：断连中止 + 半截不入记忆
  // ======================================================================
  group('[D] /chat-stream：断连中止 / 半截不入记忆 / 正常结束不误中止')
  {
    // D1：正常流
    resetUp(); setPlan({ mode: 'sse', body: sseOf(['你好', '呀']) })
    logs.length = 0
    const L1 = mkLedger()
    const res1 = mkSseRes()
    await createChatStreamHandler(L1.deps)(mkReq({ message: MESSAGE }), res1)
    const ev1 = res1.events()
    ok('D1 正常流：done 帧 + 记忆 + 鱼粮 + 缓存',
      ev1.some((e) => e.done === true) && L1.turns.length === 1 && L1.tokens.length === 1 && L1.cache.sets.length === 1,
      'turns=' + L1.turns.length + ' tokens=' + L1.tokens.length + ' cache=' + L1.cache.sets.length)
    ok('D1 正常流：无 CLIENT-ABORT 日志', !logs.some((l) => l.includes('CHAT-CLIENT-ABORT')), JSON.stringify(logs))

    // D2：上游半截抛错（客户端还在）
    const enc = new TextEncoder()
    let reads = 0
    resetUp(); setPlan({
      mode: 'reader',
      reader: () => ({
        async read() {
          reads += 1
          if (reads === 1) return { value: enc.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: '半截' } }] }) + '\n\n'), done: false }
          throw new Error('upstream reset')
        },
        releaseLock() { },
      }),
    })
    logs.length = 0
    const L2 = mkLedger()
    const res2 = mkSseRes()
    await createChatStreamHandler(L2.deps)(mkReq({ message: MESSAGE + '二' }), res2)
    const ev2 = res2.events()
    ok('D2 上游半截：delta 已推送、无 done、回 stream: error 帧',
      ev2.some((e) => e.delta === '半截') && !ev2.some((e) => e.done === true) && ev2.some((e) => /^stream:/.test(String(e.error))),
      JSON.stringify(ev2))
    ok('D2 上游半截：不写记忆/鱼粮/缓存', L2.turns.length === 0 && L2.tokens.length === 0 && L2.cache.sets.length === 0)

    // D3：客户端在流读取途中 close（上游尊重 abort：pending read 在 abort 时 reject）
    resetUp(); setPlan({
      mode: 'reader',
      reader: (sig) => {
        let served = false
        return {
          read() {
            if (!served) {
              served = true
              return Promise.resolve({ value: enc.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: '你好' } }] }) + '\n\n'), done: false })
            }
            return new Promise((resolve, reject) => {
              if (!sig) return
              if (sig.aborted) { reject(reasonOf(sig)); return }
              sig.addEventListener('abort', () => reject(reasonOf(sig)), { once: true })
            })
          },
          releaseLock() { },
        }
      },
    })
    logs.length = 0
    const L3 = mkLedger()
    const res3 = mkSseRes()
    const running = createChatStreamHandler(L3.deps)(mkReq({ message: MESSAGE + '三' }), res3)
    await waitFor(() => UP.calls.length === 1 && res3.chunks.some((c) => c.includes('你好')), 2000)
    const call = UP.calls[0]
    res3.emit('close')
    const settled = await settlesWithin(running, 1500)
    const ev3 = res3.events()
    ok('D3 客户端断连（流读取途中）→ 外呼 1s 内 abort', settled === true && call.signal.aborted === true,
      'settled=' + settled + ' aborted=' + call.signal.aborted)
    ok('D3 断连：无 done 帧、不写记忆/鱼粮/缓存、不 onReply',
      !ev3.some((e) => e.done === true) && L3.turns.length === 0 && L3.tokens.length === 0
      && L3.cache.sets.length === 0 && L3.replies === 0)
    ok('D3 日志是专用诊断 CHAT-CLIENT-ABORT，不是上游故障/超时',
      logs.some((l) => l.includes('CHAT-CLIENT-ABORT')) && !logs.some((l) => l.includes('CHAT-NETWORK')),
      JSON.stringify(logs))
    ok('D3 断连后不再往死连接写 error 帧（没人收）', !ev3.some((e) => /^stream:/.test(String(e.error))), JSON.stringify(ev3))

    // D4：req 'aborted'（流读取途中）也要中止——基线只认 res close
    resetUp(); setPlan({
      mode: 'reader',
      reader: (sig) => {
        let served = false
        return {
          read() {
            if (!served) {
              served = true
              return Promise.resolve({ value: enc.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: '你好' } }] }) + '\n\n'), done: false })
            }
            return new Promise((resolve, reject) => {
              if (!sig) return
              if (sig.aborted) { reject(reasonOf(sig)); return }
              sig.addEventListener('abort', () => reject(reasonOf(sig)), { once: true })
            })
          },
          releaseLock() { },
        }
      },
    })
    logs.length = 0
    const L4 = mkLedger()
    const req4 = mkReq({ message: MESSAGE + '四' })
    const res4 = mkSseRes()
    const running4 = createChatStreamHandler(L4.deps)(req4, res4)
    await waitFor(() => UP.calls.length === 1 && res4.chunks.some((c) => c.includes('你好')), 2000)
    req4.emit('aborted')
    const settled4 = await settlesWithin(running4, 1500)
    ok('D4 req aborted（流读取途中）→ 外呼中止、不记账、日志 CHAT-CLIENT-ABORT',
      settled4 === true && UP.calls[0].signal.aborted === true && L4.turns.length === 0
      && logs.some((l) => l.includes('CHAT-CLIENT-ABORT')),
      'settled=' + settled4 + ' aborted=' + UP.calls[0].signal.aborted + ' ' + JSON.stringify(logs))

    // D5：监听不残留
    resetUp(); setPlan({ mode: 'sse', body: sseOf(['好']) })
    const L5 = mkLedger()
    const req5 = mkReq({ message: MESSAGE + '五' })
    const res5 = mkSseRes()
    await createChatStreamHandler(L5.deps)(req5, res5)
    ok('D5 正常流结束：req/res 上的 close/aborted 监听全部摘掉',
      req5.listenerCount('close') === 0 && req5.listenerCount('aborted') === 0 && res5.listenerCount('close') === 0,
      'req.close=' + req5.listenerCount('close') + ' req.aborted=' + req5.listenerCount('aborted') +
      ' res.close=' + res5.listenerCount('close'))
  }

  // ======================================================================
  // E. 真实 socket 端到端
  // ======================================================================
  group('[E] 真实 socket 端到端 /chat：正常不误 abort；客户端 destroy 后外呼被 abort')
  {
    resetUp(); setPlan({ mode: 'json' })
    logs.length = 0
    const L = mkLedger()
    const handle = createChatHandler(L.deps)
    const server = http.createServer((req, res) => { Promise.resolve(handle(req, res)).catch(() => { }) })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const port = server.address().port
    const post = (message, ms = 4000) => new Promise((resolve) => {
      const body = Buffer.from(JSON.stringify({ message }))
      let settled = false
      const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v) } }
      const timer = setTimeout(() => done({ err: 'timeout' }), ms)
      const req = http.request({
        host: '127.0.0.1', port, path: '/chat', method: 'POST', agent: false,
        headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
      }, (r) => {
        let b = ''
        r.setEncoding('utf8')
        r.on('data', (d) => { b += d })
        r.on('end', () => done({ status: r.statusCode, body: b }))
        r.on('error', (e) => done({ err: e.code || e.message }))
      })
      req.on('error', (e) => done({ err: e.code || e.message }))
      req.end(body)
    })

    const normal = await post(MESSAGE + '真实')
    ok('E1 真实 socket 正常请求：200 + 回复（body 读完的 req close 没被误判成断连）',
      normal.status === 200 && JSON.parse(normal.body || '{}').reply === REPLY,
      'status=' + normal.status + ' err=' + (normal.err || '-') + ' body=' + String(normal.body || '').slice(0, 60))
    ok('E1 真实 socket 正常请求：外呼 signal 未被中止', UP.calls[0] && UP.calls[0].signal.aborted === false)

    // 客户端发完 body 就 destroy（Node 会发 res close 且 writableFinished=false）
    resetUp(); setPlan({ mode: 'pending' })
    const before = logs.length
    const body2 = Buffer.from(JSON.stringify({ message: MESSAGE + '断连' }))
    await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/chat', method: 'POST', agent: false,
        headers: { 'content-type': 'application/json', 'content-length': String(body2.length) },
      }, () => resolve())
      req.on('error', () => resolve())
      req.end(body2)
      setTimeout(() => { try { req.destroy() } catch { } resolve() }, 80)
    })
    const aborted = await waitFor(() => !!UP.calls[0] && UP.calls[0].signal.aborted === true, 3000)
    ok('E2 真实 socket：客户端断开后，宿主外呼被 abort（不再白跑 30s）', aborted,
      'aborted=' + aborted + ' calls=' + UP.calls.length)
    ok('E2 真实 socket：断开走专用诊断 CHAT-CLIENT-ABORT',
      logs.slice(before).some((l) => l.includes('CHAT-CLIENT-ABORT')), JSON.stringify(logs.slice(before)))
    ok('E2 真实 socket：断开那次没有写记忆（半截不入账）', L.turns.length === 1,
      'turns=' + L.turns.length)

    try { server.closeAllConnections() } catch { }
    await new Promise((r) => server.close(r))
  }
} catch (e) {
  ok('用例未抛异常', false, String((e && e.stack) || e))
} finally {
  console.error = origError
  globalThis.fetch = realFetch
  clearInterval(keepAlive)
}

console.log('\n' + '='.repeat(52))
console.log('通过 ' + pass + ' 项 / 失败 ' + fail + ' 项')
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('✅ 聊天断连与错误分类回归全部通过')
process.exit(0)
