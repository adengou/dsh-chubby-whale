/**
 * host/routes/tts.ts —— 语音合成路由（可复用模块，带缓存）
 * HTTP/缓存/参数校验在本文件；「怎么合成」交给注入的 TtsEngine（默认 host/tts-engine.ts 的 edge-tts）。
 * 缓存：文本+音色+语速+音调 hash → 复用 mp3（省时间、省调用）
 * 语速由请求体 rate 决定（说书 -15%，普通聊天 +0%），服务端不再写死。
 */
import { hashKey } from '../cache.js'
import { sendTooLarge } from '../http.js'
import { readJsonBody } from '../body.js'
import { sendJson, sendError, sendBuffer } from '../respond.js'
import { normalizeRate } from '../../shared/tts.js'
import { createEdgeTtsEngine } from '../tts-engine.js'
import type { TtsRouteDeps } from '../ports.js'

/** 单次合成的安全上限：客户端已按 80 字分段，这里只防整本大 JSON 被一次送进来 */
const MAX_TEXT = 6000
/** 请求体上限：80 字一段的 JSON 只有几百字节，64KB 足够；超了多半是误发了整本数据 */
const TTS_MAX_BODY = 64 * 1024

export function createTtsHandler(opts: TtsRouteDeps) {
  const cache = opts.cache
  const engine = opts.engine || createEdgeTtsEngine()
  // 预热常驻 worker（只导入依赖、不合成）：首句不必再等 python 启动
  try {
    const w: any = engine as any
    if (typeof w.warm === 'function') void w.warm() 
  } catch { }

  return async function handleTts(req: any, res: any): Promise<void> {
    try {
      const parsed = await readJsonBody(req, TTS_MAX_BODY)
      if (!parsed.ok) {
        console.error('[tts] BODY-TOO-LARGE > ' + TTS_MAX_BODY + ' bytes')
        sendTooLarge(res)
        return
      }
      const body = parsed.body
      const msg = typeof body?.text === 'string' ? body.text.trim().slice(0, MAX_TEXT) : ''
      const voiceIn = typeof body?.voice === 'string' ? body.voice : ''
      const isZh = /[\u4e00-\u9fa5]/.test(msg)
      let voice = (voiceIn && /^[a-zA-Z0-9-]+$/.test(voiceIn)) ? voiceIn : ''
      if (!voice || voice === 'auto' || voice === 'zh-CN-XiaoyiNeural' || voice === 'en-US-AnaNeural') { voice = isZh ? 'zh-CN-XiaoyiNeural' : 'en-US-AnaNeural' }
      // 请求体里带了合法 rate 就用它（说书 -15%），没带默认 +0%
      const rate = normalizeRate(body?.rate, '+0%')
      // 音高：允许请求体指定（带情绪的语气），非法值回落到默认
      const pitchIn = typeof body?.pitch === 'string' ? body.pitch.trim() : ''
      const pitch = /^[+-]\d{1,3}Hz$/.test(pitchIn) ? pitchIn : (isZh ? '+10Hz' : '+15Hz')
      if (!msg) {
        sendJson(res, { ok: false, error: 'empty text' }, 400)
        return
      }
      // 缓存命中（rate/pitch 必须进 key，否则慢速说书和普通聊天会串味）
      const ck = hashKey(voice + '|' + rate + '|' + pitch + '|' + msg)
      if (cache) {
        const hit = await cache.getJson(ck, 'mp3')
        if (hit) {
          sendBuffer(res, hit, 'audio/mpeg', { 'cache-control': 'no-store' })
          return
        }
      }
      const buf = await engine.synthesize({ text: msg, voice, rate, pitch })
      if (cache) { try { await cache.setJson(ck, buf, 'mp3') } catch { } }
      sendBuffer(res, buf, 'audio/mpeg', { 'cache-control': 'no-store' })
    } catch (err: any) {
      try {
        // 合成不可用（没装 python/edge-tts）→ 501，客户端据此改用浏览器 speechSynthesis；其余 → 500
        const unavailable = Boolean(err && err.code === 'TTS_UNAVAILABLE')
        sendJson(res, {
          ok: false,
          code: unavailable ? 'TTS_UNAVAILABLE' : 'TTS_FAILED',
          error: String(err?.message || err),
        }, unavailable ? 501 : 500)
      } catch { }
    }
  }
}
