/**
 * client/nervous/events.ts —— 神经感知的事件源：把「时间」判成「情绪事件」
 *
 * 定位：只做「输入 → 事件列表」的纯判断。不碰 affect.ts（怎么把事件变成情绪）、
 * 不碰 stream.ts（历史怎么记账）、不持有状态——状态由调用方保存，每次调用把
 * 上一轮的 SenseState 传回来，本模块只负责算出「这一拍该报哪几条」。
 * 上层接线时按 kind 分派：long-work → 提醒歇会儿，late-night → 催睡，
 * idle → 惦记，welcome-back → 高兴（具体措辞由表达层决定，这里不写文案）。
 *
 * 四条规则：
 *   · long-work    本次会话已连续 ≥2 小时，且最近 10 分钟内还有活动；
 *   · late-night   凌晨 0-5 点，且最近 10 分钟内还有活动；
 *   · idle         距上次活动 ≥30 分钟；
 *   · welcome-back 距上次活动 5-30 分钟（短暂离开又回来）。
 * 同一 kind 在冷却期内不再触发；四条规则各记各的触发时间，互不影响。
 *
 * 纯函数约定（便于单测）：不读 Date.now()、不挂计时器、不读存储；
 * 时间一律从 input 进；不修改 prev，返回全新对象。
 */

/** 一次判定的输入：当前时间、最后活动时间、当前小时（0-23） */
export type SenseInput = { now: number; lastActivityAt: number; hour: number }

/** 判出来的一条情绪事件（at = 判定时刻，即 input.now） */
export type NervousEvent = { kind: 'long-work' | 'late-night' | 'idle' | 'welcome-back'; at: number }

/**
 * 需要跨调用保存的状态：
 *   · lastTriggerAt：每种事件上次触发的时刻（只记触过的，没触过就不出现）；
 *   · seenAt：本次会话的起点（第一次调用时记下，之后一直沿用）。
 */
export type SenseState = { lastTriggerAt: Partial<Record<NervousEvent['kind'], number>>; seenAt: number }

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

/**
 * 全部阈值集中在这里，调参只改这一处（对外不导出，接口面保持最小）。
 *
 * 为什么取这些数：
 *   · long-work 2 小时：一次完整的专注块通常在 1.5-2 小时之间，不到 2 小时就打断显得
 *     聒噪，明显超过 2 小时又没了「该起来活动一下」的提示意义，取整 2 小时最好记；
 *   · 10 分钟：只有「刚才还在动」才算人还在屏幕前。页面开着但十分钟没动静，多半只是
 *     忘了关，这时报「连续工作」不真实，所以两条「还在用」的规则都卡这个窗口；
 *   · idle 30 分钟：接水、开会这类短暂离开通常不到半小时，超过 30 分钟按「人走了」算；
 *   · welcome-back 5 分钟：不到 5 分钟就招呼「欢迎回来」，刷个新页面、切个标签页就会
 *     被喊一次，太吵；超过 30 分钟已归 idle，所以这个窗口是 [5, 30) 分钟；
 *   · 深夜 0-5 点：按一般作息，凌晨 0 点到 5 点还在用，就是该催睡的信号；
 *   · 冷却：long-work 30 分钟（提醒节奏不超过每半小时一次）、late-night 2 小时
 *     （一夜最多两三次，不刷屏）、idle 1 小时、welcome-back 30 分钟。
 */
const THRESHOLDS = Object.freeze({
  longWorkAfterMs: 2 * HOUR,
  recentActivityMs: 10 * MINUTE,
  longWorkCooldownMs: 30 * MINUTE,
  lateNightFromHour: 0,
  lateNightToHour: 5,
  lateNightCooldownMs: 2 * HOUR,
  idleAfterMs: 30 * MINUTE,
  idleCooldownMs: 60 * MINUTE,
  welcomeBackFromMs: 5 * MINUTE,
  welcomeBackToMs: 30 * MINUTE,
  welcomeBackCooldownMs: 30 * MINUTE,
})

/** 四条规则的固定顺序：决定了同拍触发时 events 数组的顺序，保证输出可复现 */
const KINDS = ['long-work', 'late-night', 'idle', 'welcome-back'] as const

/**
 * 毫秒时间戳归一：非数字 / NaN / Infinity / 负数一律视为「没有这个值」。
 * 非法输入不抛错，由调用方按「该规则不触发」处理。
 */
function readTime(v: any): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null
  return v
}

/**
 * 会话起点归一：只认正数。0 是常见的「还没初始化」初值，
 * 若把它当成真实起点，`now - 0` 会让第一次判定就报「连续工作 2 小时」。
 */
function readSessionStart(v: any): number | null {
  const t = readTime(v)
  return t !== null && t > 0 ? t : null
}

/** 小时归一：只接受 0-23 的有限数；24、-1、字符串 '3' 都按非法处理 */
function readHour(v: any): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return v >= 0 && v <= 23 ? v : null
}

/** 复制上次触发表：只保留四条规则里合法的数值记录，脏数据不往下传 */
function copyTriggers(prev: SenseState | null): Partial<Record<NervousEvent['kind'], number>> {
  const out: Partial<Record<NervousEvent['kind'], number>> = {}
  const src: any = prev && typeof prev === 'object' ? (prev as any).lastTriggerAt : null
  if (!src || typeof src !== 'object') return out
  for (const kind of KINDS) {
    const t = src[kind]
    if (typeof t === 'number' && Number.isFinite(t) && t >= 0) out[kind] = t
  }
  return out
}

/** 是否还在冷却期：没触发过 → 不在；差值 < 冷却时长 → 在（负差值也先按冷却算，宁可不重复报） */
function inCooldown(last: number | undefined, now: number, cooldownMs: number): boolean {
  if (last === undefined) return false
  return now - last < cooldownMs
}

/**
 * 判定这一拍的情绪事件。
 *
 * @param input now（当前时刻）、lastActivityAt（最后活动时刻）、hour（当前小时 0-23）
 * @param prev  上一轮返回的 next；第一次调用传 null
 * @returns events（按 long-work → late-night → idle → welcome-back 排序，同拍可多条）
 *          与 next（新的状态，调用方保存后在下一轮传回）
 */
export function senseEvents(input: SenseInput, prev: SenseState | null): { events: NervousEvent[]; next: SenseState } {
  const src: any = input && typeof input === 'object' ? input : {}
  const now = readTime(src.now)
  const lastTriggerAt = copyTriggers(prev)
  const events: NervousEvent[] = []

  // 会话起点：沿用上一轮的；第一次调用 / 起点非法 / 时间倒退，都把 now 当起点。
  // 首调（以及起点不可信时）不判 long-work——否则刚装上就会报「连续工作 2 小时」。
  const prevSeenAt = prev && typeof prev === 'object' ? readSessionStart((prev as any).seenAt) : null
  const firstCall = now === null || prevSeenAt === null || now < prevSeenAt
  const seenAt = now === null
    ? (prevSeenAt === null ? 0 : prevSeenAt)
    : (firstCall || prevSeenAt === null ? now : prevSeenAt)

  // now 非法：一条都不判，把状态原样交回（仍是新对象）。seenAt 保不住就留 0，
  // 下一轮会被当成「还没起点」重新初始化。
  if (now === null) return { events, next: { lastTriggerAt, seenAt } }
  const at = now

  /** 触发一条：冷却内跳过；触发就记时刻并入列（各 kind 各记各的） */
  const fire = (kind: NervousEvent['kind'], cooldownMs: number): void => {
    if (inCooldown(lastTriggerAt[kind], at, cooldownMs)) return
    lastTriggerAt[kind] = at
    events.push({ kind, at })
  }

  // 距上次活动的间隔。负数或非法值说明时间线不可信（时钟回拨、脏数据），
  // 一律按「不知道离开多久」处理：四条规则都不触发，避免凭空报「离开」或「在忙」。
  const lastActivityAt = readTime(src.lastActivityAt)
  const gap = lastActivityAt === null ? null : at - lastActivityAt
  const gapKnown = gap !== null && gap >= 0
  /** 「刚才还在用」：10 分钟内有活动 */
  const recentlyActive = gapKnown && gap <= THRESHOLDS.recentActivityMs

  const hour = readHour(src.hour)
  const lateHour = hour !== null && hour >= THRESHOLDS.lateNightFromHour && hour <= THRESHOLDS.lateNightToHour

  // ① 连续工作：会话够长 + 人还在。首调不判（见上）。
  if (!firstCall && recentlyActive && at - seenAt >= THRESHOLDS.longWorkAfterMs) {
    fire('long-work', THRESHOLDS.longWorkCooldownMs)
  }

  // ② 深夜还在用：只看钟点与「人还在」，不看会话长短——刚打开也算熬夜。
  if (lateHour && recentlyActive) fire('late-night', THRESHOLDS.lateNightCooldownMs)

  // ③ 久未活动：半小时没动静。
  if (gapKnown && gap >= THRESHOLDS.idleAfterMs) fire('idle', THRESHOLDS.idleCooldownMs)

  // ④ 短暂离开又回来：[5, 30) 分钟。注意 5-10 分钟与「人还在」的窗口重叠，
  //    此时 long-work / late-night 可能同拍出现——四条规则各管各的，这是规格内行为。
  if (gapKnown && gap >= THRESHOLDS.welcomeBackFromMs && gap < THRESHOLDS.welcomeBackToMs) {
    fire('welcome-back', THRESHOLDS.welcomeBackCooldownMs)
  }

  return { events, next: { lastTriggerAt, seenAt } }
}
