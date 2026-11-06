/**
 * shared/hash.ts —— 纯 hash 工具（host / client / routes 共用）
 *
 * 为什么从 host/cache.ts 搬出来（2026-11-07）：`routes/asr.ts`、`routes/tts.ts` 只需要
 * `hashBytes`/`hashKey` 这两个**纯函数**，却因此直接 import 了缓存实现，违反 ADR 0002
 * 「路由只经端口依赖能力」。把 hash 放到 shared 后：
 *   · 路由 import shared/hash.js —— 合法（shared 是公共层）；
 *   · host/cache.ts 继续 re-export 同名函数，旧导入路径不受影响。
 *
 * 纯函数、无 I/O、无平台分支：Node 与浏览器（只要 bundler 提供 node:crypto polyfill）都可用。
 * 客户端目前不用它；留在 shared 是为了以后客户端要「内容指纹」时不至于再抄一份。
 */
import { createHash } from 'node:crypto'

/** 内容 sha1（十六进制，40 字符）：缓存 key 用 */
export function hashKey(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

/** 短指纹（md5 前 8 位）：拼缓存 key 用（如长期记忆摘要的指纹） */
export function shortHash(text: string): string {
  return createHash('md5').update(String(text || '')).digest('hex').slice(0, 8)
}

/** 二进制内容 hash（ASR 音频用完整字节，避免只取前 4000 字符撞 key） */
export function hashBytes(buf: Uint8Array | Buffer): string {
  return createHash('sha1').update(buf).digest('hex')
}
