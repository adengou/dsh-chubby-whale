/**
 * scripts/test-belly.mjs —— 「鱼账本 → 肥鲸进食参数」纯计算的离线回归
 *
 * 覆盖规格里的七条：① 首次基线 ② 增量长大 ③ 无增量不倒退 ④ 重置回基线
 * ⑤ 1.12 上限 ⑥ 非法输入不抛错 ⑦ 同输入同结果；外加 chewPlan 的爱心分档与体型夹取。
 *
 * 做法与 scripts/test-actions-rest.mjs 一致：esbuild 把 src/client/belly.ts 打成一个临时 ESM
 * （源码直打，不碰 dist/、不联网），再 import 进来跑，跑完删临时目录。
 * 临时目录优先 os.tmpdir()；本机沙箱里 esbuild 的可执行子进程没有项目外的写权限
 * （open …: Access is denied），这时退回仓库自带的 .tmp-tests/（.gitignore 已忽略 .tmp-*）。
 *
 * 用法：node scripts/test-belly.mjs（全过 exit 0，失败 exit 1）
 */

import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.error('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}
/** 浮点比较：体型是 1 + 0.12 * ratio 算出来的，不指望二进制完全相等 */
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const inRange = (s) => typeof s === 'number' && s >= 1 && s <= 1.12

/** 打一次包：stdin 直引源码，产物落在 dir/belly.mjs */
async function bundleInto(dir) {
  const outfile = join(dir, 'belly.mjs')
  await build({
    stdin: {
      contents: "export * from './src/client/belly.ts'\n",
      resolveDir: ROOT,
      sourcefile: 'belly-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    charset: 'utf8',
    logLevel: 'silent',
    outfile,
  })
  return outfile
}

/** 建临时目录并打包：系统临时目录不行就退回项目内 .tmp-tests/（两种都失败才算失败） */
const tmpDirs = []
async function makeBundle() {
  const first = mkdtempSync(join(tmpdir(), 'chubby-belly-'))
  tmpDirs.push(first)
  try {
    return await bundleInto(first)
  } catch {
    const base = join(ROOT, '.tmp-tests')
    mkdirSync(base, { recursive: true })
    const second = mkdtempSync(join(base, 'chubby-belly-'))
    tmpDirs.push(second)
    return await bundleInto(second)
  }
}

let digest = null
let chewPlan = null

try {
  // ---------- 打包（产物只落临时目录） ----------
  const BUNDLE = await makeBundle()
  const mod = await import(pathToFileURL(BUNDLE).href)
  digest = mod.digest
  chewPlan = mod.chewPlan
  ok('esbuild 打包 src/client/belly.ts，导出 digest / chewPlan',
    typeof digest === 'function' && typeof chewPlan === 'function')

  // ---------- ① 首次调用：基线合理 ----------
  console.log('\n[①] 首次调用（以当前总量为基线）')
  const zero = digest(null, 0)
  ok('0 token → 体型 1.0 / 0 口 / 不饱',
    zero.scale === 1 && zero.chewCount === 0 && zero.full === false, JSON.stringify(zero))
  ok('状态形状只有三个字段', same(Object.keys(zero), ['scale', 'chewCount', 'full']), JSON.stringify(Object.keys(zero)))

  const first = digest(null, 120000)
  ok('12 万 token → 12 口（每 1 万一口）', first.chewCount === 12, JSON.stringify(first))
  ok('12 万 token → 体型略鼓、未封顶', first.scale > 1 && first.scale < 1.12, String(first.scale))
  ok('12 万 token → 还没吃饱', first.full === false)

  const justFull = digest(null, 500000)
  ok('50 万 token → 刚好吃饱（阈值含等于）', justFull.full === true && justFull.chewCount === 50, JSON.stringify(justFull))
  ok('49.9 万 token → 还差一口、没饱', digest(null, 499999).full === false)
  ok('99 万 token → 99 口、仍饱', digest(null, 990000).chewCount === 99 && digest(null, 990000).full === true)
  ok('首次的体型随总量单调涨（0 < 12 万 < 30 万）',
    zero.scale < first.scale && first.scale < digest(null, 300000).scale,
    [zero.scale, first.scale, digest(null, 300000).scale].join(' < '))

  // ---------- ② 增量：口数与体型都变多 ----------
  console.log('\n[②] 增量（与 prev 比较）')
  const a = digest(null, 100000)
  const b = digest(a, 200000)
  ok('10 万 → 20 万：口数 10 → 20', a.chewCount === 10 && b.chewCount === 20, JSON.stringify({ a, b }))
  ok('10 万 → 20 万：体型变大', b.scale > a.scale, a.scale + ' → ' + b.scale)
  ok('增量后体型仍在合法区间', inRange(b.scale), String(b.scale))

  const c = digest(b, 260000)
  ok('连续三次（10 万 → 20 万 → 26 万）单调不降', c.chewCount > b.chewCount && c.scale > b.scale,
    JSON.stringify({ b, c }))

  const stepwise = digest(digest(digest(digest(null, 0), 40000), 80000), 120000)
  const oneShot = digest(null, 120000)
  ok('分四次喂到 12 万 与 一次喂到 12 万 结果一致（只由总量决定）',
    same(stepwise, oneShot), JSON.stringify({ stepwise, oneShot }))

  // ---------- ③ 无增量：不倒退 ----------
  console.log('\n[③] 无增量（原样返回，不倒退）')
  ok('同总量重复调用：结果与上次逐字段相同', same(digest(b, 200000), b), JSON.stringify(digest(b, 200000)))
  const sameBucket = digest(b, 200500)
  ok('同一口内多 500 token：口数不变、体型不降',
    sameBucket.chewCount === b.chewCount && sameBucket.scale >= b.scale, JSON.stringify(sameBucket))
  ok('同一口内重复调用仍稳定（不抖）', same(digest(b, 200500), sameBucket))
  const inflated = { scale: 1.12, chewCount: 20, full: false }
  ok('旧状态体型更高（1.12）：没增量时不被总量拉低',
    digest(inflated, 200000).scale === 1.12, JSON.stringify(digest(inflated, 200000)))
  ok('prev 已饱、总量同值：保持饱（不回退）',
    digest({ scale: 1.12, chewCount: 60, full: true }, 600000).full === true)

  // ---------- ④ 重置：回到基线 ----------
  console.log('\n[④] 总量变小（重置 / 清理）')
  const big = digest(null, 900000)
  const reset = digest(big, 5000)
  const base5k = digest(null, 5000)
  ok('90 万 → 5000：结果等于「首次喂 5000」（回基线）', same(reset, base5k), JSON.stringify(reset))
  ok('90 万时是饱的，重置后不再是', big.full === true && reset.full === false)
  ok('重置后口数清零', reset.chewCount === 0, JSON.stringify(reset))
  ok('重置后体型落回 1.0 附近（不再挂着 1.12）', reset.scale < 1.01, String(reset.scale))
  const regrow = digest(reset, 60000)
  ok('重置后重新累积：6 口且体型重新变大', regrow.chewCount === 6 && regrow.scale > reset.scale,
    JSON.stringify({ reset, regrow }))

  // ---------- ⑤ 上限：1.12 不被突破 ----------
  console.log('\n[⑤] 体型上限')
  const huge = digest(null, 1e9)
  ok('10 亿 token → 体型正好封顶 1.12（溢出不报错）', huge.scale === 1.12, String(huge.scale))
  ok('封顶后口数照记（不截断账）', huge.chewCount === 100000, String(huge.chewCount))
  const chained = digest(digest(huge, 2e9), 3e9)
  ok('继续喂 20 亿 / 30 亿 → 仍是 1.12，不超过', chained.scale === 1.12)
  ok('脏状态 scale=9 → 夹回 1.12', digest({ scale: 9, chewCount: 3, full: false }, 50000).scale === 1.12)
  const sweep = [0, 1, 9999, 10000, 299999, 300000, 300001, 500000, 1e6, 1e12, Number.MAX_SAFE_INTEGER]
    .map((t) => digest(null, t).scale)
  ok('各档位体型都落在 [1, 1.12]', sweep.every(inRange), JSON.stringify(sweep))
  ok('封顶点在 30 万（30 万之前线性、之后恒定）',
    near(digest(null, 150000).scale, 1.06) && near(digest(null, 300000).scale, 1.12)
    && near(digest(null, 450000).scale, 1.12),
    JSON.stringify([digest(null, 150000).scale, digest(null, 300000).scale]))

  // ---------- ⑥ 非法输入：不抛错、结果合理 ----------
  console.log('\n[⑥] 非法输入（NaN / 负数 / undefined / 别的类型）')
  const badTokens = [NaN, -1, -1e9, undefined, null, '120000', 'abc', {}, [], true, -Infinity]
  let badThrew = null
  let badResults = []
  try { badResults = badTokens.map((t) => digest(null, t)) } catch (e) { badThrew = e }
  ok('非法总量一律不抛错', badThrew === null, badThrew ? String(badThrew.message) : '')
  ok('NaN / 负数 / undefined / 数字字符串 / 对象 / 布尔 → 全部按 0（等于基线）',
    badResults.every((r) => same(r, zero)),
    JSON.stringify(badResults.map((r) => r.scale)))

  let infThrew = null
  let inf = null
  try { inf = digest(null, Infinity) } catch (e) { infThrew = e }
  ok('Infinity → 不抛错且按「撑到顶」处理', infThrew === null && inf.scale === 1.12 && inf.full === true,
    JSON.stringify(inf))
  ok('Infinity 的口数仍是有限整数', Number.isFinite(inf.chewCount) && Number.isInteger(inf.chewCount),
    String(inf.chewCount))

  const badPrev = [undefined, null, 'x', 42, true, [], [1, 2], {}, { scale: NaN, chewCount: NaN, full: 'yes' }]
  let prevThrew = null
  let prevResults = []
  try { prevResults = badPrev.map((p) => digest(p, 120000)) } catch (e) { prevThrew = e }
  ok('坏 prev 一律不抛错', prevThrew === null, prevThrew ? String(prevThrew.message) : '')
  ok('坏 prev 按首次处理（等于基线 12 口）', prevResults.every((r) => same(r, first)),
    JSON.stringify(prevResults.map((r) => r.chewCount)))
  ok('负数/NaN 总量配坏 prev 也不抛错', same(digest({ scale: NaN }, -5), zero))

  // ---------- ⑦ 纯函数：同输入同输出、不改入参 ----------
  console.log('\n[⑦] 纯函数')
  ok('digest 同输入两次结果完全相同', same(digest(a, 250000), digest(a, 250000)))
  ok('chewPlan 同输入两次结果完全相同', same(chewPlan(b), chewPlan(b)))
  const prevObj = { scale: 1.05, chewCount: 10, full: false }
  const prevSnapshot = JSON.stringify(prevObj)
  digest(prevObj, 300000)
  ok('digest 不修改传入的 prev', JSON.stringify(prevObj) === prevSnapshot, JSON.stringify(prevObj))
  const planInput = { scale: 1.06, chewCount: 12, full: false }
  const planSnapshot = JSON.stringify(planInput)
  chewPlan(planInput)
  ok('chewPlan 不修改传入的 state', JSON.stringify(planInput) === planSnapshot)
  ok('返回值是新对象（不把 prev 原引用递出去）', digest(prevObj, 300000) !== prevObj)

  // ---------- ⑧ chewPlan：0~5 颗心 + 体型夹取 ----------
  console.log('\n[⑧] chewPlan（动画参数）')
  const plan0 = chewPlan(zero)
  ok('0 口 → 0 颗心、体型 1.0', plan0.hearts === 0 && plan0.scale === 1, JSON.stringify(plan0))
  ok('12 口（12 万）→ 2 颗心', chewPlan(first).hearts === 2, JSON.stringify(chewPlan(first)))
  ok('吃饱（50 万）→ 5 颗心', chewPlan(justFull).hearts === 5, JSON.stringify(chewPlan(justFull)))
  ok('chewPlan 只返回 scale / hearts 两个字段', same(Object.keys(plan0), ['scale', 'hearts']))
  ok('chewPlan 的 scale 与 state.scale 一致', near(chewPlan(first).scale, first.scale))

  const planSweep = [0, 1, 9999, 10000, 49999, 50000, 149999, 150000, 299999, 300000, 499999, 500000, 1e6, 1e9]
    .map((t) => chewPlan(digest(null, t)))
  ok('全档位 hearts 都是 0~5 的整数',
    planSweep.every((p) => Number.isInteger(p.hearts) && p.hearts >= 0 && p.hearts <= 5),
    JSON.stringify(planSweep.map((p) => p.hearts)))
  ok('hearts 随 token 单调不降（心只增不减）',
    planSweep.every((p, i) => i === 0 || p.hearts >= planSweep[i - 1].hearts),
    JSON.stringify(planSweep.map((p) => p.hearts)))
  ok('全档位 scale 都在 [1, 1.12]', planSweep.every((p) => inRange(p.scale)),
    JSON.stringify(planSweep.map((p) => p.scale)))

  const ladder = [0, 1, 4, 5, 14, 15, 29, 30, 49, 50].map((n) => chewPlan({ scale: 1, chewCount: n, full: false }).hearts)
  ok('口数分档：0→0、1~4→1、5~14→2、15~29→3、30 以上→4',
    same(ladder, [0, 1, 1, 2, 2, 3, 3, 4, 4, 4]), JSON.stringify(ladder))
  ok('full 单独生效（口数 0 但饱了 → 至少 1 颗心）',
    chewPlan({ scale: 1, chewCount: 0, full: true }).hearts === 1)
  ok('full 只在原有颗数上 +1（15 口 → 3，饱了 → 4）',
    chewPlan({ scale: 1, chewCount: 15, full: true }).hearts === 4)
  ok('hearts 不超过 5（1000 口 + 饱）', chewPlan({ scale: 1.12, chewCount: 1000, full: true }).hearts === 5)
  ok('chewPlan 体型夹取：1.5 → 1.12、0.5 → 1.0、NaN → 1.0',
    chewPlan({ scale: 1.5, chewCount: 0, full: false }).scale === 1.12
    && chewPlan({ scale: 0.5, chewCount: 0, full: false }).scale === 1
    && chewPlan({ scale: NaN, chewCount: 0, full: false }).scale === 1)
  let planThrew = null
  let planNull = null
  try { planNull = chewPlan(null) } catch (e) { planThrew = e }
  ok('chewPlan(null) 不抛错，给安全默认值', planThrew === null && same(planNull, { scale: 1, hearts: 0 }),
    JSON.stringify(planNull))
  ok('chewPlan 对脏 chewCount（字符串/负/NaN）不抛错',
    chewPlan({ scale: 1, chewCount: '12', full: false }).hearts === 2
    && chewPlan({ scale: 1, chewCount: -3, full: false }).hearts === 0
    && chewPlan({ scale: 1, chewCount: NaN, full: false }).hearts === 0)
} catch (e) {
  fail++
  console.error('  ❌ 用例执行中抛错：' + String((e && e.stack) || e))
} finally {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
}

if (fail) {
  console.error('\n失败 ' + fail + ' 项（通过 ' + pass + ' 项）')
  process.exit(1)
}
console.log('\n✅ belly 全部通过：' + pass + ' 项')
