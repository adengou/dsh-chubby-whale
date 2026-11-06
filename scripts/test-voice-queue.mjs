/**
 * scripts/test-voice-queue.mjs —— voice/ 子模块纯逻辑回归（离线、无麦克风、不联网）
 *
 * 覆盖 src/client/voice/ 下这些「能离线证明」的部分：
 *   · tts-queue.ts   重试退避 / 换气停顿 / 预取选择 / 任务构造 / 令牌过期
 *   · echo-filter.ts 回声、短碎片、重复、段级去重、乱序段（含英文大小写回归）
 *   · recorder.ts    电平读取（float/byte 两条路）、端点累计与收尾、体积/峰值门槛
 *   · status.ts      统计初值、状态去重、诊断快照
 *   · voices.ts      音色白名单与回退
 *   · fetch.ts       硬超时 / 外部中断（stub fetch，不联网）
 *   · asr-audio.ts   base64、mp4→WAV（含 WAV 头字段与下混）、转码失败回退
 *
 * 为什么单独一个脚本：verify-voice.mjs 测的是 createVoice 的集成行为，
 * 这些纯函数/状态机的边界（窗口、上限、乱序、大小写）它覆盖不到。
 *
 * 用法：node scripts/test-voice-queue.mjs
 * 退出码：0 = 全过；1 = 有失败
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, rmSync } from 'node:fs'
import esbuild from 'esbuild'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = path.join(ROOT, '.voice-test-tmp')

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
function group(title, fn) {
  console.log('\n[' + title + ']')
  try { fn() } catch (e) { ok(title + '：未抛异常', false, String((e && e.stack) || e)) }
}

// ---------- 浏览器环境 stub（只补这些模块真的会碰的全局） ----------
globalThis.window = globalThis
const LS = new Map()
globalThis.localStorage = {
  getItem: (k) => (LS.has(k) ? LS.get(k) : null),
  setItem: (k, v) => { LS.set(k, String(v)) },
  removeItem: (k) => { LS.delete(k) },
  clear: () => { LS.clear() },
  key: (i) => (Array.from(LS.keys())[i] === undefined ? null : Array.from(LS.keys())[i]),
  get length() { return LS.size },
}

/** Node 没有 FileReader：按规范实现 load/onerror 两条回调（够 asr-audio 用） */
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

// ---------- 打包并加载 client 子模块（esbuild 负责 .js → .ts） ----------
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
const entry = path.join(TMP, 'entry.ts')
const out = path.join(TMP, 'bundle.mjs')
const ENTRY_SRC = `
import {
  TTS_TIMEOUT_MS, TTS_WATCH_MS, TTS_ZOMBIE_MS, TTS_RETRY_MAX, TTS_RETRY_BASE_MS, ECHO_MUTE_MS,
  ttsRetryDelayMs, narrationPauseFor, prefetchTargets, buildTtsJobs, isStaleToken,
} from './src/client/voice/tts-queue.js'
import { createEchoFilter } from './src/client/voice/echo-filter.js'
import {
  WINDOW_MS, EARLY_STOP_QUIET, MIN_SPEECH_MS, SILENT_PEAK_DB, CLASSIC_SPEECH_DB, MUTED_SPEECH_DB,
  TICK_MS, TICK_ERROR_MS, LEVEL_PROBE_MS, MIN_SEGMENT_BYTES, APE_MIN_SPEECH_MS,
  readLevel, createSegmentState, resetSegmentState, addChunk, clearChunks, notePeak,
  accrueClassic, shouldStopClassic, shouldStopApeNoLevel, takeBlob, isTooSmallSegment,
  isSilentPeak, hadApeSpeech,
} from './src/client/voice/recorder.js'
import { createVoiceStats, createStatusHolder, createDiagSnapshots } from './src/client/voice/status.js'
import { fetchWithTimeout } from './src/client/voice/fetch.js'
import {
  readBlobBuffer, blobToBase64, transcodeToWav, prepareAudioForAsr,
} from './src/client/voice/asr-audio.js'
import { TTS_VOICES, DEFAULT_VOICE, normalizeVoiceName, readStoredVoiceName } from './src/client/voice/voices.js'
export {
  TTS_TIMEOUT_MS, TTS_WATCH_MS, TTS_ZOMBIE_MS, TTS_RETRY_MAX, TTS_RETRY_BASE_MS, ECHO_MUTE_MS,
  ttsRetryDelayMs, narrationPauseFor, prefetchTargets, buildTtsJobs, isStaleToken,
  createEchoFilter,
  WINDOW_MS, EARLY_STOP_QUIET, MIN_SPEECH_MS, SILENT_PEAK_DB, CLASSIC_SPEECH_DB, MUTED_SPEECH_DB,
  TICK_MS, TICK_ERROR_MS, LEVEL_PROBE_MS, MIN_SEGMENT_BYTES, APE_MIN_SPEECH_MS,
  readLevel, createSegmentState, resetSegmentState, addChunk, clearChunks, notePeak,
  accrueClassic, shouldStopClassic, shouldStopApeNoLevel, takeBlob, isTooSmallSegment,
  isSilentPeak, hadApeSpeech,
  createVoiceStats, createStatusHolder, createDiagSnapshots,
  fetchWithTimeout,
  readBlobBuffer, blobToBase64, transcodeToWav, prepareAudioForAsr,
  TTS_VOICES, DEFAULT_VOICE, normalizeVoiceName, readStoredVoiceName,
}
`
await esbuild.build({
  stdin: { contents: ENTRY_SRC, resolveDir: ROOT, sourcefile: 'voice-test-entry.ts', loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: out,
  logLevel: 'silent',
})
const M = await import(pathToFileURL(out).href)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- tts-queue：常量 / 退避 / 停顿 / 预取 / 任务 / 令牌 ----------
group('tts-queue 常量与重试退避', () => {
  eq('TTS_TIMEOUT_MS', M.TTS_TIMEOUT_MS, 20000)
  eq('TTS_WATCH_MS', M.TTS_WATCH_MS, 1000)
  eq('TTS_ZOMBIE_MS', M.TTS_ZOMBIE_MS, 2500)
  eq('ECHO_MUTE_MS', M.ECHO_MUTE_MS, 700)
  eq('TTS_RETRY_MAX', M.TTS_RETRY_MAX, 4)
  eq('TTS_RETRY_BASE_MS', M.TTS_RETRY_BASE_MS, 500)
  eq('第 1 次退避', M.ttsRetryDelayMs(1), 500)
  eq('第 2 次退避', M.ttsRetryDelayMs(2), 1000)
  eq('第 3 次退避', M.ttsRetryDelayMs(3), 2000)
  eq('第 4 次退避', M.ttsRetryDelayMs(4), 4000)
  eq('超出上限按最后一次算', M.ttsRetryDelayMs(9), 4000)
  eq('非法 attempt 回落 500', M.ttsRetryDelayMs(0), 500)
  eq('总等待 7.5 秒', M.ttsRetryDelayMs(1) + M.ttsRetryDelayMs(2) + M.ttsRetryDelayMs(3) + M.ttsRetryDelayMs(4), 7500)
})

group('tts-queue 段间换气停顿', () => {
  eq('句末句号 → 260', M.narrationPauseFor('白饭真好吃。'), 260)
  eq('句末问号 → 260', M.narrationPauseFor('吃了吗？'), 260)
  eq('半角叹号 → 260', M.narrationPauseFor('stop!'), 260)
  eq('句内逗号 → 140', M.narrationPauseFor('白饭，'), 140)
  eq('顿号 → 140', M.narrationPauseFor('鱼、'), 140)
  eq('分号 → 140', M.narrationPauseFor('鱼；'), 140)
  eq('无标点 → 200', M.narrationPauseFor('本鱼'), 200)
  eq('空串 → 200', M.narrationPauseFor(''), 200)
  eq('末尾空格先 trim 再判', M.narrationPauseFor('好吃！  '), 260)
})

group('tts-queue 预取选择', () => {
  const job = (seq, narration = false) => ({ seq, text: 't' + seq, rate: '+0%', narration, attempts: 0, strict: false })
  const q = [job(1), job(2), job(3), job(4)]
  eq('普通聊天取 2 块', M.prefetchTargets(q, false).map((j) => j.seq), [1, 2])
  eq('叙述取 3 块', M.prefetchTargets(q, true).map((j) => j.seq), [1, 2, 3])
  eq('队列不足时按实际长度', M.prefetchTargets([job(7)], true).map((j) => j.seq), [7])
  eq('空队列 → 空', M.prefetchTargets([], true).map((j) => j.seq), [])
  eq('已在途 2 条 → 只补 1 条', M.prefetchTargets(q, true, 2, undefined, 3).map((j) => j.seq), [1])
  eq('已在途 3 条 → 一条都不发', M.prefetchTargets(q, true, 3, undefined, 3).map((j) => j.seq), [])
  eq('已预取的段跳过（窗口深度内补齐）', M.prefetchTargets(q, true, 0, (seq) => seq === 1, 3).map((j) => j.seq), [2, 3])
  eq('已预取的段跳过（普通 2 块窗口）', M.prefetchTargets(q, false, 0, (seq) => seq === 1, 3).map((j) => j.seq), [2])
  eq('并发上限 0 → 一条都不发', M.prefetchTargets(q, false, 0, undefined, 0).map((j) => j.seq), [])
  eq('顺序保持单调（不插队）', (() => {
    const seqs = M.prefetchTargets(q, true, 0, undefined, 3).map((j) => j.seq)
    return seqs.every((s, i) => i === 0 || s > seqs[i - 1])
  })(), true)
})

group('tts-queue 任务构造与令牌', () => {
  const done = () => 1
  const jobs = M.buildTtsJobs(['第一句。', '第二句。', '第三句。'], {
    rate: '-15%', narration: true, strict: false, nextSeq: 10, onDone: done,
  })
  eq('段数', jobs.length, 3)
  eq('seq 从 nextSeq 连续递增', jobs.map((j) => j.seq), [10, 11, 12])
  eq('rate 下发到每段', jobs.map((j) => j.rate), ['-15%', '-15%', '-15%'])
  eq('narration 下发到每段', jobs.map((j) => j.narration), [true, true, true])
  eq('attempts 从 0 起', jobs.map((j) => j.attempts), [0, 0, 0])
  eq('只有最后一段挂 onDone', jobs.map((j) => (j.onDone === done ? 1 : 0)), [0, 0, 1])
  eq('单段时 onDone 也在这一段', M.buildTtsJobs(['只有一句'], {
    rate: '+0%', narration: false, strict: true, nextSeq: 1, onDone: done,
  })[0].onDone === done, true)
  eq('空段数组 → 无任务', M.buildTtsJobs([], { rate: '+0%', narration: false, strict: false, nextSeq: 1 }).length, 0)
  eq('令牌未设置视为不过期', M.isStaleToken(undefined, 5), false)
  eq('令牌相同 → 不过期', M.isStaleToken(5, 5), false)
  eq('令牌不同 → 过期', M.isStaleToken(4, 5), true)
})

// ---------- echo-filter：回声 / 碎片 / 重复 / 段级去重 ----------
group('echo-filter 基础闸门', () => {
  const f = M.createEchoFilter()
  eq('正常一句 → 放行', f.accept('今天天气怎么样', 1000, 1), { ok: true })
  eq('单字噪声 → trivial', f.accept('嗯', 1100, 2), { ok: false, reason: 'trivial' })
  eq('噪声词 → noise', f.accept('谢谢观看', 1200, 3), { ok: false, reason: 'noise' })
  eq('本鱼在听… → self', f.accept('本鱼在听呢，主人说', 1300, 4), { ok: false, reason: 'self' })
  eq('打断词「停」必须放行（供 voice-bridge 掐朗读）', f.accept('停', 1400, 5), { ok: true })
  eq('打断词「别」必须放行', f.accept('别', 1500, 6), { ok: true })
  eq('打断词「不」必须放行', f.accept('不', 1600, 7), { ok: true })
})

group('echo-filter 回声比对', () => {
  const T0 = 1_000_000
  const f = M.createEchoFilter()
  f.noteSpoken('今天天气不错，适合吃白饭。', T0)
  eq('整句回声 → echo', f.accept('今天天气不错适合吃白饭', T0 + 1000, 1), { ok: false, reason: 'echo' })
  eq('后半句碎片（≥6 字）→ echo', f.accept('适合吃白饭', T0 + 1500, 2), { ok: false, reason: 'echo' })
  eq('短词回声（3 字，被原句包含）→ echo', f.accept('吃白饭', T0 + 2000, 3), { ok: false, reason: 'echo' })
  eq('主人自己的新话 → 放行', f.accept('明天会下雨吗', T0 + 2500, 4), { ok: true })

  const g = M.createEchoFilter()
  g.noteSpoken('你好呀', T0)
  eq('刚朗读过又只听到 2 字碎片 → short', g.accept('的歪', T0 + 1200, 1), { ok: false, reason: 'short' })

  const h = M.createEchoFilter()
  h.noteSpoken('今天天气不错，适合吃白饭。', T0)
  eq('15 秒窗口外的同文 → 放行', h.accept('今天天气不错适合吃白饭', T0 + 16000, 1), { ok: true })
})

group('echo-filter 英文回声（大小写归一）', () => {
  const T0 = 2_000_000
  const f = M.createEchoFilter()
  f.noteSpoken('Hello there, I am the whale.', T0)
  eq('英文回声（ASR 小写）→ echo', f.accept('hello there i am the whale', T0 + 1000, 1), { ok: false, reason: 'echo' })
  eq('英文新话 → 放行', f.accept('what is the weather today', T0 + 1200, 2), { ok: true })

  const g = M.createEchoFilter()
  g.noteSpoken('Dr. Smith, 你的药在桌上。', T0)
  eq('中英混排回声（大小写不同）→ echo', g.accept('dr smith 你的药在桌上', T0 + 1000, 1), { ok: false, reason: 'echo' })
})

group('echo-filter 重复与段级去重', () => {
  const T0 = 3_000_000
  const f = M.createEchoFilter()
  eq('第一遍放行', f.accept('今天天气怎么样', T0, 1), { ok: true })
  eq('8 秒内同一句 → dup', f.accept('今天天气怎么样', T0 + 2000, 2), { ok: false, reason: 'dup' })
  eq('隔 9 秒再说同一句 → 放行', f.accept('今天天气怎么样', T0 + 9500, 3), { ok: true })
  eq('同一录音段重复处理 → dup', f.accept('另一个问题', T0 + 9600, 3), { ok: false, reason: 'dup' })

  const g = M.createEchoFilter()
  eq('段 10 放行', g.accept('第一段内容甲甲甲', T0, 10), { ok: true })
  eq('段 12 放行', g.accept('第二段内容乙乙乙', T0 + 100, 12), { ok: true })
  eq('迟到的段 11（乱序）→ 当重复丢掉', g.accept('迟到的旧段内容丙丙丙', T0 + 200, 11), { ok: false, reason: 'dup' })
  eq('乱序段不算新发言（再放行一次仍丢）', g.accept('迟到的旧段内容丁丁丁', T0 + 300, 11), { ok: false, reason: 'dup' })
})

group('echo-filter reset 清空全部记忆', () => {
  const T0 = 4_000_000
  const f = M.createEchoFilter()
  f.noteSpoken('今天天气不错，适合吃白饭。', T0)
  eq('回声先挡住', f.accept('今天天气不错适合吃白饭', T0 + 500, 9), { ok: false, reason: 'echo' })
  f.reset()
  eq('reset 后同一段号可以重新处理', f.accept('今天天气不错适合吃白饭', T0 + 600, 9), { ok: true })
  eq('reset 后不再比较旧朗读', f.accept('新的问题来了', T0 + 700, 10), { ok: true })
})

// ---------- recorder：电平 / 端点 / 门槛 ----------
group('recorder 电平读取', () => {
  const floatAn = (vals) => ({ getFloatTimeDomainData(buf) { for (let i = 0; i < buf.length; i++) buf[i] = vals[i] } })
  const buf4 = () => new Float32Array(4)
  const full = M.readLevel(floatAn([1, 1, 1, 1]), buf4(), { byte: null })
  ok('满幅 float → 约 0 dBFS', full.read === true && Math.abs(full.db) < 0.01, '实际 ' + full.db)
  const silent = M.readLevel(floatAn([0, 0, 0, 0]), buf4(), { byte: null })
  ok('全零 float → -160 dBFS', silent.read === true && silent.db <= -159.99, '实际 ' + silent.db)
  eq('无 analyser → read=false', M.readLevel(null, buf4(), { byte: null }), { db: -160, read: false })
  eq('无时域缓冲 → read=false', M.readLevel(floatAn([1, 1, 1, 1]), null, { byte: null }), { db: -160, read: false })

  const byteAn = (v) => ({ getByteTimeDomainData(buf) { for (let i = 0; i < buf.length; i++) buf[i] = v } })
  const box = { byte: null }
  const byteSilent = M.readLevel(byteAn(128), buf4(), box)
  ok('8bit 中心值 128 → 约 -160 dBFS', byteSilent.read === true && byteSilent.db <= -159.99, '实际 ' + byteSilent.db)
  const first = box.byte
  M.readLevel(byteAn(128), buf4(), box)
  ok('8bit 兜底缓冲复用（不每帧新建）', box.byte === first && box.byte instanceof Uint8Array && box.byte.length === 4)
  const byteFull = M.readLevel(byteAn(255), buf4(), box)
  ok('8bit 满幅 → 高于 -1 dBFS', byteFull.read === true && byteFull.db > -1, '实际 ' + byteFull.db)
})

group('recorder 经典端点累计', () => {
  eq('TICK_MS', M.TICK_MS, 60)
  eq('TICK_ERROR_MS', M.TICK_ERROR_MS, 120)
  eq('LEVEL_PROBE_MS', M.LEVEL_PROBE_MS, 1200)
  eq('WINDOW_MS', M.WINDOW_MS, 6000)
  eq('EARLY_STOP_QUIET', M.EARLY_STOP_QUIET, 700)
  eq('MIN_SPEECH_MS', M.MIN_SPEECH_MS, 400)
  eq('SILENT_PEAK_DB', M.SILENT_PEAK_DB, -35)
  eq('CLASSIC_SPEECH_DB', M.CLASSIC_SPEECH_DB, -45)
  eq('MUTED_SPEECH_DB', M.MUTED_SPEECH_DB, 0)
  eq('MIN_SEGMENT_BYTES', M.MIN_SEGMENT_BYTES, 1200)
  eq('APE_MIN_SPEECH_MS', M.APE_MIN_SPEECH_MS, 150)

  const s = M.createSegmentState()
  M.resetSegmentState(s, 0)
  for (let i = 0; i < 7; i++) M.accrueClassic(s, -20, false)
  eq('7 帧说话 → speechMs 420', [s.speechMs, s.quietMs], [420, 0])
  for (let i = 0; i < 11; i++) M.accrueClassic(s, -60, false)
  eq('静音 660ms 还不够 700', M.shouldStopClassic(s, 1000), '')
  M.accrueClassic(s, -60, false)
  eq('静音 720ms → quiet 收尾', M.shouldStopClassic(s, 1000), 'quiet')
  eq('没说过话但到 6 秒 → timeout', M.shouldStopClassic(M.createSegmentState(), M.WINDOW_MS), 'timeout')
  const s2 = M.createSegmentState()
  M.resetSegmentState(s2, 0)
  eq('差 1ms 不超时', M.shouldStopClassic(s2, M.WINDOW_MS - 1), '')

  const muted = M.createSegmentState()
  M.resetSegmentState(muted, 0)
  for (let i = 0; i < 12; i++) M.accrueClassic(muted, -5, true)
  eq('闭麦期间一律按静音累计', [muted.speechMs, muted.quietMs], [0, 720])

  eq('APE 电平不可用且到窗口上限 → 强制收尾', M.shouldStopApeNoLevel(muted, true, M.WINDOW_MS), true)
  eq('APE 电平正常不强制收尾', M.shouldStopApeNoLevel(muted, false, 99999), false)
  eq('APE 未到窗口上限不收尾', M.shouldStopApeNoLevel(muted, true, M.WINDOW_MS - 1), false)
})

group('recorder 段状态与门槛', () => {
  const s = M.createSegmentState()
  M.resetSegmentState(s, 123)
  eq('复位起点', s.startedAt, 123)
  M.addChunk(s, new Blob([new Uint8Array(3)]))
  M.notePeak(s, -20)
  M.notePeak(s, -50)
  eq('峰值只升不降', s.peakDb, -20)
  const blob = M.takeBlob(s, 'audio/webm')
  eq('收段后清空已收块', s.chunks.length, 0)
  eq('收段按实际 mime', [blob.type, blob.size], ['audio/webm', 3])
  M.addChunk(s, new Blob([new Uint8Array(9)]))
  M.clearChunks(s)
  eq('clearChunks 丢弃残响', s.chunks.length, 0)
  eq('重置清空计数', [M.resetSegmentState(s, 5), s.peakDb, s.speechMs, s.quietMs, s.chunks.length].slice(1), [-160, 0, 0, 0])
  eq('1199 字节太小', M.isTooSmallSegment(1199), true)
  eq('1200 字节达线', M.isTooSmallSegment(1200), false)
  eq('峰值 -36 → 太安静', M.isSilentPeak(-36), true)
  eq('峰值 -35 → 达线', M.isSilentPeak(-35), false)
  eq('APE 有效语音', M.hadApeSpeech({ hadSpeech: true, speechMs: 150 }), true)
  eq('APE 说话时长不足', M.hadApeSpeech({ hadSpeech: true, speechMs: 149 }), false)
  eq('APE 没说话', M.hadApeSpeech({ hadSpeech: false, speechMs: 999 }), false)
  eq('APE 空快照', M.hadApeSpeech(null), false)
})

// ---------- status：统计 / 状态 / 诊断快照 ----------
group('status 统计与状态持有', () => {
  const st = M.createVoiceStats()
  const numeric = ['windows', 'skippedSilent', 'uploaded', 'asrFail', 'asrRetry', 'asrTexts', 'heard',
    'echoDropped', 'shortDropped', 'ttsRequests', 'ttsPlayed', 'ttsFail', 'ttsZombie', 'dupDropped']
  eq('统计字段全 0 / 空串', numeric.map((k) => st[k]).concat(st.lastError), numeric.map(() => 0).concat(''))
  ok('每次新建互不共享', M.createVoiceStats() !== M.createVoiceStats())
  st.windows = 3
  eq('调用方改自己的统计不污染新实例', M.createVoiceStats().windows, 0)

  const seen = []
  const h = M.createStatusHolder((s) => seen.push(s))
  eq('状态初值 idle', h.get(), 'idle')
  h.set('listening')
  h.set('listening')
  h.set('speaking')
  eq('同值不重复回调', seen, ['listening', 'speaking'])
  const h2 = M.createStatusHolder(() => { throw new Error('ui boom') })
  let threw = false
  try { h2.set('listening') } catch (e) { threw = true }
  eq('回调异常不打断状态机', [threw, h2.get()], [false, 'listening'])

  const d = M.createDiagSnapshots()
  const ape = { hadSpeech: true, speechMs: 200 }
  d.setApe(ape)
  d.setTts({ failed: false })
  eq('APE 快照往返', d.getApe(), ape)
  eq('TTS 快照往返', d.getTts(), { failed: false })
  eq('未设置的段快照为 null', d.getSegment(), null)
})

// ---------- voices：白名单与回退 ----------
group('voices 音色白名单', () => {
  eq('白名单 8 个音色 + auto', M.TTS_VOICES.length, 9)
  ok('含 auto', M.TTS_VOICES.indexOf('auto') >= 0)
  ok('含默认晓伊', M.TTS_VOICES.indexOf('zh-CN-XiaoyiNeural') >= 0)
  ok('白名单已冻结', Object.isFrozen(M.TTS_VOICES))
  eq('默认音色', M.DEFAULT_VOICE, 'zh-CN-XiaoyiNeural')
  eq('白名单内保持原值', M.normalizeVoiceName('en-US-AnaNeural'), 'en-US-AnaNeural')
  eq('白名单外回退默认', M.normalizeVoiceName('de-DE-KatjaNeural'), M.DEFAULT_VOICE)
  eq('空值回退默认', M.normalizeVoiceName('', 'x'), 'x')
  eq('非字符串回退默认', M.normalizeVoiceName(42), M.DEFAULT_VOICE)
  LS.clear()
  LS.set('chubby-tts-voice', 'en-GB-SoniaNeural')
  eq('读 localStorage 里的合法音色', M.readStoredVoiceName(), 'en-GB-SoniaNeural')
  LS.set('chubby-tts-voice', 'bad-voice')
  eq('localStorage 坏值回退默认', M.readStoredVoiceName(), M.DEFAULT_VOICE)
  LS.set('chubby-tts-voice', '')
  eq('localStorage 空值回退默认', M.readStoredVoiceName(), M.DEFAULT_VOICE)
})

// ---------- fetch：硬超时 / 外部中断 / 降级路径 ----------
async function agroup(title, fn) {
  console.log('\n[' + title + ']')
  try { await fn() } catch (e) { ok(title + '：未抛异常', false, String((e && e.stack) || e)) }
}
const REAL_FETCH = globalThis.fetch
const abortedError = () => Object.assign(new Error('aborted'), { name: 'AbortError' })

await agroup('fetch 硬超时与外部中断', async () => {
  // 挂起请求：只有 signal abort 时才 reject
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    const sig = init && init.signal
    if (!sig) return
    if (sig.aborted) { reject(abortedError()); return }
    sig.addEventListener('abort', () => reject(abortedError()), { once: true })
  })
  let err = null
  try { await M.fetchWithTimeout('u', {}, 30) } catch (e) { err = e }
  eq('超时 → AbortError', err && err.name, 'AbortError')

  const outer = new AbortController()
  const p = M.fetchWithTimeout('u', {}, 5000, outer.signal)
  setTimeout(() => outer.abort(), 20)
  err = null
  try { await p } catch (e) { err = e }
  eq('外部中断 → AbortError', err && err.name, 'AbortError')

  // voice.ts 靠 outer.signal.aborted 区分「停止说话」与「合成超时」：
  // 超时必须只 abort 内部控制器，不能把 outer 也 abort 掉（否则超时不计失败、冷却永不触发）
  const outer2 = new AbortController()
  try { await M.fetchWithTimeout('u', {}, 20, outer2.signal) } catch (e) { }
  eq('超时不得连带 abort 外部信号', outer2.signal.aborted, false)

  const pre = new AbortController()
  pre.abort()
  err = null
  try { await M.fetchWithTimeout('u', {}, 1000, pre.signal) } catch (e) { err = e }
  eq('调用前已中断 → AbortError', err && err.name, 'AbortError')

  globalThis.fetch = async () => ({ ok: true, status: 200 })
  const r = await M.fetchWithTimeout('u', {}, 1000)
  eq('正常返回不拦截', [r.ok, r.status], [true, 200])

  // 老 Safari 没有 AbortSignal.any：降级为「outer 的 abort 转发给内部控制器」，
  // 超时与外部中断两条路都必须还能打断请求（2026-11-06 审计修过的真 bug）。
  const savedAny = AbortSignal.any
  let removed = false
  try {
    AbortSignal.any = undefined
    removed = AbortSignal.any === undefined
  } catch (e) { }
  if (removed) {
    globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
      const sig = init && init.signal
      if (!sig) return
      if (sig.aborted) { reject(abortedError()); return }
      sig.addEventListener('abort', () => reject(abortedError()), { once: true })
    })
    const outer3 = new AbortController()
    const p3 = M.fetchWithTimeout('u', {}, 5000, outer3.signal)
    setTimeout(() => outer3.abort(), 20)
    err = null
    try { await p3 } catch (e) { err = e }
    eq('无 AbortSignal.any 时外部中断仍生效', err && err.name, 'AbortError')

    const outer4 = new AbortController()
    err = null
    try { await M.fetchWithTimeout('u', {}, 20, outer4.signal) } catch (e) { err = e }
    eq('无 AbortSignal.any 时超时仍生效', err && err.name, 'AbortError')
    eq('无 AbortSignal.any 时超时不连带 abort 外部信号', outer4.signal.aborted, false)
    AbortSignal.any = savedAny
  } else {
    ok('跳过：无法移除 AbortSignal.any（不改判为失败）', true)
  }
  globalThis.fetch = REAL_FETCH
})

// ---------- asr-audio：base64 / WAV 头 / 转码回退 ----------
function wavInfo(b64) {
  const bytes = Buffer.from(b64, 'base64')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    bytes,
    riff: bytes.toString('ascii', 0, 4),
    wave: bytes.toString('ascii', 8, 12),
    fmt: dv.getUint16(20, true),
    channels: dv.getUint16(22, true),
    sampleRate: dv.getUint32(24, true),
    byteRate: dv.getUint32(28, true),
    blockAlign: dv.getUint16(32, true),
    bits: dv.getUint16(34, true),
    dataBytes: dv.getUint32(40, true),
    samples: Array.from({ length: Math.floor(dv.getUint32(40, true) / 2) }, (_, i) => dv.getInt16(44 + i * 2, true)),
  }
}

await agroup('asr-audio base64 与容器准备', async () => {
  const abc = new Blob(['abc'], { type: 'audio/webm' })
  eq('blobToBase64 去掉 dataURL 前缀', await M.blobToBase64(abc), 'YWJj')
  const ab = await M.readBlobBuffer(abc)
  eq('readBlobBuffer 返回原始字节', [ab instanceof ArrayBuffer, ab.byteLength], [true, 3])

  const webm = await M.prepareAudioForAsr(abc, { actx: null, recMime: '' })
  eq('webm 直传：format=webm', webm && webm.format, 'webm')
  eq('webm 直传：字节不变', webm && Buffer.from(webm.base64, 'base64').toString('utf8'), 'abc')
  eq('空 blob → null', await M.prepareAudioForAsr(new Blob([], { type: 'audio/webm' }), { actx: null, recMime: '' }), null)

  const diag = []
  const mp4 = new Blob([new Uint8Array([9, 8, 7])], { type: 'audio/mp4' })
  const fallback = await M.prepareAudioForAsr(mp4, { actx: null, recMime: '', onDiag: (d) => diag.push(d) })
  eq('mp4 转不了 → 回落 webm 并按原字节传', fallback && fallback.format, 'webm')
  eq('mp4 转不了要留诊断', diag.map((d) => d.stage), ['mp4-no-transcode'])
  eq('mp4 回落字节不变', Buffer.from(fallback.base64, 'base64').toString('hex'), '090807')
})

await agroup('asr-audio mp4→WAV（回调式 / Promise 式）', async () => {
  // 旧 Safari：decodeAudioData(ab, ok, fail) 回调式，返回 undefined
  const ctxCb = {
    decodeAudioData(ab, okCb) {
      const ch0 = new Float32Array([1, 1])
      const ch1 = new Float32Array([0, 0])
      okCb({ numberOfChannels: 2, sampleRate: 48000, getChannelData: (i) => (i === 0 ? ch0 : ch1) })
    },
  }
  const wav2 = await M.transcodeToWav(new Blob([new Uint8Array(4)], { type: 'audio/mp4' }), ctxCb)
  ok('回调式 decodeAudioData 能转出 WAV', !!wav2 && wav2.type === 'audio/wav', '实际 ' + (wav2 && wav2.type))
  const wire2 = await M.blobToBase64(wav2)
  const w2 = wavInfo(wire2)
  eq('WAV 魔数', [w2.riff, w2.wave], ['RIFF', 'WAVE'])
  eq('WAV fmt/声道/位深', [w2.fmt, w2.channels, w2.bits], [1, 1, 16])
  eq('WAV 采样率/字节率/块对齐', [w2.sampleRate, w2.byteRate, w2.blockAlign], [48000, 96000, 2])
  eq('WAV data 长度 = 采样数 × 2', w2.dataBytes, 4)
  eq('双声道下混取平均（1 与 0 → 0.5 → 16384）', w2.samples, [16384, 16384])

  // Safari 14.1+：decodeAudioData 返回 Promise
  const ctxPromise = {
    decodeAudioData() {
      const ch = new Float32Array([1, -1])
      return Promise.resolve({ numberOfChannels: 1, sampleRate: 44100, getChannelData: () => ch })
    },
  }
  const wav1 = await M.transcodeToWav(new Blob([new Uint8Array(4)], { type: 'audio/mp4' }), ctxPromise)
  const w1 = wavInfo(await M.blobToBase64(wav1))
  eq('Promise 式 decodeAudioData 也能转', [w1.riff, w1.channels, w1.sampleRate, w1.dataBytes], ['RIFF', 1, 44100, 4])
  eq('满幅正负样本削顶正确', w1.samples, [32767, -32768])

  // 转出来的 WAV 超过上限 → 放弃转码（返回 null）
  eq('超过体积上限 → null', await M.transcodeToWav(new Blob([new Uint8Array(4)], { type: 'audio/mp4' }), ctxCb, 8), null)

  // prepareAudioForAsr 走完整链路：mp4 → wav
  const full = await M.prepareAudioForAsr(new Blob([new Uint8Array(4)], { type: 'audio/mp4' }),
    { actx: ctxCb, recMime: '', maxWavBytes: 1024 * 1024 })
  eq('mp4 成功转码后 format=wav', full && full.format, 'wav')
  eq('mp4 成功转码后是 RIFF 头', wavInfo(full.base64).riff, 'RIFF')
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
console.log('✅ 语音子模块纯逻辑回归全部通过')
process.exit(0)
