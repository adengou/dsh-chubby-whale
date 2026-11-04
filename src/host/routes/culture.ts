/**
 * host/routes/culture.ts —— 文化（成语/典故/民俗）与音乐路由（可复用模块）
 * 去重：culture-seen.json（{"chengyu:名称": true, ...}），优先挑没讲过的，一轮讲完再清空。
 */
import { readFile } from 'node:fs/promises'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export function createCultureHandlers(opts: { dataDir: string }) {
  const CULTURE_DIR = join(opts.dataDir, 'culture')
  const SEEN_FILE = join(opts.dataDir, 'culture-seen.json')
  const cache = new Map<string, any[]>()
  let seen: Record<string, boolean> | null = null

  async function loadJson(key: string, file: string): Promise<any[]> {
    const cached = cache.get(key)
    if (cached) return cached
    const txt = await readFile(join(CULTURE_DIR, file), 'utf8')
    const arr = JSON.parse(txt)
    if (Array.isArray(arr)) cache.set(key, arr)
    return arr
  }

  function loadSeen(): Record<string, boolean> {
    if (seen) return seen
    const out: Record<string, boolean> = {}
    try {
      const obj = JSON.parse(readFileSync(SEEN_FILE, 'utf8'))
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const k of Object.keys(obj)) if (obj[k]) out[k] = true
      }
    } catch { }
    seen = out
    return seen
  }
  function saveSeen(): void {
    try {
      mkdirSync(opts.dataDir, { recursive: true })
      writeFileSync(SEEN_FILE, JSON.stringify(seen || {}), 'utf8')
    } catch { }
  }

  /**
   * 随机挑一条没讲过的。一轮讲完只清掉同类前缀的记录，
   * 别的类别（典故/故事/成语）的进度不受影响。
   */
  function pickUnseen<T>(arr: T[], prefix: string, keyOf: (x: T) => string): T | null {
    if (!arr || arr.length === 0) return null
    const sn = loadSeen()
    const full = (x: T) => prefix + ':' + keyOf(x)
    let pool = arr.filter((x: T) => !sn[full(x)])
    if (pool.length === 0) {
      for (const k of Object.keys(sn)) {
        if (k.startsWith(prefix + ':')) delete sn[k]
      }
      saveSeen()
      pool = arr.slice()
    }
    const item = pool[Math.floor(Math.random() * pool.length)]
    sn[full(item)] = true
    saveSeen()
    return item
  }

  async function handleCulture(req: any, res: any): Promise<void> {
    try {
      const url = new URL(req.url, 'http://x')
      const type = url.searchParams.get('type') || 'chengyu'
      let item: any = null
      if (type === 'chengyu') {
        const arr = await loadJson('chengyu', 'chengyu.json')
        const x = pickUnseen(arr, 'chengyu', (i: any) => String(i.name || ''))
        if (x) item = { kind: 'chengyu', title: x.name, src: x.src, text: x.text }
      } else if (type === 'idiom') {
        const arr = await loadJson('idiom', 'idioms.json')
        const x = pickUnseen(arr, 'idiom', (i: any) => String(i.name || ''))
        if (x) item = { kind: 'idiom', title: x.name, cat: x.cat, text: (x.mean || '') + (x.wrong ? '；易误解为：' + String(x.wrong).replace('易误解为：', '') : '') }
      } else if (type === 'minsu') {
        const arr = await loadJson('minsu', 'minsu.json')
        const x = pickUnseen(arr, 'minsu', (i: any) => String(i.title || ''))
        if (x) item = { kind: 'minsu', title: (x.book || '') + '·' + (x.title || ''), text: x.text }
      } else {
        item = { kind: 'unknown', title: '嗯？', text: '这个类型的文化小鲸还没学会。' }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, item }))
    } catch (err: any) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }))
    }
  }

  async function handleMelodies(_req: any, res: any): Promise<void> {
    try {
      const txt = await readFile(join(opts.dataDir, 'melodies.json'), 'utf8')
      const data = JSON.parse(txt)
      const songs = (data?.songs || []).map((s: any) => ({ name: s.name, bpm: s.bpm }))
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, songs }))
    } catch (err: any) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String(err?.message || err), songs: [] }))
    }
  }

  async function handleMelody(req: any, res: any): Promise<void> {
    try {
      const url = new URL(req.url, 'http://x')
      const name = url.searchParams.get('name') || ''
      const txt = await readFile(join(opts.dataDir, 'melodies.json'), 'utf8')
      const data = JSON.parse(txt)
      const song = (data?.songs || []).find((s: any) => s.name === name)
      if (!song) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'song not found' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, song: { name: song.name, bpm: song.bpm || 100, notes: song.notes || [], lyrics: song.lyrics || '' } }))
    } catch (err: any) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }))
    }
  }

  return { handleCulture, handleMelodies, handleMelody }
}
