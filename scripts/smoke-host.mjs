/**
 * scripts/smoke-host.mjs —— 宿主产物冒烟：把 dist 下 48 个模块全部 import 一遍
 *
 * 为什么需要：宿主代码只在 dsh web 启动时加载，改坏了要等重启才会炸；
 * 而重启是主人明令禁止的。这里用 Node 直接把每个产物模块 import 一次：
 *   · 相对路径写错 / 文件缺失
 *   · 顶层代码抛异常（例如引用了不存在的变量、循环依赖炸栈）
 *   · index.js 的插件导出形状（inject / Config / apply）
 * 都能在不重启的情况下提前发现。
 *
 * 用法：node scripts/smoke-host.mjs
 * 退出码：0=通过；1=失败
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DIST = 'dist'
if (!existsSync(DIST)) {
  console.log('  ⏭ 没有 dist（先 npm run build），跳过宿主冒烟')
  process.exit(0)
}

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const q = join(dir, n)
    if (statSync(q).isDirectory()) walk(q, out)
    else if (n.endsWith('.js')) out.push(q)
  }
  return out
}

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

// client.js 是浏览器 IIFE 产物（引用 window），Node 里不能直接 import，单独跳过
const files = walk(DIST).filter((f) => !f.endsWith('client.js'))
const failures = []
let loaded = 0
for (const f of files) {
  try {
    await import(pathToFileURL(resolve(f)).href)
    loaded++
  } catch (err) {
    failures.push(relative('.', f).replace(/\\/g, '/') + ' :: ' + String((err && err.message) || err).slice(0, 160))
  }
}
ok('全部宿主模块可加载', failures.length === 0, loaded + '/' + files.length)
for (const f of failures.slice(0, 12)) console.log('    ❌ ' + f)

// 入口导出形状：dsh 插件靠这几个字段装配
try {
  const entry = await import(pathToFileURL(resolve(DIST, 'index.js')).href)
  ok('index.js 导出 inject 数组', Array.isArray(entry.inject), Array.isArray(entry.inject) ? entry.inject.join(',') : typeof entry.inject)
  ok('index.js 导出 Config', !!entry.Config && typeof entry.Config === 'object')
  ok('index.js 导出 apply 函数', typeof entry.apply === 'function')
  ok('inject 含 webServer', Array.isArray(entry.inject) && entry.inject.indexOf('webServer') >= 0)
} catch (err) {
  ok('能加载 dist/index.js', false, String((err && err.message) || err))
}

// ---- store 功能冒烟：真建一个临时数据目录，读写一遍 ----
try {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { createStore } = await import('../dist/host/store.js')
  const { createCache } = await import('../dist/host/cache.js')
  const dir = mkdtempSync(join(tmpdir(), 'chubby-host-smoke-'))
  const store = createStore(dir)

  store.saveState({ intimacy: 7 })
  ok('store 状态读写', store.loadState().intimacy === 7)

  store.saveState({ intimacy: 100 })
  ok('store 状态覆盖', store.loadState().intimacy === 100)

  store.appendTurns('主人', '本鲸在呢')
  const h = store.loadHistory()
  ok('store 记忆追加一轮', h.length === 2 && h[0].role === 'user' && h[1].role === 'assistant')

  const g0 = store.addExp(5, 'chat')
  ok('store 成长加经验', g0 && Number(g0.exp) > 0, 'exp=' + (g0 && g0.exp))

  const f0 = store.addTokens('chat', 10)
  ok('store 鱼粮累加', f0 && Number(f0.chatTokens) === 10 && Number(f0.totalTokens) === 10)
  ok('store 今日 token 也累加（此前永远是 0）', f0 && Number(f0.dayTokens) === 10, 'dayTokens=' + (f0 && f0.dayTokens))

  const pet = store.feedPet()
  ok('store 喂食', pet && Number(pet.feeds) === 1 && pet.mood === 'happy')

  store.saveStoryProgress({ '甲|0': true })
  ok('store 说书进度读写', store.loadStoryProgress()['甲|0'] === true)

  const r = store.addReminder('喝水', new Date(Date.now() + 60000).toISOString(), 0)
  ok('store 提醒新增', r && r.id && store.loadReminders().length === 1)
  if (r && r.id) { store.removeReminder(r.id); ok('store 提醒删除', store.loadReminders().length === 0) }

  // 缓存：JSON 与二进制都能存取（Buffer 不被降级）
  const cache = createCache({ dir: join(dir, 'cache'), memBytes: 1024 * 1024 })
  await cache.setJson('k', { a: 1 })
  const got = await cache.getJson('k', 'json')
  ok('cache JSON 读写', got && got.a === 1)
  const mp3 = Buffer.from('MP3')
  await cache.setJson('b', mp3, 'mp3')
  const back = await cache.getJson('b', 'mp3')
  ok('cache 二进制仍是 Buffer', Buffer.isBuffer(back) && back.equals(mp3))
  ok('cache 条目计数', (await cache.count()) >= 1)

  rmSync(dir, { recursive: true, force: true })
} catch (err) {
  ok('store 功能冒烟', false, String((err && err.message) || err))
}

console.log('\n  通过 ' + pass + ' 项，失败 ' + fail + ' 项')
if (fail > 0) process.exit(1)
