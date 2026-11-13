/**
 * scripts/test-whale-speak.mjs —— 鲸语口癖（client/whale-speak.ts）离线回归
 *
 * 覆盖：
 *   ① 每个场景在足够多次调用里至少出一句，且词都在本场景白名单内；
 *   ② 返回值只可能是 10 个自创鲸语词之一，且是 2–3 个汉字的单短词（不带标点）；
 *   ③ 冷却：now 不变时最多命中一次；60 秒内换场景也不放行；
 *   ④ 时间推进满 60 秒后可以再次命中；
 *   ⑤ 亲密度分档（20 / 45 / 70）：固定序列对比，高亲密度命中次数严格 ≥ 低亲密度；
 *   ⑥ 非法 ctx（null / 缺 trigger / 未知 trigger / 原型链键）返回 null 且不抛错，
 *      并且不占用机会计数与冷却；
 *   ⑦ resetWhaleWords() 后计数与冷却清零，同一时刻可重新命中。
 *
 * 做法：esbuild 把 src/client/whale-speak.ts 打成一个自包含 ESM（项目内临时目录，
 * 跑完即删），再从文件 URL 导入——测的是构建后的同一份代码；不碰 dist、不联网，
 * 也不装任何 DOM / localStorage 桩（该模块本就不该依赖浏览器环境）。
 *
 * 用法：node scripts/test-whale-speak.mjs   （全绿退出码 0；有失败退出码 1）
 */

import { build } from 'esbuild'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SRC = join(ROOT, 'src')
const SRC_FILE = join(SRC, 'client', 'whale-speak.ts')
/** 项目内临时目录：esbuild 子进程写系统临时目录会被 Windows ACL 拒（与 verify-voice 同口径） */
const TMP = join(ROOT, '.tmp-tests', 'whale-speak-' + process.pid + '-' + Date.now().toString(36))
const BUNDLE = join(TMP, 'whale-speak.mjs')

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
      contents: "export * from './client/whale-speak.js'\n",
      resolveDir: SRC,
      sourcefile: 'whale-speak-entry.ts',
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

const pickWhaleWord = mod.pickWhaleWord
const resetWhaleWords = mod.resetWhaleWords

// ---------- 测试基准数据（与规格一致，故意在测试里再写一遍，改错就会红） ----------
const ALL_WORDS = ['咕噜', '鲸喜', '鲸呆', '鲸动', '鲸奇', '鲸蹦', '鲸软', '鲸懒', '鲸泡', '鲸闹']
const POOLS = {
  greet: ['鲸喜', '鲸软', '鲸蹦'],
  reply: ['咕噜', '鲸奇', '鲸呆'],
  idle: ['鲸懒', '鲸泡', '鲸闹'],
  feed: ['鲸软', '咕噜'],
}
const TRIGGERS = ['greet', 'reply', 'idle', 'feed']

/** 固定时间基准（毫秒） */
const START = 1_700_000_000_000
/** 步长 61 秒：每次调用都在 60 秒冷却之外，于是每次都算一次「机会」 */
const STEP = 61_000

/**
 * 跑一条固定序列：先 reset（从零开始），再按 step 递增的时刻调用 n 次。
 * 只有非空返回值算命中；返回 [{ i, word }]，便于统计命中次数与轮换覆盖。
 */
function sequence(trigger, n, intimacy, start = START, step = STEP) {
  resetWhaleWords()
  const got = []
  for (let i = 0; i < n; i++) {
    const ctx = intimacy === undefined ? { trigger } : { trigger, intimacy }
    const w = pickWhaleWord(ctx, start + i * step)
    if (w !== null) got.push({ i, word: w })
  }
  return got
}

const uniq = (arr) => Array.from(new Set(arr))
const show = (v) => (v === null ? 'null' : v === undefined ? 'undefined' : JSON.stringify(v))

// ======================================================================
console.log('\n[0] 装载与导出')
ok('esbuild 打包 src/client/whale-speak.ts（离线 / 不碰 dist）', true, SRC_FILE)
ok('导出 pickWhaleWord / resetWhaleWords', typeof pickWhaleWord === 'function' && typeof resetWhaleWords === 'function')
ok('运行时只导出这两个函数（接口面收窄）',
  Object.keys(mod).sort().join(',') === 'pickWhaleWord,resetWhaleWords', Object.keys(mod).join(','))
ok('resetWhaleWords() 返回 undefined', resetWhaleWords() === undefined)

// ======================================================================
console.log('\n[1] 场景覆盖 / 白名单 / 单短词（每场景 100 次机会，步长 61 秒）')
// 各场景故意用不同亲密度：既跑通分档，也让「100 次里的命中次数」有区分度
const REPORT_INTIMACY = { greet: 10, reply: 55, idle: 80 }
const report = []
for (const trigger of TRIGGERS) {
  const intimacy = REPORT_INTIMACY[trigger]
  const got = sequence(trigger, 100, intimacy)
  const words = got.map((x) => x.word)
  report.push({
    trigger,
    intimacy: intimacy === undefined ? null : intimacy,
    calls: 100,
    hits: got.length,
    words: uniq(words),
  })
  ok(trigger + '：100 次机会至少命中一次', got.length > 0, '命中 ' + got.length + ' 次')
  const stray = words.filter((w) => !POOLS[trigger].includes(w))
  ok(trigger + '：词都在本场景白名单内', stray.length === 0, uniq(stray).join(','))
  const missing = POOLS[trigger].filter((w) => !words.includes(w))
  ok(trigger + '：本场景词池的每个词都露过面', missing.length === 0, '缺 ' + missing.join(','))
}

console.log('\n[2] 词池与词形')
const allReturned = uniq(report.flatMap((r) => r.words))
ok('返回值都在 10 个自创鲸语词白名单内', allReturned.every((w) => ALL_WORDS.includes(w)), allReturned.join('、'))
ok('每个词都是 2–3 个汉字（只返回一个短词，不带标点）',
  allReturned.length > 0 && allReturned.every((w) => /^[\u4e00-\u9fa5]{2,3}$/.test(w)), allReturned.join('、'))
ok('按规格：「鲸动」只在总词池里，未分配到场景，不会被返回',
  !allReturned.includes('鲸动'), allReturned.join('、'))

// ======================================================================
console.log('\n[3] 冷却：now 不变时最多命中一次')
{
  resetWhaleWords()
  const T = 1_800_000_000_000
  const ctx = { trigger: 'reply', intimacy: 80 }
  const got = []
  for (let i = 0; i < 50; i++) got.push(pickWhaleWord(ctx, T))
  const words = got.filter((w) => w !== null)
  ok('同一时刻连调 50 次只命中 1 次', words.length === 1, '命中 ' + words.length + ' 次')
  ok('命中的词仍在本场景白名单内', words.every((w) => POOLS.reply.includes(w)), words.join(','))
  ok('冷却对其它场景同样生效（同一进程内共用冷却）',
    pickWhaleWord({ trigger: 'greet', intimacy: 100 }, T) === null)

  // ======================================================================
  console.log('\n[4] 时间推进：满 60 秒后可再次命中')
  const gap = pickWhaleWord(ctx, T + 59_999)
  ok('差 1 毫秒（59 999 ms）仍冷却', gap === null, show(gap))
  let again = null
  let againAt = null
  for (let k = 1; k <= 10; k++) {
    const at = T + 60_000 * k
    const w = pickWhaleWord(ctx, at)
    if (w !== null) { again = w; againAt = at; break }
  }
  ok('满 60 秒后能再次命中', again !== null, '词 ' + show(again))
  ok('两次命中间隔不少于 60 秒', againAt !== null && againAt - T >= 60_000, String(againAt === null ? null : againAt - T) + ' ms')
  ok('再次命中后立刻又进冷却', pickWhaleWord(ctx, againAt) === null)
}

// ======================================================================
console.log('\n[5] 亲密度分档（固定序列，不用随机）')
{
  const bands = [0, 29, 30, 69, 70, 100]
  const counts = bands.map((v) => sequence('greet', 100, v).length)
  ok('各档 100 次机会命中次数 = 20 / 20 / 45 / 45 / 70 / 70', counts.join(',') === '20,20,45,45,70,70', counts.join(','))
  ok('未传亲密度按最低档（20 / 100）', sequence('greet', 100, undefined).length === 20)
  ok('非法亲密度（NaN / 负数）落最低档',
    sequence('greet', 100, NaN).length === 20 && sequence('greet', 100, -10).length === 20)
  ok('亲密度高时命中频率 ≥ 低时（20 ≤ 45 ≤ 70）', counts[0] <= counts[2] && counts[2] <= counts[4], counts.join(','))
  ok('亲密度越高命中不少于低一档（单调不减）',
    counts[1] <= counts[2] && counts[3] <= counts[4])
}

// ======================================================================
console.log('\n[6] 非法 ctx：返回 null、不抛错、不占机会')
{
  resetWhaleWords()
  const T = 1_800_000_000_000
  const bad = [
    null, undefined, {}, { trigger: 'sing' }, { trigger: '' }, { trigger: 'GREET' },
    { trigger: 42 }, { trigger: 'toString' }, { trigger: '__proto__' },
    42, 'greet', [], true, () => 'greet',
  ]
  let threw = null
  let allNull = true
  for (const ctx of bad) {
    try {
      const w = pickWhaleWord(ctx, T)
      if (w !== null) allNull = false
    } catch (e) { threw = e }
  }
  ok('非法 ctx 全部返回 null', allNull)
  ok('非法 ctx 不抛错', threw === null, threw ? String(threw.message) : '')

  // 紧随其后跑 100 次合法调用（不 reset）：若非法调用偷占了机会或冷却，命中数就对不上
  const got = []
  for (let i = 0; i < 100; i++) {
    const w = pickWhaleWord({ trigger: 'idle', intimacy: 80 }, T + i * STEP)
    if (w !== null) got.push(w)
  }
  ok('非法调用不占用机会计数与冷却（100 次机会仍命中 70 次）', got.length === 70, '命中 ' + got.length + ' 次')
  ok('非法调用之后命中的词仍在本场景白名单内', got.every((w) => POOLS.idle.includes(w)))
}

// ======================================================================
console.log('\n[7] resetWhaleWords()：冷却与计数一起清零')
{
  const T = 1_900_000_000_000
  const ctx = { trigger: 'idle', intimacy: 0 }
  resetWhaleWords()
  let hits = 0
  for (let i = 0; i < 10; i++) if (pickWhaleWord(ctx, T) !== null) hits++
  ok('清零前：同一时刻 10 次调用只命中 1 次', hits === 1, '命中 ' + hits + ' 次')
  ok('清零前：冷却中返回 null', pickWhaleWord(ctx, T) === null)

  resetWhaleWords()
  let hitsAfter = 0
  for (let i = 0; i < 20; i++) if (pickWhaleWord(ctx, T) !== null) hitsAfter++
  ok('reset 后：同一时刻可重新命中（且仍只 1 次）', hitsAfter === 1, '命中 ' + hitsAfter + ' 次')
}

// ======================================================================
console.log('\n[8] 省略 now（走系统时间）')
{
  resetWhaleWords()
  let threw = null
  const got = []
  try {
    for (let i = 0; i < 10; i++) got.push(pickWhaleWord({ trigger: 'feed' }))
  } catch (e) { threw = e }
  ok('省略 now 不抛错', threw === null, threw ? String(threw.message) : '')
  ok('省略 now 时返回 string | null', got.every((w) => w === null || typeof w === 'string'), got.join(','))
  ok('省略 now 时也能命中（10 次内命中 1 次）', got.filter((w) => w !== null).length === 1)
}

// ======================================================================
console.log('\n[9] 源码约束（确定性 / 零浏览器依赖）')
{
  const raw = readFileSync(SRC_FILE, 'utf8')
  // 去掉注释再扫，避免把「不碰 localStorage」这类说明文字当成真依赖
  const codeOnly = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  ok('源码不用 Math.random（命中判定完全确定）', !/Math\.random/.test(codeOnly))
  ok('源码不碰 localStorage / DOM / 网络',
    !/localStorage|document\.|window\.|fetch\(/.test(codeOnly))
  ok('源码不 import 任何模块（零依赖）', !/^\s*(import|export)\s[^\n]*\bfrom\b/m.test(codeOnly) && !/\brequire\s*\(/.test(codeOnly))
}

// ======================================================================
// 收尾报告：每个 trigger 在 100 次固定时间步调用中的命中次数（reset 后独立跑）
console.log('\n每个 trigger 在 100 次固定时间步调用中的命中次数（步长 61 000 ms；各场景 reset 后独立跑）')
for (const r of report) {
  console.log('  ' + JSON.stringify(r))
}

if (fail) {
  console.error('\n❌ 失败 ' + fail + ' 项（通过 ' + pass + ' 项）')
  process.exit(1)
}
console.log('\n✅ 全部通过：' + pass + ' 项断言（dsh-chubby-whale 鲸语口癖 whale-speak）')
