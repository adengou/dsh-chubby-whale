/**
 * scripts/test-story-auto.mjs —— 连播开关模块的离线回归（不联网、不要浏览器）
 *
 * 为什么需要：`chubby-story-auto` 原先被四个文件各写各的（'on' / '1' / '0'），
 * 功能上侥幸能跑，但口径不一随时会踩雷。这里把 story-auto.ts 打成 ESM，
 * 用可替换的 localStorage 桩逐条锁死「读侧兼容脏值 + 写侧统一 '1'/'0' + 不抛异常」。
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const TMP = mkdtempSync(join(tmpdir(), 'chubby-story-auto-'))
const out = join(TMP, 'story-auto.mjs')

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), '期望 ' + JSON.stringify(expected) + ' / 实际 ' + JSON.stringify(actual))
}

await build({
  entryPoints: [join(ROOT, 'src/client/story-auto.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: out,
  logLevel: 'silent',
})
const M = await import(pathToFileURL(out).href)

/** 造一个可替换的 localStorage 桩 */
function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) },
    _map: map,
  }
}

console.log('\n[1] 键名与默认值')
eq('键名固定为 chubby-story-auto', M.STORY_AUTO_KEY, 'chubby-story-auto')
globalThis.localStorage = makeStorage()
eq('键不存在 = 开（主人定的默认）', M.isStoryAutoOn(), true)

console.log('\n[2] 读侧兼容历史脏值')
const cases = [
  ['0', false], ['1', true], ['on', true], ['off', false], ['false', false],
  ['true', true], ['', true], [' 0 ', false], ['OFF', false],
]
for (const [raw, want] of cases) {
  globalThis.localStorage = makeStorage({ 'chubby-story-auto': raw })
  eq(`存量 ${JSON.stringify(raw)} → ${want ? '开' : '关'}`, M.isStoryAutoOn(), want)
}

console.log('\n[3] 写侧统一口径')
{
  const st = makeStorage()
  globalThis.localStorage = st
  eq('setStoryAuto(true) 返回 true', M.setStoryAuto(true), true)
  eq("写的是 '1'", st._map.get('chubby-story-auto'), '1')
  eq('写完读回是开', M.isStoryAutoOn(), true)

  eq('setStoryAuto(false) 返回 true', M.setStoryAuto(false), true)
  eq("写的是 '0'", st._map.get('chubby-story-auto'), '0')
  eq('写完读回是关', M.isStoryAutoOn(), false)
}

console.log('\n[4] 异常环境不抛')
{
  globalThis.localStorage = {
    getItem() { throw new Error('SecurityError') },
    setItem() { throw new Error('QuotaExceededError') },
  }
  eq('读抛错 → 按开', M.isStoryAutoOn(), true)
  eq('写抛错 → 返回 false，不抛', M.setStoryAuto(false), false)
  eq('读抛错 → 存储判为不可用', M.hasStoryAutoStorage(), false)
}
{
  const st = makeStorage()
  globalThis.localStorage = st
  eq('正常存储 → 可用', M.hasStoryAutoStorage(), true)
}
{
  const saved = globalThis.localStorage
  delete globalThis.localStorage
  eq('没有 localStorage → 按开', M.isStoryAutoOn(), true)
  eq('没有 localStorage → 写返回 false', M.setStoryAuto(true), false)
  eq('没有 localStorage → 存储判为不可用', M.hasStoryAutoStorage(), false)
  globalThis.localStorage = saved
}

rmSync(TMP, { recursive: true, force: true })
console.log('\n' + '='.repeat(52))
console.log(`通过 ${pass} 项 / 失败 ${fail} 项`)
if (fail > 0) process.exit(1)
console.log('✅ 连播开关模块回归全部通过')
