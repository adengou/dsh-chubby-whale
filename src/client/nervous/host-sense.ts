/**
 * client/nervous/host-sense.ts —— 神经感知第三层：客户端宿主事件轮询源
 *
 * 契约：docs/神经感知-接口契约.md 第三层。
 * 宿主侧（host/nervous/collector.ts）已经订阅好 dsh 会话事件并存进环形缓冲，
 * 这里只按固定周期把新事件取回来，一条一条交给上层（一般是第二层的 affect.apply）。
 *
 * 四条行为约定（都来自契约）：
 *   · 轮询间隔默认 3000ms（opts.intervalMs 可覆盖，下限 500ms 防打爆宿主）；
 *   · document.visibilityState === 'hidden' 时暂停：不请求、不回调；
 *   · 失败静默：网络错误 / 宿主 4xx / 返回不是 JSON，一律吞掉，下一拍再来；
 *   · 只回调新事件：按 at 去重，at 不大于上次见过的一律丢（宿主保证 at 严格单调）。
 *
 * 两处实现取舍（契约没写死，写在这里备查）：
 *   ① **首拍只对齐基线，不回放历史**。宿主缓冲里可能有别的会话攒下的旧事件，
 *      把 200 条历史一次性喂给情绪模型会直接把 arousal 顶满，那不是「感知到主人在忙」，
 *      而是「补算了一笔旧账」。所以第一次成功取到数据时只把游标推到最新，不回调。
 *   ② 页面从后台回到前台时立刻补一拍（不违反「隐藏时暂停」：隐藏期间仍然一个请求都不发）。
 *
 * 类型自包含：NervousEvent / SenseSource 按契约原文在本地声明，不 import 第一层
 * stream.ts、也不 import 第二层 affect.ts —— 三层各自可独立撤除（与 affect.ts 的做法一致，
 * 结构相同，赋值兼容）。
 */
import { getJson } from '../http.js'
import type { NervousEvent } from './stream.js'

/** 轮询路径（getJson 会补上 /api/chubby-whale 前缀） */
const PATH = '/nervous'
/** 契约定死的默认轮询间隔 */
const DEFAULT_INTERVAL_MS = 3000
/** 下限：比它还短的间隔按默认 3000ms 处理，免得传 0/负数/手滑的毫秒数把宿主打爆 */
const MIN_INTERVAL_MS = 500
const MAX_INTERVAL_MS = 10 * 60 * 1000

// 事件类型统一由第一层 stream.ts 定义（契约「事件（三层共用）」），这里只转发
export type { NervousEvent }

/** 一个事件源（契约固定形状，第三层只新增这一个实现） */
export interface SenseSource {
  name: string
  start(onEvent: (e: NervousEvent) => void): void
  stop(): void
}

/** 间隔归一：非有限数或小于下限一律回默认值，超过上限夹到上限 */
function resolveInterval(v?: number): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n) || n < MIN_INTERVAL_MS) return DEFAULT_INTERVAL_MS
  return n > MAX_INTERVAL_MS ? MAX_INTERVAL_MS : n
}

/** 规范化宿主回的一条事件：at 必须是有限数、type 非空字符串，否则丢弃 */
function normalize(raw: any): NervousEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const at = typeof raw.at === 'number' ? raw.at : NaN
  if (!Number.isFinite(at)) return null
  const type = typeof raw.type === 'string' && raw.type ? raw.type : 'host'
  const ev: NervousEvent = { at, type: type as NervousEvent['type'] }
  if (raw.data && typeof raw.data === 'object') ev.data = raw.data
  return ev
}

/** 页面是否隐藏（无 document 的环境按「可见」处理，别把轮询误停掉） */
function pageHidden(): boolean {
  try {
    return typeof document !== 'undefined' && !!document && document.visibilityState === 'hidden'
  } catch (e) {
    return false
  }
}

/**
 * 建一个宿主事件源。
 * 默认 3 秒拉一次 /api/chubby-whale/nervous；start/stop 可反复调用（幂等）。
 */
export function createHostSense(opts?: { intervalMs?: number }): SenseSource {
  const interval = resolveInterval(opts && opts.intervalMs)

  let timer: any = null
  let running = false
  /** 上层回调（stop 后置空） */
  let listener: ((e: NervousEvent) => void) | null = null
  /** 已回调过的最新 at；宿主保证单调，所以只比大小就够去重 */
  let cursor = 0
  /** 首拍只对齐基线（取舍见文件头 ①） */
  let baselineSet = false
  /** 上一次请求还没回来就不再叠一个：慢网/宿主卡住时不会越堆越多 */
  let inflight = false
  /** 可见性监听器（stop 时摘掉） */
  let onVisible: (() => void) | null = null

  /** 把一批事件交给上层：只交 at 比游标新的，逐条推进游标 */
  function deliver(events: NervousEvent[]): void {
    if (!listener) return
    if (!baselineSet) {
      baselineSet = true
      for (const e of events) {
        if (e.at > cursor) cursor = e.at
      }
      return
    }
    for (const e of events) {
      if (e.at <= cursor) continue
      cursor = e.at
      try { listener(e) } catch (err) { }
    }
  }

  /** 拉一次；失败/隐藏/上一次未返回都直接跳过 */
  function poll(): void {
    if (!running || inflight || !listener || pageHidden()) return
    inflight = true
    let pending: Promise<any>
    try {
      pending = getJson(PATH, { cache: 'no-store' })
    } catch (e) {
      // getJson 理论上不同步抛错；真抛了也只当这一拍失败，别让定时器带崩
      inflight = false
      return
    }
    pending.then((body: any) => {
      inflight = false
      // 请求飞行中页面被切到后台：这一拍直接丢（游标不推进），回到前台会当新事件补上
      if (!running || pageHidden()) return
      const list = body && Array.isArray(body.events) ? body.events : []
      const fresh: NervousEvent[] = []
      for (const raw of list) {
        const ev = normalize(raw)
        if (ev) fresh.push(ev)
      }
      // 宿主已按旧 → 新给，这里再排一次：换实现也不依赖它的顺序
      fresh.sort((a, b) => a.at - b.at)
      deliver(fresh)
    }).catch(() => {
      // 失败静默：不发气泡、不打日志、不打断轮询
      inflight = false
    })
  }

  function start(onEvent: (e: NervousEvent) => void): void {
    stop()
    listener = typeof onEvent === 'function' ? onEvent : null
    if (!listener) return
    running = true
    // 挂上先拉一拍，桌面宠物的反应才不慢一个周期
    poll()
    timer = setInterval(poll, interval)
    // 从后台回前台立刻补一拍：隐藏期间一个请求都没发，回来这一拍不算违背暂停约定
    try {
      if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
        onVisible = (): void => { if (!pageHidden()) poll() }
        document.addEventListener('visibilitychange', onVisible)
      }
    } catch (e) {
      onVisible = null
    }
  }

  function stop(): void {
    running = false
    listener = null
    inflight = false
    if (timer) {
      try { clearInterval(timer) } catch (e) { }
      timer = null
    }
    if (onVisible) {
      try { document.removeEventListener('visibilitychange', onVisible) } catch (e) { }
      onVisible = null
    }
    // 刻意不清 cursor / baselineSet：同一个实例再次 start 时不重放旧事件
  }

  return { name: 'host', start, stop }
}
