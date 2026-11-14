/**
 * client/team-surface.ts —— 鲸鱼看板的展示面（TeamSurface 实现）
 *
 * 把 TeamPresentation 分成两条互不干扰的出口：
 *   1. 常驻看板：deps.status（独立 DOM，不排队、不自动收起、不朗读）；
 *   2. 一次性提醒：bubbleScheduler 的 `team` 线路（带箭头的气泡，按队列优先级跑）。
 *
 * 这里不认识 bubble.ts，也不直接 import DOM：提醒气泡只通过注入的 deps.alert 端口
 * 显示/隐藏，测试与宿主可以换成任何实现。
 *
 * 去重策略：
 *   · 同一 alert.key 在 ALERT_DEDUPE_MS 内只入队一次（surface 自己记时间）；
 *   · 同时把 key 作为调度器的合并键传下去：即使窗口过了，同一 key 的新提醒
 *     也只会替换当前提醒，不会在队里叠两条。
 */

import type {
  TeamAlertView,
  TeamAmbientView,
  TeamPresentation,
  TeamSurface,
} from '../shared/team-contract.js'
import type { TeamRect, TeamStatusBubble } from './team-status-bubble.js'

/** 同一个 alert.key 的静默窗口（ms）：窗口内的重复投影视为同一条提醒 */
export const ALERT_DEDUPE_MS = 10_000

/** 调度器端口：只要求 enqueue，真实实现是 createBubbleScheduler */
export interface TeamSurfaceSchedulerPort {
  enqueue(entry: any): void
}

/** 一次性提醒端口：注入气泡实现，surface 不直接碰 DOM */
export interface TeamSurfaceAlertPort {
  show(text: string, ms?: number): void
  hide(): void
}

export interface TeamSurfaceDeps {
  scheduler: TeamSurfaceSchedulerPort
  alert: TeamSurfaceAlertPort
  status: TeamStatusBubble
  /** 取鱼所在 stage 的矩形；ambient 更新时用它重新定位看板 */
  position?: () => TeamRect | null
  /** 诊断日志；只在端口抛错 / 去重时调用 */
  logger?: (msg: string) => void
}

/** 取合法毫秒；非法值退化为 0（交给调度器立即收尾） */
function toMs(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return n
}

export function createTeamSurface(deps: TeamSurfaceDeps): TeamSurface {
  let disposed = false
  let dimTimer: any = null
  let alertActive = false
  let lastAlertKey = ''
  let lastAlertAt = 0

  function log(msg: string): void {
    try { if (deps.logger) deps.logger(msg) } catch (e) { }
  }

  /** 端口调用统一兜底：看板/提醒出问题不能把整个投影循环带崩 */
  function safe(fn: () => void, what: string): void {
    try { fn() } catch (e) {
      log('team-surface: ' + what + ' 失败：' + String((e && (e as any).message) || e))
    }
  }

  function clearDimTimer(): void {
    if (dimTimer === null) return
    try { clearTimeout(dimTimer) } catch (e) { }
    dimTimer = null
  }

  /** 提醒期间压暗常驻看板（status 没实现 setDim 就跳过） */
  function setDim(dim: boolean): void {
    safe(() => {
      const status: any = deps.status
      if (status && typeof status.setDim === 'function') status.setDim(dim)
    }, 'setDim')
  }

  /** 提醒开始：压暗看板，并在 ttl 后恢复（即使调度器没回调 stop 也不会永远暗着） */
  function armDimTimer(ms: number): void {
    clearDimTimer()
    try {
      dimTimer = setTimeout(() => {
        dimTimer = null
        if (!disposed) setDim(false)
      }, ms)
      // Node 测试里别让一个提醒定时器把进程拖住（浏览器返回 number，没有 unref）
      if (dimTimer && typeof dimTimer.unref === 'function') dimTimer.unref()
    } catch (e) {
      log('team-surface: armDimTimer 失败：' + String((e && (e as any).message) || e))
    }
  }

  function refreshPosition(): void {
    if (!deps.position) return
    let rect: TeamRect | null = null
    try { rect = deps.position() } catch (e) {
      log('team-surface: position() 失败：' + String((e && (e as any).message) || e))
      return
    }
    if (!rect) return
    safe(() => deps.status.updatePosition(rect as TeamRect), 'updatePosition')
  }

  function showAmbient(ambient: TeamAmbientView | null): void {
    if (!ambient) {
      safe(() => deps.status.hide(), 'status.hide')
      return
    }
    safe(() => deps.status.show(ambient.text, ambient.tone), 'status.show')
    refreshPosition()
  }

  function startAlert(text: string, ms: number): void {
    if (disposed) return
    alertActive = true
    setDim(true)
    armDimTimer(ms)
    safe(() => deps.alert.show(text, ms), 'alert.show')
  }

  function stopAlert(): void {
    alertActive = false
    clearDimTimer()
    setDim(false)
    safe(() => deps.alert.hide(), 'alert.hide')
  }

  function enqueueAlert(alert: TeamAlertView): void {
    if (!alert) return
    const text = alert.text == null ? '' : String(alert.text)
    if (!text) return
    const key = String(alert.key || '') || ('text:' + text)
    const now = Date.now()
    if (key === lastAlertKey && now - lastAlertAt < ALERT_DEDUPE_MS) {
      log('team-surface: 同一提醒 key 去重：' + key)
      return
    }
    lastAlertKey = key
    lastAlertAt = now

    const ms = toMs(alert.ttl)
    const rank = typeof alert.rank === 'number' && Number.isFinite(alert.rank) ? alert.rank : 0
    // key 是现有调度器的「同线同 key 合并」语义；replaceKey 是留给未来实现的
    // 明确意图（同一提醒只保留最新一条）。调度器不认识 replaceKey 时会忽略它。
    const entry: any = {
      lane: 'team',
      rank,
      text,
      ms,
      key,
      replaceKey: key,
      start: () => startAlert(text, ms),
      stop: () => stopAlert(),
    }
    safe(() => deps.scheduler.enqueue(entry), 'scheduler.enqueue')
  }

  function apply(presentation: TeamPresentation | null): void {
    if (disposed) return
    if (!presentation) {
      safe(() => deps.status.hide(), 'status.hide')
      return
    }
    showAmbient(presentation.ambient || null)
    if (presentation.alert) enqueueAlert(presentation.alert)
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    clearDimTimer()
    if (alertActive) {
      alertActive = false
      safe(() => deps.alert.hide(), 'alert.hide')
    }
    safe(() => deps.status.destroy(), 'status.destroy')
    lastAlertKey = ''
    lastAlertAt = 0
  }

  return { apply, reposition: refreshPosition, dispose }
}
