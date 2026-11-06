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
  transform: 'scale(' + scale + ')',
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
  font: '12px/22px "Microsoft YaHei", sans-serif',
  cursor: 'pointer',
  userSelect: 'none' as const,
  opacity: 0.75,
  boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
  zIndex: 10003,
}

export const menuStyle = (menu: any) => ({
  position: 'fixed' as const,
  // 窄视口（<220px）时 innerWidth-220 为负会把菜单甩出左边；夹到 8px 保底
  left: (menu ? Math.max(8, Math.min(menu.x, window.innerWidth - 220)) : 0) + 'px',
  top: (menu ? Math.max(8, Math.min(menu.y, window.innerHeight - 520)) : 0) + 'px',
  width: 210,
  maxHeight: (typeof window !== "undefined" ? Math.max(200, Math.min(480, window.innerHeight - 32)) : 480),
  overflowY: 'auto' as const,
  paddingBottom: 10,
  background: 'rgba(12,28,52,0.98)',
  border: '1px solid #2E6BB8',
  borderRadius: 10,
  boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
  zIndex: 10001,
  font: '13px/1.5 "Microsoft YaHei", sans-serif',
  display: menu ? 'block' : 'none',
  color: '#cfe9ff',
})

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

export const chatPanelStyle = (open: boolean) => ({
  position: 'fixed' as const,
  right: 236,
  bottom: 146,
  width: 340,
  background: 'linear-gradient(180deg, rgba(18,40,74,0.98), rgba(10,24,46,0.98))',
  border: '1px solid rgba(93,160,240,0.55)',
  borderRadius: 18,
  boxShadow: '0 18px 48px rgba(0,0,0,0.55)',
  font: '14px/1.6 "Microsoft YaHei", sans-serif',
  color: '#dbeaff',
  overflow: 'hidden',
  zIndex: 10000,
  display: open ? 'block' : 'none',
})

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
