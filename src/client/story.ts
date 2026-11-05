/**
 * client/story.ts —— 说书（连载）控制器（不碰 React）
 *
 * 旧实现是 client.ts 里的 playStoryPiece / startStory / nextStory + story-reset 分支，
 * 依赖 storyBusyRef / storyAutoRef / storyBookRef 三个 ref 与朗读回调。
 * 这里把「拉下一段 → 气泡 → 朗读 → 自动连播 → 讲完」整条链收成一个控制器，
 * 组件只注入朗读、气泡、动画与三个 ref。
 */

import { getJson, postJson, clientHeaders } from './http.js'
import { estimateSpeakMs } from './text.js'
import { normalizeRate } from '../shared/tts.js'

/** 讲故事语速（主人反馈 -30% 仍略快 → -35%）；念诗走叙述语速 -25% */
const STORY_RATE = '-35%'
import type { Persona } from './persona.js'

export type StoryRefs = {
  /** 正在讲（防止「接着说」插队） */
  busy: { current: boolean }
  /** 叙述中（提醒排队、麦克风让路） */
  narrating: { current: boolean }
  /** 点播连播：这一回讲完自动接下一段 */
  auto: { current: boolean }
  /** 最近一次讲的书名（「从头讲这本书」用） */
  book: { current: string }
}

export type StoryHost = {
  clientId: string
  persona: Persona
  /** 上叙述锁（毫秒） */
  narrate: (ms: number) => void
  /** 解叙述锁 */
  clearNarrate: () => void
  bubble: (text: string, ms?: number) => void
  speak: (text: string, opts?: { rate?: string; narration?: boolean; onDone?: () => void }) => void
  talkFor: (ms: number) => void
  narrationRate: string
  /** 语音朗读关着时只出气泡 */
  isVoiceOff: () => boolean
  refs: StoryRefs
}

export type StoryController = {
  /** 播放后端返回的一段书 */
  playPiece: (d: any) => void
  /** 开始/继续（hint 可以是书名） */
  start: (hint: string) => void
  /** 下一段 */
  next: () => void
  /** 按最近的书名重置进度 */
  reset: () => void
}

export function createStoryController(host: StoryHost): StoryController {
  const refs = host.refs
  const titleOf = (d: any): string => '正在讲《' + String((d && d.book) || '') + '》' + (d && d.title ? '｜' + d.title : '')

  function playPiece(d: any): void {
    const text = String((d && d.text) || '')
    if (d && d.book) refs.book.current = String(d.book)
    // 头顶只显示状态：不把整段古文糊上来
    host.bubble(titleOf(d), 12000)
    host.talkFor(8000)
    if (host.isVoiceOff()) {
      refs.busy.current = false
      refs.narrating.current = false
      host.bubble(titleOf(d) + '（语音朗读关着）', 12000)
      return
    }
    refs.busy.current = true
    host.narrate(estimateSpeakMs(text))
    host.speak(text, {
      // 故事语速由前端常量决定（-35%：主人反馈 -30% 仍略快）。
      // 这样调语速只改这一处、只刷新页面即可生效，不必重启宿主。
      rate: normalizeRate(STORY_RATE, host.narrationRate),
      onDone: () => {
        refs.busy.current = false
        refs.narrating.current = false
        if (d && d.isLast === false) {
          // 长故事在数据里被切成好几段（《画皮》3 段、《婴宁》6 段）。
          // 连播默认开：讲完一段自动接下一段，只到最后一段才报完；
          // 主人把「连播」关掉时才停下等「接着说」。
          if (refs.auto.current) {
            host.bubble('这一段讲完啦，接着往后讲…', 4000)
            setTimeout(() => { try { next() } catch (e) { } }, 800)
          } else {
            host.bubble('这段讲完啦～点菜单「接着说」听下一段', 6000)
          }
        } else {
          refs.auto.current = false
          host.bubble(host.persona.line('poemDone'), 6000)
        }
      },
    })
  }

  function start(hint: string): void {
    if (refs.busy.current) { host.bubble('正讲着呢，听完这段再说～', 3000); return }
    const headers = clientHeaders(host.clientId)
    // 参数格式以 host/routes/story.ts 为准：现行只认 hint（书名也算 hint）。
    // 书名另外以 book 传一份（同值），既满足「按书名点播」的调用约定，又不改后端协议。
    const query = hint
      ? '?book=' + encodeURIComponent(hint) + '&hint=' + encodeURIComponent(hint)
      : ''
    getJson('/story/start' + query, { headers })
      .then((d: any) => {
        if (!d || !d.ok) { host.bubble('说书没开成：' + ((d && d.error) || '没读到书'), 5000); return }
        playPiece(d)
      })
      .catch(() => host.bubble('说书连不上'))
  }

  function next(): void {
    if (refs.busy.current) { host.bubble('正讲着呢，听完这段再说～', 3000); return }
    const headers = clientHeaders(host.clientId)
    getJson('/story/next', { headers })
      .then((d: any) => {
        if (!d || !d.ok) { host.bubble('说书卡住了', 4000); return }
        if (d.done) { host.bubble('一轮都讲完啦，本鱼从头再讲～', 5000); start(''); return }
        playPiece(d)
      })
      .catch(() => host.bubble('说书连不上'))
  }

  function reset(): void {
    // 「从头讲这本书」：按最近一次说过的书名清进度（后端会清该书全部 book|index）
    const book = refs.book.current
    if (!book) { host.bubble('还没讲书呢', 3000); return }
    const headers = clientHeaders(host.clientId)
    postJson('/story/reset?book=' + encodeURIComponent(book), undefined, { headers })
      .then((d: any) => {
        if (!d || !d.ok) { host.bubble('没重置成：' + ((d && d.error) || '接口没应'), 4000); return }
        refs.book.current = String(d.book || book)
        host.bubble('这本书从头讲～', 3000)
      })
      .catch(() => host.bubble('说书连不上'))
  }

  return { playPiece, start, next, reset }
}
