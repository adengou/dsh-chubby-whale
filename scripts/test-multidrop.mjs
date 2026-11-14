/**
 * scripts/test-multidrop.mjs —— 多文件拖入的「不静默丢弃」回归（不联网、不要浏览器）
 *
 * 背景（2026-11-07 分身审计 G 项）：`bindFileDropCapture` 只取 `dt.files[0]`，
 * 其余文件被静默丢掉——主人一次拖三张，只处理第一张却什么提示都没有。
 * 这里用假 window/假事件把「先提示数量、再交第一张」的行为钉住。
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = mkdtempSync(join(tmpdir(), 'chubby-multidrop-'))
const out = join(TMP, 'effects.mjs')

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
  entryPoints: [join(ROOT, 'src/client/effects.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: out,
  logLevel: 'silent',
})
const M = await import(pathToFileURL(out).href)

/** 假 window：记录监听，能手动派发 */
function makeWin() {
  const listeners = []
  return {
    listeners,
    addEventListener(type, fn, capture) { listeners.push({ type, fn, capture: !!capture }) },
    removeEventListener(type, fn, capture) {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === !!capture)
      if (i >= 0) listeners.splice(i, 1)
    },
    fire(type, ev) { for (const l of listeners.filter((x) => x.type === type)) l.fn(ev) },
  }
}

function makeDropEvent(files) {
  return {
    clientX: 10, clientY: 10,
    preventDefault() { this.prevented = (this.prevented || 0) + 1 },
    stopPropagation() { this.stopped = (this.stopped || 0) + 1 },
    dataTransfer: { files },
  }
}

console.log('\n[1] 单文件：只交文件，不提示数量')
{
  const win = makeWin()
  const got = []
  const many = []
  const dispose = M.bindFileDropCapture({ win, hitTest: () => true, onFile: (f) => got.push(f), onMany: (n) => many.push(n) })
  const one = { name: 'a.png' }
  win.fire('drop', makeDropEvent([one]))
  eq('交出一个文件', got, [one])
  eq('单文件不触发 onMany', many, [])
  dispose()
  ok('dispose 摘干净监听', win.listeners.length === 0, '剩 ' + win.listeners.length)
}

console.log('\n[2] 多文件：先提示总数，再交第一张')
{
  const win = makeWin()
  const got = []
  const many = []
  const order = []
  const files = [{ name: 'a.png' }, { name: 'b.png' }, { name: 'c.png' }]
  const dispose = M.bindFileDropCapture({
    win,
    hitTest: () => true,
    onFile: (f) => { got.push(f); order.push('file') },
    onMany: (n) => { many.push(n); order.push('many:' + n) },
  })
  win.fire('drop', makeDropEvent(files))
  eq('提示的总数是 3', many, [3])
  eq('只交第一张', got, [files[0]])
  eq('顺序是「先提示后处理」', order, ['many:3', 'file'])
  dispose()
}

console.log('\n[3] 落点未命中：什么都不做（不吞宿主的拖放）')
{
  const win = makeWin()
  const got = []
  const many = []
  const dispose = M.bindFileDropCapture({ win, hitTest: () => false, onFile: (f) => got.push(f), onMany: (n) => many.push(n) })
  const ev = makeDropEvent([{ name: 'a' }, { name: 'b' }])
  win.fire('drop', ev)
  eq('不交文件', got, [])
  eq('不提示', many, [])
  ok('也不阻止默认行为', !ev.prevented && !ev.stopped)
  dispose()
}

console.log('\n[4] 没有 dataTransfer 也不炸')
{
  const win = makeWin()
  const got = []
  const dispose = M.bindFileDropCapture({ win, hitTest: () => true, onFile: (f) => got.push(f) })
  win.fire('drop', { clientX: 1, clientY: 1, preventDefault() { }, stopPropagation() { } })
  eq('交出 undefined（交给上层判空）', got, [undefined])
  dispose()
}

console.log('\n[5] DOM 目标兜底：坐标判定放过、落点在鱼身上仍接住')
{
  const doc = {
    listeners: [],
    addEventListener(type, fn, capture) { this.listeners.push({ type, fn, capture: !!capture }) },
    removeEventListener(type, fn, capture) { const i = this.listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === !!capture); if (i >= 0) this.listeners.splice(i, 1) },
    fire(type, ev) { for (const l of this.listeners.filter((x) => x.type === type)) l.fn(ev) },
  }
  const win = makeWin()
  win.document = doc
  const got = []
  const fish = { id: 'fish' }
  const dispose = M.bindFileDropCapture({
    win,
    hitTest: () => false,
    targetTest: (t) => t === fish,
    onFile: (f) => got.push(f),
  })
  const one = { name: 'a.png' }
  const ev = makeDropEvent([one]); ev.target = fish
  win.fire('dragover', ev)
  ok('window 捕获按 targetTest 放行 dragover', ev.prevented >= 1)
  win.fire('drop', ev)
  eq('window 捕获按 targetTest 接住 drop', got, [one])
  const ev2 = makeDropEvent([one]); ev2.target = fish
  doc.fire('dragover', ev2)
  ok('document 捕获兜底 dragover', ev2.prevented >= 1)
  doc.fire('drop', ev2)
  eq('document 捕获兜底接住 drop', got, [one, one])
  dispose()
  ok('dispose 摘掉 document 监听', doc.listeners.length === 0, '剩 ' + doc.listeners.length)
}

rmSync(TMP, { recursive: true, force: true })
console.log('\n' + '='.repeat(48))
console.log(`通过 ${pass} 项 / 失败 ${fail} 项`)
if (fail > 0) process.exit(1)
console.log('✅ 多文件拖入提示回归全部通过')
