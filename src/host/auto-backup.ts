/**
 * host/auto-backup.ts —— 运行数据自动定时备份（2026-11-06 新增）
 *
 * 为什么：memory / personality / state / growth 这些是主人积累的"鱼的数据"，
 * 手动导出容易忘；这里每小时自动留一份快照，保留最近 N 份（默认 7）。
 *
 * 口径：
 *   · 只读运行数据文件、写到 RUNTIME_DIR/backup/ 目录（不进插件包、不碰 data/）；
 *   · 一份备份 = 一个 JSON（{ at, files: { 文件名: 内容 } }），失败静默（绝不因备份失败影响插件）；
 *   · 保留策略按文件名（auto-时间戳）排序删旧，最多 keep 份；
 *   · setInterval 加 unref（不拖住进程退出）；启动时先备一份，之后每小时一次。
 *
 * 兼容：宿主侧改动要重启 dsh web 才生效；备份目录只增不减（除旧份）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 需要备份的运行数据文件（都在 RUNTIME_DIR 根下） */
export const AUTO_BACKUP_FILES = [
  'memory.json',
  'personality.json',
  'state.json',
  'growth.json',
  'fishfood.json',
  'reminders.json',
  'story_progress.json',
  'pet_state.json',
  'prefs.json',
] as const

export type AutoBackupOpts = {
  /** 运行数据目录（~/.dsh-chubby-whale） */
  runtimeDir: string
  /** 备份间隔（毫秒），缺省 1 小时 */
  intervalMs?: number
  /** 保留份数，缺省 7 */
  keep?: number
  /** 现在（测试注入） */
  now?: () => number
}

/** 备份目录名 */
export const AUTO_BACKUP_DIR = 'backup'

/** 时间戳 → auto-YYYYMMDD-HHmmss（文件名安全，无冒号） */
function stamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => (n < 10 ? '0' + n : String(n))
  return 'auto-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
}

/** 立即备份一次，返回是否写成功（失败静默，不抛） */
export function backupOnce(opts: AutoBackupOpts): boolean {
  try {
    const dir = join(opts.runtimeDir, AUTO_BACKUP_DIR)
    try { mkdirSync(dir, { recursive: true }) } catch { }
    const files: Record<string, string> = {}
    let any = false
    for (const name of AUTO_BACKUP_FILES) {
      try {
        const p = join(opts.runtimeDir, name)
        if (!existsSync(p)) continue
        files[name] = readFileSync(p, 'utf8')
        any = true
      } catch { }
    }
    if (!any) return false
    const nowMs = (opts.now || (() => Date.now()))()
    const out = join(dir, stamp(nowMs) + '.json')
    // 同一秒内重复备份：覆盖同名文件即可（幂等）
    writeFileSync(out, JSON.stringify({ at: nowMs, files }), 'utf8')
    // 保留最近 keep 份（按文件名排序 = 时间顺序）
    const keep = Math.max(1, Number(opts.keep) || 7)
    let list: string[] = []
    try {
      list = readdirSync(dir).filter((f) => /^auto-.*\.json$/.test(f)).sort()
    } catch { }
    while (list.length > keep) {
      const old = list.shift()
      if (!old) break
      try { rmSync(join(dir, old), { force: true }) } catch { }
    }
    return true
  } catch {
    return false
  }
}

/** 备份目录的现状（最近时间与份数；诊断面板用） */
export function autoBackupInfo(runtimeDir: string): { lastAt: number; count: number } {
  try {
    const dir = join(runtimeDir, AUTO_BACKUP_DIR)
    if (!existsSync(dir)) return { lastAt: 0, count: 0 }
    const list = readdirSync(dir).filter((f) => /^auto-.*\.json$/.test(f))
    let lastAt = 0
    for (const f of list) {
      try { const st = statSync(join(dir, f)); if (st.mtimeMs > lastAt) lastAt = st.mtimeMs } catch { }
    }
    return { lastAt, count: list.length }
  } catch {
    return { lastAt: 0, count: 0 }
  }
}

/**
 * 启动自动备份：立即备一份，之后每 intervalMs 一份。
 * 返回停止函数（插件 dispose 时调用，别让定时器挂着）。
 * 定时器 unref：不拖住宿主进程退出。
 */
export function startAutoBackup(opts: AutoBackupOpts): () => void {
  const intervalMs = Math.max(60_000, Number(opts.intervalMs) || 3600_000)
  try { backupOnce(opts) } catch { }
  const timer: any = setInterval(() => { try { backupOnce(opts) } catch { } }, intervalMs)
  try { if (typeof timer.unref === 'function') timer.unref() } catch { }
  return () => { try { clearInterval(timer) } catch { } }
}
