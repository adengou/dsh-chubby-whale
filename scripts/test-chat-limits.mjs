/**
 * scripts/test-chat-limits.mjs —— 聊天链路的限额与安全断言（离线、不联网、不启动 web）
 *
 * 覆盖「/chat 与 /chat-stream 必须同一口径」的限制点，全部按 src/host 的真实实现断言：
 *   ① 消息长度：>500 字截断到 500（chat-core.ts 的 readChatRequest），两路径逐字一致；
 *   ② 图片 base64：4 * 1024 * 1024 字符为界，超一字符即 413（两路径同一状态码与文案）；
 *   ③ 纯空格消息：/chat 回 400 empty message，/chat-stream 回 SSE error 帧（实现如此）；
 *   ④ 非法 lang：只认 zh/en/auto，其余值按 auto 再检测，注入串不进入 prompt；
 *   ⑤ 缓存 key：同输入两路径 chatCacheKey 相同，且与统一算法（含 model、ctx）一致；
 *   ⑥ NO_KEY：/chat 回兜底文案、/chat-stream 回 {error:'NO_KEY'}，均不抛；
 *   ⑦ 流式中断：上游读流异常 / 客户端断开都不写缓存、不 appendTurns、不记 token；
 *   ⑧ 图片 mime：只接受 image/<token>，其余回落 image/jpeg（防客户端伪造）。
 *
 * 用法：
 *   node scripts/test-chat-limits.mjs      # 独立运行，失败退出码 1
 *   test.mjs 里 import { runChatLimits } 并传入自己的 ok()，作为一组并入 npm test
 *
 * 本脚本只读 import 纯函数与路由处理器，不碰 dist、不写项目文件、不联网；
 * 上游 fetch 全部由进程内的假响应替代，缓存用内存 spy，不落盘。
 */

import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

/** 单条消息截断阈值（与 src/host/chat-core.ts 的 CHAT_MAX_MESSAGE_CHARS 一致） */
export const MESSAGE_LIMIT = 500
/** 单图 base64 阈值（与 src/host/chat-core.ts 的 CHAT_MAX_IMAGE_B64 一致：4 * 1024 * 1024 字符） */
export const IMAGE_B64_LIMIT = 4 * 1024 * 1024

let resolverReady = false
function ensureResolver() {
  if (resolverReady) return
  register(new URL('./ts-resolve.mjs', import.meta.url))
  resolverReady = true
}

// ---------- 假请求 / 假响应 ----------

/** 把 body 包成路由期待的异步可迭代请求（readBody 用 for await 读） */
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

/** 缓存替身：只记录读写，不落盘（getJson 一律未命中） */
function mkSpyCache() {
  const cache = { reads: [], writes: [] }
  cache.getJson = async (key) => { cache.reads.push(key); return null }
  cache.setJson = async (key, value) => { cache.writes.push({ key, value }) }
  return cache
}

function baseChatDeps(over = {}) {
  return {
    getKey: () => 'test-key',
    loadHistory: () => [],
    appendTurns: () => { },
    loadState: () => ({ intimacy: 0 }),
    saveState: () => { },
    systemPrompt: 'SYS',
    addExp: () => ({ upgraded: false }),
    addTokens: () => { },
    cache: mkSpyCache(),
    loadMemorySummary: () => '',
    model: 'deepseek-flash',
    ...over,
  }
}

function baseStreamDeps(over = {}) {
  return {
    getKey: () => 'test-key',
    loadHistory: () => [],
    appendTurns: () => { },
    systemPrompt: 'SYS',
    addTokens: () => { },
    cache: mkSpyCache(),
    loadMemorySummary: () => '',
    model: 'deepseek-flash',
    ...over,
  }
}

// ---------- 断言主体 ----------

/**
 * 运行全部限额与安全用例。
 * @param {(name: string, cond: boolean, detail?: string) => void} emit 外部断言回调（test.mjs 的 ok）
 * @param {{ registerResolver?: boolean }} [options] 嵌入 test.mjs 时传 false（该进程已注册解析钩子）
 * @returns {Promise<{ total: number }>}
 */
export async function runChatLimits(emit, options = {}) {
  if (options.registerResolver !== false) ensureResolver()

  const cc = await import('../src/host/chat-core.ts')
  const { createChatHandler } = await import('../src/host/routes/chat.ts')
  const { createChatStreamHandler } = await import('../src/host/routes/chat-stream.ts')

  const realFetch = globalThis.fetch
  const calls = []
  let mode = 'json'   // json（/chat 上游）/ sse（/chat-stream 上游）/ reader（自造读流）
  let reader = null
  const enc = new TextEncoder()

  const sseOf = (pieces) => pieces
    .map((p) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: p } }] }) + '\n\n')
    .join('')

  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body })
    if (mode === 'json') {
      return new Response(JSON.stringify({
        choices: [{ message: { content: '本鲸在呢～' } }],
        usage: { total_tokens: 7 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (mode === 'sse') {
      return new Response(sseOf(['你好', '呀']) + 'data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    if (mode === 'reader') {
      return { ok: true, status: 200, body: { getReader: () => reader } }
    }
    throw new Error('未知上游模式：' + mode)
  }

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
  const bodyOf = (i) => JSON.parse(String(calls[i].body))
  const lastUserOf = (i) => {
    const messages = bodyOf(i).messages
    return messages[messages.length - 1]
  }
  const systemOf = (i) => bodyOf(i).messages[0].content

  try {
    // ① 消息长度：>500 字截断（两路径同一入口）
    await section('消息长度', async () => {
      const max = '字'.repeat(MESSAGE_LIMIT)
      const over = max + '字'
      const coreMax = cc.readChatRequest({ message: max })
      const coreOver = cc.readChatRequest({ message: over })
      ok('chat-core：500 字不截断', coreMax.message === max)
      ok('chat-core：501 字截到前 500 字', coreOver.message === max && coreOver.message.length === MESSAGE_LIMIT)

      const long = '鲸'.repeat(MESSAGE_LIMIT + 1)
      mode = 'json'
      calls.length = 0
      await createChatHandler(baseChatDeps())(mkReq({ message: long }), mkJsonRes())
      const chatMsg = lastUserOf(0).content

      mode = 'sse'
      calls.length = 0
      await createChatStreamHandler(baseStreamDeps())(mkReq({ message: long }), mkSseRes())
      const streamMsg = lastUserOf(0).content

      ok('/chat：501 字截断到 500', typeof chatMsg === 'string' && chatMsg.length === MESSAGE_LIMIT && chatMsg === long.slice(0, MESSAGE_LIMIT))
      ok('/chat-stream：501 字截断到 500', typeof streamMsg === 'string' && streamMsg.length === MESSAGE_LIMIT && streamMsg === long.slice(0, MESSAGE_LIMIT))
      ok('两条路径截断结果逐字一致', chatMsg === streamMsg)
    })

    // ② 图片 base64 上限：4MB 字符，超限 413（两路径同一口径）
    await section('图片 base64 上限', async () => {
      const atLimit = 'A'.repeat(IMAGE_B64_LIMIT)
      const overLimit = atLimit + 'A'
      ok('chat-core：恰好 4MB 字符不判超限', cc.readChatRequest({ message: '看图', image: atLimit }).imageTooLarge === false)
      ok('chat-core：超出 1 字符即判超限', cc.readChatRequest({ message: '看图', image: overLimit }).imageTooLarge === true)

      mode = 'json'
      calls.length = 0
      const chatRes = mkJsonRes()
      await createChatHandler(baseChatDeps())(mkReq({ message: '看图', image: overLimit, imageMime: 'image/png' }), chatRes)
      const chatJson = chatRes.json()
      const chatUpstream = calls.length

      mode = 'sse'
      calls.length = 0
      const streamRes = mkSseRes()
      await createChatStreamHandler(baseStreamDeps())(mkReq({ message: '看图', image: overLimit, imageMime: 'image/png' }), streamRes)
      const streamJson = streamRes.json()
      const streamUpstream = calls.length

      ok('/chat：超限 → 413 image too large', chatRes.code === 413 && !!chatJson && chatJson.ok === false && chatJson.error === 'image too large')
      ok('/chat-stream：超限 → 413 image too large', streamRes.code === 413 && !!streamJson && streamJson.error === 'image too large')
      ok('两条路径超限文案一致且带原因', chatJson.reply === streamJson.reply && String(chatJson.reply).includes('太大') && String(chatJson.reply).includes('3MB'))
      ok('流式超限在 SSE 头之前拒绝（无 data 帧）', streamRes.events().length === 0 && streamRes.raw().indexOf('data: ') < 0)
      ok('超限不请求上游', chatUpstream === 0 && streamUpstream === 0)

      // 边界放行：恰好 4MB 应照常交给模型
      mode = 'json'
      calls.length = 0
      const chatAtRes = mkJsonRes()
      await createChatHandler(baseChatDeps())(mkReq({ message: '看图', image: atLimit, imageMime: 'image/png' }), chatAtRes)
      const atUser = lastUserOf(0)
      ok('/chat：恰好 4MB 放行并交给模型', calls.length === 1 && chatAtRes.code === 200 && Array.isArray(atUser.content) && atUser.content[1].image_url.url.indexOf('data:image/png;base64,') === 0)

      mode = 'sse'
      calls.length = 0
      const streamAtRes = mkSseRes()
      await createChatStreamHandler(baseStreamDeps())(mkReq({ message: '看图', image: atLimit, imageMime: 'image/png' }), streamAtRes)
      ok('/chat-stream：恰好 4MB 放行并交给模型', calls.length === 1 && streamAtRes.events().some((e) => e.done === true))
    })

    // ③ 纯空格消息：/chat 400，/chat-stream SSE error 帧
    await section('纯空格消息', async () => {
      const blank = '   \n\t '
      mode = 'json'
      calls.length = 0
      const chatRes = mkJsonRes()
      await createChatHandler(baseChatDeps())(mkReq({ message: blank }), chatRes)
      const chatJson = chatRes.json()
      ok('/chat：纯空格 → 400 empty message', chatRes.code === 400 && !!chatJson && chatJson.ok === false && chatJson.error === 'empty message')
      ok('/chat：纯空格不请求上游', calls.length === 0)

      mode = 'sse'
      calls.length = 0
      const streamRes = mkSseRes()
      await createChatStreamHandler(baseStreamDeps())(mkReq({ message: blank }), streamRes)
      const events = streamRes.events()
      ok('/chat-stream：纯空格 → error empty message 帧', streamRes.code === 200 && events.length === 1 && events[0].error === 'empty message')
      ok('/chat-stream：纯空格不请求上游', calls.length === 0)

      // 全角空格属于空白，同样应判空
      mode = 'json'
      const chatRes2 = mkJsonRes()
      await createChatHandler(baseChatDeps())(mkReq({ message: '\u3000\u3000' }), chatRes2)
      mode = 'sse'
      const streamRes2 = mkSseRes()
      await createChatStreamHandler(baseStreamDeps())(mkReq({ message: '\u3000\u3000' }), streamRes2)
      ok('全角空格同样判空（两路径口径一致）', !!chatRes2.json() && chatRes2.json().error === 'empty message' && streamRes2.events().some((e) => e.error === 'empty message'))
    })

    // ④ 非法 lang 注入：非 zh/en/auto 回落 auto 检测，注入串不进 prompt
    await section('非法 lang 注入', async () => {
      const injection = 'zh"><script>'
      ok('非法 lang：中文消息按 auto 检测为 zh', cc.readChatRequest({ message: '主人今天吃什么', lang: injection }).lang === 'zh')
      ok('非法 lang：英文消息按 auto 检测为 en', cc.readChatRequest({ message: 'hello there', lang: injection }).lang === 'en')
      ok('非法 lang：无字母数字消息回 auto', cc.readChatRequest({ message: '12345 !!!', lang: injection }).lang === 'auto')
      ok('合法 lang 不被内容覆盖（显式 en 保留）', cc.readChatRequest({ message: '主人今天吃什么', lang: 'en' }).lang === 'en')
      ok('非字符串 lang 回落 auto 检测', cc.readChatRequest({ message: 'hello there', lang: 42 }).lang === 'en')

      mode = 'json'
      calls.length = 0
      await createChatHandler(baseChatDeps())(mkReq({ message: '主人今天吃什么', lang: injection }), mkJsonRes())
      const chatSystem = systemOf(0)
      mode = 'sse'
      calls.length = 0
      await createChatStreamHandler(baseStreamDeps())(mkReq({ message: '主人今天吃什么', lang: injection }), mkSseRes())
      const streamSystem = systemOf(0)

      ok('两路径 system prompt 一致（非法 lang 同口径）', chatSystem === streamSystem)
      ok('非法 lang 注入不进入 prompt', chatSystem.indexOf('<script>') < 0 && chatSystem.indexOf(injection) < 0)
      ok('按中文档位拼装语言规则', chatSystem.includes('主人用中文提问') && chatSystem.includes('请用中文回答'))
    })

    // ⑤ 缓存 key 一致性：同输入两路径同键，且与统一算法（含 model、ctx）一致
    await section('缓存 key 一致性', async () => {
      const message = '主人今天想吃什么呀'
      const history = [{ role: 'user', content: '早上好' }, { role: 'assistant', content: '早呀' }]
      const keyOf = async (model, summary) => {
        const chatCache = mkSpyCache()
        const streamCache = mkSpyCache()
        mode = 'json'
        calls.length = 0
        await createChatHandler(baseChatDeps({ cache: chatCache, loadMemorySummary: () => summary, loadHistory: () => history, model }))(mkReq({ message }), mkJsonRes())
        mode = 'sse'
        calls.length = 0
        await createChatStreamHandler(baseStreamDeps({ cache: streamCache, loadMemorySummary: () => summary, loadHistory: () => history, model }))(mkReq({ message }), mkSseRes())
        return {
          chat: chatCache.reads[0],
          stream: streamCache.reads[0],
          expect: cc.chatCacheKey('zh', message, false, cc.chatContextFingerprint(summary, history), model),
        }
      }

      const base = await keyOf('deepseek-flash', '主人喜欢白饭')
      ok('同输入两路径缓存 key 相同', !!base.chat && base.chat === base.stream)
      ok('缓存 key 与统一算法一致（含 model、ctx）', base.chat === base.expect)

      const otherModel = await keyOf('deepseek-v4-pro', '主人喜欢白饭')
      ok('换模型：两路径仍一致且 key 变化', !!otherModel.chat && otherModel.chat === otherModel.stream && otherModel.chat !== base.chat && otherModel.chat === otherModel.expect)

      const otherCtx = await keyOf('deepseek-flash', '主人喜欢面条')
      ok('换上下文记忆：两路径仍一致且 key 变化', !!otherCtx.chat && otherCtx.chat === otherCtx.stream && otherCtx.chat !== base.chat && otherCtx.chat === otherCtx.expect)
    })

    // ⑥ NO_KEY：两路径都不崩，错误语义各自符合协议
    await section('NO_KEY', async () => {
      mode = 'json'
      calls.length = 0
      const chatRes = mkJsonRes()
      let chatThrew = null
      try {
        await createChatHandler(baseChatDeps({ getKey: () => '' }))(mkReq({ message: '在吗' }), chatRes)
      } catch (e) { chatThrew = e }
      const chatJson = chatRes.json()
      ok('/chat：NO_KEY 不崩且回兜底文案', chatThrew === null && chatRes.code === 200 && !!chatJson && chatJson.ok === false && chatJson.error === 'NO_KEY' && typeof chatJson.reply === 'string' && chatJson.reply.length > 0)
      ok('/chat：NO_KEY 不请求上游', calls.length === 0)

      mode = 'sse'
      calls.length = 0
      const streamRes = mkSseRes()
      let streamThrew = null
      try {
        await createChatStreamHandler(baseStreamDeps({ getKey: () => '' }))(mkReq({ message: '在吗' }), streamRes)
      } catch (e) { streamThrew = e }
      const events = streamRes.events()
      ok('/chat-stream：NO_KEY 不崩且回 {error:"NO_KEY"}', streamThrew === null && streamRes.code === 200 && events.some((e) => e.error === 'NO_KEY'))
      ok('/chat-stream：NO_KEY 只回错误帧、无 done', !events.some((e) => e.done === true) && events.filter((e) => typeof e.error === 'string').length === 1)
      ok('两条路径 NO_KEY 错误码一致', !!chatJson && chatJson.error === 'NO_KEY' && events.some((e) => e.error === 'NO_KEY'))
    })

    // ⑦ 流式中断不落盘：半截回复不能写缓存/记忆，也不记 token
    await section('流式中断不落盘', async () => {
      const message = '这句话长一点足够进缓存'
      const halfSse = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '半截' } }] }) + '\n\n'

      // 情形 A：上游读流中途抛错
      let reads = 0
      mode = 'reader'
      reader = {
        async read() {
          reads += 1
          if (reads === 1) return { value: enc.encode(halfSse), done: false }
          throw new Error('upstream reset')
        },
        releaseLock() { },
      }
      const cacheA = mkSpyCache()
      const appendedA = []
      const tokensA = []
      const resA = mkSseRes()
      await createChatStreamHandler(baseStreamDeps({
        cache: cacheA,
        appendTurns: (u, r) => { appendedA.push([u, r]) },
        addTokens: (...args) => { tokensA.push(args) },
      }))(mkReq({ message }), resA)
      const eventsA = resA.events()
      ok('上游中断：半截 delta 已推送', eventsA.some((e) => e.delta === '半截'))
      ok('上游中断：回 error 帧、无 done', eventsA.some((e) => /^stream:/.test(String(e.error))) && !eventsA.some((e) => e.done === true))
      ok('上游中断：不写缓存', cacheA.writes.length === 0)
      ok('上游中断：不 appendTurns', appendedA.length === 0)
      ok('上游中断：不记 token', tokensA.length === 0)

      // 情形 B：客户端提前断开（close 事件），上游数据仍完整。
      // 第二次 read 挂起，确保 close 发生在流读取途中，而不是整条流已经收尾之后。
      const fullSse = sseOf(['你好', '呀']) + 'data: [DONE]\n\n'
      let releaseRead = () => { }
      const readGate = new Promise((resolve) => { releaseRead = resolve })
      let served = false
      mode = 'reader'
      reader = {
        async read() {
          if (!served) { served = true; return { value: enc.encode(fullSse), done: false } }
          await readGate
          return { value: undefined, done: true }
        },
        releaseLock() { },
      }
      const cacheB = mkSpyCache()
      const appendedB = []
      const tokensB = []
      const resB = mkSseRes()
      const running = createChatStreamHandler(baseStreamDeps({
        cache: cacheB,
        appendTurns: (u, r) => { appendedB.push([u, r]) },
        addTokens: (...args) => { tokensB.push(args) },
      }))(mkReq({ message }), resB)
      for (let i = 0; i < 500 && !resB.onClose; i++) await new Promise((resolve) => setTimeout(resolve, 1))
      const hasClose = typeof resB.onClose === 'function'
      if (hasClose) resB.onClose()
      releaseRead()
      await running
      const eventsB = resB.events()
      ok('客户端断开：已注册 close 监听', hasClose)
      ok('客户端断开：delta 已推送、无 done', eventsB.some((e) => e.delta === '你好') && !eventsB.some((e) => e.done === true))
      // 2026-11-07 B95：上游已读完（close 之后第二次 read 才返回 done）→ 完整回复照常落盘，
      // 与 /chat 同口径；只有半截（上游没读完）才不落盘。
      ok('客户端断开但上游已读完：写缓存', cacheB.writes.length === 1)
      ok('客户端断开但上游已读完：appendTurns 记完整正文', appendedB.length === 1 && appendedB[0][1] === '你好呀', JSON.stringify(appendedB))
      ok('客户端断开但上游已读完：不记 token（该上游没给 usage）', tokensB.length === 0)

      // 对照：正常读完必须落盘，否则上面的"不落盘"只是路径本来就不写。
      // 上游按 stream_options.include_usage 的约定在 [DONE] 前给一帧 usage，token 断言才成立。
      const usageFrame = 'data: ' + JSON.stringify({ choices: [], usage: { total_tokens: 7 } }) + '\n\n'
      mode = 'sse'
      const cacheC = mkSpyCache()
      const appendedC = []
      const tokensC = []
      const resC = mkSseRes()
      const originalResponse = globalThis.fetch
      globalThis.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), body: init.body })
        return new Response(sseOf(['你好', '呀']) + usageFrame + 'data: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      try {
        await createChatStreamHandler(baseStreamDeps({
          cache: cacheC,
          appendTurns: (u, r) => { appendedC.push([u, r]) },
          addTokens: (...args) => { tokensC.push(args) },
        }))(mkReq({ message }), resC)
      } finally {
        globalThis.fetch = originalResponse
      }
      ok('对照：正常读完会写缓存、写记忆、记 token', cacheC.writes.length === 1 && appendedC.length === 1 && tokensC.length === 1 && resC.events().some((e) => e.done === true))
    })

    // ⑧ 图片 mime 白名单：只认 image/<token>，其余回落 image/jpeg
    await section('图片 mime 白名单', async () => {
      const mimeOf = (imageMime) => cc.readChatRequest({ message: '看图', image: 'QUJD', imageMime }).image.mime
      ok('image/png 保留', mimeOf('image/png') === 'image/png')
      ok('image/svg+xml 在允许字符集内保留', mimeOf('image/svg+xml') === 'image/svg+xml')
      ok('text/html 回落 image/jpeg', mimeOf('text/html') === 'image/jpeg')
      ok('带参数 image/png;base64 回落 image/jpeg', mimeOf('image/png;base64') === 'image/jpeg')
      ok('大写 IMAGE/PNG 回落 image/jpeg', mimeOf('IMAGE/PNG') === 'image/jpeg')
      ok('subtype 超 32 字符回落 image/jpeg', mimeOf('image/' + 'a'.repeat(33)) === 'image/jpeg')
      ok('首尾空白 trim 后保留', mimeOf(' image/webp ') === 'image/webp')
      ok('非字符串回落 image/jpeg', mimeOf(42) === 'image/jpeg')

      mode = 'json'
      calls.length = 0
      await createChatHandler(baseChatDeps())(mkReq({ message: '这是什么', image: 'QUJD', imageMime: 'text/html' }), mkJsonRes())
      const chatBad = lastUserOf(0).content[1].image_url.url
      mode = 'sse'
      calls.length = 0
      await createChatStreamHandler(baseStreamDeps())(mkReq({ message: '这是什么', image: 'QUJD', imageMime: 'text/html' }), mkSseRes())
      const streamBad = lastUserOf(0).content[1].image_url.url
      ok('/chat：非 image/* 回落为 jpeg data URL', chatBad.indexOf('data:image/jpeg;base64,') === 0)
      ok('/chat-stream：非 image/* 回落为 jpeg data URL', streamBad.indexOf('data:image/jpeg;base64,') === 0)
      ok('两路径回落结果一致', chatBad === streamBad)

      mode = 'json'
      calls.length = 0
      await createChatHandler(baseChatDeps())(mkReq({ message: '这是什么', image: 'QUJD', imageMime: 'image/webp' }), mkJsonRes())
      const chatGood = lastUserOf(0).content[1].image_url.url
      ok('/chat：合法 image/webp 保留', chatGood.indexOf('data:image/webp;base64,') === 0)
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
  console.log('\n[聊天限额与安全] scripts/test-chat-limits.mjs')
  const result = await runChatLimits(emit, { registerResolver: false })
  console.log('\n  通过 ' + pass + ' 项，失败 ' + fail + ' 项（断言 ' + result.total + ' 条）')
  if (fail > 0) process.exitCode = 1
}

const invokedDirectly = Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url
if (invokedDirectly) await main()
