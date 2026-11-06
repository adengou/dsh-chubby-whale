/**
 * client/voice/echo-filter.ts —— 回声 / 短碎片 / 重复发言过滤（从 voice.ts 外提）
 *
 * 为什么单独成文件：这是"把鱼自己的话当成主人发言"的唯一防线，规则多、边界多，
 * 混在采集与 TTS 之间很难单测。这里收成一个纯状态对象：
 *   · spokenRecent —— 自己刚朗读过的整段（15 秒内参与比对，8 秒内算"刚说过"）
 *   · recentHeard —— 已放行的主人发言（交给 sim.ts 的 bigram Jaccard 去重）
 *   · lastText     —— 完全相同的上一句（8 秒内只放行一次）
 *
 * 统计不在这里记：原来同一事件在过滤内部与调用点各记一次（echoDropped 双计），
 * 现在统一由调用方按返回的 reason 记一次。
 */
import { echoKey, isShortEchoFragment, normalizePlain } from '../text.js'
import { isNoiseText } from '../../shared/noise.js'
import { isRepeat } from '../sim.js'

export type EchoVerdict = {
  ok: boolean
  /** ok=false 时的丢弃类别：调用方据此分桶计数 */
  reason?: 'trivial' | 'noise' | 'self' | 'echo' | 'short' | 'dup'
}

export type EchoFilter = {
  /** 过滤一句 ASR 结果（now 可注入，便于单测；默认 Date.now()） */
  /** segId：同一录音段的唯一号（防 ASR 超时重试把同段识别两次） */
  accept: (text: string, now?: number, segId?: number) => EchoVerdict
  /** 记下"自己刚朗读过的整段"（回声比对用） */
  noteSpoken: (text: string, now?: number) => void
  /** 清空全部记忆（换会话/卸载时可用） */
  reset: () => void
}

export function createEchoFilter(): EchoFilter {
  /** 自己刚说过的话（最多 12 条） */
  const spokenRecent: Array<{ text: string; at: number }> = []
  /** 已放行的主人发言（最多 3 条，供 sim.ts 去重） */
  const recentHeard: Array<{ text: string; at: number }> = []
  let lastText = ''
  let lastTextAt = 0
  /** 已处理过的录音段（最近 50 个）：同一段只放行/处理一次，防重试重复 */
  const acceptedSeg: number[] = []

  function noteSpoken(text: string, now?: number): void {
    const t = String(text || '').trim()
    if (!t) return
    spokenRecent.push({ text: t, at: typeof now === 'number' ? now : Date.now() })
    while (spokenRecent.length > 12) spokenRecent.shift()
  }

  function accept(text: string, nowIn?: number, segId?: number): EchoVerdict {
    // 同一录音段只处理一次：ASR 超时重试会把同一段识别两次，第二次间隔超过 8s 去重窗 → 会变成"自言自语"
    if (typeof segId === 'number') {
      if (acceptedSeg.indexOf(segId) >= 0) return { ok: false, reason: 'dup' }
      acceptedSeg.push(segId)
      while (acceptedSeg.length > 50) acceptedSeg.shift()
    }
    const plain = normalizePlain(text)
    const plainKey = echoKey(text)
    // 单字放行白名单：主人喊「停！」也要能打断说书/朗读
    if (plain.length < 2 && !/^[停别不]$/.test(plain)) return { ok: false, reason: 'trivial' }
    if (isNoiseText(plain)) return { ok: false, reason: 'noise' }
    if (/^本鱼在听/.test(plain)) return { ok: false, reason: 'self' }
    // 自己刚说过的话（回声）
    const now = typeof nowIn === 'number' ? nowIn : Date.now()
    let hadRecentSpeech = false
    for (const s of spokenRecent) {
      if (now - s.at > 15000) continue
      if (now - s.at <= 8000) hadRecentSpeech = true
      const target = normalizePlain(s.text)
      if (!target) continue
      // 去掉动作描写后的比对（专治"星号"回声）
      const targetKey = echoKey(s.text)
      if (plainKey && targetKey && (plainKey === targetKey || (targetKey.length >= 6 && plainKey.indexOf(targetKey.slice(0, 6)) >= 0))) {
        return { ok: false, reason: 'echo' }
      }
      if (plain === target) return { ok: false, reason: 'echo' }
      if (target.length >= 6 && plain.indexOf(target.slice(0, 6)) >= 0) return { ok: false, reason: 'echo' }
      if (plain.length >= 6 && target.indexOf(plain.slice(0, 6)) >= 0) return { ok: false, reason: 'echo' }
      // 短词回声：主人说 "master"，本鲸回复里也含 master，麦克风会把它听回去 → 就变成"说两遍"
      if (plain.length >= 3 && now - s.at < 6000 && target.indexOf(plain) >= 0) return { ok: false, reason: 'echo' }
    }
    // 刚朗读过又只听到 1~2 字 → 大概率是自己的回声碎片（实测「的歪」这类会被当成主人发言）
    if (isShortEchoFragment(plain, hadRecentSpeech)) return { ok: false, reason: 'short' }
    // 去重统一走 client/sim.ts 的相似度算法（bigram Jaccard）：
    // 窗口 8 秒、阈值 0.90 —— 只挡"刚说过的同一句被切成两段"，主人隔一会儿再说不会被吞。
    if (isRepeat(plain, { recent: recentHeard, windowMs: 8000, threshold: 0.9, minLen: 4, now })) {
      return { ok: false, reason: 'dup' }
    }
    recentHeard.push({ text, at: now })
    while (recentHeard.length > 3) recentHeard.shift()
    if (text === lastText && now - lastTextAt < 8000) return { ok: false, reason: 'dup' }
    lastText = text
    lastTextAt = now
    return { ok: true }
  }

  return {
    accept,
    noteSpoken,
    reset(): void {
      spokenRecent.length = 0
      recentHeard.length = 0
      lastText = ''
      lastTextAt = 0
    },
  }
}
