/**
 * host/routes/poem.ts —— 念诗路由
 * 数据：经 DataPort 取（本地 data/poems.json 一整册；云端 poems/poems-00..14.json 分片），
 * 由 index.ts 按配置注入；路由不直接碰文件/网络。
 * 去重：poem-seen.json（["标题|作者|首句", ...]），一轮念完自动清空重来。
 * 数据源读不到只记 POEM-LOAD-FAIL，按空诗册处理；空时返回 {ok:true,item:null,reason:'no-data'}。
 * 原子写/JSON 响应分别走 host/atomic.ts、host/respond.ts。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic } from '../atomic.js'
import { sendJson, sendError } from '../respond.js'
import type { DataPort } from '../ports.js'
import { poemKeyOf } from '../../shared/poem.js'

export function createPoemHandler(opts: { runtimeDir?: string; dataDir?: string; dataPort: DataPort }) {
  const SEEN_FILE = join(opts.runtimeDir || opts.dataDir || '.', 'poem-seen.json')
  let seen: Set<string> | null = null
  /** 上一次真正念出来的诗（去重键）：一轮念完清空池子时用它挡住「刚念完又立刻同一首」 */
  let lastKey = ''

  /**
   * 拉全部诗：先取第 0 片拿到 total，再顺序取其余片。
   * 云端实现每片有内存缓存；本地实现固定 total=1，只读一次 poems.json。
   */
  async function loadPoems(): Promise<any[]> {
    try {
      const first = await opts.dataPort.readPoemsChunk(0)
      // 数据层（local/cloud）已经归一化过去重过，这里不再重复归一化（737 首诗每请求扫一遍纯属浪费）
    const out: any[] = Array.isArray(first && first.items) ? first.items.slice() : []
      const total = Math.max(1, Number(first && first.total) || 1)
      for (let i = 1; i < total; i++) {
        const chunk = await opts.dataPort.readPoemsChunk(i)
        if (chunk && Array.isArray(chunk.items)) out.push(...chunk.items)
      }
      return out
    } catch (err: any) {
      console.error('POEM-LOAD-FAIL err=' + String(err?.message || err))
      return []
    }
  }

  function loadSeen(): Set<string> {
    if (seen) return seen
    const s = new Set<string>()
    try {
      const arr = JSON.parse(String(readFileSync(SEEN_FILE, 'utf8')).replace(/^\uFEFF/, ''))
      if (Array.isArray(arr)) {
        for (const k of arr) if (typeof k === 'string' && k.trim()) s.add(k.trim())
      } else {
        console.error('POEM-SEEN-LOAD-FAIL file=' + SEEN_FILE + ' err=bad structure')
      }
    } catch (err: any) {
      // 首次运行没有文件是正常态；读坏/解析失败要留痕，否则进度悄悄清零没人知道
      if (!(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'))) {
        console.error('POEM-SEEN-LOAD-FAIL file=' + SEEN_FILE + ' err=' + String(err?.message || err))
      }
    }
    seen = s
    return seen
  }
  function saveSeen(): void {
    try {
      // 原子写：唯一临时名 + rename（失败清临时文件），见 host/atomic.ts
      writeJsonAtomic(SEEN_FILE, Array.from(seen || []))
    } catch (err: any) {
      console.error('POEM-SEEN-SAVE-FAIL file=' + SEEN_FILE + ' err=' + String(err?.message || err))
    }
  }

  async function handlePoem(req: any, res: any): Promise<void> {
    try {
      const list = await loadPoems()
      if (list.length === 0) {
        sendJson(res, { ok: true, item: null, reason: 'no-data' })
        return
      }
      // 指定标题：按「完整标题 = 」优先，其次「包含」，命中就直接背这一首（不参与随机池）
      let want = ''
      try {
        const u = new URL(String(req?.url || ''), 'http://local')
        want = String(u.searchParams.get('title') || '').trim()
      } catch { want = '' }
      if (want) {
        const exact = list.filter((p: any) => String(p.title || '').trim() === want)
        const fuzzy = exact.length ? exact : list.filter((p: any) => String(p.title || '').includes(want))
        const hit = fuzzy.length ? fuzzy[Math.floor(Math.random() * fuzzy.length)] : null
        if (hit) {
          const sn0 = loadSeen()
          sn0.add(poemKeyOf(hit))
          lastKey = poemKeyOf(hit)
          saveSeen()
          sendJson(res, {
            ok: true,
            matched: true,
            item: { title: hit.title, author: hit.author, dynasty: hit.dynasty, text: hit.lines.join('\n') },
          })
          return
        }
        // 没匹配到就回落随机（并告诉客户端 matched:false）
      }
      const sn = loadSeen()
      let pool = list.filter((p: any) => !sn.has(poemKeyOf(p)))
      if (pool.length === 0) {
        // 一轮念完：清空记忆重来。诗库不止一首时先排除刚念过的那首，
        // 否则新一轮第一首有 1/n 概率与上一首完全相同（两首诗库时最明显）。
        sn.clear()
        saveSeen()
        pool = list.filter((p: any) => poemKeyOf(p) !== lastKey)
        if (pool.length === 0) pool = list.slice()
      }
      const p = pool[Math.floor(Math.random() * pool.length)]
      sn.add(poemKeyOf(p))
      lastKey = poemKeyOf(p)
      saveSeen()
      sendJson(res, {
        ok: true,
        item: {
          title: p.title,
          author: p.author,
          dynasty: p.dynasty,
          text: p.lines.join('\n'),
        },
      })
    } catch (err: any) {
      sendError(res, err)
    }
  }

  return { handlePoem }
}
