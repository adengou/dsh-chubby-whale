/**
 * scripts/test-voice-tts.mjs —— B92「客户端朗读播放路径」离线断言（不改 package.json、不接进 npm test）
 *
 * 覆盖本批唯一可改范围：
 *   · src/client/voice.ts            朗读队列/播放/降级/令牌的实际行为（createVoice 集成跑）
 *   · src/client/voice/tts-queue.ts  队列参数、入队/出队、上限丢弃、pitch 下发
 *   · src/client/voice/echo-filter.ts 打断词与 dup 闸门的先后关系
 *
 * 做法（与 scripts/test-audio-sim.mjs 同一套路，不落盘、不联网、不要麦克风）：
 *   · voice.ts 用 esbuild 打成自包含 ESM，再从 data: URL 导入；每组一个独立 bundle（模块级
 *     冷却状态 ttsFailGuard 才能互不污染 —— data: URL 不支持 fragment，只能换 URL）；
 *   · setTimeout/setInterval **和 Date.now** 一起换成可控假时钟（voice.ts 的令牌/看门狗/
 *     退避全部按 Date.now 计时，只换定时器会得到"时间不走"的假结论）；
 *   · fetch / Audio / URL.createObjectURL / speechSynthesis 全部打桩，play() 的
 *     resolve/reject/永不落定 由用例控制，objectURL 的 live 集合用来抓泄漏。
 *
 * 负向验证：本文件先于修复写就；对着未修复的基线跑，[1][2][6][7][8] 会红（见本次交付说明），
 * 修复后全绿 —— 断言确实咬住了真问题，而不是"怎么写都过"。
 *
 * 用法：node scripts/test-voice-tts.mjs      （退出码 0=全绿，1=有失败）
 * 说明：**没有**接进 npm test —— package.json 不在本批可改范围内，需手工运行。
 */

import { build } from 'esbuild'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')
const CLIENT = join(SRC, 'client')

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) } else {
    fail++
    failures.push(name + (detail ? '  ' + detail : ''))
    console.log('  ❌ ' + name + (detail ? '  ' + detail : ''))
  }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
    '期望 ' + JSON.stringify(expected) + ' / 实际 ' + JSON.stringify(actual))
}
function group(title) { console.log('\n[' + title + ']') }

/** 去掉注释再扫源码（注释里解释背景用的状态名不算"跨模块摸内部"） */
function codeOf(file) {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

/** 把 voice.ts（或某个子模块）打成自包含 ESM，再从 data: URL 导入 */
async function bundleEntry(srcLine, tag) {
  const r = await build({
    stdin: { contents: srcLine + '\nexport const __TAG = ' + tag + '\n', resolveDir: ROOT, sourcefile: 'tts-test-' + tag + '.ts', loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2020',
    write: false,
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'silent',
  })
  return import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text, 'utf8').toString('base64'))
}
let tagSeq = 0
const loadVoice = () => bundleEntry("export * from './src/client/voice.ts'", ++tagSeq)
const loadEcho = () => bundleEntry("export * from './src/client/voice/echo-filter.ts'", ++tagSeq)

// ---------------------------------------------------------------- 假时钟
function installClock() {
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, now: Date.now }
  let now = 1_700_000_000_000
  let seq = 0
  const timers = new Map()
  const errors = []
  globalThis.setTimeout = (fn, ms) => {
    const id = ++seq
    timers.set(id, { at: now + Math.max(0, Math.round(Number(ms) || 0)), fn, every: 0 })
    return id
  }
  globalThis.setInterval = (fn, ms) => {
    const id = ++seq
    const period = Math.max(1, Math.round(Number(ms) || 0))
    timers.set(id, { at: now + period, fn, every: period })
    return id
  }
  globalThis.clearTimeout = (id) => { timers.delete(id) }
  globalThis.clearInterval = (id) => { timers.delete(id) }
  Date.now = () => now
  const clock = {
    now: () => now,
    count: () => timers.size,
    errors,
    advance(ms) {
      const end = now + ms
      for (let guard = 0; guard < 200000; guard++) {
        let pick = null
        let pickId = 0
        for (const [id, t] of timers) {
          if (t.at <= end && (!pick || t.at < pick.at)) { pick = t; pickId = id }
        }
        if (!pick) break
        now = pick.at
        if (pick.every > 0) pick.at = now + pick.every
        else timers.delete(pickId)
        try { pick.fn() } catch (e) { errors.push(e) }
      }
      now = end
    },
    async flush(turns = 24) { for (let i = 0; i < turns; i++) await Promise.resolve() },
    /** 推进假时间，并在每个小步之后把 microtask（.then 链）跑完 —— 退避重试是"定时器里再排定时器" */
    async run(ms, step = 100) {
      for (let t = 0; t < ms; t += step) { clock.advance(step); await clock.flush() }
    },
    restore() {
      globalThis.setTimeout = real.setTimeout
      globalThis.clearTimeout = real.clearTimeout
      globalThis.setInterval = real.setInterval
      globalThis.clearInterval = real.clearInterval
      Date.now = real.now
    },
  }
  return clock
}

// ---------------------------------------------------------------- 浏览器桩
function installDom() {
  const LS = new Map()
  const prev = {
    window: globalThis.window,
    localStorage: globalThis.localStorage,
    Audio: globalThis.Audio,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
    speechSynthesis: globalThis.window && globalThis.window.speechSynthesis,
    Utt: globalThis.window && globalThis.window.SpeechSynthesisUtterance,
  }
  globalThis.localStorage = {
    getItem: (k) => (LS.has(k) ? LS.get(k) : null),
    setItem: (k, v) => { LS.set(k, String(v)) },
    removeItem: (k) => { LS.delete(k) },
    clear: () => LS.clear(),
    key: (i) => Array.from(LS.keys())[i] === undefined ? null : Array.from(LS.keys())[i],
    get length() { return LS.size },
  }
  globalThis.window = globalThis
  globalThis.window.__chubbyWhale = {}

  // objectURL 记账：live 集合 = 还没 revoke 的 Blob URL（泄漏就看它）
  const all = []
  const live = new Set()
  let urlSeq = 0
  URL.createObjectURL = () => { const u = 'blob:b92-' + (++urlSeq); all.push(u); live.add(u); return u }
  URL.revokeObjectURL = (u) => { live.delete(u) }

  // Audio 桩：play() 永不自己落定，由用例 ok()/failPlay() 决定
  class FakeAudio {
    constructor(src) {
      this.src = src
      this.paused = true
      this.ended = false
      this.readyState = 4
      this.playCalls = 0
      this.pauseCalls = 0
      this._res = null
      this._rej = null
      FakeAudio.all.push(this)
    }
    play() {
      this.playCalls++
      return new Promise((res, rej) => { this._res = res; this._rej = rej })
    }
    pause() { this.pauseCalls++; this.paused = true }
    /** 真的开播：paused=false + onplaying，并落定 play() 的 Promise */
    ok() {
      this.paused = false
      this.readyState = 4
      if (this.onplaying) this.onplaying()
      const r = this._res
      this._res = null
      this._rej = null
      if (r) r()
    }
    /** 播放被拒（自动播放策略）：play() reject */
    failPlay(name = 'NotAllowedError') {
      const j = this._rej
      this._res = null
      this._rej = null
      if (j) j(Object.assign(new Error(name), { name }))
    }
    fireEnded() { this.ended = true; this.paused = true; const h = this.onended; if (h) h() }
    fireError() { const h = this.onerror; if (h) h() }
  }
  FakeAudio.all = []
  globalThis.Audio = FakeAudio

  // speechSynthesis 桩：记录每一次念，用例可 endLast() 收尾
  const spoken = []
  const synth = {
    speaking: false,
    pending: false,
    getVoices: () => [{ lang: 'zh-CN', name: 'stub-zh' }],
    speak(u) { spoken.push(u); synth.speaking = true },
    cancel() { synth.speaking = false },
  }
  class Utt { constructor(t) { this.text = t } }
  globalThis.window.speechSynthesis = synth
  globalThis.window.SpeechSynthesisUtterance = Utt

  return {
    FakeAudio,
    spoken,
    live: () => Array.from(live.keys()),
    endLast() { const u = spoken[spoken.length - 1]; if (u && typeof u.onend === 'function') u.onend() },
    restore() {
      globalThis.window.speechSynthesis = prev.speechSynthesis
      globalThis.window.SpeechSynthesisUtterance = prev.Utt
      globalThis.Audio = prev.Audio
      URL.createObjectURL = prev.createObjectURL
      URL.revokeObjectURL = prev.revokeObjectURL
      globalThis.localStorage = prev.localStorage
      globalThis.window = prev.window
    },
  }
}

/** fetch 桩：/tts 请求先记账，再由用例 resolve/fail；abort 时按 AbortError 拒绝 */
function installNet() {
  const prev = globalThis.fetch
  const calls = []
  let mode = 'manual' // manual | auto | fail
  globalThis.fetch = (url, init) => {
    const u = String(url)
    const rec = {
      url: u,
      body: init && init.body ? (() => { try { return JSON.parse(String(init.body)) } catch (e) { return null } })() : null,
      aborted: false,
      settled: false,
    }
    calls.push(rec)
    const p = new Promise((resolve, reject) => {
      rec.resolve = (size = 8) => {
        if (rec.settled) return
        rec.settled = true
        resolve({
          ok: true, status: 200,
          arrayBuffer: async () => new ArrayBuffer(size),
          json: async () => ({ ok: true }),
          headers: { get: () => null },
        })
      }
      rec.fail = (status = 500) => {
        if (rec.settled) return
        rec.settled = true
        resolve({ ok: false, status, arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({ ok: false }), headers: { get: () => null } })
      }
      const sig = init && init.signal
      if (sig) {
        const onAbort = () => {
          rec.aborted = true
          if (rec.settled) return
          rec.settled = true
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        }
        if (sig.aborted) onAbort()
        else sig.addEventListener('abort', onAbort)
      }
    })
    if (mode === 'auto') rec.resolve()
    else if (mode === 'fail') rec.fail()
    return p
  }
  return {
    calls,
    tts: () => calls.filter((c) => c.url.indexOf('/tts') >= 0),
    lastTts: () => { const l = calls.filter((c) => c.url.indexOf('/tts') >= 0); return l.length ? l[l.length - 1] : null },
    reset() { calls.length = 0 },
    setMode(m) { mode = m },
    restore() { globalThis.fetch = prev },
  }
}

/** 麦克风/录音器桩：只为了让 start() 成功（本批不测 ASR 链路） */
function installRecorder() {
  const prevNav = globalThis.navigator
  const prevCtx = globalThis.window.AudioContext
  const prevRec = globalThis.MediaRecorder
  const track = { enabled: true, stopped: false, stop() { this.stopped = true } }
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getUserMedia: async () => stream } },
    configurable: true,
  })
  class FakeAnalyser {
    constructor() { this.fftSize = 1024; this.smoothingTimeConstant = 0 }
    getFloatTimeDomainData(buf) { for (let i = 0; i < buf.length; i++) buf[i] = 0 }
  }
  class FakeCtx {
    constructor() { this.state = 'running' }
    resume() { return Promise.resolve() }
    close() { return Promise.resolve() }
    createMediaStreamSource() { return { connect() { } } }
    createAnalyser() { return new FakeAnalyser() }
  }
  globalThis.window.AudioContext = FakeCtx
  class FakeRec {
    static isTypeSupported() { return true }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm;codecs=opus' }
    start() { this.state = 'recording' }
    stop() { this.state = 'inactive'; if (this.onstop) this.onstop() }
  }
  globalThis.MediaRecorder = FakeRec
  return {
    track,
    restore() {
      Object.defineProperty(globalThis, 'navigator', { value: prevNav, configurable: true })
      globalThis.window.AudioContext = prevCtx
      globalThis.MediaRecorder = prevRec
    },
  }
}

/** 一份环境：dom + 网络 + （可选）录音器，用完整体还原 */
function makeEnv() {
  const dom = installDom()
  const net = installNet()
  return {
    dom, net,
    audio: () => dom.FakeAudio.all,
    ttsBodies: () => net.tts().map((c) => c.body),
    restore() { net.restore(); dom.restore() },
  }
}

/** 固定分段文本：14 字首段 + 56 字 × 2 = 3 段（splitForTts 的契约：首段 ≤14） */
const T3 = '白'.repeat(14) + '白'.repeat(56) + '白'.repeat(56)
const T1 = '白'.repeat(14)

// =====================================================================
// [0] 封装治理（静态）：朗读队列/播放只经公开接口，不跨模块摸内部状态
// =====================================================================
function staticAudit() {
  group('封装治理：只经公开接口 / 无跨模块内部状态')
  try {
    const internals = /\b(ttsQ|ttsBusy|ttsAudio|ttsUrl|ttsPrefetch|speakToken|ttsCurJob|ttsSynthAt|ttsProgressAt|ttsNextRetryAt|ttsBrowserKeep)\b/

    const queueSrc = codeOf(join(CLIENT, 'voice', 'tts-queue.ts'))
    ok('tts-queue.ts：零 import（纯函数）', !/from\s+'/.test(queueSrc))
    ok('tts-queue.ts：不引用队列内部状态', !internals.test(queueSrc))
    ok('tts-queue.ts：无 export let/var 可变模块状态', !/^export\s+(let|var)\s/m.test(queueSrc))

    const echoSrc = codeOf(join(CLIENT, 'voice', 'echo-filter.ts'))
    const echoImports = [...echoSrc.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
    const allowEcho = new Set(['../text.js', '../sim.js', '../../shared/noise.js'])
    ok('echo-filter.ts：import 全在公开依赖白名单内', echoImports.every((s) => allowEcho.has(s)), echoImports.join(','))
    ok('echo-filter.ts：不引用队列内部状态', !internals.test(echoSrc))
    ok('echo-filter.ts：无 export let/var 可变模块状态', !/^export\s+(let|var)\s/m.test(echoSrc))

    // 队列状态只准住在 voice.ts 里：别的 .ts 出现这些名字 = 绕过公开接口摸实现
    const offenders = []
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) { walk(p); continue }
        if (!name.endsWith('.ts')) continue
        if (p === join(CLIENT, 'voice.ts')) continue
        const hit = codeOf(p).match(internals)
        if (hit) offenders.push(relative(ROOT, p) + ':' + hit[0])
      }
    }
    walk(SRC)
    ok('全仓只有 voice.ts 持有朗读队列状态（无跨模块直摸）', offenders.length === 0, offenders.join(' / '))

    const voiceSrc = codeOf(join(CLIENT, 'voice.ts'))
    ok('voice.ts：队列/播放计时参数全部来自 tts-queue.ts',
      /from '\.\/voice\/tts-queue\.js'/.test(voiceSrc) && /capQueue/.test(voiceSrc) && !/const TTS_QUEUE_MAX/.test(voiceSrc))
  } catch (e) {
    ok('静态封装扫描执行', false, String((e && e.stack) || e))
  }
}

// =====================================================================
// [1] pitch 下发：speak({pitch}) → buildTtsJobs → /tts 请求体
// =====================================================================
async function pitchContract() {
  group('pitch 下发（speak → 队列任务 → /tts 请求体）')
  const clock = installClock()
  const env = makeEnv()
  try {
    const M = await loadVoice()
    const v = M.createVoice({})

    v.speak('你好呀', { pitch: '+15Hz' })
    await clock.flush()
    const first = env.net.lastTts()
    ok('单段 → 发出一条 /tts 请求', !!first && first.body.text === '你好呀', first ? first.body.text : '无请求')
    eq('pitch 必须进请求体（曾经整段丢掉 → 永远空串）', first && first.body.pitch, '+15Hz')

    // 多段：每一段都要带同一个 pitch（buildTtsJobs 逐段复制）
    v.stopSpeaking()
    env.net.reset()
    v.speak(T3, { pitch: '-10Hz' })
    await clock.flush()
    const bodies = env.ttsBodies()
    ok('多段朗读至少发出 2 条请求（预取窗口）', bodies.length >= 2, String(bodies.length))
    ok('每一段请求都带 pitch', bodies.length > 0 && bodies.every((b) => b && b.pitch === '-10Hz'),
      JSON.stringify(bodies.map((b) => b && b.pitch)))

    // 不传 pitch → 空串（宿主自己决定）
    v.stopSpeaking()
    env.net.reset()
    v.speak('默认音高', {})
    await clock.flush()
    eq('不传 pitch → 请求体空串（不臆造值）', env.net.lastTts() && env.net.lastTts().body.pitch, '')
  } catch (e) {
    ok('pitch 契约执行', false, String((e && e.stack) || e))
  } finally {
    env.restore(); clock.restore()
  }
}

// =====================================================================
// [2] 队列排空后的状态：没开麦时不能报「在听」
// =====================================================================
async function emptyQueueStatus() {
  group('队列排空 → 状态（未开麦 = idle，不能假装在听）')
  const clock = installClock()
  const env = makeEnv()
  try {
    env.net.setMode('auto')
    const M = await loadVoice()
    let done = 0
    const v = M.createVoice({})
    eq('新实例初值 idle', v.status(), 'idle')

    v.speak('一句话。', { onDone: () => { done++ } })
    await clock.flush(40)
    const a = env.audio()[0]
    ok('合成成功 → 建了音频元素并在播', !!a && a.playCalls === 1, a ? 'playCalls=' + a.playCalls : '无元素')
    eq('播报中 speaking=true', v.speaking(), true)
    a.ok()
    a.fireEnded()
    await clock.flush(40)

    eq('onDone 只回调一次', done, 1)
    eq('念完 speaking=false', v.speaking(), false)
    eq('麦克风从未启动 → 结束状态必须是 idle（不是 listening）', v.status(), 'idle')
    eq('没有残留 objectURL', env.dom.live(), [])
  } catch (e) {
    ok('空队列状态执行', false, String((e && e.stack) || e))
  } finally {
    env.restore(); clock.restore()
  }
}

// =====================================================================
// [3] stopSpeaking / 令牌：队列、在途请求、objectURL、旧回调
// =====================================================================
async function stopAndToken() {
  group('stopSpeaking 清队列 + 令牌隔离旧回调')
  const clock = installClock()
  const env = makeEnv()
  try {
    const M = await loadVoice()
    const seen = []
    let done = 0
    const v = M.createVoice({ onSegment: (t) => seen.push(t) })

    v.speak(T3, { onDone: () => { done++ } })
    await clock.flush(30)
    const reqs = env.net.tts()
    eq('3 段 → 预取 2 段 + 开播时补位 1 段 = 3 条在途请求', reqs.length, 3)
    eq('队首段先合成（14 字）', reqs[0].body.text.length, 14)
    reqs[0].resolve()
    await clock.flush(40)
    const a1 = env.audio()[0]
    ok('第一段开播', !!a1 && a1.playCalls === 1)
    a1.ok()
    eq('开播回调收到首段文本', seen.length, 1)

    v.stopSpeaking()
    eq('stop 后 speaking=false', v.speaking(), false)
    eq('stop 后状态回到 idle（未开麦）', v.status(), 'idle')
    eq('stop 立刻 revoke 在播音频的 objectURL（不泄漏）', env.dom.live(), [])
    ok('stop 掐掉未播段：预取的下一段请求被 abort', reqs[1].aborted === true)
    ok('stop 掐掉所有在途合成（不只第一条）', reqs.slice(1).every((r) => r.aborted === true))
    eq('stop 之后没有新的 /tts 请求', env.net.tts().length, 3)
    eq('stop 不回调 onDone（停止 ≠ 念完）', done, 0)

    // 旧元素的 onended 已被摘掉：再响也不会推进新队列
    a1.fireEnded()
    eq('旧 onended 不改变 speaking', v.speaking(), false)
    eq('旧 onended 不计入 ttsPlayed', v.stats.ttsPlayed, 0)

    // 新一段：旧 play() 迟到的 reject 只能收回自己的 URL，不能动新段
    env.net.reset()
    v.speak('新的一句。')
    await clock.flush(30)
    const a2req = env.net.lastTts()
    a2req.resolve()
    await clock.flush(40)
    const a2 = env.audio()[1]
    ok('新段建了新的音频元素（旧元素不复用）', !!a2 && a2 !== a1)
    a1.failPlay() // 旧段的 play() 此时才失败
    await clock.flush(30)
    eq('旧 play() 失败不撤销新段（speaking 仍 true）', v.speaking(), true)
    eq('旧 play() 失败不把旧段塞回队列', env.net.tts().filter((c) => c.body && c.body.text === '新的一句。').length, 1)
    eq('新段音频没有被 dispose（未 pause）', a2.pauseCalls, 0)
    eq('旧段的 objectURL 已 revoke、新段的还在', env.dom.live().length, 1)

    a2.ok()
    a2.fireEnded()
    await clock.flush(40)
    eq('新段念完 → 队列空、状态 idle、URL 全清', [v.speaking(), v.status(), env.dom.live()], [false, 'idle', []])
  } catch (e) {
    ok('stop/令牌执行', false, String((e && e.stack) || e))
  } finally {
    env.restore(); clock.restore()
  }
}

// =====================================================================
// [4] play() 被拒 → 换元素重试 1 次 → 仍失败降级浏览器 → onDone 结账
// =====================================================================
async function playFailPath() {
  group('play() 失败：revoke → 重试一次 → 浏览器兜底')
  const clock = installClock()
  const env = makeEnv()
  try {
    const M = await loadVoice()
    let done = 0
    const v = M.createVoice({})
    v.speak('一句话。', { onDone: () => { done++ } })
    await clock.flush(30)
    env.net.lastTts().resolve()
    await clock.flush(40)
    const a1 = env.audio()[0]
    ok('第一次建元素', !!a1)
    a1.failPlay()
    await clock.flush(40)
    eq('play 失败 → 立刻 revoke 该段 URL', env.dom.live(), [])
    eq('play 失败计入 ttsFail', v.stats.ttsFail, 1)
    eq('播放失败诊断 reason=play', v.lastTtsInfo() && v.lastTtsInfo().reason, 'play')

    await clock.run(300)
    eq('250ms 后重试：又发一次 /tts', env.net.tts().length, 2)
    env.net.lastTts().resolve()
    await clock.flush(40)
    const a2 = env.audio()[1]
    ok('重试用新的音频元素（换元素，不是复用）', !!a2 && a2 !== a1)
    eq('重试期间还没有降级到浏览器', env.dom.spoken.length, 0)

    a2.failPlay()
    await clock.flush(40)
    eq('第二次仍失败 → 不再重试（每次朗读只重试 1 次播放）', env.audio().length, 2)
    await clock.run(120)
    eq('降级到系统语音（同文本）', env.dom.spoken.length, 1)
    eq('降级文本正确', env.dom.spoken[0] && env.dom.spoken[0].text, '一句话。')
    eq('降级时音频 URL 已收（不叠音、不漏内存）', env.dom.live(), [])
    eq('浏览器朗读期间 onDone 还没来', done, 0)

    env.dom.endLast()
    await clock.flush(40)
    eq('浏览器念完 → onDone 结账一次', done, 1)
    eq('结账后状态收尾', [v.speaking(), v.status()], [false, 'idle'])
  } catch (e) {
    ok('play 失败路径执行', false, String((e && e.stack) || e))
  } finally {
    env.restore(); clock.restore()
  }
}

// =====================================================================
// [5] onerror：解码/播放出错 → revoke + 记账 + 继续队列
// =====================================================================
async function onerrorPath() {
  group('onerror：revoke + 记账 + 收尾')
  const clock = installClock()
  const env = makeEnv()
  try {
    env.net.setMode('auto')
    const M = await loadVoice()
    let done = 0
    const v = M.createVoice({})
    v.speak(T1, { onDone: () => { done++ } })
    await clock.flush(40)
    const a = env.audio()[0]
    a.ok()
    a.fireError()
    await clock.flush(40)
    eq('onerror → 该段 URL 已 revoke', env.dom.live(), [])
    eq('onerror 计入 ttsFail', v.stats.ttsFail, 1)
    eq('onerror 记 reason=play', v.lastTtsInfo() && v.lastTtsInfo().reason, 'play')
    eq('onerror 也把这段结账（onDone 一次）', done, 1)
    eq('收尾后不再占线', [v.speaking(), v.status()], [false, 'idle'])
  } catch (e) {
    ok('onerror 路径执行', false, String((e && e.stack) || e))
  } finally {
    env.restore(); clock.restore()
  }
}

// =====================================================================
// [6] 看门狗判死：不开语音待命（试听/说书）也必须能自愈
// =====================================================================
async function watchdogPath() {
  group('看门狗判死：无 start() 也要复位（否则朗读永久卡死）')
  const clock = installClock()
  const env = makeEnv()
  try {
    const M = await loadVoice()
    let done = 0
    const v = M.createVoice({})
    v.speak(T1, { onDone: () => { done++ } })
    await clock.flush(30)
    env.net.lastTts().resolve()
    await clock.flush(40)
    const a = env.audio()[0]
    // 故意不 ok()：音频元素既不播也不报错（真实场景：自动播放被挂起/解码卡住）
    await clock.run(3200)
    eq('2.5 秒无进展 → 判僵尸复位一次', v.stats.ttsZombie, 1)
    eq('判死也要结账（onDone 不被吞）', done, 1)
    eq('判死释放 objectURL', env.dom.live(), [])
    eq('判死后收尾不占线', [v.speaking(), v.status()], [false, 'idle'])
    eq('僵尸复位后不留残余异常', clock.errors.length, 0)
  } catch (e) {
    ok('看门狗（未 start）执行', false, String((e && e.stack) || e))
  } finally {
    env.restore(); clock.restore()
  }

  group('看门狗 + 已开语音待命：播完回到 listening')
  const clock2 = installClock()
  const env2 = makeEnv()
  const rec = installRecorder()
  try {
    env2.net.setMode('auto')
    const M = await loadVoice()
    const v = M.createVoice({})
    await v.start()
    eq('start 后状态 listening', v.status(), 'listening')
    v.speak(T1)
    await clock2.flush(40)
    const a = env2.audio()[0]
    a.ok()
    a.fireEnded()
    await clock2.flush(40)
    eq('开着麦时念完 → 回到 listening', [v.speaking(), v.status()], [false, 'listening'])
    eq('念完没有残留 objectURL', env2.dom.live(), [])
    v.stop()
    eq('stop 后 idle', v.status(), 'idle')
  } catch (e) {
    ok('看门狗（已 start）执行', false, String((e && e.stack) || e))
  } finally {
    rec.restore(); env2.restore(); clock2.restore()
  }
}

// =====================================================================
// [7] 降级闸：连续失败 → 冷却期 → 不打扰宿主 / 请求计数不虚高
// =====================================================================
async function cooldownGate() {
  group('降级闸：连败 → 冷却 → 浏览器兜底口径')
  const clock = installClock()
  const env = makeEnv()
  try {
    env.net.setMode('fail')
    const M = await loadVoice()
    const v = M.createVoice({})
    v.speak(T1)
    await clock.run(8200) // 1 次首发 + 4 次退避重试（500/1000/2000/4000 = 7.5s）
    eq('首发 + 4 次重试 = 5 条 /tts 请求', env.net.tts().length, 5)
    eq('4 次重试失败 → 降级浏览器念完', env.dom.spoken.length, 1)
    ok('冷却已生效（__chubbyWhale.ttsCooldownUntil > now）',
      typeof globalThis.window.__chubbyWhale.ttsCooldownUntil === 'number'
      && globalThis.window.__chubbyWhale.ttsCooldownUntil > Date.now(),
      String(globalThis.window.__chubbyWhale.ttsCooldownUntil))
    eq('失败段计入 ttsFail', v.stats.ttsFail, 1)

    const fetchBefore = env.net.tts().length
    const reqBefore = v.stats.ttsRequests
    env.dom.endLast()
    await clock.flush(40)
    v.speak('第二段。')
    await clock.flush(40)
    eq('冷却期不再打 /tts（省掉注定失败的请求）', env.net.tts().length, fetchBefore)
    eq('冷却期跳过合成的段不计入 ttsRequests（否则自检数字虚高）', v.stats.ttsRequests, reqBefore)
    eq('冷却期诊断 reason=cooldown', v.lastTtsInfo() && v.lastTtsInfo().reason, 'cooldown')
    await clock.run(120)
    eq('冷却期改用系统语音（内容不丢）', env.dom.spoken.length, 2)

    // strict（试听）在冷却期：安静结账，不冒充音色
    const spokenBefore = env.dom.spoken.length
    env.dom.endLast()
    await clock.flush(40)
    v.speak('试听', { strict: true })
    await clock.flush(40)
    eq('strict 在冷却期不回落系统语音', env.dom.spoken.length, spokenBefore)
    eq('strict 安静结账', [v.speaking(), v.status()], [false, 'idle'])
  } catch (e) {
    ok('降级闸执行', false, String((e && e.stack) || e))
  } finally {
    env.restore(); clock.restore()
  }
}

// =====================================================================
// [8] echo-filter：打断词/短命令跳过 dup 闸门（不是放宽 isRepeat）
// =====================================================================
async function echoInterrupt() {
  group('echo-filter：打断词跳过去重闸门（dup 不能吞掉第二声「停」）')
  const M = await loadEcho()
  try {
    const T = 7_000_000
    const f = M.createEchoFilter()
    eq('「停」放行', f.accept('停', T, 1), { ok: true })
    eq('3 秒后第二声「停」仍放行', f.accept('停', T + 3000, 2), { ok: true })
    eq('「停下」放行', f.accept('停下', T + 3100, 3), { ok: true })
    eq('第二声「停下」仍放行', f.accept('停下', T + 3500, 4), { ok: true })

    // 4 字以上的整句打断指令：说书/念诗时喊第二遍必须还能停
    const g = M.createEchoFilter()
    eq('「停下来吧」放行', g.accept('停下来吧', T, 11), { ok: true })
    eq('2 秒后第二声「停下来吧」仍放行（修复前被判 dup 吞掉）', g.accept('停下来吧', T + 2000, 12), { ok: true })
    eq('「不要说了」放行', g.accept('不要说了', T + 2100, 13), { ok: true })
    eq('第二声「不要说了」仍放行', g.accept('不要说了', T + 2300, 14), { ok: true })

    // 负向：普通句子照旧去重，闸门没被放松
    const h = M.createEchoFilter()
    eq('普通句放行', h.accept('今天天气怎么样', T, 21), { ok: true })
    eq('8 秒内同一句仍判 dup', h.accept('今天天气怎么样', T + 2000, 22), { ok: false, reason: 'dup' })
    eq('形似指令的普通句不享受豁免（别人家的孩子）', h.accept('别人家的孩子', T + 100, 23), { ok: true })
    eq('同一句普通句仍判 dup', h.accept('别人家的孩子', T + 300, 24), { ok: false, reason: 'dup' })

    // 负向：自己念过的「继续」被麦克风听回来，仍要判回声
    const k = M.createEchoFilter()
    k.noteSpoken('继续', T)
    const echoVerdict = k.accept('继续', T + 1000, 31)
    eq('本鱼自己说过的「继续」听回来仍判回声', echoVerdict, { ok: false, reason: 'echo' })

    // 单字噪声闸门不受影响
    const n = M.createEchoFilter()
    eq('单字气口仍是 trivial', n.accept('嗯', T, 41), { ok: false, reason: 'trivial' })
    eq('噪声词仍是 noise', n.accept('谢谢观看', T + 10, 42), { ok: false, reason: 'noise' })
  } catch (e) {
    ok('echo-filter 断言执行', false, String((e && e.stack) || e))
  }
}

// =====================================================================
// [9] 队列上限：capQueue 的计数与顺序（集成口径）
// =====================================================================
async function capIntegration() {
  group('队列上限：丢最旧的待播段（计数进 qDropped、顺序从队首）')
  const clock = installClock()
  const env = makeEnv()
  try {
    const M = await loadVoice()
    const seen = []
    const v = M.createVoice({ onSegment: (t) => seen.push(t) })

    // 11760 个同字（无标点、非 [A-Za-z0-9]）→ 1 段 14 字 + 209 段 56 字 + 末段 42 字 = 211 段
    const L = 11760
    const per = 56
    const first = 14
    const rest = L - first
    const total = 1 + Math.floor(rest / per) + (rest % per ? 1 : 0)
    eq('构造文本应切成 211 段（与 splitForTts 契约对拍）', total, 211)

    v.speak('白'.repeat(L))
    await clock.flush(30)
    eq('超上限 11 段 → qDropped 记 11', v.stats.qDropped, total - 200)
    eq('队列仍只剩 200 段待播（首段已被 pump 取走）', v.speaking(), true)
    ok('预取只铺窗口内的少数段（不是 200 条请求）', env.net.tts().length <= 5, String(env.net.tts().length))
    // 注意：pumpTts 等的是"它 shift 的那一段"的预取 Promise（第一条请求），不是最后一条
    const head = env.net.tts()[0]
    eq('队首请求是"被丢之后的第 12 段"（56 字，不是 14 字首段）', head.body.text.length, 56)

    head.resolve()
    await clock.flush(40)
    eq('开播的第一段 = 56 字块（证明丢的是最旧的队首）', seen.length, 1)
    eq('开播段长度 56（首段 14 字确实被丢了）', seen[0].length, 56)
    const a = env.audio()[0]
    a.ok(); a.fireEnded()
    await clock.flush(40)
  } catch (e) {
    ok('队列上限执行', false, String((e && e.stack) || e))
  } finally {
    env.restore(); clock.restore()
  }
}

// =====================================================================
async function main() {
  console.log('== B92 客户端朗读播放路径离线断言 ==')
  staticAudit()
  await pitchContract()
  await emptyQueueStatus()
  await stopAndToken()
  await playFailPath()
  await onerrorPath()
  await watchdogPath()
  await cooldownGate()
  await echoInterrupt()
  await capIntegration()

  console.log('\n────────────────────')
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项')
  if (fail > 0) {
    console.log('失败项：')
    for (const f of failures) console.log('  · ' + f)
    process.exit(1)
  }
  console.log('✅ 朗读播放路径（队列/令牌/释放/降级/回声闸门）离线断言全绿')
  process.exit(0)
}

main().catch((e) => {
  console.error('测试脚本异常：', (e && e.stack) || e)
  process.exit(1)
})
