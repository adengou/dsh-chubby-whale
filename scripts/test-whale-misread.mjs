/**
 * scripts/test-whale-misread.mjs —— 鲸鱼式误读（client/whale-misread.ts）离线回归
 *
 * 覆盖：
 *   ① 扩展名分类：6 类全查，大小写不敏感，完整路径 / 点开头文件 / 无扩展名各有断言；
 *   ② 确定性：同一文件名两次结果完全相同（含带 head 的情况），且不改动传入对象；
 *   ③ 不同文件名能选到不同文案（同一分类至少 2 种）；
 *   ④ head 线索：含 error / 失败 补「焦味」，含 TODO 补「沙」，无关键词时与不传相同；
 *   ⑤ 禁语：文案不含「第 + 数字」、不含「行」、不含「你写了」；
 *   ⑥ 每条文案（含 head 补句）≤ 60 字；
 *   ⑦ 非法输入（null / 缺 name / 空 name / 非字符串）返回 null 且不抛错；
 *   ⑧ 每个分类至少 3 条互不相同的文案，且同一条文案在源码里只出现一次（池子无重复）。
 *
 * 做法：esbuild 把 src/client/whale-misread.ts 打成自包含 ESM（项目内临时目录，跑完即删），
 * 再从文件 URL 导入——测的是构建后的同一份代码；不碰 dist、不联网，也不装 DOM 桩。
 *
 * 用法：node scripts/test-whale-misread.mjs   （全绿退出码 0；有失败退出码 1）
 */

import { build } from 'esbuild'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SRC = join(ROOT, 'src')
const SRC_FILE = join(SRC, 'client', 'whale-misread.ts')
/** 项目内临时目录：esbuild 子进程写系统临时目录会被 Windows ACL 拒（与 verify-voice 同口径） */
const TMP = join(ROOT, '.tmp-tests', 'whale-misread-' + process.pid + '-' + Date.now().toString(36))
const BUNDLE = join(TMP, 'whale-misread.mjs')

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.error('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

// ---------- esbuild：离线打包（只打这一个模块，产物落临时目录） ----------
try {
  mkdirSync(TMP, { recursive: true })
  await build({
    stdin: {
      contents: "export * from './client/whale-misread.js'\n",
      resolveDir: SRC,
      sourcefile: 'whale-misread-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    charset: 'utf8',
    logLevel: 'silent',
    outfile: BUNDLE,
  })
} catch (e) {
  console.error('  ❌ esbuild 打包失败：' + String((e && e.message) || e))
  process.exit(1)
}

const mod = await import(pathToFileURL(BUNDLE).href)
try { rmSync(TMP, { recursive: true, force: true }) } catch { /* 临时目录删不掉不影响结论 */ }

const misreadFile = mod.misreadFile
const SRC_RAW = readFileSync(SRC_FILE, 'utf8')

const show = (v) => (v === null ? 'null' : v === undefined ? 'undefined' : JSON.stringify(v))
const uniq = (arr) => Array.from(new Set(arr))
const len = (s) => Array.from(s).length

const KINDS = ['code', 'data', 'doc', 'log', 'image', 'other']
/** 每类取一个代表扩展名，供批量采样 */
const KIND_EXT = { code: '.ts', data: '.json', doc: '.md', log: '.log', image: '.png', other: '.bin' }

/** 生成一批同扩展名的文件名（确定性，便于复跑） */
function sampleNames(kind, n = 400) {
  const ext = KIND_EXT[kind]
  const out = []
  for (let i = 0; i < n; i++) out.push('reef-' + kind + '-' + i + ext)
  return out
}

// ======================================================================
console.log('\n[0] 装载与导出')
ok('esbuild 打包 src/client/whale-misread.ts（离线 / 不碰 dist）', true, SRC_FILE)
ok('导出 misreadFile', typeof misreadFile === 'function')
ok('运行时只导出 misreadFile（类型在编译期擦除）',
  Object.keys(mod).sort().join(',') === 'misreadFile', Object.keys(mod).join(','))

// ======================================================================
console.log('\n[1] 扩展名分类（6 类全覆盖、大小写不敏感）')
const KIND_CASES = {
  code: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.go', '.rs'],
  data: ['.json', '.yaml', '.yml', '.toml', '.csv'],
  doc: ['.md', '.txt', '.docx'],
  log: ['.log'],
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'],
  other: ['.exe', '.zip', '.tar.gz'],
}
{
  let checked = 0
  for (const kind of KINDS) {
    const exts = KIND_CASES[kind]
    for (const ext of exts) {
      const r = misreadFile({ name: 'specimen' + ext })
      const good = Boolean(r) && r.kind === kind && typeof r.text === 'string' && r.text.length > 0
      if (good) checked++
      ok(kind + ' ← specimen' + ext, good, r ? r.kind : 'null')
    }
  }
  ok('六类都有扩展名落位', KINDS.every((k) => KIND_CASES[k].length > 0))
  ok('逐条分类断言数 = 扩展名总数',
    checked === KINDS.reduce((n, k) => n + KIND_CASES[k].length, 0), String(checked))

  // 大小写：扩展名转小写后再查表
  const UPPER = [
    ['SAMPLE.TS', 'code'],
    ['Whale.Json', 'data'],
    ['报告.MD', 'doc'],
    ['Tail.LOG', 'log'],
    ['Reef.JpG', 'image'],
    ['WEIRD.EXE', 'other'],
  ]
  for (const [name, kind] of UPPER) {
    const r = misreadFile({ name })
    ok('大小写不敏感：' + name, Boolean(r) && r.kind === kind, r ? r.kind : 'null')
  }

  // 完整路径 / 点开头文件 / 无扩展名
  const PATH_CASES = [
    ['C:\\Users\\me\\docs\\notes.md', 'doc'],
    ['/var/log/whale.log', 'log'],
    ['dir/sub/reef.py', 'code'],
    ['.gitignore', 'other'],
    ['README', 'other'],
    ['archive.tar.gz', 'other'],
    ['trailing.', 'other'],
  ]
  for (const [name, kind] of PATH_CASES) {
    const r = misreadFile({ name })
    ok('路径 / 无扩展名：' + name, Boolean(r) && r.kind === kind, r ? r.kind : 'null')
  }
}

// ======================================================================
console.log('\n[2] 确定性：同一文件名永远同一句')
{
  const names = ['coral.ts', 'whale.json', 'notes.md', 'deep.log', 'photo.png', 'blob.bin', '报告 2026.docx', 'a.b.c.ts']
  for (const name of names) {
    const a = misreadFile({ name })
    const b = misreadFile({ name })
    ok('两次结果完全相同：' + name, JSON.stringify(a) === JSON.stringify(b), show(a && a.text))
  }

  // 带 head 也确定（含错误 + TODO 同时出现的优先级）
  const hint = { name: 'coral.ts', head: 'ERROR: boom\n// TODO: later' }
  const h1 = misreadFile(hint)
  const h2 = misreadFile(hint)
  ok('带 head 时两次结果完全相同', JSON.stringify(h1) === JSON.stringify(h2), show(h1 && h1.text))

  // 不改动调用方对象：冻结后仍可调用，字段原样
  const frozen = Object.freeze({ name: 'reef.py', head: 'TODO' })
  let frozenThrew = null
  let frozenStable = false
  try {
    const r1 = misreadFile(frozen)
    const r2 = misreadFile(frozen)
    frozenStable = JSON.stringify(r1) === JSON.stringify(r2) && r1 !== null
  } catch (e) { frozenThrew = e }
  ok('冻结的 hint 可正常调用且结果稳定', frozenStable && frozenThrew === null,
    frozenThrew ? String(frozenThrew.message) : '')
  ok('调用后 hint 字段未被改写', frozen.name === 'reef.py' && frozen.head === 'TODO')
}

// ======================================================================
console.log('\n[3] 不同文件名至少能出现 2 种文案')
{
  const texts = sampleNames('code', 60).map((name) => misreadFile({ name }).text)
  ok('同一分类 60 个文件名至少出现 2 种文案', uniq(texts).length >= 2, '出现 ' + uniq(texts).length + ' 种')
  const across = uniq(KINDS.flatMap((kind) => sampleNames(kind, 10).map((name) => misreadFile({ name }).text)))
  ok('跨分类合计至少 2 种文案', across.length >= 2, '出现 ' + across.length + ' 种')
}

// ======================================================================
console.log('\n[4] head 只作极轻线索')
{
  const NAME = 'coral.ts'
  const base = misreadFile({ name: NAME })
  const withError = misreadFile({ name: NAME, head: 'ERROR: TypeError: undefined is not a fish' })
  const withFail = misreadFile({ name: NAME, head: '构建失败：珊瑚没接上' })
  const withTodo = misreadFile({ name: NAME, head: '// TODO: 把剩下的沙铺好' })
  const withPlain = misreadFile({ name: NAME, head: '今天海面很平静。' })

  ok('head 含 error → 文案变化', withError.text !== base.text, show(withError.text))
  ok('ERROR → 提到焦味', withError.text.includes('焦味'))
  ok('head 含「失败」→ 也提到焦味', withFail.text.includes('焦味') && withFail.text !== base.text)
  ok('head 含 TODO → 提到沙', withTodo.text.includes('沙') && withTodo.text !== base.text, show(withTodo.text))
  ok('TODO 与 error 是不同的提示', withTodo.text !== withError.text)
  ok('head 无关键词时与不给 head 相同', withPlain.text === base.text, show(withPlain.text))
  ok('head 线索不改变分类', withError.kind === base.kind && base.kind === 'code')
  ok('head 非字符串按没有 head 处理', misreadFile({ name: NAME, head: 42 }).text === base.text)

  const cueSamples = [withError.text, withFail.text, withTodo.text]
  ok('head 补句都很短（≤ 60 字）', cueSamples.every((t) => len(t) <= 60),
    cueSamples.map(len).join(','))
}

// ======================================================================
console.log('\n[5] 收集全部文案，扫描「假装读过」的表述')
const SCAN = new Set()
for (const kind of KINDS) {
  for (const name of sampleNames(kind, 80)) SCAN.add(misreadFile({ name }).text)
}
for (const head of ['error', '失败', 'TODO 待铺沙', '普通开头']) {
  SCAN.add(misreadFile({ name: 'coral.ts', head }).text)
}
const scanned = Array.from(SCAN)
{
  const lineNo = scanned.filter((t) => /第\s*[0-9]/.test(t))
  const hang = scanned.filter((t) => /行/.test(t))
  const wrote = scanned.filter((t) => /你写了/.test(t))
  ok('文案不含「第 + 数字」这类行号指认', lineNo.length === 0, lineNo.join(' | '))
  ok('文案不含「行」字（不假装指到某一行）', hang.length === 0, hang.join(' | '))
  ok('文案不出现「你写了」这种判断', wrote.length === 0, wrote.join(' | '))
  // 6 类 × 每类 4 条 = 24 条池子文案，再加带 head 的 2 种补句，至少 24 条
  ok('扫描样本覆盖全部池子（≥ 24 条）', scanned.length >= 24, String(scanned.length))
}

// ======================================================================
console.log('\n[6] 文案长度 ≤ 60 字')
{
  const lengths = scanned.map(len)
  const tooLong = scanned.filter((t) => len(t) > 60)
  const tooShort = scanned.filter((t) => len(t) < 4)
  ok('每条文案都不超过 60 字', tooLong.length === 0, tooLong.join(' | '))
  ok('每条文案都不短于 4 字', tooShort.length === 0, tooShort.join(' | '))
  ok('最长一条仍在 60 字以内', Math.max(...lengths) <= 60, '最长 ' + Math.max(...lengths) + ' 字')
}

// ======================================================================
console.log('\n[7] 非法输入：返回 null、不抛错')
{
  const BAD = [
    null, undefined, {}, { name: '' }, { name: '   ' }, { name: 42 }, { name: null },
    { name: [] }, { name: {} }, 'file.ts', 42, true, [], () => 'x',
  ]
  let threw = null
  const results = []
  for (const hint of BAD) {
    try { results.push(misreadFile(hint)) } catch (e) { threw = e }
  }
  ok('非法输入全部返回 null', results.length === BAD.length && results.every((r) => r === null),
    results.map(show).join(','))
  ok('非法输入不抛错', threw === null, threw ? String(threw.message) : '')
  ok('非法调用之后合法调用仍正常', misreadFile({ name: 'ok.ts' }) !== null)
}

// ======================================================================
console.log('\n[8] 文案池：每类至少 3 条、池内不重复')
{
  const allPoolTexts = []
  for (const kind of KINDS) {
    const texts = sampleNames(kind, 400).map((name) => misreadFile({ name }).text)
    const distinct = uniq(texts)
    allPoolTexts.push(...distinct)
    ok(kind + '：至少 3 条互不相同的文案', distinct.length >= 3, '出现 ' + distinct.length + ' 条')
    ok(kind + '：文案池在 3–5 条之间', distinct.length >= 3 && distinct.length <= 5, String(distinct.length))

    // 池子里的每条文案在源码里应恰好出现一次；重复条目会让计数变成 2
    const duplicated = distinct.filter((t) => SRC_RAW.split("'" + t + "'").length - 1 !== 1)
    ok(kind + '：每条文案在源码里只出现一次（池内无重复）', duplicated.length === 0, duplicated.join(' | '))
  }
  ok('六类文案彼此不重样', uniq(allPoolTexts).length === allPoolTexts.length,
    String(allPoolTexts.length) + ' 条')
}

// ======================================================================
console.log('\n[9] 源码约束（纯函数 / 零依赖 / 无随机）')
{
  // 去掉注释再扫，避免把「不碰 localStorage」这类说明文字当成真依赖
  const codeOnly = SRC_RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  ok('源码不 import 任何模块（零依赖）',
    !/^\s*import\s/m.test(codeOnly) && !/^\s*export\s[^\n]*\bfrom\b/m.test(codeOnly) && !/\brequire\s*\(/.test(codeOnly))
  ok('源码不用 Math.random（选句完全确定）', !/Math\.random/.test(codeOnly))
  ok('源码不读时间（确定性不依赖 Date）', !/Date\.now|new Date/.test(codeOnly))
  ok('源码不碰 DOM / localStorage / 网络',
    !/document\.|window\.|localStorage|sessionStorage|fetch\(/.test(codeOnly))
  ok('源码导出规定的 FileHint / Misread / misreadFile',
    /export type FileHint\b/.test(SRC_RAW) && /export type Misread\b/.test(SRC_RAW) && /export function misreadFile\b/.test(SRC_RAW))
}

// ======================================================================
console.log('\n每类示例（固定文件名，供人工过目）')
for (const kind of KINDS) {
  const r = misreadFile({ name: '示例' + KIND_EXT[kind] })
  console.log('  ' + (kind + '     ').slice(0, 7) + ' ' + (r ? r.text : 'null'))
}
console.log('  带 error 的 head  ' + misreadFile({ name: '示例.ts', head: 'ERROR: 焦了' }).text)

if (fail) {
  console.error('\n❌ 失败 ' + fail + ' 项（通过 ' + pass + ' 项）')
  process.exit(1)
}
console.log('\n✅ 全部通过：' + pass + ' 项断言（dsh-chubby-whale 鲸鱼式误读 whale-misread）')
