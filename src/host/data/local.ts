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
 * 缓存所有权（2026-11-06 审计补）：
 *   · 所有读口**每一条返回路径**都交出拷贝（数组 .slice()、条目浅拷贝、对联连 cats 一起），
 *     调用方 push/splice/改字段都碰不到缓存里的那份——此前只有「缓存命中」分支拷贝，
 *     首次读（写缓存那条路径）把缓存数组本体递了出去；
 *   · 失败按「确定性」分两类：坏 JSON / 缺文件是确定结果，可以记空缓存；
 *     其它读错误（EISDIR/EACCES/EBUSY…）常常是杀毒、索引、升级替换文件的瞬时占用，
 *     **不写缓存**，否则一次瞬时失败会把这一类数据在进程存活期内永久锁成空
 *     （与 host/story/repo.ts 的 cacheNegative 同一条纪律）。
 *
 * 跨平台：路径一律 join；读入容错 UTF-8 BOM（数据文件被 Windows 工具改写过也不至于整类失效）。
 */
import { readFile, readdir } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { stripBom } from '../atomic.js'
import type {
  CultureKind, DailyItem, DataPort, DuilianData, DuilianItem, PoemChunk, StoryBookMeta, StoryChunk,
} from '../ports.js'
// 只借说书仓储的接口类型（本地实现把仓储注入进来）；StoryChunk 等数据结构一律走端口层
import type { StoryRepo } from '../story/repo.js'
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
  /** 分诗人归档目录：data/poets/*.json（如「李煜.json」），念诗时与主库合并 */
  const POETS_DIR = join(opts.dataDir, 'poets')
  const DUILIAN_FILE = join(opts.dataDir, 'duilian.json')
  const DAILY_FILE = join(opts.dataDir, 'daily.json')
  /** 诗名索引 / 曲库：随包只读数据文件（路由经 DataPort 的同名可选方法取，见 ports.ts） */
  const POEM_TITLES_FILE = join(opts.dataDir, 'poem-titles.json')
  const MELODIES_FILE = join(opts.dataDir, 'melodies.json')

  const cultureCache = new Map<CultureKind, CacheEntry<any[]>>()
  let poemsCache: CacheEntry<any[]> | null = null
  let duilianCache: CacheEntry<DuilianData> | null = null
  let dailyCache: CacheEntry<DailyItem[]> | null = null
  let poemTitlesCache: CacheEntry<{ titles: string[] } | null> | null = null
  let melodiesCache: CacheEntry<any | null> | null = null

  /**
   * 文件最后修改时间（读不到返回 0）；缓存据此失效，改数据不必重启。
   * mtimeMs 在 NTFS / ext4 / APFS 上可靠；FAT / exFAT 只有 2 秒精度，
   * 同一秒内改写数据时可能「偶尔不更新」，刷新生效会晚 1~2 秒——属已知限制，不影响正确性。
   */
  function fileMtime(p: string): number {
    try { return statSync(p).mtimeMs } catch { return 0 }
  }

  /**
   * 读 + 解析一个 JSON 文件（BOM 容错）。
   * cacheable=false 专指「这次失败是瞬时的」：调用方不要把它写进缓存，下次重新读。
   * 缺文件（ENOENT/ENOTDIR）与坏 JSON（SyntaxError）都是确定性结果，可以记空缓存
   * ——缺文件时 mtime=0，本来也命中不了缓存。
   */
  async function loadJsonFile(file: string, logTag: string): Promise<{ raw: any; ok: boolean; cacheable: boolean }> {
    try {
      return { raw: JSON.parse(stripBom(await readFile(file, 'utf8'))), ok: true, cacheable: true }
    } catch (err: any) {
      const missing = Boolean(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'))
      if (!missing) {
        console.error(logTag + ' file=' + file + ' err=' + String(err?.message || err))
      }
      // JSON.parse 的失败一定是 SyntaxError（内容坏）；其余错误码（EISDIR/EPERM/EBUSY/EIO…）按瞬时处理
      return { raw: null, ok: false, cacheable: missing || err instanceof SyntaxError }
    }
  }

  /** 条目浅拷贝：缓存里的对象不交给调用方，改字段也碰不到缓存 */
  function cloneItems(arr: any[]): any[] {
    return arr.map((x: any) => (x && typeof x === 'object' ? { ...x } : x))
  }

  /** 对联拷贝：items 与 cats 都是缓存本体，连分类桶和条目一起复制 */
  function cloneDuilian(d: DuilianData): DuilianData {
    const cats: Record<string, DuilianItem[]> = {}
    for (const k of Object.keys(d.cats)) cats[k] = (d.cats[k] || []).map((x: DuilianItem) => ({ ...x }))
    const out: DuilianData = { total: d.total, items: d.items.map((x: DuilianItem) => ({ ...x })), cats }
    if (d.note) out.note = d.note
    return out
  }

  /**
   * 诗名索引：只认 {titles:[...]}，过滤空串/非字符串（与改造前 poem-titles 路由的过滤口径一致）；
   * 空表按「没数据」处理（调用方返回 null，路由走既有 ok:false 兜底）。
   */
  function pickTitles(raw: any): string[] {
    const list = raw && Array.isArray(raw.titles) ? raw.titles : []
    const out: string[] = []
    for (const item of list) if (typeof item === 'string' && item) out.push(item)
    return out
  }

  /**
   * 曲库：保留整份对象（路由自己取 songs / notes / lyrics），songs 条目浅拷贝后返回，
   * 缓存本体不交给调用方（与其它读口同一条缓存所有权纪律）。
   * 合法 JSON 但不是对象（例如字面量 null / 数字）按不可用处理，路由走既有失败兜底。
   */
  function cloneMelodies(raw: any): any | null {
    if (!raw || typeof raw !== 'object') return null
    const songs = Array.isArray(raw.songs)
      ? raw.songs.filter((s: any) => s && typeof s === 'object').map((s: any) => ({ ...s }))
      : []
    return { ...raw, songs }
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
    // 返回拷贝：调用方 push/splice/改条目改的都是自己那份，不会把缓存里的数据改掉
    if (cached && mt > 0 && cached.mtimeMs === mt) return cloneItems(cached.value)
    const loaded = await loadJsonFile(file, 'CULTURE-LOAD-FAIL')
    const data = loaded.raw
    const arr = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : null)
    if (loaded.ok && !arr) console.error('CULTURE-LOAD-FAIL file=' + file + ' err=bad structure')
    const out = normalizeCultureItems(kind, arr || [])
    // 瞬时读错误不写缓存（否则一次占用会把这一整类锁成空），下次请求重新读盘
    if (!loaded.cacheable) return out
    cultureCache.set(kind, { value: out, mtimeMs: mt })
    return cloneItems(out)
  }

  /**
   * 读 data/poets/*.json（分诗人归档）：每次现读不缓存——单个诗人文件很小，
   * 换来的是「往目录里丢一个 json 就多一位诗人的作品」，不必改代码、不必重启。
   */
  async function readExtraPoets(): Promise<any[]> {
    try {
      const files = await readdir(POETS_DIR)
      const out: any[] = []
      for (const f of files) {
        if (!/\.json$/i.test(f)) continue
        try {
          const raw = JSON.parse(stripBom(await readFile(join(POETS_DIR, f), 'utf8')))
          const list = Array.isArray(raw) ? raw : (Array.isArray(raw && raw.poems) ? raw.poems : null)
          if (list) out.push(...list)
        } catch (e) { }
      }
      return out
    } catch (e) {
      return []
    }
  }

  async function readPoemsChunk(index: number): Promise<PoemChunk> {
    const i = Number(index) || 0
    // 本地只有一整册：只有第 0 片有内容，其余片返回空（云端回退时不会重复喂同一批诗）
    if (i !== 0) return { index: i, total: 1, items: [] }
    const mt = fileMtime(POEMS_FILE)
    if (poemsCache && mt > 0 && poemsCache.mtimeMs === mt) return { index: 0, total: 1, items: cloneItems(poemsCache.value) }
    const loaded = await loadJsonFile(POEMS_FILE, 'POEM-LOAD-FAIL')
    const raw = Array.isArray(loaded.raw) ? loaded.raw : (Array.isArray(loaded.raw?.poems) ? loaded.raw.poems : null)
    if (loaded.ok && !raw) console.error('POEM-LOAD-FAIL file=' + POEMS_FILE + ' err=bad structure')
    const items = normalizePoemItems(raw || [])
    // 分诗人归档（data/poets/*.json）与主库合并：念诗、今日一句都能抽到
    const extra = normalizePoemItems(await readExtraPoets())
    if (extra.length) items.push(...extra)
    if (!loaded.cacheable) return { index: 0, total: 1, items }
    poemsCache = { value: items, mtimeMs: mt }
    return { index: 0, total: 1, items: cloneItems(items) }
  }

  async function readDuilian(): Promise<DuilianData> {
    const mt = fileMtime(DUILIAN_FILE)
    // { ...value } 只拷了顶层：items / cats 还是缓存本体，这里连条目一起复制
    if (duilianCache && mt > 0 && duilianCache.mtimeMs === mt) return cloneDuilian(duilianCache.value)
    const loaded = await loadJsonFile(DUILIAN_FILE, 'DUILIAN-LOAD-FAIL')
    const out = normalizeDuilian(loaded.raw)
    if (!loaded.cacheable) return out
    duilianCache = { value: out, mtimeMs: mt }
    return cloneDuilian(out)
  }

  async function readDaily(): Promise<DailyItem[]> {
    const mt = fileMtime(DAILY_FILE)
    if (dailyCache && mt > 0 && dailyCache.mtimeMs === mt) return cloneItems(dailyCache.value)
    // data/daily.json 是可选文件：没有它属于正常态，不刷日志；读坏要留痕（loadJsonFile 负责）
    const loaded = await loadJsonFile(DAILY_FILE, 'DAILY-LOAD-FAIL')
    const out = normalizeDaily(loaded.raw)
    if (!loaded.cacheable) return out
    dailyCache = { value: out, mtimeMs: mt }
    return cloneItems(out)
  }

  /**
   * 诗名索引：缺文件 / 坏 JSON / 空表一律 null（不抛），路由按既有 ok:false 兜底。
   * 缓存口径与其它读口一致：按 mtime 失效，坏 JSON 这类确定性失败可以记空缓存，
   * 瞬时读错误不写缓存（否则一次文件占用会把诗名永久锁成空）。
   */
  async function readPoemTitles(): Promise<{ titles: string[] } | null> {
    const mt = fileMtime(POEM_TITLES_FILE)
    if (poemTitlesCache && mt > 0 && poemTitlesCache.mtimeMs === mt) {
      const hit = poemTitlesCache.value
      return hit ? { titles: hit.titles.slice() } : null
    }
    const loaded = await loadJsonFile(POEM_TITLES_FILE, 'POEM-TITLES-LOAD-FAIL')
    let out: { titles: string[] } | null = null
    if (loaded.ok) {
      const titles = pickTitles(loaded.raw)
      if (titles.length > 0) out = { titles }
      // 合法 JSON 但结构不对/空表：留痕，与「文件坏了」同口径按不可用处理
      else console.error('POEM-TITLES-LOAD-FAIL file=' + POEM_TITLES_FILE + ' err=empty or bad structure')
    }
    if (!loaded.cacheable) return out
    poemTitlesCache = { value: out, mtimeMs: mt }
    return out ? { titles: out.titles.slice() } : null
  }

  /** 曲库：缺文件 / 坏 JSON / 非对象一律 null（不抛）；返回副本，缓存本体不外泄 */
  async function readMelodies(): Promise<any | null> {
    const mt = fileMtime(MELODIES_FILE)
    if (melodiesCache && mt > 0 && melodiesCache.mtimeMs === mt) {
      return melodiesCache.value === null ? null : cloneMelodies(melodiesCache.value)
    }
    const loaded = await loadJsonFile(MELODIES_FILE, 'MELODIES-LOAD-FAIL')
    const out = loaded.ok ? cloneMelodies(loaded.raw) : null
    if (loaded.ok && !out) console.error('MELODIES-LOAD-FAIL file=' + MELODIES_FILE + ' err=bad structure')
    if (!loaded.cacheable) return out
    melodiesCache = { value: out, mtimeMs: mt }
    return out ? cloneMelodies(out) : null
  }

  return {
    readStoryIndex, readStoryBook, readCulture, readPoemsChunk, readDuilian, readDaily,
    readPoemTitles, readMelodies,
  }
}
