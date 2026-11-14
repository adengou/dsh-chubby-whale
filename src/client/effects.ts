/**
 * client/effects.ts —— 组件入口里的监听器 / 定时器 / 卸载清理工厂
 *
 * 从 client.ts 的 useEffect 里拆出来的副作用编排：
 *   · bindFileDropCapture：捕获阶段的拖放接管（必须抢在宿主 drop 处理之前）；
 *   · bindOutsideClose：菜单外点击关闭（pointerdown / mousedown / touchstart 三路兼容）；
 *   · bindResize：窗口尺寸变化后重新钳制位置；
 *   · createUnmountCleanup：卸载收尾的固定顺序（提醒链 → 朗读 → 琴声 → 气泡计时器）。
 *
 * 每个工厂只返回 cleanup，不持有组件状态；调用点（effect 的位置与依赖）保持在
 * client.ts 原处，所以 effect 的执行顺序与旧实现一致。
 */

import { clearI, clearT, evPrevent, evStop } from './util.js'

export type Dispose = () => void

/** 拖放捕获：落点命中判定 + 收文件；返回解绑函数 */
export function bindFileDropCapture(opts: {
  win: any
  /** 命中判定（一般用鱼的包围盒加点容差） */
  hitTest: (x: number, y: number) => boolean
  /** 目标命中判定：外部拖放落在 canvas/stage 子节点上时，按 DOM 目标兜底（坐标可能缺失/不准） */
  targetTest?: (target: any) => boolean
  /** 命中后交出的文件（可能为 undefined） */
  onFile: (file: any) => void
  /**
   * 一次拖了多个文件时回调（参数是总数）。界面只处理第一个，其余不能**静默**丢掉——
   * 主人会以为都收下了（2026-11-07 分身审计的 G 项）。
   */
  onMany?: (count: number) => void
}): Dispose {
  const win = opts.win
  if (!win || !win.addEventListener) return () => { }

  const doc = win.document || null
  /** 坐标命中 或 事件目标落在鱼身上（后者兜底外部拖放 clientX/Y 缺失/不准） */
  const accept = (e: any): boolean => {
    try {
      if (opts.hitTest(e.clientX, e.clientY)) return true
      if (typeof opts.targetTest === 'function') return !!opts.targetTest(e.target)
    } catch (e2) { }
    return false
  }
  const handle = (e: any): void => {
    e.preventDefault()
    e.stopPropagation()
    const dt = e.dataTransfer
    const files = dt && dt.files ? dt.files : null
    const file = files && files[0]
    // 多文件：先说明「一次一张」，再处理第一张（顺序不能反，否则提示晚于结果）
    try {
      if (files && files.length > 1 && typeof opts.onMany === 'function') opts.onMany(files.length)
    } catch (e2) { }
    try { opts.onFile(file) } catch (e2) { }
  }
  // React 的 onDrop 走冒泡阶段，宿主会先接走文件；这里用捕获阶段抢过来
  const onDragOverCapture = (e: any): void => {
    if (!accept(e)) return
    e.preventDefault()
    e.stopPropagation()
  }
  const onDropCapture = (e: any): void => {
    if (!accept(e)) return
    handle(e)
  }
  // document 捕获：window 捕获若因坐标判定放过，落点确实在鱼身上时仍能接住
  const onDocDragOver = (e: any): void => {
    if (typeof opts.targetTest !== 'function' || !opts.targetTest(e.target)) return
    e.preventDefault()
    e.stopPropagation()
  }
  const onDocDrop = (e: any): void => {
    if (typeof opts.targetTest !== 'function' || !opts.targetTest(e.target)) return
    handle(e)
  }
  win.addEventListener('dragover', onDragOverCapture, true)
  win.addEventListener('drop', onDropCapture, true)
  if (doc && doc.addEventListener) {
    doc.addEventListener('dragover', onDocDragOver, true)
    doc.addEventListener('drop', onDocDrop, true)
  }
  return () => {
    try { win.removeEventListener('dragover', onDragOverCapture, true) } catch (e) { }
    try { win.removeEventListener('drop', onDropCapture, true) } catch (e) { }
    if (doc && doc.removeEventListener) {
      try { doc.removeEventListener('dragover', onDocDragOver, true) } catch (e) { }
      try { doc.removeEventListener('drop', onDocDrop, true) } catch (e) { }
    }
  }
}

/**
 * 菜单外点击关闭：
 * Safari 13 之前没有 pointerdown，补 mousedown / touchstart；三个都挂且幂等
 * （onOutside 里重复 setMenu(null) 无副作用）。
 */
export function bindOutsideClose(opts: {
  doc: any
  onOutside: () => void
}): Dispose {
  const doc = opts.doc
  if (!doc || !doc.addEventListener) return () => { }
  const onDocDown = (e: any): void => {
    try {
      const t = e && e.target
      // 菜单根节点带 data-menu-root 标记，closest 判断"点在菜单里"
      if (t && t.closest && t.closest('[data-menu-root]')) return
      opts.onOutside()
    } catch (e2) { }
  }
  doc.addEventListener('pointerdown', onDocDown, true)
  doc.addEventListener('mousedown', onDocDown, true)
  doc.addEventListener('touchstart', onDocDown, true)
  return () => {
    try { doc.removeEventListener('pointerdown', onDocDown, true) } catch (e) { }
    try { doc.removeEventListener('mousedown', onDocDown, true) } catch (e) { }
    try { doc.removeEventListener('touchstart', onDocDown, true) } catch (e) { }
  }
}

/** 窗口尺寸变化监听；返回解绑函数 */
export function bindResize(win: any, onResize: () => void): Dispose {
  if (!win || !win.addEventListener) return () => { }
  win.addEventListener('resize', onResize)
  return () => {
    try { win.removeEventListener('resize', onResize) } catch (e) { }
  }
}

/**
 * 进门问候 + 饥饿补一句：
 *   问候固定 3 秒后触发（不抢首屏）；饿了才排 6 秒后的第二句。
 * 两个定时器都要在 cleanup 里撤：卸载后不能再冒台词，StrictMode 双跑也不会叠加。
 */
export function startGreeting(opts: {
  greet: () => void
  hungry: () => void
  hungryNow: boolean
  greetMs?: number
  hungryMs?: number
}): Dispose {
  const tGreet = setTimeout(opts.greet, opts.greetMs ?? 3000)
  const tHungry = opts.hungryNow ? setTimeout(opts.hungry, opts.hungryMs ?? 6000) : null
  return () => {
    clearT(tGreet)
    clearT(tHungry)
  }
}

/**
 * 聊天面板聚焦：打开时聚焦输入框，关闭时失焦。
 *   · 已开启「减少动效」→ 立即聚焦（没有动画可等，不为动效再拖一拍）；
 *   · 面板上还有入场动画 → 等 animationend 再聚焦（maxWaitMs 兜底，动画被取消/不触发也不会永远不聚焦）；
 *   · 其余情况立即聚焦。
 * 返回 cleanup：撤销定时器与 animationend 监听（close 分支由调用方在 open=false 时触发 blur）。
 */
export function bindChatFocus(opts: {
  win?: any
  open: boolean
  input: () => any
  /** 面板根元素（判断有没有入场动画；缺省/取不到按无动画处理） */
  panel?: () => any
  /** 等动画的上限（毫秒），缺省 400 */
  maxWaitMs?: number
}): Dispose {
  if (!opts.open) {
    try {
      const el = opts.input()
      if (el && typeof el.blur === 'function') el.blur()
    } catch (e) { }
    return () => { }
  }
  const el = opts.input()
  if (!el || typeof el.focus !== 'function') return () => { }

  let done = false
  let timer: any = null
  let panelEl: any = null
  const fire = (): void => {
    if (done) return
    done = true
    clearT(timer); timer = null
    try { if (panelEl && typeof panelEl.removeEventListener === 'function') panelEl.removeEventListener('animationend', fire) } catch (e) { }
    try {
      // 只聚焦、不改滚动/选中；输入框可能已被宿主移走，focus 抛错就静默
      el.focus()
    } catch (e) { }
  }

  const reduced = (() => {
    try {
      const win = opts.win
      if (!win || typeof win.matchMedia !== 'function') return false
      const m = win.matchMedia('(prefers-reduced-motion: reduce)')
      return !!(m && m.matches)
    } catch (e) { return false }
  })()
  if (reduced) { fire(); return () => { done = true } }

  try {
    panelEl = opts.panel ? opts.panel() : null
    const anims = panelEl && typeof panelEl.getAnimations === 'function' ? panelEl.getAnimations() : null
    if (anims && anims.length && typeof panelEl.addEventListener === 'function') {
      panelEl.addEventListener('animationend', fire)
      timer = setTimeout(fire, opts.maxWaitMs ?? 400)
      return () => {
        done = true
        clearT(timer); timer = null
        try { panelEl.removeEventListener('animationend', fire) } catch (e) { }
      }
    }
  } catch (e) { }
  fire()
  return () => { done = true }
}

/**
 * 菜单键盘导航（不抢焦点）：只挂 window 捕获阶段的 keydown，菜单容器不聚焦。
 *   ArrowUp / ArrowDown → 在「当前可见项」间移动高亮（循环，子菜单展开后进入其子项，收起时不越级）
 *   Enter → 触发高亮项（子菜单父项 = 展开/收起）；没有高亮时放行，不抢宿主的回车
 *   Escape → 关闭（与 client.ts 原有 Esc effect 收敛到同一个关闭动作，重复调用幂等）
 * 输入框/可编辑区里打字时整键放行；Ctrl/Alt/Meta 组合键一律放行（不抢浏览器与宿主快捷键）。
 */
export function bindMenuKeys(opts: {
  win: any
  /** 当前按键目标是不是输入框/可编辑区（true = 让路） */
  isTyping: (target: any) => boolean
  /** 可见项数量（每次按键现读，子菜单展开/收起后自动对齐） */
  count: () => number
  /** 当前高亮序号（-1 = 还没高亮） */
  index: () => number
  /** 移动/设置高亮序号 */
  setIndex: (i: number) => void
  /** 触发第 i 项；返回 true 表示这次按键已消费 */
  activate: (i: number) => boolean
  /** 关闭菜单（与原有 Esc effect 同一个收敛口） */
  close: () => void
}): Dispose {
  const win = opts.win
  if (!win || !win.addEventListener) return () => { }
  const onKeyDown = (e: any): void => {
    try {
      if (!e) return
      if (e.ctrlKey || e.altKey || e.metaKey) return
      if (typeof opts.isTyping === 'function' && opts.isTyping(e.target)) return
      const n = opts.count()
      if (n <= 0) return
      const key = String(e.key || '')
      const raw = opts.index()
      const cur = raw >= 0 && raw < n ? raw : -1
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        const step = key === 'ArrowDown' ? 1 : -1
        const next = cur < 0 ? (step > 0 ? 0 : n - 1) : (cur + step + n) % n
        evPrevent(e); evStop(e)
        opts.setIndex(next)
        return
      }
      if (key === 'Enter') {
        if (e.repeat || cur < 0) return
        if (!opts.activate(cur)) return
        evPrevent(e); evStop(e)
        return
      }
      if (key === 'Escape' || key === 'Esc') {
        if (e.repeat) return
        evPrevent(e); evStop(e)
        opts.close()
      }
    } catch (e2) { }
  }
  try { win.addEventListener('keydown', onKeyDown, true) } catch (e) { return () => { } }
  return () => { try { win.removeEventListener('keydown', onKeyDown, true) } catch (e) { } }
}

/** 周期自愈心跳（繁忙锁 / 叙述锁）：返回停表函数 */
export function startWatchdog(tick: () => void, intervalMs = 2000): Dispose {
  const t = setInterval(tick, intervalMs)
  return () => {
    clearI(t)
  }
}

/**
 * 卸载收尾工厂（顺序固定，不可调换）：
 *   ① 提醒链 dispose（内部再按"撤到点定时器 → 清队列 → 停轮询"）；
 *   ② 停朗读；③ 停琴声音频；④ 清气泡自动收起计时器。
 * 返回值为可直接交给 useEffect 的 cleanup。
 */
export function createUnmountCleanup(opts: {
  /** 取提醒轮询器（可能还没建） */
  reminderPoller: () => { dispose: () => void } | null | undefined
  stopTts: () => void
  stopMelody: () => void
  /** 清掉气泡的自动收起计时器（由调用方注入 bubble 的公开访问器，别在这里 import bubble） */
  clearBubble?: () => void
}): Dispose {
  return (): void => {
    // 顺序固定：提醒链 → 朗读 → 琴声 → 气泡计时器（与 client.ts 的装配顺序一致）。
    // 每步单独兜底：前一步抛错不能把后面的清理跳过（漏掉 AudioContext 会把页面拖住）。
    try { const p = opts.reminderPoller(); if (p) p.dispose() } catch (e) { }
    try { opts.stopTts() } catch (e) { }
    try { opts.stopMelody() } catch (e) { }
    // 气泡计时器由调用方注入（client.ts 传 bubble 的公开访问器）：
    // effects 是「副作用编排」层，不该 import 具体 UI 模块 —— 一 import 就把 bubble → persona → data/*.json
    // 整条链拉进任何引用 effects 的测试里（2026-11-07 B96 就是这么炸的：ts-resolve 不处理 JSON 导入）。
    try { const f = opts.clearBubble; if (typeof f === 'function') f() } catch (e) { }
  }
}
