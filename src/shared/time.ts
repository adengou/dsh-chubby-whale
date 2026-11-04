/**
 * shared/time.ts —— 提醒口语时间解析（照 C# Reminders.cs 的 ParseDue / CleanText）
 * 纯函数，浏览器端调用、Node 端可单元验证。
 * 支持：9点 / 9:30 / 9点半 / 今天9点 / 明天9点 / 后天9点 /
 *       半小时后 / 20分钟后 / 一小时后 / 2小时后 / 2026-11-04 09:00 / 每天9点
 */

export interface ParsedDue {
  /** 到点时间（本地时区） */
  at: Date
  /** 重复间隔（秒）：每天 = 86400；不重复 = null */
  repeat: number | null
  /** 去掉时间词、去掉「提醒我」等前缀后的正文，可能为空 */
  cleaned: string
}

const DAY_MS = 86400000

/** 去掉「提醒我 / 叫我 / 记得」这类前缀和首尾标点 */
export function cleanReminderText(raw: string): string {
  let t = String(raw || '').trim()
  const leads = ['提醒我一下', '提醒一下', '提醒我', '提醒', '叫我一下', '叫我', '记得要', '记得', '到时候']
  let changed = true
  while (changed) {
    changed = false
    for (const lead of leads) {
      if (t.startsWith(lead)) { t = t.slice(lead.length).trim(); changed = true; break }
    }
  }
  t = t.replace(/^[，,。.：:、\s]+/, '').replace(/[，,。.：:、\s]+$/, '')
  return t
}

/**
 * 从一句话里解析提醒时间。解析不出返回 null。
 * @param now 当前时间（测试时可注入固定值）
 */
export function parseDue(raw: string, now: Date = new Date()): ParsedDue | null {
  const src = String(raw || '').trim()
  if (!src) return null
  const base = new Date(now.getTime())
  const daily = /每天|每日/.test(src)
  const done = (at: Date, stripped: string): ParsedDue => ({
    at,
    repeat: daily ? 86400 : null,
    cleaned: cleanReminderText(stripped.replace(/每天|每日/g, '')),
  })

  // 1) 明确日期时间：2026-11-04 09:00 / 2026-11-04T09:00
  let m = src.match(/(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/)
  if (m) {
    const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0)
    if (!isNaN(dt.getTime())) return done(dt, src.replace(m[0], '').trim())
  }

  // 2) 相对时间：半小时后 / 20分钟后 / 一小时后 / 2小时后
  m = src.match(/半小时(?:后|以后)?/)
  if (m) return done(new Date(base.getTime() + 30 * 60000), src.replace(m[0], '').trim())

  m = src.match(/(\d+)\s*分钟(?:后|以后)?/)
  if (m) {
    const mins = Math.max(1, Math.min(24 * 60, Number(m[1]) || 1))
    return done(new Date(base.getTime() + mins * 60000), src.replace(m[0], '').trim())
  }

  m = src.match(/(一小时|1小时)(?:后|以后)?/)
  if (m) return done(new Date(base.getTime() + 60 * 60000), src.replace(m[0], '').trim())

  m = src.match(/(\d+)\s*小时(?:后|以后)?/)
  if (m) {
    const hours = Math.max(1, Math.min(24 * 7, Number(m[1]) || 1))
    return done(new Date(base.getTime() + hours * 3600000), src.replace(m[0], '').trim())
  }

  // 3) 今天/明天/后天 + 9点 / 9:30 / 9点半
  const day = src.match(/(今天|明天|后天)/)
  const clock = src.match(/(\d{1,2})\s*(?:点|:|：)\s*(半|\d{2})?/)
  if (clock) {
    const h = Number(clock[1])
    if (Number.isFinite(h) && h >= 0 && h <= 23) {
      let minute = 0
      const mm = clock[2] || ''
      if (mm === '半') minute = 30
      else if (mm) minute = Math.max(0, Math.min(59, Number(mm) || 0))

      const dayStart = new Date(base.getFullYear(), base.getMonth(), base.getDate())
      let target = new Date(dayStart.getTime())
      if (day) {
        if (day[1] === '明天') target = new Date(dayStart.getTime() + DAY_MS)
        else if (day[1] === '后天') target = new Date(dayStart.getTime() + 2 * DAY_MS)
      }
      target.setHours(h, minute, 0, 0)
      // 没说「今天/明天/后天」且时间已过 → 顺延到明天
      if (!day && target.getTime() <= base.getTime()) target = new Date(target.getTime() + DAY_MS)

      let stripped = src.replace(clock[0], '').trim()
      if (day) stripped = stripped.replace(day[1], '').trim()
      return done(target, stripped)
    }
  }

  return null
}

/** 给气泡/清单用的友好时间文案 */
export function formatDue(at: Date, repeatSeconds?: number | null): string {
  const d = new Date(at.getTime())
  const now = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  const prefix = repeatSeconds && repeatSeconds > 0 ? '每天 ' : (sameDay ? '今天 ' : '')
  return prefix + hh + ':' + mm
}
