/**
 * client/persona.ts —— 饭团（肥鲸）人设运行时
 *
 * 设计原则：人设不是静态文案，而是"事件 → 情绪 → 台词"的状态机。
 *   · 台词库全部放在 data/persona.json（便于主人改文案，不用碰代码）
 *   · 情绪状态一次只允许一个主状态，避免"又饿又委屈又兴奋"这种机器感
 *   · 情绪可视化：mood → 气泡前缀表情，由 client/bubble.ts 显示时读取；
 *     只影响气泡外观，不改台词正文，也不进朗读文本
 *   · 成长用"碗数"表示亲密度，只升不降（她会记得你）
 *   · 所有状态持久化在 localStorage，刷新不丢
 */

import { deepFreeze } from '../shared/immutable.js'
import personaData from '../../data/persona.json'

export type Mood = 'idle' | 'hungry' | 'sleepy' | 'excited' | 'shy' | 'sulk' | 'guard'

export type PersonaState = {
  bowls: number
  stageIndex: number
  stageName: string
  mood: Mood
  lastFeedAt: number
  lastInteractAt: number
}

type PersonaJson = typeof personaData

const LS = 'chubby-persona-v1'

/**
 * 情绪 → 气泡前缀表情（可视化用）。只加在气泡显示层，台词文案一个字都不改。
 * 缺省表情是鲸鱼本体（idle）；未知情绪不显示。
 */
export const MOOD_FACES: Readonly<Record<Mood, string>> = deepFreeze({
  idle: '🐳',
  hungry: '🍚',
  sleepy: '💤',
  excited: '✨',
  shy: '💗',
  sulk: '💢',
  guard: '🍙',
})

/** 同一场景台词的防重窗口：窗口内不连续返回同一句；过窗后允许原句再来 */
export const LINE_WINDOW_MS = 60000

/** 当前活跃的人设实例（页面里只有一个；气泡模块据此读取情绪） */
let activeState: PersonaState | null = null
let activeMoodSource: (() => Mood) | null = null

/** 当前应该显示的情绪：先刷新一次，饿/困这类按时间算的情绪才能及时显出来 */
export function currentMood(): Mood {
  if (activeMoodSource) {
    try { return activeMoodSource() } catch (e) { }
  }
  return activeState ? activeState.mood : 'idle'
}

/**
 * 服务端 mood → 客户端 Mood（启动时从 /pet 同步一次）。
 * 服务端只发 normal/happy/hungry：happy→excited、hungry→hungry、normal→idle；
 * 其余值不覆盖（sleepy/sulk/shy/guard 是客户端本地情绪）。
 */
export function applyServerMood(m: string): void {
  const s = String(m == null ? '' : m).toLowerCase()
  const map: Record<string, Mood> = { happy: 'excited', excited: 'excited', hungry: 'hungry', normal: 'idle', idle: 'idle' }
  const mood = map[s]
  if (!mood) return
  if (activeState) { try { activeState.mood = mood } catch (e) { } }
}

/** mood → 表情；未知情绪返回空串（不显示） */
export function moodFace(mood?: string): string {
  return (MOOD_FACES as any)[String(mood == null ? '' : mood)] || ''
}

/**
 * 气泡前缀（表情 + 一个空格）。开关：localStorage 的 chubby-mood-emoji，
 * 缺省开；设为 off / 0 / false 关闭。开关每次读取，改完无需刷新页面。
 */
export function moodPrefix(mood?: string): string {
  let on = true
  try {
    const v = localStorage.getItem('chubby-mood-emoji')
    if (v === 'off' || v === '0' || v === 'false') on = false
  } catch (e) { on = true }
  if (!on) return ''
  const face = moodFace(mood == null ? currentMood() : mood)
  return face ? face + ' ' : ''
}

function loadState(): PersonaState {
  const base: PersonaState = { bowls: 0, stageIndex: 0, stageName: '刚认识', mood: 'idle', lastFeedAt: 0, lastInteractAt: 0 }
  try {
    const raw = localStorage.getItem(LS)
    if (!raw) return base
    const s = JSON.parse(raw)
    return {
      ...base,
      bowls: Number(s.bowls) || 0,
      stageIndex: Number(s.stageIndex) || 0,
      lastFeedAt: Number(s.lastFeedAt) || 0,
      lastInteractAt: Number(s.lastInteractAt) || 0,
      // 情绪不跨刷新持久化：每次启动从 idle 重新判定（饿/困按 lastFeedAt 与时间现算）
      mood: 'idle',
    }
  } catch (e) { return base }
}

function saveState(s: PersonaState): void {
  try { localStorage.setItem(LS, JSON.stringify({ bowls: s.bowls, stageIndex: s.stageIndex, lastFeedAt: s.lastFeedAt, lastInteractAt: s.lastInteractAt })) } catch (e) { }
}

export type PersonaOptions = {
  /** 时间源（离线测试可注入；缺省 Date.now） */
  now?: () => number
  /** 台词防重窗口（毫秒；缺省 LINE_WINDOW_MS） */
  lineWindowMs?: number
}

export function createPersona(opts?: PersonaOptions) {
  const nowFn: () => number = (opts && typeof opts.now === 'function') ? opts.now : () => Date.now()
  const rawWin = opts ? opts.lineWindowMs : undefined
  const lineWindowMs = (typeof rawWin === 'number' && isFinite(rawWin) && rawWin >= 0) ? rawWin : LINE_WINDOW_MS
  const data = personaData as PersonaJson
  const state = loadState()
  state.stageIndex = stageIndexOf(state.bowls)
  state.stageName = data.stages[state.stageIndex] ? data.stages[state.stageIndex].name : '刚认识'

  function stageIndexOf(bowls: number): number {
    let idx = 0
    for (let i = 0; i < data.stages.length; i++) if (bowls >= data.stages[i].bowls) idx = i
    return idx
  }

  // 洗牌抽签：每个场景把台词洗一遍，抽完一轮才会重复 —— 不会老是那两三句
  const bags = new Map<string, number[]>()
  function shuffle(a: number[]): void {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const t = a[i]; a[i] = a[j]; a[j] = t
    }
  }
  function pick(arr?: string[], key = ''): string {
    if (!arr || !arr.length) return ''
    if (!key) return arr[Math.floor(Math.random() * arr.length)]
    let bag = bags.get(key)
    if (!bag || !bag.length) {
      bag = arr.map((_, i) => i)
      shuffle(bag)
      bags.set(key, bag)
    }
    const idx = bag.pop() as number
    return arr[idx] || arr[0]
  }

  function touch(): void {
    state.lastInteractAt = nowFn()
    saveState(state)
  }

  /** 主状态判定：优先级 兴奋 > 委屈 > 害羞 > 护食 > 饿 > 困 > 待机 */
  function refreshMood(now = nowFn()): Mood {
    const hour = new Date(now).getHours()
    const sinceFeed = state.lastFeedAt ? now - state.lastFeedAt : Infinity
    if (state.mood === 'excited' || state.mood === 'sulk' || state.mood === 'shy' || state.mood === 'guard') return state.mood
    if (sinceFeed > 6 * 3600 * 1000) state.mood = 'hungry'
    else if (hour >= 23 || hour < 5) state.mood = 'sleepy'
    else state.mood = 'idle'
    return state.mood
  }

  // 临时情绪只有一个回落定时器：连续两次 setMood 时旧定时器必须取消，
  // 否则旧定时器先到点会把后一次设置的（更长的）情绪提前清成 idle。
  let moodTimer: any = null
  /** 临时情绪（默认 5 秒后自动回落到 refreshMood 的结果） */
  function setMood(m: Mood, holdMs = 5000): void {
    state.mood = m
    try { if (moodTimer) clearTimeout(moodTimer) } catch (e) { }
    moodTimer = setTimeout(() => {
      moodTimer = null
      try { state.mood = 'idle'; refreshMood() } catch (e) { }
    }, holdMs)
  }

  // 登记给气泡模块：显示前刷新一次情绪（幂等；临时情绪不会被刷新覆盖）
  activeState = state
  activeMoodSource = () => refreshMood()

  /** 台词库缺 key 时的兜底：调用点（气泡/朗读）都不判空，绝不能返回空串 */
  const FALLBACK_LINE = '……本鲸在。'

  // 同一场景台词防重：窗口内抽到与上一次相同就换一条（只换句、不改文案）。
  // 池里只有一条时无备选，只能重复；窗口外不干预，原句可以再来。
  const lastLine = new Map<string, { text: string; at: number }>()

  function line(event: string): string {
    const lines = (data.lines as any)[event]
    let text = pick(lines, event) || FALLBACK_LINE
    const prev = lastLine.get(event)
    const now = nowFn()
    if (prev && prev.text === text && now - prev.at < lineWindowMs) {
      const alts = Array.isArray(lines) ? lines.filter((s: any) => s && s !== text) : []
      if (alts.length) text = alts[Math.floor(Math.random() * alts.length)]
    }
    lastLine.set(event, { text, at: now })
    return text
  }

  function greeting(now = nowFn()): string {
    const h = new Date(now).getHours()
    if (h >= 23 || h < 5) return line('greetLate')
    if (h < 11) return line('greetMorning')
    if (h < 17) return line('greetNoon')
    return line('greetEvening')
  }

  /** 投喂：碗数 +1，阶段变化时返回 stageUp 台词 */
  function feed(): { text: string; bowls: number; stage: string; stageUp: boolean } {
    const before = state.stageIndex
    state.bowls += 1
    state.lastFeedAt = nowFn()
    state.lastInteractAt = state.lastFeedAt
    state.stageIndex = stageIndexOf(state.bowls)
    state.stageName = data.stages[state.stageIndex] ? data.stages[state.stageIndex].name : '刚认识'
    saveState(state)
    const stageUp = state.stageIndex > before
    const text = stageUp ? line('stageUp') : (state.bowls === 1 ? line('feedFirst') : line('feed'))
    if (!stageUp) setMood('shy', 4000)
    return { text, bowls: state.bowls, stage: state.stageName, stageUp }
  }

  /** 从文本里识别情绪触发（夸/凶/新米/泡面/剩饭） */
  function reactTo(text: string): { event: string; text: string; mood: Mood } | null {
    const t = String(text || '')
    if (!t) return null
    if (/新米|开饭|锅巴/.test(t)) { setMood('excited', 6000); return { event: 'excited', text: line('excited'), mood: 'excited' } }
    if (/乖|可爱|好鱼|棒|喜欢你|真聪明|厉害/.test(t)) { setMood('shy', 5000); return { event: 'praise', text: line('praise'), mood: 'shy' } }
    if (/闭嘴|烦|滚|讨厌|笨蛋|丑/.test(t)) { setMood('sulk', 6000); return { event: 'scold', text: line('scold'), mood: 'sulk' } }
    // 下面三组和上面一样要落到状态机上：只返回 mood 不改 state.mood，
    // 会出现"表情/状态还是 idle，台词已经是委屈"的不一致
    if (/剩饭|倒掉|扔了/.test(t)) { setMood('sulk', 6000); return { event: 'leftover', text: line('leftover'), mood: 'sulk' } }
    if (/胖|减肥|会长胖/.test(t)) { setMood('sulk', 6000); return { event: 'fatTalk', text: line('fatTalk'), mood: 'sulk' } }
    if (/泡面|方便面/.test(t)) { setMood('sulk', 6000); return { event: 'instantNoodle', text: line('instantNoodle'), mood: 'sulk' } }
    return null
  }

  return {
    state,
    refreshMood,
    setMood,
    line,
    greeting,
    feed,
    reactTo,
    touch,
  }
}

export type Persona = ReturnType<typeof createPersona>
