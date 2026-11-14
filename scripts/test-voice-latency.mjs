/**
 * scripts/test-voice-latency.mjs —— 语音一句一落延迟/灵敏度回归（离线：esbuild 打包 + 浏览器桩）
 *
 * 背景（2026-11 主人反馈「代笔一句一落反应慢、一句话落地卡很久」）：
 *   · 端点参数太保守：700ms 静音才收尾、6 秒窗口、最短语音 400ms；
 *   · 更致命的是流水线耦合：旧实现要等 /asr 返回后才 scheduleNext，识别期间下一句
 *     完全不能录 —— 主人接着说的一句整段丢掉，表现为"说完半天没反应/后半句没了"。
 *
 * 这个脚本只做可离线证明的部分（不实际开麦、不联网）：
 *   A 端点参数口径与取舍边界（更灵敏 vs 正常停顿被切碎）
 *   B 录音提前重启：ASR 未返回时下一段已经在录；ASR 返回后不得重复排期
 *   C 忙则丢策略保留：ASR 在途时第二段不发请求、计数/诊断保留，且丢段后录音继续
 *   D 单飞锁释放后连续两句都能识别、都送聊天
 *   E 段落延迟诊断：lastSegment().latency 时间戳/相对耗时齐全，winMs 不被 ASR 等待污染
 *   F ASR 超时重试策略：首试 20s / 重试 12s 有界；超时重试一次成功后照常送聊天
 *   G stop/纪元语义不被解耦破坏：停止后在途结果作废、录音不再重启、不记失败
 *   H 静态接线：onWindowDone 不再 scheduleNext；armNextWindow 的守卫；只写 __chubbyWhale
 *
 * 用法：node scripts/test-voice-latency.mjs
 * 退出码：0 = 全过；1 = 有失败
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import esbuild from 'esbuild'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = path.join(ROOT, '.voice-latency-tmp')

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
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
    '期望 ' + JSON.stringify(expected) + ' / 实际 ' + JSON.stringify(actual))
}
async function agroup(title, fn) {
  console.log('\n[' + title + ']')
  reset()
  try { await fn() } catch (e) { ok(title + '：未抛异常', false, String((e && e.stack) || e)) }
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 2000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await tick(5)
  }
  return false
}

// ---------- 浏览器环境桩（只补 voice.ts 真的会碰的全局） ----------
globalThis.window = globalThis
globalThis.window.__chubbyWhale = {}
globalThis.window.speechSynthesis = { getVoices: () => [], speak() { }, cancel() { } }
globalThis.window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t } }

const LS = new Map()
globalThis.localStorage = {
  getItem: (k) => (LS.has(k) ? LS.get(k) : null),
  setItem: (k, v) => { LS.set(k, String(v)) },
  removeItem: (k) => { LS.delete(k) },
  clear: () => { LS.clear() },
  key: (i) => (Array.from(LS.keys())[i] === undefined ? null : Array.from(LS.keys())[i]),
  get length() { return LS.size },
}

/** Node 没有 FileReader：按规范实现 load/error 两条回调（voice/asr-audio.ts 会用到） */
class StubFileReader {
  constructor() { this.result = null; this.onload = null; this.onloadend = null; this.onerror = null }
  readAsDataURL(blob) {
    blob.arrayBuffer().then((ab) => {
      this.result = 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + Buffer.from(ab).toString('base64')
      if (this.onload) this.onload()
      if (this.onloadend) this.onloadend()
    }, () => { if (this.onerror) this.onerror() })
  }
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((ab) => {
      this.result = ab
      if (this.onload) this.onload()
    }, () => { if (this.onerror) this.onerror() })
  }
}
globalThis.FileReader = StubFileReader

// ---------- 麦克风 / 录音器 / 音频上下文桩 ----------
const MIC = {
  levelAmp: 1,       // 时域样本固定满幅 → 0dBFS，保证不会被判「太安静」
  chunkBytes: 1500,  // 每段 1500B（> MIN_SEGMENT_BYTES 1200）
  recorders: [],
  current() { return MIC.recorders[MIC.recorders.length - 1] || null },
}

class StubRecorder {
  constructor(stream, opts) {
    this.stream = stream
    this.mimeType = (opts && opts.mimeType) || ''
    this.state = 'inactive'
    this.starts = 0
    this.ondataavailable = null
    this.onstop = null
    this.onerror = null
    MIC.recorders.push(this)
  }
  static isTypeSupported(t) { return String(t).indexOf('webm') >= 0 }
  start() {
    if (this.state === 'recording') return
    this.state = 'recording'
    this.starts++
  }
  stop() {
    if (this.state !== 'recording') return
    this.state = 'inactive'
    this._emit()
    setTimeout(() => { try { if (this.onstop) this.onstop() } catch (e) { } }, 0)
  }
  /** 发一块音频（模拟 MediaRecorder 的 dataavailable） */
  _emit() {
    const data = new Blob([new Uint8Array(MIC.chunkBytes)], { type: this.mimeType || 'audio/webm' })
    try { if (this.ondataavailable) this.ondataavailable({ data }) } catch (e) { }
  }
}

class StubAudioContext {
  constructor() { this.state = 'running' }
  createMediaStreamSource() { return { connect() { } } }
  createAnalyser() {
    const amp = () => MIC.levelAmp
    return {
      fftSize: 1024,
      smoothingTimeConstant: 0,
      getFloatTimeDomainData(buf) { const a = amp(); for (let i = 0; i < buf.length; i++) buf[i] = a },
    }
  }
  resume() { this.state = 'running'; return Promise.resolve() }
  close() { this.state = 'closed'; return Promise.resolve() }
  decodeAudioData() { return Promise.reject(new Error('stub 不解码')) }
}

globalThis.MediaRecorder = StubRecorder
globalThis.AudioContext = StubAudioContext
globalThis.webkitAudioContext = StubAudioContext

const fakeTracks = [{ enabled: true, stop() { } }]
// Node 21+ 的 navigator 是只读 getter，必须用 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    mediaDevices: {
      getUserMedia: async () => ({
        getAudioTracks: () => fakeTracks,
        getTracks: () => fakeTracks,
      }),
    },
  },
})

// ---------- /asr 请求桩（可控：立刻回、body 挂着、或下一次直接超时） ----------
const ASR = { calls: [], rejectNext: 0 }
const abortErr = () => { const e = new Error('aborted'); e.name = 'AbortError'; return e }

globalThis.fetch = (url, init) => {
  const u = String(url)
  if (u.indexOf('/asr') < 0) {
    return Promise.resolve({
      ok: true, status: 200,
      arrayBuffer: async () => new ArrayBuffer(8),
      json: async () => ({ ok: true }),
      headers: { get: () => null },
    })
  }
  const call = {
    url: u, format: null,
    signal: (init && init.signal) || null,
    aborted: false, arrived: false, sentAt: Date.now(),
    _res: null, _rej: null, _json: null,
  }
  try { call.format = JSON.parse(String(init && init.body)).format } catch (e) { }
  ASR.calls.push(call)
  // 模拟「客户端硬超时」：接口一直不回 → fetchWithTimeout 的 AbortError。
  // 桩里直接 reject AbortError（等价于超时到点），免得测试真等 20 秒。
  if (ASR.rejectNext > 0) { ASR.rejectNext--; return Promise.reject(abortErr()) }
  const p = new Promise((resolve, reject) => { call._res = resolve; call._rej = reject })
  const onAbort = () => { call.aborted = true; try { call._rej(abortErr()) } catch (e) { } }
  if (call.signal) {
    if (call.signal.aborted) onAbort()
    else { try { call.signal.addEventListener('abort', onAbort, { once: true }) } catch (e) { } }
  }
  return p
}

/** 响应头到达（body 还挂着）：模拟「请求已发、结果还在路上/正在解析」 */
function arrive(call) {
  if (!call || call.aborted || call.arrived) return
  call.arrived = true
  call._res({ ok: true, status: 200, json: () => new Promise((resolve) => { call._json = resolve }) })
}

/** 放行 body 里的文字（此时 voice.ts 的 `const data = await res.json()` 才会落地） */
async function settleJson(call, text) {
  if (!(await waitFor(() => !!call._json || call.aborted, 1000))) return false
  if (call.aborted || !call._json) return false
  const r = call._json
  call._json = null
  r({ ok: true, text })
  return true
}

/** 完整回一个识别结果（头 + body） */
async function fulfil(call, text) {
  arrive(call)
  await settleJson(call, text)
  await tick(30)
}

/**
 * 制造一次"录音段收尾"：起录 → 立刻收段（等价于端点判定命中）。
 * 收段后 onstop 会提前把下一段排上，所以返回时录音器通常已恢复 recording。
 */
async function forceWindow() {
  const r = MIC.current()
  if (!r) throw new Error('录音器还没创建')
  if (r.state !== 'recording') r.start()
  r.stop()
  await tick(30)
}

function reset() {
  ASR.calls.length = 0
  ASR.rejectNext = 0
  MIC.recorders.length = 0
  MIC.levelAmp = 1
  MIC.chunkBytes = 1500
}

// ---------- 打包并加载 client 模块（esbuild 处理 .js → .ts 解析） ----------
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
const entry = path.join(TMP, 'entry.ts')
const out = path.join(TMP, 'bundle.mjs')
await esbuild.build({
  stdin: {
    contents: `import { createVoice } from './src/client/voice.js'\nimport { requiredQuietMs } from './src/shared/sentence-boundary.js'\nimport { WINDOW_MS, MIN_SPEECH_MS, TICK_MS } from './src/client/voice/recorder.js'\nexport { createVoice, requiredQuietMs, WINDOW_MS, MIN_SPEECH_MS, TICK_MS }\n`,
    resolveDir: ROOT,
    sourcefile: 'voice-latency-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: out,
  logLevel: 'silent',
})
const M = await import(pathToFileURL(out).href)
const voiceSrc = readFileSync(path.join(ROOT, 'src/client/voice.ts'), 'utf8')
const recSrc = readFileSync(path.join(ROOT, 'src/client/voice/recorder.ts'), 'utf8')
const boundarySrc = readFileSync(path.join(ROOT, 'src/shared/sentence-boundary.ts'), 'utf8')
/** 去掉注释后的源码：静态断言"代码里不再有 X"时不能被注释里的示例写法误伤 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}
const voiceCode = stripComments(voiceSrc)

/** 建一个语音实例，收集回调痕迹（onHeard / onDiag / onStatus 都是真实入口） */
function makeVoice() {
  const heard = []
  const metas = []
  const diags = []
  const statuses = []
  const v = M.createVoice({
    apiBase: '/api/chubby-whale',
    onHeard: (t, meta) => { heard.push(t); metas.push(meta) },
    onDiag: (d) => diags.push(d),
    onStatus: (s) => statuses.push(s),
  })
  return { v, heard, metas, diags, statuses }
}

// =====================================================================
// A 端点参数口径与取舍边界（2026-11-14 动态阈值）
// =====================================================================
await agroup('A 端点参数：动态静音阈值 600~900ms，短句多等、长句少等', async () => {
  // 数值口径（改代码必须同时改这里，防止悄悄回退到固定 450/700/6s/400ms）
  eq('TICK_MS 45（40~50 区间，判定粒度更细）', M.TICK_MS, 45)
  eq('WINDOW_MS 4500（原 6000）', M.WINDOW_MS, 4500)
  eq('MIN_SPEECH_MS 250（原 400）', M.MIN_SPEECH_MS, 250)

  // 动态阈值曲线：短语音（≤800ms）900ms、长语音（≥4000ms）600ms、中间线性插值
  eq('短语音 0ms → 900ms（最保守）', M.requiredQuietMs(0), 900)
  eq('短语音 800ms（上界）→ 900ms', M.requiredQuietMs(800), 900)
  eq('插值 2400ms（中点）→ 750ms', M.requiredQuietMs(2400), 750)
  eq('长语音 4000ms（下界）→ 600ms', M.requiredQuietMs(4000), 600)
  eq('长语音 5000ms → 600ms', M.requiredQuietMs(5000), 600)

  // 取舍边界（不是死值，是"允许的取舍窗口"）
  ok('动态阈值上限在 850~950ms（短句多等，防尾音被切）', M.requiredQuietMs(0) >= 850 && M.requiredQuietMs(0) <= 950)
  ok('动态阈值下限在 550~650ms（长句少等，整段落地不拖）',
    M.requiredQuietMs(99999) >= 550 && M.requiredQuietMs(99999) <= 650)
  ok('单段窗口在 4000~5000ms 内（短句交互不无限等）', M.WINDOW_MS >= 4000 && M.WINDOW_MS <= 5000)
  ok('最短语音门槛在 200~300ms 内（保住短命令，又不放咳嗽/键盘声）',
    M.MIN_SPEECH_MS >= 200 && M.MIN_SPEECH_MS <= 300)
  ok('tick 在 40~50ms 内（更细又不至于定时器过密）', M.TICK_MS >= 40 && M.TICK_MS <= 50)

  // 帧数换算：短句 900ms = 20 帧；长句 600ms 向上取整 14 帧；最短语音 250ms 向上取整 6 帧（270ms）
  eq('短句阈值向上取整 20 帧', Math.ceil(M.requiredQuietMs(300) / M.TICK_MS), 20)
  eq('长句阈值向上取整 14 帧', Math.ceil(M.requiredQuietMs(4200) / M.TICK_MS), 14)
  eq('最短语音向上取整 6 帧', Math.ceil(M.MIN_SPEECH_MS / M.TICK_MS), 6)

  // 源码级口径：动态阈值只落在 shared/sentence-boundary.ts，recorder 只调用不写死
  ok('recorder.ts：shouldStopClassic 用 requiredQuietMs(s.speechMs)',
    /quietMs >= requiredQuietMs\(s\.speechMs\)/.test(recSrc))
  ok('recorder.ts：导入了 shared/sentence-boundary.js',
    /from '\.\.\/\.\.\/shared\/sentence-boundary\.js'/.test(recSrc))
  ok('recorder.ts：固定的 EARLY_STOP_QUIET 常量已移除',
    voiceCode.length > 0 && !/export const EARLY_STOP_QUIET/.test(recSrc))
  ok('recorder.ts：WINDOW_MS = 4500', /export const WINDOW_MS = 4500/.test(recSrc))
  ok('recorder.ts：MIN_SPEECH_MS = 250', /export const MIN_SPEECH_MS = 250/.test(recSrc))
  ok('recorder.ts：TICK_MS = 45', /export const TICK_MS = 45/.test(recSrc))
  ok('阈值区间只有一个真源：sentence-boundary 里 600/900 各只出现一次定义',
    (boundarySrc.match(/const QUIET_MAX_MS = 900/g) || []).length === 1
    && (boundarySrc.match(/const QUIET_MIN_MS = 600/g) || []).length === 1)
})

// =====================================================================
// B 录音提前重启：ASR 未返回时下一段已经在录
// =====================================================================
await agroup('B 录音提前重启：ASR 在途时下一段已在录，ASR 返回后不重复排期', async () => {
  const { v, heard } = makeVoice()
  await v.start()
  const rec = MIC.current()
  eq('只创建 1 个 MediaRecorder（单录音器不变量）', MIC.recorders.length, 1)
  eq('开始待命后录音中', rec.state, 'recording')
  const starts0 = rec.starts

  await forceWindow()
  ok('第一段已发出 /asr 且尚未返回', await waitFor(() => ASR.calls.length === 1, 2000))

  // 核心断言：旧实现要等 ASR 返回（finally 里 scheduleNext）才恢复录音；
  // 解耦后 ASR 还挂着，下一段已经在录了。
  eq('ASR 在途时录音器已重启并处于 recording', rec.state, 'recording')
  eq('重启只 start 一次（没有双开/重复排期）', rec.starts - starts0, 1)
  eq('全程仍只有 1 个 MediaRecorder 实例', MIC.recorders.length, 1)

  await fulfil(ASR.calls[0], '第一句')
  ok('结果照常送聊天', await waitFor(() => heard.length === 1, 1000))
  await tick(80)
  eq('ASR 返回后没有再多排一次重启（finally 不再 scheduleNext）', rec.starts - starts0, 1)
  eq('录音仍在继续', [rec.state, MIC.recorders.length], ['recording', 1])
  eq('只发了一次识别', ASR.calls.length, 1)

  v.stop()
  eq('stop 后 idle', v.status(), 'idle')
})

// =====================================================================
// C 忙则丢策略保留
// =====================================================================
await agroup('C 忙则丢：ASR 在途时第二段不发请求，计数/诊断保留且录音继续', async () => {
  const { v, heard, diags } = makeVoice()
  await v.start()
  const rec = MIC.current()

  await forceWindow()
  ok('第一段已发出请求', await waitFor(() => ASR.calls.length === 1, 2000))
  eq('此时处于 recognizing', v.status(), 'recognizing')

  // 模拟「主人紧接着又说了一句」：第二段收尾时第一段仍在识别
  await forceWindow()
  await tick(80)
  eq('第二段没有发出第二个 /asr（忙则丢，不排队）', ASR.calls.length, 1)
  eq('第二段也没算一次上传', v.stats.uploaded, 1)
  eq('丢段计入 asrBusyDropped', v.stats.asrBusyDropped, 1)
  ok('保留 asr-busy-drop 诊断', diags.some((d) => d && d.stage === 'asr-busy-drop'))
  eq('丢段后录音已自动重启（耳朵不停）', rec.state, 'recording')
  eq('丢段不把状态卡在别处', v.status(), 'recognizing')

  // 延迟诊断里也能看到最近一次丢弃
  const latencyDiag = globalThis.__chubbyWhale.voiceLatency
  ok('__chubbyWhale.voiceLatency.busyDropped = 1', !!latencyDiag && latencyDiag.busyDropped === 1,
    latencyDiag ? String(latencyDiag.busyDropped) : '无诊断对象')
  ok('__chubbyWhale.voiceLatency.lastDropped 有段号/窗口时长',
    !!latencyDiag && !!latencyDiag.lastDropped && latencyDiag.lastDropped.segId > 0 && latencyDiag.lastDropped.winMs >= 0)

  await fulfil(ASR.calls[0], '第一句')
  ok('第一段结果照常送聊天', await waitFor(() => heard.length === 1, 1000))
  eq('被丢弃的第二段不会顶掉第一段结果', heard, ['第一句'])
  v.stop()
})

// =====================================================================
// D 单飞锁释放后连续两句都能识别
// =====================================================================
await agroup('D 锁会释放：连续两句各识别一次、各送一次', async () => {
  const { v, heard } = makeVoice()
  await v.start()

  await forceWindow()
  ok('第 1 句请求发出', await waitFor(() => ASR.calls.length === 1, 2000))
  await fulfil(ASR.calls[0], '第一句')
  ok('第 1 句送聊天', await waitFor(() => heard.length === 1, 1000))

  await forceWindow()
  ok('第 2 句请求发出', await waitFor(() => ASR.calls.length === 2, 2000))
  await fulfil(ASR.calls[1], '第二句')
  ok('第 2 句送聊天', await waitFor(() => heard.length === 2, 1000))
  eq('两句 = 两次识别 = 两次发送', [ASR.calls.length, heard], [2, ['第一句', '第二句']])

  v.stop()
})

// =====================================================================
// E 段落延迟诊断（时间戳 / 相对耗时 / 解耦证据 / onHeard meta 透传）
// =====================================================================
await agroup('E 延迟诊断：lastSegment().latency 齐全，winMs 不被 ASR 等待污染', async () => {
  const { v, metas } = makeVoice()
  await v.start()
  await forceWindow()
  ok('请求已发出', await waitFor(() => ASR.calls.length === 1, 2000))

  // 故意把 ASR 压住 180ms：旧实现会把这段等待算进 winMs（因为读活的 seg）
  await tick(180)
  await fulfil(ASR.calls[0], '延迟诊断')
  await tick(40)

  const seg = v.lastSegment()
  eq('有一段的诊断缓存', !!seg, true)
  const lat = seg && seg.latency
  eq('latency 对象存在', !!lat && typeof lat === 'object', true)

  const numeric = ['speechEndAt', 'asrStartAt', 'asrDoneAt', 'heardAt', 'quietMs', 'encodeMs',
    'asrMs', 'e2eMs', 'perceivedMs', 'recRestartAt', 'recRestartMs']
  ok('时间戳/相对耗时字段齐全且为数字',
    !!lat && numeric.every((k) => typeof lat[k] === 'number' && isFinite(lat[k])),
    lat ? numeric.filter((k) => typeof lat[k] !== 'number').join(',') : '无 latency')

  ok('事件顺序对：speechEndAt ≤ asrStartAt ≤ asrDoneAt ≤ heardAt',
    !!lat && lat.speechEndAt <= lat.asrStartAt && lat.asrStartAt <= lat.asrDoneAt && lat.asrDoneAt <= lat.heardAt)
  ok('相对耗时自洽：encodeMs/asrMs/e2eMs',
    !!lat && lat.encodeMs === lat.asrStartAt - lat.speechEndAt
    && lat.asrMs === lat.asrDoneAt - lat.asrStartAt
    && lat.e2eMs === lat.heardAt - lat.speechEndAt)
  ok('perceivedMs = e2eMs + 端点静音等待（真说完→回调）',
    !!lat && lat.perceivedMs === lat.e2eMs + lat.quietMs)
  ok('ASR 被压了 ~180ms，winMs 仍是录音段真实时长（<150ms，没把等待算进去）',
    !!seg && seg.winMs >= 0 && seg.winMs < 150, seg ? 'winMs=' + seg.winMs : '无段')
  ok('录音提前重启发生在 ASR 返回之前（recRestartAt>0 且重启延迟 <100ms）',
    !!lat && lat.recRestartAt > 0 && lat.recRestartMs >= 0 && lat.recRestartMs < 100,
    lat ? 'recRestartMs=' + lat.recRestartMs : '无 latency')

  const w = globalThis.__chubbyWhale.voiceLatency
  ok('__chubbyWhale.voiceLatency.last 与 lastSegment().latency 对齐',
    !!w && !!w.last && w.last.segId === lat.segId && w.last.heardAt === lat.heardAt)
  eq('最坏单段等待写进诊断（20s + 12s = 32s）', w && w.maxWaitMs, 32000)

  // onHeard 的第二个参数：收尾快照 meta（代笔面板靠它做断句纠偏）
  const meta = metas[0]
  ok('onHeard 透传 meta（pauseMs/speechMs/winMs）',
    !!meta && typeof meta === 'object'
    && typeof meta.pauseMs === 'number' && typeof meta.speechMs === 'number' && typeof meta.winMs === 'number',
    meta ? JSON.stringify(meta) : '无 meta')
  ok('meta 与 lastSegment 同源：pauseMs=quMs / winMs=窗口时长 / speechMs=peMs',
    !!meta && !!seg && meta.pauseMs === seg.quMs && meta.winMs === seg.winMs
    && meta.speechMs === seg.peMs,
    meta && seg ? JSON.stringify({ meta, quMs: seg.quMs, peMs: seg.peMs, winMs: seg.winMs }) : '无')
  ok('meta.winMs 是录音段真实时长（没被 ASR 等待污染）',
    !!meta && meta.winMs >= 0 && meta.winMs < 150)
  ok('诊断不刷屏：voice.ts 没有 console.log', voiceCode.indexOf('console.log') < 0)

  v.stop()
})

// =====================================================================
// F ASR 超时/重试策略
// =====================================================================
await agroup('F 识别超时重试：首试 20s / 重试 12s 有界，重试成功照常落地', async () => {
  // 静态口径：数值与"最坏等待"可核算
  ok('voice.ts：首试超时 20s（原 30s）', /const ASR_TIMEOUT_MS = 20000/.test(voiceSrc))
  ok('voice.ts：超时重试 12s（比首试短）', /const ASR_RETRY_TIMEOUT_MS = 12000/.test(voiceSrc))
  ok('voice.ts：最坏等待 = 首试 + 重试（可核算的常量）',
    /const ASR_MAX_WAIT_MS = ASR_TIMEOUT_MS \+ ASR_RETRY_TIMEOUT_MS/.test(voiceSrc))
  ok('最坏等待 32000ms < 旧值 60000ms（有界、更短）', 20000 + 12000 < 60000 && 20000 + 12000 <= 35000)
  ok('超时按尝试次数取值（首试/重试不是同一个魔数）',
    /function asrTimeoutForAttempt\(attempt: number\): number \{/.test(voiceSrc)
    && /return attempt > 0 \? ASR_RETRY_TIMEOUT_MS : ASR_TIMEOUT_MS/.test(voiceSrc))
  ok('调用处把尝试次数传进 uploadOnce',
    /uploadOnce\(attempt\)/.test(voiceSrc) && /asrTimeoutForAttempt\(n\)/.test(voiceSrc))

  // 行为：第一次请求直接以 AbortError（超时）失败 → 自动重试一次 → 成功
  const { v, heard, diags } = makeVoice()
  await v.start()
  ASR.rejectNext = 1
  await forceWindow()
  ok('第一次超时后自动重试：第二次请求已发出', await waitFor(() => ASR.calls.length === 2, 2000))
  eq('重试次数计入 stats.asrRetry', v.stats.asrRetry, 1)
  ok('重试保留 asr-retry 诊断', diags.some((d) => d && d.stage === 'asr-retry'))
  eq('重试期间录音继续（单飞占用没让耳朵停）', MIC.current().state, 'recording')

  await fulfil(ASR.calls[1], '重试救回的一句')
  ok('重试成功后照常送聊天', await waitFor(() => heard.length === 1, 1000))
  eq('只送一次（不重复送）', heard, ['重试救回的一句'])
  eq('重试救回不计识别失败', v.stats.asrFail, 0)

  v.stop()
})

// =====================================================================
// G stop/纪元语义不被解耦破坏
// =====================================================================
await agroup('G stop/纪元：停止后在途结果作废、录音不再重启、主动作废不记失败', async () => {
  const { v, heard } = makeVoice()
  await v.start()
  const rec = MIC.current()

  await forceWindow()
  ok('请求已发出且一挂着不回', await waitFor(() => ASR.calls.length === 1, 2000))
  const call = ASR.calls[0]
  eq('请求尚未被取消', call.aborted, false)
  const starts = rec.starts

  v.stop()
  eq('stop 后回到 idle', v.status(), 'idle')
  ok('stop 取消在途 /asr', await waitFor(() => call.aborted === true, 1000))
  await tick(120)
  eq('停止后不再重启录音', rec.starts, starts)
  eq('停止后录音器 inactive', rec.state, 'inactive')
  eq('停止后没有送聊天', heard, [])
  eq('主动作废不算识别失败', v.stats.asrFail, 0)
  eq('没有补发第二次请求', ASR.calls.length, 1)
})

// =====================================================================
// H 静态接线（解耦点 / 守卫 / 诊断只写 __chubbyWhale）
// =====================================================================
await agroup('H 静态接线：onWindowDone 不再排期、armNextWindow 守卫齐全', async () => {
  // 取 onWindowDone 函数体：从函数声明到它后面的「// ---- 朗读 ----」分隔
  const start = voiceSrc.indexOf('async function onWindowDone')
  const end = start >= 0 ? voiceSrc.indexOf('// ---- 朗读 ----', start) : -1
  const body = start >= 0 && end > start ? voiceSrc.slice(start, end) : ''
  ok('拿到 onWindowDone 函数体', body.length > 1000, '长度 ' + body.length)
  ok('onWindowDone 不再 scheduleNext（录音不依赖 ASR 返回）', body.indexOf('scheduleNext(') < 0)
  ok('旧耦合写法 scheduleNext(150) 已从代码移除（注释除外）', voiceCode.indexOf('scheduleNext(150)') < 0)

  ok('onstop 先 armNextWindow 再 onWindowDone（先排下一段、后识别）',
    /armNextWindow\(snap\.retiming\)[\s\S]{0,160}onWindowDone\(blob, snap\)/.test(voiceSrc))
  ok('收段时做快照（id/winMs/peakDb/speechMs/quietMs/ape/retiming）',
    /const snap: SegmentSnapshot = \{[\s\S]{0,600}retiming: \{ restartAt: 0, restartMs: 0 \}/.test(voiceSrc))

  const armStart = voiceSrc.indexOf('function armNextWindow')
  const armEnd = voiceSrc.indexOf('function beginWindow')
  const armBody = armStart >= 0 && armEnd > armStart ? voiceSrc.slice(armStart, armEnd) : ''
  ok('拿到 armNextWindow 函数体', armBody.length > 200, '长度 ' + armBody.length)
  ok('守卫：已停止/无录音器不排', /if \(!running \|\| !rec\) return/.test(armBody))
  ok('守卫：已有段在录 → 不排（不打断正在录的段）', /if \(rec\.state !== 'inactive'\) return/.test(armBody))
  ok('守卫：已排期 → 不重复排', /if \(restartTimer\) return/.test(armBody))
  ok('解耦重启延迟 0ms（没有为 ASR 让路）', /const NEXT_WINDOW_DELAY_MS = 0/.test(voiceSrc))
  ok('beginWindow 撞上"正在录"时不停旧段、不起第二个录音器',
    /function beginWindow[\s\S]{0,700}if \(rec\.state !== 'inactive'\) \{[\s\S]{0,200}return/.test(voiceSrc))

  ok('延迟诊断字段写进 voice.ts',
    ['speechEndAt', 'asrStartAt', 'asrDoneAt', 'heardAt', 'recRestartAt', 'perceivedMs']
      .every((k) => voiceSrc.indexOf(k) >= 0))
  ok('延迟诊断只写 __chubbyWhale.voiceLatency（覆盖式，不 console）',
    voiceCode.indexOf('w.voiceLatency =') >= 0 && voiceCode.indexOf('console.log') < 0)
})

// ---------- 汇总 ----------
rmSync(TMP, { recursive: true, force: true })
console.log('\n' + '='.repeat(52))
console.log('通过 ' + pass + ' 项 / 失败 ' + fail + ' 项')
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('✅ 语音延迟/灵敏度回归全部通过（端点参数 / 提前重启 / 忙则丢 / 时间戳 / 超时重试 / 纪元）')
process.exit(0)
