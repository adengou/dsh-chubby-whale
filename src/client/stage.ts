/**
 * client/stage.ts —— 舞台（鱼）的位置与拖拽数学（纯函数 / 纯状态）
 *
 * 原来 applyPos 里混了三件事：钳制、拖动中的 transform、非拖动时的 left/top。
 * 这里只保留「算」的部分（钳制、默认位置、拖拽增量、惯性衰减），
 * DOM 写入仍由 client.ts 的 applyPos 负责，行为逐项对得上旧实现。
 */

export type Pos = { x: number; y: number }

/** 把鱼钳制在可视区内（缩放后的实际占位是 w×h） */
export function clampPos(x: number, y: number, w: number, h: number, viewW: number, viewH: number): Pos {
  return {
    x: Math.max(0, Math.min(viewW - w, x)),
    y: Math.max(0, Math.min(viewH - h, y)),
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
  return Math.max(-INERTIA_MAX, Math.min(INERTIA_MAX, v))
}

/** 一帧衰减：返回下一帧速度与是否该停 */
export function decayVelocity(vx: number, vy: number): { vx: number; vy: number; done: boolean } {
  const nx = vx * INERTIA_DECAY
  const ny = vy * INERTIA_DECAY
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
 *   · iOS Safari 的 setPointerCapture 可能失效、指针会滑出元素 → window 上兜一层 move/up；
 *   · 兜底与元素处理器会收到同一个事件：先处理的一方在事件上打 __chubbyDragHandled，
 *     后来的一看标记就跳过，绝不会把一次移动算两遍（那会让鱼瞬移）。
 *
 * 返回 mode 便于诊断：'pointer' 还是 'touch' 一眼能看出走的是哪套。
 */
export function bindDragInput(target: any, win: any, handlers: DragInputHandlers): { mode: 'pointer' | 'touch'; dispose: () => void } {
  const mode = pickInputMode(!!(win && win.PointerEvent))
  const add = (el: any, t: string, fn: any, opts?: any): void => { try { el.addEventListener(t, fn, opts) } catch (e) { } }
  const del = (el: any, t: string, fn: any): void => { try { el.removeEventListener(t, fn) } catch (e) { } }
  const mark = (e: any): void => { try { e.__chubbyDragHandled = true } catch (e2) { } }
  const handled = (e: any): boolean => { try { return !!(e && e.__chubbyDragHandled) } catch (e2) { return false } }
  const onDown = (e: any): void => {
    if (handled(e)) return
    const p = pointOf(e)
    handlers.onDown(p.x, p.y)
  }
  const onMove = (e: any): void => {
    if (handled(e)) return
    const p = pointOf(e)
    handlers.onMove(p.x, p.y)
  }
  const onTouchMove = (e: any): void => {
    // 老 Safari 没有 touch-action: none，只能在这里拦掉页面滚动
    try { if (e.cancelable) e.preventDefault() } catch (e2) { }
    // 先自己处理，再打标：标记是给 window 兜底看的（同一事件冒泡到 window 时不再算一次）
    const p = pointOf(e)
    handlers.onMove(p.x, p.y)
    mark(e)
  }
  const onEnd = (e: any): void => {
    if (handled(e)) return
    handlers.onEnd()
  }
  if (target && win) {
    if (mode === 'touch') {
      add(target, 'touchstart', onDown, { passive: false })
      add(target, 'touchmove', onTouchMove, { passive: false })
      add(target, 'mousedown', onDown)
    }
    // window 兜底：bubble 阶段，元素先处理并打标
    add(win, mode === 'touch' ? 'touchmove' : 'pointermove', onMove)
    add(win, mode === 'touch' ? 'touchend' : 'pointerup', onEnd)
    add(win, mode === 'touch' ? 'touchcancel' : 'pointercancel', onEnd)
    if (mode === 'touch') { add(win, 'mousemove', onMove); add(win, 'mouseup', onEnd) }
  }
  const dispose = (): void => {
    if (target && win) {
      if (mode === 'touch') {
        del(target, 'touchstart', onDown)
        del(target, 'touchmove', onTouchMove)
        del(target, 'mousedown', onDown)
      }
      del(win, mode === 'touch' ? 'touchmove' : 'pointermove', onMove)
      del(win, mode === 'touch' ? 'touchend' : 'pointerup', onEnd)
      del(win, mode === 'touch' ? 'touchcancel' : 'pointercancel', onEnd)
      if (mode === 'touch') { del(win, 'mousemove', onMove); del(win, 'mouseup', onEnd) }
    }
  }
  return { mode, dispose }
}
