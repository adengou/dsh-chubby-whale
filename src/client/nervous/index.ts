/**
 * client/nervous/index.ts —— 鲸的神经系统（独立模块，可整体摘除）
 *
 * 三层，各自一条契约：
 *   · 感官层：只读监听主人活动（鼠标/键盘/可见性）与昼夜，不碰宿主、不阻塞任何请求；
 *   · 情绪层：交给 affect.ts 的二维模型（arousal/valence）归约，再由 faceOf 映射到 Mood，
 *     不凭空造状态；本文件只负责把「activity/back/work/away/night」喂进去；
 *   · 表达层：调 persona.setMood 换表情，低频气泡说两句话，不刷屏。
 *
 * 开关：localStorage `chubby-nervous`（默认 on）；关掉即摘监听与定时器。
 * 撤除（五处，全部是加法，删掉即回到原样）：
 *   1) src/client/nervous/ 整个目录
 *   2) client.ts：import、attach 的 useEffect、buildMenu 里的 nervousOn 字段
 *   3) client/menu.ts：MenuState.nervousOn、nervousOn 变量、菜单项、TOGGLE_EN 一行
 *   4) client/actions/nervous.ts + client.ts 里的 registerNervousActions
 *   5) actions/voice.ts 与 actions/proofread.ts 里的 noteWork 调用与 import
 */
import type { Persona, Mood } from '../persona.js'
import { createAffectModel, faceOf } from './affect.js'
import type { AffectModel } from './affect.js'
import { createEventLog } from './stream.js'
import type { EventLog, NervousEvent } from './stream.js'
import { createHostSense } from './host-sense.js'
import type { SenseSource } from './host-sense.js'
import { createDreamBook } from './dream.js'

const LS_KEY = 'chubby-nervous'
/** 闲置多久算「主人不在」 */
const AWAY_MS = 20 * 60 * 1000
/** 两条气泡各自的最小间隔，避免刷屏 */
const AWAY_LINE_GAP_MS = 40 * 60 * 1000
const BACK_LINE_GAP_MS = 20 * 60 * 1000
/** 活动采样节流 */
const ACTIVITY_THROTTLE_MS = 5000
/** 心跳间隔：衰减与表情判断都在这里做 */
const TICK_MS = 30 * 1000
/** 困意跟着心跳走：下一次心跳时还有机会重新判定 */
const SLEEPY_HOLD_MS = TICK_MS + 5000
/** 其余由情绪算出的表情挂 15 秒，到点自动回落，别把一瞬间的低落挂太久 */
const TRANSIENT_HOLD_MS = 15000
/** 干活时临时活泼的挂起时长（沿用原实现） */
const WORK_HOLD_MS = 8000

export type NervousDeps = {
  persona: Persona
  bubble: (text: string, ms?: number) => void
  /**
   * 第一层事件流的可选注入点。只要求有 log(e)，不 import stream.ts，
   * 缺省就只做情绪、不记账（没有第一层时主功能照常）。
   */
  eventLog?: { log(e: any): void }
}

type Session = {
  deps: NervousDeps
  timer: any
  lastActivityAt: number
  lastAwayLineAt: number
  lastBackLineAt: number
  /** 二维情绪模型（取代原先的单 energy 轴） */
  affect: AffectModel
  /** 第一层事件流：缺省自动创建，注入优先 */
  log: EventLog
  /** 第三层宿主事件源：可空（宿主路由没起来时） */
  sense: SenseSource | null
  /** 上一次心跳是否处于「不在」，只在翻转时记一条 away 事件 */
  wasAway: boolean
  listeners: Array<() => void>
}

let current: Session | null = null

export function nervousEnabled(): boolean {
  try { return localStorage.getItem(LS_KEY) !== 'off' } catch (e) { return true }
}

export function setNervousEnabled(on: boolean): void {
  try { localStorage.setItem(LS_KEY, on ? 'on' : 'off') } catch (e) { }
}

function hourOf(): number {
  return new Date().getHours()
}

/** 深夜/清晨：23 点到 5 点 */
function isNight(): boolean {
  const h = hourOf()
  return h >= 23 || h < 5
}

/** 往第一层记账；eventLog 自带静默失败，这里再兜一层，绝不影响主功能 */
function emit(s: Session, type: NervousEvent['type'], data?: Record<string, any>): void {
  try { s.log.log({ at: Date.now(), type, data }) } catch (e) { }
}

/** 当前 mood；persona.state 缺省时按 idle 处理，不让异常中断心跳 */
function moodOf(s: Session): Mood | null {
  try { return s.deps.persona.state ? s.deps.persona.state.mood : null } catch (e) { return null }
}

function tick(s: Session): void {
  if (!nervousEnabled()) return
  const now = Date.now()
  const away = now - s.lastActivityAt > AWAY_MS
  const night = isNight()

  // 情绪：away 衰减与夜间压唤醒度都在模型里做，这里只把环境算好传进去
  s.affect.tick(now, away, night)
  const st = s.affect.read()
  emit(s, 'tick', { away, night, arousal: st.arousal, valence: st.valence })
  if (away && !s.wasAway) emit(s, 'away', { sinceMs: now - s.lastActivityAt })
  s.wasAway = away

  // 表情：只在没有临时情绪时动手，避免盖掉聊天/喂食刚设的表情
  if (moodOf(s) === 'idle') {
    const face = faceOf(st, night)
    if (face !== 'idle') {
      try { s.deps.persona.setMood(face, face === 'sleepy' ? SLEEPY_HOLD_MS : TRANSIENT_HOLD_MS) } catch (e) { }
      emit(s, 'mood', { mood: face, arousal: st.arousal, valence: st.valence })
    }
  }

  // 表达：低频两句话（阈值与节奏保持原样）
  if (away && now - s.lastAwayLineAt > AWAY_LINE_GAP_MS) {
    s.lastAwayLineAt = now
    try { s.deps.bubble('主人…是不是把本鲸忘了', 4000) } catch (e) { }
  }
  if (!away && s.lastBackLineAt && now - s.lastBackLineAt > BACK_LINE_GAP_MS) {
    // 从「不在」回到「在」，且距离上次那句已经很远
    s.lastBackLineAt = 0
    try { s.deps.bubble('本鲸在呢', 2600) } catch (e) { }
  }
  if (away && !s.lastBackLineAt) s.lastBackLineAt = now
}

/** 挂上神经系统；重复调用是幂等的，返回 detach */
export function attachNervous(deps: NervousDeps): () => void {
  if (current) return detachNervous
  // 第一层：注入优先，缺省自建；建不出来用空实现兜底，主功能照常
  let log: EventLog
  try {
    log = deps.eventLog ? (deps.eventLog as unknown as EventLog) : createEventLog()
  } catch (e) {
    log = { log: () => { }, recent: () => [], stats: () => ({ count: 0, since: 0 }) }
  }
  const s: Session = {
    deps,
    timer: null,
    lastActivityAt: Date.now(),
    lastAwayLineAt: 0,
    lastBackLineAt: 0,
    affect: createAffectModel(),
    wasAway: false,
    listeners: [],
    log,
    sense: null,
  }
  current = s
  emit(s, 'host', { hook: 'attach' })

  // 第三层：宿主事件源（轮询 /nervous）。失败静默，缺它只影响「感知宿主」这一路
  try {
    const sense = createHostSense()
    s.sense = sense
    let focusSession = ''
    sense.start((e) => {
      try { s.log.log(e) } catch (err) { }
      // 会话聚焦：只在同一个会话连续活动时给情绪打分；换会话（含子代理）的第一条只记账，
      // 免得别人的会话把这只鲸的情绪带跑。affect 内部还有事件名冷却，双重限流。
      const sess = String((e as any).data?.session || '')
      if (sess && focusSession && sess !== focusSession) {
        focusSession = sess
        return
      }
      if (sess) focusSession = sess
      try { s.affect.apply(e as any) } catch (err) { }
    })
  } catch (e) {
    s.sense = null
  }

  let lastSample = 0
  const onActivity = (): void => {
    const now = Date.now()
    const prev = s.lastActivityAt
    const back = prev > 0 && now - prev > AWAY_MS
    s.lastActivityAt = now
    // 从「不在」回来只发生一次，不受下面节流影响：先记 back，再按节流记 activity
    if (back) {
      s.affect.apply({ at: now, type: 'back' })
      emit(s, 'back', { awayMs: now - prev })
    }
    if (now - lastSample < ACTIVITY_THROTTLE_MS) return
    lastSample = now
    s.affect.apply({ at: now, type: 'activity' })
    emit(s, 'activity', {})
  }
  const onVisible = (): void => {
    try { if (document.visibilityState === 'visible') onActivity() } catch (e) { }
  }
  const bind = (target: any, name: string, fn: any): void => {
    try {
      target.addEventListener(name, fn, { passive: true })
      s.listeners.push(() => { try { target.removeEventListener(name, fn) } catch (e) { } })
    } catch (e) { }
  }
  bind(window, 'mousemove', onActivity)
  bind(window, 'keydown', onActivity)
  bind(window, 'touchstart', onActivity)
  bind(document, 'visibilitychange', onVisible)

  s.timer = setInterval(() => { try { tick(s) } catch (e) { } }, TICK_MS)

  // 夜潜：把「昨天」的事件流反刍成一句梦话。数据太少 / 已做过梦就跳过，绝不硬编。
  try {
    const dreams = createDreamBook()
    const dream = dreams.maybeDream(s.log.recent(800))
    if (dream && !dreams.spoken(dream.date)) {
      dreams.markSpoken(dream.date)
      // 晚两秒再说：别让页面一开就抢在「早呀」前面
      setTimeout(() => { try { s.deps.bubble(dream.lines.join(' '), 7000) } catch (e) { } }, 2500)
    }
  } catch (e) { }

  return detachNervous
}

/** 摘掉监听与定时器，并把当前会话清空 */
export function detachNervous(): void {
  const s = current
  current = null
  if (!s) return
  emit(s, 'host', { hook: 'detach' })
  try { if (s.sense) s.sense.stop() } catch (e) { }
  try { clearInterval(s.timer) } catch (e) { }
  for (const off of s.listeners) { try { off() } catch (e) { } }
  s.listeners.length = 0
}

/** 供动作层打点：一次「干活了」的体会（朗读/校对/聊天开始时叫一声） */
export function noteWork(kind?: string): void {
  const s = current
  if (!s || !nervousEnabled()) return
  const now = Date.now()
  s.lastActivityAt = now
  s.affect.apply({ at: now, type: 'work', data: kind ? { kind } : undefined })
  emit(s, 'work', { kind })
  if (kind && kind.length > 0) {
    // 干活时临时活泼一下；不覆盖当前非 idle 的情绪
    if (moodOf(s) === 'idle') {
      try { s.deps.persona.setMood('excited', WORK_HOLD_MS) } catch (e) { }
      emit(s, 'mood', { mood: 'excited', cause: 'work' })
    }
  }
}

/** 只暴露给测试/诊断：当前唤醒度（arousal，0-100）；未挂载为 null */
export function nervousEnergy(): number | null {
  if (!current) return null
  try { return current.affect.read().arousal } catch (e) { return null }
}

/** 诊断快照：二维情绪 + 宿主事件源是否在跑（null = 未挂载） */
export function nervousSnapshot(): { arousal: number; valence: number; sense: boolean } | null {
  if (!current) return null
  try {
    const st = current.affect.read()
    return { arousal: st.arousal, valence: st.valence, sense: Boolean(current.sense) }
  } catch (e) {
    return null
  }
}

export type { Mood }
