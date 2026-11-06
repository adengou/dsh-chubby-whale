/**
 * host/repos/fishfood.ts —— 鱼粮（token 统计）仓储（fishfood.json）
 * 从 host/store.ts 拆出：跨天/跨月清零「今日/本月」，总量 totalTokens 不动（照 C# 的 date/month 滚动）。
 * 写盘走 host/atomic.ts；读坏文件按 [store] 前缀留痕并备份。
 * 读入容错 UTF-8 BOM，写出统一 UTF-8 无 BOM。
 *
 * 跨天/跨月判断在读取时也做一次（只改内存返回值、不写盘）：否则新的一天在
 * 「第一条新消息到来之前」读到的今日/本月计数仍是昨天的，面板与统计会显示旧值。
 * 所有 token 字段按非负整数累加，并在 Number.MAX_SAFE_INTEGER 封顶，防脏值/溢出。
 */
import { join } from 'node:path'
import { writeJsonAtomic, isMissingFileError, quarantineFile, readTextNoBom } from '../atomic.js'

/** JS 安全整数上限：超过后 +1 不再改变数值（显示与统计都失真），到这里就封顶 */
const MAX_TOKEN = Number.MAX_SAFE_INTEGER

export interface TokenRepo {
  loadFishfood(): any
  saveFishfood(obj: any): void
  /** kind='story' 记说书 token，其余记聊天 token；同时累计总量/本月 */
  addTokens(kind: string, n: number): any
}

/** 非负整数（NaN/Infinity/负数/小数一律清洗，避免一条脏 usage 把整份鱼粮写成 null） */
function cleanToken(value: any): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(MAX_TOKEN, Math.floor(n))
}

/** 累加后按安全整数封顶 */
function addToken(current: any, add: number): number {
  const base = cleanToken(current)
  return Math.min(MAX_TOKEN, base + add)
}

export function createTokenRepo(dataDir: string): TokenRepo {
  const FISHFOOD = join(dataDir, 'fishfood.json')

  function loadFishfood(): any {
    try {
      const obj = JSON.parse(readTextNoBom(FISHFOOD))
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        rollFishfood(obj)
        return obj
      }
    } catch (err: any) {
      if (!isMissingFileError(err)) quarantineFile(FISHFOOD, err, '[store]')
    }
    // 新文件也要带 day/month 标记：否则首写落盘的文件没有标记，
    // 下一次 addTokens 读到「无标记」会把它当成跨天（见 rollFishfood）
    const fresh = { chatTokens: 0, storyTokens: 0 }
    rollFishfood(fresh)
    return fresh
  }
  function saveFishfood(obj: any): void {
    try { writeJsonAtomic(FISHFOOD, obj) } catch (err: any) { console.error('[store] WRITE-FAIL ' + String(FISHFOOD) + ' err=' + String(err?.message || err)) }
  }
  /**
   * 跨天/跨月把"今日/本月"清零（总量 totalTokens 不动，照 C# 的 date/month 滚动）。
   *
   * 缺 day/month 标记（新文件、老版本文件、备份导入）**不等于跨天**：只补标记、不清零。
   * 旧实现无条件比较，null !== today 就清零；而首写的新文件没有标记（默认对象没走过
   * rollFishfood），于是「第一次 addTokens 记的今日/本月 + 总量」会在下一次 addTokens
   * 时被当成「昨天」清零（实测 chatTokens 7 → 0、dayTokens 7 → 3，只有 totalTokens 幸存）。
   */
  function rollFishfood(f: any): void {
    const now = new Date()
    const day = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
    const month = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
    const hadDay = typeof f.day === 'string' && f.day.length > 0
    if (hadDay && f.day !== day) { f.chatTokens = 0; f.storyTokens = 0; f.dayTokens = 0 }
    f.day = day
    const hadMonth = typeof f.month === 'string' && f.month.length > 0
    if (hadMonth && f.month !== month) f.monthTokens = 0
    f.month = month
  }

  function addTokens(kind: string, n: number): any {
    const f = loadFishfood()
    const add = cleanToken(n)
    if (add <= 0) return f                       // 没有可信用量：不写盘、不改计数（也不把 NaN 写进文件）
    if (kind === 'story') f.storyTokens = addToken(f.storyTokens, add)
    else f.chatTokens = addToken(f.chatTokens, add)
    f.dayTokens = addToken(f.dayTokens, add)
    f.totalTokens = addToken(f.totalTokens, add)
    f.monthTokens = addToken(f.monthTokens, add)
    saveFishfood(f)
    return f
  }

  return { loadFishfood, saveFishfood, addTokens }
}
