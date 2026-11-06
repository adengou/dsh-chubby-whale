/**
 * client/story.ts —— 说书（连载）控制器（不碰 React）
 *
 * 旧实现是 client.ts 里的 playStoryPiece / startStory / nextStory + story-reset 分支，
 * 依赖 storyBusyRef / storyAutoRef / storyBookRef 三个 ref 与朗读回调。
 * 这里把「拉下一段 → 气泡 → 朗读 → 自动连播 → 讲完」整条链收成一个控制器，
 * 组件只注入朗读、气泡、动画与三个 ref。
 *
 * 状态机（2026-11-06 审计后收敛）：
 *   · 占线同步占：start/next/reset 在发请求前就把 busy 置 true，连点两次只有第一次发请求
 *     （旧实现要等 playPiece 才置 busy，双击「接着说」会发两个请求、跳段）。
 *   · 代际令牌：开讲/接段/重讲/播新段都让 gen +1；旧请求与旧 onDone 回来先比对令牌，过期一律作废。
 *     令牌挂在 refs.busy 这个稳定对象上（WeakMap），组件重渲染新建控制器时仍然共享，
 *     否则旧实例的 onDone 会把新实例的占线清掉。
 *   · 停止检测：请求回来时 busy 已被「歇会儿/停止说话」清掉（client.ts 的 stopTts 会清 storyBusyRef），
 *     据此丢弃这段结果，不再念、不再接。
 *   · 自动连播不落定时器：一段念完用微任务接下一段。用 setTimeout(800) 时，主人在这 0.8 秒里
 *     点「歇会儿」，定时器照样会把下一段接上（stopTts 清 busy 拦不住它）。
 */

import { getJson, postJson, clientHeaders, timeoutSignal } from './http.js'
import { estimateSpeakMs } from './text.js'
import { normalizeRate } from '../shared/tts.js'
import { storyRate } from './rates.js'
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
  narrationRate: () => string
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

/** 单次说书请求的超时：超时必须释放占线，否则「接着说」永远回「正讲着呢」 */
const REQUEST_TIMEOUT_MS = 25000
/** AbortSignal 不可用时的兜底：到点直接释放占线并作废本次请求 */
const REQUEST_DEADLINE_MS = 30000
/** 朗读兜底：估算时长之外再留这么久；TTS 不回 onDone 时不至于让说书永久占线 */
const SPEAK_GUARD_EXTRA_MS = 20000

/**
 * 控制器共享状态（按 refs.busy 这个稳定对象取）。
 * 组件每次渲染都会 createStoryController，闭包变量会重置；
 * 旧实例的 onDone / 旧请求要能和「新一次操作」比对同一份 gen，必须放到共享状态里。
 */
type SharedState = { gen: number; guard: any }
const sharedStates = new WeakMap<object, SharedState>()

function sharedStateOf(refs: StoryRefs): SharedState {
  const key: any = refs && refs.busy ? refs.busy : null
  if (!key) return { gen: 0, guard: null }
  let s = sharedStates.get(key)
  if (!s) { s = { gen: 0, guard: null }; sharedStates.set(key, s) }
  return s
}

/** fetch 被 abort 时不同运行时的错误形状不一样，统一认一下 */
function isAbortError(err: any): boolean {
  return !!err && (err.name === 'AbortError' || err.code === 20 || err.code === 2)
}

/** 后端错误码 → 主人能看懂的话（后端这几个 error 是英文常量） */
function storyErrorText(raw: any): string {
  const e = String(raw == null ? '' : raw).trim()
  if (!e) return '接口没应'
  if (e === 'no books') return '书单是空的'
  if (e === 'no readable book') return '书都读不出来'
  if (e === 'unknown book') return '书单里没有这本'
  return e
}

export function createStoryController(host: StoryHost): StoryController {
  const refs = host.refs
  const shared = sharedStateOf(refs)

  /** 作废旧代际（旧请求/旧 onDone 拿到它就不再往下走） */
  function bumpGen(): number {
    shared.gen += 1
    return shared.gen
  }

  /** 本次请求是否还归我：没被新一次操作顶掉，也没被「停止说话」清掉占线 */
  function stillMine(token: number): boolean {
    return token === shared.gen && !!refs.busy.current
  }

  /** 释放一次占线（只有令牌仍最新才动，避免把新请求的锁一起放掉） */
  function release(token: number): void {
    if (token !== shared.gen) return
    refs.busy.current = false
    refs.narrating.current = false
  }

  function clearGuard(): void {
    if (!shared.guard) return
    try { clearTimeout(shared.guard) } catch (e) { }
    shared.guard = null
  }

  /** 朗读兜底：TTS 没回调 onDone 时别让说书永久占线；真念完时由 onDone 清掉 */
  function armGuard(token: number, ms: number): void {
    clearGuard()
    const t: any = setTimeout(() => {
      shared.guard = null
      if (token !== shared.gen) return
      if (!refs.busy.current) return
      bumpGen()
      refs.busy.current = false
      refs.narrating.current = false
      try { host.clearNarrate() } catch (e) { }
      host.bubble('这段没念完，先停在这儿啦～', 5000)
    }, Math.max(5000, Number(ms) || 0))
    // Node（测试/自检）里别让这个兜底把进程吊住
    try { if (t && typeof t.unref === 'function') t.unref() } catch (e) { }
    shared.guard = t
  }

  /** 同步占线：连点两次时第二次会在这里被 busy 挡下（不再发第二个请求） */
  function beginRound(): number {
    clearGuard()
    const token = bumpGen()
    refs.busy.current = true
    refs.narrating.current = false
    return token
  }

  /** 请求兜底：AbortSignal 不可用、fetch 永远不返回时也把占线放掉 */
  function armDeadline(token: number, message: string): any {
    return setTimeout(() => {
      if (token !== shared.gen || !refs.busy.current) return
      bumpGen()
      refs.busy.current = false
      refs.narrating.current = false
      host.bubble(message, 5000)
    }, REQUEST_DEADLINE_MS)
  }

  /**
   * 说书请求的公共流程：同步占线 → 带超时拉 JSON → 令牌/停止校验 → 交回调。
   * 失败（网络错/超时/作废）时的收尾都在这里，调用方只处理业务字段。
   */
  function requestStory(
    path: string,
    post: boolean,
    texts: { slow: string; fail: string },
    onData: (d: any, token: number) => void,
  ): void {
    const token = beginRound()
    const deadline = armDeadline(token, texts.slow)
    const init = { headers: clientHeaders(host.clientId), signal: timeoutSignal(REQUEST_TIMEOUT_MS) }
    const p = post ? postJson(path, undefined, init) : getJson(path, init)
    p.then((d: any) => {
      clearTimeout(deadline)
      if (!stillMine(token)) return
      onData(d, token)
    }).catch((err: any) => {
      clearTimeout(deadline)
      if (!stillMine(token)) return
      release(token)
      host.bubble(isAbortError(err) ? texts.slow : texts.fail, 5000)
    })
  }

  const titleOf = (d: any): string => {
    const total = Number(d && d.total) || 1
    const piece = Number(d && d.piece) || 1
    // 长故事在数据里被切成多段：气泡里标出「第几段」，主人能知道还剩多少
    const seg = total > 1 ? '（第 ' + piece + '/' + total + ' 段）' : ''
    return '正在讲《' + String((d && d.book) || '') + '》' + (d && d.title ? '｜' + d.title : '') + seg
  }

  function playPiece(d: any): void {
    clearGuard()
    const token = bumpGen()
    const text = String((d && d.text) || '')
    const speakMs = estimateSpeakMs(text)
    if (d && d.book) refs.book.current = String(d.book)
    // 头顶只显示状态：不把整段古文糊上来
    host.bubble(titleOf(d), 12000)
    host.talkFor(8000)
    if (!text.trim()) {
      // 没正文时绝不能占线等 onDone（空文本 speak 不会回调）
      refs.busy.current = false
      refs.narrating.current = false
      host.bubble('这一段没取到正文，先停在这里～', 5000)
      return
    }
    if (host.isVoiceOff()) {
      refs.busy.current = false
      refs.narrating.current = false
      host.bubble(titleOf(d) + '（语音朗读关着）', 12000)
      return
    }
    refs.busy.current = true
    refs.narrating.current = true
    try { host.narrate(speakMs) } catch (e) { }
    try {
      host.speak(text, {
        // 故事语速由前端常量决定（-35%：主人反馈 -30% 仍略快）。
        // 这样调语速只改这一处、只刷新页面即可生效，不必重启宿主。
        rate: normalizeRate(storyRate(), host.narrationRate()),
        onDone: () => {
          // 旧段的 onDone（已重开/已停/已换段）：不许再动占线，也不许再接下一段
          if (token !== shared.gen) return
          clearGuard()
          refs.busy.current = false
          refs.narrating.current = false
          // 讲完就解叙述锁：旧实现只清 ref，麦克风还要按估算时长多静音几秒
          try { host.clearNarrate() } catch (e) { }
          if (d && d.isLast === false) {
            // 长故事在数据里被切成好几段（《画皮》3 段、《婴宁》6 段）。
            // 连播默认开：讲完一段自动接下一段，只到最后一段才报完；
            // 主人把「连播」关掉时才停下等「接着说」。
            if (refs.auto.current) {
              host.bubble('这一段讲完啦，接着往后讲…', 4000)
              // 微任务接下一段，不留可被「歇会儿」跨过的定时器窗口；
              // 下一段请求途中被停止（busy 被清）时，回来会自己作废。
              Promise.resolve().then(() => {
                if (token !== shared.gen) return
                if (!refs.auto.current) return
                if (refs.busy.current) return
                next()
              })
            } else {
              host.bubble('这段讲完啦～点菜单「接着说」听下一段', 6000)
            }
          } else {
            refs.auto.current = false
            host.bubble(host.persona.line('poemDone'), 6000)
          }
        },
      })
      armGuard(token, speakMs + SPEAK_GUARD_EXTRA_MS)
    } catch (e) {
      // speak 本身抛错（音频上下文坏了等）：别留占线
      refs.busy.current = false
      refs.narrating.current = false
      try { host.clearNarrate() } catch (e2) { }
      host.bubble('这段没念出来，先停在这里～', 5000)
    }
  }

  function start(hint: string): void {
    if (refs.busy.current) { host.bubble('正讲着呢，听完这段再说～', 3000); return }
    // 参数格式以 host/routes/story.ts 为准：现行只认 hint（书名也算 hint）。
    // 书名另外以 book 传一份（同值），既满足「按书名点播」的调用约定，又不改后端协议。
    const query = hint
      ? '?book=' + encodeURIComponent(hint) + '&hint=' + encodeURIComponent(hint)
      : ''
    requestStory('/story/start' + query, false, {
      slow: '说书等太久啦（网络慢或书太大），再点一次试试～',
      fail: '说书连不上',
    }, (d: any, token: number) => {
      if (!d || !d.ok) {
        release(token)
        host.bubble('说书没开成：' + storyErrorText(d && d.error), 5000)
        return
      }
      playPiece(d)
    })
  }

  function next(): void {
    if (refs.busy.current) { host.bubble('正讲着呢，听完这段再说～', 3000); return }
    requestStory('/story/next', false, {
      slow: '说书等太久啦（网络慢或书太大），再点一次试试～',
      fail: '说书连不上',
    }, (d: any, token: number) => {
      if (!d || !d.ok) {
        release(token)
        host.bubble('说书卡住了：' + storyErrorText(d && d.error), 4000)
        return
      }
      if (d.done) {
        // 后端目前不会回 done（一轮讲完会自动清单重来），这段留给旧协议
        release(token)
        host.bubble('一轮都讲完啦，本鱼从头再讲～', 5000)
        start('')
        return
      }
      playPiece(d)
    })
  }

  function reset(): void {
    // 「从头讲这本书」：按最近一次说过的书名清进度（后端会清该书全部 book|index）
    const book = refs.book.current
    if (!book) { host.bubble('还没讲书呢', 3000); return }
    // 正在念的时候不能清进度：当前这一段还在响，清了之后「接着讲」会跟它对不上
    if (refs.busy.current) { host.bubble('正讲着呢，先「歇会儿」再从头讲～', 4000); return }
    const path = '/story/reset?book=' + encodeURIComponent(book)
    requestStory(path, true, {
      slow: '重置等太久啦，稍后再试～',
      fail: '说书连不上',
    }, (d: any, token: number) => {
      if (!d || !d.ok) {
        release(token)
        host.bubble('没重置成：' + storyErrorText(d && d.error), 4000)
        return
      }
      release(token)
      refs.book.current = String(d.book || book)
      host.bubble('这本书从头讲～', 3000)
    })
  }

  return { playPiece, start, next, reset }
}
