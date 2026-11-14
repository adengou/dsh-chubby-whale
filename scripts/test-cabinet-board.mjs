/**
 * scripts/test-cabinet-board.mjs —— 推演任务板进度只读检查器
 *
 * 只测纯函数：前缀解析、四角色统计、MEMO 依赖、缺角色提示、普通任务板不受影响。
 * 运行：node scripts/test-cabinet-board.mjs
 */

import assert from 'node:assert/strict'
import { inspectCabinetBoard } from '../src/shared/cabinet-board.ts'

let pass = 0
const failures = []
function check(name, fn) {
  try { fn(); pass++; console.log('  ✅ ' + name) } catch (err) {
    failures.push({ name, err })
    console.log('  ❌ ' + name)
    console.log('     ' + String((err && err.message) || err).replace(/\n/g, '\n     '))
  }
}
function task(id, subject, status = 'pending', revision = 1, extra = {}) {
  return { id, revision, subject, description: '', status, blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [], ...extra }
}

console.log('[1] 空 / 普通任务板')
check('空任务板：present=false、空文案', () => {
  const r = inspectCabinetBoard([])
  assert.equal(r.present, false)
  assert.equal(r.chipText, '')
  assert.equal(r.phase, 'idle')
})
check('普通任务板：不误判为推演', () => {
  const r = inspectCabinetBoard([task('t1', '普通任务'), task('t2', '[A] 文件清单')])
  assert.equal(r.present, false)
  assert.equal(r.chipText, '')
})

console.log('[2] 四角色统计')
check('四张角色任务都在，两个完成一个在做', () => {
  const r = inspectCabinetBoard([
    task('1', '[FIN] 财务视角', 'completed'),
    task('2', '[RISK] 风险视角', 'completed'),
    task('3', '[CUST] 客户视角', 'in_progress'),
    task('4', '[OPP] 反方视角', 'pending'),
  ])
  assert.equal(r.present, true)
  assert.equal(r.done, 2)
  assert.equal(r.active, 1)
  assert.equal(r.waiting, 1)
  assert.equal(r.memo, 'none')
  assert.match(r.chipText, /^推演 2\/4/)
})
check('中文全角括号也认', () => {
  const r = inspectCabinetBoard([task('1', '【FIN】财务视角', 'completed')])
  assert.equal(r.present, true)
  assert.equal(r.done, 1)
})
check('大小写不敏感', () => {
  const r = inspectCabinetBoard([task('1', '[fin] 财务视角', 'completed')])
  assert.equal(r.done, 1)
})
check('deleted 忽略', () => {
  const r = inspectCabinetBoard([task('1', '[FIN] 财务视角', 'deleted')])
  assert.equal(r.present, false)
})

console.log('[3] 汇总任务')
check('四角色完成但 MEMO pending → 待汇总', () => {
  const r = inspectCabinetBoard([
    task('1', '[FIN] 财务视角', 'completed'),
    task('2', '[RISK] 风险视角', 'completed'),
    task('3', '[CUST] 客户视角', 'completed'),
    task('4', '[OPP] 反方视角', 'completed'),
    task('5', '[MEMO] 汇总', 'in_progress'),
  ])
  assert.equal(r.memo, 'pending')
  assert.equal(r.phase, 'memo')
  assert.equal(r.chipText, '推演 4/4 · 待汇总')
})
check('MEMO 完成 → 推演完成', () => {
  const r = inspectCabinetBoard([
    task('1', '[FIN] 财务视角', 'completed'),
    task('2', '[RISK] 风险视角', 'completed'),
    task('3', '[CUST] 客户视角', 'completed'),
    task('4', '[OPP] 反方视角', 'completed'),
    task('5', '[MEMO] 汇总', 'completed'),
  ])
  assert.equal(r.phase, 'done')
  assert.equal(r.chipText, '推演完成')
})
check('同前缀取 revision 更高的任务', () => {
  const r = inspectCabinetBoard([
    task('1', '[FIN] 财务视角', 'pending', 1),
    task('2', '[FIN] 财务视角', 'completed', 2),
  ])
  assert.equal(r.done, 1)
})

console.log('[4] 缺角色 / 进行中')
check('只建了两个角色 → 缺 2、仍在做', () => {
  const r = inspectCabinetBoard([
    task('1', '[FIN] 财务视角', 'in_progress'),
    task('2', '[RISK] 风险视角', 'pending'),
  ])
  assert.equal(r.missing.length, 2)
  assert.equal(r.phase, 'working')
  assert.match(r.chipText, /缺 2/)
  assert.match(r.chipText, /1 在做/)
})
check('有在做 → working', () => {
  const r = inspectCabinetBoard([
    task('1', '[FIN] 财务视角', 'completed'),
    task('2', '[RISK] 风险视角', 'in_progress'),
  ])
  assert.equal(r.phase, 'working')
  assert.match(r.chipText, /1 在做/)
})
check('四角色 pending + MEMO pending → 待开工', () => {
  const r = inspectCabinetBoard([
    task('1', '[FIN] 财务视角'),
    task('2', '[RISK] 风险视角'),
    task('3', '[CUST] 客户视角'),
    task('4', '[OPP] 反方视角'),
    task('5', '[MEMO] 汇总'),
  ])
  assert.equal(r.phase, 'waiting')
  assert.match(r.chipText, /待开工/)
})

console.log('\n通过 ' + pass + ' 项 / 失败 ' + failures.length + ' 项')
if (failures.length) {
  for (const f of failures) console.log('  - ' + f.name + ': ' + String((f.err && f.err.message) || f.err))
  process.exit(1)
}
console.log('✅ 推演任务板检查器通过')
