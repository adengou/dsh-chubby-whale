/**
 * host/cache.ts —— 通用缓存（内存 + 文件，可复用）
 * 用于：TTS 音频、聊天回复、ASR 识别结果（按内容 hash 缓存，省 token/时间）
 * 内存：条目数 + 总字节双上限，LRU 淘汰（音频 Buffer 很占内存，必须限总量）
 * 磁盘：超过 MAX_FILES 时按 mtime 删最旧的一半（不读文件内容）
 * 过期：内存条目记写入时间 at（+ 可选 ttl），getJson 带 maxAgeMs 时内存命中也校验，不再让旧值顶掉 TTL
 *
 * 跨平台：
 *   · 写入走「唯一临时文件 + rename」，与 host/atomic.ts 同一套语义；rename 遇 Windows
 *     偶发 EPERM / EACCES / EBUSY 时重试 3 次（间隔 20ms），最终失败清临时文件并记日志。
 *   · POSIX 下缓存目录 0700、文件 0600（默认创建权限靠 mode 选项，Windows 忽略 mode）。
 *   · 读 JSON 容错 UTF-8 BOM；写出一律 UTF-8 无 BOM。
 *   · TTL / prune 用 stat().mtimeMs 判断新旧：NTFS / ext4 / APFS 精度足够；
 *     FAT / exFAT 只有 2 秒精度，会出现「刚写就被判过期/排序并列」的偶发现象，属已知限制，
 *     只影响缓存命中率，不影响正确性（宁可重算，不返回错内容）。
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, readdir, unlink, stat, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { CachePort } from './ports.js'
import { isRetriableRenameError, chmodPrivateDir, stripBom } from './atomic.js'

/** 磁盘 rename 失败后的重试次数（不含首次）与间隔；与 host/atomic.ts 保持一致 */
const RENAME_RETRY_LIMIT = 3
const RENAME_RETRY_DELAY_MS = 20
/** prune 节流窗口：每次写都全量 readdir+stat 会把磁盘扫描串进回复延迟 */
const PRUNE_INTERVAL_MS = 30000

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

/** 等待 ms 毫秒（异步重试用；不要为 20ms 阻塞同进程的其它请求） */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
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
    try { await mkdir(opts.dir, { recursive: true, mode: 0o700 }); ensured = true } catch { }
    chmodPrivateDir(opts.dir)          // POSIX 收紧到 0700；Windows 跳过
  }

  /** rename 带重试：Windows 上目标文件被占用时偶发 EPERM/EBUSY，重试几次通常就过去了 */
  async function renameWithRetry(tmp: string, target: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, target)
        return
      } catch (err: any) {
        if (attempt >= RENAME_RETRY_LIMIT || !isRetriableRenameError(err)) throw err
        await delay(RENAME_RETRY_DELAY_MS)
      }
    }
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

  /**
   * 命中返回前统一做一份拷贝：
   * 直接把内部对象递出去，调用方一改就污染缓存（同一 key 下次拿到被改过的值）。
   * Buffer 要特判 —— structuredClone 会把 Buffer 变成 Uint8Array，TTS 会因此播不出声。
   */
  function cloneHit(v: any): any {
    if (v == null || typeof v !== 'object') return v
    if (Buffer.isBuffer(v)) return Buffer.from(v)
    try { return structuredClone(v) } catch { return v }
  }

  function memGet(key: string): any | undefined {
    const hit = mem.get(key)
    if (!hit) return undefined
    if (!fresh(hit, 0)) { forget(key); return undefined }
    // 命中后挪到队尾（LRU）
    mem.delete(key)
    mem.set(key, hit)
    return cloneHit(hit.v)
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
        return cloneHit(hit.v)
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
      // 剥 BOM：缓存文件正常不带，但外部工具改写过时要容错（否则整条缓存静默失效）
      const val = ext === 'json' ? JSON.parse(stripBom(buf.toString('utf8'))) : buf
      remember(key, val)
      return cloneHit(val)
    } catch { return null }
  }

  async function setJson(key: string, value: any, ext = 'json', maxAgeMs = 0): Promise<void> {
    // 存入时也拷贝一份：调用方之后改自己那份，不该影响缓存内容
    remember(key, cloneHit(value), maxAgeMs)
    try {
      await ensure()
      // 原子写：先写唯一临时文件再 rename 覆盖（并发同 key 不会交错产出坏文件）
      const target = join(opts.dir, key + '.' + ext)
      const tmp = target + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp'
      // POSIX：创建即 0600；Windows 忽略 mode。写出统一 UTF-8 无 BOM
      if (ext === 'json') await writeFile(tmp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 })
      else await writeFile(tmp, value, { mode: 0o600 })
      try {
        await renameWithRetry(tmp, target)
      } catch (e) {
        try { await unlink(tmp) } catch { }   // 改名失败别留垃圾
        throw e
      }
      await prune()
    } catch (err: any) {
      // 缓存写失败不能静默：磁盘满/权限问题只留内存状态，事后根本查不出来
      console.error('[cache] WRITE-FAIL key=' + key + ' err=' + String(err?.message || err))
    }
  }

  /**
   * 文件太多时按 mtime 删最旧的一半；只 stat，不读内容。
   * 容错：单个文件 stat 失败（被并发删除/权限变化/句柄占用）只跳过这一条，不中断整轮。
   * 并发：prune 是异步的，两个写请求同时触发时用 pruning 标志保证同一时刻只跑一轮。
   * mtime 可靠性：NTFS / ext4 / APFS 的 mtimeMs 足够；FAT / exFAT 只有 2 秒精度，
   * 同一秒内写入的多个文件排序可能并列，删除顺序不必完全精确（只删最旧的一半，不删新条目）。
   */
  let lastPruneAt = 0
  let pruning = false
  async function prune(): Promise<void> {
    if (pruning) return
    try {
      const nowMs = Date.now()
      if (nowMs - lastPruneAt < PRUNE_INTERVAL_MS) return
      lastPruneAt = nowMs
      pruning = true
      const files = await readdir(opts.dir)
      if (files.length <= MAX_FILES) return
      const entries: { f: string; t: number }[] = []
      for (const f of files) {
        try {
          const st = await stat(join(opts.dir, f))
          if (!st.isFile()) continue
          // mtimeMs 异常（NaN）时排到最末，宁可少删也不误删
          entries.push({ f, t: Number.isFinite(st.mtimeMs) ? st.mtimeMs : Number.MAX_SAFE_INTEGER })
        } catch { }                                        // 单个文件 stat 失败：跳过，继续整轮
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
    } catch {
      // readdir 失败（目录被删/权限）：本轮放弃，下个窗口再试；不阻塞写盘
    } finally {
      pruning = false
    }
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
