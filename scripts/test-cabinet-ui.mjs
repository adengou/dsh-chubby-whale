/**
 * scripts/test-cabinet-ui.mjs —— 「鲸群推演室」v0.1 用户界面接入回归（离线）
 *
 * 覆盖（纯离线：不联网、不起 HTTP、不碰 dist、不写真实存储）：
 *   A. 面板导出与安全降级：无 document 时 open/close/destroy 全 no-op、不抛错；
 *   B. 面板结构：决定（必填）/背景/选项/期限/召开/取消 齐全，奶白卡片 + 高 z-index + pointer-events:auto；
 *   C. 必填校验：决定为空 → 内联错误、onSubmit 不调用、面板不关；
 *   D. 提交流程：onSubmit 收到 trim 后的四段文本；成功关闭并清空；
 *   E. 失败路径：返回 false / 同步抛错 / 异步 false / 连点只提交一次 → 内联错误 + 保持打开；
 *   F. 关闭路径：Esc / 关闭按钮 / 取消 / destroy；浮层空白不关；标题栏可反复拖动；
 *   G. 菜单：一级「推演 ▸」紧随「设置 ▸」，两项动作正确，en 翻译齐全；
 *      「施工队 ▸」、whale-works:* 与 shared/whale-works.ts 检查器一并移除；
 *   H. 动作：cabinet:open 只调 host.openCabinet；cabinet:protocol 复制 CABINET_PROTOCOL，
 *      Clipboard 优先、失败回退 textarea、彻底失败指路 docs/鲸群推演室.md；
 *   I. 接线静态：client.ts lazy 建面板、onSubmit 拼简报 + 写剪贴板 + 气泡 + 开聊天、host 接线；
 *      边界：不自动发消息、不调 team_task_*；
 *   J. 用户文档 docs/鲸群推演室.md：使用步骤 / 四角色 / 输出 / 边界齐全。
 *
 * 用法：node scripts/test-cabinet-ui.mjs   （全过退出码 0，有失败退出码 1）
 */

import { register } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 直接加载 .ts：.js 后缀找不到时回退同名 .ts（与 test-menu-actions 同款）
register(new URL('./ts-resolve.mjs', import.meta.url))

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.error('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const show = (v) => (v === null || typeof v === 'undefined' ? String(v) : JSON.stringify(v))
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

// ======================================================================
// 假 DOM：只实现 cabinet-panel.ts / copyViaTextarea 用到的 API
// ======================================================================
function makeEl(tag) {
  const el = {
    tagName: String(tag || '').toUpperCase(),
    tag: String(tag || ''),
    style: {},
    attrs: {},
    children: [],
    parentNode: null,
    value: '',
    textContent: '',
    type: '',
    disabled: false,
    placeholder: '',
    focused: 0,
    selected: null,
    listeners: new Map(),
    setAttribute(k, v) { el.attrs[String(k)] = String(v) },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el.attrs, String(k)) ? el.attrs[String(k)] : null },
    appendChild(c) { c.parentNode = el; el.children.push(c); return c },
    removeChild(c) {
      const i = el.children.indexOf(c)
      if (i >= 0) el.children.splice(i, 1)
      c.parentNode = null
      return c
    },
    remove() { if (el.parentNode) el.parentNode.removeChild(el) },
    addEventListener(type, fn) {
      if (!el.listeners.has(type)) el.listeners.set(type, [])
      el.listeners.get(type).push(fn)
    },
    removeEventListener(type, fn) {
      const arr = el.listeners.get(type) || []
      const i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
    },
    dispatch(type, ev) {
      const arr = (el.listeners.get(type) || []).slice()
      for (const fn of arr) fn(ev)
      return arr.length
    },
    focus() { el.focused++ },
    select() { },
    setSelectionRange(a, b) { el.selected = [a, b] },
  }
  return el
}

function makeFakeDoc() {
  const listeners = new Map()
  const doc = {
    body: makeEl('body'),
    execCommand(cmd) { return cmd === 'copy' },
    createElement(tag) { return makeEl(tag) },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(fn)
    },
    removeEventListener(type, fn) {
      const arr = listeners.get(type) || []
      const i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
    },
    dispatch(type, ev) {
      const arr = (listeners.get(type) || []).slice()
      for (const fn of arr) fn(ev)
      return arr.length
    },
    listenerCount() { let n = 0; for (const arr of listeners.values()) n += arr.length; return n },
  }
  return doc
}

/** DFS 收集元素 */
function collect(node, out = []) {
  if (!node || typeof node !== 'object') return out
  out.push(node)
  for (const c of node.children || []) collect(c, out)
  return out
}
/** 按 data-role 找元素 */
function byRole(root, role) {
  return collect(root).find((el) => el && el.attrs && el.attrs['data-role'] === role)
}
/** 所有文本拼起来（判断标题/按钮文案） */
function textOf(node) {
  if (!node || typeof node !== 'object') return ''
  return String(node.textContent || '') + (node.children || []).map(textOf).join('')
}
/** 点击：走 addEventListener('click') */
async function click(el) {
  if (el && typeof el.dispatch === 'function') el.dispatch('click', { target: el })
  await tick(2)
}
/** 取当前打开的面板根 */
function openRoot(doc) {
  return doc.body.children.find((el) => el && el.attrs && el.attrs['data-role'] === 'cabinet-panel') || null
}

// ---------- 全局桩（system.ts 的复制兜底会读 navigator / document） ----------
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const realDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
const realLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}
function restoreGlobal(name, desc) {
  if (desc) Object.defineProperty(globalThis, name, desc)
  else delete globalThis[name]
}
const mem = new Map()
setGlobal('localStorage', {
  getItem: (k) => (mem.has(String(k)) ? mem.get(String(k)) : null),
  setItem: (k, v) => { mem.set(String(k), String(v)) },
  removeItem: (k) => { mem.delete(String(k)) },
})

// ---------- 被测模块 ----------
const panelMod = await import('../src/client/cabinet-panel.ts')
const { createCabinetPanel } = panelMod
const menu = await import('../src/client/menu.ts')
const render = await import('../src/client/render.ts')
const { buildMenu, tr } = menu
const { listMenuEntries } = render
const actionsMod = await import('../src/client/actions.ts')
const { createActionTable } = actionsMod
const { registerSystemActions } = await import('../src/client/actions/system.ts')
const { CABINET_PROTOCOL } = await import('../src/shared/cabinet.ts')

/** 静态源码 */
const SRC = {
  'src/client/cabinet-panel.ts': readFileSync(join(ROOT, 'src/client/cabinet-panel.ts'), 'utf8'),
  'src/client/menu.ts': readFileSync(join(ROOT, 'src/client/menu.ts'), 'utf8'),
  'src/client/actions.ts': readFileSync(join(ROOT, 'src/client/actions.ts'), 'utf8'),
  'src/client/actions/system.ts': readFileSync(join(ROOT, 'src/client/actions/system.ts'), 'utf8'),
  'src/client.ts': readFileSync(join(ROOT, 'src/client.ts'), 'utf8'),
}

// ======================================================================
console.log('\n[A] 面板导出与安全降级（无 document 时整体 no-op）')
try {
  ok('cabinet-panel.ts 导出 createCabinetPanel', typeof createCabinetPanel === 'function')
  const src = SRC['src/client/cabinet-panel.ts']
  ok('面板不 import React（也不 import 任何模块）', !/^\s*import\s+[\s\S]*?from\s+['"]/m.test(src), '')
  ok('面板不写 localStorage', !/localStorage\s*[.[]/.test(src))
  ok('面板不往 window / document 挂全局', !/\bwindow\s*\./.test(src) && !/\bdocument\s*\.\s*__/.test(src))
  ok('面板不调用 team_task_* / 任务板写接口', !/\bteam_task_|\b(?:createTask|updateTask|claimTask|completeTask)\s*\(/.test(src))
  ok('面板不自己发消息 / 不联网（无 fetch / send_message）', !/\bfetch\s*\(|\bsend_message\b/.test(src))

  // 无 doc：Node 里没有全局 document 时应当安全退化
  const noop = createCabinetPanel({})
  ok('无 doc 时 open/close/destroy/isOpen 都是函数',
    typeof noop.open === 'function' && typeof noop.close === 'function' &&
    typeof noop.destroy === 'function' && typeof noop.isOpen === 'function')
  let threw = null
  try { noop.open(); noop.close(); noop.destroy(); noop.destroy() } catch (e) { threw = e }
  ok('无 doc 时整套调用不抛错', threw === null, String(threw && threw.message))
  ok('无 doc 时 isOpen 恒为 false', noop.isOpen() === false)
  let threw2 = null
  try { noop.open() } catch (e) { threw2 = e }
  ok('destroy 之后再 open 也是 no-op', threw2 === null && noop.isOpen() === false)
} catch (e) {
  ok('面板安全降级可验证', false, String(e && e.message))
}

// ======================================================================
console.log('\n[B] 面板结构：四字段 + 召开/取消 + 鱼 UI 样式')
let doc = makeFakeDoc()
let submissions = []
let panel = null
function makePanel(onSubmit) {
  doc = makeFakeDoc()
  submissions = []
  panel = createCabinetPanel({
    doc,
    onSubmit: onSubmit || ((input) => { submissions.push(input); return true }),
  })
  return panel
}
try {
  makePanel()
  ok('初始 isOpen=false', panel.isOpen() === false)
  ok('初始不挂 DOM（懒创建）', doc.body.children.length === 0)
  panel.open()
  ok('open 后 isOpen=true', panel.isOpen() === true)
  const root = openRoot(doc)
  ok('open 后遮罩挂到 body', !!root)
  ok('浮层 display=block（透明不挡页面）', root && root.style.display === 'block', root && root.style.display)
  ok('浮层 pointer-events:none（只让卡片接鼠标）', root && root.style.pointerEvents === 'none', root && root.style.pointerEvents)
  ok('z-index 高于菜单(10001)与看板(2147483000)',
    !!root && Number(root.style.zIndex) > 10001 && Number(root.style.zIndex) >= 2147483000, root && root.style.zIndex)
  ok('role=dialog / aria-modal=false（浮窗可识别）',
    !!root && root.attrs.role === 'dialog' && root.attrs['aria-modal'] === 'false', root && (root.attrs.role + '/' + root.attrs['aria-modal']))

  const card = byRole(root, 'cabinet-card')
  ok('卡片 pointer-events:auto（可输入可拖动）', !!card && card.style.pointerEvents === 'auto', card && card.style.pointerEvents)
  ok('卡片存在且渐变底/深蓝字', !!card && String(card.style.background).indexOf('#fffdf7') >= 0 && card.style.color === '#17324a',
    card && (card.style.background + ' / ' + card.style.color))
  ok('标题含「鲸群推演室」', !!byRole(root, 'cabinet-title') && textOf(byRole(root, 'cabinet-title')).indexOf('鲸群推演室') >= 0)
  ok('决定字段是 textarea 且必填标注存在', (byRole(root, 'cabinet-decision') || {}).tag === 'textarea' &&
    textOf(byRole(root, 'cabinet-decision-label')).indexOf('必填') >= 0)
  ok('背景/选项字段存在', (byRole(root, 'cabinet-context') || {}).tag === 'textarea' && (byRole(root, 'cabinet-options') || {}).tag === 'textarea')
  ok('期限字段存在（单行 input）', (byRole(root, 'cabinet-deadline') || {}).tag === 'input')
  ok('开始推演 / 取消按钮存在且文案正确',
    textOf(byRole(root, 'cabinet-submit')) === '开始推演' && textOf(byRole(root, 'cabinet-cancel')) === '取消')
  ok('内联错误默认隐藏', !!byRole(root, 'cabinet-error') && byRole(root, 'cabinet-error').style.display === 'none')
  ok('打开时聚焦「决定」字段', byRole(root, 'cabinet-decision').focused === 1, (byRole(root, 'cabinet-decision') || {}).focused)
} catch (e) {
  ok('面板结构可验证', false, String(e && e.message))
}

// ======================================================================
console.log('\n[C] 必填校验：决定为空不提交、显示内联错误、面板不关')
try {
  makePanel()
  panel.open()
  const root = openRoot(doc)
  await click(byRole(root, 'cabinet-submit'))
  ok('决定为空时 onSubmit 不被调用', submissions.length === 0)
  ok('内联错误显示且提示「决定」', byRole(root, 'cabinet-error').style.display === 'block' &&
    textOf(byRole(root, 'cabinet-error')).indexOf('决定') >= 0, textOf(byRole(root, 'cabinet-error')))
  ok('面板仍打开', panel.isOpen() === true)
  ok('焦点回到决定字段', byRole(root, 'cabinet-decision').focused >= 2, byRole(root, 'cabinet-decision').focused)
  // 只填空格也算空
  byRole(root, 'cabinet-decision').value = '   \n  '
  await click(byRole(root, 'cabinet-submit'))
  ok('只有空白字符也算空（不提交）', submissions.length === 0)
} catch (e) {
  ok('必填校验可验证', false, String(e && e.message))
}

// ======================================================================
console.log('\n[D] 提交流程：onSubmit 收到 trim 后四段文本，成功留在面板内并提示结果位置')
try {
  makePanel()
  panel.open()
  const root = openRoot(doc)
  byRole(root, 'cabinet-decision').value = '  要不要把插件开源？  '
  byRole(root, 'cabinet-context').value = ' 只在本地用，担心被抄 '
  byRole(root, 'cabinet-options').value = ' A 开源 / B 不开源 '
  byRole(root, 'cabinet-deadline').value = ' 本月底前 '
  await click(byRole(root, 'cabinet-submit'))
  ok('onSubmit 恰好调用一次', submissions.length === 1, '实际 ' + submissions.length)
  ok('四段文本按 decision/context/options/deadline 传入且已 trim',
    eq(submissions[0], { decision: '要不要把插件开源？', context: '只在本地用，担心被抄', options: 'A 开源 / B 不开源', deadline: '本月底前' }),
    show(submissions[0]))
  ok('成功后面板不消失', panel.isOpen() === true)
  ok('成功后显示结果位置提示', byRole(root, 'cabinet-success').style.display === 'block')
  ok('结果提示包含 Agent Team 与结果位置',
    textOf(byRole(root, 'cabinet-success')).indexOf('Agent Team') >= 0 &&
    textOf(byRole(root, 'cabinet-success')).indexOf('DSH 对话') >= 0 &&
    textOf(byRole(root, 'cabinet-success')).indexOf('推演 3/4') >= 0)
  ok('成功后保留已填内容，便于再次确认', byRole(root, 'cabinet-decision').value.indexOf('要不要把插件开源？') >= 0)
  panel.close()
} catch (e) {
  ok('提交流程可验证', false, String(e && e.message))
}

// ======================================================================
console.log('\n[E] 失败路径：返回 false / 抛错 / 异步失败 / 连点只提交一次')
try {
  // E1：同步返回 false
  makePanel(() => false)
  panel.open()
  let root = openRoot(doc)
  byRole(root, 'cabinet-decision').value = '要不要开源'
  await click(byRole(root, 'cabinet-submit'))
  ok('onSubmit 返回 false：面板不关', panel.isOpen() === true)
  ok('onSubmit 返回 false：显示内联错误', byRole(root, 'cabinet-error').style.display === 'block')
  ok('onSubmit 返回 false：已填内容不丢', byRole(root, 'cabinet-decision').value === '要不要开源')

  // E2：同步抛错
  makePanel(() => { throw new Error('剪贴板被拒') })
  panel.open()
  root = openRoot(doc)
  byRole(root, 'cabinet-decision').value = '要不要开源'
  await click(byRole(root, 'cabinet-submit'))
  ok('onSubmit 抛错：面板不关', panel.isOpen() === true)
  ok('onSubmit 抛错：内联错误带原因', textOf(byRole(root, 'cabinet-error')).indexOf('剪贴板被拒') >= 0,
    textOf(byRole(root, 'cabinet-error')))

  // E3：异步返回 false
  makePanel(async () => { await tick(2); return false })
  panel.open()
  root = openRoot(doc)
  byRole(root, 'cabinet-decision').value = '要不要开源'
  await click(byRole(root, 'cabinet-submit'))
  await tick(8)
  ok('异步 false：面板不关且显示错误', panel.isOpen() === true && byRole(root, 'cabinet-error').style.display === 'block')

  // E4：异步在途时连点只提交一次
  let pendingResolve = null
  let calls = 0
  makePanel(() => { calls++; return new Promise((resolveFn) => { pendingResolve = resolveFn }) })
  panel.open()
  root = openRoot(doc)
  byRole(root, 'cabinet-decision').value = '要不要开源'
  const submitBtn = byRole(root, 'cabinet-submit')
  submitBtn.dispatch('click', { target: submitBtn })
  submitBtn.dispatch('click', { target: submitBtn })
  await tick(4)
  ok('在途连点只提交一次', calls === 1, '实际 ' + calls)
  ok('在途时按钮文案变「正在准备…」', String(submitBtn.textContent).indexOf('正在准备') >= 0, String(submitBtn.textContent))
  pendingResolve(true)
  await tick(4)
  ok('异步成功后面板留在结果态', panel.isOpen() === true)
  ok('成功后按钮文案变为已复制', String(submitBtn.textContent).indexOf('已复制') >= 0, String(submitBtn.textContent))
} catch (e) {
  ok('失败路径可验证', false, String(e && e.message))
}

// ======================================================================
console.log('\n[F] 关闭路径：Esc / 浮层空白 / 拖动 / 取消 / destroy')
try {
  makePanel()
  panel.open()
  doc.dispatch('keydown', { key: 'Escape', prevented: 0, preventDefault() { this.prevented++ } })
  ok('Esc 关闭面板', panel.isOpen() === false)
  ok('Esc 后遮罩移除', doc.body.children.length === 0)
  let threw = null
  try { doc.dispatch('keydown', { key: 'Escape' }) } catch (e) { threw = e }
  ok('面板关闭时 Esc 不抛错', threw === null)

  panel.open()
  let root = openRoot(doc)
  root.dispatch('mousedown', { target: byRole(root, 'cabinet-card') })
  ok('点卡片内部不关闭', panel.isOpen() === true)
  root.dispatch('mousedown', { target: root })
  ok('点浮层空白不关闭（不挡页面）', panel.isOpen() === true)

  const header = byRole(root, 'cabinet-drag')
  const dragCard = byRole(root, 'cabinet-card')
  const beforeLeft = dragCard && dragCard.style.left
  const beforeTop = dragCard && dragCard.style.top
  if (header) header.dispatch('mousedown', { button: 0, target: header, currentTarget: header, clientX: 500, clientY: 300, preventDefault() {} })
  doc.dispatch('mousemove', { clientX: 650, clientY: 380, preventDefault() {} })
  ok('拖动标题栏后 left 改变', !!dragCard && dragCard.style.left !== beforeLeft, beforeLeft + ' → ' + (dragCard && dragCard.style.left))
  ok('拖动标题栏后 top 改变', !!dragCard && dragCard.style.top !== beforeTop, beforeTop + ' → ' + (dragCard && dragCard.style.top))
  doc.dispatch('mouseup', {})
  ok('拖动结束仍打开', panel.isOpen() === true)

  panel.open()
  root = openRoot(doc)
  await click(byRole(root, 'cabinet-cancel'))
  ok('取消按钮关闭面板', panel.isOpen() === false)

  // destroy：撤掉 document 级监听、之后 open 无效
  panel.open()
  ok('destroy 前 doc 上有 Esc 监听', doc.listenerCount() > 0, 'listeners=' + doc.listenerCount())
  panel.destroy()
  ok('destroy 后关闭并移除 DOM', panel.isOpen() === false && doc.body.children.length === 0)
  ok('destroy 后撤掉 document 级 Esc 监听', doc.listenerCount() === 0, 'listeners=' + doc.listenerCount())
  let threw2 = null
  try { panel.open(); panel.destroy() } catch (e) { threw2 = e }
  ok('destroy 后 open/destroy 不抛错且不复活', threw2 === null && panel.isOpen() === false)
} catch (e) {
  ok('关闭路径可验证', false, String(e && e.message))
}

// ======================================================================
console.log('\n[G] 菜单：一级「推演 ▸」紧随「设置 ▸」；施工队入口消失')
try {
  const items = buildMenu('9.9.9', { storyBooks: ['聊斋'], storyBooksTried: true })
  const top = items.filter((it) => it && (it.type === 'item' || it.type === 'sub'))
  const topLabels = top.map((it) => it.label)
  const setIdx = topLabels.indexOf('设置 ▸')
  const cabinetIdx = topLabels.indexOf('推演 ▸')
  ok('一级有「推演 ▸」', cabinetIdx >= 0)
  ok('「推演 ▸」紧跟在「设置 ▸」之后', setIdx >= 0 && cabinetIdx === setIdx + 1, '设置@' + setIdx + ' / 推演@' + cabinetIdx)
  ok('一级不再有「施工队 ▸」', topLabels.indexOf('施工队 ▸') < 0)
  const cabinet = cabinetIdx >= 0 ? top[cabinetIdx] : null
  const children = (cabinet && Array.isArray(cabinet.items) ? cabinet.items : []).filter((it) => it && it.type !== 'sep')
  ok('「推演 ▸」恰好两个条目且顺序正确',
    children.length === 2 &&
    children[0].type === 'item' && children[0].label === '开始推演…' && children[0].action === 'cabinet:open' &&
    children[1].type === 'item' && children[1].label === '复制推演规则' && children[1].action === 'cabinet:protocol',
    children.map((it) => it.label + '(' + it.action + ')').join(' / '))

  // render 层：按一级路径展开后两项真实可见（不是只存在数据里）
  const expanded = listMenuEntries(items, { tr, lang: 'zh', subOpen: '推演 ▸' })
  const parentEntry = expanded.find((e) => e.kind === 'sub' && e.label === '推演 ▸')
  const visible = expanded.filter((e) => e.parentPath === '推演 ▸')
  ok('render 层展开「推演 ▸」：父项 open=true 且两项紧跟其后',
    !!parentEntry && parentEntry.open === true && visible.length === 2 &&
    visible[0].action === 'cabinet:open' && visible[1].action === 'cabinet:protocol' &&
    visible[0].index === parentEntry.index + 1 && visible[1].index === parentEntry.index + 2,
    visible.map((e) => e.label + '@' + e.index).join(' / '))
  ok('收起时推演条目不可见（不越级）',
    !listMenuEntries(items, { tr, lang: 'zh', subOpen: '' }).some((e) => e.action === 'cabinet:open'))

  // 英译：三条固定文案都有译文且不残留中文
  const EN = {
    '推演 ▸': 'Decision Lab ▸',
    '开始推演…': 'Start a decision lab…',
    '复制推演规则': 'Copy lab protocol',
  }
  const badEn = Object.keys(EN).filter((label) => tr(label, 'en') !== EN[label] || /[\u4e00-\u9fa5]/.test(tr(label, 'en')))
  ok('推演三个固定文案英文正确（无中文残留）', badEn.length === 0, badEn.map((l) => l + '→' + tr(l, 'en')).join(' | '))
  const enVisible = listMenuEntries(items, { tr, lang: 'en', subOpen: '推演 ▸' })
  ok('英文界面推演菜单不漏中文',
    enVisible.filter((e) => /[\u4e00-\u9fa5]/.test(e.label)).length === 0 && enVisible.some((e) => e.label === 'Decision Lab ▸'))

  // 全树扫描：施工队 / whale-works:* 一个都不许留
  const allLabels = []
  const allActions = []
  const walk = (arr) => {
    for (const it of arr || []) {
      if (!it || typeof it !== 'object') continue
      if (it.label) allLabels.push(it.label)
      if (it.type === 'item' && it.action) allActions.push(it.action)
      if (Array.isArray(it.items)) walk(it.items)
    }
  }
  walk(items)
  ok('整棵菜单树无「施工队」字样', !allLabels.some((l) => String(l).indexOf('施工队') >= 0))
  ok('整棵菜单树无 whale-works:* 动作', !allActions.some((a) => String(a).indexOf('whale-works:') === 0))
  ok('shared/whale-works.ts 检查器已删除，team-watch 不再引用',
    !existsSync(join(ROOT, 'src/shared/whale-works.ts')) && readFileSync(join(ROOT, 'src/client/team-watch.ts'), 'utf8').indexOf('whale-works.js') < 0)
} catch (e) {
  ok('菜单结构可验证', false, String(e && e.message))
}

// ======================================================================
console.log('\n[H] 动作：cabinet:open / cabinet:protocol（复制优先 Clipboard，失败回退 textarea）')
try {
  const table = createActionTable()
  registerSystemActions(table)
  ok('cabinet:open 已注册', table.has('cabinet:open') === true)
  ok('cabinet:protocol 已注册', table.has('cabinet:protocol') === true)
  ok('whale-works:* 动作已从动作表删除',
    !table.has('whale-works:brief') && !table.has('whale-works:worker-card') &&
    !table.has('whale-works:acceptance') && !table.has('whale-works:guide'))

  // H1：cabinet:open 只调 host.openCabinet
  {
    const calls = []
    const bubbles = []
    const host = { openCabinet: () => calls.push('open'), bubble: (t) => bubbles.push(String(t)) }
    let threw = null
    let ran = false
    try { ran = await table.run('cabinet:open', host) } catch (e) { threw = e }
    ok('cabinet:open 执行不抛错且命中', threw === null && ran === true)
    ok('cabinet:open 只调 host.openCabinet（不自己拼简报/发消息）', calls.length === 1 && bubbles.length === 0,
      calls.join(',') + ' / ' + bubbles.join('|'))
  }
  // H2：没接 openCabinet 时给一句人话（不静默）
  {
    const bubbles = []
    await table.run('cabinet:open', { bubble: (t) => bubbles.push(String(t)) })
    ok('openCabinet 未接线时给降级提示', bubbles.some((b) => b.indexOf('没接上') >= 0), bubbles.join(' | '))
  }
  // H3：Clipboard API 成功 → 写入 CABINET_PROTOCOL 原文 + 成功气泡
  {
    const writes = []
    setGlobal('navigator', { clipboard: { writeText: (t) => { writes.push(String(t)); return Promise.resolve() } } })
    const bubbles = []
    await table.run('cabinet:protocol', { bubble: (t) => bubbles.push(String(t)) })
    await tick(4)
    ok('cabinet:protocol 写入的文本逐字等于 CABINET_PROTOCOL', writes.length === 1 && writes[0] === CABINET_PROTOCOL, '写入 ' + writes.length + ' 次')
    ok('复制成功气泡提示「已复制」', bubbles.length === 1 && bubbles[0].indexOf('已复制') >= 0, bubbles.join(' / '))
    restoreGlobal('navigator', realNavigator)
  }
  // H4：Clipboard 被拒 → 回退临时 textarea + execCommand
  {
    setGlobal('navigator', { clipboard: { writeText: () => Promise.reject(new Error('denied')) } })
    const fakeDoc = makeFakeDoc()
    const created = []
    const origCreate = fakeDoc.createElement
    fakeDoc.createElement = (tag) => { const el = origCreate(tag); created.push(el); return el }
    setGlobal('document', fakeDoc)
    const bubbles = []
    await table.run('cabinet:protocol', { bubble: (t) => bubbles.push(String(t)) })
    await tick(4)
    const areas = created.filter((el) => el.tag === 'textarea')
    ok('Clipboard 被拒时回退 textarea', areas.length === 1 && areas[0].value === CABINET_PROTOCOL,
      'textarea ' + areas.length + ' 个')
    ok('回退只用临时元素：插入后已移除', fakeDoc.body.children.length === 0)
    ok('回退成功仍提示「已复制」', bubbles.some((b) => b.indexOf('已复制') >= 0), bubbles.join(' / '))
    restoreGlobal('document', realDocument)
    restoreGlobal('navigator', realNavigator)
  }
  // H5：彻底失败（无 Clipboard + execCommand 失败）→ 指路 docs/鲸群推演室.md
  {
    setGlobal('navigator', undefined)
    const fakeDoc = makeFakeDoc()
    fakeDoc.execCommand = () => false
    setGlobal('document', fakeDoc)
    const bubbles = []
    await table.run('cabinet:protocol', { bubble: (t) => bubbles.push(String(t)) })
    await tick(4)
    ok('复制彻底失败时气泡指路 docs/鲸群推演室.md',
      bubbles.length === 1 && bubbles[0].indexOf('复制失败') >= 0 && bubbles[0].indexOf('docs/鲸群推演室.md') >= 0,
      bubbles.join(' / '))
    restoreGlobal('document', realDocument)
    restoreGlobal('navigator', realNavigator)
  }
} catch (e) {
  ok('推演动作可验证', false, String(e && e.message))
  restoreGlobal('document', realDocument)
  restoreGlobal('navigator', realNavigator)
}

// ======================================================================
console.log('\n[I] client.ts 接线与只读边界')
try {
  const clientSrc = SRC['src/client.ts']
  const actionsSrc = SRC['src/client/actions.ts']
  const systemSrc = SRC['src/client/actions/system.ts']
  ok('client.ts 引入 cabinet-panel 与 buildCabinetPrompt',
    /from\s+'\.\/client\/cabinet-panel\.js'/.test(clientSrc) && /from\s+'\.\/shared\/cabinet\.js'/.test(clientSrc))
  ok('client.ts 从 actions/system.ts 复用 copyPlainText', /import\s*\{[^}]*copyPlainText[^}]*\}\s*from\s*'\.\/client\/actions\/system\.js'/.test(clientSrc))
  ok('ActionHost 新增最小接口 openCabinet（actions.ts）', /openCabinet:\s*\(\)\s*=>\s*void/.test(actionsSrc))
  ok('client.ts host 接线 openCabinet → 面板 open',
    /openCabinet:\s*\(\)\s*=>\s*\{[^}]*cabinetPanelRef\.current\.open\(\)/.test(clientSrc))
  ok('client.ts 用 useLazyRef 懒建面板', /const cabinetPanelRef = hookApi\.useLazyRef\(\(\) => createCabinetPanel\(\{/.test(clientSrc))
  ok('client.ts 卸载时 destroy 面板', /cabinetPanelRef\.current\.destroy\(\)/.test(clientSrc))
  ok('client.ts onSubmit 调 buildCabinetPrompt', /buildCabinetPrompt\(input\)/.test(clientSrc))
  ok('client.ts onSubmit 走 copyPlainText(prompt) 写剪贴板', /copyPlainText\(prompt\)/.test(clientSrc))
  ok('client.ts 成功气泡含「推演议题已复制」', /推演议题已复制/.test(clientSrc))
  ok('client.ts 成功后打开聊天面板', /setChatOpen\(true\)/.test(clientSrc))
  ok('system.ts 的 cabinet:open 只转 host.openCabinet', /table\.define\('cabinet:open'[\s\S]{0,200}host\.openCabinet\(\)/.test(systemSrc))
  ok('system.ts 的 cabinet:protocol 复制 CABINET_PROTOCOL', /table\.define\('cabinet:protocol'[\s\S]{0,300}copyPlainText\(CABINET_PROTOCOL\)/.test(systemSrc))
  ok('system.ts 不再引用施工队模板 / 施工规范路径',
    systemSrc.indexOf('WHALE_WORKS_TEMPLATES') < 0 && systemSrc.indexOf('鲸群营造-工程流程') < 0)

  // 边界：接入层没有任何自动任务板写 / 自动发消息
  const forbiddenTaskCall = /\bteam_task_[A-Za-z0-9_]*\s*\(|\b(?:createTask|updateTask|claimTask|deleteTask|reassignTask|completeTask)\s*\(|\bagentTeams\b/
  for (const [name, src] of Object.entries(SRC)) {
    ok(name + ' 没有任务板写调用（team_task_* / createTask …）', !forbiddenTaskCall.test(src))
  }
  // onSubmit 代码块（lazy ref 起 → 收尾 effect 前）不得自动发消息
  const start = clientSrc.indexOf('const cabinetPanelRef = hookApi.useLazyRef')
  const end = clientSrc.indexOf('R.useEffect', start)
  const block = start >= 0 && end > start ? clientSrc.slice(start, end) : ''
  ok('client.ts 推演 onSubmit 代码块里没有自动发消息（sendText / chat.send / send_message）',
    !!block && !/\bsendText\s*\(|\bchat\.send\s*\(|\bsend_message\b/.test(block), block ? '' : '找不到代码块')
  // 接入层只 import 相对模块
  for (const [name, src] of Object.entries(SRC)) {
    const specs = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
    ok(name + ' 没有 import 外部包 / 绝对路径', specs.every((s) => s.indexOf('.') === 0), specs.join(','))
  }
} catch (e) {
  ok('client 接线可验证', false, String(e && e.message))
}

// ======================================================================
console.log('\n[J] 用户文档 docs/鲸群推演室.md')
try {
  const path = join(ROOT, 'docs/鲸群推演室.md')
  ok('文档存在', existsSync(path))
  const md = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const musts = [
    ['右键菜单路径', /右键/],
    ['填写决定', /决定（必填）|决定\(必填\)/],
    ['粘贴发送', /粘贴/],
    ['四位角色名', /财务/],
    ['四位角色名', /风险\/法务/],
    ['四位角色名', /客户代言人/],
    ['四位角色名', /反方/],
    ['输出（六项）', /决策备忘录|分歧地图|假设账本|最便宜可逆实验|待核实清单|非专业意见声明/],
    ['非专业意见边界', /非专业意见/],
    ['不自动执行边界', /不自动执行/],
  ]
  for (const [name, re] of musts) ok('文档写明「' + name + '」', re.test(md))
  ok('文档写明「不自动发消息」（面板只复制到剪贴板）', /不自动发消息/.test(md) && /剪贴板/.test(md))
  ok('文档没有编造真实价格/法条（不出现具体金额或法条编号）', !/¥\s?\d|第\s?\d+\s?条/.test(md))
} catch (e) {
  ok('用户文档可验证', false, String(e && e.message))
}

// ---------- 还原全局 ----------
restoreGlobal('navigator', realNavigator)
restoreGlobal('document', realDocument)
restoreGlobal('localStorage', realLocalStorage)

console.log('\n────────────────────')
if (fail === 0) console.log('✅ 通过 ' + pass + ' 项，失败 0 项')
else console.log('❌ 通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
