/**
 * client/chat-route.ts —— 点播本地路由（不碰 React）
 *
 * 旧实现是 client.ts 的 tryLocalRoute：一段「再来一首」「接着说」的两个正则特判，
 * 加上 detectIntent 的诗词/典故/说书分流，里面还抄了一遍念诗逻辑。
 * 这里收成一个路由对象，念诗直接复用 actions/culture.ts 的 recitePoem。
 *
 * 路由规则（与主人约定）：
 *   · 只有明确的点播指令才走本地（讲故事 / 背诗 / 讲典故 / 报书名）
 *   · 有问号、「为什么/怎么/如何」、或太长（>30 字）的一律交给模型
 */

import { setStoryAuto } from './story-auto.js'
import { getJson } from './http.js'
import { detectIntent } from './intent.js'
import { collapseText } from './text.js'
import type { Persona } from './persona.js'
import type { StoryController, StoryRefs } from './story.js'
import { beginOnce, recitePoem } from './actions/culture.js'

export type LocalRouteHost = {
  persona: Persona
  narrationRate: () => string
  bubble: (text: string, ms?: number) => void
  say: (text: string, ms?: number, opts?: { rate?: string; pitch?: string }) => void
  speak: (text: string, opts?: { rate?: string; narration?: boolean; onDone?: () => void }) => void
  narrate: (ms: number) => void
  clearNarrate: () => void
  talkFor: (ms: number) => void
  story: StoryController
  storyState: StoryRefs
  /**
   * 打断上一轮还在跑的聊天请求（流式与普通 /chat 一起停）。
   * 点播接住这条消息时调用：主人等回复期间点「背首诗／讲故事」，
   * 旧回复不该继续等、更不该回来插进新内容里。
   * 由 client.ts 注入（接 client/chat.ts 的 abortStream）；非必填，未注入时静默跳过。
   */
  abortChat?: () => void
}

export type LocalRouter = {
  /** 命中本地路由返回 true（已处理，不再送模型） */
  route: (text: string) => boolean
}

export function createLocalRouter(host: LocalRouteHost): LocalRouter {
  /**
   * 接住这条消息 = 不再送模型：先把上一轮还在等的聊天请求打断。
   * 不打断的话，等回复期间点「背首诗／讲个典故／说书」，旧回复回来照旧会
   * 写进消息列表、写气泡、念出来，和新内容叠在一起。
   * 每条消息最多从这里过一次（各分支 return 前调用）；abortChat 没接线时什么都不做。
   */
  function takeOver(): void {
    if (!host.abortChat) return
    try { host.abortChat() } catch (e) { }
  }

  function fetchPoem(query: string, onItem: (p: any) => void): void {
    getJson('/poem' + query).then((d: any) => {
      const p = (d && d.ok && d.item) ? d.item : null
      if (!p) { host.bubble('诗册没读到', 4000); return }
      onItem(p)
    }).catch(() => host.bubble('诗册没读到', 4000))
  }

  function route(rawText: string): boolean {
    const t0 = String(rawText || '').trim()

    // 追问：接着念诗 / 接着说书（主人不必重新"点播"一次）
    if (/^(再来|再念|换)(一)?(首|个)/.test(t0)) {
      takeOver()
      host.bubble('（点播）好，再念一首', 3000)
      fetchPoem('', (p) => recitePoem(host, p))
      return true
    }
    if (/^(继续|接着说|接着讲|往下讲)$/.test(t0)) {
      takeOver()
      host.bubble('（点播）接着说', 3000)
      // 点播故事=要连播：同步写 localStorage，避免菜单显示「关」但实际自动接段
      try { host.storyState.auto.current = true; setStoryAuto(true) } catch (e) { }
      host.story.start(host.storyState.book.current || '')
      return true
    }

    // 报书名 / 报书单：本地列书单，不进模型（「报书名」是点播指令里唯一不带书名的那种）
    if (/^(报|说|列)(一下|下)?(书名|书单)$/.test(t0)) {
      takeOver()
      host.bubble('（点播）本鲸数数书单…', 3000)
      getJson('/story/books', { cache: 'no-store' }).then((d: any) => {
        const books = (d && d.ok && Array.isArray(d.books))
          ? d.books.map((b: any) => String(b || '').trim()).filter(Boolean)
          : []
        if (!books.length) { host.bubble('书单没取到，稍后再试', 4000); return }
        host.bubble('书单有 ' + books.length + ' 本：' + books.join('、') + '（说个书名本鲸就开讲）', 12000)
      }).catch(() => host.bubble('书单没取到，稍后再试', 4000))
      return true
    }

    const hit = detectIntent(rawText)
    if (!hit) return false
    // 命中点播（念诗 / 典故 / 说书）后才打断旧聊天：没命中的消息照旧交给模型，
    // 绝不能在这里提前 abort，否则普通提问会把自己的请求打断。
    takeOver()

    if (hit.kind === 'poem') {
      host.bubble('（点播）好，念一首', 3000)
      fetchPoem((hit.title || '') ? ('?title=' + encodeURIComponent(hit.title || '')) : '', (p) => recitePoem(host, p))
      return true
    }

    if (hit.kind === 'culture') {
      // 映射照 intent 的原意：成语 → chengyu（带出处的小故事，/culture?type=chengyu），
      // 典故 → idiom（/culture?type=idiom）。两者是不同数据池，别在这里对调：
      // 「讲个成语」拿到 chengyu.json 的典故故事，与菜单「成语辨析」（idioms.json）分工不同。
      const type = hit.sub
      if (!beginOnce('route:' + type)) { host.bubble('正在讲呢，稍等～', 2000); return true }
      host.bubble(type === 'chengyu' ? '（点播）讲个成语' : '（点播）讲个典故', 3000)
      getJson('/culture?type=' + type).then((d: any) => {
        const it = (d && d.ok && d.item) ? d.item : null
        if (!it) { host.bubble('这个没读到', 4000); return }
        const body = collapseText(String(it.text || ''))
        host.bubble((type === 'chengyu' ? '成语·' : '典故·') + String(it.title || ''), 15000)
        host.speak((type === 'chengyu' ? '讲个成语——' : '讲个典故——') + String(it.title || '') + (it.src ? '，出自' + String(it.src) : '') + '。' + body, { rate: host.narrationRate() })
      }).catch(() => host.bubble('这个没读到', 4000))
      return true
    }

    const book = hit.book || ''
    host.bubble('（点播）' + (book ? '讲《' + book + '》' : '讲一段书'), 4000)
    host.storyState.auto.current = true
    host.story.start(book)
    return true
  }

  return { route }
}
