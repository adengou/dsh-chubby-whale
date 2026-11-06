/**
 * client/voice-bridge.ts —— 语音模块桥（把 createVoice 的回调与生命周期收成一份）
 *
 * 旧实现里同四段回调写了两遍：语音待命 effect 一份、菜单「唤醒」补建一份，
 * 两份还不完全一致（一份数 narrDrop，一份不数）。这里只建一次回调，
 * effect 与菜单都走同一个 ensure()/start()。
 *
 * 另补两条 client 侧接线（审查确认的缺口）：
 *   · 音色：菜单「换个声音」选完 → setVoiceName 立即生效（下一个 /tts 就带新 voice，
 *     不重建实例）；试听也走宿主 /tts（strict：失败静默，不回落浏览器语音）。
 *   · 唤醒词：识别结果先过 client/wake.ts 的门，命中就把唤醒词从正文里剥掉；
 *     2026-11-06 起唤醒词**不再是拦话门槛**（主人定的"随时可以说"），
 *     现在只剩三个用途：① 只喊名字时应一声；② 句首/句中的词剥掉再送模型；
 *     ③ 30 秒有效窗只作诊断（wakeInfo），不参与放行判定。
 */

import { createVoice, normalizeVoiceName, readStoredVoiceName } from './voice.js'
import type { Voice } from './voice.js'
import type { NarrationLock } from './narration.js'
import { bumpProgress } from './narration-progress.js'
import { createWakeGate, normalizeWakeText, loadCustomWakeWords, stripWakeWords, WAKE_WORDS } from './wake.js'
import { isInterruptCommand } from '../shared/noise.js'

/**
 * 整句打断指令的判定已统一到 shared/noise.ts 的 isInterruptCommand()（2026-11-07 B93）：
 * 五个规范词 + 19 条口语说法同一份真源，不再与 echo-filter 各抄一份。
 * 叙述期仍保留 NARR_STOP_RE 的放宽匹配（句中带「不念/算了」也停，容忍度高）。
 */

/** 说书/念诗期间"别念了"这类放宽匹配（句中带"不念/算了"也停，叙述中容忍度高） */
const NARR_STOP_RE = /停|别念|不念|够了|算了|打住/

/** 文本里有没有实际内容（汉字/字母/数字）；只有标点/空白不算一句话 */
const HAS_CONTENT_RE = /[\u4e00-\u9fa5a-z0-9]/i

/**
 * 归一化后的整句是不是"停止"指令。
 * 只认整句：正文里恰好含"别""不"的正常发言不能被当成指令吞掉。
 */
function isStopCommand(norm: string): boolean {
  if (!norm) return false
  return isInterruptCommand(norm)
}

export type VoiceBridgeHost = {
  /** 叙述锁：念诗/说书期间拾到的话不当作新发言（只放行明确的"停"） */
  narration: NarrationLock
  /** 说书/念诗进行中（onSegment 用它决定要不要把当前句冒出来） */
  narrating: () => boolean
  /** 停止朗读（会连带清叙述锁） */
  stopSpeaking: () => void
  bubble: (text: string, ms?: number) => void
  /** 说一句（会朗读；喊名字的应答用；缺省时退回气泡） */
  say?: (text: string, ms?: number, opts?: any) => void
  sendText: (text: string, opts?: { voice?: boolean }) => void
  /** 有人对着麦克风说话（用于切到语音模式） */
  onVoiceHeard: () => void
  /** 朗读状态变化：true=正在说 */
  onSpeaking: (playing: boolean) => void
  /** 诊断合并进 window.__chubbyWhale */
  diag: (patch: any) => void
  /** 语音聊天开关：关着时只听不接话（缺省视为开） */
  voiceChat?: () => boolean
  /** 当前是否正在朗读（打断词要看它决定要不要停） */
  speaking?: () => boolean
  /** 测试注入：替换 createVoice（默认用真模块） */
  makeVoice?: (opts: any) => Voice
}

export type BridgeSpeakOptions = { rate?: string; pitch?: string; narration?: boolean; strict?: boolean; onDone?: () => void }

export type VoiceBridge = {
  get: () => Voice | null
  ensure: () => Voice
  /** 建好并启动录音；resolve 出实例（失败不抛，靠 status/stats 判断） */
  start: () => Promise<Voice>
  /** 停止录音（实例保留，下次复用） */
  stop: () => void
  /** 停止并丢弃实例（组件卸载用） */
  dispose: () => void
  speak: (text: string, opts?: BridgeSpeakOptions) => void
  stopSpeak: () => void
  mute: (on: boolean) => void
  /** 立即切音色（实例还没建就先记住，建的时候带上去） */
  setVoiceName: (name: string) => void
  /** 当前音色（与实例同步） */
  voiceName: () => string
  /** 试听：走宿主 /tts，失败静默（不弹错、不回落浏览器语音） */
  preview: (text: string) => void
  /** 唤醒门状态（自检/诊断用） */
  wakeInfo: () => any
}

/** 诊断计数：与旧实现的 window.__chubbyWhale.<key> 自增一致 */
function bump(key: string): void {
  try {
    const w: any = (typeof window !== 'undefined') ? (window as any) : null
    if (!w) return
    const d: any = w.__chubbyWhale || (w.__chubbyWhale = {})
    d[key] = (d[key] || 0) + 1
  } catch (e) { }
}

export function createVoiceBridge(host: VoiceBridgeHost): VoiceBridge {
  let voice: Voice | null = null
  // 音色：菜单里的选择（localStorage）先记住；没建实例时也不丢
  let pendingVoice = readStoredVoiceName()
  // 唤醒门：命中唤醒词刷新 30 秒有效窗
  const gate = createWakeGate({ words: loadCustomWakeWords() })

  // 唤醒词表按需同步（2026-11-07）：主人换词后不必重开语音待命/刷新页面。
  // loadCustomWakeWords() 返回 undefined 表示「用默认表」；gate 内部持有同一个数组引用，
  // 原地替换元素即可生效，且不会丢掉「30 秒有效窗」的状态（重建 gate 会丢）。
  let wakeWordsSig = ''
  function syncWakeWords(): void {
    let next: string[]
    try {
      const custom = loadCustomWakeWords()
      next = (custom && custom.length ? custom : WAKE_WORDS).slice()
    } catch (e) {
      return
    }
    const sig = next.join('|')
    if (sig === wakeWordsSig) return
    wakeWordsSig = sig
    try {
      gate.words.length = 0
      for (const w of next) gate.words.push(w)
    } catch (e) { }
  }

  const wakeStats = { passed: 0, dropped: 0, hits: 0, lastHitAt: 0, dropNotifiedAt: 0 }
  // 识别没配 Key 的提示只弹一次（每次重开语音待命可以再弹一次）
  let asrNoKeyNotified = false
  // 关页面时释放麦克风的监听（每桥只挂一个，dispose 摘掉）
  let unloadHandler: (() => void) | null = null

  function wakeInfo(): any {
    syncWakeWords()
    const now = Date.now()
    const remainingMs = gate.remainingMs(now)
    return {
      awake: remainingMs > 0,
      remainingMs,
      windowMs: gate.windowMs,
      // 给出去的是副本：调用方（菜单/诊断）拿到的是可写数组，不能顺着它改门里的词表
      words: gate.words.slice(),
      hits: wakeStats.hits,
      passed: wakeStats.passed,
      dropped: wakeStats.dropped,
      lastHitAt: wakeStats.lastHitAt || null,
    }
  }

  function pushWake(): void {
    try { host.diag({ wake: wakeInfo() }) } catch (e) { }
  }

  /** 停止朗读 + 清叙述锁 + 说一声（stopSpeaking 在 host 侧会连带清锁，这里再兜一次） */
  function stopNarration(notice: string): void {
    try { host.stopSpeaking() } catch (e) { }
    try { host.narration.clear() } catch (e) { }
    try { host.bubble(notice, 2500) } catch (e) { }
  }

  /** 打断词是否要生效：正在朗读才停；没在朗读就把这句话当正文交给聊天（不吞正常发言） */
  function tryInterrupt(text: string): boolean {
    let spoken = ''
    try {
      // 先剥唤醒词：「大肥鱼，停」也算喊停（原来只认光秃秃的「停」）
      const probe = stripWakeWords(text, gate.words)
      spoken = normalizeWakeText(probe.hit ? probe.text : text)
    } catch (e) {
      return false
    }
    if (!isStopCommand(spoken)) return false
    let speaking = false
    try { speaking = host.speaking ? !!host.speaking() : true } catch (e) { speaking = false }
    if (!speaking) return false
    try { host.stopSpeaking() } catch (e) { }
    try { host.bubble('好，不说了', 2000) } catch (e) { }
    bump('wakeBreak')
    return true
  }

  function build(): Voice {
    const make = host.makeVoice || ((o: any) => createVoice(o))
    const v = make({
      // 建实例时就带上菜单里选的音色（原来没接，TTS 永远是默认晓伊）
      voiceName: pendingVoice,
      onHeard: (text: string) => {
        try { host.onVoiceHeard() } catch (e) { }
        // 叙述锁：念诗/说书拾到的话不当作新发言（只放行明确的"停"）
        try {
          if (host.narration.active()) {
            let narrStop = false
            try { narrStop = NARR_STOP_RE.test(String(text || '')) || isStopCommand(normalizeWakeText(text)) } catch (e) { }
            if (narrStop) stopNarration('好，不念了')
            else bump('narrDrop')
            return
          }
        } catch (e) { }
        // 打断词直通唤醒门：正在朗读时主人喊"停"必须立刻停，
        // 不能先要求喊唤醒词（否则只能去点菜单「停止说话」）。
        if (tryInterrupt(text)) return

        // 语音聊天关着：只听不接话（菜单「语音聊天」的语义）
        try {
          if (host.voiceChat && !host.voiceChat()) {
            wakeStats.dropped++
            pushWake()
            return
          }
        } catch (e) { }

        // 唤醒词不再当门槛：主人 2026-11-06 定的是"随时可以说"。
        // 唤醒词只剩两个用途：① 只喊名字时应一声；② 句中出现时从正文里剥掉。
        // （30 秒有效窗只用来诊断，不参与放行判定，见文件头。）
        syncWakeWords()
        const r = gate.check(text)
        if (r.hit) { wakeStats.hits++; wakeStats.lastHitAt = Date.now() }
        const said = r.hit ? r.text : String(text || '').trim()
        wakeStats.passed++
        // 剥完没剩实际内容（只喊了名字，或只有标点/气口）：
        // 真喊了名字就应一声（say 会朗读；同一句 25 秒去重，重复喊不会连珠炮）；
        // 没喊名字的碎屑直接丢，别让模型回一句"什么意思"。
        if (!HAS_CONTENT_RE.test(said)) {
          if (r.hit) {
            try {
              if (host.say) host.say('本鲸在呢～', 3200)
              else host.bubble('本鲸在呢～', 3200)
            } catch (e) {
              try { host.bubble('本鲸在呢～', 3200) } catch (e2) { }
            }
          }
          pushWake()
          return
        }
        try { host.bubble('（听到）' + said + '｜本鱼在想…', 3000) } catch (e) { }
        try { host.sendText(said, { voice: true }) } catch (e) { }
        pushWake()
      },
      onStatus: (st: any) => { try { host.onSpeaking(st === 'speaking') } catch (e) { } },
      onDiag: (d: any) => {
        try { host.diag({ voiceDiag: d }) } catch (e) { }
        // 语音识别没配 Key：给一句人话，别让主人对着麦克风干等
        try {
          if (d && d.stage === 'asr-no-key' && !asrNoKeyNotified) {
            asrNoKeyNotified = true
            host.bubble(String(d.hint || '没配语音识别 Key，本鲸听不见；打字也能聊～'), 8000)
          }
        } catch (e) { }
      },
      // 念诗/说书：气泡跟着当前句走，主人能看到"念到哪了"
      onSegment: (seg: string) => {
        try {
          if (!host.narrating()) return
          const t = String(seg || '').replace(/^念首诗——/, '').trim()
          if (!t) return
          // 念诗时拼「第 x/N 句」；说书/普通叙述没有进度，bumpProgress 返回空串
          const withProgress = bumpProgress(t)
          host.bubble(withProgress || t, 8000)
        } catch (e) { }
      },
    })
    voice = v
    try { host.diag({ voice: v, wake: wakeInfo() }) } catch (e) { }
    bindUnload()
    return v
  }

  /**
   * 关页面时自己把麦克风放掉，免得轨道悬着。
   * 只挂一个 beforeunload（原来每次 build 都挂一个匿名函数，dispose 后重建就越挂越多，
   * 旧监听还攥着已丢弃的实例 —— 并发纪律：监听要在卸载时清干净）。
   */
  function bindUnload(): void {
    if (unloadHandler) return
    try {
      if (typeof window === 'undefined' || !window.addEventListener) return
      unloadHandler = () => { try { if (voice) voice.stop() } catch (e) { } }
      window.addEventListener('beforeunload', unloadHandler)
    } catch (e) { unloadHandler = null }
  }

  function unbindUnload(): void {
    try {
      if (unloadHandler && typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('beforeunload', unloadHandler)
    } catch (e) { }
    unloadHandler = null
  }

  function ensure(): Voice {
    return voice || build()
  }

  return {
    get: () => voice,
    ensure,
    start(): Promise<Voice> {
      asrNoKeyNotified = false
      const v = ensure()
      // start() 自己不抛错（内部兜底），失败靠状态/统计判断，不把异常甩到渲染层
      return Promise.resolve(v.start()).then(() => { pushWake(); return v })
    },
    stop(): void {
      if (voice) { try { voice.stop() } catch (e) { } }
      // 停止待命不继承上一次的唤醒窗（菜单开关走的是 stop()，不是 dispose()）
      try { gate.reset() } catch (e) { }
    },
    dispose(): void {
      if (voice) { try { voice.stop() } catch (e) { } }
      voice = null
      unbindUnload()
      // 重开语音待命时不该继承上一次的唤醒窗
      try { gate.reset() } catch (e) { }
    },
    speak(text: string, opts?: BridgeSpeakOptions): void {
      // 原来 voice 为空（例如关过「语音待命」→刷新页面）时静默丢弃文本，
      // 且 onDone 永不回调 —— 说书会永久卡在"正讲着呢"。这里改成 ensure()：
      // 只创建朗读对象、不开麦克风，麦克风仍由 start() 负责。
      try { ensure().speak(text, opts) } catch (e) { }
    },
    stopSpeak(): void {
      if (voice) { try { voice.stopSpeaking() } catch (e) { } }
    },
    mute(on: boolean): void {
      if (voice) { try { voice.mute(on) } catch (e) { } }
    },
    setVoiceName(name: string): void {
      pendingVoice = normalizeVoiceName(name, pendingVoice)
      if (voice) { try { voice.setVoiceName(pendingVoice) } catch (e) { } }
    },
    voiceName(): string {
      try { return voice ? voice.voiceName() : pendingVoice } catch (e) { return pendingVoice }
    },
    preview(text: string): void {
      const t = String(text || '').trim()
      if (!t) return
      const v = ensure()
      // 没建实例时 ensure 会建（不启麦克风）；音色再同步一次，防上下文里 pending 过期
      try { v.setVoiceName(pendingVoice) } catch (e) { }
      // strict：只走宿主 /tts，合成失败就安静 —— 否则"换音色试听"听起来还是系统语音
      try { v.speak(t, { strict: true }) } catch (e) { }
    },
    wakeInfo,
  }
}
