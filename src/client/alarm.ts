/**
 * client/alarm.ts —— 闹钟铃声（Web Audio 合成，零第三方）
 *
 * 背景：原提醒只有「气泡 + TTS 朗读」，语音关着就无声、语音音量也小，
 * 错过就没了。这里做一条独立的闹钟铃声：
 *   · 双音交替（默认 880Hz / 660Hz），音量拉到能听清；
 *   · 响 beepMs → 停 quietMs → 再响，**循环直到 stop()**；
 *   · 与 TTS 完全解耦：语音关着照样响。
 *
 * 约束：
 *   · 不碰 DOM、不读存储；AudioContext 由调用方注入或懒创建（便于测试）；
 *   · 同一个实例只复用一个 AudioContext（Chrome 同时约 6 个 context 上限）；
 *   · start/stop 幂等；start 时若 context 被自动播放策略挂起，尝试 resume()。
 */

/** 铃声参数 */
export type AlarmParams = {
  /** 两个交替的音高（Hz） */
  beepHz: [number, number]
  /** 单次响的时长（ms） */
  beepMs: number
  /** 两次响之间的静默（ms） */
  quietMs: number
  /** 音量 0~1 */
  gain: number
}

/**
 * 默认参数：C5-E5-G5 上行琶音（风铃感），每个音 0.45 秒、一轮后停 3.5 秒，音量 0.22。
 * 早期版本用 880/660Hz 硬蜂鸣，主人反馈「像噪声、太刺耳」——纯正弦 + 硬起停会咔哒，
 * 高频双音快速交替更像报警器。改成低音量、带包络的上行三音后柔和很多。
 */
export const DEFAULT_ALARM_PARAMS: AlarmParams = Object.freeze({
  beepHz: [523.25, 659.25, 783.99] as unknown as [number, number],
  beepMs: 450,
  quietMs: 3500,
  gain: 0.22,
})

export type Alarm = {
  /** 开始循环响铃（已在响则幂等） */
  start: () => void
  /** 停止并释放振荡器（不在响则幂等） */
  stop: () => void
  /** 当前是否在响 */
  isRinging: () => boolean
}

export type AlarmOptions = {
  /** AudioContext 工厂（测试注入）；缺省用 window.AudioContext */
  createContext?: () => any
  /** 覆盖部分参数 */
  params?: Partial<AlarmParams>
}

/** 取 AudioContext 构造器（兼容 webkit 前缀） */
function defaultContextFactory(): any {
  const w: any = typeof window !== 'undefined' ? window : null
  const Ctx: any = w && (w.AudioContext || w.webkitAudioContext)
  return Ctx ? new Ctx() : null
}

export function createAlarm(options: AlarmOptions = {}): Alarm {
  const p: AlarmParams = Object.assign({}, DEFAULT_ALARM_PARAMS, options.params || {})
  const factory = typeof options.createContext === 'function' ? options.createContext : defaultContextFactory

  let ctx: any = null
  let loopTimer: any = null
  let ringing = false
  /** 当前这一轮里正在响的振荡器（stop 时要立刻掐掉） */
  let liveNodes: any[] = []

  /** 懒建 context：第一次 start 才建，避免页面一加载就占一个 context */
  function ensureContext(): any {
    if (ctx) return ctx
    try { ctx = factory() } catch (e) { ctx = null }
    return ctx
  }

  /** 响一轮：三个音依次响（上行琶音），每个音带淡入淡出包络，像风铃不像蜂鸣 */
  function beepOnce(): void {
    const c = ensureContext()
    if (!c || typeof c.createOscillator !== 'function' || typeof c.createGain !== 'function') return
    try {
      if (typeof c.resume === 'function' && c.state === 'suspended') {
        try { c.resume() } catch (e) { }
      }
      const hz = p.beepHz as unknown as number[]
      const t0 = typeof c.currentTime === 'number' ? c.currentTime : 0
      const noteSec = Math.max(0.1, p.beepMs / 1000)
      const vol = Math.max(0, Math.min(1, p.gain))
      hz.forEach((freq: number, i: number) => {
        const at = t0 + i * (noteSec * 0.9)
        const g = c.createGain()
        // 淡入 20ms → 保持 → 淡出（快起慢落，像铃）
        try {
          g.gain.setValueAtTime(0.0001, at)
          g.gain.linearRampToValueAtTime(vol, at + 0.02)
          g.gain.linearRampToValueAtTime(0.0001, at + noteSec)
        } catch (e) { }
        if (typeof g.connect === 'function') g.connect(c.destination)
        const o = c.createOscillator()
        o.type = 'sine'
        try { o.frequency.setValueAtTime(freq, at) } catch (e) { }
        if (typeof o.connect === 'function') o.connect(g)
        try { o.start(at) } catch (e) { }
        try { o.stop(at + noteSec + 0.05) } catch (e) { }
        liveNodes.push(g, o)
      })
      // 一轮结束后清掉节点引用（节点已自行 stop）
      setTimeout(() => { liveNodes = [] }, Math.ceil((noteSec + 0.2) * 1000))
    } catch (e) { }
  }

  /** 一轮：响一次，然后排下一次 */
  function tick(): void {
    if (!ringing) return
    beepOnce()
    loopTimer = setTimeout(tick, Math.max(200, p.beepMs + p.quietMs))
  }

  function start(): void {
    if (ringing) return
    ringing = true
    tick()
  }

  function stop(): void {
    ringing = false
    if (loopTimer) { try { clearTimeout(loopTimer) } catch (e) { } }
    loopTimer = null
    // 立刻掐掉可能还在响的音：断开 gain 比逐个 stop 稳（部分浏览器 stop 会抛）
    for (const n of liveNodes) {
      try { if (n && typeof n.disconnect === 'function') n.disconnect() } catch (e) { }
      try { if (n && typeof n.stop === 'function') n.stop() } catch (e) { }
    }
    liveNodes = []
  }

  return { start, stop, isRinging: () => ringing }
}
