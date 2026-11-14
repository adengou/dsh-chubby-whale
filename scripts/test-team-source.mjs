/**
 * scripts/test-team-source.mjs —— 「鲸鱼看板」数据源适配器单测
 *
 * 跑法：node scripts/test-team-source.mjs（失败 exit 1）
 *
 * 覆盖：
 *   · createTeamProbe：假 React + 假 slot props，验证 projection 发布、渲染 null、
 *     projection 引用不变时不重复通知、capability 缺失时退化；
 *   · 审批：从 useSessionStatus 的公开 pendingInteraction 读 kind='approval'，
 *     含子 Agent 会话（useSessions 的 subagentCatalog）；at 首次观测时间稳定；
 *   · TeamSource：立即回调、无快照不回调、取消订阅、按会话过滤、clear 语义；
 *   · 探针卸载/会话切换/多探针引用计数；
 *   · registerTeamProbe：inject 优先、register 兜底、备选槽位；
 *   · 静态守卫：源码不含任务写方法 / 定时器 / DOM / 全局对象 / 额外 import。
 *
 * 说明：不联网、不写盘、不读 dist；用 scripts/ts-resolve.mjs 直接加载 src/**\/*.ts。
 */

import { register } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

register(new URL('./ts-resolve.mjs', import.meta.url))

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log('  ✔ ' + name)
  } else {
    fail++
    console.log('  ✘ ' + name + (detail ? '  ' + detail : ''))
  }
}

/* ------------------------------------------------------------------ */
/* 假 React：只实现 useEffect，按依赖变化跑 cleanup/effect             */
/* ------------------------------------------------------------------ */

function createFakeReact() {
  let rendering = null
  const mounted = []

  const R = {
    useEffect(fn, deps) {
      if (rendering === null) throw new Error('useEffect 在渲染外被调用')
      rendering.push({ fn, deps: Array.isArray(deps) ? deps.slice() : null })
    },
  }

  function depsChanged(prev, next) {
    if (prev === null || prev === undefined) return true
    if (next === null || next === undefined) return true
    if (prev.length !== next.length) return true
    for (let i = 0; i < prev.length; i += 1) {
      if (!Object.is(prev[i], next[i])) return true
    }
    return false
  }

  function render(component, props) {
    rendering = []
    const output = component(props)
    const pending = rendering
    rendering = null
    const nextMounted = []
    for (let i = 0; i < pending.length; i += 1) {
      const prev = mounted[i]
      const dirty = !prev || depsChanged(prev.deps, pending[i].deps)
      if (!dirty) {
        nextMounted[i] = prev
        continue
      }
      if (prev && typeof prev.cleanup === 'function') prev.cleanup()
      const cleanup = pending[i].fn()
      nextMounted[i] = { deps: pending[i].deps, cleanup: typeof cleanup === 'function' ? cleanup : null }
    }
    for (let i = pending.length; i < mounted.length; i += 1) {
      if (mounted[i] && typeof mounted[i].cleanup === 'function') mounted[i].cleanup()
    }
    mounted.length = 0
    mounted.push(...nextMounted)
    return output
  }

  function unmount() {
    for (let i = mounted.length - 1; i >= 0; i -= 1) {
      if (mounted[i] && typeof mounted[i].cleanup === 'function') mounted[i].cleanup()
    }
    mounted.length = 0
  }

  return { R, render, unmount }
}

/* ------------------------------------------------------------------ */
/* 夹具                                                               */
/* ------------------------------------------------------------------ */

function makeTask(overrides = {}) {
  return {
    id: 'task-1',
    revision: 1,
    subject: '写测试',
    description: '给数据源写测试',
    status: 'pending',
    blockedBy: [],
    writeScopes: [],
    ready: false,
    writeScopeWarnings: [],
    ...overrides,
  }
}

function makeProjection(options = {}) {
  const { enabled = true, tasks = [], failure } = options
  return failure === undefined ? { enabled, tasks } : { enabled, tasks, failure }
}

function statusMap(interactionsBySession = {}) {
  const map = new Map()
  for (const [sessionId, interaction] of Object.entries(interactionsBySession)) {
    map.set(sessionId, { running: false, pendingInteraction: interaction, completionUnread: false })
  }
  return map
}

function approvalInteraction(sessionId, id = 'approval:1', toolName = 'bash') {
  return { kind: 'approval', key: id, toolName, sessionId }
}

function listWithCatalog(parentId, children) {
  const projectionsBySession = {}
  projectionsBySession[parentId] = {
    values: {
      subagentCatalog: children.map(id => ({
        id, createdAt: 1, mode: 'continuable', label: id, name: id,
      })),
    },
    state: 'idle',
    error: null,
  }
  return { ids: [parentId], byId: {}, phase: 'ready', projectionsBySession }
}

/**
 * 一个可多次 render 的探针夹具：state 可变，props 只建一次，
 * 这样 useSessionStatus 的相等缓存能跨渲染生效（贴近真实 hook）。
 */
function createProbeHarness(module, options = {}) {
  const state = {
    sessionId: 'sessionId' in options ? options.sessionId : 's-root',
    projection: 'projection' in options ? options.projection : makeProjection(),
    status: options.status ?? statusMap(),
    list: options.list ?? { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} },
    noProjection: options.noProjection === true,
    noStatus: options.noStatus === true,
    noSessions: options.noSessions === true,
  }

  const props = {}
  Object.defineProperty(props, 'sessionId', {
    enumerable: true,
    get() { return state.sessionId },
  })
  if (!state.noProjection) {
    props.useProjection = key => key === 'agentTeam' ? state.projection : undefined
  }
  if (!state.noSessions) {
    props.useSessions = selector => selector(state.list)
  }
  if (!state.noStatus) {
    let has = false
    let last
    props.useSessionStatus = (selector, equal) => {
      const next = selector(state.status)
      if (has && typeof equal === 'function' && equal(last, next)) return last
      has = true
      last = next
      return next
    }
  }

  const fake = createFakeReact()
  const Probe = module.createTeamProbe(fake.R)
  return {
    state,
    props,
    R: fake.R,
    render: () => fake.render(Probe, props),
    unmount: () => fake.unmount(),
  }
}

function subscribeCount(source) {
  let count = 0
  const snapshots = []
  const unsubscribe = source.subscribe((snapshot) => {
    count += 1
    snapshots.push(snapshot)
  })
  return { count: () => count, snapshots, unsubscribe }
}

/* ------------------------------------------------------------------ */
/* 加载模块                                                            */
/* ------------------------------------------------------------------ */

const MOD = await import(pathToFileURL(join(ROOT, 'src/client/team-source.ts')).href)
const {
  createTeamProbe,
  createTeamSource,
  registerTeamProbe,
  latestTeamProbeSnapshot,
  latestTeamProbeSessionId,
  teamProbeBridge,
  TEAM_PROBE_SLOT,
  TEAM_PROBE_FALLBACK_SLOT,
  TEAM_PROBE_ID,
  TEAM_PROJECTION_KEY,
} = MOD

try {
  /* ---------------------------------------------------------------- */
  console.log('\n[1] 导出面与常量')
  /* ---------------------------------------------------------------- */
  ok('createTeamProbe 是函数', typeof createTeamProbe === 'function')
  ok('createTeamSource 是函数', typeof createTeamSource === 'function')
  ok('registerTeamProbe 是函数', typeof registerTeamProbe === 'function')
  ok('latestTeamProbeSnapshot 是函数', typeof latestTeamProbeSnapshot === 'function')
  ok('latestTeamProbeSessionId 是函数', typeof latestTeamProbeSessionId === 'function')
  ok('teamProbeBridge 冻结', Object.isFrozen(teamProbeBridge)
    && typeof teamProbeBridge.setSnapshot === 'function'
    && typeof teamProbeBridge.clear === 'function')
  ok('投影键是 agentTeam', TEAM_PROJECTION_KEY === 'agentTeam')
  ok('主槽位是 conversation.session.header.actions', TEAM_PROBE_SLOT === 'conversation.session.header.actions')
  ok('备选槽位是 conversation.input.overlay', TEAM_PROBE_FALLBACK_SLOT === 'conversation.input.overlay')
  ok('探针 id 稳定', TEAM_PROBE_ID === 'chubby-whale-team-probe')

  /* ---------------------------------------------------------------- */
  console.log('\n[2] 探针发布投影快照')
  /* ---------------------------------------------------------------- */
  teamProbeBridge.clear()
  const firstTask = makeTask({ id: 't1', subject: '搬砖', status: 'in_progress', ready: false })
  const harness = createProbeHarness(MOD, {
    projection: makeProjection({ tasks: [firstTask] }),
    status: statusMap({ 's-root': approvalInteraction('s-root') }),
  })
  const output = harness.render()
  ok('探针渲染 null', output === null, String(output))

  const first = latestTeamProbeSnapshot()
  ok('store 已有快照', first !== null)
  ok('available / enabled', first.available === true && first.enabled === true)
  ok('会话身份记录正确', latestTeamProbeSessionId() === 's-root')
  ok('task 字段完整搬运', first.tasks.length === 1
    && first.tasks[0].id === 't1'
    && first.tasks[0].subject === '搬砖'
    && first.tasks[0].description === '给数据源写测试'
    && first.tasks[0].status === 'in_progress'
    && Array.isArray(first.tasks[0].blockedBy)
    && Array.isArray(first.tasks[0].writeScopes)
    && first.tasks[0].ready === false
    && Array.isArray(first.tasks[0].writeScopeWarnings))
  ok('capturedAt 是当前毫秒数', Number.isFinite(first.capturedAt)
    && Math.abs(Date.now() - first.capturedAt) < 60_000)
  ok('快照与数组冻结', Object.isFrozen(first)
    && Object.isFrozen(first.tasks)
    && Object.isFrozen(first.approvals))

  const source = createTeamSource()
  const sub = subscribeCount(source)
  ok('subscribe 立即回调当前快照', sub.count() === 1 && sub.snapshots[0] === first)

  const labelCount = { value: 0 }
  const unsubscribeLabel = source.subscribe(() => { labelCount.value += 1 })
  // subscribe 的首次回调是「当前快照」，这里只统计后续变化通知。
  labelCount.value = 0
  harness.render()
  ok('projection 引用不变时不重复通知', labelCount.value === 0)

  const secondTask = makeTask({ id: 't2', subject: '收工', status: 'completed' })
  harness.state.projection = makeProjection({ tasks: [secondTask] })
  harness.render()
  const second = latestTeamProbeSnapshot()
  ok('projection 引用变化触发通知', labelCount.value === 1)
  ok('新任务进入快照', second.tasks.length === 1 && second.tasks[0].id === 't2')
  ok('capturedAt 不倒退', second.capturedAt >= first.capturedAt)

  unsubscribeLabel()
  harness.state.projection = makeProjection({ tasks: [makeTask({ id: 't3' })] })
  harness.render()
  ok('取消订阅后不再通知', labelCount.value === 1)
  sub.unsubscribe()
  sub.unsubscribe()
  ok('取消订阅幂等', true)

  /* ---------------------------------------------------------------- */
  console.log('\n[3] 能力缺失 / 禁用 / failure / 非法 task')
  /* ---------------------------------------------------------------- */
  teamProbeBridge.clear()
  const disabled = createProbeHarness(MOD, { projection: makeProjection({ enabled: false }) })
  disabled.render()
  const disabledSnap = latestTeamProbeSnapshot()
  ok('enabled=false 仍可用', disabledSnap.available === true && disabledSnap.enabled === false)
  ok('enabled=false 任务为空', disabledSnap.tasks.length === 0)
  disabled.unmount()

  teamProbeBridge.clear()
  const failed = createProbeHarness(MOD, {
    projection: makeProjection({ tasks: [makeTask()], failure: 'team record rejected' }),
  })
  failed.render()
  ok('failure 原样搬运', latestTeamProbeSnapshot().failure === 'team record rejected')
  failed.unmount()

  teamProbeBridge.clear()
  const missing = createProbeHarness(MOD, { projection: undefined })
  missing.render()
  const missingSnap = latestTeamProbeSnapshot()
  ok('无投影时 available=false', missingSnap.available === false && missingSnap.enabled === false)
  ok('无投影时任务为空', missingSnap.tasks.length === 0)
  ok('无投影时 failure 为空', missingSnap.failure === undefined)
  missing.unmount()

  teamProbeBridge.clear()
  const malformed = createProbeHarness(MOD, {
    projection: makeProjection({
      tasks: [
        makeTask({ id: 'ok-1' }),
        { id: 'no-status' },
        { status: 'pending', subject: '缺 id' },
        { id: 'bad-status', status: 'archived' },
        { id: 42, status: 'pending', subject: '数字 id' },
      ],
    }),
  })
  malformed.render()
  const malformedSnap = latestTeamProbeSnapshot()
  ok('非法 task 被丢弃，合法 task 保留', malformedSnap.tasks.length === 2
    && malformedSnap.tasks[0].id === 'ok-1'
    && malformedSnap.tasks[1].id === '42',
  JSON.stringify(malformedSnap.tasks.map(task => task.id)))
  malformed.unmount()

  teamProbeBridge.clear()
  const unsupported = createProbeHarness(MOD, { noProjection: true })
  const unsupportedOutput = unsupported.render()
  ok('拿不到 useProjection 时仍渲染 null', unsupportedOutput === null)
  ok('拿不到 useProjection 时不发布快照', latestTeamProbeSnapshot() === null)
  unsupported.unmount()

  teamProbeBridge.clear()
  const noHookSession = createProbeHarness(MOD, { sessionId: undefined })
  noHookSession.render()
  ok('无 sessionId 时不发布快照', latestTeamProbeSnapshot() === null)
  noHookSession.unmount()

  /* ---------------------------------------------------------------- */
  console.log('\n[4] 审批：当前会话 + 子 Agent 会话')
  /* ---------------------------------------------------------------- */
  teamProbeBridge.clear()
  const approval = approvalInteraction('s-root', 'approval:7', 'pwsh')
  const approvalHarness = createProbeHarness(MOD, {
    projection: makeProjection({ tasks: [makeTask({ id: 'a1' })] }),
    status: statusMap({ 's-root': approval }),
  })
  let approvalNotifies = 0
  const approvalSub = createTeamSource().subscribe(() => { approvalNotifies += 1 })
  approvalHarness.render()
  const approvalSnap = latestTeamProbeSnapshot()
  ok('审批进入快照', Array.isArray(approvalSnap.approvals) && approvalSnap.approvals.length === 1)
  const approvalView = approvalSnap.approvals[0]
  ok('审批字段：id / toolName / sessionId', approvalView.id === 'approval:7'
    && approvalView.toolName === 'pwsh'
    && approvalView.sessionId === 's-root')
  ok('审批 at 是毫秒时间戳', Number.isFinite(approvalView.at)
    && Math.abs(Date.now() - approvalView.at) < 60_000)
  const firstApprovalAt = approvalView.at
  ok('审批出现触发一次通知', approvalNotifies === 1)

  approvalHarness.state.projection = makeProjection({ tasks: [makeTask({ id: 'a2' })] })
  approvalHarness.render()
  ok('projection 变化后审批 at 不变', latestTeamProbeSnapshot().approvals[0].at === firstApprovalAt)
  ok('projection 变化产生新通知', approvalNotifies === 2)

  const sameRenderCount = approvalNotifies
  approvalHarness.render()
  ok('同一审批/同一投影再次渲染不通知', approvalNotifies === sameRenderCount)

  approvalHarness.state.status = statusMap({})
  approvalHarness.render()
  ok('审批消失后快照为空数组', latestTeamProbeSnapshot().approvals.length === 0)
  ok('审批消失也通知', approvalNotifies === sameRenderCount + 1)
  approvalSub()
  approvalHarness.unmount()

  teamProbeBridge.clear()
  const childApproval = approvalInteraction('s-child', 'approval:9', 'read')
  const childHarness = createProbeHarness(MOD, {
    projection: makeProjection({ tasks: [makeTask({ id: 'c1' })] }),
    list: listWithCatalog('s-root', ['s-child']),
    status: statusMap({ 's-child': childApproval }),
  })
  childHarness.render()
  const childSnap = latestTeamProbeSnapshot()
  ok('子 Agent 审批被收集', childSnap.approvals.length === 1
    && childSnap.approvals[0].id === 'approval:9'
    && childSnap.approvals[0].sessionId === 's-child')
  childHarness.unmount()

  teamProbeBridge.clear()
  const questionHarness = createProbeHarness(MOD, {
    projection: makeProjection({ tasks: [makeTask()] }),
    status: statusMap({
      's-root': { kind: 'question', key: 'question:1', sessionId: 's-root' },
    }),
  })
  questionHarness.render()
  ok('非 approval 的 pendingInteraction 被忽略',
    latestTeamProbeSnapshot().approvals.length === 0)
  questionHarness.unmount()

  teamProbeBridge.clear()
  const noStatusHarness = createProbeHarness(MOD, {
    projection: makeProjection({ tasks: [makeTask()] }),
    noStatus: true,
  })
  noStatusHarness.render()
  ok('没有 useSessionStatus 时审批返回空数组',
    Array.isArray(latestTeamProbeSnapshot().approvals)
    && latestTeamProbeSnapshot().approvals.length === 0)
  noStatusHarness.unmount()

  /* ---------------------------------------------------------------- */
  console.log('\n[5] 会话切换 / 卸载 / 多探针引用计数')
  /* ---------------------------------------------------------------- */
  teamProbeBridge.clear()
  const switching = createProbeHarness(MOD, {
    sessionId: 's1',
    projection: makeProjection({ tasks: [makeTask({ id: 's1-task' })] }),
  })
  switching.render()
  ok('会话 s1 已发布', latestTeamProbeSessionId() === 's1')
  switching.state.sessionId = 's2'
  switching.state.projection = makeProjection({ tasks: [makeTask({ id: 's2-task' })] })
  switching.render()
  ok('切换会话后最新快照属于 s2', latestTeamProbeSessionId() === 's2'
    && latestTeamProbeSnapshot().tasks[0].id === 's2-task')
  switching.unmount()
  ok('卸载后快照清空', latestTeamProbeSnapshot() === null
    && latestTeamProbeSessionId() === null)
  const afterUnmount = subscribeCount(createTeamSource())
  ok('卸载后订阅没有立即回调', afterUnmount.count() === 0)

  teamProbeBridge.clear()
  const sharedA = createProbeHarness(MOD, {
    sessionId: 'shared', projection: makeProjection({ tasks: [makeTask({ id: 'shared-1' })] }),
  })
  const sharedB = createProbeHarness(MOD, {
    sessionId: 'shared', projection: makeProjection({ tasks: [makeTask({ id: 'shared-1' })] }),
  })
  sharedA.render()
  sharedB.render()
  ok('两个探针都挂载时快照存在', latestTeamProbeSnapshot() !== null)
  sharedA.unmount()
  ok('卸载一个探针不清空共享快照', latestTeamProbeSnapshot() !== null)
  sharedB.unmount()
  ok('最后一个探针卸载后才清空', latestTeamProbeSnapshot() === null)

  /* ---------------------------------------------------------------- */
  console.log('\n[6] 主视图归属过滤（侧栏子会话不能顶掉主看板）')
  /* ---------------------------------------------------------------- */
  teamProbeBridge.clear()
  const sidebarList = {
    ids: ['s-root'],
    byId: { 's-root': { retainedBy: { sidebarChat: 1 } } },
    phase: 'ready',
    projectionsBySession: {},
  }
  const sidebarHarness = createProbeHarness(MOD, {
    projection: makeProjection({ tasks: [makeTask({ id: 'child-task' })] }),
    list: sidebarList,
  })
  sidebarHarness.render()
  ok('非 mainView 持有也发布快照（桌面端保留标志不稳，只信最新会话）', latestTeamProbeSnapshot() !== null)

  sidebarHarness.state.list = {
    ids: ['s-root'],
    byId: { 's-root': { retainedBy: { mainView: 1 } } },
    phase: 'ready',
    projectionsBySession: {},
  }
  sidebarHarness.render()
  ok('会话被主视图持有后开始发布', latestTeamProbeSnapshot() !== null
    && latestTeamProbeSnapshot().tasks[0].id === 'child-task')

  sidebarHarness.state.list = {
    ids: ['s-root'],
    byId: { 's-root': { retainedBy: {} } },
    phase: 'ready',
    projectionsBySession: {},
  }
  sidebarHarness.render()
  ok('主视图释放不误清快照（交给新会话覆盖）', latestTeamProbeSnapshot() !== null)
  sidebarHarness.unmount()

  teamProbeBridge.clear()
  const unknownRetention = createProbeHarness(MOD, {
    projection: makeProjection({ tasks: [makeTask({ id: 'legacy' })] }),
    list: { ids: ['s-root'], byId: {}, phase: 'ready', projectionsBySession: {} },
  })
  unknownRetention.render()
  ok('归属信息缺失时保持兼容（照常发布）', latestTeamProbeSnapshot() !== null
    && latestTeamProbeSnapshot().tasks[0].id === 'legacy')
  unknownRetention.unmount()

  /* ---------------------------------------------------------------- */
  console.log('\n[7] TeamSource：无快照 / 会话过滤 / clear')
  /* ---------------------------------------------------------------- */
  teamProbeBridge.clear()
  const emptySource = createTeamSource()
  const emptySub = subscribeCount(emptySource)
  ok('无快照时 subscribe 不回调', emptySub.count() === 0)

  teamProbeBridge.setSnapshot({
    sessionId: 's1',
    projection: makeProjection({ tasks: [makeTask({ id: 'one' })] }),
    approvals: [],
  })
  ok('无快照时订阅者在后续发布时收到快照', emptySub.count() === 1)
  ok('会话身份是 s1', latestTeamProbeSessionId() === 's1')

  const s1Source = createTeamSource({ sessionId: 's1' })
  const s2Source = createTeamSource({ sessionId: 's2' })
  const s1Sub = subscribeCount(s1Source)
  const s2Sub = subscribeCount(s2Source)
  ok('s1 源立即拿到 s1 快照', s1Sub.count() === 1)
  ok('s2 源在 s1 期间不回调', s2Sub.count() === 0)

  teamProbeBridge.setSnapshot({
    sessionId: 's2',
    projection: makeProjection({ tasks: [makeTask({ id: 'two' })] }),
    approvals: [],
  })
  ok('切到 s2 后 s1 源不再回调', s1Sub.count() === 1)
  ok('s2 源收到 s2 快照', s2Sub.count() === 1 && s2Sub.snapshots[0].tasks[0].id === 'two')

  const beforeClear = emptySub.count()
  teamProbeBridge.clear()
  ok('clear 不伪造新快照通知', emptySub.count() === beforeClear)
  ok('clear 后 latest 为 null', latestTeamProbeSnapshot() === null)

  teamProbeBridge.setSnapshot({ sessionId: 's1', projection: makeProjection(), approvals: [] })
  teamProbeBridge.clear('s2')
  ok('clear 指定别的会话时不清当前', latestTeamProbeSessionId() === 's1')
  teamProbeBridge.clear('s1')
  ok('clear 指定当前会话时清空', latestTeamProbeSnapshot() === null)
  s1Sub.unsubscribe()
  s2Sub.unsubscribe()

  /* ---------------------------------------------------------------- */
  console.log('\n[8] teamProbeBridge 直接写入')
  /* ---------------------------------------------------------------- */
  teamProbeBridge.clear()
  const explicit = teamProbeBridge.setSnapshot({
    sessionId: 's-bridge',
    projection: makeProjection({ tasks: [makeTask({ id: 'bridge-1' })] }),
    approvals: [
      { id: 'approval:100', sessionId: 's-bridge', toolName: 'bash', at: 1234 },
      { id: 'approval:100', sessionId: 's-bridge', toolName: 'bash', at: 9999 },
      { id: 'approval:101', sessionId: 's-bridge' },
    ],
  })
  ok('setSnapshot 返回快照', explicit === latestTeamProbeSnapshot())
  ok('显式 at 被保留', explicit.approvals[0].at === 1234)
  ok('重复审批被去重', explicit.approvals.length === 2)
  ok('没有 toolName 的审批不带该字段', !('toolName' in explicit.approvals[1]))
  const secondBridge = teamProbeBridge.setSnapshot({
    sessionId: 's-bridge',
    projection: makeProjection({ tasks: [makeTask({ id: 'bridge-1' })] }),
    approvals: [{ id: 'approval:100', sessionId: 's-bridge', toolName: 'bash' }],
  })
  ok('同 session 新投影引用会重新发布', secondBridge !== explicit)
  teamProbeBridge.clear()

  /* ---------------------------------------------------------------- */
  console.log('\n[9] registerTeamProbe')
  /* ---------------------------------------------------------------- */
  const overlayCalls = []
  const overlayCtx = {
    slots: {
      inject(name, callback) {
        overlayCalls.push(['inject', name])
        callback()
        return () => {}
      },
      register(descriptor, component) {
        overlayCalls.push(['register', descriptor, component])
        return () => {}
      },
    },
  }
  registerTeamProbe(overlayCtx, createFakeReact().R)
  const injectCall = overlayCalls.find(call => call[0] === 'inject')
  const registerCall = overlayCalls.find(call => call[0] === 'register')
  ok('默认 inject overlay 槽位', injectCall && injectCall[1] === TEAM_PROBE_SLOT)
  ok('注册描述符 name/id 正确', registerCall
    && registerCall[1].name === TEAM_PROBE_SLOT
    && registerCall[1].id === TEAM_PROBE_ID)
  ok('注册的是组件函数', registerCall && typeof registerCall[2] === 'function')

  const fallbackCalls = []
  const fallbackCtx = {
    slots: {
      inject(name, callback) {
        fallbackCalls.push(['inject', name])
        if (name === TEAM_PROBE_SLOT) throw new Error('overlay 不可用')
        callback()
      },
      register(descriptor) {
        fallbackCalls.push(['register', descriptor.name])
        return () => {}
      },
    },
  }
  const originalWarnForFallback = console.warn
  console.warn = () => {}
  try {
    registerTeamProbe(fallbackCtx, createFakeReact().R)
  } finally {
    console.warn = originalWarnForFallback
  }
  ok('overlay 失败后退到 dock', fallbackCalls.some(call => call[0] === 'register'
    && call[1] === TEAM_PROBE_FALLBACK_SLOT))
  const directCalls = []
  const directCtx = {
    slots: {
      register(descriptor) {
        directCalls.push(descriptor.name)
        return () => {}
      },
    },
  }
  registerTeamProbe(directCtx, createFakeReact().R)
  ok('宿主没有 inject 时直接 register 主槽和兜底槽', directCalls.length === 2 && directCalls[0] === TEAM_PROBE_SLOT)

  let threw = false
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    registerTeamProbe({}, createFakeReact().R)
    registerTeamProbe(null, createFakeReact().R)
    registerTeamProbe(undefined, undefined)
  } catch (error) {
    threw = true
  } finally {
    console.warn = originalWarn
  }
  ok('没有 slots / R 时不抛异常', threw === false)

  const accessed = new Set()
  const guardedCtx = new Proxy(overlayCtx, {
    get(target, key) {
      accessed.add(String(key))
      return target[key]
    },
  })
  registerTeamProbe(guardedCtx, createFakeReact().R)
  ok('registerTeamProbe 只读 ctx.slots', [...accessed].join(',') === 'slots', [...accessed].join(','))

  /* ---------------------------------------------------------------- */
  console.log('\n[10] 静态守卫：只读、无定时器、无额外依赖')
  /* ---------------------------------------------------------------- */
  const sourceText = readFileSync(join(ROOT, 'src', 'client', 'team-source.ts'), 'utf8')
  const codeOnly = sourceText
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  const forbiddenWrites = [
    'updateTask', 'createTask', 'deleteTask', 'claimTask', 'releaseTask',
    'completeTask', 'reassignTask', 'setDependencies', 'agentTeams', 'setEnabled',
    'remote.agentTeams', 'sessions.create', 'sessions.fork',
  ]
  const foundWrite = forbiddenWrites.filter(token => codeOnly.includes(token))
  ok('源码不含任务写方法/写通道', foundWrite.length === 0, foundWrite.join(','))
  ok('源码不含定时器', !/\bsetInterval\b|\bsetTimeout\b/.test(codeOnly))
  ok('源码不碰 DOM / 全局对象', !/\bdocument\s*\.|\bwindow\s*\.|\blocalStorage\b/.test(codeOnly))
  ok('源码不发网络请求', !/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(codeOnly))
  const importSpecs = [...sourceText.matchAll(/(?:^|\n)\s*import\s+([\s\S]*?)\s+from\s+'([^']+)'/g)]
    .map(match => match[2])
  ok('只有一条 type-only import 且指向 shared 契约', importSpecs.length === 1
    && importSpecs[0] === '../shared/team-contract.js'
    && /import\s+type/.test(sourceText), importSpecs.join(' | '))
  ok('没有 require 动态加载', !/\brequire\s*\(/.test(codeOnly))

  /* ---------------------------------------------------------------- */
  console.log('\n[11] 无投影标准 hook 的退化路径')
  /* ---------------------------------------------------------------- */
  teamProbeBridge.clear()
  const noSessions = createProbeHarness(MOD, {
    projection: makeProjection({ tasks: [makeTask({ id: 'solo' })] }),
    noSessions: true,
  })
  noSessions.render()
  ok('没有 useSessions 时仍能发布', latestTeamProbeSnapshot().tasks[0].id === 'solo')
  noSessions.unmount()
} catch (error) {
  fail += 1
  console.log('  ✘ 运行异常：' + String((error && error.stack) || error))
}

console.log('\n' + (fail === 0
  ? '✔ 团队数据源体检测试通过（' + pass + ' 项）'
  : '✘ 失败 ' + fail + ' 项 / 通过 ' + pass + ' 项'))
process.exit(fail === 0 ? 0 : 1)
