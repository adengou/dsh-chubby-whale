/**
 * tools/test-count.mjs —— 精确统计 `npm test` 链里的断言总数（不参与 npm test）
 *
 * 为什么要有它（2026-11-07）：人工把各套件的「通过 N 项」加总时，容易漏掉不同格式的汇总行
 * （「全部通过：74/74 项」「通过 32 项 / 警告 0 项 / 失败 0 项」）。本工具逐脚本跑，
 * 从各自输出里取**最后一条**汇总行，按脚本名对齐求和，避免再拍脑袋。
 *
 * 用法：node tools/test-count.mjs           # 全跑（和 npm test 同量级耗时）
 *       node tools/test-count.mjs --json    # 机器可读
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))
const cmds = String(pkg.scripts.test).split('&&').map((s) => s.trim())

function parseCmd(cmd) {
  const m = /^node\s+(scripts\/[\w.-]+\.mjs)(.*)$/.exec(cmd)
  return m ? { script: m[1] } : null
}

// 顺序即优先级：先匹配更具体的写法
const PATTERNS = [
  { re: /通过\s*(\d+)\s*项\s*\/\s*警告\s*\d+\s*项\s*\/\s*失败\s*(\d+)\s*项/g, kind: 'passFail' },
  { re: /通过\s*(\d+)\s*项\s*[，,/]\s*失败\s*(\d+)\s*项/g, kind: 'passFail' },
  { re: /结果：通过\s*(\d+)\s*项\s*\/\s*失败\s*(\d+)\s*项/g, kind: 'passFail' },
  { re: /全部通过[：:]\s*(\d+)\s*\/\s*(\d+)\s*项/g, kind: 'passTotal' },
]

function extract(text) {
  for (const { re, kind } of PATTERNS) {
    re.lastIndex = 0
    let last = null
    let m
    while ((m = re.exec(text)) !== null) last = m
    if (!last) continue
    const a = Number(last[1])
    const b = Number(last[2])
    return kind === 'passTotal' ? { pass: a, fail: Math.max(0, b - a) } : { pass: a, fail: b }
  }
  return null
}

const results = []
for (const cmd of cmds) {
  const p = parseCmd(cmd)
  if (!p) continue
  const r = spawnSync(process.execPath, [p.script], { cwd: ROOT, encoding: 'buffer' })
  const out = Buffer.concat([r.stdout || Buffer.alloc(0), r.stderr || Buffer.alloc(0)]).toString('utf8')
  const got = extract(out)
  results.push({
    script: p.script,
    status: r.status,
    pass: got ? got.pass : 0,
    fail: got ? got.fail : 0,
    matched: Boolean(got),
  })
}

const total = results.reduce((n, r) => n + r.pass, 0)
const fails = results.reduce((n, r) => n + r.fail, 0)
const bad = results.filter((r) => r.status !== 0 || (r.matched && r.fail > 0))
// 不计断言的纯检查脚本（输出里没有 N 项汇总，属预期）
const CHECK_ONLY = new Set([
  'scripts/gen-module-index.mjs',
  'scripts/check-imports.mjs',
  'scripts/check-boundaries.mjs',
  'scripts/check-diag-keys.mjs',
  'scripts/check-text.mjs',
  'scripts/ape-bench.mjs',
])
const unmatched = results.filter((r) => !r.matched && !CHECK_ONLY.has(r.script))

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total, fails, results }, null, 2))
  process.exit(bad.length || unmatched.length ? 1 : 0)
}

for (const r of results) {
  console.log(
    (r.matched ? '  ' : (CHECK_ONLY.has(r.script) ? '· ' : '⚠️ ')) +
      r.script.padEnd(34) +
      String(r.pass).padStart(5) +
      (r.fail ? '  失败 ' + r.fail : '') +
      (r.status !== 0 ? '  exit=' + r.status : ''),
  )
}
console.log('-'.repeat(60))
console.log(
  '套件 ' + results.length + ' 个 ｜ 合计断言 ' + total + ' ｜ 失败 ' + fails + ' ｜ 未识别 ' + unmatched.length,
)
if (bad.length || unmatched.length) process.exit(1)
