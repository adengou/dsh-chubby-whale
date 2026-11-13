/**
 * scripts/test-bubble-queue.mjs —— 气泡线路调度器单测
 *
 * 跑法：node scripts/test-bubble-queue.mjs（失败 exit 1）
 * 用假定时器驱动，验证：优先级顺序、同级 FIFO、抢占、时长、去重、clear、
 * 五线集合、同道替换、瞬时丢弃、合并键、排队过期、队列上限、单条活着不变量。
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
  const { createBubbleScheduler, LANE_PRIORITY, MAX_QUEUED } = mod

  /** 假定时器：记录回调，手动 tick；clock 供 staleAfter 用 */
  function fakeTimers() {
    const tasks = []
    let seq = 0
    let clock = 0
    return {
      tasks,
      setTimeout: (fn, ms) => { const t = { id: ++seq, fn, ms }; tasks.push(t); return t.id },
      clearTimeout: (id) => { const i = tasks.findIndex((t) => t.id === id); if (i >= 0) tasks.splice(i, 1) },
      now: () => clock,
      advance: (ms) => { clock += ms },
      /** 触发最早的任务（模拟时间到） */
      tick() { const t = tasks.shift(); if (t) { t.fn(); return true } return false },
    }
  }
  function item(lane, text, ms, log) {
    return { lane, text, ms, start: () => log.push('start:' + lane + ':' + text), stop: () => log.push('stop:' + lane + ':' + text) }
  }

  console.log('\n[1] 常量（五条线：poem > voice > main > persona > tool）')
  ok('优先级 poem > voice > main > persona > tool',
    LANE_PRIORITY.poem > LANE_PRIORITY.voice && LANE_PRIORITY.voice > LANE_PRIORITY.main &&
    LANE_PRIORITY.main > LANE_PRIORITY.persona && LANE_PRIORITY.persona > LANE_PRIORITY.tool,
    JSON.stringify(LANE_PRIORITY))
  ok('线路集合正好五条（含语音线）', Object.keys(LANE_PRIORITY).sort().join(',') === 'main,persona,poem,tool,voice', Object.keys(LANE_PRIORITY).join(','))

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

  console.log('\n[6] 同道替换（念诗字幕：只保留最新一句）')
  {
    const log = []
    const t = fakeTimers()
    const s = createBubbleScheduler(t)
    const a = item('poem', '第1句', 8000, log); a.replace = true
    s.enqueue(a)
    const b = item('poem', '第2句', 8000, log); b.replace = true
    s.enqueue(b)
    ok('新字幕直接顶掉旧字幕，不排队',
      log.join('|') === 'start:poem:第1句|stop:poem:第1句|start:poem:第2句' && s.status().queued === 0, log.join('|'))
    const log2 = []
    const t2 = fakeTimers()
    const s2 = createBubbleScheduler(t2)
    s2.enqueue(item('main', '回复', 1000, log2))
    const c = item('poem', '第1句', 1000, log2); c.replace = true
    s2.enqueue(c)
    ok('替换条目仍按优先级抢占主气泡，且主气泡回队列不丢',
      log2.join('|') === 'start:main:回复|stop:main:回复|start:poem:第1句' && s2.status().queued === 1, log2.join('|'))
  }

  console.log('\n[7] 语音线优先于主气泡（新回合必须看得见）')
  {
    const log = []
    const t = fakeTimers()
    const s = createBubbleScheduler(t)
    s.enqueue(item('main', '上一轮回复', 6000, log))
    const v = item('voice', '（听到）背首诗', 3000, log); v.transient = true
    s.enqueue(v)
    ok('语音状态抢占正在显示的主气泡',
      log.join('|') === 'start:main:上一轮回复|stop:main:上一轮回复|start:voice:（听到）背首诗', log.join('|'))
    ok('被顶下的主气泡回队列（不丢）',
      s.status().queued === 1 && s.status().running === 'voice', JSON.stringify(s.status()))
    t.tick()
    ok('语音状态跑完 → 主气泡接着显示',
      log.join('|').endsWith('stop:voice:（听到）背首诗|start:main:上一轮回复'), log.join('|'))
    // 瞬时的语音状态被更高的诗词线抢占 → 丢弃，不回队列
    const log2 = []
    const t2 = fakeTimers()
    const s2 = createBubbleScheduler(t2)
    const v2 = item('voice', '（听到）…', 3000, log2); v2.transient = true
    s2.enqueue(v2)
    s2.enqueue(item('poem', '第1句', 1000, log2))
    ok('被诗词线抢占的语音状态丢弃、不回队列', s2.status().queued === 0 && s2.status().running === 'poem', JSON.stringify(s2.status()))
  }

  console.log('\n[8] 合并键（流式片段只留最新一段）')
  {
    const log = []
    const t = fakeTimers()
    const s = createBubbleScheduler(t)
    const a = item('main', '半句1', 3000, log); a.key = 'chat:stream'
    s.enqueue(a)
    const b = item('main', '半句2', 3000, log); b.key = 'chat:stream'
    s.enqueue(b)
    ok('同线同 key：新片段顶掉正在显示的旧片段，不排队',
      log.join('|') === 'start:main:半句1|stop:main:半句1|start:main:半句2' && s.status().queued === 0, log.join('|'))
    const c = item('main', '最终回复', 6000, log); c.key = 'chat:stream'
    s.enqueue(c)
    ok('最终回复同 key 替换半句，并保留自己的 6 秒',
      log.join('|').endsWith('stop:main:半句2|start:main:最终回复') && t.tasks[0].ms === 6000, log.join('|') + ' ms=' + (t.tasks[0] && t.tasks[0].ms))
    // 排队的同 key 条目也会被新条目清掉：只保留最新
    const log2 = []
    const t2 = fakeTimers()
    const s2 = createBubbleScheduler(t2)
    s2.enqueue(item('poem', '长诗', 9000, log2))
    const q1 = item('main', '排队1', 1000, log2); q1.key = 'chat:stream'
    s2.enqueue(q1)
    const q2 = item('main', '排队2', 1000, log2); q2.key = 'chat:stream'
    s2.enqueue(q2)
    ok('排队的旧片段被同 key 新片段清掉', s2.status().queued === 1, JSON.stringify(s2.status()))
  }

  console.log('\n[9] 排队过期（staleAfter）')
  {
    const log = []
    const t = fakeTimers()
    const s = createBubbleScheduler(t)
    s.enqueue(item('poem', '长诗', 9000, log))
    const v = item('voice', '听到', 3000, log); v.staleAfter = 4000
    s.enqueue(v)
    t.advance(5000)   // 等了 5 秒，超过 staleAfter
    t.tick()          // 长诗跑完 → 取队首
    ok('等过期的语音状态不再补播', log.join('|').indexOf('start:voice') < 0, log.join('|'))
    ok('过期项被清出队列', s.status().queued === 0, JSON.stringify(s.status()))
  }

  console.log('\n[10] 被抢占后沿用首次入队时间（不重置过期计时）')
  {
    const log = []
    const t = fakeTimers()
    const s = createBubbleScheduler(t)
    const m = item('main', '回复', 6000, log); m.staleAfter = 5000
    s.enqueue(m)
    t.advance(3000)
    s.enqueue(item('voice', '（听到）', 3000, log))   // 抢占 main，main 回队列
    t.advance(3000)                                   // 距首次入队已 6s > 5s
    t.tick()                                          // 语音跑完 → 取队首
    ok('超期的回复不再补播（抢占不重置计时）',
      log.filter((x) => x === 'start:main:回复').length === 1, log.join('|'))
    ok('超期条目已清出队列', s.status().queued === 0, JSON.stringify(s.status()))
    // 没超期时仍会接着显示
    const log2 = []
    const t2 = fakeTimers()
    const s2 = createBubbleScheduler(t2)
    const m2 = item('main', '回复2', 6000, log2); m2.staleAfter = 5000
    s2.enqueue(m2)
    t2.advance(1000)
    s2.enqueue(item('voice', '（听到）2', 3000, log2))
    t2.advance(1000)
    t2.tick()
    ok('未超期的回复在语音之后继续显示',
      log2.filter((x) => x === 'start:main:回复2').length === 2, log2.join('|'))
  }

  console.log('\n[11] 队列上限')
  {
    const log = []
    const t = fakeTimers()
    const s = createBubbleScheduler(t)
    s.enqueue(item('main', '占位', 60000, log))
    for (let i = 0; i < MAX_QUEUED + 10; i++) s.enqueue(item('tool', 'T' + i, 500, log))
    ok('排队数不超过 MAX_QUEUED', s.status().queued === MAX_QUEUED, String(s.status().queued))
    ok('溢出保留高优先级那条（main 仍在跑）', s.status().running === 'main', JSON.stringify(s.status()))
  }

  console.log('\n[12] 不变量：任何时刻只有一条活着')
  {
    let alive = 0
    let maxAlive = 0
    const t = fakeTimers()
    const s = createBubbleScheduler(t)
    const lanes = ['poem', 'main', 'voice', 'persona', 'tool']
    const mk = (lane, text, ms) => ({
      lane, text, ms,
      start: () => { alive++; if (alive > maxAlive) maxAlive = alive },
      stop: () => { alive-- },
    })
    for (let i = 0; i < 80; i++) {
      const it = mk(lanes[i % 5], 'x' + i, 100 + (i % 4) * 50)
      if (i % 3 === 0) it.transient = true
      if (i % 5 === 0) it.replace = true
      if (i % 7 === 0) it.key = 'k' + (i % 2)
      s.enqueue(it)
      if (i % 3 === 0) t.tick()
    }
    while (t.tick()) { }
    ok('80 条混合入队过程中从未出现两条同时显示（maxAlive=1）', maxAlive === 1, 'maxAlive=' + maxAlive + ' alive=' + alive)
    ok('清场后回到 0 条活着', alive === 0, String(alive))
  }

  console.log('\n[13] 同线 rank：点播字幕(10) 排在诗词弹幕(0) 前面')
  {
    const log = []
    const t = fakeTimers()
    const s = createBubbleScheduler(t)
    s.enqueue(item('poem', '占位诗', 9000, log))       // 先占住诗词线
    const e1 = item('poem', '弹幕A', 1000, log); e1.rank = 0
    s.enqueue(e1)
    const r1 = item('poem', '点播字幕', 1000, log); r1.rank = 10
    s.enqueue(r1)
    const e2 = item('poem', '弹幕B', 1000, log); e2.rank = 0
    s.enqueue(e2)
    const order = []
    for (let i = 0; i < 3; i++) { t.tick(); const last = log[log.length - 1]; if (last.indexOf('start:') === 0) order.push(last) }
    ok('rank 高的先出（点播先于两条弹幕）', order[0] === 'start:poem:点播字幕' && order.length === 3, order.join(' | '))
    ok('同 rank 之间仍是 FIFO（弹幕A 先于 弹幕B）', order[1] === 'start:poem:弹幕A' && order[2] === 'start:poem:弹幕B', order.join(' | '))
  }

  console.log('\n[14] 模块卫生')
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
