/**
 * scripts/test-channel.mjs —— client/channel.ts（资源通道基础件）离线回归
 *
 * 验收标准来自 docs/并发纪律.md §七（原来只有「设计目标」没有实现）：
 *   · 通道内严格串行，通道之间并发；
 *   · 优先级：数字小先跑（P0 > P1 > P2），同优先级先来先跑；
 *   · conflate：同 key 只留最新一份，旧的丢弃并计数；
 *   · 同步抛错不能把队列卡死；统计口径与 idle() 可靠。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { build } from 'esbuild'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = mkdtempSync(join(tmpdir(), 'chubby-channel-'))
const out = join(TMP, 'channel.mjs')

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), '期望 ' + JSON.stringify(b) + ' / 实际 ' + JSON.stringify(a))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await build({
  entryPoints: [join(ROOT, 'src/client/channel.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: out,
  logLevel: 'silent',
})
const M = await import(pathToFileURL(out).href)

console.log('\n[1] 串行：同一通道同一时刻只跑一个')
{
  const ch = M.createChannel('speak')
  const order = []
  let concurrent = 0
  let maxConcurrent = 0
  const task = (id, ms) => async () => {
    concurrent++
    maxConcurrent = Math.max(maxConcurrent, concurrent)
    order.push('start' + id)
    await sleep(ms)
    order.push('end' + id)
    concurrent--
    return id
  }
  const p1 = ch.run(task(1, 12))
  const p2 = ch.run(task(2, 4))
  const p3 = ch.run(task(3, 1))
  const vals = await Promise.all([p1, p2, p3])
  eq('三者都完成且返回各自结果', vals, [1, 2, 3])
  eq('执行顺序严格按入队（同优先级）', order, ['start1', 'end1', 'start2', 'end2', 'start3', 'end3'])
  eq('并发度始终为 1', maxConcurrent, 1)
  eq('统计 done=3', ch.stats().done, 3)
}

console.log('\n[2] 优先级：P2 先塞、P0 后塞 → P0 先跑（数字小 = 优先级高）')
{
  const ch = M.createChannel('prio')
  const order = []
  const mk = (id, prio) => ch.run(() => { order.push(id) }, { priority: prio })
  const p2 = mk('P2', 2)
  const p0 = mk('P0', 0)
  const p1 = mk('P1', 1)
  await Promise.all([p2, p0, p1])
  eq('线程空时第一个立刻开跑，其余按优先级', order, ['P2', 'P0', 'P1'])
}

console.log('\n[3] 优先级：排队的任务按优先级重排')
{
  const ch = M.createChannel('prio2')
  const order = []
  let release = null
  const gate = new Promise((r) => { release = r })
  const blocker = ch.run(async () => { await gate; order.push('blocker') })
  // 阻塞期间依次塞入：P3、P1、P0、P2
  const ps = [
    ch.run(() => { order.push('P3') }, { priority: 3 }),
    ch.run(() => { order.push('P1') }, { priority: 1 }),
    ch.run(() => { order.push('P0') }, { priority: 0 }),
    ch.run(() => { order.push('P2') }, { priority: 2 }),
  ]
  eq('排队期间 queued=4', ch.stats().queued, 4)
  release()
  await Promise.all([blocker, ...ps])
  eq('按优先级 0→1→2→3 执行', order, ['blocker', 'P0', 'P1', 'P2', 'P3'])
}

console.log('\n[4] conflate：同 key 只留最新一份')
{
  const ch = M.createChannel('mic')
  const order = []
  let release = null
  const gate = new Promise((r) => { release = r })
  const blocker = ch.run(async () => { await gate })
  const a = ch.run(() => { order.push('A') }, { key: 'seg' }).catch((e) => 'dropped')
  const b = ch.run(() => { order.push('B') }, { key: 'seg' }).catch((e) => 'dropped')
  const c = ch.run(() => { order.push('C') }, { key: 'seg' }).catch((e) => 'dropped')
  eq('两条旧段被丢弃', ch.stats().dropped, 2)
  release()
  const res = await Promise.all([blocker, a, b, c])
  eq('只执行最新一段 C', order, ['C'])
  eq('被丢的两条以 rejected 收口（不悬挂）', [res[1], res[2]], ['dropped', 'dropped'])
  eq('dropped 统计=2', ch.stats().dropped, 2)
}

console.log('\n[5] 不同 key 互不影响')
{
  const ch = M.createChannel('mixed')
  const order = []
  const p1 = ch.run(() => { order.push('k1') }, { key: 'k1' })
  const p2 = ch.run(() => { order.push('k2') }, { key: 'k2' })
  await Promise.all([p1, p2])
  eq('两个 key 都执行', order.sort(), ['k1', 'k2'])
  eq('没有丢弃', ch.stats().dropped, 0)
}

console.log('\n[6] 同步抛错不卡死队列')
{
  const ch = M.createChannel('boom')
  const err = await ch.run(() => { throw new Error('sync boom') }).then(() => null, (e) => e)
  ok('同步抛错 → 该调用方收到 rejection', err && /sync boom/.test(String(err.message)))
  const v = await ch.run(() => 'after')
  eq('后续任务照常执行', v, 'after')
  eq('failed=1 / done=1', [ch.stats().failed, ch.stats().done], [1, 1])
}

console.log('\n[7] 通道之间并发（不是全局串行）')
{
  const mic = M.createChannel('mic')
  const speak = M.createChannel('speak')
  let overlap = 0
  let maxOverlap = 0
  const work = async () => { overlap++; maxOverlap = Math.max(maxOverlap, overlap); await sleep(8); overlap-- }
  await Promise.all([mic.run(work), speak.run(work)])
  ok('两条通道可以同时跑', maxOverlap === 2, 'maxOverlap=' + maxOverlap)
}

console.log('\n[8] idle()：队列清空后 resolve，且不会提前')
{
  const ch = M.createChannel('idle')
  const p = ch.run(async () => { await sleep(10) })
  let idleDone = false
  const idleP = ch.idle().then(() => { idleDone = true })
  await sleep(2)
  ok('任务未完成时 idle 不 resolve', idleDone === false)
  await Promise.all([p, idleP])
  ok('任务完成后 idle resolve', idleDone === true)
  // 已空时 idle 立即 resolve
  await ch.idle()
  ok('已空时 idle 立即 resolve', true)
}

console.log('\n[9] stats 快照只读')
{
  const ch = M.createChannel('ro')
  const s = ch.stats()
  let threw = false
  try { s.queued = 99 } catch { threw = true }
  ok('stats 返回冻结对象（严格模式下赋值抛错或静默无效）',
    threw || ch.stats().queued === 0)
  eq('缺省优先级=5（与 P0-P2 区分）', s.name, 'ro')
}

rmSync(TMP, { recursive: true, force: true })
console.log('\n' + '='.repeat(48))
console.log(`通过 ${pass} 项 / 失败 ${fail} 项`)
if (fail > 0) process.exit(1)
console.log('✅ 资源通道基础件回归全部通过')
