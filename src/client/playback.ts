/**
 * client/playback.ts —— 朗读看门狗的判定（纯函数，可单测）
 *
 * 为什么单独抽出来：原来看门狗只有一个条件「ttsBusy 超过 2.5 秒还没音频就是僵尸」，
 * 但 TTS 合成本身就要 3–4 秒（实测 3035/3848/4015ms）。于是：
 *   合成还没回来 → 被判僵尸 → 复位 → 开始合成下一段
 *   前一段回来时 token 已变 → 整段被丢弃
 * 症状就是念长诗「从第三句开始」。
 *
 * 正确语义：
 *   · 有音频且在播       → 健康
 *   · 没有音频但正在合成 → 只要没超过合成超时（20s）就健康
 *   · 有音频但不动       → 超过 zombieMs 才是僵尸
 *   · 没有音频且合成也超时 → 才是僵尸
 */

export type ZombieInput = {
  /** 当前是否有音频元素 */
  hasAudio: boolean
  /** 音频元素是否在正常播放 */
  audioPlaying: boolean
  /** 是否处于"一段朗读处理中" */
  busy: boolean
  /** 本段开始的时刻 */
  busySince: number
  /** 本段合成开始的时刻（0 表示还没开始合成） */
  synthAt: number
  /** 当前时刻 */
  now: number
  /** 播放停滞多久算僵尸，默认 2500ms */
  zombieMs?: number
  /** 合成最长允许多久，默认 20000ms（与 TTS_TIMEOUT_MS 对齐） */
  synthTimeoutMs?: number
}

export function isPlaybackZombie(p: ZombieInput): boolean {
  const zombieMs = p.zombieMs === undefined ? 2500 : p.zombieMs
  const synthTimeoutMs = p.synthTimeoutMs === undefined ? 20000 : p.synthTimeoutMs
  if (!p.busy) return false
  if (p.hasAudio && p.audioPlaying) return false
  // 没有音频、但合成还在进行中且没超时 → 正常等待，不是僵尸
  if (!p.hasAudio && p.synthAt > 0 && p.now - p.synthAt < synthTimeoutMs) return false
  return p.now - p.busySince >= zombieMs
}
