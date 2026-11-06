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
  /**
   * 音高（edge-tts 的 `pitch`，如 '+15Hz'）。
   * 2026-11-07 修：buildTtsJobs 原来没复制这个字段 —— speak({pitch}) 一路传到 voice.ts 就丢了，
   * /tts 请求体的 pitch 永远是空串（actions/culture.ts 的「念完啦」就带着 +15Hz）。
   */
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
 * 2026-11-06 预取并发：普通聊天也预取后 2 块（N+1、N+2），叙述预取后 3 块 ——
 * 播放第 N 段时后面两段已在合成，段间不必再等一次 /tts 往返。
 *
 * 只做“选谁”，合成与 Map 记账仍由 voice.ts 做。可选参数（在途上限）也留在这里，
 * 是为了让「取几块」和「最多并发几条」是同一条纯逻辑：
 *   · inflight：当前在途合成数（含刚发出的当前段），达到 maxInflight 就停；
 *   · has(seq)：已经预取过的段跳过，不重复发请求；
 *   · maxInflight 缺省 3 —— 宿主 edge-tts worker 单线程顺序处理（src/host/tts/worker.ts
 *     逐行读 stdin），多发只会把“马上要播的那一段”往后排，3 条已够覆盖一段 2~4 秒播放。
 */
export function prefetchTargets(
  queue: TtsJob[],
  narration: boolean,
  inflight = 0,
  has?: (seq: number) => boolean,
  maxInflight = 3,
): TtsJob[] {
  const depth = narration ? 3 : 2
  const cap = Math.max(0, Math.floor(Number(maxInflight) || 0))
  let n = Math.max(0, Math.floor(Number(inflight) || 0))
  const out: TtsJob[] = []
  for (let i = 0; i < depth && i < queue.length; i++) {
    const t = queue[i]
    if (has && has(t.seq)) continue
    if (n >= cap) break
    out.push(t)
    n++
  }
  return out
}

/**
 * 把切好的句子变成队列任务。
 * 约定：只有最后一段挂 onDone —— 上层（说书/念诗锁）等的是一整段读完，不是第一段。
 * seq 由调用方给起点，返回后调用方自己推进（原实现是 ++ttsSeq）。
 * pitch 必须逐段复制：synth() 直接读 job.pitch 拼 /tts 请求体，漏了就等于这个选项没实现。
 */
export function buildTtsJobs(
  segs: string[],
  opts: { rate: string; pitch?: string; narration: boolean; strict: boolean; nextSeq: number; onDone?: () => void },
): TtsJob[] {
  const out: TtsJob[] = []
  const pitch = opts.pitch ? String(opts.pitch) : undefined
  for (let i = 0; i < segs.length; i++) {
    out.push({
      seq: opts.nextSeq + i,
      text: segs[i],
      rate: opts.rate,
      pitch,
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

/**
 * 朗读队列上限（段数）。
 * 长说书/跨书连播一次能切出几十上百段；没有上限时，断网或合成卡死会让队列
 * 一直堆积（并发纪律自检清单「队列有没有上限？」的落点）。
 * 200 段 ≈ 半小时朗读量，正常单次朗读远达不到。
 */
export const TTS_QUEUE_MAX = 200

/**
 * 超出上限时丢弃**队首最旧的待播段**（正在播的那段已被 pumpTts 取走，不在数组里）。
 * 返回丢弃的段数；未超限返回 0。
 * 用一个纯函数而不是在 voice.ts 里手写 splice：可离线断言，边界（0/负数 max）也只有一处。
 */
export function capQueue<T>(q: T[], max: number = TTS_QUEUE_MAX): number {
  const limit = Math.max(0, Math.floor(Number(max) || 0))
  if (!Array.isArray(q) || q.length <= limit) return 0
  const drop = q.length - limit
  q.splice(0, drop)
  return drop
}
