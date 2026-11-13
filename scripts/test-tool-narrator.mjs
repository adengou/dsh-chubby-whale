/**
 * scripts/test-tool-narrator.mjs —— 工具调用实况解说（client/tool-narrator.ts）离线回归
 *
 * 覆盖规格里的每一条：
 *   ① 七类工具分类（每类至少一条，外加 todo_write / 大小写 / web_fetch 这类易错名）；
 *   ② 单次调用出文案，且文案落在该类文案池里；
 *   ③ 15 秒冷却：窗口内只出第一句，被压制的调用仍更新 lastTool / 连续计数；
 *   ④ 30 秒不重复：同一工具、同一序号、相隔 15 秒也要换句（靠隐藏的最近句记忆）；
 *   ⑤ 连续同类 ≥3 次换「连环」文案，且与单次句不同；超 60 秒窗口 / 换类会重新起一轮；
 *   ⑥ 确定性：同一 (state, input) 两次调用 JSON 完全相等，且不修改传入 state；
 *   ⑦ 非法输入不抛错、line 一律 null、state 被归一且不推进；
 *   ⑧ 源码级约束：零 import、无 Math.random、不读时钟、不碰 DOM/存储/网络。
 *
 * 做法：esbuild 把 src/client/tool-narrator.ts 打成一个自包含 ESM，产物落**仓库内**
 * .tmp-tests/（本机 Windows ACL 拒写系统临时目录，与 test-whale-speak.mjs 同口径），
 * 导入后立即删掉临时目录；不碰 dist、不联网，也不装任何 DOM / localStorage 桩。
 *
 * 用法：node scripts/test-tool-narrator.mjs   （全绿退出码 0；有失败退出码 1）
 */

import { build } from 'esbuild'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SRC = join(ROOT, 'src')
const SRC_FILE = join(SRC, 'client', 'tool-narrator.ts')
const TMP = join(ROOT, '.tmp-tests', 'tool-narrator-' + process.pid + '-' + Date.now().toString(36))
const BUNDLE = join(TMP, 'tool-narrator.mjs')

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.error('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}
const show = (v) => (v === null ? 'null' : v === undefined ? 'undefined' : JSON.stringify(v))

// ---------- 规格文案池（故意在测试里再写一遍，模块改错就会红） ----------
const POOLS = {
  file: {
    single: [
      '咕噜……它在翻你的抽屉。',
      '它把贝壳一片片翻过来看。',
      '又低头翻你的小箱子，本鲸看着呢。',
    ],
    burst: [
      '它在翻好几个抽屉，咕噜咕噜。',
      '贝壳一片接一片，它翻得尾巴都翘了。',
      '箱子一个接一个，本鲸的泡泡都看困了。',
    ],
  },
  edit: {
    single: [
      '它拿笔在纸上涂涂改改。',
      '咕噜，它给贝壳补了一笔。',
      '它动笔了，本鲸不吵它。',
    ],
    burst: [
      '它连着改了好几处，泡泡都冒歪了。',
      '补完一片又一片，它手都没停。',
      '改了一处又一处，本鲸在边上看着。',
    ],
  },
  shell: {
    single: [
      '这个泡泡吹得有点久。',
      '咕噜……它沉下去了，还没浮上来。',
      '它在海底敲敲打打，本鲸等着。',
    ],
    burst: [
      '泡泡一个接一个，吹个不停。',
      '它连着往下潜，本鲸的尾巴都摆累了。',
      '海底的泡泡冒了一串又一串。',
    ],
  },
  web: {
    single: [
      '又去别人家海里捞东西了。',
      '咕噜，它游到很远的海面去了。',
      '它探头看别人家的浪，本鲸不跟。',
    ],
    burst: [
      '它一趟一趟往别人家海里跑。',
      '别人家的浪，它一浪接一浪地翻。',
      '别人家海里的东西快被它捞遍了。',
    ],
  },
  search: {
    single: [
      '咕噜……它把头埋进沙子里找东西。',
      '它在珊瑚缝里扒拉，尾巴一甩一甩。',
      '它眯着眼在沙里挑，本鲸帮不上。',
    ],
    burst: [
      '它在沙子里翻来翻去，找了好几样。',
      '一片沙接一片沙，它扒拉个没完。',
      '它把整片海底都筛了一遍，咕噜。',
    ],
  },
  plan: {
    single: [
      '它在小本本上划了一道。',
      '咕噜，它把要做的事排成一排。',
      '它低头数泡泡，数得很认真。',
    ],
    burst: [
      '它把清单划了好几遍，咕噜。',
      '一条接一条，本鲸都替它眼晕。',
      '它的小本本快写满了，咕噜。',
    ],
  },
  other: {
    single: [
      '咕噜……它在忙些本鲸看不懂的。',
      '它围着个泡泡转，本鲸先不打扰。',
      '它又伸手够什么东西了，咕噜。',
    ],
    burst: [
      '它围着同一个泡泡转了好几圈。',
      '一阵接一阵，本鲸的尾巴都看愣了。',
      '它忙得泡泡直冒，咕噜咕噜。',
    ],
  },
}
const KINDS = Object.keys(POOLS)
const ALL = Object.fromEntries(KINDS.map((k) => [k, [...POOLS[k].single, ...POOLS[k].burst]]))
const STATE_KEYS = ['lastAt', 'lastTool', 'lastLineAt', 'burstStartAt', 'burstCount'].sort()
/** state 必须正好是规格里的五个字段（隐藏记忆是 Symbol，不该出现在 Object.keys 里） */
function hasShape(s) {
  return !!s && typeof s === 'object' &&
    Object.keys(s).sort().join(',') === STATE_KEYS.join(',') &&
    typeof s.lastTool === 'string' &&
    typeof s.lastAt === 'number' &&
    typeof s.lastLineAt === 'number' &&
    typeof s.burstStartAt === 'number' &&
    typeof s.burstCount === 'number'
}
/** 固定时间基准（毫秒）；测试不读系统时钟，所有 at 都从这里推 */
const T = 1_700_000_000_000

// ---------- esbuild：离线打包（只打这一个模块，产物落仓库内临时目录） ----------
try {
  mkdirSync(TMP, { recursive: true })
  await build({
    stdin: {
      contents: "export * from './client/tool-narrator.js'\n",
      resolveDir: SRC,
      sourcefile: 'tool-narrator-entry.ts',
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
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
  process.exit(1)
}

let mod
try {
  mod = await import(pathToFileURL(BUNDLE).href)
} catch (e) {
  console.error('  ❌ 导入打包产物失败：' + String((e && e.message) || e))
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* 同上 */ }
  process.exit(1)
}
try { rmSync(TMP, { recursive: true, force: true }) } catch { /* 临时目录删不掉不影响结论 */ }

const { narrateTool } = mod

// ======================================================================
console.log('\n[0] 装载与导出面')
ok('esbuild 打包 src/client/tool-narrator.ts（离线 / 不碰 dist）', true, SRC_FILE)
ok('导出 narrateTool 函数', typeof narrateTool === 'function')
ok('运行时只导出这一个函数（类型在打包时擦除）', Object.keys(mod).sort().join(',') === 'narrateTool', Object.keys(mod).join(','))
ok('装载过程不创建 window / document / localStorage',
  typeof globalThis.window === 'undefined' && typeof globalThis.document === 'undefined' && typeof globalThis.localStorage === 'undefined')

// ======================================================================
console.log('\n[1] 七类工具分类（每类一条 + 易错名）')
const CLASS_CASES = [
  ['file', 'read_file'],
  ['edit', 'write_file'],
  ['shell', 'bash'],
  ['web', 'web_search'],
  ['search', 'grep'],
  ['plan', 'task_plan'],
  ['other', 'mystery_tool'],
]
for (let i = 0; i < CLASS_CASES.length; i++) {
  const [kind, tool] = CLASS_CASES[i]
  const r = narrateTool(null, { tool, at: T + i * 1000, seq: 0 })
  const foreign = KINDS.filter((k) => k !== kind).some((k) => ALL[k].includes(r.line))
  ok(kind + '：' + tool + ' 归到本类文案池',
    typeof r.line === 'string' && ALL[kind].includes(r.line) && !foreign,
    show(r.line))
  ok(kind + '：state.lastTool 原样记下工具名', r.state.lastTool === tool)
}

// 最容易归错的名字：todo_write 不能因为含 write 被 edit 抢走；
// web_fetch 必须归 web；大小写不影响分类与选句。
const TRICKY = [
  ['todo_write', 'plan'],
  ['WriteFile', 'edit'],
  ['BASH', 'shell'],
  ['web_fetch', 'web'],
  ['rg', 'search'],
]
for (const [tool, kind] of TRICKY) {
  const r = narrateTool(null, { tool, at: T, seq: 0 })
  ok('易错名 ' + tool + ' → ' + kind, ALL[kind].includes(r.line), show(r.line))
}
const upper = narrateTool(null, { tool: 'READ_FILE', at: T, seq: 0 })
const lower = narrateTool(null, { tool: 'read_file', at: T, seq: 0 })
ok('大小写不同的同一工具名选句一致', upper.line === lower.line, show([upper.line, lower.line]))

// ======================================================================
console.log('\n[2] 单次调用：出文案、落在池内、state 正确')
{
  const r = narrateTool(null, { tool: 'read_file', at: T, seq: 0 })
  ok('首次调用出文案', typeof r.line === 'string' && r.line.length > 0, show(r.line))
  ok('文案在 file 文案池内', ALL.file.includes(r.line))
  ok('返回的 state 正好五个字段', hasShape(r.state), Object.keys(r.state).join(','))
  ok('lastAt / lastTool 记下本次调用', r.state.lastAt === T && r.state.lastTool === 'read_file')
  ok('首次出句把 lastLineAt 移到 at', r.state.lastLineAt === T)
  ok('首次连续计数从 1 起、窗口起点是 at',
    r.state.burstCount === 1 && r.state.burstStartAt === T)
}

// ======================================================================
console.log('\n[3] 15 秒冷却：只出第一句，但 state 照常更新')
{
  const a = narrateTool(null, { tool: 'read_file', at: T, seq: 0 })
  const b = narrateTool(a.state, { tool: 'read_file', at: T + 14_999, seq: 1 })
  ok('差 1 毫秒（14 999 ms）不出句', b.line === null, show(b.line))
  ok('被压制仍更新 lastAt / lastTool',
    b.state.lastAt === T + 14_999 && b.state.lastTool === 'read_file')
  ok('被压制仍累计连续计数（1 → 2）', b.state.burstCount === 2)
  ok('被压制不推进 lastLineAt', b.state.lastLineAt === T)

  const c = narrateTool(b.state, { tool: 'read_file', at: T + 15_000, seq: 2 })
  ok('满 15 秒放行', typeof c.line === 'string', show(c.line))
  ok('放行后 lastLineAt 前移', c.state.lastLineAt === T + 15_000)
  ok('放行时连续计数到 3', c.state.burstCount === 3)

  const d = narrateTool(a.state, { tool: 'bash', at: T + 1_000, seq: 0 })
  ok('冷却对别的工具同样生效（全局冷却）', d.line === null)
  ok('冷却期换工具：lastTool 更新、同类连续计数重置为 1',
    d.state.lastTool === 'bash' && d.state.burstCount === 1)
}

// ======================================================================
console.log('\n[4] 30 秒不重复：序号相同也要换句')
{
  let s = narrateTool(null, { tool: 'read_file', at: T, seq: 0 })
  const l1 = s.line
  s = narrateTool(s.state, { tool: 'read_file', at: T + 15_000, seq: 0 })
  const l2 = s.line
  ok('同一工具、同一序号、相隔 15 秒：第二句不同', typeof l2 === 'string' && l1 !== l2, show([l1, l2]))

  s = narrateTool(s.state, { tool: 'read_file', at: T + 29_999, seq: 0 })
  ok('差 1 毫秒仍被 15 秒冷却压住（不会为了换句硬挤第三句）', s.line === null, show(s.line))

  s = narrateTool(s.state, { tool: 'read_file', at: T + 30_000, seq: 0 })
  const l3 = s.line
  ok('第三句与 30 秒内的第二句仍不同', typeof l3 === 'string' && l3 !== l2, show([l2, l3]))
  ok('第三句也是独立文案（与前两句不撞）', l3 !== l1 && l3 !== l2)
  ok('第三句是连环口径（同类第 3 次）', POOLS.file.burst.includes(l3), show(l3))
  ok('连环句不在单次池', !POOLS.file.single.includes(l3))
}

// ======================================================================
console.log('\n[5] 连续同类 ≥3 次：换「连环」文案')
{
  let w = narrateTool(null, { tool: 'web_search', at: T, seq: 0 })
  const w1 = w.line
  w = narrateTool(w.state, { tool: 'web_search', at: T + 15_000, seq: 0 })
  const w2 = w.line
  w = narrateTool(w.state, { tool: 'web_search', at: T + 30_000, seq: 0 })
  const w3 = w.line
  ok('前两次是单次口径', POOLS.web.single.includes(w1) && POOLS.web.single.includes(w2))
  ok('60 秒内同类第 3 次改用连环口径', POOLS.web.burst.includes(w3), show(w3))
  ok('连环句与单次句不同（也不在单次池）',
    w3 !== w1 && w3 !== w2 && !POOLS.web.single.includes(w3))

  const late = narrateTool(w.state, { tool: 'web_search', at: T + 61_000, seq: 0 })
  ok('超出 60 秒观察窗：重新按单次口径、计数归 1',
    POOLS.web.single.includes(late.line) && late.state.burstCount === 1, show(late.line))

  let z = narrateTool(null, { tool: 'read_file', at: T, seq: 0 })
  z = narrateTool(z.state, { tool: 'read_file', at: T + 15_000, seq: 0 })
  const z3 = narrateTool(z.state, { tool: 'bash', at: T + 30_000, seq: 0 })
  ok('换类重新起一轮（不同类的第 1 次是单次句）',
    POOLS.shell.single.includes(z3.line) && z3.state.burstCount === 1, show(z3.line))

  let q = narrateTool(null, { tool: 'grep', at: T, seq: 0 })
  q = narrateTool(q.state, { tool: 'grep', at: T + 30_000, seq: 0 })
  const q3 = narrateTool(q.state, { tool: 'grep', at: T + 61_000, seq: 0 })
  ok('同类但第三次已在 60 秒外：不回连环',
    POOLS.search.single.includes(q3.line) && q3.state.burstCount === 1, show(q3.line))
}

// ======================================================================
console.log('\n[6] 确定性：同输入两次结果完全一致')
{
  const input = { tool: 'grep', at: T, seq: 5 }
  const d1 = narrateTool(null, input)
  const d2 = narrateTool(null, input)
  ok('(null, input) 两次的 JSON 完全相等', JSON.stringify(d1) === JSON.stringify(d2))

  const st = narrateTool(null, { tool: 'shell_exec', at: T, seq: 1 }).state
  const snapshot = JSON.stringify(st)
  const e1 = narrateTool(st, { tool: 'shell_exec', at: T + 16_000, seq: 1 })
  const e2 = narrateTool(st, { tool: 'shell_exec', at: T + 16_000, seq: 1 })
  ok('(state, input) 两次的 JSON 完全相等', JSON.stringify(e1) === JSON.stringify(e2))
  ok('不修改调用方传入的 state', JSON.stringify(st) === snapshot)
  ok('传入 state 也不带出额外可枚举字段', Object.keys(st).sort().join(',') === STATE_KEYS.join(','))

  const bySeq = [0, 1, 2].map((seq) => narrateTool(null, { tool: 'read_file', at: T, seq }).line)
  ok('序号 0 / 1 / 2 在同一类池里轮换出三句不同文案',
    new Set(bySeq).size === 3 && bySeq.every((l) => POOLS.file.single.includes(l)), show(bySeq))
}

// ======================================================================
console.log('\n[7] 非法输入：不抛错、不出句、state 归一')
{
  const badInputs = [
    null, undefined, {},
    { tool: '', at: T }, { tool: '   ', at: T },
    { tool: 'read_file', at: NaN }, { tool: 'read_file', at: null },
    { tool: 'read_file', at: '1000' }, { tool: 'read_file', at: Infinity },
    { tool: null, at: T }, { tool: 123, at: T }, { tool: [], at: T }, { tool: {}, at: T },
  ]
  let threw = null
  let badLines = 0
  let badShapes = 0
  for (const input of badInputs) {
    try {
      const r = narrateTool(null, input)
      if (r.line !== null) badLines++
      if (!hasShape(r.state)) badShapes++
    } catch (e) { threw = e }
  }
  ok('非法输入全部不抛错', threw === null, threw ? String(threw.message) : '')
  ok('非法输入 line 一律 null', badLines === 0)
  ok('非法输入返回归一后的五字段 state', badShapes === 0)

  const zero = narrateTool(null, { tool: '', at: T })
  ok('null prev + 非法输入 → 零值 state（lastLineAt 仍是 -Infinity = 从未出句）',
    zero.state.lastAt === 0 && zero.state.lastTool === '' && zero.state.burstCount === 0 &&
    zero.state.lastLineAt === Number.NEGATIVE_INFINITY)

  const good = narrateTool(null, { tool: 'bash', at: T, seq: 0 })
  const after = narrateTool(good.state, { tool: '', at: T + 1_000 })
  ok('非法输入不推进已有状态',
    after.line === null && after.state.lastAt === good.state.lastAt &&
    after.state.lastTool === 'bash' && after.state.burstCount === good.state.burstCount &&
    after.state.lastLineAt === good.state.lastLineAt)

  const messy = narrateTool({ lastAt: 'x', lastTool: 42, lastLineAt: null, burstStartAt: NaN, burstCount: -3 }, { tool: 'grep', at: T, seq: 0 })
  ok('坏 state 归一后仍能正常出句',
    typeof messy.line === 'string' && ALL.search.includes(messy.line) &&
    messy.state.lastTool === 'grep' && messy.state.burstCount === 1, show(messy.line))
}

// ======================================================================
console.log('\n[8] 源码级约束（零依赖 / 确定性 / 不碰浏览器）')
{
  const raw = readFileSync(SRC_FILE, 'utf8')
  // 去掉注释再扫，避免把「不读 Date.now」这类说明文字当成真实现
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  ok('源码零 import（不依赖任何模块）',
    !/^\s*import\s/m.test(code) && !/\bfrom\s+['"]/.test(code) && !/\brequire\s*\(/.test(code))
  ok('源码不掷骰子（无 Math.random）', !/Math\.random/.test(code))
  ok('源码不读时钟（无 Date.now / new Date / performance.now）',
    !/Date\.now|new Date|performance\.now/.test(code))
  ok('源码不碰 DOM / 存储 / 网络',
    !/localStorage|sessionStorage|document\.|window\.|fetch\s*\(|XMLHttpRequest|navigator\./.test(code))
  ok('源码不自己起定时器 / 不碰 crypto', !/setTimeout|setInterval|requestAnimationFrame|crypto\./.test(code))
  ok('公开签名齐全（两个类型 + 一个函数 + 固定入参/返回值）',
    /export type ToolNarrateInput\s*=/.test(raw) &&
    /export type NarratorState\s*=/.test(raw) &&
    /export type NarratorResult\s*=/.test(raw) &&
    /export function narrateTool\s*\(\s*prev:\s*NarratorState\s*\|\s*null,\s*input:\s*ToolNarrateInput\s*\)\s*:\s*NarratorResult/.test(raw))
  ok('节奏常量具名且等于规格值（15 s / 30 s / 60 s / 3 次）',
    /LINE_GAP_MS\s*=\s*15_000/.test(raw) && /SAME_LINE_MS\s*=\s*30_000/.test(raw) &&
    /BURST_WINDOW_MS\s*=\s*60_000/.test(raw) && /BURST_MIN_COUNT\s*=\s*3/.test(raw))
}

// ======================================================================
// 收尾报告：七类各取一条实际输出，方便人工核对语气
console.log('\n七类工具各一条（fresh state、序号 0）')
for (const [kind, tool] of CLASS_CASES) {
  const r = narrateTool(null, { tool, at: T, seq: 0 })
  console.log('  ' + kind.padEnd(7) + ' ' + tool.padEnd(14) + ' → ' + r.line)
}

console.log('\n  通过 ' + pass + ' 项 / 失败 ' + fail + ' 项')
if (fail > 0) {
  console.error('\n❌ 工具解说纯函数体检失败')
  process.exit(1)
}
console.log('\n✅ 全部通过：' + pass + ' 项断言（tool-narrator 工具解说纯函数）')
