/**
 * scripts/test-dream.mjs —— 夜潜（事件流反刍）的离线回归
 *
 * 只测纯逻辑：生成条件、计数句子、同一天不重复、spoken 标记。
 * localStorage 用内存桩顶掉。用法：node scripts/test-dream.mjs（失败退出码 1）
 */

import { register } from 'node:module'

register(new URL('./ts-resolve.mjs', import.meta.url))

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)) },
  removeItem: (k) => { store.delete(k) },
  clear: () => store.clear(),
}

const { createDreamBook } = await import('../src/client/nervous/dream.ts')

let failed = 0
function check(name, cond, extra = '') {
  if (cond) console.log('ok   ' + name)
  else { failed++; console.error('FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

// 固定「现在」：本地 2026-11-12 10:00，昨天是 11-11
const NOW = new Date(2026, 10, 12, 10, 0, 0).getTime()
const YDAY = new Date(2026, 10, 11, 15, 0, 0).getTime()
const BEFORE_YDAY = new Date(2026, 10, 10, 15, 0, 0).getTime()

function ev(type, at, data) {
  return { at, type, data }
}

// 1) 事件太少不做梦
{
  store.clear()
  const book = createDreamBook()
  const few = Array.from({ length: 5 }, () => ev('activity', YDAY))
  check('少于 10 条不做梦', book.maybeDream(few, NOW) === null)
}

// 2) 有足够事件则生成，且只统计昨天
{
  store.clear()
  const book = createDreamBook()
  const events = [
    ...Array.from({ length: 15 }, () => ev('host', YDAY, { name: 'tool/call' })),
    ...Array.from({ length: 10 }, () => ev('activity', BEFORE_YDAY)), // 前天的，不该计入
  ]
  const d = book.maybeDream(events, NOW)
  check('生成一条梦', Boolean(d), String(d))
  check('梦见的是昨天', Boolean(d) && d.date === '2026-11-11', d ? d.date : '')
  check('句子带真实计数 15', Boolean(d) && d.lines.join('').indexOf('15') >= 0, d ? d.lines.join('|') : '')
  check('最多三句', Boolean(d) && d.lines.length <= 3, d ? String(d.lines.length) : '')
}

// 3) 同一天不重复生成
{
  store.clear()
  const book = createDreamBook()
  const events = Array.from({ length: 12 }, () => ev('activity', YDAY))
  book.maybeDream(events, NOW)
  check('同一天第二次返回 null', book.maybeDream(events, NOW) === null)
}

// 4) latest 取最近一条
{
  store.clear()
  const book = createDreamBook()
  book.maybeDream(Array.from({ length: 12 }, () => ev('activity', YDAY)), NOW)
  const latest = book.latest()
  check('latest 非空', Boolean(latest))
  check('latest 日期正确', Boolean(latest) && latest.date === '2026-11-11', latest ? latest.date : '')
}

// 5) spoken 标记
{
  store.clear()
  const book = createDreamBook()
  check('默认未说', book.spoken('2026-11-11') === false)
  book.markSpoken('2026-11-11')
  check('标记后已说', book.spoken('2026-11-11') === true)
  book.markSpoken('2026-11-11')
  check('重复标记不抛错', book.spoken('2026-11-11') === true)
}

// 6) 只有未知事件时也有一句兜底，且不编工具次数
{
  store.clear()
  const book = createDreamBook()
  const events = Array.from({ length: 12 }, () => ev('mood', YDAY))
  const d = book.maybeDream(events, NOW)
  check('兜底梦话', Boolean(d) && d.lines.join('').indexOf('模模糊糊') >= 0, d ? d.lines.join('|') : '')
}

if (failed) {
  console.error('失败 ' + failed + ' 项')
  process.exit(1)
}
console.log('全部通过')
