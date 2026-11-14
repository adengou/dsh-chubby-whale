/**
 * client/bubble-queue.ts —— 气泡线路调度器（同一时间只允许一条线路活着）
 *
 * 背景：原先诗词字幕、对话气泡、persona 问候、工具解说各用一个 DOM 元素，
 * 虽然互不覆盖，但会「同时」飘好几条，屏幕上乱。主人要求：
 *   同一时间只有一条线路是活的，按优先级先后跑。
 *
 * 规则：
 *   · 优先级：poem(诗词) > voice(语音状态) > main(对话) > persona(问候/饥饿/今日) > tool(工具解说)；
 *   · 队列内高优先级在前，同级 FIFO（先来先跑）；
 *   · 正在跑的被更高优先级抢：当前项先停；内容型**放回队列**（不丢），瞬时状态（transient）直接丢弃；
 *   · 带 replace 的条目（念诗字幕）不排队，直接顶掉同线路当前项与同线路排队项，只保留最新一句；
 *   · 带 key 的条目（流式对话片段 / 语音状态）按「同线同 key 只留最新」合并——旧片段不排队回放；
 *   · 排队超过 staleAfter 的条目不再显示（等太久了，补播只会让人以为卡住）；
 *   · 队列有上限（MAX_QUEUED），溢出时丢最早的一条最低优先级条目；
 *   · 每条按自己的时长跑完，跑完再取队首。
 *
 * 纯逻辑、零依赖：不碰 DOM；时钟与定时器都由调用方注入（默认真实 setTimeout/Date.now），方便单测。
 */

/**
 * 气泡线路（2026-11-13 校正：原为**五条**，不是三条；2026-11-14 新增通用 team 线，共六条）
 *
 *   poem    诗词线   念诗正文/字幕、诗词弹幕、说书字幕——最高，正在讲的内容不能被压断
 *   voice   语音线   语音识别的临时状态（「（听到）…本鱼在想…」「麦克风没开成」）
 *   main    主气泡   对话回复、菜单报数、错误提示——内容型
 *   persona 问候线   早安/晚安/饥饿/今日一句——氛围型，来了就排，不必抢
 *   team    团队线   鲸鱼看板的一次性提醒（审批/卡点）——低于氛围问候，高于工具解说
 *   tool    解说线   工具调用实况解说——最低，随时可以被任何一条压掉
 *
 * 语音线必须在主气泡之上：主人刚说完话，「（听到）…本鱼在想…」是对这一回合的即时确认；
 * 排在上一轮回复后面等于永远看不见（回复气泡本身 6 秒，语音状态 3 秒，等到就过期了）。
 * 被它顶下来的回复气泡按原优先级回队列，语音状态跑完会接着显示。
 *
 * team 线只是通用车道，不含任何团队业务：具体文案/时长/合并键由调用方放进条目。
 * 它要压过 tool（解说随时可让路），但不能压过 persona（问候是主人日常节奏的一部分）。
 */
export type BubbleLane = 'poem' | 'voice' | 'main' | 'persona' | 'team' | 'tool'

/** 线路优先级：数字越大越优先（team=1.5 只为插在 persona 与 tool 之间，不改现有值） */
export const LANE_PRIORITY: Readonly<Record<BubbleLane, number>> = Object.freeze({
  poem: 5,
  voice: 4,
  main: 3,
  persona: 2,
  team: 1.5,
  tool: 1,
})

/** 队列上限：正常交互远到不了；只防「生产者刷屏」把内存与延迟拖爆 */
export const MAX_QUEUED = 64

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
  /**
   * 同道替换：入队时直接顶掉当前同线路气泡（连同该线路已排队的旧条目），不排队。
   * 念诗字幕用它——「第 x/N 句」必须跟着声音走，排队会让字幕落后语音几十秒。
   */
  replace?: boolean
  /**
   * 瞬时状态气泡（「（听到）…本鱼在想…」「（点播）好，念一首」这类）：
   * 被更高优先级抢占后**丢弃**，不回队列——等高优先级跑完再补一条过期状态，只会让人以为卡住。
   */
  transient?: boolean
  /**
   * 合并键：同线路 + 同 key 只保留最新一条。
   * 流式对话每 400ms 一条半句、语音状态连续更新，都靠它合并；
   * 旧片段既不该排队回放，也不该在回复出来后再闪一遍。
   */
  key?: string
  /**
   * 排队过期：入队后等待超过该毫秒数就不显示了（运行中的条目不受影响）。
   * 语音状态这类「只对当下有意义」的气泡必须带它，否则会排在长诗后面、诗念完才冒出来。
   */
  staleAfter?: number
  /**
   * 同线路内的子优先级（越大越先）：只影响**同一线路**的排队顺序，不影响跨线路优先级。
   * 诗词线里「点播/念诗字幕」=10、诗词弹幕=0：主人点播的内容永远排在弹幕前面，
   * 同 rank 之间仍是 FIFO。跨线路仍按 LANE_PRIORITY。
   */
  rank?: number
}

export type BubbleScheduler = {
  /** 入队一条；返回 false 表示同线路同文本正在跑/已在队里（被忽略） */
  enqueue: (item: BubbleItem) => boolean
  /** 停止并清空（卸载用） */
  clear: () => void
  /** 当前是否有活在跑 / 排队数（调试用） */
  status: () => { running: BubbleLane | null; queued: number }
}

/** 队内条目：带上入队时刻，供 staleAfter 判定 */
type Queued = { item: BubbleItem; at: number }

/** 找插入位置：先按线路优先级，再按同线 rank（大者前），同 rank 排在已有同级之后（FIFO） */
function insertIndex(queue: Queued[], item: BubbleItem): number {
  const p = LANE_PRIORITY[item.lane]
  const r = item.rank || 0
  let i = 0
  while (i < queue.length) {
    const q = queue[i].item
    const qp = LANE_PRIORITY[q.lane]
    if (qp < p) break
    if (qp === p) {
      const qr = q.rank || 0
      if (qr < r) break
      // qr === r：FIFO，继续往后找
    }
    i++
  }
  return i
}

/**
 * 建一个调度器。
 * @param timers 定时器与时钟注入（默认 setTimeout/clearTimeout/Date.now；测试传假实现）
 */
export function createBubbleScheduler(timers?: {
  setTimeout: (fn: () => void, ms: number) => any
  clearTimeout: (t: any) => void
  now?: () => number
}): BubbleScheduler {
  const st = timers ? timers.setTimeout : (fn: () => void, ms: number) => setTimeout(fn, ms)
  const ct = timers ? timers.clearTimeout : (t: any) => clearTimeout(t)
  const now = timers && timers.now ? timers.now : () => Date.now()

  const queue: Queued[] = []
  let current: BubbleItem | null = null
  let currentAt = 0
  let timer: any = null

  /** 让一条气泡成为「当前」（重置计时器，到点换下一条） */
  function startItem(item: BubbleItem, at = now()): void {
    current = item
    currentAt = at
    try { item.start() } catch (e) { }
    timer = st(() => {
      timer = null
      if (current !== item) return
      current = null
      try { item.stop() } catch (e) { }
      pump()
    }, item.ms)
  }

  /** 丢掉队首已经等过期的条目（运行中的不受影响） */
  function dropStale(): void {
    while (queue.length) {
      const head = queue[0]
      const st2 = head.item.staleAfter
      if (st2 !== undefined && now() - head.at > st2) {
        queue.shift()
        continue
      }
      break
    }
  }

  /** 队列溢出：丢最早的一条最低优先级条目（队内已按优先级排序，取第一个最低优先级） */
  function trim(): void {
    if (queue.length <= MAX_QUEUED) return
    let minP = Infinity
    for (const q of queue) minP = Math.min(minP, LANE_PRIORITY[q.item.lane])
    for (let i = 0; i < queue.length; i++) {
      if (LANE_PRIORITY[queue[i].item.lane] === minP) { queue.splice(i, 1); break }
    }
  }

  /** 取队首开工；若正在跑且队首优先级更高则抢占 */
  function pump(): void {
    dropStale()
    if (current) {
      const top = queue[0]
      if (!top || LANE_PRIORITY[top.item.lane] <= LANE_PRIORITY[current.lane]) return
      // 抢占：当前项停下让高优先级先跑。
      // 内容型条目放回队列（内容不丢）；瞬时状态条目直接丢——等别人跑完再补一条过期状态是噪音。
      const preempted = current
      current = null
      if (timer) { try { ct(timer) } catch (e) { } }
      timer = null
      try { preempted.stop() } catch (e) { }
      if (!preempted.transient) {
        // 按优先级放回（不能 unshift 到队首，否则下一轮又先取到它，高优先级没机会）。
        // 入队时刻沿用**第一次入队**的那个：被抢占不算「重新排队」，
        // 否则一条回复每次被语音顶掉都重置过期计时，能无限往后拖、在很久之后补播。
        queue.splice(insertIndex(queue, preempted), 0, { item: preempted, at: currentAt })
      }
      dropStale()
    }

    const next = queue.shift()
    if (!next) return
    startItem(next.item, next.at)
  }

  /** 清掉排队中「同线同 key」的旧条目；返回是否有当前项也是同线同 key */
  function dropKey(lane: BubbleLane, key: string): boolean {
    for (let i = queue.length - 1; i >= 0; i--) {
      const it = queue[i].item
      if (it.lane === lane && it.key === key) queue.splice(i, 1)
    }
    return !!(current && current.lane === lane && current.key === key)
  }

  function enqueue(item: BubbleItem): boolean {
    if (!item || !item.text) return false

    // 合并键：同线同 key 只留最新（流式半句 / 连续语音状态）
    if (item.key) {
      const sameRunning = dropKey(item.lane, item.key)
      if (sameRunning && current) {
        // 正在显示的旧片段：停掉并立刻换成新内容（不排队，否则字幕会落后）
        if (timer) { try { ct(timer) } catch (e) { } }
        timer = null
        const prev = current
        current = null
        try { prev.stop() } catch (e) { }
        startItem(item)
        return true
      }
      if (current) {
        queue.splice(insertIndex(queue, item), 0, { item, at: now() })
        trim()
        pump()
        return true
      }
      startItem(item)
      return true
    }

    // 同道替换（念诗字幕）：顶掉当前同线路气泡，并把该线路已排队的旧条目一起清掉，
    // 然后立刻显示本条——字幕只保留最新一句，不排队。
    if (item.replace) {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].item.lane === item.lane) queue.splice(i, 1)
      }
      if (current && current.lane === item.lane) {
        if (timer) { try { ct(timer) } catch (e) { } }
        timer = null
        const prev = current
        current = null
        try { prev.stop() } catch (e) { }
      }
      if (current) {
        // 还有别的线路在跑：按优先级排队，让抢占逻辑决定先后（同道旧条目已清掉）
        queue.splice(insertIndex(queue, item), 0, { item, at: now() })
        trim()
        pump()
        return true
      }
      startItem(item)
      return true
    }

    // 同线路同文本：正在跑或已在队里就忽略（防止重复触发刷屏）
    if (current && current.lane === item.lane && current.text === item.text) return false
    for (const q of queue) if (q.item.lane === item.lane && q.item.text === item.text) return false
    queue.splice(insertIndex(queue, item), 0, { item, at: now() })
    trim()
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
