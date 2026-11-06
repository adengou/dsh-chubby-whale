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

export type Dispose = () => void

/** 拖放捕获：落点命中判定 + 收文件；返回解绑函数 */
export function bindFileDropCapture(opts: {
  win: any
  /** 命中判定（一般用鱼的包围盒加点容差） */
  hitTest: (x: number, y: number) => boolean
  /** 命中后交出的文件（可能为 undefined） */
  onFile: (file: any) => void
}): Dispose {
  const win = opts.win
  if (!win || !win.addEventListener) return () => { }

  // React 的 onDrop 走冒泡阶段，宿主会先接走文件；这里用捕获阶段抢过来
  const onDragOverCapture = (e: any): void => {
    if (!opts.hitTest(e.clientX, e.clientY)) return
    e.preventDefault()
    e.stopPropagation()
  }
  const onDropCapture = (e: any): void => {
    if (!opts.hitTest(e.clientX, e.clientY)) return
    e.preventDefault()
    e.stopPropagation()
    const dt = e.dataTransfer
    const file = dt && dt.files && dt.files[0]
    try { opts.onFile(file) } catch (e2) { }
  }
  win.addEventListener('dragover', onDragOverCapture, true)
  win.addEventListener('drop', onDropCapture, true)
  return () => {
    try { win.removeEventListener('dragover', onDragOverCapture, true) } catch (e) { }
    try { win.removeEventListener('drop', onDropCapture, true) } catch (e) { }
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
 * 注意：饥饿定时器与旧实现一样不保存句柄、卸载时不清（保持原有卸载行为，不额外改变语义）。
 */
export function startGreeting(opts: {
  greet: () => void
  hungry: () => void
  hungryNow: boolean
  greetMs?: number
  hungryMs?: number
}): Dispose {
  const tGreet = setTimeout(opts.greet, opts.greetMs ?? 3000)
  if (opts.hungryNow) setTimeout(opts.hungry, opts.hungryMs ?? 6000)
  return () => {
    try { clearTimeout(tGreet) } catch (e) { }
  }
}

/** 周期自愈心跳（繁忙锁 / 叙述锁）：返回停表函数 */
export function startWatchdog(tick: () => void, intervalMs = 2000): Dispose {
  const t = setInterval(tick, intervalMs)
  return () => {
    try { clearInterval(t) } catch (e) { }
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
  /** 取气泡根元素（计时器挂在 el._t 上） */
  bubbleEl: () => any
}): Dispose {
  return (): void => {
    // 顺序与旧实现逐行一致：dispose 自身有 try/catch，stopTts / stopMelody 原样直调
    try { const p = opts.reminderPoller(); if (p) p.dispose() } catch (e) { }
    opts.stopTts()
    opts.stopMelody()
    try {
      const el = opts.bubbleEl()
      if (el && el._t) { clearTimeout(el._t); el._t = null }
    } catch (e) { }
  }
}
