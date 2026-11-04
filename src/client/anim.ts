/**
 * client/anim.ts —— Canvas 动画（眨眼/说话/爱心），可复用
 * 纯函数式：传入 canvas/图片/状态，返回控制句柄。
 */
export const EYE_L = { x: 679, y: 430, r: 68 }
export const EYE_R = { x: 860, y: 435, r: 68 }
export const MOUTH = { x: 779, y: 525, rw: 26, rh: 18 }

export interface AnimState {
  talkUntil: number
  hearts: { age: number; dx?: number }[]
}

export function createAnimator(opts: {
  canvas: any
  imgSrc: string
  cw: number
  ch: number
  sx: number
  sy: number
  state: AnimState
}) {
  const { canvas, imgSrc, cw, ch, sx, sy, state } = opts
  const ctx = canvas.getContext('2d')
  const img = new Image()
  img.src = imgSrc
  let raf = 0
  let last = performance.now()
  let blinkT = 0
  let blinkClosed = false
  // 眨眼间隔：每次眨完才重新抽一次，不能每帧重算（否则随机到不可控）
  let blinkGap = 3200 + Math.random() * 1800

  function drawEye(c: { x: number; y: number; r: number }, closed: boolean): void {
    if (!closed) return
    const p = { x: c.x * sx, y: c.y * sy }
    const r = c.r * sx
    ctx.fillStyle = '#F9EDE7'
    ctx.beginPath()
    ctx.ellipse(p.x, p.y, r * 1.15, r * 0.9, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#3a2a24'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.arc(p.x, p.y, r * 0.8, 0.15 * Math.PI, 0.85 * Math.PI)
    ctx.stroke()
  }

  function drawMouth(open: boolean): void {
    if (!open) return
    const p = { x: MOUTH.x * sx, y: MOUTH.y * sy }
    const rw = MOUTH.rw * sx
    const rh = MOUTH.rh * sy
    ctx.fillStyle = '#E8566B'
    ctx.beginPath()
    ctx.ellipse(p.x, p.y, rw * 1.1, rh * 1.45, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#7c1f2c'
    ctx.beginPath()
    ctx.ellipse(p.x, p.y + rh * 0.5, rw * 0.6, rh * 0.55, 0, 0, Math.PI * 2)
    ctx.fill()
  }

  /** 爱心寿命（秒）：与透明度归零、上飘终点统一，避免飞出画布被裁掉 */
  const HEART_LIFE = 1.4

  function drawHearts(dtSec: number): void {
    const arr = state.hearts
    for (let i = arr.length - 1; i >= 0; i--) {
      const hh = arr[i]
      hh.age += dtSec
      if (hh.age >= HEART_LIFE) { arr.splice(i, 1); continue }
      const p = hh.age / HEART_LIFE          // 0 → 1 的寿命进度
      // 起点在鱼头附近（画布 42% / 26%），向上飘的位移按画布高度算：1.4 秒内不出画布
      const x = cw * 0.42 + (hh.dx || 0) * cw * 0.12 + Math.sin(hh.age * 6) * cw * 0.01
      const y = ch * 0.26 - p * ch * 0.16 + Math.sin(hh.age * 5) * 2
      const alpha = Math.max(0, 1 - p)       // 寿命结束时透明度正好降到 0
      const size = Math.max(12, Math.round(ch * 0.05 * (1 + p * 0.5)))
      ctx.fillStyle = 'rgba(255,120,150,' + alpha.toFixed(3) + ')'
      ctx.font = size + 'px serif'
      ctx.fillText('❤', x, y)
    }
  }

  function loop(t: number): void {
    const dt = Math.min(50, t - last)
    last = t
    ctx.clearRect(0, 0, cw, ch)
    if (img.complete && img.naturalWidth > 0) {
      ctx.drawImage(img, 0, 0, 1696, 1504, 0, 0, cw, ch)
    }
    blinkT += dt
    if (!blinkClosed && blinkT > blinkGap) { blinkClosed = true; blinkT = 0 }
    if (blinkClosed && blinkT > 150) { blinkClosed = false; blinkT = 0; blinkGap = 3200 + Math.random() * 1800 }
    if (blinkClosed) { drawEye(EYE_L, true); drawEye(EYE_R, true) }
    if (t < state.talkUntil) drawMouth(Math.sin(t / 90) > 0)
    drawHearts(dt / 1000)
    raf = requestAnimationFrame(loop)
  }

  function start(): void { raf = requestAnimationFrame(loop) }
  function stop(): void { cancelAnimationFrame(raf) }
  function talkFor(ms: number): void { state.talkUntil = performance.now() + ms }
  function pushHeart(): void { state.hearts.push({ age: 0, dx: Math.random() - 0.5 }) }

  return { start, stop, talkFor, pushHeart }
}
