/**
 * client/bubble-queue.ts —— 气泡线路调度器（同一时间只允许一条线路活着）
 *
 * 背景：原先诗词字幕、对话气泡、persona 问候、工具解说各用一个 DOM 元素，
 * 虽然互不覆盖，但会「同时」飘好几条，屏幕上乱。主人要求：
 *   同一时间只有一条线路是活的，按优先级先后跑。
 *
 * 规则：
 *   · 优先级：poem(诗词) > main(对话) > persona(问候/饥饿/今日) > tool(工具解说)；
 *   · 队列内高优先级在前，同级 FIFO（先来先跑）；
 *   · 正在跑的被更高优先级抢：当前项先停、**放回队首**，等对面跑完再继续（不丢内容）；
 *   · 每条按自己的时长跑完，跑完再取队首。
 *
 * 纯逻辑、零依赖：不碰 DOM、不看钟（时长由调用方给），方便单测。
 */

/** 气泡线路 */
export type BubbleLane = 'poem' | 'main' | 'persona' | 'tool'

/** 线路优先级：数字越大越优先 */
export const LANE_PRIORITY: Readonly<Record<BubbleLane, number>> = Object.freeze({
  poem: 4,
  main: 3,
  persona: 2,
  tool: 1,
})

/** 排队的一条气泡 */
export type BubbleItem = {
  /** 线路 */
  lane: BubbleLane
  /** 文本（只用于调试/去重） */
  text: string
  /** 展示时长（ms） */
  ms: number
  /** 开始显示（调用方注入：显示 DOM / 冒泡） */
  start: () => void
  /** 停止显示（调用方注入：隐藏 DOM） */
  stop: () => void
}

export type BubbleScheduler = {
  /** 入队一条；返回 false 表示同线路同文本正在跑/已在队里（被忽略） */
  enqueue: (item: BubbleItem) => boolean
  /** 停止并清空（卸载用） */
  clear: () => void
  /** 当前是否有活在跑 / 排队数（调试用） */
  status: () => { running: BubbleLane | null; queued: number }
}

/** 找插入位置：优先级高者在前；同优先级排在已有同级之后（FIFO） */
function insertIndex(queue: BubbleItem[], item: BubbleItem): number {
  const p = LANE_PRIORITY[item.lane]
  let i = 0
  while (i < queue.length && LANE_PRIORITY[queue[i].lane] >= p) i++
  return i
}

/**
 * 建一个调度器。
 * @param timers 定时器注入（默认 setTimeout/clearTimeout，测试可传假定时器）
 */
export function createBubbleScheduler(timers?: {
  setTimeout: (fn: () => void, ms: number) => any
  clearTimeout: (t: any) => void
}): BubbleScheduler {
  const st = timers ? timers.setTimeout : (fn: () => void, ms: number) => setTimeout(fn, ms)
  const ct = timers ? timers.clearTimeout : (t: any) => clearTimeout(t)

  const queue: BubbleItem[] = []
  let current: BubbleItem | null = null
  let timer: any = null

  /** 取队首开工；若正在跑且队首优先级更高则抢占 */
  function pump(): void {
    if (current) {
      const top = queue[0]
      if (!top || LANE_PRIORITY[top.lane] <= LANE_PRIORITY[current.lane]) return
      // 抢占：当前项停下，放回队首（内容不丢），让高优先级先跑
      const preempted = current
      current = null
      if (timer) { try { ct(timer) } catch (e) { } }
      timer = null
      try { preempted.stop() } catch (e) { }
      // 按优先级放回（不能 unshift 到队首，否则下一轮又先取到它，高优先级没机会）
      queue.splice(insertIndex(queue, preempted), 0, preempted)
    }

    const next = queue.shift()
    if (!next) return
    current = next
    try { next.start() } catch (e) { }
    timer = st(() => {
      timer = null
      if (current !== next) return
      current = null
      try { next.stop() } catch (e) { }
      pump()
    }, next.ms)
  }

  function enqueue(item: BubbleItem): boolean {
    if (!item || !item.text) return false
    // 同线路同文本：正在跑或已在队里就忽略（防止重复触发刷屏）
    if (current && current.lane === item.lane && current.text === item.text) return false
    for (const q of queue) if (q.lane === item.lane && q.text === item.text) return false
    queue.splice(insertIndex(queue, item), 0, item)
    pump()
    return true
  }

  function clear(): void {
    if (timer) { try { ct(timer) } catch (e) { } }
    timer = null
    if (current) { try { current.stop() } catch (e) { } }
    current = null
    queue.length = 0
  }

  return {
    enqueue,
    clear,
    status: () => ({ running: current ? current.lane : null, queued: queue.length }),
  }
}
