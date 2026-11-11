/**
 * scripts/test-menu-actions.mjs —— 菜单/动作分身的独立回归（不并入 npm test，避免改 package.json）
 *
 * 覆盖本次「菜单/动作模块」审查里真正有证据的四处：
 *   A. 菜单可见项（listMenuEntries）与渲染行（renderMenuItems）逐项对齐 ——
 *      键盘高亮下标与可执行项是同一份清单；二级菜单必须是「父路径\0子项」才展开。
 *   B. 版本号显示口径 —— 标题栏必须带版本（renderMenuHeader），菜单项里不重复
 *      （需求变更 2026-11-05，scripts/test.mjs:111-117 已把「不含版本项」钉死）。
 *   C. 连播开关 —— 菜单标签读 localStorage，动作也必须读同一个源：
 *      一本书讲完后 client/story.ts 会把内存 auto 清 false 而不动 localStorage，
 *      旧动作按内存取反 → 菜单显示「开」，点一下却先设成「开」，得点两下才关。
 *   D. 聊天缓存开关 —— 连点只发一次请求（在途忽略）、失败/同步抛错都回滚、
 *      失败后锁能放掉（不会永久停在「稍等～」）。
 *
 * 纯离线：不联网、不起 HTTP、不碰 dist；localStorage/fetch 全部打桩，结束还原。
 * 8 秒兜底超时只做代码路径覆盖（不真等 8 秒），见 D 组注释。
 *
 * 用法：node scripts/test-menu-actions.mjs   （失败退出码 1）
 */

import { register } from 'node:module'

// 测试里直接加载 .ts：注册解析钩子，把找不到的 .js 回退到同名 .ts
register(new URL('./ts-resolve.mjs', import.meta.url))

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.error('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

// ---------- localStorage 打桩（可模拟「禁存储」：读写抛错） ----------
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
    dump() { return new Map(map) },
  }
  return s
}
const storage = makeStorage()
globalThis.localStorage = storage

const realFetch = globalThis.fetch
const realWindow = globalThis.window

// ---------- 菜单 / 渲染工具 ----------
const menu = await import('../src/client/menu.ts')
const render = await import('../src/client/render.ts')
const { buildMenu, tr } = menu
const { listMenuEntries, renderMenuItems, renderMenuHeader, readMenuRuntime } = render
const { VERSION } = await import('../src/client/version.ts')

/** React.createElement 同形打桩：把树收成 {type, props, children} */
const h = (type, props, ...children) => ({ type, props: props || {}, children })

function flattenNodes(nodes, out = []) {
  for (const n of nodes) {
    if (Array.isArray(n)) { flattenNodes(n, out); continue }
    if (!n || typeof n !== 'object') continue
    out.push(n)
    if (Array.isArray(n.children)) flattenNodes(n.children, out)
  }
  return out
}
function nodeText(n) {
  if (typeof n === 'string') return n
  if (Array.isArray(n)) return n.map(nodeText).join('')
  if (!n || typeof n !== 'object') return ''
  return (n.children || []).map(nodeText).join('')
}
function flattenItems(items, out = []) {
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    out.push(it)
    if (Array.isArray(it.items)) flattenItems(it.items, out)
  }
  return out
}
function labelsOf(items) {
  return flattenItems(items).map((it) => it.label).filter((x) => typeof x === 'string')
}
/** 当前菜单状态下、菜单里会显示的「连播」文案（与 client.ts 传参口径一致） */
function menuLabelsWithRuntime(extra = {}) {
  return labelsOf(buildMenu('9.9.9', Object.assign({}, readMenuRuntime(), extra)))
}
function renderRows(items, subOpen) {
  const tree = renderMenuItems(items, {
    h, tr, lang: 'zh', subOpen, focusIndex: -1,
    onToggleSub: () => { }, onAction: () => { },
  })
  return flattenNodes(tree).filter((n) => n.props && n.props.role === 'menuitem')
}

// ======================================================================
console.log('\n[A] 菜单：可见项 ↔ 渲染行（键盘高亮下标与可执行项同源）')
try {
  const items = buildMenu('9.9.9', {
    storyBooks: ['聊斋', '西游记'], storyBooksTried: true,
    storyAuto: true, streamOn: true,
    narrationRate: '-25%', poemRate: '-25%', storyRate: '-35%', chatRate: '-20%',
  })
  // 子菜单 label 自带「 ▸」（menu.ts 的构造约定），路径就是完整 label、父级用 NUL 分隔
  const P_CULTURE = '文化气 ▸'
  const P_COUPLET = '出个对联 ▸'
  const P_RATE = '说书语速：-35% ▸'
  const cases = ['', P_CULTURE, P_CULTURE + '\u0000' + P_COUPLET, '换个声音 ▸', P_CULTURE + '\u0000' + P_RATE]
  let aligned = true
  let indexOk = true
  const detail = []
  for (const subOpen of cases) {
    const entries = listMenuEntries(items, { tr, lang: 'zh', subOpen })
    const rows = renderRows(items, subOpen)
    if (entries.length !== rows.length) {
      aligned = false
      detail.push((subOpen || '顶层') + ' 行数 ' + rows.length + ' ≠ 项数 ' + entries.length)
    }
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      if (e.index !== i) indexOk = false
      const row = rows[i]
      if (!row || row.props['aria-label'] !== e.label) aligned = false
      if (e.kind === 'item' && row && typeof row.props.onClick === 'function' && !e.action) aligned = false
    }
  }
  ok('五种展开状态下，可见项数量与渲染行一致', aligned && detail.length === 0, detail.join(' | '))
  ok('可见项 index 连续重编号（高亮可寻址）', indexOk)

  // 二级菜单路径：必须带父级才展开（不越级）
  const deep = listMenuEntries(items, { tr, lang: 'zh', subOpen: P_CULTURE + '\u0000' + P_COUPLET })
  const atRandom = deep.findIndex((e) => e.label === '随机一副')
  const atParent = deep.findIndex((e) => e.label === P_COUPLET)
  ok('二级菜单（文化气 → 出个对联）能展开', atParent >= 0 && atRandom === atParent + 1, '父 ' + atParent + ' / 子 ' + atRandom)
  ok('二级菜单子项紧跟父项（Enter 后高亮不越级）', atRandom === atParent + 1)
  const orphan = listMenuEntries(items, { tr, lang: 'zh', subOpen: P_COUPLET })
  ok('只给子菜单名（缺父路径）不展开', orphan.every((e) => e.label !== '随机一副'))

  // 分隔线与不可见项不占高亮序号
  const topLevel = listMenuEntries(items, { tr, lang: 'zh', subOpen: '' })
  const seps = items.filter((it) => it && it.type === 'sep').length
  const topRows = items.filter((it) => it && (it.type === 'item' || it.type === 'sub')).length
  ok('分隔线不进可见项清单', topLevel.length === topRows && seps > 0, '选项 ' + topLevel.length + ' / 分隔线 ' + seps)
} catch (e) {
  ok('菜单渲染对齐可验证', false, String(e && e.message))
}

// ======================================================================
console.log('\n[A2] 菜单脏值归一：勾选与运行时实际值同口径')
try {
  // 手改/旧版本留下的非法值：运行时分别回落 auto（chat.ts resolveChatLang）
  // 与默认晓伊（voice/voices.ts normalizeVoiceName），菜单必须跟着勾到同一项
  const dirty = labelsOf(buildMenu('9.9.9', { chatLang: 'zh-CN', ttsVoice: 'bogus-voice' }))
  ok('非法聊天语言 → 勾「自动」', dirty.indexOf('✓ 自动') >= 0, dirty.filter((x) => x.indexOf('✓') === 0).join(' / '))
  ok('非法音色 → 勾默认晓伊', dirty.indexOf('✓ 音色：晓伊（中·女）') >= 0)
  const zhV = labelsOf(buildMenu('9.9.9', { chatLang: 'zh', ttsVoice: 'auto' }))
  ok('合法值照常勾选（中文 / 自动音色）', zhV.indexOf('✓ 中文') >= 0 && zhV.indexOf('✓ 自动（按语言选音色）') >= 0)
  const enV = labelsOf(buildMenu('9.9.9', { chatLang: 'en', ttsVoice: 'en-US-AnaNeural' }))
  ok('英文聊天 + Ana 音色照常勾选', enV.indexOf('✓ English') >= 0 && enV.indexOf('✓ 音色：Ana（英·女）') >= 0)
} catch (e) {
  ok('菜单脏值归一可验证', false, String(e && e.message))
}

// ======================================================================
console.log('\n[B] 版本号：标题栏显示、菜单项不重复')
try {
  const header = renderMenuHeader({ h, lang: 'zh', balanceText: '', onRefresh: () => { } })
  ok('标题栏带版本号', nodeText(header).indexOf('肥鲸 · v' + VERSION) >= 0, nodeText(header))
  const items = buildMenu('1.2.3', {})
  const all = flattenItems(items)
  ok('菜单项不再重复版本（test.mjs 现行口径）', all.every((it) => it.label !== '版本：v1.2.3' && it.action !== 'version'))
  ok('tr 的版本模板仍可用（标题栏/旧调用兼容）', tr('版本：v1.2.3', 'en') === 'Version: v1.2.3')
} catch (e) {
  ok('版本号显示可验证', false, String(e && e.message))
}

// ======================================================================
console.log('\n[C] 连播开关：菜单标签与动作读同一个源（localStorage）')
try {
  const { createActionTable } = await import('../src/client/actions.ts')
  const { registerCultureActions } = await import('../src/client/actions/culture.ts')
  const t = createActionTable()
  registerCultureActions(t)

  const bubbles = []
  const refs = { auto: { current: false }, busy: { current: false }, narrating: { current: false }, book: { current: '' } }
  const host = { bubble: (x) => bubbles.push(String(x)), storyState: refs }

  // C1：一本书讲完（story.ts 会清内存 auto）但 localStorage 仍是「开」
  storage.setItem('chubby-story-auto', '1')
  refs.auto.current = false
  const labelBefore = menuLabelsWithRuntime().find((l) => l.indexOf('连播：') === 0)
  await t.run('story-auto', host)
  const labelAfter = menuLabelsWithRuntime().find((l) => l.indexOf('连播：') === 0)
  ok('菜单原先显示「开」', labelBefore && labelBefore.indexOf('连播：开') === 0, String(labelBefore))
  ok('点一下真的关掉（写入 0、内存同步、气泡说关）',
    storage.getItem('chubby-story-auto') === '0' && refs.auto.current === false && String(bubbles[bubbles.length - 1]).indexOf('连播：关') === 0,
    storage.getItem('chubby-story-auto') + ' / ' + bubbles[bubbles.length - 1])
  ok('菜单标签随动作翻转成「关」', labelAfter && labelAfter.indexOf('连播：关') === 0, String(labelAfter))

  // C2：反方向（内存被点播置 true、localStorage 是关）
  storage.setItem('chubby-story-auto', '0')
  refs.auto.current = true
  await t.run('story-auto', host)
  ok('菜单显示「关」时点一下变成开',
    storage.getItem('chubby-story-auto') === '1' && refs.auto.current === true && String(bubbles[bubbles.length - 1]).indexOf('连播：开') === 0,
    storage.getItem('chubby-story-auto') + ' / ' + bubbles[bubbles.length - 1])

  // C3：禁存储（读写都抛）不炸，退回内存值取反
  storage.failGet = true
  storage.failSet = true
  refs.auto.current = false
  let threw = null
  try { await t.run('story-auto', host) } catch (e) { threw = e }
  ok('localStorage 读写抛错不冒泡', threw === null, String(threw))
  ok('禁存储时按内存值切换（false → true）', refs.auto.current === true && String(bubbles[bubbles.length - 1]).indexOf('连播：开') === 0)
  storage.failGet = false
  storage.failSet = false
} catch (e) {
  ok('连播动作可验证', false, String(e && e.message))
}

// ======================================================================
console.log('\n[D] 聊天缓存开关：连点只发一次、失败回滚、锁能释放')
try {
  const { createActionTable } = await import('../src/client/actions.ts')
  const { registerSystemActions } = await import('../src/client/actions/system.ts')
  const t = createActionTable()
  registerSystemActions(t)

  const bubbles = []
  const sets = []
  let cacheOn = false
  const host = {
    bubble: (x) => bubbles.push(String(x)),
    chatCacheOn: () => cacheOn,
    setChatCacheOn: (v) => { cacheOn = !!v; sets.push(!!v) },
  }

  // D1：第一下在途时连点 —— 只能有一个请求，第二下给「稍等」
  const pending = []
  globalThis.fetch = (url) => new Promise((resolve) => pending.push({ url: String(url), resolve }))
  await t.run('cache-toggle', host)
  ok('乐观翻转（先改本地）', cacheOn === true)
  await t.run('cache-toggle', host)
  ok('在途连点被忽略：只发一个请求', pending.length === 1, '实际 ' + pending.length)
  ok('在途连点有提示', bubbles.some((b) => b.indexOf('正在切换') === 0))
  ok('第二下没有把本地值翻回去', cacheOn === true)
  pending[0].resolve({ ok: true, status: 200, json: async () => ({ ok: true, enabled: true }) })
  await tick(10)
  ok('回执后按宿主实际值收敛 + 提示开', cacheOn === true && bubbles.some((b) => b.indexOf('聊天缓存：开') === 0))

  // D2：宿主失败 → 回滚到操作前的值
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: false }) })
  await t.run('cache-toggle', host) // true → 乐观 false → 回滚 true
  await tick(10)
  ok('宿主失败回滚到操作前', cacheOn === true)
  ok('失败只提示一句', bubbles[bubbles.length - 1] === '切换失败', bubbles[bubbles.length - 1])

  // D3：请求同步抛错（fetch 不可用）→ 也要回滚，且不把异常冒到分发层
  globalThis.fetch = () => { throw new Error('fetch missing') }
  let threw = null
  try { await t.run('cache-toggle', host) } catch (e) { threw = e }
  await tick(0)
  ok('同步抛错不冒泡', threw === null, String(threw))
  ok('同步抛错也回滚', cacheOn === true, String(cacheOn))
  ok('同步抛错提示失败', bubbles[bubbles.length - 1] === '切换失败', bubbles[bubbles.length - 1])

  // D4：失败后锁必须已释放（否则开关永久停在「稍等～」）
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, enabled: false }) })
  await t.run('cache-toggle', host) // true → 乐观 false → 宿主 false
  await tick(10)
  ok('失败后锁已释放，下一次点击仍生效', cacheOn === false && bubbles.some((b) => b.indexOf('聊天缓存：关') === 0))

  // 备注：8 秒无回执的兜底回滚（finish(!nowOn, '切换失败')）走同一条 settle 路径，
  // 上面 D2/D3/D4 已覆盖「释放锁 + 回滚」；不真等 8 秒，避免拖慢离线回归。
  globalThis.fetch = realFetch
} catch (e) {
  ok('缓存开关动作可验证', false, String(e && e.message))
} finally {
  globalThis.fetch = realFetch
}

// ======================================================================
console.log('\n[E] 动作覆盖：可见菜单项都有处理器，且没有空动作项')
try {
  const { createActionTable } = await import('../src/client/actions.ts')
  const mods = await Promise.all([
    import('../src/client/actions/culture.ts'),
    import('../src/client/actions/content.ts'),
    import('../src/client/actions/system.ts'),
    import('../src/client/actions/voice.ts'),
  ])
  const t = createActionTable()
  mods[0].registerCultureActions(t)
  mods[1].registerContentActions(t)
  mods[2].registerSystemActions(t)
  mods[3].registerVoiceActions(t)
  const actionsMod = await import('../src/client/actions.ts')
  actionsMod.registerSkinActions(t)

  const items = buildMenu('9.9.9', { storyBooks: ['聊斋'], storyBooksTried: true })
  const all = flattenItems(items)
  const empties = all.filter((it) => it.type === 'item' && !String(it.action || '').trim())
  ok('没有「有空动作」的菜单项', empties.length === 0, empties.map((x) => x.label).join(','))
  const visible = listMenuEntries(items, { tr, lang: 'zh', subOpen: '文化气' })
  const dead = visible.filter((e) => e.kind === 'item' && !t.has(e.action))
  ok('可见项（含展开的二级菜单）全部有处理器', dead.length === 0, dead.map((x) => x.label + '(' + x.action + ')').join(' | '))
  ok('动作表规模合理', t.actions().length >= 40, '精确 ' + t.actions().length + ' / 前缀 ' + t.prefixes().length)
} catch (e) {
  ok('动作覆盖可验证', false, String(e && e.message))
}

// ---------- 还原全局 ----------
globalThis.localStorage = undefined
delete globalThis.localStorage
globalThis.fetch = realFetch
if (realWindow !== undefined) globalThis.window = realWindow

console.log('\n────────────────────')
if (fail === 0) console.log('✅ 通过 ' + pass + ' 项，失败 0 项')
else console.log('❌ 通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
