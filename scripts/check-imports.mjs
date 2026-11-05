/**
 * scripts/check-imports.mjs —— 模块边界检查（架构宪章 铁律）
 * 只读扫描 src/**，检查：反向依赖、跨模块深引用、dist/绝对路径引用。
 * 违规即退出码 1；输出 文件:行 → 违规说明。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname || new URL('.', import.meta.url).pathname, '..')
const SRC = path.join(ROOT, 'src')
const problems = []

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.isFile() && p.endsWith('.ts')) check(p)
  }
}

function layerOf(p) {
  const rel = path.relative(SRC, p).replace(/\\/g, '/')
  if (rel.startsWith('client/')) return 'client'
  if (rel.startsWith('host/')) return 'host'
  if (rel.startsWith('shared/')) return 'shared'
  if (rel === 'client.ts') return 'client-root'
  if (rel === 'index.ts') return 'host-root'
  if (rel === 'story-worker.ts') return 'host-root'
  return 'other'
}

function check(file) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  const from = layerOf(file)
  lines.forEach((line, i) => {
    const m = line.match(/(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/)
    if (!m) return
    const spec = m[1]
    const at = rel + ':' + (i + 1)
    // 1) dist / 绝对路径
    if (/^[A-Za-z]:[\\/]/.test(spec) || spec.includes('/dist/') || spec.startsWith('file:')) {
      problems.push(at + ' 禁止引用构建产物或绝对路径: ' + spec)
      return
    }
    if (!spec.startsWith('.')) return // 包名，交给 dependency 检查
    // 2) 解析目标层
    let target = null
    if (spec.includes('/client/') || spec.endsWith('/client.js')) target = 'client'
    else if (spec.includes('/host/') || spec.endsWith('/host.js')) target = 'host'
    else if (spec.includes('/shared/')) target = 'shared'
    if (!target) return
    // 3) 反向依赖
    if (from === 'host' || from === 'host-root') {
      if (target === 'client') problems.push(at + ' 反向依赖：host 不得引用 client（' + spec + '）')
    }
    if (from === 'shared') {
      if (target === 'client' || target === 'host') problems.push(at + ' 反向依赖：shared 不得引用 ' + target + '（' + spec + '）')
    }
    if (from === 'client' || from === 'client-root') {
      if (target === 'host') problems.push(at + ' 反向依赖：client 不得引用 host（' + spec + '）')
    }
  })
}

walk(SRC)
if (problems.length === 0) {
  console.log('模块边界检查：0 违规 ✅')
  process.exit(0)
}
console.log('模块边界检查：' + problems.length + ' 处违规 ❌')
for (const p of problems) console.log('  ' + p)
process.exit(1)