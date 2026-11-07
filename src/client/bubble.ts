import { str } from './util.js'
import { deepFreeze } from '../shared/immutable.js'
import { moodPrefix } from './persona.js'
/**
 * client/bubble.ts —— 头顶气泡控制器（DOM 操作集中在这里，不碰 React）
 *
 * 原来 showBubble / setStatus / 样式注入 / 定时器收尾全在 client.ts，
 * 气泡定位依赖 posRef，收起逻辑散在卸载 effect 里。
 * 这里收成一个对象：show / hide / dismissStatus，定时器仍挂在元素上（el._t），
 * 与旧实现共享同一个计时器槽位，多次调用不会互相漏掉 clearTimeout。
 *
 * 情绪可视化只在这一层加前缀（persona.ts 的 mood → 表情），不改台词正文；
 * 前缀只进 DOM，朗读用的仍是调用方传入的原文本。
 */

/** 气泡与三角的样式（一次性注入 <style id="chubby-whale-style">） */
export const BUBBLE_CSS =
  '.chubby-bubble{position:fixed;z-index:10002;max-width:320px;white-space:pre-wrap;opacity:0;background:#fff;color:#17325a;border-radius:14px;padding:10px 14px;font:13px/1.6 "Microsoft YaHei","Leelawadee UI",Tahoma,"Noto Sans Thai",sans-serif;box-shadow:0 8px 20px rgba(0,0,0,0.35);transition:opacity .2s;pointer-events:none;}' +
  '.chubby-bubble::after{content:"";position:absolute;left:50%;margin-left:-9px;bottom:-9px;border-left:9px solid transparent;border-right:9px solid transparent;border-top:10px solid #fff;}' +
  '.chubby-bubble.show{opacity:1;}'

/** 这些是「纯状态字」：气泡里只剩它们时才允许静默收起 */
export const STATUS_TEXTS = ['在听…', '在想…', '识别中…', '在说…']
deepFreeze(STATUS_TEXTS)

/**
 * 显示用文本：按当前情绪加前缀表情（开关在 persona.moodPrefix 里读 localStorage）。
 * 纯状态字不加（dismissStatus 按原文比较）；已经以表情开头的不再叠一个；空串不加。
 */
function decorateText(text: string): string {
  const raw = str(text)
  if (!raw) return raw
  try {
    if (STATUS_TEXTS.indexOf(raw.trim()) >= 0) return raw
    if (/^\p{Extended_Pictographic}/u.test(raw)) return raw
    const prefix = moodPrefix()
    return prefix ? prefix + raw : raw
  } catch (e) { return raw }
}

/** 注入气泡样式（已存在则跳过） */
export function ensureBubbleStyle(doc?: any): void {
  try {
    const d = doc || (typeof document !== 'undefined' ? document : null)
    if (!d || !d.getElementById || d.getElementById('chubby-whale-style')) return
    const st = d.createElement('style')
    st.id = 'chubby-whale-style'
    st.textContent = BUBBLE_CSS
    if (d.head && d.head.appendChild) d.head.appendChild(st)
  } catch (e) { }
}

export type Bubble = {
  /** 显示一段文字；ms 后自动收起 */
  show: (text: string, ms?: number) => void
  /** 立即收起并清掉计时器 */
  hide: () => void
  /** 只有当前内容是纯状态字时才收起（别把正常消息一起抹掉） */
  dismissStatus: () => void
}

export type BubbleOptions = {
  /** 取气泡根元素（每次调用时取，避免闭包拿到旧节点） */
  el: () => any
  /** 取文字节点 */
  textEl: () => any
  /** 取鱼的位置 */
  pos: () => { x: number; y: number }
  /** 气泡水平中心偏移（= W/2） */
  xOffset: number
  /** 收起后的回调（旧实现在这里调 restoreIdleStatus，现为空） */
  onHide?: () => void
  /** 视口尺寸（默认 window） */
  viewport?: () => { w: number; h: number }
}

/**
 * 清掉气泡元素上的自动收起计时器（**公开访问器**）。
 * 为什么导出（2026-11-07 B96）：卸载清理（client/effects.ts）原来直接读 `el._t`，
 * 等于跨模块摸 bubble 的私有槽位 —— 只要这里把字段改名，卸载清理会**静默失效**
 * （气泡定时器留着，组件销毁后还改 DOM）。现在两边走同一个函数。
 */
export function clearBubbleTimer(el: any): void {
  try {
    if (el && el._t) { clearTimeout(el._t); el._t = null }
  } catch (e) { }
}

export function createBubble(opts: BubbleOptions): Bubble {
  function viewport(): { w: number; h: number } {
    try {
      if (opts.viewport) return opts.viewport()
      return { w: (window as any).innerWidth, h: (window as any).innerHeight }
    } catch (e) { return { w: 1024, h: 768 } }
  }

  const clearTimer = clearBubbleTimer

  function hide(): void {
    try {
      const el = opts.el()
      if (!el) return
      clearTimer(el)
      el.classList.remove('show')
    } catch (e) { }
  }

  function show(text: string, ms = 2400): void {
    const el = opts.el()
    if (!el) return
    const p = opts.pos()
    const v = viewport()
    try {
      el.style.left = (p.x + opts.xOffset) + 'px'
      el.style.transform = 'translateX(-50%)'
      el.style.top = 'auto'
      el.style.right = 'auto'
      el.style.bottom = Math.max(70, v.h - p.y + 12) + 'px'
      const te = opts.textEl()
      if (te) te.textContent = decorateText(text)
      el.classList.add('show')
      clearTimer(el)
      el._t = setTimeout(() => {
        try {
          el.classList.remove('show')
          clearTimer(el)
        } catch (e) { }
        try { if (opts.onHide) opts.onHide() } catch (e) { }
      }, ms)
    } catch (e) { }
  }

  function dismissStatus(): void {
    try {
      const el = opts.el()
      if (!el) return
      const te = opts.textEl()
      const txt = te ? String(te.textContent || '') : ''
      // 与 decorateText 的判据保持一致（那边按 trim 后比较）：带尾随空格/换行的状态字
      // 也算纯状态字，否则「在想… 」这类会被判成"正文"，气泡永远收不起来。
      if (STATUS_TEXTS.indexOf(txt.trim()) >= 0) {
        clearTimer(el)
        el.classList.remove('show')
      }
    } catch (e) { }
  }

  return { show, hide, dismissStatus }
}
