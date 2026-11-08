/**
 * client/physics.ts —— 拖拽甩出的抛物运动（原创实现）
 *
 * 交互目标：松手时按指针速度把鱼甩出去，受重力下落、撞视口四边反弹，
 * 落地时挤压回弹，最后停稳。纯函数、无 DOM，便于离线测试。
 *
 * 说明：只是"桌宠甩动"这一类通用交互的自主实现，没有引入任何第三方
 * 代码或素材；常数按本插件手感调，不依赖外部项目。
 *
 * 单位约定：速度是「px / 60Hz 帧」，与 client/stage.ts 的拖拽速度一致；
 * 真实帧时长用 dtScale（实际毫秒 / 16.67）归一，高刷屏不会变快。
 */

export type Pos = { x: number; y: number }

/** 可活动区域（左上角坐标 + 右下角坐标，均已含鱼身尺寸） */
export type Bounds = { minX: number; minY: number; maxX: number; maxY: number }

/** 落地/撞边类型：none 表示这一帧没撞 */
export type Bounce = 'none' | 'left' | 'right' | 'top' | 'bottom'

export type Flight = {
  vx: number
  vy: number
  /** 已经停稳（贴地且速度低于阈值） */
  resting: boolean
  /** 挤压动画已进行的毫秒数（>= SQUASH_MS 表示结束） */
  squashAge: number
}

/** 重力（px / 帧²，60Hz 基准） */
export const GRAVITY = 0.55
/** 撞墙/撞地的法向速度保留比例 */
export const RESTITUTION = 0.6
/** 撞左右墙时切向（垂直）速度的保留比例 */
export const WALL_FRICTION = 0.85
/** 贴地滑行摩擦 */
export const FLOOR_FRICTION = 0.72
/** 甩出速度上限（px / 帧） */
export const MAX_SPEED = 18
/** 低于这个速度且贴地即停 */
export const STOP_SPEED = 0.35
/** 挤压动画时长 */
export const SQUASH_MS = 280
/** 挤压最大幅度（纵向压缩比例） */
export const SQUASH_MAX = 0.18
/** 松手速度低于这个值就不甩（避免轻放也弹） */
export const LAUNCH_MIN = 1.2

function finite(v: number, fallback = 0): number {
  return Number.isFinite(v) ? v : fallback
}

export function createFlight(): Flight {
  return { vx: 0, vy: 0, resting: true, squashAge: SQUASH_MS }
}

/** 松手速度：夹到 ±MAX_SPEED，非有限值归零 */
export function launch(vx: number, vy: number): { vx: number; vy: number; moving: boolean } {
  const x = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, finite(vx)))
  const y = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, finite(vy)))
  return { vx: x, vy: y, moving: Math.hypot(x, y) >= LAUNCH_MIN }
}

/**
 * 一帧积分。
 * @param dtScale 实际帧时长 / 16.67（夹到 0.25~4，掉帧/高刷都不会改变物理时长）
 * @param dtMs 实际帧时长（毫秒），用于推进挤压动画
 */
export function stepFlight(f: Flight, pos: Pos, b: Bounds, dtScale = 1, dtMs = 16.67): { pos: Pos; bounce: Bounce } {
  const k = Math.min(4, Math.max(0.25, finite(dtScale, 1)))
  const ms = Math.min(100, Math.max(0, finite(dtMs, 16.67)))
  if (f.squashAge < SQUASH_MS) f.squashAge = Math.min(SQUASH_MS, f.squashAge + ms)
  if (f.resting) return { pos: { x: finite(pos.x), y: finite(pos.y) }, bounce: 'none' }

  // 半隐式位置积分：位移用「本帧平均竖直速度」，
  // 这样 60Hz 与 120Hz 在同样时长里落点一致（纯 vy*dt 会带 O(dt) 误差）
  const vy0 = f.vy
  f.vy += GRAVITY * k
  let x = finite(pos.x) + f.vx * k
  let y = finite(pos.y) + (vy0 + f.vy) / 2 * k
  let bounce: Bounce = 'none'

  if (x < b.minX) {
    x = b.minX
    f.vx = Math.abs(f.vx) * RESTITUTION
    f.vy *= WALL_FRICTION
    f.squashAge = 0
    bounce = 'left'
  } else if (x > b.maxX) {
    x = b.maxX
    f.vx = -Math.abs(f.vx) * RESTITUTION
    f.vy *= WALL_FRICTION
    f.squashAge = 0
    bounce = 'right'
  }

  if (y < b.minY) {
    y = b.minY
    f.vy = Math.abs(f.vy) * RESTITUTION
    f.vx *= WALL_FRICTION
    f.squashAge = 0
    bounce = 'top'
  } else if (y > b.maxY) {
    y = b.maxY
    if (Math.abs(f.vy) > STOP_SPEED * 2) {
      f.vy = -Math.abs(f.vy) * RESTITUTION
      f.vx *= FLOOR_FRICTION
      f.squashAge = 0
      bounce = 'bottom'
    } else {
      f.vy = 0
      f.vx *= FLOOR_FRICTION
      if (Math.abs(f.vx) < STOP_SPEED) {
        f.vx = 0
        f.resting = true
      }
    }
  }

  // 防御：任何 NaN/Infinity 都不能漏进坐标（一帧就整只鱼报废）
  x = finite(x, b.minX)
  y = finite(y, b.minY)
  return { pos: { x, y }, bounce }
}

/** 挤压形变：t=0 时纵向压到 1-SQUASH_MAX，阻尼振荡回到 1 */
export function squashScale(ageMs: number): { sx: number; sy: number } {
  const a = Math.max(0, finite(ageMs, SQUASH_MS))
  if (a >= SQUASH_MS) return { sx: 1, sy: 1 }
  const q = a / SQUASH_MS
  const damp = Math.exp(-4.2 * q)
  const wave = Math.cos(q * Math.PI * 2)
  const sy = 1 - SQUASH_MAX * damp * wave
  const sx = 1 + (1 - sy) * 0.55
  return { sx: Math.max(0.8, Math.min(1.2, sx)), sy: Math.max(0.8, Math.min(1.2, sy)) }
}
