/**
 * client/anim.ts —— Canvas 动画（眨眼/说话/爱心），可复用
 * 纯函数式：传入 canvas/图片/状态，返回控制句柄。
 */
export const EYE_L = { x: 679, y: 430, r: 68 }
export const EYE_R = { x: 860, y: 435, r: 68 }
export const MOUTH = { x: 779, y: 525, rw: 26, rh: 18 }

export interface AnimState {
  talkUntil: number
  hearts: { age: number }[]
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

  function drawHearts(): void {
    const arr = state.hearts
    for (let i = arr.length - 1; i >= 0; i--) {
      const hh = arr[i]
      hh.age += 1 / 60
      if (hh.age > 1.4) { arr.splice(i, 1); continue }
      const x = 120 + Math.sin(hh.age * 6) * 30
      const y = 30 - hh.age * 40
      ctx.fillStyle = 'rgba(255,120,150,' + (1 - hh.age / 1.4) + ')'
      ctx.font = '22px serif'
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
    const gap = 3200 + Math.random() * 1800
    if (!blinkClosed && blinkT > gap) { blinkClosed = true; blinkT = 0 }
    if (blinkClosed && blinkT > 150) { blinkClosed = false; blinkT = 0 }
    if (blinkClosed) { drawEye(EYE_L, true); drawEye(EYE_R, true) }
    if (t < state.talkUntil) drawMouth(Math.sin(t / 90) > 0)
    drawHearts()
    raf = requestAnimationFrame(loop)
  }

  function start(): void { raf = requestAnimationFrame(loop) }
  function stop(): void { cancelAnimationFrame(raf) }
  function talkFor(ms: number): void { state.talkUntil = performance.now() + ms }
  function pushHeart(): void { state.hearts.push({ age: 0 }) }

  return { start, stop, talkFor, pushHeart }
}
