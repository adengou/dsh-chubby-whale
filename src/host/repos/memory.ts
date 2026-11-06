/**
 * host/repos/memory.ts —— 聊天记忆仓储（memory.json：history + summary）
 *
 * 从 host/store.ts 拆出：这里只负责「聊天记忆」这一件事。
 * 写盘走 host/atomic.ts；读坏文件按 [store] 前缀记日志并备份 .bad-<时间戳>。
 * 读入容错 UTF-8 BOM，写出统一 UTF-8 无 BOM（Windows / Linux / macOS 同一套行为）。
 */
import { join } from 'node:path'
import { writeJsonAtomic, isMissingFileError, quarantineFile, readTextNoBom } from '../atomic.js'

/** 记忆里最多留多少条（40 条 = 20 轮） */
const MEMORY_LIMIT = 40

export interface MemoryRepo {
  loadHistory(): any[]
  saveHistory(arr: any[]): void
  /** 追加一轮对话（主人一句 + 肥鲸一句）；读→push→写在同一个同步段里 */
  appendTurns(userText: string, replyText: string): number
  clearMemory(): void
  loadMemorySummary(): string
  saveMemorySummary(s: string): void
}

export function createMemoryRepo(dataDir: string): MemoryRepo {
  const MEMORY = join(dataDir, 'memory.json')

  function loadMemoryObj(): any {
    try {
      const obj = JSON.parse(readTextNoBom(MEMORY))
      if (Array.isArray(obj)) return { history: obj, summary: '' }
      if (obj && typeof obj === 'object') {
        return { history: Array.isArray(obj.history) ? obj.history : [], summary: String(obj.summary || '') }
      }
    } catch (err: any) {
      if (!isMissingFileError(err)) quarantineFile(MEMORY, err, '[store]')
    }
    return { history: [], summary: '' }
  }
  function saveMemoryObj(obj: any): void {
    try {
      writeJsonAtomic(MEMORY, { history: (obj.history || []).slice(-MEMORY_LIMIT), summary: String(obj.summary || ''), savedAt: new Date().toISOString() })
    } catch { }
  }
  /**
   * 追加一轮对话（主人一句 + 肥鲸一句）。
   * 读 → push → 写 全在同一个同步段里，中间没有 await，并发请求不会互相覆盖，
   * 也不会把 /clear-memory 之前的旧记忆写回。
   */
  function appendTurns(userText: string, replyText: string): number {
    const m = loadMemoryObj()
    const h = Array.isArray(m.history) ? m.history : []
    h.push({ role: 'user', content: String(userText || '') })
    h.push({ role: 'assistant', content: String(replyText || '') })
    m.history = h.slice(-MEMORY_LIMIT)
    saveMemoryObj(m)
    return m.history.length
  }
  function loadHistory(): any[] { return loadMemoryObj().history }
  function saveHistory(arr: any[]): void { const m = loadMemoryObj(); m.history = arr; saveMemoryObj(m) }
  function loadMemorySummary(): string { return loadMemoryObj().summary }
  function saveMemorySummary(s: string): void { const m = loadMemoryObj(); m.summary = String(s || ''); saveMemoryObj(m) }
  function clearMemory(): void {
    try { writeJsonAtomic(MEMORY, { history: [], summary: '', savedAt: new Date().toISOString() }) } catch { }
  }

  return { loadHistory, saveHistory, appendTurns, clearMemory, loadMemorySummary, saveMemorySummary }
}
