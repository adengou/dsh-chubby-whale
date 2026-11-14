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

import type { TeamBoardSnapshot, TeamBoardSummary, TeamSource, TeamSurface } from '../shared/team-contract.js'
import { presentTeamSummary, summarizeTeamBoard } from '../shared/team-board.js'
import { inspectCabinetBoard } from '../shared/cabinet-board.js'

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

  /** 推演任务板只读检查：只在任务标题带 [FIN]/[RISK]/[CUST]/[OPP]/[MEMO] 时接管脚下文案 */
  function readCabinetChip(snapshot: TeamBoardSnapshot): string | null {
    try {
      const report = inspectCabinetBoard(snapshot.tasks)
      if (!report.present) return null
      // 推演子集已完成时不要长期挂着「推演完成」；任务板若还有别的活，
      // 让普通摘要继续显示总任务数；全部完成时由 summary.phase==='done' 统一收工。
      if (report.phase === 'done') return null
      return report.chipText
    } catch (e) { return null }
  }

  function onSnapshot(snapshot: TeamBoardSnapshot): void {
    try {
      if (!enabled()) {
        lastPresented = null
        options.surface.apply(null)
        return
      }

      const summary = summarizeTeamBoard(snapshot, lastPresented, now())
      const cabinetChip = readCabinetChip(snapshot)
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
        if (cabinetChip !== null && presentation.ambient !== null) {
          options.surface.apply({
            ambient: { text: cabinetChip, tone: presentation.ambient.tone },
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
