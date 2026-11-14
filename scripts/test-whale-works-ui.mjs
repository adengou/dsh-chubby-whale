/**
 * scripts/test-whale-works-ui.mjs —— WhaleWorks v0.1「鱼看板 + 施工队菜单」接入回归（离线）
 *
 * 覆盖三块（纯离线：不联网、不起 HTTP、不碰 dist）：
 *   A. 右键菜单：一级「施工队 ▸」紧跟「设置 ▸」，含四个条目且动作可执行；
 *      中英翻译齐全，render 层能按路径展开。
 *   B. 动作：复制开工单/工人卡/验收单的文本逐字取自 WHALE_WORKS_TEMPLATES；
 *      Clipboard API 优先、失败回退临时 textarea + execCommand；全失败给手动指路文案；
 *      「施工规范…」只冒泡显示文档路径，不打开外部程序；处理器只依赖 host.bubble。
 *   C. 看板编排：team-watch 收到快照后调用 inspectWhaleWorks(snapshot.tasks)，
 *      有施工报告时用 report.chipText 顶替旧计数文案；审批/完成 alert、
 *      enabled/quiet/cooldown、普通任务板旧文案全部保持原样；不新增定时器。
 *   D. 只读边界：三个接入文件没有 team_task_* / 任务板写调用，模板只在 system.ts
 *      以 WHALE_WORKS_TEMPLATES 引用（没有复制内部逻辑）。
 *
 * 用法：node scripts/test-whale-works-ui.mjs   （全过退出码 0，有失败退出码 1）
 */

import { register } from 'node:module'
import { readFileSync } from 'node:fs'
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
const settle = () => new Promise((r) => setTimeout(r, 0))

// ---------- localStorage 桩（动作模块初始化会用到存储，禁存也测） ----------
function makeStorage() {
  const map = new Map()
  const s = {
    failGet: false,
    failSet: false,
    getItem(k) {
      if (s.failGet) throw new Error('storage disabled (get)')
      return map.has(String(k)) ? map.get(String(k)) : null
    },
    setItem(k, v) {
      if (s.failSet) throw new Error('storage full (set)')
      map.set(String(k), String(v))
    },
    removeItem(k) { map.delete(String(k)) },
    clear() { map.clear() },
  }
  return s
}
const storage = makeStorage()
globalThis.localStorage = storage

// ---------- 全局 navigator / document / window 的可恢复桩 ----------
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const realDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
const realWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')

function setGlobal(name, desc, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  return desc
}
function restoreGlobal(name, desc) {
  if (desc) Object.defineProperty(globalThis, name, desc)
  else delete globalThis[name]
}
function setNavigator(value) { setGlobal('navigator', realNavigator, value) }
function restoreNavigator() { restoreGlobal('navigator', realNavigator) }
function setDocument(value) { setGlobal('document', realDocument, value) }
function restoreDocument() { restoreGlobal('document', realDocument) }
function setWindow(value) { setGlobal('window', realWindow, value) }
function restoreWindow() { restoreGlobal('window', realWindow) }

/**
 * 极简 document 桩：够 copyViaTextarea 用（createElement/body/execCommand）。
 * execResult 决定 execCommand('copy') 的返回值。
 */
function makeDocStub(execResult) {
  const created = []
  const appended = []
  const removed = []
  const body = {
    appendChild(el) { appended.push(el); el.parentNode = body; return el },
    removeChild(el) { removed.push(el); el.parentNode = null; return el },
  }
  const doc = {
    body,
    createElement(tag) {
      const el = {
        tag,
        value: '',
        style: {},
        attrs: {},
        parentNode: null,
        selection: null,
        setAttribute(k, v) { el.attrs[k] = v },
        focus() { },
        select() { },
        setSelectionRange(a, b) { el.selection = [a, b] },
      }
      created.push(el)
      return el
    },
    execCommand(cmd) { return cmd === 'copy' ? execResult : false },
  }
  return { doc, created, appended, removed }
}

// ---------- 加载被测模块 ----------
const menu = await import('../src/client/menu.ts')
const render = await import('../src/client/render.ts')
const whale = await import('../src/shared/whale-works.ts')
const actionsMod = await import('../src/client/actions.ts')
const { registerSystemActions } = await import('../src/client/actions/system.ts')
const { createTeamWatch } = await import('../src/client/team-watch.ts')
const { buildMenu, tr } = menu
const { inspectWhaleWorks, WHALE_WORKS_TEMPLATES } = whale

const SRC = {
  'src/client/team-watch.ts': readFileSync(join(ROOT, 'src/client/team-watch.ts'), 'utf8'),
  'src/client/menu.ts': readFileSync(join(ROOT, 'src/client/menu.ts'), 'utf8'),
  'src/client/actions/system.ts': readFileSync(join(ROOT, 'src/client/actions/system.ts'), 'utf8'),
  'src/client/actions.ts': readFileSync(join(ROOT, 'src/client/actions.ts'), 'utf8'),
}

// ======================================================================
console.log('\n[A] 右键菜单：一级「施工队 ▸」紧跟「设置 ▸」，四个条目 + 英文翻译')
const CREW_ITEMS = [
  ['复制开工单', 'whale-works:brief'],
  ['复制工人卡', 'whale-works:worker-card'],
  ['复制验收单', 'whale-works:acceptance'],
  ['施工规范…', 'whale-works:guide'],
]
const CREW_EN = {
  '施工队 ▸': 'Construction crew ▸',
  '复制开工单': 'Copy work order',
  '复制工人卡': 'Copy worker card',
  '复制验收单': 'Copy acceptance sheet',
  '施工规范…': 'Construction guide…',
}
try {
  const items = buildMenu('9.9.9', { storyBooks: ['聊斋'], storyBooksTried: true })
  const top = items.filter((it) => it && (it.type === 'item' || it.type === 'sub'))
  const setIdx = top.findIndex((it) => it.type === 'sub' && it.label === '设置 ▸')
  const crewIdx = top.findIndex((it) => it.type === 'sub' && it.label === '施工队 ▸')
  ok('一级有「施工队 ▸」子菜单', crewIdx >= 0)
  ok('「施工队 ▸」紧跟在「设置 ▸」之后', setIdx >= 0 && crewIdx === setIdx + 1, '设置@' + setIdx + ' / 施工队@' + crewIdx)
  const crew = crewIdx >= 0 ? top[crewIdx] : null
  const crewChildren = (crew && Array.isArray(crew.items) ? crew.items : []).filter((it) => it && it.type !== 'sep')
  ok('「施工队 ▸」恰好四个条目且顺序正确',
    crewChildren.length === CREW_ITEMS.length &&
    crewChildren.every((it, i) => it.type === 'item' && it.label === CREW_ITEMS[i][0] && it.action === CREW_ITEMS[i][1]),
    crewChildren.map((it) => it.label + '(' + it.action + ')').join(' / '))

  // render 层：按一级路径展开后，四项真实可见（不是只存在数据里）
  const expanded = render.listMenuEntries(items, { tr, lang: 'zh', subOpen: '施工队 ▸' })
  const parentEntry = expanded.find((e) => e.kind === 'sub' && e.label === '施工队 ▸')
  ok('render 层展开「施工队 ▸」：父项 open=true', !!parentEntry && parentEntry.open === true)
  const visibleCrew = expanded.filter((e) => e.parentPath === '施工队 ▸')
  ok('render 层展开「施工队 ▸」：四个条目逐项可见且紧跟父项',
    !!parentEntry && visibleCrew.length === CREW_ITEMS.length &&
    visibleCrew.every((e, i) => e.kind === 'item' && e.label === CREW_ITEMS[i][0] && e.action === CREW_ITEMS[i][1] && e.index === parentEntry.index + 1 + i),
    visibleCrew.map((e) => e.label + '@' + e.index).join(' / '))
  ok('收起时施工队条目不可见（不越级）',
    !render.listMenuEntries(items, { tr, lang: 'zh', subOpen: '' }).some((e) => e.label === '复制开工单'))

  // en 翻译：五个固定文案全有译文，且译文本身不残留中文
  const badEn = Object.keys(CREW_EN).filter((label) => tr(label, 'en') !== CREW_EN[label] || /[\u4e00-\u9fa5]/.test(tr(label, 'en')))
  ok('施工队五个固定文案都有正确英文（无中文残留）', badEn.length === 0, badEn.map((l) => l + '→' + tr(l, 'en')).join(' | '))
  // 英文界面整棵树不漏译（专有名词除外）：render 层按 lang 翻译后再查中文残留
  const enVisible = render.listMenuEntries(items, { tr, lang: 'en', subOpen: '施工队 ▸' })
  const leaks = enVisible.filter((e) => /[\u4e00-\u9fa5]/.test(e.label))
  ok('英文界面施工队菜单不漏中文', leaks.length === 0 && enVisible.some((e) => e.label === CREW_EN['复制开工单']), leaks.map((e) => e.label).join(' / '))
} catch (e) {
  ok('施工队菜单结构可验证', false, String(e && e.message))
}

// ======================================================================
console.log('\n[B] 施工队动作：复制模板 / 回退 / 失败指路 / 规范路径（只冒泡不打开外部程序）')
let actionTable = null
try {
  actionTable = actionsMod.createActionTable()
  registerSystemActions(actionTable)
} catch (e) {
  ok('注册系统动作表', false, String(e && e.message))
}

function makeHost() {
  const bubbles = []
  return { bubbles, bubble: (text, ms) => { bubbles.push(String(text)) } }
}

if (actionTable) {
  // B0：四个动作都注册且只依赖 host.bubble（用「只有 bubble」的 host 跑，多取一个字段就会抛）
  for (const [label, action] of CREW_ITEMS) {
    ok('动作已注册：' + action, actionTable.has(action) === true, label)
  }

  // B1：Clipboard API 成功 → 文本逐字等于模板 + 成功气泡
  try {
    const writes = []
    setNavigator({ clipboard: { writeText: (t) => { writes.push(String(t)); return Promise.resolve() } } })
    restoreDocument()
    const cases = [
      ['whale-works:brief', 'brief', '开工单'],
      ['whale-works:worker-card', 'workerCard', '工人卡'],
      ['whale-works:acceptance', 'acceptance', '验收单'],
    ]
    for (const [action, key, name] of cases) {
      writes.length = 0
      const host = makeHost()
      let threw = null
      let ran = false
      try { ran = await actionTable.run(action, host) } catch (e) { threw = e }
      await settle()
      ok('[' + name + '] 处理器只依赖 host.bubble 不抛错', threw === null && ran === true, String(threw && threw.message))
      ok('[' + name + '] Clipboard 收到的文本逐字等于模板',
        writes.length === 1 && writes[0] === WHALE_WORKS_TEMPLATES[key], '写入 ' + writes.length + ' 次')
      ok('[' + name + '] 成功后气泡「已复制：' + name + '」',
        host.bubbles.length === 1 && host.bubbles[0] === '已复制：' + name, host.bubbles.join(' / '))
    }
    restoreNavigator()
  } catch (e) {
    ok('Clipboard 成功路径可验证', false, String(e && e.message))
    restoreNavigator()
  }

  // B2：Clipboard API 拒绝（Promise reject）→ 回退临时 textarea + execCommand
  try {
    setNavigator({ clipboard: { writeText: () => Promise.reject(new Error('denied')) } })
    const fake = makeDocStub(true)
    setDocument(fake.doc)
    const host = makeHost()
    await actionTable.run('whale-works:worker-card', host)
    await settle()
    ok('Clipboard 被拒时回退 textarea + execCommand 成功', fake.created.length === 1 && fake.created[0].tag === 'textarea')
    ok('回退时写进 textarea 的文本等于工人卡模板', !!fake.created[0] && fake.created[0].value === WHALE_WORKS_TEMPLATES.workerCard)
    ok('回退只用临时元素：插入 1 个、移除 1 个', fake.appended.length === 1 && fake.removed.length === 1)
    ok('回退成功仍提示「已复制：工人卡」', host.bubbles.at(-1) === '已复制：工人卡', host.bubbles.join(' / '))
    restoreNavigator()
    restoreDocument()
  } catch (e) {
    ok('Clipboard 拒绝回退可验证', false, String(e && e.message))
    restoreNavigator()
    restoreDocument()
  }

  // B3：Clipboard 同步抛错 + execCommand 成功 → 仍然算成功
  try {
    setNavigator({ clipboard: { writeText: () => { throw new Error('blocked by policy') } } })
    const fake = makeDocStub(true)
    setDocument(fake.doc)
    const host = makeHost()
    let threw = null
    try { await actionTable.run('whale-works:acceptance', host) } catch (e) { threw = e }
    await settle()
    ok('Clipboard 同步抛错不冒泡', threw === null, String(threw && threw.message))
    ok('同步抛错后回退成功 → 提示「已复制：验收单」', host.bubbles.at(-1) === '已复制：验收单', host.bubbles.join(' / '))
    restoreNavigator()
    restoreDocument()
  } catch (e) {
    ok('Clipboard 同步抛错回退可验证', false, String(e && e.message))
    restoreNavigator()
    restoreDocument()
  }

  // B4：Clipboard 不可用 + execCommand 返回 false → 统一失败文案（带文档路径）
  try {
    setNavigator(undefined)
    const fake = makeDocStub(false)
    setDocument(fake.doc)
    const host = makeHost()
    await actionTable.run('whale-works:brief', host)
    await settle()
    ok('复制彻底失败：气泡指路 docs/鲸群营造-工程流程.md',
      host.bubbles.length === 1 &&
      host.bubbles[0] === '复制失败，请手动打开 docs/鲸群营造-工程流程.md',
      host.bubbles.join(' / '))
    restoreNavigator()
    restoreDocument()
  } catch (e) {
    ok('复制失败路径可验证', false, String(e && e.message))
    restoreNavigator()
    restoreDocument()
  }

  // B5：没有任何 DOM/剪贴板（非浏览器极端环境）→ 仍不抛、给失败指路
  try {
    setNavigator(undefined)
    restoreDocument()
    const host = makeHost()
    let threw = null
    try { await actionTable.run('whale-works:acceptance', host) } catch (e) { threw = e }
    await settle()
    ok('无 navigator/document 时复制处理器不抛错', threw === null, String(threw && threw.message))
    ok('无 navigator/document 时给失败指路文案', host.bubbles.at(-1) === '复制失败，请手动打开 docs/鲸群营造-工程流程.md')
    restoreNavigator()
  } catch (e) {
    ok('极端环境复制路径可验证', false, String(e && e.message))
    restoreNavigator()
  }

  // B6：施工规范… 只冒泡显示路径，不打开外部程序
  try {
    const opened = []
    setWindow({ open: (...args) => { opened.push(args); return null } })
    const host = makeHost()
    let threw = null
    try { await actionTable.run('whale-works:guide', host) } catch (e) { threw = e }
    await settle()
    ok('施工规范动作不抛错', threw === null, String(threw && threw.message))
    ok('施工规范气泡显示文档路径',
      host.bubbles.length === 1 && host.bubbles[0].indexOf('docs/鲸群营造-工程流程.md') >= 0,
      host.bubbles.join(' / '))
    ok('施工规范不打开外部程序', opened.length === 0, JSON.stringify(opened))
    restoreWindow()
  } catch (e) {
    ok('施工规范动作可验证', false, String(e && e.message))
    restoreWindow()
  }
  // 恢复初始全局，后面的看板测试不依赖它们
  restoreNavigator()
  restoreDocument()
  restoreWindow()
}

// ======================================================================
console.log('\n[C] team-watch：inspectWhaleWorks → chipText；审批/完成/冷却/旧文案保持原样')
function task(over = {}) {
  return {
    id: 'task-1',
    revision: 1,
    subject: '写测试',
    description: '不应进入气泡',
    status: 'pending',
    blockedBy: [],
    writeScopes: [],
    ready: true,
    writeScopeWarnings: [],
    ...over,
  }
}
function snapshot(tasks, over = {}) {
  return { available: true, enabled: true, tasks, approvals: [], capturedAt: 1, ...over }
}
function makeSource() {
  const listeners = new Set()
  return {
    listeners,
    subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb) },
    emit(value) { for (const cb of [...listeners]) cb(value) },
  }
}
function makeSurface() {
  const calls = []
  return { calls, apply(p) { calls.push(p) }, dispose() { } }
}

try {
  // C1：施工层级任务 → ambient 文案 = inspectWhaleWorks 的 chipText
  {
    const source = makeSource()
    const surface = makeSurface()
    const tasks = [
      task({ id: 'a', subject: '[A] 文件清单', status: 'in_progress' }),
      task({ id: 'a1', subject: '[A1] 顶层文件', status: 'pending', ready: true }),
    ]
    const expected = inspectWhaleWorks(tasks).chipText
    const watch = createTeamWatch({ source, surface, now: () => 1000, cooldownMs: 0 })
    watch.start()
    source.emit(snapshot(tasks))
    const p = surface.calls.at(-1)
    ok('检查器给出施工文案「' + expected + '」', expected === '施工 0/1 分支', expected)
    ok('施工任务板：ambient 文案 = report.chipText', !!p && !!p.ambient && p.ambient.text === expected, JSON.stringify(p))
    ok('施工任务板：tone 沿用原摘要（normal）', !!p && p.ambient.tone === 'normal', p && p.ambient.tone)
    watch.stop()
  }

  // C2：带待验/警告的任务板 → chipText 带「待验 / 警告」
  {
    const source = makeSource()
    const surface = makeSurface()
    const tasks = [
      task({ id: 'a', subject: '[A] 文件清单', status: 'completed' }),
      task({ id: 'a1', subject: '[A1] 顶层文件', status: 'in_progress' }),
      task({ id: 'v', subject: '[V] 独立验收', status: 'pending', ready: true }),
    ]
    const expected = inspectWhaleWorks(tasks).chipText
    const watch = createTeamWatch({ source, surface, now: () => 2000, cooldownMs: 0 })
    watch.start()
    source.emit(snapshot(tasks))
    const p = surface.calls.at(-1)
    ok('待验任务板：chipText 含「待验」与「警告」', /待验/.test(expected) && /警告/.test(expected), expected)
    ok('待验任务板：ambient 用 chipText', !!p && !!p.ambient && p.ambient.text === expected, JSON.stringify(p))
    watch.stop()
  }

  // C3：普通 AgentTeam 任务板（无前缀/无验收/无警告）→ 保持旧计数文案
  {
    const source = makeSource()
    const surface = makeSurface()
    const watch = createTeamWatch({ source, surface, now: () => 3000, cooldownMs: 0 })
    watch.start()
    source.emit(snapshot([task({ status: 'in_progress' })]))
    const p = surface.calls.at(-1)
    ok('无施工报告：普通任务板仍用旧计数文案', !!p && !!p.ambient && p.ambient.text === '1 个任务：1 个在做', JSON.stringify(p))
    watch.stop()
  }

  // C4：审批 alert 保持；ambient 仍用施工文案，且不泄漏工具名
  {
    const source = makeSource()
    const surface = makeSurface()
    const tasks = [
      task({ id: 'a', subject: '[A] 文件清单', status: 'in_progress' }),
      task({ id: 'a1', subject: '[A1] 顶层文件', status: 'pending', ready: true }),
    ]
    const expected = inspectWhaleWorks(tasks).chipText
    const watch = createTeamWatch({ source, surface, now: () => 4000, cooldownMs: 0 })
    watch.start()
    source.emit(snapshot(tasks, { approvals: [{ id: 'ap-1', toolName: 'shell', at: 1, sessionId: 's1' }] }))
    const p = surface.calls.at(-1)
    ok('审批 alert 文案不变', !!p && !!p.alert && p.alert.text === '有个子 Agent 在等你批东西', JSON.stringify(p))
    ok('审批时 ambient 仍用 chipText', !!p && !!p.ambient && p.ambient.text === expected)
    ok('审批 alert 不泄漏工具名', !!p && !String(p.alert.text).includes('shell'))
    watch.stop()
  }

  // C5：全部完成 → 完成 alert 保留、常驻看板不保留（原有收工行为）
  {
    const source = makeSource()
    const surface = makeSurface()
    const watch = createTeamWatch({ source, surface, now: () => 5000, cooldownMs: 0 })
    watch.start()
    source.emit(snapshot([
      task({ id: 'a', subject: '[A] 文件清单', status: 'in_progress' }),
      task({ id: 'a1', subject: '[A1] 顶层文件', status: 'pending', ready: true }),
    ]))
    source.emit(snapshot([
      task({ id: 'a', subject: '[A] 文件清单', status: 'completed' }),
      task({ id: 'a1', subject: '[A1] 顶层文件', status: 'completed' }),
      task({ id: 'v', subject: '[V] 独立验收', status: 'completed' }),
    ]))
    const doneCall = surface.calls.find((p) => p && p.alert && p.alert.text === '鲸群回巢了')
    ok('完成 alert「鲸群回巢了」仍会出现', !!doneCall)
    ok('完成时常驻看板仍清空（不把「验收通过」挂在鱼脚下）', !!doneCall && doneCall.ambient === null, JSON.stringify(doneCall))
    const alerts = surface.calls.filter((p) => p && p.alert).length
    source.emit(snapshot([
      task({ id: 'a', subject: '[A] 文件清单', status: 'completed' }),
      task({ id: 'a1', subject: '[A1] 顶层文件', status: 'completed' }),
      task({ id: 'v', subject: '[V] 独立验收', status: 'completed' }),
    ]))
    ok('重复 done 不重复庆祝（原逻辑不变）', surface.calls.filter((p) => p && p.alert).length === alerts)
    watch.stop()
  }

  // C6：同 fingerprint 不重复 apply（冷却逻辑不变）
  {
    const source = makeSource()
    const surface = makeSurface()
    const watch = createTeamWatch({ source, surface, now: () => 6000, cooldownMs: 0 })
    watch.start()
    const snap = snapshot([
      task({ id: 'a', subject: '[A] 文件清单', status: 'in_progress' }),
      task({ id: 'a1', subject: '[A1] 顶层文件', status: 'pending', ready: true }),
    ])
    source.emit(snap)
    const n1 = surface.calls.length
    source.emit(snap)
    ok('同 fingerprint 不重复 apply（chipText 不影响去重）', surface.calls.length === n1, 'calls=' + surface.calls.length)
    watch.stop()
  }

  // C7：enabled=false → 隐藏（原逻辑不变）
  {
    const source = makeSource()
    const surface = makeSurface()
    const watch = createTeamWatch({ source, surface, now: () => 7000, enabled: () => false, cooldownMs: 0 })
    watch.start()
    source.emit(snapshot([task({ id: 'a', subject: '[A] 文件清单', status: 'in_progress' })]))
    ok('开关关闭仍 apply(null)', surface.calls.at(-1) === null)
    watch.stop()
  }

  // C8：空任务 → apply(null)（空任务保持原有行为）
  {
    const source = makeSource()
    const surface = makeSurface()
    const watch = createTeamWatch({ source, surface, now: () => 8000, cooldownMs: 0 })
    watch.start()
    source.emit(snapshot([]))
    ok('空任务板仍 apply(null)', surface.calls.at(-1) === null)
    watch.stop()
  }

  // C9：静态：调用的是公开接口 inspectWhaleWorks(snapshot.tasks)，只依赖 shared，无新增定时器
  const watchSrc = SRC['src/client/team-watch.ts']
  ok('team-watch 调用 inspectWhaleWorks(snapshot.tasks)', /inspectWhaleWorks\(\s*snapshot\.tasks\s*\)/.test(watchSrc))
  ok('team-watch 从 shared/whale-works 导入公开接口', /from\s+'\.\.\/shared\/whale-works\.js'/.test(watchSrc))
  const watchImports = [...watchSrc.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
  ok('team-watch 只依赖 shared 公开层（不碰 DOM/bubble/scheduler）',
    watchImports.length > 0 && watchImports.every((s) => s.indexOf('../shared/') === 0), watchImports.join(','))
  ok('team-watch 没有新增定时器', !/\b(setTimeout|setInterval|requestAnimationFrame)\b/.test(watchSrc))
} catch (e) {
  ok('team-watch 施工看板接入可验证', false, String(e && e.message))
}

// ======================================================================
console.log('\n[D] 只读边界：无 team_task_* / 任务板写调用；模板不复制内部逻辑')
try {
  const FORBIDDEN_CALL = /\bteam_task_[A-Za-z0-9_]*\s*\(|\b(?:createTask|updateTask|claimTask|deleteTask|reassignTask|completeTask)\s*\(|\bagentTeams\b|\bremote\.[A-Za-z_$]/
  for (const [name, src] of Object.entries({
    'src/client/team-watch.ts': SRC['src/client/team-watch.ts'],
    'src/client/menu.ts': SRC['src/client/menu.ts'],
    'src/client/actions/system.ts': SRC['src/client/actions/system.ts'],
  })) {
    ok(name + ' 没有任务板写调用（team_task_* / createTask / agentTeams …）', !FORBIDDEN_CALL.test(src))
  }

  // 接入层只 import 相对模块（不 import DSH 内部实现）
  for (const [name, src] of Object.entries(SRC)) {
    const specs = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
    ok(name + ' 没有 import DSH 内部模块（全部相对路径）', specs.every((s) => s.indexOf('.') === 0), specs.join(','))
  }

  // 模板只读自 WHALE_WORKS_TEMPLATES，不在 system.ts 里复制模板正文
  const systemSrc = SRC['src/client/actions/system.ts']
  ok('system.ts 从 WHALE_WORKS_TEMPLATES 取模板',
    /WHALE_WORKS_TEMPLATES\.(brief|workerCard|acceptance)/.test(systemSrc) &&
    /from\s+'\.\.\/\.\.\/shared\/whale-works\.js'/.test(systemSrc))
  const copiedTemplate = ['[E] {工程名}', '[工卡] {分支}', '[V] 独立验收单', '验收矩阵：']
  const copied = copiedTemplate.filter((word) => systemSrc.indexOf(word) >= 0)
  ok('system.ts 没有复制模板正文（只引用公开常量）', copied.length === 0, copied.join(','))
  ok('模板常量在共享层冻结（只读）', Object.isFrozen(WHALE_WORKS_TEMPLATES))
  // 四个动作串里不出现任务写入相关名字
  for (const [, action] of CREW_ITEMS) {
    ok('动作名不含任务写语义：' + action, !/task|claim|complete|assign|create|update|delete/i.test(action.replace('whale-works:', '')))
  }
} catch (e) {
  ok('只读边界可验证', false, String(e && e.message))
}

// ---------- 还原全局 ----------
restoreNavigator()
restoreDocument()
restoreWindow()
delete globalThis.localStorage

console.log('\n────────────────────')
if (fail === 0) console.log('✅ 通过 ' + pass + ' 项，失败 0 项')
else console.log('❌ 通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
