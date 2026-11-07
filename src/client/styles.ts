import { deepFreeze } from '../shared/immutable.js'
/**
 * client/styles.ts —— 所有样式常量（可复用）
 */
export const W = 240
export const H = 213
export const CW = 480
export const CH = 426
export const SX = CW / 1696
export const SY = CH / 1504
export { VERSION } from './version.js'

/**
 * stage 的 transform 合成：位移（拖动时用）+ 缩放（主人调的大小）。
 *
 * 为什么要收成函数（2026-11-07）：`client.ts` 的 applyPos 在拖动时直接写
 * `el.style.transform = 'translate3d(...)'`，把 `stageStyle` 里的 `scale(...)` 覆盖掉；
 * 拖动结束再把 transform 清空——于是「先缩放再拖」，缩放就丢了（React 认为 style 没变、
 * 不会重新写回 scale）。两边共用同一个构造函数，谁也不会漏掉另一半。
 *
 * 顺序固定为「先 translate 后 scale」：位移按屏幕像素走，不受缩放倍数影响。
 */
export const stageTransform = (scale: number, tx = 0, ty = 0): string =>
  'translate3d(' + (tx || 0) + 'px,' + (ty || 0) + 'px,0) scale(' + (scale || 1) + ')'

export const stageStyle = (scale: number, hidden: boolean) => ({
  position: 'fixed' as const,
  left: 0,
  top: 0,
  width: W + 'px',
  height: H + 'px',
  filter: 'drop-shadow(0 14px 26px rgba(0,0,0,0.5))',
  userSelect: 'none' as const,
  zIndex: 9999,
  cursor: 'grab',
  touchAction: 'none' as const,
  transform: stageTransform(scale),
  // 缩放原点用左上角：与 stage.ts 的 clampPos（按左上坐标 + W*s 宽高钳制）同口径；
  // 原先 100% 100%（右下）会让缩放后的鱼贴边溢出约 96px。
  transformOrigin: '0 0',
  display: hidden ? 'none' : 'block',
})

export const canvasStyle = { width: '100%', height: '100%', display: 'block' }
deepFreeze(canvasStyle)

/**
 * 「让它游走」后的恢复点：右下角一个极小的「○」。
 * 不占位、不抢焦点；鱼本体 display:none 时它仍然可点（不刷新页面即可恢复）。
 */
export const recoverDotStyle = {
  position: 'fixed' as const,
  right: 16,
  bottom: 16,
  width: 22,
  height: 22,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: '50%',
  background: 'rgba(12,28,52,0.72)',
  border: '1px solid rgba(93,160,240,0.55)',
  color: '#9FD8FF',
  font: '12px/22px "Microsoft YaHei", "Leelawadee UI", Tahoma, "Noto Sans Thai", sans-serif',
  cursor: 'pointer',
  userSelect: 'none' as const,
  opacity: 0.75,
  boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
  zIndex: 10003,
}

/**
 * 视口尺寸（无 window 的 SSR / 打桩环境返回 0）：
 * 样式函数里凡是读 window 的地方统一走这里，免得 `menuStyle` 在无 window 环境
 * 抛 `ReferenceError: window is not defined`，把整个渲染层带崩。
 */
function viewportSize(): { w: number; h: number } {
  try {
    if (typeof window === 'undefined') return { w: 0, h: 0 }
    const w = Number(window.innerWidth)
    const h = Number(window.innerHeight)
    return { w: isFinite(w) && w > 0 ? w : 0, h: isFinite(h) && h > 0 ? h : 0 }
  } catch (e) {
    return { w: 0, h: 0 }
  }
}

/** 坐标必须是有限数：JSX style 里的 "NaNpx" 会被浏览器整条忽略，菜单会跑回左上角 */
function finiteOr(v: any, fallback: number): number {
  const n = Number(v)
  return isFinite(n) ? n : fallback
}

export const menuStyle = (menu: any) => {
  const vp = viewportSize()
  const mx = finiteOr(menu && menu.x, 8)
  const my = finiteOr(menu && menu.y, 8)
  return {
    position: 'fixed' as const,
    // 窄视口（<220px）时 innerWidth-220 为负会把菜单甩出左边；夹到 8px 保底
    left: (menu ? Math.max(8, Math.min(mx, vp.w > 0 ? vp.w - 220 : 8)) : 0) + 'px',
    top: (menu ? Math.max(8, Math.min(my, vp.h > 0 ? vp.h - 520 : 8)) : 0) + 'px',
    width: 210,
    // 无 window 时用固定上限；有 window 时至少 200，避免窄视口把菜单压没
    maxHeight: vp.h > 0 ? Math.max(200, Math.min(480, vp.h - 32)) : 480,
    overflowY: 'auto' as const,
    paddingBottom: 10,
    background: 'rgba(12,28,52,0.98)',
    border: '1px solid #2E6BB8',
    borderRadius: 10,
    boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
    zIndex: 10001,
    font: '13px/1.5 "Microsoft YaHei", "Leelawadee UI", Tahoma, "Noto Sans Thai", sans-serif',
    display: menu ? 'block' : 'none',
    color: '#cfe9ff',
  }
}

/**
 * 菜单项样式（键盘高亮用）：
 *   active=false 时与原内联样式完全一致（透明底、无描边），鼠标交互观感不变；
 *   active=true 时给一层淡蓝底 + 内描边，保证方向键选中的项看得见。
 */
export const menuItemStyle = (active: boolean) => ({
  padding: '6px 14px',
  cursor: 'pointer',
  color: active ? '#ffffff' : '#cfe9ff',
  fontSize: 13,
  whiteSpace: 'nowrap' as const,
  background: active ? 'linear-gradient(90deg, rgba(46,107,184,0.95), rgba(34,78,140,0.55))' : 'transparent',
  borderRadius: active ? 6 : 0,
  boxShadow: active ? 'inset 0 0 0 1px rgba(159,216,255,0.8)' : 'none',
})

/** 子菜单父项：在菜单项样式上补「▸/▾」的左右分栏 */
export const menuSubStyle = (active: boolean) => ({
  ...menuItemStyle(active),
  display: 'flex',
  justifyContent: 'space-between',
})

/** 聊天面板的固定尺寸（宽度与「头 + 240 消息区 + 输入行 + 边框」的大致总高） */
const CHAT_PANEL_W = 340
const CHAT_PANEL_H = 380

/**
 * 聊天面板：默认在鱼左侧（right 236 / bottom 146）。
 * 窄窗口下 340 宽 + right 236 需要 576px 视口，手机 / 分屏时会整块甩到屏幕外；
 * 这里按视口把 right/bottom 收进来（桌面尺寸下取值与原来完全一致）。
 * 注意：窗口 resize 后要到下一次重渲染才重新计算（菜单同理），不追求逐帧跟手。
 */
export const chatPanelStyle = (open: boolean) => {
  const vp = viewportSize()
  const right = vp.w > 0 ? Math.min(236, Math.max(8, vp.w - CHAT_PANEL_W - 8)) : 236
  const bottom = vp.h > 0 ? Math.min(146, Math.max(8, vp.h - CHAT_PANEL_H)) : 146
  return {
    position: 'fixed' as const,
    right,
    bottom,
    width: CHAT_PANEL_W,
    background: 'linear-gradient(180deg, rgba(18,40,74,0.98), rgba(10,24,46,0.98))',
    border: '1px solid rgba(93,160,240,0.55)',
    borderRadius: 18,
    boxShadow: '0 18px 48px rgba(0,0,0,0.55)',
    font: '14px/1.6 "Microsoft YaHei", "Leelawadee UI", Tahoma, "Noto Sans Thai", sans-serif',
    color: '#dbeaff',
    overflow: 'hidden',
    zIndex: 10000,
    display: open ? 'block' : 'none',
  }
}

export const headStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '10px 16px',
  background: 'linear-gradient(90deg, rgba(46,107,184,0.9), rgba(27,74,140,0.9))',
  fontSize: 13,
  letterSpacing: 1,
  borderBottom: '1px solid rgba(93,160,240,0.3)',
}

export const bodyStyle = { height: 240, overflowY: 'auto' as const, padding: '12px 14px' }
export const inputRowStyle = { display: 'flex', gap: 8, padding: '10px 12px', borderTop: '1px solid rgba(93,160,240,0.25)', background: 'rgba(6,16,32,0.6)' }
deepFreeze(inputRowStyle)
export const inputStyle = {
  flex: 1,
  border: '1px solid rgba(93,160,240,0.35)',
  outline: 0,
  padding: '10px 14px',
  background: 'rgba(8,20,40,0.9)',
  color: '#dbeaff',
  borderRadius: 12,
  font: '14px "Microsoft YaHei"',
}
export const sendStyle = {
  border: 0,
  background: 'linear-gradient(90deg,#2E6BB8,#4A8FD6)',
  color: '#fff',
  padding: '0 18px',
  cursor: 'pointer',
  borderRadius: 12,
  fontWeight: 600,
}
export const msgStyle = (who: string) => ({
  margin: '8px 0',
  maxWidth: '86%',
  padding: '9px 13px',
  borderRadius: 14,
  wordBreak: 'break-word' as const,
  lineHeight: 1.6,
  marginLeft: who === 'me' ? 'auto' : 0,
  borderBottomRightRadius: who === 'me' ? 4 : 14,
  borderBottomLeftRadius: who === 'me' ? 14 : 4,
  background: who === 'me' ? 'linear-gradient(135deg,#2E6BB8,#3D7CC9)' : 'rgba(15,37,71,0.95)',
  color: who === 'me' ? '#fff' : '#dbeaff',
  border: who === 'me' ? 'none' : '1px solid rgba(93,160,240,0.25)',
  boxShadow: who === 'me' ? '0 4px 12px rgba(46,107,184,0.35)' : '0 2px 8px rgba(0,0,0,0.25)',
})
