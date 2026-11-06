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
  /**
   * 上锁：ms 超出 [MIN, MAX] 时一律夹紧（0 与负数也走下限 8 秒）；NaN/非数按 60 秒兜底。
   *
   * 为什么 0 不映射成「不上锁」：空文本（estimateSpeakMs('') === 0）时 client.ts 那边
   * 仍然会把 narrating 标记置真，而它的自愈只能靠 expire() → resetNarration()。
   * 不上锁 = expire() 永远返回 false = narrating 卡死（P2 提醒会一直等空闲）。
   * 锁下限 8 秒既让它照常过期自愈，又不会像旧实现那样把 0 当非法值闭麦 60 秒。
   */
  lock: (ms: number) => void
  clear: () => void
  /** 现在是否处于叙述中 */
  active: (now?: number) => boolean
  /** 剩余毫秒（未上锁返回 0） */
  remaining: (now?: number) => number
  /** 到点自愈：过期就清锁并返回 true（与 active 同一条界线：t >= until 即到期） */
  expire: (now?: number) => boolean
}

export function createNarrationLock(): NarrationLock {
  let until = 0
  return {
    lock(ms: number): void {
      // 旧实现是 `Number(ms) || 60000`：0 / null 被当成"非法值"跳到 60 秒，
      // 于是「没有内容要念」也闭麦一分钟。夹紧到 [MIN, MAX] 才是文档写的语义。
      const n = ms == null ? NaN : Number(ms)
      const dur = Math.max(NARRATE_MIN_MS, Math.min(Number.isNaN(n) ? 60000 : n, NARRATE_MAX_MS))
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
      // 界线必须与 active() 一致：t === until 时 active 已返回 false，
      // 旧实现还要求 t > until 才清，于是「已不算叙述中」的锁要等下一个轮询周期才真被清掉。
      if (!until || t < until) return false
      until = 0
      return true
    },
  }
}
