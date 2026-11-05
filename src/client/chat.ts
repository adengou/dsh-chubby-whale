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
  /** 停止说话时打断正在跑的流式请求：作废旧流（不再写/念/入列）并解除它的占线 */
  abortStream: () => boolean
}

/**
 * 菜单里选的聊天语言：'auto' | 'zh' | 'en'。
 * 普通 /chat 与流式 /chat-stream 共用这一个来源（流式原来写死 'auto'，
 * 菜单选英文时只有普通路径生效，等于半截）。
 */
export function resolveChatLang(): string {
  try {
    const v = localStorage.getItem('chubby-chatlang')
    return v === 'zh' || v === 'en' ? v : 'auto'
  } catch (e) { return 'auto' }
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
  /**
   * 正在跑的流：新提问 / 停止说话时要能当场终止它。
   * 只登记流式（普通 /chat 由忙碌锁保护，不在这里）。
   */
  let activeStream: { ctl: any } | null = null

  function clearActive(ctl: any): void {
    if (activeStream && activeStream.ctl === ctl) activeStream = null
  }

  /** 作废并中止正在跑的流；返回是否真有流被中止 */
  function abortStream(): boolean {
    const s = activeStream
    if (!s) return false
    activeStream = null
    // 先推进纪元：旧流之后无论走到 delta/done/结束/异常，都过不了 isCurrent 校验
    try { host.epoch.next() } catch (e) { }
    try { s.ctl && s.ctl.abort() } catch (e) { }
    try { host.busy.end(); host.setBusy(false) } catch (e) { }
    const d = diag()
    if (d) d.streamAborted = (d.streamAborted || 0) + 1
    return true
  }

  /** 流式对话：边生成边开口；异常 4 秒内回退到普通 /chat */
  async function tryStream(text: string, opts: { voice?: boolean } | undefined, myEpoch: number): Promise<boolean> {
    try { if (localStorage.getItem('chubby-stream') === 'off') return false } catch (e) { }
    const isCurrent = (): boolean => host.epoch.isCurrent(myEpoch)
    let spokeAny = false
    let full = ''
    let ctl: any = null
    try { ctl = typeof AbortController !== 'undefined' ? new AbortController() : null } catch (e) { ctl = null }
    // 一开始就登记：还在等响应头时被新提问/停止说话打断，也能 abort 掉连接
    activeStream = { ctl }
    // 4 秒兜底只针对"连响应头都没收到"：实测响应头 78ms、首字 ~486ms，
    // 只要连接正常就别重跑一次模型（会让等待翻倍）
    let gotHeaders = false
    const firstTimer = setTimeout(() => { try { if (!spokeAny && !gotHeaders && ctl) ctl.abort() } catch (e) { } }, 4000)
    let bubbleAt = 0
    // 句末标点处先念；没标点就攒到 40 字（避免等太长）
    const sb = createSentenceBuffer(40)

    const speakSegs = (segs: string[]): void => {
      for (const seg of segs) { try { host.speak(seg, { rate: '+0%' }) } catch (e) { } }
      if (segs.length) spokeAny = true
    }

    /** 旧流已被新提问/停止说话作废：不再写气泡、不再入消息列表、不再念，也不动忙碌锁（新请求已接管） */
    const dropStale = (): true => {
      clearActive(ctl)
      try { if (ctl) ctl.abort() } catch (e) { }
      const d = diag()
      if (d) d.streamStale = (d.streamStale || 0) + 1
      return true
    }

    try {
      const res = await postRaw('/chat-stream', { message: text, lang: resolveChatLang(), voice: !!(opts && opts.voice) }, { signal: ctl ? ctl.signal : undefined })
      if (!isCurrent()) return dropStale()
      if (!res.ok || !res.body) { clearTimeout(firstTimer); clearActive(ctl); return false }
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      host.busy.begin()
      host.setBusy(true)
      for (;;) {
        const { value, done } = await reader.read()
        // 等待流数据期间可能已经被新提问/停止说话作废：直接收手
        if (!isCurrent()) return dropStale()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const parsed = parseSseBuffer(buf)
        buf = parsed.rest
        for (const obj of parsed.events) {
          if (!isCurrent()) return dropStale()
          if (obj.error) { throw new Error(String(obj.error)) }
          if (typeof obj.delta === 'string' && obj.delta) {
            full += obj.delta
            clearTimeout(firstTimer)
            speakSegs(sb.push(obj.delta))
            const nowT = Date.now()
            if (nowT - bubbleAt > 400) { bubbleAt = nowT; host.bubble(full.slice(-60), 3000) }
          }
          if (obj.done) {
            // 收尾前再校验一次：旧流的 done 不能把气泡/消息列表/朗读补上
            if (!isCurrent()) return dropStale()
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
            clearActive(ctl)
            host.busy.end()
            host.setBusy(false)
            return true
          }
        }
      }
      clearTimeout(firstTimer)
      if (!isCurrent()) return dropStale()
      clearActive(ctl)
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
      // 被新提问/停止说话作废的流：不念残留、不回退普通 /chat、不动忙碌锁
      if (!isCurrent()) return dropStale()
      clearActive(ctl)
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
    // 新提问优先：正在流式时先作废旧流（旧 delta 不再写气泡/不再入消息/不再念），并解除它的占线
    abortStream()
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
    // 同一次提问共用一个纪元：流式与普通 /chat 都认它，新提问会把它顶掉（旧回复作废）
    const myEpoch = host.epoch.next()
    // 流式优先：边生成边念；失败会自动回退到下面的普通 /chat
    try { if (await tryStream(text, opts, myEpoch)) { host.setInput(''); return } } catch (e) { }

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
      data = await postJson('/chat', { message: text, voice: true, lang: resolveChatLang() }, {
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

  return { send, abortStream }
}
