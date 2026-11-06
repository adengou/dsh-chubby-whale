/**
 * scripts/test-asr-abort.mjs —— B93「客户端断连 → 中止 ASR 外呼」专项回归（离线、不联网、不起子进程）
 *
 * 为什么单独建这个文件：`scripts/test.mjs` 的 [22] 只覆盖「识别成功 / 噪声 / 缓存命中 / 超时分类」，
 * 没有钉住 B92 取证出来的这条付费路径 —— 客户端 30s 硬超时先放弃并重发，宿主却还在把第一次
 * 外呼跑满 ASR_TIMEOUT=60s（同一句话付两次钱）。package.json 与 scripts/test.mjs 均未改，
 * 用 `node scripts/test-asr-abort.mjs` 单跑。
 *
 * 覆盖：
 *   A. host/http.ts：可选 signal（第 4 个参数 / init.signal），且不破坏既有超时语义
 *      A1 不传 signal：仍是内部超时（TimeoutError），与改动前一致
 *      A2 外部 abort：立刻中止外呼，错误仍是 isTimeoutError 认得的 AbortError
 *      A3 init.signal 也认（第 4 个参数之外的第二条通路）
 *      A4 AbortSignal.any 路径：不往外部 signal 上挂监听（getEventListeners = 0）
 *      A5 无 AbortSignal.any 的手写兜底：abort 生效、触发即摘监听、正常完成后也摘、已 abort 的也认
 *   B. /asr 正常路径不被误伤（这是本次改动最大的回归风险）
 *      B1 请求体读完时 req 发 close（Node 24 实测的**正常**形状：complete=true）→ 不 abort
 *      B2 正常结束的 res close（writableFinished=true）→ 不 abort
 *      B3 上游 5xx 语义不变
 *      B4 上游超时（客户端还在）仍是 error=timeout（与 test.mjs [22]⑦ 同口径）
 *   C. /asr 客户端断连 → 立刻中止外呼
 *      C1 res close（响应没写完）→ 外呼 signal 被 abort、不回包、日志是 ASR-CLIENT-ABORT
 *      C2 AbortError 不写缓存：同音频再问必须重新外呼（不能是 cached:true）
 *      C3 req aborted（发完 body 后客户端断）同样中止
 *      C4 请求体没收完就断（req.complete=false + ECONNRESET）→ 不外呼、不回包、不算上游失败
 *      C5 每个请求结束都摘掉 req/res 上的监听（不跨请求残留）
 *   D. 真实 socket 端到端（不是假 EventEmitter）：正常请求 200 不误 abort；客户端 destroy 后外呼被 abort
 *
 * 负向验证（本批实测记录）：先把 src/host/http.ts 与 src/host/routes/asr.ts 回退到基线 6792234
 * （文件先备份到临时目录），再单跑本文件：
 *   · 基线版 C1/C2/C3/C4 失败（外呼 signal.aborted 一直 false；C4 还会把 ECONNRESET 当失败回 200/500 包）
 *     → 证明这几条断言真的咬住了「断连不中止」这个 bug，不是空转。
 *   · 基线版 A2/A3/A5 失败（fetchWithTimeout 只看内部超时，外部 signal 被覆盖/忽略）。
 *   · 恢复改动后全过；而 B1/B3/B4 在基线版也通过 —— 说明新增断言只针对新行为，没有改既有语义。
 *
 * 用法：node scripts/test-asr-abort.mjs
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

// ---------- 假 req / res：形状与 Node 24 实测一致（见文件头 B1/C1 的注释） ----------
/** 最小事件器：够 on / removeListener / listenerCount / emit（用于断言「监听有没有摘干净」） */
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
 * 假请求。默认行为照 Node 24 实测：**请求体读完时 req 立刻发 close**（此时 complete=true、
 * res 还没写）—— 这是「只看 close 就会误判断连」的那个坑，B1 就是钉它的。
 * throwMidBody：模拟请求体没收完客户端就断（实测顺序：先 aborted、complete=false，再抛 ECONNRESET）。
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
      // Node 实测：body 读完即发 close，但请求是完整的（complete=true）→ 不是断连
      req.emit('close')
    },
  })
  return req
}

/** 假响应：像 Node 一样维护 headersSent / writableEnded / writableFinished，并能在测试里手动 emit close */
function mkRes() {
  const out = mkEmitter({
    code: 0,
    headers: {},
    chunks: [],
    headersSent: false,
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
  })
  out.writeHead = (c, h) => { out.code = c; out.headers = h || {}; out.headersSent = true }
  out.end = (b) => {
    if (b) out.chunks.push(Buffer.isBuffer(b) ? b : Buffer.from(String(b)))
    // 先置标志再发 close：Node 正常结束时 close 里 writableFinished 已经是 true
    out.writableEnded = true
    out.writableFinished = true
    out.emit('close')
  }
  out.setHeader = (k, v) => { out.headers[k] = v }
  out.body = () => Buffer.concat(out.chunks)
  out.text = () => out.body().toString('utf8')
  out.json = () => { try { return JSON.parse(out.text()) } catch { return null } }
  return out
}

/** 内存缓存：记录 setJson 次数（断言「断连那次没写缓存」） */
function createMemCache() {
  const map = new Map()
  let sets = 0
  return {
    map,
    get sets() { return sets },
    async getJson(key) { return map.has(key) ? map.get(key) : null },
    async setJson(key, value) { sets++; map.set(key, value) },
    memGet() { return undefined },
    memSet() { },
    async clear() { map.clear(); return 0 },
    async count() { return map.size },
  }
}

// ---------- 上游 fetch 桩：按 plan 决定这一次的行为（pending / resolve / rejectTimeout） ----------
const FETCH = { calls: [], plan: [], text: '主人好', ok: true, status: 200, raw: null, manual: null }
function setPlan(...plan) { FETCH.plan = plan }
function resetFetch() { FETCH.calls.length = 0; FETCH.plan = []; FETCH.text = '主人好'; FETCH.ok = true; FETCH.status = 200; FETCH.raw = null; FETCH.manual = null }
/** 真实 fetch 的拒绝原因：signal.reason（可能是 TimeoutError DOMException），没有就用 AbortError */
function abortErr(sig) {
  const reason = sig && sig.reason
  if (reason && typeof reason.name === 'string') return reason
  const e = new Error('This operation was aborted')
  e.name = 'AbortError'
  return e
}
const realFetch = globalThis.fetch
globalThis.fetch = (url, init = {}) => {
  const sig = init.signal
  const call = { url: String(url), signal: sig, body: init.body }
  FETCH.calls.push(call)
  const mode = FETCH.plan.length ? FETCH.plan.shift() : 'resolve'
  if (mode === 'pending' || mode === 'manual') {
    return new Promise((resolve, reject) => {
      if (mode === 'manual') FETCH.manual = { resolve, reject }
      const onAbort = () => reject(abortErr(sig))
      if (sig) {
        if (sig.aborted) { onAbort(); return }
        sig.addEventListener('abort', onAbort, { once: true })
      }
    })
  }
  if (mode === 'rejectTimeout') {
    const e = new Error('The operation was aborted due to timeout')
    e.name = 'TimeoutError'
    return Promise.reject(e)
  }
  const text = FETCH.raw !== null ? String(FETCH.raw) : JSON.stringify({ text: FETCH.text })
  return Promise.resolve({ ok: FETCH.ok, status: FETCH.status, text: async () => text })
}

const H = await import('../src/host/http.ts')
const ASR = await import('../src/host/routes/asr.ts')
const { fetchWithTimeout, fetchJson, isTimeoutError } = H
const { createAsrHandler } = ASR

// 收集日志（断言「断连有专用诊断、不被当成上游失败」）
const logs = []
const origError = console.error
console.error = (...a) => logs.push(a.join(' '))

// AbortSignal.timeout 的定时器是 unref 的：只有它一个在跑时事件循环会空掉（顶层 await 挂住）。
// 测试里挂一个 ref 的空定时器吊住事件循环，收尾时清掉。
const keepAlive = setInterval(() => { }, 1000)

try {
  // ======================================================================
  // A. host/http.ts：可选 signal
  // ======================================================================
  group('[A] host/http.ts：可选 signal（不破坏既有超时语义）')
  {
    // A1：不传 signal → 仍是内部超时（TimeoutError）
    resetFetch(); setPlan('pending')
    const t0 = Date.now()
    const e1 = await fetchWithTimeout('https://up.example/x', {}, 40).then(() => null, (e) => e)
    ok('A1 不传 signal：内部超时仍生效（TimeoutError）',
      !!e1 && e1.name === 'TimeoutError' && isTimeoutError(e1), String(e1 && e1.name) + ' ' + (Date.now() - t0) + 'ms')

    // A2：第 4 个参数 signal
    resetFetch(); setPlan('pending')
    const ctl1 = new AbortController()
    const p2 = fetchWithTimeout('https://up.example/x', {}, 300, ctl1.signal)
    ok('A2 前置：外呼已发出且拿到组合 signal', await waitFor(() => FETCH.calls.length === 1) && !!FETCH.calls[0].signal,
      'calls=' + FETCH.calls.length)
    const call2 = FETCH.calls[0]
    ok('A2 组合 signal 不是把外部 signal 直接原样塞进去（超时要能独立生效）', call2.signal !== ctl1.signal)
    ctl1.abort()
    const e2 = await p2.then(() => null, (e) => e)
    ok('A2 外部 abort → 外呼立刻中止（AbortError，isTimeoutError 仍认）',
      !!e2 && e2.name === 'AbortError' && isTimeoutError(e2), String(e2 && e2.name))
    ok('A2 外部 abort 传到 fetch 的 signal 上（aborted=true）', call2.signal.aborted === true)

    // A3：init.signal 这条通路也认
    resetFetch(); setPlan('pending')
    const ctl2 = new AbortController()
    const p3 = fetchWithTimeout('https://up.example/x', { signal: ctl2.signal }, 300)
    await waitFor(() => FETCH.calls.length === 1)
    ctl2.abort()
    const e3 = await p3.then(() => null, (e) => e)
    ok('A3 init.signal 同样中止外呼', !!e3 && e3.name === 'AbortError' && FETCH.calls[0].signal.aborted === true,
      String(e3 && e3.name))

    // A4：AbortSignal.any 路径不往外部 signal 上挂监听（弱引用，不泄漏）
    resetFetch(); setPlan('pending')
    const ctl3 = new AbortController()
    const p4 = fetchWithTimeout('https://up.example/x', {}, 300, ctl3.signal)
    await waitFor(() => FETCH.calls.length === 1)
    ok('A4 AbortSignal.any 路径：外呼在跑时外部 signal 上没有普通监听（getEventListeners=0）',
      getEventListeners(ctl3.signal, 'abort').length === 0, 'listeners=' + getEventListeners(ctl3.signal, 'abort').length)
    ctl3.abort()
    await p4.catch(() => { })
    ok('A4 abort 之后也没有残留监听', getEventListeners(ctl3.signal, 'abort').length === 0)

    // A5：无 AbortSignal.any 的手写兜底（模拟老 Node）
    const anyDesc = Object.getOwnPropertyDescriptor(AbortSignal, 'any')
    Object.defineProperty(AbortSignal, 'any', { value: undefined, writable: true, configurable: true })
    try {
      resetFetch(); setPlan('pending')
      const ctl4 = new AbortController()
      const p5 = fetchWithTimeout('https://up.example/x', {}, 300, ctl4.signal)
      await waitFor(() => FETCH.calls.length === 1)
      ok('A5 兜底：外呼在跑时挂上 1 个转发监听（正常）',
        getEventListeners(ctl4.signal, 'abort').length === 1, 'listeners=' + getEventListeners(ctl4.signal, 'abort').length)
      ctl4.abort()
      const e5 = await p5.then(() => null, (e) => e)
      ok('A5 兜底：外部 abort 同样立刻中止外呼', !!e5 && e5.name === 'AbortError' && FETCH.calls[0].signal.aborted === true,
        String(e5 && e5.name))
      ok('A5 兜底：触发后立刻摘掉监听（不重复触发、不泄漏）',
        getEventListeners(ctl4.signal, 'abort').length === 0, 'listeners=' + getEventListeners(ctl4.signal, 'abort').length)

      resetFetch(); setPlan('resolve')
      const ctl5 = new AbortController()
      await fetchWithTimeout('https://up.example/x', {}, 5000, ctl5.signal)
      ok('A5 兜底：请求**正常完成**后也摘掉监听（不在长期 signal 上留垃圾）',
        getEventListeners(ctl5.signal, 'abort').length === 0, 'listeners=' + getEventListeners(ctl5.signal, 'abort').length)

      resetFetch(); setPlan('pending')
      const pre = new AbortController()
      pre.abort()
      const e6 = await fetchWithTimeout('https://up.example/x', {}, 300, pre.signal).then(() => null, (e) => e)
      ok('A5 兜底：已经 abort 的 signal 传进来立刻中止，且不挂监听',
        !!e6 && e6.name === 'AbortError' && getEventListeners(pre.signal, 'abort').length === 0, String(e6 && e6.name))
    } finally {
      if (anyDesc) Object.defineProperty(AbortSignal, 'any', anyDesc)
    }

    // A6：fetchJson 第 4 个参数透传（ASR 路由用的正是这条）
    resetFetch(); setPlan('pending')
    const ctl6 = new AbortController()
    const p7 = fetchJson('https://up.example/x', { method: 'POST' }, 300, ctl6.signal)
    await waitFor(() => FETCH.calls.length === 1)
    ctl6.abort()
    const e7 = await p7.then(() => null, (e) => e)
    ok('A6 fetchJson(第 4 个参数 signal)：外部 abort 生效', !!e7 && e7.name === 'AbortError' && FETCH.calls[0].signal.aborted === true,
      String(e7 && e7.name))
    ok('A6 restore AbortSignal.any 之后仍走 any 路径（测试自身没把环境改坏）', typeof AbortSignal.any === 'function')
  }

  // ======================================================================
  // B. /asr 正常路径：不误中止 / 既有语义不变
  // ======================================================================
  group('[B] /asr 正常路径：不被误中止，既有语义不变')
  {
    // B1：body 读完的 req close（complete=true）不许被当成断连
    resetFetch(); setPlan('resolve'); FETCH.text = '主人好'
    logs.length = 0
    const cache = createMemCache()
    const handle = createAsrHandler({ cache, getKey: () => 'k' })
    const audio = Buffer.from('normal-audio-b93').toString('base64')
    const res = mkRes()
    await handle(mkReq({ audio }), res)
    const call = FETCH.calls[0]
    ok('B1 正常请求：外呼 signal 没有被中止', !!call && call.signal.aborted === false)
    ok('B1 正常请求：200 + 文本', res.code === 200 && res.json() && res.json().text === '主人好', res.text().slice(0, 80))
    ok('B1 正常请求：仍然写缓存（既有行为）', cache.sets === 1 && cache.map.size === 1, 'sets=' + cache.sets)
    ok('B1 正常请求：不产生 ASR-CLIENT-ABORT 日志', !logs.some((l) => l.includes('ASR-CLIENT-ABORT')),
      JSON.stringify(logs))
    const res2 = mkRes()
    await handle(mkReq({ audio }), res2)
    ok('B1 正常请求：同音频第二次命中缓存（fetch 仍只 1 次）',
      FETCH.calls.length === 1 && res2.json() && res2.json().cached === true, 'fetch=' + FETCH.calls.length)

    // B2：正常结束形状的 res close（writableFinished=true）即使被看到也不许 abort
    resetFetch(); setPlan('manual')
    logs.length = 0
    const cache2 = createMemCache()
    const handle2 = createAsrHandler({ cache: cache2, getKey: () => 'k' })
    const audio2 = Buffer.from('normal-close-b93').toString('base64')
    const req2 = mkReq({ audio: audio2 })
    const res3 = mkRes()
    const pr = handle2(req2, res3)
    await waitFor(() => FETCH.calls.length === 1 && !!FETCH.manual)
    // 模拟「响应已经写完」的 close：writableEnded / writableFinished 都是 true
    res3.writableEnded = true
    res3.writableFinished = true
    res3.emit('close')
    await tick(10)
    ok('B2 已写完响应的 res close：不被当成断连（外呼没被 abort）', FETCH.calls[0].signal.aborted === false)
    FETCH.manual.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ text: '正常结束' }) })
    await pr
    ok('B2 已写完响应的 close 之后，识别结果照常走完（缓存写入/无 CLIENT-ABORT 日志）',
      cache2.map.size === 1 && !logs.some((l) => l.includes('ASR-CLIENT-ABORT')), JSON.stringify(logs))

    // B3：上游 5xx 语义不变
    resetFetch(); setPlan('resolve'); FETCH.ok = false; FETCH.status = 503; FETCH.raw = 'busy'
    logs.length = 0
    const cache3 = createMemCache()
    const handle3 = createAsrHandler({ cache: cache3, getKey: () => 'k' })
    const res4 = mkRes()
    await handle3(mkReq({ audio: Buffer.from('http-err-b93').toString('base64') }), res4)
    ok('B3 上游 503：仍是 ok:false + error 带状态码（200 承载业务失败，既有约定）',
      res4.code === 200 && res4.json() && res4.json().ok === false && /503/.test(String(res4.json().error)),
      res4.text().slice(0, 120))
    ok('B3 上游 503：不写缓存、不算断连', cache3.map.size === 0 && !logs.some((l) => l.includes('ASR-CLIENT-ABORT')))

    // B4：上游超时（客户端还在）→ error=timeout（与 test.mjs [22]⑦ 同口径）
    resetFetch(); setPlan('rejectTimeout')
    logs.length = 0
    const cache4 = createMemCache()
    const handle4 = createAsrHandler({ cache: cache4, getKey: () => 'k' })
    const res5 = mkRes()
    await handle4(mkReq({ audio: Buffer.from('timeout-b93').toString('base64') }), res5)
    ok('B4 上游超时（客户端未断）：仍是 error=timeout + ASR-TIMEOUT 日志',
      res5.json() && res5.json().error === 'timeout' && logs.some((l) => l.includes('ASR-TIMEOUT')),
      JSON.stringify(logs) + ' body=' + res5.text().slice(0, 80))
    ok('B4 上游超时不会误判成客户端断连', !logs.some((l) => l.includes('ASR-CLIENT-ABORT')))
  }

  // ======================================================================
  // C. /asr 客户端断连 → 立刻中止外呼
  // ======================================================================
  group('[C] /asr 客户端断连：立刻中止外呼 / 不写缓存 / 不记上游失败')
  {
    resetFetch(); setPlan('pending')
    logs.length = 0
    const cache = createMemCache()
    const handle = createAsrHandler({ cache, getKey: () => 'k' })
    const audio = Buffer.from('client-gone-b93').toString('base64')
    const req = mkReq({ audio })
    const res = mkRes()
    const pending = handle(req, res)
    ok('C1 前置：外呼已经发出', await waitFor(() => FETCH.calls.length === 1), 'calls=' + FETCH.calls.length)
    const call = FETCH.calls[0]
    ok('C1 前置：外呼在等上游（signal 未中止）', call.signal.aborted === false)
    // 客户端 30s 硬超时放弃：发完 body 后连接关闭（Node 实测：res close 且 writableFinished=false）
    res.emit('close')
    // 关键口径不是「最终会不会 abort」（基线版跑满 60s 后超时也会 abort），而是「断开后立刻 abort」：
    // 所以给 1s 的窗口。基线版这里会一直等 60s，负向验证时会当场判负。
    const settled = await Promise.race([pending.then(() => true, () => true), tick(1000).then(() => false)])
    ok('C1 客户端断开 → 外呼在 1s 内 abort（不是跑满 60s 才超时）',
      settled === true && call.signal.aborted === true, 'settled=' + settled + ' aborted=' + call.signal.aborted)
    if (settled) await pending
    ok('C1 断开后立刻收口且不回包（连接已断，没人收）',
      settled === true && res.code === 0 && res.chunks.length === 0, 'settled=' + settled + ' code=' + res.code)
    ok('C1 日志是专用诊断 ASR-CLIENT-ABORT', logs.some((l) => l.includes('ASR-CLIENT-ABORT')), JSON.stringify(logs))
    ok('C1 不被记成上游超时/网络失败',
      !logs.some((l) => l.includes('ASR-TIMEOUT') || l.includes('ASR-NETWORK')), JSON.stringify(logs))
    ok('C1 AbortError 不写缓存（cache 里一个条目都没有）', cache.map.size === 0 && cache.sets === 0,
      'size=' + cache.map.size + ' sets=' + cache.sets)

    // C2：证明 C1 那次真的没写缓存：同音频再问必须重新外呼
    setPlan('resolve'); FETCH.text = '主人好'
    const res2 = mkRes()
    await handle(mkReq({ audio }), res2)
    ok('C2 同音频重发：必须重新外呼（没有被「断连那次」的缓存吞掉）',
      FETCH.calls.length === 2 && res2.json() && res2.json().cached !== true, 'fetch=' + FETCH.calls.length)
    ok('C2 重发这次正常拿到文本', res2.json() && res2.json().ok === true && res2.json().text === '主人好',
      res2.text().slice(0, 80))

    // C3：req 'aborted'（发完 body 后客户端断）也是断连
    resetFetch(); setPlan('pending')
    logs.length = 0
    const cache2 = createMemCache()
    const handle2 = createAsrHandler({ cache: cache2, getKey: () => 'k' })
    const req3 = mkReq({ audio: Buffer.from('client-aborted-b93').toString('base64') })
    const res3 = mkRes()
    const pending3 = handle2(req3, res3)
    await waitFor(() => FETCH.calls.length === 1)
    req3.emit('aborted')
    const settled3 = await Promise.race([pending3.then(() => true, () => true), tick(1000).then(() => false)])
    ok('C3 req aborted → 外呼在 1s 内 abort', settled3 === true && FETCH.calls[0].signal.aborted === true,
      'settled=' + settled3 + ' aborted=' + FETCH.calls[0].signal.aborted)
    if (settled3) await pending3
    ok('C3 req aborted → 立刻收口、不回包、不写缓存、日志是 CLIENT-ABORT',
      settled3 === true && res3.code === 0 && cache2.map.size === 0 && logs.some((l) => l.includes('ASR-CLIENT-ABORT')),
      'settled=' + settled3 + ' code=' + res3.code + ' ' + JSON.stringify(logs))

    // C4：请求体没收完就断（complete=false + ECONNRESET）→ 根本不外呼、不回包、不算上游失败
    resetFetch(); setPlan('resolve')
    logs.length = 0
    const cache3 = createMemCache()
    const handle3 = createAsrHandler({ cache: cache3, getKey: () => 'k' })
    const res4 = mkRes()
    await handle3(mkReq({ audio: Buffer.from('mid-body-b93').toString('base64') }, { throwMidBody: true }), res4)
    ok('C4 请求体没收完就断：一个上游请求都不发', FETCH.calls.length === 0, 'fetch=' + FETCH.calls.length)
    ok('C4 不回包（不把 ECONNRESET 当失败写回已断的连接）', res4.code === 0, 'code=' + res4.code)
    ok('C4 日志是专用诊断 ASR-CLIENT-ABORT，不是 ASR-NETWORK',
      logs.some((l) => l.includes('ASR-CLIENT-ABORT')) && !logs.some((l) => l.includes('ASR-NETWORK')), JSON.stringify(logs))

    // C5：监听不跨请求残留
    resetFetch(); setPlan('resolve')
    const cache4 = createMemCache()
    const handle4 = createAsrHandler({ cache: cache4, getKey: () => 'k' })
    const req5 = mkReq({ audio: Buffer.from('leak-check-b93').toString('base64') })
    const res5 = mkRes()
    await handle4(req5, res5)
    ok('C5 请求结束：req/res 上的 close/aborted 监听全部摘掉（不跨请求残留）',
      req5.listenerCount('close') === 0 && req5.listenerCount('aborted') === 0 && res5.listenerCount('close') === 0,
      'req.close=' + req5.listenerCount('close') + ' req.aborted=' + req5.listenerCount('aborted') +
      ' res.close=' + res5.listenerCount('close'))
  }

  // ======================================================================
  // D. 真实 socket 端到端：证明这套判断不是只有假 EventEmitter 才成立
  // ======================================================================
  group('[D] 真实 socket 端到端：正常请求不误 abort；客户端 destroy 后外呼被 abort')
  {
    resetFetch(); setPlan('resolve'); FETCH.text = '主人好'
    logs.length = 0
    const cache = createMemCache()
    const handle = createAsrHandler({ cache, getKey: () => 'k' })
    const server = http.createServer((req, res) => {
      Promise.resolve(handle(req, res)).catch(() => { })
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const port = server.address().port
    const body = Buffer.from(JSON.stringify({ audio: Buffer.from('socket-normal-b93').toString('base64') }))

    /** 正常 POST：等完整响应（4s 收口） */
    const post = () => new Promise((resolve) => {
      let settled = false
      const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v) } }
      const timer = setTimeout(() => done({ err: 'timeout' }), 4000)
      const req = http.request({
        host: '127.0.0.1', port, path: '/asr', method: 'POST', agent: false,
        headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
      }, (res) => {
        let b = ''
        res.setEncoding('utf8')
        res.on('data', (d) => { b += d })
        res.on('end', () => done({ status: res.statusCode, body: b }))
        res.on('error', (e) => done({ err: e.code || e.message }))
      })
      req.on('error', (e) => done({ err: e.code || e.message }))
      req.end(body)
    })

    const normal = await post()
    ok('D1 真实 socket 正常请求：200 + 文本（body 读完的 req close 没被误判成断连）',
      normal.status === 200 && JSON.parse(normal.body || '{}').text === '主人好',
      'status=' + normal.status + ' err=' + (normal.err || '-') + ' body=' + String(normal.body || '').slice(0, 60))
    ok('D1 真实 socket 正常请求：外呼 signal 未被中止', FETCH.calls[0] && FETCH.calls[0].signal.aborted === false)

    // 客户端发完 body 就 destroy：Node 会发 res close（writableFinished=false）→ 应立刻 abort 外呼。
    // 注意用**另一段音频**：跟 D1 同一段会直接命中缓存、压根不发起外呼（第一次写这个用例就踩了）。
    const body2 = Buffer.from(JSON.stringify({ audio: Buffer.from('socket-disconnect-b93').toString('base64') }))
    setPlan('pending')
    const before = FETCH.calls.length
    await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/asr', method: 'POST', agent: false,
        headers: { 'content-type': 'application/json', 'content-length': String(body2.length) },
      }, () => resolve())
      req.on('error', () => resolve())
      req.end(body2)
      setTimeout(() => { try { req.destroy() } catch { } resolve() }, 80)
    })
    const aborted = await waitFor(() => {
      const c = FETCH.calls[before]
      return !!c && c.signal.aborted === true
    }, 3000)
    ok('D2 真实 socket：客户端断开后，宿主外呼被 abort（不再白跑 60s）', aborted,
      'aborted=' + aborted + ' calls=' + FETCH.calls.length)
    ok('D2 真实 socket：断开的那次没有写缓存', cache.map.size <= 1, 'cache.size=' + cache.map.size)
    ok('D2 真实 socket：断开走专用诊断', logs.some((l) => l.includes('ASR-CLIENT-ABORT')), JSON.stringify(logs.slice(-3)))

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
console.log('✅ ASR 断连中止回归全部通过')
process.exit(0)
