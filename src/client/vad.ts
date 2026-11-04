/**
 * client/vad.ts —— 语音活动检测的纯逻辑（可单测、可在页面里自检）
 *
 * 为什么要把判定抽成纯函数：
 *   VAD 之前写在组件的 effect 里，出了问题只能靠"看现象猜"。
 *   抽出来以后可以
 *     ① 用合成电平序列做单元测试（Node 里跑，不需要麦克风）
 *     ② 在「耳朵自检」里现场跑一遍，把结果给主人看
 *
 * 判定规则（与 docs/耳朵算法.md 一致）：
 *   · 起判：电平 > 噪声底 + ONSET_DB，或 > ABS_ON_DB（绝对门槛）
 *   · 停判：电平 <= 噪声底 + OFFSET_DB 持续 SILENCE_LIMIT
 *   · 收尾条件：speechMs >= MIN_SPEECH_MS 且 quietMs >= SILENCE_LIMIT
 *   · 兜底：整段 >= VOICE_LIMIT + 1000 也算收尾
 *   · 噪声底只在"安静且明显低于底噪"时跟随，且下降快、上升慢
 */

export const ONSET_DB = 9
export const OFFSET_DB = 5
export const MIN_SPEECH_MS = 150
export const SILENCE_LIMIT = 350
export const VOICE_LIMIT = 5000
export const ABS_ON_DB = -45

export type VadState = {
  noiseDb: number | null
  speechMs: number
  quietMs: number
  peakDb: number
  elapsedMs: number
}

export function createVadState(): VadState {
  return { noiseDb: null, speechMs: 0, quietMs: 0, peakDb: -160, elapsedMs: 0 }
}

/** 每段开始时复位（噪声底保留：环境是连续的） */
export function resetVadSegment(s: VadState): void {
  s.speechMs = 0
  s.quietMs = 0
  s.peakDb = -160
  s.elapsedMs = 0
}

export type VadStep = {
  db: number
  /** 距离上一拍的真实毫秒数 */
  dtMs: number
  /** 阈值 */
  onsetDb: number
  offsetDb: number
  /** 是否语音结束 */
  ended: boolean
  /** 是否超时兜底结束 */
  tooLong: boolean
}

/**
 * 推进一拍。
 * @param s 状态（原地修改）
 * @param db 当前电平 dBFS
 * @param dtMs 距上一拍毫秒数
 */
export function stepVad(s: VadState, db: number, dtMs: number): VadStep {
  const dt = Math.max(0, Math.min(250, dtMs))
  s.elapsedMs += dt
  // 噪声底：初始取 min(当前, -35)；之后只在"安静且明显低于底噪+4dB"时跟随
  if (s.noiseDb === null) s.noiseDb = Math.min(db, -35)
  else if (db < s.noiseDb + 4) s.noiseDb = db < s.noiseDb ? s.noiseDb * 0.7 + db * 0.3 : s.noiseDb * 0.98 + db * 0.02
  if (s.noiseDb < -95) s.noiseDb = -95
  if (s.noiseDb > -20) s.noiseDb = -20

  const onsetTh = s.noiseDb + ONSET_DB
  const offsetTh = s.noiseDb + OFFSET_DB
  if (db > onsetTh || db > ABS_ON_DB) {
    s.speechMs += dt
    s.quietMs = 0
    if (db > s.peakDb) s.peakDb = db
  } else if (db <= offsetTh) {
    s.quietMs += dt
  }

  const ended = s.speechMs >= MIN_SPEECH_MS && s.quietMs >= SILENCE_LIMIT
  const tooLong = s.elapsedMs >= VOICE_LIMIT + 1000
  return { db, dtMs: dt, onsetDb: onsetTh, offsetDb: offsetTh, ended, tooLong }
}

/** 自检用：跑一段合成序列，返回每次结束事件的时间点与原因 */
export function simulate(samples: number[], dtMs = 60): { events: Array<{ atMs: number; why: 'ended' | 'tooLong' }>; peakDb: number } {
  const s = createVadState()
  const events: Array<{ atMs: number; why: 'ended' | 'tooLong' }> = []
  let t = 0
  for (const db of samples) {
    t += dtMs
    const r = stepVad(s, db, dtMs)
    if (r.ended || r.tooLong) {
      events.push({ atMs: t, why: r.ended ? 'ended' : 'tooLong' })
      resetVadSegment(s)
    }
  }
  return { events, peakDb: Math.round(s.peakDb * 10) / 10 }
}
