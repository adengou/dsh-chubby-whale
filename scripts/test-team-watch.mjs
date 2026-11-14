/**
 * scripts/test-team-watch.mjs —— 鲸鱼看板编排层回归（离线、无 DOM）
 *
 * 只验证：订阅 → 摘要 → 展示意图 → surface；不碰真实 React/DSH。
 */

import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = mkdtempSync(join(tmpdir(), 'chubby-team-watch-'))
const BUNDLE = join(TMP, 'team-watch.mjs')
await build({
  entryPoints: [join(ROOT, 'src/client/team-watch.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: BUNDLE,
  logLevel: 'silent',
})
const { createTeamWatch } = await import(pathToFileURL(BUNDLE).href)

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

function task(over = {}) {
  return {
    id: 'task-1',
    revision: 1,
    subject: '写测试',
    description: '不应进入气泡',
    status: 'pending',
    blockedBy: [],
    writeScopes: [],
    ready: true,
    writeScopeWarnings: [],
    ...over,
  }
}

function snapshot(tasks, over = {}) {
  return {
    available: true,
    enabled: true,
    tasks,
    approvals: [],
    capturedAt: 1,
    ...over,
  }
}

function makeSource() {
  const listeners = new Set()
  return {
    listeners,
    subscribe(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    emit(value) { for (const cb of [...listeners]) cb(value) },
  }
}

function makeSurface() {
  const calls = []
  return {
    calls,
    apply(p) { calls.push(p) },
    dispose() { },
  }
}

console.log('\n[1] 初始快照 → ambient')
{
  const source = makeSource()
  const surface = makeSurface()
  let now = 1000
  const watch = createTeamWatch({ source, surface, now: () => now, cooldownMs: 0 })
  watch.start()
  source.emit(snapshot([task({ status: 'in_progress', ready: false })]))
  const p = surface.calls.at(-1)
  ok('交给 surface 一条展示意图', p && p.ambient && p.ambient.text === '1 个任务：1 个在做', JSON.stringify(p))
}

console.log('\n[2] 同 fingerprint 不重复')
{
  const source = makeSource()
  const surface = makeSurface()
  const watch = createTeamWatch({ source, surface, now: () => 2000, cooldownMs: 0 })
  watch.start()
  source.emit(snapshot([task({ status: 'in_progress' })]))
  const n1 = surface.calls.length
  source.emit(snapshot([task({ status: 'in_progress' })]))
  ok('相同状态不再 apply', surface.calls.length === n1, 'calls=' + surface.calls.length)
}

console.log('\n[3] 审批 → alert；关闭开关 → 隐藏')
{
  const source = makeSource()
  const surface = makeSurface()
  let enabled = true
  const watch = createTeamWatch({ source, surface, now: () => 3000, enabled: () => enabled, cooldownMs: 0 })
  watch.start()
  source.emit(snapshot([task({ status: 'in_progress' })], {
    approvals: [{ id: 'ap-1', toolName: 'shell', at: 1, sessionId: 's1' }],
  }))
  const p = surface.calls.at(-1)
  ok('审批提醒文案', p && p.alert && p.alert.text === '有个子 Agent 在等你批东西', JSON.stringify(p))
  ok('不泄漏工具名', p && !String(p.alert.text).includes('shell'))

  enabled = false
  source.emit(snapshot([]))
  ok('关闭开关后 apply(null)', surface.calls.at(-1) === null)
}

console.log('\n[4] stop 取消订阅并隐藏')
{
  const source = makeSource()
  const surface = makeSurface()
  const watch = createTeamWatch({ source, surface, now: () => 4000 })
  watch.start()
  source.emit(snapshot([task({ status: 'completed' })]))
  watch.stop()
  ok('stop 后退订', source.listeners.size === 0, 'listeners=' + source.listeners.size)
  ok('stop 后隐藏', surface.calls.at(-1) === null)
}

console.log('\n[5] 全部完成只庆祝一次（真实 done 转变）')
{
  const source = makeSource()
  const surface = makeSurface()
  const watch = createTeamWatch({ source, surface, now: () => 5000, cooldownMs: 0 })
  watch.start()
  source.emit(snapshot([task({ status: 'in_progress' })]))
  source.emit(snapshot([task({ status: 'completed' })]))
  const doneCall = surface.calls.find((p) => p && p.alert && p.alert.text === '鲸群回巢了')
  ok('完成提醒出现', !!doneCall, JSON.stringify(surface.calls))
  const before = surface.calls.length
  source.emit(snapshot([task({ status: 'completed' })]))
  const after = surface.calls.length
  ok('重复 done 不再提醒', after === before, before + ' → ' + after)
}

console.log('\n' + '='.repeat(48))
try { rmSync(TMP, { recursive: true, force: true }) } catch (e) { }
console.log(`通过 ${pass} 项 / 失败 ${fail} 项`)
if (fail > 0) process.exit(1)
console.log('✅ 鲸鱼看板编排层体检通过')
