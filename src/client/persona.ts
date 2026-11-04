/**
 * client/persona.ts —— 饭团（肥鲸）人设运行时
 *
 * 设计原则：人设不是静态文案，而是"事件 → 情绪 → 台词"的状态机。
 *   · 台词库全部放在 data/persona.json（便于主人改文案，不用碰代码）
 *   · 情绪状态一次只允许一个主状态，避免"又饿又委屈又兴奋"这种机器感
 *   · 成长用"碗数"表示亲密度，只升不降（她会记得你）
 *   · 所有状态持久化在 localStorage，刷新不丢
 */

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
      mood: 'idle',
    }
  } catch (e) { return base }
}

function saveState(s: PersonaState): void {
  try { localStorage.setItem(LS, JSON.stringify({ bowls: s.bowls, stageIndex: s.stageIndex, lastFeedAt: s.lastFeedAt, lastInteractAt: s.lastInteractAt })) } catch (e) { }
}

export function createPersona() {
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
    state.lastInteractAt = Date.now()
    saveState(state)
  }

  /** 主状态判定：优先级 兴奋 > 委屈 > 害羞 > 护食 > 饿 > 困 > 待机 */
  function refreshMood(now = Date.now()): Mood {
    const hour = new Date(now).getHours()
    const sinceFeed = state.lastFeedAt ? now - state.lastFeedAt : Infinity
    if (state.mood === 'excited' || state.mood === 'sulk' || state.mood === 'shy' || state.mood === 'guard') return state.mood
    if (sinceFeed > 6 * 3600 * 1000) state.mood = 'hungry'
    else if (hour >= 23 || hour < 5) state.mood = 'sleepy'
    else state.mood = 'idle'
    return state.mood
  }

  /** 临时情绪（5 秒后自动回落到 refreshMood 的结果） */
  function setMood(m: Mood, holdMs = 5000): void {
    state.mood = m
    setTimeout(() => { try { state.mood = 'idle'; refreshMood() } catch (e) { } }, holdMs)
  }

  function line(event: string): string {
    const lines = (data.lines as any)[event]
    return pick(lines, event)
  }

  function greeting(now = Date.now()): string {
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
    state.lastFeedAt = Date.now()
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
    if (/剩饭|倒掉|扔了/.test(t)) return { event: 'leftover', text: line('leftover'), mood: 'sulk' }
    if (/胖|减肥|会长胖/.test(t)) return { event: 'fatTalk', text: line('fatTalk'), mood: 'sulk' }
    if (/泡面|方便面/.test(t)) return { event: 'instantNoodle', text: line('instantNoodle'), mood: 'sulk' }
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
    /** 把 data/persona.json 里的菜单文案取出来（没配就返回原文） */
    menuLabel: (key: string, fallback: string): string => {
      const m = (data.menus as any)[key]
      return m ? String(m) : fallback
    },
  }
}

export type Persona = ReturnType<typeof createPersona>
