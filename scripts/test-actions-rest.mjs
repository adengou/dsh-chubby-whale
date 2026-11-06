/**
 * scripts/test-actions-rest.mjs —— 「动作模块（剩余）」的独立回归（不并入 npm test，避免改 package.json）
 *
 * 覆盖本轮审查里真正有证据的六处：
 *   A. content.ts 叙述锁归属 —— 旧段朗读的 onDone 不许解开新段刚立的叙述锁；
 *      朗读起不来时锁要当场放掉（不能按估算时长白闭麦）。
 *   B. content.ts 选本书防连点 —— 连点两下只发一次请求（其它内容入口都有这道闸）。
 *   C. data.ts 体积错误码 —— 导出回 TOO_LARGE、导入走公共 413 回 'too large'，两种都要说「太大」，
 *      不能落到「备份文件读不了」（旧实现只认大写）。
 *   D. data.ts 导入二次确认 —— 取消确认不许 POST；确认后才 POST；无确认框的环境照旧放行（既有回归口径）。
 *   E. voice.ts 唤醒词 —— 气泡不许谎报「已生效」：当前实例的唤醒门还是旧词表时补一句生效时机。
 *   F. 封装治理静态断言 —— 三个动作文件不反向依赖 host、不引用构建产物/绝对路径。
 *
 * 做法：esbuild 先把 src 里的 .ts 打成一份离线 ESM 包（不碰 dist/、不联网），
 * 再把 fetch / localStorage / window / document 全部打桩后跑。每次 import 带不同 query
 * 拿一份全新模块实例（模级状态如 beginOnce 的连点窗、叙述锁代次互不串味）。
 *
 * 用法：node scripts/test-actions-rest.mjs   （失败退出码 1）
 */

import { build } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TMP = mkdtempSync(join(tmpdir(), 'chubby-actions-rest-'))

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.error('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

// ---------- esbuild 打包（源码直打，产物只落在临时目录） ----------
const ENTRY = `
export * as content from './src/client/actions/content.ts'
export * as data from './src/client/actions/data.ts'
export * as voice from './src/client/actions/voice.ts'
export * as actions from './src/client/actions.ts'
export * as menu from './src/client/menu.ts'
export * as render from './src/client/render.ts'
`
const BUNDLE = join(TMP, 'bundle.mjs')
try {
  await build({
    stdin: { contents: ENTRY, resolveDir: ROOT, sourcefile: 'actions-rest-entry.ts', loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    charset: 'utf8',
    logLevel: 'silent',
    outfile: BUNDLE,
  })
  ok('esbuild 打包 src（不碰 dist / 不联网）', true, readFileSync(BUNDLE, 'utf8').length + ' 字节')
} catch (e) {
  ok('esbuild 打包 src（不碰 dist / 不联网）', false, String((e && e.message) || e))
}

let seq = 0
/** 每次拿一份全新的模块实例：模级状态（连点窗 / 叙述锁代次）不跨用例 */
function fresh() {
  return import(pathToFileURL(BUNDLE).href + '?k=' + (++seq))
}

// ---------- 全局打桩 ----------
const realFetch = globalThis.fetch
const realWindow = globalThis.window
const hadWindow = 'window' in globalThis

function makeStorage() {
  const map = new Map()
  return {
    map,
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => { map.set(String(k), String(v)) },
    removeItem: (k) => { map.delete(String(k)) },
    clear: () => map.clear(),
  }
}
const storage = makeStorage()
globalThis.localStorage = storage

/** 通用 fetch 打桩：按 URL 路由，返回 {ok,status,json()}；hits 记下每次请求 */
function stubFetch(routes, hits = []) {
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    hits.push({ url: u, init: init || {} })
    for (const [frag, make] of routes) {
      if (u.indexOf(frag) >= 0) return make(u, init)
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  return hits
}
const json200 = (body) => ({ ok: true, status: 200, json: async () => body })

// ======================================================================
console.log('\n[A] content.ts 叙述锁归属：旧 onDone 不许解新锁')
try {
  const { content, actions } = await fresh()
  const tbl = actions.createActionTable()
  content.registerContentActions(tbl)

  let narrates = 0
  let clears = 0
  const speaks = []
  const bubbles = []
  const host = {
    bubble: (t) => bubbles.push(String(t)),
    talkFor: () => { },
    voiceOn: () => true,
    narrate: () => { narrates++ },
    clearNarrate: () => { clears++ },
    narrationRate: () => '-25%',
    speak: (t, o) => speaks.push({ t, o: o || {} }),
    story: { start: () => { } },
    storyState: { busy: { current: false } },
  }
  stubFetch([
    ['/daily', () => json200({ ok: true, item: { text: '天行健，君子以自强不息', source: '周易' } })],
    ['/briefing', () => json200({ ok: true, text: '11月6日 星期五\n待办提醒：1 条' })],
  ])
  await tbl.run('daily-line', host)
  await tick(10)
  await tbl.run('briefing-card', host)
  await tick(10)
  ok('两段内容都上了叙述锁', narrates === 2 && speaks.length === 2, 'narrate ' + narrates + ' / speak ' + speaks.length)
  ok('朗读收尾回调都挂上了（onDone 必填）', speaks.every((s) => typeof s.o.onDone === 'function'))
  // 今日一句那段这时才播完（队列串行）：它的收尾不许替简报解锁
  speaks[0].o.onDone()
  ok('旧段 onDone 不解新段的锁', clears === 0, 'clearNarrate ' + clears)
  // 简报自己念完 → 才解
  speaks[1].o.onDone()
  ok('自己是最后一段 → 正常解自己的锁', clears === 1, 'clearNarrate ' + clears)
  // 重复回调（TTS 兜底/看门狗可能回两次）不许重复解
  speaks[0].o.onDone()
  speaks[1].o.onDone()
  ok('过期/重复的收尾回调不再动锁', clears === 1, 'clearNarrate ' + clears)

  // 朗读起不来（speak 同步抛错）：锁必须当场放掉，不能按估算时长白闭麦
  const B2 = await fresh()
  const tbl2 = B2.actions.createActionTable()
  B2.content.registerContentActions(tbl2)
  let clears2 = 0
  let narrates2 = 0
  const bubbles2 = []
  const host2 = {
    bubble: (t) => bubbles2.push(String(t)),
    talkFor: () => { },
    voiceOn: () => true,
    narrate: () => { narrates2++ },
    clearNarrate: () => { clears2++ },
    narrationRate: () => '-25%',
    speak: () => { throw new Error('tts missing') },
    story: { start: () => { } },
    storyState: { busy: { current: false } },
  }
  let threw = null
  try { await tbl2.run('daily-line', host2) } catch (e) { threw = e }
  await tick(10)
  ok('朗读抛错不冒到分发层', threw === null, String(threw && threw.message))
  ok('锁刚上就放掉（narrate 1 次 / clear 1 次）', narrates2 === 1 && clears2 === 1, 'narrate ' + narrates2 + ' / clear ' + clears2)
  ok('抛错路径仍出内容气泡（不谎报成"没准备好"）', bubbles2.some((b) => b.indexOf('周易') >= 0), bubbles2.join(' | '))
} catch (e) {
  ok('content 叙述锁可验证', false, String((e && e.message) || e))
}

// ======================================================================
console.log('\n[B] content.ts 选本书：连点只发一次请求')
try {
  const { content, actions } = await fresh()
  const tbl = actions.createActionTable()
  content.registerContentActions(tbl)
  const hits = stubFetch([['/story/books', () => json200({ ok: true, books: ['聊斋', '西游记'] })]])
  const bubbles = []
  const host = { bubble: (t) => bubbles.push(String(t)) }
  await tbl.run('story-books', host)
  await tbl.run('story-books', host)
  await tick(10)
  ok('连点只发一次 GET', hits.length === 1, '请求 ' + hits.length)
  ok('第一次报书数', bubbles.some((b) => b.indexOf('书单有 2 本') >= 0), bubbles.join(' | '))
  ok('第二次给"稍等"提示', bubbles.some((b) => b.indexOf('正在翻书单') >= 0))
} catch (e) {
  ok('选本书防连点可验证', false, String((e && e.message) || e))
}

// ======================================================================
console.log('\n[C] data.ts 体积错误码：两种写法都要说"太大"')
try {
  const { data } = await fresh()
  // 导出：路由自己回的 413（大写 TOO_LARGE）
  let bubbles = []
  data.exportBackup({
    bubble: (t) => bubbles.push(String(t)),
    getJson: async () => ({ ok: false, error: 'TOO_LARGE' }),
  })
  await tick(10)
  ok('导出 TOO_LARGE → 说太大', bubbles[0] === '备份太大（超过 2MB），导出没成功', bubbles.join(' | '))

  // 导出：公共通道的 413（小写 'too large'，src/host/http.ts sendTooLarge）
  bubbles = []
  data.exportBackup({
    bubble: (t) => bubbles.push(String(t)),
    getJson: async () => ({ ok: false, error: 'too large' }),
  })
  await tick(10)
  ok('导出 "too large" → 也说太大（旧实现会落到"导出没成功"）', bubbles[0] === '备份太大（超过 2MB），导出没成功', bubbles.join(' | '))

  // 导入：身体超限走 readJsonBody → sendTooLarge → 'too large'
  const goodFile = { size: 100, text: async () => JSON.stringify({ state: { intimacy: 1 } }) }
  bubbles = []
  let posts = 0
  data.importBackup({
    bubble: (t) => bubbles.push(String(t)),
    pickFile: (cb) => cb(goodFile),
    postJson: async () => { posts++; return { ok: false, error: 'too large' } },
    delJson: async () => ({ ok: true }),
    confirm: () => true,
  })
  await tick(20)
  ok('导入 "too large" → 说太大（旧实现会说"备份文件读不了"）',
    bubbles[bubbles.length - 1] === '备份太大（超过 2MB），没导入', bubbles.join(' | '))
  ok('失败的导入不谎报字段数', !bubbles.some((b) => b.indexOf('导入了') >= 0) && posts === 1, bubbles.join(' | '))

  // 400 坏体仍然分开说
  bubbles = []
  data.importBackup({
    bubble: (t) => bubbles.push(String(t)),
    pickFile: (cb) => cb(goodFile),
    postJson: async () => ({ ok: false, error: 'BAD_BODY' }),
    confirm: () => true,
  })
  await tick(20)
  ok('BAD_BODY → 说格式不对', bubbles[bubbles.length - 1] === '备份文件格式不对，没导入', bubbles.join(' | '))
} catch (e) {
  ok('体积错误码可验证', false, String((e && e.message) || e))
}

// ======================================================================
console.log('\n[D] data.ts 导入二次确认：先问再落盘')
try {
  const { data } = await fresh()
  const goodFile = { size: 100, text: async () => JSON.stringify({ memory: { history: [] }, state: { intimacy: 1 } }) }

  // D1：取消确认 → 不发 POST
  let bubbles = []
  let posts = 0
  let asked = ''
  data.importBackup({
    bubble: (t) => bubbles.push(String(t)),
    pickFile: (cb) => cb(goodFile),
    postJson: async () => { posts++; return json200Body() },
    delJson: async () => ({ ok: true }),
    confirm: (msg) => { asked = String(msg); return false },
  })
  await tick(20)
  ok('问了确认（文案说清是覆盖）', asked.indexOf('覆盖') >= 0, asked)
  ok('不确认就不落盘（POST 0 次）', posts === 0, 'POST ' + posts)
  ok('取消有明确提示', bubbles[bubbles.length - 1] === '没确认，导入取消', bubbles.join(' | '))

  // D2：确认 → 正常 POST + 报字段数
  bubbles = []
  posts = 0
  data.importBackup({
    bubble: (t) => bubbles.push(String(t)),
    pickFile: (cb) => cb(goodFile),
    postJson: async () => { posts++; return json200Body() },
    delJson: async () => ({ ok: true }),
    confirm: () => true,
  })
  await tick(20)
  ok('确认后才落盘', posts === 1, 'POST ' + posts)
  ok('报告字段数', bubbles.some((b) => b === '导入了 2 个字段，跳过 1 个字段'), bubbles.join(' | '))

  // D3：没有确认框（Node / 无 UI 宿主）→ 照旧放行，既有回归口径不变
  bubbles = []
  posts = 0
  globalThis.window = undefined
  delete globalThis.window
  data.importBackup({
    bubble: (t) => bubbles.push(String(t)),
    pickFile: (cb) => cb(goodFile),
    postJson: async () => { posts++; return json200Body() },
    delJson: async () => ({ ok: true }),
  })
  await tick(20)
  ok('无确认框环境不拦（不改变既有调用方行为）', posts === 1 && bubbles.some((b) => b.indexOf('导入了 2 个字段') >= 0), 'POST ' + posts + ' / ' + bubbles.join(' | '))

  // D4：浏览器默认路径（window.confirm）问到了、并按回答执行
  bubbles = []
  posts = 0
  let browserAsked = 0
  globalThis.window = { confirm: () => { browserAsked++; return false } }
  data.importBackup({
    bubble: (t) => bubbles.push(String(t)),
    pickFile: (cb) => cb(goodFile),
    postJson: async () => { posts++; return json200Body() },
    delJson: async () => ({ ok: true }),
  })
  await tick(20)
  ok('默认用 window.confirm 问（没注入也问）', browserAsked === 1, 'confirm 调用 ' + browserAsked)
  ok('浏览器答"否" → 不落盘', posts === 0 && bubbles[bubbles.length - 1] === '没确认，导入取消', bubbles.join(' | '))
  delete globalThis.window
} catch (e) {
  ok('导入确认可验证', false, String((e && e.message) || e))
}
function json200Body() {
  return { ok: true, imported: ['state', 'growth'], skipped: ['cache'] }
}

// ======================================================================
console.log('\n[E] voice.ts 唤醒词：气泡与实际生效时机同源')
try {
  const { voice, actions, menu, render } = await fresh()
  const tbl = actions.createActionTable()
  voice.registerVoiceActions(tbl)

  // E1：唤醒门每次判定前都会 syncWakeWords（voice-bridge），词表已即时生效 → 不再补生效提示
  let bubbles = []
  await tbl.run('wake-word:新词', {
    bubble: (t) => bubbles.push(String(t)),
    wakeInfo: () => ({ words: ['大肥鱼', '肥鲸'] }),
  })
  ok('唤醒词写进存储（菜单/门读同一键）', storage.getItem('chubby-wake-word') === '新词', String(storage.getItem('chubby-wake-word')))
  ok('门词表已同步 → 不再补生效提示', bubbles[0] === '唤醒词：新词', bubbles[0])

  // E2：门的词表已经换过 → 不再加提示
  bubbles = []
  await tbl.run('wake-word:新词', {
    bubble: (t) => bubbles.push(String(t)),
    wakeInfo: () => ({ words: ['新词'] }),
  })
  ok('门已是新词表 → 不加多余提示', bubbles[0] === '唤醒词：新词', bubbles[0])

  // E3：恢复默认（空值）时同样即时生效（syncWakeWords 同步）→ 不补「等重开」的提示
  bubbles = []
  await tbl.run('wake-word:', {
    bubble: (t) => bubbles.push(String(t)),
    wakeInfo: () => ({ words: ['新词'] }),
  })
  ok('恢复默认会清掉存储', storage.getItem('chubby-wake-word') === null, String(storage.getItem('chubby-wake-word')))
  ok('恢复默认不再补"等重开"提示', bubbles[0] === '唤醒词：默认（大肥鱼/肥鲸等）', bubbles[0])

  // E4：自定义词走 prompt，存的是 trim 后的值，气泡照抄存储口径
  bubbles = []
  const realPrompt = globalThis.window
  globalThis.window = { prompt: () => '   自定义词   ' }
  await tbl.run('wake-word:custom', {
    bubble: (t) => bubbles.push(String(t)),
    wakeInfo: () => ({ words: ['自定义词'] }),
  })
  ok('自定义词按 trim 后存储', storage.getItem('chubby-wake-word') === '自定义词', String(storage.getItem('chubby-wake-word')))
  ok('气泡与存储同值', bubbles[0] === '唤醒词：自定义词', bubbles[0])

  // E5：取消 prompt → 不改
  bubbles = []
  globalThis.window = { prompt: () => null }
  await tbl.run('wake-word:custom', {
    bubble: (t) => bubbles.push(String(t)),
    wakeInfo: () => ({ words: ['自定义词'] }),
  })
  ok('取消 prompt → 只提示没改', bubbles[0] === '没改唤醒词' && storage.getItem('chubby-wake-word') === '自定义词', bubbles.join(' | '))
  if (realPrompt === undefined) delete globalThis.window
  else globalThis.window = realPrompt

  // E6：音色动作写的键与菜单读的键是同一个（菜单显示同源）
  const voiceHost = { bubble: () => { }, setTtsVoice: (n) => { storage.setItem('chubby-tts-voice', n) }, previewVoice: () => { } }
  await tbl.run('voice:zh-CN-YunxiNeural', voiceHost)
  const rt = render.readMenuRuntime()
  const labels = []
  const walk = (arr) => { for (const it of arr) { if (it && it.items) walk(it.items); else if (it && it.label) labels.push(it.label) } }
  walk(menu.buildMenu('9.9.9', { ttsVoice: rt.ttsVoice }))
  ok('菜单勾到刚换的音色（同一存储键）', labels.indexOf('✓ 音色：云希（中·男）') >= 0 && rt.ttsVoice === 'zh-CN-YunxiNeural', rt.ttsVoice + ' / ' + labels.filter((x) => x.indexOf('✓') === 0).join(','))
} catch (e) {
  ok('唤醒词动作可验证', false, String((e && e.message) || e))
}

// ======================================================================
console.log('\n[F] 封装治理静态断言：动作文件只走公开接口')
try {
  const files = ['src/client/actions/content.ts', 'src/client/actions/data.ts', 'src/client/actions/voice.ts']
  const srcs = files.map((f) => ({ f, s: readFileSync(join(ROOT, f), 'utf8') }))
  const hostImp = srcs.filter((x) => /from\s+'(\.\.\/)+host\//.test(x.s))
  const distImp = srcs.filter((x) => /from\s+'[^']*dist\//.test(x.s) || /file:\/\/\//.test(x.s))
  ok('不反向依赖 host（数据只走 HTTP 接口）', hostImp.length === 0, hostImp.map((x) => x.f).join(','))
  ok('不引用构建产物/绝对路径', distImp.length === 0, distImp.map((x) => x.f).join(','))
  const dataSrc = srcs.find((x) => x.f.indexOf('data.ts') >= 0).s
  ok('导入/导出只经注入的宿主能力（getJson/postJson/delJson 可注入）',
    /host\.getJson/.test(dataSrc) && /host\.postJson/.test(dataSrc) && /host\.delJson/.test(dataSrc))
} catch (e) {
  ok('封装治理静态断言', false, String((e && e.message) || e))
}

// ---------- 还原全局 ----------
globalThis.localStorage = undefined
delete globalThis.localStorage
globalThis.fetch = realFetch
if (hadWindow) globalThis.window = realWindow
else delete globalThis.window
try { rmSync(TMP, { recursive: true, force: true }) } catch (e) { }

console.log('\n────────────────────')
if (fail === 0) console.log('✅ 通过 ' + pass + ' 项，失败 0 项')
else console.log('❌ 通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
