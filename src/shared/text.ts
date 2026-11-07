/**
 * shared/text.ts —— 文本截断的公共口径（按 Unicode 码点，不切坏 emoji / 中文）
 *
 * 为什么要有这一层：`s.slice(0, N)` 数的是 **UTF-16 码元**，不是「字」。
 * 汉字（BMP）一个压一个码元，看不出问题；emoji、扩展 B 汉字（𠀀）、带修饰符的符号
 * 是代理对（2 码元），于是：
 *   · `'🍚'.repeat(300).slice(0, 500)` 只剩 250 个 emoji —— 上限被按码元吃掉了；
 *   · 499 个汉字 + 一个 emoji 时，第 500 个码元正好是代理对的前半截，切出来是
 *     **孤立高代理项**：JSON.stringify 会转成 "\ud83c"，写 UTF-8 文件时变成 U+FFFD，
 *     另一端解析到的就是坏字符串。
 * 凡是给「未知外部输入」（用户文本 / 拖进来的文件内容 / HTTP 回包 / 备份 JSON）
 * 定长度上限的地方，一律走 clipCodePoints，口径统一为「字」= Unicode 码点。
 *
 * host 与 client 共用；纯函数，不碰 DOM / 文件 / 网络。
 */

/**
 * 按 Unicode 码点截断到 max 个「字」。
 *
 * 语义（断言见 scripts/test-codepoint-truncation.mjs）：
 *   · 只在码点边界上切：代理对（绝大多数 emoji、扩展 B 汉字）不会被切成半个，
 *     结果里不会出现**新的**孤立代理项，字符串始终是合法 UTF-16；
 *   · 一个码点 ≠ 一个字素簇：ZWJ 组合（👨‍👩‍👧）、肤色修饰、国旗这类由多个码点
 *     拼出来的图形，可能被截在组合中间（得到 👨 或 👨‍👩）——仍是合法字符串，
 *     但图形不完整。要按"看起来的一个图形"切就得引入 Intl.Segmenter，
 *     本函数不背这个代价；调用方要的是"上限按字、不切坏编码"。
 *   · max 不是有限数 / NaN，或 ≤ 0 → 返回空串（0 与负数都是空，不是「全留」）；
 *   · 没超限时原样返回同一个字符串：先比 UTF-16 长度（码点数必然 ≤ 码元数），
 *     聊天主路径每条消息都过这里，不做多余的 Array.from；
 *   · 输入里**本来就有的**孤立代理项原样保留：本函数只保证「截断不再切坏」，
 *     不负责修复非法输入 —— 静默丢字符比留下坏字符更难排查。
 */
export function clipCodePoints(value: any, max: number): string {
  const s = value == null ? '' : String(value)
  const n = Number(max)
  if (Number.isNaN(n)) return ''
  if (n === Infinity) return s
  const limit = Math.floor(n)
  if (limit <= 0) return ''
  // 码点数 ≤ 码元数：码元都没超限，码点必然没超限，直接原样返回
  if (s.length <= limit) return s
  const cps = Array.from(s)
  return cps.length > limit ? cps.slice(0, limit).join('') : s
}
