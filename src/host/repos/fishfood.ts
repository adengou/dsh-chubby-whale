/**
 * host/repos/fishfood.ts —— 鱼粮（token 统计）仓储（fishfood.json）
 * 从 host/store.ts 拆出：跨天/跨月清零「今日/本月」，总量 totalTokens 不动（照 C# 的 date/month 滚动）。
 * 写盘走 host/atomic.ts；读坏文件按 [store] 前缀留痕并备份。
 * 读入容错 UTF-8 BOM，写出统一 UTF-8 无 BOM。
 *
 * 跨天/跨月判断在读取时也做一次（只改内存返回值、不写盘）：否则新的一天在
 * 「第一条新消息到来之前」读到的今日/本月计数仍是昨天的，面板与统计会显示旧值。
 * 所有 token 字段按非负整数累加，并在 Number.MAX_SAFE_INTEGER 封顶，防脏值/溢出。
 *
 * 分桶（2026-11-07 B98）：内部模型用量（kind='summary'/'personality'）与聊天共用 chatTokens 时
 * 账本分不出「聊天 / 摘要 / 人格」各花了多少。这里额外按 kind 累计 byKind，四个桶各带
 * 总量 / 当日 / 当月的 tokens 与金额。**顶层字段语义一个都不改**（老面板、老客户端、
 * 备份导入还在读 chatTokens/storyTokens/totalTokens/dayTokens/monthTokens/costCny/...）。
 * byKind 是「新账」：老 fishfood.json 没有它就按 0 处理，不回溯拆分历史（历史内部用量
 * 早已并进 chatTokens，拆不出来，硬拆等于编数字）。
 */
import { join } from 'node:path'
import { writeJsonAtomic, isMissingFileError, quarantineFile, readTextNoBom } from '../atomic.js'

/** JS 安全整数上限：超过后 +1 不再改变数值（显示与统计都失真），到这里就封顶 */
const MAX_TOKEN = Number.MAX_SAFE_INTEGER

/**
 * 账本分桶的 kind（与 addTokens 收到的 kind 一一对应；别的 kind 按老口径并进 chat）。
 * 只在本文件内部约束类型，**刻意不 export**：分桶是 fishfood.json 的数据形状，
 * 不是新的模块接口（docs/模块接口清单.md 不该因本批次漂移）。
 */
type TokenKind = 'chat' | 'story' | 'summary' | 'personality'

/** 单个桶：总量 / 当日 / 当月各记 tokens 与人民币估算（金额口径与顶层 costCny 相同） */
type TokenBucket = {
  tokens: number
  costCny: number
  dayTokens: number
  dayCostCny: number
  monthTokens: number
  monthCostCny: number
}

/** 分桶顺序固定：写盘、出接口、展示都按这个来，别依赖对象键序 */
const TOKEN_KINDS: TokenKind[] = ['chat', 'story', 'summary', 'personality']

/** 一次用量的明细（都可缺省：老路径只有 total） */
export type TokenDetail = {
  promptTokens?: number
  completionTokens?: number
  cacheHitTokens?: number
  /** 本次调用的人民币估算（元），由 shared/pricing.ts 算好后传入 */
  costCny?: number
}

export interface TokenRepo {
  loadFishfood(): any
  saveFishfood(obj: any): void
  /**
   * kind='story' 记说书 token，其余记聊天 token；同时累计总量/本月；detail 可选（拆分与金额）。
   * 另按 kind 计入 byKind 分桶（chat/story/summary/personality），顶层字段口径不变。
   */
  addTokens(kind: string, n: number, detail?: TokenDetail): any
}

/** 非负整数（NaN/Infinity/负数/小数一律清洗，避免一条脏 usage 把整份鱼粮写成 null） */
function cleanToken(value: any): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(MAX_TOKEN, Math.floor(n))
}

/** 累加后按安全整数封顶 */
function addToken(current: any, add: number): number {
  const base = cleanToken(current)
  return Math.min(MAX_TOKEN, base + add)
}

/** 金额清洗：非负有限，保留 6 位小数（与 shared/pricing.ts 的输出精度一致） */
function cleanCost(value: any): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(Math.min(1e9, n) * 1e6) / 1e6
}

/** 金额累加（同样封顶，防脏值把 total 变成 1e309） */
function addCost(current: any, add: number): number {
  const base = cleanCost(current)
  return Math.round(Math.min(1e9, base + add) * 1e6) / 1e6
}

/** 空桶（四个桶的形状一致，缺数据就用它） */
function emptyBucket(): TokenBucket {
  return { tokens: 0, costCny: 0, dayTokens: 0, dayCostCny: 0, monthTokens: 0, monthCostCny: 0 }
}

/**
 * kind → 桶名。老口径是「kind === 'story' 单独计，其余全进 chat」，分桶沿用**同一条判断**
 * （不做 trim/小写化，刻意与顶层分支保持逐字一致）：只有 story/summary/personality 单列，
 * 其它（含脏值/空值/未知 kind）都算 chat —— 这样 byKind.chat + byKind.story 恰好等于
 * 新记账的 chatTokens + storyTokens，不会出现「桶里有一笔、顶层没有」的错位。
 */
function bucketKindOf(kind: any): TokenKind {
  return kind === 'story' || kind === 'summary' || kind === 'personality' ? kind : 'chat'
}

/** 读一个桶并清洗：缺字段/脏值/老文件没有 byKind 一律给 0 桶，绝不返回 undefined */
function readBucket(f: any, kind: TokenKind): TokenBucket {
  const b = emptyBucket()
  const all = f && typeof f === 'object' && f.byKind && typeof f.byKind === 'object' && !Array.isArray(f.byKind) ? f.byKind : null
  const raw = all && all[kind] && typeof all[kind] === 'object' && !Array.isArray(all[kind]) ? all[kind] : null
  if (!raw) return b
  b.tokens = cleanToken(raw.tokens)
  b.costCny = cleanCost(raw.costCny)
  b.dayTokens = cleanToken(raw.dayTokens)
  b.dayCostCny = cleanCost(raw.dayCostCny)
  b.monthTokens = cleanToken(raw.monthTokens)
  b.monthCostCny = cleanCost(raw.monthCostCny)
  return b
}

/** 取（必要时创建）分桶容器，并把四个桶补齐成规范形状（脏桶就地清洗，不留下怪形状） */
function ensureBuckets(f: any): any {
  if (!f.byKind || typeof f.byKind !== 'object' || Array.isArray(f.byKind)) f.byKind = {}
  for (const kind of TOKEN_KINDS) f.byKind[kind] = readBucket(f, kind)
  return f.byKind
}

/** 跨天/跨月：各桶的当日/当月计数随顶层一起归零（桶的总量与累计金额不动） */
function rollBuckets(f: any, scope: 'day' | 'month'): void {
  const all = f && typeof f === 'object' && f.byKind && typeof f.byKind === 'object' && !Array.isArray(f.byKind) ? f.byKind : null
  if (!all) return
  for (const kind of TOKEN_KINDS) {
    const raw = all[kind]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    if (scope === 'day') { raw.dayTokens = 0; raw.dayCostCny = 0 }
    else { raw.monthTokens = 0; raw.monthCostCny = 0 }
  }
}

export function createTokenRepo(dataDir: string): TokenRepo {
  const FISHFOOD = join(dataDir, 'fishfood.json')

  function loadFishfood(): any {
    try {
      const obj = JSON.parse(readTextNoBom(FISHFOOD))
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        rollFishfood(obj)
        return obj
      }
    } catch (err: any) {
      if (!isMissingFileError(err)) quarantineFile(FISHFOOD, err, '[store]')
    }
    // 新文件也要带 day/month 标记：否则首写落盘的文件没有标记，
    // 下一次 addTokens 读到「无标记」会把它当成跨天（见 rollFishfood）
    const fresh = { chatTokens: 0, storyTokens: 0 }
    rollFishfood(fresh)
    return fresh
  }
  function saveFishfood(obj: any): void {
    try { writeJsonAtomic(FISHFOOD, obj) } catch (err: any) { console.error('[store] WRITE-FAIL ' + String(FISHFOOD) + ' err=' + String(err?.message || err)) }
  }
  /**
   * 跨天/跨月把"今日/本月"清零（总量 totalTokens 不动，照 C# 的 date/month 滚动）。
   *
   * 缺 day/month 标记（新文件、老版本文件、备份导入）**不等于跨天**：只补标记、不清零。
   * 旧实现无条件比较，null !== today 就清零；而首写的新文件没有标记（默认对象没走过
   * rollFishfood），于是「第一次 addTokens 记的今日/本月 + 总量」会在下一次 addTokens
   * 时被当成「昨天」清零（实测 chatTokens 7 → 0、dayTokens 7 → 3，只有 totalTokens 幸存）。
   */
  function rollFishfood(f: any): void {
    const now = new Date()
    const day = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
    const month = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
    const hadDay = typeof f.day === 'string' && f.day.length > 0
    if (hadDay && f.day !== day) { f.chatTokens = 0; f.storyTokens = 0; f.dayTokens = 0; f.dayCostCny = 0; rollBuckets(f, 'day') }
    f.day = day
    const hadMonth = typeof f.month === 'string' && f.month.length > 0
    if (hadMonth && f.month !== month) { f.monthTokens = 0; f.monthCostCny = 0; rollBuckets(f, 'month') }
    f.month = month
  }

  /**
   * 记一次用量。
   * @param detail 输入/输出拆分与本次人民币估算（2026-11-07 鱼账本）：
   *   拆分来自上游 usage（prompt_tokens / completion_tokens / prompt_cache_hit_tokens），
   *   金额由 shared/pricing.ts 按「模型 × 高峰/空闲 × 缓存命中」算好再传进来 ——
   *   仓储只负责累计与滚动，不自己判断价格（价格口径只有一个真源）。
   *   旧调用方只传前两个参数时行为完全不变。
   */
  function addTokens(kind: string, n: number, detail?: TokenDetail): any {
    const f = loadFishfood()
    const add = cleanToken(n)
    if (add <= 0) return f                       // 没有可信用量：不写盘、不改计数（也不把 NaN 写进文件）
    const kindOf = bucketKindOf(kind)
    if (kindOf === 'story') f.storyTokens = addToken(f.storyTokens, add)
    else f.chatTokens = addToken(f.chatTokens, add)
    f.dayTokens = addToken(f.dayTokens, add)
    f.totalTokens = addToken(f.totalTokens, add)
    f.monthTokens = addToken(f.monthTokens, add)
    // 拆分与金额：只在真的拿到时累加（拿不到就保持原值，不写 0 冒充「已知为 0」）
    const d: any = detail || {}
    const prompt = cleanToken(d.promptTokens)
    const completion = cleanToken(d.completionTokens)
    const hit = cleanToken(d.cacheHitTokens)
    const cost = cleanCost(d.costCny)
    if (prompt > 0) f.promptTokens = addToken(f.promptTokens, prompt)
    if (completion > 0) f.completionTokens = addToken(f.completionTokens, completion)
    if (hit > 0) f.cacheHitTokens = addToken(f.cacheHitTokens, hit)
    if (cost > 0) {
      f.costCny = addCost(f.costCny, cost)
      f.dayCostCny = addCost(f.dayCostCny, cost)
      f.monthCostCny = addCost(f.monthCostCny, cost)
    }
    // 分桶（B98）：按 kind 累加，桶内总量/当日/当月与顶层同步走；顶层字段保持原样。
    // 先 ensureBuckets 再取本桶：老文件没有 byKind 时在这一步补齐四个 0 桶（只补形状，不补历史数字）。
    const bucket = ensureBuckets(f)[kindOf]
    bucket.tokens = addToken(bucket.tokens, add)
    bucket.dayTokens = addToken(bucket.dayTokens, add)
    bucket.monthTokens = addToken(bucket.monthTokens, add)
    if (cost > 0) {
      bucket.costCny = addCost(bucket.costCny, cost)
      bucket.dayCostCny = addCost(bucket.dayCostCny, cost)
      bucket.monthCostCny = addCost(bucket.monthCostCny, cost)
    }
    saveFishfood(f)
    return f
  }

  return { loadFishfood, saveFishfood, addTokens }
}
