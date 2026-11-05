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
 *   · 唤醒词：识别结果先过 client/wake.ts 的门，只有最近 30 秒内被叫过才交给聊天。
 *     ASR 上传节奏不变（仍是每 6 秒窗口一段），减少的是误触发与误回话。
 */

import { createVoice, normalizeVoiceName, readStoredVoiceName } from './voice.js'
import type { Voice } from './voice.js'
import type { NarrationLock } from './narration.js'
import { bumpProgress } from './narration-progress.js'
import { createWakeGate, normalizeWakeText } from './wake.js'

export type VoiceBridgeHost = {
  /** 叙述锁：念诗/说书期间拾到的话不当作新发言（只放行明确的"停"） */
  narration: NarrationLock
  /** 说书/念诗进行中（onSegment 用它决定要不要把当前句冒出来） */
  narrating: () => boolean
  /** 停止朗读（会连带清叙述锁） */
  stopSpeaking: () => void
  bubble: (text: string, ms?: number) => void
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
  const gate = createWakeGate()
  const wakeStats = { passed: 0, dropped: 0, hits: 0, lastHitAt: 0, dropNotifiedAt: 0 }

  function wakeInfo(): any {
    const now = Date.now()
    const remainingMs = gate.remainingMs(now)
    return {
      awake: remainingMs > 0,
      remainingMs,
      windowMs: gate.windowMs,
      words: gate.words,
      hits: wakeStats.hits,
      passed: wakeStats.passed,
      dropped: wakeStats.dropped,
      lastHitAt: wakeStats.lastHitAt || null,
    }
  }

  function pushWake(): void {
    try { host.diag({ wake: wakeInfo() }) } catch (e) { }
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
            if (/停|别念|不念|够了|算了|打住/.test(String(text || ''))) {
              try { host.stopSpeaking() } catch (e) { }
              host.narration.clear()
              host.bubble('好，不念了', 2500)
            } else {
              bump('narrDrop')
            }
            return
          }
        } catch (e) { }

        // 打断词直通唤醒门：正在朗读时主人喊"停"必须立刻停，
        // 不能先要求喊唤醒词（否则只能去点菜单「停止说话」）。
        try {
          if (/^(停|停下|停一下|别说了|别讲了|别念了|别吵|闭嘴|安静|打住|够了)$/.test(normalizeWakeText(text))) {
            const speaking = host.speaking ? !!host.speaking() : true
            if (speaking) {
              try { host.stopSpeaking() } catch (e) { }
              try { host.bubble('好，不说了', 2000) } catch (e) { }
              bump('wakeBreak')
              return
            }
          }
        } catch (e) { }

        // 语音聊天关着：只听不接话（菜单「语音聊天」的语义）
        try {
          if (host.voiceChat && !host.voiceChat()) {
            wakeStats.dropped++
            pushWake()
            return
          }
        } catch (e) { }

        // 唤醒门：只有最近 30 秒内被叫过，识别结果才交给聊天
        const r = gate.check(text)
        if (r.hit) { wakeStats.hits++; wakeStats.lastHitAt = Date.now() }
        if (!r.pass) {
          wakeStats.dropped++
          // 提示限流：20 秒最多一次，别每段窗口都刷一句
          const now = Date.now()
          if (now - wakeStats.dropNotifiedAt > 20000) {
            wakeStats.dropNotifiedAt = now
            try { host.bubble('先喊一声「' + (gate.words[0] || '大肥鱼') + '」，本鲸才答话～', 3500) } catch (e) { }
          }
          bump('wakeDrop')
          pushWake()
          return
        }
        // 只喊了名字（剥掉唤醒词后没剩内容）：应一声，不劳烦模型
        if (!r.text) {
          try { host.bubble('本鲸在呢～', 2200) } catch (e) { }
          pushWake()
          return
        }
        wakeStats.passed++
        try { host.bubble('（听到）' + r.text + '｜本鱼在想…', 3000) } catch (e) { }
        try { host.sendText(r.text, { voice: true }) } catch (e) { }
        pushWake()
      },
      onStatus: (st: any) => { try { host.onSpeaking(st === 'speaking') } catch (e) { } },
      onDiag: (d: any) => { try { host.diag({ voiceDiag: d }) } catch (e) { } },
      // 念诗/说书：气泡跟着当前句走，主人能看到"念到哪了"
      onSegment: (seg: string) => {
        try {
          if (!host.narrating()) return
          const t = String(seg || '').replace(/^念首诗——/, '').trim()
          if (t) host.bubble(t, 8000)
        } catch (e) { }
      },
    })
    voice = v
    try { host.diag({ voice: v, wake: wakeInfo() }) } catch (e) { }
    // 关页面时自己把麦克风放掉，免得轨道悬着
    try {
      if (typeof window !== 'undefined') window.addEventListener('beforeunload', () => { try { v.stop() } catch (e) { } })
    } catch (e) { }
    return v
  }

  function ensure(): Voice {
    return voice || build()
  }

  return {
    get: () => voice,
    ensure,
    start(): Promise<Voice> {
      const v = ensure()
      // start() 自己不抛错（内部兜底），失败靠状态/统计判断，不把异常甩到渲染层
      return Promise.resolve(v.start()).then(() => { pushWake(); return v })
    },
    stop(): void {
      if (voice) { try { voice.stop() } catch (e) { } }
    },
    dispose(): void {
      if (voice) { try { voice.stop() } catch (e) { } }
      voice = null
      // 重开语音待命时不该继承上一次的唤醒窗
      try { gate.reset() } catch (e) { }
    },
    speak(text: string, opts?: BridgeSpeakOptions): void {
      if (voice) { try { voice.speak(text, opts) } catch (e) { } }
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
