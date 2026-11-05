/**
 * client/chat.ts —— 聊天发送器（普通 /chat + 流式 /chat-stream，不碰 React）
 *
 * 旧实现是 client.ts 里紧挨着的 sendText + tryStreamChat 两个函数，
 * 混着 React state、忙碌锁、纪元、气泡、诊断写入。这里改成：
 *   · 状态通过 host 注入（busy / epoch / refs / setState）
 *   · 流式切句用 client/text.ts 的 createSentenceBuffer（原来手写一份 flush）
 *   · 所有诊断仍写 window.__chubbyWhale（与旧字段完全一致，方便自查）
 */

import { postJson, postRaw, timeoutSignal } from './http.js'
import { parseSseBuffer } from '../shared/sse.js'
import { createSentenceBuffer } from './text.js'
import type { Deduper } from './text.js'
import type { BusyLock, Epoch } from './busy.js'
import type { Persona } from './persona.js'

export type ChatHost = {
  persona: Persona
  bubble: (text: string, ms?: number) => void
  say: (text: string, ms?: number, voiceOpts?: { rate?: string; pitch?: string }) => void
  speak: (text: string, opts?: { rate?: string; narration?: boolean; onDone?: () => void }) => void
  speakReply: (text: string) => void
  stopSpeak: () => void
  talkFor: (ms: number) => void
  heart: () => void
  setInput: (v: string) => void
  setMessages: (updater: any) => void
  setBusy: (v: boolean) => void
  scrollBody: () => void
  busy: BusyLock
  epoch: Epoch
  /** 叙述中（说书/念诗） */
  narrating: { current: boolean }
  /** 说书中（打断时要一起放） */
  storyBusy: { current: boolean }
  /** 输入来自语音（气泡前缀用） */
  voiceMode: { current: boolean }
  ttsPlaying: () => boolean
  narrationRate: string
  /** 点播本地路由（命中则不走模型） */
  route: (text: string) => boolean
  /** 回复去重（30 秒窗口） */
  replyDeduper: Deduper
  /** 记录对话耗时（写 __chubbyWhale.lat） */
  recordChatLatency: (ms: number) => void
}

export type ChatController = {
  send: (rawText: string, opts?: { voice?: boolean }) => Promise<void>
}

/** 诊断对象：与旧实现一样直接写 window.__chubbyWhale */
function diag(): any {
  try {
    const w: any = (typeof window !== 'undefined') ? (window as any) : null
    if (!w) return null
    return w.__chubbyWhale || (w.__chubbyWhale = {})
  } catch (e) { return null }
}

export function createChatSender(host: ChatHost): ChatController {
  /** 流式对话：边生成边开口；异常 4 秒内回退到普通 /chat */
  async function tryStream(text: string, opts?: { voice?: boolean }): Promise<boolean> {
    try { if (localStorage.getItem('chubby-stream') === 'off') return false } catch (e) { }
    let spokeAny = false
    let full = ''
    let ctl: any = null
    try { ctl = typeof AbortController !== 'undefined' ? new AbortController() : null } catch (e) { ctl = null }
    const firstTimer = setTimeout(() => { try { if (!spokeAny && ctl) ctl.abort() } catch (e) { } }, 4000)
    let bubbleAt = 0
    // 句末标点处先念；没标点就攒到 40 字（避免等太长）
    const sb = createSentenceBuffer(40)

    const speakSegs = (segs: string[]): void => {
      for (const seg of segs) { try { host.speak(seg, { rate: '+0%' }) } catch (e) { } }
      if (segs.length) spokeAny = true
    }

    try {
      const res = await postRaw('/chat-stream', { message: text, lang: 'auto', voice: !!(opts && opts.voice) }, { signal: ctl ? ctl.signal : undefined })
      if (!res.ok || !res.body) { clearTimeout(firstTimer); return false }
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      host.busy.begin()
      host.setBusy(true)
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const parsed = parseSseBuffer(buf)
        buf = parsed.rest
        for (const obj of parsed.events) {
          if (obj.error) { throw new Error(String(obj.error)) }
          if (typeof obj.delta === 'string' && obj.delta) {
            full += obj.delta
            clearTimeout(firstTimer)
            speakSegs(sb.push(obj.delta))
            const nowT = Date.now()
            if (nowT - bubbleAt > 400) { bubbleAt = nowT; host.bubble(full.slice(-60), 3000) }
          }
          if (obj.done) {
            const reply = String(obj.reply || full || '').trim()
            full = reply || full
            if (reply) {
              if (host.replyDeduper.allow(reply)) {
                speakSegs(sb.flush())
                host.busy.end()
                host.setBusy(false)
                host.setMessages((m: any[]) => [...m, { who: 'fish', text: reply }])
                host.bubble(reply, 6000)
                host.talkFor(1500)
                host.scrollBody()
                const d = diag()
                if (d) d.lastChat = { stage: 'stream-done', firstDeltaMs: obj.firstDeltaMs || 0, ms: obj.ms || 0, cached: !!obj.cached, reply: reply.slice(0, 40) }
              }
            }
            clearTimeout(firstTimer)
            host.busy.end()
            host.setBusy(false)
            return true
          }
        }
      }
      clearTimeout(firstTimer)
      // 流正常结束但没收到 done（少见）：把已攒的文字念完并展示
      speakSegs(sb.flush())
      host.busy.end()
      host.setBusy(false)
      if (full) {
        host.setMessages((m: any[]) => [...m, { who: 'fish', text: full }])
        host.bubble(full, 6000)
        host.scrollBody()
      }
      return true
    } catch (e: any) {
      clearTimeout(firstTimer)
      host.busy.end()
      host.setBusy(false)
      if (spokeAny) {
        speakSegs(sb.flush())
        const d = diag()
        if (d) d.streamFallback = String(e && e.message || e)
        return true
      }
      return false
    }
  }

  async function send(rawText: string, opts?: { voice?: boolean }): Promise<void> {
    const text = String(rawText || '').trim()
    if (!text) return
    const d0 = diag()
    if (d0) d0.ttsSkip = 'empty-text'
    // 占线保护：上一条还在想就拒绝（不排队），避免两条回复抢同一个话筒
    if (d0) d0.lastChat = { stage: 'entry', busy: host.busy.isBusy(), tts: !!host.ttsPlaying(), at: Date.now() }
    if (host.busy.isBusy() && d0) d0.lastChat.stage = 'blocked-busy'
    if (host.busy.isBusy() && host.busy.age() < 35000) {
      if (opts && opts.voice) host.bubble('本鲸还在想上一句呢，稍等～', 2500)
      return
    }
    // 用户提问永远优先：先打断正在播的旁白（说书/念诗）再回答
    if (host.narrating.current || host.ttsPlaying()) {
      try { host.stopSpeak() } catch (e) { }
      host.narrating.current = false
      try { host.storyBusy.current = false } catch (e) { }
    }
    if (host.route(text)) { host.setInput(''); return }
    // 流式优先：边生成边念；失败会自动回退到下面的普通 /chat
    try { if (await tryStream(text, opts)) { host.setInput(''); return } } catch (e) { }

    const myEpoch = host.epoch.next()
    try { const hit = host.persona.reactTo(text); if (hit) { host.say(hit.text, 4000); if (hit.event === 'praise') host.heart() } } catch (e) { }
    host.setInput('')
    host.setMessages((m: any[]) => [...m, { who: 'me', text }])
    // 等待提示（人设 waiting）：只在语音提问时偶尔冒一句，概率 25%，不刷屏
    try { if (opts && opts.voice && !host.ttsPlaying() && Math.random() < 0.25) host.say(host.persona.line('waiting'), 3000) } catch (e) { }
    host.busy.begin()
    host.setBusy(true)
    host.talkFor(1200)
    host.scrollBody()
    let data: any = null
    try {
      const tChat = performance.now()
      data = await postJson('/chat', { message: text, voice: true, lang: (() => { try { return localStorage.getItem('chubby-chatlang') || 'auto' } catch (e) { return 'auto' } })() }, {
        // 30 秒上限：请求卡住时别让状态永远停在「在想…」
        signal: timeoutSignal(30000),
      })
      try { host.recordChatLatency(Math.round(performance.now() - tChat)) } catch (e) { }
      if (!host.epoch.isCurrent(myEpoch)) return   // 主人已经问了新问题：这条旧回复作废（防串线）
      const reply = data?.reply || '主人……本鲸走神了。'
      const d1 = diag()
      if (d1) d1.lastChat = { stage: 'fetched', reply: String(reply).slice(0, 40), at: Date.now() }
      host.setMessages((m: any[]) => [...m, { who: 'fish', text: reply }])
      if (host.voiceMode.current) { host.bubble('（说）' + reply, 8000) }
      if (data && data.upgraded) host.bubble('本鲸又长大一点啦！', 4000)
    } catch {
      host.setMessages((m: any[]) => [...m, { who: 'fish', text: host.persona.line('error') }])
    } finally {
      host.busy.end()
      host.setBusy(false)
      host.talkFor(1500)
      // 聊天回复：长回复（≥80 字）按 C# 自动切叙述语调 -15%，短句 +0%
      try {
        if (data && data.reply && host.epoch.isCurrent(myEpoch)) {
          const rp = String(data.reply)
          const d2 = diag()
          if (d2) d2.lastChat = { stage: 'speak', reply: rp.slice(0, 40), at: Date.now() }
          host.speakReply(rp)
        }
      } catch { }
      host.scrollBody()
    }
  }

  return { send }
}
