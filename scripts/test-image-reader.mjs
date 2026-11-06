/**
 * scripts/test-image-reader.mjs —— 读图的「等待上限」回归（不联网、不要浏览器）
 *
 * 背景（2026-11-07）：readFileAsDataUrl 原先没有任何超时。FileReader 在个别环境
 * （安全软件拦截、文件被占用、超大文件）会永远不回调，于是 handleFileDrop 一直 pending，
 * 气泡卡在「本鲸看看这张图…」。这里用「永不回调的 FileReader + 假定时器」把收尾行为钉死。
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = mkdtempSync(join(tmpdir(), 'chubby-image-reader-'))
const out = join(TMP, 'image.mjs')

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

await build({
  entryPoints: [join(ROOT, 'src/client/image.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: out,
  logLevel: 'silent',
})
const M = await import(pathToFileURL(out).href)

// ---- 假定时器：把 setTimeout 换成可手动触发的队列 ----
const timers = []
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
function installFakeTimers() {
  timers.length = 0
  globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms, alive: true }); return timers.length }
  globalThis.clearTimeout = (id) => { const t = timers[id - 1]; if (t) t.alive = false }
}
function fireTimer(i = 0) {
  const t = timers[i]
  if (!t) return false
  if (t.alive) t.fn()
  return true
}
function restoreTimers() {
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
}

console.log('\n[1] FileReader 永不回调 → 超时后自己收尾')
{
  installFakeTimers()
  const stats = { aborted: 0, read: 0 }
  globalThis.FileReader = class {
    constructor() { this.result = null }
    readAsDataURL() { stats.read++ /* 故意永不回调 */ }
    abort() { stats.aborted++ }
  }
  const p = M.readFileAsBase64({ name: 'x.png', type: 'image/png', size: 10 })
  let settled = 'pending'
  p.then((v) => { settled = v === '' ? 'empty' : 'value' })
  await Promise.resolve()
  ok('超时前 promise 未结算', settled === 'pending', 'state=' + settled)
  ok('挂了超时定时器', timers.length === 1 && timers[0].ms === 30000, 'timers=' + timers.length + '/ms=' + (timers[0] && timers[0].ms))
  fireTimer(0)
  await Promise.resolve(); await Promise.resolve()
  ok('超时后按失败收尾（返回空串，不抛）', settled === 'empty', 'state=' + settled)
  ok('超时主动 abort 释放文件句柄', stats.aborted === 1, 'aborted=' + stats.aborted)
  restoreTimers()
}

console.log('\n[2] 正常回调路径不受影响（回调后清掉定时器）')
{
  installFakeTimers()
  globalThis.FileReader = class {
    constructor() { this.result = null }
    readAsDataURL() {
      // 同步回调：模拟浏览器最快路径
      this.result = 'data:image/png;base64,AA=='
      if (this.onloadend) this.onloadend()
    }
    abort() { }
  }
  const v = await M.readFileAsBase64({ name: 'x.png', type: 'image/png', size: 10 })
  ok('读到内容', typeof v === 'string' && v.length > 0, 'len=' + (v || '').length)
  const aliveTimers = timers.filter((t) => t.alive).length
  ok('收尾时清掉超时定时器（不留悬挂 timer）', aliveTimers === 0, 'alive=' + aliveTimers)
  restoreTimers()
}

console.log('\n[3] FileReader 构造失败不卡住')
{
  globalThis.FileReader = class { constructor() { throw new Error('blocked') } }
  const v = await M.readFileAsBase64({ name: 'x.png', type: 'image/png', size: 10 })
  ok('构造抛错 → 返回空串', v === '', 'v=' + JSON.stringify(v))
}

rmSync(TMP, { recursive: true, force: true })
console.log('\n' + '='.repeat(48))
console.log(`通过 ${pass} 项 / 失败 ${fail} 项`)
if (fail > 0) process.exit(1)
console.log('✅ 读图等待上限回归全部通过')
