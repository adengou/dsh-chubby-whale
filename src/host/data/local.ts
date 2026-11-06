/**
 * host/data/local.ts —— 本地数据源（默认）
 *
 * 从插件包内 data/ 读：说书走 host/story/repo.ts（Worker 解析大 JSON），
 * 文化走 data/culture/*.json，诗词走 data/poems.json，对联走 data/duilian.json，
 * 每日一句走 data/daily.json（可选，没有就当空）。
 *
 * 与改造前行为一致：按文件 mtime 缓存，改数据不重启；读坏只记一条日志并返回空，
 * 绝不把异常抛给路由。新增的 DataPort 只是把这些读盘逻辑收进一个实现里。
 *
 * 跨平台：路径一律 join；读入容错 UTF-8 BOM（数据文件被 Windows 工具改写过也不至于整类失效）。
 */
import { readFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { stripBom } from '../atomic.js'
import type { CultureKind, DailyItem, DataPort, DuilianData, PoemChunk, StoryBookMeta } from '../ports.js'
import type { StoryChunk, StoryRepo } from '../story/repo.js'
import {
  normalizeCultureItems, normalizeDaily, normalizeDuilian, normalizePoemItems,
} from './normalize.js'

/** 文化数据文件（本地是单文件数组） */
const CULTURE_FILES: Record<CultureKind, string> = {
  chengyu: 'chengyu.json',
  idiom: 'idioms.json',
  minsu: 'minsu.json',
}

interface CacheEntry<T> {
  value: T
  mtimeMs: number
}

export function createLocalDataPort(opts: { dataDir: string; story: StoryRepo }): DataPort {
  const CULTURE_DIR = join(opts.dataDir, 'culture')
  const POEMS_FILE = join(opts.dataDir, 'poems.json')
  const DUILIAN_FILE = join(opts.dataDir, 'duilian.json')
  const DAILY_FILE = join(opts.dataDir, 'daily.json')

  const cultureCache = new Map<CultureKind, CacheEntry<any[]>>()
  let poemsCache: CacheEntry<any[]> | null = null
  let duilianCache: CacheEntry<DuilianData> | null = null
  let dailyCache: CacheEntry<DailyItem[]> | null = null

  /**
   * 文件最后修改时间（读不到返回 0）；缓存据此失效，改数据不必重启。
   * mtimeMs 在 NTFS / ext4 / APFS 上可靠；FAT / exFAT 只有 2 秒精度，
   * 同一秒内改写数据时可能「偶尔不更新」，刷新生效会晚 1~2 秒——属已知限制，不影响正确性。
   */
  function fileMtime(p: string): number {
    try { return statSync(p).mtimeMs } catch { return 0 }
  }

  async function loadJsonArray(file: string, logTag: string): Promise<any[]> {
    try {
      const data = JSON.parse(stripBom(await readFile(file, 'utf8')))
      const arr = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : null)
      if (!arr) {
        console.error(logTag + ' file=' + file + ' err=bad structure')
        return []
      }
      return arr
    } catch (err: any) {
      if (!(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'))) {
        console.error(logTag + ' file=' + file + ' err=' + String(err?.message || err))
      }
      return []
    }
  }

  async function readStoryIndex(): Promise<StoryBookMeta[]> {
    try {
      const books = await opts.story.listBooks()
      return books.map((book: string) => ({ book }))
    } catch (err: any) {
      console.error('STORY-INDEX-FAIL err=' + String(err?.message || err))
      return []
    }
  }

  async function readStoryBook(book: string): Promise<StoryChunk[]> {
    try {
      return await opts.story.loadBook(book)
    } catch (err: any) {
      // repo.loadBook 自己已经兜底，这里只防注入的假实现抛错
      console.error('STORY-LOAD-FAIL book=' + book + ' err=' + String(err?.message || err))
      return []
    }
  }

  async function readCulture(kind: CultureKind): Promise<any[]> {
    const file = join(CULTURE_DIR, CULTURE_FILES[kind])
    const mt = fileMtime(file)
    const cached = cultureCache.get(kind)
    // 返回浅拷贝：调用方 push/splice 改的是自己那份，不会把缓存里的数组改掉
    if (cached && mt > 0 && cached.mtimeMs === mt) return cached.value.slice()
    const raw = await loadJsonArray(file, 'CULTURE-LOAD-FAIL')
    const out = normalizeCultureItems(kind, raw)
    cultureCache.set(kind, { value: out, mtimeMs: mt })
    return out
  }

  async function readPoemsChunk(index: number): Promise<PoemChunk> {
    const i = Number(index) || 0
    // 本地只有一整册：只有第 0 片有内容，其余片返回空（云端回退时不会重复喂同一批诗）
    if (i !== 0) return { index: i, total: 1, items: [] }
    const mt = fileMtime(POEMS_FILE)
    if (!(poemsCache && mt > 0 && poemsCache.mtimeMs === mt)) {
      let raw: any = null
      try {
        const data = JSON.parse(stripBom(await readFile(POEMS_FILE, 'utf8')))
        raw = Array.isArray(data) ? data : (Array.isArray(data?.poems) ? data.poems : null)
        if (!raw) console.error('POEM-LOAD-FAIL file=' + POEMS_FILE + ' err=bad structure')
      } catch (err: any) {
        if (!(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'))) {
          console.error('POEM-LOAD-FAIL file=' + POEMS_FILE + ' err=' + String(err?.message || err))
        }
      }
      poemsCache = { value: normalizePoemItems(raw || []), mtimeMs: mt }
    }
    return { index: 0, total: 1, items: poemsCache.value.slice() }
  }

  async function readDuilian(): Promise<DuilianData> {
    const mt = fileMtime(DUILIAN_FILE)
    if (duilianCache && mt > 0 && duilianCache.mtimeMs === mt) return { ...duilianCache.value }
    let raw: any = null
    try {
      raw = JSON.parse(stripBom(await readFile(DUILIAN_FILE, 'utf8')))
    } catch (err: any) {
      if (!(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'))) {
        console.error('DUILIAN-LOAD-FAIL file=' + DUILIAN_FILE + ' err=' + String(err?.message || err))
      }
    }
    const out = normalizeDuilian(raw)
    duilianCache = { value: out, mtimeMs: mt }
    return out
  }

  async function readDaily(): Promise<DailyItem[]> {
    const mt = fileMtime(DAILY_FILE)
    if (dailyCache && mt > 0 && dailyCache.mtimeMs === mt) return dailyCache.value.slice()
    let raw: any = null
    try {
      raw = JSON.parse(stripBom(await readFile(DAILY_FILE, 'utf8')))
    } catch (err: any) {
      // data/daily.json 是可选文件：没有它属于正常态，不刷日志；读坏要留痕
      if (!(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'))) {
        console.error('DAILY-LOAD-FAIL file=' + DAILY_FILE + ' err=' + String(err?.message || err))
      }
    }
    const out = normalizeDaily(raw)
    dailyCache = { value: out, mtimeMs: mt }
    return out
  }

  return { readStoryIndex, readStoryBook, readCulture, readPoemsChunk, readDuilian, readDaily }
}
