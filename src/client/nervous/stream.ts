/**
 * client/nervous/stream.ts —— 神经感知第一层：事件流记账
 *
 * 只做一件事：把 NervousEvent 按到达顺序存进 localStorage 的环形缓冲，
 * 供第二层情绪模型回放、调试时翻历史。不做归约、不做判断、不碰 DOM 事件。
 *
 * 边界（见 docs/神经感知-接口契约.md）：
 *   · 存储顺序 = 写入顺序；超过 cap 时从头部丢最旧的（环形缓冲语义）；
 *   · recent(n) 返回「最近 n 条」，顺序**旧 → 新**（尾部是最新），便于按时间顺序回放；
 *   · stats().since 取所有条目里最小的 at（不依赖数组有序），空缓冲为 0；
 *   · 所有 localStorage 读写失败一律静默（隐私模式 / 配额满 / 无存储环境），绝不抛错。
 *
 * 刻意不做：读失败（getItem 抛错）时不写回，避免用一条新事件覆盖掉读不到的历史；
 * 存储内容损坏（JSON 非法 / 不是数组）则视为空并允许其后重写，起自愈作用。
 *
 * 零第三方依赖，不引用任何其他模块。
 */

/** 契约里的默认存储键 */
const DEFAULT_KEY = 'chubby-nervous-log'
/** 契约里的默认容量 */
const DEFAULT_CAP = 500

/** 一条神经事件（三层共用） */
export type NervousEvent = {
  at: number
  type: 'activity' | 'away' | 'back' | 'work' | 'tick' | 'host' | 'mood'
  data?: Record<string, any>
}

/** 事件账本：追加、回看、统计 */
export interface EventLog {
  log(e: NervousEvent): void
  recent(n?: number): NervousEvent[]
  stats(): { count: number; since: number }
}

/** 规范化一条事件：at 必须是有限数字、type 必须是非空字符串，否则丢弃（脏数据不落盘） */
function normalize(x: any): NervousEvent | null {
  if (!x || typeof x !== 'object') return null
  const at = typeof x.at === 'number' ? x.at : NaN
  if (!Number.isFinite(at)) return null
  const type = typeof x.type === 'string' ? x.type : ''
  if (!type) return null
  const ev: NervousEvent = { at, type: type as NervousEvent['type'] }
  if (x.data && typeof x.data === 'object') ev.data = x.data
  return ev
}

/**
 * 读缓冲。ok=false 表示存储本身不可访问（隐私模式 / 无 localStorage），
 * 此时不要在 log 里回写，否则可能把读不到的历史整段覆盖掉。
 * 内容为空、JSON 坏掉、不是数组都按「空缓冲」处理（ok=true，允许重写自愈）。
 */
function readList(key: string): { list: NervousEvent[]; ok: boolean } {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return { list: [], ok: false }
    const raw = localStorage.getItem(key)
    if (!raw) return { list: [], ok: true }
    let parsed: any
    try { parsed = JSON.parse(raw) } catch (e) { return { list: [], ok: true } }
    if (!Array.isArray(parsed)) return { list: [], ok: true }
    const list: NervousEvent[] = []
    for (const x of parsed) {
      const ev = normalize(x)
      if (ev) list.push(ev)
    }
    return { list, ok: true }
  } catch (e) {
    return { list: [], ok: false }
  }
}

/** 写缓冲：配额满 / 隐私模式一律吞掉，不影响主功能 */
function writeList(key: string, list: NervousEvent[]): void {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return
    localStorage.setItem(key, JSON.stringify(list))
  } catch (e) { }
}

/** 环形缓冲裁剪：只保留最后 cap 条（从头部丢最旧的） */
function trim(list: NervousEvent[], cap: number): void {
  const extra = list.length - cap
  if (extra > 0) list.splice(0, extra)
}

/** key 归一：空/非字符串回默认键 */
function resolveKey(key?: string): string {
  const k = typeof key === 'string' ? key.trim() : ''
  return k || DEFAULT_KEY
}

/** cap 归一：非有限数、非正数回默认容量；小数向下取整 */
function resolveCap(cap?: number): number {
  const n = Math.floor(Number(cap))
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CAP
}

/**
 * 建一个事件账本。
 * key 默认 `chubby-nervous-log`，cap 默认 500 条。
 */
export function createEventLog(opts?: { key?: string; cap?: number }): EventLog {
  const o = opts || {}
  const key = resolveKey(o.key)
  const cap = resolveCap(o.cap)

  /** 追加一条并裁剪；存储不可访问时静默跳过 */
  function log(e: NervousEvent): void {
    const ev = normalize(e)
    if (!ev) return
    const r = readList(key)
    // 读失败（getItem 抛错）就不写：宁可这条丢失，也不覆盖读不到的历史
    if (!r.ok) return
    r.list.push(ev)
    trim(r.list, cap)
    writeList(key, r.list)
  }

  /**
   * 最近 n 条，**旧 → 新**（返回副本；n 省略/非数字 → 全部，n ≤ 0 → 空）。
   * 返回顺序与写入顺序一致：尾部一条就是最新事件。
   */
  function recent(n?: number): NervousEvent[] {
    const list = readList(key).list
    if (n === undefined || n === null) return list.slice()
    const k = Math.floor(Number(n))
    if (!Number.isFinite(k) || k <= 0) return []
    return k >= list.length ? list.slice() : list.slice(list.length - k)
  }

  /** 当前条数与最早一条的时间（空缓冲 since=0） */
  function stats(): { count: number; since: number } {
    const list = readList(key).list
    let since = Infinity
    for (const e of list) {
      if (e.at < since) since = e.at
    }
    return { count: list.length, since: Number.isFinite(since) ? since : 0 }
  }

  return { log, recent, stats }
}
