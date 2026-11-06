/**
 * client/channel.ts —— 资源通道（docs/并发纪律.md §七 的基础件）
 *
 * 为什么需要：浏览器 JS 单线程，但「排队粒度」是可选的。全局 FIFO 会让一次对话请求把提醒、
 * 气泡、动画全堵住；正确粒度是**每个独占资源一条通道**：mic / asr / speak 各自串行，
 * 通道之间并发。队列负责「谁先执行」，纪元（epoch）负责「结果还算不算」，两者缺一不可。
 *
 * 本模块只做通道本身，不绑任何业务：
 *   · 串行执行：同一通道内同一时刻只跑一个任务；
 *   · 优先级：数字小 = 优先级高（与全仓 P0 > P1 > P2 的口径一致），同优先级先来先跑；
 *   · conflate：同 key 只保留最新一份（旧的还在排队就丢弃并计数）；
 *   · 统计：queued / running / done / dropped / failed，供诊断面板读。
 *
 * 边界（刻意不做）：
 *   · 不做超时/重试 —— 那是任务自己的事，通道只保证顺序与互斥；
 *   · 不做「取消正在跑的任务」—— 进行中的任务由调用方用 AbortController/纪元作废，
 *     通道若也提供取消，会出现两套真相（这是并发纪律文档里反复强调的坑）。
 */

export type ChannelTaskOptions = {
  /** 优先级：数字小 = 先执行（P0 打断 > P1 说书 > P2 提醒），缺省 5 */
  priority?: number
  /** 合并键：同 key 只保留最新一份（旧的在排队时被丢弃） */
  key?: string
}

export type ChannelStats = {
  name: string
  running: boolean
  queued: number
  done: number
  dropped: number
  failed: number
}

type Entry = {
  task: () => unknown
  priority: number
  seq: number
  key: string
  resolve: (v: any) => void
  reject: (e: any) => void
}

export type Channel = {
  readonly name: string
  /** 把任务排进通道；返回的 Promise 在任务真正执行完后落定 */
  run<T>(task: () => T | Promise<T>, opts?: ChannelTaskOptions): Promise<T>
  /** 当前统计快照（只读拷贝，外部改不动内部状态） */
  stats(): ChannelStats
  /** 队列清空且没有在跑的任务时 resolve（测试与关停用） */
  idle(): Promise<void>
}

/** 优先级缺省值：普通任务，排在 P0/P1/P2 之后 */
const DEFAULT_PRIORITY = 5

/**
 * 建一条通道。
 * @param name 通道名（诊断面板显示用；不参与任何逻辑）
 */
export function createChannel(name = 'channel'): Channel {
  const queue: Entry[] = []
  let running = false
  let seq = 0
  let done = 0
  let dropped = 0
  let failed = 0
  const idleWaiters: Array<() => void> = []

  function settleIdle(): void {
    if (running || queue.length > 0) return
    while (idleWaiters.length > 0) {
      const fn = idleWaiters.shift()
      if (fn) { try { fn() } catch { /* 等待者自己抛错不影响通道 */ } }
    }
  }

  function pump(): void {
    if (running) return
    const next = queue.shift()
    if (!next) { settleIdle(); return }
    running = true
    // 用 Promise.resolve().then 包一层：任务同步抛错也走同一条失败路径，
    // 不会把 pump 打断（否则队列会永久卡住）
    Promise.resolve()
      .then(() => next.task())
      .then(
        (v) => { done++; next.resolve(v) },
        (e) => { failed++; next.reject(e) },
      )
      .then(() => {
        running = false
        pump()
      })
  }

  return {
    name,
    run<T>(task: () => T | Promise<T>, opts?: ChannelTaskOptions): Promise<T> {
      const priority = Number(opts && opts.priority)
      const key = String((opts && opts.key) || '')
      const p = Number.isFinite(priority) ? priority : DEFAULT_PRIORITY
      return new Promise<T>((resolve, reject) => {
        if (key) {
          // conflate：同 key 还在排队 → 丢掉旧的（它从没开始跑，调用方拿到 rejected 才能收口，
          // 否则那个 await 永远悬着）
          for (let i = 0; i < queue.length; i++) {
            if (queue[i].key !== key) continue
            const [old] = queue.splice(i, 1)
            dropped++
            try { old.reject(new Error('channel dropped: ' + key)) } catch { /* 调用方可能没接 */ }
            break
          }
        }
        // 插入位置：优先级小的先跑；同优先级排在已有同优先级任务之后（先来先跑）
        let at = queue.length
        for (let i = 0; i < queue.length; i++) {
          if (queue[i].priority > p) { at = i; break }
        }
        queue.splice(at, 0, { task, priority: p, seq: ++seq, key, resolve: resolve as (v: any) => void, reject })
        pump()
      })
    },
    stats(): ChannelStats {
      return Object.freeze({ name, running, queued: queue.length, done, dropped, failed })
    },
    idle(): Promise<void> {
      if (!running && queue.length === 0) return Promise.resolve()
      return new Promise<void>((resolve) => { idleWaiters.push(resolve) })
    },
  }
}
