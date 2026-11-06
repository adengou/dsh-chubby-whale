/**
 * scripts/test-render-layer.mjs —— 「分身·客户端渲染层」独立回归（不并入 npm test）
 *
 * 覆盖本轮审查里真正有证据的四处（其余为纯函数不变量）：
 *   A. stage.ts：bindDragInput 的 window 捕获监听在 dispose 时必须撤干净 ——
 *      add(..., true) 与 removeEventListener 的 capture 参数必须一致，
 *      否则每挂载/卸载一次就漏 4 个监听（闭包一直攥着旧 stage 元素与回调）。
 *   B. stage.ts：多点触控 / 指针过滤 / 拖拽数学边界（NaN、贴边、视口比鱼小）。
 *   C. anim.ts：绘制异常必须能重试（旧实现异常一抛，rAF 链就断了，鱼永远冻结）；
 *      连续异常要有上限，别拿 60fps 空转烧 CPU；stop() 要撤掉 rAF 与 resize 监听。
 *   D. styles.ts：菜单样式在无 window（SSR / 打桩环境）下不能抛错，
 *      菜单坐标 NaN 不能生成 "NaNpx"（浏览器会整条忽略，菜单跑到左上角）。
 *
 * 纯离线：DOM / rAF / Image / localStorage 全部打桩，结束还原；不联网、不碰 dist。
 * 用法：node scripts/test-render-layer.mjs   （失败退出码 1）
 */

import { register } from 'node:module'

register(new URL('./ts-resolve.mjs', import.meta.url))

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.error('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

const stage = await import('../src/client/stage.ts')
const styles = await import('../src/client/styles.ts')
const look = await import('../src/client/look.ts')
const anim = await import('../src/client/anim.ts')
const render = await import('../src/client/render.ts')

/** 规格口径的事件目标桩：removeEventListener 按 (type, fn, capture) 三元组匹配 */
class FakeTarget {
  constructor() { this.listeners = [] }
  addEventListener(type, fn, opts) {
    const capture = typeof opts === 'boolean' ? opts : !!(opts && opts.capture)
    this.listeners.push({ type, fn, capture })
  }
  removeEventListener(type, fn, opts) {
    const capture = typeof opts === 'boolean' ? opts : !!(opts && opts.capture)
    const i = this.listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture)
    if (i >= 0) this.listeners.splice(i, 1)
  }
  count() { return this.listeners.length }
  fire(type, ev, capture) {
    const ls = this.listeners.filter((l) => l.type === type && l.capture === !!capture)
    for (const l of ls) l.fn(ev)
    return ls.length
  }
}

/** 指针事件桩：带 stopPropagation / preventDefault 计数 */
function pev(id, x, y, target, extra = {}) {
  return Object.assign({
    pointerId: id,
    clientX: x,
    clientY: y,
    target,
    stopped: false,
    prevented: false,
    stopPropagation() { this.stopped = true },
    preventDefault() { this.prevented = true },
  }, extra)
}

function touchEv(id, x, y, extra = {}) {
  const t = { identifier: id, clientX: x, clientY: y }
  return Object.assign({ touches: [t], changedTouches: [t], cancelable: true, prevented: false, preventDefault() { this.prevented = true } }, extra)
}

// ======================================================================
console.log('\n[A] stage.bindDragInput：监听生命周期（dispose 必须撤干净）')
try {
  const win = new FakeTarget()
  win.PointerEvent = function PointerEvent() { }
  const fish = { contains: (n) => n === fish }
  const stageEl = Object.assign(new FakeTarget(), { contains: (n) => n === fish })

  const b = stage.bindDragInput(stageEl, win, { onDown() { }, onMove() { }, onEnd() { } })
  ok('PointerEvent 环境走 pointer 模式', b.mode === 'pointer', 'mode=' + b.mode)
  ok('pointer 模式挂上 window 监听', win.count() === 8, 'listeners=' + win.count())
  b.dispose()
  ok('pointer 模式 dispose 后 window 监听清零（含 capture 监听）', win.count() === 0, '残留=' + win.count())

  const win2 = new FakeTarget()   // 没有 PointerEvent → touch 模式
  const stageEl2 = Object.assign(new FakeTarget(), { contains: (n) => n === fish })
  const b2 = stage.bindDragInput(stageEl2, win2, { onDown() { }, onMove() { }, onEnd() { } })
  ok('无 PointerEvent 走 touch 模式', b2.mode === 'touch', 'mode=' + b2.mode)
  b2.dispose()
  ok('touch 模式 dispose 后元素监听清零', stageEl2.count() === 0, '残留=' + stageEl2.count())
  ok('touch 模式 dispose 后 window 监听清零', win2.count() === 0, '残留=' + win2.count())
} catch (e) {
  ok('stage 监听生命周期测试未抛错', false, String(e && e.stack || e))
}

// ======================================================================
console.log('\n[B] stage.bindDragInput：主指针过滤 / 多点触控 / 拖拽数学')
try {
  // ---- pointer：第二根手指按下/移动被拦，不能重置拖拽基线 ----
  const win = new FakeTarget()
  win.PointerEvent = function PointerEvent() { }
  const fish = { contains: (n) => n === fish }
  const other = { notFish: true }
  const stageEl = Object.assign(new FakeTarget(), { contains: (n) => n === fish })
  let downs = 0
  let moves = 0
  let ends = 0
  const b = stage.bindDragInput(stageEl, win, {
    onDown() { downs++ },
    onMove() { moves++ },
    onEnd() { ends++ },
  })

  const d1 = pev(1, 10, 10, fish)
  win.fire('pointerdown', d1, true)
  if (!d1.stopped) downs++                      // 模拟 React 的 onPointerDown
  ok('主指针按下未被拦', d1.stopped === false && downs === 1, 'downs=' + downs)

  const d2 = pev(2, 30, 30, fish)
  win.fire('pointerdown', d2, true)
  ok('第二根手指按下被捕获阶段拦下（不重置拖拽）', d2.stopped === true && downs === 1, 'downs=' + downs)
  const m2 = pev(2, 40, 40, fish)
  win.fire('pointermove', m2, true)
  ok('第二根手指移动被拦下', m2.stopped === true)
  const m1 = pev(1, 20, 20, fish)
  win.fire('pointermove', m1, true)
  ok('主指针移动放行', m1.stopped === false)
  win.fire('pointermove', m1, false)                // window 冒泡兜底 → handlers.onMove
  ok('主指针移动只算一次（捕获过滤 + 冒泡兜底不重复）', moves === 1, 'moves=' + moves)
  const u2 = pev(2, 40, 40, fish)
  win.fire('pointerup', u2, true)
  ok('第二根手指抬起被拦（不提前结束拖拽）', u2.stopped === true)
  const u1 = pev(1, 20, 20, fish)
  win.fire('pointerup', u1, true)
  win.fire('pointerup', u1, false)                  // window 冒泡兜底 → handlers.onEnd
  ok('主指针抬起放行并收尾', u1.stopped === false && ends === 1, 'ends=' + ends)
  b.dispose()

  // ---- touch：只认先按下的那根手指 ----
  const winT = new FakeTarget()
  const stageT = Object.assign(new FakeTarget(), { contains: (n) => n === fish })
  let tDowns = 0
  let tEnds = 0
  let lastMove = null
  const bt = stage.bindDragInput(stageT, winT, {
    onDown() { tDowns++ },
    onMove(x, y) { lastMove = { x, y } },
    onEnd() { tEnds++ },
  })
  const t1 = touchEv(11, 5, 5)
  stageT.fire('touchstart', t1, false)
  ok('第一根手指开始拖拽', tDowns === 1)
  const t2 = touchEv(22, 9, 9, { touches: [{ identifier: 11 }, { identifier: 22 }], changedTouches: [{ identifier: 22, clientX: 9, clientY: 9 }] })
  stageT.fire('touchstart', t2, false)
  ok('第二根手指按下被忽略（活动触点还在）', tDowns === 1)
  // 第二根手指移动：事件里 touches 两根都在，活动触点位置不变 → 位移必须为 0
  const t2m = touchEv(22, 40, 40, { touches: [{ identifier: 11, clientX: 5, clientY: 5 }, { identifier: 22, clientX: 40, clientY: 40 }] })
  stageT.fire('touchmove', t2m, false)
  winT.fire('touchmove', t2m, false)
  ok('第二根手指移动不带动鱼（取的是活动触点坐标）', !!lastMove && lastMove.x === 5 && lastMove.y === 5, JSON.stringify(lastMove))
  // 主触点移动：元素处理器先算、打标；window 兜底看到标记不得重复
  lastMove = null
  const t1m = touchEv(11, 16, 16, { touches: [{ identifier: 11, clientX: 16, clientY: 16 }, { identifier: 22, clientX: 40, clientY: 40 }] })
  stageT.fire('touchmove', t1m, false)
  winT.fire('touchmove', t1m, false)
  ok('主触点移动只算一次（元素处理器 + window 兜底不重复）', !!lastMove && lastMove.x === 16 && lastMove.y === 16 && t1m.__chubbyDragHandled === true, JSON.stringify(lastMove))
  const t2e = touchEv(22, 40, 40, { touches: [{ identifier: 11, clientX: 16, clientY: 16 }], changedTouches: [{ identifier: 22, clientX: 40, clientY: 40 }] })
  winT.fire('touchend', t2e, false)
  ok('抬起非活动触点不结束拖拽', tEnds === 0)
  const t1e = touchEv(11, 16, 16, { touches: [], changedTouches: [{ identifier: 11, clientX: 16, clientY: 16 }] })
  winT.fire('touchend', t1e, false)
  ok('主触点抬起结束拖拽', tEnds === 1)
  bt.dispose()

  // ---- 纯数学边界 ----
  ok('clampPos：NaN 横坐标按 0', stage.clampPos(NaN, 50, 240, 213, 800, 600).x === 0)
  ok('clampPos：+Infinity 夹到右下边界', (() => {
    const p = stage.clampPos(Infinity, Infinity, 240, 213, 800, 600)
    return p.x === 560 && p.y === 387
  })(), JSON.stringify(stage.clampPos(Infinity, Infinity, 240, 213, 800, 600)))
  ok('clampPos：-Infinity 夹到左上', (() => {
    const p = stage.clampPos(-Infinity, -Infinity, 240, 213, 800, 600)
    return p.x === 0 && p.y === 0
  })())
  ok('clampPos：视口比鱼小 → 贴左上，不出负值', (() => {
    const p = stage.clampPos(100, 100, 400, 400, 200, 150)
    return p.x === 0 && p.y === 0
  })())
  ok('clampPos：宽高 NaN 按 0 处理（不产生 NaN 坐标）', (() => {
    const p = stage.clampPos(100, 80, NaN, NaN, 800, 600)
    return Number.isFinite(p.x) && Number.isFinite(p.y) && p.x === 100 && p.y === 80
  })())
  ok('homePos：右下角默认位（离右 24、离下 150）', (() => {
    const p = stage.homePos(240, 213, 800, 600)
    return p.x === 536 && p.y === 237
  })(), JSON.stringify(stage.homePos(240, 213, 800, 600)))
  ok('clampVelocity：NaN → 0，±Infinity → ±上限', stage.clampVelocity(NaN) === 0 && stage.clampVelocity(Infinity) === 14 && stage.clampVelocity(-Infinity) === -14)
  ok('decayVelocity：dtScale 非法时按 1 衰减', (() => {
    const a = stage.decayVelocity(10, 0, NaN)
    const b = stage.decayVelocity(10, 0, 1)
    return Math.abs(a.vx - b.vx) < 1e-9 && a.done === false
  })())
  ok('decayVelocity：速度衰减到阈值后 done', (() => {
    let vx = 14
    let vy = 0
    let done = false
    for (let i = 0; i < 500 && !done; i++) { const r = stage.decayVelocity(vx, vy, 1); vx = r.vx; vy = r.vy; done = r.done }
    return done
  })())
  ok('moveDrag：未按下时返回 0 位移', (() => {
    const d = stage.createDragState()
    const m = stage.moveDrag(d, 99, 99)
    return m.x === 0 && m.y === 0 && d.moved === 0
  })())
  ok('drag 全流程：moved 累计、速度取末段、endDrag 后 dragging=false', (() => {
    const d = stage.createDragState()
    stage.beginDrag(d, 10, 10, 100, 100)
    stage.moveDrag(d, 14, 18)
    stage.moveDrag(d, 20, 26)
    const v = stage.endDrag(d)
    return d.moved === 26 && v.x === 6 && v.y === 8 && d.dragging === false
  })())
  ok('pointOf：坏坐标归 0，touches 优先', (() => {
    const a = stage.pointOf({ clientX: 'x', clientY: undefined })
    const b = stage.pointOf({ touches: [{ clientX: 5, clientY: 6 }], clientX: 1, clientY: 2 })
    return a.x === 0 && a.y === 0 && b.x === 5 && b.y === 6
  })())
} catch (e) {
  ok('stage 交互/数学测试未抛错', false, String(e && e.stack || e))
}

// ======================================================================
console.log('\n[C] anim.createAnimator：rAF/监听清理 + 绘制异常重试')
try {
  const calls = { clear: 0, draw: 0, save: 0, restore: 0 }
  let throwClear = 0            // >0 时 clearRect 抛错，每帧减一
  let throwDraw = 0             // >0 时 drawImage 抛错（发生在 save 之后，验证 finally 配平）
  const ctx = {
    setTransform() { }, save() { calls.save++ }, restore() { calls.restore++ }, translate() { }, rotate() { },
    clearRect() { calls.clear++; if (throwClear > 0) { throwClear--; throw new Error('canvas 绘制炸了') } },
    drawImage() { calls.draw++; if (throwDraw > 0) { throwDraw--; throw new Error('drawImage 炸了') } },
    beginPath() { }, ellipse() { }, arc() { }, fill() { }, stroke() { },
    fillRect() { }, fillText() { }, createRadialGradient() { return { addColorStop() { } } },
    fillStyle: '', strokeStyle: '', lineWidth: 0, globalAlpha: 1, globalCompositeOperation: '', font: '',
  }
  const canvas = {
    width: 480, height: 426, isConnected: true, style: {},
    getContext: () => ctx,
    getBoundingClientRect: () => ({ width: 240, height: 213 }),
    getClientRects: () => [{}],
  }
  const state = { talkUntil: 0, hearts: [] }

  // rAF 队列桩
  let nextId = 1
  const pending = new Map()
  const realRaf = globalThis.requestAnimationFrame
  const realCaf = globalThis.cancelAnimationFrame
  const realImage = globalThis.Image
  const realWindow = globalThis.window
  const realDocument = globalThis.document
  const realWarn = console.warn
  const warns = []
  globalThis.requestAnimationFrame = (cb) => { const id = nextId++; pending.set(id, cb); return id }
  globalThis.cancelAnimationFrame = (id) => { pending.delete(id) }
  globalThis.Image = class Image { constructor() { this.src = ''; this.complete = true; this.naturalWidth = 1696 } }
  const win = new FakeTarget()
  win.devicePixelRatio = 2
  globalThis.window = win
  globalThis.document = { hidden: false }
  console.warn = (...args) => { warns.push(args.map(String).join(' ')) }

  function fireFrame(ts) {
    const first = pending.entries().next()
    if (first.done) return false
    const [id, cb] = first.value
    pending.delete(id)
    try { cb(ts) } catch (e) { return { threw: e } }
    return true
  }

  try {
    const a = anim.createAnimator({ canvas, imgSrc: 'x', cw: 480, ch: 426, sx: 480 / 1696, sy: 426 / 1504, state })
    a.start()
    a.start()   // 幂等：不能叠加第二条 rAF / 第二个 resize 监听
    ok('start 幂等：只有一条 rAF 链、一个 resize 监听', pending.size === 1 && win.count() === 1, 'raf=' + pending.size + ' listeners=' + win.count())
    fireFrame(16)
    ok('正常帧后继续排下一帧', pending.size === 1)

    // ---- 隐藏（标签页 / 「游走」display:none）：停绘制、保活 rAF、恢复后自动续上 ----
    globalThis.document.hidden = true
    for (let i = 0; i < 30; i++) fireFrame(32 + i * 16)
    const drawsHidden = calls.draw
    for (let i = 0; i < 10; i++) fireFrame(600 + i * 16)
    ok('隐藏后不再绘制（drawImage 不调用）', calls.draw === drawsHidden, 'delta=' + (calls.draw - drawsHidden))
    ok('隐藏期间 rAF 仍保活（设计如此，恢复可见可自动续上）', pending.size === 1)
    globalThis.document.hidden = false
    for (let i = 0; i < 32; i++) fireFrame(900 + i * 16)
    ok('恢复可见后自动继续绘制', calls.draw > drawsHidden, 'draw=' + calls.draw)
    a.stop()

    // ---- DPR / 放大：backing store 有上限，不会按 DPR×放大无限堆像素 ----
    const canvasBig = Object.assign({}, canvas, { width: 0, height: 0, getBoundingClientRect: () => ({ width: 400, height: 400 }) })
    win.devicePixelRatio = 3
    const big = anim.createAnimator({ canvas: canvasBig, imgSrc: 'x', cw: 480, ch: 426, sx: 1, sy: 1, state })
    big.start()
    ok('DPR=3 + 显示 400px 时 backing store 封顶 2× 逻辑坐标（960×852）', canvasBig.width === 960 && canvasBig.height === 852, canvasBig.width + '×' + canvasBig.height)
    big.stop()
    win.devicePixelRatio = 2
    ok('stop 取消 rAF', pending.size === 0)
    ok('stop 撤掉 resize 监听', win.count() === 0, '残留=' + win.count())
    a.stop()   // 重复 stop 不抛

    // ---- 单次异常：必须重试，不能断链 ----
    const b = anim.createAnimator({ canvas, imgSrc: 'x', cw: 480, ch: 426, sx: 1, sy: 1, state })
    b.start()
    fireFrame(16)
    const before = calls.clear
    throwClear = 1
    const r = fireFrame(32)
    ok('绘制异常没有从 rAF 回调里逃逸（被就地拦下）', r !== false && !(r && r.threw), r && r.threw ? String(r.threw) : '')
    ok('异常帧后仍排了下一帧（可重试）', pending.size === 1, 'raf=' + pending.size)
    ok('异常帧只记一次日志', warns.length === 1, 'warn=' + warns.length)
    fireFrame(48)
    ok('恢复后继续绘制', pending.size === 1 && calls.clear > before, 'frames=' + (calls.clear - before))
    // 异常发生在 ctx.save() 之后：finally 必须把 restore 补上，否则旋转/位移会一直留在栈顶
    const saveBefore = calls.save
    const restoreBefore = calls.restore
    throwDraw = 1
    fireFrame(64)
    ok('异常发生在 save 之后时 save/restore 仍配平（画布状态不残留）', calls.save - saveBefore === 1 && calls.restore - restoreBefore === 1, 'save=' + (calls.save - saveBefore) + ' restore=' + (calls.restore - restoreBefore))
    ok('drawImage 异常后也继续排帧', pending.size === 1, 'raf=' + pending.size)
    b.stop()

    // ---- 连续异常：有上限，不能 60fps 无限重试 ----
    const c = anim.createAnimator({ canvas, imgSrc: 'x', cw: 480, ch: 426, sx: 1, sy: 1, state })
    c.start()
    throwClear = 999999
    let tried = 0
    while (pending.size > 0 && tried < 1000) { fireFrame(tried * 16); tried++ }
    ok('连续异常在有限帧内停表（不无限烧 CPU）', pending.size === 0 && tried > 1 && tried <= 1000, 'tried=' + tried)
    ok('停表后 resize 监听已撤', win.count() === 0, '残留=' + win.count())
    throwClear = 0

    // ---- 取不到 2D 上下文：空句柄，任何方法都不抛 ----
    const noCtx = { getContext: () => null }
    const f = anim.createAnimator({ canvas: noCtx, imgSrc: 'x', cw: 480, ch: 426, sx: 1, sy: 1, state })
    f.start(); f.talkFor(100); f.pushHeart(); f.setLook(look.lookFor(800)); f.stop()
    ok('无 2D 上下文时降级为空句柄且 setLook 仍生效', f.getLook().tier === 2)
    ok('无 2D 上下文时不排 rAF', pending.size === 0)
  } finally {
    globalThis.requestAnimationFrame = realRaf
    globalThis.cancelAnimationFrame = realCaf
    globalThis.Image = realImage
    globalThis.window = realWindow
    globalThis.document = realDocument
    console.warn = realWarn
  }
} catch (e) {
  ok('anim 测试未抛错', false, String(e && e.stack || e))
}

// ======================================================================
console.log('\n[D] styles：无 window 安全降级 / NaN 坐标 / 贴边钳制')
try {
  const realWindow = globalThis.window
  try {
    // 无 window（SSR / 测试桩）：样式函数不能抛 ReferenceError
    delete globalThis.window
    let threw = ''
    let s = null
    try { s = styles.menuStyle({ x: 10, y: 20 }) } catch (e) { threw = String(e) }
    ok('无 window 时 menuStyle 不抛错', !threw && !!s, threw)
    ok('无 window 时与菜单坐标无关（left/top 给保底值，不是 NaN）', !!s && s.left !== 'NaNpx' && s.top !== 'NaNpx' && s.display === 'block', s ? s.left + '/' + s.top : '')
  } finally {
    if (realWindow !== undefined) globalThis.window = realWindow
  }

  globalThis.window = { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1 }
  try {
    const a = styles.menuStyle({ x: 500, y: 500 })
    ok('菜单贴底时上边钳到视口内', a.top === '80px', 'top=' + a.top)
    ok('菜单贴右时左边钳到视口内', a.left === '500px', 'left=' + a.left)
    ok('maxHeight 不超过 480 且不小于 200', a.maxHeight === 480, 'maxHeight=' + a.maxHeight)
    const b = styles.menuStyle({ x: NaN, y: undefined })
    ok('菜单坐标 NaN/undefined 不生成 NaNpx', b.left === '8px' && b.top === '8px', b.left + '/' + b.top)
    const c = styles.menuStyle(null)
    ok('菜单关闭时 display:none、left/top 归零', c.display === 'none' && c.left === '0px' && c.top === '0px')
    const st = styles.stageStyle(1.4, true)
    ok('stageStyle：缩放与隐藏样式', st.transform === 'scale(1.4)' && st.transformOrigin === '0 0' && st.display === 'none')
    const st1 = styles.stageStyle(1, false)
    ok('stageStyle：默认尺寸与抓取光标', st1.width === '240px' && st1.height === '213px' && st1.cursor === 'grab' && st1.display === 'block')

    // 聊天面板：桌面视口保持原值；窄视口必须仍能塞进屏幕
    const desktop = styles.chatPanelStyle(true)
    ok('chatPanelStyle：桌面视口保持 right=236 / bottom=146', desktop.right === 236 && desktop.bottom === 146, desktop.right + '/' + desktop.bottom)
    globalThis.window = { innerWidth: 375, innerHeight: 667, devicePixelRatio: 1 }
    const phone = styles.chatPanelStyle(true)
    ok('chatPanelStyle：375px 宽视口不整块甩出屏幕', phone.right + phone.width <= 375 && phone.right >= 8, 'right=' + phone.right + ' 左边界=' + (375 - phone.right - phone.width))
    ok('chatPanelStyle：矮视口 bottom 收进屏幕', phone.bottom + 380 <= 667 || phone.bottom === 8, 'bottom=' + phone.bottom)
    globalThis.window = { innerWidth: 400, innerHeight: 360, devicePixelRatio: 1 }
    const tiny = styles.chatPanelStyle(true)
    ok('chatPanelStyle：400×360 小视口贴边收到 8px（不整块甩到框外）', tiny.right + 340 <= 400 && tiny.bottom === 8, 'right=' + tiny.right + ' bottom=' + tiny.bottom)
  } finally {
    globalThis.window = realWindow
  }
} catch (e) {
  ok('styles 测试未抛错', false, String(e && e.stack || e))
}

// ======================================================================
console.log('\n[E] look / render 纯函数不变量')
try {
  ok('tierOf：0/199 → 初识，200/799 → 熟络，800+ → 黏人', (() => {
    return look.tierOf(0) === 0 && look.tierOf(199) === 0 && look.tierOf(200) === 1 && look.tierOf(799) === 1 && look.tierOf(800) === 2
  })())
  ok('tierOf：NaN/负数 → 0，Infinity → 最高档', look.tierOf(NaN) === 0 && look.tierOf(-5) === 0 && look.tierOf(Infinity) === 2)
  ok('lookFor 返回冻结对象（外部改不动内部档位表）', Object.isFrozen(look.lookFor(0)) && Object.isFrozen(look.lookFor(800)))
  ok('lookForGrowth(null) 回落初识档', look.lookForGrowth(null).tier === 0)
  ok('parseGrowth：坏数据返回 null', look.parseGrowth(null) === null && look.parseGrowth({ exp: 10 }) === null && look.parseGrowth({ ok: true, exp: 'x' }) === null)
  ok('parseGrowth：正常数据取整 + 外观档位', (() => {
    const g = look.parseGrowth({ ok: true, exp: 250.9, nextExp: 800 })
    return g && g.exp === 250 && g.tier === 1 && g.nextExp === 800 && typeof g.stage === 'string' && g.stage.length > 0
  })())
  ok('parseGrowth：缺 nextExp 时回落 host 同源门槛', (() => {
    const g = look.parseGrowth({ ok: true, exp: 250 })
    return g && g.nextExp === 800
  })())

  const h = (type, props, ...children) => ({ type, props: props || {}, children })
  const items = [
    { type: 'item', label: '甲', action: 'a' },
    { type: 'sep' },
    { type: 'sub', label: '子 ▸', items: [{ type: 'item', label: '乙', action: 'b' }] },
    { type: 'item', label: '丙', action: 'c' },
  ]
  const tr = (label) => label
  const list = render.listMenuEntries(items, { tr, lang: 'zh', subOpen: '子 ▸' })
  ok('listMenuEntries：展开子菜单后序号全局唯一且连续', list.length === 4 && list.every((x, i) => x.index === i))
  ok('listMenuEntries：收起时不含子项', render.listMenuEntries(items, { tr, lang: 'zh', subOpen: '' }).length === 3)
  ok('renderMenuItems：行数与可见项一致', (() => {
    const tree = render.renderMenuItems(items, {
      h, tr, lang: 'zh', subOpen: '', focusIndex: -1, onToggleSub() { }, onAction() { },
    })
    const flat = []
    const walk = (nodes) => { for (const n of nodes) { if (!n || typeof n !== 'object') continue; if (n.props && n.props.role === 'menuitem') flat.push(n); if (Array.isArray(n.children)) walk(n.children) } }
    walk(tree)
    return flat.length === 3
  })())

  const realLS = globalThis.localStorage
  globalThis.localStorage = { getItem() { throw new Error('storage disabled') }, setItem() { throw new Error('storage disabled') } }
  try {
    const rt = render.readMenuRuntime()
    ok('readMenuRuntime：存储被禁时全部回落默认值', rt.storyAuto === true && rt.streamOn === true && rt.ttsVoice === 'zh-CN-XiaoyiNeural' && rt.chatLang === 'auto' && typeof rt.storyRate === 'string')
  } finally {
    if (realLS === undefined) delete globalThis.localStorage
    else globalThis.localStorage = realLS
  }
} catch (e) {
  ok('look/render 测试未抛错', false, String(e && e.stack || e))
}

// ======================================================================
console.log('\n' + '—'.repeat(60))
console.log('通过 ' + pass + ' 项 / 失败 ' + fail + ' 项')
if (fail > 0) {
  console.error('❌ 渲染层回归未通过')
  process.exit(1)
}
console.log('✅ 渲染层回归通过')
