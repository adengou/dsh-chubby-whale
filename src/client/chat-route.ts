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
import { parseWeatherAsk } from './weather-ask.js'
import type { Persona } from './persona.js'
import type { StoryController, StoryRefs } from './story.js'
import { beginOnce, recitePoem } from './actions/culture.js'

/**
 * 点播取数的显式预算（B105）。
 *
 * 为什么在 route 层再写一遍：http.ts 的默认 15s 是兜底，不是每个接口合适的节奏。
 *   · 典故/成语：宿主数据接口自己 10s，再留一次文件读取与回传的余量 → 20s；
 *   · 念诗：单文件小数据，15s 与 http 默认一致，显式写出来便于审查。
 * 超时后走**既有**失败文案（'诗册没读到' / '这个没读到'），不新造提示。
 * 不导出：模块接口清单受控，B105 只改三个文件，不新增对外符号。
 */
const CULTURE_TIMEOUT_MS = 20000
const POEM_TIMEOUT_MS = 15000
/** 天气查询预算：宿主自己 6s 超时 + 回包余量（wttr.in 慢时不至于把气泡一直挂着） */
const WEATHER_TIMEOUT_MS = 8000
/** 天气没查到的统一人话（不编一个温度糊弄主人） */
const WEATHER_FAIL_TEXT = '天气没查到，可能是网断了；等会儿再问本鲸一次'

export type LocalRouteHost = {
  persona: Persona
  narrationRate: () => string
  bubble: (text: string, ms?: number, opts?: { transient?: boolean }) => void
  /**
   * 诗词线气泡（念诗正文/逐句进度）：最高优先级 + 同道替换。
   * 缺省时 recitePoem 退回 bubble，功能不受影响。
   */
  poemBubble?: (text: string, ms?: number) => void
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
  /** 最近一次「点了名」的诗词请求：追问「叫你背呀」时接着背这首（2 分钟内有效） */
  let lastPoemAsk = { title: '', at: 0 }
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

  function fetchPoem(query: string, onItem: (p: any) => void, wantTitle?: string): void {
    // 显式 15s：宿主不回包时到点走下面的既有「诗册没读到」，不再无限等（B105）
    getJson('/poem' + query, { timeout: POEM_TIMEOUT_MS }).then((d: any) => {
      if (!d || d.ok !== true) { host.bubble('诗册没读到', 4000); return }
      const p = d.item || null
      if (!p) { host.bubble('诗册没读到', 4000); return }
      /**
       * 点了名、诗库里却没有：宿主会「回落随机一首」并在响应里带 matched:false。
       * 旧实现直接照着随机那首念——主人说「背诵《梦》」，听到的却是《雨霖铃》，
       * 比「不知道」更糟。这里改成照实说没有，并明确不拿别的凑数。
       */
      if (wantTitle && d.matched === false) {
        host.bubble('诗库里没有《' + wantTitle + '》，本鲸不拿别的凑数', 6000)
        return
      }
      onItem(p)
    }).catch(() => host.bubble('诗册没读到', 4000))
  }

  /**
   * 天气建议：只根据已查到的事实（描述/温度）给一句穿衣提醒，
   * 不编「今天会下雨」这类没查到的结论。
   */
  function weatherTip(d: any): string {
    try {
      const desc = String(d && d.desc || '')
      const temp = Number(d && d.tempC)
      if (/雨|雪|雷/.test(desc)) return '出门带把伞'
      if (Number.isFinite(temp) && temp <= 5) return '多穿点，别冻着'
      if (Number.isFinite(temp) && temp >= 30) return '热，别在外面晒太久'
      if (Number.isFinite(temp) && temp >= 20) return '穿件薄的就够了'
      return '出门看天加件衣服'
    } catch (e) { return '' }
  }

  /**
   * 实时天气（本地查询，不交给模型猜）：命中即气泡 + 朗读。
   * 宿主查不到就照实说「没查到」——宁可答不上，也不编一个温度。
   */
  function fetchWeather(city: string): void {
    host.bubble('（查天气）本鲸看看天…', 3000, { transient: true })
    getJson('/weather?city=' + encodeURIComponent(city), { cache: 'no-store', timeout: WEATHER_TIMEOUT_MS }).then((d: any) => {
      if (!d || d.ok !== true || typeof d.text !== 'string' || !d.text) {
        host.bubble(WEATHER_FAIL_TEXT, 6000)
        return
      }
      const tip = weatherTip(d)
      const said = d.text + (tip ? '，' + tip : '') + '～'
      host.bubble(said, 9000)
      host.say(said, 7000)
    }).catch(() => host.bubble(WEATHER_FAIL_TEXT, 6000))
  }

  function route(rawText: string): boolean {
    const t0 = String(rawText || '').trim()
    /**
     * 句末的陈述语气标点先剥掉再认整句指令：主人打字常带「接着说。」「报书名！」，
     * 而下面的整句正则都以 `$` 收尾。问号不剥——带问号的是提问（"接着说？"是问，
     * 不是命令），照旧交给模型。
     */
    const cmd = t0.replace(/[。．.!！~～…]+$/, '')

    /**
     * 追问：接着念诗 / 接着说书（主人不必重新"点播"一次）。
     * 只接两种：① 不点具体内容（「再来一首」「换一个」「再念首」）；
     * ② 明确点诗（「再来一首诗」）。
     * 其余一律交给模型——「换个说法 / 换个话题 / 换个声音 / 换个故事 / 再来个故事」
     * 都不是"再念一首诗"。intent 的既有断言（test-utils-pure「不是点播的近似说法
     * 照样交给模型（来点故事 / 换个故事）」）已经把这类说法划给模型，这里不能再抢先接住。
     */
    const again = /^(再来|再念|换)(一)?(首|个)([\s\S]*)$/.exec(cmd)
    const againTail = again ? again[4] : ''
    if (again && (againTail === '' || /^[吧啊呀哦嘛哈啦呗吖诗]+/.test(againTail))) {
      takeOver()
      host.bubble('（点播）好，再念一首', 3000, { transient: true })
      fetchPoem('', (p) => recitePoem(host, p))
      return true
    }
    if (/^(继续|接着说|接着讲|往下讲)$/.test(cmd)) {
      takeOver()
      host.bubble('（点播）接着说', 3000, { transient: true })
      // 点播故事=要连播：同步写 localStorage，避免菜单显示「关」但实际自动接段
      try { host.storyState.auto.current = true; setStoryAuto(true) } catch (e) { }
      host.story.start(host.storyState.book.current || '')
      return true
    }

    // 报书名 / 报书单：本地列书单，不进模型（「报书名」是点播指令里唯一不带书名的那种）
    if (/^(报|说|列)(一下|下)?(书名|书单)$/.test(cmd)) {
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

    // 实时天气：早于「问句交给模型」——模型看不到外面的天，本地查才有真数据。
    // 诗句/闲聊（「天气晚来秋」「我喜欢这样的天气」）由 parseWeatherAsk 挡回去。
    const weatherAsk = parseWeatherAsk(t0)
    if (weatherAsk) {
      takeOver()
      fetchWeather(weatherAsk.city)
      return true
    }

    const hit = detectIntent(rawText)
    if (!hit) {
      /**
       * 追问：「叫你背呀！」「快念」这类没有诗名、也没有标准点播句式的句子。
       * 语音里主人先报了诗名（《宋·雨霖铃》），下一句催促时不能又交给模型——
       * 模型只会回「本鲸去诗库里翻」，不会真的背。这里 2 分钟内接着背刚才那首。
       * 否定式（别背了）不接。
       */
      const asksAgain = /背|念|朗诵|朗读/.test(rawText) && !/(不|别|甭|勿|无需)/.test(rawText)
      if (asksAgain && lastPoemAsk.title && Date.now() - lastPoemAsk.at < 120000) {
        takeOver()
        host.bubble('（点播）好，念《' + lastPoemAsk.title + '》', 3000, { transient: true })
        fetchPoem('?title=' + encodeURIComponent(lastPoemAsk.title), (p) => recitePoem(host, p), lastPoemAsk.title)
        return true
      }
      return false
    }
    if (hit.kind === 'poem' && hit.title) lastPoemAsk = { title: hit.title, at: Date.now() }
    // 命中点播（念诗 / 典故 / 说书）后才打断旧聊天：没命中的消息照旧交给模型，
    // 绝不能在这里提前 abort，否则普通提问会把自己的请求打断。
    takeOver()

    if (hit.kind === 'poem') {
      const wantTitle = String(hit.title || '').trim()
      // 状态提示是瞬时的：诗词线一开始跑就会把它压掉，压掉后不必再补播
      host.bubble('（点播）好，念一首', 3000, { transient: true })
      fetchPoem(wantTitle ? ('?title=' + encodeURIComponent(wantTitle)) : '', (p) => recitePoem(host, p), wantTitle)
      return true
    }

    if (hit.kind === 'culture') {
      // 数据池口径以 intent 的为准（2026-11-06 定）：讲成语 → idiom（成语辨析池）、
      // 讲典故 → chengyu（带出处的典故故事池）。两者是不同数据池，别在这里对调。
      const type = hit.sub
      if (!beginOnce('route:' + type)) { host.bubble('正在讲呢，稍等～', 2000); return true }
      /**
       * 播报用词按「主人说的是哪个词」走，不跟着数据池名走：
       * 旧实现按 type 取标签，讲典故（type=chengyu）会念成「成语·」「讲个成语——」，
       * 与主人刚说的话正好相反（type 是数据池名，不是主语）。判据与 intent 同一条：
       * 句子里出现「成语」就是成语，其余都是典故。
       */
      const saidIdiom = /成语/.test(t0)
      host.bubble(saidIdiom ? '（点播）讲个成语' : '（点播）讲个典故', 3000)
      getJson('/culture?type=' + type, { timeout: CULTURE_TIMEOUT_MS }).then((d: any) => {
        const it = (d && d.ok && d.item) ? d.item : null
        if (!it) { host.bubble('这个没读到', 4000); return }
        const body = collapseText(String(it.text || ''))
        host.bubble((saidIdiom ? '成语·' : '典故·') + String(it.title || ''), 15000)
        host.speak((saidIdiom ? '讲个成语——' : '讲个典故——') + String(it.title || '') + (it.src ? '，出自' + String(it.src) : '') + '。' + body, { rate: host.narrationRate() })
      }).catch(() => host.bubble('这个没读到', 4000))
      return true
    }

    const book = hit.book || ''
    host.bubble('（点播）' + (book ? '讲《' + book + '》' : '讲一段书'), 4000, { transient: true })
    host.storyState.auto.current = true
    host.story.start(book)
    return true
  }

  return { route }
}
