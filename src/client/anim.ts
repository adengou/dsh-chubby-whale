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

export const EYE_L = { x: 730, y: 420, r: 68 }
deepFreeze(EYE_L)
export const EYE_R = { x: 870, y: 422, r: 68 }
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
/**
 * 每多少帧做一次「便宜维护」（可见性 / DPR / 画布尺寸）。
 * 读取布局（getBoundingClientRect）会触发布局查询，不能每帧做；约 0.5 秒一次足够跟手。
 */
const MAINTAIN_EVERY = 30
/** 爱心同时存在的上限：动画暂停 / 页面隐藏期间连点也不会把数组撑大 */
const HEART_MAX = 8

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
  const ctx: any = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null
  // 取不到 2D 上下文（元素尺寸为 0、GPU 进程回收等）时给一个空句柄：
  // 后面每帧都要在 ctx 上调方法，绝不能让它抛异常 —— 那会把宿主整棵渲染树拖垮。
  if (!ctx) {
    let fallbackLook: Look = opts.look || lookFor(0)
    return {
      start(): void { },
      stop(): void { },
      talkFor(_ms?: number): void { },
      pushHeart(): void { },
      // 取不到上下文时动画无法重建，但外观数据仍要跟上成长（否则 getLook 永远停在初识档）
      setLook(next?: Look): void { fallbackLook = next || lookFor(0) },
      getLook(): Look { return fallbackLook },
    }
  }
  const img = new Image()
  img.src = imgSrc
  let raf = 0
  /** 循环是否在跑：start 必须幂等，否则重复 start 会叠加两条 RAF 链，stop 只取消得掉最后一条 */
  let running = false
  let last = performance.now()
  let blinkT = 0
  let blinkClosed = false
  // 眨眼间隔：每次眨完才重新抽一次，不能每帧重算（否则随机到不可控）
  let blinkGap = 3200 + Math.random() * 1800
  /** 打瞌睡：闭眼、不做说话嘴动（由 setSleepy 控制） */
  let sleepy = false
  /** 撞墙震屏：剩余抖动时间（毫秒），绘制时整幅画布轻微位移 */
  let shakeT = 0
  /** 双击跳：剩余跳起时间（毫秒），绘制时整幅画布上移再落 */
  let jumpT = 0

  // ===== 成长外观状态（setLook 可随时替换，不需要重建动画器） =====
  let look: Look = opts.look || lookFor(0)
  let dotIdx: number[] = pickDotIndexes(look.dots)
  let nextWagAt = performance.now() + wagGap()
  let wagStart = -1
  let splashes: { x: number; y: number; vx: number; vy: number; age: number; life: number; r: number }[] = []
  const haloGrads: any[] = []

  // ===== 画布尺寸：按「显示尺寸 × devicePixelRatio」设 backing store =====
  // 旧实现把 backing 写死成 CW×CH（恰好是 CSS 尺寸的 2 倍）：DPR=2 时清晰，
  // 但 DPR=3（手机）、菜单把鱼放大 1.4 倍、外接屏切换 DPR 时都会被拉伸变糊。
  // 逻辑绘制坐标始终是 cw×ch，靠 setTransform 映射到物理像素，绘制代码不用改。
  let visible = true
  let maintCountdown = MAINTAIN_EVERY
  let usedDpr = 0

  function dprNow(): number {
    try {
      const d = typeof window !== 'undefined' ? Number((window as any).devicePixelRatio) : 1
      return isFinite(d) && d > 0 ? d : 1
    } catch (e) { return 1 }
  }

  function syncCanvasSize(): void {
    try {
      let cssW = 0
      let cssH = 0
      if (typeof canvas.getBoundingClientRect === 'function') {
        const r = canvas.getBoundingClientRect()
        cssW = Number(r && r.width) || 0
        cssH = Number(r && r.height) || 0
      }
      // display:none / 尚未布局时拿不到尺寸：按设计基准（CW/2、CH/2）兜底，绝不清成 0
      if (!(cssW > 0)) cssW = cw / 2
      if (!(cssH > 0)) cssH = ch / 2
      const dpr = dprNow()
      // 上限 2 倍逻辑坐标（960×852）：DPR3 + 菜单放大 1.4 时再往上堆像素没有视觉收益，
      // 只会让每帧全画布重绘的负担翻倍。
      const pxW = Math.max(1, Math.min(cw * 2, Math.round(cssW * dpr)))
      const pxH = Math.max(1, Math.min(ch * 2, Math.round(cssH * dpr)))
      // 给 canvas.width/height 赋值（即使同值）也会清空画布，所以只在真正变化时写
      if (canvas.width !== pxW) canvas.width = pxW
      if (canvas.height !== pxH) canvas.height = pxH
      if (typeof ctx.setTransform === 'function') ctx.setTransform(pxW / cw, 0, 0, pxH / ch, 0, 0)
      if (dpr !== usedDpr) {
        usedDpr = dpr
        // 分辨率变了：清掉按档位缓存的渐变，下帧按新上下文重建
        haloGrads.length = 0
      }
    } catch (e) { }
  }

  /** 元素是否还看得见（卸载后 isConnected=false；「让它游走」时 display:none 于祖先） */
  function checkVisible(): boolean {
    try {
      if (typeof document !== 'undefined' && (document as any).hidden) return false
      if (canvas.isConnected === false) return false
      if (typeof canvas.getClientRects === 'function') return canvas.getClientRects().length > 0
    } catch (e) { }
    return true
  }

  function maintain(): void {
    maintCountdown = MAINTAIN_EVERY
    visible = checkVisible()
    if (visible) syncCanvasSize()
  }

  let watchingResize = false
  function onWindowResize(): void {
    try { visible = checkVisible() } catch (e) { }
    if (visible) syncCanvasSize()
  }
  function watchResize(): void {
    if (watchingResize) return
    watchingResize = true
    try {
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('resize', onWindowResize)
    } catch (e) { }
  }
  function unwatchResize(): void {
    if (!watchingResize) return
    watchingResize = false
    try {
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener('resize', onWindowResize)
    } catch (e) { }
  }

  /** 下一次甩尾的间隔：档位基准 ±20% 抖动 */
  function wagGap(): number {
    return Math.max(2500, look.tailEveryMs * (1 - WAG_JITTER + Math.random() * WAG_JITTER * 2))
  }

  /** 进食体型系数（1~1.12，鱼账本用；乘在成长档位体型上，不改变 look 本身） */
  let bellyScale = 1

  /** 应用外观参数：体型走 canvas 元素 transform，光点数量即时生效 */
  function applyLook(next: Look): void {
    const prev = look
    look = next || lookFor(0)
    // 只有参数真的变了才动作：菜单打开会周期性重拉 /growth，旧实现每次都把甩尾计时重置，
    // 频繁开菜单时鱼就永远不甩尾了。
    if (look.dots !== prev.dots) dotIdx = pickDotIndexes(look.dots)
    if (look.tailEveryMs !== prev.tailEveryMs) nextWagAt = performance.now() + wagGap()
    try {
      canvas.style.transform = 'scale(' + (look.scale * bellyScale) + ')'
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

  /** 打瞌睡时头顶冒三个 Z（渐显渐隐、向上飘） */
  function drawZZZ(t: number): void {
    ctx.save()
    ctx.fillStyle = '#5B8DEF'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (let i = 0; i < 3; i++) {
      const phase = ((t / 900) + i / 3) % 1
      const a = Math.sin(phase * Math.PI)
      if (a <= 0.05) continue
      ctx.globalAlpha = Math.min(1, a)
      ctx.font = 'bold ' + (13 + i * 4) + 'px sans-serif'
      // 头的右侧、离头留空、上飘明显：x 从 290 起（向右斜），y 从 42 起飘 34
      ctx.fillText('Z', 290 + i * 16 + phase * 8, 50 - phase * 34 - i * 5)
    }
    ctx.restore()
  }

  /**
   * 说话开合（与竖版同款的含蓄画法）：立绘的嘴本身张开——
   * 张嘴帧不画（露出立绘嘴），闭嘴帧用肤色盖住嘴 + 一条小唇线，形成小幅度上下噏合。
   */
  function drawMouth(open: boolean): void {
    if (open) return
    const p = { x: MOUTH.x * sx, y: MOUTH.y * sy }
    const rw = MOUTH.rw * sx * 1.7
    const rh = MOUTH.rh * sy * 1.9
    // 肤色覆盖（横版立绘肤色采样 #FEF3F1）
    ctx.beginPath()
    ctx.ellipse(p.x, p.y, rw, rh, 0, 0, Math.PI * 2)
    ctx.fillStyle = '#FEF3F1'
    ctx.fill()
    // 闭合唇线（小弧度）
    ctx.beginPath()
    ctx.moveTo(p.x - rw * 0.5, p.y + rh * 0.03)
    ctx.quadraticCurveTo(p.x, p.y + rh * 0.3, p.x + rw * 0.5, p.y + rh * 0.03)
    ctx.lineWidth = 1.4
    ctx.strokeStyle = '#C56E6A'
    ctx.stroke()
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
      // 字体回退链：三家都不一定给 serif 配 emoji 字形。
      // 显式列出颜色 emoji 字体，免得 Safari 画成黑白、Linux 上画成豆腐块。
      ctx.font = size + 'px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",serif'
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
  function spawnSplash(count = 4, sizeMul = 1): void {
    const n = Math.max(1, Math.min(16, Math.round(count)))
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.7
      const speed = 0.05 + Math.random() * 0.07   // 像素/毫秒
      splashes.push({
        x: TAIL_TIP.x + (Math.random() - 0.5) * 12,
        y: TAIL_TIP.y + (Math.random() - 0.5) * 8,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        age: 0,
        life: (420 + Math.random() * 260) * Math.max(1, sizeMul * 0.75),
        r: (1.2 + Math.random() * 1.8) * sizeMul,
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
      ctx.globalAlpha = Math.min(1, 0.95 * k)
      const rr = p.r * (0.6 + 0.6 * k)
      // 深一点的蓝 + 白描边：透明背景下也看得见
      ctx.fillStyle = '#5FB8EC'
      ctx.beginPath()
      ctx.arc(p.x, p.y, rr, 0, TAU)
      ctx.fill()
      ctx.lineWidth = Math.max(0.8, rr * 0.35)
      ctx.strokeStyle = 'rgba(255,255,255,0.95)'
      ctx.stroke()
    }
    ctx.restore()
  }

  /** 当前工作状态（waiting/thinking/working/success/error），由 setPhase 更新 */
  let phase = 'waiting'

  /**
   * 头顶状态叠加：思考点 / 工作转圈 / 成功星星 / 出错汗滴。
   * 纯 canvas 画的小图形，不依赖任何外部素材。
   */
  function drawPhaseOverlay(t: number): void {
    if (phase === 'waiting') return
    ctx.save()
    try {
      if (phase === 'thinking') {
        for (let i = 0; i < 3; i++) {
          const a = 0.3 + 0.5 * Math.max(0, Math.sin(t / 380 - i * 0.9))
          ctx.globalAlpha = a
          ctx.fillStyle = '#ffffff'
          ctx.beginPath()
          ctx.arc(cw / 2 - 14 + i * 14, 42, 3.2, 0, TAU)
          ctx.fill()
        }
      } else if (phase === 'working') {
        const cx = cw - 52
        const cy = 52
        ctx.globalAlpha = 0.85
        ctx.strokeStyle = '#9FD8FF'
        ctx.lineWidth = 3
        const a0 = (t / 260) % TAU
        ctx.beginPath()
        ctx.arc(cx, cy, 9, a0, a0 + Math.PI * 1.2)
        ctx.stroke()
        ctx.globalAlpha = 0.6
        ctx.fillStyle = '#9FD8FF'
        ctx.beginPath()
        ctx.arc(cx, cy, 3, 0, TAU)
        ctx.fill()
      } else if (phase === 'success') {
        const cx = cw / 2
        const cy = 96
        for (let i = 0; i < 6; i++) {
          const a = (t / 520 + i / 6) * TAU
          const r = 20 + 10 * Math.sin(t / 220 + i)
          ctx.globalAlpha = 0.55 + 0.35 * Math.sin(t / 180 + i)
          ctx.fillStyle = i % 2 ? '#ffe08a' : '#ffb3c6'
          ctx.beginPath()
          ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.6, 2.4, 0, TAU)
          ctx.fill()
        }
      } else if (phase === 'error') {
        const x = cw * 0.72
        const y = 66
        ctx.globalAlpha = 0.9
        ctx.fillStyle = '#7fb7ff'
        ctx.beginPath()
        ctx.moveTo(x, y - 7)
        ctx.quadraticCurveTo(x + 6, y + 3, x, y + 8)
        ctx.quadraticCurveTo(x - 6, y + 3, x, y - 7)
        ctx.fill()
        ctx.globalAlpha = 0.7
        ctx.fillStyle = '#ffffff'
        ctx.beginPath()
        ctx.arc(x - 2, y + 1, 1.1, 0, TAU)
        ctx.fill()
      }
    } finally {
      ctx.restore()
    }
  }

  /**
   * 单帧绘制（不含排帧）。抽出来是为了让 loop 能兜住异常：
   * 旧实现把 requestAnimationFrame(loop) 写在函数末尾，任何一次绘制抛错都会让
   * rAF 链直接断掉——鱼从此冻结，连重试的机会都没有。
   */
  function drawFrame(t: number): void {
    const dt = Math.max(0, Math.min(50, t - last))
    last = t

    // 便宜维护（可见性 / DPR / 尺寸）按帧数节流：见 MAINTAIN_EVERY
    maintCountdown -= 1
    if (maintCountdown <= 0) maintain()
    // 不可见（卸载 / display:none / 标签页隐藏）时只保活 RAF，不做绘制：
    // 2MB 的鱼图每帧 drawImage 纯属白烧 GPU，恢复可见后下一拍自动续上。
    if (!visible) return

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

    // save/restore 必须成对：重试机制下如果异常发生在中间，画布状态（旋转/位移）会
    // 一直留在栈顶，下一帧 save 的又是被污染的状态，几次之后鱼就歪着画了。
    ctx.save()
    try {
      // 撞墙震屏：阻尼抖动（整幅画布轻微位移），dt 走完自动归零
      if (shakeT > 0) {
        const s = Math.min(1, shakeT / 160)
        ctx.translate((Math.random() - 0.5) * 4 * s, (Math.random() - 0.5) * 3 * s)
        shakeT = Math.max(0, shakeT - dt)
      }
      if (jumpT > 0) {
        // 0→1→0 的抛物线高度（最高 26px），落地瞬间归零
        const p = 1 - jumpT / 340
        ctx.translate(0, -Math.sin(Math.PI * Math.min(1, p)) * 26)
        jumpT = Math.max(0, jumpT - dt)
      }
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
      if (blinkClosed || sleepy) { drawEye(EYE_L, true); drawEye(EYE_R, true) }
      if (sleepy) drawZZZ(t)
      // 说话嘴动：正弦连续开合（周期约 1.2 秒），比原来的二值跳变更自然
      if (t < state.talkUntil && !sleepy) drawMouth(Math.sin(t / 90) > 0)
      drawSplashes(dt)
    } finally {
      ctx.restore()
    }

    drawHearts(dt / 1000)
    drawPhaseOverlay(t)
  }

  /** 连续绘制异常上限（约 5 秒 / 60Hz）：到顶就停表，避免 60fps 无限重试白烧 CPU */
  const FRAME_ERROR_LIMIT = 300
  let frameErrors = 0

  function loop(t: number): void {
    // stop 之后即使还有一帧回调被派发到这里，也绝不再排下一帧（RAF 链必断）
    if (!running) return
    try {
      drawFrame(t)
      frameErrors = 0
    } catch (e) {
      frameErrors += 1
      // 只在连续异常的第一帧记一次，别把控制台刷满
      if (frameErrors === 1) {
        try { console.warn('[chubby-whale] canvas 绘制异常，已继续排帧重试：', e) } catch (e2) { }
      }
      if (frameErrors >= FRAME_ERROR_LIMIT) {
        try { console.warn('[chubby-whale] canvas 连续 ' + FRAME_ERROR_LIMIT + ' 帧绘制异常，停止动画（已画出的画面保留）') } catch (e2) { }
        stop()
        return
      }
    }
    // stop() 可能在上面分支或外部被调用：确认还在跑才续帧
    if (!running) return
    raf = requestAnimationFrame(loop)
  }

  function start(): void {
    if (running) return
    running = true
    last = performance.now()
    maintCountdown = MAINTAIN_EVERY
    visible = true
    watchResize()
    syncCanvasSize()
    raf = requestAnimationFrame(loop)
  }
  function stop(): void {
    running = false
    unwatchResize()
    cancelAnimationFrame(raf)
    raf = 0
  }
  function talkFor(ms: number): void { state.talkUntil = performance.now() + ms }
  function pushHeart(): void {
    if (state.hearts.length >= HEART_MAX) state.hearts.shift()
    state.hearts.push({ age: 0, dx: Math.random() - 0.5 })
  }
  /** 成长变化时热更新外观（不重建动画器，不影响眨眼/说话/爱心） */
  function setPhase(next: string): void { phase = next || 'waiting' }
  function setLook(next: Look): void { applyLook(next) }
  /** 打瞌睡：闭眼 + 停止说话嘴动（不影响其他动画） */
  function setSleepy(on: boolean): void { sleepy = !!on }

  /** 撞墙：触发一次 160ms 的屏幕（画布）抖动 */
  function shake(): void { shakeT = 160 }

  /** 双击：原地跳一下（画布整体上移 26px 再落，约 340ms） */
  function jump(): void { jumpT = 340 }

  /** 连点彩蛋：连喷几圈水花 + 蹦几个爱心（错开时间，像小小烟花） */
  function celebrate(): void {
    try {
      spawnSplash(14, 2.4)
      setTimeout(() => { try { spawnSplash(10, 2) } catch (e) { } }, 90)
      setTimeout(() => { try { spawnSplash(8, 1.6) } catch (e) { } }, 190)
      for (let i = 0; i < 3; i++) setTimeout(() => { try { pushHeart() } catch (e) { } }, 60 + i * 140)
    } catch (e) { }
  }

  /** 落地/被摔时甩一圈水花（复用甩尾水珠） */
  function wakeSplash(): void { spawnSplash(10, 2.5) }

  /**
   * 进食体型：在成长档位体型上乘一个临时系数（1~1.12），只改画布 transform，不改 look。
   * 传 1 即恢复；非法值按 1 处理，绝不抛错。
   */
  function setBellyScale(multiplier: number): void {
    const m = Number(multiplier)
    bellyScale = Number.isFinite(m) ? Math.min(1.12, Math.max(1, m)) : 1
    try {
      canvas.style.transform = 'scale(' + (look.scale * bellyScale) + ')'
      canvas.style.transformOrigin = '50% 100%'
    } catch (e) { }
  }

  /** 当前外观参数（诊断/自测用） */
  function getLook(): Look { return look }

  return { start, stop, talkFor, pushHeart, setPhase, setLook, getLook, setBellyScale, wakeSplash, setSleepy, celebrate, shake, jump }
}
