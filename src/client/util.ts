/**
 * client/util.ts —— 跨模块共用的极小工具（不碰 React / DOM 树 / 网络）
 *
 * 存在理由：这几类 try/catch 包装原来在 10 多个模块里各写一份
 * （清定时器、拦事件默认行为、写调试命名空间），调用点统一后只剩一次短调用，
 * 打包体积与阅读成本都降下来，行为逐项保持原样。
 *
 * 刻意不做的：**localStorage 不在这里封装**。check-boundaries 的 B4 靠源码里的
 * `localStorage.getItem('chubby-…')` 字面量检查键前缀，收进工具函数会让检查失效。
 */

/** 拦冒泡：事件对象可能没有该方法（合成事件/部分旧浏览器），失败绝不影响主流程 */
export function evStop(e: any): void {
  try { if (e && typeof e.stopPropagation === 'function') e.stopPropagation() } catch (e2) { }
}

/** 拦默认行为：同 evStop，带同样的防御 */
export function evPrevent(e: any): void {
  try { if (e && typeof e.preventDefault === 'function') e.preventDefault() } catch (e2) { }
}

/** 清延时定时器：句柄可能为空；跨窗口句柄在个别环境会抛，失败静默 */
export function clearT(t: any): void {
  try { if (t) clearTimeout(t) } catch (e) { }
}

/** 清周期定时器：同 clearT */
export function clearI(t: any): void {
  try { if (t) clearInterval(t) } catch (e) { }
}

/** 字符串归一：null/undefined → ''，其余按 String(x)（手写 `String(x == null ? '' : x)` 的短写法） */
export function str(x: unknown): string {
  return x == null ? '' : String(x)
}
