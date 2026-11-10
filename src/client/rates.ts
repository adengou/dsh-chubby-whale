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

/**
 * 聊天语速可选档位（菜单用）。
 * 2026-11-10 主人要求「语速快一点」：默认从 -20% 提到 -10%；11-10 再调到 -15%（更自然）；
 * 之前 -20 是主人说 +0/-10 太快时定的，现在按新反馈回调一档。
 */
export const CHAT_RATES: string[] = ['+10%', '+0%', '-10%', '-15%', '-20%', '-30%']
deepFreeze(CHAT_RATES)

export const DEFAULT_CHAT_RATE = '-15%'

/** 说书语速默认值（主人反馈 -30% 仍略快 → -35%；菜单与播放器共用一份） */
export const DEFAULT_STORY_RATE = '-35%'

/** 念诗语速默认值（与叙述语速一致；菜单与念诗共用一份） */
export const DEFAULT_POEM_RATE = '-25%'

/**
 * 归一「-xx%」写法：只收 -1%～-99%（拒绝 -0% / -01% / -00% / -100% / +10% / 带小数）；
 * 不合法返回空串，由调用方决定回落值。读存储与校验 fallback 共用同一把尺子。
 */
function validPercent(v: unknown): string {
  const s = String(v == null ? '' : v).trim()
  return /^-(?:[1-9]\d?)%$/.test(s) ? s : ''
}

/**
 * 读「-xx%」形态的语速偏好（说书 / 念诗共用这一份读取口径）：
 * 读不到、浏览器禁存储、格式不对 → 回默认值。
 *
 * 校验边界：只收 -1%～-99%，且拒绝 -0% / -01% / -00% 这类写法——
 * 它们虽然能被正则放过，但换算成 TTS 语速是 0 或非规范值，念出来要么原速要么报错。
 * -100% 同样拒绝（三位数，且等于完全停住，不是可用的朗读档位）。
 */
function readPercentRate(key: string, fallback: string): string {
  try {
    const s = validPercent(localStorage.getItem(key))
    if (s) return s
  } catch (e) { }
  return fallback
}

/** 读当前说书语速（非法值回落默认 -35%） */
export function storyRate(): string {
  return readPercentRate('chubby-story-rate', DEFAULT_STORY_RATE)
}

/**
 * 读当前念诗语速（非法值回落 fallback，缺省 -25%）。
 *
 * fallback 也要过一遍校验：它来自调用方的 narrationRate()，历史上有过把脏值透传的先例；
 * 一旦 -200%/胡说 这类字符串漏进 TTS 的 rate 参数，念出来要么原速要么直接报错。
 * 非法 fallback 退回 DEFAULT_POEM_RATE。
 */
export function poemRate(fallback: string = DEFAULT_POEM_RATE): string {
  return readPercentRate('chubby-poem-rate', validPercent(fallback) || DEFAULT_POEM_RATE)
}

/** 读当前聊天语速（非法值回落默认 -20%）；用时现读，菜单改完立即生效 */
export function chatRate(): string {
  try {
    // 读侧也 trim：手改/旧版本可能留下 ' -10% '，不 trim 会静默回默认（写侧早就 trim 了）
    const s = String(localStorage.getItem('chubby-chat-rate') || '').trim()
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
    // 同 chatRate：读侧 trim，与写侧同口径
    const s = String(localStorage.getItem('chubby-narration-rate') || '').trim()
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
