/**
 * host/repos/fishfood.ts —— 鱼粮（token 统计）仓储（fishfood.json）
 * 从 host/store.ts 拆出：跨天/跨月清零「今日/本月」，总量 totalTokens 不动（照 C# 的 date/month 滚动）。
 * 写盘走 host/atomic.ts；读坏文件按 [store] 前缀留痕并备份。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic, isMissingFileError, quarantineFile } from '../atomic.js'

export interface TokenRepo {
  loadFishfood(): any
  saveFishfood(obj: any): void
  /** kind='story' 记说书 token，其余记聊天 token；同时累计总量/本月 */
  addTokens(kind: string, n: number): any
}

export function createTokenRepo(dataDir: string): TokenRepo {
  const FISHFOOD = join(dataDir, 'fishfood.json')

  function loadFishfood(): any {
    try {
      const obj = JSON.parse(readFileSync(FISHFOOD, 'utf8'))
      if (obj && typeof obj === 'object') return obj
    } catch (err: any) {
      if (!isMissingFileError(err)) quarantineFile(FISHFOOD, err, '[store]')
    }
    return { chatTokens: 0, storyTokens: 0 }
  }
  function saveFishfood(obj: any): void {
    try { writeJsonAtomic(FISHFOOD, obj) } catch { }
  }
  /** 跨天/跨月把"今日/本月"清零（总量 totalTokens 不动，照 C# 的 date/month 滚动） */
  function rollFishfood(f: any): void {
    const now = new Date()
    const day = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
    const month = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
    if (f.day !== day) { f.day = day; f.chatTokens = 0; f.storyTokens = 0; f.dayTokens = 0 }
    if (f.month !== month) { f.month = month; f.monthTokens = 0 }
  }

  function addTokens(kind: string, n: number): any {
    const f = loadFishfood()
    rollFishfood(f)
    if (kind === 'story') f.storyTokens = (Number(f.storyTokens) || 0) + n
    else f.chatTokens = (Number(f.chatTokens) || 0) + n
    f.totalTokens = (Number(f.totalTokens) || 0) + n
    f.monthTokens = (Number(f.monthTokens) || 0) + n
    saveFishfood(f)
    return f
  }

  return { loadFishfood, saveFishfood, addTokens }
}
