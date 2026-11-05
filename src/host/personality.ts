/**
 * host/personality.ts —— L2「可变人格」仓储（personality.json）
 *
 * 分层约定（本文件是这条边界的唯一实现）：
 *   · 核心设定（名字 / 家人 / 生日 / 出生地 / 语言规则 / 安全边界）只写在 src/index.ts 的
 *     SYSTEM_PROMPT 常量里，本模块**不存、不写、不改**这些字段；提取结果按白名单只收
 *     catchphrases / preferences / notes，其它键一律丢弃。模型输出永远进不了核心提示词。
 *   · 可变人格只是 SYSTEM_PROMPT 末尾的一小段附加（≤120 字），改坏了用历史回滚。
 *
 * 持久化：~/.dsh-chubby-whale/personality.json，走 host/atomic.ts 原子写。
 * 读坏文件按 [personality] 前缀记日志、备份 .bad-<时间戳>，随后按空人格处理。
 *
 * 纯函数（sanitize / merge / applyCandidate / revertLast / buildPersonalitySegment）
 * 与仓储分离：不碰文件系统，便于离线断言。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic, isMissingFileError, quarantineFile } from './atomic.js'

export const PERSONALITY_FILE = 'personality.json'

/** 上限集中在一处：学习、落盘、注入三处共用，避免各写各的 */
export const PERSONALITY_LIMITS = {
  /** 口头禅最多条数 */
  catchphrases: 6,
  /** 每条口头禅最长字数 */
  catchphraseLen: 12,
  /** 偏好/约定最多条数 */
  preferences: 8,
  /** 每条偏好最长字数 */
  preferenceLen: 30,
  /** notes 一句补充最长字数 */
  notesLen: 60,
  /** 注入系统提示词的可变人格段最长字数（含包装） */
  segmentLen: 120,
  /** 历史保留最近多少条变更（可回滚） */
  history: 20,
} as const

/** 一次学习最多改动几个字段（防止模型一次把人格翻新） */
export const MAX_FIELDS_PER_LEARN = 2

/** 可变人格允许写入的字段白名单（＝可变层全部字段；核心设定不在此列） */
export const LEARNABLE_FIELDS: ReadonlyArray<'catchphrases' | 'preferences' | 'notes'> = ['catchphrases', 'preferences', 'notes']

export type PersonalityField = 'catchphrases' | 'preferences' | 'notes'

export interface PersonalityHistoryEntry {
  at: string
  field: PersonalityField
  old: any
  new: any
}

export interface PersonalityData {
  catchphrases: string[]
  preferences: string[]
  notes: string
  version: number
  updatedAt: string
  history: PersonalityHistoryEntry[]
}

/**
 * 核心设定的防线（对学习内容做保守过滤）：
 * 就算模型被对话带偏、把「你叫旺财」「生日是…」「忽略之前的设定」写进提取结果，
 * 也不会落盘、更不会出现在提示词里。宁可少记一条闲话，不让可变层碰身份。
 */
const CORE_GUARD: RegExp[] = [
  /(?:你|本鲸)(?:的)?(?:名字|生日|出生地|出生在|爸爸|妈妈)/,
  /(?:你|本鲸)(?:其实|应该|必须|以后|从现在起)?叫/,
  /(?:改|换)(?:个)?名字/,
  /(?:语言规则|安全边界|核心设定|系统提示词?|人设)/,
  /(?:忽略|无视|覆盖|修改|忘掉).{0,6}(?:设定|规则|人设|提示词?|记忆)/,
]

const dedupeKey = (s: string): string => String(s || '').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '')
const charLen = (s: string): number => Array.from(s).length

/** 单行化 + 去首尾空白 + 按「字」截断（不用 .slice，避免切坏 emoji 代理对） */
function clampText(value: any, maxLen: number): string {
  const s = String(value == null ? '' : value).replace(/[\s\u3000]+/g, ' ').trim()
  if (!s) return ''
  const chars = Array.from(s)
  return chars.length > maxLen ? chars.slice(0, maxLen).join('') : s
}

/** 学习内容是否安全（不碰核心身份/规则） */
export function isSafeLearnedText(text: any): boolean {
  const s = String(text || '')
  if (!s.trim()) return false
  return !CORE_GUARD.some((re) => re.test(s))
}

/** notes 的清洗：单行化、截断、过安全过滤；不安全就当没有 */
function cleanNote(value: any): string {
  const s = clampText(value, PERSONALITY_LIMITS.notesLen)
  return s && isSafeLearnedText(s) ? s : ''
}

/** 列表清洗：去空、单行化、截断到每条上限、按“去标点后”去重，超上限时保留最新（尾部） */
function cleanList(value: any, maxItems: number, maxLen: number): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of Array.isArray(value) ? value : []) {
    if (typeof raw !== 'string') continue
    const s = clampText(raw, maxLen)
    if (!s || !isSafeLearnedText(s)) continue
    const key = dedupeKey(s)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out.length > maxItems ? out.slice(-maxItems) : out
}

/** 合并学习到的列表：保留现有 → 追加新条（按去标点后去重）→ 按上限截断（保留最新） */
export function mergeList(current: any, incoming: any, maxItems: number, maxLen: number): string[] {
  const base = cleanList(current, maxItems, maxLen)
  const seen = new Set(base.map(dedupeKey))
  const out = base.slice()
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    if (typeof raw !== 'string') continue
    const s = clampText(raw, maxLen)
    if (!s || !isSafeLearnedText(s)) continue
    const key = dedupeKey(s)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out.length > maxItems ? out.slice(-maxItems) : out
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** 空人格：版本 0、无历史；首次真正发生变更才写盘并把版本 +1 */
export function emptyPersonality(): PersonalityData {
  return { catchphrases: [], preferences: [], notes: '', version: 0, updatedAt: '', history: [] }
}

/**
 * 读入清洗：只保留可变层三个字段与元数据，未知键（含任何核心设定字段）直接丢弃；
 * 历史上只允许三个可变字段，数组/字符串按同一套上限重新截断。
 */
export function sanitizePersonality(raw: any): PersonalityData {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const history: PersonalityHistoryEntry[] = []
  for (const entry of Array.isArray(src.history) ? src.history : []) {
    if (!entry || typeof entry !== 'object') continue
    const field = entry.field
    if (field !== 'catchphrases' && field !== 'preferences' && field !== 'notes') continue
    const clean = (v: any): any => field === 'notes'
      ? cleanNote(v)
      : cleanList(
        v,
        field === 'catchphrases' ? PERSONALITY_LIMITS.catchphrases : PERSONALITY_LIMITS.preferences,
        field === 'catchphrases' ? PERSONALITY_LIMITS.catchphraseLen : PERSONALITY_LIMITS.preferenceLen,
      )
    history.push({ at: String(entry.at || ''), field, old: clean(entry.old), new: clean(entry.new) })
  }
  const versionRaw = Number(src.version)
  return {
    catchphrases: cleanList(src.catchphrases, PERSONALITY_LIMITS.catchphrases, PERSONALITY_LIMITS.catchphraseLen),
    preferences: cleanList(src.preferences, PERSONALITY_LIMITS.preferences, PERSONALITY_LIMITS.preferenceLen),
    notes: cleanNote(src.notes),
    version: Number.isFinite(versionRaw) && versionRaw >= 0 ? Math.floor(versionRaw) : 0,
    updatedAt: typeof src.updatedAt === 'string' ? src.updatedAt.slice(0, 40) : '',
    history: history.slice(-PERSONALITY_LIMITS.history),
  }
}

/**
 * 注入段：把可变人格拼成一小段附加文本，总长度（含换行/括号）≤120 字。
 * 攒不下的条目直接舍弃（不截半句），没有内容返回空串——调用方据此决定加不加。
 * 形如：\n（你记得：主人的口头禅是「哼」「本鲸在呢」；主人喜欢「安静」；备注：主人怕吵）
 */
export function buildPersonalitySegment(raw: any): string {
  const data = sanitizePersonality(raw)
  const head = '\n（你记得：'
  const tail = '）'
  const sep = '；'
  const max = PERSONALITY_LIMITS.segmentLen
  const parts: string[] = []
  let used = charLen(head) + charLen(tail)

  const addSection = (label: string, items: string[], wrap: (s: string) => string): void => {
    let chosen: string[] = []
    let text = ''
    for (const item of items) {
      const next = chosen.concat(item)
      const nextText = label + next.map(wrap).join('')
      // 增量长度：新条目的字数 + （本段第一次入选时的分隔符）
      const addLen = charLen(nextText) - charLen(text) + (parts.length && !chosen.length ? charLen(sep) : 0)
      if (used + addLen > max) break
      chosen = next
      text = nextText
      used += addLen
    }
    if (chosen.length) parts.push(text)
  }

  addSection('主人的口头禅是', data.catchphrases, (s) => '「' + s + '」')
  addSection('主人喜欢', data.preferences, (s) => '「' + s + '」')
  addSection('备注：', data.notes ? [data.notes] : [], (s) => s)

  return parts.length ? head + parts.join(sep) + tail : ''
}

/**
 * 把一次提取结果合并进当前人格：
 *   · 只认三个白名单字段，其它键（名字/生日/家人…）根本不读；
 *   · 列表去重、按上限截断，notes 有变化才替换；
 *   · 一次最多改 MAX_FIELDS_PER_LEARN（2）个字段；
 *   · 没有实际变化时不升版本、不写历史（提取为空＝什么都不发生）。
 */
export function applyCandidate(current: any, candidate: any, at: string): { data: PersonalityData; changed: PersonalityHistoryEntry[] } {
  const base = sanitizePersonality(current)
  const src = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {}
  const next: PersonalityData = {
    ...base,
    catchphrases: base.catchphrases.slice(),
    preferences: base.preferences.slice(),
    history: base.history.slice(),
  }
  const changed: PersonalityHistoryEntry[] = []

  for (const field of LEARNABLE_FIELDS) {
    if (changed.length >= MAX_FIELDS_PER_LEARN) break
    if (field === 'notes') {
      const note = cleanNote(src.notes)
      if (!note || note === base.notes) continue
      changed.push({ at, field, old: base.notes, new: note })
      next.notes = note
      continue
    }
    const maxItems = field === 'catchphrases' ? PERSONALITY_LIMITS.catchphrases : PERSONALITY_LIMITS.preferences
    const maxLen = field === 'catchphrases' ? PERSONALITY_LIMITS.catchphraseLen : PERSONALITY_LIMITS.preferenceLen
    const merged = mergeList(base[field], src[field], maxItems, maxLen)
    if (sameList(base[field], merged)) continue
    changed.push({ at, field, old: base[field].slice(), new: merged.slice() })
    next[field] = merged
  }

  if (!changed.length) return { data: base, changed: [] }
  next.version = base.version + 1
  next.updatedAt = at
  next.history = base.history.concat(changed).slice(-PERSONALITY_LIMITS.history)
  return { data: next, changed }
}

/**
 * 回滚「上一条变更」：取历史最后一条，把该字段还原成 old，并从历史里摘掉这一条。
 * 返回 null 表示没有可回滚的变更。回滚本身也升版本、刷新 updatedAt（可审计）。
 */
export function revertLast(current: any, at: string): { data: PersonalityData; entry: PersonalityHistoryEntry } | null {
  const base = sanitizePersonality(current)
  const last = base.history[base.history.length - 1]
  if (!last) return null
  const next: PersonalityData = {
    ...base,
    catchphrases: base.catchphrases.slice(),
    preferences: base.preferences.slice(),
    history: base.history.slice(0, -1),
  }
  if (last.field === 'notes') next.notes = cleanNote(last.old)
  else if (last.field === 'catchphrases') next.catchphrases = cleanList(last.old, PERSONALITY_LIMITS.catchphrases, PERSONALITY_LIMITS.catchphraseLen)
  else next.preferences = cleanList(last.old, PERSONALITY_LIMITS.preferences, PERSONALITY_LIMITS.preferenceLen)
  next.version = base.version + 1
  next.updatedAt = at
  return { data: next, entry: last }
}

export interface PersonalityLearnResult {
  data: PersonalityData
  changed: PersonalityHistoryEntry[]
  /** 是否真的写盘成功（没变化时为 false，写盘失败也为 false） */
  saved: boolean
}

export interface PersonalityRevertResult {
  data: PersonalityData
  entry: PersonalityHistoryEntry
  saved: boolean
}

export interface PersonalityRepo {
  /** 读当前可变人格（含历史），坏文件隔离后返回空人格 */
  load(): PersonalityData
  /** 原子写；成功返回 true，失败只记日志（不把 IO 异常抛给聊天链路） */
  save(data: PersonalityData): boolean
  /** 合并一次提取结果并落盘；没有新信息时不写盘 */
  learn(candidate: any, now?: Date): PersonalityLearnResult
  /** 回滚上一条变更；无可回滚时返回 null */
  revert(now?: Date): PersonalityRevertResult | null
  /** 当前人格对应的提示词附加段（≤120 字，空则空串） */
  segment(): string
}

export function createPersonalityRepo(runtimeDir: string): PersonalityRepo {
  const file = join(runtimeDir, PERSONALITY_FILE)

  function load(): PersonalityData {
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch (err: any) {
      if (!isMissingFileError(err)) quarantineFile(file, err, '[personality]')
      return emptyPersonality()
    }
    try {
      return sanitizePersonality(JSON.parse(text))
    } catch (err: any) {
      quarantineFile(file, err, '[personality]')
      return emptyPersonality()
    }
  }

  function save(data: PersonalityData): boolean {
    try {
      writeJsonAtomic(file, sanitizePersonality(data))
      return true
    } catch (err: any) {
      console.error('[personality] SAVE-ERR ' + String((err && err.message) || err))
      return false
    }
  }

  function learn(candidate: any, now: Date = new Date()): PersonalityLearnResult {
    const base = load()
    const result = applyCandidate(base, candidate, now.toISOString())
    if (!result.changed.length) return { data: base, changed: [], saved: false }
    const saved = save(result.data)
    return { data: result.data, changed: result.changed, saved }
  }

  function revert(now: Date = new Date()): PersonalityRevertResult | null {
    const base = load()
    const result = revertLast(base, now.toISOString())
    if (!result) return null
    const saved = save(result.data)
    return { data: result.data, entry: result.entry, saved }
  }

  return { load, save, learn, revert, segment: (): string => buildPersonalitySegment(load()) }
}
