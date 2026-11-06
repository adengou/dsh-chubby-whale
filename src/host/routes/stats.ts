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
 *     intimacy,                                        // state.json
 *     personality: { catchphrases, preferences, notes, selfNarrative },
 *     uptimeMs                                         // 插件本次装配至今
 *   }
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
  dataSource?: string
  model?: string
  tts?: { available: boolean; interpreter: string; cooling: boolean }
  backup?: { lastAt: number; count: number }
  now?: () => number
}

/** 非负整数（NaN/负数/小数一律归零或取整，展示用不需要负值） */
function count(value: any): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
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
    const uptimeMs = startedAt > 0 ? Math.max(0, Math.floor(nowFn() - startedAt)) : 0

    return {
      ok: true,
      cache: { tts: count(cache.tts), chat: count(cache.chat), asr: count(cache.asr) },
      fishfood: { chatTokens, storyTokens, total: chatTokens + storyTokens },
      growth: { exp, stage: stage.name, nextExp: stage.nextExp },
      intimacy: count(state.intimacy),
      personality: {
        catchphrases: strList(p.catchphrases),
        preferences: strList(p.preferences),
        notes: typeof p.notes === 'string' ? p.notes : '',
        selfNarrative: typeof p.selfNarrative === 'string' ? p.selfNarrative : '',
      },
      uptimeMs,
      // 自检：数据源 / 模型 / TTS 引擎 / 备份（缺省不报错）
      dataSource: String(opts.dataSource || 'local'),
      model: String(opts.model || ''),
      tts: opts.tts || { available: false, interpreter: '', cooling: false },
      backup: opts.backup || { lastAt: 0, count: 0 },
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
