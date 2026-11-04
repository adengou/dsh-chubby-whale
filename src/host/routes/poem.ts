/**
 * host/routes/poem.ts —— 念诗路由
 * 数据：data/poems.json（739 首，结构 {poems:[{type,dynasty,title,author,lines,sources}]}）
 * 去重：data/poem-seen.json（["标题|作者", ...]），一轮念完自动清空重来。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export function createPoemHandler(opts: { dataDir: string }) {
  const POEMS_FILE = join(opts.dataDir, 'poems.json')
  const SEEN_FILE = join(opts.dataDir, 'poem-seen.json')
  let poems: any[] | null = null
  let seen: Set<string> | null = null

  function loadPoems(): any[] {
    if (poems) return poems
    const out: any[] = []
    try {
      const data = JSON.parse(readFileSync(POEMS_FILE, 'utf8'))
      const arr = Array.isArray(data) ? data : (Array.isArray(data?.poems) ? data.poems : [])
      for (const p of arr) {
        if (!p || typeof p !== 'object') continue
        const title = String(p.title || '').trim()
        if (!title) continue
        const lines = Array.isArray(p.lines) ? p.lines.map((x: any) => String(x || '').trim()).filter(Boolean) : []
        if (lines.length === 0) continue
        out.push({
          type: String(p.type || ''),
          dynasty: String(p.dynasty || ''),
          title,
          author: String(p.author || ''),
          lines,
        })
      }
    } catch { }
    poems = out
    return poems
  }

  function keyOf(p: any): string {
    // 同题不同作很多（蝶恋花/浣溪沙 等），键里加上首句前 12 字
    const first = Array.isArray(p.lines) ? String(p.lines[0] || '') : String(p.text || '')
    return String(p.title || '') + '|' + String(p.author || '') + '|' + first.slice(0, 12)
  }

  function loadSeen(): Set<string> {
    if (seen) return seen
    const s = new Set<string>()
    try {
      const arr = JSON.parse(readFileSync(SEEN_FILE, 'utf8'))
      if (Array.isArray(arr)) {
        for (const k of arr) if (typeof k === 'string' && k.trim()) s.add(k.trim())
      }
    } catch { }
    seen = s
    return seen
  }
  function saveSeen(): void {
    try {
      mkdirSync(opts.dataDir, { recursive: true })
      writeFileSync(SEEN_FILE, JSON.stringify(Array.from(seen || [])), 'utf8')
    } catch { }
  }

  async function handlePoem(_req: any, res: any): Promise<void> {
    try {
      const list = loadPoems()
      if (list.length === 0) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'no poems' }))
        return
      }
      const sn = loadSeen()
      let pool = list.filter((p: any) => !sn.has(keyOf(p)))
      if (pool.length === 0) {
        // 一轮念完：清空记忆重来
        sn.clear()
        saveSeen()
        pool = list.slice()
      }
      const p = pool[Math.floor(Math.random() * pool.length)]
      sn.add(keyOf(p))
      saveSeen()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        ok: true,
        title: p.title,
        author: p.author,
        dynasty: p.dynasty,
        text: p.lines.join('\n'),
      }))
    } catch (err: any) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }))
    }
  }

  return { handlePoem }
}
