import { deepFreeze } from '../shared/immutable.js'

/**
 * client/rates.ts —— 朗读语速（叙述语速）
 *
 * 以前的坑：`chubby-narration-rate` 这个键**只有人读、没人写**（死键），
 * 而且 client.ts / voice.ts 各存了一份模块级快照，改了要刷新页面才生效。
 * 这里统一成"用时现读"的接口：菜单改完立即生效，两个模块读的是同一份。
 */

/** 允许的档位（菜单与校验共用） */
export const NARRATION_RATES: string[] = ['-15%', '-20%', '-25%', '-30%']
deepFreeze(NARRATION_RATES)

export const DEFAULT_NARRATION_RATE = '-25%'

/** 聊天语速可选档位（菜单用；默认 -20%：+0%/-10% 主人都觉得快） */
export const CHAT_RATES: string[] = ['-10%', '-20%', '-25%', '-30%']
deepFreeze(CHAT_RATES)

export const DEFAULT_CHAT_RATE = '-20%'

/** 读当前聊天语速（非法值回落默认 -20%）；用时现读，菜单改完立即生效 */
export function chatRate(): string {
  try {
    const s = localStorage.getItem('chubby-chat-rate')
    if (s && CHAT_RATES.indexOf(s) >= 0) return s
  } catch (e) { }
  return DEFAULT_CHAT_RATE
}

/** 写聊天语速；返回是否写入成功（非法值不写） */
export function setChatRate(rate: string): boolean {
  const v = String(rate || '').trim()
  if (CHAT_RATES.indexOf(v) < 0) return false
  try {
    localStorage.setItem('chubby-chat-rate', v)
    return true
  } catch (e) {
    return false
  }
}

/** 读当前叙述语速（非法值回落默认 -25%） */
export function narrationRate(): string {
  try {
    const s = localStorage.getItem('chubby-narration-rate')
    if (s && NARRATION_RATES.indexOf(s) >= 0) return s
  } catch (e) { }
  return DEFAULT_NARRATION_RATE
}

/** 写叙述语速；返回是否写入成功（非法值不写） */
export function setNarrationRate(rate: string): boolean {
  const v = String(rate || '').trim()
  if (NARRATION_RATES.indexOf(v) < 0) return false
  try {
    localStorage.setItem('chubby-narration-rate', v)
    return true
  } catch (e) {
    return false
  }
}
