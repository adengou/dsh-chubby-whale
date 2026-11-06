/**
 * host/routes/stats.ts —— 可视化汇总（只读）
 *
 *   GET /api/chubby-whale/stats
 *
 * 返回：
 *   {
 *     ok,
 *     cache: { tts, chat, asr },                       // 三个缓存目录的条目数
 *     fishfood: { chatTokens, storyTokens, total },    // total = chat + story（与 /fishfood 同口径）
 *     growth: { exp, stage, nextExp },                 // 与 /growth 同口径
 *     intimacy,                                        // state.json，0..100（与 /state 同口径）
 *     personality: { catchphrases, preferences, notes, selfNarrative },
 *     uptimeMs                                         // 插件本次装配至今
 *   }
 *
 * 数值口径：所有数字字段都是有限非负整数——NaN / Infinity / 负数 / 数字字符串都在这里归一，
 * 不让 NaN 进 JSON（JSON.stringify 会把 NaN 变成 null，客户端拿到 null 会显示成"没有值"）。
 * intimacy 和 /state 一样夹到 [0, 100]：同一份 state.json 不许在两个接口给出两个亲密度。
 *
 * 数据全部来自现有 store / cache / 人格仓储的读取器，不新增任何持久化文件，也不写盘。
 */
import { growthStage } from '../../shared/growth.js'
import { sendJson, sendError } from '../respond.js'

export interface StatsHandlerDeps {
  /** 缓存条目数（tts/chat/asr）；读失败按 0 */
  cacheStats?: () => Promise<Record<string, number>>
  loadState: () => any
  loadGrowth: () => any
  loadFishfood: () => any
  /** 当前可变人格（只取四个展示字段） */
  loadPersonality?: () => any
  /** 插件装配时间（ms）；uptimeMs = now - startedAt */
  startedAt?: number
  /** 自检字段（2026-11-06 补）：数据源 / 模型名 / TTS 引擎状态 / 备份信息 */
  /**
   * 值或读取器：路由每次出包都重新取值，装配方可以传 getter 让统计保持新鲜
   * （2026-11-07：此前只能传静态值，备份份数/模型名在插件加载那一刻就固定了）。
   */
  dataSource?: Lazy<string>
  model?: Lazy<string>
  tts?: Lazy<{ available: boolean; interpreter: string; cooling: boolean }>
  backup?: Lazy<{ lastAt: number; count: number }>
  now?: () => number
}

/** 值或读取器（getter 抛错按缺省值处理，绝不把异常抛给 /stats） */
type Lazy<T> = T | (() => T)

function resolve<T>(v: Lazy<T> | undefined | null, fallback: T): T {
  if (typeof v === 'function') {
    try {
      const got = (v as () => T)()
      return got === undefined || got === null ? fallback : got
    } catch {
      return fallback
    }
  }
  return v === undefined || v === null ? fallback : (v as T)
}

/** 非负整数（NaN/负数/小数一律归零或取整，展示用不需要负值） */
function count(value: any): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** 亲密度上限（与 host/repos/state.ts、host/routes/misc.ts 同一口径） */
const INTIMACY_MAX = 100

/** 亲密度展示口径：非数字/负数归 0，超 100 截到 100（与 /state 同口径，不许两个接口两个值） */
function intimacyOf(value: any): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(INTIMACY_MAX, Math.floor(n)))
}

function strList(value: any): string[] {
  return (Array.isArray(value) ? value : []).filter((x: any) => typeof x === 'string')
}

export function createStatsHandler(opts: StatsHandlerDeps) {
  const nowFn = opts.now || ((): number => Date.now())

  async function buildStats(): Promise<any> {
    let cache: Record<string, number> = {}
    try {
      const raw = opts.cacheStats ? await opts.cacheStats() : {}
      cache = raw && typeof raw === 'object' ? raw : {}
    } catch {
      cache = {}
    }

    const growth = opts.loadGrowth() || {}
    const exp = count(growth.exp)
    const stage = growthStage(exp)

    const fish = opts.loadFishfood() || {}
    const chatTokens = count(fish.chatTokens)
    const storyTokens = count(fish.storyTokens)

    const state = opts.loadState() || {}

    const p = opts.loadPersonality ? (opts.loadPersonality() || {}) : {}
    const startedAt = Number(opts.startedAt) || 0
    const elapsed = nowFn() - startedAt
    // 时钟坏了（now() 非有限数）时 elapsed 是 NaN，JSON 会把它写成 null；这里给 0，保持数字类型
    const uptimeMs = startedAt > 0 && Number.isFinite(elapsed) ? Math.max(0, Math.floor(elapsed)) : 0

    // 自检字段是"外部注入"的：形状由调用方决定，这里逐项归一再出包；
    // 支持 getter（备份份数/模型名要反映"现在"，而不是插件加载那一刻）
    const ttsRaw: any = resolve(opts.tts, {} as any) || {}
    const backupRaw: any = resolve(opts.backup, {} as any) || {}
    const dataSource = String(resolve(opts.dataSource, 'local') || 'local')
    const model = String(resolve(opts.model, '') || '')

    return {
      ok: true,
      cache: { tts: count(cache.tts), chat: count(cache.chat), asr: count(cache.asr) },
      fishfood: {
        chatTokens, storyTokens, total: chatTokens + storyTokens,
        // 鱼账本（2026-11-07）：明细与人民币估算同 /fishfood 口径（金额在记账时算好，这里只读）
        promptTokens: count(fish.promptTokens),
        completionTokens: count(fish.completionTokens),
        cacheHitTokens: count(fish.cacheHitTokens),
        costCny: Math.max(0, Math.round((Number(fish.costCny) || 0) * 1e6) / 1e6),
        dayCostCny: Math.max(0, Math.round((Number(fish.dayCostCny) || 0) * 1e6) / 1e6),
      },
      growth: { exp, stage: stage.name, nextExp: stage.nextExp },
      intimacy: intimacyOf(state.intimacy),
      personality: {
        catchphrases: strList(p.catchphrases),
        preferences: strList(p.preferences),
        notes: typeof p.notes === 'string' ? p.notes : '',
        selfNarrative: typeof p.selfNarrative === 'string' ? p.selfNarrative : '',
      },
      uptimeMs,
      // 自检：数据源 / 模型 / TTS 引擎 / 备份（缺省不报错；坏值也不许把 null/负数/怪类型漏出去）
      dataSource,
      model,
      tts: {
        available: ttsRaw.available === true,
        interpreter: typeof ttsRaw.interpreter === 'string' ? ttsRaw.interpreter : '',
        cooling: ttsRaw.cooling === true,
      },
      backup: { lastAt: count(backupRaw.lastAt), count: count(backupRaw.count) },
    }
  }

  async function handleStats(req: any, res: any): Promise<void> {
    try {
      const method = req && req.method ? String(req.method).toUpperCase() : 'GET'
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405)
        return
      }
      sendJson(res, await buildStats())
    } catch (err: any) {
      sendError(res, err)
    }
  }

  return { handleStats }
}
