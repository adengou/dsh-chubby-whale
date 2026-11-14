/**
 * scripts/test-team-surface.mjs —— 鲸鱼看板展示面单测
 *
 * 跑法：node scripts/test-team-surface.mjs（失败 exit 1）
 * 覆盖：
 *   · 无 document 时 createTeamStatusBubble 优雅降级；
 *   · 假 document 下独立挂件的样式/文案/定位/基调/压暗/销毁；
 *   · TeamSurface 的 null / ambient / alert 路由、入队参数、同 key 去重、dispose；
 *   · 真实 bubbleScheduler 的 team 线路：优先级 person > team > tool、抢占与同 key 替换。
 *
 * 不引入 jsdom：用最小假 document（createElement 返回带 style/setAttribute/remove 的节点）。
 */
import { build } from 'esbuild'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/..'
const TMP = join(ROOT, '.tmp-tests', 'team-surface-' + Date.now())
mkdirSync(TMP, { recursive: true })

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name) }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 最小假 document：够 createTeamStatusBubble 用，不模拟布局/CSS 级联 */
function fakeDoc() {
  const body = {
    children: [],
    appendChild(node) {
      node.parentNode = body
      body.children.push(node)
      return node
    },
    removeChild(node) {
      const i = body.children.indexOf(node)
      if (i >= 0) body.children.splice(i, 1)
    },
  }
  return {
    body,
    createElement(tag) {
      const node = {
        tagName: String(tag).toUpperCase(),
        style: {},
        textContent: '',
        className: '',
        parentNode: null,
        attrs: {},
        setAttribute(k, v) { node.attrs[k] = String(v) },
        remove() {
          if (node.parentNode) {
            node.parentNode.removeChild(node)
            node.parentNode = null
          }
        },
      }
      return node
    },
  }
}

/** 假 status：记录调用顺序与参数 */
function fakeStatus(withDim = true) {
  const calls = []
  const status = {
    calls,
    show(text, tone) { calls.push(['show', text, tone]) },
    hide() { calls.push(['hide']) },
    updatePosition(rect) { calls.push(['updatePosition', rect]) },
    destroy() { calls.push(['destroy']) },
  }
  if (withDim) status.setDim = (dim) => calls.push(['setDim', dim])
  return status
}

/** 假 alert：记录显示/隐藏 */
function fakeAlert() {
  const calls = []
  return {
    calls,
    show(text, ms) { calls.push(['show', text, ms]) },
    hide() { calls.push(['hide']) },
  }
}

/** 假 scheduler：只收条目，不执行（执行语义交给真实调度器那一节） */
function fakeScheduler() {
  const entries = []
  return {
    entries,
    enqueue(entry) { entries.push(entry); return true },
  }
}

function fakeTimers() {
  const tasks = []
  let seq = 0
  let clock = 0
  return {
    tasks,
    setTimeout(fn, ms) { const t = { id: ++seq, fn, ms }; tasks.push(t); return t.id },
    clearTimeout(id) { const i = tasks.findIndex((t) => t.id === id); if (i >= 0) tasks.splice(i, 1) },
    now: () => clock,
    advance(ms) { clock += ms },
    tick() { const t = tasks.shift(); if (t) { t.fn(); return true } return false },
  }
}

try {
  const out = join(TMP, 'm.mjs')
  await build({
    stdin: {
      contents: [
        "export * from './src/client/team-status-bubble.ts'",
        "export * from './src/client/team-surface.ts'",
        "export * from './src/client/bubble-queue.ts'",
      ].join('\n'),
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    logLevel: 'silent',
  })
  const mod = await import(pathToFileURL(out).href)
  const {
    createTeamStatusBubble, TEAM_STATUS_Z_INDEX, TEAM_STATUS_MAX_WIDTH,
    createTeamSurface, ALERT_DEDUPE_MS,
    createBubbleScheduler, LANE_PRIORITY,
  } = mod

  console.log('\n[1] 模块边界与导出')
  {
    ok('四个入口都导出', typeof createTeamStatusBubble === 'function' &&
      typeof createTeamSurface === 'function' &&
      typeof createBubbleScheduler === 'function' &&
      typeof ALERT_DEDUPE_MS === 'number')
    const bubbleSrc = readFileSync(join(ROOT, 'src', 'client', 'team-status-bubble.ts'), 'utf8')
    const surfaceSrc = readFileSync(join(ROOT, 'src', 'client', 'team-surface.ts'), 'utf8')
    ok('team-status-bubble 不 import bubble.ts', !/from\s+['"]\.\/bubble\.js['"]/.test(bubbleSrc))
    ok('team-surface 不 import bubble.ts', !/from\s+['"]\.\/bubble\.js['"]/.test(surfaceSrc))
    ok('两个新文件都不 import React', !/from\s+['"]react['"]/.test(bubbleSrc + surfaceSrc))
    ok('team-surface 不直接碰 DOM', !/\bdocument\.|createElement|appendChild/.test(surfaceSrc))
  }

  console.log('\n[2] 无 document 时优雅降级')
  {
    ok('Node 环境确实没有全局 document', typeof document === 'undefined')
    let threw = null
    const b = createTeamStatusBubble()
    try {
      b.show('团队 2 件事', 'normal')
      b.show('告警', 'warn')
      b.updatePosition({ left: 1, top: 2, width: 3, height: 4 })
      b.setDim(true)
      b.hide()
      b.destroy()
      b.destroy()
      b.show('销毁后不再显示')
    } catch (e) { threw = e }
    ok('show/hide/updatePosition/setDim/destroy 全部 no-op 且不抛错', threw === null, threw && threw.stack)
  }

  console.log('\n[3] 独立挂件：样式与初始状态')
  {
    const doc = fakeDoc()
    const b = createTeamStatusBubble({ doc, zIndex: 12345 })
    ok('初始不创建节点（display:none 且未挂载）', doc.body.children.length === 0)
    b.show('2 个任务进行中', 'normal')
    ok('show 后创建并挂到 body', doc.body.children.length === 1)
    const el = doc.body.children[0]
    ok('class = chubby-team-status', el.className === 'chubby-team-status', el.className)
    ok('fixed 定位', el.style.position === 'fixed', el.style.position)
    ok('show 后 display:block', el.style.display === 'block', el.style.display)
    ok('z-index 取注入值', el.style.zIndex === '12345', el.style.zIndex)
    ok('max-width=240', el.style.maxWidth === TEAM_STATUS_MAX_WIDTH + 'px', el.style.maxWidth)
    ok('pointer-events:none（不抢点击）', el.style.pointerEvents === 'none', el.style.pointerEvents)
    ok('aria-hidden（不朗读）', el.attrs['aria-hidden'] === 'true', JSON.stringify(el.attrs))
    ok('半透明深色底', /rgba\(20,28,45,0\.72\)/.test(el.style.background), el.style.background)
    ok('小号圆角', el.style.borderRadius === '8px', el.style.borderRadius)
    ok('文案进入 textContent', el.textContent === '2 个任务进行中', el.textContent)
    ok('normal 基调边框为白色半透明', /255,255,255/.test(el.style.border), el.style.border)
    b.hide()
    ok('hide 只藏不删', el.style.display === 'none' && doc.body.children.length === 1, el.style.display)
    b.destroy()
    ok('destroy 从 body 移除', doc.body.children.length === 0)
    b.destroy()
    ok('destroy 幂等（再次调用不抛错）', true)
    b.show('销毁后不应重建')
    ok('销毁后 show 不重建节点', doc.body.children.length === 0, String(doc.body.children.length))
  }

  console.log('\n[4] 独立挂件：默认 z-index / 定位 / tone / 压暗')
  {
    const doc = fakeDoc()
    const b = createTeamStatusBubble({
      doc,
      position: () => ({ left: 100, top: 200, width: 300, height: 400 }),
    })
    b.show('干活 2/5', 'normal')
    const el = doc.body.children[0]
    ok('默认 z-index=2147483000', el.style.zIndex === String(TEAM_STATUS_Z_INDEX), el.style.zIndex)
    ok('鱼头右上方：left = 100 + 300*0.62', el.style.left === (100 + 300 * 0.62) + 'px', el.style.left)
    ok('鱼头右侧：top = 200 + 8', el.style.top === '208px', el.style.top)
    b.show('审批卡住了', 'warn')
    ok('warn 换边框色（琥珀）', /255,196,84/.test(el.style.border), el.style.border)
    ok('warn 文案更新', el.textContent === '审批卡住了', el.textContent)
    b.show('很安静', 'muted')
    ok('muted 压透明度', el.style.opacity === '0.72', el.style.opacity)
    b.setDim(true)
    ok('setDim(true) 进一步压暗到 0.45', el.style.opacity === '0.45', el.style.opacity)
    b.setDim(false)
    ok('setDim(false) 恢复 muted 的 0.72', el.style.opacity === '0.72', el.style.opacity)
    b.updatePosition({ left: 10, top: 20, width: 100, height: 50 })
    ok('updatePosition 重新换算', el.style.left === (10 + 100 * 0.62) + 'px' && el.style.top === '28px',
      el.style.left + '/' + el.style.top)
    b.updatePosition({ left: NaN, top: 0, width: 10, height: 10 })
    ok('非法矩形被忽略', el.style.top === '28px', el.style.top)
    b.destroy()
  }

  console.log('\n[5] surface：null 只隐藏看板')
  {
    const status = fakeStatus()
    const alert = fakeAlert()
    const scheduler = fakeScheduler()
    const surface = createTeamSurface({ scheduler, alert, status })
    surface.apply(null)
    ok('status.hide 被调用', status.calls.some((c) => c[0] === 'hide'), JSON.stringify(status.calls))
    ok('不发 alert', alert.calls.length === 0, JSON.stringify(alert.calls))
    ok('不入队', scheduler.entries.length === 0, String(scheduler.entries.length))
    surface.dispose()
  }

  console.log('\n[6] surface：ambient 显示并刷新定位')
  {
    const status = fakeStatus()
    const alert = fakeAlert()
    const scheduler = fakeScheduler()
    const rect = { left: 40, top: 50, width: 200, height: 300 }
    let positionCalls = 0
    const surface = createTeamSurface({
      scheduler, alert, status,
      position: () => { positionCalls++; return rect },
    })
    surface.apply({ ambient: { text: '2 个任务进行中', tone: 'normal' } })
    const showCall = status.calls.find((c) => c[0] === 'show')
    ok('status.show(text, tone)', !!showCall && showCall[1] === '2 个任务进行中' && showCall[2] === 'normal',
      JSON.stringify(showCall))
    const posCall = status.calls.find((c) => c[0] === 'updatePosition')
    ok('用 position() 更新看板位置', positionCalls === 1 && !!posCall && posCall[1] === rect,
      'calls=' + positionCalls + ' ' + JSON.stringify(posCall))
    ok('ambient 不再触发 hide', !status.calls.some((c) => c[0] === 'hide'), JSON.stringify(status.calls))
    ok('ambient 不发 alert、不入队', alert.calls.length === 0 && scheduler.entries.length === 0)
    surface.dispose()
  }

  console.log('\n[7] surface：alert 走 team 线路并可保留 ambient')
  {
    const status = fakeStatus()
    const alert = fakeAlert()
    const scheduler = fakeScheduler()
    const surface = createTeamSurface({ scheduler, alert, status })
    surface.apply({
      ambient: { text: '2 个任务进行中', tone: 'normal' },
      alert: { key: 'approval:1', text: '有 1 个审批待处理', ttl: 5000, rank: 7, anim: 'nudge' },
    })
    ok('ambient 仍然显示', status.calls.some((c) => c[0] === 'show' && c[1] === '2 个任务进行中'))
    ok('只入队一条 team 提醒', scheduler.entries.length === 1, String(scheduler.entries.length))
    const entry = scheduler.entries[0]
    ok('lane=team', entry.lane === 'team', entry.lane)
    ok('rank 原样透传', entry.rank === 7, String(entry.rank))
    ok('text 原样透传', entry.text === '有 1 个审批待处理', entry.text)
    ok('ms=alert.ttl', entry.ms === 5000, String(entry.ms))
    ok('key / replaceKey 都带 alert.key', entry.key === 'approval:1' && entry.replaceKey === 'approval:1',
      entry.key + '/' + entry.replaceKey)
    ok('start / stop 是函数', typeof entry.start === 'function' && typeof entry.stop === 'function')
    entry.start()
    ok('start 调 alert.show(text, ttl)', alert.calls.some((c) => c[0] === 'show' &&
      c[1] === '有 1 个审批待处理' && c[2] === 5000), JSON.stringify(alert.calls))
    ok('提醒期间看板被压暗', status.calls.some((c) => c[0] === 'setDim' && c[1] === true),
      JSON.stringify(status.calls))
    entry.stop()
    ok('stop 调 alert.hide', alert.calls.some((c) => c[0] === 'hide'), JSON.stringify(alert.calls))
    ok('提醒结束恢复看板亮度', status.calls.some((c) => c[0] === 'setDim' && c[1] === false),
      JSON.stringify(status.calls))
    surface.dispose()
  }

  console.log('\n[8] surface：同 key 10s 去重')
  {
    const status = fakeStatus()
    const alert = fakeAlert()
    const scheduler = fakeScheduler()
    const logs = []
    const surface = createTeamSurface({ scheduler, alert, status, logger: (m) => logs.push(m) })
    const realNow = Date.now
    let fakeNow = 1_000_000
    Date.now = () => fakeNow
    try {
      const presentation = { ambient: null, alert: { key: 'stuck:3', text: '任务 3 卡住了', ttl: 4000, rank: 9 } }
      surface.apply(presentation)
      surface.apply(presentation)
      ok('窗口内同 key 只入队一次', scheduler.entries.length === 1, String(scheduler.entries.length))
      ok('去重有日志', logs.some((m) => m.indexOf('去重') >= 0), JSON.stringify(logs))
      fakeNow += ALERT_DEDUPE_MS - 1
      surface.apply(presentation)
      ok('窗口内（9.999s）仍不重复', scheduler.entries.length === 1, String(scheduler.entries.length))
      fakeNow += 2
      surface.apply(presentation)
      ok('超过 10s 后同 key 可再次入队', scheduler.entries.length === 2, String(scheduler.entries.length))
      surface.apply({ ambient: null, alert: { key: 'stuck:4', text: '任务 4 卡住了', ttl: 4000, rank: 9 } })
      ok('不同 key 不受去重影响', scheduler.entries.length === 3, String(scheduler.entries.length))
    } finally {
      Date.now = realNow
      surface.dispose()
    }
  }

  console.log('\n[9] 真实调度器：team 线路优先级与替换')
  {
    ok('persona > team > tool', LANE_PRIORITY.persona > LANE_PRIORITY.team && LANE_PRIORITY.team > LANE_PRIORITY.tool,
      JSON.stringify(LANE_PRIORITY))
    ok('原有顺序不变（poem>voice>main>persona）',
      LANE_PRIORITY.poem > LANE_PRIORITY.voice && LANE_PRIORITY.voice > LANE_PRIORITY.main &&
      LANE_PRIORITY.main > LANE_PRIORITY.persona, JSON.stringify(LANE_PRIORITY))
    ok('仍保留原有五条线并新增 team', ['poem', 'voice', 'main', 'persona', 'tool', 'team']
      .every((lane) => typeof LANE_PRIORITY[lane] === 'number'), Object.keys(LANE_PRIORITY).join(','))

    const log = []
    const t = fakeTimers()
    const scheduler = createBubbleScheduler(t)
    const alert = fakeAlert()
    const status = fakeStatus()
    const surface = createTeamSurface({ scheduler, alert, status })
    // tool 正在跑 → team 提醒抢占（解说随时让路）
    scheduler.enqueue({
      lane: 'tool', text: '工具解说', ms: 1000,
      start: () => log.push('start:tool'), stop: () => log.push('stop:tool'),
    })
    surface.apply({ ambient: null, alert: { key: 'approval:9', text: '有审批', ttl: 3000, rank: 5 } })
    ok('team 抢占正在跑的 tool', scheduler.status().running === 'team' && log.join('|').includes('stop:tool'),
      log.join('|') + ' ' + JSON.stringify(scheduler.status()))
    ok('team 提醒真的显示（alert.show）', alert.calls.some((c) => c[0] === 'show' && c[1] === '有审批'),
      JSON.stringify(alert.calls))

    // persona 高于 team → 抢占，team 提醒先收起来，回队列等待
    scheduler.enqueue({
      lane: 'persona', text: '早安', ms: 1000,
      start: () => log.push('start:persona'), stop: () => log.push('stop:persona'),
    })
    ok('persona 抢占 team', scheduler.status().running === 'persona', JSON.stringify(scheduler.status()))
    ok('被抢占的提醒先 hide', alert.calls.some((c) => c[0] === 'hide'), JSON.stringify(alert.calls))
    ok('team 条目按原优先级回队列（不丢）', scheduler.status().queued >= 2, JSON.stringify(scheduler.status()))

    t.tick() // persona 跑完 → team 回来
    ok('persona 跑完后 team 提醒继续', scheduler.status().running === 'team', JSON.stringify(scheduler.status()))
    ok('继续时重新 alert.show', alert.calls.filter((c) => c[0] === 'show').length === 2,
      JSON.stringify(alert.calls))
    scheduler.clear()
    surface.dispose()
  }

  console.log('\n[10] 真实调度器：同线同 key 只保留最新')
  {
    const log = []
    const t = fakeTimers()
    const scheduler = createBubbleScheduler(t)
    const mk = (text, ms) => ({
      lane: 'team', text, ms, key: 'alert:k',
      start: () => log.push('start:' + text), stop: () => log.push('stop:' + text),
    })
    scheduler.enqueue(mk('旧提醒', 1000))
    scheduler.enqueue(mk('新提醒', 1000))
    ok('同 key 新提醒顶掉旧提醒，不排队',
      log.join('|') === 'start:旧提醒|stop:旧提醒|start:新提醒' && scheduler.status().queued === 0,
      log.join('|') + ' ' + JSON.stringify(scheduler.status()))
    scheduler.clear()
  }

  console.log('\n[11] dispose：销毁看板、清提醒定时器、幂等')
  {
    const status = fakeStatus()
    const alert = fakeAlert()
    const scheduler = fakeScheduler()
    const surface = createTeamSurface({ scheduler, alert, status })
    surface.apply({ ambient: { text: '看板', tone: 'normal' }, alert: { key: 'k1', text: '提醒', ttl: 40, rank: 1 } })
    const entry = scheduler.entries[0]
    entry.start()
    ok('提醒开始后已压暗', status.calls.some((c) => c[0] === 'setDim' && c[1] === true))
    surface.dispose()
    ok('dispose 销毁看板', status.calls.some((c) => c[0] === 'destroy'), JSON.stringify(status.calls))
    ok('dispose 收起正在显示的提醒', alert.calls.some((c) => c[0] === 'hide'), JSON.stringify(alert.calls))
    const before = status.calls.length
    await sleep(80)
    ok('dispose 清掉提醒恢复定时器（80ms 内无新 setDim）', status.calls.length === before,
      JSON.stringify(status.calls.slice(before)))
    surface.dispose()
    ok('dispose 幂等（只 destroy 一次）', status.calls.filter((c) => c[0] === 'destroy').length === 1,
      JSON.stringify(status.calls))
    surface.apply({ ambient: { text: '迟到', tone: 'normal' } })
    ok('dispose 后 apply 不再影响任何端口', scheduler.entries.length === 1 &&
      !status.calls.some((c) => c[0] === 'show' && c[1] === '迟到'), JSON.stringify(status.calls))
  }

  console.log('\n[12] dispose 后队列里的提醒不再冒出来')
  {
    const status = fakeStatus()
    const alert = fakeAlert()
    const scheduler = fakeScheduler()
    const surface = createTeamSurface({ scheduler, alert, status })
    surface.apply({ ambient: null, alert: { key: 'k2', text: '排队中的提醒', ttl: 1000, rank: 1 } })
    const entry = scheduler.entries[0]
    surface.dispose()
    const showsBefore = alert.calls.filter((c) => c[0] === 'show').length
    entry.start()
    entry.stop()
    ok('dispose 后 start 不再显示提醒', alert.calls.filter((c) => c[0] === 'show').length === showsBefore,
      JSON.stringify(alert.calls))
    ok('dispose 后 stop 不抛错', true)
  }

  console.log('\n[13] status 没有 setDim 时仍可用')
  {
    const status = fakeStatus(false)
    const alert = fakeAlert()
    const scheduler = fakeScheduler()
    const surface = createTeamSurface({ scheduler, alert, status })
    let threw = null
    try {
      surface.apply({ ambient: { text: '看板', tone: 'normal' }, alert: { key: 'k3', text: '提醒', ttl: 1000, rank: 1 } })
      scheduler.entries[0].start()
      scheduler.entries[0].stop()
      surface.dispose()
    } catch (e) { threw = e }
    ok('缺 setDim 时提醒照常显示/收起，不抛错', threw === null && alert.calls.some((c) => c[0] === 'show') &&
      alert.calls.some((c) => c[0] === 'hide'), threw && threw.stack)
  }
} catch (err) {
  console.log('  ❌ 运行异常：' + String((err && err.stack) || err))
  fail++
} finally {
  rmSync(TMP, { recursive: true, force: true })
}

console.log('\n' + (fail === 0
  ? '✅ 鲸鱼看板展示面体检通过（' + pass + ' 项）'
  : '❌ 失败 ' + fail + ' 项 / 通过 ' + pass + ' 项'))
process.exit(fail === 0 ? 0 : 1)
