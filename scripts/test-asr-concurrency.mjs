/**
 * scripts/test-asr-concurrency.mjs —— ASR 上传/识别的并发治理回归（离线：esbuild 打包 + 浏览器桩）
 *
 * 对着 createVoice 的真实实现跑（只桩麦克风/录音器/电平/网络，不打桩 voice.ts 内部函数）：
 *   A 正常路径不变：一句话 = 一次 /asr = 一次 onHeard
 *   B 单飞：第一段还在识别时，第二段的重复触发直接丢，不发出第二个请求、不顶掉第一段
 *   C 纪元-停止：Stop 后立刻重新待命，旧响应回来必须作废（不送聊天 / 不写诊断 / 不改状态）
 *   D 纪元-打断：停止说话（P0 打断）后，在途识别的结果必须作废
 *   E 早退清干净：Stop 取消在途请求、清单飞标志，主动作废不算「识别失败」
 *   F 锁会释放：连续两句各识别一次、各送一次（不会因为单飞把耳朵永久占住）
 *
 * 为什么单飞要测「重复触发」：正常路径里下一段录音要等这一段识别完才排期（scheduleNext
 * 在 onWindowDone 的 finally），所以并发只可能来自 onstop 连发 / 停掉重开 ——
 * 这里用假录音器显式制造这两种时序，而不是靠真麦克风碰运气。
 *
 * 为什么假录音器能造第二个窗口：测试直接调 recorder.start()/stop() 模拟「同一时刻又来一段」，
 * 麦克风电平固定满幅，所以该段不会被判成静音；时间与体积都过门槛。
 *
 * 用法：node scripts/test-asr-concurrency.mjs
 * 退出码：0 = 全过；1 = 有失败
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import esbuild from 'esbuild'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = path.join(ROOT, '.asr-concurrency-tmp')

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
    this.ondataavailable = null
    this.onstop = null
    this.onerror = null
    MIC.recorders.push(this)
  }
  static isTypeSupported(t) { return String(t).indexOf('webm') >= 0 }
  start() {
    if (this.state === 'recording') return
    this.state = 'recording'
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

// ---------- /asr 请求桩（可控：立刻回、body 挂着、或一直不回来） ----------
const ASR = { calls: [] }
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
    aborted: false, arrived: false,
    _res: null, _rej: null, _json: null,
  }
  try { call.format = JSON.parse(String(init && init.body)).format } catch (e) { }
  ASR.calls.push(call)
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

/** 制造「同一时刻又来一段」：起录 + 立刻收段（等价于麦克风在极短时间里触发两次 onstop） */
async function forceWindow() {
  const r = MIC.current()
  if (!r) throw new Error('录音器还没创建')
  if (r.state !== 'recording') r.start()
  r.stop()
  await tick(40)
}

function reset() {
  ASR.calls.length = 0
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
    contents: `import { createVoice } from './src/client/voice.js'\nexport { createVoice }\n`,
    resolveDir: ROOT,
    sourcefile: 'asr-concurrency-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: out,
  logLevel: 'silent',
})
const M = await import(pathToFileURL(out).href)

/** 建一个语音实例，收集回调痕迹（onHeard / onDiag / onStatus 都是真实入口） */
function makeVoice() {
  const heard = []
  const diags = []
  const statuses = []
  const v = M.createVoice({
    apiBase: '/api/chubby-whale',
    onHeard: (t) => heard.push(t),
    onDiag: (d) => diags.push(d),
    onStatus: (s) => statuses.push(s),
  })
  return { v, heard, diags, statuses }
}

// ---------- A 正常路径 ----------
await agroup('A 正常路径：一句 = 一次识别 = 一次 onHeard（行为不变）', async () => {
  const { v, heard } = makeVoice()
  await v.start()
  eq('start 后进入 listening', v.status(), 'listening')

  await forceWindow()
  ok('第一段发出 /asr 请求', await waitFor(() => ASR.calls.length >= 1, 2000), '请求数 ' + ASR.calls.length)
  eq('上传格式是 webm', ASR.calls[0].format, 'webm')

  await fulfil(ASR.calls[0], '第一句')
  ok('识别结果送进聊天', await waitFor(() => heard.length === 1, 1000))
  eq('只送一次、内容正确', heard, ['第一句'])
  eq('/asr 只发了一次', ASR.calls.length, 1)
  eq('统计：uploaded / asrTexts / heard / asrFail',
    [v.stats.uploaded, v.stats.asrTexts, v.stats.heard, v.stats.asrFail], [1, 1, 1, 0])

  v.stop()
  eq('stop 后回到 idle', v.status(), 'idle')
})

// ---------- B 单飞 ----------
await agroup('B 单飞：识别在途时重复触发的第二段直接丢（忙则丢，不排队）', async () => {
  const { v, heard, diags } = makeVoice()
  await v.start()

  await forceWindow()
  ok('第一段已发出请求', await waitFor(() => ASR.calls.length >= 1, 2000))
  eq('此时处于 recognizing', v.status(), 'recognizing')

  // 模拟麦克风在极短时间里又触发一次（旧段残响 + 新段刚停）：第二段有真实音频、也过音量门槛
  await forceWindow()
  await tick(100)
  eq('第二段没有发出第二个 /asr', ASR.calls.length, 1)
  eq('第二段也没算成一次上传', v.stats.uploaded, 1)
  ok('留下 asr-busy-drop 诊断', diags.some((d) => d && d.stage === 'asr-busy-drop'))
  eq('丢段次数计入 asrBusyDropped（诊断面板可见）', v.stats.asrBusyDropped, 1)

  await fulfil(ASR.calls[0], '第一句')
  ok('第一段结果照常送聊天', await waitFor(() => heard.length === 1, 1000))
  eq('被丢弃的第二段不会顶掉第一段的结果', heard, ['第一句'])
  eq('全程只有一次识别、一次发送', [ASR.calls.length, v.stats.heard], [1, 1])

  v.stop()
})

// ---------- C 纪元：停止 → 重新待命 ----------
await agroup('C 纪元-停止：Stop 后重新待命，旧响应必须作废', async () => {
  const { v, heard } = makeVoice()
  await v.start()

  await forceWindow()
  ok('请求已发出', await waitFor(() => ASR.calls.length >= 1, 2000))
  const old = ASR.calls[0]
  arrive(old)
  ok('响应头已到、body 还挂着（最容易被旧结果顶掉的那一刻）', await waitFor(() => !!old._json, 1000))

  v.stop()
  eq('stop 后回到 idle', v.status(), 'idle')
  await v.start()
  eq('重新待命后 listening', v.status(), 'listening')

  await settleJson(old, '上一轮的旧话')
  await tick(150)
  eq('旧响应不得送聊天', heard, [])
  eq('旧响应不得写诊断缓存（lastSegment 仍为空）', v.lastSegment(), null)
  eq('旧响应不得改状态', v.status(), 'listening')
  eq('旧响应不算识别出文字', v.stats.asrTexts, 0)

  v.stop()
})

// ---------- D 纪元：打断（停止说话） ----------
await agroup('D 纪元-打断：停止说话后，在途识别的结果必须作废', async () => {
  const { v, heard } = makeVoice()
  await v.start()

  await forceWindow()
  ok('请求已发出', await waitFor(() => ASR.calls.length >= 1, 2000))
  const old = ASR.calls[0]
  arrive(old)
  ok('响应头已到、body 还挂着', await waitFor(() => !!old._json, 1000))

  v.stopSpeaking()
  eq('打断只停朗读，待命仍开着', v.status(), 'listening')

  await settleJson(old, '被打断的旧话')
  await tick(150)
  eq('打断前的识别结果不得补送聊天', heard, [])
  eq('也不写诊断缓存', v.lastSegment(), null)

  v.stop()
})

// ---------- E 早退清干净 ----------
await agroup('E 早退清干净：Stop 取消在途请求，且主动作废不记失败', async () => {
  const { v, heard } = makeVoice()
  await v.start()

  await forceWindow()
  ok('请求已发出（一直挂着不回）', await waitFor(() => ASR.calls.length >= 1, 2000))
  const call = ASR.calls[0]
  eq('请求尚未被取消', call.aborted, false)

  v.stop()
  ok('Stop 取消了在途 /asr', await waitFor(() => call.aborted === true, 1000))
  await tick(150)
  eq('主动作废不记识别失败', v.stats.asrFail, 0)
  eq('也不留 lastError', v.stats.lastError, '')
  eq('没有补发第二个请求', ASR.calls.length, 1)
  eq('没有送聊天', heard, [])
  eq('状态已回到 idle', v.status(), 'idle')
})

// ---------- F 锁会释放 ----------
await agroup('F 锁会释放：连续两句各识别一次、各发送一次', async () => {
  const { v, heard } = makeVoice()
  await v.start()

  await forceWindow()
  ok('第 1 句请求发出', await waitFor(() => ASR.calls.length === 1, 2000))
  await fulfil(ASR.calls[0], '第一句')
  ok('第 1 句已送聊天', await waitFor(() => heard.length === 1, 1000))

  ok('下一段录音已排上（锁释放后循环继续）',
    await waitFor(() => { const r = MIC.current(); return !!r && r.state === 'recording' }, 2000))

  await forceWindow()
  ok('第 2 句也发出请求', await waitFor(() => ASR.calls.length === 2, 2000))
  await fulfil(ASR.calls[1], '第二句')
  ok('第 2 句也送聊天', await waitFor(() => heard.length === 2, 1000))
  eq('两句 = 两次识别 = 两次发送', [ASR.calls.length, heard], [2, ['第一句', '第二句']])
  eq('统计对得上（uploaded / heard）', [v.stats.uploaded, v.stats.heard], [2, 2])

  v.stop()
})

// ---------- G 静态接线 ----------
await agroup('G 静态接线：单飞闸门 + 纪元校验 + abort 收尾都在 voice.ts', async () => {
  const src = readFileSync(path.join(ROOT, 'src/client/voice.ts'), 'utf8')
  ok('有单飞闸门（asrBusy 判断）', /if \(asrBusy\)/.test(src))
  ok('每个 await 之后都校验纪元（>= 3 处）', (src.match(/myEpoch !== asrEpoch/g) || []).length >= 3,
    '实际 ' + (src.match(/myEpoch !== asrEpoch/g) || []).length + ' 处')
  ok('finally 里只有同一纪元才回收单飞锁', /if \(myEpoch === asrEpoch\) \{/.test(src))
  ok('Stop / 打断 / 重新待命都调用 abortAsrFlight', (src.match(/abortAsrFlight\(\)/g) || []).length >= 4)
  ok('单飞丢弃有诊断事件', src.indexOf('asr-busy-drop') >= 0)
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
console.log('✅ ASR 并发治理回归全部通过（单飞 / 纪元 / 早退收尾）')
process.exit(0)
