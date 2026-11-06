/**
 * scripts/test-chat-routes.mjs —— 聊天路由（/chat 与 /chat-stream）治理与正确性回归
 *
 * 这批用例专门盯「两条路径同口径」与「路由不被内部状态绑架」，全部离线：
 * 上游 fetch、缓存、store 全部是进程内替身，不联网、不落盘、不启动 web 服务。
 *
 * 覆盖（A~E 是 BUG 回归，F 是封装治理）：
 *   A. 流式收尾 flush：上游最后一个 data 行没有行尾换行时，最后一段正文与 usage 帧
 *      不能被 parseSseBuffer 当残留丢掉（丢了就会把「走神了」兜底文案写进记忆和 7 天缓存）。
 *   B. 摘要计数器：每 createChatStreamHandler 一份，不是模块级共享
 *      （模块级计数会让第二个 handler 实例替第一个凑满 10 次摘要）。
 *   C. 缓存命中判空同口径：缓存里是纯空白 reply 时，两条路径都不算命中。
 *   D. /chat 亲密度读写失败不能吃掉已付费的回复（流式早已 try 包住，普通路径没有）。
 *   E. 并发：/chat 与 /chat-stream 同时到达时，记忆走 appendTurns 追加、
 *      亲密度同步读改写，互不覆盖。
 *   F. 封装治理：路由只经 ports 注入取状态，不 import 具体仓储、不做整份历史覆盖写。
 *
 * 用法：
 *   node scripts/test-chat-routes.mjs          # 独立运行，失败退出码 1
 *   npm test 不含本文件（未改 package.json / test.mjs）；需要并入时在 test.mjs 里
 *   `const { runChatRoutes } = await import('./test-chat-routes.mjs')`，再把它当一组跑。
 */

import { register } from 'node:module'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const MESSAGE = '主人今天吃白饭了吗'
const MESSAGE_10 = '第十轮聊天，主人今晚吃米饭吗'
const REPLY = '你好呀'
const USAGE_TOKENS = 9
const SUMMARY_TEXT = '新摘要'

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

function mkReq(body) {
  const buf = Buffer.from(JSON.stringify(body))
  return {
    method: 'POST',
    url: '/api/chubby-whale/chat',
    headers: {},
    destroy() { },
    on() { },
    resume() { },
    async *[Symbol.asyncIterator]() { yield buf },
  }
}

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

// ---------- 端口替身 ----------

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
    throws: {
      loadState: false,
      saveState: false,
    },
  }
  L.deps = {
    getKey: () => 'test-key',
    loadHistory: () => L.history.slice(),
    appendTurns: (userText, replyText) => {
      L.turns.push([userText, replyText])
      L.history.push({ role: 'user', content: userText }, { role: 'assistant', content: replyText })
    },
    loadState: () => {
      L.loads += 1
      if (L.throws.loadState) throw new Error('state read failed')
      return L.state
    },
    saveState: (s) => {
      if (L.throws.saveState) throw new Error('state write failed')
      L.saves.push(s)
      L.state = s
    },
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
  L.depsStream = { ...L.deps }
  return L
}

const sseOfReply = (text) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n'

function mkUpstream(opts = {}) {
  const U = {
    calls: [],
    summaryCalls: [],
    sseText: sseOfReply(REPLY) + 'data: ' + JSON.stringify({ choices: [], usage: { total_tokens: USAGE_TOKENS } }) + '\n\ndata: [DONE]\n\n',
    chatReply: REPLY,
    usage: USAGE_TOKENS,
    delayMs: Number(opts.delayMs) || 0,
    summaryReply: SUMMARY_TEXT,
  }
  U.fetch = async (url, init = {}) => {
    if (U.delayMs > 0) await sleep(U.delayMs)
    let body = null
    try { body = JSON.parse(String(init.body || '{}')) } catch { body = null }
    if (body && body.stream === true) {
      U.calls.push({ url: String(url), body, kind: 'stream' })
      return new Response(U.sseText, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const sys = String(body && body.messages && body.messages[0] && body.messages[0].content || '')
    if (sys.includes('整理长期记忆')) {
      U.summaryCalls.push({ url: String(url), body })
      return new Response(JSON.stringify({ choices: [{ message: { content: U.summaryReply } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    U.calls.push({ url: String(url), body, kind: 'chat' })
    return new Response(JSON.stringify({
      choices: [{ message: { content: U.chatReply } }],
      usage: { total_tokens: U.usage },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return U
}

// ---------- 模块加载 ----------

let freshSeq = 0
async function loadFresh(modRelPath) {
  freshSeq += 1
  const base = new URL(modRelPath, import.meta.url).href
  return import(base + (base.includes('?') ? '&' : '?') + 'fresh=' + Date.now() + '-' + freshSeq)
}

// ---------- 断言主体 ----------

export async function runChatRoutes(emit, options = {}) {
  if (options.registerResolver !== false) ensureResolver()

  const { createChatHandler } = await import('../src/host/routes/chat.ts')
  const { createChatStreamHandler } = await import('../src/host/routes/chat-stream.ts')
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
  const doneOf = (res) => res.events().find((e) => e.done === true)

  try {
    // A. 流式收尾 flush
    await section('流式末帧无行尾换行', async () => {
      const U = mkUpstream()
      // 整条流只有一帧，且没有行尾换行（上游直接关连接）
      U.sseText = 'data: ' + JSON.stringify({ choices: [{ delta: { content: REPLY } }] })
      globalThis.fetch = U.fetch
      const L = mkLedger()
      const res = mkSseRes()
      await createChatStreamHandler(L.depsStream)(mkReq({ message: MESSAGE }), res)
      const done = doneOf(res)
      ok('末帧无换行：正文没有被丢掉', !!done && done.reply === REPLY, JSON.stringify(done))
      ok('末帧无换行：不写「走神了」兜底文案', !!done && !String(done.reply).includes('走神'), String(done && done.reply))
      ok('末帧无换行：记忆记的是真回复', L.turns.length === 1 && L.turns[0][1] === REPLY, JSON.stringify(L.turns))
      ok('末帧无换行：缓存里是完整回复', L.cache.writes.length === 1 && L.cache.writes[0].value.reply === REPLY, JSON.stringify(L.cache.writes.map((w) => w.value)))

      // usage 帧在最后且没有行尾换行：token 不能漏记
      const U2 = mkUpstream()
      U2.sseText = sseOfReply(REPLY) + 'data: ' + JSON.stringify({ choices: [], usage: { total_tokens: USAGE_TOKENS } })
      globalThis.fetch = U2.fetch
      const L2 = mkLedger()
      const res2 = mkSseRes()
      await createChatStreamHandler(L2.depsStream)(mkReq({ message: MESSAGE }), res2)
      ok('末帧无换行：usage 照记', L2.tokens.length === 1 && L2.tokens[0][1] === USAGE_TOKENS, JSON.stringify(L2.tokens))
      ok('末帧无换行：回复完整', (doneOf(res2) || {}).reply === REPLY, JSON.stringify(doneOf(res2)))
      globalThis.fetch = realFetch
    })

    // B. 摘要计数器：每个 handler 一份（同一模块实例建两个 handler）
    await section('摘要计数器按 handler 隔离', async () => {
      const mod = await loadFresh('../src/host/routes/chat-stream.ts')
      const U = mkUpstream()
      globalThis.fetch = U.fetch
      const LA = mkLedger()
      const LB = mkLedger()
      const hA = mod.createChatStreamHandler(LA.depsStream)
      const hB = mod.createChatStreamHandler(LB.depsStream)
      for (let i = 1; i <= 5; i++) {
        await hA(mkReq({ message: '第' + i + '轮聊天，主人今天想吃什么' }), mkSseRes())
        await hB(mkReq({ message: '第' + i + '轮聊天，主人今天想吃什么' }), mkSseRes())
      }
      await sleep(50)
      ok('两个 handler 各 5 次：还没到 10 次，不触发摘要',
        U.summaryCalls.length === 0 && LA.summaries.length === 0 && LB.summaries.length === 0,
        'fetches=' + U.summaryCalls.length + ' saves=' + LA.summaries.length + '/' + LB.summaries.length)

      // 同一个 handler 跑满 10 次仍然要触发（防止为过上面那条把功能改死）
      const mod2 = await loadFresh('../src/host/routes/chat-stream.ts')
      const U2 = mkUpstream()
      globalThis.fetch = U2.fetch
      const LC = mkLedger()
      const hC = mod2.createChatStreamHandler(LC.depsStream)
      for (let i = 1; i <= 9; i++) await hC(mkReq({ message: '第' + i + '轮聊天，主人今天想吃什么' }), mkSseRes())
      ok('同一 handler 前 9 次不触发摘要', U2.summaryCalls.length === 0)
      await hC(mkReq({ message: MESSAGE_10 }), mkSseRes())
      const fired = await waitFor(() => U2.summaryCalls.length >= 1 && LC.summaries.length >= 1)
      ok('同一 handler 第 10 次触发摘要并写回', fired && U2.summaryCalls.length === 1 && LC.summaries[0] === SUMMARY_TEXT, JSON.stringify(LC.summaries))
      globalThis.fetch = realFetch
    })

    // C. 缓存命中判空口径（纯空白 reply）
    await section('缓存里是纯空白回复', async () => {
      const blankHit = { reply: '   ' }
      const U = mkUpstream()
      globalThis.fetch = U.fetch
      const chatL = mkLedger({ cache: mkSpyCache(blankHit) })
      const chatRes = mkJsonRes()
      await createChatHandler(chatL.deps)(mkReq({ message: MESSAGE }), chatRes)
      const chatJson = chatRes.json()

      const streamL = mkLedger({ cache: mkSpyCache(blankHit) })
      const streamRes = mkSseRes()
      await createChatStreamHandler(streamL.depsStream)(mkReq({ message: MESSAGE }), streamRes)
      const done = doneOf(streamRes)

      ok('/chat：空白缓存不算命中，走模型', chatJson.ok === true && chatJson.reply === REPLY && chatJson.cached !== true)
      ok('/chat-stream：空白缓存不算命中，走模型', !!done && done.reply === REPLY && done.cached === false, JSON.stringify(done))
      ok('两条路径对空白缓存的判断一致', (chatJson.reply === REPLY) === (!!done && done.reply === REPLY))
      ok('两条路径都照常记账（没被空缓存吃掉一轮）',
        chatL.turns.length === 1 && chatL.exp.length === 1 && streamL.turns.length === 1 && streamL.exp.length === 1,
        'chat=' + chatL.turns.length + '/' + chatL.exp.length + ' stream=' + streamL.turns.length + '/' + streamL.exp.length)
      globalThis.fetch = realFetch
    })

    // D. /chat 亲密度读写失败不能吃掉回复
    await section('/chat 亲密度读写失败', async () => {
      const U = mkUpstream()
      globalThis.fetch = U.fetch

      const LR = mkLedger({ intimacy: 3 })
      LR.throws.loadState = true
      const resR = mkJsonRes()
      await createChatHandler(LR.deps)(mkReq({ message: MESSAGE }), resR)
      const jsonR = resR.json()
      ok('loadState 抛错：仍然回真回复', !!jsonR && jsonR.ok === true && jsonR.reply === REPLY, JSON.stringify(jsonR))
      ok('loadState 抛错：intimacy 回 0 而不是崩', !!jsonR && jsonR.intimacy === 0, JSON.stringify(jsonR && jsonR.intimacy))
      ok('loadState 抛错：模型回复仍写进记忆（只写一次）', LR.turns.length === 1, JSON.stringify(LR.turns))

      const LW = mkLedger({ intimacy: 3 })
      LW.throws.saveState = true
      const resW = mkJsonRes()
      await createChatHandler(LW.deps)(mkReq({ message: MESSAGE }), resW)
      const jsonW = resW.json()
      ok('saveState 抛错：仍然回真回复', !!jsonW && jsonW.ok === true && jsonW.reply === REPLY, JSON.stringify(jsonW))
      ok('saveState 抛错：回复仍入记忆', LW.turns.length === 1)

      // 对照：流式早就 try 包住，同样抛错也要回真回复
      const LS = mkLedger({ intimacy: 3 })
      LS.throws.loadState = true
      const resS = mkSseRes()
      await createChatStreamHandler(LS.depsStream)(mkReq({ message: MESSAGE }), resS)
      ok('流式 loadState 抛错：回真回复（两路径同口径）', (doneOf(resS) || {}).reply === REPLY, JSON.stringify(doneOf(resS)))
      globalThis.fetch = realFetch
    })

    // E. 并发：/chat 与 /chat-stream 同时到达
    await section('并发两路同时到达', async () => {
      const U = mkUpstream({ delayMs: 20 })
      globalThis.fetch = U.fetch
      const L = mkLedger({ intimacy: 40 })
      const [rChat, rStream] = await Promise.all([
        createChatHandler(L.deps)(mkReq({ message: '主人问第一句，今天吃什么' }), mkJsonRes()),
        createChatStreamHandler(L.depsStream)(mkReq({ message: '主人问第二句，今天喝什么' }), mkSseRes()),
      ])
      ok('两路都完成', rChat !== null && rStream !== null && L.turns.length === 2, 'turns=' + L.turns.length)
      const asked = L.turns.map((t) => t[0]).sort()
      ok('两轮的提问都在记忆里（没有互相覆盖）',
        asked.length === 2 && asked[0].includes('第一句') && asked[1].includes('第二句'), JSON.stringify(asked))
      ok('两轮回复都完整', L.turns.every((t) => t[1] === REPLY), JSON.stringify(L.turns.map((t) => t[1])))
      ok('亲密度两次 +1（40 → 42）', L.state.intimacy === 42, 'intimacy=' + L.state.intimacy)
      ok('两路各记一次经验', L.exp.length === 2, JSON.stringify(L.exp))
      ok('两路各记一次 token', L.tokens.length === 2, JSON.stringify(L.tokens))
      globalThis.fetch = realFetch
    })

    // F. 封装治理（静态）
    await section('封装治理（静态）', async () => {
      const chatSrc = readFileSync(new URL('../src/host/routes/chat.ts', import.meta.url), 'utf8')
      const streamSrc = readFileSync(new URL('../src/host/routes/chat-stream.ts', import.meta.url), 'utf8')
      const coreSrc = readFileSync(new URL('../src/host/chat-core.ts', import.meta.url), 'utf8')

      const readsImpl = (src) => /from '\.\.\/(repos|store|data)\//.test(src)
      ok('/chat 只经 ports 取状态：不 import 具体仓储', !readsImpl(chatSrc))
      ok('/chat-stream 只经 ports 取状态：不 import 具体仓储', !readsImpl(streamSrc))
      ok('两条路由都不做整份历史覆盖写（无 saveHistory 调用）',
        !/saveHistory\s*\(/.test(chatSrc) && !/saveHistory\s*\(/.test(streamSrc))
      ok('两条路由的记忆写在同一个入口 appendTurns 上',
        /appendTurns/.test(chatSrc) && /appendTurns/.test(streamSrc))
      const hasModuleState = /^\s*(let|var)\s+\w+\s*=/m.test(coreSrc)
      ok('chat-core 是纯函数模块：没有模块级可变状态', !hasModuleState, hasModuleState ? '匹配到模块级 let/var' : '')
      ok('路由之间不横向 import（流式不 import chat.ts）',
        !/from '\.\/chat\.js'/.test(streamSrc) && !/from '\.\/chat\.ts'/.test(streamSrc))
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
  console.log('\n[聊天路由治理与正确性] scripts/test-chat-routes.mjs')
  const result = await runChatRoutes(emit, { registerResolver: false })
  console.log('\n  通过 ' + pass + ' 项，失败 ' + fail + ' 项（断言 ' + result.total + ' 条）')
  if (fail > 0) process.exitCode = 1
}

const invokedDirectly = Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url
if (invokedDirectly) {
  main().catch((e) => {
    console.error('聊天路由测试运行失败：' + ((e && e.stack) || e))
    process.exitCode = 1
  })
}
