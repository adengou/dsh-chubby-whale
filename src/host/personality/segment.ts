/**
 * host/personality/segment.ts —— 注入系统提示词的可变人格附加段（纯函数）
 *
 * 输出形如（没有心境时与旧版一致）：
 *   \n（你记得：主人的口头禅是「哼」；主人喜欢「安静」；备注：主人怕吵）
 *   \n（近期心境：最近有点犯困，话比平时少）
 *
 * 预算规则（需求写死）：
 *   · 整段（含换行、括号、「」、分隔符等全部字符）≤ PERSONALITY_LIMITS.segmentLen（160）；
 *   · 先给心境段预留位置（心境段最长 87 字：6 字包装 + 80 字心境 + 1 字右括号），剩余给记忆段；
 *   · 记忆段超预算时按 口头禅 → 偏好 → 备注 的顺序**整条**舍弃，绝不截半句；
 *   · 只有心境段自己都放不下时才丢心境。
 *
 * 审计结论（2026-11-06）：
 *   · 预算按 Unicode 码点计（charLen），且 head/tail/sep/引号/括号全部计入，不存在少算标点；
 *   · 舍弃以整条为粒度，不会出现「半句」；
 *   · `if (narrative && charLen(narrative) + 1 > total) narrative = ''` 在现有上限下不可达
 *     （心境≤80 → 段≤87，远小于 159），属于为日后调整上限预留的兜底，保留不改。
 */
import { PERSONALITY_LIMITS } from './model.js'
import type { PersonalityData } from './model.js'
import { charLen, sanitizePersonality } from './merge.js'

/**
 * 记忆段（口头禅→偏好→备注）在给定预算内渲染。
 * 预算不够时按 口头禅→偏好→备注 的顺序舍弃（从尾部逐条丢），绝不截半句。
 *
 * 导出仅用于离线单测（可绕过 buildPersonalitySegment 单独验预算边界）；
 * personality.ts 的对外接口不转出它，外部调用仍走 buildPersonalitySegment。
 */
export function buildMemorySegment(data: PersonalityData, budget: number): string {
  const head = '\n（你记得：'
  const tail = '）'
  const sep = '；'
  const catchphrases = data.catchphrases.slice()
  const preferences = data.preferences.slice()
  let note = data.notes
  const render = (): string => {
    const parts: string[] = []
    if (catchphrases.length) parts.push('主人的口头禅是' + catchphrases.map((s) => '「' + s + '」').join(''))
    if (preferences.length) parts.push('主人喜欢' + preferences.map((s) => '「' + s + '」').join(''))
    if (note) parts.push('备注：' + note)
    return parts.length ? head + parts.join(sep) + tail : ''
  }
  let text = render()
  // 上限保护：条目数最多 6+8+1，循环不会超过这个量级；guard 只为防意外死循环
  let guard = 0
  while (charLen(text) > budget && guard++ < 100) {
    if (catchphrases.length) catchphrases.pop()
    else if (preferences.length) preferences.pop()
    else if (note) note = ''
    else break
    text = render()
  }
  return charLen(text) <= budget ? text : ''
}

/**
 * 注入段：基础记忆 + L3 近期心境，总长度（含换行/括号）≤160 字。
 *
 * 舍弃顺序（需求写死）：口头禅 → 偏好 → 备注 → 心境。
 * 心境段先按“连换行最多 88 字”预留（心境段 87 字 + 换行 1 字），剩余预算才给记忆段；记忆段内的口头禅最先被丢，
 * 所以整体超限时一定是口头禅先舍、心境最后才动（只有心境段自己放不下才丢）。
 */
export function buildPersonalitySegment(raw: any): string {
  const data = sanitizePersonality(raw)
  const total = PERSONALITY_LIMITS.segmentLen
  let narrative = data.selfNarrative ? '（近期心境：' + data.selfNarrative + '）' : ''
  if (narrative && charLen(narrative) + 1 > total) narrative = ''
  const budget = narrative ? total - charLen(narrative) - 1 : total
  const memory = buildMemorySegment(data, Math.max(0, budget))
  if (!narrative) return memory
  return memory ? memory + '\n' + narrative : '\n' + narrative
}
