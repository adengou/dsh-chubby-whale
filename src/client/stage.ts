/**
 * client/stage.ts —— 舞台（鱼）的位置与拖拽数学（纯函数 / 纯状态）
 *
 * 原来 applyPos 里混了三件事：钳制、拖动中的 transform、非拖动时的 left/top。
 * 这里只保留「算」的部分（钳制、默认位置、拖拽增量、惯性衰减），
 * DOM 写入仍由 client.ts 的 applyPos 负责，行为逐项对得上旧实现。
 */

import { evStop } from './util.js'

export type Pos = { x: number; y: number }

/** 非有限数一律按 0：localStorage 里的位置被手改成坏值时，不能把 NaN 传进 left/top（鱼会整只消失） */
function finiteOr0(v: number): number {
  const n = Number(v)
  return isFinite(n) ? n : 0
}

/** 把鱼钳制在可视区内（缩放后的实际占位是 w×h） */
export function clampPos(x: number, y: number, w: number, h: number, viewW: number, viewH: number): Pos {
  const ww = Math.max(0, finiteOr0(w))
  const hh = Math.max(0, finiteOr0(h))
  const vw = Math.max(0, finiteOr0(viewW))
  const vh = Math.max(0, finiteOr0(viewH))
  const maxX = Math.max(0, vw - ww)
  const maxY = Math.max(0, vh - hh)
  const nx = Number(x)
  const ny = Number(y)
  // NaN 没有方向，按 0 处理；±Infinity 按方向夹到对应边界
  const cx = isFinite(nx) ? nx : (nx > 0 ? maxX : 0)
  const cy = isFinite(ny) ? ny : (ny > 0 ? maxY : 0)
  return {
    x: Math.max(0, Math.min(maxX, cx)),
    y: Math.max(0, Math.min(maxY, cy)),
  }
}

/** 默认位置：右下角（离右 24px、离下 150px，给聊天面板留位） */
export function homePos(w: number, h: number, viewW: number, viewH: number): Pos {
  return clampPos(viewW - 24 - w, viewH - 150 - h, w, h, viewW, viewH)
}

export type DragState = {
  dragging: boolean
  lastX: number
  lastY: number
  /** 最近一次 move 的位移（惯性初速） */
  vx: number
  vy: number
  /** 累计位移：用来区分「点击」与「拖动」 */
  moved: number
  baseX?: number
  baseY?: number
}

export function createDragState(): DragState {
  return { dragging: false, lastX: 0, lastY: 0, vx: 0, vy: 0, moved: 0 }
}

/** 按下：记录起点与当前鱼的位置（拖动期间用 transform 相对位移） */
export function beginDrag(d: DragState, x: number, y: number, baseX: number, baseY: number): void {
  d.dragging = true
  d.lastX = x
  d.lastY = y
  d.vx = 0
  d.vy = 0
  d.moved = 0
  d.baseX = baseX
  d.baseY = baseY
}

/** 移动：返回本帧位移（>0 表示真的在拖） */
export function moveDrag(d: DragState, x: number, y: number): Pos {
  if (!d.dragging) return { x: 0, y: 0 }
  const dx = x - d.lastX
  const dy = y - d.lastY
  d.vx = dx
  d.vy = dy
  d.moved += Math.abs(dx) + Math.abs(dy)
  d.lastX = x
  d.lastY = y
  return { x: dx, y: dy }
}

/** 松手：结束拖动并返回惯性初速（已夹到 ±14） */
export function endDrag(d: DragState): Pos {
  if (!d.dragging) return { x: 0, y: 0 }
  d.dragging = false
  return { x: clampVelocity(d.vx), y: clampVelocity(d.vy) }
}

/** 惯性速度上限：太快会甩出屏幕 */
export const INERTIA_MAX = 14
/** 每帧衰减系数 */
export const INERTIA_DECAY = 0.9
/** 低于这个速度就停 */
export const INERTIA_STOP = 0.2

export function clampVelocity(v: number): number {
  const n = Number(v)
  // NaN 当 0；±Infinity 按方向取上限（不能让 NaN 漏进惯性循环，位置一帧就废）
  if (!isFinite(n)) return n > 0 ? INERTIA_MAX : (n < 0 ? -INERTIA_MAX : 0)
  return Math.max(-INERTIA_MAX, Math.min(INERTIA_MAX, n))
}

/** 一帧衰减：返回下一帧速度与是否该停 */
/**
 * 惯性衰减。dtScale = 实际帧时长 / 16.67ms（60Hz 基准）：
 * 按帧衰减会让 120Hz 屏的惯性物理时长只有 60Hz 的一半（位移一样、时间不对）；
 * 传入 dtScale 后按时间衰减，各刷新率下物理时长一致。
 */
export function decayVelocity(vx: number, vy: number, dtScale = 1): { vx: number; vy: number; done: boolean } {
  const k = Math.min(4, Math.max(0.25, Number.isFinite(dtScale) ? dtScale : 1))
  const f = Math.pow(INERTIA_DECAY, k)
  const nx = vx * f
  const ny = vy * f
  return { vx: nx, vy: ny, done: Math.abs(nx) < INERTIA_STOP && Math.abs(ny) < INERTIA_STOP }
}

/**
 * 拖拽该挂哪套事件。
 * Safari 13 之前没有 PointerEvent：只绑 pointerdown/move/up 的话事件永远不触发，
 * 整只鱼拖不动，而且是**静默失效**（没报错、没日志），最难受的坏法。这种环境改挂 touch + mouse。
 */
export function pickInputMode(hasPointerEvent: boolean): 'pointer' | 'touch' {
  return hasPointerEvent ? 'pointer' : 'touch'
}

/** 从任意事件取指针坐标：touch 用 touches[0]/changedTouches[0]，mouse/pointer 用 clientX/Y */
export function pointOf(e: any): { x: number; y: number } {
  const t = (e && e.touches && e.touches[0]) || (e && e.changedTouches && e.changedTouches[0])
  const s = t || e || {}
  const x = Number(s.clientX)
  const y = Number(s.clientY)
  return { x: isFinite(x) ? x : 0, y: isFinite(y) ? y : 0 }
}

export type DragInputHandlers = {
  onDown: (x: number, y: number) => void
  onMove: (x: number, y: number) => void
  onEnd: () => void
}

/**
 * 绑定拖拽输入（DOM 侧唯一一处，可离线测）。
 *
 * 三家差异：
 *   · Safari 13 之前没有 PointerEvent → 改挂 touch + mouse（元素上 touchstart/mousemove）；
 *   · iOS Safari 的 setPointerCapture 可能失效、指针会滑出元素 → 在 window 上兜一层 move/up；
 *   · touch 模式的事件只有一套（本模块自己处理）：元素处理器先算、在原生事件上打
 *     __chubbyDragHandled，window 兜底看到标记就跳过，一次移动不会算两遍；
 *   · 多点触控：只认「先按下的那根手指」。其余手指的事件在捕获阶段拦下 —— 否则第二根手指
 *     会重置拖拽基线（鱼瞬移）、甚至抬手时提前结束拖拽。主指针/主触点抬起后自动让位。
 *
 * pointer 模式的按下/移动/抬起由 client.ts 的 React 处理器负责，这里补 window 兜底与多指过滤。
 * 注意 React 处理器拿到的 e 是 **SyntheticEvent**，在它上面打标记到不了原生事件，
 * 所以 pointer 模式不能靠 __chubbyDragHandled 去重：兜底只在事件目标已经不在鱼身上
 * （capture 失效、指针滑出）时接手；目标还在鱼身上时 React 已经处理过，再算一次会把
 * 末帧速度清零（惯性直接消失），也会让 applyPos 每帧写两遍样式。
 *
 * blur（切窗口/切标签）时抬起事件永远不会到：必须在这里补一次 onEnd，
 * 只清 activeId 会让 client.ts 的 dragging 卡住，切回来动鼠标时鱼会粘着指针跑。
 *
 * 返回 mode 便于诊断：'pointer' 还是 'touch' 一眼能看出走的是哪套。
 */
export function bindDragInput(target: any, win: any, handlers: DragInputHandlers): { mode: 'pointer' | 'touch'; dispose: () => void } {
  const mode = pickInputMode(!!(win && win.PointerEvent))
  const add = (el: any, t: string, fn: any, opts?: any): void => { try { el.addEventListener(t, fn, opts) } catch (e) { } }
  // removeEventListener 的第三个参数必须与 add 一致：**capture 参与匹配**，
  // 少传一个 true 就撤不掉捕获阶段监听（旧实现每卸载一次漏 4 个，闭包一直攥着旧元素）。
  const del = (el: any, t: string, fn: any, opts?: any): void => { try { el.removeEventListener(t, fn, opts) } catch (e) { } }
  const mark = (e: any): void => { try { e.__chubbyDragHandled = true } catch (e2) { } }
  const handled = (e: any): boolean => { try { return !!(e && e.__chubbyDragHandled) } catch (e2) { return false } }
  /** 拦掉「不属于当前拖拽指针」的事件：capture 阶段 stopPropagation 同时挡住元素上的 React 处理器 */
  const swallow = (e: any): void => {
    evStop(e)
    try { if (e && e.cancelable && typeof e.preventDefault === 'function') e.preventDefault() } catch (e2) { }
  }
  /** 事件目标是否在鱼身上（按在页面其它地方的手指不归我们管） */
  const inside = (e: any): boolean => {
    try { if (target && typeof target.contains === 'function') return !!target.contains(e && e.target) } catch (e2) { }
    return true
  }
  /** 正在拖拽的指针 / 触点 id；null = 没有活动指针 */
  let activeId: number | null = null
  /**
   * 失焦收尾。window blur 之后 pointerup/touchend 不会再送达：只把 activeId 清空，
   * client.ts 的 dragRef 仍是 dragging=true —— 切回来移动鼠标时 onMove 照样会驱动鱼（粘手）。
   * 因此这里必须补一次 onEnd（没有活动指针时不通知，避免凭空触发一次 dragFinish）。
   */
  const release = (): void => {
    if (activeId === null) return
    activeId = null
    try { handlers.onEnd() } catch (e) { }
  }
  const pointerIdOf = (e: any): number | null => (e && typeof e.pointerId === 'number') ? e.pointerId : null
  const touchOf = (e: any, id: number): any => {
    const list = (e && e.touches) || []
    for (let i = 0; i < list.length; i++) if (list[i] && list[i].identifier === id) return list[i]
    return null
  }

  // ===== pointer：capture 阶段记账 + 过滤 =====
  const onPointerDownCapture = (e: any): void => {
    if (activeId === null) {
      const id = pointerIdOf(e)
      if (id !== null && inside(e)) activeId = id
      return
    }
    if (pointerIdOf(e) !== activeId && inside(e)) swallow(e)
  }
  const onPointerMoveCapture = (e: any): void => {
    if (activeId !== null && pointerIdOf(e) !== activeId && inside(e)) swallow(e)
  }
  const onPointerEndCapture = (e: any): void => {
    if (activeId === null) return
    if (pointerIdOf(e) === activeId) { activeId = null; return }   // 主指针抬起：放行给上层收尾
    if (inside(e)) swallow(e)                                      // 其它手指抬起：不得提前结束拖拽
  }

  // ===== touch：按触点 identifier 记账（第二指只动它自己的坐标，不碰鱼） =====
  const onTouchStart = (e: any): void => {
    if (activeId !== null) {
      // 已有手指在拖：它还在 touches 里就忽略新手指；不在（漏了 touchend）才允许接管
      if (touchOf(e, activeId)) return
      activeId = null
    }
    const list = (e && e.changedTouches) || (e && e.touches) || []
    const t = list[0]
    if (!t) return
    activeId = typeof t.identifier === 'number' ? t.identifier : null
    handlers.onDown(Number(t.clientX) || 0, Number(t.clientY) || 0)
  }
  const onTouchMove = (e: any): void => {
    if (activeId === null) return
    const t = touchOf(e, activeId)
    if (!t) return                        // 动的不是活动触点 → 忽略，鱼不会瞬移
    // 老 Safari 没有 touch-action: none，只能在这里拦掉页面滚动
    try { if (e.cancelable) e.preventDefault() } catch (e2) { }
    // 先自己处理，再打标：标记是给 window 兜底看的（同一事件冒泡到 window 时不再算一次）
    handlers.onMove(Number(t.clientX) || 0, Number(t.clientY) || 0)
    mark(e)
  }
  const onTouchEnd = (e: any): void => {
    if (activeId === null) return
    if (touchOf(e, activeId)) return      // 活动触点还在（抬起的是另一根手指）→ 不结束
    activeId = null
    handlers.onEnd()
  }

  // ===== 元素/兜底通用处理器 =====
  const onDown = (e: any): void => {
    if (handled(e)) return
    const p = pointOf(e)
    handlers.onDown(p.x, p.y)
  }
  const onMouseDown = (e: any): void => {
    // 鼠标接管时清掉触摸记账，window 的 mousemove/mouseup 兜底才能走
    activeId = null
    onDown(e)
  }
  const onMove = (e: any): void => {
    if (handled(e)) return
    if (mode === 'pointer') {
      // 目标还在鱼身上 → React 的 onPointerMove 已经处理过（见函数头注释）；
      // 只有 capture 失效、指针滑到页面其它地方时才由这里接手。
      if (inside(e)) return
      const p = pointOf(e)
      handlers.onMove(p.x, p.y)
      return
    }
    if (activeId !== null) {
      const t = touchOf(e, activeId)
      if (!t) return
      handlers.onMove(Number(t.clientX) || 0, Number(t.clientY) || 0)
      return
    }
    // 没有活动触点时只剩鼠标兜底（触屏模式下的老桌面浏览器）
    const p = pointOf(e)
    handlers.onMove(p.x, p.y)
  }
  const onEnd = (e: any): void => {
    if (handled(e)) return
    // 同 onMove：抬起发生在鱼身上时由 React 的 onPointerUp/onPointerCancel 收尾
    if (mode === 'pointer' && inside(e)) return
    handlers.onEnd()
  }

  if (target && win) {
    if (mode === 'pointer') {
      // capture 阶段早于 React 在 root 上的冒泡处理器：既能挡住非活动指针，也不干扰主指针
      add(win, 'pointerdown', onPointerDownCapture, true)
      add(win, 'pointermove', onPointerMoveCapture, true)
      add(win, 'pointerup', onPointerEndCapture, true)
      add(win, 'pointercancel', onPointerEndCapture, true)
      // window 兜底：iOS Safari 的 setPointerCapture 可能失效、指针会滑出元素
      add(win, 'pointermove', onMove)
      add(win, 'pointerup', onEnd)
      add(win, 'pointercancel', onEnd)
      add(win, 'blur', release)
    } else {
      add(target, 'touchstart', onTouchStart, { passive: false })
      add(target, 'touchmove', onTouchMove, { passive: false })
      add(target, 'mousedown', onMouseDown)
      add(win, 'touchmove', onMove)
      add(win, 'touchend', onTouchEnd)
      add(win, 'touchcancel', onTouchEnd)
      add(win, 'mousemove', onMove)
      add(win, 'mouseup', onEnd)
      add(win, 'blur', release)
    }
  }
  const dispose = (): void => {
    if (target && win) {
      if (mode === 'pointer') {
        // capture 监听必须按 capture=true 撤（见 del 的注释）
        del(win, 'pointerdown', onPointerDownCapture, true)
        del(win, 'pointermove', onPointerMoveCapture, true)
        del(win, 'pointerup', onPointerEndCapture, true)
        del(win, 'pointercancel', onPointerEndCapture, true)
        del(win, 'pointermove', onMove)
        del(win, 'pointerup', onEnd)
        del(win, 'pointercancel', onEnd)
        del(win, 'blur', release)
      } else {
        del(target, 'touchstart', onTouchStart)
        del(target, 'touchmove', onTouchMove)
        del(target, 'mousedown', onMouseDown)
        del(win, 'touchmove', onMove)
        del(win, 'touchend', onTouchEnd)
        del(win, 'touchcancel', onTouchEnd)
        del(win, 'mousemove', onMove)
        del(win, 'mouseup', onEnd)
        del(win, 'blur', release)
      }
    }
    activeId = null
  }
  return { mode, dispose }
}
