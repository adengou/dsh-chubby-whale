/**
 * tools/content-check.mjs —— 三处“内容”一致性检查（不只版本号）
 *
 * 用法：node tools/content-check.mjs
 * 退出码：0=一致；1=有不一致
 *
 * 三种渠道的语义不同，分开比对：
 *   ① Gitee  ：比 commit sha（git 内容寻址，sha 相同则文件必然相同）
 *   ② GitHub ：比逐个文件的 blob sha（走 api.github.com，本机连不上 github.com）
 *   ③ npm    ：npm 包是“发布子集”（package.json 的 files 白名单），
 *               逐文件比较包内字节与工作区文件；换行符差异单独归类；
 *               再把“只在仓库、不进包”的文件分组核对
 *
 * 为什么用系统 tar 解包而不是自己解析 tar：npm 的 tarball 带 PAX 扩展头，
 * 手写解析容易把 PaxHeader 当成文件、并让后续偏移错位（上一版就踩了）。
 */

import { execFileSync, execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const OWNER = 'adengou'
const REPO = 'dsh-chubby-whale'
const API = 'https://api.github.com'

function ghToken() {
  try {
    const out = execSync("printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill", { encoding: 'utf8', shell: 'bash' })
    const m = out.match(/password=(.+)/)
    return m ? m[1].trim() : ''
  } catch { return '' }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const norm = (buf) => sha256(Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'))

const rows = []
let ok = true
const line = (mark, name, detail) => { rows.push({ mark, name, detail }); if (mark === '✗') ok = false }

// ---------- 本地 ----------
const tracked = new Map() // path -> 索引 blob sha
for (const rec of execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '-s', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean)) {
  const tab = rec.indexOf('\t')
  if (tab < 0) continue
  tracked.set(rec.slice(tab + 1).replace(/\\/g, '/'), rec.slice(0, tab).split(' ')[1])
}
const headSha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
const version = JSON.parse(readFileSync('package.json', 'utf8')).version

// ---------- Gitee ----------
try {
  const remoteSha = execSync('git ls-remote origin refs/heads/main', { encoding: 'utf8' }).trim().split(/\s+/)[0]
  line(remoteSha === headSha ? '✓' : '✗', 'Gitee 内容', remoteSha === headSha
    ? `commit 与本地 HEAD 相同（${headSha.slice(0, 7)}）→ 文件必然一致`
    : `commit 不同：本地 ${headSha.slice(0, 7)} / 远端 ${remoteSha.slice(0, 7)}`)
} catch (e) { line('✗', 'Gitee 内容', '读取失败：' + e.message) }

// ---------- GitHub ----------
try {
  const t = ghToken()
  const r = await fetch(`${API}/repos/${OWNER}/${REPO}/git/trees/main?recursive=1`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(t ? { Authorization: 'Bearer ' + t } : {}) },
  })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  const remote = new Map(((await r.json()).tree || []).filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]))
  const missing = [...tracked.keys()].filter((k) => !remote.has(k))
  const extra = [...remote.keys()].filter((k) => !tracked.has(k))
  const diff = [...tracked.entries()].filter(([k, v]) => remote.has(k) && remote.get(k) !== v).map(([k]) => k)
  const bad = missing.length + extra.length + diff.length
  line(bad === 0 ? '✓' : '✗', 'GitHub 内容', bad === 0
    ? `逐文件 blob sha 一致（${remote.size} 个文件）`
    : `不一致：缺 ${missing.length}、多 ${extra.length}、不同 ${diff.length}`)
  if (missing.length) console.log('    GitHub 缺：' + missing.slice(0, 8).join(', '))
  if (extra.length) console.log('    GitHub 多：' + extra.slice(0, 8).join(', '))
  if (diff.length) console.log('    GitHub 不同：' + diff.slice(0, 8).join(', '))
} catch (e) { line('✗', 'GitHub 内容', '读取失败：' + e.message) }

// ---------- npm ----------
try {
  const meta = await (await fetch(`https://registry.npmjs.org/${REPO}`, { headers: { 'cache-control': 'no-cache' } })).json()
  const latest = meta['dist-tags'].latest
  const tb = meta.versions[latest].dist.tarball
  const tmp = mkdtempSync(join(tmpdir(), 'pkgcheck-'))
  const tgz = join(tmp, 'pkg.tgz')
  let got = false
  for (const u of [tb, `https://registry.npmmirror.com/${REPO}/-/${REPO}-${latest}.tgz`]) {
    for (let i = 0; i < 2 && !got; i++) {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(60000) })
        if (!r.ok) continue
        const buf = Buffer.from(await r.arrayBuffer())
        execFileSync('tar', ['-xzf', '-', '-C', tmp], { input: buf })
        got = true
      } catch { }
    }
    if (got) break
  }
  if (!got) throw new Error('tarball 下载/解包失败')
  const root = join(tmp, 'package')
  const inPkg = new Map()
  const walk = (dir) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else inPkg.set(relative(root, p).replace(/\\/g, '/'), sha256(readFileSync(p)))
    }
  }
  walk(root)

  const same = []
  const crlfOnly = []
  const diffFiles = []
  for (const [p, h] of inPkg) {
    if (!existsSync(p)) { diffFiles.push(p + '(工作区没有)'); continue }
    const disk = readFileSync(p)
    if (sha256(disk) === h) same.push(p)
    else if (norm(disk) === norm(Buffer.from(execFileSync('tar', ['-xOf', tgz, 'package/' + p], { maxBuffer: 64 * 1024 * 1024 })))) crlfOnly.push(p)
    else diffFiles.push(p)
  }
  const inPkgSet = new Set(inPkg.keys())
  const notInPkg = [...tracked.keys()].filter((p) => !inPkgSet.has(p))
  const pkgVersion = inPkg.has('package.json') ? JSON.parse(readFileSync('package.json', 'utf8')).version : '?'
  const bad = diffFiles.length
  line(bad === 0 ? '✓' : '✗', 'npm 包内容', bad === 0
    ? `包内 ${inPkg.size} 个文件：${same.length} 个逐字节一致${crlfOnly.length ? '，' + crlfOnly.length + ' 个仅换行符差异（内容等价）' : ''}`
    : `包内 ${inPkg.size} 个：${diffFiles.length} 个内容不同`)
  if (diffFiles.length) console.log('    内容不同：' + diffFiles.slice(0, 8).join(', '))

  // 只在仓库、不进包的文件：分组核对（这些是 files 白名单决定的正常情况）
  const groups = { '源码 src/': 0, '脚本 scripts/': 0, '工具 tools/': 0, '隐藏配置': 0, '密钥/运行数据': 0, '工程配置': 0, '其它': 0 }
  const other = []
  for (const p of notInPkg) {
    if (p.startsWith('src/')) groups['源码 src/']++
    else if (p.startsWith('scripts/')) groups['脚本 scripts/']++
    else if (p.startsWith('tools/')) groups['工具 tools/']++
    else if (/^\.(gitignore|github)/.test(p)) groups['隐藏配置']++
    else if (/^config\.json$|^(data\/(memory|state|growth|fishfood|pet_state|reminders|prefs|story_progress)|data\/.*-seen)/.test(p)) groups['密钥/运行数据']++
    else if (/^(package-lock\.json|tsconfig\.json|\.npmignore)$/.test(p)) groups['工程配置']++
    else { groups['其它']++; other.push(p) }
  }
  line(groups['其它'] === 0 ? '✓' : '✗', 'npm 未打包部分', groups['其它'] === 0
    ? `${notInPkg.length} 个文件按设计不进包：` + Object.entries(groups).filter(([, n]) => n).map(([k, n]) => `${k}${n}`).join(' / ')
    : '有意外未打包文件：' + other.slice(0, 6).join(', '))

  rmSync(tmp, { recursive: true, force: true })
} catch (e) { line('✗', 'npm 包内容', '检查失败：' + e.message) }

// ---------- 输出 ----------
console.log('  内容一致性检查（版本 ' + version + '）')
console.log('  ' + '-'.repeat(68))
for (const r of rows) console.log(`  ${r.mark} ${r.name.padEnd(14)} ${r.detail}`)
console.log('  ' + '-'.repeat(68))
console.log(ok ? '  ✅ 三处内容一致' : '  ❌ 存在内容不一致')
process.exit(ok ? 0 : 1)
