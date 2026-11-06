/**
 * scripts/test-poem-titles-retry.mjs —— 客户端诗名索引「失败后有界重试」回归
 *
 * 背景（2026-11-07 分身审计）：`ensurePoemTitles` 的 `started` 只置一次，本页一旦失败
 * 就**永不再试**；而宿主是「文件后来补上就能恢复」的设计——两边恢复能力不对等。
 * 现在：最多 3 次、每次间隔 60s 的有界重试。
 *
 * 做法：esbuild 把 poem-titles.ts 打成一个包，把 `./http.js` 换成可控桩（假 getJson +
 * 假 timeoutSignal），用假 Date.now 控制退避窗口。
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = mkdtempSync(join(tmpdir(), 'chubby-poem-titles-'))
const out = join(TMP, 'poem-titles.mjs')

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

const stubHttp = {
  name: 'stub-http',
  setup(b) {
    b.onResolve({ filter: /\/http\.js$/ }, () => ({ path: 'stub-http', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: [
        'export function timeoutSignal(ms) { return undefined }',
        'export function getJson(path, opts) {',
        '  const f = globalThis.__ptGetJson',
        '  if (typeof f === "function") return f(path, opts)',
        '  return Promise.resolve({ ok: false })',
        '}',
      ].join('\n'),
      loader: 'js',
    }))
  },
}

await build({
  entryPoints: [join(ROOT, 'src/client/poem-titles.ts')],
  bundle: true,
  format: 'esm',
  // platform= browser：Node 平台下模块会从 data/poem-titles.json 播种（测试环境专用分支），
  // 那样 cache 一开始就非空，测不到「失败后重试」；浏览器平台下 process 不存在、只走 fetch。
  platform: 'browser',
  outfile: out,
  logLevel: 'silent',
  plugins: [stubHttp],
})
// 模块初始化会读 localStorage 缓存：给一个永远空的桩，保证从「未就绪」开始
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)) },
  removeItem: (k) => { store.delete(k) },
}

// 关掉 seedFromDisk：它在 Node 下会从 data/poem-titles.json 播种（单测兜底分支），
// 那样 cache 一开始就非空，测不到「失败后重试」。只屏蔽 getBuiltinModule，不动 process 本体。
const realGetBuiltin = process.getBuiltinModule
process.getBuiltinModule = () => undefined

const M = await import(pathToFileURL(out).href)

// 假时钟
const realNow = Date.now
let now = 1_000_000
Date.now = () => now

function reset() {
  // 模块级状态无法重置，所以每个场景都重新 import 一个带查询串的副本；
  // 同时清掉 localStorage 缓存——上一个场景成功时会把标题写进 chubby-poem-titles-v1，
  // 新实例会同步命中缓存，导致「失败重试」场景根本不发请求（本测试第一版就栽在这）。
  store.clear()
  return import(pathToFileURL(out).href + '?' + Math.random())
}

console.log('\n[1] 首次失败 → 60s 内不再试 → 窗口过后重试')
{
  const mod = await reset()
  const calls = []
  globalThis.__ptGetJson = () => { calls.push(1); return Promise.resolve({ ok: false, titles: [] }) }
  mod.ensurePoemTitles()
  await Promise.resolve(); await Promise.resolve()
  ok('第一次发起请求', calls.length === 1, 'calls=' + calls.length)
  mod.ensurePoemTitles()
  await Promise.resolve()
  ok('退避窗口内不再请求', calls.length === 1, 'calls=' + calls.length)
  now += 61_000
  mod.ensurePoemTitles()
  await Promise.resolve(); await Promise.resolve()
  ok('60s 后重试一次（有界重试生效）', calls.length === 2, 'calls=' + calls.length)
}

console.log('\n[2] 最多 3 次，之后不再打扰宿主')
{
  const mod = await reset()
  const calls = []
  globalThis.__ptGetJson = () => { calls.push(1); return Promise.resolve({ ok: false }) }
  for (let i = 0; i < 5; i++) {
    mod.ensurePoemTitles()
    await Promise.resolve(); await Promise.resolve()
    now += 61_000
  }
  ok('尝试上限 3 次', calls.length === 3, 'calls=' + calls.length)
  ok('仍然降级为空表（不抛）', Array.isArray(mod.poemTitles()) && mod.poemTitles().length === 0)
}

console.log('\n[3] 成功后不再请求')
{
  const mod = await reset()
  const calls = []
  globalThis.__ptGetJson = () => { calls.push(1); return Promise.resolve({ ok: true, titles: ['静夜思', '登鹳雀楼'] }) }
  mod.ensurePoemTitles()
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  ok('成功后拿到标题', mod.poemTitles().length === 2, JSON.stringify(mod.poemTitles()))
  now += 61_000
  mod.ensurePoemTitles()
  await Promise.resolve()
  ok('已有数据就不再请求', calls.length === 1, 'calls=' + calls.length)
}

console.log('\n[4] 网络抛错同样进入退避（不是永不重试）')
{
  const mod = await reset()
  const calls = []
  globalThis.__ptGetJson = () => { calls.push(1); return Promise.reject(new Error('offline')) }
  mod.ensurePoemTitles()
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  ok('抛错不冒泡', true)
  mod.ensurePoemTitles()
  await Promise.resolve()
  ok('窗口内不重试', calls.length === 1, 'calls=' + calls.length)
  now += 61_000
  mod.ensurePoemTitles()
  await Promise.resolve(); await Promise.resolve()
  ok('窗口过后重试', calls.length === 2, 'calls=' + calls.length)
}

Date.now = realNow
delete globalThis.__ptGetJson
rmSync(TMP, { recursive: true, force: true })
console.log('\n' + '='.repeat(48))
console.log(`通过 ${pass} 项 / 失败 ${fail} 项`)
if (fail > 0) process.exit(1)
console.log('✅ 诗名索引有界重试回归全部通过')
