/**
 * client/browser-tts.ts —— 浏览器内置 speechSynthesis 兜底（宿主 /tts 挂了时用）
 *
 * 为什么单独成模块：三家浏览器的行为差异都在这里，且必须能离线验证——
 *   · Firefox/Safari 的 getVoices() 是**异步**填的，首次调用常是空数组。
 *     旧写法"空数组=没语音"会让兜底永远不触发（宿主 TTS 一挂就彻底没声）。
 *   · Safari 的 onend 偶发不触发（尤其被 cancel 或切后台之后）→ 必须按文本长度看门狗兜底，
 *     否则 Promise 永不 resolve，上层 ttsBusy / 说书锁会永久卡死；看门狗判死时顺手 cancel，
 *     不然引擎还在念而上层已经开播下一段（两路声音叠在一起）。
 *   · Chrome/Safari 在 cancel() 之后立刻 speak() 会被吞 → 隔一拍（80ms）再开口。
 *     注意上层（voice.ts）每次兜底前都会先 cancel，所以这"一拍"不能只在 busy 时让。
 *   · Firefox 首批 voices 为空时不能挑 voice，用默认音色先念。
 *
 * 对外只暴露两个函数：能不能用、怎么念（永远 resolve，绝不 reject）。
 */

import { clearT } from './util.js'

/** 取一个作用域对象（默认 window），便于 Node 里传 stub 验证 */
function scopeOf(scope?: any): any {
  if (scope) return scope
  try { return typeof window !== 'undefined' ? (window as any) : null } catch (e) { return null }
}

/**
 * 系统语音是否值得一试。
 * getVoices() 为空时返回 true：真没语音时 speak() 会静默失败，而看门狗会放行，不会卡队列；
 * 若因为"首次调用拿到空数组"就返回 false，Firefox/Safari 上兜底会永久失效。
 */
export function browserVoiceUsable(scope?: any): boolean {
  try {
    const s: any = scopeOf(scope)
    if (!s || !s.speechSynthesis || typeof s.speechSynthesis.speak !== 'function') return false
    return true
  } catch (e) { return false }
}

/** 按文本长度估一个看门狗时长：220ms/字、最少 4 秒、封顶 30 秒（上层每段 ≤56 字，估算 ≤13.8 秒） */
export function watchdogMs(text: string): number {
  const n = String(text || '').length
  return Math.min(30000, Math.max(4000, 1500 + n * 220))
}

/** 等 voices 异步就位的上限：等不到就用默认音色先念，不能把朗读拖住 */
const VOICE_WAIT_MS = 300

/**
 * 念一段（Promise 永远 resolve）。
 * opts.scope 可传 stub；opts.wait 可覆盖看门狗时长（测试用）。
 */
export function speakViaBrowser(text: string, opts?: { scope?: any; watchdog?: number }): Promise<void> {
  const src = String(text || '')
  const s: any = scopeOf(opts && opts.scope)
  const ms = (opts && typeof opts.watchdog === 'number' && opts.watchdog > 0) ? opts.watchdog : watchdogMs(src)
  return new Promise((resolve) => {
    let done = false
    // 看门狗超时（onend 没来/引擎卡住）才需要替上层把扬声器收回，见 finish()
    let timedOut = false
    let startTimer: any = null
    let voiceTimer: any = null
    let onVoices: any = null
    let synthRef: any = null
    const finish = (): void => {
      if (done) return
      done = true
      try { if (startTimer) { clearTimeout(startTimer); startTimer = null } } catch (e) { }
      try { if (voiceTimer) { clearTimeout(voiceTimer); voiceTimer = null } } catch (e) { }
      try {
        if (onVoices && synthRef && typeof synthRef.removeEventListener === 'function') {
          synthRef.removeEventListener('voiceschanged', onVoices)
        }
      } catch (e) { }
      onVoices = null
      // 看门狗判死 = 这段已经算"说完了"，上层（voice.ts 的 finishJob）会接着播下一段
      // （可能是 edge-tts 音频）。引擎要是还在念，两路声音就叠在一起——并发纪律把
      // 「扬声器同一时刻只播一段」列为硬规则，所以这里必须把排队/在播的掐掉。
      if (timedOut) {
        try { if (synthRef && typeof synthRef.cancel === 'function') synthRef.cancel() } catch (e) { }
      }
      resolve()
    }
    // 看门狗：onend 不触发时也放行（Safari 的老毛病）
    const watch = setTimeout(() => { timedOut = true; finish() }, ms)
    const realFinish = (): void => { clearT(watch); finish() }
    try {
      const Synth: any = s && s.speechSynthesis
      const Utt: any = s && s.SpeechSynthesisUtterance
      if (!Synth || !Utt || typeof Synth.speak !== 'function') { realFinish(); return }
      synthRef = Synth
      const u = new Utt(src)
      // 语言按文本判断：英文界面/英文回复用 zh-CN 念会被系统音色读成怪腔
      const wantZh = /[\u4e00-\u9fa5]/.test(src)
      u.lang = wantZh ? 'zh-CN' : 'en-US'
      u.onend = realFinish
      u.onerror = realFinish
      // 有同语言音色就挑一个（Firefox 默认音色可能英文腔）
      const chooseVoice = (): void => {
        try {
          const vs = typeof Synth.getVoices === 'function' ? Synth.getVoices() : null
          for (let i = 0; vs && i < vs.length; i++) {
            const v = vs[i]
            if (!v) continue
            const lang = String(v.lang || '')
            if (wantZh ? /^zh/i.test(lang) : /^en/i.test(lang)) { u.voice = v; break }
          }
        } catch (e) { }
      }
      const speak = (): void => { try { Synth.speak(u) } catch (e) { realFinish() } }
      const launch = (): void => {
        if (done) return
        // 结束等待 voices：无论来自 voiceschanged 还是 300ms 超时，只放行一次
        try { if (voiceTimer) { clearTimeout(voiceTimer); voiceTimer = null } } catch (e) { }
        try {
          if (onVoices && typeof Synth.removeEventListener === 'function') Synth.removeEventListener('voiceschanged', onVoices)
        } catch (e) { }
        onVoices = null
        chooseVoice()
        const busy = (() => { try { return !!(Synth.speaking || Synth.pending) } catch (e) { return false } })()
        if (busy) {
          // 先取消在播/在排队的：这一段的文本已经换了，不能等旧段念完
          try { if (typeof Synth.cancel === 'function') Synth.cancel() } catch (e) { }
        }
        // 不管 busy 与否都隔一拍再开口：上层（voice.ts 的 ttsBrowserFallback）在调这里之前
        // 刚 stopBrowserSpeech() → cancel() 过；而 Chrome/Safari 在 cancel 之后立刻 speak
        // 会把这一句直接吞掉（本模块头注释记的老毛病）。busy 标志在 cancel 后就已经是 false，
        // 靠它判断"是否刚取消"根本看不出来，只能统一让一拍（80ms，兜底路径上无感）。
        startTimer = setTimeout(speak, 80)
      }
      // Firefox/Safari 首次 getVoices() 是空的（voiceschanged 之后才有）：
      // 有事件就等最多 VOICE_WAIT_MS 挑个同语言音色；没有就带着默认音色走 launch（再隔一拍开口）。
      let waiting = false
      try {
        const vs = typeof Synth.getVoices === 'function' ? Synth.getVoices() : null
        if ((!vs || !vs.length) && typeof Synth.addEventListener === 'function') {
          waiting = true
          onVoices = (): void => { if (done) return; launch() }
          Synth.addEventListener('voiceschanged', onVoices)
          voiceTimer = setTimeout(() => { if (done) return; launch() }, VOICE_WAIT_MS)
        }
      } catch (e) { waiting = false }
      if (!waiting) launch()
    } catch (e) { realFinish() }
  })
}
