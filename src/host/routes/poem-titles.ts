/**
 * host/routes/poem-titles.ts —— 诗名索引路由（客户端「点诗」识别按需拉取）
 *
 * GET /api/chubby-whale/poem-titles
 *   成功 → { ok: true, count, titles: [...] }
 *   失败 → { ok: false, titles: [], error }（文件缺失/坏 JSON/空表都走这里；HTTP 仍 200，
 *          与既有「200 承载业务失败」约定一致）
 *
 * 为什么单独一条路由：634 个标题约 11 KB，原先内联在 client bundle 里，
 * 改成按需下发后只有真正点诗的人付这份体积。
 * 数据是随包发布的只读文件：读成功后在内存里缓存一份；失败不缓存，补回文件即恢复。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sendJson } from '../respond.js'

export function createPoemTitlesHandler(opts: { dataDir?: string }) {
  const FILE = join(opts.dataDir || '.', 'poem-titles.json')
  /** 成功读到的标题（只缓存成功结果：文件后来补上时不用重启就能恢复） */
  let cached: string[] | null = null

  function loadTitles(): string[] {
    if (cached) return cached
    const raw = readFileSync(FILE, 'utf8')
    const data = JSON.parse(String(raw).replace(/^\uFEFF/, ''))
    const list = Array.isArray(data && data.titles) ? data.titles : []
    const titles: string[] = []
    for (const item of list) if (typeof item === 'string' && item) titles.push(item)
    if (titles.length === 0) throw new Error('empty titles')
    cached = titles
    return titles
  }

  async function handlePoemTitles(_req: any, res: any): Promise<void> {
    try {
      const titles = loadTitles()
      sendJson(res, { ok: true, count: titles.length, titles })
    } catch (err: any) {
      // 读不到就明确报失败：客户端会降级为「不识别具体诗名」，其他意图照常
      console.error('POEM-TITLES-LOAD-FAIL file=' + FILE + ' err=' + String((err && err.message) || err))
      sendJson(res, { ok: false, titles: [], error: String((err && err.message) || err) })
    }
  }

  return { handlePoemTitles }
}
