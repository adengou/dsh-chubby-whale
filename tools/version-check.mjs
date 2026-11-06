/**
 * tools/version-check.mjs —— 版本一致性检查（本地 ↔ Gitee）
 *
 * 用法：
 *   node tools/version-check.mjs             # 本地 package.json vs Gitee main（默认）
 *   node tools/version-check.mjs --offline   # 只读本地、不联网（断网/CI 无网时用，恒退出 0）
 *
 * 退出码：0=一致（或 --offline），1=不一致或读取失败
 *
 * 口径（2026-11-06 起，第一原则）：唯一分发渠道是 Gitee，**不上 GitHub、不发 npm**。
 * 旧版三渠道检查（GitHub API / npm registry / npm tarball 哈希）已整体删除，
 * 留着只会误报：本机 github.com 不可达、npm 包冻结在 1.0.1，两处永远「不一致」。
 *
 * 设计：以本地 package.json 为唯一真源；远程只读，不改任何东西。
 */

import { readFileSync } from 'node:fs'

const OFFLINE = process.argv.includes('--offline')
const OWNER = 'adengou'
const REPO = 'dsh-chubby-whale'
const RAW_URL = `https://gitee.com/${OWNER}/${REPO}/raw/main/package.json`

function localVersion() {
  return JSON.parse(readFileSync('package.json', 'utf8')).version
}

async function giteeVersion() {
  const r = await fetch(RAW_URL, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(20000) })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  return JSON.parse(await r.text()).version
}

const local = localVersion()
const rows = [{ name: '本地 (package.json)', value: local, error: '' }]

if (!OFFLINE) {
  try {
    rows.push({ name: 'Gitee  main', value: await giteeVersion(), error: '' })
  } catch (e) {
    rows.push({ name: 'Gitee  main', value: '—', error: e.message })
  }
}

let ok = true
for (const r of rows) {
  if (r.error) { ok = false; continue }
  if (r.value !== local) ok = false
}

console.log('  版本一致性检查' + (OFFLINE ? '（离线：只读本地）' : ''))
console.log('  ' + '-'.repeat(46))
for (const r of rows) {
  const mark = r.error ? '✗' : (r.value === local ? '✓' : '✗')
  console.log(`  ${mark} ${r.name.padEnd(20)} ${r.error ? '读取失败：' + r.error : r.value}`)
}
console.log('  ' + '-'.repeat(46))
console.log(ok ? '  ✅ 版本一致（本地 / Gitee）' : '  ❌ 存在不一致，发版前请先对齐')
process.exit(ok ? 0 : 1)
