/**
 * client/team-watch.ts —— 看板编排层（不碰 DOM、不碰 bubble/scheduler）
 *
 * 依赖方向：
 *   TeamSource（公开投影） → summarizeTeamBoard → presentTeamSummary
 *   → TeamSurface.apply（端口；由 client.ts 注入独立挂件/调度器）
 *   · 同时用 shared/whale-works.ts 的 inspectWhaleWorks 计算施工看板 chipText（只读纯函数）。
 *
 * 这里只做三件事：订阅、算摘要、把展示意图交给 surface。
 * 普通摘要的冷却由 presentTeamSummary 依据「上一次真正展示过的摘要」判断。
 */

import type { TeamBoardSnapshot, TeamBoardSummary, TeamSource, TeamSurface } from '../shared/team-contract.js'
import { presentTeamSummary, summarizeTeamBoard } from '../shared/team-board.js'
import type { WhaleWorksReport } from '../shared/whale-works.js'
import { inspectWhaleWorks } from '../shared/whale-works.js'

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

  /**
   * 收到快照后做一次「鲸群营造」施工检查（纯函数，不读 clock/DOM）。
   *
   * 只有任务板真的按施工层级组织时才用 chipText 顶替旧计数文案：
   * 有分支（[A]/[A1]…）、有验收任务（[V]）或有施工警告。
   * 普通 AgentTeam 任务板（无前缀、无验收、无警告）继续用原摘要文案，
   * 不把「暂无分支」硬塞给所有看板 —— 空任务/无报告保持原有展示。
   */
  function readWhaleWorksChip(snapshot: TeamBoardSnapshot): string | null {
    try {
      const report: WhaleWorksReport = inspectWhaleWorks(snapshot.tasks)
      if (report.totalTasks <= 0) return null
      if (report.branches.length === 0 && !report.acceptance.hasTask && report.warnings.length === 0) {
        return null
      }
      return report.chipText
    } catch (e) {
      // 检查器失败只回落旧文案，不把看板拖崩
      return null
    }
  }

  function onSnapshot(snapshot: TeamBoardSnapshot): void {
    try {
      if (!enabled()) {
        lastPresented = null
        options.surface.apply(null)
        return
      }

      const summary = summarizeTeamBoard(snapshot, lastPresented, now())
      // 施工报告：每次快照都过一遍只读纯函数检查器，不写任务板、不打网络。
      const chipText = readWhaleWorksChip(snapshot)
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

      // 任务板完成：收工庆祝仍走提醒，但脚下常驻看板不再保留「已完成」。
      if (summary.phase === 'done') {
        const doneAlert = presentation && presentation.alert ? { ambient: null, alert: presentation.alert } : null
        options.surface.apply(doneAlert)
        lastPresented = summary
        return
      }

      if (presentation !== null) {
        // 有施工报告时用 chipText 替换旧的计数文案；tone / alert / 冷却判定全部沿用原逻辑。
        if (chipText !== null && presentation.ambient !== null) {
          options.surface.apply({
            ambient: { text: chipText, tone: presentation.ambient.tone },
            ...(presentation.alert === undefined ? {} : { alert: presentation.alert }),
          })
        } else {
          options.surface.apply(presentation)
        }
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
