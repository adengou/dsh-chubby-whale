/**
 * client/reminders.ts —— 到点提醒的轮询与播报队列
 *
 * 原逻辑写在 client.ts 的 WhaleBody 里（pumpDueReminders + dueQueueRef + dueTimerRef
 * + 20 秒轮询 effect）。抽成 createReminderPoller 后：
 *   - 每 20 秒查一次 /reminders?action=due（与 C# 一致）；
 *   - 到点的提醒全部入队，逐条「气泡 + 朗读」，两条之间隔 3 秒；
 *   - 本鱼正在朗读 / 说书 / 思考时排队等，2 秒后重试，绝不插队抢话筒。
 *
 * 这里只做编排，副作用（取数、气泡、朗读、忙闲判断）全部由 host 注入，
 * 便于离线单测；卸载收尾顺序固定为：撤到点定时器 → 清队列 → 停轮询。
 */

import { getJson } from './http.js'

/** 到点提醒轮询所需的宿主能力（由 client.ts 注入） */
export interface ReminderHost {
  /** GET 并解析 JSON；缺省用 client/http.ts 的 getJson */
  getJson?: (path: string, init?: any) => Promise<any>
  /** 冒气泡 */
  bubble: (text: string, ms: number) => void
  /** 让鱼张嘴说话（动画） */
  talkFor: (ms: number) => void
  /** 朗读一句 */
  speak: (text: string) => void
  /** 是否正在朗读（低优先级让路） */
  isSpeaking: () => boolean
  /** 是否正在说书（低优先级让路） */
  isNarrating: () => boolean
  /** 是否正忙（低优先级让路） */
  isBusy: () => boolean
}

export interface ReminderPollerOptions {
  /** 轮询周期，默认 20000（与 C# 一致） */
  intervalMs?: number
  /** 忙时重试间隔，默认 2000 */
  retryMs?: number
  /** 两条提醒之间的间隔，默认 3000 */
  gapMs?: number
  /** 气泡停留，默认 8000 */
  bubbleMs?: number
}

export interface ReminderPoller {
  /** 立刻处理队列（轮询到点后内部调用；单测可直接调） */
  pump(): void
  /** 启动轮询，返回停止函数（交给 effect 的 cleanup） */
  start(): () => void
  /** 卸载收尾：撤到点定时器 → 清队列 → 停轮询；顺序不可调换 */
  dispose(): void
}

const DUE_PATH = '/reminders?action=due'

/** 取整数毫秒，非法值退回默认值 */
function ms(v: any, def: number): number {
  const n = Math.round(Number(v))
  return isFinite(n) && n > 0 ? n : def
}

export function createReminderPoller(host: ReminderHost, opts?: ReminderPollerOptions): ReminderPoller {
  const o = opts || {}
  const intervalMs = ms(o.intervalMs, 20000)
  const retryMs = ms(o.retryMs, 2000)
  const gapMs = ms(o.gapMs, 3000)
  const bubbleMs = ms(o.bubbleMs, 8000)
  const fetchJson = typeof host.getJson === 'function' ? host.getJson : getJson

  const queue: any[] = []
  let dueTimer: any = null
  let pollTimer: any = null

  /** 到点队列：一次只放一条，间隔 gapMs；忙时 retryMs 后重试 */
  function pump(): void {
    if (dueTimer) return
    if (queue.length === 0) return
    // 提醒是低优先级：本鱼正在说/在想/在说书时排队等，绝不插队抢话筒
    if (host.isSpeaking() || host.isNarrating() || host.isBusy()) {
      dueTimer = setTimeout(() => {
        dueTimer = null
        pump()
      }, retryMs)
      return
    }
    const item = queue.shift()
    // 照 C# FishForm：气泡与朗读都用「主人，提醒你：」+ 正文；正文为空兜底「时间到了」
    const body = String((item && item.text) || '').trim() || '时间到了'
    const line = '主人，提醒你：' + body
    host.bubble(line, bubbleMs)
    host.talkFor(3000)
    try { host.speak(line) } catch (e) { }
    dueTimer = setTimeout(() => {
      dueTimer = null
      pump()
    }, gapMs)
  }

  /** 停轮询（幂等） */
  function stopPoll(): void {
    if (pollTimer !== null) {
      try { clearInterval(pollTimer) } catch (e) { }
      pollTimer = null
    }
  }

  function start(): () => void {
    stopPoll()
    pollTimer = setInterval(() => {
      fetchJson(DUE_PATH).then((d: any) => {
        const due = (d && d.due) || []
        for (const it of due) {
          if (it && it.text) queue.push(it)
        }
        pump()
      }).catch(() => { })
    }, intervalMs)
    return stopPoll
  }

  function dispose(): void {
    // 顺序敏感：先撤到点定时器，再清队列，最后停轮询（与原来 client.ts 的卸载顺序一致）
    if (dueTimer !== null) {
      try { clearTimeout(dueTimer) } catch (e) { }
      dueTimer = null
    }
    queue.length = 0
    stopPoll()
  }

  return { pump, start, dispose }
}
