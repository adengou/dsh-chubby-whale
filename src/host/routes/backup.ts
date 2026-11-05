/**
 * host/routes/backup.ts —— 一键备份 / 导入
 *
 *   GET  /api/chubby-whale/data/export   导出（JSON，≤2MB，超了 413）
 *   POST /api/chubby-whale/data/import   导入（body ≤2MB，超了 413）
 *
 * 安全边界（写死在本文件的设计里，不靠调用方自觉）：
 *   · 导出只经注入的 load* 读取记忆/人格/状态/成长/鱼粮/宠物/提醒/说书进度，
 *     **不读 config.json、不读环境变量、不 import host/config.ts**——API Key 没有进入导出包的通路；
 *   · 导入只认 8 个数据字段，逐字段过类型清洗后经注入的 save* 原子写落盘；
 *     **没有任何写 config.json / 改 Key 的分支**；version / exportedAt / ok 是导出包元数据，
 *     认识但不写盘；其余字段一律进 skipped 并计数（apiKey、deepseekKey、config 之类）；
 *   · 人格导入再过一遍 sanitizePersonality：模型/手改文件都写不进核心设定（名字/家人/生日/语言规则）。
 *
 * 体积：导出先序列化再量字节数，超限回 413 不带部分数据；导入用 readJsonBody 的上限，超限回 413。
 * 写盘复用各仓储自己的 writeJsonAtomic（host/atomic.ts），本文件不额外落任何新文件。
 */
import { sendJson, sendError } from '../respond.js'
import { readJsonBody } from '../body.js'
import { sendTooLarge } from '../http.js'
import { sanitizePersonality } from '../personality.js'

/** 备份体积上限：2MB（导出超限 413；导入 body 超限 413） */
export const BACKUP_MAX_BYTES = 2 * 1024 * 1024

/** 可导出的数据字段（导入白名单同一份：只接受这 8 个） */
export const BACKUP_DATA_FIELDS = [
  'memory', 'personality', 'state', 'growth', 'fishfood', 'pet', 'reminders', 'storyProgress',
] as const

export type BackupDataField = (typeof BACKUP_DATA_FIELDS)[number]

/** 导出包自带的元数据：导入时认识，但不写盘（防止把版本号/时间戳当数据） */
export const BACKUP_META_FIELDS = ['ok', 'version', 'exportedAt'] as const

export interface BackupDeps {
  /** 插件版本（导出包里的 version） */
  version?: string
  /** 读聊天记忆（history + summary） */
  loadMemory: () => { history?: any[]; summary?: string }
  /** 写聊天记忆；host/index 里组合成 store.saveHistory + store.saveMemorySummary */
  saveMemory?: (m: { history: any[]; summary: string }) => void
  loadPersonality: () => any
  /** 返回 false 表示写盘失败（PersonalityRepo.save 的约定） */
  savePersonality?: (p: any) => boolean
  loadState: () => any
  saveState?: (obj: any) => void
  loadGrowth: () => any
  saveGrowth?: (obj: any) => void
  loadFishfood: () => any
  saveFishfood?: (obj: any) => void
  loadPet: () => any
  savePet?: (obj: any) => void
  loadReminders: () => any[]
  saveReminders?: (arr: any[]) => void
  loadStoryProgress: () => any
  saveStoryProgress?: (obj: any) => void
  /** 说书进度导入后刷新播放器内存，否则它下一次保存会把旧进度盖回去 */
  onStoryProgressImported?: () => void
  now?: () => Date
}

const isPlainObject = (v: any): boolean => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/** 有限数字（严格 typeof number；字符串数字不算，类型校验不放松） */
const isNum = (v: any): boolean => typeof v === 'number' && Number.isFinite(v)
const toNonNegInt = (v: any): number => (isNum(v) ? Math.max(0, Math.floor(v)) : 0)
const clip = (v: any, max: number): string => String(v == null ? '' : v).slice(0, max)

// ===== 导出 =====

/**
 * 组装导出包。只读现有数据，不含 Key（本函数拿不到 config 的任何读取器）。
 * 字段取值尽量保真：状态/成长/鱼粮/宠物/提醒/说书进度原样带出，人格只出可变层四字段。
 */
function buildExport(deps: BackupDeps, now: Date): any {
  const memory = (() => {
    try {
      const m = deps.loadMemory()
      return { history: Array.isArray(m && m.history) ? m.history : [], summary: String((m && m.summary) || '') }
    } catch {
      return { history: [], summary: '' }
    }
  })()
  const safe = (read: () => any, fallback: any): any => {
    try { const v = read(); return v === undefined || v === null ? fallback : v } catch { return fallback }
  }
  return {
    ok: true,
    version: String(deps.version || '0.0.0'),
    exportedAt: now.toISOString(),
    memory,
    personality: sanitizePersonality(safe(deps.loadPersonality, {})),
    state: safe(deps.loadState, {}),
    growth: safe(deps.loadGrowth, {}),
    fishfood: safe(deps.loadFishfood, {}),
    pet: safe(deps.loadPet, {}),
    reminders: safe(deps.loadReminders, []),
    storyProgress: safe(deps.loadStoryProgress, {}),
  }
}

// ===== 导入：逐字段类型清洗（非法返回 null → skipped） =====

/** 聊天记忆：{history:[{role,content}], summary}；老格式（整份就是数组）也认 */
export function cleanMemory(value: any): { history: any[]; summary: string } | null {
  const cleanTurns = (raw: any): any[] | null => {
    if (!Array.isArray(raw)) return null
    const out: any[] = []
    for (const t of raw) {
      if (!isPlainObject(t)) continue
      const role = t.role === 'user' || t.role === 'assistant' ? t.role : ''
      if (!role || typeof t.content !== 'string') continue
      out.push({ role, content: t.content })
    }
    return out
  }
  if (Array.isArray(value)) {
    const history = cleanTurns(value)
    return history === null ? null : { history, summary: '' }
  }
  if (!isPlainObject(value)) return null
  // 空对象没有可写内容：当非法处理，避免一次误导入把记忆清空
  if (!('history' in value) && !('summary' in value)) return null
  const history = value.history === undefined ? [] : cleanTurns(value.history)
  if (history === null) return null
  if (value.summary !== undefined && typeof value.summary !== 'string') return null
  return { history, summary: typeof value.summary === 'string' ? value.summary : '' }
}

/** 亲密度：{intimacy:number} */
export function cleanState(value: any): { intimacy: number } | null {
  if (!isPlainObject(value) || !isNum(value.intimacy)) return null
  return { intimacy: Math.max(0, Math.floor(value.intimacy)) }
}

/** 成长：{exp:number, dayKey?:string, dayExp?:number, src?:{来源:number}} */
export function cleanGrowth(value: any): any | null {
  if (!isPlainObject(value) || !isNum(value.exp)) return null
  const out: any = { exp: Math.max(0, Math.floor(value.exp)) }
  if (typeof value.dayKey === 'string') out.dayKey = clip(value.dayKey, 20)
  if (isNum(value.dayExp)) out.dayExp = Math.max(0, Math.floor(value.dayExp))
  if (isPlainObject(value.src)) {
    const src: any = {}
    for (const k of Object.keys(value.src)) {
      if (!isNum(value.src[k])) continue
      src[clip(k, 20)] = Math.max(0, Math.floor(value.src[k]))
    }
    out.src = src
  }
  return out
}

/** 鱼粮：token 计数与日/月滚动标记 */
export function cleanFishfood(value: any): any | null {
  if (!isPlainObject(value)) return null
  const out: any = {}
  for (const k of ['chatTokens', 'storyTokens', 'totalTokens', 'monthTokens', 'dayTokens']) {
    if (isNum(value[k])) out[k] = Math.max(0, Math.floor(value[k]))
  }
  if (typeof value.day === 'string') out.day = clip(value.day, 20)
  if (typeof value.month === 'string') out.month = clip(value.month, 20)
  return Object.keys(out).length ? out : null
}

/** 宠物：数值项 + 心情字符串 */
export function cleanPet(value: any): any | null {
  if (!isPlainObject(value)) return null
  const out: any = {}
  for (const k of ['feeds', 'hunger', 'lastSeen', 'intimacy']) {
    if (isNum(value[k])) out[k] = Math.max(0, Math.floor(value[k]))
  }
  if (typeof value.mood === 'string') out.mood = clip(value.mood, 20)
  return Object.keys(out).length ? out : null
}

/** 提醒：数组，逐项重建（坏项丢弃）；非空数组全是坏项 → null，避免误清空 */
export function cleanReminders(value: any): any[] | null {
  if (!Array.isArray(value)) return null
  const out: any[] = []
  for (const r of value) {
    if (!isPlainObject(r)) continue
    if (typeof r.text !== 'string' || !r.text.trim()) continue
    if (typeof r.at !== 'string' || !r.at.trim()) continue
    out.push({
      id: typeof r.id === 'string' && r.id ? clip(r.id, 64) : Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      text: clip(r.text, 200),
      at: clip(r.at, 40),
      repeat: isNum(r.repeat) && r.repeat > 0 ? Math.round(r.repeat) : null,
      nextAt: typeof r.nextAt === 'string' ? clip(r.nextAt, 40) : null,
      fired: r.fired === true,
      done: r.done === true,
      remindCount: toNonNegInt(r.remindCount),
      createdAt: typeof r.createdAt === 'string' ? clip(r.createdAt, 40) : new Date().toISOString(),
    })
  }
  if (out.length === 0 && value.length > 0) return null
  return out
}

/** 说书进度：{'书|段': true, _current:'书名'}；没有任何合法项 → null，避免误清空 */
export function cleanStoryProgress(value: any): any | null {
  if (!isPlainObject(value)) return null
  const out: any = {}
  let kept = 0
  for (const k of Object.keys(value)) {
    if (k === '_current') {
      if (typeof value[k] === 'string' && value[k]) {
        out._current = clip(value[k], 40)
        kept++
      }
      continue
    }
    if (value[k] === true) {
      out[clip(k, 400)] = true
      kept++
    }
  }
  return kept > 0 ? out : null
}

/** 人格：只走 sanitizePersonality（可变层四字段 + 元数据），核心设定永远进不来 */
export function cleanPersonality(value: any): any | null {
  if (!isPlainObject(value)) return null
  return sanitizePersonality(value)
}

type Cleaner = (value: any) => any | null

/** 字段 → 清洗器（与 BACKUP_DATA_FIELDS 一一对应） */
export const BACKUP_CLEANERS: Record<BackupDataField, Cleaner> = {
  memory: cleanMemory,
  personality: cleanPersonality,
  state: cleanState,
  growth: cleanGrowth,
  fishfood: cleanFishfood,
  pet: cleanPet,
  reminders: cleanReminders,
  storyProgress: cleanStoryProgress,
}

export function createBackupHandlers(deps: BackupDeps) {
  const nowFn = deps.now || ((): Date => new Date())

  function saveField(field: BackupDataField, value: any): void {
    if (field === 'memory') {
      if (!deps.saveMemory) throw new Error('saveMemory missing')
      deps.saveMemory(value)
      return
    }
    if (field === 'personality') {
      if (!deps.savePersonality) throw new Error('savePersonality missing')
      if (deps.savePersonality(value) === false) throw new Error('personality save failed')
      return
    }
    const table: Record<string, (() => void) | undefined> = {
      state: deps.saveState ? () => deps.saveState!(value) : undefined,
      growth: deps.saveGrowth ? () => deps.saveGrowth!(value) : undefined,
      fishfood: deps.saveFishfood ? () => deps.saveFishfood!(value) : undefined,
      pet: deps.savePet ? () => deps.savePet!(value) : undefined,
      reminders: deps.saveReminders ? () => deps.saveReminders!(value) : undefined,
      storyProgress: deps.saveStoryProgress ? () => deps.saveStoryProgress!(value) : undefined,
    }
    const run = table[field]
    if (!run) throw new Error('save' + field + ' missing')
    run()
  }

  /** GET /data/export：导出包（≤2MB；超限 413，不回部分数据） */
  async function handleExport(req: any, res: any): Promise<void> {
    try {
      const method = req && req.method ? String(req.method).toUpperCase() : 'GET'
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405)
        return
      }
      const payload = buildExport(deps, nowFn())
      let size = 0
      try { size = Buffer.byteLength(JSON.stringify(payload), 'utf8') } catch { size = Infinity }
      if (size > BACKUP_MAX_BYTES) {
        sendJson(res, { ok: false, error: 'TOO_LARGE', limit: BACKUP_MAX_BYTES }, 413)
        return
      }
      sendJson(res, payload)
    } catch (err: any) {
      sendError(res, err)
    }
  }

  /**
   * POST /data/import：逐字段类型校验后落盘。
   * imported 写成功的字段；skipped 被忽略的字段（未知字段与类型非法都算）。
   * 元数据（ok/version/exportedAt）认识但不写盘，也不进 skipped。
   */
  async function handleImport(req: any, res: any): Promise<void> {
    try {
      const method = req && req.method ? String(req.method).toUpperCase() : ''
      if (method !== 'POST') {
        sendJson(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405)
        return
      }
      let parsed: any
      try {
        parsed = await readJsonBody(req, BACKUP_MAX_BYTES)
      } catch (err: any) {
        // 读流异常（连接中断等）不该被当成"导入成功"
        console.error('[backup] IMPORT-READ-FAIL ' + String((err && err.message) || err))
        sendError(res, err)
        return
      }
      if (!parsed || parsed.ok !== true) {
        sendTooLarge(res)
        return
      }
      const body = parsed.body
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, { ok: false, error: 'BAD_BODY' }, 400)
        return
      }

      const imported: string[] = []
      const skipped: string[] = []
      for (const key of Object.keys(body)) {
        // 导出包自带的元数据：认识，但不落盘
        if ((BACKUP_META_FIELDS as ReadonlyArray<string>).includes(key)) continue
        const field = key as BackupDataField
        const clean = BACKUP_CLEANERS[field]
        if (!clean) {
          skipped.push(key)
          continue
        }
        let value: any
        try {
          value = clean(body[key])
        } catch {
          value = null
        }
        if (value === null) {
          skipped.push(key)
          continue
        }
        try {
          saveField(field, value)
          imported.push(field)
          if (field === 'storyProgress' && deps.onStoryProgressImported) {
            try { deps.onStoryProgressImported() } catch { }
          }
        } catch (err: any) {
          console.error('[backup] IMPORT-SAVE-FAIL field=' + field + ' err=' + String((err && err.message) || err))
          skipped.push(field)
        }
      }
      sendJson(res, { ok: true, imported, skipped })
    } catch (err: any) {
      sendError(res, err)
    }
  }

  return { handleExport, handleImport }
}
