import { deepFreeze } from '../shared/immutable.js'
/**
 * client/melody.ts —— 琴声播放（WebAudio 振荡器，不碰 React）
 *
 * 原来 NOTE_FREQ / playMelody / stopMelody 直接摊在 client.ts 的组件作用域里，
 * 既没法单独测，也和组件状态混在一起。这里收成一个可创建/销毁的播放器：
 *   const player = createMelodyPlayer()
 *   player.play(notes, bpm, onDone)
 *   player.stop()
 *
 * 行为与旧实现一致：先停旧曲子再开新曲子；不支持的浏览器静默返回；
 * onDone 在最后一个音符播完后 300ms 触发。
 */

/** 音符表：覆盖 C3–E6（含升降号），与 data/melodies.json 实际用到的音名对齐 */
export const NOTE_FREQ: Record<string, number> = {
  'C3': 130.81, 'C#3': 138.59, 'D3': 146.83, 'D#3': 155.56, 'E3': 164.81, 'F3': 174.61,
  'F#3': 185.00, 'G3': 196.00, 'G#3': 207.65, 'A3': 220.00, 'A#3': 233.08, 'B3': 246.94,
  'C4': 261.63, 'C#4': 277.18, 'D4': 293.66, 'D#4': 311.13, 'E4': 329.63, 'F4': 349.23,
  'F#4': 369.99, 'G4': 392.00, 'G#4': 415.30, 'A4': 440.00, 'A#4': 466.16, 'B4': 493.88,
  'C5': 523.25, 'C#5': 554.37, 'D5': 587.33, 'D#5': 622.25, 'E5': 659.25, 'F5': 698.46,
  'F#5': 739.99, 'G5': 783.99, 'G#5': 830.61, 'A5': 880.00, 'A#5': 932.33, 'B5': 987.77,
  'C6': 1046.50, 'C#6': 1108.73, 'D6': 1174.66, 'D#6': 1244.51, 'E6': 1318.51,
}
deepFreeze(NOTE_FREQ)

/** 拍长（秒）：bpm 低于 60 按 60 算，与旧实现一致 */
export function beatSeconds(bpm: number): number {
  return 60 / Math.max(60, Number(bpm) || 100)
}

/** 预估时长（秒）：所有时值之和 × 拍长，保留一位小数 */
export function estimateMelodySeconds(notes: any[], bpm: number): number {
  let beats = 0
  for (const pair of notes || []) {
    const d = Number(pair && pair[1])
    beats += isFinite(d) && d > 0 ? d : 1
  }
  return Math.round(beats * beatSeconds(bpm) * 10) / 10
}

export type MelodyPlayer = {
  play: (notes: any[], bpm: number, onDone?: () => void) => void
  stop: () => void
}

export function createMelodyPlayer(): MelodyPlayer {
  // AudioContext 复用：每次 play 都 new 再 close 会撞 Chrome 的 context 上限
  // （同时存在的 context 约 6 个），连点几首后 new AudioContext() 直接抛错，整首静音。
  let ctx: any = null
  let oscs: any[] = []
  let doneTimer: any = null
  // 播放代次：stop 或下一次 play 之后，旧曲排队中的 resume 回调必须作废
  let seq = 0

  function ensureCtx(): any {
    try {
      const AC = (typeof window !== 'undefined' ? (window as any).AudioContext : null)
        || (typeof window !== 'undefined' ? (window as any).webkitAudioContext : null)
      if (!AC) return null
      if (!ctx || ctx.state === 'closed') ctx = new AC()
      return ctx
    } catch (e) { return null }
  }

  /** 只停音符与计时器，不动 AudioContext（switch 曲目时用） */
  function stopNotes(): void {
    for (const o of oscs) { try { o.stop() } catch (e) { } }
    oscs = []
    if (doneTimer) { try { clearTimeout(doneTimer) } catch (e) { } doneTimer = null }
  }

  function stop(): void {
    seq++
    stopNotes()
    // 挂起而不是 close：复用同一个上下文，页面卸载时由浏览器统一回收
    try {
      if (ctx && ctx.state !== 'closed' && typeof ctx.suspend === 'function') {
        const p = ctx.suspend()
        if (p && typeof p.catch === 'function') p.catch(() => { })
      }
    } catch (e) { }
  }

  function play(notes: any[], bpm: number, onDone?: () => void): void {
    try {
      stopNotes()
      const my = ++seq
      const c = ensureCtx()
      if (!c) return
      const beat = beatSeconds(bpm)

      const schedule = (): void => {
        if (my !== seq) return
        try {
          let t = (Number(c.currentTime) || 0) + 0.05
          const local: any[] = []
          for (const pair of notes || []) {
            const nm = String(pair && pair[0])
            const rawDur = Number(pair && pair[1])
            // 负数 / 0 / NaN 都按一拍：时值非法时不能把时间轴往回拨
            const dur = isFinite(rawDur) && rawDur > 0 ? rawDur : 1
            const f = NOTE_FREQ[nm]
            if (!f) { t += dur * beat; continue }
            // 单个音符排程失败不能连坐整首（例如 stop 时刻已过 / 参数被拒绝）
            try {
              const o = c.createOscillator()
              const g = c.createGain()
              o.frequency.value = f
              o.type = 'sine'
              g.gain.setValueAtTime(0.3, t)
              g.gain.exponentialRampToValueAtTime(0.001, t + dur * beat * 0.95)
              o.connect(g)
              g.connect(c.destination)
              o.start(t)
              o.stop(t + dur * beat)
              local.push(o)
            } catch (e) { }
            t += dur * beat
          }
          oscs = local
          // 全部音符播完的时刻 = 当前累计时间 t（AudioContext 时间轴）
          const totalMs = Math.max(0, (t - (Number(c.currentTime) || 0)) * 1000) + 300
          if (onDone) {
            doneTimer = setTimeout(() => {
              doneTimer = null
              if (my !== seq) return
              try { onDone() } catch (e) { }
            }, totalMs)
          }
        } catch (e) { }
      }

      // 自动播放策略下 ctx 常是 suspended，此时 currentTime 冻结：直接排程会让
      // onDone 按"估计时长"提前触发、开头几个音符还没出声。resume() 是异步的，
      // 等它落定（无论成功/失败）再排程；stop/下一次 play 由 seq 作废旧回调。
      try {
        const p = typeof c.resume === 'function' ? c.resume() : null
        if (p && typeof p.then === 'function') p.then(schedule, schedule)
        else schedule()
      } catch (e) { schedule() }
    } catch (e) { }
  }

  return { play, stop }
}
