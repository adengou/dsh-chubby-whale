/**
 * client/screen-keeper.ts —— 保持亮屏（浏览器标准 Screen Wake Lock，无第三方依赖）
 *
 * 用途：DSH 桌面端/浏览器页面打开且可见时，阻止显示器自动休眠。
 *   · 默认由调用方决定开/关；本模块只负责申请/释放/重连；
 *   · 页面隐藏时先释放（浏览器也会自动释放），回到可见且开关为开时重新申请；
 *   · 不支持 Wake Lock 的环境安静降级，由调用方提示；
 *   · 不写浏览器存储、不碰 React、不联网。
 *
 * 限制（必须让主人知道）：
 *   · 只能保持“屏幕”不休眠，不能覆盖合盖/系统电源策略/锁屏；
 *   · 页面被最小化/隐藏/关闭后，浏览器会释放锁；
 *   · 这是页面级能力，不是系统级电源管理。
 */

export type ScreenWakeLockSentinelLike = {
  released?: boolean
  release?: () => Promise<void> | void
  addEventListener?: (type: string, fn: () => void) => void
  removeEventListener?: (type: string, fn: () => void) => void
}

export type ScreenKeeperOptions = {
  /** navigator（测试注入）；缺省用全局 navigator */
  nav?: any
  /** document（测试注入）；缺省用全局 document */
  doc?: any
  /** 申请失败/不支持时回调；只用于提示一次，不刷屏 */
  onError?: (reason: string) => void
}

export type ScreenKeeper = {
  /** 开/关保持亮屏；重复设置同一状态幂等 */
  setEnabled: (enabled: boolean) => void
  /** 当前是否已持有有效锁 */
  isHeld: () => boolean
  /** 当前环境是否支持 Wake Lock */
  isSupported: () => boolean
  /** 释放并摘掉 visibility 监听；之后 setEnabled 不再生效 */
  dispose: () => void
}

export function createScreenKeeper(options: ScreenKeeperOptions = {}): ScreenKeeper {
  const nav: any = options.nav || (typeof navigator !== 'undefined' ? navigator : null)
  const doc: any = options.doc || (typeof document !== 'undefined' ? document : null)
  const onError = typeof options.onError === 'function' ? options.onError : () => { }

  let enabled = false
  let disposed = false
  let sentinel: ScreenWakeLockSentinelLike | null = null
  let pending: Promise<void> | null = null
  let visibilityBound = false

  function supported(): boolean {
    return !!(nav && nav.wakeLock && typeof nav.wakeLock.request === 'function')
  }

  function isHeld(): boolean {
    return !!(sentinel && sentinel.released !== true)
  }

  function isVisible(): boolean {
    // 测试/无 document 时按可见处理
    if (!doc || typeof doc !== 'object') return true
    return doc.visibilityState !== 'hidden' && doc.hidden !== true
  }

  function release(): void {
    const old = sentinel
    sentinel = null
    if (!old) return
    try {
      if (typeof old.release === 'function') {
        const r = old.release()
        if (r && typeof r.catch === 'function') r.catch(() => { })
      }
    } catch (e) { }
  }

  function acquire(): Promise<void> {
    if (disposed || !enabled || !supported() || !isVisible()) return Promise.resolve()
    if (isHeld()) return Promise.resolve()
    if (pending) return pending

    pending = Promise.resolve()
      .then(() => nav.wakeLock.request('screen'))
      .then((lock: ScreenWakeLockSentinelLike) => {
        if (!lock) return
        if (disposed || !enabled || !isVisible()) {
          try { lock.release && lock.release() } catch (e) { }
          return
        }
        sentinel = lock
        try {
          if (typeof lock.addEventListener === 'function') {
            lock.addEventListener('release', () => {
              if (sentinel === lock) sentinel = null
            })
          }
        } catch (e) { }
      })
      .catch((err: any) => {
        sentinel = null
        const reason = String((err && err.name) || (err && err.message) || err || 'wake-lock-failed')
        try { onError(reason) } catch (e) { }
      })
      .finally(() => { pending = null })

    return pending
  }

  function onVisibilityChange(): void {
    if (disposed) return
    if (!isVisible()) {
      // 页面隐藏时主动放锁；浏览器通常也会自己放，这里保证状态一致
      release()
      return
    }
    if (enabled) void acquire()
  }

  function bindVisibility(): void {
    if (visibilityBound || !doc || typeof doc.addEventListener !== 'function') return
    try {
      doc.addEventListener('visibilitychange', onVisibilityChange)
      visibilityBound = true
    } catch (e) { }
  }

  function unbindVisibility(): void {
    if (!visibilityBound || !doc || typeof doc.removeEventListener !== 'function') return
    try {
      doc.removeEventListener('visibilitychange', onVisibilityChange)
      visibilityBound = false
    } catch (e) { }
  }

  function setEnabled(next: boolean): void {
    if (disposed) return
    enabled = !!next
    if (enabled) {
      bindVisibility()
      void acquire()
    } else {
      release()
    }
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    enabled = false
    release()
    unbindVisibility()
  }

  return {
    setEnabled,
    isHeld,
    isSupported: supported,
    dispose,
  }
}
