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
 * 行为与拆分前逐字对齐（比较符、累加方式都没改；端点常量与判定策略在 2026-11 调整过，
 * 调整依据见各常量说明）：
 *   · 静音门槛是 -35dBFS（20*log10(600/32768) ≈ -34.7，对齐 C# 版 SilenceGate）；
 *   · 经典端点：说话累计 ≥250ms 且静音累计 ≥**动态阈值**（短句 750ms、长句 450ms，
 *     见 shared/sentence-boundary.ts 的 requiredQuietMs）才提前收尾，否则录满 4.5 秒；
 *   · 物理闭麦（muted）时阈值抬到 0dBFS：闭麦期间一律按静音累计（闭麦本来就收不到人声）。
 *
 * 2026-11-14 动态断句（修"一句一落切片太快"）：
 *   固定 450ms 一刀切对短句太狠（尾音/拖腔没停就切走），对长句又不够快。现在收尾静音
 *   按本段已累计的说话时长动态取值：≤800ms 语音要求 750ms 静音，≥4000ms 语音只需 450ms，
 *   中间线性插值（实现只在 shared/sentence-boundary.ts 一处，client 其它地方不许再写死）。
 *   WINDOW_MS 仍是 4500ms 硬上限。
 *
 * 2026-11 延迟审查（历史沿革，保留说明）：
 *   · 提前收尾 700→450ms（现在下限 450、短句可到 750）：真说完到"判定说完"是每句的
 *     固定延迟，700ms 太肉；动态化后短句多等一点防切碎，长句保持灵敏。
 *   · 窗口上限 6000→4500ms：一句一落是短句交互，4.5 秒足够说一句；长句被上限
 *     切开后由下一段继续录（录音/ASR 已解耦），不丢字，只是多一段识别。
 *   · 最短语音 400→250ms：保留短命令（"停""别读了"）的检出概率；低于 250ms 的
 *     人声仍会被当静音丢弃（防咳嗽/键盘声被识别成幻觉）。
 *   · TICK 60→45ms：判定粒度从 60ms 降到 45ms，比 40ms 少一点定时器压力；
 *     实际 setTimeout 有 1~5ms 漂移，真实静音时长会略长于标称值（偏保守，不容易切碎）。
 */

import { requiredQuietMs } from '../../shared/sentence-boundary.js'

/**
 * 一段录音的硬上限（C# 版 MaxMs=6000；2026-11 一句一落优化：6000→4500）
 * 一句一落是短句交互，窗口越短"没检测到端点"时的最坏等待越短；
 * 长句被这里切开后由下一段继续录，不丢字。
 */
export const WINDOW_MS = 4500
/**
 * 至少累计这么多“说话帧”才算有效语音（C# 版 ms<400 直接丢；2026-11：400→250）。
 * 短命令（停 / 别读了）本身只有一两百毫秒，门槛太高就永远等不到提前收尾。
 */
export const MIN_SPEECH_MS = 250
/** 整段峰值低于此值直接丢：静音送识别只会换来幻觉（C# 版 SilenceGate） */
export const SILENT_PEAK_DB = -35
/** 经典端点的说话帧门槛（dBFS） */
export const CLASSIC_SPEECH_DB = -45
/** 物理闭麦时的说话帧门槛：闭麦期间没有可信人声，一律按静音累计 */
export const MUTED_SPEECH_DB = 0
/** tick 间隔（与 APE 的 frameMs 对齐；2026-11：60→45，判定粒度更细） */
export const TICK_MS = 45
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
 * 经典端点：按 TICK_MS 一帧累计说话/静音时长。
 * 只用“帧数×TICK_MS”，不读真实时钟 —— 与拆分前一致（改成真实间隔会改判定时长；
 * 真实 setTimeout 的 1~5ms 漂移只会让实际静音略长于标称值，方向偏保守）。
 */
export function accrueClassic(s: SegmentState, db: number, muted: boolean): void {
  if (db > (muted ? MUTED_SPEECH_DB : CLASSIC_SPEECH_DB)) {
    s.speechMs += TICK_MS
    s.quietMs = 0
  } else {
    s.quietMs += TICK_MS
  }
}

/**
 * 经典端点是否该收尾：返回 quiet / timeout / ''（两者同时成立时优先 quiet，同原实现）
 *
 * 静音阈值不是固定值：按本段累计说话时长取 requiredQuietMs(speechMs) ——
 * 短语音多等（最多 750ms，防尾音/拖腔被切走），长语音少等（最快 450ms，别拖整段落地）。
 * 阈值实现只在 shared/sentence-boundary.ts 一处；这里只调用，不写死数字。
 */
export function shouldStopClassic(s: SegmentState, now: number): 'quiet' | 'timeout' | '' {
  if (s.speechMs >= MIN_SPEECH_MS && s.quietMs >= requiredQuietMs(s.speechMs)) return 'quiet'
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
