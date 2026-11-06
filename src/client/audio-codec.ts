/**
 * client/audio-codec.ts —— 录音编码协商与 WAV 封装（纯函数，不碰 DOM）
 *
 * 为什么要有这一层（真机差异，不是理论问题）：
 *   · Chrome / Edge / Firefox：MediaRecorder 一般给 webm（opus），可直接传宿主 /asr；
 *   · Safari：MediaRecorder 只给 audio/mp4，更老的 Safari 连 MediaRecorder 都没有。
 *   宿主 src/host/routes/asr.ts 的 format 白名单是 /^(webm|wav|mp3)$/，不认 mp4：
 *   把 mp4 字节标成 webm 送识别，能不能出字全看识别服务怎么探测容器 —— 不可靠。
 *   所以先在客户端协商编码；选到 mp4 时由调用方用 WebAudio 解成 16bit WAV 再传
 *   （wav 在宿主白名单内，识别服务对 wav 也最稳）。
 *
 * 本模块只做纯计算：编码候选、mime 归类、宿主 format 映射、PCM→WAV、多声道下混。
 * 浏览器 API（isTypeSupported / decodeAudioData）由调用方获取后传入或另处调用。
 */
import { deepFreeze } from '../shared/immutable.js'

/** 宿主 /asr 认识的格式（与 src/host/routes/asr.ts 的白名单保持一致） */
export type HostAsrFormat = 'webm' | 'wav' | 'mp3'

/** 浏览器实际可能录出来的容器 */
export type RecFormat = HostAsrFormat | 'mp4'

/**
 * MediaRecorder 依次尝试的编码。
 * 顺序是有意的：opus 在 webm 里体积最小、识别最稳；Safari 两个 webm 都 false 才轮到 mp4。
 */
export const RECORDER_MIME_CANDIDATES: string[] = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
]
deepFreeze(RECORDER_MIME_CANDIDATES)

/** WAV 头长度（44 字节，PCM 标准头） */
export const WAV_HEADER_BYTES = 44

/** 协商结果：mimeType 为空表示"不传 options，让浏览器自己选"（= 改造前的行为） */
export type RecorderPick = { mimeType: string; format: RecFormat }

/**
 * mime → 容器归类。
 * 认不出的一律按 webm 处理：宿主白名单里有它，最坏情况与改造前完全一致。
 */
export function formatFromMime(mime: unknown): RecFormat {
  const m = String(mime == null ? '' : mime).toLowerCase()
  if (m.indexOf('webm') >= 0) return 'webm'
  if (m.indexOf('wav') >= 0 || m.indexOf('wave') >= 0) return 'wav'
  if (m.indexOf('mpeg') >= 0 || m.indexOf('mp3') >= 0) return 'mp3'
  if (m.indexOf('mp4') >= 0 || m.indexOf('m4a') >= 0 || m.indexOf('aac') >= 0) return 'mp4'
  return 'webm'
}

/**
 * 挑一个 MediaRecorder 支持的编码。
 * isTypeSupported 全 false（或压根没有这个静态方法）时回退到"不指定 mimeType"，
 * 与改造前的 `new MediaRecorder(stream)` 行为一致 —— 绝不因为探测失败而不录音。
 */
export function pickRecorderMime(caps: { isTypeSupported?: (t: string) => boolean } | null | undefined): RecorderPick {
  const can: any = caps && typeof (caps as any).isTypeSupported === 'function' ? caps : null
  if (can) {
    for (let i = 0; i < RECORDER_MIME_CANDIDATES.length; i++) {
      const t = RECORDER_MIME_CANDIDATES[i]
      try {
        if (can.isTypeSupported(t)) return { mimeType: t, format: formatFromMime(t) }
      } catch (e) { }
    }
  }
  return { mimeType: '', format: 'webm' }
}

/**
 * 上传时带给宿主的 format。
 * 宿主只认 webm/wav/mp3：mp4 不在白名单里，显式回落成 webm（宿主本来也会这么兜），
 * 这样请求体里的 format 永远是"宿主认识的值"，不会出现莫名的 400。
 */
export function hostAsrFormat(format: RecFormat): HostAsrFormat {
  return format === 'wav' ? 'wav' : format === 'mp3' ? 'mp3' : 'webm'
}

/** 多声道下混成单声道（取平均；长度按最长声道算，缺失的采样按 0 处理） */
export function downmixToMono(channels: Array<Float32Array | number[]> | null | undefined): Float32Array {
  const list = (channels || []).filter(Boolean) as Array<Float32Array | number[]>
  if (!list.length) return new Float32Array(0)
  let len = 0
  for (let i = 0; i < list.length; i++) len = Math.max(len, list[i].length >>> 0)
  const out = new Float32Array(len)
  for (let c = 0; c < list.length; c++) {
    const ch = list[c]
    for (let i = 0; i < len; i++) {
      const v = i < ch.length ? Number(ch[i]) : 0
      out[i] += isFinite(v) ? v : 0
    }
  }
  if (list.length > 1) for (let i = 0; i < len; i++) out[i] = out[i] / list.length
  return out
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i) & 0xff)
}

/**
 * Float32 采样 → 16bit PCM 单声道 WAV（小端）。
 * 采样先夹到 [-1,1]，非有限值按 0；负半轴用 0x8000、正半轴用 0x7fff，避免削顶溢出。
 * 说明：16bit 单声道每个采样固定 2 字节，data 块长度恒为偶数，不会出现需要 padding 的奇数字节；
 * 头部各字段（RIFF size = 36 + data、byteRate = sr×2、blockAlign = 2）均按 PCM 标准填写。
 */
export function encodeWavPcm16(samples: Float32Array | number[] | null | undefined, sampleRate: number): ArrayBuffer {
  const src: any = samples || []
  const n = Math.max(0, src.length >>> 0)
  const rateRaw = Math.round(Number(sampleRate) || 48000)
  const sr = Math.max(8000, Math.min(96000, rateRaw))
  const dataBytes = n * 2
  // RIFF 的 size 字段只有 32 位：溢出会写出一个宿主/识别服务读不懂的坏头
  if (dataBytes > 0xffffffff - 36) throw new RangeError('wav too large')
  const buf = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes)
  const v = new DataView(buf)
  writeAscii(v, 0, 'RIFF')
  v.setUint32(4, 36 + dataBytes, true)
  writeAscii(v, 8, 'WAVE')
  writeAscii(v, 12, 'fmt ')
  v.setUint32(16, 16, true)      // fmt 块长度
  v.setUint16(20, 1, true)       // PCM
  v.setUint16(22, 1, true)       // 单声道
  v.setUint32(24, sr, true)
  v.setUint32(28, sr * 2, true)  // 字节率 = 采样率 × 声道 × 位深/8
  v.setUint16(32, 2, true)       // 块对齐
  v.setUint16(34, 16, true)      // 位深
  writeAscii(v, 36, 'data')
  v.setUint32(40, dataBytes, true)
  for (let i = 0; i < n; i++) {
    let s = Number(src[i])
    if (!isFinite(s)) s = 0
    if (s < -1) s = -1
    else if (s > 1) s = 1
    v.setInt16(WAV_HEADER_BYTES + i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true)
  }
  return buf
}

/**
 * WAV 能装下多少字节（调用方按它估算上传体积，避免超过宿主上限）。
 * 采样数向上取整：与 encodeWavPcm16 的实际 data 长度（n×2）保持同一口径，
 * 不用 round 是为了体积检查宁多算 2 字节，也别放过刚好卡线的情况。
 */
export function wavBytes(seconds: number, sampleRate: number): number {
  const sec = Math.max(0, Number(seconds) || 0)
  const sr = Math.max(8000, Math.min(96000, Math.round(Number(sampleRate) || 48000)))
  return WAV_HEADER_BYTES + Math.ceil(sec * sr) * 2
}
