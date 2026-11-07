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
 * 分段位置（2026-11-07 修）：数据里的段落只有 book/title/section/total/text，**没有 piece 字段**
 *   （实测 data/story 全部 17 本）。旧实现 `Number(c.piece) || 1` 让 piece 恒为 1，于是
 *   · `isLast = piece >= total` 只在 total===1 的段为真——而这类段多数在书中间
 *     （儒林外史第 0 段就中招，共 6 本书 18 段），客户端把 isLast===true 当「整轮讲完」
 *     （关连播 + 报「讲完了」），于是一本书刚开口就连播停了；
 *   · 气泡里的「第 x/y 段」永远是「第 1/N 段」。
 *   现在按数据本身推导：相邻同名的段属于同一个「回/篇」，total 是回内段数就用回内序号，
 *   total 恰好等于本书段数（聊斋 495、世说新语 1129）就用全书累计序号。见 planSegments()。
 *
 * isLast 只收不放：客户端把 isLast===true 当成「整轮都讲完了」（关连播 + 报完），
 *   而本后端一轮讲完会自动回卷重来（pickNext 清进度），「讲完一本自动换下一本」也是既定行为。
 *   所以 isLast 只在「本书最后一段 + 数据自己的编号也说到本单元末尾」时才置真——只去掉
 *   书中间的误判（total===1 的 18 段），不新增任何 true，跨书连播不受影响。
 *   「这一回，就讲到这里。」改由分段末尾（endsChapter）决定，回末就有，不必等到整本讲完。
 *
 * 进度次序（2026-11-07，B97）：「讲出去」不等于「听进去了」。
 *   旧实现里 pickNext/next 在**返回响应之前**就 markRead + saveProgress；而客户端单次请求超时 25s、
 *   服务端冷读一本书最长 30s（host/story/repo.ts），客户端一旦在途被停止/超时就把响应丢掉
 *   （client/story.ts 的 stillMine），于是「主人没听到的段」被记成已讲，下一段直接被跳过。
 *   现在拆成两步：
 *     · start/next 只做**内存预约**（pending）并返回这一段（served: {book,index}），不写盘；
 *     · 路由在响应真的送出去之后调 confirm(book,index) 才 markRead + 落盘；
 *       没送出去（res.end 抛错、客户端提前断开）调 discard(book,index)，这一段回到「未讲」，
 *       下一次请求还会把它讲出来。
 *   预约只用于「同一段别同时发给两个人」（并发 start 仍不重复），绝不进进度文件：
 *   只要没确认，它就永远不算讲过；进程重启后预约自然消失，最坏是重听，绝不会漏听。
 *   兼容窗口：不带 opts 的 start/next 保持旧语义（当场 markRead + 落盘）——离线脚本、
 *   旧调用方靠它读进度续讲；生产路由（host/routes/story.ts）一律传 { defer: true }。
 *
 * 这里不碰 req/res：HTTP 解析与响应在 host/routes/story.ts。
 *
 * 性能（2026-11-07 B104，算法只改「怎么算」不改「算出来是什么」）：
 *   · **键只拼一次/前缀只拼一次**：旧实现每次「这一段读过没」都现拼三个字符串
 *     （`<source>:<book>|<i>`、`<book>|<i>`、再一个 pending 键），一本 1129 段就要拼 3387 次；
 *     现在每本书的两种前缀各缓存一次（`source + ':' + book + '|'`、`book + '|'`），
 *     每段只剩 1 次「前缀 + 段号」，旧键回退也只在内存里确实存在旧键时（`hasLegacy`）才去试。
 *   · **在途预约按书分组**：`pending` 从「一个大字符串键的 Map」改成「book → 段号字符串 → 预约」，
 *     查找不再拼键；reset 清某本书也从「扫全部键的前缀」变成按书一把清（等价，见 reset 注释）。
 *   · **分段位置不再整本建 map**：旧实现 start()/next() 每次都给整本书建 `Map<段号, SegmentPos>`
 *     （1129 段 = 1129 个对象 + 1129 个 map 项），其实一次只回一段、只用一个位置；
 *     现在规范化数据直接按 index 取位置、回边界就地从相邻段扫（一「回」最多 156 段，实测最大），
 *     只有 index 不规范的怪数据才退回原来的整本 plan（那段代码原样保留，见 planOf）。
 *   · **连播队列只存段引用**：旧实现每段存一个 `{chunk, piece, total, endsChapter, endsBook}`
 *     （实测 ~90B/段，1129 段一个客户端就是 ~100KB）；现在队列只存 `StoryChunk` 引用
 *     （8B/段），位置等真正要回这一段时再算。
 *   · 以上都只动内存里的算法，进度文件格式、响应字段、选段顺序一字未变；
 *     `scripts/test-story-perf.mjs` 里内嵌了改动前的逐字段快照做等价证明。
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
  /** 这一段在本单元（回/篇）里的序号，1 起；由数据推导，不读 piece 字段（数据里没有） */
  piece: number
  /** 本单元共几段（回内段数，或全书段数——见 planSegments） */
  total: number
  isFirst: boolean
  /**
   * 整本书讲完（本书最后一段 + 数据编号也到本单元末尾）。
   * 客户端拿到 true 会关掉连播并报「讲完了」，所以只有真正讲完一本才置真：
   * 书中间的 total===1 段曾经被误判成 true，一本书刚开口连播就停了（见文件头）。
   */
  isLast: boolean
  text: string
  rate: string
}

export type StoryPick =
  /** served = 这一段是哪本书哪一段：路由在响应送出后拿它去 confirm（见文件头「进度次序」） */
  | { ok: true; chunk: StorySpeech; remain: number; served: { book: string; index: number } }
  | { ok: false; error: string }

export type StoryReset = { ok: true; book: string } | { ok: false; error: string }

export interface StoryPlayer {
  books(): Promise<string[]>
  /**
   * 开讲：按 hint 定位书，挑下一个未读段并重建该客户端的连播队列。
   * opts.defer=true（生产路由用）：只预约、不落盘，等响应送出后由 confirm 记账；
   * 省略/ false：旧语义，当场记账落盘（离线脚本与旧调用方依赖它）。
   */
  start(hint: string, clientId: string, opts?: { defer?: boolean }): Promise<StoryPick>
  /** 连播下一段：先取该客户端队列，空了再跨书挑（opts 同上） */
  next(clientId: string, opts?: { defer?: boolean }): Promise<StoryPick>
  /**
   * 确认「这一段真的送出去了」：把预约的段记成已讲并落盘。
   * 只认预约过的段——reset / 导入备份之后迟到的确认，不许把旧段写回来。
   * @returns 是否确实记了；没有预约（已被撤销/重置）返回 false 且不写盘
   */
  confirm(book: string, index: number): boolean
  /** 撤销预约：响应没送出去（res.end 抛错 / 客户端提前断开）时调用，这一段回到「未讲」 */
  discard(book: string, index: number): boolean
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
/**
 * 在途预约的兜底寿命：正常路径由路由的 confirm/discard 当场结清，
 * 这里只防「既没 confirm 也没 discard」（宿主异常、路由没接完）时预约在内存里越积越多。
 * 过期只是让这一段重新可挑（最坏重听一段），绝不写盘、绝不会把没听的段算成已讲。
 */
const PENDING_TTL_MS = 10 * 60 * 1000
/**
 * 回目标题里的「正文」噪音（有的数据把「正文」拼进标题，念出来很怪）。
 * 提到模块级只编译一次：每段都新建一个正则对象是白花的内存/GC（替换行为不变，/g 每次都会重置 lastIndex）。
 */
const TITLE_NOISE_RE = /正文\s*/g

/** 一段在本书里的分段位置，以及「是否讲到了本回/篇的末尾」 */
interface SegmentPos {
  /** 这一段在本单元里的序号（1 起） */
  piece: number
  /** 本单元共几段 */
  total: number
  /** 本回/篇讲完了 → 该说「这一回，就讲到这里。」 */
  endsChapter: boolean
  /** 这是本书的最后一段（按数据顺序）——「整本书讲完」的必要条件 */
  endsBook: boolean
}

/** plan 里查不到时的安全默认值（不该发生；旧实现每次新建一个同值对象，这里共享一份只读默认值） */
const DEFAULT_POS: SegmentPos = { piece: 1, total: 1, endsChapter: false, endsBook: false }

/**
 * 一本书的分段位置来源（见 planOf）。两种形态：
 *   · canonical=true：数据规范（`String(index)` 恰好等于数组位置，normalize 恒成立）——
 *     位置直接由 index 得到，回边界按相邻段现扫，不需要整本 map；
 *   · canonical=false：index 重复/不是数组位置等怪数据——退回旧实现逐字保留的整本 plan，
 *     保证「同一输入 → 同一输出」，不因为优化改变怪数据的表现。
 */
interface BookPlan {
  canonical: boolean
  /** 规范数据：整本段（扫回边界、判断书末要用）；非规范数据为 undefined */
  chunks?: StoryChunk[]
  /** 非规范数据：旧实现的 `Map<String(index), SegmentPos>`；规范数据为 undefined */
  map?: Map<string, SegmentPos>
}

/** 连播队列里的一项就是段本身（分段位置在要回这一段时才按 plan 算，见文件头「性能」） */
interface ClientQueue {
  /** 本书剩余未读段（连播顺序） */
  queue: StoryChunk[]
  /** 队列所属书名 */
  book: string
  /** 队列所属书的分段位置来源（与 book 同时设置，见 planOf） */
  plan: BookPlan | null
  /** 最近一次请求时间：TTL 清理与 LRU 驱逐都按它排 */
  lastSeen: number
}

/** 已送出、等确认的一段：存活时间（TTL）、领走它的客户端、以及从连播队列出队的原始段 */
interface PendingServe {
  /** 预约时间（超过 PENDING_TTL_MS 视为作废） */
  at: number
  /** 领走这一段的客户端（start 会重建队列，留空；next 记下以便撤销时归队） */
  client: string
  /** next 从队列里出队的那一段：响应没送出去时原样塞回队首 */
  entry?: StoryChunk
}

/** 新键前缀：`local:` / `cloud:`。两种前缀都没有的键，就是需要迁移的旧格式键 */
const NAMESPACED_KEY_RE = /^(?:local|cloud):/

/** 新键：`<source>:<book>|<index>`（进度写入只走这个格式；键格式只在这里定义一次） */
function storyKeyOf(source: DataSourceKind, book: string, index: number | string): string {
  return source + ':' + String(book || '') + '|' + String(index)
}

/** 旧键（无数据源命名空间）：`<book>|<index>`，只用于迁移与读取兼容，不再写入 */
function legacyStoryKey(book: string, index: number | string): string {
  return String(book || '') + '|' + String(index)
}

export function createStoryPlayer(opts: { repo: StoryRepo; progressFile: string; source?: DataSourceKind }): StoryPlayer {
  const repo = opts.repo
  // 数据源命名空间：index.ts 装配时注入 readDataSource() 的结果；缺省 local（旧调用方/离线测试）
  const source: DataSourceKind = opts.source === 'cloud' ? 'cloud' : 'local'
  const loaded = loadProgress()
  const progress = loaded.map
  /**
   * 内存里是否还留着旧格式键（`book|index`）。启动迁移与 reload 迁移都会把它们搬走，
   * 正常情况下恒为 false；为 false 时读取跳过旧键回退（省一次拼接 + 一次对象查找）。
   * 保留这个开关而不是删掉回退分支：万一有旧键绕过迁移留在内存里，读取行为与旧实现完全一致。
   * 计数是 loadProgress 顺路数的（不多扫一遍），迁移真搬了键就置 false（见 migrateLegacyKeys）。
   */
  let hasLegacy = loaded.legacy > 0
  // 启动即迁移旧键（一次性、幂等，见文件头「旧键迁移」）；函数声明会提升，读起来仍是线性顺序
  migrateLegacyKeys()
  // 每个客户端一条连播队列；Map 的插入顺序即 LRU 顺序（命中时移到末尾）
  const clientQueues = new Map<string, ClientQueue>()
  /**
   * 已送出、还没确认的段（只在内存里，绝不落盘）：键与进度键同口径，但按书分组，
   * 「这本书这个段号」直接两级查，不必现拼 `<source>:<book>|<index>`（见文件头「性能」）。
   * 段号仍按 String(index) 做键：与旧实现的字符串键口径一致（1 与 '1' 算同一段），只是省掉前缀。
   * 作用有二：① 响应写出期间同一段不会被另一个请求再挑走（并发 start 不重复）；
   * ② 只要没 confirm，它就仍算未讲——断开/undo 之后下一次请求还能再讲它。
   */
  const pending = new Map<string, Map<string, PendingServe>>()
  /**
   * 每本书的新键前缀 `<source>:<book>|`（只依赖 source + book，建一次就不变）：
   * 热路径每段只拼一次「前缀 + 段号」，不必每次把 source/book/分隔符再拼一遍。
   * 缓存只影响速度：前缀内容与 storyKeyOf 的拼接逐字一致；上限只是防外部输入把 Map 撑大。
   */
  const progressPrefixes = new Map<string, string>()
  const KEY_PREFIX_MAX = 256

  function loadProgress(): { map: Record<string, any>; legacy: number } {
    try {
      const obj = JSON.parse(String(readFileSync(opts.progressFile, 'utf8')).replace(/^\uFEFF/, ''))
      const out: Record<string, any> = {}
      let legacy = 0
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const k of Object.keys(obj)) {
          if (k === '_current') {
            if (typeof obj[k] === 'string') out[k] = obj[k]
          } else if (obj[k]) {
            out[k] = true
            // 顺便数旧键：这次遍历本来就要走一遍键，不必为了 hasLegacy 再单独扫一遍进度对象
            if (!isNamespacedKey(k)) legacy++
          }
        }
      }
      return { map: out, legacy }
    } catch { return { map: {}, legacy: 0 } }
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
      // 搬走的旧键已经删掉了：内存里不再有旧键，读取可跳过旧键回退（行为与「扫到没有」等价）
      hasLegacy = false
      saveProgress()
      // 只报数量：书名来自云端清单等外部输入，不往日志里抄
      console.log('STORY-PROGRESS-MIGRATED source=' + source + ' keys=' + moved)
    }
    return moved
  }

  /** 取（并缓存）一本书的新键前缀；内容与 storyKeyOf 的拼接逐字一致 */
  function keyPrefixOf(book: string): string {
    const b = String(book || '')
    let p = progressPrefixes.get(b)
    if (p === undefined) {
      // 段号传空串：拼出来正好是「前缀」（键格式仍只由 storyKeyOf / legacyStoryKey 定义）
      if (progressPrefixes.size >= KEY_PREFIX_MAX) progressPrefixes.clear()
      p = storyKeyOf(source, b, '')
      progressPrefixes.set(b, p)
    }
    return p
  }

  /** 预约表：按书分组，进去只查这一本；没有预约过这本书就返回 undefined（不建空表） */
  function pendingOf(book: string): Map<string, PendingServe> | undefined {
    return pending.get(String(book || ''))
  }
  /** 取一段的预约（不判 TTL、不删除）：confirm/discard/tagServed 用，与旧实现「只看在不在」一致 */
  function peekPending(book: string, index: number): PendingServe | undefined {
    const m = pendingOf(book)
    return m === undefined ? undefined : m.get(String(index))
  }
  /** 取走一段的预约（拿到即删；书里没有别的预约时把空表也摘掉，别留空壳） */
  function takePending(book: string, index: number): PendingServe | undefined {
    const b = String(book || '')
    const m = pending.get(b)
    if (m === undefined) return undefined
    const rec = m.get(String(index))
    if (rec === undefined) return undefined
    m.delete(String(index))
    if (m.size === 0) pending.delete(b)
    return rec
  }
  function putPending(book: string, index: number, rec: PendingServe): void {
    const b = String(book || '')
    let m = pending.get(b)
    if (m === undefined) { m = new Map<string, PendingServe>(); pending.set(b, m) }
    m.set(String(index), rec)
  }

  /** 读进度：先查新键，查不到再回退旧键（兼容窗口只读，绝不把旧键写回去） */
  function getProgress(book: string, index: number): boolean {
    // 热路径（每扫一段都要问一次）：前缀已缓存，这里只拼一次「前缀 + 段号」。
    if (progress[keyPrefixOf(book) + index] === true) return true
    // 迁移后内存里通常一条旧键都没有（hasLegacy=false）：这时连旧键字符串都不必拼。
    return hasLegacy && legacyReadFallback(book, index)
  }

  /**
   * 旧键读取（兼容窗口只读，绝不把旧键写回去）——getProgress 的回退分支，只有 hasLegacy 时才进来。
   * 这里的拼法与旧实现逐字一致：scripts/test-behavior-regressions.mjs 用源码形状锁住
   * 「先新键、再回退旧键」这条兼容约定（它不是热路径，没必要为省字符串把这段改形）。
   * 新键在这里会再查一次（调用方刚查过）：只为让这段回退的语义与形状和迁移前完全一样。
   */
  function legacyReadFallback(book: string, index: number): boolean {
    if (progress[storyKeyOf(source, book, index)] === true) return true
    return progress[legacyStoryKey(book, index)] === true
  }

  /**
   * 只改内存的「已讲」标记；落盘由调用方统一 saveProgress（一次播放只写一次盘）。
   * 写入一律走新键（storyKeyOf 口径），旧键只读不写——自测里有源码形状断言锁这条。
   * 每段只调一次（confirm 之后），不是扫描热路径，不必为了省一次拼接在这里做前缀缓存。
   */
  function markRead(book: string, index: number): void {
    progress[storyKeyOf(source, book, index)] = true
  }

  /** 这一段是否还在「已送出、等确认」的状态（过期即作废：宁可重听一段，也不能漏讲） */
  function isPending(book: string, index: number): boolean {
    const m = pendingOf(book)
    if (m === undefined) return false
    const k = String(index)
    const rec = m.get(k)
    if (rec === undefined) return false
    if (Date.now() - rec.at > PENDING_TTL_MS) {
      m.delete(k)
      if (m.size === 0) pending.delete(String(book || ''))
      return false
    }
    return true
  }

  /** 这一段现在能不能挑：已讲（落盘了）或在途（等确认）都别动 */
  function isTaken(book: string, index: number): boolean {
    return getProgress(book, index) || isPending(book, index)
  }

  /**
   * 记账入口：defer=true 只预约（等响应送出后 confirm 才落盘），否则维持旧语义当场记账落盘。
   * 两套语义共用同一个进度文件格式：确认后才写 `<source>:<book>|<index>: true` + `_current`。
   * client/entry 只给连播队列用：next 从队列里出队的那一段要记下来，响应没送出去时塞回队首。
   */
  function markServed(book: string, index: number, defer: boolean, client: string = '', entry?: StoryChunk): void {
    if (defer) { putPending(book, index, { at: Date.now(), client, entry }); return }
    markRead(book, index)
    progress['_current'] = book
    saveProgress()
  }

  /** 只补预约里的「谁领走的、队列里那一段长什么样」，不碰预约时间、更不碰进度文件（pickNext 已预约过） */
  function tagServed(book: string, index: number, client: string, entry: StoryChunk): void {
    const rec = peekPending(book, index)
    if (!rec) return
    rec.client = client
    rec.entry = entry
  }

  /**
   * 确认一段真的送出去了：预约 → 已讲 + 落盘，并把「当前书」指过去。
   * 只认预约过的段：reset / 导入备份清掉预约之后迟到的确认，不会把旧段写回来。
   */
  function confirm(book: string, index: number): boolean {
    if (takePending(book, index) === undefined) return false
    markRead(book, index)
    progress['_current'] = book
    saveProgress()
    return true
  }

  /**
   * 撤销预约：这一段没送出去，回到「未讲」（不写盘，因为本来就还没写）。
   * 若它是从某客户端的连播队列里出队的，就原样塞回该队列的队首——不塞回去的话，
   * 这一段要等整本书念完才可能被 pickNext 重新捡到，用户会以为「跳了一段」。
   */
  function discard(book: string, index: number): boolean {
    const rec = takePending(book, index)
    if (!rec) return false
    const st = rec.client ? clientQueues.get(rec.client) : undefined
    if (rec.entry && st && st.book === book && !st.queue.some((q: StoryChunk) => Number(q.index) === index)) {
      st.queue.unshift(rec.entry)
    }
    return true
  }

  /** 写进度：只写当前数据源的新键；read=false 只删新键，旧键与别的数据源都不动 */
  function setProgress(book: string, index: number, read: boolean = true): void {
    if (read) markRead(book, index)
    else delete progress[keyPrefixOf(book) + index]
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
    for (const k of Object.keys(next.map)) progress[k] = next.map[k]
    // 导入的备份才是真相：在途预约作废（迟到的 confirm 会因「没预约」被拒绝，不会覆盖导入内容）
    pending.clear()
    hasLegacy = next.legacy > 0
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
  function buildChunk(c: StoryChunk, isFirst: boolean, seg: SegmentPos): StorySpeech {
    const bookName = String(c.book || '故事')
    const title = String(c.title || '')
    const spoken = String(c.text || '')
    const author = STORY_AUTHORS[bookName] || ''
    const cleanTitle = title.replace(TITLE_NOISE_RE, '')
    const intro = isFirst ? ('话说，今天给主人讲一段《' + bookName + '》' + (author ? '，' + author + '著' : '') + '，' + cleanTitle + '。') : ''
    // 结尾句按「本回/篇讲完」出，不再跟着 isLast（见文件头：isLast 会被客户端当成整轮结束）
    const tail = seg.endsChapter ? '这一回，就讲到这里。' : ''
    return {
      book: bookName,
      title,
      piece: seg.piece,
      total: seg.total,
      isFirst,
      // 「整本书讲完」= 本书最后一段 + 数据自己的编号也说到本单元末尾（piece >= total）。
      // 两条必须同时成立：数据里没有 piece 字段（归一化后 piece 恒 1），只看编号的话，
      // total===1 的中间段会被误判成整轮结束（6 本书 18 段，儒林外史第 0 段就中招），
      // 客户端会当场关掉连播。这里只收紧不放松——原本为 false 的段永远不会变成 true，
      // 所以「一本接一本」的跨书连播照旧。
      isLast: seg.endsBook && Number(c.piece) >= Number(c.total),
      text: intro + spoken + tail,
      rate: '-30%',  // 故事语速：主人反馈 -15% 太快，-30% 听感更稳（念诗是 -25%）
    }
  }

  /**
   * 一本书每段的分段位置（键 = String(index)）——**旧实现**，现在只在「index 不规范的怪数据」上走。
   * 数据里没有 piece 字段，只能从 title 分组推：
   *   · 相邻且同名的段 = 同一「回/篇」（西游记 4 段一回、三言二拍 10 段一卷、聊斋一篇一段）；
   *   · total 的语义两种：回内段数（西游记 4 / 三言二拍 10），或全书段数（聊斋 495 / 世说新语 1129）；
   *   · 判定：total === 本书段数 → 全书累计序号；否则用回内序号；
   *     两者都对不上（空段被过滤、坏数据）时以实际分组为准——保证「第 x/y 段」的 y 永远等于真实段数。
   * 保留它是因为它按 String(index) 建表：index 重复时「后写覆盖先写」，与 posOf 的按位置推导不等价。
   */
  function planSegments(chunks: StoryChunk[]): Map<string, SegmentPos> {
    const plan = new Map<string, SegmentPos>()
    const n = chunks.length
    let i = 0
    while (i < n) {
      const title = String(chunks[i].title || '')
      let j = i + 1
      while (j < n && String(chunks[j].title || '') === title) j++
      for (let k = i; k < j; k++) {
        const bookWide = Number(chunks[k].total) === n
        plan.set(String(chunks[k].index), {
          piece: bookWide ? k + 1 : k - i + 1,
          total: bookWide ? n : j - i,
          endsChapter: k === j - 1,
          endsBook: k === n - 1,
        })
      }
      i = j
    }
    return plan
  }

  /**
   * 决定一本书用哪种分段位置来源。
   * 规范数据（normalize 的产物：`String(index)` 恰好是数组位置）走「按位置就地推导」，不建任何整本表；
   * 否则退回旧实现的 planSegments——同一输入 → 同一输出，优化不改变怪数据的行为。
   */
  function planOf(chunks: StoryChunk[]): BookPlan {
    const n = chunks.length
    for (let i = 0; i < n; i++) {
      const x = chunks[i].index
      // 旧实现的键是 String(index)，所以「数字 0 / 字符串 '0'」在同一个位置算规范；
      // 只有拼出来跟位置对不上的（重复、缺号、非数字）才退回 plan map。
      if (x !== i && String(x) !== String(i)) return { canonical: false, map: planSegments(chunks) }
    }
    return { canonical: true, chunks }
  }

  /**
   * 取一段的分段位置。
   * 规范数据：段号就是位置，回边界就地往两边扫同名段（实测最长一「回」156 段）——
   *   旧实现为此给整本 1129 段各建一个对象 + 一条 map 项，其实一次只要一个位置。
   * 非规范数据：查旧实现的 plan map（`String(index)` 后写覆盖，与旧行为一致）。
   * 查不到（不该发生）时给安全默认值，绝不让响应缺字段。
   */
  function posOf(plan: BookPlan, c: StoryChunk): SegmentPos {
    if (!plan.canonical) {
      const hit = plan.map!.get(String(c.index))
      return hit || DEFAULT_POS
    }
    const chunks = plan.chunks!
    const n = chunks.length
    const pos = Number(c.index)
    if (!Number.isInteger(pos) || pos < 0 || pos >= n) return DEFAULT_POS
    const title = String(chunks[pos].title || '')
    let start = pos
    while (start > 0 && String(chunks[start - 1].title || '') === title) start--
    let end = pos + 1
    while (end < n && String(chunks[end].title || '') === title) end++
    const bookWide = Number(chunks[pos].total) === n
    return {
      piece: bookWide ? pos + 1 : pos - start + 1,
      total: bookWide ? n : end - start,
      endsChapter: pos === end - 1,
      endsBook: pos === n - 1,
    }
  }

  /**
   * 本书剩余未读段（按数组顺序，供本客户端连播）。
   * 旧实现是 filter → sort → map(段+位置)，每段一个对象（实测 ~90B/段，1129 段 ~100KB）；
   * 现在只收段引用：位置等真正要回这一段时再由 posOf 算（见文件头「性能」）。
   * 排序保留：数据若本来没按 index 升序，排序结果与旧实现逐元素一致（稳定排序 + 同一个比较器）。
   */
  function queueAfter(chunks: StoryChunk[], book: string, afterIndex: number): StoryChunk[] {
    const out: StoryChunk[] = []
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]
      if (Number(c.index) > afterIndex && !isTaken(book, c.index)) out.push(c)
    }
    for (let i = 1; i < out.length; i++) {
      if (Number(out[i - 1].index) > Number(out[i].index)) {
        out.sort((a: StoryChunk, b: StoryChunk) => Number(a.index) - Number(b.index))
        break
      }
    }
    return out
  }

  /** 照 C# Story.Next()：当前书里找第一个未读段；读完换下一本；全读完才清零重来 */
  async function pickNext(books: string[], want: string, defer: boolean): Promise<{ piece: StoryChunk; chunks: StoryChunk[]; book: string } | null> {
    if (books.length === 0) return null
    const resolved = resolveBook(books, want)
    let target = resolved || currentBook(books)
    let anyReadable = false
    for (let attempt = 0; attempt < books.length; attempt++) {
      const chunks = await repo.loadBook(target)
      if (chunks.length > 0) anyReadable = true
      const hit = chunks.find((c: StoryChunk) => !isTaken(target, c.index))
      if (hit) {
        // 只预约、不落盘：等路由确认「响应真的写出去了」才记账（见文件头「进度次序」）
        markServed(target, hit.index, defer)
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
    // 新的一轮开始：在途预约也一起作废（否则刚回卷就会被上一轮的预约挡住，挑不出段）
    pending.clear()
    // 上面这轮清键把旧格式键也一并删了（非命名空间的键不跳过），所以内存里不再有旧键
    hasLegacy = false
    saveProgress()
    // 从头再来也要跳过坏书：按顺序找第一本能读的
    for (let i = 0; i < books.length; i++) {
      const book = books[i]
      const chunks = await repo.loadBook(book)
      const hit = chunks.find((c: StoryChunk) => !isTaken(book, c.index))
      if (!hit) continue
      markServed(book, hit.index, defer)
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
    st = { queue: [], book: '', plan: null, lastSeen: now }
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

  async function start(hint: string, clientId: string, opts?: { defer?: boolean }): Promise<StoryPick> {
    const defer = !!(opts && opts.defer)
    const list = await repo.listBooks()
    if (list.length === 0) return { ok: false, error: 'no books' }
    const picked = await pickNext(list, hint, defer)
    if (!picked) return { ok: false, error: 'no readable book' }
    const st = stateFor(clientId)
    const plan = planOf(picked.chunks)
    st.book = picked.book
    st.plan = plan
    st.queue = queueAfter(picked.chunks, picked.book, Number(picked.piece.index))
    const chunk = buildChunk(picked.piece, true, posOf(plan, picked.piece))
    return { ok: true, chunk, remain: st.queue.length, served: { book: picked.book, index: Number(picked.piece.index) } }
  }

  async function next(clientId: string, opts?: { defer?: boolean }): Promise<StoryPick> {
    const defer = !!(opts && opts.defer)
    const list = await repo.listBooks()
    if (list.length === 0) return { ok: false, error: 'no books' }
    const st = stateFor(clientId)
    // 队列里若已被别的标签页讲过、或正在送出（等确认），就跳过
    while (st.queue.length > 0 && isTaken(st.book, st.queue[0].index)) st.queue.shift()
    let entry: StoryChunk | null = null
    let isFirst = false
    /** pickNext 已经预约/记账过这一段，别再记第二遍 */
    let booked = false
    if (st.queue.length > 0) {
      entry = st.queue.shift() as StoryChunk
    } else {
      const picked = await pickNext(list, '', defer)
      if (!picked) return { ok: false, error: 'no readable book' }
      // 队列空后重新挑段：还是同一本书就不重复插开场白，真换书才开口
      const switched = !st.book || picked.book !== st.book
      entry = picked.piece
      st.book = picked.book
      st.plan = planOf(picked.chunks)
      st.queue = queueAfter(picked.chunks, picked.book, Number(picked.piece.index))
      isFirst = switched
      booked = true
    }
    const piece = entry
    const bk = st.book || String(piece.book || list[0])
    if (booked) {
      // pickNext 已经预约/记账过这一段：defer 时补上「谁领走的 + 队列里那一段」，撤销时好归队
      if (defer) tagServed(bk, piece.index, clientId, entry)
    } else {
      markServed(bk, piece.index, defer, clientId, entry)
    }
    const chunk = buildChunk(piece, isFirst, st.plan ? posOf(st.plan, piece) : DEFAULT_POS)
    return { ok: true, chunk, remain: st.queue.length, served: { book: bk, index: Number(piece.index) } }
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
    const prefix = keyPrefixOf(book)
    for (const k of Object.keys(progress)) {
      if (k !== '_current' && k.startsWith(prefix)) delete progress[k]
    }
    // 在途预约也一起清：reset 之后这一段必须能马上重讲，别让「刚送出还没确认」的旧预约挡住。
    // 预约按书分组（键就是书名），所以这里一把删掉这本书的分组即可——与旧实现「按 <source>:<book>| 前缀扫」
    // 命中的集合完全相同（预约键的前缀里 source 恒定、book 完全相同）。
    pending.delete(String(book || ''))
    progress['_current'] = book
    saveProgress()
    // 该客户端的连播队列里若还排着这本书的段，也一起丢掉，免得 reset 后又接着念旧的
    const st = stateFor(clientId)
    if (st.book === book) st.queue = []
    return { ok: true, book }
  }

  return { books, start, next, reset, reloadProgress, getProgress, setProgress, confirm, discard }
}
