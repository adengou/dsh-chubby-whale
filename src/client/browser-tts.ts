/**
 * client/browser-tts.ts —— 浏览器内置 speechSynthesis 兜底（宿主 /tts 挂了时用）
 *
 * 为什么单独成模块：三家浏览器的行为差异都在这里，且必须能离线验证——
 *   · Firefox/Safari 的 getVoices() 是**异步**填的，首次调用常是空数组。
 *     旧写法"空数组=没语音"会让兜底永远不触发（宿主 TTS 一挂就彻底没声）。
 *   · Safari 的 onend 偶发不触发（尤其被 cancel 或切后台之后）→ 必须按文本长度看门狗兜底，
 *     否则 Promise 永不 resolve，上层 ttsBusy / 说书锁会永久卡死。
 *   · Chrome/Safari 在 cancel() 之后立刻 speak() 会被吞 → 隔一拍再开口。
 *   · Firefox 首批 voices 为空时不能挑 voice，用默认音色先念。
 *
 * 对外只暴露两个函数：能不能用、怎么念（永远 resolve，绝不 reject）。
 */

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

/** 按文本长度估一个看门狗时长：220ms/字、最少 4 秒、封顶 30 秒 */
export function watchdogMs(text: string): number {
  const n = String(text || '').length
  return Math.min(30000, Math.max(4000, 1500 + n * 220))
}

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
    let startTimer: any = null
    const finish = (): void => {
      if (done) return
      done = true
      try { if (startTimer) clearTimeout(startTimer) } catch (e) { }
      resolve()
    }
    // 看门狗：onend 不触发时也放行（Safari 的老毛病）
    const watch = setTimeout(finish, ms)
    const realFinish = (): void => { try { clearTimeout(watch) } catch (e) { }; finish() }
    try {
      const Synth: any = s && s.speechSynthesis
      const Utt: any = s && s.SpeechSynthesisUtterance
      if (!Synth || !Utt || typeof Synth.speak !== 'function') { realFinish(); return }
      const u = new Utt(src)
      u.lang = 'zh-CN'
      u.onend = realFinish
      u.onerror = realFinish
      // 有中文音色就挑一个（Firefox 默认音色可能英文腔）
      try {
        const vs = typeof Synth.getVoices === 'function' ? Synth.getVoices() : null
        for (let i = 0; vs && i < vs.length; i++) {
          if (vs[i] && /^zh/i.test(String(vs[i].lang || ''))) { u.voice = vs[i]; break }
        }
      } catch (e) { }
      const busy = (() => { try { return !!(Synth.speaking || Synth.pending) } catch (e) { return false } })()
      const speak = (): void => { try { Synth.speak(u) } catch (e) { realFinish() } }
      if (busy) {
        // 先取消在播/在排队的，再隔一拍开口：立刻 speak 会被 Chrome/Safari 吞掉
        try { if (typeof Synth.cancel === 'function') Synth.cancel() } catch (e) { }
        startTimer = setTimeout(speak, 80)
      } else speak()
    } catch (e) { realFinish() }
  })
}
