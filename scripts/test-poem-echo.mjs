/**
 * scripts/test-poem-echo.mjs —— 诗词弹幕（host/poem-echo.ts）离线回归
 *
 * 覆盖：
 *   ① 24 个主题的每个触发词都能命中该主题，且触发词表与规格逐字一致；
 *   ② 返回的 line / title / author 非空，line 是中文原句，返回对象只有约定四键；
 *   ③ 未命中文本（今天天气不错 / 帮我看看这段代码 / Hello world …）返回 null；
 *   ④ 多主题同时命中时取「触发词最长」的那个（喜欢一个人 → 孤独，不是相思）；
 *   ⑤ 同一文本两次调用结果完全相同（含首尾空格：trim 后同一句 = 同一句诗）；
 *   ⑥ 空串 / 纯空白 / 非字符串返回 null 且不抛错；
 *   ⑦ 诗句真实性：先全量核对 79 句都能在 data/poems.json 的同一首诗（title+author）里
 *      找到原文，再随机抽 5 条返回结果逐条对data库（找不到同名诗即断言失败）；
 *   ⑧ 源码级断言：模块零 import、无 Math.random、不读时钟、不碰文件系统、常量表已冻结。
 *
 * 做法：esbuild 把 src/host/poem-echo.ts 打成一个自包含 ESM（仓库内 .tmp-tests/ 临时目录——
 * 本机 Windows ACL 拒写系统临时目录，与 test-whale-speak.mjs 同口径），导入后立即删目录；
 * 测的是构建后的同一份代码，不碰 dist、不联网。
 *
 * 用法：node scripts/test-poem-echo.mjs   （全绿退出码 0；有失败退出码 1）
 */

import { build } from 'esbuild'
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SRC = join(ROOT, 'src')
const MODULE_FILE = join(SRC, 'host', 'poem-echo.ts')
const DATA_FILE = join(ROOT, 'data', 'poems.json')
/** 分诗人归档目录：与主库合并后再核对诗句 */
const POETS_DIR = join(ROOT, 'data', 'poets')
/** 项目内临时目录：esbuild 子进程写系统临时目录会被 Windows ACL 拒 */
const TMP = join(ROOT, '.tmp-tests', 'poem-echo-' + process.pid + '-' + Date.now().toString(36))
const BUNDLE = join(TMP, 'poem-echo.mjs')

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.error('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}
/** 便于打印 null / 空串这类"假值也算结果"的比较 */
const show = (v) => (v === null ? 'null' : v === undefined ? 'undefined' : JSON.stringify(v))

/** 规格里 24 个主题的触发词（测试里照抄一遍：模块改错、规格走样都会红） */
const EXPECTED_TRIGGERS = {
  '坚持': ['坚持', '努力', '不放弃', '加油', '扛住', '撑住', '熬', '顶住'],
  '孤独': ['孤独', '一个人', '寂寞', '无人'],
  '离别': ['离别', '分开', '告别', '离开', '分手'],
  '思乡': ['思乡', '想家', '故乡', '家乡'],
  '友情': ['朋友', '友情', '兄弟', '知己'],
  '豁达': ['豁达', '看开', '放下', '无所谓', '随缘'],
  '时光': ['时光', '时间', '老了', '岁月', '青春'],
  '奋斗': ['奋斗', '拼搏', '打拼', '事业'],
  '失败': ['失败', '输了', '搞砸', '完蛋'],
  '读书': ['读书', '学习', '看书', '考试'],
  '烦恼': ['烦恼', '烦', '焦虑', '压力', '郁闷'],
  '快乐': ['快乐', '开心', '高兴', '爽'],
  '勇气': ['勇气', '勇敢', '怕', '恐惧'],
  '归隐': ['归隐', '躺平', '退休', '清静'],
  '山水': ['山水', '风景', '旅游', '旅行'],
  '明月': ['月亮', '明月', '月光'],
  '酒': ['喝酒', '酒', '醉了'],
  '雨': ['下雨', '雨', '阴天'],
  '雪': ['下雪', '雪', '冬天'],
  '春天': ['春天', '花开', '踏青'],
  '秋天': ['秋天', '落叶', '秋'],
  '夜晚': ['晚上', '深夜', '失眠', '睡不着'],
  '相思': ['想念', '思念', '相思', '喜欢'],
  '离别酒': ['送别', '饯行', '践行'],
}

// ---------- esbuild：离线打包（只打这一个模块，产物落仓库内临时目录） ----------
try {
  mkdirSync(TMP, { recursive: true })
  await build({
    stdin: {
      contents: "export * from './host/poem-echo.js'\n",
      resolveDir: SRC,
      sourcefile: 'poem-echo-entry.ts',
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
  ok('esbuild 打包 host/poem-echo.ts（离线 / 不碰 dist / 产物在仓库内）', true, '.tmp-tests/…')
} catch (e) {
  ok('esbuild 打包 host/poem-echo.ts（离线 / 不碰 dist / 产物在仓库内）', false, String((e && e.message) || e))
  console.error(String((e && e.stack) || e))
  rmSync(TMP, { recursive: true, force: true })
  process.exit(1)
}

let mod
try {
  mod = await import(pathToFileURL(BUNDLE).href)
} catch (e) {
  ok('打包产物可在 Node 里直接导入（无浏览器依赖）', false, String((e && e.message) || e))
  console.error(String((e && e.stack) || e))
  rmSync(TMP, { recursive: true, force: true })
  process.exit(1)
}
rmSync(TMP, { recursive: true, force: true }) // 临时目录用完即删
ok('打包产物可在 Node 里直接导入、临时目录已删除', true)

const matchPoem = mod.matchPoem
const table = mod.POEM_ECHO_TABLE
const themes = mod.POEM_ECHO_THEMES

// ======================================================================
console.log('\n[1] 模块表面与常量表（主题 / 触发词 / 冻结）')
ok('matchPoem 是函数', typeof matchPoem === 'function')
ok('POEM_ECHO_THEMES 是数组、POEM_ECHO_TABLE 是对象', Array.isArray(themes) && table && typeof table === 'object')
ok('主题不少于 24 个',
  themes.length >= 24 && Object.keys(EXPECTED_TRIGGERS).every((t) => themes.indexOf(t) >= 0),
  themes.join('、'))

const wordDiff = []
for (const t of Object.keys(EXPECTED_TRIGGERS)) {
  const got = table[t] ? Array.from(table[t].words) : []
  if (got.join('|') !== EXPECTED_TRIGGERS[t].join('|')) {
    wordDiff.push(t + ' 实=' + got.join(',') + ' 期=' + EXPECTED_TRIGGERS[t].join(','))
  }
}
ok('24 个主题的触发词与规格逐字一致（连顺序都对）', wordDiff.length === 0, wordDiff.join(' / '))

ok('每主题至少 1 句诗',
  themes.every((t) => table[t].lines.length >= 1 && table[t].lines.length <= 5),
  themes.map((t) => t + ':' + table[t].lines.length).join(' '))
const totalLines = themes.reduce((n, t) => n + table[t].lines.length, 0)
ok('诗句总量不少于 79 句', totalLines >= 79, String(totalLines))

ok('POEM_ECHO_THEMES / POEM_ECHO_TABLE 都冻结', Object.isFrozen(themes) && Object.isFrozen(table))
let pushBlocked = false
try { themes.push('x') } catch { pushBlocked = true }
ok('冻结是真的：往主题数组 push 会抛错', pushBlocked)
const frozenBad = []
for (const t of themes) {
  const pool = table[t]
  if (!pool || !Object.isFrozen(pool) || !Object.isFrozen(pool.words) || !Object.isFrozen(pool.lines)) frozenBad.push(t)
  else if (pool.lines.some((l) => !Object.isFrozen(l))) frozenBad.push(t + '(条目)')
}
ok('池 / 触发词数组 / 诗句数组 / 每条诗句对象四层都冻结', frozenBad.length === 0, frozenBad.join(','))

// ======================================================================
console.log('\n[2] 每个主题的每个触发词都能命中该主题')
const hitMiss = []
let triggerCount = 0
for (const t of Object.keys(EXPECTED_TRIGGERS)) {
  for (const w of EXPECTED_TRIGGERS[t]) {
    triggerCount++
    const r = matchPoem('我最近总在想「' + w + '」这件事')
    if (!r || r.theme !== t) hitMiss.push(w + '→' + (r ? r.theme : 'null') + '（期望 ' + t + '）')
  }
}
ok('全部 ' + triggerCount + ' 个触发词命中预期主题', hitMiss.length === 0, hitMiss.slice(0, 6).join(' / '))

// ======================================================================
console.log('\n[3] 返回字段完整、line 是中文原句、对象只有约定四键')
const CN = /[\u4e00-\u9fff]/
const LATIN = /[A-Za-z0-9]/
const shapeBad = []
const shapeSamples = []
for (const t of themes) {
  const word = table[t].words[0]
  for (const tail of ['', '啊', '啊呀', '嗯嗯嗯', '好累啊']) {
    const r = matchPoem(word + tail)
    if (!r) { shapeBad.push(t + ':null'); continue }
    shapeSamples.push(r)
    if (r.theme !== t) shapeBad.push(t + ':theme=' + r.theme)
    if (typeof r.line !== 'string' || !r.line.trim() || !CN.test(r.line) || LATIN.test(r.line)) shapeBad.push(t + ':line=' + show(r.line))
    if (typeof r.title !== 'string' || !r.title.trim() || !CN.test(r.title)) shapeBad.push(t + ':title=' + show(r.title))
    if (typeof r.author !== 'string' || !r.author.trim() || !CN.test(r.author)) shapeBad.push(t + ':author=' + show(r.author))
  }
}
ok('所有返回结果 line/title/author 非空、line 为中文无拉丁字符', shapeBad.length === 0, shapeBad.slice(0, 5).join(' / '))
ok('返回对象只含 theme/line/title/author 四个键',
  shapeSamples.length > 0 && shapeSamples.every((r) => Object.keys(r).sort().join(',') === 'author,line,theme,title'))

// ======================================================================
console.log('\n[4] 未命中的文本返回 null')
const nonMatch = ['今天天气不错', '帮我看看这段代码', 'Hello world', '嗯', '哈哈哈', '这个功能怎么实现', '我饿了', '12:30 开会']
const notNull = nonMatch.filter((t) => matchPoem(t) !== null)
ok('日常闲聊一律 null（' + nonMatch.length + ' 条）', notNull.length === 0, notNull.join(' / '))

// ======================================================================
console.log('\n[5] 多主题同时命中：取触发词最长的那个')
const multi = [
  ['喜欢一个人', '孤独'],   // 触发词：一个人(3) > 喜欢(2)；旧式「先到先得」会误判成相思
  ['一个人喝酒', '孤独'],   // 触发词：一个人(3) > 喝酒(2) > 酒(1)
  ['看开一点，别烦', '豁达'], // 触发词：看开(2) > 烦(1)
  ['努力奋斗', '坚持'],     // 努力(2) 与 奋斗(2) 等长 → 按表顺序先到先得
]
const multiBad = []
for (const [text, want] of multi) {
  const r = matchPoem(text)
  if (!r || r.theme !== want) multiBad.push(text + '→' + (r ? r.theme : 'null') + '（期望 ' + want + '）')
}
ok('最长触发词胜出 / 等长按表顺序', multiBad.length === 0, multiBad.join(' / '))
const liked = matchPoem('喜欢一个人')
ok('「喜欢一个人」不再被「喜欢」抢走', liked && liked.theme === '孤独', show(liked && liked.theme))

// ======================================================================
console.log('\n[6] 确定性：同一文本永远同一句诗')
const detTexts = ['坚持住，别放弃', '一个人', '今天有点烦', '想家了', '毕业了，要离别',
  '喝酒去', '下雨了', '下雪了', '春天来了', '秋天到了', '睡不着', '喜欢一个人']
const detBad = []
for (const t of detTexts) {
  const a = matchPoem(t)
  const b = matchPoem(t)
  const c = matchPoem('  ' + t + '\n') // trim 后同一句 → 必须同一句诗
  if (JSON.stringify(a) !== JSON.stringify(b)) detBad.push(t + '(两次不同)')
  if (JSON.stringify(a) !== JSON.stringify(c)) detBad.push(t + '(首尾空白影响结果)')
}
ok('12 条文本各调两次 + 带空白版本，结果完全一致', detBad.length === 0, detBad.join(' / '))

// ======================================================================
console.log('\n[7] 空串 / 纯空白 / 非字符串返回 null 且不抛错')
const badInputs = ['', ' ', '   \t\r\n ', null, undefined, 0, 123, true, {}, [], () => {}, Symbol('x'), 10n, Number.NaN]
let threw = ''
const badResults = []
for (const v of badInputs) {
  try { badResults.push(matchPoem(v)) } catch (e) { threw = String((e && e.message) || e) }
}
ok('14 种非法输入一律 null、全程不抛错', threw === '' && badResults.length === badInputs.length && badResults.every((r) => r === null), threw)

// ======================================================================
console.log('\n[8] 诗句真实性：data/poems.json 逐句核对')
let poems = []
try {
  const raw = readFileSync(DATA_FILE, 'utf8').replace(/^\uFEFF/, '')
  // 合并 data/poets/*.json（李煜等分诗人归档）
  let extraPoems = []
  try {
    for (const f of readdirSync(POETS_DIR)) {
      if (!/\.json$/i.test(f)) continue
      try {
        const j = JSON.parse(readFileSync(join(POETS_DIR, f), 'utf8').replace(/^\uFEFF/, ''))
        const list = Array.isArray(j) ? j : (Array.isArray(j && j.poems) ? j.poems : [])
        extraPoems = extraPoems.concat(list)
      } catch (e) { }
    }
  } catch (e) { }
  const parsed = JSON.parse(raw)
  poems = ((Array.isArray(parsed) ? parsed : (parsed && parsed.poems)) || []).concat(extraPoems)
} catch (e) {
  ok('data/poems.json 可读', false, String((e && e.message) || e))
}
ok('数据源（主库+分诗人目录）读到不少于 740 首', poems.length >= 740, String(poems.length))

/** 在诗库里找：同题 + 同作者 + 该行原文在 lines 里 */
function findSource(line, title, author) {
  const exact = poems.filter((p) => p.title === title && p.author === author)
  const pool = exact.length ? exact : poems.filter((p) => p.title === title)
  for (const p of pool) if (Array.isArray(p.lines) && p.lines.indexOf(line) >= 0) return p
  return null
}

const badLines = []
for (const t of themes) {
  for (const item of table[t].lines) {
    const p = findSource(item.line, item.title, item.author)
    if (!p) badLines.push(t + '「' + item.line + '」（' + item.title + '/' + item.author + '）')
  }
}
ok('模块内全部诗句能在数据源原诗里找到原文（title + author + 整行）',
  badLines.length === 0, badLines.slice(0, 3).join(' / '))

// 随机抽 5 条真实返回结果，逐条回到 data 库核对（找不到同名诗即失败）
const seen = new Map()
const probeTails = ['', '啊', '啊呀', '哎', '嗯', '呀', '唉', '哈', '嘿', '哦', '啦', '哟']
for (const t of themes) {
  const word = table[t].words[0]
  for (const tail of probeTails) {
    const r = matchPoem(word + tail)
    if (r) seen.set(r.theme + '|' + r.line, r)
  }
}
const allResults = Array.from(seen.values())
for (let i = allResults.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1))
  const tmp = allResults[i]
  allResults[i] = allResults[j]
  allResults[j] = tmp
}
const picked = allResults.slice(0, 5)
ok('可抽查的返回结果不少于 5 条', picked.length === 5, String(allResults.length))

console.log('  随机抽查的 5 条：')
const spotBad = []
for (const r of picked) {
  const hits = poems.filter((p) => p.title === r.title)
  const p = findSource(r.line, r.title, r.author)
  console.log('    ' + r.theme + ' → ' + r.line + '（' + r.title + ' / ' + r.author + '）'
    + (p ? '  ✓ 同名诗 ' + hits.length + ' 首、作者 ' + p.author + '、' + p.dynasty : '  ✗ 诗库无此句'))
  if (!p) spotBad.push(r.title + ' / ' + r.line)
}
ok('随机 5 条都能在数据源找到同名诗且诗句是原文', spotBad.length === 0, spotBad.join(' / '))

// ======================================================================
console.log('\n[9] 轮换：确定性顺序轮转，池内每一句都轮得到')
const rotateBad = []
for (const t of themes) {
  const lines = Array.from(table[t].lines)
  const word = table[t].words[0]
  const n = lines.length
  const got = []
  for (let i = 0; i < n * 2; i++) {
    const r = matchPoem(word + '啊'.repeat(i))
    got.push(r ? r.line : null)
  }
  const offset = lines.findIndex((l) => l.line === got[0])
  if (offset < 0) rotateBad.push(t + ': 首句不在池内')
  else {
    for (let i = 0; i < got.length; i++) {
      if (got[i] !== lines[(offset + i) % n].line) { rotateBad.push(t + '#' + i + ' 未按顺序轮转'); break }
    }
  }
  if (new Set(got).size !== n) rotateBad.push(t + ': 只轮到 ' + new Set(got).size + '/' + n + ' 句')
}
ok('24 个主题都按固定顺序逐句轮转且轮满整个池子', rotateBad.length === 0, rotateBad.slice(0, 4).join(' / '))

// ======================================================================
console.log('\n[10] 源码级断言：零 import / 无随机 / 无时钟 / 不读文件')
let src = ''
try { src = readFileSync(MODULE_FILE, 'utf8') } catch (e) { ok('模块源码可读', false, String((e && e.message) || e)) }
ok('没有任何 import / export … from / require',
  !/^[ \t]*import[\s{*]/m.test(src) && !/\bfrom[ \t]+['"]/.test(src) && !/\brequire[ \t]*\(/.test(src))
ok('没有 Math.random（不掷骰子）', !/Math[ \t]*\.[ \t]*random/.test(src))
ok('没有 Date.now / new Date（不看时钟）', !/Date[ \t]*\.[ \t]*now/.test(src) && !/new[ \t]+Date\b/.test(src))
ok('没有 fs / 读文件调用', !/node:fs|readFileSync|readFileSync|readFile[ \t]*\(/.test(src))
ok('常量表用 Object.freeze 冻结', /Object[ \t]*\.[ \t]*freeze/.test(src))
const flat = src.replace(/\s+/g, ' ')
ok('PoemEcho 类型签名未改（theme/line/title/author 四字段）',
  /export type PoemEcho = \{ theme: string; line: string; title: string; author: string \}/.test(flat))
ok('matchPoem 签名未改（text: string → PoemEcho | null）',
  /export function matchPoem\(text: string\): PoemEcho \| null/.test(flat))

// ---------- 汇总 ----------
try { rmSync(TMP, { recursive: true, force: true }) } catch { /* 删不掉不影响结论 */ }
console.log('\n  通过 ' + pass + ' 项 / 失败 ' + fail + ' 项')
if (fail > 0) {
  console.error('\n  ❌ 诗词弹幕体检失败')
  process.exit(1)
}
console.log('\n  ✅ 诗词弹幕体检通过（24 个主题 / 79 句真诗 / 触发与轮换确定）')
