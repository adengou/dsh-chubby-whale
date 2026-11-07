/**
 * host/ports.ts —— 路由依赖的窄接口（端口）
 *
 * 目的：路由只声明"我需要什么能力"，不依赖 store / cache / 具体实现的类型；
 * index.ts 负责把真实实现注进来，测试可注入内存假实现。
 * 每个接口只覆盖一个路由用到的字段，不追求把整个 store 塞进来。
 */
// 端口层自己定义数据结构，绝不 import 具体实现（依赖方向：实现 → 端口）

/** 说书的一块正文（story/repo 产出、路由消费；定义放端口层避免反向依赖） */
export interface StoryChunk {
  book: string
  title: string
  piece: number
  total: number
  text: string
  /** 原数组序号（进度 key 用它，避免回目里 piece 重复导致误判） */
  index: number
}

/** TTS 合成请求（引擎与路由共用；定义放端口层） */
export interface TtsSynthRequest {
  text: string
  voice: string
  rate?: string
  pitch?: string
  /**
   * 可选：调用方中止信号（路由在客户端断连时给出 —— 切页面 / 30s 硬超时 / 断网重发）。
   *
   * 引擎收到后必须只停**当前这一次**合成：立刻放弃等待、清理临时产物，绝不再回退重跑；
   * 常驻 worker 等共享资源不因此杀掉（取舍见 host/tts-engine.ts 的注释）。
   * 不传时行为与改动前完全一致（B94）。
   */
  signal?: AbortSignal
}

/** TTS 引擎端口：路由只要"能合成成 mp3 字节"这一件事 */
export interface TtsEngine {
  synthesize(req: TtsSynthRequest): Promise<Buffer>
  /** 预热：提前把常驻 worker 拉起来（只导入依赖，不合成），首句能省约 1.3 秒 */
  warm?(): Promise<void>
}

/** 数据源类型：本地 data/（默认）或使用者自建的云端文化数据服务（地址由 cloudBase 配置） */
export type DataSourceKind = 'local' | 'cloud'

/** 文化数据类型（对应路由 ?type=chengyu|idiom|minsu） */
export type CultureKind = 'chengyu' | 'idiom' | 'minsu'

/** 说书目录中的一本书（本地只有 book；云端 index 额外带 file/bytes/chapters） */
export interface StoryBookMeta {
  book: string
  file?: string
  author?: string
  bytes?: number
  chapters?: any[]
}

/** 诗词分片：本地只有 1 片（total=1），云端 poems-00..14 共 15 片 */
export interface PoemChunk {
  index: number
  total: number
  items: any[]
}

export interface DuilianItem {
  upper: string
  lower: string
  source?: string
  cat?: string
}

/** 对联数据：本地 {items} 与云端 {cats} 统一成同一结构（cats 也保留，供直接按分类取） */
export interface DuilianData {
  total: number
  items: DuilianItem[]
  cats: Record<string, DuilianItem[]>
  note?: string
}

export interface DailyItem {
  date: string
  type: string
  text: string
  source?: string
}

/**
 * 内容数据端口：说书 / 文化 / 诗词 / 对联 / 每日一句。
 * 路由只依赖这个接口；本地实现（host/data/local.ts）与云端实现（host/data/cloud.ts）
 * 由 index.ts 按配置注入。方法都承诺不把网络/读盘错误抛给路由。
 */
export interface DataPort {
  /** 书单（说书用；顺序即播放顺序） */
  readStoryIndex(): Promise<StoryBookMeta[]>
  /** 读一本书的全部段落（坏文件/超时返回空数组） */
  readStoryBook(book: string): Promise<StoryChunk[]>
  /** 某类文化数据（已按名称去重） */
  readCulture(kind: CultureKind): Promise<any[]>
  /** 诗词第 index 片；本地固定只有 0 片 */
  readPoemsChunk(index: number): Promise<PoemChunk>
  /** 对联库 */
  readDuilian(): Promise<DuilianData>
  /** 每日一句 */
  readDaily(): Promise<DailyItem[]>
  /**
   * 诗名索引（客户端「点诗」识别用，GET /poem-titles）：读不到 / 坏 JSON / 空表一律返回 null，
   * 绝不把异常抛给路由。**可选**：老宿主或测试假端口没有这个能力时，路由退回读包内文件
   * （过渡分支，见 routes/poem-titles.ts 的注释与移除条件）。
   */
  readPoemTitles?(): Promise<{ titles: string[] } | null>
  /**
   * 曲库（GET /melodies、/melody）：交出整份 melodies 数据（路由自己取 songs）。
   * 读不到 / 坏 JSON 返回 null，绝不抛。**可选**：理由同上，仅在端口缺该能力时路由退回读文件。
   */
  readMelodies?(): Promise<any | null>
}

/** 缓存端口（host/cache.ts 实现；get/set 的 ext 与 maxAgeMs 语义见 cache.ts） */
export interface CachePort {
  getJson(key: string, ext?: string, maxAgeMs?: number): Promise<any | null>
  setJson(key: string, value: any, ext?: string, maxAgeMs?: number): Promise<void>
  memGet(key: string): any | undefined
  memSet(key: string, value: any, ttlMs?: number): void
  clear(): Promise<number>
  count(): Promise<number>
}

/** Key 读取器（返回空串表示未配置） */
export type KeyReader = () => string

/** 普通 /chat 的依赖；appendTurns 是记忆写入的唯一入口 */
export interface ChatRouteDeps {
  getKey: KeyReader
  loadHistory: () => any[]
  appendTurns: (userText: string, replyText: string) => any
  loadState: () => any
  saveState: (obj: any) => void
  systemPrompt: string | (() => string)
  addExp?: (n: number, source?: string) => any
  /** 可选第 3 参：一次用量的输入/输出拆分与本次人民币估算（鱼账本 2026-11-07）；老调用方只传两个参数 */
  addTokens?: (kind: string, n: number, detail?: { promptTokens?: number; completionTokens?: number; cacheHitTokens?: number; costCny?: number }) => any
  cache?: CachePort
  loadMemorySummary?: () => string
  saveMemorySummary?: (s: string) => void
  cacheEnabled?: () => boolean
  /** 聊天模型名：index.ts 装配时由 readChatModel 算一次注入；缺省回落到配置模块的默认值 */
  model?: string
  /** 模型真实成功回复后回调（L2 可变人格计数用）；不 await、不阻塞回复 */
  onReply?: () => void
  /**
   * 建提醒（2026-11-07 B106）：主人说「十分钟后提醒我吃早餐」这类话时，
   * 聊天路由会把解析出的任务写进提醒仓储。缺省（老调用方/离线测试）＝不建，行为与以前一致。
   */
  addReminder?: (text: string, at: string, repeat?: number) => any
}

/** 流式 /chat-stream 的依赖（与普通 /chat 同口径：亲密度/成长/长期摘要都记） */
export interface ChatStreamRouteDeps {
  getKey: KeyReader
  loadHistory: () => any[]
  appendTurns?: (userText: string, replyText: string) => any
  systemPrompt: string | (() => string)
  /** 可选第 3 参：一次用量的输入/输出拆分与本次人民币估算（鱼账本 2026-11-07）；老调用方只传两个参数 */
  addTokens?: (kind: string, n: number, detail?: { promptTokens?: number; completionTokens?: number; cacheHitTokens?: number; costCny?: number }) => any
  cache?: CachePort
  loadMemorySummary?: () => string
  cacheEnabled?: () => boolean
  /** 聊天模型名：与普通 /chat 共用同一个装配值（缓存 key 也带它） */
  model?: string
  /** 建提醒：与 /chat 同口径（见 ChatRouteDeps.addReminder 注释） */
  addReminder?: (text: string, at: string, repeat?: number) => any
  /** 模型真实成功回复后回调（L2 可变人格计数用）；不 await、不阻塞流 */
  onReply?: () => void
  /** 亲密度/成长/长期摘要：与普通 /chat 同口径（2026-11-06 补齐，客户端优先走流式） */
  loadState?: () => any
  saveState?: (s: any) => void
  addExp?: (n: number, kind: string) => any
  saveMemorySummary?: (s: string) => void
}

/**
 * /tts 的依赖：合成引擎**必须**由装配层构造并注入（路由内不自建，否则拿不到 dispose 句柄），
 * 缓存走缓存端口。
 * 注：原 `voice?: string` 字段是死字段（声明后全仓无人读取），B93 已删。
 */
export interface TtsRouteDeps {
  cache?: CachePort
  engine: TtsEngine
  /**
   * 云端 TTS（火山豆包语音）：有 Key 时优先，失败由路由回退 engine（edge-tts）。
   * synthesize 的第 2 个参数是可选中止信号：实现侧会与自己的 15s 超时合并（AbortSignal.any），
   * 客户端走了就不再等云端（B94）。
   */
  cloudTts?: { synthesize: (text: string, signal?: AbortSignal) => Promise<Buffer>; enabled: () => boolean }
}

/** /asr 的依赖：只要求能拿到硅基流动 Key */
export interface AsrRouteDeps {
  getKey: KeyReader
  cache?: CachePort
  /** 识别语言（zh/en/auto）；缺省 zh。配置键 asrLanguage，2026-11-07 起真正生效 */
  language?: () => string
}
