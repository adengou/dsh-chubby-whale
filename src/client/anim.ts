/**
 * client/anim.ts —— Canvas 动画（眨眼/说话/爱心 + L5 成长外观），可复用
 * 纯函数式：传入 canvas/图片/状态，返回控制句柄。
 *
 * L5 外观（参数由 client/look.ts 提供，setLook 可热更新）：
 *   · 体型：canvas 元素 transform: scale(...)，锚点底部居中，不裁剪画面；
 *   · 背鳍光点：2 / 4 / 6 个淡蓝光点，各自错相呼吸微亮；
 *   · 光晕：径向渐变按档位缓存，初识不画，熟络淡、黏人稍明显；
 *   · 甩尾/水花：按档位调节间隔（14s / 9s / 5.5s），短促摆尾 + 尾巴尖水花。
 */
import { lookFor, type Look } from './look.js'
import { deepFreeze } from '../shared/immutable.js'

export const EYE_L = { x: 679, y: 430, r: 68 }
deepFreeze(EYE_L)
export const EYE_R = { x: 860, y: 435, r: 68 }
deepFreeze(EYE_R)
export const MOUTH = { x: 779, y: 525, rw: 26, rh: 18 }
deepFreeze(MOUTH)

export interface AnimState {
  talkUntil: number
  hearts: { age: number; dx?: number }[]
}

/** 背鳍光点候选位置（画布坐标）——沿右侧鳍缘从根部到鳍尖，按档位均匀取点 */
const FIN_DOTS = [
  { x: 308, y: 115 },
  { x: 317, y: 113 },
  { x: 326, y: 116 },
  { x: 334, y: 120 },
  { x: 343, y: 125 },
  { x: 350, y: 131 },
]

/** 甩尾水花起点：尾巴尖附近（画布坐标） */
const TAIL_TIP = { x: 391, y: 270 }
/** 一次甩尾的时长（毫秒） */
const WAG_MS = 900
/** 甩尾间隔随机抖动 ±20%，免得像节拍器 */
const WAG_JITTER = 0.2
/** 光晕渐变的圆心与内外半径（固定值；渐变对象按档位缓存，不每帧创建） */
const HALO = { x: 240, y: 228, r0: 30, r1: 252 }
/** 光点呼吸周期（毫秒） */
const DOT_BREATH_MS = 620
const TAU = Math.PI * 2

/** 按需要的光点数沿鳍缘均匀取样（2/4/6 个），返回 FIN_DOTS 下标 */
function pickDotIndexes(count: number): number[] {
  const n = FIN_DOTS.length
  const c = Math.max(2, Math.min(n, Math.round(Number(count)) || 2))
  if (c >= n) return [0, 1, 2, 3, 4, 5]
  const out: number[] = []
  for (let i = 0; i < c; i++) out.push(Math.round((i * (n - 1)) / (c - 1)))
  return out
}

export function createAnimator(opts: {
  canvas: any
  imgSrc: string
  cw: number
  ch: number
  sx: number
  sy: number
  state: AnimState
  look?: Look
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

  // ===== 成长外观状态（setLook 可随时替换，不需要重建动画器） =====
  let look: Look = opts.look || lookFor(0)
  let dotIdx: number[] = pickDotIndexes(look.dots)
  let nextWagAt = performance.now() + wagGap()
  let wagStart = -1
  let splashes: { x: number; y: number; vx: number; vy: number; age: number; life: number; r: number }[] = []
  const haloGrads: any[] = []

  /** 下一次甩尾的间隔：档位基准 ±20% 抖动 */
  function wagGap(): number {
    return Math.max(2500, look.tailEveryMs * (1 - WAG_JITTER + Math.random() * WAG_JITTER * 2))
  }

  /** 应用外观参数：体型走 canvas 元素 transform，光点数量即时生效 */
  function applyLook(next: Look): void {
    look = next || lookFor(0)
    dotIdx = pickDotIndexes(look.dots)
    nextWagAt = performance.now() + wagGap()
    try {
      canvas.style.transform = 'scale(' + look.scale + ')'
      canvas.style.transformOrigin = '50% 100%'
    } catch (e) { }
  }
  applyLook(look)

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

  /** 光晕渐变：每个档位只建一次（首帧），之后复用 */
  function haloGradient(): any {
    const cached = haloGrads[look.tier]
    if (cached) return cached
    const g = ctx.createRadialGradient(HALO.x, HALO.y, HALO.r0, HALO.x, HALO.y, HALO.r1)
    g.addColorStop(0, 'rgba(130,196,255,0.9)')
    g.addColorStop(0.5, 'rgba(80,150,240,0.38)')
    g.addColorStop(1, 'rgba(60,120,220,0)')
    haloGrads[look.tier] = g
    return g
  }

  function drawHalo(t: number): void {
    if (!(look.halo > 0)) return
    // 呼吸：透明度在 85%–100% 之间缓慢起伏，不闪
    const breathe = 0.85 + 0.15 * Math.sin(t / 900)
    ctx.save()
    ctx.globalAlpha = look.halo * breathe
    ctx.fillStyle = haloGradient()
    ctx.fillRect(0, 0, cw, ch)
    ctx.restore()
  }

  /** 背鳍光点：外壳 + 内核两层，错相呼吸；只画 2/4/6 个 */
  function drawFinDots(t: number): void {
    if (!look.dots || !dotIdx.length) return
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    for (let i = 0; i < dotIdx.length; i++) {
      const p = FIN_DOTS[dotIdx[i]]
      const pulse = 0.7 + 0.3 * Math.sin(t / DOT_BREATH_MS + i * 1.15)
      ctx.fillStyle = '#9FD6FF'
      ctx.globalAlpha = 0.16 * pulse
      ctx.beginPath()
      ctx.arc(p.x, p.y, 5.2, 0, TAU)
      ctx.fill()
      ctx.fillStyle = '#E6F6FF'
      ctx.globalAlpha = 0.9 * pulse
      ctx.beginPath()
      ctx.arc(p.x, p.y, 1.7, 0, TAU)
      ctx.fill()
    }
    ctx.restore()
  }

  /** 甩尾时从尾巴尖甩出几颗水珠 */
  function spawnSplash(): void {
    const n = 4
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.7
      const speed = 0.05 + Math.random() * 0.07   // 像素/毫秒
      splashes.push({
        x: TAIL_TIP.x + (Math.random() - 0.5) * 12,
        y: TAIL_TIP.y + (Math.random() - 0.5) * 8,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        age: 0,
        life: 420 + Math.random() * 260,
        r: 1.2 + Math.random() * 1.8,
      })
    }
    // 上限保护：异常情况下不会越积越多
    if (splashes.length > 24) splashes = splashes.slice(splashes.length - 24)
  }

  function drawSplashes(dt: number): void {
    if (!splashes.length) return
    ctx.save()
    for (let i = splashes.length - 1; i >= 0; i--) {
      const p = splashes[i]
      p.age += dt
      if (p.age >= p.life) { splashes.splice(i, 1); continue }
      p.vy += 0.0005 * dt       // 轻微重力
      p.x += p.vx * dt
      p.y += p.vy * dt
      const k = 1 - p.age / p.life
      ctx.globalAlpha = 0.55 * k
      ctx.fillStyle = '#BFE6FF'
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.r * (0.6 + 0.6 * k), 0, TAU)
      ctx.fill()
    }
    ctx.restore()
  }

  function loop(t: number): void {
    const dt = Math.min(50, t - last)
    last = t
    ctx.clearRect(0, 0, cw, ch)

    // 甩尾节拍：到点就起一段短摆尾，并按档位重排下一次
    if (t >= nextWagAt) {
      wagStart = t
      nextWagAt = t + wagGap()
      spawnSplash()
    }
    const wagP = (wagStart >= 0 && t >= wagStart && t <= wagStart + WAG_MS)
      ? (t - wagStart) / WAG_MS
      : -1

    ctx.save()
    if (wagP >= 0) {
      // 包络 0→1→0，绕底部中心左右摆一小下 + 轻微上下浮动
      const env = Math.sin(Math.PI * wagP)
      const angle = Math.sin(wagP * Math.PI * 6) * 0.012 * env
      const bob = Math.sin(wagP * Math.PI * 4) * 1.6 * env
      ctx.translate(cw / 2, ch)
      ctx.rotate(angle)
      ctx.translate(0, bob)
      ctx.translate(-cw / 2, -ch)
    }

    drawHalo(t)
    if (img.complete && img.naturalWidth > 0) {
      ctx.drawImage(img, 0, 0, 1696, 1504, 0, 0, cw, ch)
    }
    drawFinDots(t)
    blinkT += dt
    if (!blinkClosed && blinkT > blinkGap) { blinkClosed = true; blinkT = 0 }
    if (blinkClosed && blinkT > 150) { blinkClosed = false; blinkT = 0; blinkGap = 3200 + Math.random() * 1800 }
    if (blinkClosed) { drawEye(EYE_L, true); drawEye(EYE_R, true) }
    if (t < state.talkUntil) drawMouth(Math.sin(t / 90) > 0)
    drawSplashes(dt)
    ctx.restore()

    drawHearts(dt / 1000)
    raf = requestAnimationFrame(loop)
  }

  function start(): void { raf = requestAnimationFrame(loop) }
  function stop(): void { cancelAnimationFrame(raf) }
  function talkFor(ms: number): void { state.talkUntil = performance.now() + ms }
  function pushHeart(): void { state.hearts.push({ age: 0, dx: Math.random() - 0.5 }) }
  /** 成长变化时热更新外观（不重建动画器，不影响眨眼/说话/爱心） */
  function setLook(next: Look): void { applyLook(next) }
  /** 当前外观参数（诊断/自测用） */
  function getLook(): Look { return look }

  return { start, stop, talkFor, pushHeart, setLook, getLook }
}
