/**
 * host/routes/chat-stream.ts —— 流式聊天（SSE）
 *
 * 目的：让肥鲸"边生成边开口"。原来必须等整段回复生成完才合成语音，
 * 用户感觉"说完话要等一两秒"；流式之后模型吐第一个字就能开始念。
 *
 * 协议（服务端 → 客户端，一行一条）：
 *   data: {"delta":"文字片段"}
 *   data: {"done":true,"reply":"完整回复","cached":false}
 *   data: {"error":"原因"}            // 失败时；客户端据此回退到普通 /chat
 *
 * 缓存与记忆行为与普通 /chat 一致：
 *   · 命中缓存：直接发一条 delta + done(cached:true)
 *   · 未命中：边转发边累积，结束时写缓存、写记忆、记 token
 */

import { readBody, isBodyTooLarge, sendTooLarge } from '../http.js'
import { chatCacheKey } from './chat.js'

const CHAT_URL = 'https://api.deepseek.com/chat/completions'
const CHAT_TIMEOUT = 30 * 1000
const CHAT_CACHE_TTL = 7 * 24 * 3600 * 1000
const CHAT_MAX_BODY = 6 * 1024 * 1024

function normalizeLang(raw: any): string {
  const s = String(raw || '').toLowerCase()
  return s.startsWith('en') ? 'en' : 'zh'
}

export function createChatStreamHandler(opts: {
  getKey: () => string
  loadHistory: () => any[]
  appendTurns?: (userText: string, replyText: string) => any
  systemPrompt: string
  addTokens?: (kind: string, n: number) => any
  cache?: any
  loadMemorySummary?: () => string
  cacheEnabled?: () => boolean
}) {
  return async function handleChatStream(req: any, res: any): Promise<void> {
    // SSE 头：立刻发出，避免客户端等到第一个 token 才开始
    const started = Date.now()
    const send = (obj: any): void => {
      try { res.write('data: ' + JSON.stringify(obj) + '\n\n') } catch { }
    }
    try {
      let raw: Buffer
      try {
        raw = await readBody(req, CHAT_MAX_BODY)
      } catch (err: any) {
        if (isBodyTooLarge(err)) { sendTooLarge(res); return }
        throw err
      }
      let body: any = {}
      try { body = JSON.parse(raw.toString('utf8') || '{}') } catch { body = {} }
      const message = String(body?.message || '').trim()
      const lang = normalizeLang(body?.lang)
      const isVoice = !!body?.voice
      if (!message) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
        send({ error: 'empty message' })
        res.end()
        return
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })

      const cacheOn = !opts.cacheEnabled || opts.cacheEnabled() !== false
      const cacheKey = chatCacheKey(lang, message, isVoice)
      // 与普通 /chat 一致：太短的消息不缓存
      const cacheable = message.length >= (isVoice ? 2 : 6)

      if (opts.cache && cacheOn && cacheable) {
        try {
          const hit = await opts.cache.getJson(cacheKey, 'json', CHAT_CACHE_TTL)
          if (hit && typeof hit.reply === 'string' && hit.reply) {
            send({ delta: hit.reply })
            send({ done: true, reply: hit.reply, cached: true, ms: Date.now() - started })
            res.end()
            return
          }
        } catch { }
      }

      const key = opts.getKey()
      if (!key) {
        send({ error: 'NO_KEY' })
        res.end()
        return
      }

      const memSummary = (() => { try { return String(opts.loadMemorySummary ? opts.loadMemorySummary() : '') } catch { return '' } })()
      const messages: any[] = [{ role: 'system', content: opts.systemPrompt + (lang === 'en' ? '\n【Language】Answer in English.' : '\n【语言规则】主人用中文提问，请用中文回答。') + (memSummary ? ('\n（关于主人的长期记忆：' + memSummary + '）') : '') }]
      let history: any[] = []
      try { history = opts.loadHistory() || [] } catch { history = [] }
      for (const m of history) {
        if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') messages.push({ role: m.role, content: m.content })
      }
      messages.push({ role: 'user', content: message })

      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null
      const timer = ctl ? setTimeout(() => { try { ctl.abort() } catch { } }, CHAT_TIMEOUT) : null
      let upstream: any = null
      try {
        upstream = await fetch(CHAT_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
          body: JSON.stringify({
            model: 'deepseek-flash',
            messages,
            max_tokens: 260,
            temperature: 0.8,
            thinking: { type: 'disabled' },
            stream: true,
            stream_options: { include_usage: true },
          }),
          signal: ctl ? ctl.signal : undefined,
        })
      } catch (err: any) {
        if (timer) clearTimeout(timer)
        send({ error: 'connect: ' + String(err?.message || err) })
        res.end()
        return
      }
      if (!upstream.ok || !upstream.body) {
        if (timer) clearTimeout(timer)
        send({ error: 'HTTP ' + upstream.status })
        res.end()
        return
      }

      const reader = upstream.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let reply = ''
      let usage: any = null
      let firstDeltaAt = 0
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          // SSE：按行解析，只取 data: 行
          let idx = buf.indexOf('\n')
          while (idx >= 0) {
            const line = buf.slice(0, idx).trim()
            buf = buf.slice(idx + 1)
            idx = buf.indexOf('\n')
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            try {
              const j = JSON.parse(payload)
              const delta = j?.choices?.[0]?.delta?.content
              if (typeof delta === 'string' && delta) {
                if (!firstDeltaAt) firstDeltaAt = Date.now()
                reply += delta
                send({ delta })
              }
              if (j?.usage) usage = j.usage
            } catch { }
          }
        }
      } catch (err: any) {
        send({ error: 'stream: ' + String(err?.message || err) })
      } finally {
        if (timer) clearTimeout(timer)
      }

      const text = reply.trim() || '主人……本鲸刚刚走神了。'
      // 收尾：写缓存 / 记忆 / token（与普通 /chat 同口径）
      if (opts.cache && cacheOn && cacheable && reply.trim()) {
        try { await opts.cache.setJson(cacheKey, { reply: text }, 'json', CHAT_CACHE_TTL) } catch { }
      }
      try {
        const u = usage
        if (u && typeof u.total_tokens === 'number' && opts.addTokens) opts.addTokens('chat', u.total_tokens)
      } catch { }
      try { if (typeof opts.appendTurns === 'function') opts.appendTurns(message, text) } catch { }
      send({ done: true, reply: text, cached: false, firstDeltaMs: firstDeltaAt ? firstDeltaAt - started : 0, ms: Date.now() - started })
      res.end()
    } catch (err: any) {
      try {
        send({ error: String(err?.message || err) })
        res.end()
      } catch { }
    }
  }
}
