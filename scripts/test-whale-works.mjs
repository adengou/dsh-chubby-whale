/**
 * scripts/test-whale-works.mjs —— 「鲸群营造（WhaleWorks）」v0.1 纯函数检查器自检。
 *
 * 不联网、不读文件、不依赖 DOM；直接由 Node 24 剥离类型后加载 src/shared/whale-works.ts。
 * 覆盖：空板 / 单分支 / 多分支 / 叶子完成 / 死锁 / 分支完成叶子未完成 /
 *       验收缺失·未签字·通过 / scope 重叠 / 重复前缀 / 无前缀·空标题 / deleted /
 *       chipText 文案 / 模板 / phase 优先级。
 *
 * 运行：node scripts/test-whale-works.mjs
 */

import assert from 'node:assert/strict'

const { inspectWhaleWorks, WHALE_WORKS_TEMPLATES } = await import(
  '../src/shared/whale-works.ts'
)

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
    subject: '[A] 任务',
    description: '',
    status: 'pending',
    blockedBy: [],
    writeScopes: [],
    ready: true,
    writeScopeWarnings: [],
    ...overrides,
  }
}

function codes(report) {
  return report.warnings.map((w) => w.code)
}

function findWarning(report, code) {
  return report.warnings.find((w) => w.code === code)
}

function branch(report, key) {
  return report.branches.find((b) => b.key === key)
}

// ---------------------------------------------------------------------------
console.log('\n[1] 空板与脏输入容错')
// ---------------------------------------------------------------------------
const empty = inspectWhaleWorks([])

check('空板 → phase idle', () => assert.equal(empty.phase, 'idle'))
check('空板 → chipText「暂无施工」', () => assert.equal(empty.chipText, '暂无施工'))
check('空板 → branches / warnings 为空', () => {
  assert.deepEqual(empty.branches, [])
  assert.deepEqual(empty.warnings, [])
})
check('空板 → acceptance 全 false', () =>
  assert.deepEqual(empty.acceptance, { hasTask: false, signed: false, pending: false }),
)
check('空板 → totalTasks / completedTasks = 0', () => {
  assert.equal(empty.totalTasks, 0)
  assert.equal(empty.completedTasks, 0)
})
check('null 输入不抛错（运行期脏输入降级为空板）', () => {
  const report = inspectWhaleWorks(null)
  assert.equal(report.phase, 'idle')
  assert.equal(report.totalTasks, 0)
})

// ---------------------------------------------------------------------------
console.log('\n[2] 单分支施工中')
// ---------------------------------------------------------------------------
const working = inspectWhaleWorks([
  task({ id: 'a', subject: '[A] 文件清单', status: 'in_progress' }),
  task({ id: 'a1', subject: '[A1] 顶层文件', status: 'pending', ready: true }),
])

check('单分支 → 1 个分支，key/label 正确', () => {
  assert.equal(working.branches.length, 1)
  assert.equal(working.branches[0].key, 'A')
  assert.equal(working.branches[0].label, '文件清单')
})
check('单分支 → total/done/active/waiting/blocked 精确', () => {
  const { total, done, active, waiting, blocked } = working.branches[0]
  assert.deepEqual({ total, done, active, waiting, blocked }, {
    total: 2,
    done: 0,
    active: 1,
    waiting: 1,
    blocked: 0,
  })
})
check('单分支 → phase working', () => assert.equal(working.phase, 'working'))
check('施工中不误报验收警告', () => assert.deepEqual(working.warnings, []))
check('施工中 → chipText「施工 0/1 分支」', () =>
  assert.equal(working.chipText, '施工 0/1 分支'),
)
check('单分支 → hasAcceptance=false', () =>
  assert.equal(working.branches[0].hasAcceptance, false),
)

// ---------------------------------------------------------------------------
console.log('\n[3] 叶子完成但分支未完成（不误报 BRANCH_DONE_WITH_OPEN_LEAVES）')
// ---------------------------------------------------------------------------
const leafDone = inspectWhaleWorks([
  task({ id: 'a', subject: '[A] 文件清单', status: 'in_progress' }),
  task({ id: 'a1', subject: '[A1] 顶层文件', status: 'completed' }),
])

check('叶子完成 → 分支 done=1 active=1', () => {
  const b = branch(leafDone, 'A')
  assert.equal(b.done, 1)
  assert.equal(b.active, 1)
  assert.equal(b.total, 2)
})
check('叶子完成但分支未完成 → 不报分支完成警告', () =>
  assert.equal(findWarning(leafDone, 'BRANCH_DONE_WITH_OPEN_LEAVES'), undefined),
)
check('叶子完成但分支未完成 → phase working', () => assert.equal(leafDone.phase, 'working'))

// ---------------------------------------------------------------------------
console.log('\n[4] 多分支统计（A 完成 / B 在施工且叶子卡住）')
// ---------------------------------------------------------------------------
const multi = inspectWhaleWorks([
  task({ id: 'a', subject: '[A] 文件清单', status: 'completed' }),
  task({ id: 'a1', subject: '[A1] 顶层文件', status: 'completed' }),
  task({ id: 'b', subject: '[B] 格式检查', status: 'in_progress' }),
  task({ id: 'b1', subject: '[B1] AGENTS 格式', status: 'pending', ready: false }),
])

check('多分支 → 分支按 key 排序 A、B', () =>
  assert.deepEqual(multi.branches.map((b) => b.key), ['A', 'B']),
)
check('多分支 → A 全完成', () => {
  const b = branch(multi, 'A')
  assert.deepEqual(
    { total: b.total, done: b.done, active: b.active, waiting: b.waiting, blocked: b.blocked },
    { total: 2, done: 2, active: 0, waiting: 0, blocked: 0 },
  )
})
check('多分支 → B 有 1 active + 1 blocked', () => {
  const b = branch(multi, 'B')
  assert.deepEqual(
    { total: b.total, done: b.done, active: b.active, waiting: b.waiting, blocked: b.blocked },
    { total: 2, done: 0, active: 1, waiting: 0, blocked: 1 },
  )
})
check('多分支 → phase blocked（blocked 优先于 active）', () =>
  assert.equal(multi.phase, 'blocked'),
)
check('多分支 → chipText「施工 1/2 分支」', () =>
  assert.equal(multi.chipText, '施工 1/2 分支'),
)
check('多分支 → 计数正确', () => {
  assert.equal(multi.totalTasks, 4)
  assert.equal(multi.completedTasks, 2)
})

// ---------------------------------------------------------------------------
console.log('\n[5] 全部完成但没有验收任务 → ACCEPTANCE_MISSING')
// ---------------------------------------------------------------------------
const missing = inspectWhaleWorks([
  task({ id: 'a', subject: '[A] 文件清单', status: 'completed' }),
  task({ id: 'a1', subject: '[A1] 顶层文件', status: 'completed' }),
])

check('无 [V] 且全部完成 → 有 ACCEPTANCE_MISSING', () => {
  const w = findWarning(missing, 'ACCEPTANCE_MISSING')
  assert.ok(w, '缺少 ACCEPTANCE_MISSING')
  assert.equal(w.level, 'error')
  assert.deepEqual(w.taskIds, [])
})
check('ACCEPTANCE_MISSING → phase warn', () => assert.equal(missing.phase, 'warn'))
check('无 [V] → acceptance 全 false', () =>
  assert.deepEqual(missing.acceptance, { hasTask: false, signed: false, pending: false }),
)
check('无 [V] → chipText 带「1 警告」', () =>
  assert.equal(missing.chipText, '施工 1/1 分支 · 1 警告'),
)

// ---------------------------------------------------------------------------
console.log('\n[6] 死锁：叶子 blockedBy 父分支')
// ---------------------------------------------------------------------------
const deadlock = inspectWhaleWorks([
  task({ id: 'a', subject: '[A] 文件清单', status: 'pending', ready: false }),
  task({ id: 'a1', subject: '[A1] 顶层文件', status: 'pending', ready: false, blockedBy: ['a'] }),
])

check('叶子 blockedBy 父分支 → LEAF_BLOCKED_BY_PARENT（error）', () => {
  const w = findWarning(deadlock, 'LEAF_BLOCKED_BY_PARENT')
  assert.ok(w, '缺少 LEAF_BLOCKED_BY_PARENT')
  assert.equal(w.level, 'error')
  assert.deepEqual(w.taskIds, ['a1', 'a'])
})
check('死锁 → phase warn', () => assert.equal(deadlock.phase, 'warn'))
check('死锁 → chipText 带警告数', () => assert.match(deadlock.chipText, /1 警告$/))

const noDeadlock = inspectWhaleWorks([
  task({ id: 'a', subject: '[A] 文件清单', status: 'pending', ready: false }),
  task({ id: 'a1', subject: '[A1] 顶层文件', status: 'pending', ready: false, blockedBy: ['x-real-dep'] }),
])

check('blockedBy 指向真实前置依赖 → 不误报死锁', () =>
  assert.equal(findWarning(noDeadlock, 'LEAF_BLOCKED_BY_PARENT'), undefined),
)
check('叶子 blockedBy 别的分支任务 → 不报本分支死锁', () => {
  const report = inspectWhaleWorks([
    task({ id: 'a', subject: '[A] 分支', status: 'pending', ready: false }),
    task({ id: 'b', subject: '[B] 分支', status: 'pending', ready: false }),
    task({ id: 'a1', subject: '[A1] 工人', status: 'pending', ready: false, blockedBy: ['b'] }),
  ])
  assert.equal(findWarning(report, 'LEAF_BLOCKED_BY_PARENT'), undefined)
})

// ---------------------------------------------------------------------------
console.log('\n[7] 分支完成但叶子还没完成 → BRANCH_DONE_WITH_OPEN_LEAVES')
// ---------------------------------------------------------------------------
const branchDone = inspectWhaleWorks([
  task({ id: 'a', subject: '[A] 文件清单', status: 'completed' }),
  task({ id: 'a1', subject: '[A1] 顶层文件', status: 'pending', ready: true }),
  task({ id: 'a2', subject: '[A2] 清单校验', status: 'in_progress' }),
])

check('分支完成 + 叶子未完成 → 有 BRANCH_DONE_WITH_OPEN_LEAVES（warn）', () => {
  const w = findWarning(branchDone, 'BRANCH_DONE_WITH_OPEN_LEAVES')
  assert.ok(w, '缺少 BRANCH_DONE_WITH_OPEN_LEAVES')
  assert.equal(w.level, 'warn')
  assert.deepEqual(w.taskIds, ['a', 'a1', 'a2'])
})
check('分支完成 + 叶子未完成 → 分支统计正确', () => {
  const b = branch(branchDone, 'A')
  assert.deepEqual(
    { total: b.total, done: b.done, active: b.active, waiting: b.waiting, blocked: b.blocked },
    { total: 3, done: 1, active: 1, waiting: 1, blocked: 0 },
  )
})
check('分支完成 + 叶子未完成 → phase working', () =>
  assert.equal(branchDone.phase, 'working'),
)
check('分支完成 + 叶子未完成 → chipText「施工 0/1 分支 · 1 警告」', () =>
  assert.equal(branchDone.chipText, '施工 0/1 分支 · 1 警告'),
)

// ---------------------------------------------------------------------------
console.log('\n[8] 验收未签字 → ACCEPTANCE_NOT_SIGNED')
// ---------------------------------------------------------------------------
const unsigned = inspectWhaleWorks([
  task({ id: 'a', subject: '[A] 文件清单', status: 'completed' }),
  task({ id: 'a1', subject: '[A1] 顶层文件', status: 'completed' }),
  task({ id: 'v', subject: '[V] 独立验收', status: 'pending', ready: true }),
])

check('施工完成 + [V] 未完成 → ACCEPTANCE_NOT_SIGNED（warn）', () => {
  const w = findWarning(unsigned, 'ACCEPTANCE_NOT_SIGNED')
  assert.ok(w, '缺少 ACCEPTANCE_NOT_SIGNED')
  assert.equal(w.level, 'warn')
  assert.deepEqual(w.taskIds, ['v'])
})
check('验收未签字 → acceptance {hasTask:true,signed:false,pending:true}', () =>
  assert.deepEqual(unsigned.acceptance, { hasTask: true, signed: false, pending: true }),
)
check('验收未签字 → phase verify（V 未完成优先）', () =>
  assert.equal(unsigned.phase, 'verify'),
)
check('验收未签字 → chipText「施工 1/1 分支 · 1 待验 · 1 警告」', () =>
  assert.equal(unsigned.chipText, '施工 1/1 分支 · 1 待验 · 1 警告'),
)
check('验收未签字 → 分支 hasAcceptance=false', () =>
  assert.equal(branch(unsigned, 'A').hasAcceptance, false),
)

// ---------------------------------------------------------------------------
console.log('\n[9] 验收通过 → done / 验收通过')
// ---------------------------------------------------------------------------
const accepted = inspectWhaleWorks([
  task({ id: 'a', subject: '[A] 文件清单', status: 'completed' }),
  task({ id: 'a1', subject: '[A1] 顶层文件', status: 'completed' }),
  task({ id: 'v', subject: '[V] 独立验收', status: 'completed' }),
])

check('验收完成 → acceptance signed', () =>
  assert.deepEqual(accepted.acceptance, { hasTask: true, signed: true, pending: false }),
)
check('验收完成 → phase done', () => assert.equal(accepted.phase, 'done'))
check('验收完成 → 无警告', () => assert.deepEqual(accepted.warnings, []))
check('验收完成 → chipText「验收通过」', () => assert.equal(accepted.chipText, '验收通过'))
check('验收完成 → 已完成分支 hasAcceptance=true', () =>
  assert.equal(branch(accepted, 'A').hasAcceptance, true),
)
check('验收完成 → 计数正确', () => {
  assert.equal(accepted.totalTasks, 3)
  assert.equal(accepted.completedTasks, 3)
})

// ---------------------------------------------------------------------------
console.log('\n[10] 有 [V] 未完成 → ACCEPTANCE_NOT_SIGNED 不沉默')
// ---------------------------------------------------------------------------
const earlyV = inspectWhaleWorks([
  task({ id: 'a', subject: '[A] 文件清单', status: 'in_progress' }),
  task({ id: 'a1', subject: '[A1] 顶层文件', status: 'pending', ready: true }),
  task({ id: 'v', subject: '[V] 独立验收', status: 'pending', ready: true }),
])

check('有 [V] 未完成 → 有 ACCEPTANCE_NOT_SIGNED（warn）', () => {
  const w = findWarning(earlyV, 'ACCEPTANCE_NOT_SIGNED')
  assert.ok(w, '缺少 ACCEPTANCE_NOT_SIGNED')
  assert.equal(w.level, 'warn')
  assert.deepEqual(w.taskIds, ['v'])
})
check('有 [V] 未完成 → phase verify', () => assert.equal(earlyV.phase, 'verify'))
check('chipText「施工 0/1 分支 · 1 待验 · 1 警告」', () => {
  assert.equal(earlyV.chipText, '施工 0/1 分支 · 1 待验 · 1 警告')
  assert.equal(earlyV.warnings.length, 1)
})

// ---------------------------------------------------------------------------
console.log('\n[11] 写作用域重叠（非 completed / 跳过空 scope / 同 scope 只报一次）')
// ---------------------------------------------------------------------------
const overlap = inspectWhaleWorks([
  task({ id: 'x', subject: '[A] 甲', status: 'in_progress', writeScopes: ['src/shared/a.ts', 'src/shared/b.ts'] }),
  task({ id: 'y', subject: '[B] 乙', status: 'in_progress', writeScopes: ['src/shared/a.ts', 'src/shared/c.ts'] }),
])

check('两任务共享一个 scope → 只报 1 条 WRITE_SCOPE_OVERLAP', () => {
  assert.deepEqual(codes(overlap), ['WRITE_SCOPE_OVERLAP'])
  const w = findWarning(overlap, 'WRITE_SCOPE_OVERLAP')
  assert.equal(w.level, 'warn')
  assert.deepEqual(w.taskIds, ['x', 'y'])
  assert.match(w.message, /src\/shared\/a\.ts/)
  assert.doesNotMatch(w.message, /src\/shared\/b\.ts/)
})
check('3 个任务共享同一 scope → 汇总成 1 条', () => {
  const report = inspectWhaleWorks([
    task({ id: 'p', subject: '[A] 1', status: 'in_progress', writeScopes: ['src/x.ts'] }),
    task({ id: 'q', subject: '[B] 2', status: 'in_progress', writeScopes: ['src/x.ts'] }),
    task({ id: 'r', subject: '[C] 3', status: 'pending', writeScopes: ['src/x.ts'] }),
  ])
  assert.equal(report.warnings.filter((w) => w.code === 'WRITE_SCOPE_OVERLAP').length, 1)
})
check('空 scope / 不同 scope 不报重叠', () => {
  const report = inspectWhaleWorks([
    task({ id: 'p', subject: '[A] 1', status: 'in_progress', writeScopes: ['', '  '] }),
    task({ id: 'q', subject: '[B] 2', status: 'in_progress', writeScopes: [] }),
    task({ id: 'r', subject: '[C] 3', status: 'in_progress', writeScopes: ['src/other.ts'] }),
  ])
  assert.equal(findWarning(report, 'WRITE_SCOPE_OVERLAP'), undefined)
})
check('completed 任务不参与 scope 重叠判断', () => {
  const report = inspectWhaleWorks([
    task({ id: 'p', subject: '[A] 1', status: 'completed', writeScopes: ['src/x.ts'] }),
    task({ id: 'q', subject: '[B] 2', status: 'in_progress', writeScopes: ['src/x.ts'] }),
  ])
  assert.equal(findWarning(report, 'WRITE_SCOPE_OVERLAP'), undefined)
})
check('同一 scope 重复声明不产生重复警告', () => {
  const report = inspectWhaleWorks([
    task({ id: 'p', subject: '[A] 1', status: 'in_progress', writeScopes: ['src/x.ts', 'src/x.ts'] }),
    task({ id: 'q', subject: '[B] 2', status: 'in_progress', writeScopes: ['src/x.ts'] }),
  ])
  assert.equal(report.warnings.filter((w) => w.code === 'WRITE_SCOPE_OVERLAP').length, 1)
})

// ---------------------------------------------------------------------------
console.log('\n[12] 重复前缀（分支与叶子不同层，不算重复）')
// ---------------------------------------------------------------------------
const duplicate = inspectWhaleWorks([
  task({ id: 'a1', subject: '[A] 分支一' }),
  task({ id: 'a2', subject: '[A] 分支二' }),
  task({ id: 'leaf1', subject: '[A1] 叶子一' }),
  task({ id: 'leaf2', subject: '[A2] 叶子二' }),
])

check('两个 [A] → DUPLICATE_PREFIX（warn），taskIds 两条', () => {
  const list = duplicate.warnings.filter((w) => w.code === 'DUPLICATE_PREFIX')
  assert.equal(list.length, 1)
  assert.equal(list[0].level, 'warn')
  assert.deepEqual(list[0].taskIds, ['a1', 'a2'])
})
check('[A] 与 [A1]/[A2] 不同层 → 各自不算重复', () => {
  const tokens = duplicate.warnings
    .filter((w) => w.code === 'DUPLICATE_PREFIX')
    .map((w) => w.message)
  assert.equal(tokens.length, 1)
  assert.doesNotMatch(tokens[0], /A1/)
})
check('重复 [A] 仍归入同一分支 → total=4', () =>
  assert.equal(branch(duplicate, 'A').total, 4),
)
check('前缀不区分大小写：[a] 与 [A] 算重复', () => {
  const report = inspectWhaleWorks([
    task({ id: 'low', subject: '[a] 小写' }),
    task({ id: 'up', subject: '[A] 大写' }),
  ])
  const w = findWarning(report, 'DUPLICATE_PREFIX')
  assert.ok(w)
  assert.deepEqual(w.taskIds, ['low', 'up'])
})
check('两个 [V] 也算重复前缀', () => {
  const report = inspectWhaleWorks([
    task({ id: 'v1', subject: '[V] 验收一' }),
    task({ id: 'v2', subject: '[V] 验收二' }),
  ])
  assert.ok(findWarning(report, 'DUPLICATE_PREFIX'))
})

// ---------------------------------------------------------------------------
console.log('\n[13] 无前缀 / 空标题 / 未分类')
// ---------------------------------------------------------------------------
const unclassified = inspectWhaleWorks([
  task({ id: 'n1', subject: '没有前缀的任务', status: 'in_progress' }),
  task({ id: 'n2', subject: '   ', status: 'pending', ready: true }),
  task({ id: 'a', subject: '[A] 正常分支', status: 'in_progress' }),
])

check('空标题 → EMPTY_TITLE（warn）只针对空标题任务', () => {
  const list = unclassified.warnings.filter((w) => w.code === 'EMPTY_TITLE')
  assert.equal(list.length, 1)
  assert.equal(list[0].level, 'warn')
  assert.deepEqual(list[0].taskIds, ['n2'])
})
check('无前缀任务不崩、不产生分支和前缀警告', () => {
  assert.deepEqual(unclassified.branches.map((b) => b.key), ['A'])
  assert.equal(findWarning(unclassified, 'DUPLICATE_PREFIX'), undefined)
})
check('无前缀任务仍计入 totalTasks', () => assert.equal(unclassified.totalTasks, 3))
check('未分类任务不影响 phase', () => assert.equal(unclassified.phase, 'working'))
check('[D]/[E]/[FIX] 不占普通分支', () => {
  const report = inspectWhaleWorks([
    task({ id: 'e', subject: '[E] 工程', status: 'completed' }),
    task({ id: 'd', subject: '[D] 设计', status: 'completed' }),
    task({ id: 'd1', subject: '[D1] 设计工人', status: 'completed' }),
    task({ id: 'fix', subject: '[FIX] 缺陷返工', status: 'in_progress' }),
  ])
  assert.deepEqual(report.branches, [])
  assert.equal(report.totalTasks, 4)
  assert.equal(report.chipText, '暂无分支')
})

// ---------------------------------------------------------------------------
console.log('\n[14] deleted 一律忽略')
// ---------------------------------------------------------------------------
const deletedOnly = inspectWhaleWorks([
  task({ id: 'gone-a', subject: '[A] 已删分支', status: 'deleted' }),
  task({ id: 'gone-v', subject: '[V] 已删验收', status: 'deleted' }),
])

check('只有 deleted → idle / 暂无施工', () => {
  assert.equal(deletedOnly.phase, 'idle')
  assert.equal(deletedOnly.chipText, '暂无施工')
  assert.equal(deletedOnly.totalTasks, 0)
})
check('deleted 不建分支、不建验收、不产生警告', () => {
  assert.deepEqual(deletedOnly.branches, [])
  assert.deepEqual(deletedOnly.warnings, [])
  assert.deepEqual(deletedOnly.acceptance, { hasTask: false, signed: false, pending: false })
})
check('deleted 的父分支不参与死锁判定', () => {
  const report = inspectWhaleWorks([
    task({ id: 'gone-a', subject: '[A] 已删分支', status: 'deleted' }),
    task({ id: 'leaf', subject: '[A1] 工人', status: 'pending', blockedBy: ['gone-a'] }),
  ])
  assert.equal(findWarning(report, 'LEAF_BLOCKED_BY_PARENT'), undefined)
  assert.equal(report.totalTasks, 1)
  assert.equal(report.branches.length, 1)
})

// ---------------------------------------------------------------------------
console.log('\n[15] chipText 文案契约')
// ---------------------------------------------------------------------------
const chipReport = inspectWhaleWorks([
  task({ id: 'a', subject: '[A] 文件清单', status: 'completed' }),
  task({ id: 'a1', subject: '[A1] 顶层文件', status: 'completed' }),
  task({ id: 'b', subject: '[B] 格式检查', status: 'completed' }),
  task({ id: 'b1', subject: '[B1] AGENTS 格式', status: 'completed' }),
  task({ id: 'c', subject: '[C] 前端实现', status: 'in_progress' }),
  task({ id: 'c1', subject: '[C1] 前端测试', status: 'in_progress' }),
  task({ id: 'v', subject: '[V] 独立验收', status: 'pending', ready: true }),
])

check('示例文案逐字：施工 2/3 分支 · 1 待验 · 1 警告', () =>
  assert.equal(chipReport.chipText, '施工 2/3 分支 · 1 待验 · 1 警告'),
)
check('示例场景警告恰好 1 条（验收未签字）', () => {
  assert.deepEqual(codes(chipReport), ['ACCEPTANCE_NOT_SIGNED'])
})
check('示例场景 phase=verify（[V] 未完成优先）', () =>
  assert.equal(chipReport.phase, 'verify'),
)
check('只有未分类任务时 chipText =「暂无分支 · N 警告」', () => {
  const report = inspectWhaleWorks([task({ id: 'x', subject: '杂项', status: 'completed' })])
  assert.equal(report.chipText, '暂无分支 · 1 警告')
})

// ---------------------------------------------------------------------------
console.log('\n[16] phase 优先级')
// ---------------------------------------------------------------------------
check('验收已签优先于 in_progress → done', () => {
  const report = inspectWhaleWorks([
    task({ id: 'a', subject: '[A] 分支', status: 'completed' }),
    task({ id: 'a1', subject: '[A1] 叶子', status: 'in_progress' }),
    task({ id: 'v', subject: '[V] 验收', status: 'completed' }),
  ])
  assert.equal(report.phase, 'done')
})
check('等待中（pending ready）→ waiting', () => {
  const report = inspectWhaleWorks([task({ id: 'a', subject: '[A] 文件清单', status: 'pending', ready: true })])
  assert.equal(report.phase, 'waiting')
})
check('error 警告压过验收签字前的 verify', () => {
  const report = inspectWhaleWorks([
    task({ id: 'a', subject: '[A] 分支', status: 'pending', ready: false }),
    task({ id: 'a1', subject: '[A1] 工人', status: 'pending', ready: false, blockedBy: ['a'] }),
    task({ id: 'v', subject: '[V] 验收', status: 'pending', ready: true }),
  ])
  assert.equal(report.phase, 'warn')
})

// ---------------------------------------------------------------------------
console.log('\n[17] 施工模板 WHALE_WORKS_TEMPLATES')
// ---------------------------------------------------------------------------
check('模板对象已冻结', () => assert.equal(Object.isFrozen(WHALE_WORKS_TEMPLATES), true))
check('模板四项齐全且非空', () => {
  for (const key of ['brief', 'workerCard', 'acceptance', 'finalSummary']) {
    assert.equal(typeof WHALE_WORKS_TEMPLATES[key], 'string')
    assert.ok(WHALE_WORKS_TEMPLATES[key].trim().length > 0, key + ' 为空')
  }
})
check('brief 含目标/范围/验收/预算', () => {
  const text = WHALE_WORKS_TEMPLATES.brief
  for (const word of ['目标', '范围', '验收', '预算']) assert.match(text, new RegExp(word))
})
check('workerCard 含目标/输入/输出/写作用域/验收/证据/上报', () => {
  const text = WHALE_WORKS_TEMPLATES.workerCard
  for (const word of ['目标', '输入', '输出', '写作用域', '验收', '证据', '上报']) {
    assert.match(text, new RegExp(word))
  }
})
check('acceptance 含验收矩阵/复跑/签字', () => {
  const text = WHALE_WORKS_TEMPLATES.acceptance
  for (const word of ['验收矩阵', '复跑', '签字']) assert.match(text, new RegExp(word))
})
check('finalSummary 含分支/验收/返工/未决', () => {
  const text = WHALE_WORKS_TEMPLATES.finalSummary
  for (const word of ['分支', '验收', '返工', '未决']) assert.match(text, new RegExp(word))
})

// ---------------------------------------------------------------------------
console.log('')
if (failures.length > 0) {
  console.error(`失败 ${failures.length} 项，通过 ${pass} 项`)
  process.exitCode = 1
} else {
  console.log(`通过 ${pass} 项`)
}
