/**
 * scripts/test-menu-hierarchy.mjs —— 右键菜单「设置」层级重构的独立回归（不并入 npm test，避免改 package.json）
 *
 * 背景（2026-11-14 重构）：高频命令留在一级；所有开关/选择类统一收进一级「设置 ▸」，
 * 设置内部再分「显示与语言 / 语音与耳朵 / 行为开关 / 数据与维护」四组。
 * 本文件钉住的正是这次重构最容易悄悄坏掉、且肉眼不容易发现的地方：
 *   A. 一级只剩高频命令：顺序固定、没有「：开/关」开关、没有语言/音色/语速/维护入口；
 *      设置放在最上面、退出永远最后一个。
 *   B. 设置四组的分组结构、组内顺序、每个开关/选择都落在规定的组里。
 *   C. 所有开关/选择类 action 只能从设置子树抵达 —— 一级菜单不再散落任何一条。
 *   D. 动作字符串全集与重构前逐字一致（117 个，含随状态变化的曲目/书单/语速档位）——
 *      只调整树的位置与层级，不改变任何 action。
 *   E. 三级子菜单路径能逐级展开（设置 → 语音与耳朵 → 说书语速），
 *      listMenuEntries 与 renderMenuItems 在每一层都对齐（键盘高亮不错项）。
 *   F. 中英双语：四个新分组标题与「界面语言：/聊天语言：」动态前缀都有译文，英文界面不漏中文。
 *   G. 数据层结构合法：无空子菜单、无字段混用、无重复 action、分隔符不成串不在首尾。
 *
 * 做法与 test-menu-actions 一致：注册 ts-resolve 钩子后直接 import src/client/menu.ts，
 * 纯离线、不联网、不碰 dist、不读浏览器存储。
 *
 * 用法：node scripts/test-menu-hierarchy.mjs   （全过退出码 0，有失败退出码 1）
 */

import { register } from 'node:module'

register(new URL('./ts-resolve.mjs', import.meta.url))

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.error('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const show = (v) => (v === null || typeof v === 'undefined' ? String(v) : JSON.stringify(v))

const menu = await import('../src/client/menu.ts')
const render = await import('../src/client/render.ts')
const { buildMenu, tr } = menu
const { listMenuEntries, renderMenuItems } = render

/** 子菜单路径分隔符（与 client/render.ts 的 SUB_PATH_SEP 同款） */
const NUL = '\u0000'
const joinPath = (...parts) => parts.filter(Boolean).join(NUL)

// 结构检查用的固定状态：语速/书单/音色都给确定值，标签才可复现
const STATE = {
  growth: '熟悉（200）',
  storyBooks: ['聊斋'], storyBooksTried: true,
  storyAuto: true, streamOn: true,
  voiceOn: true, earOn: true, voiceChatOn: true,
  chatLang: 'zh', ttsVoice: 'zh-CN-XiaoyiNeural', chatCacheOn: true,
  narrationRate: '-25%', poemRate: '-25%', storyRate: '-35%', chatRate: '-15%',
  skinFixed: false, toolNarratorOn: true, poemEchoOn: true, nervousOn: true,
  teamBoardOn: true, webSearchOn: false,
}
const TOP = buildMenu('9.9.9', STATE)

// 与重构前基线同口径的多状态：覆盖开关两态、书单两态、曲目/语速不同档位
const STATES = [
  {},
  { voiceOn: true, earOn: true, voiceChatOn: true, chatCacheOn: false, chatLang: 'zh', ttsVoice: 'zh-CN-YunxiNeural' },
  { chatLang: 'en', ttsVoice: 'auto' },
  { chatLang: 'zh', ttsVoice: 'en-GB-SoniaNeural' },
  { storyBooksTried: true },
  { skinFixed: true, storyAuto: false, streamOn: false, toolNarratorOn: false, poemEchoOn: false, nervousOn: false, teamBoardOn: false, webSearchOn: true },
  { storyBooks: ['聊斋', '西游记'], storyBooksTried: true, storyAuto: true, streamOn: true, narrationRate: '-15%', poemRate: '-20%', storyRate: '-30%', chatRate: '-20%', melodies: ['小星星'] },
  { narrationRate: '-20%', poemRate: '-25%', storyRate: '-40%', chatRate: '+10%' },
]

/** 遍历：visit(item, 祖先子菜单 label 数组, 层级)；根层 depth=1 */
function walk(items, visit, path = [], depth = 1) {
  if (!Array.isArray(items)) return
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    visit(it, path, depth)
    if (it.type === 'sub') walk(it.items, visit, path.concat(it.label), depth + 1)
  }
}
const visibleTop = (items) => items.filter((it) => it && (it.type === 'item' || it.type === 'sub'))
const findSub = (items, label) => (items || []).find((it) => it && it.type === 'sub' && it.label === label)
const findItem = (items, label) => (items || []).find((it) => it && it.type === 'item' && it.label === label)
/** 组内直接子项序列：子菜单记 sub:标题，普通项记 item:action（分隔符不参与） */
function childSeq(sub) {
  return (sub && Array.isArray(sub.items) ? sub.items : [])
    .filter((it) => it && it.type !== 'sep')
    .map((it) => (it.type === 'sub' ? 'sub:' + it.label : 'item:' + it.action))
}
/** action → 它出现的全部祖先子菜单路径（每个路径是 label 数组） */
function actionPaths(items) {
  const map = new Map()
  walk(items, (it, path) => {
    if (!it || it.type !== 'item') return
    const list = map.get(it.action) || []
    list.push(path.slice())
    map.set(it.action, list)
  })
  return map
}
/** 菜单里找某个 action 的当前文案；找不到回 null */
function labelOf(items, action) {
  let hit = null
  walk(items, (it) => { if (hit === null && it && it.type === 'item' && it.action === action) hit = it.label })
  return hit
}
/** 结构体检：三种形态不混字段、子菜单非空 */
function shapeProblems(items, depth = 1, out = []) {
  if (!Array.isArray(items)) { out.push('第 ' + depth + ' 层不是数组'); return out }
  items.forEach((it, i) => {
    const at = '第 ' + depth + ' 层#' + i
    if (!it || typeof it !== 'object' || Array.isArray(it)) { out.push(at + ' 不是对象'); return }
    if (it.type === 'sep') {
      if (Object.keys(it).length !== 1) out.push(at + ' 分隔符带多余字段')
      return
    }
    if (it.type === 'sub') {
      if (typeof it.label !== 'string' || it.label.trim() === '') out.push(at + ' 子菜单标题为空')
      if (typeof it.items !== 'undefined' && !Array.isArray(it.items)) out.push(at + ' items 不是数组')
      if (!Array.isArray(it.items) || it.items.length === 0) out.push(at + ' 子菜单为空')
      else shapeProblems(it.items, depth + 1, out)
      return
    }
    if (it.type !== 'item') out.push(at + ' 未知类型 ' + show(it.type))
    if (typeof it.label !== 'string' || it.label.trim() === '') out.push(at + ' label 不是非空字符串')
    if (typeof it.action !== 'string' || it.action === '') out.push(at + ' action 不是非空字符串')
  })
  return out
}
/** 分隔符体检：相邻不许两条、末尾不许分隔符（首行分隔线是菜单既有样式，允许） */
function sepProblems(items, where, out = []) {
  if (!Array.isArray(items) || items.length === 0) { out.push(where + ' 为空'); return out }
  if (items[items.length - 1] && items[items.length - 1].type === 'sep') out.push(where + ' 以分隔符结尾')
  for (let i = 1; i < items.length; i++) {
    if (items[i] && items[i - 1] && items[i].type === 'sep' && items[i - 1].type === 'sep') {
      out.push(where + ' 第 ' + i + '/' + (i + 1) + ' 条连续分隔符')
    }
  }
  for (const it of items) {
    if (it && it.type === 'sub') sepProblems(it.items, where + ' › ' + it.label, out)
  }
  return out
}

// ======================================================================
console.log('\n[A] 一级菜单：只剩高频命令，设置放在最上面，退出永远最后')
const topLabels = visibleTop(TOP).map((it) => it.label)
const EXPECT_TOP = [
  '设置 ▸',
  '跟她说两句',
  '阅读文档 ▸',
  '公文校对…',
  '投喂一碗',
  '成长：熟悉（200）',
  '记个饭点…',
  '提醒清单…',
  '文化气 ▸',
  '选本书 ▸',
  '今日一句',
  '今日简报',
  '弹首曲子 ▸',
  '停止弹奏',
  '让她歇会儿',
  '回碗里待着',
  '数据与统计 ▸',
  '鱼粮账本',
  '让它游走（退出）',
]
ok('一级菜单顺序与设计一致（高频命令 + 设置 + 退出）', eq(topLabels, EXPECT_TOP), topLabels.join(' / '))
ok('一级没有「：开 / ：关」开关项', !topLabels.some((l) => /：开$/.test(l) || /：关$/.test(l)))
const topSwitchLike = topLabels.filter((l) => /语言|音色|语速|唤醒词|端点检测|耳朵自检|自检|背景|缓存|搜索|解说|弹幕|感知|看板|长大|变小/.test(l))
ok('一级没有开关/选择类文案残留', topSwitchLike.length === 0, topSwitchLike.join(' / '))
const settings = findSub(TOP, '设置 ▸')
ok('一级有「设置 ▸」子菜单', !!settings)
const setIdx = visibleTop(TOP).findIndex((it) => it.label === '设置 ▸')
ok('「设置 ▸」在最上面（第 1 项）', setIdx === 0, 'index=' + setIdx + ' / 共 ' + visibleTop(TOP).length + ' 项')
ok('「让它游走（退出）」是最后一项', topLabels[topLabels.length - 1] === '让它游走（退出）')
const topActions = new Set(visibleTop(TOP).filter((it) => it.type === 'item').map((it) => it.action))
ok('一级子菜单只有 设置/阅读文档/文化气/选本书/弹首曲子/数据与统计',
  eq(topLabels.filter((l) => l.endsWith('▸')), ['设置 ▸', '阅读文档 ▸', '文化气 ▸', '选本书 ▸', '弹首曲子 ▸', '数据与统计 ▸']))

// ======================================================================
console.log('\n[B] 设置 → 四个分组：分组、组内顺序、每个条目落位')
const GROUP_LABELS = ['显示与语言 ▸', '语音与耳朵 ▸', '行为开关 ▸', '数据与维护 ▸']
const groupSubs = (settings ? settings.items : []).filter((it) => it && it.type === 'sub')
ok('设置下正好四个分组子菜单', groupSubs.length === 4, groupSubs.map((s) => s.label).join(' / '))
ok('四个分组标题与顺序正确', eq(groupSubs.map((s) => s.label), GROUP_LABELS))
ok('设置分组之间没有散落的顶级开关项',
  (settings ? settings.items : []).filter((it) => it && it.type === 'item').length === 0,
  (settings ? settings.items : []).filter((it) => it && it.type === 'item').map((it) => it.label).join(' / '))

const EXPECT_CHILD = {
  '显示与语言 ▸': [
    'sub:界面语言 ▸', 'sub:聊天语言 ▸',
    'item:skin-fixed', 'item:skin-bg-reset', 'item:bigger', 'item:smaller',
  ],
  '语音与耳朵 ▸': [
    'item:voice', 'item:tts-stop', 'item:wake', 'item:chatmode', 'item:stream-toggle',
    'sub:换个声音 ▸', 'sub:唤醒词 ▸',
    'item:endpoint', 'item:ear-check', 'item:voice-export',
    'sub:说书语速：-35% ▸', 'sub:聊天语速：-15% ▸', 'sub:叙述语速：-25% ▸', 'sub:念诗语速：-25% ▸',
  ],
  '行为开关 ▸': [
    'item:tool-narrator', 'item:poem-echo', 'item:nervous', 'item:nervous-status',
    'item:team-board', 'item:web-search', 'item:cache-toggle', 'item:story-auto',
  ],
  '数据与维护 ▸': [
    'item:config-view', 'item:remind-manage', 'item:wake-recover', 'item:cache-clear', 'item:clear-memory',
  ],
}
for (const g of GROUP_LABELS) {
  const node = findSub(settings ? settings.items : [], g)
  ok('「' + g + '」存在且顺序正确', !!node && groupSubs.some((s) => s.label === g))
  ok('「' + g + '」组内顺序/条目与设计一致', !!node && eq(childSeq(node), EXPECT_CHILD[g]), show(childSeq(node)))
}

// 子菜单内部：语言、音色、唤醒词、四类语速的档位一个不少
const EXPECT_INNER = [
  ['显示与语言 ▸', '界面语言 ▸', ['item:lang:zh', 'item:lang:en']],
  ['显示与语言 ▸', '聊天语言 ▸', ['item:chat-lang:auto', 'item:chat-lang:zh', 'item:chat-lang:en']],
  ['语音与耳朵 ▸', '换个声音 ▸', ['item:voice:zh-CN-XiaoyiNeural', 'item:voice:zh-CN-XiaoxiaoNeural', 'item:voice:zh-CN-XiaochenNeural', 'item:voice:zh-CN-YunxiNeural', 'item:voice:zh-CN-YunyangNeural', 'item:voice:en-US-AnaNeural', 'item:voice:en-US-JennyNeural', 'item:voice:en-GB-SoniaNeural', 'item:voice:auto']],
  ['语音与耳朵 ▸', '唤醒词 ▸', ['item:wake-word:', 'item:wake-word:大肥鱼', 'item:wake-word:肥鲸', 'item:wake-word:小鲸', 'item:wake-word:custom']],
  ['语音与耳朵 ▸', '说书语速：-35% ▸', ['item:story-rate:-25%', 'item:story-rate:-30%', 'item:story-rate:-35%', 'item:story-rate:-40%']],
  ['语音与耳朵 ▸', '聊天语速：-15% ▸', ['item:chat-rate:+10%', 'item:chat-rate:+0%', 'item:chat-rate:-15%', 'item:chat-rate:-10%', 'item:chat-rate:-20%', 'item:chat-rate:-30%']],
  ['语音与耳朵 ▸', '叙述语速：-25% ▸', ['item:narration-rate:-15%', 'item:narration-rate:-20%', 'item:narration-rate:-25%', 'item:narration-rate:-30%']],
  ['语音与耳朵 ▸', '念诗语速：-25% ▸', ['item:poem-rate:-15%', 'item:poem-rate:-20%', 'item:poem-rate:-25%', 'item:poem-rate:-30%']],
]
for (const [group, subLabel, expected] of EXPECT_INNER) {
  const g = findSub(settings ? settings.items : [], group)
  const s = findSub(g ? g.items : [], subLabel)
  ok('「' + group + ' › ' + subLabel + '」档位齐全', !!s && eq(childSeq(s), expected), show(childSeq(s)))
}

// ======================================================================
console.log('\n[C] 所有开关/选择类动作只能从「设置」子树抵达')
const SETTINGS_ONLY = [
  // 显示与语言
  'lang:zh', 'lang:en', 'chat-lang:auto', 'chat-lang:zh', 'chat-lang:en',
  'skin-fixed', 'skin-bg-reset', 'bigger', 'smaller',
  // 语音与耳朵
  'voice', 'tts-stop', 'wake', 'chatmode', 'stream-toggle', 'endpoint', 'ear-check', 'voice-export',
  'voice:zh-CN-XiaoyiNeural', 'voice:zh-CN-XiaoxiaoNeural', 'voice:zh-CN-XiaochenNeural',
  'voice:zh-CN-YunxiNeural', 'voice:zh-CN-YunyangNeural', 'voice:en-US-AnaNeural',
  'voice:en-US-JennyNeural', 'voice:en-GB-SoniaNeural', 'voice:auto',
  'wake-word:', 'wake-word:大肥鱼', 'wake-word:肥鲸', 'wake-word:小鲸', 'wake-word:custom',
  'story-rate:-25%', 'story-rate:-30%', 'story-rate:-35%', 'story-rate:-40%',
  'chat-rate:+10%', 'chat-rate:+0%', 'chat-rate:-15%', 'chat-rate:-10%', 'chat-rate:-20%', 'chat-rate:-30%',
  'narration-rate:-15%', 'narration-rate:-20%', 'narration-rate:-25%', 'narration-rate:-30%',
  'poem-rate:-15%', 'poem-rate:-20%', 'poem-rate:-25%', 'poem-rate:-30%',
  // 行为开关
  'tool-narrator', 'poem-echo', 'nervous', 'nervous-status', 'team-board', 'web-search',
  'cache-toggle', 'story-auto',
  // 数据与维护
  'config-view', 'remind-manage', 'wake-recover', 'cache-clear', 'clear-memory',
]
{
  const paths = actionPaths(TOP)
  const missing = SETTINGS_ONLY.filter((a) => !paths.has(a))
  ok('所有开关/选择类动作都还在菜单里（无遗漏）', missing.length === 0, missing.join(','))
  const outside = []
  for (const a of SETTINGS_ONLY) {
    for (const p of paths.get(a) || []) {
      if (p[0] !== '设置 ▸') outside.push(a + ' ← ' + p.join(' › '))
    }
  }
  ok('开关/选择类动作全部位于「设置」子树', outside.length === 0, outside.slice(0, 5).join(' | '))
  const leakedTop = [...topActions].filter((a) => SETTINGS_ONLY.includes(a))
  ok('一级菜单没有任何开关/选择类 action', leakedTop.length === 0, leakedTop.join(','))
  const dup = []
  for (const [a, list] of paths) if (list.length > 1) dup.push(a + '×' + list.length)
  ok('同一 action 全树只出现一次（无重复项）', dup.length === 0, dup.join(','))
}

// ======================================================================
console.log('\n[D] 动作全集与重构前一致：117 个 action 一个不少、一个不多')
// 重构前（git 1.5.1）用 8 种状态跑出的 action 全集，逐字固化在这里；
// 这是一次「只搬家不换货」的验收口径：任何 action 改名/丢失/新增都会在这里报警。
const BEFORE_ACTIONS = [
  'bigger', 'briefing-card', 'cache-clear', 'cache-toggle', 'chat-lang:auto', 'chat-lang:en', 'chat-lang:zh',
  'chat-rate:+0%', 'chat-rate:+10%', 'chat-rate:-10%', 'chat-rate:-15%', 'chat-rate:-20%', 'chat-rate:-30%',
  'chatmode', 'clear-memory', 'config-view', 'culture-allusion', 'culture-couplet',
  'culture-couplet:中药', 'culture-couplet:书房', 'culture-couplet:书院', 'culture-couplet:叠字',
  'culture-couplet:名胜', 'culture-couplet:寿联', 'culture-couplet:数字', 'culture-couplet:春联',
  'culture-couplet:景观', 'culture-couplet:格言', 'culture-couplet:谐趣',
  'culture-idiom', 'culture-story', 'culture-story-next', 'culture-tale', 'daily-line',
  'data-export', 'data-import', 'ear-check', 'endpoint', 'feed', 'fishfood', 'growth', 'hide', 'home',
  'lang:en', 'lang:zh', 'music-stop',
  'music:两只老虎', 'music:伦敦大桥', 'music:卡农', 'music:友谊天长地久', 'music:土耳其进行曲',
  'music:小星星', 'music:平安夜', 'music:斯卡布罗集市', 'music:欢乐颂', 'music:生日快乐',
  'music:绿袖子', 'music:致爱丽丝', 'music:茉莉花', 'music:铃儿响叮当', 'music:阳关三叠',
  'narration-rate:-15%', 'narration-rate:-20%', 'narration-rate:-25%', 'narration-rate:-30%',
  'nervous', 'nervous-status', 'pause', 'poem', 'poem-echo',
  'poem-rate:-15%', 'poem-rate:-20%', 'poem-rate:-25%', 'poem-rate:-30%',
  'proofread', 'read-doc', 'remind-add', 'remind-list', 'remind-manage', 'skin-bg-reset', 'skin-fixed',
  'smaller', 'stats', 'story-auto', 'story-book:聊斋', 'story-book:西游记', 'story-books',
  'story-rate:-25%', 'story-rate:-30%', 'story-rate:-35%', 'story-rate:-40%', 'story-reset',
  'stream-toggle', 'team-board', 'tool-narrator', 'tts-stop', 'type', 'vision', 'voice', 'voice-export',
  'voice:auto', 'voice:en-GB-SoniaNeural', 'voice:en-US-AnaNeural', 'voice:en-US-JennyNeural',
  'voice:zh-CN-XiaochenNeural', 'voice:zh-CN-XiaoxiaoNeural', 'voice:zh-CN-XiaoyiNeural',
  'voice:zh-CN-YunxiNeural', 'voice:zh-CN-YunyangNeural',
  'wake', 'wake-recover', 'wake-word:', 'wake-word:custom', 'wake-word:大肥鱼', 'wake-word:小鲸',
  'wake-word:肥鲸', 'web-search',
]
// 与基线同口径的多状态见文件头部 STATES（覆盖开关两态、书单两态、曲目/语速不同档位）
{
  const actual = new Set()
  for (const st of STATES) walk(buildMenu('9.9.9', st), (it) => { if (it && it.type === 'item') actual.add(it.action) })
  const missing = BEFORE_ACTIONS.filter((a) => !actual.has(a))
  const extra = [...actual].filter((a) => BEFORE_ACTIONS.indexOf(a) < 0)
  ok('重构前后 action 总数都是 ' + BEFORE_ACTIONS.length, actual.size === BEFORE_ACTIONS.length, '实际 ' + actual.size)
  ok('重构前有、现在全部还在（无改名字/丢失）', missing.length === 0, missing.join(','))
  ok('没有新增 action（只搬家不换货）', extra.length === 0, extra.join(','))
}

// ======================================================================
console.log('\n[E] 三级子菜单展开：设置 → 语音与耳朵 → 说书语速')
{
  const P_SET = '设置 ▸'
  const P_VOICE = joinPath(P_SET, '语音与耳朵 ▸')
  const P_RATE = joinPath(P_VOICE, '说书语速：-35% ▸')
  const cases = ['', P_SET, joinPath(P_SET, '显示与语言 ▸'), P_VOICE, joinPath(P_SET, '行为开关 ▸'), joinPath(P_SET, '数据与维护 ▸'), P_RATE]
  let alignOk = true
  const detail = []
  for (const subOpen of cases) {
    const entries = listMenuEntries(TOP, { tr, lang: 'zh', subOpen })
    const rows = []
    const h = (type, props, ...children) => ({ type, props: props || {}, children })
    const walkRows = (nodes) => {
      for (const n of nodes) {
        if (Array.isArray(n)) { walkRows(n); continue }
        if (!n || typeof n !== 'object') continue
        if (n.props && n.props.role === 'menuitem') rows.push(n)
        if (Array.isArray(n.children)) walkRows(n.children)
      }
    }
    walkRows(renderMenuItems(TOP, { h, tr, lang: 'zh', subOpen, focusIndex: -1, onToggleSub() { }, onAction() { } }))
    if (entries.length !== rows.length) { alignOk = false; detail.push((subOpen || '顶层') + ' 行数 ' + rows.length + ' ≠ ' + entries.length) }
    for (let i = 0; i < entries.length; i++) {
      if (!rows[i] || rows[i].props['aria-label'] !== entries[i].label || entries[i].index !== i) alignOk = false
    }
  }
  ok('七种展开状态下可见项与渲染行逐一对齐（键盘高亮可寻址）', alignOk, detail.join(' | '))

  const topOnly = listMenuEntries(TOP, { tr, lang: 'zh', subOpen: '' })
  ok('全收起：看不到设置里的开关', !topOnly.some((e) => e.label === '语音朗读：开') && !topOnly.some((e) => e.label === '界面语言 ▸'))
  const setOpen = listMenuEntries(TOP, { tr, lang: 'zh', subOpen: P_SET })
  ok('展开「设置」：四个分组都可见', GROUP_LABELS.every((l) => setOpen.some((e) => e.kind === 'sub' && e.label === l)))
  ok('展开「设置」：各分组内部仍收起（不越级）', !setOpen.some((e) => e.label === '语音朗读：开'))
  const voiceOpen = listMenuEntries(TOP, { tr, lang: 'zh', subOpen: P_VOICE })
  const rateParent = voiceOpen.find((e) => e.kind === 'sub' && e.label === '说书语速：-35% ▸')
  ok('展开「设置 → 语音与耳朵」：语音项与四类语速都可见', !!rateParent && voiceOpen.some((e) => e.label === '语音朗读：开') && voiceOpen.some((e) => e.label === '换个声音 ▸'))
  ok('展开「设置 → 语音与耳朵」：语速档位仍收起', !voiceOpen.some((e) => e.action === 'story-rate:-25%'))
  const deep = listMenuEntries(TOP, { tr, lang: 'zh', subOpen: P_RATE })
  const rateParentDeep = deep.find((e) => e.kind === 'sub' && e.label === '说书语速：-35% ▸')
  ok('展开「设置 → 语音与耳朵 → 说书语速」：档位逐级出现', !!rateParentDeep && rateParentDeep.open === true &&
    !!deep[rateParentDeep.index + 1] && deep[rateParentDeep.index + 1].action === 'story-rate:-25%',
  rateParentDeep ? 'parent@' + rateParentDeep.index : 'null')
  const orphan = listMenuEntries(TOP, { tr, lang: 'zh', subOpen: '语音与耳朵 ▸' })
  ok('只给二级子菜单名（缺父路径）不展开', !orphan.some((e) => e.label === '语音朗读：开'))
}

// ======================================================================
console.log('\n[F] 中英双语：新增分组与动态前缀都有译文，英文界面不漏中文')
{
  ok('设置 ▸ → Settings ▸', tr('设置 ▸', 'en') === 'Settings ▸')
  ok('显示与语言 ▸ 有英文', tr('显示与语言 ▸', 'en') === 'Display & language ▸', tr('显示与语言 ▸', 'en'))
  ok('语音与耳朵 ▸ 有英文', tr('语音与耳朵 ▸', 'en') === 'Voice & hearing ▸', tr('语音与耳朵 ▸', 'en'))
  ok('行为开关 ▸ 有英文', tr('行为开关 ▸', 'en') === 'Behavior toggles ▸', tr('行为开关 ▸', 'en'))
  ok('数据与维护 ▸ 有英文', tr('数据与维护 ▸', 'en') === 'Data & maintenance ▸', tr('数据与维护 ▸', 'en'))
  ok('动态前缀「界面语言：」保持 tr 兼容', tr('界面语言：中文 ▸', 'en') === 'Interface language: Chinese ▸', tr('界面语言：中文 ▸', 'en'))
  ok('动态前缀「聊天语言：」保持 tr 兼容', tr('聊天语言：自动 ▸', 'en') === 'Chat language: Auto ▸', tr('聊天语言：自动 ▸', 'en'))
  ok('开关类译文沿用（语音朗读）', tr('语音朗读：关', 'en') === 'Voice output: off')
  ok('开关类译文沿用（行为开关新增位置不影响）', tr('鲸式解说：开', 'en') === 'Whale commentary: on')
  ok('语速类译文沿用（说书语速）', tr('说书语速：-35% ▸', 'en') === 'Story speed: -35% ▸')

  // 六种状态取全部标签：除书名/曲名（专有名词）外，英文界面不许残留中文
  const EN_STATES = [{}, ...STATES.slice(1)]
  const leaks = []
  for (const st of EN_STATES) {
    const items = buildMenu('9.9.9', st)
    walk(items, (it) => {
      if (!it || !it.label) return
      if (it.type === 'item' && /^(story-book:|music:)/.test(it.action || '')) return
      const en = tr(it.label, 'en')
      if (/[\u4e00-\u9fa5]/.test(en)) leaks.push(it.label + ' → ' + en)
    })
  }
  const uniqLeaks = [...new Set(leaks)]
  ok('英文界面无漏译（专有名词除外）', uniqLeaks.length === 0, uniqLeaks.slice(0, 5).join(' / '))
}

// ======================================================================
console.log('\n[G] 数据层结构：开关文案跟 state 走、结构合法、无重复')
{
  const allOn = buildMenu('9.9.9', Object.assign({}, STATE, {
    voiceOn: true, earOn: true, voiceChatOn: true, streamOn: true, storyAuto: true,
    skinFixed: true, toolNarratorOn: true, poemEchoOn: true, nervousOn: true,
    teamBoardOn: true, webSearchOn: true, chatCacheOn: true,
  }))
  const allOff = buildMenu('9.9.9', Object.assign({}, STATE, {
    voiceOn: false, earOn: false, voiceChatOn: false, streamOn: false, storyAuto: false,
    skinFixed: false, toolNarratorOn: false, poemEchoOn: false, nervousOn: false,
    teamBoardOn: false, webSearchOn: false, chatCacheOn: false,
  }))
  const TOGGLES = [
    ['voice', '语音朗读：开', '语音朗读：关'],
    ['wake', '语音待命：开', '语音待命：关'],
    ['chatmode', '语音聊天：开', '语音聊天：关'],
    ['stream-toggle', '流式回复：开', '流式回复：关'],
    ['skin-fixed', '固定背景：开', '固定背景：关'],
    ['tool-narrator', '鲸式解说：开', '鲸式解说：关'],
    ['poem-echo', '诗词弹幕：开', '诗词弹幕：关'],
    ['nervous', '神经感知：开', '神经感知：关'],
    ['team-board', '鲸鱼看板：开', '鲸鱼看板：关'],
    ['web-search', '联网搜索：开', '联网搜索：关'],
    ['cache-toggle', '聊天缓存：开', '聊天缓存：关'],
  ]
  const wrong = []
  for (const [action, onLabel, offLabel] of TOGGLES) {
    if (labelOf(allOn, action) !== onLabel) wrong.push(action + ' 开态=' + show(labelOf(allOn, action)))
    if (labelOf(allOff, action) !== offLabel) wrong.push(action + ' 关态=' + show(labelOf(allOff, action)))
  }
  ok('11 个开关的两态文案都跟着 state 走', wrong.length === 0, wrong.slice(0, 4).join(' | '))
  ok('「连播」开关两态文案保留原括注', labelOf(allOn, 'story-auto') === '连播：开（讲完一段自动接下一段）' &&
    labelOf(allOff, 'story-auto') === '连播：关（讲完一段自动接下一段）', show(labelOf(allOff, 'story-auto')))

  const badShape = shapeProblems(TOP)
  ok('结构合法（三种形态不混字段、子菜单非空）', badShape.length === 0, badShape.slice(0, 3).join(' | '))
  const badSep = sepProblems(TOP, '顶层菜单')
  ok('各层分隔符不成串、不在首尾', badSep.length === 0, badSep.slice(0, 3).join(' | '))
  const labels = []
  walk(TOP, (it) => { if (it && it.type === 'sub') labels.push(it.label) })
  const dupLabel = labels.filter((l, i) => labels.indexOf(l) !== i)
  ok('子菜单标题不重复（同层/跨层都不重名，路径可寻址）', dupLabel.length === 0, [...new Set(dupLabel)].join(','))
}

// ======================================================================
console.log('\n────────────────────')
if (fail === 0) console.log('✅ 通过 ' + pass + ' 项，失败 0 项')
else console.log('❌ 通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
