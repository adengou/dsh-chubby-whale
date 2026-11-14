/**
 * shared/team-contract.ts —— 鲸鱼看板与 AgentTeam 的唯一公开契约。
 *
 * 只放类型，不放实现：
 *   · shared/team-board.ts   纯函数实现摘要/展示
 *   · client/team-source.ts  投影/审批适配器
 *   · client/team-surface.ts 独立挂件 + 调度器线路
 *
 * 约束：本文件不 import 任何 DSH 内部模块、不碰 DOM、不读日志。
 */

export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

/** 与 @deepseek-ai/dsh-agent-team 的 TeamTaskView 公开字段对齐；只读快照。 */
export interface TeamTaskView {
  id: string
  revision: number
  subject: string
  description: string
  status: TeamTaskStatus
  blockedBy: readonly string[]
  writeScopes: readonly string[]
  ownerId?: string
  ownerName?: string
  ready: boolean
  writeScopeWarnings: readonly string[]
}

/** 审批提示的最小公开信号；reason 不进入气泡。 */
export interface TeamApprovalView {
  id: string
  toolName?: string
  at: number
  sessionId: string
}

/** 一次投影快照 + 可选审批快照，适配器只负责搬运。 */
export interface TeamBoardSnapshot {
  available: boolean
  enabled: boolean
  failure?: string
  tasks: readonly TeamTaskView[]
  approvals?: readonly TeamApprovalView[]
  capturedAt: number
}

export type TeamPhase =
  | 'unavailable'
  | 'empty'
  | 'approval'
  | 'done'
  | 'working'
  | 'waiting'
  | 'blocked'
  | 'error'

export interface TeamBoardCounts {
  total: number
  inProgress: number
  readyPending: number
  blockedPending: number
  completed: number
  approvals: number
}

export interface TeamBoardSummary {
  phase: TeamPhase
  counts: TeamBoardCounts
  activeTask?: {
    id: string
    subject: string
    ownerName?: string
  }
  stuckTaskIds: readonly string[]
  approvalIds: readonly string[]
  fingerprint: string
  capturedAt: number
}

export type TeamTone = 'normal' | 'warn' | 'muted'
export type TeamAnim = 'settle' | 'perk' | 'nudge'

export interface TeamAmbientView {
  text: string
  tone: TeamTone
}

export interface TeamAlertView {
  /** 同 key 的提醒在 surface 内替换，不排队重复 */
  key: string
  text: string
  ttl: number
  /** 数字越大越优先；实际线路优先级由 surface 统一决定 */
  rank: number
  anim?: TeamAnim
}

/** 一次展示意图：常驻挂件 + 可选一次性提醒；surface 只认这个形状。 */
export interface TeamPresentation {
  ambient: TeamAmbientView | null
  alert?: TeamAlertView
}

/** 只读数据源；订阅回调可能在任意时刻触发，调用方自行节流。 */
export interface TeamSource {
  subscribe(callback: (snapshot: TeamBoardSnapshot) => void): () => void
}

/** 展示端口；实现方决定独立挂件与调度器线路，业务层不认识 bubble/scheduler。 */
export interface TeamSurface {
  apply(presentation: TeamPresentation | null): void
  /** 鱼移动时刷新常驻挂件位置（可选；没有独立挂件的实现可省略） */
  reposition?: () => void
  dispose(): void
}

export interface TeamPresenterOptions {
  enabled: boolean
  quiet?: boolean
  /** 最小普通摘要间隔；默认 60s */
  cooldownMs?: number
  /** 审批提醒冷却；默认 60s */
  approvalCooldownMs?: number
}
