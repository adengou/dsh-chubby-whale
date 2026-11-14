/**
 * scripts/test-nervous.mjs —— 神经系统模块的离线回归
 *
 * 只测「挂/摘/开关」这三件事：浏览器事件与定时器用桩顶掉，不起真实计时。
 * 用法：node scripts/test-nervous.mjs（失败退出码 1）
 */

import { register } from 'node:module'

register(new URL('./ts-resolve.mjs', import.meta.url))

// ---- 最小浏览器桩（模块加载前就位） ----
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)) },
  removeItem: (k) => { store.delete(k) },
  clear: () => store.clear(),
}
globalThis.window = {
  addEventListener() { },
  removeEventListener() { },
}
globalThis.document = {
  visibilityState: 'visible',
  addEventListener() { },
  removeEventListener() { },
}

const { attachNervous, detachNervous, nervousEnabled, setNervousEnabled, nervousEnergy, noteWork } = await import('../src/client/nervous/index.ts')

let failed = 0
function check(name, cond, extra = '') {
  if (cond) console.log('ok   ' + name)
  else { failed++; console.error('FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

// 1) 默认开
store.clear()
check('默认开启', nervousEnabled() === true)

// 2) 开关落盘
setNervousEnabled(false)
check('关闭落盘', nervousEnabled() === false && store.get('chubby-nervous') === 'off')
setNervousEnabled(true)
check('重新开启', nervousEnabled() === true)

// 3) attach 幂等 + 能量可读
const moods = []
const persona = {
  state: { mood: 'idle' },
  setMood: (m) => { moods.push(m); persona.state.mood = m },
}
const detach1 = attachNervous({ persona, bubble: () => { } })
const detach2 = attachNervous({ persona, bubble: () => { } })
check('attach 返回函数', typeof detach1 === 'function')
check('重复 attach 幂等', detach1 === detach2)
check('能量是数字', typeof nervousEnergy() === 'number', String(nervousEnergy()))
check('初始能量在 0-100', nervousEnergy() >= 0 && nervousEnergy() <= 100)

// 4) noteWork 不抛错（打点入口）
{
  let threw = false
  try { noteWork('chat') } catch (e) { threw = true }
  check('noteWork 不抛错', threw === false)
}

// 5) detach 后可重复调用且能量清空
detachNervous()
detachNervous()
check('detach 后能量为 null', nervousEnergy() === null)

if (failed) {
  console.error('失败 ' + failed + ' 项')
  process.exit(1)
}
console.log('全部通过')
