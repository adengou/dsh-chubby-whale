/**
 * host/backup/fields.ts —— 备份数据字段白名单、上限与导入清洗（纯函数）
 *
 * 从 routes/backup.ts 拆出（行为等价，安全修复见各函数注释）。这一层只做三件事：
 *   1) 定死可导出/可导入的 8 个数据字段与导出包元数据；
 *   2) 集中体积上限与字段级上限（条数、单条字符串长度），导入清洗与导出共用同一份口径；
 *   3) 把外部 JSON 逐字段重建成内部对象（只读白名单、只写新对象），非法值返回 null → skipped。
 *
 * 安全边界：
 *   · 字段名只认 BACKUP_DATA_FIELDS；`__proto__` / `constructor` 等原型链键既不是数据字段，
 *     也不会被当成清洗器查表命中（BACKUP_CLEANERS 用 null 原型 + 白名单双重判断）；
 *   · 动态键写入（growth.src / storyProgress）跳过 `__proto__` / `constructor` / `prototype`，
 *     只写自有属性，避免把外部键名变成原型污染跳板；
 *   · personality 先过 sanitizePersonality（可变层四字段 + 上限），再补一道 CORE_GUARD：
 *     L3 心境与心境历史是外部 JSON 直接给的内容，必须与 L2 学习同一道身份词闸门。
 *
 * 本文件不读盘、不写盘、不 import 任何路由/仓储实现。
 */
import { deepFreeze } from '../../shared/immutable.js'
import { clipCodePoints } from '../../shared/text.js'
import { sanitizePersonality, isSafeLearnedText } from '../personality.js'

/** 备份体积上限：2MB（导出超限 413；导入 body 超限 413） */
export const BACKUP_MAX_BYTES = 2 * 1024 * 1024

/** 可导出的数据字段（导入白名单同一份：只接受这 8 个） */
export const BACKUP_DATA_FIELDS = [
  'memory', 'personality', 'state', 'growth', 'fishfood', 'pet', 'reminders', 'storyProgress',
] as const

export type BackupDataField = (typeof BACKUP_DATA_FIELDS)[number]

/** 导出包自带的元数据：导入时认识，但不写盘（防止把版本号/时间戳当数据） */
export const BACKUP_META_FIELDS = ['ok', 'version', 'exportedAt'] as const

/**
 * 字段级上限（导入清洗与导出共用）。
 *
 * 取值依据：
 *   · memoryHistory=40 与 host/repos/memory.ts 的 MEMORY_LIMIT 同口径：入库本来只留最新 40 条，
 *     导入层先截断，保证「导入的内存占用 / 落盘文件大小」与运行时一致；
 *   · memoryContentLen=8000 / memorySummaryLen=2000：正常聊天单条远低于此，但 2MB 请求体
 *     内可以塞 40 条各 50KB 的「聊天内容」，不设上限会把 memory.json 撑到 2MB 并拖慢每次读盘；
 *   · reminders=200：正常提醒是个位数，2MB 内可塞数万条；dueReminders 每次全量遍历，
 *     不设上限会把一次误导入变成长期的同步遍历负担；
 *   · growthSources=50 / storyEntries=2000 / storyKeyLen=400：动态键对象的上限，
 *     正常数据（5 个经验来源、17 本书的说书进度）远低于上限，留足余量。
 */
export const BACKUP_LIMITS = deepFreeze({
  memoryHistory: 40,
  memoryContentLen: 8000,
  memorySummaryLen: 2000,
  reminders: 200,
  reminderTextLen: 200,
  reminderStampLen: 40,
  growthSources: 50,
  storyEntries: 2000,
  storyKeyLen: 400,
})

/** 普通对象（数组、null、函数都不算） */
export function isPlainObject(v: any): boolean {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

/** 有限数字（严格 typeof number；字符串数字不算，类型校验不放松） */
function isNum(v: any): boolean {
  return typeof v === 'number' && Number.isFinite(v)
}

function toNonNegInt(v: any): number {
  return isNum(v) ? Math.max(0, Math.floor(v)) : 0
}

/**
 * token 类整数的上限：与 repos/fishfood.ts 的 MAX_TOKEN（Number.MAX_SAFE_INTEGER）同一口径。
 *
 * 审计修复（2026-11-07 B99 备份分身取证）：这里原来只做 `Math.max(0, Math.floor(v))`，
 * 而仓储的 cleanToken 会在 Number.MAX_SAFE_INTEGER 封顶。于是导入一个 `chatTokens: 1e308`
 * 的包会把 1e308 原样写进 fishfood.json（仓储自己都不接受的写法），面板显示 1e+308、
 * 后续 addTokens 再把总量一次性夹回上限——等于一次导入就把真实账目变成垃圾数。
 * 导入层必须与仓储同口径，不能比仓储更宽松。
 */
const MAX_TOKEN = Number.MAX_SAFE_INTEGER

/** 非负 token 整数：向下取整 + 安全整数封顶 */
function toToken(v: any): number {
  return Math.min(MAX_TOKEN, Math.max(0, Math.floor(v)))
}

/**
 * 外部 JSON 字段的「字」上限：按 Unicode 码点截断（B101）。
 *
 * 旧实现 `String(v).slice(0, max)` 按 UTF-16 码元切：导入一份 reminderTextLen=200
 * 的提醒正文时，200 个 emoji 会被砍成 100 个；199 个汉字 + emoji 时第 200 个码元
 * 是代理对前半截 → 孤立代理项写进 reminders.json / personality.json / memory.json
 * （UTF-8 落盘成 U+FFFD）。备份导入的上限口径与运行时一致：都是「字」= 码点。
 */
function clip(v: any, max: number): string {
  return clipCodePoints(v == null ? '' : v, max)
}

/** 动态键里永远不写的三个名字（会命中对象原型/构造器语义） */
const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype']

/** 外部 JSON 给的键名是否允许直接写进内部对象 */
function isUnsafeKey(key: string): boolean {
  return UNSAFE_KEYS.indexOf(key) >= 0
}

// ===== 导入：逐字段类型清洗（非法返回 null → skipped） =====

/**
 * 聊天记忆：{history:[{role,content}], summary}；老格式（整份就是数组）也认。
 *
 * 审计修复 F1（2026-11-06）：history 先截到 40 条（与 repos/memory.ts 的 MEMORY_LIMIT 一致，
 * 保留最新），单条 content ≤8000 字、summary ≤2000 字。原实现不设上限，导入后由仓储
 * 的 slice(-40) 兜底条数，但单条长度与 summary 没有任何上限，2MB 内的请求可把 memory.json
 * 写到接近 2MB，之后每次聊天读盘都要解析这份大文件。
 */
export function cleanMemory(value: any): { history: any[]; summary: string } | null {
  const cleanTurns = (raw: any): any[] | null => {
    if (!Array.isArray(raw)) return null
    const out: any[] = []
    for (const t of raw) {
      if (!isPlainObject(t)) continue
      const role = t.role === 'user' || t.role === 'assistant' ? t.role : ''
      if (!role || typeof t.content !== 'string') continue
      out.push({ role, content: clip(t.content, BACKUP_LIMITS.memoryContentLen) })
    }
    // 与运行时的「只留最新 40 条」同口径；不截断会让导入后的内存/文件超过仓储预期
    if (out.length > BACKUP_LIMITS.memoryHistory) return out.slice(-BACKUP_LIMITS.memoryHistory)
    // 非空数组全是坏项 → 当非法（审计修复 2026-11-07 B99，与 cleanReminders 的「全坏不误清空」同口径）：
    // 旧实现会返回 []，于是「history 里全是 role:system / content 不是字符串的条目」这种脏包
    // 会被当成「主人本来就没有记忆」，把已有 history 清空。空数组 `[]` 仍然合法（那是真备份的形状）。
    return out.length === 0 && raw.length > 0 ? null : out
  }
  if (Array.isArray(value)) {
    const history = cleanTurns(value)
    return history === null ? null : { history, summary: '' }
  }
  if (!isPlainObject(value)) return null
  // 缺键的包按非法处理（审计修复 2026-11-07 B99）：memory 的形状固定是 {history, summary}，
  // 导出从第一版起就同时给这两个键，所以真备份永远两键齐全。
  // 旧实现只缺一个键也照写：`{summary:'x'}` 把已有 history 写成 []、`{history:[...]}` 把 summary 写成 ''。
  // 那等于「字段缺失」去覆盖主人已有的另一半记忆——与「整字段覆盖」不是一回事（缺的不是值，是整个键）。
  if (!('history' in value) || !('summary' in value)) return null
  const history = cleanTurns(value.history)
  if (history === null) return null
  if (typeof value.summary !== 'string') return null
  return { history, summary: clip(value.summary, BACKUP_LIMITS.memorySummaryLen) }
}

/** 亲密度：{intimacy:number} */
export function cleanState(value: any): { intimacy: number } | null {
  if (!isPlainObject(value) || !isNum(value.intimacy)) return null
  return { intimacy: Math.max(0, Math.floor(value.intimacy)) }
}

/**
 * 成长：{exp:number, dayKey?:string, dayExp?:number, src?:{来源:number}}
 *
 * 审计修复 F2（2026-11-06）：src 是外部 JSON 提供的动态键对象。原实现直接
 * `src[clip(k, 20)] = 数值`，`__proto__` / `constructor` / `prototype` 会被当作普通属性写入
 * （当前值都是数字，改不了 Object.prototype，但键名语义已偏离，且一旦以后写入对象值
 * 就会变成原型污染跳板）。现在跳过这三个键，并限制来源数量 ≤50。
 */
export function cleanGrowth(value: any): any | null {
  if (!isPlainObject(value) || !isNum(value.exp)) return null
  const out: any = { exp: Math.max(0, Math.floor(value.exp)) }
  if (typeof value.dayKey === 'string') out.dayKey = clip(value.dayKey, 20)
  if (isNum(value.dayExp)) out.dayExp = Math.max(0, Math.floor(value.dayExp))
  if (isPlainObject(value.src)) {
    const src: any = {}
    let kept = 0
    for (const k of Object.keys(value.src)) {
      if (kept >= BACKUP_LIMITS.growthSources) break
      if (isUnsafeKey(k) || !isNum(value.src[k])) continue
      const key = clip(k, 20)
      if (isUnsafeKey(key)) continue
      src[key] = Math.max(0, Math.floor(value.src[k]))
      kept++
    }
    out.src = src
  }
  return out
}

/** 鱼粮：token 计数与日/月滚动标记 */
/** 金额清洗：非负有限，保留 6 位小数（与 fishfood 记账精度一致），上限 1e9 防脏值 */
function cleanCost(value: any): number | null {
  if (!isNum(value)) return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(Math.min(1e9, n) * 1e6) / 1e6
}

/** 鱼账本分桶的固定四个来源（多出来的键一律丢弃，避免备份包夹带未知结构） */
const FISHFOOD_KINDS = ['chat', 'story', 'summary', 'personality']
/** 每个桶的六个数值字段 */
const BUCKET_NUM_FIELDS = ['tokens', 'costCny', 'dayTokens', 'dayCostCny', 'monthTokens', 'monthCostCny']

export function cleanFishfood(value: any): any | null {
  if (!isPlainObject(value)) return null
  const out: any = {}
  for (const k of ['chatTokens', 'storyTokens', 'totalTokens', 'monthTokens', 'dayTokens']) {
    if (isNum(value[k])) out[k] = toToken(value[k])
  }
  // 鱼账本（2026-11-07 B98）：输入/输出拆分、缓存命中、人民币与分桶以前会被这份白名单过滤掉，
  // 于是「备份 — 导入」一轮后金额和分桶归零（token 总量还在，钱不见了）。这里补齐 round-trip；
  // 字段形状与 src/host/repos/fishfood.ts 的同名清洗函数保持一致（含安全整数封顶）。
  for (const k of ['promptTokens', 'completionTokens', 'cacheHitTokens']) {
    if (isNum(value[k])) out[k] = toToken(value[k])
  }
  for (const k of ['costCny', 'dayCostCny', 'monthCostCny']) {
    const v = cleanCost(value[k])
    if (v !== null) out[k] = v
  }
  if (isPlainObject(value.byKind)) {
    const buckets: any = {}
    for (const kind of FISHFOOD_KINDS) {
      const src = value.byKind[kind]
      if (!isPlainObject(src)) continue
      const b: any = {}
      for (const f of BUCKET_NUM_FIELDS) {
        const raw = src[f]
        if (!isNum(raw)) continue
        // 注意大小写：字段是 dayCostCny / monthCostCny（大写 C），用正则不能用 indexOf('cost')
        if (/cost/i.test(f)) {
          const v = cleanCost(raw)
          if (v !== null) b[f] = v
        } else {
          // 负数直接丢弃（不夹成 0：写个 0 等于声称「这一桶确实是 0」，与「数据脏」不是一件事）
          const n = Math.floor(raw)
          if (n >= 0) b[f] = Math.min(MAX_TOKEN, n)
        }
      }
      if (Object.keys(b).length) buckets[kind] = b
    }
    if (Object.keys(buckets).length) out.byKind = buckets
  }
  if (typeof value.day === 'string') out.day = clip(value.day, 20)
  if (typeof value.month === 'string') out.month = clip(value.month, 20)
  return Object.keys(out).length ? out : null
}

/** 宠物：数值项 + 心情字符串 */
export function cleanPet(value: any): any | null {
  if (!isPlainObject(value)) return null
  const out: any = {}
  // lastFeedAt：喂食时刻（mood 的 happy 窗口要用它；漏掉会让导入后情绪退回 normal）
  for (const k of ['feeds', 'lastSeen', 'lastFeedAt', 'intimacy']) {
    if (isNum(value[k])) out[k] = Math.max(0, Math.floor(value[k]))
  }
  // 饥饿度是连续量，不能向下取整（审计修复 2026-11-07 B99）：repos/pet.ts 的 cleanHunger
  // 只夹到 [0,100] 不取整，tickPet 会按离线时长写出 21.5 这类小数。导入层取整会让
  // 「备份 → 导入 → 再导出」把 21.5 变成 21，与本机自己写出的值不一致。
  if (isNum(value.hunger)) out.hunger = Math.max(0, Math.min(100, value.hunger))
  if (typeof value.mood === 'string') out.mood = clip(value.mood, 20)
  return Object.keys(out).length ? out : null
}

/**
 * 提醒：数组，逐项重建（坏项丢弃）；非空数组全是坏项 → null，避免误清空。
 *
 * 审计修复 F3（2026-11-06）：最多保留最新 200 条（与 memory 的“保留最新”同口径）。
 * 原实现不设上限，2MB 内可写入数万条；写盘后 dueReminders 每次轮询都全量遍历。
 * 备注：过去时间的 `at` 仍按原样保留，下一次 dueReminders 会立即触发一次——这是
 * 备份恢复的语义（恢复后提醒照常到点），本次审计只报告、不改数据含义。
 */
export function cleanReminders(value: any): any[] | null {
  if (!Array.isArray(value)) return null
  const out: any[] = []
  for (const r of value) {
    if (!isPlainObject(r)) continue
    if (typeof r.text !== 'string' || !r.text.trim()) continue
    if (typeof r.at !== 'string' || !r.at.trim()) continue
    const at = clip(r.at, BACKUP_LIMITS.reminderStampLen)
    // 与 routes/reminders.ts:44 同口径：at 必须能解析成真实时间才收（审计修复 2026-11-07 B99）。
    // 旧实现只判「非空字符串」，`at: "not-a-date"` 会原样落盘，而 dueReminders 用
    // `new Date(stamp).getTime()` 判到期——非有限数直接 continue，于是这条提醒永远不响，
    // 主人却看到它好好地躺在列表里（比直接跳过更坏：静默失效）。
    if (!Number.isFinite(new Date(at).getTime())) continue
    const nextRaw = typeof r.nextAt === 'string' ? clip(r.nextAt, BACKUP_LIMITS.reminderStampLen) : ''
    // dueReminders 取 `r.nextAt || r.at`：留一个解析不了的 nextAt 会把合法的 at 挡死。
    // 解析不了就当没有下一次时间，回落到 at（恢复后照常到点）。
    const nextAt = nextRaw && Number.isFinite(new Date(nextRaw).getTime()) ? nextRaw : null
    out.push({
      id: typeof r.id === 'string' && r.id ? clip(r.id, 64) : Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      text: clip(r.text, BACKUP_LIMITS.reminderTextLen),
      at,
      // repeat 与路由同口径：只接受 60s ~ 7 天（routes/reminders.ts:43）。
      // 导入的是外部 JSON，此前只判 >0：repeat=1e15 这类值会落到仓储，
      // 算出超出 Date 表示范围的 nextAt（toISOString 抛 RangeError，整份提醒都取不出来）。
      repeat: isNum(r.repeat) && r.repeat >= 60 && r.repeat <= 86400 * 7 ? Math.round(r.repeat) : null,
      nextAt,
      fired: r.fired === true,
      done: r.done === true,
      remindCount: toNonNegInt(r.remindCount),
      createdAt: typeof r.createdAt === 'string' ? clip(r.createdAt, BACKUP_LIMITS.reminderStampLen) : new Date().toISOString(),
    })
  }
  if (out.length === 0 && value.length > 0) return null
  return out.length > BACKUP_LIMITS.reminders ? out.slice(-BACKUP_LIMITS.reminders) : out
}

/**
 * 说书进度：{'书|段': true, _current:'书名'}；没有任何合法项 → null，避免误清空。
 *
 * 审计修复 F4（2026-11-06）：跳过 `__proto__` / `constructor` / `prototype` 键，条目上限 2000。
 * 原实现把任意键名直接写到 `out[...]`，虽当前值固定为 true（不构成原型污染），
 * 但键名会原样保存到 story_progress.json，不应允许外部 JSON 控制 `__proto__` 这类保留名。
 */
export function cleanStoryProgress(value: any): any | null {
  if (!isPlainObject(value)) return null
  const out: any = {}
  let kept = 0
  for (const k of Object.keys(value)) {
    if (kept >= BACKUP_LIMITS.storyEntries) break
    if (isUnsafeKey(k)) continue
    if (k === '_current') {
      if (typeof value[k] === 'string' && value[k]) {
        out._current = clip(value[k], 40)
        kept++
      }
      continue
    }
    if (value[k] === true) {
      const key = clip(k, BACKUP_LIMITS.storyKeyLen)
      if (!isUnsafeKey(key)) {
        out[key] = true
        kept++
      }
    }
  }
  return kept > 0 ? out : null
}

/** 心境历史值是否可用（空串是合法的“原有/现有心境为空”，非空才过 CORE_GUARD） */
function isSafeNarrativeValue(v: any): boolean {
  return v === '' || isSafeLearnedText(v)
}

/**
 * 人格：只走 sanitizePersonality（可变层四字段 + 元数据），核心设定永远进不来。
 *
 * 审计修复 F5（2026-11-06）：补一道 CORE_GUARD。sanitizePersonality 对 L2 学习内容
 * （口头禅/偏好/备注）用 CORE_GUARD 过滤，但 selfNarrative 只过 L3 的 SELF_GUARD；
 * 导入是外部 JSON 直接指定心境，SELF_GUARD 不拦「本鲸叫旺财」这类「自称 + 叫」结构，
 * 而 CORE_GUARD 会拦。这里对当前心境与心境历史（回滚会把 old 恢复成当前心境）
 * 再走一遍 isSafeLearnedText，命中即清空/丢弃该条历史，保证“导入写不进核心设定”的承诺成立。
 * 注：personality.ts 门面没有暴露 CORE_GUARD 词表，这里只调用它导出的判定函数，不另抄词表。
 *
 * 审计修复（2026-11-07 B99）：没有任何可变层字段的包不再写盘。
 * 旧实现把 `{}` / `{name:'旺财'}`（只有核心设定键）都 sanitize 成“全空人格”并落盘，
 * 等于一次误导入把主人的口头禅/偏好/备注/心境历史全清掉，且 imported 报告还说“成功”。
 * 与 cleanMemory 的「空对象没有可写内容」同一道闸；真备份一定四键齐全（导出走 sanitizePersonality，
 * 永远是四个可变层字段），所以这里不会误杀任何真实备份包。
 */
const PERSONALITY_CONTENT_KEYS = ['catchphrases', 'preferences', 'notes', 'selfNarrative']

export function cleanPersonality(value: any): any | null {
  if (!isPlainObject(value)) return null
  if (!PERSONALITY_CONTENT_KEYS.some((k) => k in value)) return null
  const data = sanitizePersonality(value)
  if (data.selfNarrative && !isSafeLearnedText(data.selfNarrative)) {
    data.selfNarrative = ''
    data.selfNarrativeAt = ''
  }
  data.history = data.history.filter((entry: any) => (
    entry.field !== 'selfNarrative' || (isSafeNarrativeValue(entry.old) && isSafeNarrativeValue(entry.new))
  ))
  return data
}

type Cleaner = (value: any) => any | null

/**
 * 字段 → 清洗器（与 BACKUP_DATA_FIELDS 一一对应）。
 *
 * 用 null 原型：即使调用方漏做白名单判断，`BACKUP_CLEANERS['__proto__']` / `['constructor']`
 * 也不会命中原型链上的对象，避免“查表得到一个非函数/非空值”的隐式行为。
 */
export const BACKUP_CLEANERS: Record<BackupDataField, Cleaner> = Object.assign(Object.create(null), {
  memory: cleanMemory,
  personality: cleanPersonality,
  state: cleanState,
  growth: cleanGrowth,
  fishfood: cleanFishfood,
  pet: cleanPet,
  reminders: cleanReminders,
  storyProgress: cleanStoryProgress,
})
deepFreeze(BACKUP_CLEANERS)

/** 字段名是否是备份数据字段（显式白名单，不查原型链） */
export function isBackupDataField(name: string): name is BackupDataField {
  return (BACKUP_DATA_FIELDS as ReadonlyArray<string>).indexOf(name) >= 0
}
