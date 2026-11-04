/**
 * host/cache.ts —— 通用缓存（内存 + 文件，可复用）
 * 用于：TTS 音频、聊天回复、ASR 识别结果（按内容 hash 缓存，省 token/时间）
 * 内存：条目数 + 总字节双上限，LRU 淘汰（音频 Buffer 很占内存，必须限总量）
 * 磁盘：超过 MAX_FILES 时按 mtime 删最旧的一半（不读文件内容）
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, readdir, unlink, stat } from 'node:fs/promises'
import { join } from 'node:path'

export function hashKey(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

/** 二进制内容 hash（ASR 音频用完整字节，避免只取前 4000 字符撞 key） */
export function hashBytes(buf: Uint8Array | Buffer): string {
  return createHash('sha1').update(buf).digest('hex')
}

function sizeOf(value: any): number {
  if (value == null) return 0
  if (Buffer.isBuffer(value)) return value.length
  if (value instanceof Uint8Array) return value.byteLength
  if (typeof value === 'string') return Buffer.byteLength(value)
  try { return Buffer.byteLength(JSON.stringify(value) || '') } catch { return 64 }
}

export function createCache(opts: { dir: string; memLimit?: number; memBytes?: number; maxFiles?: number }) {
  const mem = new Map<string, { v: any; size: number }>()
  const MEM_ITEMS = opts.memLimit || 500
  const MEM_BYTES = opts.memBytes || 32 * 1024 * 1024   // 内存里最多放 32MB
  const MAX_FILES = opts.maxFiles || 800
  let memBytes = 0
  let ensured = false

  async function ensure(): Promise<void> {
    if (ensured) return
    try { await mkdir(opts.dir, { recursive: true }); ensured = true } catch { }
  }

  function remember(key: string, value: any): void {
    const size = sizeOf(value)
    if (size > MEM_BYTES) return                       // 单个对象就超上限：不驻留内存
    const old = mem.get(key)
    if (old) { memBytes -= old.size; mem.delete(key) }
    mem.set(key, { v: value, size })
    memBytes += size
    while (mem.size > MEM_ITEMS || memBytes > MEM_BYTES) {
      const oldest = mem.keys().next().value as string | undefined
      if (oldest === undefined) break
      const it = mem.get(oldest)
      if (it) memBytes -= it.size
      mem.delete(oldest)
    }
  }

  function memGet(key: string): any | undefined {
    const hit = mem.get(key)
    if (!hit) return undefined
    // 命中后挪到队尾（LRU）
    mem.delete(key)
    mem.set(key, hit)
    return hit.v
  }

  /**
   * 读缓存。maxAgeMs > 0 时按文件 mtime 判断过期（ASR 用 7 天）。
   */
  async function getJson(key: string, ext = 'json', maxAgeMs = 0): Promise<any | null> {
    const hit = mem.get(key)
    if (hit) {
      mem.delete(key)
      mem.set(key, hit)
      return hit.v
    }
    try {
      const file = join(opts.dir, key + '.' + ext)
      if (maxAgeMs > 0) {
        try {
          const st = await stat(file)
          if (Date.now() - st.mtimeMs > maxAgeMs) return null
        } catch { return null }
      }
      const buf = await readFile(file)
      const val = ext === 'json' ? JSON.parse(buf.toString('utf8')) : buf
      remember(key, val)
      return val
    } catch { return null }
  }

  async function setJson(key: string, value: any, ext = 'json'): Promise<void> {
    remember(key, value)
    try {
      await ensure()
      if (ext === 'json') await writeFile(join(opts.dir, key + '.' + ext), JSON.stringify(value), 'utf8')
      else await writeFile(join(opts.dir, key + '.' + ext), value)
      await prune()
    } catch { }
  }

  /** 文件太多时按 mtime 删最旧的一半；只 stat，不读内容 */
  async function prune(): Promise<void> {
    try {
      const files = await readdir(opts.dir)
      if (files.length <= MAX_FILES) return
      const entries: { f: string; t: number }[] = []
      for (const f of files) {
        try {
          const st = await stat(join(opts.dir, f))
          if (st.isFile()) entries.push({ f, t: st.mtimeMs })
        } catch { }
      }
      entries.sort((a, b) => a.t - b.t)
      const toDelete = entries.slice(0, Math.floor(entries.length / 2))
      for (const it of toDelete) {
        try { await unlink(join(opts.dir, it.f)) } catch { }
        try { mem.delete(it.f.replace(/\.[^.]+$/, '')) } catch { }
      }
    } catch { }
  }

  function memSet(key: string, value: any): void { remember(key, value) }

  return { getJson, setJson, memGet, memSet }
}
