/**
 * client/voice/echo-filter.ts —— 回声 / 短碎片 / 重复发言过滤（从 voice.ts 外提）
 *
 * 为什么单独成文件：这是"把鱼自己的话当成主人发言"的唯一防线，规则多、边界多，
 * 混在采集与 TTS 之间很难单测。这里收成一个纯状态对象：
 *   · spokenRecent —— 自己刚朗读过的整段（15 秒内参与比对，8 秒内算"刚说过"）
 *   · recentHeard —— 已放行的主人发言（交给 sim.ts 的 bigram Jaccard 去重）
 *   · acceptedSeg —— 已处理过的录音段号（同一段只处理一次；段号倒退 = ASR 结果乱序）
 *
 * 两处与字面规则不同的细节（都是实际会踩到的）：
 *   · 比对前统一小写：英文回复首字母大写、ASR 回声常见全小写，不归一就永远对不上
 *     （normalizePlain/echoKey 在 text.ts，被多处共用，不能动，所以在这里归一）；
 *   · 录音段号必须单调：正常流程段号递增；ASR 没有显式单飞护栏，onerror 重开窗口、
 *     关了再开等路径都可能让两段上传在途，旧段结果晚到时段号更小 —— 直接作废，
 *     绝不能当成主人的新发言（否则旧答案会盖住新问题）。
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
  /** 已处理过的录音段（最近 50 个）：同一段只放行/处理一次，防重试重复 */
  const acceptedSeg: number[] = []
  /**
   * 已处理过的最大段号：段号只增不减，若某个结果回来时段号更小，
   * 说明它是更早那段录音的迟到响应（ASR 无单飞时的乱序）→ 当重复处理丢弃。
   */
  let maxSegId = 0

  function noteSpoken(text: string, now?: number): void {
    const t = String(text || '').trim()
    if (!t) return
    spokenRecent.push({ text: t, at: typeof now === 'number' ? now : Date.now() })
    while (spokenRecent.length > 12) spokenRecent.shift()
  }

  function accept(text: string, nowIn?: number, segId?: number): EchoVerdict {
    // 同一录音段只处理一次：ASR 超时重试会把同一段识别两次，第二次间隔超过 8s 去重窗 → 会变成"自言自语"
    if (typeof segId === 'number') {
      // 段号只增不减：更小的段号 = 更早那段录音的迟到结果（ASR 没有单飞时的乱序）。
      // 当重复处理丢掉，绝不能当成主人的新发言（否则旧答案会盖住新问题）。
      // 计到调用方的 dup 桶里：语义同为"这段已经处理过/不该再算新话"。
      if (segId < maxSegId) return { ok: false, reason: 'dup' }
      if (acceptedSeg.indexOf(segId) >= 0) return { ok: false, reason: 'dup' }
      acceptedSeg.push(segId)
      while (acceptedSeg.length > 50) acceptedSeg.shift()
      if (segId > maxSegId) maxSegId = segId
    }
    // 小写归一：英文回复首字母大写、ASR 回声常见全小写；不做这一步，英文/中英混排回声永远对不上。
    // （normalizePlain / echoKey 在 text.ts 被多处共用，不能为回声单独改它们，所以在这里归一。）
    const plain = normalizePlain(text).toLowerCase()
    const plainKey = echoKey(text).toLowerCase()
    // 单字放行白名单：主人喊「停！」也要能打断说书/朗读。
    // 必须在噪声判定之前放行 —— isNoiseText() 会把所有单字判成噪声（"嗯/啊"那类气口），
    // 直接丢掉的话「停/别/不」这条打断路径就永远走不到。
    const interrupt = /^[停别不]$/.test(plain)
    if (plain.length < 2 && !interrupt) return { ok: false, reason: 'trivial' }
    if (!interrupt && isNoiseText(plain)) return { ok: false, reason: 'noise' }
    if (/^本鱼在听/.test(plain)) return { ok: false, reason: 'self' }
    // 自己刚说过的话（回声）
    const now = typeof nowIn === 'number' ? nowIn : Date.now()
    let hadRecentSpeech = false
    for (const s of spokenRecent) {
      if (now - s.at > 15000) continue
      if (now - s.at <= 8000) hadRecentSpeech = true
      const target = normalizePlain(s.text).toLowerCase()
      if (!target) continue
      // 去掉动作描写后的比对（专治"星号"回声）
      const targetKey = echoKey(s.text).toLowerCase()
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
    // 这里原有一条「text === lastText 且 8 秒内 → dup」：与上面的 isRepeat 完全重复
    // （lastText 就是最近一次放行的原句，且一定还在 recentHeard 里、isRepeat 会先命中），
    // 永远执行不到；删掉并把 lastText 状态一并移除，避免误以为还有第四道闸门。
    return { ok: true }
  }

  return {
    accept,
    noteSpoken,
    reset(): void {
      spokenRecent.length = 0
      recentHeard.length = 0
      acceptedSeg.length = 0
      maxSegId = 0
    },
  }
}
