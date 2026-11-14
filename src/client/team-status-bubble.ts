/**
 * client/team-status-bubble.ts —— 鲸鱼看板的「常驻挂件」DOM 实现
 *
 * 独立于头顶气泡体系：不 import bubble.ts / 不 import React、不注入全局样式、
 * 不经过 bubble-queue 调度器。它只是鱼头右上方的一块小牌子，用来长期显示
 * 团队有几件事在做、卡在哪一步；一次性提醒（审批等）仍走气泡调度器。
 *
 * 约束：
 *   · fixed 定位 + pointer-events:none —— 不抢点击、不抢焦点；
 *   · aria-hidden —— 不参与朗读（看板只是视觉摘要，语音提醒走 alert 线路）；
 *   · display:none 初始 —— 没有团队任务时完全不存在；
 *   · 没有 document 时（Node / 测试）整个对象退化成 no-op，不抛错。
 *
 * 定位：调用方传入 stage 矩形（鱼所在容器），气泡落在鱼头右上方。
 */

import type { TeamTone } from '../shared/team-contract.js'

/** 看板默认压在其它浮层之上（但低于浏览器原生模态层） */
export const TEAM_STATUS_Z_INDEX = 2147483000

/** 看板默认最大宽度（px） */
export const TEAM_STATUS_MAX_WIDTH = 240

/** stage 矩形：只取定位需要的四个数，避免依赖 DOMRect 类型 */
export interface TeamRect {
  left: number
  top: number
  width: number
  height: number
}

export interface TeamStatusBubbleOptions {
  /** 文档对象；缺省时用全局 document（Node 下没有则退化为 no-op） */
  doc?: Document
  /** 取鱼所在 stage 的矩形；每次 show / 手动刷新时重新取（鱼会动） */
  position?: () => TeamRect | null
  /** 自定义 z-index；默认 2147483000 */
  zIndex?: number
}

export interface TeamStatusBubble {
  /** 显示一段摘要（text 为空也照常显示空牌，由调用方决定是否隐藏） */
  show(text: string, tone?: TeamTone): void
  /** 隐藏但不销毁 DOM（下次 show 复用同一个节点） */
  hide(): void
  /** 按 stage 矩形重新定位；内部会换算成「鱼头右上方」 */
  updatePosition(rect: TeamRect): void
  /** 移除节点；幂等（重复调用无副作用） */
  destroy(): void
  /**
   * 可选能力：提醒气泡显示期间把常驻看板压暗，避免两层抢注意力。
   * 表面层会先探测此方法是否存在，不存在就跳过。
   */
  setDim?(dim: boolean): void
}

/** 合法矩形（NaN / Infinity 会让 style 变成非法值，直接忽略） */
function validRect(rect: TeamRect | null | undefined): rect is TeamRect {
  return !!rect &&
    Number.isFinite(rect.left) && Number.isFinite(rect.top) &&
    Number.isFinite(rect.width) && Number.isFinite(rect.height)
}

/**
 * 建一块常驻看板。
 * @param opts.doc 可注入 document（测试用假 document）；不传则用全局 document
 */
export function createTeamStatusBubble(opts: TeamStatusBubbleOptions = {}): TeamStatusBubble {
  const doc: Document | null =
    opts.doc || (typeof document !== 'undefined' ? document : null)
  const zIndex =
    opts.zIndex !== undefined && Number.isFinite(opts.zIndex)
      ? opts.zIndex
      : TEAM_STATUS_Z_INDEX

  let el: any = null
  let destroyed = false
  let tone: TeamTone = 'normal'
  let dim = false
  let lastRect: TeamRect | null = null

  /** 把「鱼头右上方」换算成 fixed 坐标：横向落在鱼身 62% 处，纵向贴头顶上沿 */
  function place(rect: TeamRect): void {
    if (!el) return
    try {
      const viewportWidth = typeof window !== 'undefined' && Number.isFinite(window.innerWidth)
        ? window.innerWidth
        : 1024
      const left = Math.min(
        Math.max(8, rect.left + rect.width * 0.62),
        Math.max(8, viewportWidth - TEAM_STATUS_MAX_WIDTH - 8),
      )
      el.style.left = left + 'px'
      el.style.top = (rect.top + 8) + 'px'
    } catch (e) { }
  }

  /** 基调：warn 只换边框色；muted 压透明度 */
  function applyTone(): void {
    if (!el) return
    try {
      el.style.border =
        tone === 'warn'
          ? '1px solid rgba(255,196,84,0.95)'
          : tone === 'muted'
            ? '1px solid rgba(255,255,255,0.10)'
            : '1px solid rgba(255,255,255,0.18)'
      el.setAttribute('data-tone', tone)
    } catch (e) { }
  }

  /** 基础透明度 × 提醒期间的压暗系数 */
  function applyOpacity(): void {
    if (!el) return
    try {
      const base = tone === 'muted' ? 0.72 : 1
      el.style.opacity = String(dim ? Math.min(base, 0.45) : base)
    } catch (e) { }
  }

  /** 懒创建：没 document 时永远返回 null（no-op） */
  function ensureEl(): any {
    if (destroyed) return null
    if (el) return el
    if (!doc || typeof doc.createElement !== 'function') return null
    try {
      const node: any = doc.createElement('div')
      node.className = 'chubby-team-status'
      // 不抢焦点 / 不朗读：视觉摘要，不是交互控件
      if (node.setAttribute) {
        node.setAttribute('aria-hidden', 'true')
        node.setAttribute('role', 'presentation')
        node.setAttribute('data-tone', tone)
      }
      const s = node.style
      s.position = 'fixed'
      s.display = 'none'
      s.left = '0px'
      s.top = '0px'
      s.zIndex = String(zIndex)
      s.maxWidth = TEAM_STATUS_MAX_WIDTH + 'px'
      s.padding = '5px 9px'
      s.borderRadius = '8px'
      s.background = 'rgba(20,28,45,0.72)'
      s.color = '#ffffff'
      s.font = '12px/1.5 "Microsoft YaHei","Leelawadee UI",Tahoma,sans-serif'
      s.boxShadow = '0 4px 12px rgba(0,0,0,0.28)'
      s.pointerEvents = 'none'
      s.userSelect = 'none'
      s.whiteSpace = 'pre-wrap'
      s.wordBreak = 'break-word'
      s.overflowWrap = 'anywhere'
      s.transition = 'opacity .15s'
      s.opacity = '1'
      if (doc.body && typeof doc.body.appendChild === 'function') doc.body.appendChild(node)
      el = node
      applyTone()
      applyOpacity()
      if (lastRect) place(lastRect)
      return el
    } catch (e) {
      return null
    }
  }

  function show(text: string, nextTone?: TeamTone): void {
    if (destroyed) return
    const node = ensureEl()
    if (!node) return
    try {
      tone = nextTone || 'normal'
      node.textContent = text == null ? '' : String(text)
      applyTone()
      applyOpacity()
      node.style.display = 'block'
      // 有 position 端口就顺手刷新一次；调用方也可以显式 updatePosition
      if (opts.position) {
        let rect: TeamRect | null = null
        try { rect = opts.position() } catch (e) { rect = null }
        if (validRect(rect)) {
          lastRect = rect
          place(rect)
        }
      }
    } catch (e) { }
  }

  function hide(): void {
    if (!el) return
    try { el.style.display = 'none' } catch (e) { }
  }

  function updatePosition(rect: TeamRect): void {
    if (destroyed || !validRect(rect)) return
    lastRect = rect
    const node = ensureEl()
    if (!node) return
    place(rect)
  }

  function setDim(next: boolean): void {
    dim = !!next
    applyOpacity()
  }

  function destroy(): void {
    if (destroyed) return
    destroyed = true
    const node = el
    el = null
    lastRect = null
    if (!node) return
    try {
      if (typeof node.remove === 'function') node.remove()
      else if (node.parentNode && typeof node.parentNode.removeChild === 'function') {
        node.parentNode.removeChild(node)
      }
    } catch (e) { }
  }

  return { show, hide, updatePosition, destroy, setDim }
}
