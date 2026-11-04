/**
 * client/voice.ts —— 语音模块（2026-11 算法级重写）
 *
 * 参考算法：https://gitee.com/adengou/linyu → tools/asr-listener.ps1（MaxMs / SilenceMs / SilenceGate）
 *
 * 与上一版的区别（都是算法层面，不是调参）：
 *
 *   ① 采集与识别**彻底解耦**
 *      上一版：停录 → await 识别 → 才重启录音（识别那 1~2 秒里说的话全丢）
 *      现在：录音器常开（timeslice 250ms 滚动缓冲），每段用「webm 头部 + 本段数据块」拼装，
 *            识别 / 对话 / 朗读 与下一段采集完全并行，主人可以连着说。
 *
 *   ② 两段式静音判停（原来是单阈值绝对静音时长，句尾换气就拖到最长窗口）
 *      · 抖动窗 SOFT_QUIET=300ms：疑似说完 → 先把这段**预提交**（speculative）
 *      · 确认窗 HARD_QUIET=450ms：仍无起声 → 正式提交；期间又说话 → 撤销预提交继续录
 *      因为采集常开，误切也不丢字（最坏把一句切成两段）。
 *
 *   ③ 首段朗读更短：首段 16 字先合成先开口（原始 C# 版是 14 字），后面 90 字边播边合成。
 *
 *   ④ 自适应起判阈值：跟随环境噪声，夹在 -55…-40，避免小声说话被判静音而跑满窗口。
 *
 *   ⑤ 所有请求硬超时；朗读看门狗不依赖 onended；每一环都有计数与耗时。
 */

export type VoiceStatus = 'idle' | 'listening' | 'recognizing' | 'thinking' | 'speaking'

export type VoiceTiming = {
  /** 从"疑似说完"到正式提交的等待（越小越跟得上） */
  endpointMs: number
  /** 本段采集时长 */
  windowMs: number
  /** 识别耗时 */
  asrMs: number
  /** 本段音频字节数 */
  bytes: number
}

export type VoiceStats = {
  segments: number
  skippedSilent: number
  speculative: number
  cancelSpec: number
  uploaded: number
  asrFail: number
  asrTexts: number
  heard: number
  echoDropped: number
  ttsRequests: number
  ttsPlayed: number
  ttsFail: number
  ttsZombie: number
  lastError: string
  /** 最近一段的峰值 dBFS（判断"是不是被判成静音"） */
  lastPeak: number
  gateDb?: number
  timing: VoiceTiming
}

export type VoiceOptions = {
  /** 识别到一句有效的话（已过滤回声/重复/噪声） */
  onHeard: (text: string) => void
  /** 状态变化 */
  onStatus?: (s: VoiceStatus) => void
  /** 启动失败等诊断 */
  onDiag?: (d: any) => void
  apiBase?: string
  voiceName?: string
}

export type Voice = {
  start: () => Promise<void>
  stop: () => void
  speaking: () => boolean
  speak: (text: string, opts?: { rate?: string; narration?: boolean; onDone?: () => void }) => void
  stopSpeaking: () => void
  setVoiceName: (name: string) => void
  mute: (on: boolean) => void
  stats: VoiceStats
  status: () => VoiceStatus
}

// ---- 参数（注释里标出原始 C# 版对应值）----
const MAX_SEG_MS = 6000          // MaxMs = 6000
const SOFT_QUIET_MS = 300        // 抖动窗：疑似说完
const HARD_QUIET_MS = 450        // 确认窗（原 SilenceMs = 700）
const MIN_SPEECH_MS = 180        // 一段里至少这么多"像说话"
const TIMESLICE_MS = 250         // 滚动缓冲粒度
const SILENT_PEAK_DB = -45       // 整段峰值低于此值 = 没人说话（原 SilenceGate ≈ -34.7，放宽以适配小声）
const ECHO_MUTE_MS = 700
const ASR_TIMEOUT_MS = 15000
const TTS_TIMEOUT_MS = 20000
const TTS_FIRST_MAX = 16         // 首段 16 字先开口
const TTS_SEG_MAX = 90
const TTS_WATCH_MS = 1000
const TTS_ZOMBIE_MS = 2500

const NOISE_TEXTS = ['嗯', '呃', '啊', '哦', '嗯嗯', '谢谢观看', '谢谢大家', '字幕', '请不吝点赞', '订阅', '转发', '打赏', '再见', '本鱼在听', '嗯本鱼在听']

type Job = { text: string; rate: string; narration: boolean; onDone?: () => void }

export function createVoice(opts: VoiceOptions): Voice {
  const apiBase = opts.apiBase || '/api/chubby-whale'
  let voiceName = opts.voiceName || 'zh-CN-XiaoyiNeural'

  const stats: VoiceStats = {
    segments: 0, skippedSilent: 0, speculative: 0, cancelSpec: 0, uploaded: 0,
    asrFail: 0, asrTexts: 0, heard: 0, echoDropped: 0,
    ttsRequests: 0, ttsPlayed: 0, ttsFail: 0, ttsZombie: 0, lastError: '',
    lastPeak: 0,
    timing: { endpointMs: 0, windowMs: 0, asrMs: 0, bytes: 0 },
  }

  // ---- 状态机 ----
  let status: VoiceStatus = 'idle'
  const setStatus = (s: VoiceStatus) => {
    if (status === s) return
    status = s
    try { opts.onStatus && opts.onStatus(s) } catch (e) { }
  }

  // ---- 采集 ----
  let stream: MediaStream | null = null
  let actx: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let timeBuf: Float32Array | null = null
  let running = false
  let muted = false
  let rec: MediaRecorder | null = null
  let headerBlob: Blob | null = null                 // webm 头：每段都必须带上
  let buf: Array<{ t: number; b: Blob }> = []        // 滚动缓冲（录音器常开）

  // ---- 当前段 ----
  let segStart = 0
  let segPeak = -160
  let speechMs = 0
  let quietMs = 0
  let floorDb = -70
  let gateDb = -50   // 本段整段门限（= 起判阈值，跟着环境噪声走）
  let tickTimer: any = null
  let pendingSpec: { blob: Blob; at: number } | null = null

  // ---- 过滤 ----
  let lastText = ''
  let lastTextAt = 0
  const spokenRecent: Array<{ text: string; at: number }> = []

  // ---- 朗读 ----
  const ttsQ: Job[] = []
  let ttsBusy = false
  let ttsAudio: HTMLAudioElement | null = null
  let ttsBusySince = 0
  let ttsWatch: any = null
  let mutedUntil = 0
  let speakToken = 0

  function level(): number {
    if (!analyser || !timeBuf) return -160
    analyser.getFloatTimeDomainData(timeBuf as any)
    let sum = 0
    for (let i = 0; i < timeBuf.length; i++) sum += timeBuf[i] * timeBuf[i]
    const rms = Math.sqrt(sum / timeBuf.length)
    return 20 * Math.log10(rms + 1e-8)
  }

  function micOn(on: boolean): void {
    try { if (stream) stream.getAudioTracks().forEach((t) => { t.enabled = on }) } catch (e) { }
  }

  /** 用「webm 头 + 本段数据块」拼出可独立解码的一段 */
  function buildSegment(fromT: number, toT: number): Blob | null {
    if (!headerBlob) return null
    const picked = buf.filter((x) => x.t >= fromT && x.t <= toT).map((x) => x.b)
    if (!picked.length) return null
    return new Blob([headerBlob, ...picked], { type: 'audio/webm' })
  }

  // ---- 判停主循环 ----
  function tick(): void {
    if (!running) return
    try {
      const db = level()
      if (db > segPeak) segPeak = db
      // 自适应噪声底：说话声不会把底噪带高
      if (db < floorDb) floorDb = floorDb * 0.8 + db * 0.2
      else if (db < floorDb + 6) floorDb = floorDb * 0.98 + db * 0.02
      if (floorDb < -95) floorDb = -95
      if (floorDb > -25) floorDb = -25
      const onTh = Math.min(-40, Math.max(-55, floorDb + 8))
      gateDb = onTh   // 整段门限跟随同一起判阈值，避免"起判通过、整段被丢"
      try { stats.gateDb = Math.round(onTh) } catch (e) { }

      if (db > (muted ? 0 : onTh)) { speechMs += 60; quietMs = 0 }
      else { quietMs += 60 }

      const now = performance.now()
      const elapsed = now - segStart

      // ① 抖动窗：预提交（先拼好音频，暂不上传）
      if (!pendingSpec && speechMs >= MIN_SPEECH_MS && quietMs >= SOFT_QUIET_MS) {
        const blob = buildSegment(segStart, now)
        if (blob) { pendingSpec = { blob, at: now }; stats.speculative++ }
      }

      // ② 确认窗：正式提交（采集不中断）
      const confirmed = quietMs >= HARD_QUIET_MS && speechMs >= MIN_SPEECH_MS
      const overflow = elapsed >= MAX_SEG_MS
      if (confirmed || overflow) {
        const blob = pendingSpec ? pendingSpec.blob : buildSegment(segStart, now)
        const winMs = Math.round(now - segStart)
        const endpointMs = Math.round(quietMs)
        pendingSpec = null
        segStart = now
        segPeak = -160
        speechMs = 0
        quietMs = 0
        if (blob) void handleSegment(blob, winMs, endpointMs)
      } else if (pendingSpec && quietMs < SOFT_QUIET_MS) {
        // 说话又接上：撤销预提交，同一段继续录
        pendingSpec = null
        stats.cancelSpec++
      }

      tickTimer = setTimeout(tick, 60)
    } catch (e: any) {
      stats.lastError = 'tick: ' + String(e && e.name)
      tickTimer = setTimeout(tick, 120)
    }
  }

  async function handleSegment(blob: Blob, winMs: number, endpointMs: number): Promise<void> {
    stats.segments++
    stats.timing.windowMs = winMs
    stats.timing.endpointMs = endpointMs
    stats.timing.bytes = blob.size
    stats.lastPeak = Math.round(segPeak)
    if (segPeak < gateDb) { stats.skippedSilent++; return }   // 与起判统一：起判能过的话，整段就不该被判静音
    if (Date.now() < mutedUntil) { stats.skippedSilent++; return }
    if (blob.size < 1200) { stats.skippedSilent++; return }

    stats.uploaded++
    const t0 = performance.now()
    setStatus('recognizing')
    try {
      const b64 = await blobToBase64(blob)
      if (!b64) { stats.asrFail++; stats.lastError = 'b64-empty'; return }
      const res = await fetchTimeout(apiBase + '/asr', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audio: b64, format: 'webm' }),
      }, ASR_TIMEOUT_MS)
      const data = await res.json()
      stats.timing.asrMs = Math.round(performance.now() - t0)
      if (!data || !data.ok) { stats.asrFail++; stats.lastError = 'asr: ' + String((data && data.error) || 'failed'); return }
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
    }
  }

  function acceptText(text: string): boolean {
    const plain = text.replace(/[\s。，！？,.!?、…~～]/g, '')
    if (plain.length < 2) return false
    if (NOISE_TEXTS.indexOf(plain) >= 0) return false
    if (/^本鱼在听/.test(plain)) return false
    const now = Date.now()
    for (const s of spokenRecent) {
      if (now - s.at > 15000) continue
      const target = s.text.replace(/[\s。，！？,.!?、…~～]/g, '')
      if (!target) continue
      if (plain === target) return false
      if (target.length >= 6 && plain.indexOf(target.slice(0, 6)) >= 0) return false
      if (plain.length >= 6 && target.indexOf(plain.slice(0, 6)) >= 0) return false
    }
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
  function watchdog(): void {
    try {
      if (!ttsBusy) return
      const alive = ttsAudio && !ttsAudio.paused && !ttsAudio.ended && ttsAudio.readyState > 0
      if (alive) return
      if (Date.now() - ttsBusySince < TTS_ZOMBIE_MS) return
      stats.ttsZombie++
      try { if (ttsAudio) { ttsAudio.onended = null; ttsAudio.onerror = null } } catch (e) { }
      ttsAudio = null
      ttsBusy = false
      pump()
    } catch (e) { }
  }

  function pump(): void {
    if (ttsBusy) return
    const job = ttsQ.shift()
    if (!job) { setStatus('listening'); return }
    ttsBusy = true
    ttsBusySince = Date.now()
    const token = ++speakToken
    setStatus('speaking')
    micOn(false)
    stats.ttsRequests++
    fetchTimeout(apiBase + '/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: job.text, voice: voiceName }),
    }, TTS_TIMEOUT_MS).then((r) => {
      if (!r.ok) throw new Error('tts-http-' + r.status)
      return r.arrayBuffer()
    }).then((ab) => {
      if (token !== speakToken) { ttsBusy = false; return }
      const url = URL.createObjectURL(new Blob([ab], { type: 'audio/mpeg' }))
      const a = new Audio(url)
      ttsAudio = a
      const done = () => {
        if (token !== speakToken) { try { URL.revokeObjectURL(url) } catch (e) { } return }
        try { a.onended = null; a.onerror = null } catch (e) { }
        try { URL.revokeObjectURL(url) } catch (e) { }
        ttsAudio = null
        ttsBusy = false
        mutedUntil = Date.now() + ECHO_MUTE_MS
        setTimeout(() => { if (!ttsBusy && !muted) micOn(true) }, ECHO_MUTE_MS)
        try { job.onDone && job.onDone() } catch (e) { }
        pump()
      }
      a.onended = done
      a.onerror = done
      stats.ttsPlayed++
      a.play().catch(() => { stats.ttsFail++; done() })
    }).catch((e: any) => {
      stats.ttsFail++
      stats.lastError = 'tts: ' + String((e && e.name) || e)
      ttsBusy = false
      micOn(true)
      pump()
    })
  }

  /** 首段 16 字先开口，其余 90 字切（边播边合成） */
  function splitForSpeech(text: string): string[] {
    const clean = String(text || '').replace(/\s+/g, ' ').trim()
    if (!clean) return []
    const out: string[] = []
    let rest = clean
    if (rest.length > TTS_FIRST_MAX) {
      let cut = -1
      for (let i = 0; i < Math.min(TTS_FIRST_MAX, rest.length); i++) {
        if (/[。！？!?；;，,]/.test(rest[i])) cut = i + 1
      }
      if (cut <= 0) cut = TTS_FIRST_MAX
      out.push(rest.slice(0, cut).trim())
      rest = rest.slice(cut).trim()
    }
    while (rest.length > TTS_SEG_MAX) {
      let cut = -1
      for (let i = 0; i < TTS_SEG_MAX; i++) if (/[。！？!?；;]/.test(rest[i])) cut = i + 1
      if (cut <= 0) cut = TTS_SEG_MAX
      out.push(rest.slice(0, cut).trim())
      rest = rest.slice(cut).trim()
    }
    if (rest) out.push(rest)
    return out.filter(Boolean)
  }

  function blobToBase64(blob: Blob): Promise<string> {
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

  async function fetchTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = ctl ? setTimeout(() => { try { ctl.abort() } catch (e) { } }, ms) : null
    try {
      return await fetch(url, ctl ? { ...init, signal: ctl.signal } : init)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  // ---- 对外 ----
  async function start(): Promise<void> {
    if (running) return
    running = true
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      })
      if (!running) { try { stream.getTracks().forEach((t) => t.stop()) } catch (e) { } ; return }
      const Ctx: any = (window as any).AudioContext || (window as any).webkitAudioContext
      actx = new Ctx()
      try { await actx!.resume() } catch (e) { }
      const src = actx!.createMediaStreamSource(stream)
      analyser = actx!.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0
      timeBuf = new Float32Array(1024)
      src.connect(analyser)

      // 录音器常开：采集与识别解耦（每 250ms 一块进滚动缓冲）
      rec = new MediaRecorder(stream, { audioBitsPerSecond: 32000 } as any)
      rec.ondataavailable = (e: any) => {
        if (!e || !e.data || e.data.size === 0) return
        if (!headerBlob) { headerBlob = e.data; return }
        buf.push({ t: performance.now(), b: e.data })
        while (buf.length > 240) buf.shift()
      }
      rec.onerror = (e: any) => { stats.lastError = 'recorder: ' + String(e && e.error && e.error.name) }
      rec.start(TIMESLICE_MS)

      micOn(true)
      const now = performance.now()
      segStart = now
      segPeak = -160
      speechMs = 0
      quietMs = 0
      setStatus('listening')
      tick()
      if (ttsWatch) clearInterval(ttsWatch)
      ttsWatch = setInterval(watchdog, TTS_WATCH_MS)
      stats.lastError = ''
    } catch (e: any) {
      running = false
      stats.lastError = 'getUserMedia: ' + String((e && e.name) || e)
      setStatus('idle')
      try { opts.onDiag && opts.onDiag({ stage: 'start-failed', err: stats.lastError }) } catch (e2) { }
    }
  }

  function stop(): void {
    running = false
    if (tickTimer) { clearTimeout(tickTimer); tickTimer = null }
    if (ttsWatch) { clearInterval(ttsWatch); ttsWatch = null }
    try { if (rec && rec.state !== 'inactive') rec.stop() } catch (e) { }
    try { if (actx) actx.close() } catch (e) { }
    try { if (stream) stream.getTracks().forEach((t) => t.stop()) } catch (e) { }
    rec = null; actx = null; analyser = null; stream = null; timeBuf = null
    headerBlob = null; buf = []
    setStatus('idle')
  }

  function speak(text: string, o?: { rate?: string; narration?: boolean; onDone?: () => void }): void {
    const segs = splitForSpeech(text)
    if (!segs.length) return
    noteSpoken(text)
    for (let i = 0; i < segs.length; i++) {
      ttsQ.push({
        text: segs[i],
        rate: o && o.rate ? o.rate : '+0%',
        narration: !!(o && o.narration),
        onDone: i === segs.length - 1 ? (o && o.onDone) : undefined,
      })
    }
    pump()
  }

  function stopSpeaking(): void {
    speakToken++
    ttsQ.length = 0
    try { if (ttsAudio) { ttsAudio.pause(); ttsAudio.onended = null; ttsAudio.onerror = null } } catch (e) { }
    ttsAudio = null
    ttsBusy = false
    if (typeof speechSynthesis !== 'undefined') { try { speechSynthesis.cancel() } catch (e) { } }
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
    setVoiceName: (n: string) => { voiceName = n || voiceName },
    mute: (on: boolean) => { muted = on; micOn(!on) },
    stats,
    status: () => status,
  }
}
