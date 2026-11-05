/**
 * host/data/normalize.ts —— 本地/云端两种数据源的共同规范化
 *
 * 数据源不同、磁盘结构也不同（本地 poems.json 一整个文件，云端 poems-00..14 分片；
 * 本地 culture/*.json 是数组，云端外层套 {items}；本地 duilian 是 {items}，
 * 云端是 {cats}）。把清洗、字段映射、去重集中在这里，本地实现与云端实现共用，
 * 保证切换数据源后路由拿到的结构完全一致（前端协议不变）。
 *
 * 本文件不碰磁盘、不碰网络，只做纯函数转换。
 */
import type { StoryChunk } from '../story/repo.js'
import type { CultureKind, DailyItem, DuilianData, DuilianItem } from '../ports.js'

/** 说书段落：与 host/story/repo.ts 原 normalizeBook 完全一致；index 用原数组序号（进度 key） */
export function normalizeStoryChunks(book: string, raw: any): StoryChunk[] {
  const out: StoryChunk[] = []
  if (!Array.isArray(raw)) return out
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (!c || typeof c !== 'object') continue
    const text = String(c.text == null ? '' : c.text)
    if (!text.trim()) continue
    out.push({
      book: String(c.book || book),
      title: String(c.title || ''),
      piece: Number(c.piece) || 1,
      total: Number(c.total) || 1,
      text,
      index: i,
    })
  }
  return out
}

/**
 * 诗的去重键：同题不同作很多（蝶恋花/浣溪沙 等），键里加上首句前 12 字。
 * poem 路由记录「已念过」也用它，保证与数据规范化口径一致。
 */
export function poemKeyOf(p: any): string {
  const first = Array.isArray(p?.lines) ? String(p.lines[0] || '') : String(p?.text || '')
  return String(p?.title || '') + '|' + String(p?.author || '') + '|' + first.slice(0, 12)
}

/** 诗词条目：只留路由用到的字段，标题/首句为空的丢掉，按 poemKeyOf 去重 */
export function normalizePoemItems(raw: any): any[] {
  const arr = Array.isArray(raw) ? raw : []
  const out: any[] = []
  const keys = new Set<string>()
  for (const p of arr) {
    if (!p || typeof p !== 'object') continue
    const title = String(p.title || '').trim()
    if (!title) continue
    const lines = Array.isArray(p.lines) ? p.lines.map((x: any) => String(x || '').trim()).filter(Boolean) : []
    if (lines.length === 0) continue
    const item = {
      type: String(p.type || ''),
      dynasty: String(p.dynasty || ''),
      title,
      author: String(p.author || ''),
      lines,
    }
    const k = poemKeyOf(item)
    if (keys.has(k)) continue
    keys.add(k)
    out.push(item)
  }
  return out
}

/** 文化条目的去重键：成语/典故按名称，民间故事按「书名|标题」 */
export function cultureKeyOf(kind: CultureKind, item: any): string {
  if (kind === 'chengyu' || kind === 'idiom') return String(item?.name || '').trim()
  return (String(item?.book || '') + '|' + String(item?.title || '')).trim()
}

/** 文化条目：只保留对象、丢弃空键、按 cultureKeyOf 去重（保留第一条） */
export function normalizeCultureItems(kind: CultureKind, raw: any): any[] {
  const arr = Array.isArray(raw) ? raw : []
  const out: any[] = []
  const keys = new Set<string>()
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue
    const k = cultureKeyOf(kind, it)
    if (!k || keys.has(k)) continue
    keys.add(k)
    out.push(it)
  }
  return out
}

/**
 * 对联：本地 {items:[{upper,lower,source,cat}]}，云端 {total,cats:{分类:[...]}}。
 * 统一输出 items（拍平）与 cats（按分类），按上下联去重。
 */
export function normalizeDuilian(raw: any): DuilianData {
  const items: DuilianItem[] = []
  const cats: Record<string, DuilianItem[]> = {}
  const seen = new Set<string>()
  const push = (x: any, fallbackCat: string): void => {
    if (!x || typeof x !== 'object') return
    const upper = String(x.upper == null ? '' : x.upper).trim()
    const lower = String(x.lower == null ? '' : x.lower).trim()
    if (!upper && !lower) return
    const key = upper + '|' + lower
    if (seen.has(key)) return
    seen.add(key)
    const cat = String(x.cat == null ? '' : x.cat).trim() || fallbackCat
    const item: DuilianItem = { upper, lower }
    if (x.source) item.source = String(x.source)
    item.cat = cat
    items.push(item)
    const bucket = cats[cat] || (cats[cat] = [])
    bucket.push(item)
  }

  if (raw && raw.cats && typeof raw.cats === 'object' && !Array.isArray(raw.cats)) {
    for (const cat of Object.keys(raw.cats)) {
      const list = raw.cats[cat]
      if (!Array.isArray(list)) continue
      for (const x of list) push(x, cat)
    }
  } else if (raw && Array.isArray(raw.items)) {
    for (const x of raw.items) push(x, '')
  } else if (Array.isArray(raw)) {
    for (const x of raw) push(x, '')
  }

  const data: DuilianData = {
    total: Number(raw && raw.total) || items.length,
    items,
    cats,
  }
  if (raw && typeof raw.note === 'string' && raw.note) data.note = raw.note
  return data
}

/** 每日一句：丢掉缺 date/text 的条目 */
export function normalizeDaily(raw: any): DailyItem[] {
  const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.items) ? raw.items : [])
  const out: DailyItem[] = []
  for (const x of arr) {
    if (!x || typeof x !== 'object') continue
    const date = String(x.date || '').trim()
    const text = String(x.text || '').trim()
    if (!date || !text) continue
    const item: DailyItem = { date, type: String(x.type || ''), text }
    if (x.source) item.source = String(x.source)
    out.push(item)
  }
  return out
}
