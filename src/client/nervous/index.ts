/**
 * client/nervous/index.ts —— 鲸的神经系统（独立模块，可整体摘除）
 *
 * 三层，各自一条契约：
 *   · 感官层：只读监听主人活动（鼠标/键盘/可见性）与昼夜，不碰宿主、不阻塞任何请求；
 *   · 情绪层：把事件归约成一个 energy（0-100），再映射到现有 Mood，不凭空造状态；
 *   · 表达层：调 persona.setMood 换表情，低频气泡说两句话，不刷屏。
 *
 * 开关：localStorage `chubby-nervous`（默认 on）；关掉即摘监听与定时器。
 * 撤除：删掉本目录 + client.ts 的接入两行 + menu/actions 各一项即可，不留依赖。
 */
import type { Persona, Mood } from '../persona.js'

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

export type NervousDeps = {
  persona: Persona
  bubble: (text: string, ms?: number) => void
}

type Session = {
  deps: NervousDeps
  timer: any
  lastActivityAt: number
  lastAwayLineAt: number
  lastBackLineAt: number
  energy: number
  listeners: Array<() => void>
}

let current: Session | null = null

export function nervousEnabled(): boolean {
  try { return localStorage.getItem(LS_KEY) !== 'off' } catch (e) { return true }
}

export function setNervousEnabled(on: boolean): void {
  try { localStorage.setItem(LS_KEY, on ? 'on' : 'off') } catch (e) { }
}

function clamp(n: number): number {
  return n < 0 ? 0 : (n > 100 ? 100 : n)
}

function hourOf(): number {
  return new Date().getHours()
}

/** 深夜/清晨：23 点到 5 点 */
function isNight(): boolean {
  const h = hourOf()
  return h >= 23 || h < 5
}

function tick(s: Session): void {
  if (!nervousEnabled()) return
  const now = Date.now()
  const away = now - s.lastActivityAt > AWAY_MS
  const night = isNight()

  // 衰减：主人不在就慢慢没精神；深夜里压得更低
  if (away) s.energy = clamp(s.energy - 3)
  else s.energy = clamp(s.energy + 1)
  if (night) s.energy = clamp(Math.min(s.energy, 40))

  // 表情：只在没有临时情绪时动手，避免盖掉聊天/喂食刚设的表情
  try {
    const mood = s.deps.persona.state ? s.deps.persona.state.mood : null
    if (mood === 'idle') {
      if (night) s.deps.persona.setMood('sleepy', TICK_MS + 5000)
      else if (s.energy <= 20) s.deps.persona.setMood('sleepy', TICK_MS + 5000)
      else if (s.energy >= 85) s.deps.persona.setMood('excited', 15000)
    }
  } catch (e) { }

  // 表达：低频两句话
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
  const s: Session = {
    deps,
    timer: null,
    lastActivityAt: Date.now(),
    lastAwayLineAt: 0,
    lastBackLineAt: 0,
    energy: 65,
    listeners: [],
  }
  current = s

  let lastSample = 0
  const onActivity = (): void => {
    const now = Date.now()
    s.lastActivityAt = now
    if (now - lastSample < ACTIVITY_THROTTLE_MS) return
    lastSample = now
    s.energy = clamp(s.energy + 2)
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
  return detachNervous
}

/** 摘掉监听与定时器，并把当前会话清空 */
export function detachNervous(): void {
  const s = current
  current = null
  if (!s) return
  try { clearInterval(s.timer) } catch (e) { }
  for (const off of s.listeners) { try { off() } catch (e) { } }
  s.listeners.length = 0
}

/** 供动作层打点：一次「干活了」的体会（朗读/校对/聊天开始时叫一声） */
export function noteWork(kind?: string): void {
  const s = current
  if (!s || !nervousEnabled()) return
  s.energy = clamp(s.energy + 1)
  s.lastActivityAt = Date.now()
  if (kind && kind.length > 0) {
    // 干活时临时活泼一下；不覆盖当前非 idle 的情绪
    try {
      const mood = s.deps.persona.state ? s.deps.persona.state.mood : null
      if (mood === 'idle') s.deps.persona.setMood('excited', 8000)
    } catch (e) { }
  }
}

/** 只暴露给测试/诊断：当前能量 */
export function nervousEnergy(): number | null {
  return current ? current.energy : null
}

export type { Mood }
