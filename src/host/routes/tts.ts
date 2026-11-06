/**
 * host/routes/tts.ts —— 语音合成路由（可复用模块，带缓存）
 * HTTP/缓存/参数校验在本文件；「怎么合成」交给注入的 TtsEngine（默认 host/tts-engine.ts 的 edge-tts）。
 * 缓存：文本+音色+语速+音调 hash → 复用 mp3（省时间、省调用）
 * 语速由请求体 rate 决定（说书 -15%，普通聊天 +0%），服务端不再写死。
 */
import { hashKey } from '../../shared/hash.js'
import { sendTooLarge } from '../http.js'
import { readJsonBody } from '../body.js'
import { sendJson, sendBuffer } from '../respond.js'
import { normalizeRate, TTS_UNAVAILABLE } from '../../shared/tts.js'
import { createEdgeTtsEngine } from '../tts-engine.js'
import type { TtsRouteDeps } from '../ports.js'

/** 单次合成的安全上限：客户端已按 80 字分段，这里只防整本大 JSON 被一次送进来 */
const MAX_TEXT = 6000
/** 请求体上限：80 字一段的 JSON 只有几百字节，64KB 足够；超了多半是误发了整本数据 */
const TTS_MAX_BODY = 64 * 1024

/**
 * 连败闸门（纯进程内状态，不依赖任何平台能力）
 *
 * 背景（2026-11-06 实测）：edge-tts 偶发 NoAudioReceived / 超时；客户端每段会重试并回退 spawn，
 * 一次失败能刷出三行 traceback，分段朗读几十段就成了刷屏。
 * 收口方式：连续失败 DEGRADE_AFTER 次（或解释器/依赖确定不可用）→ 静默 DEGRADE_MS，
 * 期间直接回 501 让客户端改走浏览器朗读，不再调引擎、不再打堆栈；任意一次成功立即清零。
 * 阈值可用环境变量覆盖（测试与排障用），默认值即正式行为。
 */
const DEGRADE_AFTER = Math.max(1, Number(process.env.CHUBBY_TTS_DEGRADE_AFTER) || 2)
const DEGRADE_MS = Math.max(1, Number(process.env.CHUBBY_TTS_DEGRADE_MS) || 60 * 1000)

/** 错误文本压成一行：python 的 traceback 是多行的，逐段打全栈正是刷屏本体 */
function oneLine(err: any, max = 220): string {
  return String((err && err.message) || err || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

export function createTtsHandler(opts: TtsRouteDeps) {
  const cache = opts.cache
  const engine = opts.engine || createEdgeTtsEngine()
  // 每个 handler 一份闸门状态：测试里多次 createTtsHandler 互不串味
  const failGuard = { streak: 0, until: 0 }
  // 预热常驻 worker（只解析解释器、导入依赖，不合成）：首句不必再等 python 启动。
  // warm 自身保证不抛；这里再兜一层，防止自定义引擎的异步 rejection 变成未处理异常。
  try {
    const w: any = engine as any
    if (typeof w.warm === 'function') {
      const p = w.warm.call(engine)
      if (p && typeof p.catch === 'function') void p.catch(() => { })
    }
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
      // 降级窗口内：不调引擎、不打堆栈（进入窗口时已打过一行），回 501 让客户端改走浏览器朗读
      if (Date.now() < failGuard.until) {
        sendJson(res, { ok: false, code: TTS_UNAVAILABLE, error: 'tts degraded' }, 501)
        return
      }
      // 云端优先（火山豆包语音 2.0）：有 Key 且启用时先走云端；任何失败都回退 edge-tts（免费兜底）
      let buf: Buffer
      const cloud = opts.cloudTts
      if (cloud && cloud.enabled()) {
        try {
          buf = await cloud.synthesize(msg)
        } catch (ce: any) {
          console.warn('[tts] CLOUD-FAIL 回退 edge-tts：' + String(ce?.message || ce).slice(0, 200))
          buf = await engine.synthesize({ text: msg, voice, rate, pitch })
        }
      } else {
        buf = await engine.synthesize({ text: msg, voice, rate, pitch })
      }
      // 任意一次成功即视为恢复：清零连败计数与降级窗口
      failGuard.streak = 0
      failGuard.until = 0
      if (cache) { try { await cache.setJson(ck, buf, 'mp3') } catch { } }
      sendBuffer(res, buf, 'audio/mpeg', { 'cache-control': 'no-store' })
    } catch (err: any) {
      try {
        // 合成不可用（没装 python/edge-tts）→ 501，客户端据此改用浏览器 speechSynthesis；其余 → 500。
        // 连败闸门：连续失败到阈值（或依赖确定不可用）就进入静默窗口，期间不再逐段打堆栈。
        const wasUnavailable = Boolean(err && err.code === TTS_UNAVAILABLE)
        failGuard.streak++
        const degraded = wasUnavailable || failGuard.streak >= DEGRADE_AFTER
        const entering = degraded && Date.now() >= failGuard.until
        if (degraded) failGuard.until = Date.now() + DEGRADE_MS
        const detail = oneLine(err)
        if (entering) {
          console.error('[tts] ' + (wasUnavailable ? '语音合成不可用' : '连续 ' + failGuard.streak + ' 次合成失败')
            + '，' + Math.round(DEGRADE_MS / 1000) + 's 内改走浏览器朗读（不再逐段重试）：' + detail)
        } else if (!degraded) {
          // 只记录失败摘要（引擎侧已把 python stderr 截到前 500 字），不打印请求文本；压成一行
          console.error('[tts] 语音合成失败（' + failGuard.streak + '/' + DEGRADE_AFTER + '，回 500）：' + detail)
        }
        sendJson(res, {
          ok: false,
          code: degraded ? TTS_UNAVAILABLE : 'TTS_FAILED',
          error: detail,
        }, degraded ? 501 : 500)
      } catch { }
    }
  }
}
