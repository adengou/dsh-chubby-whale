/**
 * scripts/test-package-clean.mjs —— 发布面体检（离线、只读）
 *
 * 钉住 2026-11-14 R2 审查发现的两类回归：
 *   1. dist 孤儿：src 已删、dist 还留着旧模块，build 无 clean 会继续发布；
 *   2. npm 包夹带内部 docs（43 个，含密钥扫描报告）。
 *
 * 不实际 npm pack（避免慢/写临时 tgz）；只做静态与产物存在性检查。
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.error('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

console.log('[A] build 前先 clean dist')
ok('build 脚本以 clean-dist 开头', /^node scripts\/clean-dist\.mjs && /.test(String(pkg.scripts.build)), String(pkg.scripts.build).slice(0, 80))
ok('clean-dist.mjs 存在', existsSync(join(ROOT, 'scripts', 'clean-dist.mjs')))
const cleanSrc = readFileSync(join(ROOT, 'scripts', 'clean-dist.mjs'), 'utf8')
ok('clean-dist 只用 Node fs（无 shell/cmd/rm -rf）', /rmSync\(/.test(cleanSrc) && !/child_process|exec\(|spawn\(/.test(cleanSrc))

console.log('\n[B] npm 包不夹带 docs / 内部报告')
ok('files 不含 "docs"', !Array.isArray(pkg.files) || !pkg.files.includes('docs'), JSON.stringify(pkg.files))
ok('files 仍含运行时必需项',
  ['dist', 'mobile', 'assets', 'README.md', 'config.example.json'].every((x) => pkg.files.includes(x)))
ok('docs 目录仍保留在仓库（只是不进 npm 包）', existsSync(join(ROOT, 'docs')))

console.log('\n[C] dist 孤儿已清')
const ORPHANS = [
  'dist/host/feedback/send.js',
  'dist/host/routes/feedback.js',
  'dist/host/routes/memory.js',
  'dist/shared/whale-works.js',
]
for (const rel of ORPHANS) {
  ok('不存在 ' + rel, !existsSync(join(ROOT, rel)))
}

console.log('\n' + '='.repeat(48))
console.log('通过 ' + pass + ' 项 / 失败 ' + fail + ' 项')
if (fail) process.exit(1)
console.log('✅ 发布面体检通过')
