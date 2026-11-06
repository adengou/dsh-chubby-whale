/**
 * host/story/repo.ts —— 说书数据仓库（可复用）
 *
 * 职责只有三件事：枚举书单、按需解析一本书、按 mtime 缓存/并发去重。
 * 不碰进度、不碰 HTTP、不碰客户端队列——那些在 host/story/player.ts。
 * 解析放 Worker 线程（一本 30MB JSON 不能阻塞主线程）；坏文件/超时都 resolve 空数组，绝不 reject。
 */
import { readdir } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { normalizeStoryChunks } from '../data/normalize.js'
import type { StoryChunk } from '../ports.js'

export type { StoryChunk }

/** 内存里最多留几本书：一本 JSON 可能几 MB，无限缓存会一直涨 */
const BOOK_CACHE_MAX = 2
/** 单本书解析超时：30 秒 */
const READ_TIMEOUT_MS = 30000
/** 书名上限：与路由/数据源投影一致（最长书名 4 字，64 已留余量） */
const BOOK_NAME_MAX = 64
/** 书名里不允许出现：路径分隔符、控制字符、上跳片段（`..`）——book 最终要拼进 join()，不能当路径用 */
const BAD_BOOK_NAME_RE = /[\\/\u0000-\u001F\u007F]|\.\./

export interface StoryRepo {
  /** 数据目录下所有 .json 书名（排序后） */
  listBooks(): Promise<string[]>
  /** 读一本书；坏文件/超时返回空数组 */
  loadBook(book: string): Promise<StoryChunk[]>
}

export function createStoryRepo(opts: { dataDir: string; workerPath: string }): StoryRepo {
  const STORY_DIR = join(opts.dataDir, 'story')
  const bookCache = new Map<string, { chunks: StoryChunk[]; mtimeMs: number }>()
  /**
   * 进行中的读盘请求：book → { mtimeMs, promise }。
   * 并发来两个请求时如果各起一个 Worker，就是两个线程同时读 30MB JSON，
   * 内存峰值和 CPU 都翻倍；这里按「书 + mtime」去重，两个请求共用同一次解析。
   */
  const inflight = new Map<string, { mtimeMs: number; promise: Promise<StoryChunk[]> }>()

  /** 文件最后修改时间（读不到返回 0）；缓存据此失效，改数据不必重启 */
  function fileMtime(p: string): number {
    try { return statSync(p).mtimeMs } catch { return 0 }
  }

  /**
   * 书名 → 安全文件名（空串表示非法）。
   * book 来自书单（本地 readdir / 云端 index.json），最终拼进 join(STORY_DIR, book + '.json')；
   * 云端清单属于外部数据，若原样透传，`../x` 就能读出 data/story 以外的 JSON。
   * 这里作为文件系统边界的最后一道校验，非法名一律当坏书（返回空数组），不抛错。
   */
  function safeBookName(book: string): string {
    const name = String(book == null ? '' : book).trim()
    if (!name || name.length > BOOK_NAME_MAX) return ''
    if (BAD_BOOK_NAME_RE.test(name)) return ''
    return name
  }

  /** 缓存写入后统一按 LRU 修剪，避免超上限 */
  function trimCache(): void {
    while (bookCache.size > BOOK_CACHE_MAX) {
      const oldest = bookCache.keys().next().value as string | undefined
      if (oldest === undefined) break
      bookCache.delete(oldest)
    }
  }

  async function listBooks(): Promise<string[]> {
    try {
      const files = await readdir(STORY_DIR)
      return files.filter((f: string) => f.endsWith('.json')).map((f: string) => f.replace(/\.json$/, '')).sort()
    } catch { return [] }
  }

  /**
   * 按需读一本书（Worker 解析、内存缓存、并发去重）；index 用原数组序号（照 C#）。
   * 坏文件/超时都不抛：记 STORY-LOAD-FAIL 后返回空数组，
   * 让上层继续试下一本（一本坏不能拖垮整个说书功能）。
   * 同一本书（且文件没被改过）已有请求在跑时复用那个 Promise，不再另起 Worker。
   * 清洗规则与云端数据源共用，见 host/data/normalize.ts。
   */
  function loadBook(book: string): Promise<StoryChunk[]> {
    const name = safeBookName(book)
    if (!name) {
      // 外部输入只留 80 字并去掉换行：别让坏请求写出几千字的日志行或伪造日志
      console.error('STORY-LOAD-FAIL book=' + String(book == null ? '' : book).slice(0, 80).replace(/[\r\n]/g, ' ') + ' err=bad book name')
      return Promise.resolve([])
    }
    const file = join(STORY_DIR, name + '.json')
    const mt = fileMtime(file)
    const cached = bookCache.get(name)
    if (cached && mt > 0 && cached.mtimeMs === mt) {
      // 命中：顺手 touch 一下，保持 LRU 顺序
      bookCache.delete(name)
      bookCache.set(name, cached)
      // 浅拷贝返回：调用方排序/切分不会改到缓存里的数组
      return Promise.resolve(cached.chunks.slice())
    }
    const running = inflight.get(name)
    // 文件没被改过才复用；mtime 变了说明数据刚更新，得重新读，不能拿旧书糊弄。
    // 复用的是「解析」这一次，数组仍各给一份：多个等待者若拿到同一个数组实例，
    // 谁在旁边 sort/reverse 一下就会把别人的播放顺序改掉（坑 27 的同款）。
    if (running && running.mtimeMs === mt) return running.promise.then((list) => list.slice())
    const task = readBook(name, file, mt)
    inflight.set(name, { mtimeMs: mt, promise: task })
    const release = (): void => {
      const cur = inflight.get(name)
      if (cur && cur.promise === task) inflight.delete(name)   // 只摘自己这条，别误删后来者
    }
    task.then(release, release)
    return task
  }

  /** 起 Worker 解析一本书（30s 超时；失败/崩溃都 resolve 空数组，绝不 reject） */
  function readBook(book: string, file: string, mt: number): Promise<StoryChunk[]> {
    return new Promise((resolve) => {
      let done = false
      let worker: any = null
      let timer: any = null
      const stopWorker = (): void => { try { if (worker) worker.terminate() } catch { } }
      /** cacheNegative：只给「文件解析不了」这种确定性失败记缓存，
       *  让后续请求直接返回空、不再每次重起 Worker。文件修好时 mtime 变，缓存自动失效重读。
       *  超时 / Worker 崩溃可能是机器一时繁忙或资源紧张，不记（否则这本书在重启前永远读不到）。 */
      const fail = (err: any, cacheNegative = false): void => {
        if (done) return
        done = true
        // 超时/崩溃/解析失败都要把另外两样收干净，别留一个 30s 定时器或活着的线程
        if (timer) { try { clearTimeout(timer) } catch { } ; timer = null }
        stopWorker()
        console.error('STORY-LOAD-FAIL book=' + book + ' err=' + String(err?.message || err))
        if (cacheNegative && mt > 0) {
          bookCache.set(book, { chunks: [], mtimeMs: mt })
          trimCache()
        }
        resolve([])
      }
      try {
        const w = new Worker(opts.workerPath)
        worker = w
        timer = setTimeout(() => { fail('timeout 30s') }, READ_TIMEOUT_MS)
        w.once('message', (msg: any) => {
          clearTimeout(timer)
          timer = null
          if (done) return
          if (msg && msg.ok) {
            done = true
            const list = normalizeStoryChunks(book, msg.chunks)
            bookCache.set(book, { chunks: list, mtimeMs: mt })
            // LRU：超上限就丢最早的那本（Map 保持插入顺序）
            trimCache()
            stopWorker()
            // 冷读也返回浅拷贝：首个调用方若对返回数组 push/sort，不能改到缓存里的那份
            resolve(list.slice())
          } else fail(msg?.error || 'parse failed', true)
        })
        w.once('error', (err: any) => fail(err))
        // Worker 崩了（线程里未捕获异常、被 OOM 杀掉）不会发 message 也不会发 error，只有 exit；
        // 不接这一条，请求会一直悬到 30 秒超时才回空。done 在成功/失败时已置位，
        // 所以 terminate() 引发的 exit(code=1) 不会被误报成崩溃。
        w.once('exit', (code: number) => {
          if (!done && code !== 0) fail('worker exit ' + code)
        })
        w.postMessage({ book, file })
      } catch (err) { fail(err) }
    })
  }

  return { listBooks, loadBook }
}
