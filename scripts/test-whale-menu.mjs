/**
 * scripts/test-whale-menu.mjs —— 「鲸式右键菜单」数据层的独立回归（不并入 npm test，避免改 package.json）
 *
 * 覆盖菜单最容易悄悄坏掉的几条：
 *   A. 菜单不缩水：动作条目 ≥ 12，需求点名的六组动作一个不少，结构不混字段；
 *   B. 所有 action 都在已注册的动作表内 —— 自造 id 的菜单点了没反应，等于死菜单；
 *   C. 分隔符不成串、不在首尾（含各子菜单）；
 *   D. 开关文案跟着 state 走，而且三个开关互不牵连（不能拿一个布尔糊弄三条）；
 *   E. 纯函数：同输入同输出，返回的是全新对象（调用方改了不污染下一次）。
 * 另外做源码静态检查：零依赖、不碰浏览器环境 —— 这不是洁癖，是「无 DOM 环境也能单测」的前提。
 *
 * 做法：用 esbuild 的 transformSync 把 .ts 就地转成 ESM 写到临时目录再 import。
 * 本模块没有 import，转完即可跑，不用打包整个 src，也不碰 dist/、不联网。
 *   （为什么不直接 import .ts：Node 原生只剥类型，遇到项目里的 .js 后缀解析不稳，
 *     transformSync 只多一步，却和构建产物口径一致。）
 *
 * 用法：node scripts/test-whale-menu.mjs   （全过退出码 0，有失败退出码 1）
 */

import { transformSync } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC = join(ROOT, 'src', 'client', 'menu-whale.ts')

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.error('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

// 已注册的动作白名单：与动作处理表对齐。菜单只能从这里取 id，多一个就是死项。
const ACTIONS = new Set([
  'voice', 'ear', 'voice-chat', 'voice-export', 'proofread',
  'lang:zh', 'lang:en', 'chat-lang:zh', 'chat-lang:en',
  'skin-fixed', 'skin-bg-reset', 'story-books', 'story-auto',
  'poem', 'daily-line', 'briefing-card', 'remind-add', 'test-tts',
  'fishfood', 'clear-memory', 'quit',
])

// 需求点名的分组覆盖：少一个都算菜单缩水
const REQUIRED = {
  '说话': ['voice', 'ear', 'voice-chat', 'test-tts'],
  '内容': ['poem', 'story-books', 'daily-line', 'briefing-card'],
  '工作': ['voice-export', 'proofread', 'remind-add'],
  '账本': ['fishfood'],
  '皮肤': ['skin-fixed', 'skin-bg-reset'],
  '系统': ['clear-memory', 'quit'],
}

// ---------- 转换 + 加载：只转这一个文件 ----------
const TMP = mkdtempSync(join(tmpdir(), 'chubby-whale-menu-'))
let source = ''
let buildWhaleMenu = null
try {
  source = readFileSync(SRC, 'utf8')
  const { code } = transformSync(source, { loader: 'ts', format: 'esm', target: 'node22', charset: 'utf8' })
  const OUT = join(TMP, 'menu-whale.mjs')
  writeFileSync(OUT, code, 'utf8')
  ;({ buildWhaleMenu } = await import(pathToFileURL(OUT).href))
} catch (e) {
  console.error('  ❌ 读取/转换 src/client/menu-whale.ts 失败：' + ((e && e.message) || e))
  fail++
}

function summary() {
  console.log('\n────────────────────')
  if (fail === 0) console.log('✅ 通过 ' + pass + ' 项，失败 0 项')
  else console.log('❌ 通过 ' + pass + ' 项，失败 ' + fail + ' 项')
  try { rmSync(TMP, { recursive: true, force: true }) } catch (e) { }
  process.exit(fail === 0 ? 0 : 1)
}
if (!buildWhaleMenu) summary()

// ---------- 遍历工具（只读，不改传入的菜单） ----------
/** 递归收集动作条目与子菜单；分隔符只占位，不进任何集合 */
function collect(items, depth = 1, acc = { items: [], subs: [] }) {
  if (!Array.isArray(items)) return acc
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    if (it.sep === true) continue
    if (typeof it.sub === 'string') {
      acc.subs.push({ title: it.sub, depth })
      collect(it.items, depth + 1, acc)
    } else {
      acc.items.push(it)
    }
  }
  return acc
}

/** 按 action 找文案；找不到回 null（不写死文案，文案随便改都能测） */
function labelOf(items, action) {
  if (!Array.isArray(items)) return null
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    if (typeof it.sub === 'string') {
      const hit = labelOf(it.items, action)
      if (hit !== null) return hit
    } else if (it.action === action) {
      return it.label
    }
  }
  return null
}

function actionsOf(items, out = []) {
  if (!Array.isArray(items)) return out
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    if (it.sep === true) continue
    if (typeof it.sub === 'string') actionsOf(it.items, out)
    else out.push(it.action)
  }
  return out
}

/** 结构体检：三种形态各自只能带自己的字段，子菜单不许为空 */
function shapeProblems(items, depth = 1, out = []) {
  if (!Array.isArray(items)) { out.push('第 ' + depth + ' 层不是数组'); return out }
  items.forEach((it, i) => {
    const at = '第 ' + depth + ' 层#' + i
    if (!it || typeof it !== 'object' || Array.isArray(it)) { out.push(at + ' 不是对象'); return }
    if (it.sep === true) {
      if (Object.keys(it).length !== 1) out.push(at + ' 分隔符带多余字段：' + Object.keys(it).join(','))
      return
    }
    if (typeof it.sub === 'string') {
      if (typeof it.label !== 'undefined' || typeof it.action !== 'undefined') out.push(at + ' 子菜单混入动作字段')
      if (!Array.isArray(it.items) || it.items.length === 0) out.push(at + ' 子菜单为空')
      else shapeProblems(it.items, depth + 1, out)
      return
    }
    if (typeof it.label !== 'string' || it.label.trim() === '') out.push(at + ' label 不是非空字符串')
    if (typeof it.action !== 'string' || it.action === '') out.push(at + ' action 不是非空字符串')
    if (typeof it.sub !== 'undefined' || typeof it.sep !== 'undefined') out.push(at + ' 动作条目混入 sep/sub 字段')
  })
  return out
}

/** 分隔符体检：首尾不许是分隔符、相邻不许两条（递归到子菜单） */
function sepProblems(items, where, out = []) {
  if (!Array.isArray(items) || items.length === 0) { out.push(where + ' 为空'); return out }
  if (items[0] && items[0].sep === true) out.push(where + ' 以分隔符开头')
  if (items[items.length - 1] && items[items.length - 1].sep === true) out.push(where + ' 以分隔符结尾')
  for (let i = 1; i < items.length; i++) {
    if (items[i] && items[i - 1] && items[i].sep === true && items[i - 1].sep === true) {
      out.push(where + ' 第 ' + i + '/' + (i + 1) + ' 条连续分隔符')
    }
  }
  for (const it of items) {
    if (it && typeof it.sub === 'string') sepProblems(it.items, where + ' › ' + it.sub, out)
  }
  return out
}

const hasAll = (text, words) => typeof text === 'string' && words.every((w) => text.indexOf(w) >= 0)
const show = (v) => (v === null ? 'null' : String(v))

// ======================================================================
console.log('\n[A] 菜单不缩水：条目数、六组覆盖、动作白名单')
const OFF = { voiceOn: false, earOn: false, voiceChatOn: false }
const ON = { voiceOn: true, earOn: true, voiceChatOn: true }
let base = []
try { base = buildWhaleMenu(OFF) } catch (e) { ok('buildWhaleMenu 不抛错', false, String((e && e.message) || e)) }
ok('buildWhaleMenu 返回数组', Array.isArray(base), Array.isArray(base) ? base.length + ' 个顶层条目' : typeof base)
if (!Array.isArray(base)) base = []

const acc = collect(base)
const ids = actionsOf(base)
ok('动作条目 ≥ 12（含子菜单里的）', acc.items.length >= 12, acc.items.length + ' 条')
ok('用了子菜单，且没有第三层', acc.subs.length > 0 && acc.subs.every((s) => s.depth === 1),
  acc.subs.map((s) => s.title + '@' + s.depth).join(' / ') || '无子菜单')

const badShape = shapeProblems(base)
ok('结构合法（动作 / 分隔 / 子菜单不混字段）', badShape.length === 0, badShape.slice(0, 3).join(' | '))

const badActions = acc.items.filter((it) => !ACTIONS.has(it.action)).map((it) => show(it.label) + '→' + it.action)
ok('所有 action 都在白名单内（防死菜单）', badActions.length === 0, badActions.join(' | '))

const dup = ids.filter((id, i) => ids.indexOf(id) !== i)
ok('同一动作不重复出现', dup.length === 0, [...new Set(dup)].join(','))

const noFunc = acc.items
  .filter((it) => typeof it.label !== 'string' || !/（[^（）]+）/.test(it.label))
  .map((it) => show(it.label))
ok('每条 label 都用括号带上人话功能名', noFunc.length === 0, noFunc.join(' | '))

for (const [name, acts] of Object.entries(REQUIRED)) {
  const missing = acts.filter((a) => ids.indexOf(a) < 0)
  ok('「' + name + '」组覆盖齐全', missing.length === 0, missing.length ? '缺 ' + missing.join(',') : acts.join(','))
}

// ======================================================================
console.log('\n[B] 分隔符：不成串、不在首尾')
const sepBad = sepProblems(base, '顶层菜单')
ok('各层都没有连续 / 首尾分隔符', sepBad.length === 0, sepBad.join(' | '))
ok('顶层确实用上了分隔符分组', base.some((it) => it && it.sep === true))

// ======================================================================
console.log('\n[C] 开关状态：文案跟着 state 走，三个开关互不牵连')
const onMenu = buildWhaleMenu(ON)
const offVoice = labelOf(base, 'voice')
const onVoice = labelOf(onMenu, 'voice')
ok('语音朗读关：文案含「鲸口」「关」', hasAll(offVoice, ['鲸口', '关']), show(offVoice))
ok('语音朗读开：文案含「鲸口」「开」', hasAll(onVoice, ['鲸口', '开']), show(onVoice))
ok('语音朗读两态文案不同', offVoice !== null && onVoice !== null && offVoice !== onVoice)

const offEar = labelOf(base, 'ear')
const onEar = labelOf(onMenu, 'ear')
ok('语音待命关：文案含「鲸耳」「关」', hasAll(offEar, ['鲸耳', '关']), show(offEar))
ok('语音待命开：文案含「鲸耳」「开」', hasAll(onEar, ['鲸耳', '开']), show(onEar))
ok('语音待命两态文案不同', offEar !== null && onEar !== null && offEar !== onEar)

const offChat = labelOf(base, 'voice-chat')
const onChat = labelOf(onMenu, 'voice-chat')
ok('语音聊天关：文案含「语音聊天」「关」', hasAll(offChat, ['语音聊天', '关']), show(offChat))
ok('语音聊天开：文案含「语音聊天」「开」', hasAll(onChat, ['语音聊天', '开']), show(onChat))
ok('语音聊天两态文案不同', offChat !== null && onChat !== null && offChat !== onChat)

// 只翻一个开关：另外两条的文案必须原样不动（防三条共用一个布尔）
const onlyVoice = buildWhaleMenu({ voiceOn: true, earOn: false, voiceChatOn: false })
ok('只开语音朗读：待命 / 聊天文案不受牵连',
  labelOf(onlyVoice, 'ear') === offEar && labelOf(onlyVoice, 'voice-chat') === offChat)
const onlyEar = buildWhaleMenu({ voiceOn: false, earOn: true, voiceChatOn: false })
ok('只开语音待命：朗读 / 聊天文案不受牵连',
  labelOf(onlyEar, 'voice') === offVoice && labelOf(onlyEar, 'voice-chat') === offChat)
const onlyChat = buildWhaleMenu({ voiceOn: false, earOn: false, voiceChatOn: true })
ok('只开语音聊天：朗读 / 待命文案不受牵连',
  labelOf(onlyChat, 'voice') === offVoice && labelOf(onlyChat, 'ear') === offEar)
ok('开关状态不改菜单骨架（动作与顺序一致）', JSON.stringify(actionsOf(onMenu)) === JSON.stringify(ids))

// ======================================================================
console.log('\n[D] 纯函数：同输入同输出，且不共享可变状态')
const serial = JSON.stringify(buildWhaleMenu(OFF))
ok('同输入两次调用 JSON 相等', serial === JSON.stringify(buildWhaleMenu(OFF)))
ok('等价入参（不同对象字面量）结果相等',
  serial === JSON.stringify(buildWhaleMenu({ voiceOn: false, earOn: false, voiceChatOn: false })))
ok('每次调用返回新的顶层数组', buildWhaleMenu(OFF) !== buildWhaleMenu(OFF))

const mutable = buildWhaleMenu(OFF)
const firstSub = mutable.find((it) => it && Array.isArray(it.items))
if (firstSub && firstSub.items[0]) firstSub.items[0].action = '被篡改'
if (firstSub) firstSub.items.push({ sep: true })
mutable.push({ sep: true })
ok('改返回值（含子菜单）不污染下一次结果', JSON.stringify(buildWhaleMenu(OFF)) === serial)

let partialThrew = null
try { buildWhaleMenu({}) } catch (e) { partialThrew = e }
ok('缺字段的 state 不抛错（按关处理，右键不白屏）', partialThrew === null, String(partialThrew && partialThrew.message))

// ======================================================================
console.log('\n[E] 源码静态检查：零依赖、不碰浏览器环境、签名不漂移')
ok('没有 import / require（零第三方依赖）', !/^\s*import\b/m.test(source) && !/\brequire\s*\(/.test(source))
ok('不碰浏览器环境（存储 / DOM / 全局对象 / 网络）',
  !/\b(localStorage|sessionStorage|document|window|navigator|fetch)\b/.test(source))
ok('没有随机数 / 时钟（同输入必同输出）', !/\bMath\.random\b/.test(source) && !/\bDate\b/.test(source))

ok('三个契约导出都在',
  /export\s+type\s+WhaleMenuState\b/.test(source) &&
  /export\s+type\s+WhaleMenuItem\b/.test(source) &&
  /export\s+function\s+buildWhaleMenu\b/.test(source))
ok('buildWhaleMenu 签名未漂移',
  /export\s+function\s+buildWhaleMenu\s*\(\s*state\s*:\s*WhaleMenuState\s*\)\s*:\s*WhaleMenuItem\s*\[\]/.test(source))
ok('WhaleMenuState 字段与契约一致',
  /export\s+type\s+WhaleMenuState\s*=\s*\{[\s\S]*?voiceOn\s*:\s*boolean[\s\S]*?earOn\s*:\s*boolean[\s\S]*?voiceChatOn\s*:\s*boolean[\s\S]*?\}/.test(source))
ok('WhaleMenuItem 三种形态与契约一致',
  /export\s+type\s+WhaleMenuItem\s*=[\s\S]*?label\s*:\s*string\s*;\s*action\s*:\s*string[\s\S]*?sep\s*:\s*true[\s\S]*?sub\s*:\s*string\s*;\s*items\s*:\s*WhaleMenuItem\s*\[\]/.test(source))

summary()
