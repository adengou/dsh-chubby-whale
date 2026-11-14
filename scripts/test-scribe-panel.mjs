/**
 * scripts/test-scribe-panel.mjs —— 「小鲸代笔」浮动面板回归（fake DOM，离线、不点真浏览器）
 *
 * 2026-11-14 主人 7 条改版 + 保存交互二次选择去掉后的面板：
 *   正文 = 可编辑 textarea；话筒图标开始/暂停；工具栏「保存类型」下拉（TXT/DOCX，默认 DOCX）；
 *   点「保存」直接按当前类型保存（不再弹选择气泡）；清空；关闭；
 *   没有编号/列表、没有停止按钮、没有 stopped 状态。
 *
 * 覆盖：
 *   · 没有 document 时整体 no-op（Node 环境不会炸）；
 *   · 打开/关闭/销毁、Esc 关闭、destroy 之后 open 失效；
 *   · 正文 textarea 可编辑：input → onTextChange；update 不覆盖用户正在编辑的内容；
 *   · 状态行（待开始/正在听写/已暂停 · 本面板 + 已接 N 句）、话筒图标 🎤/●（绿色）；
 *   · 工具栏「保存类型」下拉：默认 DOCX、可切 TXT、保存直接按当前类型回调；
 *     没有保存类型气泡（DOM 里不存在 popover / 两个并排保存选项）；保存成功/失败提示；正文保留；
 *   · 清空/关闭回调；标题栏拖动；无「停止」按钮/编号/列表；
 *   · 源码纪律：不抢焦点（不调 .focus）、不写 localStorage、不 fetch、不 import React。
 *
 * 做法：自己搭最小 FakeDocument/FakeElement（只实现面板用到的 DOM 方法），
 * 不依赖 jsdom，也不启动浏览器。
 *
 * 用法：node scripts/test-scribe-panel.mjs   （全过退出码 0）
 */

import { register } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

register(new URL('./ts-resolve.mjs', import.meta.url))

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.error('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
const show = (v) => (v === null || typeof v === 'undefined' ? String(v) : JSON.stringify(v))

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { createScribePanel } = await import('../src/client/scribe-panel.ts')

// ======================================================================
// 最小 fake DOM：面板只用 createElement / appendChild / removeChild / addEventListener /
// setAttribute / style / textContent / value / disabled / getBoundingClientRect 这几样
// ======================================================================
class FakeElement {
  constructor(tag, doc) {
    this.tagName = String(tag || 'div').toUpperCase()
    this._doc = doc
    this.style = {}
    this.attrs = {}
    this.children = []
    this.parentNode = null
    this.textContent = ''
    this.value = ''
    this.disabled = false
    this.type = ''
    this.title = ''
    this.placeholder = ''
    this.listeners = {}
  }
  setAttribute(k, v) { this.attrs[String(k)] = String(v) }
  getAttribute(k) { const v = this.attrs[String(k)]; return v === undefined ? null : v }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child }
  removeChild(child) {
    const i = this.children.indexOf(child)
    if (i >= 0) { this.children.splice(i, 1); child.parentNode = null }
    return child
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this) }
  addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn) }
  removeEventListener(type, fn) {
    const a = this.listeners[type]
    if (!a) return
    const i = a.indexOf(fn)
    if (i >= 0) a.splice(i, 1)
  }
  fire(type, ev = {}) {
    const a = (this.listeners[type] || []).slice()
    for (const fn of a) fn(Object.assign({ target: this, currentTarget: this, preventDefault() { }, stopPropagation() { } }, ev))
  }
  click() { this.fire('click') }
  getBoundingClientRect() { return { left: 0, top: 0, width: 430, height: 560 } }
  /** 递归找 data-role */
  query(role) {
    if (this.attrs['data-role'] === role) return this
    for (const c of this.children) {
      if (c && typeof c.query === 'function') { const hit = c.query(role); if (hit) return hit }
    }
    return null
  }
  /** 递归取全部文本（含子节点） */
  text() {
    let out = this.textContent || ''
    for (const c of this.children) out += (c && typeof c.text === 'function') ? c.text() : ''
    return out
  }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement('body', this)
    this.defaultView = { innerWidth: 1024, innerHeight: 768 }
    this.documentElement = { clientWidth: 1024, clientHeight: 768 }
    this.activeElement = null
    this.listeners = {}
  }
  createElement(tag) { return new FakeElement(tag, this) }
  addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn) }
  removeEventListener(type, fn) {
    const a = this.listeners[type]
    if (!a) return
    const i = a.indexOf(fn)
    if (i >= 0) a.splice(i, 1)
  }
  fire(type, ev = {}) {
    for (const fn of (this.listeners[type] || []).slice()) fn(Object.assign({ preventDefault() { }, target: null }, ev))
  }
  listenerCount(type) { return (this.listeners[type] || []).length }
}

/** 建一块面板 + 记录回调的辅助（onSave 记录 kind+正文） */
function setup(overrides = {}) {
  const doc = new FakeDocument()
  const calls = { mic: 0, text: [], clear: 0, close: 0, saves: [] }
  const panel = createScribePanel(Object.assign({
    doc,
    onMic: () => { calls.mic++ },
    onTextChange: (value) => { calls.text.push(value) },
    onClear: () => { calls.clear++ },
    onClose: () => { calls.close++ },
    onSave: (kind, text) => {
      calls.saves.push([kind, text])
      return { ok: true, name: '小鲸代笔.' + kind }
    },
  }, overrides))
  return { doc, panel, calls }
}
function openRoot(setupResult) {
  setupResult.panel.open()
  return setupResult.doc.body.children[0]
}

// ======================================================================
console.log('\n[A] 没有 document：整体 no-op，不抛错')
{
  let threw = null
  try {
    const panel = createScribePanel({})
    panel.open()
    panel.update({ status: 'active', text: '不会显示' })
    panel.notice('提示')
    panel.close()
    panel.destroy()
    ok('无 doc 时 isOpen 恒为 false', panel.isOpen() === false)
  } catch (e) { threw = e }
  ok('无 doc 时 open/update/close/destroy 都不抛错', threw === null, String(threw))
}

// ======================================================================
console.log('\n[B] 打开面板：可编辑正文、话筒、保存类型下拉、单保存按钮、无停止/编号/列表')
{
  const ctx = setup()
  const root = openRoot(ctx)
  ok('open 后 isOpen=true 且挂到 body', ctx.panel.isOpen() === true && ctx.doc.body.children.length === 1)
  ok('根节点 data-role=scribe-panel', root.getAttribute('data-role') === 'scribe-panel')
  const textarea = root.query('scribe-textarea')
  ok('正文是 textarea（可编辑元素）', !!textarea && textarea.tagName === 'TEXTAREA')
  ok('textarea 有占位提示与 aria-label', String(textarea.placeholder).length > 0 && !!textarea.attrs['aria-label'])
  ok('有话筒按钮 / 保存类型下拉 / 清空 / 关闭', !!root.query('scribe-mic') && !!root.query('scribe-save-type') && !!root.query('scribe-clear') && !!root.query('scribe-close'))
  ok('保存只有一个按钮（没有并排的保存 TXT/DOCX 按钮）', !!root.query('scribe-save') && root.query('scribe-save').textContent === '保存' && !root.query('scribe-save-txt') && !root.query('scribe-save-docx'))
  ok('没有保存类型气泡（popover DOM 已删除）', root.query('scribe-save-popover') === null)
  ok('没有「停止」按钮（角色 scribe-stop 不存在）', root.query('scribe-stop') === null)
  ok('没有暂停文字按钮（暂停由话筒图标承担）', root.query('scribe-pause') === null)
  ok('没有编号/句子列表 DOM（scribe-list / scribe-sentence 不存在）', root.query('scribe-list') === null && root.query('scribe-sentence') === null && root.query('scribe-sentence-no') === null)
  ok('状态行写「本面板」（无第三方窗口注入）', root.query('scribe-status').text().indexOf('本面板') >= 0, root.query('scribe-status').text())
  ok('初始状态为待开始', root.query('scribe-status').text().indexOf('待开始') >= 0)

  const saveType = root.query('scribe-save-type')
  ok('保存类型是 select 下拉', !!saveType && saveType.tagName === 'SELECT')
  ok('下拉旁有「保存类型」文字标签', !!root.query('scribe-save-type-label') && root.query('scribe-save-type-label').textContent === '保存类型')
  ok('下拉默认 DOCX', saveType.value === 'docx', show(saveType.value))
  const optionTexts = (saveType.children || []).map((o) => o.textContent)
  ok('下拉两项 = DOCX 文档 / TXT 文档', optionTexts.join('|') === 'DOCX 文档|TXT 文档', optionTexts.join('|'))
  ok('下拉有 aria-label=保存类型', saveType.attrs['aria-label'] === '保存类型')
}

// ======================================================================
console.log('\n[C] 正文可编辑：input → onTextChange；update 不覆盖用户输入')
{
  const ctx = setup()
  const root = openRoot(ctx)
  const textarea = root.query('scribe-textarea')
  textarea.value = '用户自己打的一句话，还能改标点。'
  textarea.fire('input')
  ok('textarea 输入触发 onTextChange（原文交回）', ctx.calls.text.length === 1 && ctx.calls.text[0] === textarea.value, show(ctx.calls.text[0]))
  ctx.panel.update({ status: 'active', text: textarea.value })
  ok('update 传入相同正文时不覆盖 textarea（不打断编辑）', textarea.value === '用户自己打的一句话，还能改标点。')
  ctx.panel.update({ status: 'active', text: '第一段。\n\n语音接进来的第二段。' })
  ok('update 传入新正文（语音/清空）时 textarea 跟着变', textarea.value === '第一段。\n\n语音接进来的第二段。', show(textarea.value))
  textarea.value = '用户又改了一遍，没有保存也能改。'
  ok('用户可随意改字/删字（value 直接可写）', textarea.value.indexOf('又改了一遍') >= 0)
}

// ======================================================================
console.log('\n[D] 话筒图标：🎤 开始 / ● 绿色听写中；状态与句数')
{
  const ctx = setup()
  const root = openRoot(ctx)
  const mic = root.query('scribe-mic')
  const status = root.query('scribe-status')
  const count = root.query('scribe-count')
  ok('待开始：话筒是 🎤、aria-label=开始听写', mic.textContent === '🎤' && mic.attrs['aria-label'] === '开始听写', show(mic.textContent))
  mic.click()
  ok('点话筒触发 onMic（由 client 决定开始还是暂停）', ctx.calls.mic === 1)

  ctx.panel.update({ status: 'active', text: '第一句。', count: 1 })
  ok('听写中：话筒变 ●、aria-label=暂停听写', mic.textContent === '●' && mic.attrs['aria-label'] === '暂停听写', show(mic.textContent))
  ok('听写中：话筒是绿色（背景 #1F9D55）', String(mic.style.background).toUpperCase() === '#1F9D55', String(mic.style.background))
  ok('听写中：状态行显示「正在听写 · 本面板」', status.text().indexOf('正在听写') >= 0 && status.text().indexOf('本面板') >= 0, status.text())
  ok('已接句数提示：已接 1 句', count.textContent === '已接 1 句', show(count.textContent))

  ctx.panel.update({ status: 'paused', text: '第一句。', count: 1 })
  ok('暂停：话筒回到 🎤、状态「已暂停 · 本面板」', mic.textContent === '🎤' && status.text().indexOf('已暂停') >= 0)
  ctx.panel.update({ status: 'stopped', text: '第一句。', count: 1 })
  ok('传入旧 stopped 值按待开始处理（没有 stopped 语义）', status.text().indexOf('待开始') >= 0, status.text())
  ctx.panel.update({ status: 'active', text: '第一句。', count: 0 })
  ok('句数 0 时不显示提示', count.textContent === '')
}

// ======================================================================
console.log('\n[E] 保存类型下拉 + 单保存按钮：点保存直接按当前类型存，无二次选择')
{
  const ctx = setup()
  const root = openRoot(ctx)
  const textarea = root.query('scribe-textarea')
  const saveBtn = root.query('scribe-save')
  const saveType = root.query('scribe-save-type')
  textarea.value = '第一段。\n第二段。'

  ok('保存按钮初始可见（保存随时可点）', saveBtn.disabled === false)
  saveBtn.click()
  await tick()
  ok('默认 DOCX：点一次「保存」直接回调 onSave("docx", 正文)，不再二次弹选择', ctx.calls.saves.length === 1 && ctx.calls.saves[0][0] === 'docx' && ctx.calls.saves[0][1] === '第一段。\n第二段。', show(ctx.calls.saves[0]))
  ok('保存 DOCX 成功提示带文件名', root.query('scribe-notice').text().indexOf('已保存 DOCX') >= 0 && root.query('scribe-notice').text().indexOf('小鲸代笔.docx') >= 0, root.query('scribe-notice').text())
  ok('保存后正文保留', textarea.value === '第一段。\n第二段。')
  ok('点保存不会再冒出选择气泡/选项', root.query('scribe-save-popover') === null && root.query('scribe-save-txt') === null && root.query('scribe-save-docx') === null)

  saveType.value = 'txt'
  saveType.fire('change')
  saveBtn.click()
  await tick()
  ok('切到 TXT：点「保存」直接回调 onSave("txt", 正文)', ctx.calls.saves.length === 2 && ctx.calls.saves[1][0] === 'txt' && ctx.calls.saves[1][1] === '第一段。\n第二段。', show(ctx.calls.saves[1]))
  ok('保存 TXT 成功提示带文件名', root.query('scribe-notice').text().indexOf('已保存 TXT') >= 0 && root.query('scribe-notice').text().indexOf('小鲸代笔.txt') >= 0)
  ok('保存后正文仍保留', textarea.value === '第一段。\n第二段。')

  // 下拉选择在面板刷新后保留（同一面板实例）
  saveType.value = 'txt'
  saveType.fire('change')
  ctx.panel.update({ status: 'active', text: '第一段。\n第二段。', count: 2 })
  saveBtn.click()
  await tick()
  ok('保存类型选择不被 update 重置（仍是 TXT）', ctx.calls.saves[2][0] === 'txt', show(ctx.calls.saves[2][0]))

  // 空正文也能保存（保存随时可点）
  saveType.value = 'docx'
  saveType.fire('change')
  textarea.value = ''
  saveBtn.click()
  await tick()
  ok('空正文也能直接保存（不拦「保存随时可点」）', ctx.calls.saves[3][0] === 'docx' && ctx.calls.saves[3][1] === '')

  // 失败提示
  const failCtx = setup({ onSave: (kind) => ({ ok: false, error: '磁盘满了' }) })
  const froot = openRoot(failCtx)
  froot.query('scribe-save').click()
  await tick()
  ok('保存失败提示带原因与类型', froot.query('scribe-notice').text().indexOf('保存 DOCX 失败') >= 0 && froot.query('scribe-notice').text().indexOf('磁盘满了') >= 0, froot.query('scribe-notice').text())
  ok('保存失败不动正文', froot.query('scribe-textarea').value === '')
}

// ======================================================================
console.log('\n[F] 清空 / 关闭 / Esc / destroy')
{
  const ctx = setup()
  const root = openRoot(ctx)
  root.query('scribe-clear').click()
  ok('点「清空」→ onClear', ctx.calls.clear === 1)
  root.query('scribe-close').click()
  ok('点「×」关闭：isOpen=false 且从 body 移除', ctx.panel.isOpen() === false && ctx.doc.body.children.length === 0)
  ok('关闭触发 onClose', ctx.calls.close === 1)

  ctx.panel.open()
  ctx.doc.fire('keydown', { key: 'Escape' })
  ok('Esc 关闭面板', ctx.panel.isOpen() === false && ctx.calls.close === 2)

  ctx.panel.open()
  ctx.panel.destroy()
  const callsAfter = ctx.calls.close
  ctx.panel.open()
  ok('destroy 后 DOM 移除、open 失效', ctx.panel.isOpen() === false && ctx.doc.body.children.length === 0)
  ok('destroy 不触发 onClose（卸载收尾不跑业务动作）', callsAfter === ctx.calls.close)
}

// ======================================================================
console.log('\n[G] 拖动：标题栏按住移动，位置变化；mouseup 撤监听')
{
  const ctx = setup()
  const root = openRoot(ctx)
  const dragHandle = root.query('scribe-drag')
  const card = root.query('scribe-card')
  ok('面板打开时位置已初始化', typeof card.style.left === 'string' && card.style.left.length > 0, card.style.left + '/' + card.style.top)
  dragHandle.fire('mousedown', { button: 0, clientX: 100, clientY: 100 })
  ok('mousedown 后挂上文档级 mousemove/mouseup', ctx.doc.listenerCount('mousemove') === 1 && ctx.doc.listenerCount('mouseup') === 1)
  ctx.doc.fire('mousemove', { clientX: 140, clientY: 160 })
  ok('拖动后卡片位置改变（left/top 写入）', card.style.left === '40px' && card.style.top === '60px', card.style.left + '/' + card.style.top)
  ctx.doc.fire('mouseup', {})
  ok('mouseup 后撤掉监听', ctx.doc.listenerCount('mousemove') === 0 && ctx.doc.listenerCount('mouseup') === 0)
  dragHandle.fire('mousedown', { button: 2, clientX: 10, clientY: 10 })
  ok('右键按下不触发拖动', ctx.doc.listenerCount('mousemove') === 0)
}

// ======================================================================
console.log('\n[H] 源码纪律：不抢焦点、不写存储、不发网络、无 popover/停止')
{
  const src = readFileSync(join(ROOT, 'src/client/scribe-panel.ts'), 'utf8')
  ok('不调用 focus()（打开面板不抢主人正在打的字）', !/\.focus\s*\(/.test(src))
  ok('没有 localStorage/sessionStorage', !/localStorage|sessionStorage/.test(src))
  ok('没有 fetch/XMLHttpRequest', !/\bfetch\s*\(/.test(src) && !/XMLHttpRequest/.test(src))
  ok('不 import React（纯 DOM）', !/from\s+['"]react['"]/.test(src) && !/require\(['"]react['"]\)/.test(src))
  ok('没有停止按钮/停止动作', !/makeButton\('scribe-stop'/.test(src) && !/'scribe-stop'/.test(src))
  ok('没有保存类型气泡（popover 代码已删除）', !/popover/i.test(src) && !/scribe-save-txt/.test(src) && !/scribe-save-docx/.test(src))
  ok('有「保存类型」下拉（select + 默认 DOCX）', /'scribe-save-type'/.test(src) && /DOCX 文档/.test(src) && /TXT 文档/.test(src) && src.indexOf("saveKind = value === 'txt' ? 'txt' : 'docx'") >= 0 && /saveTypeSelect\.value = 'docx'/.test(src))
  ok('没有编号/列表渲染', !/scribe-sentence/.test(src) && !/scribe-list/.test(src))
}

// ======================================================================
console.log('\n────────────────────')
if (fail === 0) console.log('✅ 通过 ' + pass + ' 项，失败 0 项')
else console.log('❌ 通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
