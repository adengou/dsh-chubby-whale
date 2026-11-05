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
 *
 * 超时语义（2026-11-05 起）：
 *   · 30s 是**空闲超时**——每收到一段上游数据就重置，模型还在吐字就不算超时；
 *     （此前它被当成「整条请求的总时长」，慢模型讲到一半会被硬切）
 *   · 120s 是总时长硬上限，兜底防「上游一直有数据但永远不结束」；
 *   · 每 12s 写一行 `: ping` 注释帧保活，客户端解析器会跳过以 : 开头的行。
 *
 * 纯函数与其它路由共用 host/chat-core.ts，不再从 routes/chat.ts 横向 import。
 */

import { sendTooLarge } from '../http.js'
import { readJsonBody } from '../body.js'
import { sendSseHeaders } from '../respond.js'
import type { ChatStreamRouteDeps } from '../ports.js'
import {
  CHAT_URL, CHAT_CACHE_TTL, detectLang, chatCacheKey, chatContextFingerprint,
  historyMessages, composeSystemPrompt,
} from '../chat-core.js'
import { parseSseBuffer } from '../../shared/sse.js'

const CHAT_IDLE_TIMEOUT = 30 * 1000      // 空闲超时：连续这么久没有上游数据才中止
const CHAT_MAX_DURATION = 120 * 1000     // 总时长硬上限：不论有没有数据，到点就断
const SSE_PING_MS = 12 * 1000            // SSE 心跳间隔
const CHAT_MAX_BODY = 6 * 1024 * 1024

export function createChatStreamHandler(opts: ChatStreamRouteDeps) {
  return async function handleChatStream(req: any, res: any): Promise<void> {
    // SSE 头：立刻发出，避免客户端等到第一个 token 才开始
    const started = Date.now()
    const send = (obj: any): void => {
      try { res.write('data: ' + JSON.stringify(obj) + '\n\n') } catch { }
    }

    // 超时与保活状态放在函数级：任何退出路径（缓存命中/无 Key/连接失败/正常结束/抛错）
    // 都要能在最后的 finally 里清干净，否则定时器会一直挂在事件循环上。
    let pingTimer: any = null
    let idleTimer: any = null
    let totalTimer: any = null
    let ctl: any = null
    let abortReason = ''
    const stopPing = (): void => {
      if (pingTimer) { try { clearInterval(pingTimer) } catch { } ; pingTimer = null }
    }
    const clearTimers = (): void => {
      if (idleTimer) { try { clearTimeout(idleTimer) } catch { } ; idleTimer = null }
      if (totalTimer) { try { clearTimeout(totalTimer) } catch { } ; totalTimer = null }
    }
    /** 空闲/总时长谁先到都走同一个 AbortController；只记第一次的原因，便于日志定位 */
    const abortUpstream = (why: string): void => {
      if (abortReason) return
      abortReason = why
      try { if (ctl) ctl.abort() } catch { }
    }
    /** 收到上游数据就重置空闲计时：优先 timer.refresh()，老运行时退回「清旧建新」 */
    const touchIdle = (): void => {
      if (!ctl || (ctl.signal && ctl.signal.aborted)) return
      if (idleTimer && typeof idleTimer.refresh === 'function') {
        try { idleTimer.refresh(); return } catch { }
      }
      if (idleTimer) { try { clearTimeout(idleTimer) } catch { } }
      idleTimer = setTimeout(() => abortUpstream('idle timeout ' + CHAT_IDLE_TIMEOUT + 'ms'), CHAT_IDLE_TIMEOUT)
    }

    try {
      const parsed = await readJsonBody(req, CHAT_MAX_BODY)
      if (!parsed.ok) { sendTooLarge(res); return }
      const body = parsed.body
      const message = String(body?.message || '').trim()
      const rawLang = (typeof body?.lang === 'string' && /^(zh|en|auto)$/.test(body.lang)) ? body.lang : 'auto'
      const lang = rawLang === 'auto' ? detectLang(message) : rawLang
      const isVoice = !!body?.voice
      if (!message) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
        send({ error: 'empty message' })
        res.end()
        return
      }

      sendSseHeaders(res)
      // 立刻把 SSE 头刷出去，客户端不必等首帧；同时记录客户端断开
      try { (res as any).flushHeaders && (res as any).flushHeaders() } catch { }
      let clientGone = false
      try { if (typeof (res as any).on === 'function') (res as any).on('close', () => { clientGone = true }) } catch { }

      // SSE 心跳：浏览器/反向代理会掐掉长时间没有数据的连接（豆包/nginx 一类默认 60s 左右），
      // 每 12s 写一行注释帧（以 : 开头，客户端解析器直接跳过）既保活又不污染事件流。
      // 正常结束/出错统一由 finally 里的 stopPing 清掉，不会残留定时器。
      pingTimer = setInterval(() => {
        try {
          if (res.writableEnded) return
          res.write(': ping\n\n')
        } catch { }
      }, SSE_PING_MS)
      // 心跳不该阻止进程退出（unref 只是在事件循环里「不计入活跃句柄」）
      try { if (pingTimer && typeof pingTimer.unref === 'function') pingTimer.unref() } catch { }

      // 先读上下文：缓存 key 带上下文指纹；prompt 只带最近几条（省 token）
      const memSummary = (() => { try { return String(opts.loadMemorySummary ? opts.loadMemorySummary() : '') } catch { return '' } })()
      let history: any[] = []
      try { history = opts.loadHistory() || [] } catch { history = [] }

      const cacheOn = !opts.cacheEnabled || opts.cacheEnabled() !== false
      const cacheKey = chatCacheKey(lang, message, isVoice, chatContextFingerprint(memSummary, history))
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

      const messages: any[] = [{
        role: 'system',
        content: composeSystemPrompt(opts.systemPrompt, [
          lang === 'en' ? '\n【Language】Answer in English.' : '\n【语言规则】主人用中文提问，请用中文回答。',
          memSummary ? ('\n（关于主人的长期记忆：' + memSummary + '）') : '',
        ]),
      }]
      messages.push(...historyMessages(history))
      messages.push({ role: 'user', content: message })

      // 超时从「准备发上游请求」这一刻才开始：读请求体、查缓存慢，不该算进模型响应时间
      ctl = typeof AbortController !== 'undefined' ? new AbortController() : null
      if (ctl) {
        totalTimer = setTimeout(() => abortUpstream('total timeout ' + CHAT_MAX_DURATION + 'ms'), CHAT_MAX_DURATION)
        touchIdle()
      }
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
        // 空闲/总时长中止时抛的是 AbortError，消息没用，用我们记下的原因
        send({ error: 'connect: ' + (abortReason || String(err?.message || err)) })
        res.end()
        return
      }
      if (!upstream.ok || !upstream.body) {
        send({ error: 'HTTP ' + upstream.status })
        res.end()
        return
      }
      // 响应头已到：接下来按「两段数据之间的间隔」算空闲
      touchIdle()

      let aborted = false
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
          touchIdle()   // 每收到一段就重置空闲计时：又慢又长的回复不会再被 30s 硬切
          buf += dec.decode(value, { stream: true })
          const parsedSse = parseSseBuffer(buf)
          buf = parsedSse.rest
          for (const j of parsedSse.events) {
            const delta = j?.choices?.[0]?.delta?.content
            if (typeof delta === 'string' && delta) {
              if (!firstDeltaAt) firstDeltaAt = Date.now()
              reply += delta
              send({ delta })
            }
            if (j?.usage) usage = j.usage
          }
        }
      } catch (err: any) {
        aborted = true
        send({ error: 'stream: ' + (abortReason || String(err?.message || err)) })
      } finally {
        // 流已结束（正常或异常），超时定时器再留着只会误伤后续收尾
        clearTimers()
      }

      // 流中断或客户端已断开：这段回复是半截的，绝不能写进缓存和记忆（否则被永久命中）
      if (aborted || clientGone) { try { res.end() } catch { } ; return }
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
      // L2 可变人格：完整回复收尾后才计数（中断/客户端断开/缓存命中都不算），不 await
      try { if (opts.onReply) opts.onReply() } catch { }
    } catch (err: any) {
      try {
        send({ error: String(err?.message || err) })
        res.end()
      } catch { }
    } finally {
      // 所有退出路径统一收口：心跳 interval 与两个超时定时器一个都不许残留
      clearTimers()
      stopPing()
    }
  }
}
