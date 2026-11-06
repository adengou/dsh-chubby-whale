/**
 * host/story/player.ts —— 说书业务（选段算法 + 进度 + 每客户端连播队列）
 *
 * 对齐 C# 版 Story.cs 的 Next() 算法：
 *   按数组顺序找第一个未读段（key = <source>:<book>|index）；一本读完自动下一本；17 本全读完才清空进度重来。
 *   进度文件：{"<source>:<book>|index": true, "_current": "书名"}
 *   单本坏文件/超时不拖垮全局：repo.loadBook 返回空数组，pickNext 继续试下一本。
 *   连播：每个客户端（x-client-id）一条队列，多标签页互不抢段；拿不到 id 时共用单队列。
 *
 * 进度键的数据源命名空间（2026-11-06）：
 *   云端与本地同名书的回目/分段不同，同一个 `book|index` 键若被两个数据源共用，
 *   切数据源后段号就会串位（跳段）或从头重念（重听）。所以进度键统一写成
 *   `<source>:<book>|index`，source 由 index.ts 装配时按 readDataSource() 注入。
 *
 * 旧键迁移（兼容窗口 = 本版本）：
 *   · 启动创建播放器、以及每次 reloadProgress()（备份导入后）各跑一次：扫描无 `local:` / `cloud:`
 *     前缀的旧键 `book|index`，复制为 `<当前 source>:book|index`，随后删除旧键；
 *   · 整个迁移在内存里做完，一次 writeJsonAtomic 落盘：中途崩溃只会留下迁移前或迁移后的完整文件；
 *   · 幂等：迁移完旧键即不存在，再跑没有可迁移的键、不写盘，文件字节不变，可重复执行；
 *   · 读兼容保留一个版本：读取先查新键、查不到再回退旧键（只读），写入一律只写新键；
 *     正常路径下旧键在加载时已被搬走，回退分支是防御性的（迁移失败/旧数据绕过加载），下个版本随迁移代码一起删；
 *   · 迁移后不长期留旧键：旧键不带 source，两个数据源都会命中，等于把刚修好的「切源跳段」
 *     放回来；而且 reset 只清新键，旧键残留会让刚重置的书「复活」。
 *
 * 这里不碰 req/res：HTTP 解析与响应在 host/routes/story.ts。
 */
import { readFileSync } from 'node:fs'
import { deepFreeze } from '../../shared/immutable.js'
import { writeJsonAtomic } from '../atomic.js'
import type { DataSourceKind } from '../ports.js'
import type { StoryChunk, StoryRepo } from './repo.js'

export const STORY_AUTHORS: Record<string, string> = {
  '聊斋志异': '蒲松龄', '三国演义': '罗贯中', '西游记': '吴承恩', '水浒传': '施耐庵',
  '红楼梦': '曹雪芹', '儒林外史': '吴敬梓', '镜花缘': '李汝珍', '三言二拍': '冯梦龙、凌濛初',
  '官场现形记': '李宝嘉', '老残游记': '刘鹗', '世说新语': '刘义庆', '封神演义': '许仲琳',
  '东周列国志': '冯梦龙', '隋唐演义': '褚人获', '说岳全传': '钱彩', '杨家将演义': '熊大木',
  '三侠五义': '石玉昆', '喻世明言': '冯梦龙', '警世通言': '冯梦龙', '醒世恒言': '冯梦龙',
  '初刻拍案惊奇': '凌濛初', '二刻拍案惊奇': '凌濛初',
}
deepFreeze(STORY_AUTHORS)

export interface StorySpeech {
  book: string
  title: string
  piece: number
  total: number
  isFirst: boolean
  isLast: boolean
  text: string
  rate: string
}

export type StoryPick =
  | { ok: true; chunk: StorySpeech; remain: number }
  | { ok: false; error: string }

export type StoryReset = { ok: true; book: string } | { ok: false; error: string }

export interface StoryPlayer {
  books(): Promise<string[]>
  /** 开讲：按 hint 定位书，挑下一个未读段并重建该客户端的连播队列 */
  start(hint: string, clientId: string): Promise<StoryPick>
  /** 连播下一段：先取该客户端队列，空了再跨书挑 */
  next(clientId: string): Promise<StoryPick>
  /** 从头讲这本书：只清当前数据源下该书的进度，并把「当前书」指过去（别的数据源与旧键都不动） */
  reset(bookHint: string, clientId: string): Promise<StoryReset>
  /** 重新读盘（备份导入说书进度后调用）：不读的话内存里的旧进度会在下一次保存时盖掉导入内容 */
  reloadProgress(): void
  /** 读某书某段是否已讲：先查当前数据源的新键，查不到再回退旧键（一个版本的只读兼容） */
  getProgress(book: string, index: number): boolean
  /** 写进度：一律写当前数据源的新键；read=false 只删新键（旧键归迁移清理，别的数据源不动） */
  setProgress(book: string, index: number, read?: boolean): void
}

/** 连播队列最多留几个客户端：一本 30MB 书的段引用不算大，但标签页数量不该无上限 */
const QUEUE_MAX_CLIENTS = 16
/** 客户端超过这么久没再请求，视为标签页已关：队列快照丢掉，免得长期占内存 */
const QUEUE_TTL_MS = 30 * 60 * 1000

interface ClientQueue {
  /** 本书剩余未读段（连播顺序） */
  queue: StoryChunk[]
  /** 队列所属书名 */
  book: string
  /** 最近一次请求时间：TTL 清理与 LRU 驱逐都按它排 */
  lastSeen: number
}

/** 新键前缀：`local:` / `cloud:`。两种前缀都没有的键，就是需要迁移的旧格式键 */
const NAMESPACED_KEY_RE = /^(?:local|cloud):/

/** 新键：`<source>:<book>|<index>`（进度写入只走这个格式） */
function storyKeyOf(source: DataSourceKind, book: string, index: number): string {
  return source + ':' + String(book || '') + '|' + String(index)
}

/** 旧键（无数据源命名空间）：`<book>|<index>`，只用于迁移与读取兼容，不再写入 */
function legacyStoryKey(book: string, index: number): string {
  return String(book || '') + '|' + String(index)
}

export function createStoryPlayer(opts: { repo: StoryRepo; progressFile: string; source?: DataSourceKind }): StoryPlayer {
  const repo = opts.repo
  // 数据源命名空间：index.ts 装配时注入 readDataSource() 的结果；缺省 local（旧调用方/离线测试）
  const source: DataSourceKind = opts.source === 'cloud' ? 'cloud' : 'local'
  const progress = loadProgress()
  // 启动即迁移旧键（一次性、幂等，见文件头「旧键迁移」）；函数声明会提升，读起来仍是线性顺序
  migrateLegacyKeys()
  // 每个客户端一条连播队列；Map 的插入顺序即 LRU 顺序（命中时移到末尾）
  const clientQueues = new Map<string, ClientQueue>()

  function loadProgress(): Record<string, any> {
    try {
      const obj = JSON.parse(String(readFileSync(opts.progressFile, 'utf8')).replace(/^\uFEFF/, ''))
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
      // 原子写：唯一临时文件 + rename，截断坏文件会让进度静默清零
      writeJsonAtomic(opts.progressFile, progress)
    } catch (e: any) { console.error('STORY-PROGRESS-SAVE-FAIL ' + String(e?.message || e)) }
  }
  /** 键是否已带数据源命名空间（`local:` / `cloud:`）；不带的是旧格式键 */
  function isNamespacedKey(key: string): boolean {
    return NAMESPACED_KEY_RE.test(key)
  }

  /**
   * 旧键 → 当前数据源命名空间：复制后删除旧键，最后整份原子落盘一次。
   *   幂等：第二次跑已经没有旧键，直接跳过、不写盘（文件字节不变）；
   *   不丢数据：先把新键放好再删旧键，落盘一次完成（writeJsonAtomic 要么旧文件、要么新文件）；
   *   新键已存在时以新键为准，旧键只做清理（对应“新键已存在 → 删除旧键”）。
   * @returns 本次搬动的旧键数（只用于日志/自测）
   */
  function migrateLegacyKeys(): number {
    let moved = 0
    for (const key of Object.keys(progress)) {
      // `_current` 是「讲到哪本」的指针，不属于任何数据源，不参与迁移
      if (key === '_current' || isNamespacedKey(key)) continue
      const target = source + ':' + key
      if (progress[target] !== true) progress[target] = true
      delete progress[key]
      moved++
    }
    if (moved > 0) {
      saveProgress()
      // 只报数量：书名来自云端清单等外部输入，不往日志里抄
      console.log('STORY-PROGRESS-MIGRATED source=' + source + ' keys=' + moved)
    }
    return moved
  }

  /** 读进度：先查新键，查不到再回退旧键（兼容窗口只读，绝不把旧键写回去） */
  function getProgress(book: string, index: number): boolean {
    if (progress[storyKeyOf(source, book, index)] === true) return true
    return progress[legacyStoryKey(book, index)] === true
  }

  /** 只改内存的「已讲」标记；落盘由调用方统一 saveProgress（一次播放只写一次盘） */
  function markRead(book: string, index: number): void {
    progress[storyKeyOf(source, book, index)] = true
  }

  /** 写进度：只写当前数据源的新键；read=false 只删新键，旧键与别的数据源都不动 */
  function setProgress(book: string, index: number, read: boolean = true): void {
    if (read) markRead(book, index)
    else delete progress[storyKeyOf(source, book, index)]
    saveProgress()
  }

  /**
   * 重新读盘：清空内存进度后按文件内容重填（保持 progress 引用不变，闭包里的其它函数继续共用同一份）。
   * 备份导入说书进度后必须调用；否则 player 手里还是启动时的旧进度，下一次 pickNext 保存会把它写回去。
   * 重读后同样跑一次迁移：导入的旧格式备份当场归一到当前数据源（幂等；没有旧键就不写盘）。
   */
  function reloadProgress(): void {
    const next = loadProgress()
    for (const k of Object.keys(progress)) delete progress[k]
    for (const k of Object.keys(next)) progress[k] = next[k]
    migrateLegacyKeys()
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

  // 播一段（组装开场白/结尾，照 C# 版 的 Speak-StoryChunk）
  function buildChunk(c: StoryChunk, isFirst: boolean, isLast: boolean): StorySpeech {
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
      rate: '-30%',  // 故事语速：主人反馈 -15% 太快，-30% 听感更稳（念诗是 -25%）
    }
  }

  function isLastPiece(c: StoryChunk): boolean {
    return Number(c.piece) >= Number(c.total)
  }

  /** 本回剩余未读段（按数组顺序，供本客户端连播） */
  function queueAfter(chunks: StoryChunk[], book: string, piece: StoryChunk): StoryChunk[] {
    return chunks
      .filter((c: StoryChunk) => Number(c.index) > Number(piece.index) && !getProgress(book, c.index))
      .sort((a: StoryChunk, b: StoryChunk) => Number(a.index) - Number(b.index))
  }

  /** 照 C# Story.Next()：当前书里找第一个未读段；读完换下一本；全读完才清零重来 */
  async function pickNext(books: string[], want: string): Promise<{ piece: StoryChunk; chunks: StoryChunk[]; book: string } | null> {
    if (books.length === 0) return null
    const resolved = resolveBook(books, want)
    let target = resolved || currentBook(books)
    let anyReadable = false
    for (let attempt = 0; attempt < books.length; attempt++) {
      const chunks = await repo.loadBook(target)
      if (chunks.length > 0) anyReadable = true
      const hit = chunks.find((c: StoryChunk) => !getProgress(target, c.index))
      if (hit) {
        markRead(target, hit.index)
        progress['_current'] = target
        saveProgress()
        return { piece: hit, chunks, book: target }
      }
      const idx = books.indexOf(target)
      target = books[(idx + 1) % books.length]
    }
    // 一本书都读不出来：上层据此返回 no readable book，别再假装「讲完了」
    if (!anyReadable) return null
    // 整整一轮都没找到未读：把本数据源的进度清零从头再来。
    // 只清当前数据源的键：别的数据源的进度不该被这次连播连带清空；
    // 旧格式键理论上已被迁移清掉，这里兜底一并清，免得读兼容把它们当成“已讲”卡死重播。
    const ownPrefix = source + ':'
    for (const k of Object.keys(progress)) {
      if (k === '_current') continue
      if (isNamespacedKey(k) && !k.startsWith(ownPrefix)) continue
      delete progress[k]
    }
    saveProgress()
    // 从头再来也要跳过坏书：按顺序找第一本能读的
    for (let i = 0; i < books.length; i++) {
      const book = books[i]
      const chunks = await repo.loadBook(book)
      const hit = chunks.find((c: StoryChunk) => !getProgress(book, c.index))
      if (!hit) continue
      markRead(book, hit.index)
      progress['_current'] = book
      saveProgress()
      return { piece: hit, chunks, book }
    }
    return null
  }

  /**
   * 取某个客户端的连播状态：命中时就地标记「刚用过」并移到 Map 末尾（LRU）。
   * 新建时先清超时未归的客户端，再按上限踢最久没用的——以前的实现按插入顺序踢最早的那个，
   * 活跃客户端反而会被刚打开的新标签页挤掉队列，连播无故从头挑段。
   */
  function stateFor(id: string): ClientQueue {
    const now = Date.now()
    let st = clientQueues.get(id)
    if (st) {
      st.lastSeen = now
      clientQueues.delete(id)
      clientQueues.set(id, st)
      return st
    }
    st = { queue: [], book: '', lastSeen: now }
    clientQueues.set(id, st)
    for (const [k, v] of clientQueues) {
      if (k !== id && now - v.lastSeen > QUEUE_TTL_MS) clientQueues.delete(k)
    }
    while (clientQueues.size > QUEUE_MAX_CLIENTS) {
      const oldest = clientQueues.keys().next().value as string | undefined
      if (oldest === undefined || oldest === id) break
      clientQueues.delete(oldest)
    }
    return st
  }

  async function books(): Promise<string[]> {
    return repo.listBooks()
  }

  async function start(hint: string, clientId: string): Promise<StoryPick> {
    const list = await repo.listBooks()
    if (list.length === 0) return { ok: false, error: 'no books' }
    const picked = await pickNext(list, hint)
    if (!picked) return { ok: false, error: 'no readable book' }
    const st = stateFor(clientId)
    st.book = picked.book
    st.queue = queueAfter(picked.chunks, picked.book, picked.piece)
    const chunk = buildChunk(picked.piece, true, isLastPiece(picked.piece))
    return { ok: true, chunk, remain: st.queue.length }
  }

  async function next(clientId: string): Promise<StoryPick> {
    const list = await repo.listBooks()
    if (list.length === 0) return { ok: false, error: 'no books' }
    const st = stateFor(clientId)
    // 队列里若已被别的标签页讲过，就跳过
    while (st.queue.length > 0 && getProgress(st.book, st.queue[0].index)) st.queue.shift()
    let piece: StoryChunk | null = null
    let isFirst = false
    if (st.queue.length > 0) {
      piece = st.queue.shift() as StoryChunk
    } else {
      const picked = await pickNext(list, '')
      if (!picked) return { ok: false, error: 'no readable book' }
      // 队列空后重新挑段：还是同一本书就不重复插开场白，真换书才开口
      const switched = !st.book || picked.book !== st.book
      piece = picked.piece
      st.book = picked.book
      st.queue = queueAfter(picked.chunks, picked.book, piece)
      isFirst = switched
    }
    const bk = st.book || String(piece.book || list[0])
    markRead(bk, piece.index)
    progress['_current'] = bk
    saveProgress()
    const chunk = buildChunk(piece, isFirst, isLastPiece(piece))
    return { ok: true, chunk, remain: st.queue.length }
  }

  async function reset(bookHint: string, clientId: string): Promise<StoryReset> {
    const list = await repo.listBooks()
    const want = String(bookHint || '').trim()
    if (!want) return { ok: false, error: 'no book' }
    // 只重置书单里真实存在的书。以前这里是 `resolveBook(list, want) || want`：
    // 任何字符串都会被当成书名写进 _current，误传一次就把「讲到哪本」污染成不存在的书
    // （下一次 next 只能回退到书单第一本，进度指针等于被静默重置）。
    const book = resolveBook(list, want)
    if (!book) return { ok: false, error: 'unknown book' }
    // 只清本数据源下这本书的新键：别的数据源的同书进度键与旧键都不动。
    // 旧键由迁移清理；迁移后还残留旧键说明是迟到的旧格式数据，下一次重读/重启会归一到当时的数据源。
    const prefix = source + ':' + book + '|'
    for (const k of Object.keys(progress)) {
      if (k !== '_current' && k.startsWith(prefix)) delete progress[k]
    }
    progress['_current'] = book
    saveProgress()
    // 该客户端的连播队列里若还排着这本书的段，也一起丢掉，免得 reset 后又接着念旧的
    const st = stateFor(clientId)
    if (st.book === book) st.queue = []
    return { ok: true, book }
  }

  return { books, start, next, reset, reloadProgress, getProgress, setProgress }
}
