/**
 * client/actions/content.ts —— 内容入口的动作处理器（选本书 / 今日一句 / 今日简报）
 *
 * 对应菜单：story-books（书单兜底/重试）、story-book:<书名>、daily-line、briefing-card。
 * 接口：/story/books、/story/start、/daily、/briefing（都经 client/http.ts 加 /api/chubby-whale 前缀）。
 * 接口没上线或请求失败时只给一句气泡，不抛错、不刷日志（与其余处理器同一约定）。
 */

import type { ActionHost, ActionTable } from '../actions.js'
import { getJson } from '../http.js'
import { estimateSpeakMs } from '../text.js'

/** 今日一句：text 必填，source 可能为空 */
export type DailyLine = { text: string; source: string }

/**
 * 从 /daily 响应里取今日一条；取不到（未上线 / ok:false / 缺 text）返回 null。
 * 兼容 {text,source}、{item:{…}}、{items:[{…}]} 三种包裹，接口换形状不用改菜单。
 */
export function pickDaily(d: any): DailyLine | null {
  if (!d || typeof d !== 'object' || d.ok === false) return null
  const box = d.item || d.data || (Array.isArray(d.items) && d.items.length ? d.items[0] : null) || d
  const text = String((box && box.text) || '').trim()
  if (!text) return null
  const source = String((box && box.source) || d.source || '').trim()
  return { text, source }
}

/**
 * 今日简报切成两段：first = 日期 / 北海天气 / 成长，second = 待办提醒。
 * 现有接口（host/routes/briefing.ts）回 {ok,text}，按行归类；
 * 同时兼容结构化回包（date / weather / growth / todos），解析不出返回 null。
 */
export function parseBriefing(d: any): { first: string; second: string } | null {
  if (!d || typeof d !== 'object' || d.ok === false) return null
  const text = String(d.text || (d.item && d.item.text) || '')
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  const first: string[] = []
  const second: string[] = []
  for (const line of lines) {
    // 待办/提醒行单独成段，其余（日期、天气、成长）放第一段
    if (/待办|提醒/.test(line)) second.push(line)
    else first.push(line)
  }
  if (!first.length && !second.length) {
    const date = String(d.date || '').trim()
    const weather = String(d.weather || '').trim()
    const growth = String(d.growth || '').trim()
    const head = [
      date,
      weather ? '北海天气：' + weather : '',
      growth ? '肥鲸成长：' + growth : '',
    ].filter(Boolean).join('\n')
    if (head) first.push(head)
    if (Array.isArray(d.todos)) second.push('待办提醒：' + d.todos.length + ' 条')
    else if (typeof d.todos === 'string' && d.todos.trim()) second.push('待办提醒：' + d.todos.trim())
  }
  if (!first.length && !second.length) return null
  return { first: first.join('\n'), second: second.join('\n') }
}

/** 气泡 + 朗读（语音朗读关着时只出气泡；锁在朗读结束时释放，异常由叙述锁自愈兜底） */
function showAndSpeak(host: ActionHost, shown: string, speech: string, ms: number): void {
  host.bubble(shown, ms)
  host.talkFor(5000)
  if (!host.voiceOn()) return
  host.narrate(estimateSpeakMs(speech))
  host.speak(speech, { rate: host.narrationRate, onDone: () => host.clearNarrate() })
}

export function registerContentActions(table: ActionTable<ActionHost>): void {
  // —— 选本书：书单没拉到时菜单显示这项，点一下重试并报数 ——
  table.define('story-books', (host) => {
    getJson('/story/books', { cache: 'no-store' })
      .then((d: any) => {
        const books = (d && d.ok && Array.isArray(d.books))
          ? d.books.map((b: any) => String(b || '').trim()).filter(Boolean)
          : []
        if (!books.length) { host.bubble('书单没取到，稍后再试', 4000); return }
        host.bubble('书单有 ' + books.length + ' 本，右键点「选本书」挑一本～', 5000)
      })
      .catch(() => host.bubble('书单没取到，稍后再试', 4000))
  })

  // —— 点书名开讲：story-book:<书名>（书名经 story.start 走 hint/book 双参数）——
  table.definePrefix('story-book:', (host, name) => {
    const book = String(name || '').trim()
    if (!book) { host.bubble('书名没读到', 3000); return }
    if (host.storyState && host.storyState.busy.current) { host.bubble('正讲着呢，听完这段再说～', 3000); return }
    host.bubble('开始讲《' + book + '》', 3000)
    host.story.start(book)
  })

  // —— 今日一句：text + ——source，失败静默给一句提示 ——
  table.define('daily-line', (host) => {
    getJson('/daily', { cache: 'no-store' })
      .then((d: any) => {
        const line = pickDaily(d)
        if (!line) { host.bubble('今天那句还没准备好', 3500); return }
        const shown = line.source ? line.text + '\n——' + line.source : line.text
        showAndSpeak(host, shown, shown, 9000)
      })
      .catch(() => host.bubble('今天那句还没准备好', 3500))
  })

  // —— 今日简报：先日期天气、再待办，两段之间空一行 ——
  table.define('briefing-card', (host) => {
    getJson('/briefing', { cache: 'no-store' })
      .then((d: any) => {
        const card = parseBriefing(d)
        if (!card) { host.bubble('简报今天没取到', 3500); return }
        const shown = card.first && card.second
          ? card.first + '\n\n' + card.second
          : (card.first || card.second)
        const speech = [card.first, card.second].filter(Boolean).join('。')
        showAndSpeak(host, shown, speech, 12000)
      })
      .catch(() => host.bubble('简报今天没取到', 3500))
  })
}
