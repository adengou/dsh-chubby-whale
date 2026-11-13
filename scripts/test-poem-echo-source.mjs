/**
 * scripts/test-poem-echo-source.mjs —— 诗词弹幕「触发源」回归（离线、不联网）
 *
 * 2026-11-14 主人要求：在 Harness 工作区输入框打字**不能**冒诗（会打扰干活），
 * 只有菜单「跟她说两句」里的聊天才触发。旧实现把匹配挂在宿主 user/message 事件上，
 * 于是工作区每句话都可能冒一首诗。
 *
 * 本文件钉住三件事：
 *   A. 收集器：DSH 的 user/message 只记摘要，不再产生 poem-echo；keywordEcho 一次都不调。
 *   B. 收集器：noteUserChat（鲸鱼聊天专用入口）命中才推 poem-echo，带整首/冷却用的 theme。
 *   C. 两条聊天路由（/chat、/chat-stream）都把自己的 message 交给 noteUserChat；
 *      空消息不触发；装配层（index.ts）确实把收集器接到两条路由上。
 *
 * 用法：node scripts/test-poem-echo-source.mjs
 * 退出码：0 = 全过；1 = 有失败
 */
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

register(new URL('./ts-resolve.mjs', import.meta.url))

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

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

const realFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('测试不许真联网') }

function mkRes() {
  const out = {
    code: 0, headers: {}, chunks: [], headersSent: false, writableEnded: false, writableFinished: false,
  }
  out.writeHead = (c, h) => { out.code = c; out.headers = h || {}; out.headersSent = true }
  out.setHeader = (k, v) => { out.headers[k] = v }
  out.write = (b) => { if (b) out.chunks.push(Buffer.from(String(b))) }
  out.end = (b) => { if (b) out.chunks.push(Buffer.from(String(b))); out.writableEnded = true; out.writableFinished = true }
  out.flushHeaders = () => { }
  out.on = () => { }
  out.bodyText = () => Buffer.concat(out.chunks).toString('utf8')
  out.json = () => { try { return JSON.parse(out.bodyText()) } catch { return null } }
  return out
}

function mkReq(body, method = 'POST') {
  const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  return {
    method,
    url: '/api/chubby-whale/chat',
    headers: { 'content-length': String(buf.length) },
    destroy() { }, on() { }, resume() { },
    async *[Symbol.asyncIterator]() { yield buf },
  }
}

try {
  const { createHostCollector } = await import('../src/host/nervous/collector.ts')
  const { createChatHandler } = await import('../src/host/routes/chat.ts')
  const { createChatStreamHandler } = await import('../src/host/routes/chat-stream.ts')

  // ======================================================================
  group('[A] DSH user/message 不再产生诗词弹幕')
  {
    const knocks = []
    const findCalls = []
    const collector = createHostCollector({
      cap: 20,
      keywordEcho: (text) => { knocks.push(text); return null },
      findPoem: async (t) => { findCalls.push(t); return null },
    })
    const listeners = {}
    const ctx = {
      on(name, fn) { listeners[name] = fn; return () => { delete listeners[name] } },
    }
    collector.start(ctx)
    ok('收集器订阅了 session/event', typeof listeners['session/event'] === 'function')

    // 模拟 DSH 输入框发的一句话（工作指令里带诗里的词，旧实现会冒诗）
    listeners['session/event']({ id: 'sess-abc' }, {
      type: 'user/message',
      seq: 1,
      data: { content: [{ type: 'text', text: '寻寻觅觅，把这段代码改成流式' }] },
    })
    await tick(20)
    const evs = collector.recent()
    ok('user/message 仍记一条摘要（神经感知没残废）',
      evs.length === 1 && evs[0].data.event === 'session/event' && evs[0].data.name === 'user/message', JSON.stringify(evs))
    ok('不再产生 poem-echo', evs.every((e) => e.data.name !== 'poem-echo'), JSON.stringify(evs.map((e) => e.data.name)))
    ok('DSH 输入完全不进诗词匹配（keywordEcho 0 次）', knocks.length === 0, 'calls=' + knocks.length)
    ok('也不会去查整首（findPoem 0 次）', findCalls.length === 0, 'calls=' + findCalls.length)
    ok('摘要里不落用户原文（只存事件名/seq/会话前缀）',
      JSON.stringify(evs[0]).indexOf('寻寻觅觅') < 0 && JSON.stringify(evs[0]).indexOf('流式') < 0, JSON.stringify(evs[0]))
    collector.stop()
  }

  // ======================================================================
  group('[B] noteUserChat（鲸鱼聊天专用）：命中才推 poem-echo')
  {
    const text = '寻寻觅觅，冷冷清清'
    let seen = ''
    const collector = createHostCollector({
      cap: 20,
      keywordEcho: (t) => { seen = t; return { theme: '关键词', line: '寻寻觅觅，冷冷清清，凄凄惨惨戚戚。', title: '声声慢', author: '李清照' } },
      findPoem: async (title, author) => (title === '声声慢' ? ['寻寻觅觅，冷冷清清，凄凄惨惨戚戚。', '乍暖还寒时候，最难将息。'] : null),
    })
    collector.noteUserChat(text)
    await tick(30)
    const evs = collector.recent()
    const echo = evs.find((e) => e.data.name === 'poem-echo')
    ok('鲸鱼聊天里命中 → 推一条 poem-echo', !!echo, JSON.stringify(evs))
    ok('匹配用的是主人原话', seen === text, JSON.stringify(seen))
    ok('带 theme（客户端靠它判「关键词不冷却」）', echo && echo.data.theme === '关键词', JSON.stringify(echo && echo.data))
    ok('带整首（async 补全落地）', echo && Array.isArray(echo.data.full) && echo.data.full.length === 2, JSON.stringify(echo && echo.data.full))
    ok('带出处（标题/作者）', echo && echo.data.title === '声声慢' && echo.data.author === '李清照', JSON.stringify(echo && echo.data))

    // 不命中 / 空文本 / 非字符串：不推、不抛
    const before = collector.recent().length
    const quiet = createHostCollector({ cap: 10, keywordEcho: () => null })
    quiet.noteUserChat('今天吃什么')
    quiet.noteUserChat('')
    quiet.noteUserChat(null)
    quiet.noteUserChat(12345)
    await tick(20)
    ok('不命中/空值不产生事件，也不抛', quiet.recent().length === 0, JSON.stringify(quiet.recent()))
    ok('别人的收集器不受影响', collector.recent().length === before)

    // findPoem 挂了：仍要发一句（弹幕不能因为查整首失败就没了）
    const fallback = createHostCollector({
      cap: 10,
      keywordEcho: () => ({ theme: '意境', line: '一蓑烟雨任平生。', title: '定风波', author: '苏轼' }),
      findPoem: async () => { throw new Error('诗库挂了') },
    })
    fallback.noteUserChat('最近好难')
    await tick(30)
    const fe = fallback.recent().find((e) => e.data.name === 'poem-echo')
    ok('查整首失败 → 仍发一句（不连累弹幕）', !!fe && fe.data.line === '一蓑烟雨任平生。' && !fe.data.full, JSON.stringify(fe && fe.data))

    const boom = createHostCollector({ cap: 10, keywordEcho: () => { throw new Error('boom') } })
    let threw = false
    try { boom.noteUserChat('坚持') } catch { threw = true }
    ok('keywordEcho 抛错 → noteUserChat 不抛（只静默）', threw === false)
  }

  // ======================================================================
  group('[C] 两条聊天路由都接上 noteUserChat（DSH 输入不经过）')
  {
    // /chat：正常消息应把原话交给 noteUserChat
    const seen = []
    const chatDeps = {
      getKey: () => 'sk-test',
      loadHistory: () => [],
      appendTurns: () => {},
      loadState: () => ({ intimacy: 0 }),
      saveState: () => {},
      systemPrompt: 'test',
      addExp: () => {},
      addTokens: () => {},
      loadMemorySummary: () => '',
      saveMemorySummary: () => {},
      cacheEnabled: () => false,
      model: 'deepseek-flash',
      noteUserChat: (t) => seen.push(t),
    }
    const chat = createChatHandler(chatDeps)
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: '在呢' } }], usage: { total_tokens: 5 } }),
    })
    let res = mkRes()
    await chat(mkReq({ message: '寻寻觅觅', poem: true }), res)
    ok('/chat 把主人原话交给 noteUserChat', seen.length === 1 && seen[0] === '寻寻觅觅', JSON.stringify(seen))
    ok('/chat 正常回包不受影响', res.json() && res.json().ok === true && res.json().reply === '在呢', res.bodyText().slice(0, 80))

    seen.length = 0
    res = mkRes()
    await chat(mkReq({ message: '寻寻觅觅' }), res)
    ok('/chat 未带 poem:true 不触发（Harness/其它 API 调用）', seen.length === 0, JSON.stringify(seen))

    seen.length = 0
    res = mkRes()
    await chat(mkReq({ message: '   ', poem: true }), res)
    ok('/chat 空消息不触发', seen.length === 0, JSON.stringify(seen))

    // /chat-stream：外呼失败也要先触发（触发点在请求上游之前）
    const streamSeen = []
    const stream = createChatStreamHandler({
      getKey: () => 'sk-test',
      loadHistory: () => [],
      systemPrompt: 'test',
      model: 'deepseek-flash',
      noteUserChat: (t) => streamSeen.push(t),
    })
    globalThis.fetch = async () => { throw new Error('upstream down') }
    res = mkRes()
    await stream(mkReq({ message: '寻寻觅觅', poem: true }), res)
    ok('/chat-stream 把主人原话交给 noteUserChat', streamSeen.length === 1 && streamSeen[0] === '寻寻觅觅', JSON.stringify(streamSeen))
    streamSeen.length = 0
    res = mkRes()
    await stream(mkReq({ message: '寻寻觅觅' }), res)
    ok('/chat-stream 未带 poem:true 不触发', streamSeen.length === 0, JSON.stringify(streamSeen))

    const chatSrc = readFileSync(path.join(ROOT, 'src/host/routes/chat.ts'), 'utf8')
    const streamSrc = readFileSync(path.join(ROOT, 'src/host/routes/chat-stream.ts'), 'utf8')
    const idxSrc = readFileSync(path.join(ROOT, 'src/index.ts'), 'utf8')
    const collectorSrc = readFileSync(path.join(ROOT, 'src/host/nervous/collector.ts'), 'utf8')
    ok('chat.ts 仅在 poem:true 时调用 noteUserChat', /body\?\.poem === true && opts\.noteUserChat/.test(chatSrc))
    ok('chat-stream.ts 仅在 poem:true 时调用 noteUserChat', /body\?\.poem === true && opts\.noteUserChat/.test(streamSrc))
    ok('index.ts 把 noteUserChat 同时注入两条聊天路由',
      (idxSrc.match(/noteUserChat,/g) || []).length >= 2, 'count=' + (idxSrc.match(/noteUserChat,/g) || []).length)
    const chatClientSrc = readFileSync(path.join(ROOT, 'src/client/chat.ts'), 'utf8')
    ok('鲸鱼聊天普通/流式两条请求都带 poem:true', (chatClientSrc.match(/poem: true/g) || []).length >= 2, String((chatClientSrc.match(/poem: true/g) || []).length))
    ok('collector.ts 不再读 user/message 做匹配（源码级硬约束）',
      !/event\.type\s*===\s*'user\/message'/.test(collectorSrc), '仍含 user/message 分支')
  }
} catch (e) {
  ok('用例未抛异常', false, String((e && e.stack) || e))
} finally {
  globalThis.fetch = realFetch
}

console.log('\n' + '='.repeat(52))
console.log('通过 ' + pass + ' 项 / 失败 ' + fail + ' 项')
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('✅ 诗词弹幕触发源回归全部通过')
process.exit(0)
