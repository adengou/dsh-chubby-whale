import { deepFreeze } from '../shared/immutable.js'
/**
 * client/ape.ts —— APE 端点检测（Adaptive Percentile Endpointing）
 *
 * 为什么不再用固定分贝阈值：
 *   之前用「-45dBFS 起判 / -35dBFS 门限 / 峰值-8dB 判静音」，换麦克风、改音量、开 AGC、
 *   换房间就全错：要么永远判"没说话"（等满窗口），要么永远判"还在说话"（也等满窗口），
 *   要么说话中途被误判静音（句子被切断）。四次失败都是这一个根因。
 *
 * APE 的三层设计（全部相对噪声底，不写死绝对电平）：
 *   ① 噪声底估计器：**只在安静时更新**（db <= floor + 6 才跟随，慢速 EMA），
 *      并且当电平"持续处于中间带"超过 1 秒时，也允许噪声底缓慢上移 ——
 *      这样环境噪声整体变大（空调开、换房间）时能跟上，而正常说话不会把底噪带高。
 *   ② 双阈值滞回：起判 = floor + margin（margin 随动态范围自适应 4…14dB），
 *      停判 = floor + 6dB。中间带两边都不计入，防抖动。
 *   ③ 句尾窗自适应：短句 300ms / 中句 450ms / 长句 600ms。
 *      日常短句比固定 700ms 省 400ms，这就是"回答更快"的来源。
 *
 * 纯函数状态机：可在 Node 里用合成波形单测，不依赖麦克风。
 */

export type ApeParams = {
  /** 帧长（ms），与主循环 tick 一致 */
  frameMs: number
  /** 噪声底 EMA 系数（下降时用） */
  floorDownAlpha: number
  /** 噪声底 EMA 系数（缓慢上升时用） */
  floorUpAlpha: number
  /** 判定"安静"的余量：db <= floor + 该值 → 视为安静，可更新噪声底 */
  quietMarginDb: number
  /** 停判余量：db <= floor + 该值 → 计入静音时长 */
  offsetMarginDb: number
  /** 动态范围 → 起判余量：margin = clamp(range * ratio, min, max) */
  marginRatio: number
  marginMinDb: number
  marginMaxDb: number
  /** 峰值包络衰减（dB/帧）：保证说话音量变化时 margin 能回落 */
  peakDecayDb: number
  /** 持续处于中间带这么久后，允许噪声底缓慢上移（跟踪环境变化） */
  driftAfterMs: number
  /** 句长分级与对应静音确认窗（ms） */
  shortRunMs: number
  longRunMs: number
  quietShortMs: number
  quietMidMs: number
  quietLongMs: number
  /** 一段里至少累计这么多说话时长才算有效语音 */
  minSpeechMs: number
  /** 稳态噪声允许高出噪声底多少 dB（超过就当人声，见 APE_DEFAULTS 里的说明） */
  steadyMaxAboveFloorDb: number
  /**
   * 说完话后最多再等多久（毫秒）。背景噪声落在"中间带"（高于安静阈值、又不到起判阈值）时，
   * 静音永远不累计——实测会让每句话都等满 6 秒窗口。用"距最后一次说话帧的时长"兜底。
   */
  maxWaitAfterSpeechMs: number
  /** 判定为"环境噪声"的电平上限：比底噪高出多少 dB 以内才算噪声（防止把大声讲话当噪声） */
  noiseNearDb: number
  /** 平稳性判别：电平起伏小于 spreadDb 且持续 steadyMs → 判定为环境噪声而非说话 */
  steadyWindowFrames: number
  steadySpreadDb: number
  steadyMs: number
  /** 单段硬上限 */
  maxSegmentMs: number
}

export const APE_DEFAULTS: ApeParams = {
  frameMs: 60,
  floorDownAlpha: 0.25,
  floorUpAlpha: 0.03,
  quietMarginDb: 6,
  offsetMarginDb: 6,
  marginRatio: 0.45,
  marginMinDb: 4,
  marginMaxDb: 14,
  peakDecayDb: 0.3,
  driftAfterMs: 1000,
  shortRunMs: 1200,
  longRunMs: 3000,
  quietShortMs: 300,
  quietMidMs: 450,
  quietLongMs: 600,
  minSpeechMs: 150,
  maxWaitAfterSpeechMs: 900,
  noiseNearDb: 14,
  /**
   * 稳态噪声允许高出噪声底多少 dB。
   * 取 20：风扇/空调常压在 15~20dB；而"持续大声说话"一般高出 25dB 以上，
   * 不会被误当噪声（试过 28，合成的一直 -45dB 语音会被判成噪声、永远不提交）。
   */
  steadyMaxAboveFloorDb: 20,
  maxSegmentMs: 6000,
  /**
   * 平稳性判别窗口（帧）。10 帧 × 60ms = 600ms。
   * 注意：起判前至少采 8 帧再算起伏（见 step 里的 minFrames，窗口配得更小时按窗口本身算）；
   * 这里原来写「25 帧 = 1.5s」是旧稿注释，与取值不符，2026-11-07 按实际取值改正。
   */
  steadyWindowFrames: 10,
  steadySpreadDb: 3,
  steadyMs: 400,
}
deepFreeze(APE_DEFAULTS)

/**
 * 电平哨兵：readLevel() 读不到时返回 -160，数字静音（rms=0）算出来同样是 -160。
 * APE 把"不高于它"的帧当作没有有效电平（见 step 里的 valid 判断）。
 */
const SENTINEL_DB = -160

export type ApeStep = {
  db: number
  floorDb: number
  onsetTh: number
  offsetTh: number
  speechMs: number
  quietMs: number
  elapsedMs: number
  hadSpeech: boolean
  quietTargetMs: number
  commit: boolean
  commitReason: 'quiet' | 'overflow' | ''
}

export class Ape {
  readonly p: ApeParams
  private floorDb: number | null = null
  private peakDb = -160
  private speechMs = 0
  private quietMs = 0
  private elapsedMs = 0
  private runMs = 0
  private hadSpeech = false
  private lastSpeechAtMs = 0
  private noiseTail = false
  private bandMs = 0
  private steadyHist: number[] = []
  private steadyMs = 0

  constructor(params?: Partial<ApeParams>) {
    this.p = { ...APE_DEFAULTS, ...(params || {}) }
  }

  resetSegment(): void {
    this.steadyHist = []
    this.steadyMs = 0
    this.speechMs = 0
    this.quietMs = 0
    this.elapsedMs = 0
    this.runMs = 0
    this.hadSpeech = false
    this.noiseTail = false          // 上一段的"噪声尾"标记不能带到下一段（会提前收尾）
    this.bandMs = 0
  }

  resetNoise(): void {
    this.floorDb = null
    this.peakDb = -160
  }

  floor(): number {
    return this.floorDb === null ? -70 : this.floorDb
  }

  step(rawDb: number): ApeStep {
    const p = this.p
    /**
     * 有效电平 = 有限值且高于哨兵 -160。
     *
     * 为什么要单列：readLevel() 在 analyser 读不到时返回 -160；数字静音（rms=0）
     * 按 `20*log10(rms+1e-8)` 算出来也正好是 -160；AudioContext 被自动播放策略挂起时
     * analyser 恒返回 0，同样落在这个值上（voice.ts 里记着这条实测）。
     * 这类帧一旦写进噪声底，起判阈值会被压到 floor+4 ≈ -156：之后任何真实电平都算
     * "说话"，安静帧再也出现不了 → 噪声底永远回不来，每段都要等满 6 秒按 overflow 收尾。
     * NaN / ±Infinity 更直接：写进去后 onsetTh 变 NaN（所有比较为假，永远判不出发言）
     * 或 -Infinity（所有帧误判成说话）。
     *
     * 处理：按"安静帧"推进时长（窗口要按时间收口，不能因为读不到电平就永不停止录音），
     * 但**不参与噪声底 / 峰值估计**，也不初始化噪声底。
     */
    const valid = Number.isFinite(rawDb) && rawDb > SENTINEL_DB
    // 无效帧的 db 只用于诊断展示（写当前噪声底），不参与任何判定
    const db = valid ? rawDb : this.floor()

    if (valid) {
      if (this.floorDb === null) this.floorDb = db
      // 峰值包络（随时间衰减，用于算动态范围）
      if (db > this.peakDb) this.peakDb = db
      else this.peakDb = Math.max(-160, this.peakDb - p.peakDecayDb)
    }

    const floorNow = this.floor()
    const range = this.peakDb - floorNow
    const margin = Math.max(p.marginMinDb, Math.min(p.marginMaxDb, range * p.marginRatio))
    const onsetTh = floorNow + margin
    const offsetTh = floorNow + p.offsetMarginDb

    this.elapsedMs += p.frameMs

    if (!valid) {
      // 没有有效电平：只按安静推进（噪声底原样不动，理由见上）
      this.quietMs += p.frameMs
      this.bandMs = 0
    } else if (db > onsetTh) {
      // 说话帧。先做平稳性判别：真人说话电平必有起伏（>3dB），恒定电平是环境噪声
      this.steadyHist.push(db)
      while (this.steadyHist.length > p.steadyWindowFrames) this.steadyHist.shift()
      // 起伏判别至少要采几帧：默认窗口 10 帧时取 8；窗口被调小（参数是可配的）时
      // 按窗口本身取。原来这里写死 8，steadyWindowFrames < 8 时窗口永远采不满 →
      // 恒定噪声永远判不出"平稳"，每段都要等满 maxSegmentMs（6000ms）才按 overflow 收尾。
      const minFrames = Math.max(2, Math.min(8, p.steadyWindowFrames))
      const spread = this.steadyHist.length >= minFrames
        ? Math.max(...this.steadyHist) - Math.min(...this.steadyHist)
        : 99
      const nearFloor = (db - this.floorDb) <= p.steadyMaxAboveFloorDb
      const steadyNow = spread < p.steadySpreadDb && nearFloor

      if (steadyNow) {
        this.steadyMs += p.frameMs
        if (this.steadyMs >= p.steadyMs) {
          // 恒定电平持续够久 = 环境噪声（风扇、空调等）。
          // 不能直接抹掉已成立的说话，但要从这一帧开始把它当"安静"来累计，
          // 否则静音永远涨不起来，一句话就要白等满 6 秒窗口（实测过）。
          this.noiseTail = true
          this.floorDb = this.floorDb * 0.7 + db * 0.3
        }
      } else {
        this.steadyMs = 0
        this.noiseTail = false
      }

      if (this.noiseTail) {
        // 噪声尾：按安静累计（这样才能提前收尾）
        this.quietMs += p.frameMs
        this.bandMs = 0
      } else {
        this.speechMs += p.frameMs
        this.runMs += p.frameMs
        this.hadSpeech = true
        this.lastSpeechAtMs = this.elapsedMs
        this.quietMs = 0
        this.bandMs = 0
      }
    } else if (db <= offsetTh) {
      // 安静帧：噪声底跟随（下降快）
      this.quietMs += p.frameMs
      this.bandMs = 0
      this.floorDb = this.floorDb * (1 - p.floorDownAlpha) + db * p.floorDownAlpha
    } else {
      // 中间带：两边都不计；持续太久说明环境整体抬升 → 噪声底缓慢上移
      this.bandMs += p.frameMs
      if (this.bandMs >= p.driftAfterMs) {
        this.floorDb = this.floorDb * (1 - p.floorUpAlpha) + db * p.floorUpAlpha
      }
    }

    const quietTargetMs = this.runMs < p.shortRunMs
      ? p.quietShortMs
      : (this.runMs < p.longRunMs ? p.quietMidMs : p.quietLongMs)

    // 说完话后兜底：有些背景噪声落在中间带、或刚过阈值又不够"平稳"，
    // quietMs 涨不起来，会一直等到 maxSegmentMs（6 秒）。按"距最后一次说话帧"收尾。
    const sinceSpeechMs = this.hadSpeech ? Math.max(0, this.elapsedMs - this.lastSpeechAtMs) : 0
    const overSpeechWait = this.hadSpeech && sinceSpeechMs >= p.maxWaitAfterSpeechMs
    const validSpeech = this.speechMs >= p.minSpeechMs
    let commit = false
    let commitReason: 'quiet' | 'overflow' | '' = ''
    if (validSpeech && this.quietMs >= quietTargetMs) { commit = true; commitReason = 'quiet' }
    else if (validSpeech && overSpeechWait) { commit = true; commitReason = 'quiet' }
    else if (this.elapsedMs >= p.maxSegmentMs) {
      if (validSpeech) { commit = true; commitReason = 'overflow' }
      else {
        // 一直是静音：静默重置窗口，继续录；不能把一段空气送去 ASR（缓存里曾堆满 17 字节噪声）
        this.elapsedMs = 0
        this.runMs = 0
        this.quietMs = 0
        this.speechMs = 0
        this.bandMs = 0
        this.hadSpeech = false
        this.lastSpeechAtMs = 0
      }
    }

    return {
      db,
      floorDb: this.floor(),
      onsetTh,
      offsetTh,
      speechMs: this.speechMs,
      quietMs: this.quietMs,
      elapsedMs: this.elapsedMs,
      hadSpeech: this.hadSpeech,
      quietTargetMs,
      commit,
      commitReason,
    }
  }
}

/** 单元测试用：跑一段合成序列 */
export function simulateSegment(dbSeq: number[], params?: Partial<ApeParams>): { step: ApeStep; frames: number } {
  const ape = new Ape(params)
  let last: ApeStep | null = null
  for (let i = 0; i < dbSeq.length; i++) {
    last = ape.step(dbSeq[i])
    if (last.commit) return { step: last, frames: i + 1 }
  }
  // 空序列时 last 为 null：调用方取 .commit 会崩，返回一个未收尾的空步骤
  if (!last) return { step: { db: 0, floorDb: 0, onsetTh: 0, offsetTh: 0, speechMs: 0, quietMs: 0, elapsedMs: 0, hadSpeech: false, quietTargetMs: 0, commit: false, commitReason: '' }, frames: 0 }
  return { step: last, frames: dbSeq.length }
}
