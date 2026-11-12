/**
 * client/nervous/dream.ts —— 夜潜：把事件流反刍成一条「鲸的回忆」（独立模块，可整体摘除）
 *
 * 架构位置：第一层事件流的**消费者**。事件流只负责记，这里负责在合适的时机读一次，
 * 把「昨天」压缩成两三句话。不调模型、不联网——句子是模板拼真实计数，绝不编事实。
 *
 * 三条边界：
 *   · 一天只做一次梦（同一天不重复生成）；
 *   · 昨天事件少于 MIN_EVENTS 条就不做梦（数据不够，宁可不说话）；
 *   · 只读事件类型与计数，不读正文（事件里本来也没有正文）。
 *
 * 存储：localStorage（key `chubby-nervous-dreams`，保留最近 7 条；已说过的日期另存一份）。
 */
import type { NervousEvent } from './stream.js'

/** 一天最多留几条梦 */
const MAX_DREAMS = 7
/** 少于这个事件数就不做梦：一天几乎没动静，硬编一句就成了假话 */
const MIN_EVENTS = 10
/** 已说过日期的保留条数 */
const MAX_SPOKEN = 30

const KEY_DREAMS = 'chubby-nervous-dreams'
const KEY_SPOKEN = 'chubby-nervous-dreams-spoken'

export type DreamEntry = {
  /** 梦见的是哪一天（本地日期 yyyy-mm-dd） */
  date: string
  /** 生成时刻 */
  at: number
  /** 一到三句梦话 */
  lines: string[]
}

export interface DreamBook {
  /** 满足条件才生成；同一天已生成过、或事件太少返回 null */
  maybeDream(events: NervousEvent[], now?: number): DreamEntry | null
  /** 最近一条梦（没有则 null） */
  latest(): DreamEntry | null
  /** 标记某天的梦已经说给主人听 */
  markSpoken(date: string): void
  /** 某天的梦是不是已经说过了 */
  spoken(date: string): boolean
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n)
}

/** 本地日期 → yyyy-mm-dd（不用 toISOString：那是 UTC，半夜会串天） */
function dayKey(ts: number): string {
  const d = new Date(ts)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

function readJSON(key: string, fallback: any): any {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const v = JSON.parse(raw)
    return v == null ? fallback : v
  } catch (e) {
    return fallback
  }
}

function writeJSON(key: string, value: any): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch (e) { }
}

/** 统计昨天的事件，拼出梦话；全部数字来自真实计数 */
function compose(mine: NervousEvent[]): string[] {
  let work = 0
  let tool = 0
  let err = 0
  let away = 0
  let night = 0
  for (const e of mine) {
    if (e.type === 'work') work++
    else if (e.type === 'away') away++
    else if (e.type === 'tick') {
      if (e.data && (e.data as any).night) night++
    } else if (e.type === 'host') {
      const name = String(((e.data && ((e.data as any).name || (e.data as any).event)) || ''))
      if (name.indexOf('tool/') === 0) tool++
      if (/error|fail|abort|crash/i.test(name)) err++
    }
  }
  const lines: string[] = []
  if (tool > 0) lines.push('昨晚梦见你在那边跑东西，人家在旁边数水花，数到 ' + tool + ' 次。')
  if (work > 0) lines.push('还梦见你让人家念稿子、看材料，一共 ' + work + ' 回。')
  if (err > 0) lines.push('中间有几回出了岔子，人家尾巴都绷紧了。')
  if (night > 0) lines.push('你熬到很晚，人家困得直冒泡。')
  if (away > 0 && lines.length < 2) lines.push('有几段时间你不在，人家对着墙角发了会儿呆。')
  if (!lines.length) lines.push('昨晚你的动静不多，人家睡得模模糊糊。')
  return lines.slice(0, 3)
}

export function createDreamBook(): DreamBook {
  return {
    maybeDream(events: NervousEvent[], now: number = Date.now()): DreamEntry | null {
      if (!Array.isArray(events)) return null
      const yesterday = dayKey(now - 24 * 3600 * 1000)
      const dreams: DreamEntry[] = readJSON(KEY_DREAMS, [])
      if (!Array.isArray(dreams)) return null
      // 同一天已经做过梦：不重复生成（重复生成会让「昨晚梦见」天天变样，反而假）
      for (const d of dreams) {
        if (d && d.date === yesterday) return null
      }
      const mine = events.filter((e) => Boolean(e) && Number.isFinite(e.at) && dayKey(e.at) === yesterday)
      if (mine.length < MIN_EVENTS) return null
      const entry: DreamEntry = { date: yesterday, at: now, lines: compose(mine) }
      dreams.push(entry)
      writeJSON(KEY_DREAMS, dreams.slice(-MAX_DREAMS))
      return entry
    },

    latest(): DreamEntry | null {
      const dreams: DreamEntry[] = readJSON(KEY_DREAMS, [])
      if (!Array.isArray(dreams) || !dreams.length) return null
      const last = dreams[dreams.length - 1]
      return last && Array.isArray(last.lines) ? last : null
    },

    markSpoken(date: string): void {
      const spoken: string[] = readJSON(KEY_SPOKEN, [])
      if (!Array.isArray(spoken)) return
      if (spoken.indexOf(date) >= 0) return
      spoken.push(date)
      writeJSON(KEY_SPOKEN, spoken.slice(-MAX_SPOKEN))
    },

    spoken(date: string): boolean {
      const spoken: string[] = readJSON(KEY_SPOKEN, [])
      return Array.isArray(spoken) && spoken.indexOf(date) >= 0
    },
  }
}
