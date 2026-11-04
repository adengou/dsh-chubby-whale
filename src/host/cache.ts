/**
 * host/cache.ts —— 通用缓存（内存 + 文件，可复用）
 * 用于：TTS 音频、聊天回复、ASR 识别结果（按内容 hash 缓存，省 token/时间）
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export function hashKey(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

export function createCache(opts: { dir: string; memLimit?: number; maxFiles?: number }) {
  const mem = new Map<string, any>()
  const MEM_LIMIT = opts.memLimit || 300
  const MAX_FILES = opts.maxFiles || 800
  let ensured = false

  async function ensure(): Promise<void> {
    if (ensured) return
    try { await mkdir(opts.dir, { recursive: true }); ensured = true } catch { }
  }

  async function getJson(key: string, ext = 'json'): Promise<any | null> {
    const hit = mem.get(key)
    if (hit !== undefined) return hit
    try {
      const buf = await readFile(join(opts.dir, key + '.' + ext))
      const val = ext === 'json' ? JSON.parse(buf.toString('utf8')) : buf
      if (mem.size < MEM_LIMIT) mem.set(key, val)
      return val
    } catch { return null }
  }

  async function setJson(key: string, value: any, ext = 'json'): Promise<void> {
    if (mem.size < MEM_LIMIT) mem.set(key, value)
    try {
      await ensure()
      if (ext === 'json') await writeFile(join(opts.dir, key + '.' + ext), JSON.stringify(value), 'utf8')
      else await writeFile(join(opts.dir, key + '.' + ext), value)
      await prune()
    } catch { }
  }

  async function prune(): Promise<void> {
    try {
      const files = await readdir(opts.dir)
      if (files.length <= MAX_FILES) return
      const withTime = [] as any[]
      for (const f of files) {
        try {
          const st = await readFile(join(opts.dir, f)) // 触发存在性
          withTime.push({ f, t: Date.now() })
        } catch { }
      }
      // 简化：按文件名前缀时间？—— 直接删最旧的一半（尽力）
      const toDelete = files.slice(0, Math.floor(files.length / 2))
      for (const f of toDelete) { try { await unlink(join(opts.dir, f)) } catch { } }
    } catch { }
  }

  function memGet(key: string): any | undefined { return mem.get(key) }
  function memSet(key: string, value: any): void { if (mem.size < MEM_LIMIT) mem.set(key, value) }

  return { getJson, setJson, memGet, memSet }
}
