/**
 * client/voice.ts —— 语音编排层（麦克风采集 → VAD 端点 → 录音编码 → ASR → 回声过滤 → TTS 队列）
 *
 * 2026-11-06 拆分（行为等价，纯外提）：本文件只留「编排 + 状态机」。
 * 子模块（公开接口都在各自文件头部说明，外部只准从这里或子模块入口引用）：
 *   · voice/status.ts      统计对象、状态去重、诊断快照
 *   · voice/tts-queue.ts   朗读队列参数/预取选择/任务构造/重试退避（队列本身仍在这里）
 *   · voice/recorder.ts    录音段状态、电平读取、端点门槛（设备生命周期仍在这里）
 *   · voice/asr-audio.ts   上传前的容器准备（mp4→wav、base64、FileReader 兜底）
 *   · voice/echo-filter.ts 回声/短碎片/重复发言过滤（纯状态 + 纯逻辑）
 *   · voice/fetch.ts       带硬超时的 fetch
 *   · voice/voices.ts      音色白名单与读写
 * 状态机仍只有这一处：idle → listening → recognizing → thinking → speaking → idle。
 *
 * 设计原则（每一条都是被之前的 bug 教育的）：
 *   ① 只有一个状态机：状态转移只有一处在改，杜绝"标志卡住没人清"
 *   ② 录音不靠"判句"：固定 6 秒窗口，窗口结束就上传；
 *      只在"已检测到说话且安静 700ms"时提前收尾（把它当加速，不当必要条件）
 *   ③ 每段必带电平信息：整段峰值 < -35dBFS 直接丢，不浪费识别额度
 *   ④ 所有网络请求都有硬超时（ASR 15s / TTS 20s / 对话由调用方负责）
 *   ⑤ 朗读队列有看门狗：不依赖 onended 回调，按音频元素真实状态复位
 *   ⑥ 回声防护三层：TTS 期间物理闭麦 + 说完 700ms 静音窗 + 文本回声比对
 *   ⑦ 每个可能"静默失败"的地方都有计数（stats），出问题看数字就知道卡在哪
 *
 * 2026-11-06 算法审计补丁见各补丁点的注释（令牌守卫 / 超时降级 / FileReader onerror /
 * 分块不劈词 / 丢弃计数只记一次）。
 */

import { Ape } from './ape.js'
import { narrationRate } from './rates.js'
import { stripStageDirections } from './text.js'
import { isPlaybackZombie } from './playback.js'
import { readEndpointMode, writeEndpointMode, normalizeEndpointMode } from './endpoint.js'
import { pickRecorderMime, type RecFormat } from './audio-codec.js'
import { browserVoiceUsable, speakViaBrowser } from './browser-tts.js'
import { prepareAudioForAsr } from './voice/asr-audio.js'
import { createEchoFilter } from './voice/echo-filter.js'
import { fetchWithTimeout } from './voice/fetch.js'
import { normalizeVoiceName, readStoredVoiceName } from './voice/voices.js'
import { createVoiceStats, createStatusHolder, createDiagSnapshots } from './voice/status.js'
import {
  ECHO_MUTE_MS, TTS_TIMEOUT_MS, TTS_WATCH_MS, TTS_ZOMBIE_MS, TTS_RETRY_MAX,
  ttsRetryDelayMs, narrationPauseFor, prefetchTargets, buildTtsJobs, isStaleToken, capQueue,
  type TtsJob,
} from './voice/tts-queue.js'
import {
  TICK_MS, TICK_ERROR_MS, LEVEL_PROBE_MS,
  readLevel, createSegmentState, resetSegmentState, addChunk, clearChunks, notePeak,
  accrueClassic, shouldStopClassic, shouldStopApeNoLevel, takeBlob, isTooSmallSegment,
  isSilentPeak, hadApeSpeech,
  type LevelBox,
} from './voice/recorder.js'
import type { VoiceStatus, VoiceStats } from './voice/status.js'
import { clearI } from './util.js'

// 对外公开接口保持原路径可导入（voice-bridge 等只依赖 ./voice.js）
export type { VoiceStatus, VoiceStats } from './voice/status.js'
export { TTS_VOICES, DEFAULT_VOICE, normalizeVoiceName, readStoredVoiceName } from './voice/voices.js'


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

// 录音端点参数（WINDOW_MS / EARLY_STOP_QUIET / MIN_SPEECH_MS / SILENT_PEAK_DB）与
// TTS 计时参数（TTS_TIMEOUT_MS / TTS_ZOMBIE_MS / ECHO_MUTE_MS）已分别搬到
// voice/recorder.ts 与 voice/tts-queue.ts，避免常量与实现分居两处。
const ASR_TIMEOUT_MS = 30000        // 识别上传硬超时（2026-11-06：15s 常被慢接口打满 → 超时 AbortError；TTS 的 20s 在 tts-queue.ts）
const ASR_RETRY_ONCE = true         // 超时/网络错误自动重试一次（识别失败不再直接算丢）

// 噪声判定与宿主共用一份（shared/noise.ts），避免两边各写一套、缓存又把噪声写进去

// ---- TTS 瞬时失败策略（2026-11-06：微软 edge-tts 偶发 NoAudioReceived） ----
// 分工：
//   · 重试次数与指数退避在 voice/tts-queue.ts（500ms 起、×2、最多 4 次，总等待 7.5s）；
//   · 这里管「连续失败 → 本会话冷却、直接用浏览器朗读」与「失败段跳过开关」。
// 冷却状态放模块级而不是实例内：限流是页面会话级别的事，重开语音待命（重建实例）不该重置。
// 冷却不是永久放弃——60 秒到期后，下一次朗读会自动重试一次合成，成功即恢复（ttsNoteSynthOk）。
const TTS_FAIL_COOLDOWN_K = 3       // 连续 K 次合成失败 → 进入冷却
const TTS_COOLDOWN_MS = 60000       // 冷却时长：期间跳过合成，直接用系统语音朗读
/**
 * 客户端同时允许在途的合成请求上限（1 条当前段 + 2 条预取）。
 * 为什么不更高：宿主 edge-tts 常驻 worker 是单线程顺序处理（src/host/tts/worker.ts 逐行读 stdin），
 * 多发只是堆在它的 stdin 队列里，反而把“马上要播的那一段”排到后面；3 条已够覆盖一段 2~4 秒的播放。
 */
const TTS_MAX_INFLIGHT = 3

const ttsFailGuard = { streak: 0, count: 0, cooldownUntil: 0 }

// ---- 预取诊断（模块级：跨语音实例累计，排障看趋势即可，不影响任何判定） ----
// hits：pumpTts 取段时命中了 ttsPrefetch（播放直接等这段已有的合成结果，不再发新请求）；
// misses：没命中，当场发 /tts。预取失败（结果 null）也算一次命中，随后重试路径按 miss 重新合成。
const ttsPrefetchGuard = { hits: 0, misses: 0 }

/** 此刻是否在冷却中（冷却到期后自动返回 false，下一段朗读会重新尝试合成） */
function ttsInCooldown(now = Date.now()): boolean {
  return ttsFailGuard.cooldownUntil > 0 && now < ttsFailGuard.cooldownUntil
}

/** 把 TTS 稳定性诊断同步到 window.__chubbyWhale（控制台排障直接看） */
function ttsSyncDiag(): void {
  try {
    const w: any = (window as any).__chubbyWhale || ((window as any).__chubbyWhale = {})
    w.ttsFailCount = ttsFailGuard.count
    w.ttsCooldownUntil = ttsFailGuard.cooldownUntil
    w.ttsPrefetchHits = ttsPrefetchGuard.hits
    w.ttsPrefetchMisses = ttsPrefetchGuard.misses
  } catch (e) { }
}

/** 记一次合成失败；连续 K 次即进入 60 秒冷却。返回此刻是否在冷却中 */
function ttsNoteSynthFail(): boolean {
  const now = Date.now()
  ttsFailGuard.count++
  ttsFailGuard.streak++
  if (ttsFailGuard.streak >= TTS_FAIL_COOLDOWN_K && !ttsInCooldown(now)) {
    ttsFailGuard.cooldownUntil = now + TTS_COOLDOWN_MS
  }
  ttsSyncDiag()
  return ttsInCooldown(now)
}

/** 合成成功：清零连败并解除冷却（冷却到期后那次重试成功就靠它恢复） */
function ttsNoteSynthOk(): void {
  ttsFailGuard.streak = 0
  ttsFailGuard.cooldownUntil = 0
  ttsSyncDiag()
}

/**
 * 失败段跳过开关（localStorage: chubby-tts-skip-fail，默认 off）。
 * on = 某段重试失败后跳过该段、继续下一段（完整性换稳定）；off = 保持原行为（降级浏览器朗读）。
 * 每次失败时就地读取：主人改完刷新即可生效，不必重建语音实例。
 */
function ttsSkipFailOn(): boolean {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return false
    return String(localStorage.getItem('chubby-tts-skip-fail') || '').trim().toLowerCase() === 'on'
  } catch (e) { return false }
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
  // 诊断快照（上一段录音 / 上一句朗读 / 当前 APE 帧）与统计对象由 voice/status.ts 持有
  const diag = createDiagSnapshots()
  const stats: VoiceStats = createVoiceStats()
  // 诊断字段先落 0：控制台 __chubbyWhale.ttsFailCount / ttsCooldownUntil 一开始就可读
  ttsSyncDiag()

  // ---- 状态机（去重与回调隔离在 status.ts，转移判定仍只在这里） ----
  const statusHolder = createStatusHolder((s: VoiceStatus) => {
    try { opts.onStatus && opts.onStatus(s) } catch (e) { }
  })
  const setStatus = statusHolder.set

  // ---- 采集 ----
  let stream: MediaStream | null = null
  let actx: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let rec: MediaRecorder | null = null
  let timeBuf: Float32Array | null = null
  const levelBuf: LevelBox = { byte: null }   // getFloatTimeDomainData 缺失时（老 Safari）用它兜底
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

  // ---- 一段录音的状态（parts / 峰值 / 说话时长 / 静音时长 / 段起点）----
  const seg = createSegmentState()
  // 录音段自增号：ASR 超时重试时同一段只处理一次（echoFilter 段级去重）
  let segSeq = 0
  let curSegId = 0
  let tickTimer: any = null
  let restartTimer: any = null

  // ---- 过滤状态（回声/短碎片/重复都收在 voice/echo-filter.ts，这里只留一个实例） ----
  const echoFilter = createEchoFilter()

  // ---- 朗读 ----
  const ttsQ: TtsJob[] = []
  let ttsBusy = false
  let ttsAudio: HTMLAudioElement | null = null
  // 当前音频的 objectURL：正常播完由 finish() 释放，停止/看门狗复位也必须一并 revoke，
  // 否则每次中途停止都会把一整段音频 Blob 留在内存里（页面不刷新就不回收）
  let ttsUrl = ''
  let ttsBusySince = 0
  let ttsSynthAt = 0   // 本段开始合成的时刻（0 = 未在合成）；看门狗据此区分"合成中"与"僵死"
  let ttsProgressAt = 0  // 本段最近一次"有进展"的时刻（开播/播放进度/收到新 chunk）；看门狗按它判停滞
  let ttsCurJob: TtsJob | null = null  // 当前正在处理的段：看门狗复位时要给它结账（回调 onDone）
  let ttsWatch: any = null
  // 系统语音朗读期间的「进展心跳」：看门狗按 ttsProgressAt 判停滞，浏览器朗读可能十几秒
  let ttsBrowserKeep: any = null
  // 退避窗口：下一次允许重试的时刻（0 = 无）。窗口内新 speak 不能把退避等待挤掉
  let ttsNextRetryAt = 0
  let mutedUntil = 0
  let speakToken = 0

  /** 当前电平（dBFS）。降级路径（老 Safari 8bit）与"读不到返回 -160"都在 recorder.ts */
  const level = (): number => {
    const r = readLevel(analyser, timeBuf, levelBuf)
    // 有真实读数就说明 analyser 在工作（哪怕此刻很安静，底噪也不会正好等于 -160）
    if (r.db > -159) levelOk = true
    return r.db
  }

  function micOn(on: boolean): void {
    try { if (stream) stream.getAudioTracks().forEach((t) => { t.enabled = on }) } catch (e) { }
  }

  /** 释放麦克风与 AudioContext：start 失败与 stop 共用 —— 绝不把录音灯留在亮着 */
  function releaseAudio(): void {
    try { if (rec && rec.state !== 'inactive') rec.stop() } catch (e) { }
    try { if (actx) actx.close() } catch (e) { }
    try { if (stream) stream.getTracks().forEach((t) => { t.stop() }) } catch (e) { }
    rec = null; actx = null; analyser = null; stream = null; timeBuf = null; levelBuf.byte = null
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
    curSegId = ++segSeq
    if (!running || !rec) return
    try {
      if (rec.state !== 'inactive') { try { rec.stop() } catch (e) { } scheduleNext(200); return }
      // 每段复位：计数器不清会出现"完全听不到"（修过的真 bug）
      resetSegmentState(seg, performance.now())
      ape.resetSegment()
      diag.setApe(null)
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
      if (!levelOk && !levelDead && levelProbeAt && performance.now() - levelProbeAt > LEVEL_PROBE_MS) {
        levelDead = true
        try { opts.onDiag && opts.onDiag({ stage: 'analyser-dead', hint: '电平不可用，静音判定已降级（改按段长/体积）' }) } catch (e) { }
      }
      if (epMode === 'ape') {
        // APE 路径：判定全部交给 client/ape.ts（已用 10 个合成场景单测）
        const st = ape.step(db)
        diag.setApe(st)
        notePeak(seg, db)
        if (st.commit && rec && rec.state === 'recording') {
          try { rec.stop() } catch (e) { }
          try { opts.onDiag && opts.onDiag({ stage: 'window-end', why: st.commitReason, floor: Math.round(st.floorDb) }) } catch (e) { }
          return
        }
        // 电平不可用：APE 会一直判"静音"、永不提交（它会静默重置窗口继续录）。
        // 这里按窗口上限强制收尾，交给 onWindowDone 的体积/时长兜底。
        if (shouldStopApeNoLevel(seg, levelDead, performance.now())) {
          try { rec.stop() } catch (e) { }
          try { opts.onDiag && opts.onDiag({ stage: 'window-end', why: 'no-level' }) } catch (e) { }
          return
        }
        tickTimer = setTimeout(tick, TICK_MS)
        return
      }
      const now = performance.now()
      notePeak(seg, db)
      accrueClassic(seg, db, muted)
      const why = shouldStopClassic(seg, now)
      if (why) {
        try { rec.stop() } catch (e) { }
        try { opts.onDiag && opts.onDiag({ stage: 'window-end', why, peak: Math.round(seg.peakDb), speechMs: seg.speechMs }) } catch (e) { }
        return   // onstop 里继续
      }
      tickTimer = setTimeout(tick, TICK_MS)
    } catch (e: any) {
      stats.lastError = 'tick: ' + String(e && e.name)
      tickTimer = setTimeout(tick, TICK_ERROR_MS)
    }
  }

  async function onWindowDone(blob: Blob): Promise<void> {
    const thisSegId = curSegId
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
        if (!hadApeSpeech(diag.getApe())) { stats.skippedSilent++; scheduleNext(150); return }
      } else if (isSilentPeak(seg.peakDb)) { stats.skippedSilent++; scheduleNext(150); return }
    }
    if (Date.now() < mutedUntil) { stats.skippedSilent++; scheduleNext(150); return }
    if (isTooSmallSegment(blob.size)) { stats.skippedSilent++; scheduleNext(150); return }

    stats.uploaded++
    setStatus('recognizing')
    try {
      // 编码协商 + Safari 的 mp4→WAV：上传前的容器转换都在这里（client/audio-codec.ts 提供纯函数）
      const wire = await prepareAudioForAsr(blob, { actx, recMime, onDiag: opts.onDiag })
      if (!wire || !wire.base64) { stats.asrFail++; stats.lastError = 'b64-empty'; return }
      // 单次上传（带独立 AbortController，超时/停止都会中止）
      const uploadOnce = async (): Promise<Response> => {
        const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null
        if (ctl) asrAborts.add(ctl)
        try {
          return await fetchWithTimeout(apiBase + '/asr', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            // format 必须带实际值：宿主按它决定 multipart 的 filename/Content-Type。
            // 白名单是 webm/wav/mp3（src/host/routes/asr.ts），mp4 不在其中 → hostAsrFormat 已回落成 webm。
            body: JSON.stringify({ audio: wire.base64, format: wire.format }),
          }, ASR_TIMEOUT_MS, ctl ? ctl.signal : undefined)
        } finally {
          if (ctl) asrAborts.delete(ctl)
        }
      }
      let res: Response
      try {
        res = await uploadOnce()
      } catch (e1: any) {
        // 超时/网络抖动：自动重试一次（识别失败 3/4 的根因是 15s 硬超时）
        if (ASR_RETRY_ONCE && e1 && e1.name === 'AbortError' && running) {
          stats.asrRetry = (stats.asrRetry || 0) + 1
          try { opts.onDiag && opts.onDiag({ stage: 'asr-retry', hint: '识别超时，重试一次' }) } catch (e) { }
          res = await uploadOnce()
        } else {
          throw e1
        }
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
      try {
        const cur = diag.getApe()
        diag.setSegment({
          mode: epMode,
          fmt: wire.format,
          winMs: Math.round(performance.now() - seg.startedAt),
          peMs: cur ? cur.speechMs : seg.speechMs,
          quMs: cur ? cur.quietMs : seg.quietMs,
          floor: cur ? Math.round(cur.floorDb) : null,
          target: cur ? cur.quietTargetMs : null,
          text: String(data.text || '').slice(0, 24),
        })
      } catch (e) { }
      const text = String(data.text || '').trim()
      if (!text) return
      stats.asrTexts++
      // 丢弃原因只在这里记一次（过滤器内部不再动 stats：原来同一个事件会被记两遍）
      const verdict = echoFilter.accept(text, Date.now(), thisSegId)
      if (verdict.ok) {
        stats.heard++
        setStatus('thinking')
        try { opts.onHeard(text) } catch (e) { }
      } else if (verdict.reason === 'short') {
        stats.shortDropped = (stats.shortDropped || 0) + 1
      } else if (verdict.reason === 'dup') {
        stats.dupDropped = (stats.dupDropped || 0) + 1
      } else {
        stats.echoDropped++
      }
    } catch (e: any) {
      stats.asrFail++
      stats.lastError = (e && e.name === 'AbortError' ? 'asr-ex: AbortError（超时/已停止）' : 'asr-ex: ' + String((e && e.name) || e))
    } finally {
      if (statusHolder.get() === 'recognizing') setStatus('listening')
      // 只有录音器空闲时才排下一段：否则会打断正在录的段（会丢开头几个字）
      if (!rec || rec.state === "inactive") scheduleNext(150)
    }
  }

  // ---- 朗读 ----
  /** revoke 一个音频 objectURL（旧环境可能没有该方法，失败绝不能影响朗读流程） */
  function revokeUrl(u: string): void {
    try { URL.revokeObjectURL(u) } catch (e) { }
    if (ttsUrl === u) ttsUrl = ''
  }

  /** 释放当前朗读音频：pause + 摘回调 + revoke objectURL（停止 / 看门狗复位 / 异常兜底共用） */
  function disposeTtsAudio(): void {
    try {
      if (ttsAudio) {
        ttsAudio.pause()
        ttsAudio.onended = null
        ttsAudio.onerror = null
      }
    } catch (e) { }
    ttsAudio = null
    if (ttsUrl) {
      const u = ttsUrl
      ttsUrl = ''
      try { URL.revokeObjectURL(u) } catch (e) { }
    }
  }

  /** TTS 诊断快照（原来 6 处手写同一段 try/catch；文本只留前 20 字） */
  function ttsDiag(job: TtsJob, failed: boolean, reason?: string): void {
    try { diag.setTts({ failed, reason, text: job.text.slice(0, 20), at: Date.now() }) } catch (e) { }
  }

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
      // 看门狗自己是"结账方"：把这段的令牌同步到新纪元，finishJob 才能在结账后继续 pump
      if (dead) dead.token = speakToken
      // 复位即放弃这一段：系统语音还在念的话一并掐掉（否则会和下一段叠音），退避窗口也清掉
      stopBrowserSpeech()
      ttsNextRetryAt = 0
      disposeTtsAudio()
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
  /** 在途合成数（当前段 + 预取）：预取按它截断到 TTS_MAX_INFLIGHT，避免把 worker 队列塞满 */
  let ttsInflight = 0
  let ttsSeq = 0

  // 合成一段（带超时）。失败返回 null —— 对应 C# 的 wav == null
  function synth(job: TtsJob): Promise<ArrayBuffer | null> {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null
    if (ctl) ttsAborts.add(ctl)
    // 在途计数与 abort 清理放在同一条 finally：命中/取消/失败三条路径都会回到这里
    ttsInflight++
    return fetchWithTimeout(apiBase + '/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: job.text, voice: voiceName, rate: job.rate, pitch: job.pitch || '' }),
    }, TTS_TIMEOUT_MS, ctl ? ctl.signal : undefined).then((r) => {
      if (!r.ok) throw new Error('tts-http-' + r.status)
      return r.arrayBuffer()
    }).catch((e: any) => {
      // 预取与正式合成共用这条计数（2026-11-06 复核：故意不区分）。
      // 预取失败也意味着"链路此刻不通"，计入连败能让下一段尽快降级到浏览器朗读；
      // 若把它排除，非 strict 场景要等本段 4 次退避全部失败才会兜底（verify-voice 实测 ~3.5s）。
      stats.lastError = 'tts: ' + String((e && e.name) || e)
      // 主动取消（停止说话 abort）不是"合成失败"：不能因为主人点了停止就推进冷却计数
      if (!(ctl && ctl.signal.aborted)) ttsNoteSynthFail()
      return null
    }).finally(() => {
      ttsInflight = Math.max(0, ttsInflight - 1)
      if (ctl) ttsAborts.delete(ctl)
    })
  }

  /**
   * 预取队列里接下来的块：普通 2 块、叙述 3 块，按在途上限截断（voice/tts-queue.ts）。
   * 预取失败不阻塞播放：synth 自身永远 resolve(null)，播放到那段时 pumpTts 当 miss 重合成。
   * 但它**计入**连败闸门（见 synth 的注释）——链路真的不通时，下一段能尽快降级浏览器朗读。
   */
  function prefetchUpcoming(narration: boolean): void {
    // 退避窗口内不预取：正在等重试的那一段不能被"提前合成"绕过 500/1000/2000/4000 的退避
    if (ttsNextRetryAt > 0) return
    // 冷却期不预取：连续失败说明正在限流，预取只会多发一次注定失败的请求
    if (ttsInCooldown()) return
    const wants = prefetchTargets(ttsQ, narration, ttsInflight, (seq) => ttsPrefetch.has(seq), TTS_MAX_INFLIGHT)
    for (let i = 0; i < wants.length; i++) {
      const target = wants[i]
      ttsPrefetch.set(target.seq, synth(target))
    }
  }

  // 系统语音兜底的三家差异（voices 异步 / onend 不触发 / cancel 后被吞）
  // 全部收进 client/browser-tts.ts，这里只用它导出的两个接口：
  //   browserVoiceUsable() —— 是否值得一试
  //   speakViaBrowser()    —— 念一段，Promise 永远 resolve（内部看门狗）

  // 叙述换气停顿（narrationPauseFor）在 voice/tts-queue.ts：纯函数，单测可覆盖

  /** 系统语音朗读期间按秒刷新进展时刻：否则看门狗 2.5 秒就判僵死、把队列打断 */
  function keepBrowserProgress(): () => void {
    clearI(ttsBrowserKeep); ttsBrowserKeep = null
    ttsProgressAt = Date.now()
    ttsBrowserKeep = setInterval(() => { ttsProgressAt = Date.now() }, TTS_WATCH_MS)
    return () => {
      if (!ttsBrowserKeep) return
      clearI(ttsBrowserKeep)
      ttsBrowserKeep = null
    }
  }

  /** 停掉系统语音与心跳（看门狗复位 / 停止说话共用） */
  function stopBrowserSpeech(): void {
    clearI(ttsBrowserKeep); ttsBrowserKeep = null
    try { const s: any = (window as any).speechSynthesis; if (s && typeof s.cancel === 'function') s.cancel() } catch (e) { }
  }

  /**
   * 一段朗读的最终降级（合成失败 / 冷却期 / 播放被拒绝后都走这里）：
   *   strict（试听）          → 静默结账，不冒充音色
   *   chubby-tts-skip-fail=on → 跳过该段、继续下一段（完整性换稳定，用户显式选择）
   *   系统语音可用            → 用浏览器 speechSynthesis 念完
   *   都没有                  → 结账继续，这一段记为丢失
   */
  function ttsBrowserFallback(job: TtsJob, myToken: number): void {
    // 混音根因：浏览器朗读前没停可能仍在播的 edge-tts 音频 → 两路同时出声
    try { disposeTtsAudio() } catch (e) { }
    try { stopBrowserSpeech() } catch (e) { }
    const canBrowser = !job.strict && browserVoiceUsable()
    if (job.strict || ttsSkipFailOn() || !canBrowser) { finishJob(job); return }
    // 朗读期间开麦会把自己的声音录回去：与音频路径一致先闭麦，finishJob 里 700ms 后恢复
    if (!muted) micOn(false)
    const stopKeep = keepBrowserProgress()
    speakViaBrowser(job.text).then(() => {
      stopKeep()
      // 审计补丁：浏览器兜底可能念很久，念完时这一段可能已被停止/看门狗作废；
      // 没有这道令牌守卫就会在停止后仍回调 onDone（说书锁被解开）并把状态回写成 listening。
      if (myToken !== speakToken) return
      finishJob(job)
    })
  }

  function finishJob(j: TtsJob): void {
    clearI(ttsBrowserKeep); ttsBrowserKeep = null
    ttsNextRetryAt = 0
    ttsBusy = false
    if (ttsCurJob === j) ttsCurJob = null
    ttsProgressAt = 0
    mutedUntil = Date.now() + ECHO_MUTE_MS
    setTimeout(() => { if (!ttsBusy && !muted) micOn(true) }, ECHO_MUTE_MS)
    try { j.onDone && j.onDone() } catch (e) { }
    // 叙述模式：段间 260ms 换气停顿（C# NarrationPauseMs）
    if (j.narration && ttsQ.length > 0) {
      const token = j.token
      setTimeout(() => {
        // 审计补丁：原来这里没有令牌守卫，停止说话后迟到的续播定时器还会再 pump 一次
        // （队列已清空 → 只把状态回写成 listening）。
        if (isStaleToken(token, speakToken)) return
        try { pumpTts() } catch (e) { }
      }, narrationPauseFor(j.text))
    } else {
      pumpTts()
    }
  }

  /** force=true：退避定时器到点后的自唤醒，不再做一次毫秒级窗口比较（否则偶发提前 1ms 就永久卡住） */
  function pumpTts(force?: boolean): void {
    if (ttsBusy) return
    // 退避窗口内不取任务：新 speak 不能把「重试等待」挤掉（否则退避形同虚设、请求更密）
    if (ttsNextRetryAt > 0) {
      if (!force && Date.now() < ttsNextRetryAt) return
      ttsNextRetryAt = 0
    }
    const job = ttsQ.shift()
    if (!job) { setStatus('listening'); return }
    ttsBusy = true
    ttsBusySince = Date.now()
    ttsProgressAt = Date.now()
    ttsCurJob = job
    const myToken = ++speakToken
    job.token = myToken
    setStatus('speaking')
    // 不在合成开始时就闭麦：合成要 3~4 秒，提前闭麦会让主人这几秒说的话全丢；
    // 真正闭麦放到「开播前」（见下面 a.play() 之前），重试等待期间也保持开麦
    // （自身回声由 acceptText 的 spokenRecent 比对 + 说完后的静音窗兜住）。
    stats.ttsRequests++

    // 冷却期（连续合成失败达到阈值）：暂时不打 /tts，直接把这一段交给系统语音。
    // 正在退避重试中的段（attempts > 0）例外：让它按 4 次上限走完（冷却只拦"下一段"，
    // 否则第 4 次重试永远轮不到，"最多 4 次"名存实亡）。
    // 不是永久放弃——60 秒冷却到期后的下一次朗读会重新尝试合成，成功即恢复（ttsNoteSynthOk）。
    if (ttsInCooldown() && job.attempts <= 0) {
      ttsSynthAt = 0
      ttsDiag(job, true, 'cooldown')
      // 跳过开关优先：主人显式选了「跳过失败段」，冷却期也不拿系统语音顶替，否则等于没跳过
      if (ttsSkipFailOn()) { finishJob(job); return }
      ttsBrowserFallback(job, myToken)
      return
    }

    const cached = ttsPrefetch.get(job.seq)
    const cur = cached || synth(job)
    // 预取命中/未命中：只做诊断计数（__chubbyWhale 里看），不参与任何播放/重试判定
    if (cached) { ttsPrefetchGuard.hits++; ttsSyncDiag() } else { ttsPrefetchGuard.misses++; ttsSyncDiag() }
    ttsSynthAt = Date.now()
    ttsPrefetch.delete(job.seq)
    // 预取并发：当前块一开始合成就把 N+1、N+2（叙述 N+3）压上去，worker 在播放当前块时
    // 顺便把后面几段做完；播放仍由 ttsBusy 的串行门保证不重叠，预取命中时直接开播、不再发请求。
    prefetchUpcoming(job.narration)

    cur.then((buf) => {
      // 令牌校验必须放最前：这一段如果已被 stopSpeaking / 看门狗作废，
      // 回调再去改 ttsBusy / ttsSynthAt 就会把"新段"的状态一起清掉，
      // 新段要么立刻被判僵尸，要么被旧段顶掉重播。
      if (myToken !== speakToken) return
      ttsSynthAt = 0
      if (!buf) {
        // 合成失败：按指数退避（500/1000/2000/4000ms）重试，最多 TTS_RETRY_MAX 次，
        // 绝不静默跳过（默认 off 时重试后降级浏览器朗读，保证内容完整）。
        // 冷却只影响「后续段」：本段已经开念，仍按 4 次上限走完——否则冷却阈值（3 次）
        // 会让第 4 次重试永远轮不到，"最多 4 次"名存实亡。
        if (job.attempts < TTS_RETRY_MAX) {
          job.attempts++
          ttsQ.unshift(job)
          ttsBusy = false
          const backoff = ttsRetryDelayMs(job.attempts)
          ttsNextRetryAt = Date.now() + backoff
          try { (window as any).__chubbyWhale.ttsRetry = ((window as any).__chubbyWhale.ttsRetry || 0) + 1 } catch (e) { }
          // 令牌守卫：停止说话后这次重试不能再把状态机拉起来
          setTimeout(() => { if (myToken !== speakToken) return; try { pumpTts(true) } catch (e) { } }, backoff)
          return
        }
        stats.ttsFail++
        ttsDiag(job, true, 'synth')
        try {
          const w: any = (window as any).__chubbyWhale
          w.ttsLost = w.ttsLost || []
          w.ttsLost.push(job.text.slice(0, 16))
          if (w.ttsLost.length > 10) w.ttsLost.shift()
        } catch (e) { }
        // 系统语音兜底 / 失败段跳过开关都在 ttsBrowserFallback 里（strict 试听不兜底）
        ttsBrowserFallback(job, myToken)
        return
      }
      // 合成成功：清零连败、解除冷却（限流恢复后不再用系统语音顶替）
      ttsNoteSynthOk()
      try { opts.onSegment && opts.onSegment(job.text) } catch (e) { }
      const url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }))
      // 先登记再建元素：new Audio 若抛错，下面 catch 里的 disposeTtsAudio 也能收回这个 URL
      ttsUrl = url
      const a = new Audio(url)
      ttsAudio = a
      ttsProgressAt = Date.now()
      // 播放进度/缓冲/开播都算"有进展"：长段播到一半卡死时，看门狗才等到真正停滞再复位，
      // 而不是按段开始时刻一刀切。
      const bump = () => { ttsProgressAt = Date.now() }
      try { a.onplaying = bump; a.ontimeupdate = bump; a.onprogress = bump; a.onloadeddata = bump } catch (e) { }
      // played 区分 onended（真播完）与 onerror（解码/播放出错）：原来两者都记"已开播"，统计虚高
      const finish = (played: boolean) => {
        // 过期段只收回自己的 objectURL，绝不能清掉新段的 ttsAudio
        if (myToken !== speakToken) { revokeUrl(url); return }
        try { a.onended = null; a.onerror = null } catch (e) { }
        revokeUrl(url)
        ttsAudio = null
        if (played) {
          stats.ttsPlayed++
          ttsDiag(job, false)
        } else {
          stats.ttsFail++
          ttsDiag(job, true, 'play')
        }
        finishJob(job)
      }
      a.onended = () => finish(true)
      a.onerror = () => finish(false)
      // 开播前才闭麦：合成期间麦克风保持开（主人插话能听到），播放结束 finishJob 里 700ms 后恢复
      micOn(false)
      a.play().catch(() => {
        // 令牌校验：过期段只收回自己的 objectURL，绝不能清掉新段的 ttsAudio，
        // 也不能把旧 job unshift 回去（那会变成"新段播一半被旧段顶掉重播"）
        if (myToken !== speakToken) { revokeUrl(url); return }
        // 播放没起来：先恢复麦克风再重试，别让麦一直关着（重试等待期间要能听见主人）
        if (!muted) micOn(true)
        stats.ttsFail++
        ttsDiag(job, true, 'play')
        try { a.onended = null; a.onerror = null } catch (e) { }
        revokeUrl(url)
        ttsAudio = null
        // 播放被拒绝：先重试一次（换新音频元素），仍不行才降级；跳过开关与系统语音兜底同合成失败
        if (job.attempts < 1) {
          job.attempts++
          ttsQ.unshift(job)
          ttsBusy = false
          setTimeout(() => { if (myToken !== speakToken) return; try { pumpTts() } catch (e) { } }, 250)
          return
        }
        ttsBrowserFallback(job, myToken)
      })
    }).catch((e: any) => {
      // 兜底：建 Blob / objectURL / 音频元素或启动播放时的未预料异常不能把 ttsBusy 卡住
      // （卡住后要等看门狗 20 秒合成超时才复位），也不能把这一段的 onDone 吞掉。
      try { stats.lastError = 'tts-play: ' + String((e && e.name) || e) } catch (e2) { }
      if (myToken !== speakToken) return
      ttsSynthAt = 0
      disposeTtsAudio()
      stats.ttsFail++
      ttsDiag(job, true, 'exception')
      finishJob(job)
    })
  }

  /** 硬切点若落在英文单词/数字串内部，回退到词首（整段都是一个超长词时只能原样硬切） */
  function splitForTts(text: string, maxLen = 56): string[] {
    const out: string[] = []
    const src = String(text || '')
    if (!src.trim()) return out
    if (maxLen < 8) maxLen = 8
    const firstMax = Math.min(maxLen, 14)
    // 审计补丁：硬切（攒到 cap）原先直接按长度切，会把英文单词/数字串从中间劈开
    // （"unbelievable" → "unbeliev|able"、"2026" → "20|26"），TTS 会把半截词按字母念。
    // 现在硬切点落在连续的 [A-Za-z0-9] 串内部时向前回退到词首；回退不丢字（整词落到下一段），
    // 首段只会更短，不破坏“首段 ≤14 字”的契约。标点边界（boundary）不回退。
    const isWordChar = function (ch) { return /[A-Za-z0-9]/.test(ch) }
    let sbuf = ''
    for (const c of src) {
      sbuf += c
      const boundary = /[。，！？!?；;、,\n]/.test(c)
      const cap = out.length === 0 ? firstMax : maxLen
      const atBoundary = boundary && sbuf.length >= Math.max(8, Math.floor(cap / 3))
      if (sbuf.length >= cap || atBoundary) {
        let cut = sbuf.length
        if (!atBoundary) {
          const limit = Math.min(sbuf.length, cap)
          // 末尾若是连续的 [A-Za-z0-9] 串，说明这里可能正是一个单词/数字串的中段
          // （下一个字符还没收进来，无法判断它是否已结束）→ 保守回退到串首，
          // 整词落到下一段。代价只是偶尔把恰好结束在 cap 的整词挪后，不丢字也不劈开。
          if (limit > 1 && isWordChar(sbuf[limit - 1])) {
            let back = limit
            while (back > 0 && isWordChar(sbuf[back - 1])) back--
            if (back > 0) cut = back
          }
        }
        const seg = sbuf.slice(0, cut).trim()
        if (seg) out.push(seg)
        sbuf = sbuf.slice(cut)
      }
    }
    const rest = sbuf.trim()
    if (rest) out.push(rest)
    return out
  }

  // 上传前的容器准备（mp4→wav / base64 / FileReader 兜底）在 voice/asr-audio.ts；
  // 带硬超时的 fetch 在 voice/fetch.ts。这里只调用。

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
      rec.ondataavailable = (e: BlobEvent) => { if (e.data && e.data.size > 0) addChunk(seg, e.data) }
      rec.onstop = () => {
        // 已经 stop() 了：这段残响不能再走识别（哪怕录音器自己又 stop 了一次）
        if (!running) { clearChunks(seg); return }
        // blob 的 type 用录音器实际报的 mime（Safari 这里是 audio/mp4），绝不写死 webm：
        // 写死会让后面的 format 归类拿到错误容器，Safari 的 mp4 就永远走不到转 wav 那条路。
        const blobType = String((rec && (rec as any).mimeType) || recMime || 'audio/webm')
        const blob = takeBlob(seg, blobType)
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
    // 关掉语音待命就清空回声记忆：否则 15 秒内重新打开、再说同一句，
    // 仍会被判成「本鱼刚说过的回声」而丢掉（分身 2026-11-06 取证）
    try { echoFilter.reset() } catch (e) { }
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
    echoFilter.noteSpoken(raw)
    // 队列任务由 voice/tts-queue.ts 构造（只有最后一段挂 onDone，seq 连续递增）
    const jobs = buildTtsJobs(segs, {
      rate,
      narration,
      strict,
      nextSeq: ttsSeq + 1,
      onDone: o && o.onDone,
    })
    ttsSeq += segs.length
    for (let i = 0; i < jobs.length; i++) ttsQ.push(jobs[i])
    // 队列上限：超出就丢最旧的待播段（正在播的那段已被 pumpTts 取走，不在数组里）。
    // 防断网/合成卡死时无限堆积；丢了多少进 qDropped，排障面板能看到。
    const droppedQ = capQueue(ttsQ)
    if (droppedQ > 0) stats.qDropped = (stats.qDropped || 0) + droppedQ
    // 首块优先：入队即把队首（及后一块）压上合成，不等播放循环 —— 旧段还在播时，
    // 新段首块也能在旧段播完前合成好；播放仍交给 pumpTts 串行接管（命中预取直接开播）。
    prefetchUpcoming(!!(ttsQ[0] && ttsQ[0].narration))
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
    // 停止也要释放 objectURL：否则每次「停止说话」都白留一段音频 Blob，直到刷新页面
    disposeTtsAudio()
    ttsBusy = false
    // 退避窗口与系统语音心跳一起清：停止后不能再有迟到的重试/叠音
    ttsNextRetryAt = 0
    // 系统语音兜底可能还在念：一起取消（Safari/Firefox 都支持 cancel）
    stopBrowserSpeech()
    if (!muted) micOn(true)
    mutedUntil = Date.now() + ECHO_MUTE_MS
    // 没开麦时不能报「在听」：原来无条件 listening，菜单试听/停止后状态会假装麦克风开着
    setStatus(running ? 'listening' : 'idle')
  }

  return {
    start,
    stop,
    speak,
    stopSpeaking,
    speaking: () => ttsBusy,
    recognizing: () => statusHolder.get() === 'recognizing',
    setEndpointMode: (m: 'ape' | 'classic') => { epMode = normalizeEndpointMode(m); writeEndpointMode(epMode) },
    // 端点检测：报告当前实际生效的模式（ape / classic），不再写死 classic
    endpointInfo: () => ({ mode: epMode }),
    lastSegment: () => diag.getSegment(),
    lastTtsInfo: () => diag.getTts(),
    // 立即换音色：下一个 /tts 请求就带新 voice（不重建实例）；白名单外的值不改
    setVoiceName: (n: string) => { voiceName = normalizeVoiceName(n, voiceName) },
    voiceName: () => voiceName,
    mute: (on: boolean) => { muted = on; micOn(!on) },
    stats,
    status: () => statusHolder.get(),
  }
}
