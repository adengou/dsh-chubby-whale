/**
 * client/voice/tts-queue.ts —— 朗读队列的纯函数与计时参数（从 voice.ts 外提）
 *
 * 边界（按「状态机不进里面」的纪律）：
 *   · 这里只有「怎么排、排多久、怎么切段、令牌是否过期」这些无副作用的判断；
 *   · 队列本身（ttsQ / ttsBusy / ttsAudio / 在途 AbortController）仍由 voice.ts 持有 ——
 *     它们是朗读状态机的一部分，搬出去就会出现两处改状态。
 */

/** 一段合成的硬超时（与看门狗的 synthTimeoutMs 对齐） */
export const TTS_TIMEOUT_MS = 20000
/** 看门狗轮询间隔 */
export const TTS_WATCH_MS = 1000
/** 这么久没有任何进展（开播/播放进度/收到新 chunk）且没在合法合成中 → 判僵死 */
export const TTS_ZOMBIE_MS = 2500
/** 朗读结束后继续闭麦/静音的时间（回声静音窗） */
export const ECHO_MUTE_MS = 700
/** 合成失败最多重试几次（4 次：500 + 1000 + 2000 + 4000ms，总等待 7.5 秒） */
export const TTS_RETRY_MAX = 4
/** 重试退避基数：第 n 次重试等 500 * 2^(n-1)（500/1000/2000/4000） */
export const TTS_RETRY_BASE_MS = 500

export type TtsJob = {
  seq: number
  text: string
  rate: string
  pitch?: string
  narration: boolean
  attempts: number
  strict: boolean
  onDone?: () => void
  /**
   * 发起这一段的纪元令牌：停止说话 / 看门狗复位会递增 speakToken，
   * 迟到的合成/播放/兜底回调靠它作废（令牌校验必须覆盖所有迟到回调）。
   */
  token?: number
}

/**
 * 第 attempt 次重试的退避时长（attempt 从 1 开始）：指数退避 500 → 1000 → 2000 → 4000。
 * 超出上限的 attempt 按最后一次算，保证总等待不会失控（4 次合计 7.5 秒）。
 */
export function ttsRetryDelayMs(attempt: number): number {
  const n = Math.max(1, Math.floor(Number(attempt) || 1))
  return TTS_RETRY_BASE_MS * Math.pow(2, Math.min(n, TTS_RETRY_MAX) - 1)
}

/**
 * 叙述（念诗/说书）段间换气停顿：照真人换气节奏给不同标点不同停顿。
 *   。！？… → 260ms（一句结束，标准值照参考实现）
 *   ，、；   → 140ms（句内小停顿，别拖）
 *   其他     → 200ms（没标点时取中）
 */
export function narrationPauseFor(text: string): number {
  const t = String(text || '').trim()
  if (!t) return 200
  const last = t.slice(-1)
  if (/[。！？!?…]/.test(last)) return 260
  if (/[，、；,;]/.test(last)) return 140
  return 200
}

/**
 * 当前段开始合成时，应该顺手把队列里哪几段压上去预合成。
 * 原实现：永远预取下一段；叙述模式再多预取一段（句子短、段间停顿明显，减少等合成空档）。
 * 只做“选谁”，合成与 Map 记账仍由 voice.ts 做。
 */
export function prefetchTargets(queue: TtsJob[], narration: boolean): TtsJob[] {
  const out: TtsJob[] = []
  if (queue[0]) out.push(queue[0])
  if (narration && queue[1]) out.push(queue[1])
  return out
}

/**
 * 把切好的句子变成队列任务。
 * 约定：只有最后一段挂 onDone —— 上层（说书/念诗锁）等的是一整段读完，不是第一段。
 * seq 由调用方给起点，返回后调用方自己推进（原实现是 ++ttsSeq）。
 */
export function buildTtsJobs(
  segs: string[],
  opts: { rate: string; narration: boolean; strict: boolean; nextSeq: number; onDone?: () => void },
): TtsJob[] {
  const out: TtsJob[] = []
  for (let i = 0; i < segs.length; i++) {
    out.push({
      seq: opts.nextSeq + i,
      text: segs[i],
      rate: opts.rate,
      narration: opts.narration,
      attempts: 0,
      strict: opts.strict,
      onDone: i === segs.length - 1 ? opts.onDone : undefined,
    })
  }
  return out
}

/** 令牌是否已过期（token 未设置视为不过期：兼容看门狗复位后补发令牌的路径） */
export function isStaleToken(token: number | undefined, current: number): boolean {
  return typeof token === 'number' && token !== current
}
