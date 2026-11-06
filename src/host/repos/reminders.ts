/**
 * host/repos/reminders.ts —— 提醒仓储（reminders.json）
 *
 * 从 host/store.ts 拆出：新增、到期判定、重复提醒推进、删除都在这里。
 * 写盘走 host/atomic.ts；读坏文件按 [store] 前缀留痕并备份。
 * 读入容错 UTF-8 BOM，写出统一 UTF-8 无 BOM。
 */
import { join } from 'node:path'
import { writeJsonAtomic, isMissingFileError, quarantineFile, readTextNoBom } from '../atomic.js'

export interface ReminderRepo {
  loadReminders(): any[]
  saveReminders(arr: any[]): void
  addReminder(text: string, at: string, repeat?: number): any
  /** 找出已到期的提醒并推进下一次时间；返回本次到期的条目 */
  dueReminders(): any[]
  removeReminder(id: string): void
}

export function createReminderRepo(dataDir: string): ReminderRepo {
  const REMINDERS = join(dataDir, 'reminders.json')

  /** JS Date 能表示的最大毫秒数（±8.64e15，约 ±275760 年）；超过它 toISOString() 直接抛 RangeError */
  const MAX_DATE_MS = 8.64e15

  /**
   * 重复提醒的下一次触发时刻，保证**严格晚于 now**。
   *
   * 旧实现是 `while (nextMs <= now) nextMs += step`，最多 1 万次：
   *   · 间隔小、逾期久时（例如 route 允许的 60 秒间隔 + 逾期 8 天 = 11520 个周期），
   *     循环在仍早于 now 的地方停下，nextAt 留在过去 → 下一次轮询立刻再触发一遍，
   *     同一条提醒会连着响好几遍（实测第二次轮询仍返回该条）；
   *   · 间隔大到超出 Date 可表示范围时 new Date(nextMs).toISOString() 抛 RangeError，
   *     dueReminders 整份列表都取不出来（一条坏数据废掉全部提醒）。
   * 现在直接算「已经错过了几个间隔」（O(1)），再补一次兜住浮点误差。
   *
   * @returns 下一次触发的毫秒时间；无法落到合法时间（超大/非有限间隔）返回 null
   */
  function nextRepeatMs(when: number, repeatSec: number, now: number): number | null {
    const step = repeatSec * 1000
    if (!Number.isFinite(step) || step <= 0) return null
    const periods = Math.floor((now - when) / step) + 1   // 至少跨过 now 一个周期
    let nextMs = when + periods * step
    if (nextMs <= now) nextMs = when + (periods + 1) * step // 浮点误差兜底
    if (!Number.isFinite(nextMs) || nextMs <= now || nextMs > MAX_DATE_MS) return null
    return nextMs
  }

  function loadReminders(): any[] {
    try {
      const arr = JSON.parse(readTextNoBom(REMINDERS))
      if (Array.isArray(arr)) return arr
    } catch (err: any) {
      if (!isMissingFileError(err)) quarantineFile(REMINDERS, err, '[store]')
    }
    return []
  }
  function saveReminders(arr: any[]): void {
    try { writeJsonAtomic(REMINDERS, arr) } catch (err: any) { console.error('[store] WRITE-FAIL ' + String(REMINDERS) + ' err=' + String(err?.message || err)) }
  }
  function addReminder(text: string, at: string, repeat?: number): any {
    const arr = loadReminders()
    // repeat 只接受「有限正整数秒」：Infinity/NaN 落成 Infinity 会让 dueReminders 算出非法时间
    const repIn = Math.round(Number(repeat) || 0)
    const rep = Number.isFinite(repIn) && repIn > 0 ? repIn : 0
    const item = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      text,
      at,
      repeat: rep > 0 ? rep : null,
      nextAt: null,
      fired: false,
      done: false,
      remindCount: 0,
      createdAt: new Date().toISOString(),
    }
    arr.push(item)
    saveReminders(arr)
    return item
  }
  function dueReminders(): any[] {
    const arr = loadReminders()
    const now = Date.now()
    const due: any[] = []
    let changed = false
    for (const r of arr) {
      if (!r || r.done) continue                    // 已完成的一律跳过
      const stamp = r.nextAt || r.at
      if (!stamp) continue
      const when = new Date(stamp).getTime()
      if (!Number.isFinite(when) || when > now) continue
      if (r.fired) continue
      r.fired = true
      r.remindCount = (Number(r.remindCount) || 0) + 1
      due.push(r)
      changed = true
      const rep = Number(r.repeat) || 0
      if (rep > 0) {
        // 每天（或自定义间隔）的提醒：不标 done，只把下一次时间往后推
        // 从「原定时间」往后推，不用「触发时刻」——否则每天 9 点的提醒会一天比一天晚
        const nextMs = nextRepeatMs(when, rep, now)
        if (nextMs === null) {
          // 间隔落不到合法时间（超大/非有限）：退化成一次性，别让一条坏数据拖垮整份到点列表
          console.error('[store] REMINDER-REPEAT-OVERFLOW repeat=' + rep + ' at=' + String(stamp))
          r.done = true
        } else {
          r.nextAt = new Date(nextMs).toISOString()
          r.at = r.nextAt
          r.fired = false
        }
      } else {
        r.done = true
      }
    }
    if (changed) saveReminders(arr)
    return due
  }
  function removeReminder(id: string): void {
    saveReminders(loadReminders().filter((r: any) => r.id !== id))
  }

  return { loadReminders, saveReminders, addReminder, dueReminders, removeReminder }
}
