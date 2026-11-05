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
  for (const pair of notes || []) beats += Number(pair && pair[1]) || 1
  return Math.round(beats * beatSeconds(bpm) * 10) / 10
}

export type MelodyPlayer = {
  play: (notes: any[], bpm: number, onDone?: () => void) => void
  stop: () => void
}

export function createMelodyPlayer(): MelodyPlayer {
  let ctx: any = null
  let oscs: any[] = []
  let doneTimer: any = null

  function stop(): void {
    try { for (const o of oscs) { try { o.stop() } catch (e) { } } } catch (e) { }
    oscs = []
    try { if (doneTimer) { clearTimeout(doneTimer); doneTimer = null } } catch (e) { }
    try { if (ctx) ctx.close() } catch (e) { }
    ctx = null
  }

  function play(notes: any[], bpm: number, onDone?: () => void): void {
    try {
      stop()
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext
      if (!AC) return
      const c = new AC()
      ctx = c
      try { c.resume() } catch (e) { }
      // 显式等上下文真正跑起来：suspended 状态下排程的音符会被吞，听感就是"开头没弹"
      try { if (c.state === 'suspended') c.resume() } catch (e) { }
      const beat = beatSeconds(bpm)
      let t = c.currentTime + 0.05
      for (const pair of notes || []) {
        const nm = String(pair && pair[0])
        const dur = Number(pair && pair[1]) || 1
        const f = NOTE_FREQ[nm]
        if (!f) { t += dur * beat; continue }
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
        oscs.push(o)
        t += dur * beat
      }
      // 全部音符播完的时刻 = 当前累计时间 t（AudioContext 时间轴）
      const totalMs = Math.max(0, (t - c.currentTime) * 1000) + 300
      if (onDone) doneTimer = setTimeout(() => { try { onDone() } catch (e) { } }, totalMs)
    } catch (e) { }
  }

  return { play, stop }
}
