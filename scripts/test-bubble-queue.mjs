/**
 * scripts/test-bubble-queue.mjs —— 气泡线路调度器单测
 *
 * 跑法：node scripts/test-bubble-queue.mjs（失败 exit 1）
 * 用假定时器驱动，验证：优先级顺序、同级 FIFO、抢占、时长、去重、clear。
 */
import { build } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/..'
const TMP = join(ROOT, '.tmp-tests', 'bubble-queue-' + Date.now())
mkdirSync(TMP, { recursive: true })

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name) }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

try {
  const out = join(TMP, 'm.mjs')
  await build({
    stdin: { contents: "export * from './src/client/bubble-queue.ts'", resolveDir: ROOT, loader: 'ts' },
    bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
  })
  const mod = await import(pathToFileURL(out).href)
  const { createBubbleScheduler, LANE_PRIORITY } = mod

  /** 假定时器：记录回调，手动 tick */
  function fakeTimers() {
    const tasks = []
    let seq = 0
    return {
      tasks,
      setTimeout: (fn, ms) => { const t = { id: ++seq, fn, ms }; tasks.push(t); return t.id },
      clearTimeout: (id) => { const i = tasks.findIndex((t) => t.id === id); if (i >= 0) tasks.splice(i, 1) },
      /** 触发最早的任务（模拟时间到） */
      tick() { const t = tasks.shift(); if (t) { t.fn(); return true } return false },
    }
  }
  function item(lane, text, ms, log) {
    return { lane, text, ms, start: () => log.push('start:' + lane + ':' + text), stop: () => log.push('stop:' + lane + ':' + text) }
  }

  console.log('\n[1] 常量')
  ok('优先级 poem > main > persona > tool',
    LANE_PRIORITY.poem > LANE_PRIORITY.main && LANE_PRIORITY.main > LANE_PRIORITY.persona && LANE_PRIORITY.persona > LANE_PRIORITY.tool)

  console.log('\n[2] 同一时间只有一条活着（按优先级）')
  {
    const log = []
    const t = fakeTimers()
    const s = createBubbleScheduler(t)
    s.enqueue(item('tool', '解说', 1000, log))
    ok('第一条立即开始', log.join('|') === 'start:tool:解说', log.join('|'))
    s.enqueue(item('main', '对话', 1000, log))
    // main 优先级更高 → 抢占：tool 停、main 开
    ok('高优先级抢占（tool 停、main 开）', log.join('|') === 'start:tool:解说|stop:tool:解说|start:main:对话', log.join('|'))
    ok('调度器状态只有一条在跑', s.status().running === 'main', JSON.stringify(s.status()))
    ok('被抢占的 tool 回到队列', s.status().queued === 1, JSON.stringify(s.status()))
    t.tick() // main 跑完
    ok('main 跑完后 tool 继续', log.join('|').endsWith('stop:main:对话|start:tool:解说'), log.join('|'))
  }

  console.log('\n[3] 排队顺序：优先级高在前，同级 FIFO')
  {
    const log = []
    const t = fakeTimers()
    const s = createBubbleScheduler(t)
    s.enqueue(item('poem', '诗词', 500, log))  // 立即跑
    s.enqueue(item('tool', 'A', 500, log))
    s.enqueue(item('tool', 'B', 500, log))
    s.enqueue(item('persona', 'P', 500, log))
    // 当前 poem 跑完后，应依次 persona → tool A → tool B
    t.tick()
    // 再走两步：persona 停 → tool A 开（此时才出现 start:tool:A）
    t.tick(); t.tick()
    const joined = log.join('|')
    ok('poem 之后 persona 先于 tool', joined.indexOf('start:persona:P') >= 0 && joined.indexOf('start:tool:A') >= 0 && joined.indexOf('start:persona:P') < joined.indexOf('start:tool:A'), joined)
    ok('同级 tool 保持 FIFO（A 先于 B）', log.join('|').indexOf('start:tool:A') < log.join('|').indexOf('start:tool:B'), log.join('|'))
  }

  console.log('\n[4] 时长与去重')
  {
    const log = []
    const t = fakeTimers()
    const s = createBubbleScheduler(t)
    ok('空文本不入队', s.enqueue(item('main', '', 500, log)) === false)
    ok('同线同文本重复入队被忽略', s.enqueue(item('main', '你好', 500, log)) === true && s.enqueue(item('main', '你好', 500, log)) === false)
    ok('定时器按 ms 排队', t.tasks[0].ms === 500, String(t.tasks[0] && t.tasks[0].ms))
    t.tick()
    ok('跑完后 stop 被调用', log.join('|').includes('stop:main:你好'), log.join('|'))
  }

  console.log('\n[5] clear 停掉一切')
  {
    const log = []
    const t = fakeTimers()
    const s = createBubbleScheduler(t)
    s.enqueue(item('poem', '长诗', 9000, log))
    s.enqueue(item('tool', '解说', 1000, log))
    s.clear()
    ok('clear 后没有在跑/没有排队', s.status().running === null && s.status().queued === 0, JSON.stringify(s.status()))
    ok('clear 会 stop 当前项', log.join('|').includes('stop:poem:长诗'), log.join('|'))
  }

  console.log('\n[6] 模块卫生')
  {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(join(ROOT, 'src', 'client', 'bubble-queue.ts'), 'utf8')
    ok('无 DOM 调用', !/document\.|classList|textContent/.test(src))
    ok('无第三方 import', !/^import /m.test(src))
  }
} catch (err) {
  console.log('  ❌ 运行异常：' + String((err && err.stack) || err))
  fail++
} finally {
  rmSync(TMP, { recursive: true, force: true })
}

console.log('\n' + (fail === 0 ? '✅ 气泡调度器体检通过（' + pass + ' 项）' : '❌ 失败 ' + fail + ' 项 / 通过 ' + pass + ' 项'))
process.exit(fail === 0 ? 0 : 1)
