/**
 * scripts/test-voice-bridge.mjs —— 语音桥 / 唤醒词 / 浏览器朗读兜底 的离线断言
 *
 * 覆盖三块（2026-11-07 B74-voicebridge）：
 *   ① client/wake.ts：繁体折简体、谐音容错、剥词、自定义词（只认新词 / 单字词整句）、30 秒窗原语
 *   ② client/voice-bridge.ts：打断词直通（停/别/不/闭嘴/打住 + 名字前缀）、只喊名字应一声、
 *      叙述锁分支、voiceChat 关闭、syncWakeWords（换词即时生效且不丢窗口）、监听清理
 *   ③ client/browser-tts.ts：voices 异步未就绪、onend 不触发（看门狗 resolve + 收回扬声器）、
 *      cancel 之后立刻 speak 被吞（必须隔一拍）
 *
 * 全部打桩离线跑：esbuild 打包源码后 import，不需要麦克风 / 网络 / 浏览器。
 * 用法：node scripts/test-voice-bridge.mjs
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, rmSync } from 'node:fs'
import esbuild from 'esbuild'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = path.join(ROOT, '.test-voice-bridge-tmp')

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- stub 浏览器环境（桥要读 localStorage / window） ----------
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
const storage = memoryStorage()
const win = {
  __chubbyWhale: {},
  addEventListener(type, fn) { if (type === 'beforeunload') win.listeners.push(fn) },
  removeEventListener(type, fn) {
    if (type !== 'beforeunload') return
    const i = win.listeners.indexOf(fn)
    if (i >= 0) win.listeners.splice(i, 1)
  },
  listeners: [],
}
globalThis.localStorage = storage
globalThis.window = win

// ---------- 打包并加载被审计的模块 ----------
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
const out = path.join(TMP, 'bundle.mjs')
const ENTRY_SRC = `
import { createVoiceBridge } from './src/client/voice-bridge.js'
import { createWakeGate, stripWakeWords, normalizeWakeText, setCustomWakeWord, WAKE_WORDS, WAKE_WORD_KEY } from './src/client/wake.js'
import { speakViaBrowser, browserVoiceUsable, watchdogMs } from './src/client/browser-tts.js'
export {
  createVoiceBridge, createWakeGate, stripWakeWords, normalizeWakeText, setCustomWakeWord,
  WAKE_WORDS, WAKE_WORD_KEY, speakViaBrowser, browserVoiceUsable, watchdogMs,
}
`
await esbuild.build({
  stdin: { contents: ENTRY_SRC, resolveDir: ROOT, sourcefile: 'voice-bridge-entry.ts', loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: out,
  logLevel: 'silent',
})
const M = await import(pathToFileURL(out).href)

// ---------- ① 唤醒词原语 ----------
console.log('\n[1] 唤醒词原语（繁简 / 谐音 / 剥词 / 自定义词）')
{
  ok('繁体折简体', M.normalizeWakeText('大肥魚') === '大肥鱼', M.normalizeWakeText('大肥魚'))
  const t1 = M.stripWakeWords('大肥魚，講個故事')
  ok('繁体句子：命中并把唤醒词剥掉', t1.hit === true && t1.text === '講個故事', '正文「' + t1.text + '」')

  const t2 = M.stripWakeWords('大粉鱼，讲个笑话')
  ok('谐音容错（大粉鱼）→ 命中并剥词', t2.hit === true && t2.text === '讲个笑话', '正文「' + t2.text + '」')

  const t3 = M.stripWakeWords('我想看小鱼')
  ok('两字词不在句首 → 不误剥（「我想看小鱼」原样）', t3.hit === false && t3.text === '我想看小鱼', t3.text)

  const t4 = M.stripWakeWords('大肥鱼，讲个故事', ['小饭团'])
  ok('自定义词表下不再认「大肥鱼」（约定：只用这一个词）', t4.hit === false, '实际 hit=' + t4.hit)

  const t5 = M.stripWakeWords('小饭团，讲个故事', ['小饭团'])
  ok('自定义词命中并剥词', t5.hit === true && t5.text === '讲个故事', '正文「' + t5.text + '」')

  const t6 = M.stripWakeWords('好的', ['好'])
  ok('单字唤醒词只认整句（「好的」不被剥成「的」）', t6.hit === false, '实际 hit=' + t6.hit)
  const t7 = M.stripWakeWords('好', ['好'])
  ok('单字唤醒词整句命中 → 剥成空（只喊了名字）', t7.hit === true && t7.text === '', '正文「' + t7.text + '」')
}

// ---------- ② 30 秒有效窗原语（bridge 已不据此拦话，这里只验窗口语义） ----------
console.log('\n[2] 唤醒门 30 秒有效窗')
{
  const gate = M.createWakeGate()
  ok('窗口 = 30 秒', gate.windowMs === 30000, gate.windowMs + 'ms')
  const t0 = 1_000_000
  gate.check('大肥鱼', t0)
  ok('命中后 29.999 秒仍在窗内', gate.awake(t0 + 29999) === true)
  ok('剩下 1ms', gate.remainingMs(t0 + 29999) === 1, gate.remainingMs(t0 + 29999) + 'ms')
  ok('超过 30 秒出窗', gate.awake(t0 + 30001) === false)

  const g2 = M.createWakeGate({ words: ['小饭团'] })
  ok('自定义词表：旧词谐音不再命中', g2.check('大粉鱼', t0).hit === false)
  ok('自定义词表：新词命中', g2.check('小饭团', t0).hit === true)
}

// ---------- ③ bridge：打断词 / 只喊名字 / 叙述锁 ----------
console.log('\n[3] voice-bridge：打断词直通与只喊名字')
{
  function makeNarration(active = false) {
    const st = { active, cleared: 0 }
    return {
      lock() { }, clear() { st.cleared++ }, remaining() { return 0 }, expire() { return false },
      active: () => st.active,
      _st: st,
    }
  }
  function makeBridge(over = {}) {
    const narration = over.narration || makeNarration(false)
    const log = { sends: [], bubbles: [], says: [], stops: 0, diag: {} }
    let caps = null
    let speaking = over.speaking !== undefined ? over.speaking : true
    const fakeVoice = {
      start: async () => { },
      stop() { },
      speak() { },
      stopSpeaking() { },
      setVoiceName() { },
      voiceName: () => 'zh-CN-XiaoyiNeural',
      speaking: () => speaking,
      mute() { },
      stats: {},
      status: () => 'listening',
      setEndpointMode() { },
      endpointInfo: () => ({ mode: 'classic' }),
    }
    const bridge = M.createVoiceBridge({
      narration,
      narrating: () => !!over.narrating,
      stopSpeaking: () => { log.stops++ },
      bubble: (t) => log.bubbles.push(t),
      say: (t) => log.says.push(t),
      sendText: (t, o) => log.sends.push({ t, o }),
      onVoiceHeard() { },
      onSpeaking() { },
      diag: (d) => Object.assign(log.diag, d),
      voiceChat: over.voiceChat || (() => true),
      speaking: () => speaking,
      makeVoice: (o) => { caps = o; return fakeVoice },
    })
    return {
      bridge, log, narration,
      setSpeaking: (v) => { speaking = v },
      heard: (t) => { if (!caps) throw new Error('先 start()'); caps.onHeard(t) },
    }
  }

  const b = makeBridge()
  await b.bridge.start()
  for (const w of ['停', '别', '不', '闭嘴', '打住']) {
    const before = b.log.stops
    b.heard(w)
    ok('朗读中喊「' + w + '」→ 立刻停、不送聊天', b.log.stops === before + 1 && b.log.sends.length === 0, '停 ' + b.log.stops + ' 次')
  }
  b.heard('大肥鱼，停')
  ok('「大肥鱼，停」也认（带名字的打断词）', b.log.stops === 6 && b.log.sends.length === 0, '停 ' + b.log.stops + ' 次')
  b.heard('别说了')
  ok('「别说了」整句打断', b.log.stops === 7 && b.log.sends.length === 0)

  // 没在朗读：打断词不能吞掉正常发言
  b.setSpeaking(false)
  b.heard('停')
  ok('没在朗读时「停」照常当正文送聊天（不吞话）', b.log.sends.length === 1 && b.log.sends[0].t === '停', JSON.stringify(b.log.sends[0]))

  b.heard('大肥鱼')
  ok('只喊名字 → 应一声（say），不送聊天', b.log.says.length === 1 && b.log.says[0].indexOf('在呢') >= 0 && b.log.sends.length === 1)

  b.heard('大肥鱼，讲个故事')
  ok('唤醒词剥掉后送正文', b.log.sends.length === 2 && b.log.sends[1].t === '讲个故事' && b.log.sends[1].o.voice === true, JSON.stringify(b.log.sends[1]))

  const w = b.bridge.wakeInfo()
  ok('诊断：hits=2 / passed=3（打断词不计数）', w.hits === 2 && w.passed === 3, JSON.stringify({ hits: w.hits, passed: w.passed }))
  ok('诊断：命中唤醒词后 awake=true 且窗口 30 秒', w.awake === true && w.windowMs === 30000)

  // 叙述锁：说书/念诗期间只放行停止
  const nb = makeBridge({ narration: makeNarration(true), narrating: true })
  await nb.bridge.start()
  nb.heard('别')
  ok('叙述中喊「别」→ 停朗读 + 清叙述锁', nb.log.stops === 1 && nb.narration._st.cleared === 1 && nb.log.sends.length === 0)
  nb.heard('随便说点什么')
  ok('叙述中的闲聊不送聊天', nb.log.sends.length === 0 && (win.__chubbyWhale.narrDrop || 0) >= 1, 'narrDrop=' + win.__chubbyWhale.narrDrop)
  nb.heard('大肥鱼，念首诗')
  ok('叙述中喊唤醒词也不当新发言', nb.log.sends.length === 0)

  // 语音聊天关闭：只听不接话
  const cb = makeBridge({ voiceChat: () => false })
  await cb.bridge.start()
  cb.setSpeaking(false)
  cb.heard('大肥鱼，讲个故事')
  ok('语音聊天关 → 不送聊天', cb.log.sends.length === 0 && cb.bridge.wakeInfo().dropped === 1, 'dropped=' + cb.bridge.wakeInfo().dropped)
}

// ---------- ④ syncWakeWords：换词即时生效、不丢窗口、不暴露内部数组 ----------
console.log('\n[4] syncWakeWords（换词后的同步）')
{
  storage.clear()
  const log = { sends: [], says: [] }
  let caps = null
  const fakeVoice = {
    start: async () => { }, stop() { }, speak() { }, stopSpeaking() { },
    setVoiceName() { }, voiceName: () => 'zh-CN-XiaoyiNeural', speaking: () => false,
    mute() { }, stats: {}, status: () => 'listening', setEndpointMode() { }, endpointInfo: () => ({ mode: 'classic' }),
  }
  const bridge = M.createVoiceBridge({
    narration: { active: () => false, lock() { }, clear() { } },
    narrating: () => false,
    stopSpeaking() { },
    bubble() { },
    say: (t) => log.says.push(t),
    sendText: (t) => log.sends.push(t),
    onVoiceHeard() { }, onSpeaking() { }, diag() { },
    voiceChat: () => true,
    speaking: () => false,
    makeVoice: (o) => { caps = o; return fakeVoice },
  })
  await bridge.start()

  const info0 = bridge.wakeInfo()
  ok('默认词表 = WAKE_WORDS', info0.words.length === M.WAKE_WORDS.length && info0.words[0] === '大肥鱼', info0.words.join('/'))

  caps.onHeard('大肥鱼')
  ok('先命中一次（刷新 30 秒窗）', bridge.wakeInfo().awake === true && log.says.length === 1)

  ok('写自定义词（不重开语音待命）', M.setCustomWakeWord('小饭团') === true)
  const info1 = bridge.wakeInfo()
  ok('wakeInfo 立刻读到新词表（syncWakeWords）', info1.words.length === 1 && info1.words[0] === '小饭团', info1.words.join('/'))
  ok('换词不丢 30 秒窗', info1.awake === true)

  caps.onHeard('小饭团，讲个故事')
  ok('新词被剥掉后送正文', log.sends.length === 1 && log.sends[0] === '讲个故事', '「' + log.sends[0] + '」')

  caps.onHeard('大肥鱼，讲个故事')
  ok('换词后旧词不再当唤醒词（谐音同禁用）', log.sends.length === 2 && log.sends[1] === '大肥鱼，讲个故事', '「' + log.sends[1] + '」')

  const leaked = bridge.wakeInfo().words
  leaked.push('注入的词')
  ok('wakeInfo 给的是副本（外部改不动门里的词表）', bridge.wakeInfo().words.length === 1 && bridge.wakeInfo().words.indexOf('注入的词') < 0)

  M.setCustomWakeWord('')
  const info2 = bridge.wakeInfo()
  ok('清空自定义词 → 回默认词表', info2.words.length === M.WAKE_WORDS.length && info2.words[0] === '大肥鱼')
}

// ---------- ⑤ 生命周期：beforeunload 监听只挂一个、dispose 摘掉 ----------
console.log('\n[5] 监听清理（beforeunload）')
{
  storage.clear()
  win.listeners.length = 0
  const fakeVoice = {
    start: async () => { }, stop() { }, speak() { }, stopSpeaking() { },
    setVoiceName() { }, voiceName: () => 'x', speaking: () => false,
    mute() { }, stats: {}, status: () => 'listening', setEndpointMode() {}, endpointInfo: () => ({ mode: 'classic' }),
  }
  const mk = () => M.createVoiceBridge({
    narration: { active: () => false, lock() { }, clear() { } },
    narrating: () => false, stopSpeaking() { }, bubble() { }, sendText() { },
    onVoiceHeard() { }, onSpeaking() { }, diag() { }, makeVoice: () => fakeVoice,
  })
  const b = mk()
  await b.start()
  ok('启动后挂 1 个 beforeunload（放麦克风用）', win.listeners.length === 1, win.listeners.length + ' 个')
  b.dispose()
  ok('dispose 摘掉监听', win.listeners.length === 0, win.listeners.length + ' 个')
  await b.start()
  ok('dispose 后重建：仍然只有 1 个（不叠加）', win.listeners.length === 1, win.listeners.length + ' 个')
  b.dispose()
  win.listeners.length = 0
}

// ---------- ⑥ browser-tts：voices 异步 / onend 不触发 / cancel 后被吞 ----------
console.log('\n[6] 浏览器朗读兜底（browser-tts）')
{
  ok('可用性判定：有 speak 即可用', M.browserVoiceUsable({ speechSynthesis: { speak() { } } }) === true)
  ok('可用性判定：没有 speechSynthesis 不可用', M.browserVoiceUsable({}) === false)
  ok('看门狗估时：最短 4 秒', M.watchdogMs('') === 4000, M.watchdogMs('') + 'ms')
  ok('看门狗估时：封顶 30 秒', M.watchdogMs('字'.repeat(200)) === 30000, M.watchdogMs('字'.repeat(200)) + 'ms')
  ok('看门狗估时：56 字 ≈ 13.8 秒', M.watchdogMs('字'.repeat(56)) === 13820, M.watchdogMs('字'.repeat(56)) + 'ms')

  function makeScope(opts = {}) {
    const st = {
      spoken: [], cancelled: 0, addEvent: 0, removeEvent: 0, handlers: [],
      lang: null, voice: null, swallowed: 0, lastCancelAt: -1e9,
    }
    const Synth = {
      speaking: false,
      pending: false,
      getVoices: opts.getVoices || (() => [{ lang: 'zh-CN', name: 'Ting-Ting' }]),
      addEventListener(type, fn) { if (type === 'voiceschanged') { st.addEvent++; st.handlers.push(fn) } },
      removeEventListener(type, fn) {
        if (type !== 'voiceschanged') return
        st.removeEvent++
        const i = st.handlers.indexOf(fn)
        if (i >= 0) st.handlers.splice(i, 1)
      },
      speak(u) {
        // 模拟 Chrome/Safari：cancel 之后立刻 speak 会被吞（50ms 内视为被吞）
        if (opts.swallowAfterCancel && Date.now() - st.lastCancelAt < 50) { st.swallowed++; return }
        st.spoken.push(u)
        if (opts.end) { try { u.onend && setTimeout(() => u.onend(), 5) } catch (e) { } }
      },
      cancel() { st.cancelled++; st.lastCancelAt = Date.now() },
    }
    if (opts.busyAtStart) { Synth.speaking = true }
    return {
      st, synth: Synth,
      scope: { speechSynthesis: Synth, SpeechSynthesisUtterance: class { constructor(t) { this.text = t } } },
      fireVoices() { const hs = st.handlers.slice(); st.handlers.length = 0; for (const h of hs) h() },
    }
  }

  // ① voices 异步未就绪：等 voiceschanged 后再挑同语言音色，只念一次
  {
    const s = makeScope({ getVoices: (() => { let n = 0; return () => (n++ === 0 ? [] : [{ lang: 'zh-CN', name: 'Ting-Ting' }]) })() })
    const p = M.speakViaBrowser('你好呀', { scope: s.scope, watchdog: 5000 })
    ok('voices 为空时先等 voiceschanged（不立刻念）', s.st.spoken.length === 0)
    s.fireVoices()
    await tick(140)
    ok('voiceschanged 后念一次', s.st.spoken.length === 1 && s.st.spoken[0].text === '你好呀', '次数 ' + s.st.spoken.length)
    ok('挑到中文音色（不是默认英文腔）', s.st.spoken[0].voice && s.st.spoken[0].voice.lang === 'zh-CN')
    ok('语言标记 zh-CN', s.st.spoken[0].lang === 'zh-CN')
    s.st.spoken[0].onend()
    await p
    ok('onend → Promise resolve', true)
    ok('voiceschanged 监听已摘掉', s.st.handlers.length === 0)
    ok('正常结束不 cancel（不误杀）', s.st.cancelled === 0)
  }

  // ② 看门狗：onend 永不触发也要 resolve，并把还在念的引擎掐掉
  {
    const s = makeScope({ end: false, busyAtStart: false })
    const t0 = Date.now()
    await M.speakViaBrowser('这段不会回调', { scope: s.scope, watchdog: 120 })
    const used = Date.now() - t0
    ok('onend 不触发 → 看门狗放行（不会永久卡死）', used >= 100 && used < 1500, used + 'ms')
    ok('看门狗判死后 cancel 收回扬声器（防与下一段叠音）', s.st.cancelled === 1, 'cancel ' + s.st.cancelled + ' 次')
  }

  // ③ cancel 被吞：上层在调用前刚 cancel 过（voice.ts 的 ttsBrowserFallback）
  {
    const s = makeScope({ swallowAfterCancel: true, end: true })
    s.synth.cancel()   // 上层先 cancel（同一拍）
    const p = M.speakViaBrowser('刚取消完就念', { scope: s.scope, watchdog: 5000 })
    await tick(150)
    ok('cancel 后不立刻开口（隔一拍），没被吞', s.st.swallowed === 0 && s.st.spoken.length === 1, '被吞 ' + s.st.swallowed + ' 次 / 念了 ' + s.st.spoken.length + ' 次')
    await p
  }

  // ④ 引擎原本在播：先 cancel 旧段，再隔一拍念新的
  {
    const s = makeScope({ busyAtStart: true, end: true })
    const p = M.speakViaBrowser('新的这句', { scope: s.scope, watchdog: 5000 })
    await tick(150)
    ok('引擎在播时先 cancel 旧段再念', s.st.cancelled >= 1 && s.st.spoken.length === 1, 'cancel ' + s.st.cancelled + ' / 念 ' + s.st.spoken.length)
    await p
  }

  // ⑤ 没有 voiceschanged 事件可用：300ms 后带默认音色照念（不能永久等）
  {
    const Synth = {
      speaking: false, pending: false,
      getVoices: () => [],
      addEventListener() { /* voiceschanged 永远不来（Firefox 老毛病） */ },
      removeEventListener() { },
      speak(u) { this.spoken = (this.spoken || 0) + 1; try { u.onend && setTimeout(() => u.onend(), 5) } catch (e) { } },
      cancel() { },
    }
    const scope = { speechSynthesis: Synth, SpeechSynthesisUtterance: class { constructor(t) { this.text = t } } }
    const t0 = Date.now()
    await M.speakViaBrowser('等不到事件', { scope, watchdog: 3000 })
    const used = Date.now() - t0
    ok('没有 voiceschanged 也照念（300ms 等音色 + 80ms 一拍）', Synth.spoken === 1 && used >= 350 && used < 2000, used + 'ms')
  }
}

rmSync(TMP, { recursive: true, force: true })
console.log('\n────────────────────')
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
