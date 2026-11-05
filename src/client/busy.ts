/**
 * client/busy.ts —— 忙碌锁 + 请求纪元（纯状态，不碰 React）
 *
 * 旧实现用三个散落的变量维持同一件事：busy state（UI）、busyRef（给定时器读）、
 * busyAtRef（超时自愈）。闭包里读到的 busy 经常是旧值，只能靠 ref 兜。
 * 这里收成一个权威状态对象：UI 只订阅它，判断只问它。
 *
 * 纪元（epoch）用于「主人已经问了新问题，旧回复作废」：
 *   const ep = epoch.next() … 回来时 if (!epoch.isCurrent(ep)) return
 */

/** 请求占线超过这么久就自动解锁（原 35 秒） */
export const BUSY_STALE_MS = 35000

export type BusyLock = {
  /** 开始一次占线请求 */
  begin: (now?: number) => void
  /** 结束占线（无论成功失败都要调） */
  end: () => void
  isBusy: () => boolean
  /** 已经占线多久（毫秒） */
  age: (now?: number) => number
  /** 超过 staleMs 自动解锁，返回 true 表示本次刚复位（供诊断计数） */
  watchdog: (now?: number) => boolean
}

export function createBusyLock(opts?: { staleMs?: number }): BusyLock {
  const staleMs = Math.max(1000, Number(opts && opts.staleMs) || BUSY_STALE_MS)
  let busy = false
  let beganAt = 0
  return {
    begin(now?: number): void {
      busy = true
      beganAt = typeof now === 'number' ? now : Date.now()
    },
    end(): void {
      busy = false
    },
    isBusy(): boolean {
      return busy
    },
    age(now?: number): number {
      if (!busy) return 0
      const t = typeof now === 'number' ? now : Date.now()
      return Math.max(0, t - beganAt)
    },
    watchdog(now?: number): boolean {
      const t = typeof now === 'number' ? now : Date.now()
      if (!busy) return false
      if (t - beganAt <= staleMs) return false
      busy = false
      return true
    },
  }
}

export type Epoch = {
  /** 开一个新纪元，返回纪元号 */
  next: () => number
  current: () => number
  isCurrent: (e: number) => boolean
}

export function createEpoch(): Epoch {
  let cur = 0
  return {
    next(): number { cur += 1; return cur },
    current(): number { return cur },
    isCurrent(e: number): boolean { return e === cur },
  }
}
