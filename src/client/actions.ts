/**
 * client/actions.ts —— 菜单动作分发表的引擎（不碰 React）
 *
 * 替代 client.ts 里 300 多行的 `if (action === 'xxx') { … }` 链：
 *   · 精确动作：table.define('feed', (host) => { … })
 *   · 带参数的动作：table.definePrefix('music:', (host, name) => { … })
 *   · 未命中：run() 返回 false，由调用方决定兜底文案
 *
 * 新增一个菜单动作只需要：在对应 handlers 文件里加一行 define/definePrefix，
 * 再在 client/menu.ts 里加一项菜单（菜单数据与动作表解耦）。
 * 匹配规则：精确优先；前缀按「最长前缀」优先，避免 'music:' 抢走 'music-stop'。
 */

import type { Persona } from './persona.js'
import type { StoryController, StoryRefs } from './story.js'
import type { Voice } from './voice.js'

/**
 * 动作处理器能用的全部能力（由 client.ts 的组件组装后注入）。
 *
 * 约定：处理器只调 host 上的方法，不直接碰 React state / refs；
 * 这样每个处理器都是「纯流程」，可以脱离组件单独推理。
 */
export type ActionHost = {
  // —— 展示与朗读 ——
  bubble: (text: string, ms?: number) => void
  say: (text: string, ms?: number, voiceOpts?: { rate?: string; pitch?: string }) => void
  speak: (text: string, opts?: { rate?: string; narration?: boolean; onDone?: () => void }) => void
  speakReply: (text: string) => void
  /** 上叙述锁（念诗/说书期间麦克风让路） */
  narrate: (ms: number) => void
  /** 解叙述锁 */
  clearNarrate: () => void
  stopSpeak: () => void
  stopMelody: () => void
  playMelody: (notes: any[], bpm: number, onDone?: () => void) => void
  talkFor: (ms: number) => void
  heart: () => void

  // —— 数据 ——
  persona: Persona
  clientId: string
  narrationRate: string
  version: string

  // —— 说书 ——
  story: StoryController
  storyState: StoryRefs

  // —— 位置 / 大小 / 面板 ——
  homePos: () => void
  nudgeScale: (delta: number) => void
  hide: () => void
  setChatOpen: (v: boolean) => void
  setVoiceMode: (v: boolean) => void
  setMessages: (v: any) => void

  // —— 余额 / 成长 / 语言 ——
  setBalance: (text: string, label: string) => void
  refreshBalance: () => void
  setGrowthLabel: (v: string) => void
  setLang: (l: string) => void

  // —— 语音 ——
  voice: () => Voice | null
  voicePlaying: () => boolean
  earStandby: () => boolean
  setEarStandby: (v: boolean) => void
  voiceChat: () => boolean
  setVoiceChat: (v: boolean) => void
  voiceOn: () => boolean
  setVoiceOn: (v: boolean) => void
  /** 语音待命总开关：关=停录音；开=建/启语音模块 */
  toggleStandby: () => void

  // —— 聊天缓存开关 ——
  chatCacheOn: () => boolean
  setChatCacheOn: (v: boolean) => void

  // —— 诊断（合并进 window.__chubbyWhale） ——
  diag: (patch: any) => void
}

export type ActionHandler<C = any> = (ctx: C, arg: string) => void | Promise<void>

type PrefixEntry<C> = { prefix: string; handler: ActionHandler<C> }

export type ActionTable<C = any> = {
  define: (action: string, handler: ActionHandler<C>) => void
  definePrefix: (prefix: string, handler: ActionHandler<C>) => void
  has: (action: string) => boolean
  /** 执行动作；命中返回 true，未命中返回 false（不执行任何兜底） */
  run: (action: string, ctx: C) => Promise<boolean>
  /** 已注册的精确动作名（诊断用） */
  actions: () => string[]
  /** 已注册的前缀（诊断用） */
  prefixes: () => string[]
}

export function createActionTable<C = any>(): ActionTable<C> {
  const exact = new Map<string, ActionHandler<C>>()
  const prefixes: PrefixEntry<C>[] = []

  function define(action: string, handler: ActionHandler<C>): void {
    const name = String(action || '')
    if (!name || typeof handler !== 'function') return
    exact.set(name, handler)
  }

  function definePrefix(prefix: string, handler: ActionHandler<C>): void {
    const p = String(prefix || '')
    if (!p || typeof handler !== 'function') return
    prefixes.push({ prefix: p, handler })
  }

  function matchPrefix(action: string): PrefixEntry<C> | null {
    let best: PrefixEntry<C> | null = null
    for (const e of prefixes) {
      if (action.indexOf(e.prefix) !== 0) continue
      if (!best || e.prefix.length > best.prefix.length) best = e
    }
    return best
  }

  return {
    define,
    definePrefix,
    has(action: string): boolean {
      const name = String(action || '')
      if (!name) return false
      return exact.has(name) || matchPrefix(name) !== null
    },
    async run(action: string, ctx: C): Promise<boolean> {
      const name = String(action || '')
      if (!name) return false
      const h = exact.get(name)
      if (h) { await h(ctx, name); return true }
      const p = matchPrefix(name)
      if (p) { await p.handler(ctx, name.slice(p.prefix.length)); return true }
      return false
    },
    actions: () => Array.from(exact.keys()),
    prefixes: () => prefixes.map((e) => e.prefix),
  }
}
