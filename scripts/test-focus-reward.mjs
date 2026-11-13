/**
 * scripts/test-focus-reward.mjs —— 「反向驯化」专注奖励判定的离线回归
 *
 * 覆盖规格里的七条：
 *   ① 连续 45 分钟整点触发 1 次   ② 44 分 59 秒不触发   ③ 触发后同一段不再重复
 *   ④ 中途 active=false 重置、再专注 45 分钟又能触发
 *   ⑤ 心跳间隔超过 60 秒视为中断   ⑥ 非法输入不抛错
 *   ⑦ 纯函数：同输入两次结果相同、不改入参
 * 另加：起点为 0 的时间轴、自定义阈值/间隔、源码零依赖静态断言。
 *
 * 做法与 scripts/test-actions-rest.mjs 一致：esbuild 用 stdin 直引源码打成一个临时 ESM
 * （不碰 dist/、不联网），import 进来逐拍跑，跑完删临时目录。系统临时目录写不进去时
 * 退回仓库的 .tmp-tests/（与 scripts/test-belly.mjs 同一套兜底）。
 *
 * 用法：node scripts/test-focus-reward.mjs（全过 exit 0，失败 exit 1）
 */

import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const tmpDirs = []

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.error('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const MIN = 60_000
/** 用真实量级的时间戳（不是 0），避免和「0 = 未开始」的哨兵混淆 */
const T0 = 1_700_000_000_000

/** 从 from 起每 step 毫秒打一次 active 心跳，收集这一段里的奖励 */
function beat(state, from, to, step = MIN, opts) {
  const rewards = []
  for (let t = from; t <= to; t += step) {
    const r = updateFocus(state, { now: t, active: true }, opts)
    state = r.state
    if (r.reward) rewards.push(r.reward)
  }
  return { state, rewards }
}

let updateFocus = null

/** 打一次包：stdin 直引源码，产物落在 dir/focus-reward.mjs */
async function bundleInto(dir) {
  const outfile = join(dir, 'focus-reward.mjs')
  await build({
    stdin: {
      contents: "export * from './src/client/focus-reward.ts'\n",
      resolveDir: ROOT,
      sourcefile: 'focus-reward-entry.ts',
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

/**
 * 建临时目录并打包：优先系统临时目录；本机沙箱里 esbuild 的子进程没有项目外的写权限
 * （open …: Access is denied），这时退回仓库自带的 .tmp-tests/（.gitignore 已忽略 .tmp-*），
 * 两种都失败才算失败。跑完统一删掉。
 */
async function makeBundle() {
  const first = mkdtempSync(join(tmpdir(), 'chubby-focus-reward-'))
  tmpDirs.push(first)
  try {
    return await bundleInto(first)
  } catch {
    const base = join(ROOT, '.tmp-tests')
    mkdirSync(base, { recursive: true })
    const second = mkdtempSync(join(base, 'chubby-focus-reward-'))
    tmpDirs.push(second)
    return await bundleInto(second)
  }
}

// ---------- esbuild 打包（源码直打，产物只落在临时目录） ----------
try {
  const BUNDLE = await makeBundle()
  const mod = await import(pathToFileURL(BUNDLE).href)
  updateFocus = mod.updateFocus
  ok('esbuild 打包 src/client/focus-reward.ts（只落临时目录）', typeof updateFocus === 'function')
} catch (e) {
  ok('esbuild 打包 src/client/focus-reward.ts（只落临时目录）', false, String((e && e.message) || e))
}

if (typeof updateFocus !== 'function') {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
  console.error('\n❌ 无法加载 focus-reward 模块，共失败 ' + fail + ' 项')
  process.exit(1)
}

try {
  // ====================================================================
  console.log('\n[A] 首次心跳：只登记起点，绝不立刻发奖励')
  const first = updateFocus(null, { now: T0, active: true })
  ok('首次 active：起点与上一拍都是 now，rewarded=false，不发奖励',
    same(first.state, { streakStartAt: T0, lastTickAt: T0, rewarded: false }) && first.reward === null,
    JSON.stringify(first.state))
  const firstIdle = updateFocus(null, { now: T0, active: false })
  ok('首次 inactive：起点记 0（未开始），上一拍仍是 now，不发奖励',
    same(firstIdle.state, { streakStartAt: 0, lastTickAt: T0, rewarded: false }) && firstIdle.reward === null,
    JSON.stringify(firstIdle.state))

  // 外部手写（没有内部标记）的 0 起点按规格里的「未开始」哨兵处理
  const sentinel = updateFocus({ streakStartAt: 0, lastTickAt: 60_000, rewarded: false }, { now: 120_000, active: true })
  ok('外部手写的 0 起点按「未开始」处理，从这一拍重新计时',
    sentinel.state.streakStartAt === 120_000 && sentinel.state.lastTickAt === 120_000 && sentinel.reward === null,
    JSON.stringify(sentinel.state))

  const tiny = updateFocus(null, { now: T0, active: true }, { thresholdMs: 0 })
  ok('阈值调到 0，首次心跳也不当场发奖励', tiny.reward === null && tiny.state.rewarded === false,
    JSON.stringify(tiny))

  // ====================================================================
  console.log('\n[B] 连续专注：44 分 59 秒不发，45 分钟整发且只发一次')
  const b0 = updateFocus(null, { now: T0, active: true }).state
  const pre = beat(b0, T0 + MIN, T0 + 44 * MIN)
  ok('前 44 分钟没有奖励', pre.rewards.length === 0 && pre.state.rewarded === false,
    '奖励 ' + pre.rewards.length)

  const r45 = updateFocus(pre.state, { now: T0 + 45 * MIN, active: true })
  ok('第 45 分钟整触发一次，形如 { kind:"poem", at:now }',
    r45.reward && r45.reward.kind === 'poem' && r45.reward.at === T0 + 45 * MIN,
    JSON.stringify(r45.reward))
  ok('奖励后同一段标记 rewarded=true，起点不变、上一拍跟上',
    r45.state.rewarded === true && r45.state.streakStartAt === T0 && r45.state.lastTickAt === T0 + 45 * MIN,
    JSON.stringify(r45.state))
  ok('奖励分支没有修改传入的状态（副本判定）', pre.state.rewarded === false && r45.state !== pre.state)

  const after = beat(r45.state, T0 + 46 * MIN, T0 + 60 * MIN)
  ok('触发后继续坐到 60 分钟不再重复发', after.rewards.length === 0 && after.state.rewarded === true,
    '奖励 ' + after.rewards.length)

  const p0 = updateFocus(null, { now: T0, active: true }).state
  const nearly = beat(p0, T0 + 30_000, T0 + 44 * MIN + 30_000, 30_000)
  const lastSec = updateFocus(nearly.state, { now: T0 + 44 * MIN + 59_000, active: true })
  ok('44 分 59 秒（差 1 秒）仍不触发',
    nearly.rewards.length === 0 && lastSec.reward === null && lastSec.state.rewarded === false,
    JSON.stringify(lastSec.state))

  // ====================================================================
  console.log('\n[C] 切走重置：active=false 清零，再坐满 45 分钟又能触发')
  const reset = updateFocus(after.state, { now: T0 + 61 * MIN, active: false })
  ok('切走：起点归零、rewarded 复位，不发奖励',
    same(reset.state, { streakStartAt: 0, lastTickAt: T0 + 61 * MIN, rewarded: false }) && reset.reward === null,
    JSON.stringify(reset.state))

  const resume = updateFocus(reset.state, { now: T0 + 62 * MIN, active: true })
  ok('再回来：从回归这一拍重新起算，不继承上一轮',
    resume.state.streakStartAt === T0 + 62 * MIN && resume.state.rewarded === false && resume.reward === null,
    JSON.stringify(resume.state))

  const secondPre = beat(resume.state, T0 + 63 * MIN, T0 + 106 * MIN)
  ok('新一轮前 44 分钟仍不触发', secondPre.rewards.length === 0 && secondPre.state.rewarded === false,
    '奖励 ' + secondPre.rewards.length)

  const secondHit = updateFocus(secondPre.state, { now: T0 + 107 * MIN, active: true })
  ok('再专注满 45 分钟又能触发一次',
    secondHit.reward && secondHit.reward.at === T0 + 107 * MIN && secondHit.state.rewarded === true,
    JSON.stringify(secondHit.reward))
  ok('两轮奖励时刻不同（不是同一段的重复）',
    secondHit.reward && r45.reward && secondHit.reward.at !== r45.reward.at)

  // 基数很小（1_000_000 < 阈值）的时间轴：切走后回来必须从零起算，
  // 不能在「绝对第 45 分钟」提前发奖
  const TL = 1_000_000
  const lowStart = updateFocus(null, { now: TL, active: true }).state
  const lowPre = beat(lowStart, TL + MIN, TL + 20 * MIN)
  const lowReset = updateFocus(lowPre.state, { now: TL + 21 * MIN, active: false })
  const lowResume = updateFocus(lowReset.state, { now: TL + 22 * MIN, active: true })
  ok('低基数时间轴：切走后回来从回归这一拍重新起算',
    lowReset.state.streakStartAt === 0 && lowResume.state.streakStartAt === TL + 22 * MIN,
    JSON.stringify(lowResume.state))
  const lowAfter = beat(lowResume.state, TL + 23 * MIN, TL + 66 * MIN)
  const lowHit = updateFocus(lowAfter.state, { now: TL + 67 * MIN, active: true })
  ok('低基数时间轴：回归后坐满 45 分钟才触发，绝对第 45 分钟不误发',
    lowAfter.rewards.length === 0 && lowHit.reward && lowHit.reward.at === TL + 67 * MIN,
    JSON.stringify(lowHit.reward))

  // ====================================================================
  console.log('\n[D] 心跳间隔：正好 60 秒算连续，超过 60 秒算中断')
  const s0 = updateFocus(null, { now: T0, active: true }).state
  const at60 = updateFocus(s0, { now: T0 + 60_000, active: true })
  ok('间隔正好 60 秒：继续累计，起点不变', at60.state.streakStartAt === T0 && at60.reward === null,
    JSON.stringify(at60.state))

  const broken = updateFocus(s0, { now: T0 + 60_001, active: true })
  ok('间隔 60.001 秒：判中断并从这一拍重新计时',
    broken.state.streakStartAt === T0 + 60_001 && broken.state.lastTickAt === T0 + 60_001 && broken.reward === null,
    JSON.stringify(broken.state))

  const gapPre = beat(broken.state, T0 + 60_001 + MIN, T0 + 60_001 + 44 * MIN)
  ok('中断后前 44 分钟不触发', gapPre.rewards.length === 0, '奖励 ' + gapPre.rewards.length)

  const gapHit = updateFocus(gapPre.state, { now: T0 + 60_001 + 45 * MIN, active: true })
  ok('中断后重新坐满 45 分钟才触发',
    gapHit.reward && gapHit.reward.at === T0 + 60_001 + 45 * MIN,
    JSON.stringify(gapHit.reward))

  // ====================================================================
  console.log('\n[E] 非法输入：不抛错，按中断处理')
  const badCases = [
    [null, { now: NaN, active: true }, undefined],
    [null, { now: -1, active: true }, undefined],
    [null, { now: undefined, active: true }, undefined],
    [null, undefined, undefined],
    [undefined, null, undefined],
    [null, { now: T0, active: 'yes' }, undefined],
    [{ streakStartAt: NaN, lastTickAt: T0, rewarded: false }, { now: T0 + 1000, active: true }, undefined],
    [{ streakStartAt: T0, lastTickAt: undefined, rewarded: false }, { now: T0 + 1000, active: true }, undefined],
    [{ streakStartAt: -1, lastTickAt: T0, rewarded: 'x' }, { now: T0 + 1000, active: true }, undefined],
    [null, { now: T0, active: true }, { thresholdMs: NaN, idleGapMs: -1 }],
    [null, { now: T0, active: true }, null],
  ]
  let badThrew = null
  const badOuts = []
  try {
    for (const [p, i, o] of badCases) badOuts.push(updateFocus(p, i, o))
  } catch (e) {
    badThrew = e
  }
  ok('11 组非法输入全部不抛错', badThrew === null, String(badThrew && badThrew.message))

  const shapeOk = badOuts.length === badCases.length && badOuts.every((o) => o && o.state
    && typeof o.state.streakStartAt === 'number' && Number.isFinite(o.state.streakStartAt) && o.state.streakStartAt >= 0
    && typeof o.state.lastTickAt === 'number' && Number.isFinite(o.state.lastTickAt) && o.state.lastTickAt >= 0
    && typeof o.state.rewarded === 'boolean' && o.reward === null)
  ok('返回值形状始终合法（有限非负数 + 布尔标记，奖励为 null）', shapeOk)

  ok('now 非法（NaN / 负数 / undefined）→ 归零，按中断处理',
    badOuts.slice(0, 3).every((o) => same(o.state, { streakStartAt: 0, lastTickAt: 0, rewarded: false })),
    JSON.stringify(badOuts.slice(0, 3).map((o) => o.state)))

  ok('旧状态被写坏 → 当作没有旧状态，从当前拍重新计时',
    badOuts.slice(6, 9).every((o) => o.state.streakStartAt === T0 + 1000
      && o.state.lastTickAt === T0 + 1000 && o.state.rewarded === false && o.reward === null),
    JSON.stringify(badOuts.slice(6, 9).map((o) => o.state)))

  ok('active 不是布尔 true → 按未专注处理',
    badOuts[5].state.streakStartAt === 0 && badOuts[5].state.lastTickAt === T0 && badOuts[5].reward === null,
    JSON.stringify(badOuts[5].state))

  const fbFirst = updateFocus(null, { now: T0, active: true }, { thresholdMs: NaN, idleGapMs: -1 })
  const fbPre = beat(fbFirst.state, T0 + MIN, T0 + 44 * MIN, MIN, { thresholdMs: NaN, idleGapMs: -1 })
  const fbHit = updateFocus(fbPre.state, { now: T0 + 45 * MIN, active: true }, { thresholdMs: NaN, idleGapMs: -1 })
  ok('阈值/间隔参数非法 → 回落到默认的 45 分钟 / 60 秒',
    fbPre.rewards.length === 0 && fbHit.reward && fbHit.reward.at === T0 + 45 * MIN,
    JSON.stringify(fbHit.reward))

  // ====================================================================
  console.log('\n[F] 纯函数：同输入同结果，不改入参，零外部依赖')
  const prevFrozen = Object.freeze({ streakStartAt: T0, lastTickAt: T0 + MIN, rewarded: false })
  const inputFrozen = Object.freeze({ now: T0 + 2 * MIN, active: true })
  const optsFrozen = Object.freeze({ thresholdMs: 10 * MIN, idleGapMs: MIN })
  const snapshot = JSON.stringify([prevFrozen, inputFrozen, optsFrozen])
  let p1 = null
  let p2 = null
  let purityThrew = null
  try {
    p1 = updateFocus(prevFrozen, inputFrozen, optsFrozen)
    p2 = updateFocus(prevFrozen, inputFrozen, optsFrozen)
  } catch (e) {
    purityThrew = e
  }
  ok('冻结的入参也不抛错（证明没有任何写入）', purityThrew === null, String(purityThrew && purityThrew.message))
  ok('同输入两次结果完全相同', p1 && p2 && same(p1, p2))
  ok('入参保持原样', JSON.stringify([prevFrozen, inputFrozen, optsFrozen]) === snapshot)
  ok('返回新的状态对象，不是入参本身（两次之间也不共享）',
    p1 && p2 && p1.state !== prevFrozen && p2.state !== p1.state)
  ok('预期结果：继续累计、未到阈值不发奖励',
    p1 && p1.state.streakStartAt === T0 && p1.state.lastTickAt === T0 + 2 * MIN
    && p1.state.rewarded === false && p1.reward === null,
    JSON.stringify(p1))

  const src = readFileSync(join(ROOT, 'src/client/focus-reward.ts'), 'utf8')
  ok('源码零 import（也没有 require）',
    !/^\s*import\s/m.test(src) && !/\brequire\s*\(/.test(src))
  ok('源码不读全局时钟 / 存储 / DOM / 随机数',
    !/Date\.now|performance\.now|localStorage|sessionStorage|\bdocument\b|\bwindow\b|Math\.random/.test(src))

  // ====================================================================
  console.log('\n[G] 时间轴从 0 开始：第 45 分钟触发，46 分钟不重复')
  let zeroState = null
  const zeroHits = []
  for (let m = 0; m <= 46; m++) {
    const r = updateFocus(zeroState, { now: m * MIN, active: true })
    zeroState = r.state
    if (r.reward) zeroHits.push(r.reward.at)
  }
  ok('每分钟一拍从 0 到 46 分钟，只在第 45 分钟触发一次',
    zeroHits.length === 1 && zeroHits[0] === 45 * MIN, JSON.stringify(zeroHits))
  ok('46 分钟时仍在同一段、不重复发', zeroState.rewarded === true && zeroState.streakStartAt === 0,
    JSON.stringify(zeroState))
  ok('真实 0 起点的内部标记不可枚举：公开形状仍是三个字段',
    Object.keys(zeroState).sort().join(',') === 'lastTickAt,rewarded,streakStartAt')

  // 0 起点时间轴中途切走：回来从第 11 分钟重新起算，绝对第 45 分钟不许误发
  let zs = null
  for (let m = 0; m <= 10; m++) zs = updateFocus(zs, { now: m * MIN, active: true }).state
  const zReset = updateFocus(zs, { now: 10 * MIN, active: false })
  const zResume = updateFocus(zReset.state, { now: 11 * MIN, active: true })
  ok('0 起点时间轴切走后：回到第 11 分钟重新起算',
    zReset.state.streakStartAt === 0 && zResume.state.streakStartAt === 11 * MIN,
    JSON.stringify(zResume.state))
  const zPre = beat(zResume.state, 12 * MIN, 55 * MIN)
  const zHit = updateFocus(zPre.state, { now: 56 * MIN, active: true })
  ok('0 起点时间轴：绝对第 45 分钟不误发，回归后满 45 分钟才发',
    zPre.rewards.length === 0 && zHit.reward && zHit.reward.at === 56 * MIN,
    JSON.stringify(zHit.reward))

  // 0 时刻就是未专注：下一拍必须重新起算，不能把 0 当成真实起点
  const zIdle = updateFocus(null, { now: 0, active: false })
  const zBack = updateFocus(zIdle.state, { now: MIN, active: true })
  ok('0 时刻首次未专注 → 第 1 分钟回来从第 1 分钟起算',
    zIdle.state.streakStartAt === 0 && zBack.state.streakStartAt === MIN,
    JSON.stringify(zBack.state))

  // ====================================================================
  console.log('\n[H] 自定义阈值 / 间隔：按参数生效，不用默认值')
  const c0 = updateFocus(null, { now: T0, active: true }, { thresholdMs: 5 * MIN, idleGapMs: 2 * MIN }).state
  const c4 = beat(c0, T0 + 2 * MIN, T0 + 4 * MIN, 2 * MIN, { thresholdMs: 5 * MIN, idleGapMs: 2 * MIN })
  ok('阈值 5 分钟：第 4 分钟不触发', c4.rewards.length === 0 && c4.state.rewarded === false,
    '奖励 ' + c4.rewards.length)
  const c6 = updateFocus(c4.state, { now: T0 + 6 * MIN, active: true }, { thresholdMs: 5 * MIN, idleGapMs: 2 * MIN })
  ok('第 6 分钟首拍越过 5 分钟阈值 → 触发',
    c6.reward && c6.reward.at === T0 + 6 * MIN, JSON.stringify(c6.reward))
} catch (e) {
  fail++
  console.error('  ❌ 用例执行中抛错：' + String((e && e.stack) || e))
} finally {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
}

if (fail) {
  console.error('\n❌ focus-reward 失败 ' + fail + ' 项（通过 ' + pass + ' 项）')
  process.exit(1)
}
console.log('\n✅ focus-reward 全部通过：' + pass + ' 项')
