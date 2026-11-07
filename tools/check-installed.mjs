/**
 * tools/check-installed.mjs —— 安装副本完整性检查
 *
 * 为什么需要：改完代码后如果"只挑自己改过的文件"复制进安装目录，
 * 会漏掉index.js 依赖但本次没改的文件（真实事故：漏了 dist/shared/immutable.js
 * 和 noise.js，dsh web 重启时插件直接 failed to import，整个插件没激活）。
 *
 * 检查三件事：
 *   ① 安装副本 dist 的文件集合与仓库 dist 是否一致（多/少都算问题）
 *   ② 从 dist/index.js、dist/story-worker.js 出发，所有相对 import 的文件是否存在
 *   ③ dist/client.js 与仓库 dist/client.js 哈希是否一致（客户端有没有同步）
 *
 * 用法：
 *   node tools/check-installed.mjs
 *   node tools/check-installed.mjs --dir "C:\path\to\node_modules\dsh-chubby-whale"
 *
 * 退出码：0=一致；1=有问题
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const getArg = (name, def) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const REPO_DIST = resolve(getArg('repo-dist', 'dist'))
const DEFAULT_PROFILE = process.env.DSH_PROFILE || 'web'
const INSTALL_DIR = resolve(getArg('dir', join(homedir(), '.dsh', 'profiles', DEFAULT_PROFILE, 'node_modules', 'dsh-chubby-whale')))
const INSTALL_DIST = join(INSTALL_DIR, 'dist')

function listFiles(dir) {
  const out = new Set()
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else out.add(relative(dir, p).replace(/\\/g, '/'))
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

const problems = []

if (!existsSync(INSTALL_DIST)) {
  console.error('  ❌ 找不到安装副本：' + INSTALL_DIST)
  process.exit(1)
}

// ① 文件集合
const repo = listFiles(REPO_DIST)
const inst = listFiles(INSTALL_DIST)
const missing = [...repo].filter((f) => !inst.has(f))
const extra = [...inst].filter((f) => !repo.has(f))
if (missing.length) problems.push('安装副本缺少文件（重启会 import 失败）：' + missing.join(', '))
if (extra.length) problems.push('安装副本多出文件（可能是旧版本残留）：' + extra.join(', '))
console.log('  文件集合：仓库 ' + repo.size + ' ｜ 安装副本 ' + inst.size + ' ｜ 缺 ' + missing.length + ' ｜ 多 ' + extra.length)

// ② 相对 import 闭包（从入口出发）
function checkClosure(entry) {
  const seen = new Set()
  const stack = [entry]
  while (stack.length) {
    const file = stack.pop()
    if (seen.has(file)) continue
    seen.add(file)
    let src = ''
    try { src = readFileSync(join(INSTALL_DIST, file), 'utf8') } catch (e) {
      problems.push('读不到 ' + file)
      continue
    }
    for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
      const target = resolve(dirname(join(INSTALL_DIST, file)), m[1])
      const rel = relative(INSTALL_DIST, target).replace(/\\/g, '/')
      if (!existsSync(target)) problems.push(file + ' 引用的 ' + rel + ' 不存在')
      else if (rel.endsWith('.js')) stack.push(rel)
    }
  }
  return seen.size
}
for (const entry of ['index.js', 'story-worker.js']) {
  if (!existsSync(join(INSTALL_DIST, entry))) continue
  const n = checkClosure(entry)
  console.log('  入口 ' + entry + '：可达 ' + n + ' 个模块')
}

// ③ 客户端产物
function hash(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}
const repoClient = join(REPO_DIST, 'client.js')
const instClient = join(INSTALL_DIST, 'client.js')
if (existsSync(repoClient) && existsSync(instClient)) {
  const same = hash(repoClient) === hash(instClient)
  console.log('  client.js：' + (same ? '一致' : '不一致') + '（' + Math.round(statSync(instClient).size / 1024) + ' KB）')
  if (!same) problems.push('client.js 与仓库不一致：Ctrl+F5 后仍是旧界面')
}

if (problems.length) {
  console.log('\n  ❌ 安装副本有问题：')
  for (const p of problems) console.log('    · ' + p)
  process.exit(1)
}
console.log('\n  ✅ 安装副本完整：文件集合一致、相对 import 全部可达、client.js 同步')
