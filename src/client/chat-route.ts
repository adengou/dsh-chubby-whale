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

import { getJson } from './http.js'
import { detectIntent } from './intent.js'
import { collapseText } from './text.js'
import type { Persona } from './persona.js'
import type { StoryController, StoryRefs } from './story.js'
import { recitePoem } from './actions/culture.js'

export type LocalRouteHost = {
  persona: Persona
  narrationRate: string
  bubble: (text: string, ms?: number) => void
  say: (text: string, ms?: number, opts?: { rate?: string; pitch?: string }) => void
  speak: (text: string, opts?: { rate?: string; narration?: boolean; onDone?: () => void }) => void
  narrate: (ms: number) => void
  clearNarrate: () => void
  talkFor: (ms: number) => void
  story: StoryController
  storyState: StoryRefs
}

export type LocalRouter = {
  /** 命中本地路由返回 true（已处理，不再送模型） */
  route: (text: string) => boolean
}

export function createLocalRouter(host: LocalRouteHost): LocalRouter {
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
      host.bubble('（点播）好，再念一首', 3000)
      fetchPoem('', (p) => recitePoem(host, p))
      return true
    }
    if (/^(继续|接着说|接着讲|往下讲)$/.test(t0)) {
      host.bubble('（点播）接着说', 3000)
      host.story.start(host.storyState.book.current || '')
      return true
    }

    const hit = detectIntent(rawText)
    if (!hit) return false

    if (hit.kind === 'poem') {
      host.bubble('（点播）好，念一首', 3000)
      fetchPoem((hit.title || '') ? ('?title=' + encodeURIComponent(hit.title || '')) : '', (p) => recitePoem(host, p))
      return true
    }

    if (hit.kind === 'culture') {
      const type = hit.sub
      host.bubble(type === 'chengyu' ? '（点播）讲个成语' : '（点播）讲个典故', 3000)
      getJson('/culture?type=' + type).then((d: any) => {
        const it = (d && d.ok && d.item) ? d.item : null
        if (!it) { host.bubble('这个没读到', 4000); return }
        const body = collapseText(String(it.text || ''))
        host.bubble((type === 'chengyu' ? '成语·' : '典故·') + String(it.title || ''), 15000)
        host.speak((type === 'chengyu' ? '讲个成语——' : '讲个典故——') + String(it.title || '') + (it.src ? '，出自' + String(it.src) : '') + '。' + body, { rate: host.narrationRate })
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
