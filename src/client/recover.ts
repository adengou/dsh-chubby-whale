/**
 * client/recover.ts —— 「让它游走」的可逆恢复（纯逻辑，不碰 React）
 *
 * 原来隐藏后只能刷新页面才能找回来。现在两条路都能恢复，且都不重新加载页面：
 *   ① 隐藏时在右下角留一个极小的「○」恢复点，点一下就回来；
 *   ② 全局快捷键 Ctrl+Shift+W 随时叫回来（菜单的 wake-recover 也走同一条恢复路径）。
 *
 * 恢复动作本身由调用方提供（client.ts 里就是 setHidden(false)），
 * 这里只负责「该不该出现恢复点」「这次按键算不算恢复快捷键」和事件登记，
 * 因此可以脱离浏览器 UI 在 Node 里验证。
 */

import { evPrevent, evStop, str } from './util.js'

/** 恢复快捷键的展示文案（气泡/提示用，只写一处） */
export const RECOVER_HOTKEY_LABEL = 'Ctrl+Shift+W'

export type RecoverHost = {
  /** 真正恢复显示（客户端接的是 setHidden(false)） */
  recover: () => void
}

export type Recover = {
  /** 隐藏时返回恢复点的属性（标记 + 提示 + 点击恢复）；显示时返回 null */
  dot: (hidden: boolean) => { [key: string]: any } | null
  /** 登记全局快捷键，返回解绑函数（交给 effect 的 cleanup） */
  bindHotkey: (target?: any) => () => void
  /** 直接触发一次恢复（幂等，诊断/单测用） */
  trigger: () => void
}

/** 只有隐藏时才需要恢复点 */
export function shouldShowRecoverDot(hidden: boolean): boolean {
  return !!hidden
}

/**
 * 判断一次 keydown 是不是恢复快捷键。
 * 兼容 `key` 缺失或浏览器只给 keyCode/which 的旧环境；大小写都认。
 */
export function isRecoverHotkey(e: any): boolean {
  if (!e) return false
  const ctrl = !!(e.ctrlKey || e.metaKey)
  const shift = !!e.shiftKey
  if (!ctrl || !shift) return false
  const key = str(e.key).toLowerCase()
  if (key === 'w') return true
  const code = Number(e.keyCode != null ? e.keyCode : e.which)
  return code === 87
}

/** 恢复点要挂在右下角：只是一个提示，不影响鱼本体（鱼本体此时是 display:none） */
export function createRecover(host: RecoverHost): Recover {
  function trigger(): void {
    try { host.recover() } catch (e) { }
  }

  function dot(hidden: boolean): { [key: string]: any } | null {
    if (!shouldShowRecoverDot(hidden)) return null
    return {
      'data-chubby-recover': '1',
      title: '点一下叫本鲸回来（或按 ' + RECOVER_HOTKEY_LABEL + '）',
      onClick: (e: any) => {
        // 恢复点只做恢复，不把这次点击继续传给底下的宿主页面
        evStop(e); evPrevent(e)
        trigger()
      },
    }
  }

  function bindHotkey(target?: any): () => void {
    let el: any = target
    if (!el) {
      try { el = typeof window !== 'undefined' ? window : null } catch (e) { el = null }
    }
    if (!el || typeof el.addEventListener !== 'function') return () => { }
    const onKeyDown = (e: any): void => {
      if (!isRecoverHotkey(e)) return
      // 恢复是幂等的：显示时按它等于「鱼还在」，不闪烁、不打断任何播放
      evPrevent(e); evStop(e)
      trigger()
    }
    try { el.addEventListener('keydown', onKeyDown, true) } catch (e) { return () => { } }
    return () => {
      try { el.removeEventListener('keydown', onKeyDown, true) } catch (e) { }
    }
  }

  return { dot, bindHotkey, trigger }
}
