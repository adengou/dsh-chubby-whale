/**
 * client/voice/export-audio.ts —— 稿子 → 分段合成 mp3 + srt 字幕（零第三方依赖）
 *
 * 为什么要分段：宿主 /tts 单次上限 6000 字，而且整段合成没有时间轴、出不了字幕。
 * 按句切成 ≤MAX_SEG_CHARS 字的小段逐段合成：
 *   · 每段音频用 Web Audio decodeAudioData 拿**真实时长** → srt 时间轴是量出来的；
 *   · 各段 mp3 去掉 ID3v2 头后按序拼接成一个可播放文件（同一引擎参数一致）。
 * decodeAudioData 不可用时才退回按字数估算，并在返回值里如实标 measured=false。
 */
import { postRaw } from '../http.js'

/** 单段上限：与 `say` 的 80 字分段口径一致 */
export const MAX_SEG_CHARS = 80
/** 整篇上限：20000 字约等于半小时语音，再多就建议分文件 */
export const MAX_SCRIPT_CHARS = 20000
/**
 * 字幕单条上限：合成按 80 字段走，字幕却要逐句——
 * 播放器里一条塞 80 字会显示不全，看着就像「字幕不完整」。
 */
const SUBTITLE_MAX_CHARS = 32
/** decodeAudioData 不可用时的兜底：中文 TTS 大约 4.5 字/秒 */
const FALLBACK_CHARS_PER_SEC = 4.5
/** 句末标点：中英文都算，换行也断句 */
const SENTENCE_END = '。！？!?；;…\n'

export type ExportProgress = (done: number, total: number) => void

export type ExportResult = {
  audio: Blob
  srt: string
  segments: number
  /** true = 时长来自解码；false = 按字数估算 */
  measured: boolean
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n)
}

/** 秒 → srt 时间戳（00:00:00,000） */
export function srtTime(sec: number): string {
  const total = Math.max(0, Math.round(Number(sec) * 1000) || 0)
  const h = Math.floor(total / 3600000)
  const m = Math.floor((total % 3600000) / 60000)
  const s = Math.floor((total % 60000) / 1000)
  const ms = total % 1000
  return pad2(h) + ':' + pad2(m) + ':' + pad2(s) + ',' + String(ms).padStart(3, '0')
}

export function buildSrt(lines: Array<{ start: number; end: number; text: string }>): string {
  return lines
    .map((l, i) => (i + 1) + '\n' + srtTime(l.start) + ' --> ' + srtTime(l.end) + '\n' + l.text + '\n')
    .join('\n')
}

/**
 * 切句 → 分段：先按句末标点切开（保留标点），再把小句合并到 ≤max 字；
 * 单句超长时硬切。返回非空段列表。
 */
export function splitScript(text: string, max = MAX_SEG_CHARS): string[] {
  const src = String(text || '').replace(/\r\n/g, '\n').trim()
  if (!src) return []
  const parts: string[] = []
  let buf = ''
  for (const ch of src) {
    buf += ch
    if (SENTENCE_END.indexOf(ch) >= 0) {
      if (buf.trim()) parts.push(buf.trim())
      buf = ''
    }
  }
  if (buf.trim()) parts.push(buf.trim())

  const out: string[] = []
  let cur = ''
  for (const p of parts) {
    if (p.length > max) {
      if (cur) { out.push(cur); cur = '' }
      for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max))
      continue
    }
    if ((cur + p).length > max) { out.push(cur); cur = p }
    else cur += p
  }
  if (cur) out.push(cur)
  return out
}

/** 去掉 ID3v2 头：各段裸帧序列才能直接拼接播放（不是 ID3 开头的原样返回） */
export function stripId3(buf: Uint8Array): Uint8Array {
  if (buf.length > 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f)
    const footer = (buf[5] & 0x10) ? 10 : 0
    const start = 10 + size + footer
    return start < buf.length ? buf.subarray(start) : buf
  }
  return buf
}

/** 解码出一段音频的秒数；浏览器不支持或解码失败返回 null（调用方退回估算） */
function decodeDuration(buf: ArrayBuffer): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      const AC: any = (window as any).AudioContext || (window as any).webkitAudioContext
      if (!AC) { resolve(null); return }
      const ctx = new AC()
      let done = false
      const finish = (v: number | null): void => {
        if (done) return
        done = true
        try { ctx.close() } catch (e) { }
        resolve(v)
      }
      // decodeAudioData 会 detach 原缓冲，传副本
      const copy = buf.slice(0)
      const maybe = ctx.decodeAudioData(
        copy,
        (ab: any) => { const d = Number(ab && ab.duration) || 0; finish(d > 0 ? d : null) },
        () => finish(null),
      )
      if (maybe && typeof maybe.then === 'function') {
        maybe.then((ab: any) => { const d = Number(ab && ab.duration) || 0; finish(d > 0 ? d : null) }).catch(() => finish(null))
      }
    } catch (e) {
      resolve(null)
    }
  })
}

/**
 * 逐段合成并拼装。进度通过 onProgress(done, total) 回报给气泡。
 * 任一段失败即整体失败（保留错误里第几段，方便主人知道从哪断的）。
 */
export async function exportSpeechToAudio(opts: {
  text: string
  voice: string
  rate?: string
  onProgress?: ExportProgress
  signal?: any
}): Promise<ExportResult> {
  const segs = splitScript(opts.text)
  if (!segs.length) throw new Error('稿子是空的')
  const frames: Uint8Array[] = []
  const cues: Array<{ start: number; end: number; text: string }> = []
  let clock = 0
  let measured = true
  for (let i = 0; i < segs.length; i++) {
    const res = await postRaw('/tts', {
      text: segs[i],
      voice: opts.voice,
      rate: opts.rate || '+0%',
      pitch: '',
    }, { timeout: 120000, signal: opts.signal })
    if (!res || !res.ok) throw new Error('第 ' + (i + 1) + ' 段合成失败（HTTP ' + (res ? res.status : '?') + '）')
    const buf = await res.arrayBuffer()
    frames.push(stripId3(new Uint8Array(buf)))
    const dur = await decodeDuration(buf)
    if (dur == null) measured = false
    const seconds = dur == null ? segs[i].length / FALLBACK_CHARS_PER_SEC : dur
    // 字幕按句切（≤SUBTITLE_MAX_CHARS 字一条），段内时间按字数比例分配：
    // 合成仍按 80 字段走，字幕却是逐句的——播放器里一条塞不下 80 字。
    const subs = splitScript(segs[i], SUBTITLE_MAX_CHARS)
    const totalChars = subs.reduce((n, s) => n + s.length, 0) || 1
    let t = clock
    for (const s of subs) {
      const d = seconds * (s.length / totalChars)
      cues.push({ start: t, end: t + d, text: s })
      t += d
    }
    clock += seconds
    if (opts.onProgress) { try { opts.onProgress(i + 1, segs.length) } catch (e) { } }
  }
  return {
    audio: new Blob(frames as any[], { type: 'audio/mpeg' }),
    srt: buildSrt(cues),
    segments: segs.length,
    measured,
  }
}
