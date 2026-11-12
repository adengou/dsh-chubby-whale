/**
 * client/nervous/affect.ts —— 神经感知第二层：二维情绪模型 + 九格表情映射
 *
 * 契约：docs/神经感知-接口契约.md（唯一依据；接口只加不改）。
 *
 * 情绪用两轴表示，取值都夹在 0-100：
 *   · arousal（唤醒/精神）：越高越兴奋、越坐不住；
 *   · valence（愉悦/心情）：越高越开心，越低越委屈。
 * 表情由两轴 + 昼夜映射到 persona 的 Mood。两轴各分低/中/高三档是九格，
 * 契约只给其中几条判定规则，没命中的格子落到 idle。
 *
 * 纯状态机：不读 DOM、不碰 localStorage、不引第三方依赖，便于单测。
 */
import { deepFreeze } from '../../shared/immutable.js'
import type { Mood } from '../persona.js'
import type { NervousEvent } from './stream.js'

// 事件类型统一由第一层 stream.ts 定义（契约「事件（三层共用）」），这里只转发
export type { NervousEvent }

/** 二维情绪状态：两个轴都是 0-100 */
export interface AffectState { arousal: number; valence: number }

/** 第二层对外接口（契约固定，不改名不加必填参数） */
export interface AffectModel {
  read(): AffectState
  apply(e: NervousEvent): void
  tick(now: number, away: boolean, night: boolean): void
  reset(): void
}

type Delta = { arousal: number; valence: number }

/**
 * 全部可调常量集中在这里：调参只改这一个对象，规则本身不用动。
 * 数值口径来自契约，改动前先同步契约。
 */
const RULES = deepFreeze({
  /** 两轴统一取值范围 */
  min: 0,
  max: 100,
  /** 初始情绪：略高于中位，开局是「有精神、心情不错」 */
  initial: { arousal: 65, valence: 55 },
  /** 一次性事件的增量：activity / back / work */
  gains: {
    activity: { arousal: 2, valence: 1 },
    back: { arousal: 2, valence: 3 },
    work: { arousal: 2, valence: 1 },
  },
  /** 主人不在时的心跳衰减（只由 tick(away=true) 扣，事件流里的 away 事件不重复扣） */
  awayHeartbeat: { arousal: -1, valence: -1 },
  /** 夜间心跳把 arousal 压到这个上限（契约：≤40） */
  nightArousalCap: 40,
  /** 九格表情阈值：命中顺序与契约一致，先到先判 */
  face: {
    /** 夜间或 arousal ≤20 → sleepy */
    sleepyArousal: 20,
    /** valence ≤20 且 arousal ≥60 → sulk */
    sulkValence: 20,
    sulkArousal: 60,
    /** arousal ≥85 且 valence ≥60 → excited */
    excitedArousal: 85,
    excitedValence: 60,
    /** valence ≥80 且 arousal ≤40 → shy */
    shyValence: 80,
    shyArousal: 40,
  },
  /**
   * 宿主事件（第三层）的增量：按事件名前缀匹配。
   * 权重刻意压得很小（0.2~0.6），因为一次工具调用不该让鲸「激动」；
   * 只有明确的失败类事件才给大幅度的负 valence。
   */
  host: {
    /** 同一事件名的冷却：连续工具调用在这段时间内只算一次 */
    cooldownMs: 1500,
    byPrefix: {
      'tool/': { arousal: 0.6, valence: 0.2 },
      'turn/': { arousal: 0.5, valence: 0.2 },
      'job/': { arousal: 0.2, valence: 0 },
    },
    /** 失败/中断类：不论前缀，一律按这条算 */
    failure: { arousal: 2, valence: -2 },
  },
})

/** 把单轴夹到 [min, max]；非数字（NaN/Infinity/undefined）回落到 fallback */
function clampAxis(n: number, fallback: number): number {
  const v = Number.isFinite(n) ? n : fallback
  if (v < RULES.min) return RULES.min
  if (v > RULES.max) return RULES.max
  return v
}

/** 归一化任意输入；缺哪个轴就用哪个轴的默认值，绝不留下 NaN */
function normalize(src: any): AffectState {
  const a = src && src.arousal !== undefined ? src.arousal : RULES.initial.arousal
  const v = src && src.valence !== undefined ? src.valence : RULES.initial.valence
  return {
    arousal: clampAxis(a, RULES.initial.arousal),
    valence: clampAxis(v, RULES.initial.valence),
  }
}

/** 按事件类型取增量；契约没列的类型（away/tick/host/mood）返回 null，不凭感觉加规则 */
function gainOf(type: string): Delta | null {
  const gains = RULES.gains as unknown as Record<string, Delta>
  return Object.prototype.hasOwnProperty.call(gains, type) ? gains[type] : null
}

/** 宿主事件名 → 增量；失败类优先，未知名字返回 null（不猜） */
function hostDeltaOf(name: string): Delta | null {
  if (!name) return null
  const host = RULES.host as unknown as { byPrefix: Record<string, Delta>; failure: Delta }
  if (/error|fail|abort|crash/i.test(name)) return host.failure
  const keys = Object.keys(host.byPrefix)
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    if (name.indexOf(k) === 0) return host.byPrefix[k]
  }
  return null
}

export function createAffectModel(opts?: { initial?: AffectState }): AffectModel {
  const initial = normalize(opts && opts.initial)
  let state: AffectState = { arousal: initial.arousal, valence: initial.valence }
  /** 上一次心跳的时刻；当前规则不依赖时间差，留给以后按时间衰减/平滑用 */
  let lastTickAt = 0
  /** 宿主事件名的冷却表：同名事件在 cooldownMs 内只算一次 */
  const hostLastAt = new Map<string, number>()

  function applyDelta(d: Delta): void {
    // 整体替换而不是改字段：read() 返回的快照与内部状态互不影响
    state = {
      arousal: clampAxis(state.arousal + d.arousal, state.arousal),
      valence: clampAxis(state.valence + d.valence, state.valence),
    }
  }

  return {
    /** 读快照：返回新对象，调用方改不到模型内部 */
    read(): AffectState {
      return { arousal: state.arousal, valence: state.valence }
    },

    apply(e: NervousEvent): void {
      if (!e || typeof e !== 'object') return
      const delta = gainOf(e.type)
      if (delta) { applyDelta(delta); return }
      if (e.type !== 'host') return
      const data = (e as any).data || {}
      const name = String(data.name || data.event || '')
      if (!name) return
      const now = Number.isFinite(Number(e.at)) ? Number(e.at) : Date.now()
      const last = hostLastAt.get(name)
      // last 为 undefined 表示这个事件名从没见过：首条必须放行（不能拿 0 当时间戳比）
      if (last !== undefined && now - last < RULES.host.cooldownMs) return
      const hd = hostDeltaOf(name)
      if (!hd) return
      hostLastAt.set(name, now)
      applyDelta(hd)
    },

    tick(now: number, away: boolean, night: boolean): void {
      lastTickAt = now
      if (away) applyDelta(RULES.awayHeartbeat)
      // 夜间只压唤醒度，不动心情；压完仍然夹在 0-100（夜间上限已小于 100）
      if (night) {
        state = {
          arousal: clampAxis(Math.min(state.arousal, RULES.nightArousalCap), state.arousal),
          valence: clampAxis(state.valence, state.valence),
        }
      }
    },

    reset(): void {
      state = { arousal: initial.arousal, valence: initial.valence }
    },
  }
}

/**
 * 九格表情映射（契约固定）：
 *   夜间 或 arousal ≤20        → sleepy
 *   valence ≤20 且 arousal ≥60 → sulk
 *   arousal ≥85 且 valence ≥60 → excited
 *   valence ≥80 且 arousal ≤40 → shy
 *   其余                       → idle
 * 判定顺序不能换：夜间/低唤醒优先于委屈，避免困着还挂个生气脸。
 */
export function faceOf(s: AffectState, night: boolean): Mood {
  const src: any = s || {}
  const a = clampAxis(src.arousal, RULES.initial.arousal)
  const v = clampAxis(src.valence, RULES.initial.valence)

  if (night || a <= RULES.face.sleepyArousal) return 'sleepy'
  if (v <= RULES.face.sulkValence && a >= RULES.face.sulkArousal) return 'sulk'
  if (a >= RULES.face.excitedArousal && v >= RULES.face.excitedValence) return 'excited'
  if (v >= RULES.face.shyValence && a <= RULES.face.shyArousal) return 'shy'
  return 'idle'
}
