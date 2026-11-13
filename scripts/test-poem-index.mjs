/**
 * scripts/test-poem-index.mjs —— 诗句关键词索引（host/poem-index.ts）单测
 *
 * 跑法：node scripts/test-poem-index.mjs（失败 exit 1）
 * 用 esbuild 打包到仓库内 .tmp-tests/（本机写系统临时目录会被拒）。
 */
import { build } from 'esbuild'
import { mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/..'
const TMP = join(ROOT, '.tmp-tests', 'poem-index-' + Date.now())
mkdirSync(TMP, { recursive: true })

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name) }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

try {
  // ── 打包模块 ──
  const out = join(TMP, 'm.mjs')
  await build({
    stdin: { contents: "export * from './src/host/poem-index.ts'", resolveDir: ROOT, loader: 'ts' },
    bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
  })
  const mod = await import(pathToFileURL(out).href)
  const { buildPoemIndex, matchPoemKeyword } = mod

  // ── 读诗库（主库 + data/poets 目录）──
  const poems = []
  const main = JSON.parse(readFileSync(join(ROOT, 'data', 'poems.json'), 'utf8'))
  const mainList = Array.isArray(main) ? main : (main && main.poems) || []
  poems.push(...mainList)
  const dir = join(ROOT, 'data', 'poets')
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      poems.push(...(Array.isArray(j) ? j : (j && j.poems) || []))
    }
  }

  console.log('\n[1] 建索引')
  const index = buildPoemIndex(poems.map((p) => ({ title: p.title, author: p.author, lines: p.lines })))
  ok('索引非空（词条数 > 1000）', index.size > 1000, String(index.size))
  ok('诗库条数 ≥ 740', poems.length >= 740, String(poems.length))

  console.log('\n[2] 关键词命中')
  const cases = [
    ['寻寻觅觅', '声声慢'],
    ['冷冷清清', '声声慢'],
    ['春红', '乌夜啼'],
    ['梧桐', ''],
    ['一晌贪欢', '浪淘沙'],
    ['雨霖铃', '雨霖铃'],
    ['声声慢', '声声慢'],
    ['乌夜啼', '乌夜啼'],
  ]
  for (const [word, titlePart] of cases) {
    const hit = matchPoemKeyword(word, index)
    if (!titlePart) ok('「' + word + '」有命中', !!hit, hit ? hit.title : 'null')
    else ok('「' + word + '」命中《' + titlePart + '》', !!hit && hit.title.includes(titlePart), hit ? hit.title : 'null')
  }
  // 太常见的景语（BANAL）刻意不进关键词，避免「东风」「明月」这类词把弹幕刷成噪音
  ok('「东风」被 BANAL 排除（返回 null）', matchPoemKeyword('东风', index) === null)
  // 同一词牌多首时优先带副题的名篇（虞美人 → 李煜两首之一，不是只写词牌的那首）
  const yumeiren = matchPoemKeyword('虞美人', index)
  ok('「虞美人」优先带副题的名篇', !!yumeiren && yumeiren.title.includes('·'), yumeiren ? yumeiren.title + '/' + yumeiren.author : 'null')
  // 带空格的输入也认（「冷 冷」→「冷冷」）
  const spaced = matchPoemKeyword('冷 冷', index)
  ok('「冷 冷」（带空格）也能命中', !!spaced && spaced.title.includes('声声慢'), spaced ? spaced.title : 'null')
  const hit = matchPoemKeyword('寻寻觅觅', index)
  ok('命中的那句包含关键词', !!hit && hit.line.includes('寻寻觅觅'), hit ? hit.line : 'null')

  console.log('\n[3] 最长优先与确定性')
  ok('「寻寻觅觅」选中的词是 4 字而非 2 字', !!hit && hit.word === '寻寻觅觅', hit ? hit.word : 'null')
  const a = matchPoemKeyword('梧桐更兼细雨', index)
  const b = matchPoemKeyword('梧桐更兼细雨', index)
  ok('同一句两次结果相同（确定性）', JSON.stringify(a) === JSON.stringify(b))

  console.log('\n[4] 不命中与空输入')
  ok('空串返回 null', matchPoemKeyword('', index) === null)
  ok('纯标点返回 null', matchPoemKeyword('。。！', index) === null)
  ok('无诗词语返回 null', matchPoemKeyword('今天写了个 bug', index) === null)
  ok('null 索引不抛错且返回 null', matchPoemKeyword('梧桐', null) === null)

  console.log('\n[5] 模块卫生')
  const src = readFileSync(join(ROOT, 'src', 'host', 'poem-index.ts'), 'utf8')
  ok('无 fs / 读文件调用', !/node:fs|readFileSync|readFile[ \t]*\(/.test(src))
  ok('无网络调用', !/fetch\(|http/.test(src))
  ok('无第三方 import', !/^import /m.test(src))
} catch (err) {
  console.log('  ❌ 运行异常：' + String((err && err.stack) || err))
  fail++
} finally {
  rmSync(TMP, { recursive: true, force: true })
}

console.log('\n' + (fail === 0 ? '✅ 关键词索引体检通过（' + pass + ' 项）' : '❌ 失败 ' + fail + ' 项 / 通过 ' + pass + ' 项'))
process.exit(fail === 0 ? 0 : 1)
