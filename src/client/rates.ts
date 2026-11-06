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

/** 说书语速默认值（主人反馈 -30% 仍略快 → -35%；菜单与播放器共用一份） */
export const DEFAULT_STORY_RATE = '-35%'

/** 念诗语速默认值（与叙述语速一致；菜单与念诗共用一份） */
export const DEFAULT_POEM_RATE = '-25%'

/**
 * 读「-xx%」形态的语速偏好（说书 / 念诗共用这一份读取口径）：
 * 读不到、浏览器禁存储、格式不对 → 回默认值。
 */
function readPercentRate(key: string, fallback: string): string {
  try {
    const s = localStorage.getItem(key)
    if (s && /^-\d{1,2}%$/.test(s)) return s
  } catch (e) { }
  return fallback
}

/** 读当前说书语速（非法值回落默认 -35%） */
export function storyRate(): string {
  return readPercentRate('chubby-story-rate', DEFAULT_STORY_RATE)
}

/** 读当前念诗语速（非法值回落 fallback，缺省 -25%） */
export function poemRate(fallback: string = DEFAULT_POEM_RATE): string {
  return readPercentRate('chubby-poem-rate', fallback)
}

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
