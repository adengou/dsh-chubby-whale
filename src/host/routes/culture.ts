/**
 * host/routes/culture.ts —— 文化（成语/典故/民俗）与音乐路由（可复用模块）
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export function createCultureHandlers(opts: { dataDir: string }) {
  const CULTURE_DIR = join(opts.dataDir, 'culture')
  const cache = new Map<string, any[]>()

  async function loadJson(key: string, file: string): Promise<any[]> {
    const cached = cache.get(key)
    if (cached) return cached
    const txt = await readFile(join(CULTURE_DIR, file), 'utf8')
    const arr = JSON.parse(txt)
    if (Array.isArray(arr)) cache.set(key, arr)
    return arr
  }

  function pick(arr: any[]): any {
    return arr[Math.floor(Math.random() * arr.length)]
  }

  async function handleCulture(req: any, res: any): Promise<void> {
    try {
      const url = new URL(req.url, 'http://x')
      const type = url.searchParams.get('type') || 'chengyu'
      let item: any = null
      if (type === 'chengyu') {
        const arr = await loadJson('chengyu', 'chengyu.json')
        const x = pick(arr)
        item = { kind: 'chengyu', title: x.name, src: x.src, text: x.text }
      } else if (type === 'idiom') {
        const arr = await loadJson('idiom', 'idioms.json')
        const x = pick(arr)
        item = { kind: 'idiom', title: x.name, cat: x.cat, text: (x.mean || '') + (x.wrong ? '；易误解为：' + String(x.wrong).replace('易误解为：', '') : '') }
      } else if (type === 'minsu') {
        const arr = await loadJson('minsu', 'minsu.json')
        const x = pick(arr)
        item = { kind: 'minsu', title: (x.book || '') + '·' + (x.title || ''), text: x.text }
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
