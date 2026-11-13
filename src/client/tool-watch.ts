/**
 * client/tool-watch.ts —— 工具调用实况解说的「订阅端」
 *
 * 只做三件事：每 3 秒拉一次 /nervous → 筛出 tool/call 事件 → 交给 tool-narrator 决定要不要冒一句。
 * 文案与节奏全在 tool-narrator.ts（纯函数），这里不写文案、不做判断。
 *
 * 与 nervous 的 host-sense 是两条独立轮询：nervous 管情绪、这条管解说，
 * 互不影响（关掉解说不会让情绪停摆，反之亦然）。
 */
import { getJson } from './http.js'
import { narrateTool } from './tool-narrator.js'
import type { NarratorState } from './tool-narrator.js'

/** 诗词弹幕后缀（通用池） */
const POEM_TAILS_COMMON = [
  '——这句是不是有点像你？',
  '。送你了。',
  '。本鲸觉得今天该念这句。',
  '——给你。',
  '。像不像你？',
]

/** 主题专属后缀（命中这些主题时优先） */
const POEM_TAILS_BY_THEME: Record<string, string[]> = {
  坚持: ['。撑住。'],
  奋斗: ['。撑住。'],
  孤独: ['。……本鲸也这么觉得。'],
  思乡: ['。……本鲸也这么觉得。'],
  快乐: ['。今天心情不错嘛。'],
  离别: ['。别难过。'],
  离别酒: ['。别难过。'],
}

/** 诗词冷却：两次诗词弹幕至少隔这么久（本意是偶尔冒一句，不是每句话都冒） */
const POEM_COOLDOWN_MS = 5 * 60 * 1000
/** 上次诗词弹幕时间 */
let lastPoemAt = 0

/** 后缀轮换计数：每次触发 +1，保证不会每次都同一句 */
let poemTailSeq = 0

/**
 * 选后缀：诗句哈希 + 递增计数。
 * 为什么不用「主题哈希 + 日期」：关键词触发的 theme 恒为「关键词」，
 * 同一天里算出来永远是同一句（主人反馈「每道诗都是这个收尾」）。
 */
function poemTail(theme: string, line: string): string {
  const special = POEM_TAILS_BY_THEME[theme] || []
  const pool = special.concat(POEM_TAILS_COMMON)
  let h = poemTailSeq++ >>> 0
  for (const ch of String(theme || "") + String(line || "")) h = (h * 31 + (ch.codePointAt(0) || 0)) >>> 0
  return pool[h % pool.length]
}


/** 轮询路径（getJson 会补 /api/chubby-whale 前缀） */
const PATH = '/nervous'
/** 轮询间隔：3 秒，与 nervous 同频；本地接口，压力可忽略 */
const INTERVAL_MS = 3000

export function createToolWatch(opts: {
  /** 诗词字幕线（调用方注入 poemBubble.show） */
  bubble: (text: string, ms?: number) => void
  /** 工具解说线（调用方注入 toolBubble.show；缺省退回 bubble） */
  toolBubble?: (text: string, ms?: number) => void
  /** 开关（localStorage chubby-tool-narrator !== 'off'） */
  enabled: () => boolean
  /** 诗词弹幕开关（localStorage chubby-poem-echo !== 'off'；缺省 = 开） */
  poemEnabled?: () => boolean
  /** 念出来（诗词弹幕用；缺省 = 只冒气泡不念） */
  speak?: (text: string) => void
  intervalMs?: number
}): { start: () => void; stop: () => void } {
  const interval = Number(opts.intervalMs) > 0 ? Number(opts.intervalMs) : INTERVAL_MS
  let timer: any = null
  let running = false
  let listener: ((line: string) => void) | null = null

  /** 解说的内部状态（冷却、连续调用计数） */
  let state: NarratorState | null = null
  /** 已处理到的最新 at（宿主保证 at 单调） */
  let cursor = 0
  /** 首拍只对齐基线，不回放历史（与 host-sense 同一条取舍：别一开机就把旧调用全解说一遍） */
  let baselineSet = false
  /** 上一次请求没回来就不再叠一个 */
  let inflight = false
  /** 诗词字幕占用期：这段时间里工具解说让路，别把字幕顶掉 */
  let poemBusyUntil = 0

  function deliver(events: any[]): void {
    if (!Array.isArray(events) || !listener) return
    if (!baselineSet) {
      baselineSet = true
      for (const e of events) {
        const at = Number(e && e.at)
        if (Number.isFinite(at) && at > cursor) cursor = at
      }
      return
    }
    for (const e of events) {
      const at = Number(e && e.at)
      if (!Number.isFinite(at) || at <= cursor) continue
      cursor = at
      // 只认 tool/call；data.tool 是工具名（见 host/nervous/collector.ts）
      const d = (e && e.data) || {}
      if (e && e.type === 'host' && d.name === 'poem-echo' && d.line) {
        const poemOn = opts.poemEnabled ? !!opts.poemEnabled() : true
        if (poemOn) {
          /**
           * 冷却只拦「意境」触发（theme 是主题名），**关键词命中放行**：
           * 主人明确要求「寻寻」这类关键词要按点播优先立刻冒整首，不被 5 分钟冷却挡住。
           * 意境触发仍走冷却，避免日常闲聊每句话都冒诗（1.4.0 的旧问题）。
           */
          const keywordHit = String((d as any).theme || '') === '关键词'
          if (!keywordHit && Date.now() - lastPoemAt < POEM_COOLDOWN_MS) { continue }
          lastPoemAt = Date.now()
          const line = String(d.line)
          const full = Array.isArray((d as any).full) ? (d as any).full.map((x: any) => String(x)).filter(Boolean) : []
          const src = full.length ? full : [line]
          const tail = poemTail(String((d as any).theme || ""), String(d.line || ""))
          const title = String((d as any).title || "").trim()
          const author = String((d as any).author || "").trim()
          const source = title ? (author ? author + "《" + title + "》" : "《" + title + "》") : ""
          // 整首一条气泡（不再每 2 句切换——切换会让字幕「跳跃」）；
          // 气泡在 CSS 里带 max-height + 滚动，长词也能看全。
          const body = src.join("\n")
          const cite = source ? "\n——" + source + "。" : ""
          const text = "咕噜……" + body + cite + tail
          // 时长按整首字数算（慢速每字约 320ms，下限 18s、上限 90s）
          const spoken = body + (source ? "。" + source : "") + tail
          const ms = Math.min(90000, Math.max(18000, spoken.length * 320))
          poemBusyUntil = Date.now() + ms
          try { opts.bubble(text, ms) } catch (err) { }
          // 语音一次念完整首 + 出处 + 后缀
          try { if (opts.speak) opts.speak(spoken) } catch (err) { }
        }
        continue
      }
      if (e && e.type === 'host' && d.name === 'tool/call' && d.tool) {
        try {
          const r = narrateTool(state, { tool: String(d.tool), at, seq: Number(d.seq) || 0 })
          state = r.state
          if (r.line) { try { listener(r.line) } catch (err) { } }
        } catch (err) { }
      }
    }
  }

  function poll(): void {
    if (!running || inflight || !listener) return
    if (!opts.enabled()) return
    inflight = true
    let pending: Promise<any>
    try {
      pending = getJson(PATH, { cache: 'no-store' })
    } catch (e) {
      inflight = false
      return
    }
    pending
      .then((d: any) => {
        if (d && d.ok && Array.isArray(d.events)) deliver(d.events)
      })
      .catch(() => { })
      .then(() => { inflight = false })
  }

  function start(): void {
    if (running) return
    running = true
    listener = (line: string) => {
      try {
        // 诗词字幕正在显示：工具解说让路（优先级：诗词 > 解说）
        if (Date.now() < poemBusyUntil) return
        const show = opts.toolBubble || opts.bubble
        show(line, 5200)
      } catch (e) { }
    }
    // 启动立刻拉一拍（对齐基线），之后定时
    poll()
    timer = setInterval(poll, interval)
  }

  function stop(): void {
    running = false
    listener = null
    if (timer) { try { clearInterval(timer) } catch (e) { } }
    timer = null
  }

  return { start, stop }
}
