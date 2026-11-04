/**
 * host/routes/story.ts —— 说书路由（对齐 C# 版 Story.cs 的 Next() 算法）
 * 选段：按数组顺序找第一个未读段（key = book|index，避免回目里 piece 重复导致误判）；
 * 一本读完自动下一本；17 本全读完才清空进度重来。
 * 进度文件：{"book|index": true, "_current": "书名"}
 * 单本坏文件/超时不拖垮全局：loadBook 记日志后返回空数组，pickNext 继续试下一本；
 * 全部书都读不出来时返回 no readable book。
 * 连播：每个客户端（x-client-id）一条队列，多标签页互不抢段；拿不到 id 时共用单队列。
 * 菜单「从头讲这本书」：POST /story/reset?book=书名，清该书的 book|index 进度。
 */
import { readdir } from 'node:fs/promises'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

export const STORY_AUTHORS: Record<string, string> = {
  '聊斋志异': '蒲松龄', '三国演义': '罗贯中', '西游记': '吴承恩', '水浒传': '施耐庵',
  '红楼梦': '曹雪芹', '儒林外史': '吴敬梓', '镜花缘': '李汝珍', '三言二拍': '冯梦龙、凌濛初',
  '官场现形记': '李宝嘉', '老残游记': '刘鹗', '世说新语': '刘义庆', '封神演义': '许仲琳',
  '东周列国志': '冯梦龙', '隋唐演义': '褚人获', '说岳全传': '钱彩', '杨家将演义': '熊大木',
  '三侠五义': '石玉昆', '喻世明言': '冯梦龙', '警世通言': '冯梦龙', '醒世恒言': '冯梦龙',
  '初刻拍案惊奇': '凌濛初', '二刻拍案惊奇': '凌濛初',
}

export function createStoryHandlers(opts: {
  dataDir: string
  runtimeDir?: string
  workerPath: string
}) {
  const STORY_DIR = join(opts.dataDir, 'story')
  const PROGRESS = join(opts.runtimeDir || opts.dataDir, 'story_progress.json')
  const bookCache = new Map<string, any[]>()
/** 内存里最多留几本书：一本 JSON 可能几 MB，无限缓存会一直涨 */
const BOOK_CACHE_MAX = 2
  const progress = loadProgress()
  // 每个客户端一条连播队列：{ queue: 本书剩余未读段, book: 书名 }
  const clientQueues = new Map<string, { queue: any[]; book: string }>()

  function loadProgress(): Record<string, any> {
    try {
      const obj = JSON.parse(readFileSync(PROGRESS, 'utf8'))
      const out: Record<string, any> = {}
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const k of Object.keys(obj)) {
          if (k === '_current') {
            if (typeof obj[k] === 'string') out[k] = obj[k]
          } else if (obj[k]) {
            out[k] = true
          }
        }
      }
      return out
    } catch { return {} }
  }
  function saveProgress(): void {
    try {
      mkdirSync(opts.dataDir, { recursive: true })
      writeFileSync(PROGRESS, JSON.stringify(progress), 'utf8')
    } catch { }
  }
  function storyKey(book: string, index: number): string {
    return String(book || '') + '|' + String(index)
  }

  async function listBooks(): Promise<string[]> {
    try {
      const files = await readdir(STORY_DIR)
      return files.filter((f: string) => f.endsWith('.json')).map((f: string) => f.replace(/\.json$/, '')).sort()
    } catch { return [] }
  }

  function resolveBook(books: string[], want: string): string {
    const w = String(want || '').trim()
    if (!w) return ''
    if (books.indexOf(w) >= 0) return w
    let hit = ''
    for (const b of books) {
      if (b.indexOf(w) >= 0 || w.indexOf(b) >= 0) {
        if (b.length > hit.length) hit = b
      }
    }
    return hit
  }

  function currentBook(books: string[]): string {
    try {
      const cur = progress['_current']
      if (typeof cur === 'string' && cur && books.indexOf(cur) >= 0) return cur
    } catch { }
    return books.length ? books[0] : ''
  }

  // 按需加载一本书的切片（Worker 解析，内存缓存）；index 用原数组序号（照 C#）
  function normalizeBook(book: string, raw: any): any[] {
    const out: any[] = []
    if (!Array.isArray(raw)) return out
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i]
      if (!c || typeof c !== 'object') continue
      const text = String(c.text == null ? '' : c.text)
      if (!text.trim()) continue
      out.push({
        book: String(c.book || book),
        title: String(c.title || ''),
        piece: Number(c.piece) || 1,
        total: Number(c.total) || 1,
        text,
        index: i,
      })
    }
    return out
  }

  /**
   * 读一本书。坏文件/超时都不抛：记 STORY-LOAD-FAIL 后返回空数组，
   * 让 pickNext 继续试下一本（一本坏不能拖垮整个说书功能）。
   */
  function loadBook(book: string): Promise<any[]> {
    const cached = bookCache.get(book)
    if (cached) return Promise.resolve(cached)
    return new Promise((resolve) => {
      let done = false
      const fail = (err: any): void => {
        if (done) return
        done = true
        console.error('STORY-LOAD-FAIL book=' + book + ' err=' + String(err?.message || err))
        resolve([])
      }
      try {
        const w = new Worker(opts.workerPath)
        const timer = setTimeout(() => {
          try { w.terminate() } catch { }
          fail('timeout 30s')
        }, 30000)
        w.once('message', (msg: any) => {
          clearTimeout(timer)
          try { w.terminate() } catch { }
          if (done) return
          if (msg && msg.ok) {
            done = true
            const list = normalizeBook(book, msg.chunks)
            bookCache.set(book, list)
            // LRU：超上限就丢最早的那本（Map 保持插入顺序）
            while (bookCache.size > BOOK_CACHE_MAX) { const oldest = bookCache.keys().next().value as string | undefined; if (oldest === undefined) break; bookCache.delete(oldest) }
            resolve(list)
          } else fail(msg?.error || 'parse failed')
        })
        w.once('error', (err: any) => { clearTimeout(timer); fail(err) })
        w.postMessage({ book, file: join(STORY_DIR, book + '.json') })
      } catch (err) { fail(err) }
    })
  }

  // 播一段（组装开场白/结尾，照 C# 版 的 Speak-StoryChunk）
  function buildChunk(c: any, isFirst: boolean, isLast: boolean): any {
    const bookName = String(c.book || '故事')
    const title = String(c.title || '')
    const piece = Number(c.piece) || 1
    const total = Number(c.total) || 1
    const spoken = String(c.text || '')
    const author = STORY_AUTHORS[bookName] || ''
    const cleanTitle = title.replace(/正文\s*/g, '')
    const intro = isFirst ? ('话说，今天给主人讲一段《' + bookName + '》' + (author ? '，' + author + '著' : '') + '，' + cleanTitle + '。') : ''
    const tail = isLast ? '这一回，就讲到这里。' : ''
    return {
      book: bookName,
      title,
      piece,
      total,
      isFirst,
      isLast,
      text: intro + spoken + tail,
      rate: '-15%',
    }
  }

  function isLastPiece(c: any): boolean {
    return Number(c.piece) >= Number(c.total)
  }

  /** 本回剩余未读段（按数组顺序，供本客户端连播） */
  function queueAfter(chunks: any[], book: string, piece: any): any[] {
    return chunks
      .filter((c: any) => Number(c.index) > Number(piece.index) && !progress[storyKey(book, c.index)])
      .sort((a: any, b: any) => Number(a.index) - Number(b.index))
  }

  /** 照 C# Story.Next()：当前书里找第一个未读段；读完换下一本；全读完才清零重来 */
  async function pickNext(books: string[], want: string): Promise<{ piece: any; chunks: any[]; book: string } | null> {
    if (books.length === 0) return null
    const resolved = resolveBook(books, want)
    let target = resolved || currentBook(books)
    let anyReadable = false
    for (let attempt = 0; attempt < books.length; attempt++) {
      const chunks = await loadBook(target)
      if (chunks.length > 0) anyReadable = true
      const hit = chunks.find((c: any) => !progress[storyKey(target, c.index)])
      if (hit) {
        progress[storyKey(target, hit.index)] = true
        progress['_current'] = target
        saveProgress()
        return { piece: hit, chunks, book: target }
      }
      const idx = books.indexOf(target)
      target = books[(idx + 1) % books.length]
    }
    // 一本书都读不出来：上层据此返回 no readable book，别再假装「讲完了」
    if (!anyReadable) return null
    // 整整一轮都没找到未读：都讲完了，清空进度从头再来
    for (const k of Object.keys(progress)) {
      if (k !== '_current') delete progress[k]
    }
    saveProgress()
    // 从头再来也要跳过坏书：按顺序找第一本能读的
    for (let i = 0; i < books.length; i++) {
      const book = books[i]
      const chunks = await loadBook(book)
      const hit = chunks.find((c: any) => !progress[storyKey(book, c.index)])
      if (!hit) continue
      progress[storyKey(book, hit.index)] = true
      progress['_current'] = book
      saveProgress()
      return { piece: hit, chunks, book }
    }
    return null
  }

  function clientId(req: any): string {
    try {
      const raw = req?.headers?.['x-client-id']
      const v = Array.isArray(raw) ? raw[0] : raw
      if (typeof v !== 'string') return ''
      return v.replace(/[^\w.-]/g, '').slice(0, 64)
    } catch { return '' }
  }
  function stateFor(id: string): { queue: any[]; book: string } {
    let st = clientQueues.get(id)
    if (!st) {
      st = { queue: [], book: '' }
      clientQueues.set(id, st)
      if (clientQueues.size > 16) {
        for (const k of clientQueues.keys()) {
          if (k !== id) { clientQueues.delete(k); break }
        }
      }
    }
    return st
  }

  function send(res: any, payload: any): void {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(payload))
  }

  async function handleBooks(_req: any, res: any): Promise<void> {
    try {
      send(res, { ok: true, books: await listBooks() })
    } catch (err: any) {
      send(res, { ok: false, error: String(err?.message || err), books: [] })
    }
  }

  async function handleStoryStart(req: any, res: any): Promise<void> {
    try {
      const books = await listBooks()
      if (books.length === 0) { send(res, { ok: false, error: 'no books' }); return }
      const url = new URL(req.url, 'http://x')
      const hint = url.searchParams.get('hint') || ''
      const picked = await pickNext(books, hint)
      if (!picked) { send(res, { ok: false, error: 'no readable book' }); return }
      const st = stateFor(clientId(req))
      st.book = picked.book
      st.queue = queueAfter(picked.chunks, picked.book, picked.piece)
      const out = buildChunk(picked.piece, true, isLastPiece(picked.piece))
      send(res, { ok: true, ...out, remain: st.queue.length })
    } catch (err: any) {
      send(res, { ok: false, error: String(err?.message || err) })
    }
  }

  async function handleStoryNext(req: any, res: any): Promise<void> {
    try {
      const books = await listBooks()
      if (books.length === 0) { send(res, { ok: false, error: 'no books' }); return }
      const st = stateFor(clientId(req))
      // 队列里若已被别的标签页讲过，就跳过
      while (st.queue.length > 0 && progress[storyKey(st.book, st.queue[0].index)]) st.queue.shift()
      let piece: any = null
      let isFirst = false
      if (st.queue.length > 0) {
        piece = st.queue.shift()
      } else {
        const picked = await pickNext(books, '')
        if (!picked) { send(res, { ok: false, error: 'no readable book' }); return }
        // 队列空后重新挑段：还是同一本书就不重复插开场白，真换书才开口
        const switched = !st.book || picked.book !== st.book
        piece = picked.piece
        st.book = picked.book
        st.queue = queueAfter(picked.chunks, picked.book, piece)
        isFirst = switched
      }
      const bk = st.book || String(piece.book || books[0])
      progress[storyKey(bk, piece.index)] = true
      progress['_current'] = bk
      saveProgress()
      const out = buildChunk(piece, isFirst, isLastPiece(piece))
      send(res, { ok: true, ...out, remain: st.queue.length })
    } catch (err: any) {
      send(res, { ok: false, error: String(err?.message || err) })
    }
  }

  /** 从头讲这本书：清掉该书全部进度（book|index 前缀），并把「当前书」指过去 */
  async function handleStoryReset(req: any, res: any): Promise<void> {
    try {
      const books = await listBooks()
      const url = new URL(req.url, 'http://x')
      const want = String(url.searchParams.get('book') || '').trim()
      const book = resolveBook(books, want) || want
      if (!book) { send(res, { ok: false, error: 'no book' }); return }
      let cleared = 0
      for (const k of Object.keys(progress)) {
        if (k !== '_current' && k.startsWith(book + '|')) { delete progress[k]; cleared++ }
      }
      progress['_current'] = book
      saveProgress()
      // 该客户端的连播队列里若还排着这本书的段，也一起丢掉，免得 reset 后又接着念旧的
      const st = stateFor(clientId(req))
      if (st.book === book) st.queue = []
      send(res, { ok: true, book })
    } catch (err: any) {
      send(res, { ok: false, error: String(err?.message || err) })
    }
  }

  return { handleBooks, handleStoryStart, handleStoryNext, handleStoryReset }
}
