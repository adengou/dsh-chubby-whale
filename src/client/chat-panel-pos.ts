/**
 * client/chat-panel-pos.ts —— 聊天面板浮动位置（纯函数 + LocalStorage）
 *
 * 面板默认仍停在右下角；主人拖动标题栏后记住位置，下次打开沿用。
 * 模块只提供读/写/钳制接口，不碰 DOM、不 import React，便于单测。
 */

export type PanelPos = { x: number; y: number }

/** LocalStorage 键：只存 {x,y}；坏值当作没拖过 */
export const PANEL_POS_KEY = 'chubby-chat-panel-pos'

/** 面板距离视口边缘的最小留白 */
export const PANEL_MARGIN = 8

function finite(n: unknown): number | null {
  const v = Number(n)
  return Number.isFinite(v) ? v : null
}

/** 读上次拖动的位置；没有/坏值/浏览器禁存储都返回 null（回到默认右下角） */
export function readPanelPos(): PanelPos | null {
  try {
    const raw = localStorage.getItem(PANEL_POS_KEY)
    if (!raw) return null
    const j = JSON.parse(raw)
    const x = finite(j && j.x)
    const y = finite(j && j.y)
    return x === null || y === null ? null : { x, y }
  } catch (e) {
    return null
  }
}

/** 记住位置；浏览器禁存储时静默失败，不影响拖动 */
export function savePanelPos(pos: PanelPos | null): void {
  try {
    if (!pos) {
      localStorage.removeItem(PANEL_POS_KEY)
      return
    }
    localStorage.setItem(PANEL_POS_KEY, JSON.stringify({ x: Math.round(pos.x), y: Math.round(pos.y) }))
  } catch (e) { }
}

/**
 * 把面板左上角钳进视口：左右/上下都留 PANEL_MARGIN，保证标题栏和输入框都能点到。
 * 面板比视口还大时，贴左上角（宁可溢出也不能把左上角藏到视口外）。
 */
export function clampPanelPos(pos: PanelPos, w: number, h: number, vw: number, vh: number): PanelPos {
  const pw = Math.max(0, finite(w) || 0)
  const ph = Math.max(0, finite(h) || 0)
  const maxX = Math.max(PANEL_MARGIN, (finite(vw) || 0) - pw - PANEL_MARGIN)
  const maxY = Math.max(PANEL_MARGIN, (finite(vh) || 0) - ph - PANEL_MARGIN)
  const x = Math.min(Math.max(PANEL_MARGIN, finite(pos && pos.x) || 0), maxX)
  const y = Math.min(Math.max(PANEL_MARGIN, finite(pos && pos.y) || 0), maxY)
  return { x: Math.round(x), y: Math.round(y) }
}
