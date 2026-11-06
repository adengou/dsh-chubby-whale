/**
 * client/chat.ts —— 聊天发送器（普通 /chat + 流式 /chat-stream，不碰 React）
 *
 * 旧实现是 client.ts 里紧挨着的 sendText + tryStreamChat 两个函数，
 * 混着 React state、忙碌锁、纪元、气泡、诊断写入。这里改成：
 *   · 状态通过 host 注入（busy / epoch / refs / setState）
 *   · 流式切句用 client/text.ts 的 createSentenceBuffer（原来手写一份 flush）
 *   · 所有诊断仍写 window.__chubbyWhale（与旧字段完全一致，方便自查）
 *
 * 2026-11-06 审计修正（点）：
 *   · 主人这句先入消息列表：原来只有普通 /chat 会加，开着流式时聊天记录里看不到自己的提问。
 *   · 停止说话/新提问能打断普通 /chat：原来只登记流式请求，停止后普通请求回来照样念。
 *   · 流式 4 秒超时只看「响应头」：原 gotHeaders 从没置 true，模型首字慢就被误杀并重跑一次。
 *   · 流式失败不再吞消息：同句去重只压气泡，正文照常入列；断流时把已念的部分也留在列表里。
 *
 * 2026-11-07 并发复审（B68）：
 *   · 流式没接上、回退普通 /chat 之前补一次纪元校验：await 期间被新提问顶掉时不再白打一轮，
 *     也不会把 busy / activeChat 从新请求手里抢走（并发纪律 五-1）。
 *   · P0 打断条件补上 storyBusy：叙述锁过期看门狗只清 narrating，TTS 退避期间 ttsPlaying 也可能是假，
 *     只认 narrating||ttsPlaying 会漏掉说书占线，旁白会在回答之后再抢话筒。
 *   · 人设 reactTo 提到两条路径之前：原来在 tryStream 之后，流式（默认开着）成功时永远走不到。
 *   · 占线阈值与 client/busy.ts 共用 BUSY_STALE_MS，不再手写 35000。
 */

import { postJson, postRaw, timeoutSignal } from './http.js'
import { parseSseBuffer } from '../shared/sse.js'
import { createSentenceBuffer } from './text.js'
import type { Deduper } from './text.js'
import { BUSY_STALE_MS } from './busy.js'
import type { BusyLock, Epoch } from './busy.js'
import { chatRate } from './rates.js'
import type { Persona } from './persona.js'
import { clearT } from './util.js'

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
  narrationRate: () => string
  /** 点播本地路由（命中则不走模型） */
  route: (text: string) => boolean
  /** 回复去重（30 秒窗口） */
  replyDeduper: Deduper
  /** 记录对话耗时（写 __chubbyWhale.lat） */
  recordChatLatency: (ms: number) => void
}

export type ChatController = {
  send: (rawText: string, opts?: { voice?: boolean }) => Promise<void>
  /** 停止说话/新提问时打断正在跑的请求：作废旧流（不再写/念/入列）并解除它的占线 */
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

/** 兜底提示：消息列表留一条 + 气泡（两个动作各自失败都不影响主流程，原来三处各写两份） */
function fishTip(host: ChatHost, tip: string, ms = 6000): void {
  try { host.setMessages((m: any[]) => [...m, { who: 'fish', text: tip }]) } catch (e) { }
  try { host.bubble(tip, ms) } catch (e) { }
}

/** 诊断对象：与旧实现一样直接写 window.__chubbyWhale */
function diag(): any {
  try {
    const w: any = (typeof window !== 'undefined') ? (window as any) : null
    if (!w) return null
    return w.__chubbyWhale || (w.__chubbyWhale = {})
  } catch (e) { return null }
}

/** 普通 /chat 的总超时（含网络与模型） */
const CHAT_TIMEOUT_MS = 30000
/** 流式在等响应头时的兜底（实测响应头 78ms；超过 4 秒基本是连接没建起来） */
const STREAM_HEADER_TIMEOUT_MS = 4000
/** 流式非 2xx 中，只有这些状态码值得回退普通 /chat（路由没挂/暂时不可用） */
const STREAM_RETRYABLE_STATUS = [404, 405, 408, 425, 429, 501, 502, 503, 504]

function streamHttpRetryable(status: number): boolean {
  if (!status) return true
  return STREAM_RETRYABLE_STATUS.indexOf(status) >= 0
}

function newAbortController(): any {
  try { return typeof AbortController !== 'undefined' ? new AbortController() : null } catch (e) { return null }
}

export function createChatSender(host: ChatHost): ChatController {
  /**
   * 正在跑的请求：新提问 / 停止说话时要能当场终止它。
   * 流式（activeStream）与普通 /chat（activeChat）各登记一个——
   * 旧实现只登记流式，停止说话对普通请求无效，答案回来仍会念出来。
   */
  let activeStream: { ctl: any } | null = null
  let activeChat: { ctl: any } | null = null

  function clearActive(ctl: any): void {
    if (activeStream && activeStream.ctl === ctl) activeStream = null
  }

  /** 作废并中止正在跑的请求；返回是否真有请求被中止 */
  function abortStream(): boolean {
    const s = activeStream
    const c = activeChat
    if (!s && !c) return false
    activeStream = null
    activeChat = null
    // 先推进纪元：旧流之后无论走到 delta/done/结束/异常，都过不了 isCurrent 校验
    try { host.epoch.next() } catch (e) { }
    try { if (s && s.ctl) s.ctl.abort() } catch (e) { }
    try { if (c && c.ctl) c.ctl.abort() } catch (e) { }
    try { host.busy.end(); host.setBusy(false) } catch (e) { }
    const d = diag()
    if (s) { if (d) d.streamAborted = (d.streamAborted || 0) + 1 }
    if (c) { if (d) d.chatAborted = (d.chatAborted || 0) + 1 }
    return true
  }

  /** 流式对话：边生成边开口；连接建不起来才回退普通 /chat */
  async function tryStream(text: string, opts: { voice?: boolean } | undefined, myEpoch: number): Promise<boolean> {
    try { if (localStorage.getItem('chubby-stream') === 'off') return false } catch (e) { }
    const isCurrent = (): boolean => host.epoch.isCurrent(myEpoch)
    let spokeAny = false
    let full = ''
    const ctl = newAbortController()
    // 一开始就登记：还在等响应头时被新提问/停止说话打断，也能 abort 掉连接
    activeStream = { ctl }
    // 4 秒兜底只针对「连响应头都没收到」：只要连接正常就别重跑一次模型（会让等待翻倍）。
    // gotHeaders 收到响应头后置 true，这条定时器随即清掉。
    let gotHeaders = false
    const firstTimer = setTimeout(() => {
      try { if (!gotHeaders && ctl) ctl.abort() } catch (e) { }
    }, STREAM_HEADER_TIMEOUT_MS)
    let bubbleAt = 0
    // 句末标点处先念；没标点就攒到 40 字（避免等太长）
    const sb = createSentenceBuffer(40)

    const speakSegs = (segs: string[]): void => {
      for (const seg of segs) { try { host.speak(seg, { rate: chatRate() }) } catch (e) { } }
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
      gotHeaders = true
      clearTimeout(firstTimer)
      if (!isCurrent()) return dropStale()
      if (!res.ok || !res.body) {
        clearActive(ctl)
        const status = Number(res && res.status) || 0
        // 路由没挂/暂时不可用：回退普通 /chat 是必要的；其余 4xx/5xx 再发一遍只会更慢
        // （请求本身已被拒，重发也拿不到模型回复，还可能白等一轮）
        if (streamHttpRetryable(status)) return false
        let tip = ''
        try {
          // 只取服务端给的「人话」文案；error 是内部常量（如 too large），不直接甩给主人
          const j = await res.json()
          tip = String((j && j.reply) || '')
        } catch (e) { }
        if (!tip) tip = '主人，本鲸这边没接上（HTTP ' + status + '），等会儿再试一次？'
        if (isCurrent()) {
          try { host.setMessages((m: any[]) => [...m, { who: 'fish', text: tip }]) } catch (e) { }
          try { host.bubble(tip, 6000) } catch (e) { }
          try { host.speakReply(tip) } catch (e) { }
        }
        const d = diag()
        if (d) d.streamHttpFail = status
        return true
      }
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
            speakSegs(sb.push(obj.delta))
            const nowT = Date.now()
            if (nowT - bubbleAt > 400) { bubbleAt = nowT; host.bubble(full.slice(-60), 3000) }
          }
          if (obj.done) {
            // 收尾前再校验一次：旧流的 done 不能把气泡/消息列表/朗读补上
            if (!isCurrent()) return dropStale()
            const reply = String(obj.reply || full || '').trim()
            full = reply || full
            clearActive(ctl)
            // 尾巴先念完：done 之前可能还有没到句末的碎片
            speakSegs(sb.flush())
            host.busy.end()
            host.setBusy(false)
            if (reply) {
              // 30 秒同句去重只压气泡：流式的正文在 done 之前已经念出去了，
              // 这里再吞掉整条回复，会让主人的提问孤零零挂着、看不到答案。
              const fresh = host.replyDeduper.allow(reply)
              try { host.setMessages((m: any[]) => [...m, { who: 'fish', text: reply }]) } catch (e) { }
              if (fresh) { try { host.bubble(reply, 6000) } catch (e) { } }
              try { host.talkFor(1500) } catch (e) { }
              try { host.scrollBody() } catch (e) { }
              const d = diag()
              if (d) d.lastChat = { stage: 'stream-done', firstDeltaMs: obj.firstDeltaMs || 0, ms: obj.ms || 0, cached: !!obj.cached, reply: reply.slice(0, 40) }
            } else {
              // 空回复也不许静默：给一句兜底并留在消息列表里
              fishTip(host, host.persona.line('error'))
              const d = diag()
              if (d) d.lastChat = { stage: 'stream-empty', at: Date.now() }
            }
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
      const tail = full.trim()
      if (tail) {
        try { host.setMessages((m: any[]) => [...m, { who: 'fish', text: tail }]) } catch (e) { }
        try { host.bubble(tail, 6000) } catch (e) { }
        try { host.scrollBody() } catch (e) { }
      } else {
        fishTip(host, host.persona.line('error'))
      }
      return true
    } catch (e: any) {
      clearTimeout(firstTimer)
      // 被新提问/停止说话作废的流：不念残留、不回退普通 /chat、不动忙碌锁
      if (!isCurrent()) return dropStale()
      clearActive(ctl)
      host.busy.end()
      host.setBusy(false)
      const d = diag()
      if (d) d.streamFallback = String(e && e.message || e)
      if (spokeAny) {
        // 已经念出去一部分：把半截也留在消息列表里，并明确告诉主人断在哪儿
        speakSegs(sb.flush())
        const partial = full.trim()
        if (partial) {
          try { host.setMessages((m: any[]) => [...m, { who: 'fish', text: partial }]) } catch (e2) { }
        }
        try { host.bubble(partial ? '网络断了一下，本鲸先念到这儿～' : '网络断了一下，本鲸没说完～', 5000) } catch (e2) { }
        return true
      }
      return false
    }
  }

  async function send(rawText: string, opts?: { voice?: boolean }): Promise<void> {
    const text = String(rawText || '').trim()
    if (!text) return
    // 新提问优先：正在跑（流式或普通）就先作废旧请求（旧 delta 不再写气泡/不再入消息/不再念），并解除它的占线
    abortStream()
    const d0 = diag()
    // 这里原来有一行 d0.ttsSkip = 'empty-text'（重构时留下的残留）：
    // 每次发送都会把"跳过朗读的原因"改写成 empty-text，掩盖真正的原因（比如 voice-off）。
    // 诊断字段要能信，删掉这行，真正的跳过原因由 speak 侧写。
    // 占线保护：上一条还在想就拒绝（不排队），避免两条回复抢同一个话筒
    if (d0) d0.lastChat = { stage: 'entry', busy: host.busy.isBusy(), tts: !!host.ttsPlaying(), at: Date.now() }
    // 阈值与 client/busy.ts 的看门狗共用 BUSY_STALE_MS：两处各写一个数字时，
    // 改过 staleMs 的实例会出现「看门狗已解锁、发送入口还当忙」的错位。
    if (host.busy.isBusy() && host.busy.age() < BUSY_STALE_MS) {
      if (d0) d0.lastChat.stage = 'blocked-busy'
      // 打字也要提示：客户端发送后会把输入框清空，原来只在语音时冒一句，打字的这句就静默丢了
      host.bubble('本鲸还在想上一句呢，稍等～', 2500)
      return
    }
    // 用户提问永远优先：先打断正在播的旁白（说书/念诗）再回答。
    // storyBusy 也要算：client.ts 的叙述锁过期看门狗只清 narrating、不清 storyBusy
    // （narration.expire → clearNarrating），TTS 退避重试期间 ttsPlaying 也可能是 false；
    // 只认 narrating||ttsPlaying 会漏掉这一轮，说书的旗子留到回答之后再抢话筒。
    if (host.narrating.current || host.storyBusy.current || host.ttsPlaying()) {
      try { host.stopSpeak() } catch (e) { }
      host.narrating.current = false
      try { host.storyBusy.current = false } catch (e) { }
    }
    // 本地点播路由：处理器抛错不该把整次发送函数带崩（调用方没有 catch 这个 Promise）
    let localHit = false
    try { localHit = host.route(text) } catch (e) { localHit = false }
    if (localHit) { host.setInput(''); return }
    // 同一次提问共用一个纪元：流式与普通 /chat 都认它，新提问会把它顶掉（旧回复作废）
    const myEpoch = host.epoch.next()
    // 主人这句先入列（流式与普通两条路径共用）：旧实现只有普通路径加「me」，
    // 开着流式时聊天记录里只有鱼的话、没有主人的提问。
    host.setInput('')
    try { host.setMessages((m: any[]) => [...m, { who: 'me', text }]) } catch (e) { }
    // 人设情绪/台词是对「主人这句话」的反应，流式与普通两条路径都要触发：
    // 原来这行在 tryStream 之后，流式（默认开着）成功时永远走不到 —— 情绪状态机与气泡表情
    // 等于没接上，只有流式失败/被关掉时才偶尔生效。点播命中在上面已经 return，不会误触发。
    try { const hit = host.persona.reactTo(text); if (hit) { host.say(hit.text, 4000); if (hit.event === 'praise') host.heart() } } catch (e) { }
    // 流式优先：边生成边念；失败会自动回退到下面的普通 /chat
    try { if (await tryStream(text, opts, myEpoch)) return } catch (e) { }
    // 每个 await 之后都要问一句「我还是当前那个请求吗」（docs/并发纪律.md 五-1）：
    // 流式没接上、正要回退普通 /chat 的这段间隙里，可能已经有更晚的提问顶掉了本纪元。
    // 这时再发一次 /chat 会白烧一轮 token，还会把 busy / activeChat 从新请求手里抢过来。
    if (!host.epoch.isCurrent(myEpoch)) return

    // 等待提示（人设 waiting）：只在语音提问时偶尔冒一句，概率 25%，不刷屏
    try { if (opts && opts.voice && !host.ttsPlaying() && Math.random() < 0.25) host.say(host.persona.line('waiting'), 3000) } catch (e) { }
    host.busy.begin()
    host.setBusy(true)
    host.talkFor(1200)
    host.scrollBody()
    const d1 = diag()
    let data: any = null
    const ctl = newAbortController()
    activeChat = { ctl }
    let timeoutTimer: any = null
    try {
      // 30 秒上限：请求卡住时别让状态永远停在「在想…」。
      // 用自己登记的 controller（而不是 AbortSignal.timeout），停止说话时才能一起中断。
      if (ctl) {
        timeoutTimer = setTimeout(() => {
          try { ctl.abort() } catch (e) { }
        }, CHAT_TIMEOUT_MS)
      }
      const tChat = performance.now()
      data = await postJson('/chat', {
        message: text,
        // voice 表示「输入来自语音识别」（后端据此追加 ASR 纠错说明）。
        // 原来这里写死 true，打字也会被当成语音，且与流式的缓存键对不上。
        voice: !!(opts && opts.voice),
        lang: resolveChatLang(),
      }, {
        signal: ctl ? ctl.signal : timeoutSignal(CHAT_TIMEOUT_MS),
      })
      try { host.recordChatLatency(Math.round(performance.now() - tChat)) } catch (e) { }
      if (!host.epoch.isCurrent(myEpoch)) return   // 主人已经问了新问题：这条旧回复作废（防串线）
      const reply = (data && data.reply)
        ? String(data.reply)
        : (data && data.ok === false)
          ? '主人，本鲸这边没接上（' + String(data.error || '接口没应') + '），等会儿再问一次？'
          : '主人……本鲸走神了。'
      if (d1) d1.lastChat = { stage: 'fetched', reply: String(reply).slice(0, 40), at: Date.now() }
      host.setMessages((m: any[]) => [...m, { who: 'fish', text: reply }])
      if (host.voiceMode.current) { host.bubble('（说）' + reply, 8000) }
      if (data && data.upgraded) host.bubble('本鲸又长大一点啦！', 4000)
    } catch (err: any) {
      if (!host.epoch.isCurrent(myEpoch)) return   // 被停止说话/新提问作废：不弹错误、不念旧答案
      // AbortSignal.timeout() 的拒绝名是 TimeoutError（Node 24 code=23），只认 AbortError/20/2
      // 会把「超时」报成普通失败（diag 里看不出是超时）；口径与 client/story.ts 保持一致
      const timedOut = !!err && (
        err.name === 'AbortError' ||
        err.name === 'TimeoutError' ||
        err.code === 20 ||
        err.code === 2 ||
        err.code === 23
      )
      const tip = timedOut ? '主人，本鲸等太久啦（网络慢），再问一次？' : host.persona.line('error')
      if (d1) d1.lastChat = { stage: timedOut ? 'timeout' : 'error', error: String((err && err.message) || err).slice(0, 60), at: Date.now() }
      fishTip(host, tip, 5000)
    } finally {
      clearT(timeoutTimer)
      if (activeChat && activeChat.ctl === ctl) activeChat = null
      // 只有仍然归我时才解占线：被新请求接管时（epoch 变了）不能把新请求的锁放掉
      if (host.epoch.isCurrent(myEpoch)) {
        host.busy.end()
        host.setBusy(false)
        host.talkFor(1500)
        // 聊天回复：长回复（≥80 字）按 C# 自动切叙述语调 -15%，短句 +0%
        try {
          if (data && data.reply) {
            const rp = String(data.reply)
            const d2 = diag()
            if (d2) d2.lastChat = { stage: 'speak', reply: rp.slice(0, 40), at: Date.now() }
            host.speakReply(rp)
          }
        } catch (e) { }
        host.scrollBody()
      }
    }
  }

  return { send, abortStream }
}
