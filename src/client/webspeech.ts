/**
 * client/webspeech.ts —— 浏览器自带语音识别通道（Web Speech API）
 *
 * 为什么要有它：
 *   我们自己的 VAD（AnalyserNode 读 dBFS + 自己判"说完了"）反复出问题，
 *   而浏览器自带的 SpeechRecognition 内部已经做了 VAD 与流式识别：
 *   它会在检测到句子结束时直接回调 isFinal 结果，不需要我们再切段、再上传。
 *
 * 代价与风险（必须先说清楚）：
 *   · Chrome 的识别走 Google 云端、Edge 走微软云端 —— 国内网络很可能连不上；
 *   · 只在这些浏览器里有；Firefox 没有；需要 https 或 localhost；
 *   · 隐私上音频会发给浏览器厂商的云（不是发给 DSH 后端）。
 *   因此它只作为「优先通道」，失败必须能干净地退回自建 ASR 链路。
 */

export type WebSpeechHandlers = {
  onFinal: (text: string) => void
  onInterim?: (text: string) => void
  onError?: (code: string) => void
  onEnd?: () => void
}

export type WebSpeechCtl = {
  available: boolean
  running: boolean
  start: () => void
  stop: () => void
  /** 浏览器给的具体错误码（network / not-allowed / service-not-allowed…） */
  lastError: string
  restarts: number
}

export function createWebSpeech(handlers: WebSpeechHandlers, lang = 'zh-CN'): WebSpeechCtl {
  const w: any = typeof window !== 'undefined' ? window : {}
  const SR = w.SpeechRecognition || w.webkitSpeechRecognition
  const ctl: WebSpeechCtl = {
    available: !!SR,
    running: false,
    lastError: '',
    restarts: 0,
    start() { },
    stop() { },
  }
  if (!SR) return ctl

  let rec: any = null
  let wantOn = false
  let restartTimer: any = null

  function build(): any {
    const r = new SR()
    r.lang = lang
    r.continuous = true          // 中文连续识别：让浏览器自己分段
    r.interimResults = true      // 中间结果可用于即时气泡反馈
    r.maxAlternatives = 1
    r.onresult = (ev: any) => {
      try {
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const res = ev.results[i]
          if (!res) continue
          const text = String((res[0] && res[0].transcript) || '').trim()
          if (!text) continue
          if (res.isFinal) { try { handlers.onFinal(text) } catch (e) { } }
          else if (handlers.onInterim) { try { handlers.onInterim(text) } catch (e) { } }
        }
      } catch (e) { }
    }
    r.onerror = (ev: any) => {
      // not-allowed = 没权限；network = 云端不可达；service-not-allowed = 被策略禁
      ctl.lastError = String((ev && ev.error) || 'unknown')
      if (handlers.onError) { try { handlers.onError(ctl.lastError) } catch (e) { } }
      // 云端不可达时不要再无限重连（每 2 秒重试会刷爆控制台）
      if (ctl.lastError === 'not-allowed' || ctl.lastError === 'service-not-allowed' || ctl.lastError === 'network') {
        wantOn = false
      }
    }
    r.onend = () => {
      ctl.running = false
      if (handlers.onEnd) { try { handlers.onEnd() } catch (e) { } }
      // 浏览器会在静音一段时间后自动结束：只要还想要，就重启（间隔 400ms 防抖）
      if (wantOn) {
        ctl.restarts++
        if (restartTimer) clearTimeout(restartTimer)
        restartTimer = setTimeout(() => {
          restartTimer = null
          try { r.start() } catch (e) { }
        }, 400)
      }
    }
    return r
  }

  ctl.start = () => {
    if (wantOn) return
    wantOn = true
    try {
      if (!rec) rec = build()
      rec.start()
      ctl.running = true
      ctl.lastError = ''
    } catch (e: any) {
      // 同一实例重复 start() 会抛 InvalidStateError：忽略即可
      ctl.lastError = String((e && e.name) || e)
    }
  }

  ctl.stop = () => {
    wantOn = false
    if (restartTimer) { try { clearTimeout(restartTimer) } catch (e) { } restartTimer = null }
    try { if (rec) rec.stop() } catch (e) { }
    try { if (rec) rec.abort() } catch (e) { }
    ctl.running = false
  }

  return ctl
}
