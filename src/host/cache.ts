/**
 * host/cache.ts —— 通用缓存（内存 + 文件，可复用）
 * 用于：TTS 音频、聊天回复、ASR 识别结果（按内容 hash 缓存，省 token/时间）
 * 内存：条目数 + 总字节双上限，LRU 淘汰（音频 Buffer 很占内存，必须限总量）
 * 磁盘：超过 MAX_FILES 时按 mtime 删最旧的一半（不读文件内容）
 * 过期：内存条目记写入时间 at（+ 可选 ttl），getJson 带 maxAgeMs 时内存命中也校验，不再让旧值顶掉 TTL
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, readdir, unlink, stat, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { CachePort } from './ports.js'

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

function sizeOf(value: any): number {
  if (value == null) return 0
  if (Buffer.isBuffer(value)) return value.length
  if (value instanceof Uint8Array) return value.byteLength
  if (typeof value === 'string') return Buffer.byteLength(value)
  try { return Buffer.byteLength(JSON.stringify(value) || '') } catch { return 64 }
}

export function createCache(opts: { dir: string; memLimit?: number; memBytes?: number; maxFiles?: number }): CachePort {
  const mem = new Map<string, { v: any; size: number; at: number; ttl: number }>()
  const MEM_ITEMS = opts.memLimit || 500
  const MEM_BYTES = opts.memBytes || 32 * 1024 * 1024   // 内存里最多放 32MB
  const MAX_FILES = opts.maxFiles || 1200
  let memBytes = 0
  let ensured = false

  async function ensure(): Promise<void> {
    if (ensured) return
    try { await mkdir(opts.dir, { recursive: true }); ensured = true } catch { }
  }

  /** 从内存拿掉一条（同步扣减字节计数，避免计数漂移） */
  function forget(key: string): void {
    const hit = mem.get(key)
    if (hit) { memBytes -= hit.size; mem.delete(key) }
  }

  function remember(key: string, value: any, ttlMs = 0): void {
    const size = sizeOf(value)
    forget(key)                                        // 先清旧条目：超大值也不能把旧值留在内存里
    if (size > MEM_BYTES) return                       // 单个对象就超上限：不驻留内存
    mem.set(key, { v: value, size, at: Date.now(), ttl: ttlMs > 0 ? ttlMs : 0 })
    memBytes += size
    while (mem.size > MEM_ITEMS || memBytes > MEM_BYTES) {
      const oldest = mem.keys().next().value as string | undefined
      if (oldest === undefined) break
      const it = mem.get(oldest)
      if (it) memBytes -= it.size
      mem.delete(oldest)
    }
  }

  /** 内存条目是否还新鲜：带 ttl 的按写入时间算，没 ttl 的永不过期 */
  function fresh(hit: { at: number; ttl: number }, maxAgeMs: number): boolean {
    const ttl = maxAgeMs > 0 ? maxAgeMs : hit.ttl
    return ttl <= 0 || Date.now() - hit.at <= ttl
  }

  function memGet(key: string): any | undefined {
    const hit = mem.get(key)
    if (!hit) return undefined
    if (!fresh(hit, 0)) { forget(key); return undefined }
    // 命中后挪到队尾（LRU）
    mem.delete(key)
    mem.set(key, hit)
    return hit.v
  }

  /**
   * 读缓存。maxAgeMs > 0 时按 mtime / 内存写入时间判断过期（ASR 与聊天缓存用 7 天）。
   * 注意：内存命中也必须校验过期，否则文件早就过期了内存里还一直往回给。
   */
  async function getJson(key: string, ext = 'json', maxAgeMs = 0): Promise<any | null> {
    const hit = mem.get(key)
    if (hit) {
      let alive = fresh(hit, maxAgeMs)
      if (alive && maxAgeMs > 0) {
        // 要 TTL 时再用磁盘 mtime 复核一次：文件可能被外部删掉/回拨，不能只信内存里的 at
        try {
          const st = await stat(join(opts.dir, key + '.' + ext))
          alive = Date.now() - st.mtimeMs <= maxAgeMs
        } catch { alive = false }
      }
      if (alive) {
        mem.delete(key)
        mem.set(key, hit)                    // 命中后挪到队尾（LRU）
        return hit.v
      }
      forget(key)
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

  async function setJson(key: string, value: any, ext = 'json', maxAgeMs = 0): Promise<void> {
    remember(key, value, maxAgeMs)
    try {
      await ensure()
      // 原子写：先写唯一临时文件再 rename 覆盖（并发同 key 不会交错产出坏文件）
      const target = join(opts.dir, key + '.' + ext)
      const tmp = target + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp'
      if (ext === 'json') await writeFile(tmp, JSON.stringify(value), 'utf8')
      else await writeFile(tmp, value)
      try { await rename(tmp, target) } catch (e) { try { await unlink(tmp) } catch { } ; throw e }
      await prune()
    } catch { }
  }

  /** 文件太多时按 mtime 删最旧的一半；只 stat，不读内容 */
  /** prune 节流：每次写都全量 readdir+stat 会把磁盘扫描串进回复延迟，30 秒最多扫一次 */
  let lastPruneAt = 0
  async function prune(): Promise<void> {
    try {
      const nowMs = Date.now()
      if (nowMs - lastPruneAt < 30000) return
      lastPruneAt = nowMs
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
      const gone = new Set<string>()                     // 同名不同扩展名只扣一次内存
      for (const it of toDelete) {
        try { await unlink(join(opts.dir, it.f)) } catch { }
        // 内存 key 不带扩展名：按「文件名去掉扩展名」精确删，forget 内部判存在才会扣 memBytes
        const k = it.f.replace(/\.[^.]+$/, '')
        if (!k || gone.has(k)) continue
        gone.add(k)
        forget(k)
      }
    } catch { }
  }

  // 内存直写：和 setJson 一样经 remember 打 at（可选 ttl），过期判定不会拿到没有时间的条目
  function memSet(key: string, value: any, ttlMs = 0): void { remember(key, value, ttlMs) }

  /** 清空缓存（内存 + 磁盘文件）；用于「清空聊天缓存」「清除记忆」 */
  async function clear(): Promise<number> {
    let n = 0
    try { mem.clear(); memBytes = 0 } catch { }
    try {
      await ensure()
      const files = await readdir(opts.dir)
      for (const f of files) { try { await unlink(join(opts.dir, f)); n++ } catch { } }
    } catch { }
    return n
  }

  /** 统计当前磁盘缓存条目数（给菜单/状态用） */
  async function count(): Promise<number> {
    try { return (await readdir(opts.dir)).length } catch { return 0 }
  }
  return { getJson, setJson, memGet, memSet, clear, count }
}
