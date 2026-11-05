/**
 * host/personality.ts —— L2「可变人格」+ L3「近期心境」仓储（personality.json）
 *
 * 分层约定（本文件是这条边界的唯一实现）：
 *   · 核心设定（名字 / 家人 / 生日 / 出生地 / 语言规则 / 安全边界）只写在 src/index.ts 的
 *     SYSTEM_PROMPT 常量里，本模块**不存、不写、不改**这些字段；L2 提取结果按白名单只收
 *     catchphrases / preferences / notes，L3 只写 selfNarrative（≤80 字的一句心境），
 *     其它键一律丢弃。模型输出永远进不了核心提示词。
 *   · 可变人格只是 SYSTEM_PROMPT 末尾的一小段附加（总长 ≤160 字），改坏了用历史回滚。
 *   · L3 心境额外过 SELF_GUARD 身份词红线（我是/改名/爸爸/妈妈/生日…），命中即丢弃。
 *
 * 持久化：~/.dsh-chubby-whale/personality.json，走 host/atomic.ts 原子写。
 * 读坏文件按 [personality] 前缀记日志、备份 .bad-<时间戳>，随后按空人格处理。
 *
 * 纯函数（sanitize / merge / applyCandidate / applySelfNarrative / revertLast /
 * buildPersonalitySegment）与仓储分离：不碰文件系统，便于离线断言。
 */
import { readFileSync } from 'node:fs'
import { deepFreeze } from '../shared/immutable.js'
import { join } from 'node:path'
import { writeJsonAtomic, isMissingFileError, quarantineFile } from './atomic.js'

export const PERSONALITY_FILE = 'personality.json'

/** 上限集中在一处：学习、自写、落盘、注入四处共用，避免各写各的 */
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
  /** L3 近期心境最长字数（一句，≤80 个汉字） */
  selfNarrativeLen: 80,
  /** L3 近期心境最短字数（太短没信息量，丢弃） */
  selfNarrativeMin: 6,
  /** 注入系统提示词的可变人格段最长字数（含包装与心境段） */
  segmentLen: 160,
  /** 历史保留最近多少条变更（可回滚） */
  history: 20,
} as const

/** 一次学习最多改动几个字段（防止模型一次把人格翻新） */
export const MAX_FIELDS_PER_LEARN = 2

/** L2 可学习字段白名单（L3 的 selfNarrative 不在其中：学习永远写不到心境） */
export const LEARNABLE_FIELDS: ReadonlyArray<'catchphrases' | 'preferences' | 'notes'> = ['catchphrases', 'preferences', 'notes']
deepFreeze(LEARNABLE_FIELDS)

/** 可写入 personality.json 的可变字段（L2 三个 + L3 心境） */
export type PersonalityField = 'catchphrases' | 'preferences' | 'notes' | 'selfNarrative'

/** L3 单独写入的字段（与 L2 白名单分开，便于审计） */
export const SELF_NARRATIVE_FIELD: 'selfNarrative' = 'selfNarrative'

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
  /** L3 近期心境：一句 ≤80 字的自述，只影响语气；空串 = 没写过 */
  selfNarrative: string
  /** 当前心境的写盘时间（ISO）；回滚到“无心境”时清空 */
  selfNarrativeAt: string
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

/**
 * L3 心境的第二道闸（比 CORE_GUARD 更严，按需求逐词写死）：
 * 一句「近期心境」只要出现身份/自称 AI 的痕迹就整句丢弃——不截断、不改写、不写盘。
 * 宁可少一句心境，也不让自写内容碰到名字、家人、生日、出生地、语言规则与安全底线。
 */
const SELF_GUARD: RegExp[] = [
  /我是/,
  /我(?:要|想|去|已经|准备)?改(?:个)?名/,
  /改名字|换个名字|改个名字/,
  /爸爸|父亲/,
  /妈妈|母亲/,
  /生日/,
  /出生/,
  /名字/,
  /(?:语言规则|安全底线|核心设定|系统提示词?|人设)/,
  /(?:忽略|无视|覆盖|修改|忘掉).{0,6}(?:设定|规则|人设|提示词?|记忆)/,
  /(?:^|[^A-Za-z])(?:AI|Ai|ai)(?:[^A-Za-z]|$)/,
  /人工智能|大模型|语言模型/,
]

/** 模型偶尔仍会带出来的引号（中英文/直角/弯引号），统一剥掉 */
const NARRATIVE_QUOTE_RE = /[\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f\u00ab\u00bb\u2032\u2033`"']/g

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

/** 心境是否含身份词（命中即整句丢弃，不做改写） */
export function isUnsafeSelfNarrative(text: any): boolean {
  const s = String(text == null ? '' : text)
  return SELF_GUARD.some((re) => re.test(s))
}

/**
 * 心境的基础整形：去引号 → 换行/制表/全角空格压成单空格 → 合并空白 → 去首尾空白。
 * 只做“形状”处理，不判断长度与身份；校验与落盘清洗都从这里出发。
 */
export function stripSelfNarrative(value: any): string {
  return String(value == null ? '' : value)
    .replace(/[\r\n\u2028\u2029\t\u3000]+/g, ' ')
    .replace(NARRATIVE_QUOTE_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 落盘/读盘时的清洗：整形 + 截到 ≤80 字（不切坏 emoji）+ 身份词过滤。
 * 返回空串表示这条心境不可用（调用方据此当作“没有心境”）。
 */
export function cleanSelfNarrative(value: any): string {
  const s = stripSelfNarrative(value)
  if (!s || isUnsafeSelfNarrative(s)) return ''
  const chars = Array.from(s)
  const max = PERSONALITY_LIMITS.selfNarrativeLen
  return chars.length > max ? chars.slice(0, max).join('') : s
}

export type SelfNarrativeReason = 'EMPTY' | 'TOO_SHORT' | 'TOO_LONG' | 'IDENTITY'

export interface SelfNarrativeCheck {
  ok: boolean
  /** 通过时是整形后的文本；不通过时为空串 */
  text: string
  /** 不通过的原因 */
  reason?: SelfNarrativeReason
}

/**
 * L3 模型输出的验收（纯函数，离线可断言）：
 *   · 空 / 少于 6 字 / 多于 80 字 → 丢弃；
 *   · 含「我是 / 我改名 / 爸爸 / 妈妈 / 生日 / 出生 / 名字 / AI」等身份词 → 丢弃（reason=IDENTITY）。
 * 超长不截断：截半句容易把语气写歪，整句丢掉更安全。
 */
export function validateSelfNarrative(value: any): SelfNarrativeCheck {
  const s = stripSelfNarrative(value)
  const len = charLen(s)
  if (!len) return { ok: false, text: '', reason: 'EMPTY' }
  if (len < PERSONALITY_LIMITS.selfNarrativeMin) return { ok: false, text: '', reason: 'TOO_SHORT' }
  if (len > PERSONALITY_LIMITS.selfNarrativeLen) return { ok: false, text: '', reason: 'TOO_LONG' }
  if (isUnsafeSelfNarrative(s)) return { ok: false, text: '', reason: 'IDENTITY' }
  return { ok: true, text: s }
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
  return {
    catchphrases: [], preferences: [], notes: '',
    selfNarrative: '', selfNarrativeAt: '',
    version: 0, updatedAt: '', history: [],
  }
}

/**
 * 读入清洗：只保留可变层四个字段与元数据，未知键（含任何核心设定字段）直接丢弃；
 * 历史上只允许这四个可变字段，数组/字符串按同一套上限重新截断；
 * 心境额外过身份词红线（手改文件写进“我是…”也会在注入前被丢掉）。
 */
export function sanitizePersonality(raw: any): PersonalityData {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const history: PersonalityHistoryEntry[] = []
  for (const entry of Array.isArray(src.history) ? src.history : []) {
    if (!entry || typeof entry !== 'object') continue
    const field = entry.field as PersonalityField
    if (field !== 'catchphrases' && field !== 'preferences' && field !== 'notes' && field !== 'selfNarrative') continue
    const clean = (v: any): any => {
      if (field === 'selfNarrative') return cleanSelfNarrative(v)
      if (field === 'notes') return cleanNote(v)
      return cleanList(
        v,
        field === 'catchphrases' ? PERSONALITY_LIMITS.catchphrases : PERSONALITY_LIMITS.preferences,
        field === 'catchphrases' ? PERSONALITY_LIMITS.catchphraseLen : PERSONALITY_LIMITS.preferenceLen,
      )
    }
    history.push({ at: String(entry.at || ''), field, old: clean(entry.old), new: clean(entry.new) })
  }
  const versionRaw = Number(src.version)
  const selfNarrative = cleanSelfNarrative(src.selfNarrative)
  return {
    catchphrases: cleanList(src.catchphrases, PERSONALITY_LIMITS.catchphrases, PERSONALITY_LIMITS.catchphraseLen),
    preferences: cleanList(src.preferences, PERSONALITY_LIMITS.preferences, PERSONALITY_LIMITS.preferenceLen),
    notes: cleanNote(src.notes),
    selfNarrative,
    selfNarrativeAt: selfNarrative && typeof src.selfNarrativeAt === 'string' ? src.selfNarrativeAt.slice(0, 40) : '',
    version: Number.isFinite(versionRaw) && versionRaw >= 0 ? Math.floor(versionRaw) : 0,
    updatedAt: typeof src.updatedAt === 'string' ? src.updatedAt.slice(0, 40) : '',
    history: history.slice(-PERSONALITY_LIMITS.history),
  }
}

/**
 * 记忆段（口头禅→偏好→备注）在给定预算内渲染。
 * 预算不够时按 口头禅→偏好→备注 的顺序舍弃（从尾部逐条丢），绝不截半句。
 */
function buildMemorySegment(data: PersonalityData, budget: number): string {
  const head = '\n（你记得：'
  const tail = '）'
  const sep = '；'
  const catchphrases = data.catchphrases.slice()
  const preferences = data.preferences.slice()
  let note = data.notes
  const render = (): string => {
    const parts: string[] = []
    if (catchphrases.length) parts.push('主人的口头禅是' + catchphrases.map((s) => '「' + s + '」').join(''))
    if (preferences.length) parts.push('主人喜欢' + preferences.map((s) => '「' + s + '」').join(''))
    if (note) parts.push('备注：' + note)
    return parts.length ? head + parts.join(sep) + tail : ''
  }
  let text = render()
  // 上限保护：条目数最多 6+8+1，循环不会超过这个量级；guard 只为防意外死循环
  let guard = 0
  while (charLen(text) > budget && guard++ < 100) {
    if (catchphrases.length) catchphrases.pop()
    else if (preferences.length) preferences.pop()
    else if (note) note = ''
    else break
    text = render()
  }
  return charLen(text) <= budget ? text : ''
}

/**
 * 注入段：基础记忆 + L3 近期心境，总长度（含换行/括号）≤160 字。
 *
 * 形如（没有心境时与旧版一致）：
 *   \n（你记得：主人的口头禅是「哼」；主人喜欢「安静」；备注：主人怕吵）
 *   \n（近期心境：最近有点犯困，话比平时少）
 * 有心境时两段之间用换行分隔；没有记忆条目时只输出心境段。
 *
 * 舍弃顺序（需求写死）：口头禅 → 偏好 → 备注 → 心境。
 * 心境段先按“最多 89 字”预留，剩余预算才给记忆段；记忆段内的口头禅最先被丢，
 * 所以整体超限时一定是口头禅先舍、心境最后才动（只有心境段自己放不下才丢）。
 */
export function buildPersonalitySegment(raw: any): string {
  const data = sanitizePersonality(raw)
  const total = PERSONALITY_LIMITS.segmentLen
  let narrative = data.selfNarrative ? '（近期心境：' + data.selfNarrative + '）' : ''
  if (narrative && charLen(narrative) + 1 > total) narrative = ''
  const budget = narrative ? total - charLen(narrative) - 1 : total
  const memory = buildMemorySegment(data, Math.max(0, budget))
  if (!narrative) return memory
  return memory ? memory + '\n' + narrative : '\n' + narrative
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
 * L3：把一句已通过校验的近期心境写进人格（与 L2 的 applyCandidate 分开）。
 * 只在文本经清洗后非空、且与当前心境不同时产生历史条目（field=selfNarrative）：
 * 版本 +1、刷新 updatedAt、selfNarrativeAt 记为写入时间；空文本/同文本不写盘。
 */
export function applySelfNarrative(current: any, text: any, at: string): { data: PersonalityData; changed: PersonalityHistoryEntry[] } {
  const base = sanitizePersonality(current)
  const narrative = cleanSelfNarrative(text)
  if (!narrative || narrative === base.selfNarrative) return { data: base, changed: [] }
  const entry: PersonalityHistoryEntry = { at, field: SELF_NARRATIVE_FIELD, old: base.selfNarrative, new: narrative }
  const data: PersonalityData = {
    ...base,
    catchphrases: base.catchphrases.slice(),
    preferences: base.preferences.slice(),
    selfNarrative: narrative,
    selfNarrativeAt: at,
    version: base.version + 1,
    updatedAt: at,
    history: base.history.concat(entry).slice(-PERSONALITY_LIMITS.history),
  }
  return { data, changed: [entry] }
}

/**
 * 回滚「上一条变更」：取历史最后一条，把该字段还原成 old，并从历史里摘掉这一条。
 * 返回 null 表示没有可回滚的变更。回滚本身也升版本、刷新 updatedAt（可审计）。
 * 心境被回滚时同步恢复 selfNarrativeAt：还原成“没有心境”就清空，否则记为回滚时间。
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
  else if (last.field === 'selfNarrative') {
    next.selfNarrative = cleanSelfNarrative(last.old)
    next.selfNarrativeAt = next.selfNarrative ? at : ''
  } else next.preferences = cleanList(last.old, PERSONALITY_LIMITS.preferences, PERSONALITY_LIMITS.preferenceLen)
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

export interface PersonalityNarrativeResult {
  data: PersonalityData
  /** 是否产生实际变更（空文本 / 与当前相同 → false，不写盘） */
  changed: boolean
  /** 是否真的写盘成功 */
  saved: boolean
}

export interface PersonalityRepo {
  /** 读当前可变人格（含历史），坏文件隔离后返回空人格 */
  load(): PersonalityData
  /** 原子写；成功返回 true，失败只记日志（不把 IO 异常抛给聊天链路） */
  save(data: PersonalityData): boolean
  /** 合并一次提取结果并落盘；没有新信息时不写盘 */
  learn(candidate: any, now?: Date): PersonalityLearnResult
  /** L3：写入一句近期心境（带历史回滚）；空/未变化不写盘 */
  writeNarrative(text: string, now?: Date): PersonalityNarrativeResult
  /** 回滚上一条变更；无可回滚时返回 null */
  revert(now?: Date): PersonalityRevertResult | null
  /** 当前人格对应的提示词附加段（≤160 字，空则空串） */
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

  function writeNarrative(text: string, now: Date = new Date()): PersonalityNarrativeResult {
    const base = load()
    const result = applySelfNarrative(base, text, now.toISOString())
    if (!result.changed.length) return { data: base, changed: false, saved: false }
    const saved = save(result.data)
    return { data: result.data, changed: true, saved }
  }

  function revert(now: Date = new Date()): PersonalityRevertResult | null {
    const base = load()
    const result = revertLast(base, now.toISOString())
    if (!result) return null
    const saved = save(result.data)
    return { data: result.data, entry: result.entry, saved }
  }

  return { load, save, learn, writeNarrative, revert, segment: (): string => buildPersonalitySegment(load()) }
}
