/**
 * host/personality/merge.ts —— 可变人格的清洗、去重、合并与回滚（纯函数，不碰文件系统）
 *
 * 这一层回答四个问题，全部无副作用，离线可断言：
 *   · 一段外来文本能不能进人格？（CORE_GUARD / SELF_GUARD 判定在 model.ts 的词表上）
 *   · 列表怎么去重、怎么按上限淘汰？（按去标点/空白/符号后的 key 去重，超限留最新）
 *   · 一次学习最多改几个字段？（白名单 + MAX_FIELDS_PER_LEARN）
 *   · 回滚怎么撤？（取历史最后一条，恢复 old 并从历史摘掉）
 *
 * 仓储（createPersonalityRepo）在 store.ts，注入段渲染在 segment.ts；
 * 本文件不引入 node:fs，也不引用任何 host 其他模块。
 */
import {
  PERSONALITY_LIMITS,
  MAX_FIELDS_PER_LEARN,
  LEARNABLE_FIELDS,
  SELF_NARRATIVE_FIELD,
  CORE_GUARD,
  SELF_GUARD,
} from './model.js'
import type { PersonalityData, PersonalityField, PersonalityHistoryEntry } from './model.js'

/** 字符长度：按 Unicode 码点计，不用 .length（避免把 emoji 代理对算成两个） */
export function charLen(s: string): number {
  return Array.from(s).length
}

/** 去重 key：小写 + 去掉标点/符号/空白后再比较，避免「白饭」与「白饭！」各存一条 */
function dedupeKey(s: string): string {
  return String(s || '').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '')
}

/** 单行化 + 去首尾空白 + 按「字」截断（不用 .slice，避免切坏 emoji 代理对） */
function clampText(value: any, maxLen: number): string {
  const s = String(value == null ? '' : value).replace(/[\s\u3000]+/g, ' ').trim()
  if (!s) return ''
  const chars = Array.from(s)
  return chars.length > maxLen ? chars.slice(0, maxLen).join('') : s
}

/**
 * 按上限保留最新（尾部），丢掉最旧。
 *
 * 审计修复 F6（2026-11-06）：原实现直接 `out.slice(-maxItems)`，而 `slice(-0)` 等于 `slice(0)`
 * 会返回整个数组、负数会从头部反向截取，maxItems ≤ 0 或不是有限数时结果都不对。
 * 现在先把上限规整成非负整数，0 明确表示“一条都不留”。
 */
function keepNewest(items: string[], maxItems: number): string[] {
  const max = Math.max(0, Math.floor(Number(maxItems) || 0))
  if (max === 0) return []
  return items.length > max ? items.slice(-max) : items
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

/** 模型偶尔仍会带出来的引号（中英文/直角/弯引号），统一剥掉 */
const NARRATIVE_QUOTE_RE = /[\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f\u00ab\u00bb\u2032\u2033`"']/g

/**
 * 心境的基础整形：去引号 → 换行/制表/全角空格压成单空格 → 合并空白 → 去首尾空白。
 * 只做“形状”处理，不判断长度与身份；校验与落盘清洗都从这里出发。
 *
 * 审计修复 F4（2026-11-06）：原实现用 String(value) 强转，坏文件里写成对象/数字时
 * `{}` 会被整形成 "[object Object]" 并当成合法心境注入提示词。现在只接受字符串，
 * 其余类型一律按“没有心境”处理（模型输出本来就是字符串，正常路径行为不变）。
 */
export function stripSelfNarrative(value: any): string {
  if (typeof value !== 'string') return ''
  return value
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

/**
 * notes 的清洗：单行化、截断、过安全过滤；不安全就当没有。
 *
 * 审计修复 F3（2026-11-06）：原实现会对任意类型做 String 强转，坏文件或模型给出
 * `notes: {}` 时会写入 "[object Object]" 并进入提示词。现在只接受字符串。
 */
function cleanNote(value: any): string {
  if (typeof value !== 'string') return ''
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
  return keepNewest(out, maxItems)
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
  return keepNewest(out, maxItems)
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
 *
 * 审计修复 F5（2026-11-06）：历史条目的 at 与其他元数据字段一样截到 40 字符，
 * 防止坏文件里塞超长字符串把历史列表撑爆（updatedAt 原本就是 40）。
 *
 * 审计修复 F8（2026-11-07）：F5 只截了长度，at 仍走 String() 强转——坏文件里写成对象时
 * 会变成 "[object Object]"、写成数组时变成 "[a]" 这种假时间，与同函数里 updatedAt /
 * selfNarrativeAt 的「只接受字符串」口径不一致。现在 at 也只认字符串，其余类型按空串处理。
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
    history.push({ at: typeof entry.at === 'string' ? entry.at.slice(0, 40) : '', field, old: clean(entry.old), new: clean(entry.new) })
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
 * 把一次提取结果合并进当前人格：
 *   · 只认三个白名单字段，其它键（名字/生日/家人…）根本不读；
 *   · 列表去重、按上限截断，notes 有变化才替换；
 *   · 一次最多改 MAX_FIELDS_PER_LEARN（2）个字段；
 *   · 没有实际变化时不升版本、不写历史（提取为空＝什么都不发生）。
 *
 * 已知取舍（审计记录，不改）：字段按 catchphrases → preferences → notes 的固定顺序取，
 * 前两个字段只要有变化就占满 2 个名额，notes 会长期得不到学习机会。这是“一次最多改 2 个字段”
 * 的保守策略副作用；改成按变化量排序会让行为不可预测，暂不调整，留待产品明确。
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
 *
 * 已知取舍（审计记录，不改）：
 *   · 一次 learn 最多产生 2 条历史，本函数只撤最后 1 条，所以“回滚一次”撤的是“一条变更”
 *     而不是“一次学习”。路由/前端与既有测试都按“一条变更”定义，改语义会破坏契约。
 *   · 回滚到非空心境时 selfNarrativeAt 记回滚时间而非旧心境的原始写入时间：
 *     该字段的语义是“当前心境最近一次写盘时间”，回滚确实在 at 时刻写了盘，
 *     且自写器的 24 小时冷却会因此重新计时（避免回滚后立刻又生成一句）——按现语义是正确的；
 *     旧心境原始时间没有存进历史，无法精确恢复，也不值得为它扩历史结构。
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
