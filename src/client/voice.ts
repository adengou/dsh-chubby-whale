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

export type VoiceStatus = 'idle' | 'listening' | 'recognizing' | 'thinking' | 'speaking'

export type VoiceStats = {
  windows: number          // 录过多少段
  skippedSilent: number    // 因太安静被丢
  uploaded: number         // 上传次数
  asrFail: number          // 识别失败
  asrTexts: number         // 识别出文字的段数
  heard: number            // 通过过滤、真正交给上层的
  echoDropped: number      // 被回声/重复过滤掉
  ttsRequests: number      // 朗读请求数
  ttsPlayed: number        // 真正开始播放
  ttsFail: number          // 合成/播放失败
  ttsZombie: number        // 僵尸复位次数
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
}

export type Voice = {
  start: () => Promise<void>
  stop: () => void
  speaking: () => boolean
  recognizing: () => boolean
  speak: (text: string, opts?: { rate?: string; narration?: boolean; onDone?: () => void }) => void
  stopSpeaking: () => void
  setVoiceName: (name: string) => void
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
const TTS_SEG_MAX = 90           // 一段朗读最多多少字
const TTS_WATCH_MS = 1000        // 朗读看门狗间隔
const TTS_ZOMBIE_MS = 2500       // 这么久没在播就复位

/** 识别服务常把静音/气口编成的词，一律当噪声 */
const NOISE_TEXTS = ['嗯', '呃', '啊', '哦', '嗯嗯', '谢谢观看', '谢谢大家', '字幕', '请不吝点赞', '订阅', '转发', '打赏', '再见', '本鱼在听', '嗯本鱼在听']

export function createVoice(opts: VoiceOptions): Voice {
  const apiBase = opts.apiBase || '/api/chubby-whale'
  let voiceName = opts.voiceName || 'zh-CN-XiaoyiNeural'

  const stats: VoiceStats = {
    windows: 0, skippedSilent: 0, uploaded: 0, asrFail: 0, asrTexts: 0, heard: 0,
    echoDropped: 0, ttsRequests: 0, ttsPlayed: 0, ttsFail: 0, ttsZombie: 0, lastError: '',
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
  let running = false
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

  // ---- 朗读 ----
  type Job = { text: string; rate: string; narration: boolean; onDone?: () => void }
  const ttsQ: Job[] = []
  let ttsBusy = false
  let ttsAudio: HTMLAudioElement | null = null
  let ttsBusySince = 0
  let ttsWatch: any = null
  let mutedUntil = 0
  let speakToken = 0

  const level = () => {
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
    stats.windows++
    // 太安静：直接丢（识别服务对静音会编词，浪费钱还制造幻觉）
    if (winPeak < SILENT_PEAK_DB) { stats.skippedSilent++; scheduleNext(150); return }
    if (Date.now() < mutedUntil) { stats.skippedSilent++; scheduleNext(150); return }
    if (blob.size < 1200) { stats.skippedSilent++; scheduleNext(150); return }

    stats.uploaded++
    setStatus('recognizing')
    try {
      const b64 = await blobToBase64(blob)
      if (!b64) { stats.asrFail++; stats.lastError = 'b64-empty'; return }
      const res = await fetchWithTimeout(apiBase + '/asr', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audio: b64, format: 'webm' }),
      }, ASR_TIMEOUT_MS)
      const data = await res.json()
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
      scheduleNext(150)
    }
  }

  /** 过滤：静音噪声 / 自身回声 / 短时间重复 */
  function acceptText(text: string): boolean {
    const plain = text.replace(/[\s。，！？,.!?、…~～]/g, '')
    if (plain.length < 2) return false
    if (NOISE_TEXTS.indexOf(plain) >= 0) return false
    if (/^本鱼在听/.test(plain)) return false
    // 自己刚说过的话（回声）
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
  function ttsWatchdog(): void {
    try {
      if (ttsAudio && !ttsAudio.paused && !ttsAudio.ended && ttsAudio.readyState > 0) return
      if (!ttsBusy) return
      if (Date.now() - ttsBusySince < TTS_ZOMBIE_MS) return
      // 僵尸：标志说在播，但音频元素早就停了 → 复位，继续下一段
      stats.ttsZombie++
      try { if (ttsAudio) { ttsAudio.onended = null; ttsAudio.onerror = null } } catch (e) { }
      ttsAudio = null
      ttsBusy = false
      pumpTts()
    } catch (e) { }
  }

  function pumpTts(): void {
    if (ttsBusy) return
    const job = ttsQ.shift()
    if (!job) { setStatus('listening'); return }
    ttsBusy = true
    ttsBusySince = Date.now()
    const myToken = ++speakToken
    setStatus('speaking')
    micOn(false)                     // 出声即闭麦
    stats.ttsRequests++
    fetchWithTimeout(apiBase + '/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: job.text, voice: voiceName }),
    }, TTS_TIMEOUT_MS).then((r) => {
      if (!r.ok) throw new Error('tts-http-' + r.status)
      return r.arrayBuffer()
    }).then((buf) => {
      if (myToken !== speakToken) { ttsBusy = false; return }
      const url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }))
      const a = new Audio(url)
      ttsAudio = a
      const finish = () => {
        if (myToken !== speakToken) { try { URL.revokeObjectURL(url) } catch (e) { } return }
        try { a.onended = null; a.onerror = null } catch (e) { }
        try { URL.revokeObjectURL(url) } catch (e) { }
        ttsAudio = null
        ttsBusy = false
        mutedUntil = Date.now() + ECHO_MUTE_MS
        setTimeout(() => { if (!ttsBusy && !muted) micOn(true) }, ECHO_MUTE_MS)
        try { job.onDone && job.onDone() } catch (e) { }
        pumpTts()
      }
      a.onended = finish
      a.onerror = finish
      stats.ttsPlayed++
      a.play().catch(() => {
        stats.ttsFail++
        finish()
      })
    }).catch((e: any) => {
      stats.ttsFail++
      stats.lastError = 'tts: ' + String((e && e.name) || e)
      ttsBusy = false
      micOn(true)
      pumpTts()
    })
  }

  function splitText(text: string, max: number): string[] {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean) return []
    if (clean.length <= max) return [clean]
    const out: string[] = []
    let cur = ''
    for (const ch of clean) {
      cur += ch
      if (cur.length >= max || /[。！？!?；;]/.test(ch)) { out.push(cur.trim()); cur = '' }
    }
    if (cur.trim()) out.push(cur.trim())
    return out.filter(Boolean)
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

  async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = ctl ? setTimeout(() => { try { ctl.abort() } catch (e) { } }, ms) : null
    try {
      return await fetch(url, ctl ? { ...init, signal: ctl.signal } : init)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  // ---- 对外接口 ----
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
      rec = new MediaRecorder(stream)
      rec.ondataavailable = (e: BlobEvent) => { if (e.data && e.data.size > 0) parts.push(e.data) }
      rec.onstop = () => {
        const blob = new Blob(parts, { type: 'audio/webm' })
        parts = []
        void onWindowDone(blob)
        // 关键：立刻开始录下一段，不要等识别返回（原来识别期间麦克风是"瞎"的，主人接话就丢）
        scheduleNext(120)
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
      stats.lastError = 'getUserMedia: ' + String((e && e.name) || e)
      setStatus('idle')
      try { opts.onDiag && opts.onDiag({ stage: 'start-failed', err: stats.lastError }) } catch (e2) { }
    }
  }

  function stop(): void {
    running = false
    if (tickTimer) { clearTimeout(tickTimer); tickTimer = null }
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null }
    if (ttsWatch) { clearInterval(ttsWatch); ttsWatch = null }
    try { if (rec && rec.state !== 'inactive') rec.stop() } catch (e) { }
    try { if (actx) actx.close() } catch (e) { }
    try { if (stream) stream.getTracks().forEach((t) => t.stop()) } catch (e) { }
    rec = null; actx = null; analyser = null; stream = null; timeBuf = null
    setStatus('idle')
  }

  function speak(text: string, o?: { rate?: string; narration?: boolean; onDone?: () => void }): void {
    // 首段 16 字先开口：长回复不用等整段合成完（只影响文字切分，不涉及录音逻辑）
    const head = splitText(String(text || ""), 16)
    const segs = head.length <= 1
      ? splitText(String(text || ""), TTS_SEG_MAX)
      : [head[0], ...splitText(head.slice(1).join(""), TTS_SEG_MAX)]
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
    pumpTts()
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
    recognizing: () => status === 'recognizing',
    setVoiceName: (n: string) => { voiceName = n || voiceName },
    mute: (on: boolean) => { muted = on; micOn(!on) },
    stats,
    status: () => status,
  }
}
