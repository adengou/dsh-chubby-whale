import { deepFreeze } from '../shared/immutable.js'
/**
 * client/bubble.ts —— 头顶气泡控制器（DOM 操作集中在这里，不碰 React）
 *
 * 原来 showBubble / setStatus / 样式注入 / 定时器收尾全在 client.ts，
 * 气泡定位依赖 posRef，收起逻辑散在卸载 effect 里。
 * 这里收成一个对象：show / hide / dismissStatus，定时器仍挂在元素上（el._t），
 * 与旧实现共享同一个计时器槽位，多次调用不会互相漏掉 clearTimeout。
 */

/** 气泡与三角的样式（一次性注入 <style id="chubby-whale-style">） */
export const BUBBLE_CSS =
  '.chubby-bubble{position:fixed;z-index:10002;max-width:320px;white-space:pre-wrap;opacity:0;background:#fff;color:#17325a;border-radius:14px;padding:10px 14px;font:13px/1.6 "Microsoft YaHei",sans-serif;box-shadow:0 8px 20px rgba(0,0,0,0.35);transition:opacity .2s;pointer-events:none;}' +
  '.chubby-bubble::after{content:"";position:absolute;left:50%;margin-left:-9px;bottom:-9px;border-left:9px solid transparent;border-right:9px solid transparent;border-top:10px solid #fff;}' +
  '.chubby-bubble.show{opacity:1;}'

/** 这些是「纯状态字」：气泡里只剩它们时才允许静默收起 */
export const STATUS_TEXTS = ['在听…', '在想…', '识别中…', '在说…']
deepFreeze(STATUS_TEXTS)

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

export function createBubble(opts: BubbleOptions): Bubble {
  function viewport(): { w: number; h: number } {
    try {
      if (opts.viewport) return opts.viewport()
      return { w: (window as any).innerWidth, h: (window as any).innerHeight }
    } catch (e) { return { w: 1024, h: 768 } }
  }

  function clearTimer(el: any): void {
    try {
      if (el && el._t) { clearTimeout(el._t); el._t = null }
    } catch (e) { }
  }

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
      if (te) te.textContent = text
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
      if (STATUS_TEXTS.indexOf(txt) >= 0) {
        clearTimer(el)
        el.classList.remove('show')
      }
    } catch (e) { }
  }

  return { show, hide, dismissStatus }
}
