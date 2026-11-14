/**
 * client/team-source.ts —— 「鲸鱼看板」的数据源适配器（只读）。
 *
 * 职责：
 *   1. 会话级探针（probe）：注册一个渲染 null 的会话槽位组件，从 slot props 的
 *      公开标准 hook 读 `useProjection('agentTeam')` 与 `useSessionStatus(...)`；
 *   2. 模块级 store：保存最后一次快照，监听集合负责通知；
 *   3. TeamSource：对外只暴露 subscribe（契约见 shared/team-contract.ts）。
 *
 * 公开依据（本机 app.asar 0.2.2-rc.3 解包目录，非内部实现）：
 *   · @deepseek-ai/dsh-client-ui-agent-team/src/client/TeamBoard.tsx:82
 *       官方 TeamBoard 的 props 就是 { sessionId, useProjection, useSessions }，
 *       并且第 83 行直接 `const team = useProjection('agentTeam')`。
 *   · @deepseek-ai/dsh-agent-team/src/types.ts:98-109
 *       `TeamProjection = { enabled, tasks: TeamTaskView[], failure? }`，
 *       并通过 declare module 把 'agentTeam' 挂进 SessionProjectionMap。
 *   · @deepseek-ai/dsh-client-ui-session/src/client/index.ts:266-279
 *       会话级槽位的内建标准源是 hooks:['session']、keyedHooks:['projection']、
 *       props:['sessionId']；所以任何 session 作用域槽位都能拿到
 *       sessionId / useProjection / useSession。
 *   · 同文件 157-175 行把 useSessions / useSessionStatus 加进 GlobalStandardProps，
 *       把 sessionId / useProjection 加进 SessionStandardProps，
 *       slot runtime 对每个 entry 合并 root 与 session 两级标准源。
 *   · @deepseek-ai/dsh-client-ui-conversation/src/client/contract/slots.ts:310
 *       `'conversation.input.overlay': { kind: 'list'; scope: 'session' }`
 *   · .../skeleton/InputBar.tsx:467-469
 *       只要 sessionId !== undefined 就渲染该槽位（composer 卡片内的 overlay 锚点）。
 *   · .../skeleton/ConversationContent.tsx:174-178
 *       composer 链是 overlay:true，链上有接管者（例如审批面板）时 fallback 仍然
 *       挂载，只是 display:none —— 因此审批出现期间探针不会被卸载。
 *   · @deepseek-ai/dsh-client-ui-approval/src/client/contract/slots.ts:84-114
 *       PendingApproval 是公开类：kind='approval'、key、toolName、sessionId 都可读；
 *       它通过 uiSession.registerPendingInteraction 挂进 SessionStatus.pendingInteraction，
 *       由 useSessionStatus（全局标准 hook）读出。
 *
 * 边界（硬约束）：
 *   · 不 import 任何 DSH 包（只用 shared/team-contract.ts 的类型），不读日志、不碰 DOM；
 *   · 不调用任何任务写方法（createTask / updateTask / setEnabled / remote.agentTeams …），
 *     本文件根本没有这些符号；
 *   · 不制造定时轮询：只在 React effect 里发布，靠 projection / status 的订阅驱动；
 *   · 探针只读，绝不修改传入的 props / projection 对象。
 */

import type {
  TeamApprovalView,
  TeamBoardSnapshot,
  TeamSource,
  TeamTaskStatus,
  TeamTaskView,
} from '../shared/team-contract.js'

/** 官方 AgentTeam 投影键（dsh-agent-team 的 SessionProjectionMap 声明）。 */
export const TEAM_PROJECTION_KEY = 'agentTeam'

/**
 * 探针槽位：composer 卡片内的浮层列表（list / session）。
 * 选择它而不是根作用域 shell.overlay，是因为根作用域拿不到会话级标准 hook。
 */
export const TEAM_PROBE_SLOT = 'conversation.session.header.actions'

/**
 * 备选槽位：composer 卡片上方的整行列表（list / session）。
 * 该槽位需要 InputZone（session + input 都存在）才渲染，可用性略弱于 overlay，
 * 仅当宿主版本没有 overlay 声明时由调用方显式指定。
 */
export const TEAM_PROBE_FALLBACK_SLOT = 'conversation.input.overlay'

/** list 槽位按 id 分格，注册 id 必须稳定且唯一。 */
export const TEAM_PROBE_ID = 'chubby-whale-team-probe'

/** 子 Agent 目录最多向下追几层（团队树一般只有一层；上限只防异常数据）。 */
const MAX_SESSION_DEPTH = 8

const TASK_STATUSES: readonly TeamTaskStatus[] = ['pending', 'in_progress', 'completed', 'deleted']

/** 官方投影里一个 task 的可见字段（运行时按 unknown 读，逐字段收紧）。 */
interface TeamProjectionLike {
  readonly enabled?: unknown
  readonly tasks?: unknown
  readonly failure?: unknown
}

/** PendingApproval 的最小结构（公开字段；不 import 它的类）。 */
interface PendingInteractionLike {
  readonly kind?: unknown
  readonly key?: unknown
  readonly sessionId?: unknown
  readonly toolName?: unknown
}

/** useSessionStatus 快照的最小结构：Map<SessionId, { pendingInteraction? }>。 */
interface SessionStatusMapLike {
  get(sessionId: string): { readonly pendingInteraction?: unknown } | undefined
}

/** useSessions 快照里本模块关心的部分：按会话保存的投影值 + 行归属计数。 */
interface SessionListLike {
  readonly byId?: unknown
  readonly projectionsBySession?: unknown
}

/** 调用方/探针交给 store 的审批最小输入；at 省略时用首次观测时间。 */
export interface TeamProbeApprovalInput {
  readonly id: string
  readonly toolName?: string
  readonly sessionId: string
  /** 审批真实发生时间；拿不到时省略，store 用首次观测时间并在后续快照中保持不变。 */
  readonly at?: number
}

/** 一次发布的输入：官方 agentTeam 投影 + 当前会话 + 待审批列表。 */
export interface TeamProbeSnapshotInput {
  readonly sessionId?: string
  /** `useProjection('agentTeam')` 的返回值；undefined 表示该会话此刻没有这项能力。 */
  readonly projection?: unknown
  /** 待审批列表；省略等价于空数组。 */
  readonly approvals?: readonly TeamProbeApprovalInput[]
}

/** 探针写入 store 的窄接口（测试/宿主也可直接用它注入假快照）。 */
export interface TeamProbeBridge {
  setSnapshot(input: TeamProbeSnapshotInput): TeamBoardSnapshot
  /** 清空快照；传入 sessionId 时只清该会话，避免误清后来者的数据。 */
  clear(sessionId?: string): void
}

type TeamSnapshotListener = (snapshot: TeamBoardSnapshot) => void

/** 模块级 listener 集合：TeamSource 的订阅者都挂在这里。 */
const listeners = new Set<TeamSnapshotListener>()

/** 已挂载探针数（按会话）；多个槽位同时挂载时，最后一个卸载才清快照。 */
const probeMounts = new Map<string, number>()

/** 审批首次被观测到的时间（key = sessionId + NUL + approval id）。 */
const approvalFirstSeen = new Map<string, number>()

/** store 里的最后一份快照及其去重依据。 */
interface StoredSnapshot {
  readonly sessionId: string | undefined
  readonly projection: unknown
  readonly approvalSignature: string
  readonly snapshot: TeamBoardSnapshot
}

let stored: StoredSnapshot | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isTaskStatus(value: unknown): value is TeamTaskStatus {
  return typeof value === 'string' && TASK_STATUSES.indexOf(value as TeamTaskStatus) >= 0
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string') out.push(item)
  }
  return out
}

/**
 * 把官方 TeamTaskView 收敛成契约形状。
 * 缺 id 或缺合法 status 的条目直接丢弃：不去猜一个状态，也不伪造一条任务。
 */
function normalizeTask(value: unknown): TeamTaskView | null {
  if (!isRecord(value)) return null
  const raw = value
  const id = typeof raw.id === 'string'
    ? raw.id
    : typeof raw.id === 'number' && Number.isFinite(raw.id) ? String(raw.id) : ''
  if (id === '') return null
  if (!isTaskStatus(raw.status)) return null
  const revision = typeof raw.revision === 'number' && Number.isFinite(raw.revision) ? raw.revision : 0
  const task: TeamTaskView = {
    id,
    revision,
    subject: typeof raw.subject === 'string' ? raw.subject : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    status: raw.status,
    blockedBy: toStringArray(raw.blockedBy),
    writeScopes: toStringArray(raw.writeScopes),
    ready: raw.ready === true,
    writeScopeWarnings: toStringArray(raw.writeScopeWarnings),
  }
  if (typeof raw.ownerId === 'string') task.ownerId = raw.ownerId
  if (typeof raw.ownerName === 'string') task.ownerName = raw.ownerName
  return task
}

/** 官方投影 + 审批 → 契约快照；只读副本，对象与数组都冻结。 */
function buildSnapshot(
  projection: unknown,
  approvals: readonly TeamApprovalView[],
  now: number,
): TeamBoardSnapshot {
  const raw: TeamProjectionLike | undefined = isRecord(projection)
    ? projection as TeamProjectionLike
    : undefined
  const tasks: TeamTaskView[] = []
  if (raw !== undefined && Array.isArray(raw.tasks)) {
    for (const item of raw.tasks) {
      const task = normalizeTask(item)
      if (task !== null) tasks.push(task)
    }
  }
  const failure = raw !== undefined && typeof raw.failure === 'string' ? raw.failure : undefined
  const snapshot = {
    available: raw !== undefined,
    enabled: raw !== undefined && raw.enabled === true,
    ...(failure === undefined ? {} : { failure }),
    tasks: Object.freeze(tasks),
    approvals: Object.freeze(approvals.slice()),
    capturedAt: now,
  }
  return Object.freeze(snapshot) as TeamBoardSnapshot
}

/** 审批去重/排序用的稳定签名（顺序不影响判定）。 */
function approvalSignatureOf(approvals: readonly TeamApprovalView[]): string {
  return approvals
    .map(approval => [
      approval.sessionId,
      approval.id,
      approval.toolName === undefined ? '' : approval.toolName,
      String(approval.at),
    ].join('\u0000'))
    .join('\u0001')
}

function approvalFirstSeenKey(approval: { sessionId: string; id: string }): string {
  return approval.sessionId + '\u0000' + approval.id
}

/** 把输入审批补齐为契约视图；首次观测时间在同一审批存续期间保持不变。 */
function stampApprovals(
  inputs: readonly TeamProbeApprovalInput[],
  now: number,
): TeamApprovalView[] {
  const stamped: TeamApprovalView[] = []
  const seen = new Set<string>()
  const touchedSessions = new Set<string>()
  for (const input of inputs) {
    if (input === null || typeof input !== 'object') continue
    if (typeof input.id !== 'string' || input.id === '') continue
    if (typeof input.sessionId !== 'string' || input.sessionId === '') continue
    touchedSessions.add(input.sessionId)
    const key = approvalFirstSeenKey(input)
    if (seen.has(key)) continue
    seen.add(key)
    let at = typeof input.at === 'number' && Number.isFinite(input.at)
      ? input.at
      : approvalFirstSeen.get(key)
    if (at === undefined) at = now
    approvalFirstSeen.set(key, at)
    stamped.push({
      id: input.id,
      ...(typeof input.toolName === 'string' && input.toolName !== ''
        ? { toolName: input.toolName }
        : {}),
      at,
      sessionId: input.sessionId,
    })
  }
  // 只清理「这次发布涉及到的会话」里已经结束的审批；别的会话的首次观测时间
  // 保留着，避免多会话切换时同一审批的 at 漂移。
  for (const key of [...approvalFirstSeen.keys()]) {
    const separator = key.indexOf('\u0000')
    const sessionId = separator < 0 ? '' : key.slice(0, separator)
    if (touchedSessions.has(sessionId) && !seen.has(key)) approvalFirstSeen.delete(key)
  }
  stamped.sort((left, right) => {
    if (left.sessionId !== right.sessionId) return left.sessionId < right.sessionId ? -1 : 1
    if (left.id === right.id) return 0
    return left.id < right.id ? -1 : 1
  })
  return stamped
}

function notifyListeners(snapshot: TeamBoardSnapshot): void {
  for (const listener of [...listeners]) {
    try {
      listener(snapshot)
    } catch (error) {
      // 一个订阅者抛错不能中断其它订阅者，也不能把 store 带崩。
      try {
        console.error('[chubby-whale] team-source 订阅回调失败：', error)
      } catch (ignored) { /* console 不可用就算了 */ }
    }
  }
}

/**
 * 发布一份快照（store 内部入口，也是 probe 的写入路径）。
 * 去重：同一会话、同一 projection 引用、同一审批签名时直接返回旧快照，不通知。
 */
function publishSnapshot(input: TeamProbeSnapshotInput): TeamBoardSnapshot {
  const now = Date.now()
  const sessionId = typeof input.sessionId === 'string' && input.sessionId !== ''
    ? input.sessionId
    : undefined
  const approvals = stampApprovals(Array.isArray(input.approvals) ? input.approvals : [], now)
  const signature = approvalSignatureOf(approvals)
  if (stored !== null
    && stored.sessionId === sessionId
    && stored.projection === input.projection
    && stored.approvalSignature === signature) {
    return stored.snapshot
  }
  const snapshot = buildSnapshot(input.projection, approvals, now)
  stored = { sessionId, projection: input.projection, approvalSignature: signature, snapshot }
  notifyListeners(snapshot)
  return snapshot
}

/** 清快照；带 sessionId 时只清该会话。清空不触发监听（没有新快照可发）。 */
function clearSnapshot(sessionId?: string): void {
  if (stored === null) return
  if (sessionId !== undefined && stored.sessionId !== sessionId) return
  const cleared = stored.sessionId
  stored = null
  if (cleared === undefined) {
    approvalFirstSeen.clear()
    return
  }
  const prefix = cleared + '\u0000'
  for (const key of [...approvalFirstSeen.keys()]) {
    if (key.startsWith(prefix)) approvalFirstSeen.delete(key)
  }
}

function retainProbe(sessionId: string): void {
  probeMounts.set(sessionId, (probeMounts.get(sessionId) ?? 0) + 1)
}

function releaseProbe(sessionId: string): void {
  const count = probeMounts.get(sessionId) ?? 0
  if (count <= 1) {
    probeMounts.delete(sessionId)
    clearSnapshot(sessionId)
    return
  }
  probeMounts.set(sessionId, count - 1)
}

/** 对外桥接对象：测试/宿主可直接写假快照，或清空以复用模块实例。 */
export const teamProbeBridge: TeamProbeBridge = Object.freeze({
  setSnapshot(input: TeamProbeSnapshotInput): TeamBoardSnapshot {
    return publishSnapshot(input)
  },
  clear(sessionId?: string): void {
    clearSnapshot(sessionId)
  },
})

/**
 * 最近一份快照（诊断/测试用）；没有快照时返回 null。
 * 返回的是 store 里同一份冻结对象，调用方不要修改。
 */
export function latestTeamProbeSnapshot(): TeamBoardSnapshot | null {
  return stored === null ? null : stored.snapshot
}

/** 当前快照属于哪个会话（诊断用）；没有快照时返回 null。 */
export function latestTeamProbeSessionId(): string | null {
  return stored === null ? null : (stored.sessionId ?? null)
}

/* ------------------------------------------------------------------ */
/* 探针读取：只依赖 slot runtime 提供的公开标准 hook                    */
/* ------------------------------------------------------------------ */

/** 从 useSessions 快照里按 subagentCatalog 向下收集根会话及其后代 id。 */
function collectSessionIds(list: unknown, rootSessionId: string | undefined): string[] {  if (rootSessionId === undefined) return []
  const ids: string[] = [rootSessionId]
  const visited = new Set<string>([rootSessionId])
  if (!isRecord(list)) return ids
  const projections = (list as SessionListLike).projectionsBySession
  if (!isRecord(projections)) return ids
  let frontier: string[] = [rootSessionId]
  for (let depth = 0; depth < MAX_SESSION_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = []
    for (const parentId of frontier) {
      const entry = projections[parentId]
      if (!isRecord(entry)) continue
      const values = entry.values
      if (!isRecord(values)) continue
      const catalog = values.subagentCatalog
      if (!Array.isArray(catalog)) continue
      for (const row of catalog) {
        if (!isRecord(row)) continue
        const childId = typeof row.id === 'string' ? row.id : ''
        if (childId === '' || visited.has(childId)) continue
        visited.add(childId)
        ids.push(childId)
        next.push(childId)
      }
    }
    frontier = next
  }
  return ids
}

/**
 * 判断这份 slot props 所在的会话是不是「主会话视图」持有的会话。
 *
 * 为什么需要：conversation.content 这个 factory 还会被右侧子 Agent 聊天面板
 * 以 variant:'embedded' 实例化（dsh-client-ui-subagent/sidebar-chat）。如果两个
 * 会话同时挂载，子会话探针会发布它自己的（通常是空的）agentTeam 快照，把主会话
 * 的快照顶掉。SessionSummary.retainedBy 是公开数据：主视图用 'mainView' 这个
 * 引用来源持有会话，侧栏聊天用 'sidebarChat'。因此只有 mainView > 0 的会话
 * 才允许发布；字段缺失时返回 'unknown'（老宿主没有该信息就保持原行为）。
 *
 * @returns 'yes' | 'no' | 'unknown'
 */
function readMainViewFlag(list: unknown, sessionId: string): 'yes' | 'no' | 'unknown' {
  if (!isRecord(list)) return 'unknown'
  const byId = (list as SessionListLike).byId
  if (!isRecord(byId)) return 'unknown'
  const row = byId[sessionId]
  if (!isRecord(row)) return 'unknown'
  const retainedBy = row.retainedBy
  if (!isRecord(retainedBy)) return 'unknown'
  const count = retainedBy.mainView
  if (typeof count !== 'number' || !Number.isFinite(count)) return 'no'
  return count > 0 ? 'yes' : 'no'
}

/** 从 SessionStatus 快照里挑出这些会话的 pendingInteraction（只读）。 */
function selectPendingInteractions(state: unknown, sessionIds: readonly string[]): PendingInteractionLike[] {
  const found: PendingInteractionLike[] = []
  if (sessionIds.length === 0 || !isRecord(state)) return found
  const statuses = state as unknown as SessionStatusMapLike
  if (typeof statuses.get !== 'function') return found
  for (const sessionId of sessionIds) {
    const status = statuses.get(sessionId)
    if (!isRecord(status)) continue
    const interaction = status.pendingInteraction
    if (isRecord(interaction)) found.push(interaction as PendingInteractionLike)
  }
  return found
}

/** useSessionStatus 的相等判断：只比较公开身份字段，避免新数组触发重渲染。 */
function samePendingInteractions(left: readonly PendingInteractionLike[], right: readonly PendingInteractionLike[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    const a = left[index]
    const b = right[index]
    if (a === b) continue
    if (a.kind !== b.kind || a.key !== b.key || a.sessionId !== b.sessionId || a.toolName !== b.toolName) {
      return false
    }
  }
  return true
}

/** 只保留 kind === 'approval' 的待办，转成 store 的审批输入。 */
function toApprovalInputs(
  interactions: readonly PendingInteractionLike[],
  fallbackSessionId: string,
): TeamProbeApprovalInput[] {
  const out: TeamProbeApprovalInput[] = []
  const seen = new Set<string>()
  for (const interaction of interactions) {
    if (interaction.kind !== 'approval') continue
    const id = typeof interaction.key === 'string' ? interaction.key : ''
    if (id === '') continue
    const sessionId = typeof interaction.sessionId === 'string' && interaction.sessionId !== ''
      ? interaction.sessionId
      : fallbackSessionId
    const key = sessionId + '\u0000' + id
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      id,
      ...(typeof interaction.toolName === 'string' && interaction.toolName !== ''
        ? { toolName: interaction.toolName }
        : {}),
      sessionId,
    })
  }
  out.sort((left, right) => {
    if (left.sessionId !== right.sessionId) return left.sessionId < right.sessionId ? -1 : 1
    if (left.id === right.id) return 0
    return left.id < right.id ? -1 : 1
  })
  return out
}

/**
 * 创建一个会话级探针组件。
 *
 * 返回的组件：
 *   · 不使用 JSX；渲染结果固定为 null；
 *   · 从 props 取 useProjection / useSessionStatus / useSessions / sessionId（slot runtime
 *     的标准 props），在 R.useEffect 里把快照写入模块级 store；
 *   · 如果宿主没给 useProjection（slot 作用域不对/版本不兼容），安静地退化为不发布，
 *     不读 DOM、不猜数据。
 *
 * @param R - React 命名空间（宿主传入；只需要 useEffect）。
 * @returns 可直接交给 slots.register 的组件函数。
 */
export function createTeamProbe(R: any): (props: any) => any {
  const hasEffects = !!R && typeof R.useEffect === 'function'

  return function TeamProbe(props: any): any {
    const source = isRecord(props) ? props : {}
    const sessionId = typeof source.sessionId === 'string' && source.sessionId !== ''
      ? source.sessionId
      : undefined
    const useProjection = source.useProjection
    const useSessionStatus = source.useSessionStatus
    const useSessions = source.useSessions

    // 会话作用域槽位的标准 props 由 slot runtime 固定提供（见文件头依据）；
    // 因此这里的 typeof 在同一挂载期内是常量，hook 顺序稳定。
    const projection = typeof useProjection === 'function' && hasEffects
      ? useProjection(TEAM_PROJECTION_KEY)
      : undefined

    // useSessions 的第一段是主视图归属标记，第二段是根会话及后代 id。
    // 用字符串而不是数组：selector 每次返回原始值时引用稳定，不会造成额外渲染。
    let listSignature = sessionId === undefined ? '' : sessionId
    let mainViewFlag: 'yes' | 'no' | 'unknown' = 'unknown'
    if (typeof useSessions === 'function' && hasEffects) {
      listSignature = useSessions((state: unknown) => sessionId === undefined
        ? ''
        : readMainViewFlag(state, sessionId) + '\u0002' + collectSessionIds(state, sessionId).join('\u0001'))
    }
    let sessionIds: string[] = []
    if (listSignature !== '') {
      const separator = listSignature.indexOf('\u0002')
      const flag = separator < 0 ? '' : listSignature.slice(0, separator)
      if (flag === 'yes' || flag === 'no') mainViewFlag = flag
      const idsPart = separator < 0 ? listSignature : listSignature.slice(separator + 1)
      sessionIds = idsPart === '' ? [] : idsPart.split('\u0001')
    }

    let interactions: readonly PendingInteractionLike[] = []
    if (typeof useSessionStatus === 'function' && hasEffects) {
      interactions = useSessionStatus(
        (state: unknown) => selectPendingInteractions(state, sessionIds),
        samePendingInteractions,
      )
    }
    const approvalInputs = toApprovalInputs(interactions, sessionId ?? '')
    const approvalsSignature = approvalInputs
      .map(approval => approval.sessionId + '\u0000' + approval.id + '\u0000' + (approval.toolName ?? ''))
      .join('\u0001')

    if (hasEffects) {
      // 先登记挂载，再发布；卸载/会话切换时按会话引用计数清理。
      R.useEffect(() => {
        if (sessionId === undefined) return undefined
        retainProbe(sessionId)
        return () => { releaseProbe(sessionId) }
      }, [sessionId])

      R.useEffect(() => {
        if (sessionId === undefined) return
        if (typeof useProjection !== 'function') return
        publishSnapshot({ sessionId, projection, approvals: approvalInputs })
      }, [projection, sessionId, approvalsSignature, mainViewFlag])
    }

    return null
  }
}

/* ------------------------------------------------------------------ */
/* TeamSource                                                          */
/* ------------------------------------------------------------------ */

/** TeamSource 选项：可按会话过滤（多会话同时挂载时用）。 */
export interface TeamSourceOptions {
  /** 只接收该会话的快照；省略则接收最新发布的快照。 */
  readonly sessionId?: string
}

/**
 * 创建只读数据源。
 *
 * subscribe 语义（契约要求）：
 *   · store 里已有（且匹配过滤条件）快照时立即回调一次；
 *   · 没有快照时不回调；
 *   · 返回取消订阅函数，幂等。
 *
 * @param options - 可选的会话过滤。
 * @returns TeamSource 实现。
 */
export function createTeamSource(options: TeamSourceOptions = {}): TeamSource {
  const filter = typeof options.sessionId === 'string' && options.sessionId !== ''
    ? options.sessionId
    : undefined
  return {
    subscribe(callback: (snapshot: TeamBoardSnapshot) => void): () => void {
      if (typeof callback !== 'function') return () => {}
      const listener: TeamSnapshotListener = snapshot => {
        if (filter !== undefined && latestTeamProbeSessionId() !== filter) return
        callback(snapshot)
      }
      listeners.add(listener)
      const current = latestTeamProbeSnapshot()
      if (current !== null && (filter === undefined || latestTeamProbeSessionId() === filter)) {
        try {
          callback(current)
        } catch (error) {
          try {
            console.error('[chubby-whale] team-source 首次回调失败：', error)
          } catch (ignored) { /* console 不可用就算了 */ }
        }
      }
      let active = true
      return () => {
        if (!active) return
        active = false
        listeners.delete(listener)
      }
    },
  }
}

/* ------------------------------------------------------------------ */
/* 注册                                                               */
/* ------------------------------------------------------------------ */

/** 注册探针的选项：默认 overlay 槽位，可显式切到备选 dock 槽位。 */
export interface RegisterTeamProbeOptions {
  /** 覆盖槽位名（默认 TEAM_PROBE_SLOT；备选 TEAM_PROBE_FALLBACK_SLOT）。 */
  readonly slot?: string
}

function registerProbeInSlot(slots: any, slotName: string, probe: (props: any) => any, id = TEAM_PROBE_ID): void {
  const descriptor = { name: slotName, id, order: 0 }
  const register = () => slots.register(descriptor, probe)
  if (typeof slots.inject === 'function') {
    // 与官方插件一致：inject 等到槽位声明出现后再注册，并返回 disposer。
    slots.inject(slotName, register)
    return
  }
  register()
}

/**
 * 把探针注册进会话级槽位。
 *
 * 优先 `ctx.slots.inject(name, ...)`（槽位可能晚于本插件声明；DSH 的 inject 会等声明）；
 * 没有 inject 的旧宿主退回直接 register。overlay 注册同步失败时尝试 dock 备选槽位；
 * 仍然失败只记一条 warn —— 看板没有数据源不该拖垮宠物本体。
 *
 * @param ctx - 客户端 cordis 上下文（只需要 ctx.slots）。
 * @param R - React 命名空间，原样交给 createTeamProbe。
 * @param options - 可选槽位覆盖。
 */
export function registerTeamProbe(ctx: any, R: any, options: RegisterTeamProbeOptions = {}): void {
  const slots: any = isRecord(ctx) ? ctx.slots : undefined
  if (!slots || typeof slots.register !== 'function') {
    try {
      console.warn('[chubby-whale] team-source：ctx.slots 不可用，鲸鱼看板探针未注册')
    } catch (ignored) { /* console 不可用就算了 */ }
    return
  }
  const probe = createTeamProbe(R)
  const slotName = typeof options.slot === 'string' && options.slot !== ''
    ? options.slot
    : TEAM_PROBE_SLOT
  try {
    registerProbeInSlot(slots, slotName, probe)
  } catch (error) {
    try {
      console.warn('[chubby-whale] team-source：探针槽位 ' + slotName + ' 注册失败，尝试备选槽位', error)
    } catch (ignored) { /* console 不可用就算了 */ }
  }
  if (slotName !== TEAM_PROBE_FALLBACK_SLOT) {
    try { registerProbeInSlot(slots, TEAM_PROBE_FALLBACK_SLOT, probe, TEAM_PROBE_ID + '-fallback') } catch (error) {
      try {
        console.warn('[chubby-whale] team-source：备选槽位注册失败，鲸鱼看板可能没有数据源', error)
      } catch (ignored) { /* console 不可用就算了 */ }
    }
  }
}
