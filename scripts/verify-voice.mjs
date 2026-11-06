/**
 * scripts/verify-voice.mjs —— client 语音链路离线验证（Node stub，不联网、不要麦克风）
 *
 * 验证四件事：
 *   ① 换音色后 /tts 请求里的 voice 参数确实变了（含"菜单存的值会被建实例时读到"）
 *   ② 唤醒词：gate 原语仍算 30 秒窗；bridge 层自 2026-11-06 起"随时可以说"，
 *      唤醒词只剩两个用途——只喊名字时应一声、句首出现时从正文剥掉
 *   ③ endpointInfo 随实际模式变化（不是写死 classic）
 *   ④ 聊天语言随菜单选择变化（流式与普通 /chat 同源）
 * 另有 ⑤：试听（strict）失败时不回落浏览器 speechSynthesis。
 *
 * 用法：node scripts/verify-voice.mjs
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import esbuild from 'esbuild'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = path.join(ROOT, '.verify-tmp')

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- stub 浏览器环境 ----------
function memoryStorage() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)) },
    removeItem: (k) => { m.delete(k) },
    clear: () => m.clear(),
    key: () => null,
    get length() { return m.size },
  }
}

const requests = []
let asrText = '大肥鱼'
const storage = memoryStorage()

globalThis.localStorage = storage
globalThis.sessionStorage = memoryStorage()
globalThis.window = globalThis
globalThis.window.__chubbyWhale = {}
globalThis.window.speechSynthesis = { getVoices: () => [], speak() { }, cancel() { } }
globalThis.window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t } }
globalThis.Audio = class {
  constructor(url) { this.src = url; this.paused = true; this.ended = false; this.readyState = 4 }
  play() { this.paused = false; return Promise.resolve() }
  pause() { this.paused = true }
}
try { URL.createObjectURL = () => 'blob:verify' } catch (e) { }
try { URL.revokeObjectURL = () => { } } catch (e) { }
if (!globalThis.performance || typeof globalThis.performance.now !== 'function') {
  globalThis.performance = { now: () => Date.now() }
}
globalThis.fetch = async (url, init) => {
  const u = String(url)
  const body = init && init.body ? (() => { try { return JSON.parse(init.body) } catch (e) { return null } })() : null
  requests.push({ url: u, body })
  if (u.indexOf('/asr') >= 0) return { ok: true, status: 200, json: async () => ({ ok: true, text: asrText }) }
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(16),
    json: async () => ({ ok: true }),
    headers: { get: () => null },
  }
}

// ---------- 打包并加载 client 模块（esbuild 处理 .js → .ts 解析） ----------
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
const entry = path.join(TMP, 'entry.ts')
const out = path.join(TMP, 'bundle.mjs')
const ENTRY_SRC = `
import { createVoice, normalizeVoiceName, readStoredVoiceName, TTS_VOICES, DEFAULT_VOICE } from './src/client/voice.js'
import { createWakeGate, stripWakeWords, normalizeWakeText, WAKE_WORDS, WAKE_WINDOW_MS } from './src/client/wake.js'
import { createVoiceBridge } from './src/client/voice-bridge.js'
import { resolveChatLang } from './src/client/chat.js'
import { buildMenu, tr, EN_MAP } from './src/client/menu.js'
export {
  createVoice, normalizeVoiceName, readStoredVoiceName, TTS_VOICES, DEFAULT_VOICE,
  createWakeGate, stripWakeWords, normalizeWakeText, WAKE_WORDS, WAKE_WINDOW_MS,
  createVoiceBridge, resolveChatLang, buildMenu, tr, EN_MAP,
}
`
await esbuild.build({
  stdin: { contents: ENTRY_SRC, resolveDir: ROOT, sourcefile: 'verify-entry.ts', loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: out,
  logLevel: 'silent',
})
const M = await import(pathToFileURL(out).href)
const lastTts = () => {
  const list = requests.filter((r) => r.url.indexOf('/tts') >= 0)
  return list.length ? list[list.length - 1] : null
}

// ---------- ① 音色真的进了 /tts 请求 ----------
console.log('\n[1] 音色接线（/tts 的 voice 参数）')
{
  storage.clear()
  ok('白名单覆盖菜单 8 个音色 + auto', M.TTS_VOICES.length === 9 && M.TTS_VOICES.indexOf('auto') >= 0)

  const v = M.createVoice({})
  ok('默认音色 = 晓伊', v.voiceName() === 'zh-CN-XiaoyiNeural', '实际 ' + v.voiceName())

  v.setVoiceName('zh-CN-YunxiNeural')
  ok('setVoiceName 立即生效', v.voiceName() === 'zh-CN-YunxiNeural')
  requests.length = 0
  v.speak('你好呀')
  await tick(40)
  ok('TTS 请求带新音色（云希）', !!lastTts() && lastTts().body.voice === 'zh-CN-YunxiNeural', '实际 ' + (lastTts() ? lastTts().body.voice : '无请求'))

  v.stopSpeaking()
  v.setVoiceName('en-GB-SoniaNeural')
  requests.length = 0
  v.speak('hello')
  await tick(40)
  ok('再换音色 → 请求随之变化（Sonia）', !!lastTts() && lastTts().body.voice === 'en-GB-SoniaNeural', '实际 ' + (lastTts() ? lastTts().body.voice : '无请求'))

  v.stopSpeaking()
  v.setVoiceName('auto')
  requests.length = 0
  v.speak('你好')
  await tick(40)
  ok('「自动」原样交给宿主（由它按语言选）', !!lastTts() && lastTts().body.voice === 'auto')

  v.setVoiceName('不存在的音色')
  ok('白名单外的值被忽略（不污染请求）', v.voiceName() === 'auto', '实际 ' + v.voiceName())

  storage.setItem('chubby-tts-voice', 'zh-CN-XiaoxiaoNeural')
  const v2 = M.createVoice({})
  ok('新建实例会读菜单存下的音色（晓晓）', v2.voiceName() === 'zh-CN-XiaoxiaoNeural', '实际 ' + v2.voiceName())
  requests.length = 0
  v2.speak('测试')
  await tick(40)
  ok('该音色进入 TTS 请求', !!lastTts() && lastTts().body.voice === 'zh-CN-XiaoxiaoNeural')
  v.stopSpeaking(); v2.stopSpeaking()
}

// ---------- ② 唤醒词 gate 原语（bridge 已不据此拦话，见 [2b]） ----------
console.log('\n[2] 唤醒词 gate 原语（窗口语义仍在；bridge 是否拦话见 [2b]）')
{
  ok('默认窗口 30 秒', M.WAKE_WINDOW_MS === 30000 && M.createWakeGate().windowMs === 30000)
  ok('主唤醒词是「大肥鱼」', M.WAKE_WORDS[0] === '大肥鱼')
  ok('归一化去标点空白', M.normalizeWakeText(' 大 肥 鱼， ') === '大肥鱼')

  const gate = M.createWakeGate({ windowMs: 30000 })
  const t0 = 1_000_000
  let r = gate.check('今天天气怎么样', t0)
  ok('gate 原语：没被唤醒时 pass=false（bridge 不再据此拦话）', r.pass === false && r.hit === false)

  r = gate.check('大肥鱼', t0 + 1000)
  ok('喊唤醒词 → 命中并刷新窗口', r.hit === true && r.pass === true && r.text === '')

  r = gate.check('讲个聊斋故事', t0 + 2000)
  ok('窗口内的话照常放行', r.pass === true && r.hit === false && r.text === '讲个聊斋故事')

  r = gate.check('再讲一个', t0 + 29000)
  ok('29 秒仍在窗内', r.pass === true)

  r = gate.check('再讲一个', t0 + 32000)
  ok('gate 原语：超过 30 秒 pass=false（不代表 bridge 丢话）', r.pass === false)

  r = gate.check('小鱼，背首诗', t0 + 40000)
  ok('唤醒词可出现在句中，并剥出正文', r.hit === true && r.text === '背首诗', '正文「' + r.text + '」')

  r = gate.check('大肥鱼，讲个故事', t0 + 41000)
  ok('唤醒词 + 正文一起说：剥离后送正文', r.text === '讲个故事', '正文「' + r.text + '」')

  const g2 = M.createWakeGate({ windowMs: 30000 })
  g2.check('肥鲸', 5000)
  ok('窗口按最近一次命中刷新', g2.remainingMs(5000) === 30000 && g2.remainingMs(35000) === 0)
}

// ---------- ②b bridge 集成：唤醒词只是"打招呼/剥词"，不再当门槛 ----------
console.log('\n[2b] voice-bridge 集成（随时可以说 / 语音聊天开关 / 试听）')
{
  const sends = []
  const bubbles = []
  const says = []
  const previews = []
  let fakeVoiceName = ''
  let capturedOpts = null
  const diagAll = {}
  const fakeVoice = {
    status: () => 'listening',
    start: async () => { },
    stop() { },
    speak(t, o) { previews.push({ t, o }) },
    stopSpeaking() { },
    setVoiceName(n) { fakeVoiceName = n },
    voiceName: () => fakeVoiceName,
    mute() { },
    stats: {},
    setEndpointMode() { },
    endpointInfo: () => ({ mode: 'classic' }),
  }
  const bridge = M.createVoiceBridge({
    narration: { active: () => false, lock() { }, clear() { } },
    narrating: () => false,
    stopSpeaking() { },
    bubble: (t) => bubbles.push(t),
    say: (t) => says.push(t),
    sendText: (t, o) => sends.push({ t, o }),
    onVoiceHeard() { },
    onSpeaking() { },
    diag: (d) => Object.assign(diagAll, d),
    voiceChat: () => true,
    makeVoice: (o) => { capturedOpts = o; return fakeVoice },
  })
  await bridge.start()
  ok('建实例时把菜单音色带进 createVoice', capturedOpts && capturedOpts.voiceName === 'zh-CN-XiaoxiaoNeural', '实际 ' + (capturedOpts && capturedOpts.voiceName))

  capturedOpts.onHeard('客厅里的闲聊')
  ok('未喊唤醒词也照常送聊天（2026-11-06「随时可以说」）', sends.length === 1 && sends[0].t === '客厅里的闲聊' && bubbles.some((b) => b.indexOf('听到') >= 0), sends.length ? '「' + sends[0].t + '」' : '未发送')

  capturedOpts.onHeard('大肥鱼')
  ok('只喊名字：应一声（say），不送聊天', says.length === 1 && says[0].indexOf('在呢') >= 0 && sends.length === 1, says.join('/'))

  capturedOpts.onHeard('大肥鱼，讲个故事')
  ok('唤醒词在句首：剥掉后送正文', sends.length === 2 && sends[1].t === '讲个故事', sends.length > 1 ? '「' + sends[1].t + '」' : '未发送')

  capturedOpts.onHeard('再讲一个')
  ok('接着说：不再受唤醒窗限制，照常送聊天', sends.length === 3 && sends[2].t === '再讲一个')

  const wake = bridge.wakeInfo()
  ok('唤醒诊断可读（hits=2 / passed=4 / dropped=0）', wake && wake.hits === 2 && wake.passed === 4 && wake.dropped === 0, JSON.stringify({ hits: wake.hits, passed: wake.passed, dropped: wake.dropped }))
  ok('喊过名字后诊断报 awake、窗口 30 秒', wake && wake.awake === true && wake.remainingMs > 0 && wake.windowMs === 30000, '剩余 ' + wake.remainingMs + 'ms')

  bridge.setVoiceName('zh-CN-YunxiNeural')
  ok('setVoiceName 同步到已建实例', fakeVoiceName === 'zh-CN-YunxiNeural')
  bridge.preview('主人，这个声音好听吗？')
  ok('试听走 voice.speak 且带 strict', previews.length === 1 && previews[0].o && previews[0].o.strict === true)

  // 语音聊天关：只听不接话
  const sends2 = []
  let opts2 = null
  const b2 = M.createVoiceBridge({
    narration: { active: () => false, lock() { }, clear() { } },
    narrating: () => false,
    stopSpeaking() { },
    bubble: () => { },
    sendText: (t) => sends2.push(t),
    onVoiceHeard() { },
    onSpeaking() { },
    diag: () => { },
    voiceChat: () => false,
    makeVoice: (o) => { opts2 = o; return Object.assign({}, fakeVoice, { voiceName: () => 'x' }) },
  })
  await b2.start()
  opts2.onHeard('大肥鱼，讲个故事')
  ok('语音聊天关着时只听不接话', sends2.length === 0)

  // 打断词不受唤醒门限制（正在朗读时喊"停"必须立刻停）
  let stopCount = 0
  const sends3 = []
  let opts3 = null
  const b3 = M.createVoiceBridge({
    narration: { active: () => false, lock() { }, clear() { } },
    narrating: () => false,
    stopSpeaking: () => { stopCount++ },
    bubble: () => { },
    sendText: (t) => sends3.push(t),
    onVoiceHeard() { },
    onSpeaking() { },
    diag: () => { },
    voiceChat: () => true,
    speaking: () => true,
    makeVoice: (o) => { opts3 = o; return Object.assign({}, fakeVoice, { voiceName: () => 'x' }) },
  })
  await b3.start()
  ok('打断词直通：从未命中唤醒词也能停（不前置唤醒门）', b3.wakeInfo().awake === false)
  opts3.onHeard('停')
  ok('朗读中喊「停」：直接停，不要求唤醒', stopCount === 1 && sends3.length === 0, '停 ' + stopCount + ' 次')
}

// ---------- ③ 端点检测真实模式 ----------
console.log('\n[3] endpointInfo 真实模式')
{
  storage.removeItem('chubby-endpoint')
  const v = M.createVoice({})
  ok('初始经典', v.endpointInfo().mode === 'classic')
  v.setEndpointMode('ape')
  ok('切到自适应 → endpointInfo 报 ape', v.endpointInfo().mode === 'ape')
  ok('模式写进 localStorage', storage.getItem('chubby-endpoint') === 'ape')
  const v2 = M.createVoice({})
  ok('新实例继承 ape', v2.endpointInfo().mode === 'ape')
  v2.setEndpointMode('classic')
  ok('切回经典 → endpointInfo 报 classic', v2.endpointInfo().mode === 'classic')
}

// ---------- ④ 聊天语言 ----------
console.log('\n[4] 聊天语言（流式与普通 /chat 同源）')
{
  storage.removeItem('chubby-chatlang')
  ok('未选 → auto', M.resolveChatLang() === 'auto')
  storage.setItem('chubby-chatlang', 'en')
  ok('选英文 → en', M.resolveChatLang() === 'en')
  storage.setItem('chubby-chatlang', 'zh')
  ok('选中文 → zh', M.resolveChatLang() === 'zh')
  storage.setItem('chubby-chatlang', '乱写')
  ok('非法值回落 auto', M.resolveChatLang() === 'auto')
}

// ---------- ⑤ 试听失败静默（不回落浏览器语音） ----------
console.log('\n[5] 试听失败静默（strict）')
{
  let browserSpoken = 0
  globalThis.window.speechSynthesis = { getVoices: () => [{ name: 'x' }], speak() { browserSpoken++ }, cancel() { } }
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    requests.push({ url: String(url), body: null })
    return { ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({ ok: false }), headers: { get: () => null } }
  }
  const v = M.createVoice({})
  v.speak('试听', { strict: true })
  await tick(2600)   // 3 次重试（300+600+900ms）走完
  ok('合成失败不回落 speechSynthesis', browserSpoken === 0, '浏览器朗读次数 ' + browserSpoken)
  globalThis.fetch = realFetch

  // 非 strict 的原有降级仍在：合成失败会用浏览器语音兜底
  globalThis.fetch = async (url) => {
    requests.push({ url: String(url), body: null })
    return { ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({ ok: false }), headers: { get: () => null } }
  }
  const v2 = M.createVoice({})
  v2.speak('日常朗读')
  await tick(2600)
  ok('非 strict 仍保留浏览器兜底（降级未被破坏）', browserSpoken >= 1, '浏览器朗读次数 ' + browserSpoken)
  globalThis.fetch = realFetch
}

// ---------- ⑥ 接线静态断言（源码里不再留"半截"） ----------
console.log('\n[6] 接线静态断言')
{
  const read = (p) => readFileSync(path.join(ROOT, p), 'utf8')
  const chatSrc = read('src/client/chat.ts')
  ok('流式 /chat-stream 的 lang 不再写死', /lang: resolveChatLang\(\)/.test(chatSrc) && !/lang: 'auto'/.test(chatSrc))

  const actSrc = read('src/client/actions/voice.ts')
  // 去掉注释行再判：注释里提到 speechSynthesis 不算"用了"
  const actCode = actSrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  ok('菜单试听不再用浏览器 speechSynthesis', !/SpeechSynthesisUtterance|speechSynthesis\.speak/.test(actCode) && /host\.previewVoice/.test(actCode))
  ok('菜单换音色走 setTtsVoice（存下 + 立即生效）', /host\.setTtsVoice/.test(actSrc))

  const voiceSrc = read('src/client/voice.ts')
  ok('endpointInfo 返回真实模式（不再写死 classic）', /endpointInfo: \(\) => \(\{ mode: epMode \}\)/.test(voiceSrc) && !/endpointInfo: \(\) => \(\{ mode: 'classic' \}\)/.test(voiceSrc))

  const clientSrc = read('src/client.ts')
  ok('client.ts 里不再有"定义未使用"的 WAKE_WORDS', !/const WAKE_WORDS/.test(clientSrc))

  // 菜单英文覆盖：多状态取全部标签，英文界面不能漏中文
  const states = [
    {},
    { voiceOn: true, earOn: true, voiceChatOn: true, chatCacheOn: false, chatLang: 'zh', ttsVoice: 'zh-CN-YunxiNeural' },
    { chatLang: 'en', ttsVoice: 'auto' },
    { chatLang: 'zh', ttsVoice: 'en-GB-SoniaNeural', chatCacheOn: false },
    // 书单拉过但为空 → 菜单显示兜底项「书单没取到，稍后再试」（menu.ts 的 bookItems 分支）
    { storyBooksTried: true },
  ]
  const labels = new Set()
  const walk = (items) => {
    for (const it of items) {
      if (it.type === 'sub') { labels.add(it.label); walk(it.items) }
      else if (it.type === 'item') labels.add(it.label)
    }
  }
  for (const s of states) walk(M.buildMenu('0.1.1', s))
  const arr = [...labels]
  const missingEn = arr.filter((l) => /[\u4e00-\u9fa5]/.test(M.tr(l, 'en')))
  ok('英文界面无遗漏菜单项（' + arr.length + ' 个标签 / ' + states.length + ' 种状态）', missingEn.length === 0, missingEn.slice(0, 3).join(' / '))

  const dead = Object.keys(M.EN_MAP).filter((k) => !arr.some((l) => l === k || l === '✓ ' + k))
  ok('EN_MAP 无死键', dead.length === 0, dead.join(','))
}

rmSync(TMP, { recursive: true, force: true })
console.log('\n────────────────────')
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
