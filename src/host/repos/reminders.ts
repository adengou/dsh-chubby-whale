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
    const rep = Math.round(Number(repeat) || 0)
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
        let nextMs = when + rep * 1000
        let guard = 0
        while (nextMs <= now && guard++ < 10000) nextMs += rep * 1000
        r.nextAt = new Date(nextMs).toISOString()
        r.at = r.nextAt
        r.fired = false
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
