/**
 * shared/poem.ts —— 诗词去重键（纯函数，路由与数据层共用）
 *
 * 口径：标题 + 作者 + 首句前 12 字。
 * 放在 shared 的原因：数据层用它去重，路由用它记「念过」，两边必须完全一致；
 * 同时避免路由为了一个纯函数去 import 数据层实现（依赖方向应该反过来）。
 */

export function poemKeyOf(p: any): string {
  const first = Array.isArray(p?.lines) ? String(p.lines[0] || '') : String(p?.text || '')
  return String(p?.title || '') + '|' + String(p?.author || '') + '|' + first.slice(0, 12)
}
