/**
 * scripts/clean-dist.mjs —— 构建前清空 dist（跨平台、无 shell）
 *
 * 为什么需要：dist 是入库产物，历史上删过 src 模块但漏删 dist，
 * 导致 npm 包夹带 src 已不存在的旧代码。build 前全量清空，保证
 * dist 只由当前 src 重新生成。
 *
 * 只删仓库根下的 dist；不做任何其他路径操作。
 */

import { rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = resolve(root, 'dist')
if (target !== resolve(root, 'dist')) {
  throw new Error('clean-dist: 目标不是仓库根下的 dist：' + target)
}
rmSync(target, { recursive: true, force: true })
console.log('🧹 clean-dist: 已清空 ' + target)
