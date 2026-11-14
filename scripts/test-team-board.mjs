/**
 * scripts/test-team-board.mjs —— 「鲸鱼看板」纯函数核心的自检。
 *
 * 不联网、不读文件、不依赖 DOM；直接由 Node 24 剥离类型后加载 src/shared/team-board.ts。
 * 运行：node scripts/test-team-board.mjs
 */

import assert from 'node:assert/strict'

const { summarizeTeamBoard, presentTeamSummary, emptyTeamBoardSummary } =
  await import('../src/shared/team-board.ts')

let pass = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    pass++
    console.log('  ✅ ' + name)
  } catch (err) {
    failures.push({ name, err })
    console.log('  ❌ ' + name)
    const detail = err && err.message ? String(err.message) : String(err)
    console.log('     ' + detail.replace(/\n/g, '\n     '))
  }
}

/** 构造一个字段齐全的 TeamTaskView；只覆盖测试关心的字段。 */
function task(overrides = {}) {
  return {
    id: 't1',
    revision: 1,
    subject: '任务',
    description: '',
    status: 'pending',
    blockedBy: [],
    writeScopes: [],
    ready: true,
    writeScopeWarnings: [],
    ...overrides,
  }
}

function snapshot(tasks, extra = {}) {
  return { available: true, enabled: true, tasks, capturedAt: 1000, ...extra }
}

const ENABLED = { enabled: true }

// ---------------------------------------------------------------------------
console.log('\n[1] 空板')
// ---------------------------------------------------------------------------
const empty = summarizeTeamBoard(snapshot([]), null, 4000)

check('phase = empty', () => assert.equal(empty.phase, 'empty'))
check('counts 全零', () =>
  assert.deepEqual(empty.counts, {
    total: 0,
    inProgress: 0,
    readyPending: 0,
    blockedPending: 0,
    completed: 0,
    approvals: 0,
  }),
)
check('activeTask 为 undefined', () => assert.equal(empty.activeTask, undefined))
check('stuckTaskIds / approvalIds 为空', () => {
  assert.deepEqual(empty.stuckTaskIds, [])
  assert.deepEqual(empty.approvalIds, [])
})
check('capturedAt = now', () => assert.equal(empty.capturedAt, 4000))
check('emptyTeamBoardSummary 指纹与空板一致', () =>
  assert.equal(emptyTeamBoardSummary(999).fingerprint, empty.fingerprint),
)
check('空板不展示', () => assert.equal(presentTeamSummary(empty, null, 4000, ENABLED), null))

// ---------------------------------------------------------------------------
console.log('\n[2] 单任务：在做 / 等人接 / 卡住')
// ---------------------------------------------------------------------------
const working = summarizeTeamBoard(
  snapshot([task({ id: 'live', subject: '写测试', status: 'in_progress' })]),
  null,
  5000,
)

check('1 个在做 → phase working', () => assert.equal(working.phase, 'working'))
check('1 个在做 → 计数正确', () =>
  assert.deepEqual(working.counts, {
    total: 1,
    inProgress: 1,
    readyPending: 0,
    blockedPending: 0,
    completed: 0,
    approvals: 0,
  }),
)
check('activeTask 取 in_progress 的 id/subject', () =>
  assert.deepEqual(working.activeTask, { id: 'live', subject: '写测试' }),
)
check('1 个在做 → ambient 文案', () => {
  const p = presentTeamSummary(working, null, 5000, ENABLED)
  assert.ok(p)
  assert.equal(p.ambient.text, '1 个任务：1 个在做')
  assert.equal(p.ambient.tone, 'normal')
})
check('首次 ambient 不带 alert', () => {
  const p = presentTeamSummary(working, null, 5000, ENABLED)
  assert.equal(p.alert, undefined)
})

const waiting = summarizeTeamBoard(
  snapshot([task({ id: 'ready', subject: '等人接', status: 'pending', ready: true })]),
  null,
  5000,
)
check('1 个等人接 → phase waiting', () => assert.equal(waiting.phase, 'waiting'))
check('activeTask 回退到 readyPending', () =>
  assert.deepEqual(waiting.activeTask, { id: 'ready', subject: '等人接' }),
)
check('1 个等人接 → ambient 文案', () => {
  const p = presentTeamSummary(waiting, null, 5000, ENABLED)
  assert.equal(p.ambient.text, '1 个任务：1 个等人接')
  assert.equal(p.ambient.tone, 'normal')
})

const blocked = summarizeTeamBoard(
  snapshot([task({ id: 'stuck', subject: '被卡住', status: 'pending', ready: false })]),
  null,
  5000,
)
check('1 个卡住 → phase blocked', () => assert.equal(blocked.phase, 'blocked'))
check('1 个卡住 → stuckTaskIds', () => assert.deepEqual(blocked.stuckTaskIds, ['stuck']))
check('1 个卡住 → ambient 文案 + warn', () => {
  const p = presentTeamSummary(blocked, null, 5000, ENABLED)
  assert.equal(p.ambient.text, '1 个任务：1 个卡住了')
  assert.equal(p.ambient.tone, 'warn')
})

// ---------------------------------------------------------------------------
console.log('\n[3] 3 任务示例文案')
// ---------------------------------------------------------------------------
const three = summarizeTeamBoard(
  snapshot([
    task({ id: 'a', status: 'in_progress' }),
    task({ id: 'b', status: 'pending', ready: true }),
    task({ id: 'c', status: 'pending', ready: false }),
  ]),
  null,
  6000,
)

check('3 任务 → phase working（在做优先于卡住）', () => assert.equal(three.phase, 'working'))
check('3 任务 → 计数精确', () =>
  assert.deepEqual(three.counts, {
    total: 3,
    inProgress: 1,
    readyPending: 1,
    blockedPending: 1,
    completed: 0,
    approvals: 0,
  }),
)
check('3 任务 → 示例文案逐字精确', () => {
  const p = presentTeamSummary(three, null, 6000, ENABLED)
  assert.equal(p.ambient.text, '3 个任务：1 个在做，1 个等人接，1 个卡住了')
})
check('3 任务 → tone warn', () => {
  const p = presentTeamSummary(three, null, 6000, ENABLED)
  assert.equal(p.ambient.tone, 'warn')
})

// ---------------------------------------------------------------------------
console.log('\n[4] 完成转变只提示一次')
// ---------------------------------------------------------------------------
const prevWorking = summarizeTeamBoard(
  snapshot([task({ id: 'w', status: 'in_progress' })]),
  null,
  1000,
)
const done = summarizeTeamBoard(
  snapshot([task({ id: 'd1', status: 'completed' })]),
  prevWorking,
  100000,
)

check('全完成 → phase done', () => assert.equal(done.phase, 'done'))
check('非 done → done 给出 alert', () => {
  const p = presentTeamSummary(done, prevWorking, 100000, ENABLED)
  assert.ok(p?.alert)
  assert.equal(p.alert.text, '鲸群回巢了')
  assert.equal(p.alert.key, 'team:done:' + done.fingerprint)
  assert.equal(p.alert.ttl, 12000)
  assert.equal(p.alert.rank, 15)
  assert.equal(p.alert.anim, 'settle')
})
check('done 时普通 ambient 是「全部完成」', () => {
  const p = presentTeamSummary(done, prevWorking, 100000, ENABLED)
  assert.equal(p.ambient.text, '1 个任务：全部完成')
  assert.equal(p.ambient.tone, 'normal')
})
check('previous 已是 done → 不再 alert，返回 null', () => {
  const p = presentTeamSummary(done, done, 200000, ENABLED)
  assert.equal(p, null)
})

const done2 = summarizeTeamBoard(
  snapshot([
    task({ id: 'd1', status: 'completed' }),
    task({ id: 'd2', status: 'completed' }),
  ]),
  done,
  300000,
)
check('done → done 的计数变化不重复庆祝', () => {
  const p = presentTeamSummary(done2, done, 300000, ENABLED)
  assert.ok(p)
  assert.equal(p.alert, undefined)
  assert.equal(p.ambient.text, '2 个任务：全部完成')
})

// ---------------------------------------------------------------------------
console.log('\n[5] 审批提醒与去重')
// ---------------------------------------------------------------------------
const approvals = [
  { id: 'ap-1', toolName: 'shell', at: 1, sessionId: 's1' },
  { id: 'ap-1', toolName: 'shell', at: 2, sessionId: 's1' },
]
const appr = summarizeTeamBoard(
  snapshot([task({ id: 'w', status: 'in_progress' })], { approvals }),
  prevWorking,
  7000,
)

check('approval 优先于 working', () => assert.equal(appr.phase, 'approval'))
check('approvals 按原始长度计数、approvalIds 按 id 去重', () => {
  assert.equal(appr.counts.approvals, 2)
  assert.deepEqual(appr.approvalIds, ['ap-1'])
})
check('审批 alert 文案/键/参数严格', () => {
  const p = presentTeamSummary(appr, prevWorking, 7000, ENABLED)
  assert.ok(p?.alert)
  assert.equal(p.alert.text, '有个子 Agent 在等你批东西')
  assert.equal(p.alert.key, 'team:approval:ap-1')
  assert.equal(p.alert.ttl, 6000)
  assert.equal(p.alert.rank, 20)
})
check('审批不泄漏 toolName', () => {
  const p = presentTeamSummary(appr, prevWorking, 7000, ENABLED)
  assert.equal(p.alert.text.includes('shell'), false)
})
check('同一 previous 摘要 → 不重复 alert / 不重复 ambient', () =>
  assert.equal(presentTeamSummary(appr, appr, 8000, ENABLED), null),
)

const apprSeen = summarizeTeamBoard(
  snapshot(
    [
      task({ id: 'w', status: 'in_progress' }),
      task({ id: 'd', status: 'completed' }),
    ],
    { approvals: [{ id: 'ap-1', toolName: 'shell', at: 3, sessionId: 's1' }] },
  ),
  appr,
  90000,
)
check('previous.approvalIds 已有该 id → 即使其它计数变化也不 alert', () => {
  const p = presentTeamSummary(apprSeen, appr, 90000, ENABLED)
  assert.equal(p?.alert, undefined)
})

const apprNew = summarizeTeamBoard(
  snapshot([task({ id: 'w', status: 'in_progress' })], {
    approvals: [{ id: 'ap-2', toolName: 'shell', at: 4, sessionId: 's1' }],
  }),
  appr,
  120000,
)
check('新的审批 id 会 alert', () => {
  const p = presentTeamSummary(apprNew, appr, 120000, ENABLED)
  assert.equal(p?.alert?.key, 'team:approval:ap-2')
})

check('首次看到审批：alert + ambient 都给', () => {
  const p = presentTeamSummary(appr, null, 7000, ENABLED)
  assert.ok(p?.alert)
  assert.ok(p?.ambient)
})

// ---------------------------------------------------------------------------
console.log('\n[6] 错误只提示一次')
// ---------------------------------------------------------------------------
const failed = summarizeTeamBoard(snapshot([], { failure: 'boom' }), null, 1000)

check('failure → phase error', () => assert.equal(failed.phase, 'error'))
check('首次 error → alert 参数严格、无 ambient', () => {
  const p = presentTeamSummary(failed, null, 1000, ENABLED)
  assert.ok(p?.alert)
  assert.equal(p.alert.text, '看板暂不可用')
  assert.equal(p.alert.key, 'team:error')
  assert.equal(p.alert.ttl, 6000)
  assert.equal(p.alert.rank, 10)
  assert.equal(p.ambient, null)
})
check('error → error 不重复提示', () =>
  assert.equal(presentTeamSummary(failed, failed, 2000, ENABLED), null),
)
check('working → error 仍提示一次', () => {
  const p = presentTeamSummary(failed, prevWorking, 2000, ENABLED)
  assert.equal(p?.alert?.key, 'team:error')
})
check('available=false 优先于 failure', () => {
  const s = summarizeTeamBoard(snapshot([], { available: false, failure: 'boom' }), null, 1000)
  assert.equal(s.phase, 'unavailable')
})
check('failure 优先于 enabled=false', () => {
  const s = summarizeTeamBoard(snapshot([], { enabled: false, failure: 'boom' }), null, 1000)
  assert.equal(s.phase, 'error')
})

// ---------------------------------------------------------------------------
console.log('\n[7] 禁用 / 不可用')
// ---------------------------------------------------------------------------
check('options.enabled=false → null', () =>
  assert.equal(presentTeamSummary(working, null, 5000, { enabled: false }), null),
)

const disabled = summarizeTeamBoard(
  snapshot([task({ id: 'w', status: 'in_progress' })], { enabled: false }),
  null,
  5000,
)
check('snapshot.enabled=false → unavailable', () => assert.equal(disabled.phase, 'unavailable'))
check('unavailable 不展示', () =>
  assert.equal(presentTeamSummary(disabled, null, 5000, ENABLED), null),
)

// ---------------------------------------------------------------------------
console.log('\n[8] fingerprint 稳定性与 deleted / description')
// ---------------------------------------------------------------------------
const fpA = summarizeTeamBoard(
  snapshot([
    task({ id: 'a', subject: '甲', description: '描述一', status: 'in_progress' }),
    task({ id: 'b', subject: '乙', description: '描述二', status: 'pending', ready: false }),
  ]),
  null,
  1000,
)
const fpB = summarizeTeamBoard(
  snapshot([
    task({ id: 'a', subject: '甲', description: '完全不同的描述', status: 'in_progress' }),
    task({ id: 'b', subject: '乙', description: '另一个描述', status: 'pending', ready: false }),
  ]),
  null,
  987654,
)

check('不同对象 / 不同 description / 不同 now → fingerprint 相同', () =>
  assert.equal(fpA.fingerprint, fpB.fingerprint),
)
check('description 不进入摘要', () =>
  assert.equal(JSON.stringify(fpA).includes('描述一'), false),
)
check('状态变化 → fingerprint 变化', () => {
  const changed = summarizeTeamBoard(
    snapshot([
      task({ id: 'a', status: 'completed' }),
      task({ id: 'b', status: 'pending', ready: false }),
    ]),
    null,
    1000,
  )
  assert.notEqual(changed.fingerprint, fpA.fingerprint)
})
check('审批顺序不影响 fingerprint', () => {
  const orderA = summarizeTeamBoard(
    snapshot([], {
      approvals: [
        { id: 'x', at: 1, sessionId: 's' },
        { id: 'y', at: 2, sessionId: 's' },
      ],
    }),
    null,
    1000,
  )
  const orderB = summarizeTeamBoard(
    snapshot([], {
      approvals: [
        { id: 'y', at: 2, sessionId: 's' },
        { id: 'x', at: 1, sessionId: 's' },
      ],
    }),
    null,
    2000,
  )
  assert.equal(orderA.fingerprint, orderB.fingerprint)
})

const deleted = summarizeTeamBoard(
  snapshot([
    task({ id: 'gone', subject: '已删', status: 'deleted', ready: false }),
    task({ id: 'done', status: 'completed' }),
    task({ id: 'next', status: 'pending', ready: true }),
  ]),
  null,
  1000,
)
check('deleted 不计入 total/completed', () => {
  assert.equal(deleted.counts.total, 2)
  assert.equal(deleted.counts.completed, 1)
  assert.equal(deleted.counts.readyPending, 1)
})
check('deleted 不进入 activeTask / stuckTaskIds / 文案', () => {
  assert.equal(deleted.activeTask.id, 'next')
  assert.deepEqual(deleted.stuckTaskIds, [])
  const p = presentTeamSummary(deleted, null, 1000, ENABLED)
  assert.equal(p.ambient.text, '2 个任务：1 个等人接')
})
check('只剩 deleted → 空板', () => {
  const onlyDeleted = summarizeTeamBoard(
    snapshot([task({ id: 'gone', status: 'deleted' })]),
    null,
    1000,
  )
  assert.equal(onlyDeleted.phase, 'empty')
  assert.equal(onlyDeleted.counts.total, 0)
  assert.equal(presentTeamSummary(onlyDeleted, null, 1000, ENABLED), null)
})

// ---------------------------------------------------------------------------
console.log('\n[9] 普通摘要冷却与 quiet')
// ---------------------------------------------------------------------------
check('状态变化但未满默认冷却 → 不给 ambient', () =>
  assert.equal(presentTeamSummary(blocked, prevWorking, 2000, ENABLED), null),
)
check('满默认冷却 → 给 ambient', () => {
  const p = presentTeamSummary(blocked, prevWorking, 70000, ENABLED)
  assert.equal(p?.ambient?.text, '1 个任务：1 个卡住了')
})
check('同 fingerprint 即使过了冷却也不重复', () =>
  assert.equal(presentTeamSummary(working, working, 200000, ENABLED), null),
)
check('cooldownMs=0 可立即给 ambient', () => {
  const p = presentTeamSummary(blocked, prevWorking, 2000, {
    enabled: true,
    cooldownMs: 0,
  })
  assert.ok(p?.ambient)
})
check('quiet=true 仍给普通 ambient', () => {
  const p = presentTeamSummary(working, null, 5000, { enabled: true, quiet: true })
  assert.ok(p?.ambient)
  assert.equal(p.alert, undefined)
})
check('quiet=true 不影响审批 alert', () => {
  const p = presentTeamSummary(appr, prevWorking, 7000, { enabled: true, quiet: true })
  assert.equal(p?.alert?.key, 'team:approval:ap-1')
})

// 2026-11-14 验收补充：首次看到 done 不补播历史庆祝；旧审批未走时新审批要提示
check('首次看到已全部完成 → 不庆祝（previous=null）', () => {
  const p = presentTeamSummary(done, null, 100000, ENABLED)
  assert.equal(p?.alert, undefined)
  assert.ok(p?.ambient)
})
check('旧审批仍在、新增第二个审批 → 提示新 id', () => {
  const both = summarizeTeamBoard(
    snapshot([task({ id: 'w', status: 'in_progress' })], {
      approvals: [
        { id: 'ap-1', toolName: 'shell', at: 3, sessionId: 's1' },
        { id: 'ap-2', toolName: 'shell', at: 4, sessionId: 's1' },
      ],
    }),
    appr,
    110000,
  )
  const p = presentTeamSummary(both, appr, 110000, ENABLED)
  assert.equal(p?.alert?.key, 'team:approval:ap-2')
})

// ---------------------------------------------------------------------------
console.log('')
if (failures.length > 0) {
  console.error(`失败 ${failures.length} 项，通过 ${pass} 项`)
  process.exitCode = 1
} else {
  console.log(`通过 ${pass} 项`)
}
