/**
 * client/voice-bridge.ts —— 语音模块桥（把 createVoice 的回调与生命周期收成一份）
 *
 * 旧实现里同四段回调写了两遍：语音待命 effect 一份、菜单「唤醒」补建一份，
 * 两份还不完全一致（一份数 narrDrop，一份不数）。这里只建一次回调，
 * effect 与菜单都走同一个 ensure()/start()。
 */

import { createVoice } from './voice.js'
import type { Voice } from './voice.js'
import type { NarrationLock } from './narration.js'

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
}

export type VoiceBridge = {
  get: () => Voice | null
  ensure: () => Voice
  /** 建好并启动录音；resolve 出实例（失败不抛，靠 status/stats 判断） */
  start: () => Promise<Voice>
  /** 停止录音（实例保留，下次复用） */
  stop: () => void
  /** 停止并丢弃实例（组件卸载用） */
  dispose: () => void
  speak: (text: string, opts?: { rate?: string; pitch?: string; narration?: boolean; onDone?: () => void }) => void
  stopSpeak: () => void
  mute: (on: boolean) => void
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

  function build(): Voice {
    const v = createVoice({
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
        try { host.bubble('（听到）' + text + '｜本鱼在想…', 3000) } catch (e) { }
        try { host.sendText(text, { voice: true }) } catch (e) { }
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
    try { host.diag({ voice: v }) } catch (e) { }
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
      return Promise.resolve(v.start()).then(() => v)
    },
    stop(): void {
      if (voice) { try { voice.stop() } catch (e) { } }
    },
    dispose(): void {
      if (voice) { try { voice.stop() } catch (e) { } }
      voice = null
    },
    speak(text: string, opts?: { rate?: string; pitch?: string; narration?: boolean; onDone?: () => void }): void {
      if (voice) { try { voice.speak(text, opts) } catch (e) { } }
    },
    stopSpeak(): void {
      if (voice) { try { voice.stopSpeaking() } catch (e) { } }
    },
    mute(on: boolean): void {
      if (voice) { try { voice.mute(on) } catch (e) { } }
    },
  }
}
