/**
 * client/story-auto.ts —— 连播开关（localStorage 键 `chubby-story-auto`）的唯一读写口
 *
 * 背景（2026-11-07 分身审计）：这个键原先有四处在用、三套写法——
 *   · chat-route.ts 写 `'on'`；actions/culture.ts 写 `'1'`/`'0'`、读 `!== '0'`；
 *   · render.ts 读 `!== '0'`；story.ts 整本讲完写 `'0'`。
 * `'on'` 恰好被 `!== '0'` 当成「开」，所以功能没炸；但口径不一会留下雷：
 * 以后谁改成 `=== '1'` 就会把 `'on'` 判成关。这里收成一个模块，读侧兼容历史脏值。
 *
 * 语义：**键不存在 = 开**（主人定的默认值）；`'0'`/`'off'`/`'false'` = 关；其余 = 开。
 * 所有读写都不抛异常：禁 cookie、配额满、隐私模式下退化为「开」或返回 false。
 */

/** localStorage 键名（全仓只允许经由本模块引用，别再手写字符串） */
export const STORY_AUTO_KEY = 'chubby-story-auto'

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch (e) {
    // Safari 隐私模式访问 localStorage 本身就可能抛
    return null
  }
}

/**
 * 读开关。读取失败 / 键缺失 / 无法识别的值一律按「开」。
 * 与旧 render.ts 的 `!== '0'` 口径一致，额外把 'off'/'false' 也认作关。
 */
export function isStoryAutoOn(): boolean {
  const s = storage()
  if (!s) return true
  let raw: string | null = null
  try {
    raw = s.getItem(STORY_AUTO_KEY)
  } catch (e) {
    return true
  }
  if (raw === null) return true
  const v = String(raw).trim().toLowerCase()
  return !(v === '0' || v === 'off' || v === 'false')
}

/**
 * 存储是否真的可用（能读一次键）。
 *
 * 为什么要单独暴露：`isStoryAutoOn()` 为了不抛异常，把「读不了」也按「开」返回；
 * 但调用方（actions/culture.ts 的开关）需要区分「开」和「读不到」——读不到时
 * 应该退回内存里的一次性开关，否则禁存储环境点一下会翻反方向。
 */
export function hasStoryAutoStorage(): boolean {
  const s = storage()
  if (!s) return false
  try {
    s.getItem(STORY_AUTO_KEY)
    return true
  } catch (e) {
    return false
  }
}

/** 写开关（统一写 `'1'`/`'0'`）。存储不可用返回 false，调用方不需要 try。 */
export function setStoryAuto(on: boolean): boolean {
  const s = storage()
  if (!s) return false
  try {
    s.setItem(STORY_AUTO_KEY, on ? '1' : '0')
    return true
  } catch (e) {
    return false
  }
}
