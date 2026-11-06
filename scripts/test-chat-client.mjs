/**
 * scripts/test-chat-client.mjs —— client/chat.ts + client/persona.ts 的离线回归
 *
 * 为什么单独建这个文件：现有 npm test 的 30 多个脚本里，聊天「发送器」只有静态字符串断言
 * （verify-voice.mjs 查 lang、test.mjs 查 chatRate），真正跑一遍
 * 流式 / 回退 / 占线 / 纪元 / P0 打断的分支没有运行时覆盖。
 * 这里用 esbuild 把 src/client/chat.ts 打成 ESM，注入假 fetch / 假时钟 / 假 host，
 * 把 docs/并发纪律.md 的规则逐条跑成断言（不联网、不需要浏览器、不需要麦克风）。
 *
 * 用法：node scripts/test-chat-client.mjs      （失败 exit 1）
 * 注意：本文件没有接进 npm test（本批次不许改 package.json / scripts/test.mjs）。
 */

import { build } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const REAL_SET_TIMEOUT = globalThis.setTimeout
const REAL_CLEAR_TIMEOUT = globalThis.clearTimeout

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), 'got=' + JSON.stringify(got))

// ---------------------------------------------------------------- 假时钟
// chat.ts 只用 setTimeout/clearTimeout（4s 首帧兜底、30s /chat 上限）。
// 换成可控假时钟，才能在毫秒级把"超时/兜底"跑出来；await 一律走微任务，不依赖真定时器。
let clock = 0
let timerSeq = 0
const timers = new Map()
globalThis.setTimeout = (fn, ms, ...args) => {
  const id = ++timerSeq
  timers.set(id, { at: clock + Math.max(0, Number(ms) || 0), fn, args })
  return id
}
globalThis.clearTimeout = (id) => { try { timers.delete(id) } catch (e) { } }
const pendingTimers = () => [...timers.values()].map((t) => t.at - clock)
function fireTimers(ms) {
  clock += ms
  const due = [...timers.entries()].filter(([, t]) => t.at <= clock).sort((a, b) => a[1].at - b[1].at)
  for (const [id, t] of due) {
    timers.delete(id)
    try { t.fn(...t.args) } catch (e) { }
  }
}

// ---------------------------------------------------------------- 假浏览器全局
const lsMap = new Map()
try {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (k) => (lsMap.has(String(k)) ? lsMap.get(String(k)) : null),
      setItem: (k, v) => { lsMap.set(String(k), String(v)) },
      removeItem: (k) => { lsMap.delete(String(k)) },
      clear: () => { lsMap.clear() },
    },
  })
} catch (e) { }
if (typeof globalThis.window === 'undefined') {
  try { globalThis.window = { __chubbyWhale: {} } } catch (e) { }
}

// ---------------------------------------------------------------- 假网络
const abortErr = () => (typeof DOMException !== 'undefined'
  ? new DOMException('This operation was aborted', 'AbortError')
  : Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))

let plan = []
let calls = []
function enqueue(fn) { plan.push(fn) }
const jsonRes = (status, obj) => ({ ok: status >= 200 && status < 300, status, body: null, json: async () => obj })
const hangRes = (init) => new Promise((resolve, reject) => {
  const sig = init && init.signal
  if (!sig) return
  if (sig.aborted) { reject(abortErr()); return }
  try { sig.addEventListener('abort', () => reject(abortErr())) } catch (e) { reject(abortErr()) }
})
/** SSE 响应：push() 帧、end() 收流、abort() 模拟 signal 中止（读取中的 read 会 reject） */
function sseRes(init) {
  const enc = new TextEncoder()
  const queued = []
  const waiting = []
  let ended = false
  let abortWith = null
  const ctl = {
    push: (obj) => {
      const line = 'data: ' + JSON.stringify(obj) + '\n\n'
      if (waiting.length) waiting.shift().res({ value: enc.encode(line), done: false })
      else queued.push(line)
    },
    end: () => {
      ended = true
      while (waiting.length) waiting.shift().res({ value: undefined, done: true })
    },
    abort: () => {
      abortWith = abortErr()
      while (waiting.length) waiting.shift().rej(abortWith)
    },
  }
  try {
    const sig = init && init.signal
    if (sig) {
      if (sig.aborted) ctl.abort()
      else sig.addEventListener('abort', () => ctl.abort())
    }
  } catch (e) { }
  const res = {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () => {
          if (abortWith) return Promise.reject(abortWith)
          if (queued.length) return Promise.resolve({ value: enc.encode(queued.shift()), done: false })
          if (ended) return Promise.resolve({ value: undefined, done: true })
          return new Promise((res2, rej2) => waiting.push({ res: res2, rej: rej2 }))
        },
        cancel: async () => { },
      }),
    },
  }
  return { res, ctl }
}
try {
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: (url, init) => {
      calls.push({ url: String(url), init: init || {} })
      const fn = plan.shift()
      if (!fn) return Promise.reject(new Error('UNEXPECTED_FETCH ' + String(url)))
      return Promise.resolve().then(() => fn(String(url), init || {}))
    },
  })
} catch (e) { }

async function tick(n = 16) {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

// ---------------------------------------------------------------- 打包 client/chat.ts
const tmp = mkdtempSync(join(tmpdir(), 'chubby-chat-client-'))
const toEntry = (p) => {
  const abs = join(ROOT, p).replace(/\\/g, '/')
  return abs
}
writeFileSync(join(tmp, 'entry.mjs'), [
  'export { createChatSender, resolveChatLang } from "' + toEntry('src/client/chat.ts') + '"',
  'export { createBusyLock, createEpoch, BUSY_STALE_MS } from "' + toEntry('src/client/busy.ts') + '"',
  'export { createDeduper } from "' + toEntry('src/client/text.ts') + '"',
  '',
].join('\n'))
const bundlePath = join(tmp, 'bundle.mjs')
await build({
  entryPoints: [join(tmp, 'entry.mjs')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: bundlePath,
  logLevel: 'silent',
})
const mod = await import(pathToFileURL(bundlePath).href)

// ---------------------------------------------------------------- 假 host
function mkHost(cfg = {}) {
  const st = {
    messages: [],
    bubbles: [],
    speaks: [],
    says: [],
    replies: [],
    bubblesAt: 0,
    input: cfg.input || '',
    busyUI: false,
    tts: !!cfg.tts,
    hearts: 0,
    stopSpeak: 0,
    scrolls: 0,
    routes: [],
    reacts: 0,
    lat: [],
    order: [],
  }
  const host = {
    persona: {
      line: (k) => 'LINE:' + k,
      reactTo: (t) => {
        st.reacts++
        return cfg.reactTo ? cfg.reactTo(t) : null
      },
    },
    bubble: (t) => { st.bubbles.push(String(t)) },
    say: (t) => { st.says.push(String(t)); st.order.push('say') },
    speak: (t) => { st.speaks.push(String(t)); st.order.push('speak') },
    speakReply: (t) => { st.replies.push(String(t)); st.order.push('speakReply') },
    stopSpeak: () => { st.stopSpeak++; st.order.push('stopSpeak') },
    talkFor: () => { },
    heart: () => { st.hearts++ },
    setInput: (v) => { st.input = String(v) },
    setMessages: (u) => { st.messages = typeof u === 'function' ? u(st.messages) : u },
    setBusy: (v) => { st.busyUI = !!v },
    scrollBody: () => { st.scrolls++ },
    busy: mod.createBusyLock(),
    epoch: mod.createEpoch(),
    narrating: { current: !!cfg.narrating },
    storyBusy: { current: !!cfg.storyBusy },
    voiceMode: { current: !!cfg.voiceMode },
    ttsPlaying: () => st.tts,
    narrationRate: () => '-25%',
    route: (t) => { st.routes.push(String(t)); return !!cfg.route },
    replyDeduper: mod.createDeduper({ windowMs: 30000 }),
    recordChatLatency: (ms) => { st.lat.push(ms) },
  }
  return { host, st }
}
const msgList = (st) => st.messages.map((m) => String(m.who) + ':' + String(m.text))

function resetCase() {
  lsMap.clear()
  timers.clear()
  clock = 0
  timerSeq = 0
  plan = []
  calls = []
  globalThis.window.__chubbyWhale = {}
}
const urls = () => calls.map((c) => String(c.url).replace(/^.*\/api\/chubby-whale/, ''))

// ================================================================ 用例
async function caseStreamSuccess() {
  console.log('\n[1] 流式成功：逐句朗读 / done 入列 / 占线释放')
  resetCase()
  const { host, st } = mkHost()
  const chat = mod.createChatSender(host)
  let s = null
  enqueue((url, init) => { s = sseRes(init); return s.res })
  const p = chat.send('你好')
  await tick()
  eq('/chat-stream 已发出', urls(), ['/chat-stream'])
  ok('等首帧期间已占线（busy=true）', host.busy.isBusy() && st.busyUI === true)
  s.ctl.push({ delta: '第一句。' })
  await tick()
  s.ctl.push({ delta: '第二句。' })
  s.ctl.push({ done: true, reply: '第一句。第二句。', cached: false, firstDeltaMs: 12, ms: 30 })
  s.ctl.end()
  await p
  eq('消息列表：主人提问 + 完整回复各一次', msgList(st), ['me:你好', 'fish:第一句。第二句。'])
  ok('按句朗读（两句都念）', st.speaks.includes('第一句。') && st.speaks.includes('第二句。'), st.speaks.join('|'))
  ok('占线释放（busy + UI）', !host.busy.isBusy() && st.busyUI === false)
  ok('首帧兜底定时器已清', timers.size === 0, pendingTimers().join(','))
  const d = globalThis.window.__chubbyWhale
  ok('诊断写入 stream-done', !!d.lastChat && d.lastChat.stage === 'stream-done')
}

async function caseStreamPreempt() {
  console.log('\n[2] 新提问打断旧流：旧 delta 不再入列/朗读，占线归新请求')
  resetCase()
  const { host, st } = mkHost()
  const chat = mod.createChatSender(host)
  let s1 = null
  let s2 = null
  enqueue((url, init) => { s1 = sseRes(init); return s1.res })
  const p1 = chat.send('第一问')
  await tick()
  s1.ctl.push({ delta: '旧答案第一句。' })
  await tick()
  ok('旧答案已念出的部分不作废（已发生的朗读收不回）', st.speaks.includes('旧答案第一句。'))
  enqueue((url, init) => { s2 = sseRes(init); return s2.res })
  const p2 = chat.send('第二问')
  await tick()
  eq('第二问自己发了一条流', urls(), ['/chat-stream', '/chat-stream'])
  ok('旧流被 abort 计数', (globalThis.window.__chubbyWhale.streamAborted || 0) >= 1, String(globalThis.window.__chubbyWhale.streamAborted))
  ok('新请求接管占线', host.busy.isBusy() === true)
  s2.ctl.push({ delta: '新答案。' })
  s2.ctl.push({ done: true, reply: '新答案。', cached: false })
  s2.ctl.end()
  await p1
  await p2
  eq('消息列表不含旧答案，只留新答案', msgList(st), ['me:第一问', 'me:第二问', 'fish:新答案。'])
  ok('旧答案没有整段补念', !st.speaks.some((x) => x.indexOf('旧答案') === 0 && x !== '旧答案第一句。'), st.speaks.join('|'))
  ok('占线最终释放', !host.busy.isBusy() && st.busyUI === false)
  ok('没有遗留定时器', timers.size === 0)
}

async function caseAbortNormalChat() {
  console.log('\n[3] 停止说话打断普通 /chat：旧回复不写不念，占线立刻放')
  resetCase()
  lsMap.set('chubby-stream', 'off')   // 本组专门测普通 /chat 路径
  const { host, st } = mkHost()
  const chat = mod.createChatSender(host)
  enqueue((url, init) => hangRes(init))
  const p = chat.send('问个事')
  await tick()
  eq('/chat 已发出', urls(), ['/chat'])
  ok('占线中', host.busy.isBusy() && st.busyUI === true)
  const aborted = chat.abortStream()
  ok('abortStream 报告中止了请求', aborted === true)
  ok('占线立刻释放', !host.busy.isBusy() && st.busyUI === false)
  await p
  eq('只留主人那句，没有鱼回复', msgList(st), ['me:问个事'])
  ok('没有朗读、没有气泡兜底', st.replies.length === 0 && st.speaks.length === 0 && st.bubbles.length === 0, st.bubbles.join('|'))
  ok('30 秒超时定时器已清', timers.size === 0, pendingTimers().join(','))
}

async function caseBusyGuard() {
  console.log('\n[4] 占线保护：忙时拒绝（不排队）、输入框不清；超阈值才放行')
  resetCase()
  lsMap.set('chubby-stream', 'off')   // 本组专门测普通 /chat 路径的占线
  const { host, st } = mkHost({ input: '主人正在打的字' })
  const chat = mod.createChatSender(host)
  host.busy.begin()
  await chat.send('在吗')
  ok('忙时不发请求', calls.length === 0, urls().join(','))
  ok('给出「还在想上一句」提示', st.bubbles.some((b) => b.indexOf('还在想上一句') >= 0), st.bubbles.join('|'))
  ok('输入框内容保留（不丢主人的话）', st.input === '主人正在打的字', st.input)
  ok('没把提问写进消息列表', st.messages.length === 0)
  ok('不劫持别人的占线', host.busy.isBusy() === true)

  host.busy.begin(Date.now() - 40000)
  enqueue(() => jsonRes(200, { ok: true, reply: '迟到的答复' }))
  await chat.send('再问一次')
  eq('超过占线阈值（35s）后放行', urls(), ['/chat'])
  eq('消息成对入列', msgList(st), ['me:再问一次', 'fish:迟到的答复'])
  ok('占线释放', !host.busy.isBusy() && st.busyUI === false)
}

async function caseChatTimeout() {
  console.log('\n[5] /chat 超时：可读提示 + 占线释放 + 定时器清干净')
  resetCase()
  lsMap.set('chubby-stream', 'off')   // 本组专门测普通 /chat 路径的超时
  const { host, st } = mkHost()
  const chat = mod.createChatSender(host)
  enqueue((url, init) => hangRes(init))
  const p = chat.send('慢问题')
  await tick()
  const left = pendingTimers()
  ok('挂了 30 秒总超时', left.some((ms) => ms > 29000 && ms <= 30000), left.join(','))
  fireTimers(30000)
  await p
  ok('提示「等太久」且进消息列表', st.bubbles.some((b) => b.indexOf('等太久') >= 0)
    && st.messages.length === 2 && st.messages[1].who === 'fish', msgList(st).join('|'))
  ok('占线释放', !host.busy.isBusy() && st.busyUI === false)
  ok('定时器清干净', timers.size === 0, pendingTimers().join(','))
}

async function caseStreamFallback() {
  console.log('\n[6] 流式 503：回退普通 /chat，回复只入列一次')
  resetCase()
  const { host, st } = mkHost()
  const chat = mod.createChatSender(host)
  enqueue(() => ({ ok: false, status: 503, body: null, json: async () => ({ ok: false, error: 'busy' }) }))
  enqueue(() => jsonRes(200, { ok: true, reply: '回退成功' }))
  await chat.send('问')
  eq('503 回退普通 /chat（共两条请求）', urls(), ['/chat-stream', '/chat'])
  eq('消息只一条回复（不重复）', msgList(st), ['me:问', 'fish:回退成功'])
  ok('回退回复被朗读', st.replies.includes('回退成功'), st.replies.join('|'))
  ok('占线释放', !host.busy.isBusy() && st.busyUI === false)
  ok('没有遗留定时器', timers.size === 0)
}

async function caseStreamNoFallback() {
  console.log('\n[7] 流式 500：不回退，直接把服务端人话提示给主人')
  resetCase()
  const { host, st } = mkHost()
  const chat = mod.createChatSender(host)
  enqueue(() => ({ ok: false, status: 500, body: null, json: async () => ({ ok: false, error: 'boom', reply: '主人，本鲸这边没接上' }) }))
  await chat.send('问')
  eq('500 只发一条请求（不白打第二轮）', urls(), ['/chat-stream'])
  eq('提示进消息列表', msgList(st), ['me:问', 'fish:主人，本鲸这边没接上'])
  ok('提示也念出来', st.replies.includes('主人，本鲸这边没接上'))
  ok('没有占住占线', !host.busy.isBusy() && st.busyUI === false)
}

async function caseStreamErrorFallback() {
  console.log('\n[8] 流式 error 帧（未念过任何字）：回退普通 /chat')
  resetCase()
  const { host, st } = mkHost()
  const chat = mod.createChatSender(host)
  let s = null
  enqueue((url, init) => { s = sseRes(init); return s.res })
  enqueue(() => jsonRes(200, { ok: false, error: 'NO_KEY', reply: '没钥匙' }))
  const p = chat.send('问')
  await tick()
  ok('error 帧前已占线', host.busy.isBusy() === true)
  s.ctl.push({ error: 'NO_KEY' })
  s.ctl.end()
  await p
  eq('error 帧回退 /chat', urls(), ['/chat-stream', '/chat'])
  eq('只有一条兜底回复', msgList(st), ['me:问', 'fish:没钥匙'])
  ok('兜底回复被朗读', st.replies.includes('没钥匙'))
  ok('占线释放', !host.busy.isBusy() && st.busyUI === false)
}

async function caseStreamPartialError() {
  console.log('\n[9] 流式断流（已念过一部分）：不回退，半截留在列表里')
  resetCase()
  const { host, st } = mkHost()
  const chat = mod.createChatSender(host)
  let s = null
  enqueue((url, init) => { s = sseRes(init); return s.res })
  const p = chat.send('问')
  await tick()
  s.ctl.push({ delta: '念到一半。' })
  await tick()
  s.ctl.push({ error: 'stream: idle timeout' })
  s.ctl.end()
  await p
  eq('断流不回退（不重发第二轮）', urls(), ['/chat-stream'])
  eq('半截正文留在消息列表', msgList(st), ['me:问', 'fish:念到一半。'])
  ok('气泡说明断流', st.bubbles.some((b) => b.indexOf('网络断了一下') >= 0), st.bubbles.join('|'))
  ok('占线释放', !host.busy.isBusy() && st.busyUI === false)
}

async function caseStreamNoDone() {
  console.log('\n[10] 流正常结束但没有 done 帧：正文仍入列')
  resetCase()
  const { host, st } = mkHost()
  const chat = mod.createChatSender(host)
  let s = null
  enqueue((url, init) => { s = sseRes(init); return s.res })
  const p = chat.send('问')
  await tick()
  s.ctl.push({ delta: '没有收尾帧。' })
  await tick()
  s.ctl.end()
  await p
  eq('无 done 也把正文入列', msgList(st), ['me:问', 'fish:没有收尾帧。'])
  ok('占线释放', !host.busy.isBusy() && st.busyUI === false)
}

async function caseStreamEmpty() {
  console.log('\n[11] 流式空回复：给一句人设兜底，不静默')
  resetCase()
  const { host, st } = mkHost()
  const chat = mod.createChatSender(host)
  let s = null
  enqueue((url, init) => { s = sseRes(init); return s.res })
  const p = chat.send('问')
  await tick()
  s.ctl.push({ done: true, reply: '' })
  s.ctl.end()
  await p
  eq('空回复留一句兜底', msgList(st), ['me:问', 'fish:LINE:error'])
  ok('占线释放', !host.busy.isBusy() && st.busyUI === false)
}

async function caseCacheLikeStream() {
  console.log('\n[12] 缓存命中的流（一条 delta + done cached）：只入列一次、照常朗读')
  resetCase()
  const { host, st } = mkHost()
  const chat = mod.createChatSender(host)
  let s = null
  enqueue((url, init) => { s = sseRes(init); return s.res })
  const p = chat.send('问')
  await tick()
  s.ctl.push({ delta: '缓存答复。' })
  s.ctl.push({ done: true, reply: '缓存答复。', cached: true })
  s.ctl.end()
  await p
  eq('缓存命中只入列一次', msgList(st), ['me:问', 'fish:缓存答复。'])
  ok('缓存命中同样朗读', st.speaks.includes('缓存答复。'), st.speaks.join('|'))
  ok('诊断标注 cached', !!globalThis.window.__chubbyWhale.lastChat && globalThis.window.__chubbyWhale.lastChat.cached === true)
  ok('占线释放', !host.busy.isBusy() && st.busyUI === false)
}

async function caseP0Interrupt() {
  console.log('\n[13] P0 打断：先 stopSpeak + 清 storyBusy，再发请求')
  resetCase()
  const { host, st } = mkHost({ narrating: true, storyBusy: true, tts: true })
  const chat = mod.createChatSender(host)
  let s = null
  enqueue((url, init) => { st.order.push('fetch'); s = sseRes(init); return s.res })
  const p = chat.send('提问')
  await tick()
  ok('先停朗读、后发请求', st.stopSpeak === 1
    && st.order.indexOf('stopSpeak') >= 0 && st.order.indexOf('stopSpeak') < st.order.indexOf('fetch'), st.order.join('>'))
  ok('叙述 / 说书两把锁都清了', host.narrating.current === false && host.storyBusy.current === false)
  s.ctl.push({ done: true, reply: '答。' })
  s.ctl.end()
  await p
  ok('打断后状态干净（没有卡在「正在说书」）', host.narrating.current === false && host.storyBusy.current === false && !host.busy.isBusy())
}

async function caseP0StoryBusyOnly() {
  console.log('\n[14] P0 打断：narrating 已被看门狗过期清掉、只剩 storyBusy 时也要停')
  resetCase()
  // client.ts:599-602 叙述锁过期只清 narrating，不清 storyBusy；此时 ttsPlaying 也可能是 false
  //（TTS 重试退避期间 ttsBusy=false）。P0 只认 narrating||ttsPlaying 就会漏掉这一轮。
  const { host, st } = mkHost({ narrating: false, storyBusy: true, tts: false })
  const chat = mod.createChatSender(host)
  let s = null
  enqueue((url, init) => { st.order.push('fetch'); s = sseRes(init); return s.res })
  const p = chat.send('提问')
  await tick()
  ok('只剩说书占线时也要先停朗读', st.stopSpeak === 1
    && st.order.indexOf('stopSpeak') >= 0 && st.order.indexOf('stopSpeak') < st.order.indexOf('fetch'), st.order.join('>'))
  ok('说书占线被一起清掉', host.storyBusy.current === false)
  s.ctl.push({ done: true, reply: '答。' })
  s.ctl.end()
  await p
}

async function caseNoInterrupt() {
  console.log('\n[15] 没有旁白时不乱喊停')
  resetCase()
  const { host, st } = mkHost()
  const chat = mod.createChatSender(host)
  let s = null
  enqueue((url, init) => { s = sseRes(init); return s.res })
  const p = chat.send('提问')
  await tick()
  ok('stopSpeak 一次都没调', st.stopSpeak === 0)
  s.ctl.push({ done: true, reply: '答。' })
  s.ctl.end()
  await p
}

async function caseRouteHit() {
  console.log('\n[16] 本地点播命中：不发请求、不写对话、清输入框、不触发人设情绪')
  resetCase()
  const { host, st } = mkHost({ route: true, input: '背首诗' })
  const chat = mod.createChatSender(host)
  await chat.send('背首诗')
  ok('点播不发网络请求', calls.length === 0)
  ok('点播不写消息列表', st.messages.length === 0)
  ok('点播清输入框', st.input === '', st.input)
  ok('点播不占线', !host.busy.isBusy() && st.busyUI === false)
  ok('点播指令不触发人设情绪', st.reacts === 0, 'reacts=' + st.reacts)
}

async function caseEpochGuardAfterStream() {
  console.log('\n[17] 纪元：await 期间被新请求顶掉后，不再补发普通 /chat')
  resetCase()
  lsMap.set('chubby-stream', 'off')   // 流式关闭：tryStream 直接返回 false（没有登记 activeStream）
  const { host, st } = mkHost()
  const chat = mod.createChatSender(host)
  const p = chat.send('问')
  // send 已同步跑到 await tryStream(...)；此刻没有在途请求，等价于另一个更晚的请求先占住了这条对话
  host.epoch.next()
  await p
  ok('纪元已变 → 不再发白工请求', calls.length === 0, urls().join(','))
  eq('只有主人那句进列表', msgList(st), ['me:问'])
  ok('没有占线残留', !host.busy.isBusy() && st.busyUI === false)
  ok('没有遗留定时器', timers.size === 0)
}

async function caseAbortNoop() {
  console.log('\n[18] abortStream 无在途请求：返回 false、不推进纪元、不误放占线')
  resetCase()
  const { host } = mkHost()
  const chat = mod.createChatSender(host)
  const before = host.epoch.current()
  ok('没有请求时返回 false', chat.abortStream() === false)
  ok('不推进纪元', host.epoch.current() === before)
  host.busy.begin()
  ok('没有登记请求时不把别人的占线放掉', chat.abortStream() === false && host.busy.isBusy() === true)
  host.busy.end()
}

async function casePersonaReaction() {
  console.log('\n[19] 人设情绪/台词：流式（默认路径）也要触发 reactTo')
  resetCase()
  const { host, st } = mkHost({
    reactTo: (t) => (t.indexOf('可爱') >= 0 ? { event: 'praise', text: '哼，才不是可爱呢', mood: 'shy' } : null),
  })
  const chat = mod.createChatSender(host)
  let s = null
  enqueue((url, init) => { s = sseRes(init); return s.res })
  const p = chat.send('你好可爱呀')
  await tick()
  ok('reactTo 被调用（流式路径不再跳过情绪状态机）', st.reacts >= 1, 'reacts=' + st.reacts)
  ok('人设台词说出来了', st.says.includes('哼，才不是可爱呢'), st.says.join('|'))
  ok('夸夸触发爱心', st.hearts === 1)
  s.ctl.push({ done: true, reply: '答。' })
  s.ctl.end()
  await p
  eq('主人提问 + 回复仍然成对', msgList(st), ['me:你好可爱呀', 'fish:答。'])
}

async function caseResolveChatLang() {
  console.log('\n[20] resolveChatLang：菜单值非法时回落 auto')
  resetCase()
  ok('缺省 auto', mod.resolveChatLang() === 'auto')
  lsMap.set('chubby-chatlang', 'en')
  ok('en 原样', mod.resolveChatLang() === 'en')
  lsMap.set('chubby-chatlang', 'zh')
  ok('zh 原样', mod.resolveChatLang() === 'zh')
  lsMap.set('chubby-chatlang', 'fr')
  ok('非法值回落 auto', mod.resolveChatLang() === 'auto')
}

function caseStaticBoundaries() {
  console.log('\n[21] 封装治理（静态）：chat.ts 只经注入依赖/HTTP 工作')
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const chatSrc = readFileSync(join(ROOT, 'src/client/chat.ts'), 'utf8')
  const perSrc = readFileSync(join(ROOT, 'src/client/persona.ts'), 'utf8')
  const chatCode = stripComments(chatSrc)
  const perCode = stripComments(perSrc)
  const imports = [...chatSrc.matchAll(/from '([^']+)'/g)].map((m) => m[1])
  const allowed = ['./http.js', '../shared/sse.js', './text.js', './busy.js', './rates.js', './persona.js', './util.js']
  const extra = imports.filter((x) => allowed.indexOf(x) < 0)
  ok('chat.ts 只 import 注入端口/纯工具模块', extra.length === 0, extra.join(','))
  ok('chat.ts 不直接碰 voice / story / client 内部',
    !/from '\.\/(voice|voice-bridge|story|story-auto|client)(\.js)?'/.test(chatSrc) && !/from '\.\.\/client\.js'/.test(chatSrc))
  ok('chat.ts 不读 TTS 队列 / 浏览器语音内部',
    !/ttsQ|speechSynthesis|SpeechSynthesisUtterance|ttsPrefetch|speakToken/.test(chatCode))
  ok('chat.ts 不横向 import 宿主模块', !/from '\.\.\/host\//.test(chatSrc))
  ok('chat.ts 不碰 React/DOM 树', !/\bReact\b|useState|document\./.test(chatCode))
  const keys = [...chatCode.matchAll(/localStorage\.getItem\('([^']+)'\)/g)].map((m) => m[1])
  ok('chat.ts 只读两个公开配置键', keys.every((k) => k === 'chubby-stream' || k === 'chubby-chatlang'), keys.join(','))
  ok('chat.ts 只通过 host 公开 ref 契约做打断', /host\.narrating\.current/.test(chatCode)
    && /host\.storyBusy\.current/.test(chatCode) && !/narration\.lock|narration\.clear/.test(chatCode))
  const perImports = [...perSrc.matchAll(/from '([^']+)'/g)].map((m) => m[1])
  const perAllowed = ['../shared/immutable.js', '../../data/persona.json', './util.js']
  const perExtra = perImports.filter((x) => perAllowed.indexOf(x) < 0)
  ok('persona.ts 只 import 冻结工具/台词库/工具', perExtra.length === 0, perExtra.join(','))
  ok('persona.ts 不碰 voice/story/chat/React', !/\bReact\b|useState|ttsQ|speechSynthesis|from '\.\/(voice|story|chat)/.test(perCode))
}

// ================================================================ 跑
try {
  await caseStreamSuccess()
  await caseStreamPreempt()
  await caseAbortNormalChat()
  await caseBusyGuard()
  await caseChatTimeout()
  await caseStreamFallback()
  await caseStreamNoFallback()
  await caseStreamErrorFallback()
  await caseStreamPartialError()
  await caseStreamNoDone()
  await caseStreamEmpty()
  await caseCacheLikeStream()
  await caseP0Interrupt()
  await caseP0StoryBusyOnly()
  await caseNoInterrupt()
  await caseRouteHit()
  await caseEpochGuardAfterStream()
  await caseAbortNoop()
  await casePersonaReaction()
  await caseResolveChatLang()
  caseStaticBoundaries()
} finally {
  // 假时钟换回去，免得影响本进程里后续可能 import 的模块
  globalThis.setTimeout = REAL_SET_TIMEOUT
  globalThis.clearTimeout = REAL_CLEAR_TIMEOUT
  try { rmSync(tmp, { recursive: true, force: true }) } catch (e) { }
}

console.log('\n────────────────────')
ok('全部用例结束后没有遗留定时器', timers.size === 0, pendingTimers().join(','))
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
