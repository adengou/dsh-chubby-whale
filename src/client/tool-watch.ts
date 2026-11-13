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

/** 轮询路径（getJson 会补 /api/chubby-whale 前缀） */
const PATH = '/nervous'
/** 轮询间隔：3 秒，与 nervous 同频；本地接口，压力可忽略 */
const INTERVAL_MS = 3000

export function createToolWatch(opts: {
  /** 冒一句（调用方注入 showBubble） */
  bubble: (text: string, ms?: number) => void
  /** 开关（localStorage chubby-tool-narrator !== 'off'） */
  enabled: () => boolean
  /** 诗词弹幕开关（localStorage chubby-poem-echo !== 'off'；缺省 = 开） */
  poemEnabled?: () => boolean
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
        if (poemOn) { try { opts.bubble('咕噜……「' + String(d.line) + '」——这句是不是有点像你？', 9000) } catch (err) { } }
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
    listener = (line: string) => { try { opts.bubble(line, 5200) } catch (e) { } }
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
