/**
 * host/routes/asr.ts —— 语音识别路由（硅基流动 Qwen3-ASR）
 * POST JSON { audio: base64, format: 'webm'|'wav'|'mp3' } → { text }
 * Key 来源：插件 config.json 的 siliconflowKey > 环境变量 SILICONFLOW_API_KEY
 */
import { readFileSync } from 'node:fs'
import { hashBytes } from '../cache.js'
import { join } from 'node:path'

const ASR_MODEL = 'Qwen/Qwen3-ASR-1.7B'
const ENDPOINT = 'https://api.siliconflow.cn/v1/audio/transcriptions'
/** 识别结果的缓存有效期：7 天（音频字节内容 hash，同一个录音重放可直接命中） */
const ASR_CACHE_MAX_AGE = 7 * 24 * 3600 * 1000

export function readSiliconFlowKey(pluginDir: string): string {
  try {
    const cfg = JSON.parse(readFileSync(join(pluginDir, 'config.json'), 'utf8'))
    if (cfg && typeof cfg.siliconflowKey === 'string' && cfg.siliconflowKey.trim()) return cfg.siliconflowKey.trim()
  } catch { }
  try {
    if (process.env.SILICONFLOW_API_KEY) return process.env.SILICONFLOW_API_KEY.trim()
  } catch { }
  return ''
}

export function createAsrHandler(opts: { pluginDir: string; cache?: any }) {
  return async function handleAsr(req: any, res: any): Promise<void> {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: any = {}
      try { body = raw ? JSON.parse(raw) : {} } catch { body = {} }
      const audioB64 = typeof body?.audio === 'string' ? body.audio : ''
      const format = typeof body?.format === 'string' ? body.format : 'webm'
      if (!audioB64) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'empty audio' }))
        return
      }
      const key = readSiliconFlowKey(opts.pluginDir)
      if (!key) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'NO_KEY', text: '' }))
        return
      }
      const buf = Buffer.from(audioB64, 'base64')
      // 用完整音频字节做 key（只取前 4000 字符容易撞 key）
      const ck = hashBytes(buf)
      if (opts.cache) {
        const hit = await opts.cache.getJson(ck, 'json', ASR_CACHE_MAX_AGE)
        if (hit && typeof hit.text === 'string') {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, text: hit.text, cached: true }))
          return
        }
      }
      if (buf.length > 8 * 1024 * 1024) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'audio too large', text: '' }))
        return
      }
      // 构造 multipart
      const boundary = '----chubbywhale' + Math.random().toString(36).slice(2, 10)
      const mime = format === 'wav' ? 'audio/wav' : format === 'mp3' ? 'audio/mpeg' : 'audio/webm'
      const head = Buffer.from(
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="model"\r\n\r\n' + ASR_MODEL + '\r\n' +
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="file"; filename="audio.' + format + '"\r\n' +
        'Content-Type: ' + mime + '\r\n\r\n'
      )
      const tail = Buffer.from('\r\n--' + boundary + '--\r\n')
      const payload = Buffer.concat([head, buf, tail])
      const resp = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + key,
          'content-type': 'multipart/form-data; boundary=' + boundary,
        },
        body: payload,
      })
      if (!resp.ok) {
        const detail = await resp.text().catch(() => '')
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'HTTP ' + resp.status + ' ' + detail.slice(0, 200), text: '' }))
        return
      }
      const data: any = await resp.json()
      const text = String(data?.text || '').trim()
      if (opts.cache && text) { try { await opts.cache.setJson(ck, { text }) } catch { } }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, text }))
    } catch (err: any) {
      try {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: String(err?.message || err), text: '' }))
      } catch { }
    }
  }
}
