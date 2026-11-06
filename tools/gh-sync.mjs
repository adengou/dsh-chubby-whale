/**
 * tools/gh-sync.mjs —— 把当前仓库内容同步到 GitHub（只传差异）
 *
 * 为什么需要它：本机连不上 github.com（git push 超时），但 api.github.com 可达。
 * 所以用 Git Data API 逐个文件上传，最后建 tree/commit、更新 main 引用。
 *
 * 用法：
 *   node tools/gh-sync.mjs            # 同步（幂等，可重复跑）
 *   node tools/gh-sync.mjs --dry-run  # 只看差异，不上传
 *
 * 凭据：从 git 凭据管理器取（git credential fill），不落盘、不打印。
 * 环境变量 GH_REPO=owner/name 可覆盖默认仓库。
 */

import { execFileSync, execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const DRY = process.argv.includes('--dry-run')
const OWNER = (process.env.GH_OWNER || 'adengou')
const REPO = (process.env.GH_REPO || 'dsh-chubby-whale')
const API = 'https://api.github.com'

function token() {
  const out = execSync("printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill", { encoding: 'utf8', shell: 'bash' })
  const m = out.match(/password=(.+)/)
  if (!m) throw new Error('取不到 GitHub 凭据：请先 git 登录一次或设置 GH_TOKEN')
  return m[1].trim()
}

const TOKEN = process.env.GH_TOKEN || token()
const H = { Authorization: 'Bearer ' + TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'content-type': 'application/json' }

async function req(method, path, body, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    const r = await fetch(API + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined })
    if (r.ok) return r.json()
    const t = await r.text()
    if ((r.status === 403 && /rate limit/i.test(t)) || r.status === 502) { await new Promise((s) => setTimeout(s, 2500)); continue }
    const e = new Error(method + ' ' + path + ' → ' + r.status + ' ' + t.slice(0, 200)); e.status = r.status; throw e
  }
  throw new Error(method + ' ' + path + ' 重试耗尽')
}

function localBlobs() {
  // 用 git 索引里的 blob sha（就是提交里存的那份字节，已做换行符归一化）。
  // 之前用 hash-object 读工作区文件，CRLF 会让每个文本文件都算成"不同"，导致每次全量重传。
  const out = execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '-s', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const map = new Map()
  for (const line of out.split('\0').filter(Boolean)) {
    // 格式：<mode> <sha> <stage>\t<path>
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const meta = line.slice(0, tab).split(' ')
    const path = line.slice(tab + 1).replace(/\\/g, '/')
    map.set(path, meta[1])
  }
  return map
}

/** 取 git 里存的原始字节（与索引 blob sha 对应），上传时用它，保证 sha 对得上 */
function blobBytes(path) {
  return execFileSync('git', ['cat-file', 'blob', 'HEAD:' + path], { maxBuffer: 64 * 1024 * 1024 })
}

async function remoteTree(branch) {
  const t = await req('GET', `/repos/${OWNER}/${REPO}/git/trees/${branch}?recursive=1`)
  const map = new Map()
  for (const e of t.tree || []) if (e.type === 'blob') map.set(e.path, e.sha)
  return map
}

const repo = await req('GET', `/repos/${OWNER}/${REPO}`)
const branch = repo.default_branch || 'main'
const head = await req('GET', `/repos/${OWNER}/${REPO}/commits/${branch}`)
const parent = head.sha
const local = localBlobs()
const remote = await remoteTree(branch)

const toUpload = [...local.entries()].filter(([k, v]) => remote.get(k) !== v)
const toDelete = [...remote.keys()].filter((k) => !local.has(k))
console.log(`  本地 ${local.size} 个文件 ｜ GitHub ${remote.size} 个文件`)
console.log(`  需要上传 ${toUpload.length} 个${toUpload.length ? '：' + toUpload.slice(0, 5).map(([k]) => k).join(', ') + (toUpload.length > 5 ? ' …' : '') : ''}`)
if (toDelete.length) console.log(`  需要删除 ${toDelete.length} 个：${toDelete.slice(0, 5).join(', ')}`)
if (!toUpload.length && !toDelete.length) { console.log('  ✅ 已是最新，无需同步'); process.exit(0) }
if (DRY) { console.log('  （--dry-run：没有上传）'); process.exit(0) }

const entries = []
let idx = 0
let done = 0
async function worker() {
  while (idx < toUpload.length) {
    const [path] = toUpload[idx++]
    const blob = await req('POST', `/repos/${OWNER}/${REPO}/git/blobs`, { content: blobBytes(path).toString('base64'), encoding: 'base64' })
    entries.push({ path, mode: '100644', type: 'blob', sha: blob.sha })
    done++
    if (done % 20 === 0) console.log(`    ${done}/${toUpload.length}`)
  }
}
await Promise.all([worker(), worker(), worker(), worker()])
for (const path of toDelete) entries.push({ path, mode: '100644', type: 'blob', sha: null })

const tree = await req('POST', `/repos/${OWNER}/${REPO}/git/trees`, { base_tree: head.commit.tree.sha, tree: entries })
const msg = execSync('git log -1 --pretty=%s', { encoding: 'utf8' }).trim()
const commit = await req('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
  message: msg + '\n\n（由 tools/gh-sync.mjs 从本地 HEAD 同步）',
  tree: tree.sha,
  parents: [parent],
})
await req('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${branch}`, { sha: commit.sha, force: true })
console.log(`  ✅ 同步完成：commit ${commit.sha.slice(0, 7)}，上传 ${entries.length} 个文件`)
