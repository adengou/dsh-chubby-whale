/**
 * host/ports.ts —— 路由依赖的窄接口（端口）
 *
 * 目的：路由只声明"我需要什么能力"，不依赖 store / cache / 具体实现的类型；
 * index.ts 负责把真实实现注进来，测试可注入内存假实现。
 * 每个接口只覆盖一个路由用到的字段，不追求把整个 store 塞进来。
 */
import type { TtsEngine } from './tts-engine.js'

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
  systemPrompt: string
  addExp?: (n: number, source?: string) => any
  addTokens?: (kind: string, n: number) => any
  cache?: CachePort
  loadMemorySummary?: () => string
  saveMemorySummary?: (s: string) => void
  cacheEnabled?: () => boolean
}

/** 流式 /chat-stream 的依赖（不写亲密度/成长，只记 token 与记忆） */
export interface ChatStreamRouteDeps {
  getKey: KeyReader
  loadHistory: () => any[]
  appendTurns?: (userText: string, replyText: string) => any
  systemPrompt: string
  addTokens?: (kind: string, n: number) => any
  cache?: CachePort
  loadMemorySummary?: () => string
  cacheEnabled?: () => boolean
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
