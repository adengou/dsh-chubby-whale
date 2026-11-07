/**
 * tools/check-release.mjs —— 发版一致性自检（零网络）
 *
 * 为什么有它：2026-11-07 一次发版事故——发布脚本因文案里的反引号嵌套报语法错误，
 * 但后半段的 `git commit / tag / push` 仍在同一个命令里照常执行，于是打出了
 * 「tag = v1.1.72，package.json 还是 1.1.71」的坏 tag，还推到了远端。
 * 事后虽然补提交并重建 tag，但根因是「没有一道门禁在推之前核对一致性」。
 *
 * 检查项（全部本地，不需要网络）：
 *   ① package.json 的 version；
 *   ② src/client/version.ts 里的 VERSION（由 scripts/gen-version.mjs 生成）；
 *   ③ dist/client.js 里是否真的编进了这个版本号（构建产物没更新 = 发布包与源码不一致）；
 *   ④ CHANGELOG.md 顶部「[未发布]」下最新一条版本号（应等于 ①，或至少不高于它）；
 *   ⑤ 若本地存在 v<version> tag：该 tag 指向的提交里 package.json 的版本必须与 ① 一致；
 *   ⑥ 可选 --require-tag：要求 tag 必须已存在（发布收尾用）。
 *
 * 用法：
 *   node tools/check-release.mjs                 # 常规自检（tag 不存在时只提示）
 *   node tools/check-release.mjs --require-tag   # 发布推 tag 之后跑，缺 tag 即失败
 * 退出码：0 = 一致；1 = 有不一致（会逐条打印）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REQUIRE_TAG = process.argv.includes('--require-tag')

const problems = []
const notes = []
const ok = (msg) => console.log('  ✅ ' + msg)
const bad = (msg) => { problems.push(msg); console.log('  ❌ ' + msg) }
const note = (msg) => { notes.push(msg); console.log('  · ' + msg) }

/** 跑 git 并把 stdout 拿回来；git 不可用/非仓库时返回 null（不因此判失败） */
function git(args) {
  try {
    const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
    if (r.status !== 0) return null
    return String(r.stdout || '').trim()
  } catch (e) {
    return null
  }
}

console.log('\n[1] package.json ↔ src/client/version.ts ↔ dist/client.js')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = String(pkg.version || '')
if (!/^\d+\.\d+\.\d+/.test(version)) bad('package.json version 形状可疑：' + JSON.stringify(version))
else ok('package.json version = ' + version)

let clientVersion = ''
try {
  const vts = readFileSync(join(ROOT, 'src/client/version.ts'), 'utf8')
  const m = /VERSION\s*=\s*['"]([^'"]+)['"]/.exec(vts)
  clientVersion = m ? m[1] : ''
} catch (e) {
  bad('读不到 src/client/version.ts：' + e.message)
}
if (!clientVersion) bad('src/client/version.ts 里找不到 VERSION 常量')
else if (clientVersion !== version) bad('客户端 VERSION(' + clientVersion + ') 与 package.json(' + version + ') 不一致 —— 先 npm run build')
else ok('客户端 VERSION 与 package.json 一致')

const distClient = join(ROOT, 'dist/client.js')
if (!existsSync(distClient)) bad('dist/client.js 不存在（先 npm run build）')
else {
  const bundle = readFileSync(distClient, 'utf8')
  if (bundle.indexOf(version) >= 0) ok('dist/client.js 已编入版本号 ' + version)
  else bad('dist/client.js 里没有版本号 ' + version + ' —— 构建产物是旧的，发布前必须 npm run build')
}

console.log('\n[2] CHANGELOG 顶部版本')
let topVersion = ''
try {
  const md = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
  const m = /^##\s*\[(\d+\.\d+\.\d+)\]/m.exec(md)
  topVersion = m ? m[1] : ''
} catch (e) {
  bad('读不到 CHANGELOG.md：' + e.message)
}
if (!topVersion) bad('CHANGELOG.md 顶部没有形如 ## [x.y.z] 的版本标题')
else if (topVersion !== version) {
  // 允许「已 bump 但还没写 CHANGELOG」与反向两种情况都判失败：发版时两者必须同时到位
  bad('CHANGELOG 顶部版本(' + topVersion + ') 与 package.json(' + version + ') 不一致')
} else ok('CHANGELOG 顶部版本一致：' + topVersion)

console.log('\n[3] git tag 与 tag 内的 package.json')
const tagName = 'v' + version
const tagSha = git(['rev-parse', '--verify', '--quiet', 'refs/tags/' + tagName])
if (!tagSha) {
  if (REQUIRE_TAG) bad('要求 tag 存在，但本地没有 ' + tagName)
  else note('本地还没有 ' + tagName + '（未打 tag，属正常）')
} else {
  ok('本地 tag ' + tagName + ' = ' + tagSha.slice(0, 7))
  const taggedPkg = git(['show', tagName + ':package.json'])
  if (taggedPkg === null) {
    // 轻量 tag 也走 show；真拿不到就提示，不误判
    note('读不到 tag 内的 package.json（可能不是 git 仓库/对象缺失），跳过内容核对')
  } else {
    let taggedVersion = ''
    try { taggedVersion = String(JSON.parse(taggedPkg).version || '') } catch { }
    if (!taggedVersion) bad('tag ' + tagName + ' 里的 package.json 解析不出 version')
    else if (taggedVersion !== version) bad('tag ' + tagName + ' 里的 package.json 是 ' + taggedVersion + '，与当前 ' + version + ' 不一致（坏 tag，别推！）')
    else ok('tag 内 package.json 版本与当前一致：' + taggedVersion)
  }
}

console.log('\n' + '='.repeat(48))
if (problems.length === 0) {
  console.log('✅ 发版一致性自检通过（' + version + '）')
  if (notes.length) console.log('   提示：' + notes.join('；'))
  process.exit(0)
}
console.log('❌ 发版一致性自检失败，共 ' + problems.length + ' 项：')
for (const p of problems) console.log('   · ' + p)
process.exit(1)
