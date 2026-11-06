/**
 * client/voice/asr-audio.ts —— 上传前的音频容器准备（从 voice.ts 外提）
 *
 * 处理两件真机差异（不是理论问题）：
 *   · Safari 只能录 audio/mp4，而宿主白名单是 webm/wav/mp3 → 先在客户端用 WebAudio
 *     解成 16bit 单声道 WAV 再传；
 *   · 老 Safari 没有 Blob.arrayBuffer()，只能用 FileReader。
 *
 * 只做纯转换，不碰录音状态机：AudioContext / 录音 mime / 诊断回调都由调用方传入。
 * 行为与拆分前逐字一致（含 3 秒转码兜底、6MB 体积上限、失败回退原字节）。
 */
import {
  capSampleRate, formatFromMime, hostAsrFormat, downmixToMono, encodeWavPcm16, wavBytes,
  type RecFormat,
} from '../audio-codec.js'
import { clearT } from '../util.js'

export type AsrWire = { base64: string; format: 'webm' | 'wav' | 'mp3' }

export type AsrAudioDeps = {
  /** 解码用的 AudioContext（转 mp4 用）；没有就放弃转码，按原字节走 */
  actx: any
  /** 录音器协商到的 mime（blob.type 缺失时兜底） */
  recMime: string
  /** 诊断回调（转码失败时告诉上层） */
  onDiag?: (d: any) => void
  /** 转出的 WAV 超过这么多字节就放弃（宿主解码后上限 8MB，默认按 6MB 留余量） */
  maxWavBytes?: number
}

/** Blob → ArrayBuffer；用 FileReader（Blob.arrayBuffer() 在老 Safari 上没有） */
export function readBlobBuffer(blob: Blob): Promise<ArrayBuffer | null> {
  return new Promise((resolve) => {
    try {
      const fr = new FileReader()
      fr.onload = () => resolve((fr.result as ArrayBuffer) || null)
      fr.onerror = () => resolve(null)
      fr.readAsArrayBuffer(blob)
    } catch (e) { resolve(null) }
  })
}

/**
 * mp4 → 16bit 单声道 WAV。
 * decodeAudioData 在旧 Safari 只有回调式（Promise 式 14.1 才有），两种都接；
 * 3 秒没回调就当失败 → 回退原字节，绝不让转码把识别卡死。
 */
export function transcodeToWav(blob: Blob, actx: any, maxWavBytes = 6 * 1024 * 1024): Promise<Blob | null> {
  return new Promise((resolve) => {
    const ctx: any = actx
    if (!ctx || typeof ctx.decodeAudioData !== 'function') { resolve(null); return }
    let settled = false
    let timeout: any = null
    const done = (wav: Blob | null) => {
      if (settled) return
      settled = true
      // 成功路径原来不清这 3 秒兜底定时器（settled 守卫只是让它空转），这里顺手清掉
      clearT(timeout)
      resolve(wav)
    }
    const finish = (buf: any) => {
      try {
        if (!buf || !buf.numberOfChannels) { done(null); return }
        const chans: Float32Array[] = []
        const n = Math.min(2, Number(buf.numberOfChannels) || 1)
        for (let i = 0; i < n; i++) chans.push(buf.getChannelData(i))
        const mono = downmixToMono(chans)
        // 设备可能是 192kHz（AudioContext 跟随输出设备）：先降到 ≤96k，
        // 否则 encodeWavPcm16 会把头部夹成 96k 而数据仍是 192k —— 半速音频，识别必错。
        const capped = capSampleRate(mono, buf.sampleRate)
        const samples = capped.samples
        const rate = capped.sampleRate
        if (wavBytes(samples.length / rate, rate) > maxWavBytes) { done(null); return }
        done(new Blob([encodeWavPcm16(samples, rate)], { type: 'audio/wav' }))
      } catch (e) { done(null) }
    }
    readBlobBuffer(blob).then((ab) => {
      if (!ab) { done(null); return }
      try {
        const ret: any = ctx.decodeAudioData(ab, finish, () => done(null))
        if (ret && typeof ret.then === 'function') ret.then(finish).catch(() => done(null))
      } catch (e) { done(null) }
    })
    timeout = setTimeout(() => done(null), 3000)
  })
}

/** Blob → base64（去掉 dataURL 前缀） */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    try {
      const fr = new FileReader()
      fr.onloadend = () => {
        const s = String(fr.result || '')
        resolve(s.indexOf(',') >= 0 ? s.slice(s.indexOf(',') + 1) : s)
      }
      // 审计补丁：原来只有 onloadend，没有 onerror。FileReader 读失败时 Promise 永不
      // resolve → onWindowDone 卡在 await 上 → finally 不执行 → 再也不排下一段录音（整只鱼变聋）。
      fr.onerror = () => resolve('')
      fr.readAsDataURL(blob)
    } catch (e) { resolve('') }
  })
}

/**
 * 上传前准备：确定实际容器；mp4 先转 WAV，转不动就按原字节走。
 * 返回的 format 一定是宿主认识的值（webm/wav/mp3）。
 */
export async function prepareAudioForAsr(blob: Blob, deps: AsrAudioDeps): Promise<AsrWire | null> {
  const recMime = String(deps && deps.recMime || '')
  const onDiag = deps && deps.onDiag
  const maxWavBytes = deps && typeof deps.maxWavBytes === 'number' ? deps.maxWavBytes : 6 * 1024 * 1024
  let src: Blob = blob
  let fmt: RecFormat = formatFromMime(blob.type || recMime)
  if (fmt === 'mp4') {
    const wav = await transcodeToWav(blob, deps && deps.actx, maxWavBytes)
    if (wav) { src = wav; fmt = 'wav' } else {
      try { onDiag && onDiag({ stage: 'mp4-no-transcode', hint: 'mp4 没能转成 wav，按原字节上传' }) } catch (e) { }
    }
  }
  const b64 = await blobToBase64(src)
  if (!b64) return null
  return { base64: b64, format: hostAsrFormat(fmt) }
}
