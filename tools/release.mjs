/**
 * tools/release.mjs —— 跨平台发版助手（纯 Node，不依赖 PowerShell / bash 特性）
 *
 * 为什么有它（2026-11-07 主人要求「插件是跨平台的，不要依赖 PowerShell」）：
 *   插件运行时本来没有任何 shell 依赖（唯一的外部命令 taskkill 只在 win32 分支、POSIX 走信号），
 *   但发版流程过去一直是用交互式 PowerShell 一条条敲的——这一步在 Linux/macOS 上不可复制。
 *   本脚本把同一套步骤写成 Node：Windows / Linux / macOS 都能直接 `node tools/release.mjs ...`。
 *
 * 子命令：
 *   node tools/release.mjs check        # 构建 + 全链测试 + 发版一致性自检（默认）
 *   node tools/release.mjs check:tag    # 同上，但要求本地 tag 已存在（打 tag 之后用）
 *   node tools/release.mjs push         # 推 Gitee（含 tag）→ GitHub 同步 → npm 发布 → 轮询 latest
 *   node tools/release.mjs poll         # 只轮询 npm dist-tags.latest（发布后确认可见）
 *   node tools/release.mjs all          # check → push → poll
 *
 * 设计约束：
 *   · 不拼 shell 字符串：一律 `spawnSync(程序, argv数组)`，需要 shell 的地方只有 npm（Windows 上是 npm.cmd）；
 *   · `git` / `npm` 找不到时给出明确提示（而不是让父进程报 ENOENT）；
 *   · 任何一步非 0 就停，不静默继续；
 *   · 不做破坏性操作：不 reset、不 force push、不删除分支；tag 冲突只提示人工处理。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const IS_WIN = process.platform === 'win32'

const ok = (m) => console.log('  ✅ ' + m)
const info = (m) => console.log('  · ' + m)
const die = (m) => { console.error('  ❌ ' + m); process.exit(1) }

/** 跑一个外部命令；返回退出码。没有 shell 参与（npm 在 Windows 用 npm.cmd） */
function run(cmd, args, opts = {}) {
  // Windows 上的 npm 是 npm.cmd：spawnSync 不能直接执行 .cmd（EINVAL），必须交给 cmd.exe。
  // 注意：这里只用 cmd.exe，绝不引 PowerShell——脚本要在 Windows / Linux / macOS 都能跑。
  if (cmd === 'npm' && IS_WIN) {
    // Windows 的 npm 是 .cmd：必须经 shell。这里把命令拼成**一条字符串**再交给 shell，
    // 不传 args 数组（那样会触发 DEP0190「args 未转义只拼接」的弃用警告）。
    // 只拼我们自己写死的参数（run/build/test/publish/--registry=...），没有用户输入。
    const quote = (a) => (/[\s"]/.test(a) ? '"' + String(a).replace(/"/g, '\\"') + '"' : a)
    const line = 'npm ' + args.map(quote).join(' ')
    const r = spawnSync(line, { cwd: ROOT, stdio: 'inherit', shell: true, ...opts })
    if (r.error) die('跑不起来：npm（' + (r.error.code || r.error.message) + '）')
    return r.status === null ? 1 : r.status
  }
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: false, ...opts })
  if (r.error) die('跑不起来：' + cmd + '（' + (r.error.code || r.error.message) + '）')
  return r.status === null ? 1 : r.status
}

function version() {
  try { return String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || '') } catch { return '' }
}
function gitOut(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', shell: false })
  return r.status === 0 ? String(r.stdout || '').trim() : null
}

/** npm registry 里 latest 是否已经等于当前版本（最多等 tries × 20s） */
async function pollLatest(tries = 15) {
  const want = version()
  const url = 'https://registry.npmjs.org/dsh-chubby-whale'
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(20000) })
      const j = await r.json()
      const latest = j && j['dist-tags'] && j['dist-tags'].latest
      console.log('  [' + new Date().toISOString().slice(11, 19) + '] npm latest = ' + latest)
      if (latest === want) { ok('npm 已可见 ' + want); return true }
    } catch (e) {
      info('轮询失败（继续）：' + String(e && e.message))
    }
    await new Promise((r) => setTimeout(r, 20000))
  }
  console.error('  ❌ 等不到 npm latest = ' + want + '（可能仍在处理，稍后手动 node tools/release.mjs poll）')
  return false
}

function check(requireTag) {
  info('版本 ' + version())
  if (run('npm', ['run', 'build']) !== 0) die('build 失败')
  if (run('npm', ['test']) !== 0) die('npm test 失败')
  const args = ['tools/check-release.mjs']
  if (requireTag) args.push('--require-tag')
  if (run(process.execPath, args) !== 0) die('发版一致性自检失败')
  ok('构建 + 全链测试 + 一致性自检 全部通过')
}

function push() {
  const v = version()
  const dirty = gitOut(['status', '--porcelain'])
  if (dirty) die('工作区不干净，先提交（' + dirty.split('\n').length + ' 个改动）')
  const tag = 'v' + v
  if (!gitOut(['rev-parse', '--verify', '--quiet', 'refs/tags/' + tag])) {
    info('本地没有 ' + tag + '，按当前提交打 tag')
    if (run('git', ['tag', '-a', tag, '-m', tag]) !== 0) die('打 tag 失败')
  } else {
    ok('本地 tag 已存在：' + tag)
  }
  // 推 Gitee：main + 该 tag（不 force，不改历史）
  if (run('git', ['push', 'origin', 'main']) !== 0) die('推 Gitee main 失败')
  if (run('git', ['push', 'origin', tag]) !== 0) die('推 Gitee tag 失败（若远端已有同名 tag，请人工确认后处理）')
  ok('Gitee 已推送 main + ' + tag)

  // GitHub：走 API（gh-sync.mjs），凭据由 gh-sync 自己从 git 凭据管理器/环境变量取
  if (existsSync(join(ROOT, 'tools/gh-sync.mjs'))) {
    if (run(process.execPath, ['tools/gh-sync.mjs']) !== 0) die('GitHub 同步失败')
    ok('GitHub 已同步')
  } else {
    info('没有 tools/gh-sync.mjs，跳过 GitHub')
  }

  // npm：显式官方源
  if (run('npm', ['publish', '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund']) !== 0) {
    die('npm publish 失败（常见原因：token 失效 / 版本已存在）')
  }
  ok('npm 已提交发布（202 异步，稍后轮询可见）')
}

const cmd = process.argv[2] || 'check'
if (cmd === 'check') check(false)
else if (cmd === 'check:tag') check(true)
else if (cmd === 'push') { push(); await pollLatest() }
else if (cmd === 'poll') { const done = await pollLatest(); if (!done) process.exit(1) }
else if (cmd === 'all') { check(false); push(); const done = await pollLatest(); if (!done) process.exit(1) }
else {
  console.error('用法：node tools/release.mjs [check|check:tag|push|poll|all]')
  process.exit(2)
}
