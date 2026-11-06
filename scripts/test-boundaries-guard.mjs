/**
 * scripts/test-boundaries-guard.mjs —— 封装检查器的「会拦人」自检（不联网）
 *
 * 为什么需要（2026-11-07）：`check-boundaries.mjs` 曾经把禁令清单写成带引号的
 * `"'../cache.js'"`，却拿去掉引号的模块路径做 indexOf，结果**恒不命中**——
 * 规则从未生效，而 `npm test` 一直报「封装检查通过」。修好之后必须有人盯着它别再假绿，
 * 所以这里反过来验证「塞违规进去，它必须红」。
 *
 * 做法：在 src/host/routes/ 下临时放两个探针文件（一个路由越界、一个端口反依赖），
 * 跑检查器子进程断言 exit 1 且报出对应规则；finally 里一定删干净。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHECKER = join(ROOT, 'scripts/check-boundaries.mjs')

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

/** 跑一次检查器，返回 {status, out} */
function runChecker() {
  const r = spawnSync(process.execPath, [CHECKER], { cwd: ROOT, encoding: 'utf8' })
  return { status: r.status, out: String(r.stdout || '') + String(r.stderr || '') }
}

const probes = [
  {
    file: join(ROOT, 'src/host/routes/_guard_probe_route.ts'),
    body: "import { createStore } from '../store.js'\nexport const probeRoute = () => createStore\n",
    name: '路由直连 store 实现',
    rule: 'B6',
  },
  {
    file: join(ROOT, 'src/host/routes/_guard_probe_cache.ts'),
    body: "import { hashKey } from '../cache.js'\nexport const probeCache = () => hashKey('x')\n",
    name: '路由直连缓存实现',
    rule: 'B6',
  },
]

try {
  console.log('\n[1] 干净基线：检查器应通过')
  const clean = runChecker()
  ok('无违规时 exit 0', clean.status === 0, 'status=' + clean.status)

  for (const p of probes) {
    console.log('\n[2] 探针「' + p.name + '」必须被拦')
    writeFileSync(p.file, p.body, 'utf8')
    try {
      const r = runChecker()
      ok('塞违规后 exit 1（不再假绿）', r.status === 1, 'status=' + r.status)
      ok('报出 ' + p.rule + ' 规则', r.out.indexOf(p.rule) >= 0, r.out.split('\n').filter((l) => l.includes(p.rule)).join(' | ').slice(0, 160))
      ok('报出具体文件', r.out.indexOf(p.file.replace(ROOT, '').replace(/\\/g, '/').split('/').pop()) >= 0 || r.out.indexOf('_guard_probe') >= 0)
    } finally {
      try { if (existsSync(p.file)) unlinkSync(p.file) } catch (e) { }
    }
  }

  console.log('\n[3] 清理后回到干净基线')
  ok('探针文件已删除', probes.every((p) => !existsSync(p.file)))
  const after = runChecker()
  ok('删除探针后 exit 0', after.status === 0, 'status=' + after.status)
} finally {
  // 兜底清理：中途抛错也不留探针
  for (const p of probes) {
    try { if (existsSync(p.file)) unlinkSync(p.file) } catch (e) { }
  }
}

console.log('\n' + '='.repeat(48))
console.log(`通过 ${pass} 项 / 失败 ${fail} 项`)
if (fail > 0) process.exit(1)
console.log('✅ 检查器自检通过（会拦违规，且清理干净）')
