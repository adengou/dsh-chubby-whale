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
  const from = layerOf(file)
  // 跨行匹配 import/export ... from '...'（坑 40：多行 import 曾可绕过单行正则）
  const re = /(?:^|\n)[ \t]*(?:import|export)\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(text))) {
    const spec = m[1]
    const lineNo = text.slice(0, m.index).split('\n').length
    const at = rel + ':' + lineNo
    // 1) dist / 绝对路径
    if (/^[A-Za-z]:[\\/]/.test(spec) || spec.includes('/dist/') || spec.startsWith('file:')) {
      problems.push(at + ' 禁止引用构建产物或绝对路径: ' + spec)
      continue
    }
    if (!spec.startsWith('.')) continue // 包名
    // 2) 解析目标层
    let target = null
    if (spec.includes('/client/') || spec.endsWith('/client.js')) target = 'client'
    else if (spec.includes('/host/') || spec.endsWith('/host.js')) target = 'host'
    else if (spec.includes('/shared/')) target = 'shared'
    if (!target) continue
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
    // 规则 A：host 路由不得绕过 ports 直连仓储/store/cache/chat-core/prefs
    if (rel.includes('/host/routes/')) {
      if (/^\.\.\/(repos|store\.js|cache\.js|chat-core\.js|prefs\.js)/.test(spec)) {
        problems.push(at + ' 路由越界：应经 ports 注入，不得直连内部模块（' + spec + '）')
      }
    }
    // 规则 B：client 子模块不得反向 import 组件入口 client.ts
    if (rel.startsWith('src/client/') && spec === '../client.js') {
      problems.push(at + ' 循环风险：client 子模块不得 import 组件入口 client.ts（' + spec + '）')
    }
  }
}

walk(SRC)
if (problems.length === 0) {
  console.log('模块边界检查：0 违规 ✅')
  process.exit(0)
}
console.log('模块边界检查：' + problems.length + ' 处违规 ❌')
for (const p of problems) console.log('  ' + p)
process.exit(1)