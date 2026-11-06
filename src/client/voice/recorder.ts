/**
 * client/voice/recorder.ts —— 录音段状态与门槛判定（纯数据 + 纯函数，不碰 MediaRecorder 生命周期）
 *
 * 为什么单独成文件：voice.ts 原先把「一段录音的统计状态」（parts / 峰值 / 说话时长 /
 * 静音时长 / 段起点）和「采集设备生命周期」（getUserMedia / AudioContext / MediaRecorder）
 * 混在一个闭包里，改一处门槛就要顺着 tick 通读全篇。
 * 这里只搬出前半截：段状态、电平读取、端点门槛。
 * 采集与状态机（running / status / 何时开始录）仍留在 voice.ts —— 那块一动就会连带
 * 状态转移，按「宁可不抽」的纪律不硬拆。
 *
 * 行为与拆分前逐字对齐（常量、比较符、累加方式都没改）：
 *   · 静音门槛是 -35dBFS（20*log10(600/32768) ≈ -34.7，对齐 C# 版 SilenceGate）；
 *   · 经典端点：说话累计 ≥400ms 且静音累计 ≥700ms 才提前收尾，否则录满 6 秒；
 *   · 物理闭麦（muted）时阈值抬到 0dBFS：闭麦期间一律按静音累计（闭麦本来就收不到人声）。
 */

/** 一段录音的硬上限（C# 版 MaxMs=6000） */
export const WINDOW_MS = 6000
/** 说完后连续静音多久提前收尾（C# 版 SilenceMs=700） */
export const EARLY_STOP_QUIET = 700
/** 至少累计这么多“说话帧”才算有效语音（C# 版 ms<400 直接丢） */
export const MIN_SPEECH_MS = 400
/** 整段峰值低于此值直接丢：静音送识别只会换来幻觉（C# 版 SilenceGate） */
export const SILENT_PEAK_DB = -35
/** 经典端点的说话帧门槛（dBFS） */
export const CLASSIC_SPEECH_DB = -45
/** 物理闭麦时的说话帧门槛：闭麦期间没有可信人声，一律按静音累计 */
export const MUTED_SPEECH_DB = 0
/** tick 间隔（与 APE 的 frameMs 一致） */
export const TICK_MS = 60
/** tick 抛错后的重试间隔 */
export const TICK_ERROR_MS = 120
/** 启动后多久还读不到任何电平 → 判定 analyser 不可用（自动播放策略挂起的典型表现） */
export const LEVEL_PROBE_MS = 1200
/** 太小的段不上传：静音 webm 也有容器开销，按体积兜底 */
export const MIN_SEGMENT_BYTES = 1200
/** APE：至少累计这么多说话时长才算有效语音 */
export const APE_MIN_SPEECH_MS = 150

/**
 * 老 Safari 没有 getFloatTimeDomainData 时的 8bit 兜底缓冲。
 * 用可变盒子持有，保证每帧复用同一块内存（原来就是闭包变量，别改成每帧新建）。
 */
export type LevelBox = { byte: Uint8Array | null }

/** 一次电平读数：db 为 dBFS；read=false 表示接口缺失/抛错（不是“安静”） */
export type LevelRead = { db: number; read: boolean }

/**
 * 读一次时域电平（dBFS）。
 * · 优先 getFloatTimeDomainData（Chrome/Edge/Firefox、Safari 14.1+）；
 * · 老 Safari 只有 getByteTimeDomainData：8bit 中心值 128 → 近似 [-1,1]；
 * · 接口缺失或抛错一律返回 -160，由调用方决定是否采信。
 */
export function readLevel(analyser: any, timeBuf: Float32Array | null, box: LevelBox): LevelRead {
  const an: any = analyser
  if (!an || !timeBuf) return { db: -160, read: false }
  let ok = false
  try {
    if (typeof an.getFloatTimeDomainData === 'function') {
      an.getFloatTimeDomainData(timeBuf as any)
      ok = true
    } else if (typeof an.getByteTimeDomainData === 'function') {
      let bytes = box.byte
      if (!bytes || bytes.length !== timeBuf.length) {
        bytes = new Uint8Array(timeBuf.length)
        box.byte = bytes
      }
      an.getByteTimeDomainData(bytes as any)
      for (let i = 0; i < timeBuf.length; i++) timeBuf[i] = (bytes[i] - 128) / 128
      ok = true
    }
  } catch (e) { ok = false }
  if (!ok) return { db: -160, read: false }
  let sum = 0
  for (let i = 0; i < timeBuf.length; i++) sum += timeBuf[i] * timeBuf[i]
  const rms = Math.sqrt(sum / timeBuf.length)
  const db = 20 * Math.log10(rms + 1e-8)
  return { db, read: true }
}

/** 一段录音的状态（只装统计量，不含设备句柄） */
export type SegmentState = {
  /** 已收到的音频块 */
  chunks: Blob[]
  /** 本段峰值电平（dBFS），用于“太安静”判定 */
  peakDb: number
  /** 说话帧累计（ms） */
  speechMs: number
  /** 静音帧累计（ms） */
  quietMs: number
  /** 段起点（performance.now()） */
  startedAt: number
}

export function createSegmentState(): SegmentState {
  return { chunks: [], peakDb: -160, speechMs: 0, quietMs: 0, startedAt: 0 }
}

/** 开新段：计数器必须整段复位（不清会“完全听不到”，这是修过的真 bug） */
export function resetSegmentState(s: SegmentState, startedAt: number): void {
  s.chunks = []
  s.peakDb = -160
  s.speechMs = 0
  s.quietMs = 0
  s.startedAt = startedAt
}

export function addChunk(s: SegmentState, blob: Blob): void {
  s.chunks.push(blob)
}

/** 丢弃本段已收的块（停止录音时的残响不再上传） */
export function clearChunks(s: SegmentState): void {
  s.chunks = []
}

export function notePeak(s: SegmentState, db: number): void {
  if (db > s.peakDb) s.peakDb = db
}

/**
 * 经典端点：按 60ms 一帧累计说话/静音时长。
 * 只用“帧数×TICK_MS”，不读真实时钟 —— 与拆分前完全一致（改成真实间隔会改判定时长）。
 */
export function accrueClassic(s: SegmentState, db: number, muted: boolean): void {
  if (db > (muted ? MUTED_SPEECH_DB : CLASSIC_SPEECH_DB)) {
    s.speechMs += TICK_MS
    s.quietMs = 0
  } else {
    s.quietMs += TICK_MS
  }
}

/** 经典端点是否该收尾：返回 quiet / timeout / ''（两者同时成立时优先 quiet，同原实现） */
export function shouldStopClassic(s: SegmentState, now: number): 'quiet' | 'timeout' | '' {
  if (s.speechMs >= MIN_SPEECH_MS && s.quietMs >= EARLY_STOP_QUIET) return 'quiet'
  if (now - s.startedAt >= WINDOW_MS) return 'timeout'
  return ''
}

/**
 * APE 路径的兜底：电平不可用时 APE 会一直判“静音”、永不提交（它会静默重置窗口继续录）。
 * 到窗口上限就强制收尾，交给上传前的体积/时长兜底。
 */
export function shouldStopApeNoLevel(s: SegmentState, levelDead: boolean, now: number): boolean {
  return !!(levelDead && now - s.startedAt >= WINDOW_MS)
}

/** 收段：按实际 mime 组装 Blob 并清空已收块（mime 必须由调用方给实际容器） */
export function takeBlob(s: SegmentState, type: string): Blob {
  const blob = new Blob(s.chunks, { type })
  s.chunks = []
  return blob
}

/** 太小的段不上传（静音 webm 也有容器开销） */
export function isTooSmallSegment(bytes: number): boolean {
  return bytes < MIN_SEGMENT_BYTES
}

/** 经典端点：整段峰值太安静就不上传 */
export function isSilentPeak(peakDb: number): boolean {
  return peakDb < SILENT_PEAK_DB
}

/** APE：本段是否已有有效语音（hadSpeech 且有足够说话时长） */
export function hadApeSpeech(step: any): boolean {
  return !!(step && step.hadSpeech && step.speechMs >= APE_MIN_SPEECH_MS)
}
