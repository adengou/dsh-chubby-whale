/**
 * host/migrate.ts —— 运行数据迁移（插件 data/ → 运行时目录）
 *
 * 只在目标不存在时拷贝，绝不覆盖用户现有数据；失败静默（环境差异）。
 * 从 index.ts 抽出：架构宪章要求 index 只做组装。
 */
import { existsSync, mkdirSync, copyFileSync, cpSync } from 'node:fs'
import { join } from 'node:path'

export function migrateRuntimeData(dataDir: string, runtimeDir: string): void {
  const files = [
    'memory.json', 'state.json', 'growth.json', 'fishfood.json', 'reminders.json',
    'story_progress.json', 'culture-seen.json', 'poem-seen.json', 'pet_state.json',
  ]
  try { mkdirSync(runtimeDir, { recursive: true }) } catch { }
  for (const f of files) {
    const src = join(dataDir, f)
    const dst = join(runtimeDir, f)
    try {
      if (existsSync(src) && !existsSync(dst)) {
        copyFileSync(src, dst)
        console.log('[chubby-whale] 迁移运行数据 ' + f + ' → ' + runtimeDir)
      }
    } catch { }
  }
  // 缓存目录整目录搬迁（只在目标不存在时）
  try {
    const src = join(dataDir, 'cache')
    const dst = join(runtimeDir, 'cache')
    if (existsSync(src) && !existsSync(dst)) {
      cpSync(src, dst, { recursive: true })
      console.log('[chubby-whale] 迁移缓存 → ' + dst)
    }
  } catch { }
}
