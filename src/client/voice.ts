/**
 * client/voice.ts —— 语音模块（从零重写，替代原来的 VAD + WebSpeech + 通道 + 朗读队列）
 *
 * 设计原则（每一条都是被之前的 bug 教育的）：
 *   ① 只有一个状态机：idle → listening → recognizing → thinking → speaking → idle
 *      状态转移只有一处在改，杜绝"标志卡住没人清"
 *   ② 录音不靠"判句"：固定 6 秒窗口，窗口结束就上传；
 *      只在"已检测到说话且安静 400ms"时提前收尾（把它当加速，不当必要条件）
 *   ③ 每段必带电平信息：整段峰值 < -50dBFS 直接丢，不浪费识别额度
 *   ④ 所有网络请求都有硬超时（ASR 15s / TTS 20s / 对话由调用方负责）
 *   ⑤ 朗读队列有看门狗：不依赖 onended 回调，按音频元素真实状态复位
 *   ⑥ 回声防护三层：TTS 期间物理闭麦 + 说完 700ms 静音窗 + 文本回声比对
 *   ⑦ 每个可能"静默失败"的地方都有计数（stats），出问题看数字就知道卡在哪
 */

import { Ape } from './ape.js'
import { deepFreeze } from '../shared/immutable.js'
import { narrationRate } from './rates.js'
import { isRepeat } from './sim.js'
import { echoKey, isShortEchoFragment, stripStageDirections } from './text.js'
import { isNoiseText } from '../shared/noise.js'
import { isPlaybackZombie } from './playback.js'
import { readEndpointMode, writeEndpointMode, normalizeEndpointMode } from './endpoint.js'
import {
  pickRecorderMime, formatFromMime, hostAsrFormat, downmixToMono, encodeWavPcm16, wavBytes,
  type RecFormat,
} from './audio-codec.js'
import { browserVoiceUsable, speakViaBrowser } from './browser-tts.js'

export type VoiceStatus = 'idle' | 'listening' | 'recognizing' | 'thinking' | 'speaking'

export type VoiceStats = {
  windows: number          // 录过多少段
  skippedSilent: number    // 因太安静被丢
  uploaded: number         // 上传次数
  asrFail: number          // 识别失败
  asrTexts: number         // 识别出文字的段数
  heard: number            // 通过过滤、真正交给上层的
  echoDropped: number      // 被回声/重复过滤掉
  shortDropped: number     // 刚朗读过、只听到 1~2 字碎片（回声残留）
  ttsRequests: number      // 朗读请求数
  ttsPlayed: number        // 真正开始播放
  ttsFail: number          // 合成/播放失败
  ttsZombie: number
  dupDropped?: number      // 因重复被丢掉的识别结果（防重复回答）
  lastError: string
}

export type VoiceOptions = {
  /** 识别到一句有效的话（已过滤回声/重复/黑名单） */
  onHeard: (text: string) => void
  /** 状态变化（用来显示「在听…/在想…/在说…」） */
  onStatus?: (s: VoiceStatus) => void
  /** 诊断信息（失败原因等） */
  onDiag?: (d: any) => void
  /** 接口前缀，默认 /api/chubby-whale */
  apiBase?: string
  /** 说话人音色 */
  voiceName?: string
  /** 每段真正开播时回调（用于气泡跟着显示"当前念到哪一句"） */
  onSegment?: (text: string) => void
}

export type Voice = {
  start: () => Promise<void>
  stop: () => void
  speaking: () => boolean
  recognizing: () => boolean
  /** strict：只走宿主 /tts，失败就安静（试听用，不回落浏览器 speechSynthesis） */
  speak: (text: string, opts?: { rate?: string; pitch?: string; narration?: boolean; strict?: boolean; onDone?: () => void }) => void
  stopSpeaking: () => void
  /** 立即换音色：下一个 /tts 请求就带新 voice，无需重建实例 */
  setVoiceName: (name: string) => void
  /** 当前音色（自检用） */
  voiceName: () => string
  /** 端点检测模式切换（菜单「端点检测」用） */
  setEndpointMode: (mode: 'ape' | 'classic') => void
  /** 当前实际生效的端点检测模式（不是写死的 classic） */
  endpointInfo: () => { mode: 'ape' | 'classic' }
  /** 上一段录音的诊断信息 */
  lastSegment: () => any
  /** 上一段朗读的诊断信息 */
  lastTtsInfo: () => any
  mute: (on: boolean) => void
  stats: VoiceStats
  status: () => VoiceStatus
}

// ---- 参数对齐 C# 版 tools/asr-listener.ps1（MaxMs=6000, SilenceMs=700, SilenceGate=600）----
// 参考仓库：https://gitee.com/adengou/linyu  →  tools/asr-listener.ps1
//   原始语义：连续采集 → 静音 700ms 判说完 → 最长 6000ms
//   丢弃条件：时长 < 400ms 或 峰值 < SilenceGate(600/32768 ≈ -34.7 dBFS)
const WINDOW_MS = 6000           // MaxMs
const EARLY_STOP_QUIET = 700     // SilenceMs
const MIN_SPEECH_MS = 400        // 原始：ms < 400 直接丢
const SILENT_PEAK_DB = -35       // SilenceGate 换算：20*log10(600/32768) ≈ -34.7
const ECHO_MUTE_MS = 700         // 朗读结束后继续静音的时间
const ASR_TIMEOUT_MS = 15000
const TTS_TIMEOUT_MS = 20000
const TTS_SEG_MAX = 90
// 叙述（说书/故事/诗歌）语速：可配置，默认 -25%（参考版默认 -15%，实测说书偏快）
           // 一段朗读最多多少字
const TTS_WATCH_MS = 1000        // 朗读看门狗间隔
const TTS_ZOMBIE_MS = 2500       // 这么久没在播就复位

// 噪声判定与宿主共用一份（shared/noise.ts），避免两边各写一套、缓存又把噪声写进去

/**
 * 可用的音色 —— 与菜单「换个声音 ▸」的列表一一对应，也是 /tts 请求前的白名单。
 * 'auto' 不在 edge-tts 的语音表里，但宿主 routes/tts.ts 认它：按文本语言自动选晓伊/Ana。
 * 列表外的一律回退默认晓伊：绝不把坏值（旧配置、手改 localStorage）送给 edge-tts。
 */
export const TTS_VOICES: string[] = [
  'zh-CN-XiaoyiNeural',
  'zh-CN-XiaoxiaoNeural',
  'zh-CN-XiaochenNeural',
  'zh-CN-YunxiNeural',
  'zh-CN-YunyangNeural',
  'en-US-AnaNeural',
  'en-US-JennyNeural',
  'en-GB-SoniaNeural',
  'auto',
]
deepFreeze(TTS_VOICES)

/** 默认音色：晓伊（与菜单默认与 C# 版一致） */
export const DEFAULT_VOICE = 'zh-CN-XiaoyiNeural'

/** 音色名规范化：白名单外（含空值/坏值）一律回退 */
export function normalizeVoiceName(name: unknown, fallback: string = DEFAULT_VOICE): string {
  const n = String(name == null ? '' : name).trim()
  return TTS_VOICES.indexOf(n) >= 0 ? n : fallback
}

/** 读菜单里选过的音色（localStorage）；读不到或非法 → 默认晓伊 */
export function readStoredVoiceName(): string {
  try { return normalizeVoiceName(localStorage.getItem('chubby-tts-voice')) } catch (e) { return DEFAULT_VOICE }
}

export function createVoice(opts: VoiceOptions): Voice {
  const apiBase = opts.apiBase || '/api/chubby-whale'
  // 音色：显式传入优先，其次菜单里存的（chubby-tts-voice），最后默认晓伊
  let voiceName = normalizeVoiceName(opts.voiceName || readStoredVoiceName())
  // 端点检测模式：ape（自适应，默认）/ classic（经典绝对阈值，可一键切回）
  // 默认 classic（经典绝对阈值）：实测 APE 在真实麦克风下会提前切句，前半句丢失。
  // 想试自适应可在菜单里切换，随时能切回来。
  let epMode: 'ape' | 'classic' = readEndpointMode()
  const ape = new Ape()
  let lastApe: any = null
  let lastSeg: any = null
  let lastTts: any = null

  const stats: VoiceStats = {
    windows: 0, skippedSilent: 0, uploaded: 0, asrFail: 0, asrTexts: 0, heard: 0,
    echoDropped: 0, shortDropped: 0, ttsRequests: 0, ttsPlayed: 0, ttsFail: 0, ttsZombie: 0, lastError: '',
  }

  // ---- 状态机 ----
  let status: VoiceStatus = 'idle'
  function setStatus(s: VoiceStatus): void {
    if (status === s) return
    status = s
    try { opts.onStatus && opts.onStatus(s) } catch (e) { }
  }

  // ---- 采集 ----
  let stream: MediaStream | null = null
  let actx: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let rec: MediaRecorder | null = null
  let timeBuf: Float32Array | null = null
  let byteBuf: Uint8Array | null = null   // getFloatTimeDomainData 缺失时（老 Safari）用它兜底
  let running = false
  // 录音编码：recMime 为空 = 不传 options（浏览器自选）；recFormat 是实际容器
  let recMime = ''
  let recFormat: RecFormat = 'webm'
  // 电平可用性：AudioContext 被自动播放策略挂起时，analyser 恒返回 0 → 静音判定会把每段都丢掉，
  // 表现是"开了麦克风但鱼永远听不见"。探测失败就关掉静音判定，改为按段长/体积兜底。
  let levelOk = false
  let levelDead = false
  let levelProbeAt = 0
  // 自动播放策略：suspended 时挂一次性手势，用户一碰页面就恢复
  let gestureHooks: { resume: () => void } | null = null
  // 识别没配 Key（NO_KEY）：本次语音会话内不再上传，避免每段窗口都白打一次请求
  let asrNoKey = false
  let muted = false

  // ---- 一段录音的状态 ----
  let parts: Blob[] = []
  let winPeak = -160
  let speechMs = 0
  let quietMs = 0
  let winStart = 0
  let tickTimer: any = null
  let restartTimer: any = null

  // ---- 过滤状态 ----
  let lastText = ''
  let lastTextAt = 0
  const spokenRecent: Array<{ text: string; at: number }> = []
  const recentHeard: Array<{ text: string; at: number }> = []

  // ---- 朗读 ----
type Job = { seq: number; text: string; rate: string; pitch?: string; narration: boolean; attempts: number; strict: boolean; onDone?: () => void }
  const ttsQ: Job[] = []
  let ttsBusy = false
  let ttsAudio: HTMLAudioElement | null = null
  let ttsBusySince = 0
  let ttsSynthAt = 0   // 本段开始合成的时刻（0 = 未在合成）；看门狗据此区分"合成中"与"僵死"
  let ttsProgressAt = 0  // 本段最近一次"有进展"的时刻（开播/播放进度/收到新 chunk）；看门狗按它判停滞
  let ttsCurJob: Job | null = null  // 当前正在处理的段：看门狗复位时要给它结账（回调 onDone）
  let ttsWatch: any = null
  let mutedUntil = 0
  let speakToken = 0

  /**
   * 当前电平（dBFS）。
   * · 优先 getFloatTimeDomainData（Chrome/Edge/Firefox、Safari 14.1+）；
   * · 老 Safari 只有 getByteTimeDomainData：8bit 中心值 128 → 近似 [-1,1]；
   * · 接口缺失或抛错一律返回 -160（静音），由 levelDead 决定要不要采信。
   */
  const level = () => {
    const an: any = analyser
    if (!an || !timeBuf) return -160
    let ok = false
    try {
      if (typeof an.getFloatTimeDomainData === 'function') {
        an.getFloatTimeDomainData(timeBuf as any)
        ok = true
      } else if (typeof an.getByteTimeDomainData === 'function') {
        if (!byteBuf || byteBuf.length !== timeBuf.length) byteBuf = new Uint8Array(timeBuf.length)
        an.getByteTimeDomainData(byteBuf as any)
        for (let i = 0; i < timeBuf.length; i++) timeBuf[i] = (byteBuf[i] - 128) / 128
        ok = true
      }
    } catch (e) { ok = false }
    if (!ok) return -160
    let sum = 0
    for (let i = 0; i < timeBuf.length; i++) sum += timeBuf[i] * timeBuf[i]
    const rms = Math.sqrt(sum / timeBuf.length)
    const db = 20 * Math.log10(rms + 1e-8)
    // 有真实读数就说明 analyser 在工作（哪怕此刻很安静，底噪也不会正好等于 -160）
    if (db > -159) levelOk = true
    return db
  }

  function micOn(on: boolean): void {
    try { if (stream) stream.getAudioTracks().forEach((t) => { t.enabled = on }) } catch (e) { }
  }

  /** 释放麦克风与 AudioContext：start 失败与 stop 共用 —— 绝不把录音灯留在亮着 */
  function releaseAudio(): void {
    try { if (rec && rec.state !== 'inactive') rec.stop() } catch (e) { }
    try { if (actx) actx.close() } catch (e) { }
    try { if (stream) stream.getTracks().forEach((t) => { t.stop() }) } catch (e) { }
    rec = null; actx = null; analyser = null; stream = null; timeBuf = null; byteBuf = null
  }

  function unhookGestureResume(): void {
    const g = gestureHooks
    if (!g) return
    gestureHooks = null
    try { window.removeEventListener('pointerdown', g.resume, true) } catch (e) { }
    try { window.removeEventListener('touchstart', g.resume, true) } catch (e) { }
    try { window.removeEventListener('keydown', g.resume, true) } catch (e) { }
  }

  /**
   * 自动播放策略：没有用户手势时新建的 AudioContext 常是 suspended（Safari 最严格）。
   * suspended 下 AnalyserNode 不出数，电平恒静音 → 静音判定会把每段都丢掉。
   * 挂一次性手势：一碰页面就恢复（并重新开始电平探活）。
   */
  function hookGestureResume(): void {
    if (gestureHooks) return
    const resume = (): void => {
      try {
        const c: any = actx
        if (c && c.state === 'suspended') c.resume()
        if (c && c.state !== 'suspended') { levelDead = false; levelOk = false; levelProbeAt = performance.now() }
      } catch (e) { }
      unhookGestureResume()
    }
    gestureHooks = { resume }
    try {
      window.addEventListener('pointerdown', resume, true)
      window.addEventListener('touchstart', resume, true)
      window.addEventListener('keydown', resume, true)
    } catch (e) { }
  }

  function scheduleNext(ms: number): void {
    if (!running) return
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = setTimeout(() => { restartTimer = null; beginWindow() }, ms)
  }

  function beginWindow(): void {
    if (!running || !rec) return
    try {
      if (rec.state !== 'inactive') { try { rec.stop() } catch (e) { } scheduleNext(200); return }
      parts = []
      winPeak = -160
      speechMs = 0
      quietMs = 0
      winStart = performance.now()
      ape.resetSegment()
      lastApe = null
      rec.start()
      scheduleNext(0)  // 占位：下面立刻换成 tick 循环
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null }
      tick()
    } catch (e: any) {
      stats.lastError = 'beginWindow: ' + String(e && e.name)
      scheduleNext(1000)
    }
  }

  function tick(): void {
    if (!running || !rec || rec.state !== 'recording') return
    try {
      const db = level()
      // 探活：启动后 1.2 秒还读不到任何电平 → analyser 没在工作（典型是 AudioContext 被自动播放策略挂起）。
      // 此时绝不能继续按电平判静音，否则每段都被当"太安静"丢掉，表现就是"Safari 上开了麦却永远听不见"。
      if (!levelOk && !levelDead && levelProbeAt && performance.now() - levelProbeAt > 1200) {
        levelDead = true
        try { opts.onDiag && opts.onDiag({ stage: 'analyser-dead', hint: '电平不可用，静音判定已降级（改按段长/体积）' }) } catch (e) { }
      }
      if (epMode === 'ape') {
        // APE 路径：判定全部交给 client/ape.ts（已用 10 个合成场景单测）
        const st = ape.step(db)
        lastApe = st
        if (db > winPeak) winPeak = db
        if (st.commit && rec && rec.state === 'recording') {
          try { rec.stop() } catch (e) { }
          try { opts.onDiag && opts.onDiag({ stage: 'window-end', why: st.commitReason, floor: Math.round(st.floorDb) }) } catch (e) { }
          return
        }
        // 电平不可用：APE 会一直判"静音"、永不提交（它会静默重置窗口继续录）。
        // 这里按窗口上限强制收尾，交给 onWindowDone 的体积/时长兜底。
        if (levelDead && performance.now() - winStart >= WINDOW_MS) {
          try { rec.stop() } catch (e) { }
          try { opts.onDiag && opts.onDiag({ stage: 'window-end', why: 'no-level' }) } catch (e) { }
          return
        }
        tickTimer = setTimeout(tick, 60)
        return
      }
      if (db > winPeak) winPeak = db
      const now = performance.now()
      const elapsed = now - winStart
      if (db > (muted ? 0 : -45)) { speechMs += 60; quietMs = 0 } else { quietMs += 60 }
      const earlyStop = speechMs >= MIN_SPEECH_MS && quietMs >= EARLY_STOP_QUIET
      const tooLong = elapsed >= WINDOW_MS
      if (earlyStop || tooLong) {
        try { rec.stop() } catch (e) { }
        try { opts.onDiag && opts.onDiag({ stage: 'window-end', why: earlyStop ? 'quiet' : 'timeout', peak: Math.round(winPeak), speechMs }) } catch (e) { }
        return   // onstop 里继续
      }
      tickTimer = setTimeout(tick, 60)
    } catch (e: any) {
      stats.lastError = 'tick: ' + String(e && e.name)
      tickTimer = setTimeout(tick, 120)
    }
  }

  async function onWindowDone(blob: Blob): Promise<void> {
    // 已停止（关语音待命/卸载）：这段不能再上传，也不能把状态从 idle 回写成
    // recognizing/listening —— 那正是"关了还在听"的来源。
    if (!running) return
    // 已知没配识别 Key：直接跳过，不再上传（否则每句话都白打一次请求）
    if (asrNoKey) { stats.skippedSilent++; scheduleNext(150); return }
    stats.windows++
    // 太安静：直接丢（识别服务对静音会编词，浪费钱还制造幻觉）
    // levelDead（analyser 不可用）时没有可信电平，跳过静音判定，只按体积/回声窗兜底。
    if (!levelDead) {
      if (epMode === 'ape') {
        const okSpeech = !!(lastApe && lastApe.hadSpeech && lastApe.speechMs >= 150)
        if (!okSpeech) { stats.skippedSilent++; scheduleNext(150); return }
      } else if (winPeak < SILENT_PEAK_DB) { stats.skippedSilent++; scheduleNext(150); return }
    }
    if (Date.now() < mutedUntil) { stats.skippedSilent++; scheduleNext(150); return }
    if (blob.size < 1200) { stats.skippedSilent++; scheduleNext(150); return }

    stats.uploaded++
    setStatus('recognizing')
    try {
      // 编码协商 + Safari 的 mp4→WAV：上传前的容器转换都在这里（client/audio-codec.ts 提供纯函数）
      const wire = await prepareAudioForAsr(blob)
      if (!wire || !wire.base64) { stats.asrFail++; stats.lastError = 'b64-empty'; return }
      const asrCtl = typeof AbortController !== 'undefined' ? new AbortController() : null
      if (asrCtl) asrAborts.add(asrCtl)
      let res: Response
      try {
        res = await fetchWithTimeout(apiBase + '/asr', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // format 必须带实际值：宿主按它决定 multipart 的 filename/Content-Type。
          // 白名单是 webm/wav/mp3（src/host/routes/asr.ts），mp4 不在其中 → hostAsrFormat 已回落成 webm。
          body: JSON.stringify({ audio: wire.base64, format: wire.format }),
        }, ASR_TIMEOUT_MS, asrCtl ? asrCtl.signal : undefined)
      } finally {
        if (asrCtl) asrAborts.delete(asrCtl)
      }
      const data = await res.json()
      // 请求期间可能已经关掉语音待命/卸载：这时候不能再把结果当主人说话
      if (!running) return
      // 没配识别 Key：记一次、通知上层给一句提示，本次会话内不再重试
      if (data && data.error === 'NO_KEY') {
        stats.asrFail++
        stats.lastError = 'asr: NO_KEY'
        asrNoKey = true
        try { opts.onDiag && opts.onDiag({ stage: 'asr-no-key', hint: String(data.hint || '') }) } catch (e) { }
        return
      }
      if (!data || !data.ok) { stats.asrFail++; stats.lastError = 'asr: ' + String((data && data.error) || 'failed'); return }
      try { lastSeg = { mode: epMode, fmt: wire.format, winMs: Math.round(performance.now() - winStart), peMs: lastApe ? lastApe.speechMs : speechMs, quMs: lastApe ? lastApe.quietMs : quietMs, floor: lastApe ? Math.round(lastApe.floorDb) : null, target: lastApe ? lastApe.quietTargetMs : null, text: String(data.text || "").slice(0, 24) } } catch (e) { }
      const text = String(data.text || '').trim()
      if (!text) return
      stats.asrTexts++
      if (acceptText(text)) {
        stats.heard++
        setStatus('thinking')
        try { opts.onHeard(text) } catch (e) { }
      } else {
        stats.echoDropped++
      }
    } catch (e: any) {
      stats.asrFail++
      stats.lastError = 'asr-ex: ' + String((e && e.name) || e)
    } finally {
      if (status === 'recognizing') setStatus('listening')
      // 只有录音器空闲时才排下一段：否则会打断正在录的段（会丢开头几个字）
      if (!rec || rec.state === "inactive") scheduleNext(150)
    }
  }

  /** 过滤：静音噪声 / 自身回声 / 短时间重复 */
  function acceptText(text: string): boolean {
    const plain = text.replace(/[\s。，！？,.!?、…~～]/g, '')
    const plainKey = echoKey(text)
    // 单字放行白名单：主人喊「停！」也要能打断说书/朗读
    if (plain.length < 2 && !/^[停别不]$/.test(plain)) return false
    if (isNoiseText(plain)) return false
    if (/^本鱼在听/.test(plain)) return false
    // 自己刚说过的话（回声）
    const now = Date.now()
    let hadRecentSpeech = false
    for (const s of spokenRecent) {
      if (now - s.at > 15000) continue
      if (now - s.at <= 8000) hadRecentSpeech = true
      const target = s.text.replace(/[\s。，！？,.!?、…~～]/g, '')
      if (!target) continue
      // 去掉动作描写后的比对（专治"星号"回声）
      const targetKey = echoKey(s.text)
      if (plainKey && targetKey && (plainKey === targetKey || (targetKey.length >= 6 && plainKey.indexOf(targetKey.slice(0, 6)) >= 0))) {
        try { stats.echoDropped++ } catch (e) { }
        return false
      }
      if (plain === target) return false
      if (target.length >= 6 && plain.indexOf(target.slice(0, 6)) >= 0) return false
      if (plain.length >= 6 && target.indexOf(plain.slice(0, 6)) >= 0) return false
      // 短词回声：主人说 "master"，本鲸回复里也含 master，麦克风会把它听回去 → 就变成"说两遍"
      if (plain.length >= 3 && now - s.at < 6000 && target.indexOf(plain) >= 0) { try { stats.echoDropped++ } catch (e) { } ; return false }
    }
    // 刚朗读过又只听到 1~2 字 → 大概率是自己的回声碎片（实测「的歪」这类会被当成主人发言）
    if (isShortEchoFragment(plain, hadRecentSpeech)) {
      try { stats.shortDropped = (stats.shortDropped || 0) + 1 } catch (e) { }
      return false
    }
    // 去重统一走 client/sim.ts 的相似度算法（bigram Jaccard）：
    // 窗口 8 秒、阈值 0.90 —— 只挡"刚说过的同一句被切成两段"，主人隔一会儿再说不会被吞。
    if (isRepeat(plain, { recent: recentHeard, windowMs: 8000, threshold: 0.9, minLen: 4, now })) {
      try { stats.dupDropped = (stats.dupDropped || 0) + 1 } catch (e) { }
      return false
    }
    recentHeard.push({ text, at: now })
    while (recentHeard.length > 3) recentHeard.shift()
    if (text === lastText && now - lastTextAt < 8000) return false
    lastText = text
    lastTextAt = now
    return true
  }

  function noteSpoken(text: string): void {
    const t = String(text || '').trim()
    if (!t) return
    spokenRecent.push({ text: t, at: Date.now() })
    while (spokenRecent.length > 12) spokenRecent.shift()
  }

  // ---- 朗读 ----
  function ttsWatchdog(): void {
    try {
      const audioPlaying = !!(ttsAudio && !ttsAudio.paused && !ttsAudio.ended && ttsAudio.readyState > 0)
      // 判定抽到 client/playback.ts（纯函数，npm test 覆盖）：
      // 关键——合成中（实测 3~4 秒）不能被当成僵死，否则前几段会被丢弃，
      // 表现就是念长诗「从第三句开始」。
      const zombie = isPlaybackZombie({
        hasAudio: !!ttsAudio,
        audioPlaying,
        busy: ttsBusy,
        busySince: ttsBusySince,
        // 停滞按"最后一次有进展"算：长段播到一半卡住时，段开始时刻早就过阈值了，
        // 还用 busySince 会一上来就误判；播放进度、缓冲、开播都算有新进展。
        lastProgressAt: ttsProgressAt,
        synthAt: ttsSynthAt,
        now: Date.now(),
        zombieMs: TTS_ZOMBIE_MS,
        synthTimeoutMs: TTS_TIMEOUT_MS,
      })
      if (!zombie) return
      // 真僵死：有音频却不动，或合成超时 → 复位，继续下一段
      // 复位必须把"被丢弃那一段"的账结清：① 上层在等 onDone（说书/念诗锁）会永远卡住；
      // ② pumpTts 开播前闭了麦，不恢复就再也听不见（整只鱼变聋）。
      stats.ttsZombie++
      const dead = ttsCurJob
      ttsCurJob = null
      // 令牌作废：在途的合成回调/play 回调回来时被 token 校验拦住，不会把这一段又开播一遍
      speakToken++
      try { if (ttsAudio) { ttsAudio.pause(); ttsAudio.onended = null; ttsAudio.onerror = null } } catch (e) { }
      ttsAudio = null
      ttsSynthAt = 0
      ttsProgressAt = 0
      ttsBusy = false
      // 先开麦：队列空时 pumpTts 只会切回 listening，不会恢复麦克风
      mutedUntil = Date.now() + ECHO_MUTE_MS
      micOn(!muted)
      if (dead) {
        // 走 finishJob：它负责复位 busy、设回声静音窗、回调 onDone（解开上层锁），
        // 队列还有下一段时顺带接着 pump
        try { finishJob(dead) } catch (e) { }
      } else {
        pumpTts()
      }
      // 兜底：队列空时无论如何都要让麦克风最终是开的（可能被别的路径又关掉）
      if (!ttsBusy && ttsQ.length === 0) {
        setTimeout(() => { try { if (!ttsBusy && !muted) micOn(true) } catch (e) { } }, ECHO_MUTE_MS)
      }
    } catch (e) { }
  }

  const ttsPrefetch = new Map<number, Promise<ArrayBuffer | null>>()
/** 在途的合成请求：停止说话时一起 abort（服务器那边也会跟着断，不再白算一整段） */
const ttsAborts = new Set<AbortController>()
/** 在途的识别请求：关语音待命/卸载时取消（否则关了还会"听到"并回话） */
const asrAborts = new Set<AbortController>()
  let ttsSeq = 0

  // 合成一段（带超时）。失败返回 null —— 对应 C# 的 wav == null
  function synth(job: Job): Promise<ArrayBuffer | null> {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null
    if (ctl) ttsAborts.add(ctl)
    return fetchWithTimeout(apiBase + '/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: job.text, voice: voiceName, rate: job.rate, pitch: job.pitch || '' }),
    }, TTS_TIMEOUT_MS, ctl ? ctl.signal : undefined).then((r) => {
      if (!r.ok) throw new Error('tts-http-' + r.status)
      return r.arrayBuffer()
    }).catch((e: any) => {
      stats.lastError = 'tts: ' + String((e && e.name) || e)
      return null
    }).finally(() => {
      if (ctl) ttsAborts.delete(ctl)
    })
  }

  // 系统语音兜底的三家差异（voices 异步 / onend 不触发 / cancel 后被吞）
  // 全部收进 client/browser-tts.ts，这里只用它导出的两个接口：
  //   browserVoiceUsable() —— 是否值得一试
  //   speakViaBrowser()    —— 念一段，Promise 永远 resolve（内部看门狗）

  /**
   * 自适应停顿：照真人换气节奏给不同标点不同停顿
   *   。！？ → 260ms（一句结束，标准值照参考实现）
   *   ，、； → 140ms（句内小停顿，别拖）
   *   其他   → 200ms（没标点时取中）
   */
  function narrationPauseFor(text: string): number {
    const t = String(text || '').trim()
    if (!t) return 200
    const last = t.slice(-1)
    if (/[。！？!?…]/.test(last)) return 260
    if (/[，、；,;]/.test(last)) return 140
    return 200
  }

  function finishJob(j: Job): void {
    ttsBusy = false
    if (ttsCurJob === j) ttsCurJob = null
    ttsProgressAt = 0
    mutedUntil = Date.now() + ECHO_MUTE_MS
    setTimeout(() => { if (!ttsBusy && !muted) micOn(true) }, ECHO_MUTE_MS)
    try { j.onDone && j.onDone() } catch (e) { }
    // 叙述模式：段间 260ms 换气停顿（C# NarrationPauseMs）
    if (j.narration && ttsQ.length > 0) setTimeout(() => pumpTts(), narrationPauseFor(j.text))
    else pumpTts()
  }

  function pumpTts(): void {
    if (ttsBusy) return
    const job = ttsQ.shift()
    if (!job) { setStatus('listening'); return }
    ttsBusy = true
    ttsBusySince = Date.now()
    ttsProgressAt = Date.now()
    ttsCurJob = job
    const myToken = ++speakToken
    setStatus('speaking')
    // 不在合成开始时就闭麦：合成要 3~4 秒，提前闭麦会让主人这几秒说的话全丢；
    // 真正闭麦放到「开播前」（见下面 a.play() 之前），重试等待期间也保持开麦
    // （自身回声由 acceptText 的 spokenRecent 比对 + 说完后的静音窗兜住）。
    stats.ttsRequests++

    const cur = ttsPrefetch.get(job.seq) || synth(job)
    ttsSynthAt = Date.now()
    ttsPrefetch.delete(job.seq)
    // 当前段开播前就把下一段合成压上去（C# 的 prefetch）
    const next = ttsQ[0]
    if (next && !ttsPrefetch.has(next.seq)) ttsPrefetch.set(next.seq, synth(next))
    // 叙述（念诗/说书）句子短、段间停顿明显：再多预取一段，减少"等合成"的空档。
    // 普通聊天首段短、后面长，只预取一段就够，避免把 worker 队列塞满。
    const next2 = ttsQ[1]
    if (job.narration && next2 && !ttsPrefetch.has(next2.seq)) ttsPrefetch.set(next2.seq, synth(next2))

    cur.then((buf) => {
      // 令牌校验必须放最前：这一段如果已被 stopSpeaking / 看门狗作废，
      // 回调再去改 ttsBusy / ttsSynthAt 就会把"新段"的状态一起清掉，
      // 新段要么立刻被判僵尸，要么被旧段顶掉重播。
      if (myToken !== speakToken) return
      ttsSynthAt = 0
      if (!buf) {
        // 失败：最多重试 3 次（每次间隔递增）。绝不静默跳过——跳过就是'少内容'。
        if (job.attempts < 3) {
          job.attempts++
          ttsQ.unshift(job)
          ttsBusy = false
          const backoff = 300 * job.attempts
          try { (window as any).__chubbyWhale.ttsRetry = ((window as any).__chubbyWhale.ttsRetry || 0) + 1 } catch (e) { }
          setTimeout(() => { try { pumpTts() } catch (e) { } }, backoff)
          return
        }
        stats.ttsFail++
        try { lastTts = { failed: true, text: job.text.slice(0, 20), at: Date.now() } } catch (e) { }
        try {
          const w: any = (window as any).__chubbyWhale
          w.ttsLost = w.ttsLost || []
          w.ttsLost.push(job.text.slice(0, 16))
          if (w.ttsLost.length > 10) w.ttsLost.shift()
        } catch (e) { }
        // 系统语音兜底：只有真的有可用语音时才用（没语音就当场静音，等于丢内容）
        // 试听（strict）不兜底：否则换了音色听起来还是系统音，等于没接线
        const canBrowser = !job.strict && browserVoiceUsable()
        if (canBrowser) speakViaBrowser(job.text).then(() => finishJob(job))
        else finishJob(job)
        return
      }
      try { opts.onSegment && opts.onSegment(job.text) } catch (e) { }
      const url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }))
      const a = new Audio(url)
      ttsAudio = a
      ttsProgressAt = Date.now()
      // 播放进度/缓冲/开播都算"有进展"：长段播到一半卡死时，看门狗才等到真正停滞再复位，
      // 而不是按段开始时刻一刀切。
      const bump = () => { ttsProgressAt = Date.now() }
      try { a.onplaying = bump; a.ontimeupdate = bump; a.onprogress = bump; a.onloadeddata = bump } catch (e) { }
      const finish = () => {
        if (myToken !== speakToken) { try { URL.revokeObjectURL(url) } catch (e) { } return }
        try { a.onended = null; a.onerror = null } catch (e) { }
        try { URL.revokeObjectURL(url) } catch (e) { }
        ttsAudio = null
        stats.ttsPlayed++
        try { lastTts = { failed: false, text: job.text.slice(0, 20), at: Date.now() } } catch (e) { }
        finishJob(job)
      }
      a.onended = finish
      a.onerror = finish
      // 开播前才闭麦：合成期间麦克风保持开（主人插话能听到），播放结束 finishJob 里 700ms 后恢复
      micOn(false)
      a.play().catch(() => {
        // 令牌校验：过期段只收回自己的 objectURL，绝不能清掉新段的 ttsAudio，
        // 也不能把旧 job unshift 回去（那会变成"新段播一半被旧段顶掉重播"）
        if (myToken !== speakToken) { try { URL.revokeObjectURL(url) } catch (e) { } ; return }
        // 播放没起来：先恢复麦克风再重试，别让麦一直关着（重试等待期间要能听见主人）
        if (!muted) micOn(true)
        stats.ttsFail++
        try { lastTts = { failed: true, text: job.text.slice(0, 20), at: Date.now() } } catch (e) { }
        try { a.onended = null; a.onerror = null; URL.revokeObjectURL(url) } catch (e) { }
        ttsAudio = null
        // 播放被拒绝：先重试一次（换新音频元素），仍不行才用系统语音；没语音说明当场静音，记为丢失
        if (job.attempts < 1) {
          job.attempts++
          ttsQ.unshift(job)
          ttsBusy = false
          setTimeout(() => { try { pumpTts() } catch (e) { } }, 250)
          return
        }
        const canBrowser2 = !job.strict && browserVoiceUsable()
        if (canBrowser2) speakViaBrowser(job.text).then(() => finishJob(job))
        else finishJob(job)
      })
    })
  }

  /** 1:1 移植 C# TextTools.SplitForTts：首段 ≤14 字；边界字符需距上一切点 ≥ cap/3 */
  function splitForTts(text: string, maxLen = 56): string[] {
    const out: string[] = []
    const src = String(text || '')
    if (!src.trim()) return out
    if (maxLen < 8) maxLen = 8
    const firstMax = Math.min(maxLen, 14)
    let sbuf = ''
    for (const c of src) {
      sbuf += c
      const boundary = /[。，！？!?；;、,\n]/.test(c)
      const cap = out.length === 0 ? firstMax : maxLen
      if (sbuf.length >= cap || (boundary && sbuf.length >= Math.max(8, Math.floor(cap / 3)))) {
        const seg = sbuf.trim()
        if (seg) out.push(seg)
        sbuf = ''
      }
    }
    const rest = sbuf.trim()
    if (rest) out.push(rest)
    return out
  }

  // ---- 上传前的容器准备（Safari 兼容的关键一段）----
  /** Blob → ArrayBuffer；用 FileReader（Blob.arrayBuffer() 在老 Safari 上没有） */
  function readBlobBuffer(blob: Blob): Promise<ArrayBuffer | null> {
    return new Promise((resolve) => {
      try {
        const fr = new FileReader()
        fr.onload = () => resolve((fr.result as ArrayBuffer) || null)
        fr.onerror = () => resolve(null)
        fr.readAsArrayBuffer(blob)
      } catch (e) { resolve(null) }
    })
  }

  /**
   * mp4 → 16bit 单声道 WAV。
   * 只用于"Safari 只能录 mp4"这一种情况：宿主白名单不含 mp4（webm/wav/mp3），转 wav 才稳。
   * decodeAudioData 在旧 Safari 只有回调式（Promise 式 14.1 才有），两种都接；
   * 3 秒没回调就当失败 → 回退原字节，绝不让转码把识别卡死。
   */
  function transcodeToWav(blob: Blob): Promise<Blob | null> {
    return new Promise((resolve) => {
      const ctx: any = actx
      if (!ctx || typeof ctx.decodeAudioData !== 'function') { resolve(null); return }
      let settled = false
      const done = (wav: Blob | null) => { if (settled) return; settled = true; resolve(wav) }
      const finish = (buf: any) => {
        try {
          if (!buf || !buf.numberOfChannels) { done(null); return }
          const chans: Float32Array[] = []
          const n = Math.min(2, Number(buf.numberOfChannels) || 1)
          for (let i = 0; i < n; i++) chans.push(buf.getChannelData(i))
          const mono = downmixToMono(chans)
          // 宿主解码后上限 8MB：转出来超 6MB 就别传了，按原字节回退
          if (wavBytes(mono.length / (Number(buf.sampleRate) || 48000), buf.sampleRate) > 6 * 1024 * 1024) { done(null); return }
          done(new Blob([encodeWavPcm16(mono, buf.sampleRate)], { type: 'audio/wav' }))
        } catch (e) { done(null) }
      }
      readBlobBuffer(blob).then((ab) => {
        if (!ab) { done(null); return }
        try {
          const ret: any = ctx.decodeAudioData(ab, finish, () => done(null))
          if (ret && typeof ret.then === 'function') ret.then(finish).catch(() => done(null))
        } catch (e) { done(null) }
      })
      setTimeout(() => done(null), 3000)
    })
  }

  /**
   * 上传前准备：确定实际容器；mp4 先转 WAV，转不动就按原字节走。
   * 返回的 format 一定是宿主认识的值（webm/wav/mp3）。
   */
  async function prepareAudioForAsr(blob: Blob): Promise<{ base64: string; format: 'webm' | 'wav' | 'mp3' } | null> {
    let src: Blob = blob
    let fmt: RecFormat = formatFromMime(blob.type || recMime)
    if (fmt === 'mp4') {
      const wav = await transcodeToWav(blob)
      if (wav) { src = wav; fmt = 'wav' } else {
        try { opts.onDiag && opts.onDiag({ stage: 'mp4-no-transcode', hint: 'mp4 没能转成 wav，按原字节上传' }) } catch (e) { }
      }
    }
    const b64 = await blobToBase64(src)
    if (!b64) return null
    return { base64: b64, format: hostAsrFormat(fmt) }
  }

  async function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve) => {
      try {
        const fr = new FileReader()
        fr.onloadend = () => {
          const s = String(fr.result || '')
          resolve(s.indexOf(',') >= 0 ? s.slice(s.indexOf(',') + 1) : s)
        }
        fr.readAsDataURL(blob)
      } catch (e) { resolve('') }
    })
  }

  async function fetchWithTimeout(url: string, init: RequestInit, ms: number, outer?: AbortSignal): Promise<Response> {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = ctl ? setTimeout(() => { try { ctl.abort() } catch (e) { } }, ms) : null
    // 外部 signal（停止说话）与超时任何一个触发都要中断请求
    let sig: AbortSignal | undefined = ctl ? ctl.signal : undefined
    if (outer) {
      try {
        sig = (ctl && typeof (AbortSignal as any).any === 'function')
          ? (AbortSignal as any).any([ctl.signal, outer])
          : (outer || ctl.signal)
      } catch (e) { sig = outer || sig }
    }
    try {
      return await fetch(url, sig ? { ...init, signal: sig } : init)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  // ---- 对外接口 ----
  async function start(): Promise<void> {
    asrNoKey = false   // 重新开语音会话就再试一次（主人可能刚配好 Key）
    if (running) return
    running = true
    recMime = ''
    recFormat = 'webm'
    levelOk = false
    levelDead = false
    try {
      // 非安全上下文（http + 内网 IP）下 Chrome/Safari 都没有 mediaDevices：
      // 这属于常见部署形态，给一条能看懂的诊断，别只留一个 "TypeError"。
      const nav: any = typeof navigator !== 'undefined' ? navigator : null
      if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== 'function') {
        throw { name: 'NoGetUserMedia' }
      }
      stream = await nav.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      })
      if (!running) { releaseAudio(); return }
      // Safari 用 webkitAudioContext；两个都没有就别硬走
      const Ctx: any = (window as any).AudioContext || (window as any).webkitAudioContext
      if (!Ctx) throw { name: 'NoAudioContext' }
      actx = new Ctx()
      // 自动播放策略：resume 一次；仍 suspended 就等用户手势（见 hookGestureResume）
      try { await (actx as any).resume() } catch (e) { }
      try { if ((actx as any).state === 'suspended') hookGestureResume() } catch (e) { }
      const srcNode: any = (actx as any).createMediaStreamSource(stream)
      analyser = (actx as any).createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0
      timeBuf = new Float32Array(analyser.fftSize || 1024)
      try { srcNode.connect(analyser) } catch (e) { }
      levelProbeAt = performance.now()
      // 老 Safari（< 14.1）没有 MediaRecorder：明确诊断并放掉麦克风，不要装作在听
      const Rec: any = typeof MediaRecorder !== 'undefined' ? MediaRecorder : null
      if (!Rec) throw { name: 'NoMediaRecorder' }
      // 编码协商：Chrome/Edge/Firefox → webm(opus)；Safari → audio/mp4（后面转 wav 再传）
      const picked = pickRecorderMime(Rec)
      recMime = picked.mimeType
      recFormat = picked.format
      try {
        rec = recMime ? new Rec(stream, { mimeType: recMime }) : new Rec(stream)
      } catch (e) {
        // isTypeSupported 说支持、构造时却挑食的浏览器：退回不指定 mimeType，保证还能录
        rec = new Rec(stream)
        recMime = ''
        recFormat = 'webm'
      }
      try { opts.onDiag && opts.onDiag({ stage: 'recorder', mime: recMime || '(default)', fmt: recFormat }) } catch (e) { }
      rec.ondataavailable = (e: BlobEvent) => { if (e.data && e.data.size > 0) parts.push(e.data) }
      rec.onstop = () => {
        // 已经 stop() 了：这段残响不能再走识别（哪怕录音器自己又 stop 了一次）
        if (!running) { parts = []; return }
        // blob 的 type 用录音器实际报的 mime（Safari 这里是 audio/mp4），绝不写死 webm：
        // 写死会让后面的 format 归类拿到错误容器，Safari 的 mp4 就永远走不到转 wav 那条路。
        const blobType = String((rec && (rec as any).mimeType) || recMime || 'audio/webm')
        const blob = new Blob(parts, { type: blobType })
        parts = []
        void onWindowDone(blob)
      }
      rec.onerror = (e: any) => { stats.lastError = 'recorder: ' + String(e && e.error && e.error.name) ; scheduleNext(800) }
      micOn(true)
      setStatus('listening')
      beginWindow()
      // 朗读看门狗：不依赖任何回调，按音频元素真实状态判断
      if (ttsWatch) clearInterval(ttsWatch)
      ttsWatch = setInterval(ttsWatchdog, TTS_WATCH_MS)
      stats.lastError = ''
    } catch (e: any) {
      running = false
      stats.lastError = 'start: ' + String((e && e.name) || e)
      setStatus('idle')
      // 失败也把麦克风/AudioContext 收掉：否则标签页一直亮录音灯（用户会以为在偷听）
      try { unhookGestureResume() } catch (e2) { }
      try { releaseAudio() } catch (e2) { }
      try { opts.onDiag && opts.onDiag({ stage: 'start-failed', err: stats.lastError }) } catch (e2) { }
    }
  }

  function stop(): void {
    running = false
    // 在途识别请求一并取消：关掉之后不能再"听到"并回话
    try { for (const c of asrAborts) { try { c.abort() } catch (e) { } } } catch (e) { }
    try { asrAborts.clear() } catch (e) { }
    if (tickTimer) { clearTimeout(tickTimer); tickTimer = null }
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null }
    if (ttsWatch) { clearInterval(ttsWatch); ttsWatch = null }
    // 朗读侧一起收：原来只停录音，说书/回复还在播、队列还留着，
    // 结果是"关了语音待命，声音没停、麦克风还被静音"，点菜单也不对。
    try { stopSpeaking() } catch (e) { }
    try { unhookGestureResume() } catch (e) { }
    levelProbeAt = 0
    levelOk = false
    levelDead = false
    try { releaseAudio() } catch (e) { }
    setStatus('idle')
  }

  function speak(text: string, o?: { rate?: string; pitch?: string; narration?: boolean; strict?: boolean; onDone?: () => void }): void {
    // 先剥掉动作描写（人设的 *…* 不该进语音通道）
    const raw = stripStageDirections(String(text || ''))
    if (!raw) return
    // 叙述判定照 C#：≥80 字算长文/典故/诗词 → 降速 -15%，段间 260ms 换气
    const narration = o && typeof o.narration === 'boolean' ? o.narration : raw.length >= 80
    const rate = (o && o.rate) ? o.rate : (narration ? narrationRate() : '+0%')
    const strict = !!(o && o.strict)
    const segs = splitForTts(raw, 56)
    if (!segs.length) return
    noteSpoken(raw)
    for (let i = 0; i < segs.length; i++) {
      ttsQ.push({
        seq: ++ttsSeq,
        text: segs[i],
        rate,
        narration,
        attempts: 0,
        strict,
        onDone: i === segs.length - 1 ? (o && o.onDone) : undefined,
      })
    }
    pumpTts()
  }

  function stopSpeaking(): void {
    ttsSynthAt = 0
    ttsProgressAt = 0
    ttsCurJob = null
    speakToken++
    ttsQ.length = 0
    // 预合成也算旧队列的一部分：不清掉的话，stop 之后开新段会捡起上一轮的音频，
    // 表现是"刚停止就冒出一句旧的"
    try { ttsPrefetch.clear() } catch (e) { }
    // 在途的合成请求也取消：否则停止后服务器还在算，结果也没人要
    try { for (const c of ttsAborts) { try { c.abort() } catch (e) { } } } catch (e) { }
    try { ttsAborts.clear() } catch (e) { }
    try { if (ttsAudio) { ttsAudio.pause(); ttsAudio.onended = null; ttsAudio.onerror = null } } catch (e) { }
    ttsAudio = null
    ttsBusy = false
    // 系统语音兜底可能还在念：一起取消（Safari/Firefox 都支持 cancel）
    try { const s: any = (window as any).speechSynthesis; if (s && typeof s.cancel === 'function') s.cancel() } catch (e) { }
    if (!muted) micOn(true)
    mutedUntil = Date.now() + ECHO_MUTE_MS
    setStatus('listening')
  }

  return {
    start,
    stop,
    speak,
    stopSpeaking,
    speaking: () => ttsBusy,
    recognizing: () => status === 'recognizing',
    setEndpointMode: (m: 'ape' | 'classic') => { epMode = normalizeEndpointMode(m); writeEndpointMode(epMode) },
    // 端点检测：报告当前实际生效的模式（ape / classic），不再写死 classic
    endpointInfo: () => ({ mode: epMode }),
    lastSegment: () => lastSeg,
    lastTtsInfo: () => lastTts,
    // 立即换音色：下一个 /tts 请求就带新 voice（不重建实例）；白名单外的值不改
    setVoiceName: (n: string) => { voiceName = normalizeVoiceName(n, voiceName) },
    voiceName: () => voiceName,
    mute: (on: boolean) => { muted = on; micOn(!on) },
    stats,
    status: () => status,
  }
}
