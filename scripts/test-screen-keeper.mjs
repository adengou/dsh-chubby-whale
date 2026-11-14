/**
 * scripts/test-screen-keeper.mjs —— 保持亮屏（Screen Wake Lock）纯逻辑回归
 *
 * 不访问真实 navigator / document：用 fake 对象验证
 *   申请、幂等、释放、重新申请、页面隐藏/可见、失败降级、dispose、不支持环境。
 */

import assert from 'node:assert/strict'
import { createScreenKeeper } from '../src/client/screen-keeper.ts'

let pass = 0
const failures = []
function check(name, fn) {
  try { fn(); pass++; console.log('  ✅ ' + name) } catch (err) {
    failures.push({ name, err })
    console.log('  ❌ ' + name)
    console.log('     ' + String((err && err.message) || err).replace(/\n/g, '\n     '))
  }
}
const tick = () => new Promise((r) => setTimeout(r, 0))
async function acheck(name, fn) {
  try { await fn(); pass++; console.log('  ✅ ' + name) } catch (err) {
    failures.push({ name, err })
    console.log('  ❌ ' + name)
    console.log('     ' + String((err && err.message) || err).replace(/\n/g, '\n     '))
  }
}

function fakeSentinel() {
  const listeners = new Map()
  const s = {
    released: false,
    releaseCalls: 0,
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn) },
    removeEventListener(type, fn) { const a = listeners.get(type) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1) },
    fireRelease() { s.released = true; for (const fn of listeners.get('release') || []) fn() },
    async release() { s.releaseCalls++; s.released = true; s.fireRelease() },
  }
  return s
}

function fakeDoc(visible = true) {
  const listeners = new Map()
  return {
    visibilityState: visible ? 'visible' : 'hidden',
    hidden: !visible,
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn) },
    removeEventListener(type, fn) { const a = listeners.get(type) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1) },
    dispatch(type) { for (const fn of listeners.get(type) || []) fn() },
    count(type) { return (listeners.get(type) || []).length },
  }
}

console.log('[A] 不支持环境安静降级')
check('没有 navigator.wakeLock → isSupported=false', () => {
  const k = createScreenKeeper({ nav: {}, doc: fakeDoc() })
  assert.equal(k.isSupported(), false)
})
await acheck('开启不抛错、不持有锁', async () => {
  const k = createScreenKeeper({ nav: {}, doc: fakeDoc() })
  k.setEnabled(true)
  await tick()
  assert.equal(k.isHeld(), false)
  k.dispose()
})

console.log('\n[B] 申请 / 幂等 / 释放 / 重开')
await acheck('setEnabled(true) 申请 screen，只申请一次', async () => {
  let requests = 0
  const nav = { wakeLock: { request: async () => { requests++; return fakeSentinel() } } }
  const k = createScreenKeeper({ nav, doc: fakeDoc() })
  k.setEnabled(true)
  k.setEnabled(true)
  await tick()
  assert.equal(requests, 1)
  assert.equal(k.isHeld(), true)
  k.dispose()
})
await acheck('setEnabled(false) 释放锁', async () => {
  const sent = fakeSentinel()
  const nav = { wakeLock: { request: async () => sent } }
  const k = createScreenKeeper({ nav, doc: fakeDoc() })
  k.setEnabled(true)
  await tick()
  k.setEnabled(false)
  await tick()
  assert.equal(sent.releaseCalls, 1)
  assert.equal(k.isHeld(), false)
  k.dispose()
})
await acheck('关闭后再开启重新申请', async () => {
  let requests = 0
  const nav = { wakeLock: { request: async () => { requests++; return fakeSentinel() } } }
  const k = createScreenKeeper({ nav, doc: fakeDoc() })
  k.setEnabled(true)
  await tick()
  k.setEnabled(false)
  k.setEnabled(true)
  await tick()
  assert.equal(requests, 2)
  k.dispose()
})

console.log('\n[C] 页面隐藏 / 可见')
await acheck('隐藏时释放，回到可见且开关为开 → 重新申请', async () => {
  let requests = 0
  const doc = fakeDoc(true)
  const nav = { wakeLock: { request: async () => { requests++; return fakeSentinel() } } }
  const k = createScreenKeeper({ nav, doc })
  k.setEnabled(true)
  await tick()
  doc.visibilityState = 'hidden'; doc.hidden = true; doc.dispatch('visibilitychange')
  await tick()
  assert.equal(k.isHeld(), false)
  doc.visibilityState = 'visible'; doc.hidden = false; doc.dispatch('visibilitychange')
  await tick()
  assert.equal(k.isHeld(), true)
  assert.equal(requests, 2)
  assert.equal(doc.count('visibilitychange'), 1)
  k.dispose()
})
await acheck('dispose 摘掉 visibility 监听并释放锁', async () => {
  const sent = fakeSentinel()
  const doc = fakeDoc()
  const nav = { wakeLock: { request: async () => sent } }
  const k = createScreenKeeper({ nav, doc })
  k.setEnabled(true)
  await tick()
  k.dispose()
  await tick()
  assert.equal(doc.count('visibilitychange'), 0)
  assert.equal(sent.releaseCalls, 1)
  k.setEnabled(true)
  await tick()
  assert.equal(k.isHeld(), false)
})

console.log('\n[D] 失败 / 外部释放')
await acheck('request 拒绝 → onError，且不抛错', async () => {
  const reasons = []
  const nav = { wakeLock: { request: async () => { const e = new Error('denied'); e.name = 'NotAllowedError'; throw e } } }
  const k = createScreenKeeper({ nav, doc: fakeDoc(), onError: (r) => reasons.push(r) })
  k.setEnabled(true)
  await tick()
  assert.equal(k.isHeld(), false)
  assert.equal(reasons[0], 'NotAllowedError')
  k.dispose()
})
await acheck('浏览器外部释放（release 事件）→ isHeld 变 false', async () => {
  const sent = fakeSentinel()
  const nav = { wakeLock: { request: async () => sent } }
  const k = createScreenKeeper({ nav, doc: fakeDoc() })
  k.setEnabled(true)
  await tick()
  assert.equal(k.isHeld(), true)
  sent.fireRelease()
  assert.equal(k.isHeld(), false)
  k.dispose()
})

console.log('\n[E] 源码纪律')
await acheck('不 import 第三方 / 不写浏览器存储 / 不联网', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/client/screen-keeper.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /from\s+['"][^.'"]/)
  assert.doesNotMatch(src, /localStorage|fetch\(|XMLHttpRequest|http:\/\//)
})

console.log('\n' + '='.repeat(48))
console.log('通过 ' + pass + ' 项 / 失败 ' + failures.length + ' 项')
if (failures.length) {
  for (const f of failures) console.log('  - ' + f.name + ': ' + String((f.err && f.err.message) || f.err))
  process.exit(1)
}
console.log('✅ 保持亮屏回归通过')
