/**
 * host/ports.ts —— 路由依赖的窄接口（端口）
 *
 * 目的：路由只声明"我需要什么能力"，不依赖 store / cache / 具体实现的类型；
 * index.ts 负责把真实实现注进来，测试可注入内存假实现。
 * 每个接口只覆盖一个路由用到的字段，不追求把整个 store 塞进来。
 */
import type { TtsEngine } from './tts-engine.js'
import type { StoryChunk } from './story/repo.js'

/** 数据源类型：本地 data/（默认）或云端 adengou.cn/culture/v1/ */
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
  addTokens?: (kind: string, n: number) => any
  cache?: CachePort
  loadMemorySummary?: () => string
  saveMemorySummary?: (s: string) => void
  cacheEnabled?: () => boolean
  /** 模型真实成功回复后回调（L2 可变人格计数用）；不 await、不阻塞回复 */
  onReply?: () => void
}

/** 流式 /chat-stream 的依赖（不写亲密度/成长，只记 token 与记忆） */
export interface ChatStreamRouteDeps {
  getKey: KeyReader
  loadHistory: () => any[]
  appendTurns?: (userText: string, replyText: string) => any
  systemPrompt: string | (() => string)
  addTokens?: (kind: string, n: number) => any
  cache?: CachePort
  loadMemorySummary?: () => string
  cacheEnabled?: () => boolean
  /** 模型真实成功回复后回调（L2 可变人格计数用）；不 await、不阻塞流 */
  onReply?: () => void
}

/** /tts 的依赖：合成引擎可替换，缓存走缓存端口 */
export interface TtsRouteDeps {
  voice?: string
  cache?: CachePort
  engine?: TtsEngine
}

/** /asr 的依赖：只要求能拿到硅基流动 Key */
export interface AsrRouteDeps {
  getKey: KeyReader
  cache?: CachePort
}
