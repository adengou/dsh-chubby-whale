/**
 * client/channel.ts —— 串行通道（资源租约 + 优先级队列）
 *
 * 为什么不是"全局单线程队列"：
 *   浏览器里的 JS 本来就是单线程，把**所有**异步任务塞进一个 FIFO 队列会出事：
 *   一个 2 秒的对话请求会把提醒、气泡刷新、动画全堵在后面，用户看到的是"整个插件卡死"。
 *   真正需要串行的只有**独占性资源**：
 *     · 麦克风（同一时刻只能录一段）
 *     · ASR 请求（同一时刻只允许一个在途，否则结果乱序）
 *     · 扬声器（同一时刻只能播一段）
 *
 * 所以这里做的是"每个资源一条通道"：
 *   - 同一通道内严格串行（前一个跑完才跑下一个）；
 *   - 通道内按优先级排队（数字小优先），同优先级 FIFO；
 *   - conflate = true 时，同 key 只保留最新一条（旧的直接丢，不排队）；
 *   - 统计 inFlight / queued / done / dropped / lastMs，便于排查"占线"。
 *
 * 与"纪元（epoch）"的分工：
 *   队列负责"谁先执行"，纪元负责"结果还算不算数"。
 *   已经过期的结果不该排队等待执行，应当直接丢弃 —— 这是 epoch 的职责。
 */

export type ChannelTask = {
  key?: string
  priority?: number
  /** 同 key 只保留最新一条（麦克风/ASR 这类"最新状态才有意义"的资源用） */
  conflate?: boolean
  run: () => Promise<any> | any
}

export type ChannelStats = {
  inFlight: number
  queued: number
  done: number
  dropped: number
  lastMs: number
  lastError: string
}

export function createChannel(name: string) {
  type Entry = { key?: string; priority: number; seq: number; run: () => any }
  const queue: Entry[] = []
  let inFlight = false
  let seq = 0
  const stats: ChannelStats = { inFlight: 0, queued: 0, done: 0, dropped: 0, lastMs: 0, lastError: '' }

  function pickNext(): Entry | undefined {
    if (queue.length === 0) return undefined
    // 优先级小的先走；同优先级按到达顺序（seq）
    let best = 0
    for (let i = 1; i < queue.length; i++) {
      const a = queue[i]
      const b = queue[best]
      if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i
    }
    return queue.splice(best, 1)[0]
  }

  async function drain(): Promise<void> {
    if (inFlight) return
    const next = pickNext()
    if (!next) return
    inFlight = true
    stats.inFlight = 1
    stats.queued = queue.length
    const t0 = Date.now()
    try {
      await next.run()
      stats.lastError = ''
    } catch (e: any) {
      stats.lastError = String((e && e.message) || e)
      try { console.error('[' + name + '] 通道任务异常：', e) } catch (e2) { }
    } finally {
      stats.lastMs = Date.now() - t0
      stats.done++
      inFlight = false
      stats.inFlight = 0
      stats.queued = queue.length
      // 继续下一个（用微任务，避免深递归）
      if (queue.length > 0) setTimeout(() => { void drain() }, 0)
    }
  }

  function push(task: ChannelTask): void {
    const priority = typeof task.priority === 'number' ? task.priority : 5
    if (task.conflate && task.key) {
      // 同 key 的旧任务作废：它描述的是"过去的状态"，执行它只会拖慢最新的那条
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].key === task.key) { queue.splice(i, 1); stats.dropped++ }
      }
    }
    queue.push({ key: task.key, priority, seq: ++seq, run: task.run })
    stats.queued = queue.length
    void drain()
  }

  return {
    name,
    push,
    /** 直接跑一个任务并返回结果（不排队，但仍受 inFlight 保护：忙则返回 undefined） */
    tryRun: (task: ChannelTask): boolean => {
      if (inFlight) return false
      push(task)
      return true
    },
    stats,
    isBusy: (): boolean => inFlight,
    clear: (): void => { stats.dropped += queue.length; queue.length = 0; stats.queued = 0 },
  }
}

/** 插件用到的三条独占通道 */
export function createChannels() {
  return {
    /** 麦克风采集段：最新一段才有意义（conflate） */
    mic: createChannel('mic'),
    /** ASR：同一时刻只允许一个在途，结果不能乱序 */
    asr: createChannel('asr'),
    /** 扬声器：严格串行，按优先级（P0 主人回复 > P1 说书 > P2 提醒） */
    speak: createChannel('speak'),
  }
}
