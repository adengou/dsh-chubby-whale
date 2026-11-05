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
