/**
 * client/focus-reward.ts —— 「反向驯化」：连续专注到阈值，肥鲸才第一次游出来叼诗
 *
 * 这里只做纯判定：吃一次心跳（现在时刻 + 是否还在专注），吐出下一份状态和至多一个奖励。
 * 不碰动画、不发请求、不读全局时钟和页面环境，也没有任何外部依赖——时间全部由入参给，
 * 这样同一条时间轴可以在离线测试里逐毫秒复现。
 *
 * 为什么阈值是 45 分钟：25 分钟的番茄钟太短，随手点两下就能凑满，起不到驯化作用；
 * 90 分钟又超出多数人一次能坐住的时长。45 分钟正好覆盖一个完整的深度工作块，
 * 又不会把「今天状态不错」误判成「今天很努力」。
 *
 * 为什么切走就让这一轮作废：它奖励的是「连续在场」，不是「累计在线」。只要允许
 * 碎片时间累加，把标签页挂着、隔一会儿回来点一下就能白拿奖励，反向驯化立刻变成
 * 反向摸鱼。所以 active=false 或心跳断档，一律清零重来。
 *
 * 心跳间隔放宽到 60 秒，是给浏览器后台定时器的节流留余量：后台标签页常被压到
 * 一分钟一跳，而人真的切走往往不止一分钟。超过 60 秒才判中断，正好 60 秒仍算连续。
 *
 * 约定：streakStartAt = 0 表示「这一轮还没开始」。时间戳 0 本身也可以是合法起点
 * （测试时间轴从 0 起算时），这种状态由本模块打一个不可枚举的内部标记来区分；
 * 外部构造的 { streakStartAt: 0, … } 一律按空档处理。标记不参与 JSON、深比较和公开形状。
 */

/** 默认阈值 45 分钟：一个完整深度工作块的粒度，见文件头说明 */
const DEFAULT_THRESHOLD_MS = 45 * 60 * 1000

/** 默认心跳容忍 60 秒：后台节流到 1 分钟一拍时不算人走了 */
const DEFAULT_IDLE_GAP_MS = 60 * 1000

/**
 * 「真实起点恰为 0」的内部标记：0 同时承担「这一轮还没开始」的哨兵含义，
 * 只靠三个公开字段分不开。标记不可枚举，所以 JSON、Object.keys、深比较看到的
 * 仍然只有三个字段；外部手写的 0 起点状态没有这个标记，按空档处理。
 */
const ZERO_START = Symbol('focusReward.zeroStart')

export type FocusState = { streakStartAt: number; lastTickAt: number; rewarded: boolean }

export type FocusReward = { kind: 'poem'; at: number } | null

export type FocusInput = { now: number; active: boolean }

/** 时间戳只认「有限且非负」的数：NaN / 负数 / 非数字都不参与判定 */
function isTime(t: unknown): t is number {
  return typeof t === 'number' && Number.isFinite(t) && t >= 0
}

/** 时长参数非法（NaN / 负数 / 非数字）时回落到默认值，绝不抛错 */
function span(v: unknown, fallback: number): number {
  return isTime(v) ? v : fallback
}

/** 拷一份旧状态：缺字段或脏数据当作「没有旧状态」，避免把坏值继续传下去 */
function copyPrev(prev: FocusState | null | undefined): FocusState | null {
  if (!prev || typeof prev !== 'object') return null
  if (!isTime(prev.streakStartAt) || !isTime(prev.lastTickAt)) return null
  const copy: FocusState = {
    streakStartAt: prev.streakStartAt,
    lastTickAt: prev.lastTickAt,
    rewarded: prev.rewarded === true,
  }
  // 真实 0 起点的标记要跟着副本走，否则下一次判定会把它误当成空档
  if (isZeroStart(prev)) brandZeroStart(copy)
  return copy
}

/** 未开始 / 这一轮作废：起点归零，奖励标记复位 */
function holdState(now: number): FocusState {
  return { streakStartAt: 0, lastTickAt: now, rewarded: false }
}

/** 从这一拍重新计时（起点为 0 时打上真实起点标记） */
function startState(now: number): FocusState {
  const state: FocusState = { streakStartAt: now, lastTickAt: now, rewarded: false }
  if (now === 0) brandZeroStart(state)
  return state
}

/** 读取内部标记：只看本模块产出的状态，外部手写对象没有它 */
function isZeroStart(s: FocusState): boolean {
  return (s as any)[ZERO_START] === true
}

/** 打标记但保持不可枚举：公开形状始终是三个字段 */
function brandZeroStart(s: FocusState): void {
  Object.defineProperty(s, ZERO_START, { value: true })
}

export function updateFocus(
  prev: FocusState | null,
  input: FocusInput,
  opts?: { thresholdMs?: number; idleGapMs?: number },
): { state: FocusState; reward: FocusReward } {
  const thresholdMs = span(opts && opts.thresholdMs, DEFAULT_THRESHOLD_MS)
  const idleGapMs = span(opts && opts.idleGapMs, DEFAULT_IDLE_GAP_MS)
  const active = !!(input && input.active === true)
  const rawNow = input && typeof input === 'object' ? input.now : undefined

  // 时刻非法（NaN / 负数 / 缺字段）就无从判断间隔，按中断处理：清空这一轮，但不抛错
  if (!isTime(rawNow)) return { state: holdState(0), reward: null }
  const now = rawNow

  const base = copyPrev(prev)

  // 首次心跳（或旧状态被写坏）：只登记起点，绝不立刻发奖励——
  // 奖励必须来自「熬满阈值」这一段，第一拍就叼诗会把机制变成开屏广告
  if (!base) {
    return { state: active ? startState(now) : holdState(now), reward: null }
  }

  // 人切走了：连续在场断掉，这一轮直接作废
  if (!active) return { state: holdState(now), reward: null }

  // 两拍间隔超时：同样当作中断，从这一拍重新计时（正好 60 秒仍算连续）
  const gap = now - base.lastTickAt
  if (gap > idleGapMs) return { state: startState(now), reward: null }

  // streakStartAt = 0 是「这一轮还没开始」的哨兵；只有真实起点恰为 0 的状态带内部标记。
  // 没标记就说明上一轮是空档（切走/断档留下的），从这一拍重新计时，不能白送一段专注。
  if (base.streakStartAt === 0 && !isZeroStart(base)) {
    return { state: startState(now), reward: null }
  }

  const next: FocusState = {
    streakStartAt: base.streakStartAt,
    lastTickAt: now,
    rewarded: base.rewarded,
  }
  if (isZeroStart(base)) brandZeroStart(next)

  // 同一段只发一次：rewarded 记住已经叼过诗，继续坐着也不会重复触发
  if (!base.rewarded && now - base.streakStartAt >= thresholdMs) {
    next.rewarded = true
    return { state: next, reward: { kind: 'poem', at: now } }
  }

  return { state: next, reward: null }
}
