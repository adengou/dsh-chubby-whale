/**
 * client/team-watch.ts —— 看板编排层（不碰 DOM、不碰 bubble/scheduler）
 *
 * 依赖方向：
 *   TeamSource（公开投影） → summarizeTeamBoard → presentTeamSummary
 *   → TeamSurface.apply（端口；由 client.ts 注入独立挂件/调度器）
 *
 * 这里只做三件事：订阅、算摘要、把展示意图交给 surface。
 * 普通摘要的冷却由 presentTeamSummary 依据「上一次真正展示过的摘要」判断。
 */

import type { TeamBoardSummary, TeamSource, TeamSurface } from '../shared/team-contract.js'
import { presentTeamSummary, summarizeTeamBoard } from '../shared/team-board.js'

export interface TeamWatchOptions {
  source: TeamSource
  surface: TeamSurface
  /** 菜单开关；false 时隐藏看板并清空展示状态 */
  enabled?: () => boolean
  /** 静默模式：普通摘要仍显示，但不额外制造提醒 */
  quiet?: () => boolean
  /** 普通摘要最小间隔（默认 60s） */
  cooldownMs?: number
  now?: () => number
}

export interface TeamWatch {
  start: () => void
  stop: () => void
}

export function createTeamWatch(options: TeamWatchOptions): TeamWatch {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const enabled = typeof options.enabled === 'function' ? options.enabled : () => true
  const quiet = typeof options.quiet === 'function' ? options.quiet : () => false

  let unsubscribe: (() => void) | null = null
  let lastPresented: TeamBoardSummary | null = null
  let running = false

  function onSnapshot(snapshot: Parameters<typeof summarizeTeamBoard>[0]): void {
    try {
      if (!enabled()) {
        lastPresented = null
        options.surface.apply(null)
        return
      }

      const summary = summarizeTeamBoard(snapshot, lastPresented, now())
      if (summary.phase === 'empty' || summary.phase === 'unavailable') {
        lastPresented = summary
        options.surface.apply(null)
        return
      }
      const presentation = presentTeamSummary(summary, lastPresented, now(), {
        enabled: true,
        quiet: quiet(),
        ...(options.cooldownMs === undefined ? {} : { cooldownMs: options.cooldownMs }),
      })

      if (presentation !== null) {
        options.surface.apply(presentation)
        lastPresented = summary
      }
    } catch (e) {
      // 看板失败不能把投影订阅/宿主页面拖崩
    }
  }

  function start(): void {
    if (running) return
    running = true
    try {
      unsubscribe = options.source.subscribe(onSnapshot)
    } catch (e) {
      running = false
      unsubscribe = null
    }
  }

  function stop(): void {
    running = false
    const off = unsubscribe
    unsubscribe = null
    try { if (off) off() } catch (e) { }
    try { options.surface.apply(null) } catch (e) { }
    lastPresented = null
  }

  return { start, stop }
}
