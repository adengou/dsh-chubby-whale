/**
 * scripts/test-affect.mjs —— 二维情绪模型（第二层）的离线回归
 *
 * 覆盖：环境事件增量、宿主事件前缀匹配、失败类优先、事件名冷却、未知名字不加分。
 * 用法：node scripts/test-affect.mjs（失败退出码 1）
 */

import { register } from 'node:module'

register(new URL('./ts-resolve.mjs', import.meta.url))

const { createAffectModel, faceOf } = await import('../src/client/nervous/affect.ts')

let failed = 0
function check(name, cond, extra = '') {
  if (cond) console.log('ok   ' + name)
  else { failed++; console.error('FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}
function near(a, b, eps = 1e-9) {
  return Math.abs(a - b) < eps
}

// 1) 初始值
{
  const m = createAffectModel()
  const s = m.read()
  check('初始 arousal=65', near(s.arousal, 65), String(s.arousal))
  check('初始 valence=55', near(s.valence, 55), String(s.valence))
}

// 2) 环境事件增量（activity +2/+1）
{
  const m = createAffectModel()
  m.apply({ at: 1, type: 'activity' })
  const s = m.read()
  check('activity +2/+1', near(s.arousal, 67) && near(s.valence, 56), JSON.stringify(s))
}

// 3) 宿主事件 tool/call：+0.6/+0.2
{
  const m = createAffectModel()
  m.apply({ at: 1000, type: 'host', data: { name: 'tool/call' } })
  const s = m.read()
  check('tool/call 轻加权', near(s.arousal, 65.6) && near(s.valence, 55.2), JSON.stringify(s))
}

// 4) 冷却：同名事件 1.5 秒内只算一次
{
  const m = createAffectModel()
  m.apply({ at: 1000, type: 'host', data: { name: 'tool/call' } })
  m.apply({ at: 1500, type: 'host', data: { name: 'tool/call' } })
  const s = m.read()
  check('冷却期内不重复加', near(s.arousal, 65.6), JSON.stringify(s))
  m.apply({ at: 3100, type: 'host', data: { name: 'tool/call' } })
  check('冷却过后继续加', near(m.read().arousal, 66.2), JSON.stringify(m.read()))
}

// 5) 失败类优先：tool/error 按 failure 算（+2/-2），不走 tool/ 前缀
{
  const m = createAffectModel()
  m.apply({ at: 1000, type: 'host', data: { name: 'tool/error' } })
  const s = m.read()
  check('tool/error 走失败规则', near(s.arousal, 67) && near(s.valence, 53), JSON.stringify(s))
}

// 6) 未知事件名不加分
{
  const m = createAffectModel()
  m.apply({ at: 1000, type: 'host', data: { name: 'something/else' } })
  const s = m.read()
  check('未知名字不动情绪', near(s.arousal, 65) && near(s.valence, 55), JSON.stringify(s))
}

// 7) 非 host 的未知类型不加分
{
  const m = createAffectModel()
  m.apply({ at: 1000, type: 'mood' })
  const s = m.read()
  check('mood 事件不加分', near(s.arousal, 65) && near(s.valence, 55), JSON.stringify(s))
}

// 8) faceOf 九格
check('深夜 → sleepy', faceOf({ arousal: 80, valence: 80 }, true) === 'sleepy')
check('低唤醒 → sleepy', faceOf({ arousal: 20, valence: 50 }, false) === 'sleepy')
check('低愉悦高唤醒 → sulk', faceOf({ arousal: 60, valence: 20 }, false) === 'sulk')
check('高唤醒高愉悦 → excited', faceOf({ arousal: 85, valence: 60 }, false) === 'excited')
check('高愉悦低唤醒 → shy', faceOf({ arousal: 40, valence: 80 }, false) === 'shy')
check('中间态 → idle', faceOf({ arousal: 50, valence: 50 }, false) === 'idle')

// 9) reset
{
  const m = createAffectModel()
  m.apply({ at: 1, type: 'activity' })
  m.reset()
  const s = m.read()
  check('reset 回初值', near(s.arousal, 65) && near(s.valence, 55), JSON.stringify(s))
}

if (failed) {
  console.error('失败 ' + failed + ' 项')
  process.exit(1)
}
console.log('全部通过')
