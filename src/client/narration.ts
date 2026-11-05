/**
 * client/narration.ts —— 叙述锁（念诗/说书期间不把麦克风拾到的话当新发言）
 *
 * 旧实现是 client.ts 里的 narrateUntil 变量 + setNarrating/clearNarrating 两个函数
 * + 2 秒轮询里的一段「过期强制解锁」。最后那段一度写得又深又绕（同一轮 clear 两遍），
 * 这里收成显式状态机：lock / clear / active / expire，行为只有一种解释。
 */

/** 锁时长下限（太短等于没锁） */
export const NARRATE_MIN_MS = 8000
/** 锁时长上限：绝不能"忘了解锁"把耳朵永久关掉 */
export const NARRATE_MAX_MS = 5 * 60 * 1000

export type NarrationLock = {
  /** 上锁：ms 超出 [MIN, MAX] 时自动夹紧，非法值按 60 秒 */
  lock: (ms: number) => void
  clear: () => void
  /** 现在是否处于叙述中 */
  active: (now?: number) => boolean
  /** 剩余毫秒（未上锁返回 0） */
  remaining: (now?: number) => number
  /** 到点自愈：过期就清锁并返回 true */
  expire: (now?: number) => boolean
}

export function createNarrationLock(): NarrationLock {
  let until = 0
  return {
    lock(ms: number): void {
      const dur = Math.max(NARRATE_MIN_MS, Math.min(Number(ms) || 60000, NARRATE_MAX_MS))
      until = Date.now() + dur
    },
    clear(): void { until = 0 },
    active(now?: number): boolean {
      const t = typeof now === 'number' ? now : Date.now()
      return until > 0 && t < until
    },
    remaining(now?: number): number {
      const t = typeof now === 'number' ? now : Date.now()
      return until > 0 ? Math.max(0, until - t) : 0
    },
    expire(now?: number): boolean {
      const t = typeof now === 'number' ? now : Date.now()
      if (!until || t <= until) return false
      until = 0
      return true
    },
  }
}
