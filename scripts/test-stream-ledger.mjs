/**
 * scripts/test-stream-ledger.mjs —— 流式聊天「记账」回归测试（B8 防退化）
 *
 * 背景（docs/坑.md 坑 39）：客户端优先走 /chat-stream，但流式 handler 一度没有
 * loadState/saveState/addExp/saveMemorySummary，日常聊天不涨亲密度、不涨经验、
 * 长期记忆摘要永不更新。这组用例锁死两条路径（/chat 与 /chat-stream）的记账同口径。
 *
 * 覆盖（离线、不联网、不真起 HTTP 服务）：
 *   ① 流式成功：loadState/saveState（亲密度 +1）、addExp(1,'chat')、appendTurns、
 *      addTokens('chat', usage.total_tokens)、onReply 各一次，缓存落盘一次；
 *   ② 缓存命中：只加亲密度，不加经验、不 appendTurns、不 onReply、不记 token、不写缓存；
 *   ③ 中断/客户端断开：不缓存、不 appendTurns、不记账（含不读不写 state）；
 *   ④ 每 10 次摘要：前 9 次不触发，第 10 次触发 saveMemorySummary；
 *   ⑤ 代际校验：写回前历史变短（模拟 /clear-memory）或摘要被改写 → 不写回；
 *   ⑥ 与普通 /chat 并列对照：同样输入下记账结果、缓存与第 10 次摘要完全一致；
 *   ⑦ 装配接线（静态）：src/index.ts 必须把四项能力注入 createChatStreamHandler，
 *      否则路由层写得再全，生产环境仍然静默跳过（B8 的实际故障面）。
 *
 * 实现要点：
 *   · 用 scripts/ts-resolve.mjs 直接加载 src/**\/*.ts，不依赖 dist、不需要构建；
 *   · 每次用例都用带 query 的 import 取「全新模块实例」，隔离 chat-stream.ts 模块级
 *     summaryCount（否则 test.mjs 里先跑的其它用例会把计数器推到未知值）；
 *   · 上游 fetch、摘要 fetch、缓存、store 全部是进程内 stub，不落盘、不联网；
 *   · 负向验证可把 DSH_TEST_STREAM_ROUTE 指向 chat-stream.ts 的临时副本，
 *     在副本里删掉 loadState 调用，本套用例应变红（不改 src）。
 *
 * 用法：
 *   node scripts/test-stream-ledger.mjs            # 独立运行，失败退出码 1
 *   test.mjs 里 import { runStreamLedger } 并传入自己的 ok()，作为一组并入 npm test
 */

import { register } from 'node:module'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const MESSAGE = '主人今天想吃什么呀'
const MESSAGE_10 = '第十轮聊天，主人今晚吃米饭吗'
const REPLY = '你好呀'
const USAGE_TOKENS = 12
const SUMMARY_TEXT = '新摘要'

const HALF_SSE = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '半截' } }] }) + '\n\n'
const FULL_SSE = [
  'data: ' + JSON.stringify({ choices: [{ delta: { content: '你好' } }] }),
  'data: ' + JSON.stringify({ choices: [{ delta: { content: '呀' } }] }),
  'data: ' + JSON.stringify({ choices: [], usage: { total_tokens: USAGE_TOKENS } }),
  'data: [DONE]',
].join('\n\n') + '\n\n'

let resolverReady = false
function ensureResolver() {
  if (resolverReady) return
  register(new URL('./ts-resolve.mjs', import.meta.url))
  resolverReady = true
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(pred, ms = 1500) {
  const started = Date.now()
  while (Date.now() - started < ms) {
    if (pred()) return true
    await sleep(5)
  }
  return Boolean(pred())
}

// ---------- 假请求 / 假响应 ----------

/** 把 body 包成路由期待的异步可迭代请求（readBody 用 for await 读） */
function mkReq(body) {
  const buf = Buffer.from(JSON.stringify(body))
  return {
    method: 'POST',
    url: '/api/chubby-whale/chat-stream',
    headers: {},
    destroy() { },
    on() { },
    resume() { },
    async *[Symbol.asyncIterator]() { yield buf },
  }
}

/** 普通 JSON 路由的假响应 */
function mkJsonRes() {
  const res = { code: 0, chunks: [] }
  res.writeHead = (code) => { res.code = code }
  res.write = (chunk) => { res.chunks.push(Buffer.from(String(chunk))); return true }
  res.end = (chunk) => { if (chunk !== undefined) res.chunks.push(Buffer.from(String(chunk))) }
  res.setHeader = () => { }
  res.on = () => { }
  res.raw = () => Buffer.concat(res.chunks).toString('utf8')
  res.json = () => { try { return JSON.parse(res.raw()) } catch { return null } }
  return res
}

/** SSE 路由的假响应：记录状态码、帧、close 监听 */
function mkSseRes() {
  const res = { code: 200, chunks: [], onClose: null, ended: false }
  res.writeHead = (code) => { res.code = code }
  res.write = (chunk) => { res.chunks.push(String(chunk)); return true }
  res.end = (chunk) => { if (chunk !== undefined) res.chunks.push(String(chunk)); res.ended = true }
  res.on = (event, cb) => { if (event === 'close') res.onClose = cb; return res }
  res.flushHeaders = () => { }
  res.setHeader = () => { }
  res.raw = () => res.chunks.join('')
  res.json = () => { try { return JSON.parse(res.raw()) } catch { return null } }
  res.events = () => res.raw().split('\n\n').map((block) => {
    const line = block.split('\n').find((x) => x.startsWith('data: '))
    if (!line) return null
    try { return JSON.parse(line.slice(6)) } catch { return null }
  }).filter(Boolean)
  return res
}

/** 缓存替身：只记录读写，不落盘；hit 非空时每次都命中 */
function mkSpyCache(hit = null) {
  const cache = { reads: [], writes: [], hit }
  cache.getJson = async (key) => { cache.reads.push(key); return cache.hit }
  cache.setJson = async (key, value) => { cache.writes.push({ key, value }) }
  cache.memGet = () => undefined
  cache.memSet = () => { }
  cache.clear = async () => 0
  cache.count = async () => 0
  return cache
}

function defaultHistory(n = 8) {
  const out = []
  for (let i = 0; i < n; i++) {
    out.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: '历史第' + (i + 1) + '条' + (i % 2 === 0 ? '主人说的话' : '肥鲸的回复'),
    })
  }
  return out
}

// ---------- 记账探针（store 端口替身） ----------

function mkLedger(over = {}) {
  const L = {
    state: { intimacy: Number(over.intimacy ?? 0) },
    loads: 0,
    saves: [],
    exp: [],
    tokens: [],
    turns: [],
    replies: 0,
    summaries: [],
    history: Array.isArray(over.history) ? over.history.slice() : defaultHistory(),
    summary: over.summary ?? '旧摘要',
    cache: over.cache || mkSpyCache(),
  }
  L.deps = {
    getKey: () => 'test-key',
    loadHistory: () => L.history.slice(),
    appendTurns: (userText, replyText) => {
      L.turns.push([userText, replyText])
      L.history.push({ role: 'user', content: userText }, { role: 'assistant', content: replyText })
    },
    loadState: () => { L.loads += 1; return L.state },
    saveState: (s) => { L.saves.push(s); L.state = s },
    systemPrompt: 'SYS',
    addExp: (n, source) => { L.exp.push([n, source]); return { upgraded: false, exp: Number(n) || 0 } },
    addTokens: (kind, n) => { L.tokens.push([kind, n]) },
    cache: L.cache,
    loadMemorySummary: () => L.summary,
    saveMemorySummary: (s) => { L.summaries.push(s); L.summary = s },
    cacheEnabled: () => true,
    model: 'deepseek-flash',
    onReply: () => { L.replies += 1 },
  }
  return L
}

// ---------- 上游 fetch 替身 ----------

function mkUpstream() {
  const U = {
    streamCalls: [],
    summaryCalls: [],
    mode: 'sse',            // sse | reader
    sseText: FULL_SSE,
    reader: null,
    onSummaryFetch: null,   // 摘要请求返回前调用，模拟「20 秒窗口里记忆被改」
    summaryReply: SUMMARY_TEXT,
  }
  U.fetch = async (url, init = {}) => {
    let body = null
    try { body = JSON.parse(String(init.body || '{}')) } catch { body = null }
    // 流式聊天请求
    if (body && body.stream === true) {
      U.streamCalls.push({ url: String(url), body })
      if (U.mode === 'reader') {
        return { ok: true, status: 200, body: { getReader: () => U.reader } }
      }
      return new Response(U.sseText, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    // 长期记忆摘要请求（chat-core.summarizeMemory 的 system 文案）
    const sys = String(body && body.messages && body.messages[0] && body.messages[0].content || '')
    if (sys.includes('整理长期记忆')) {
      U.summaryCalls.push({ url: String(url), body })
      if (U.onSummaryFetch) await U.onSummaryFetch(body)
      return new Response(JSON.stringify({ choices: [{ message: { content: U.summaryReply } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    // 普通 /chat 请求
    U.streamCalls.push({ url: String(url), body })
    return new Response(JSON.stringify({
      choices: [{ message: { content: REPLY } }],
      usage: { total_tokens: USAGE_TOKENS },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return U
}

// ---------- 全新模块实例（隔离模块级 summaryCount） ----------

let freshSeq = 0
function streamRouteBaseUrl() {
  const override = String(process.env.DSH_TEST_STREAM_ROUTE || '').trim()
  if (override) return pathToFileURL(override).href
  return new URL('../src/host/routes/chat-stream.ts', import.meta.url).href
}

async function loadFreshStreamFactory() {
  freshSeq += 1
  const base = streamRouteBaseUrl()
  const url = base + (base.includes('?') ? '&' : '?') + 'fresh=' + Date.now() + '-' + freshSeq
  const mod = await import(url)
  return mod.createChatStreamHandler
}

// ---------- 断言主体 ----------

/**
 * 运行全部流式记账用例。
 * @param {(name: string, cond: boolean, detail?: string) => void} emit 外部断言回调（test.mjs 的 ok）
 * @param {{ registerResolver?: boolean }} [options] 嵌入 test.mjs 时传 false（该进程已注册解析钩子）
 * @returns {Promise<{ total: number }>}
 */
export async function runStreamLedger(emit, options = {}) {
  if (options.registerResolver !== false) ensureResolver()

  const { createChatHandler } = await import('../src/host/routes/chat.ts')
  const realFetch = globalThis.fetch

  let total = 0
  const ok = (name, cond, detail = '') => {
    total += 1
    emit(name, cond === true, detail)
  }
  const section = async (name, fn) => {
    try { await fn() } catch (e) {
      ok(name + '（用例本身可执行）', false, String((e && e.message) || e))
    }
  }
  const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b)

  try {
    // ④ 每 10 次摘要：前 9 次不触发，第 10 次写回（放最前，计数器从 0 开始）
    await section('每 10 次摘要', async () => {
      const create = await loadFreshStreamFactory()
      const L = mkLedger()
      const U = mkUpstream()
      globalThis.fetch = U.fetch
      const handler = create(L.deps)
      for (let i = 1; i <= 9; i++) {
        await handler(mkReq({ message: '第' + i + '轮聊天，主人今天想吃什么' }), mkSseRes())
      }
      const before = { summaries: L.summaries.length, fetches: U.summaryCalls.length }
      ok('前 9 次成功聊天不触发摘要', before.summaries === 0 && before.fetches === 0, 'summaries=' + before.summaries + ' fetches=' + before.fetches)

      const res = mkSseRes()
      await handler(mkReq({ message: MESSAGE_10 }), res)
      const fetched = await waitFor(() => U.summaryCalls.length >= 1)
      const saved = await waitFor(() => L.summaries.length >= 1)
      ok('第 10 次发起摘要请求（只发 1 次）', fetched && U.summaryCalls.length === 1, 'fetches=' + U.summaryCalls.length)
      ok('第 10 次把新摘要写回（saveMemorySummary）', saved && L.summaries[0] === SUMMARY_TEXT, JSON.stringify(L.summaries))
      const summaryUser = String(U.summaryCalls[0]?.body?.messages?.[1]?.content || '')
      ok('摘要请求带旧记忆与最近对话（含本轮问答）',
        summaryUser.includes('旧记忆：旧摘要') && summaryUser.includes('主人：' + MESSAGE_10) && summaryUser.includes('肥鲸：' + REPLY))
      ok('第 10 次仍正常回 done 帧', res.events().some((e) => e.done === true && e.cached === false))
      ok('摘要写回后记忆摘要已更新（计数复位）', L.summary === SUMMARY_TEXT)
    })

    // ① 流式成功：五项记账 + 缓存落盘
    await section('流式成功记账', async () => {
      const create = await loadFreshStreamFactory()
      const L = mkLedger({ intimacy: 41 })
      const U = mkUpstream()
      globalThis.fetch = U.fetch
      const cacheOk = L.cache
      const res = mkSseRes()
      await create(L.deps)(mkReq({ message: MESSAGE }), res)
      const events = res.events()
      const done = events.find((e) => e.done === true)
      ok('流式成功：loadState 被调用', L.loads === 1, 'calls=' + L.loads)
      ok('流式成功：saveState 被调用', L.saves.length === 1)
      ok('流式成功：亲密度 +1（41 → 42）', L.state.intimacy === 42 && L.saves[0]?.intimacy === 42, 'intimacy=' + L.state.intimacy)
      ok("流式成功：addExp(1,'chat') 被调用", L.exp.length === 1 && L.exp[0][0] === 1 && L.exp[0][1] === 'chat', JSON.stringify(L.exp))
      ok('流式成功：appendTurns 收到本轮问答', L.turns.length === 1 && L.turns[0][0] === MESSAGE && L.turns[0][1] === REPLY, JSON.stringify(L.turns))
      ok("流式成功：addTokens('chat', usage)", L.tokens.length === 1 && L.tokens[0][0] === 'chat' && L.tokens[0][1] === USAGE_TOKENS, JSON.stringify(L.tokens))
      ok('流式成功：onReply 计一次 L2', L.replies === 1)
      ok('流式成功：done 帧带 intimacy / reply / cached:false', !!done && done.intimacy === 42 && done.reply === REPLY && done.cached === false, JSON.stringify(done))
      ok('流式成功：缓存落盘一次（reply 一致）', cacheOk.writes.length === 1 && cacheOk.writes[0].value?.reply === REPLY)
      ok('流式成功：单次成功不触发摘要', U.summaryCalls.length === 0 && L.summaries.length === 0)
      try { globalThis.fetch = realFetch } catch { }
    })

    // ② 缓存命中：只加亲密度
    await section('缓存命中', async () => {
      const create = await loadFreshStreamFactory()
      const hit = { reply: '这是缓存里的回复' }
      const L = mkLedger({ intimacy: 7, cache: mkSpyCache(hit) })
      const U = mkUpstream()
      globalThis.fetch = U.fetch
      const res = mkSseRes()
      await create(L.deps)(mkReq({ message: MESSAGE }), res)
      const done = res.events().find((e) => e.done === true)
      ok('缓存命中：原样发出缓存回复、标记 cached', !!done && done.cached === true && done.reply === hit.reply)
      ok('缓存命中：只加亲密度（7 → 8）', L.state.intimacy === 8 && done?.intimacy === 8, 'intimacy=' + L.state.intimacy)
      ok('缓存命中：loadState / saveState 各一次', L.loads === 1 && L.saves.length === 1)
      ok('缓存命中：不加经验', L.exp.length === 0)
      ok('缓存命中：不 appendTurns', L.turns.length === 0)
      ok('缓存命中：不 onReply', L.replies === 0)
      ok('缓存命中：不记 token', L.tokens.length === 0)
      ok('缓存命中：不写缓存', L.cache.writes.length === 0)
      ok('缓存命中：不请求上游、不触发摘要', U.streamCalls.length === 0 && U.summaryCalls.length === 0)
      globalThis.fetch = realFetch
    })

    // ③ 中断 / 客户端断开：不缓存、不 appendTurns、不记账
    await section('中断与客户端断开', async () => {
      const enc = new TextEncoder()

      // 情形 A：上游读流中途抛错
      let reads = 0
      const U1 = mkUpstream()
      U1.mode = 'reader'
      U1.reader = {
        async read() {
          reads += 1
          if (reads === 1) return { value: enc.encode(HALF_SSE), done: false }
          throw new Error('upstream reset')
        },
        releaseLock() { },
      }
      const L1 = mkLedger()
      globalThis.fetch = U1.fetch
      const resA = mkSseRes()
      await (await loadFreshStreamFactory())(L1.deps)(mkReq({ message: MESSAGE }), resA)
      const eventsA = resA.events()
      ok('上游中断：半截 delta 已推送', eventsA.some((e) => e.delta === '半截'))
      ok('上游中断：回 error 帧、无 done', eventsA.some((e) => /^stream:/.test(String(e.error))) && !eventsA.some((e) => e.done === true))
      ok('上游中断：不读不写 state、不加经验', L1.loads === 0 && L1.saves.length === 0 && L1.exp.length === 0)
      ok('上游中断：不 appendTurns、不记 token、不 onReply', L1.turns.length === 0 && L1.tokens.length === 0 && L1.replies === 0)
      ok('上游中断：不写缓存', L1.cache.writes.length === 0)

      // 情形 B：客户端在流读取途中断开（close 事件）
      let served = false
      let releaseRead = () => { }
      const readGate = new Promise((resolve) => { releaseRead = resolve })
      const U2 = mkUpstream()
      U2.mode = 'reader'
      U2.reader = {
        async read() {
          if (!served) { served = true; return { value: enc.encode(FULL_SSE), done: false } }
          await readGate
          return { value: undefined, done: true }
        },
        releaseLock() { },
      }
      const L2 = mkLedger()
      globalThis.fetch = U2.fetch
      const resB = mkSseRes()
      const handlerB = (await loadFreshStreamFactory())(L2.deps)
      const running = handlerB(mkReq({ message: MESSAGE }), resB)
      for (let i = 0; i < 2000 && !(served && resB.onClose); i++) await sleep(1)
      const hasClose = typeof resB.onClose === 'function'
      if (hasClose) resB.onClose()
      releaseRead()
      await running
      const eventsB = resB.events()
      ok('客户端断开：已注册 close 监听', hasClose)
      ok('客户端断开：已推送 delta、无 done', served && eventsB.some((e) => e.delta === '你好') && !eventsB.some((e) => e.done === true))
      // 2026-11-07 B95：口径与 /chat 对齐 —— 这份回复**上游已读完**（第二次 read 在 close 之后才返回 done），
      // 是「完整回复只是回不去」，照常记账；半截（上游没读完）才不落盘。
      ok('客户端断开但上游已读完：照常记账（state/exp/turns/cache/onReply 各 1 次）',
        L2.saves.length === 1 && L2.exp.length === 1 && L2.turns.length === 1 && L2.cache.writes.length === 1 && L2.replies === 1,
        JSON.stringify({ saves: L2.saves.length, exp: L2.exp.length, turns: L2.turns.length, cache: L2.cache.writes.length, replies: L2.replies }))
      ok('客户端断开但上游已读完：token 按 usage 记', L2.tokens.length === 1 && L2.tokens[0][1] === USAGE_TOKENS, JSON.stringify(L2.tokens))
      ok('客户端断开但上游已读完：不写 done 帧（socket 已死）', !eventsB.some((e) => e.done === true))
      // 记忆里留下的是完整正文，不是半截
      ok('记账的正文完整', L2.turns.length === 1 && L2.turns[0][1] === '你好呀', JSON.stringify(L2.turns))
    })

    // ⑤ 代际校验：写回前历史变短 / 摘要被改写都不写回
    await section('摘要代际校验', async () => {
      // 5a：历史变短（模拟 /clear-memory）
      const createA = await loadFreshStreamFactory()
      const LA = mkLedger()
      const UA = mkUpstream()
      globalThis.fetch = UA.fetch
      const handlerA = createA(LA.deps)
      for (let i = 1; i <= 9; i++) {
        await handlerA(mkReq({ message: '第' + i + '轮聊天，主人今天想吃什么' }), mkSseRes())
      }
      UA.onSummaryFetch = async () => { LA.history = [] }
      await handlerA(mkReq({ message: MESSAGE_10 }), mkSseRes())
      const firedA = await waitFor(() => UA.summaryCalls.length >= 1)
      await sleep(100)
      ok('代际校验：第 10 次确实发起了摘要请求', firedA && UA.summaryCalls.length === 1)
      ok('代际校验：历史变短（/clear-memory）→ 摘要不写回', LA.summaries.length === 0, 'saved=' + LA.summaries.length)

      // 5b：摘要被改写（并发入口改过摘要）
      const createB = await loadFreshStreamFactory()
      const LB = mkLedger()
      const UB = mkUpstream()
      globalThis.fetch = UB.fetch
      const handlerB = createB(LB.deps)
      for (let i = 1; i <= 9; i++) {
        await handlerB(mkReq({ message: '第' + i + '轮聊天，主人今天想吃什么' }), mkSseRes())
      }
      UB.onSummaryFetch = async () => { LB.summary = '被外部入口改写' }
      await handlerB(mkReq({ message: MESSAGE_10 }), mkSseRes())
      const firedB = await waitFor(() => UB.summaryCalls.length >= 1)
      await sleep(100)
      ok('代际校验：第 10 次确实发起了摘要请求', firedB && UB.summaryCalls.length === 1)
      ok('代际校验：摘要被改写 → 摘要不写回', LB.summaries.length === 0, 'saved=' + LB.summaries.length)
      ok('代际校验：跳过时保留改写后的摘要（不覆盖）', LB.summary === '被外部入口改写')

      // 5c：普通 /chat 共用同一代际校验（并列对照）
      const LC = mkLedger()
      const UC = mkUpstream()
      globalThis.fetch = UC.fetch
      const chatHandler = createChatHandler(LC.deps)
      for (let i = 1; i <= 9; i++) {
        await chatHandler(mkReq({ message: '第' + i + '轮聊天，主人今天想吃什么' }), mkJsonRes())
      }
      UC.onSummaryFetch = async () => { LC.history = [] }
      await chatHandler(mkReq({ message: MESSAGE_10 }), mkJsonRes())
      const firedC = await waitFor(() => UC.summaryCalls.length >= 1)
      await sleep(100)
      ok('/chat 同款代际校验：历史变短 → 摘要不写回', firedC && UC.summaryCalls.length === 1 && LC.summaries.length === 0, 'saved=' + LC.summaries.length)
    })

    // ⑥ 与普通 /chat 并列对照：单次记账 / 第 10 次摘要都同口径
    await section('与普通 /chat 同口径', async () => {
      const createStream = await loadFreshStreamFactory()
      const LS = mkLedger({ intimacy: 10 })
      const LC = mkLedger({ intimacy: 10 })
      const U = mkUpstream()
      globalThis.fetch = U.fetch
      await createChatHandler(LC.deps)(mkReq({ message: MESSAGE }), mkJsonRes())
      await createStream(LS.deps)(mkReq({ message: MESSAGE }), mkSseRes())
      ok('单次：两路径亲密度都 +1（10 → 11）', LS.state.intimacy === 11 && LC.state.intimacy === 11)
      ok("单次：两路径都 addExp(1,'chat')", deepEqual(LS.exp, [[1, 'chat']]) && deepEqual(LC.exp, LS.exp))
      ok('单次：两路径 appendTurns 内容一致', LS.turns.length === 1 && deepEqual(LS.turns, LC.turns))
      ok('单次：两路径 token 口径一致', deepEqual(LS.tokens, [[ 'chat', USAGE_TOKENS ]]) && deepEqual(LC.tokens, LS.tokens))
      ok('单次：两路径 onReply 各一次', LS.replies === 1 && LC.replies === 1)
      ok('单次：两路径都不触发摘要', LS.summaries.length === 0 && LC.summaries.length === 0 && U.summaryCalls.length === 0)
      ok('单次：两路径都缓存落盘一次且内容一致',
        LS.cache.writes.length === 1 && LC.cache.writes.length === 1 && LS.cache.writes[0].value?.reply === LC.cache.writes[0].value?.reply)

      // 第 10 次摘要并列对照
      const createStream2 = await loadFreshStreamFactory()
      const LS2 = mkLedger()
      const LC2 = mkLedger()
      const U2 = mkUpstream()
      globalThis.fetch = U2.fetch
      const streamHandler = createStream2(LS2.deps)
      const chatHandler = createChatHandler(LC2.deps)
      for (let i = 1; i <= 9; i++) {
        await streamHandler(mkReq({ message: '第' + i + '轮聊天，主人今天想吃什么' }), mkSseRes())
        await chatHandler(mkReq({ message: '第' + i + '轮聊天，主人今天想吃什么' }), mkJsonRes())
      }
      ok('第 10 次前：两路径都不触发摘要', LS2.summaries.length === 0 && LC2.summaries.length === 0 && U2.summaryCalls.length === 0)
      await chatHandler(mkReq({ message: MESSAGE_10 }), mkJsonRes())
      await streamHandler(mkReq({ message: MESSAGE_10 }), mkSseRes())
      const bothFired = await waitFor(() => U2.summaryCalls.length >= 2 && LS2.summaries.length >= 1 && LC2.summaries.length >= 1)
      ok('第 10 次：两路径都触发摘要并写回', bothFired && LS2.summaries.length === 1 && LC2.summaries.length === 1, 'stream=' + LS2.summaries.length + ' chat=' + LC2.summaries.length)
      ok('第 10 次：两路径写回的摘要内容一致', LS2.summaries[0] === LC2.summaries[0] && LS2.summaries[0] === SUMMARY_TEXT)
      const prompts = U2.summaryCalls.map((c) => String(c.body?.messages?.[1]?.content || ''))
      ok('第 10 次：两路径摘要上下文（旧记忆 + 近 14 条 + 本轮）一致', prompts.length === 2 && prompts[0] === prompts[1] && prompts[0].includes('主人：' + MESSAGE_10))
    })

    // ⑦ 装配接线（静态）：路由能力必须真的注入，否则生产环境静默不记账
    await section('装配接线（静态）', async () => {
      const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
      const start = src.indexOf('createChatStreamHandler(')
      let block = ''
      if (start >= 0) {
        const brace = src.indexOf('{', start)
        if (brace >= 0) {
          let depth = 0
          for (let i = brace; i < src.length; i++) {
            if (src[i] === '{') depth += 1
            else if (src[i] === '}') { depth -= 1; if (depth === 0) { block = src.slice(brace, i + 1); break } }
          }
        }
      }
      ok('index.ts 能找到 createChatStreamHandler 装配块', block.length > 0)
      for (const name of ['loadState', 'saveState', 'addExp', 'saveMemorySummary']) {
        ok('index.ts 向流式注入 ' + name, block.includes(name + ':'))
      }
      const applied = src.indexOf('createChatStreamHandler(') >= 0
        && ['loadState', 'saveState', 'addExp', 'saveMemorySummary'].every((name) => block.includes(name + ':'))
      ok('流式路由在生产装配里拿到完整记账能力', applied)
    })
  } finally {
    globalThis.fetch = realFetch
  }

  return { total }
}

// ---------- 直接运行 ----------

async function main() {
  ensureResolver()
  let pass = 0
  let fail = 0
  const emit = (name, cond, detail = '') => {
    if (cond) { pass += 1; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
    else { fail += 1; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
  }
  console.log('\n[流式聊天记账] scripts/test-stream-ledger.mjs')
  const result = await runStreamLedger(emit, { registerResolver: false })
  console.log('\n  通过 ' + pass + ' 项，失败 ' + fail + ' 项（断言 ' + result.total + ' 条）')
  if (fail > 0) process.exitCode = 1
}

const invokedDirectly = Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url
if (invokedDirectly) {
  main().catch((e) => {
    console.error('流式记账测试运行失败：' + ((e && e.stack) || e))
    process.exitCode = 1
  })
}

