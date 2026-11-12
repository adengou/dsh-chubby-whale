/**
 * host/routes/nervous.ts —— 神经感知第三层：GET /api/chubby-whale/nervous
 *
 * 只做「把收集器缓冲里的最近事件交出去」这一件事：不筛事件、不归约情绪
 * （归约在客户端第二层 affect.ts），不读盘、不写盘、不外呼。
 *
 * 出包形状（契约：docs/神经感知-接口契约.md 第三层）：
 *   { ok: true, events: NervousEvent[] }   // 契约字段，客户端只读它
 *   { subscribed: string[] }               // 诊断字段：宿主上哪些 dsh 事件订阅成功了
 *
 * 订阅全失败时 events 为空数组、ok 仍为 true —— 客户端按「这次没有新事件」处理，不报错，
 * 也不让「感知」这条旁路把只读接口变成 500。
 */
import { sendJson } from '../respond.js'
import type { HostCollector } from '../nervous/collector.js'

export interface NervousHandlerDeps {
  /** 宿主事件收集器：index.ts 装配时构造后注入，路由内部不自建（与 createProofreadHandler 同一注入方式） */
  collector: HostCollector
}

/** 一次最多回多少条：客户端按 at 去重，基线对齐也用不到更多，没必要把 200 条全推过去 */
const DEFAULT_LIMIT = 60
/** 上限 = 收集器容量（200），再大也没有更多数据 */
const MAX_LIMIT = 200

/** 从 req.url 取 ?limit=，缺省/非法用默认值，结果夹在 [1, MAX_LIMIT] */
function limitOf(req: any): number {
  try {
    const url = new URL(String((req && req.url) || ''), 'http://x')
    const n = Math.floor(Number(url.searchParams.get('limit')))
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
    return n > MAX_LIMIT ? MAX_LIMIT : n
  } catch (e) {
    return DEFAULT_LIMIT
  }
}

export function createNervousHandler(deps: NervousHandlerDeps) {
  // deps 缺省/collector 缺失时按「没有收集器」处理：接口永不因装配问题 500
  const collector: HostCollector | undefined = deps && deps.collector

  return function handleNervous(req: any, res: any): void {
    try {
      const events = collector ? collector.recent(limitOf(req)) : []
      const subscribed = collector ? collector.status().subscribed : []
      sendJson(res, { ok: true, events, subscribed })
    } catch (e) {
      // 收集器自身出问题也只回空结果（只读接口不该把异常抛给客户端）
      sendJson(res, { ok: true, events: [], subscribed: [] })
    }
  }
}
