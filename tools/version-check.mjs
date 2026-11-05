/**
 * tools/version-check.mjs —— 三处版本一致性检查（Gitee / GitHub / npm）
 *
 * 用法：
 *   node tools/version-check.mjs          # 只比对版本号
 *   node tools/version-check.mjs --deep   # 额外比对 npm 包内 dist/client.js 与本地是否一致
 *
 * 退出码：0=三处一致，1=有不一致（可用于 CI / 发版前自检）
 *
 * 设计：以本地 package.json 为唯一真源；远程只做“读”，不改任何东西。
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

const DEEP = process.argv.includes('--deep')
const OWNER = 'adengou'
const REPO = 'dsh-chubby-whale'

function localVersion() {
  return JSON.parse(readFileSync('package.json', 'utf8')).version
}

async function giteeVersion() {
  const r = await fetch(`https://gitee.com/${OWNER}/${REPO}/raw/main/package.json`, { headers: { 'cache-control': 'no-cache' } })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  return JSON.parse(await r.text()).version
}

async function githubVersion() {
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/package.json`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'cache-control': 'no-cache' },
  })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  const j = await r.json()
  return JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')).version
}

async function npmLatest() {
  const r = await fetch(`https://registry.npmjs.org/${REPO}`, { headers: { 'cache-control': 'no-cache' } })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  const j = await r.json()
  return { version: j['dist-tags'].latest, tarball: j.versions[j['dist-tags'].latest].dist.tarball }
}

async function npmClientHash(tarball, version) {
  // 官方源在国内经常断流：官方失败就换 npmmirror（同一个包，字节一致）
  const urls = [tarball, `https://registry.npmmirror.com/${REPO}/-/${REPO}-${version}.tgz`]
  let buf = null
  const errs = []
  for (const u of urls) {
    for (let i = 1; i <= 2 && !buf; i++) {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(60000) })
        if (!r.ok) throw new Error('HTTP ' + r.status)
        buf = gunzipSync(Buffer.from(await r.arrayBuffer()))
      } catch (e) { errs.push(u.replace(/^https?:\/\//, '').split('/')[0] + ': ' + e.message) }
    }
    if (buf) break
  }
  if (!buf) throw new Error('tarball 下载失败（' + errs.slice(0, 2).join('；') + '）')
  // 从 tar 里找 package/dist/client.js：tar 头 512 字节，跳过内容块
  let off = 0
  while (off + 512 <= buf.length) {
    const name = buf.subarray(off, off + 100).toString('utf8').replace(/\0.*$/, '')
    const sizeOctal = buf.subarray(off + 124, off + 136).toString('utf8').replace(/\0.*$/, '').trim()
    const size = parseInt(sizeOctal, 8) || 0
    if (name === 'package/dist/client.js') {
      return createHash('sha256').update(buf.subarray(off + 512, off + 512 + size)).digest('hex')
    }
    off += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error('tar 里没找到 dist/client.js')
}

function localHash(rel) {
  return createHash('sha256').update(readFileSync(rel)).digest('hex')
}

const rows = []
let ok = true
function row(name, fn) {
  return fn().then((v) => rows.push({ name, value: v, error: '' })).catch((e) => { rows.push({ name, value: '—', error: e.message }); ok = false })
}

const local = localVersion()
await Promise.all([
  row('本地 (package.json)', async () => local),
  row('Gitee  main', giteeVersion),
  row('GitHub main', githubVersion),
  row('npm    latest', async () => (await npmLatest()).version),
])

console.log('  版本一致性检查')
console.log('  ' + '-'.repeat(46))
for (const r of rows) {
  const mark = r.error ? '✗' : (r.value === local ? '✓' : '✗')
  console.log(`  ${mark} ${r.name.padEnd(20)} ${r.error ? '读取失败：' + r.error : r.value}`)
}
for (const r of rows) if (!r.error && r.value !== local) ok = false

if (DEEP && ok) {
  try {
    const { tarball } = await npmLatest()
    const remoteH = await npmClientHash(tarball, local)
    const localH = localHash('dist/client.js')
    const same = remoteH === localH
    console.log(`  ${same ? '✓' : '✗'} npm 包内 dist/client.js ${same ? '与本地一致' : '与本地不同'}`)
    if (!same) { console.log('    本地 ' + localH.slice(0, 16) + '  远程 ' + remoteH.slice(0, 16)); ok = false }
  } catch (e) {
    console.log('  ✗ npm 包内容比对失败：' + e.message)
    ok = false
  }
}

console.log('  ' + '-'.repeat(46))
console.log(ok ? '  ✅ 三处版本一致（本地 / Gitee / GitHub / npm）' : '  ❌ 存在不一致，发版前请先对齐')
process.exit(ok ? 0 : 1)
