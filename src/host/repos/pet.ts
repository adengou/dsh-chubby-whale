/**
 * host/repos/pet.ts —— 宠物状态仓储（pet_state.json：feeds/hunger/mood/lastSeen/lastFeedAt/intimacy）
 *
 * 从 host/store.ts 拆出：离线越久越饿（每小时 +3）、喂食 -30 饥饿 +2 亲密（照 C# 版）。
 * 写盘走 host/atomic.ts；读坏文件按 [store] 前缀留痕并备份。
 * 读入容错 UTF-8 BOM，写出统一 UTF-8 无 BOM。
 *
 * 饥饿结算用「距上次结算的时间差」，不是「距上次喂食」：每次结算后把 lastSeen
 * 推到 now，间隔可无限细分，饥饿增长速度与轮询频率无关；大时间差只封顶 100，
 * 时钟回拨（lastSeen 在将来）按 0 处理并回写 now，绝不让饥饿/心情倒着走。
 * 心情由饥饿度与 lastFeedAt 推导（happy 只保留 6 小时），喂食即时写 happy。
 */
import { join } from 'node:path'
import { writeJsonAtomic, isMissingFileError, quarantineFile, readTextNoBom } from '../atomic.js'

/** 离线每小时涨 3 点饥饿（照 C# 版） */
const HUNGER_PER_HOUR = 3
/** 饥饿到 70 算「饿了」，由 /pet 下发 hungry（客户端只认 happy/hungry/normal 三态） */
const HUNGRY_AT = 70
/** 喂食后心情保持 happy 的时长，与客户端 6 小时「该喂了」的阈值同口径 */
const HAPPY_WINDOW_MS = 6 * 3600 * 1000

export interface PetRepo {
  loadPet(): any
  savePet(obj: any): void
  /** 读取时结算饥饿/离线时长并更新 lastSeen */
  tickPet(): any
  feedPet(): any
  setMood(mood: string): void
}

/** 饥饿统一夹到 [0, 100]；非数字按 0 */
function cleanHunger(value: any): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, n))
}

/** 计数类字段统一成非负整数，防旧文件里的负值/小数继续传播 */
function cleanCount(value: any): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/**
 * 历史字段 intimacy（亲密度真源在 state.json，这里只做展示兼容）也按 [0,100] 整数夹紧。
 * 旧实现只写了 `Math.min(100, (Number(p.intimacy) || 0) + 2)`：上界有、下界没有，
 * pet_state.json 里一旦是负数（老文件/导入），每次喂食只会越喂越负（实测 -50 → -48 → -46），
 * 还会以负值落盘。清洗口径与 state 仓储保持一致。
 */
function cleanLegacyIntimacy(value: any): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.floor(n)))
}

export function createPetRepo(dataDir: string): PetRepo {
  const PET = join(dataDir, 'pet_state.json')

  function loadPet(): any {
    try {
      const obj = JSON.parse(readTextNoBom(PET))
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj
    } catch (err: any) {
      if (!isMissingFileError(err)) quarantineFile(PET, err, '[store]')
    }
    return { feeds: 0, hunger: 0, mood: 'normal', lastSeen: 0 }
  }
  function savePet(obj: any): void {
    try { writeJsonAtomic(PET, obj) } catch (err: any) { console.error('[store] WRITE-FAIL ' + String(PET) + ' err=' + String(err?.message || err)) }
  }
  function tickPet(): any {
    const p = loadPet()
    const now = Date.now()
    const lastSeen = Number(p.lastSeen)
    let hunger = cleanHunger(p.hunger)
    // 只在 lastSeen 是「过去」的合法时间时结算；NaN / 0 / 将来（时钟回拨）都跳过
    if (Number.isFinite(lastSeen) && lastSeen > 0 && lastSeen <= now) {
      const hoursAway = (now - lastSeen) / 3600000
      if (hoursAway > 0) hunger = Math.min(100, hunger + hoursAway * HUNGER_PER_HOUR)
    }
    p.hunger = cleanHunger(hunger)
    p.lastSeen = now
    // lastFeedAt 是新增字段：老文件没有就按 0；时钟回拨（将来时间）也按 0，不参与 happy 判定
    const lastFeed = Number(p.lastFeedAt)
    if (Number.isFinite(lastFeed) && lastFeed > 0 && lastFeed <= now) p.lastFeedAt = lastFeed
    else p.lastFeedAt = 0
    p.mood = (p.lastFeedAt > 0 && now - p.lastFeedAt < HAPPY_WINDOW_MS)
      ? 'happy'
      : (p.hunger >= HUNGRY_AT ? 'hungry' : 'normal')
    p.intimacy = cleanLegacyIntimacy(p.intimacy)   // 历史字段：落盘永远不出现负值/超限值
    savePet(p)
    return p
  }
  function feedPet(): any {
    const p = tickPet()
    const now = Date.now()
    p.feeds = cleanCount(p.feeds) + 1
    p.hunger = Math.max(0, cleanHunger(p.hunger) - 30)
    p.intimacy = Math.min(100, cleanLegacyIntimacy(p.intimacy) + 2)   // 照 C#：喂食亲密 +2（历史字段，真源在 state.json）
    p.lastFeedAt = now
    p.mood = 'happy'
    savePet(p)
    return p
  }
  function setMood(mood: string): void {
    const p = loadPet()
    p.mood = mood
    savePet(p)
  }

  return { loadPet, savePet, tickPet, feedPet, setMood }
}
