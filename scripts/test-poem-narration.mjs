/**
 * scripts/test-poem-narration.mjs —— 念诗收尾令牌 + sayLine 朗读入口（独立脚本，不进 npm test）
 *
 * 覆盖两件事（都在客户端，不需要宿主 / 网络）：
 *
 *   A. 念诗的 per-call 收尾令牌（src/client/actions/culture.ts）：
 *      client.ts 的 narrateOwner 只挡「换使用方」——念诗中途点「讲段书」，说书接锁后诗尾的
 *      clearNarrate 会被判成"别人的锁"，已由 test-entry-narration.mjs 覆盖。挡不住的是
 *      **同一使用方连念两首**：两次 narrate 用的是同一个 ownerId，旧诗的 onDone 晚到/重复到达
 *      时仍会被当"自己人"，把新诗的叙述锁清掉、把新诗的进度停掉，还替新诗补一句「念完啦」。
 *      这里直接调 recitePoem 两次（假时钟越过 1.5 秒连点窗），再手动触发两条 onDone：
 *        · 旧诗的迟到回调 → 不许清新诗的锁 / 不许停新诗的进度 / 不许说「念完啦」；
 *        · 旧诗的重复回调 → 同上，且不能把"已收尾"状态带跑；
 *        · 最新一次诗的收尾 → 正常清锁、停进度、说「念完啦」；
 *        · 同一次收尾重复到达 → 只放行一次（TTS 兜底/两次回调不重复动锁）。
 *
 *   B. sayLine 的朗读入口（src/client.ts）：
 *      sayLine 旧实现用 bridge.get()：语音待命关着刷新页面后实例没建，get() 为 null，
 *      开场问候/情绪台词就只剩气泡没声（朗读开关仍开）；而 speakText → bridge.speak 走 ensure()。
 *      这里把 voice-bridge 桩成 get()=null、ensure()=假朗读对象，调入口注入的 say()：
 *        · 必须走 ensure() 并真的把文本交给朗读（只建朗读对象、不开麦，见 docs/坑.md 坑 23）；
 *        · 朗读开关（chubby-voice=off）仍能全静 —— 待命关不等于静音，静音开关是「语音朗读」。
 *
 * 做法：esbuild 把 TS 离线打成 ESM（不碰 dist、不联网），客户端入口按 test-entry-narration.mjs
 * 同一套办法桩掉三个注入点（只替换 client.ts 自己的 import），再用假 React 跑一次渲染，
 * 于是拿到的 bridgeHost.say 就是组件真正注入的 sayLine。
 *
 * 用法：node scripts/test-poem-narration.mjs [--src <src 目录>]
 *   --src 给负向验证用：把基线 src 副本放进一份目录再跑，本脚本必须变红。
 */

import { build } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const srcFlag = argv.indexOf('--src')
const SRC = srcFlag >= 0 ? resolve(argv[srcFlag + 1] || '') : join(ROOT, 'src')

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.error('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

const TMP = mkdtempSync(join(tmpdir(), 'chubby-poem-narration-'))
const POEM_BUNDLE = join(TMP, 'poem.mjs')
const ENTRY_BUNDLE = join(TMP, 'entry.mjs')

// ---------- 全局打桩：window / 存储 / 定时器（先于 import 打上） ----------
function makeStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => { map.set(String(k), String(v)) },
    removeItem: (k) => { map.delete(String(k)) },
    clear: () => { map.clear() },
  }
}
const storage = makeStorage()
const timers = new Map()
let timerSeq = 0
function fakeSetTimeout(fn, ms, ...args) {
  const id = ++timerSeq
  timers.set(id, { fn, ms, args })
  return id
}
function fakeClearTimeout(id) { timers.delete(id) }

const win = {
  innerWidth: 1280,
  innerHeight: 720,
  localStorage: storage,
  sessionStorage: makeStorage(),
  addEventListener() { },
  removeEventListener() { },
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  __ModuleLoader__: { load(def) { globalThis.__b86Loaded = def } },
}
globalThis.window = win
globalThis.localStorage = storage
globalThis.sessionStorage = win.sessionStorage
globalThis.setTimeout = fakeSetTimeout
globalThis.clearTimeout = fakeClearTimeout
globalThis.setInterval = () => 0

// ---------- esbuild：① 念诗动作 ② 客户端入口（桩掉三个注入点） ----------
try {
  await build({
    stdin: {
      contents:
        "export { recitePoem } from './client/actions/culture.ts'\n" +
        "export { progressActive } from './client/narration-progress.ts'\n",
      resolveDir: SRC,
      sourcefile: 'b86-poem-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    charset: 'utf8',
    logLevel: 'silent',
    outfile: POEM_BUNDLE,
  })
  ok('esbuild 打包念诗动作（离线 / 不碰 dist）', true, SRC)
} catch (e) {
  ok('esbuild 打包念诗动作（离线 / 不碰 dist）', false, String((e && e.message) || e))
  console.error(String((e && e.stack) || e))
  process.exit(1)
}

const STUB_SOURCES = {
  story: `export function createStoryController(host) {
  globalThis.__b86StoryHost = host
  return { playPiece() {}, start() {}, next() {}, reset() {} }
}`,
  'chat-route': `export function createLocalRouter(host) {
  globalThis.__b86RouteHost = host
  return { route() { return false } }
}`,
  'voice-bridge': `export function createVoiceBridge(host) {
  globalThis.__b86BridgeHost = host
  const st = globalThis.__b86BridgeStat || (globalThis.__b86BridgeStat = { get: 0, ensure: 0, spoken: [] })
  const fakeVoice = {
    speak(text, opts) { st.spoken.push({ text: text, opts: opts }) },
    speaking: () => false,
    start: async () => { },
    stop() {}, stopSpeaking() {}, mute() {},
    setVoiceName() {}, voiceName: () => '',
    setEndpointMode() {}, endpointInfo: () => ({ mode: 'classic' }),
    lastSegment: () => null, lastTtsInfo: () => null,
    stats: {}, status: () => 'idle',
  }
  return {
    get: () => { st.get++; return null },
    ensure: () => { st.ensure++; return fakeVoice },
    start: async () => fakeVoice,
    stop() {}, dispose() {}, speak() {}, stopSpeak() {}, mute() {},
    setVoiceName() {}, voiceName: () => '', preview() {},
    wakeInfo: () => ({ words: [] }),
  }
}`,
}

const stubPlugin = {
  name: 'b86-entry-injection-stubs',
  setup(b) {
    b.onResolve({ filter: /^\.\/client\/(story|chat-route|voice-bridge)\.js$/ }, (args) => {
      const importer = String(args.importer || '').replace(/\\/g, '/')
      // 只替换 client.ts 自己的注入点；别的模块引用同名文件仍走真实现
      if (!/client\.ts$/.test(importer)) return null
      const m = args.path.match(/^\.\/client\/(story|chat-route|voice-bridge)\.js$/)
      return { path: m[1], namespace: 'b86-entry-stub' }
    })
    b.onLoad({ filter: /.*/, namespace: 'b86-entry-stub' }, (args) => ({
      contents: STUB_SOURCES[args.path],
      loader: 'js',
    }))
  },
}

try {
  await build({
    stdin: {
      contents: "export * as entry from './client.ts'\n",
      resolveDir: SRC,
      sourcefile: 'b86-client-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    charset: 'utf8',
    logLevel: 'silent',
    outfile: ENTRY_BUNDLE,
    plugins: [stubPlugin],
  })
  ok('esbuild 打包客户端入口（离线 / 不碰 dist）', true, SRC)
} catch (e) {
  ok('esbuild 打包客户端入口（离线 / 不碰 dist）', false, String((e && e.message) || e))
  console.error(String((e && e.stack) || e))
  process.exit(1)
}

// ---------- 念诗：假时钟 + 假宿主 ----------
const realNow = Date.now
let fakeNow = 1700000000000
Date.now = () => fakeNow

let poemMod = null
try {
  poemMod = await import(pathToFileURL(POEM_BUNDLE).href + '?k=' + Date.now())
  ok('载入念诗动作产物', !!(poemMod && typeof poemMod.recitePoem === 'function'))
} catch (e) {
  ok('载入念诗动作产物', false, String((e && e.message) || e))
  console.error(String((e && e.stack) || e))
  process.exit(1)
}

// ======================================================================
console.log('\n[1] 同一使用方连念两首：旧诗的迟到 onDone 不许清新诗的锁/进度/收尾')
try {
  const POEM_DONE = '念完啦～'
  const calls = { narrate: 0, clear: 0, says: [], speaks: [] }
  let progressActive = false
  const host = {
    bubble() { },
    talkFor() { },
    narrate(ms) { calls.narrate++; progressActive = true },
    clearNarrate() { calls.clear++; progressActive = false },
    say(text, ms, opts) { calls.says.push({ text, ms, opts }) },
    speak(text, opts) { calls.speaks.push({ text, opts }) },
    persona: { line: (k) => (k === 'poemDone' ? POEM_DONE : '开念～') },
    narrationRate: () => '-25%',
  }
  const progressActiveFn = () => poemMod.progressActive()

  const poemA = { title: '静夜思', author: '李白', dynasty: '唐', text: '床前明月光\n疑是地上霜\n举头望明月\n低头思故乡' }
  const poemB = { title: '春晓', author: '孟浩然', dynasty: '唐', text: '春眠不觉晓\n处处闻啼鸟' }

  poemMod.recitePoem(host, poemA)
  ok('第一次念诗已上叙述锁', calls.narrate === 1 && progressActiveFn() === true)
  ok('第一次念诗把整首交给朗读并挂 onDone', calls.speaks.length === 1 && typeof calls.speaks[0].opts.onDone === 'function')
  ok('念诗语速走 poemRate（默认 -25%）', calls.speaks[0].opts.rate === '-25%', String(calls.speaks[0].opts.rate))
  const onDoneA = calls.speaks[0].opts.onDone

  // 越过 beginOnce 的 1.5 秒连点窗，再念第二首（模拟"听完/隔一会儿再点一次"）
  fakeNow += 2000
  poemMod.recitePoem(host, poemB)
  ok('第二次念诗接过锁', calls.narrate === 2 && progressActiveFn() === true)
  ok('两首诗各挂一条 onDone', calls.speaks.length === 2 && typeof calls.speaks[1].opts.onDone === 'function')
  const onDoneB = calls.speaks[1].opts.onDone

  // 旧诗的收尾迟到：新诗已经接过锁，它什么都不许动
  onDoneA()
  ok('旧诗的迟到 onDone 不清新诗的锁', calls.clear === 0, 'clear=' + calls.clear)
  ok('旧诗的迟到 onDone 不停新诗的进度', progressActiveFn() === true)
  ok('旧诗的迟到 onDone 不替新诗说「念完啦」', calls.says.filter((s) => s.text === POEM_DONE).length === 0)

  // 旧诗的回调重复到达：依然什么都不许动
  onDoneA()
  ok('旧诗的重复 onDone 仍然不清锁', calls.clear === 0, 'clear=' + calls.clear)
  ok('旧诗的重复 onDone 仍然不停进度', progressActiveFn() === true)
  ok('旧诗的重复 onDone 仍然不补「念完啦」', calls.says.filter((s) => s.text === POEM_DONE).length === 0)

  // 最新一首的正常收尾：锁/进度/收尾台词都该走（用相对量，不被上面旧诗的回调计数污染）
  const doneCount = () => calls.says.filter((s) => s.text === POEM_DONE).length
  const clearBeforeB = calls.clear
  const doneBeforeB = doneCount()
  onDoneB()
  ok('最新一首的 onDone 正常清锁', calls.clear === clearBeforeB + 1, 'clear ' + clearBeforeB + ' → ' + calls.clear)
  ok('最新一首的 onDone 正常停进度', progressActiveFn() === false)
  ok('最新一首的 onDone 说一次「念完啦」', doneCount() === doneBeforeB + 1, JSON.stringify(calls.says))
  const doneSays = calls.says.filter((s) => s.text === POEM_DONE)
  ok('「念完啦」用念诗收尾的语气参数（-8% / +15Hz）',
    !!doneSays[doneSays.length - 1] && doneSays[doneSays.length - 1].opts &&
    doneSays[doneSays.length - 1].opts.rate === '-8%' && doneSays[doneSays.length - 1].opts.pitch === '+15Hz',
    JSON.stringify(doneSays[doneSays.length - 1] && doneSays[doneSays.length - 1].opts))

  // 同一次收尾重复到达（TTS 兜底 + 真 onDone 双回调）：只放行一次
  onDoneB()
  ok('同一首诗的重复收尾只清一次锁', calls.clear === clearBeforeB + 1, 'clear=' + calls.clear)
  ok('同一首诗的重复收尾不重复补台词', doneCount() === doneBeforeB + 1)

  // 反向对照：没有后来者时，最后一次念诗自己的收尾照常生效
  fakeNow += 2000
  poemMod.recitePoem(host, poemA)
  const onDoneC = calls.speaks[calls.speaks.length - 1].opts.onDone
  const clearBeforeC = calls.clear
  const doneBeforeC = doneCount()
  onDoneC()
  ok('单独念一首：自己的 onDone 照常清锁', calls.clear === clearBeforeC + 1, 'clear=' + calls.clear)
  ok('单独念一首：自己的 onDone 照常收尾', doneCount() === doneBeforeC + 1)
} catch (e) {
  ok('念诗收尾令牌可验证', false, String((e && e.message) || e))
}
Date.now = realNow

// ---------- 客户端入口：假 React + 桩注入点 ----------
const hookSlots = []
let hookIndex = 0
const R = {
  Fragment: 'Fragment',
  createElement(type, props, ...children) { return { type, props: props || {}, children } },
  useState(init) {
    const i = hookIndex++
    const slot = hookSlots[i] || (hookSlots[i] = {})
    if (!('v' in slot)) slot.v = typeof init === 'function' ? init() : init
    return [slot.v, (next) => { slot.v = typeof next === 'function' ? next(slot.v) : next }]
  },
  useRef(init) {
    const i = hookIndex++
    const slot = hookSlots[i] || (hookSlots[i] = {})
    if (!('ref' in slot)) slot.ref = { current: init }
    return slot.ref
  },
  useEffect() { hookIndex++ },
}
const requireStub = (name) => {
  if (name === 'react') return R
  throw new Error('unexpected require(' + name + ')')
}

let entryMod = null
try {
  entryMod = await import(pathToFileURL(ENTRY_BUNDLE).href + '?k=' + Date.now())
  ok('载入客户端入口产物（顶层 __ModuleLoader__.load 已挂上）', !!(entryMod && entryMod.entry) && !!globalThis.__b86Loaded)
} catch (e) {
  ok('载入客户端入口产物（顶层 __ModuleLoader__.load 已挂上）', false, String((e && e.message) || e))
  console.error(String((e && e.stack) || e))
  process.exit(1)
}

let render = null
try {
  const plugin = globalThis.__b86Loaded.factory(requireStub)
  const slots = { register(_desc, fn) { render = fn }, inject(_type, cb) { cb() } }
  plugin.apply({ slots })
  ok('插件 apply 注册了 overlay 渲染函数', typeof render === 'function', String(typeof render))
} catch (e) {
  ok('插件 apply 注册了 overlay 渲染函数', false, String((e && e.message) || e))
  console.error(String((e && e.stack) || e))
}

if (typeof render === 'function') {
  hookIndex = 0
  try {
    render()
    ok('WhaleBody 渲染（假 React）', true)
  } catch (e) {
    ok('WhaleBody 渲染（假 React）', false, String((e && e.message) || e))
  }
}

// ======================================================================
console.log('\n[2] sayLine：待命关着刷新（get()=null）时仍走 ensure 出声；朗读开关仍能全静')
try {
  const stat = globalThis.__b86BridgeStat
  const bridgeHost = globalThis.__b86BridgeHost
  ok('语音桥 host 已注入', !!bridgeHost)
  ok('入口把 sayLine 注入成 host.say', !!(bridgeHost && typeof bridgeHost.say === 'function'))

  const before = stat ? stat.spoken.length : 0
  const ensure0 = stat ? stat.ensure : 0
  if (bridgeHost && typeof bridgeHost.say === 'function') {
    bridgeHost.say('开场问候·测试', 3000)
    ok('get() 为空时 sayLine 改走 ensure()（不再只有气泡没声）',
      !!stat && stat.ensure === ensure0 + 1,
      JSON.stringify(stat && { get: stat.get, ensure: stat.ensure }))
    ok('ensure() 建出的朗读对象真的收到这句台词',
      !!stat && stat.spoken.length === before + 1 && stat.spoken[stat.spoken.length - 1].text === '开场问候·测试',
      JSON.stringify(stat && stat.spoken))
    const lastSpoken = stat && stat.spoken[stat.spoken.length - 1]
    ok('台词语速走聊天语速（默认 -15%）',
      !!lastSpoken && !!lastSpoken.opts && lastSpoken.opts.rate === '-15%',
      JSON.stringify(lastSpoken))

    // 「语音朗读」是真正的静音开关：关掉后 sayLine 一声不出、也不再建朗读对象
    storage.setItem('chubby-voice', 'off')
    const ensureBefore = stat.ensure
    const spokenBefore = stat.spoken.length
    bridgeHost.say('朗读关掉不该出声', 3000)
    ok('朗读开关关掉时 sayLine 完全静音（不建朗读对象、不出声）',
      stat.ensure === ensureBefore && stat.spoken.length === spokenBefore,
      JSON.stringify({ ensure: stat.ensure, spoken: stat.spoken.length }))
  }
} catch (e) {
  ok('sayLine 朗读入口可验证', false, String((e && e.message) || e))
}

console.log('\n[E] 收尾契约（源码静态：抛错也收尾 / 实例卸载始终回收）')
try {
  const cultureSrc = readFileSync(join(ROOT, 'src/client/actions/culture.ts'), 'utf8')
  ok('念诗 speak 同步抛错时也走 release()', /catch \(e\) \{\s*\n\s*\/\/[^\n]*\n\s*release\(\)/.test(cultureSrc), cultureSrc.includes('release()') ? '有 release 调用' : '缺')
  const clientSrc = readFileSync(join(ROOT, 'src/client.ts'), 'utf8')
  ok('语音清理器不依赖 earOn（cleanup 先定义后分支返回）', /const cleanup = \(\): void => \{ try \{ bridge\.dispose\(\) \} catch \(e\) \{ \} \}/.test(clientSrc))
  ok('开待命与不开待命都返回同一个 cleanup', (clientSrc.match(/return cleanup/g) || []).length >= 2, '出现 ' + (clientSrc.match(/return cleanup/g) || []).length + ' 次')
} catch (e) {
  ok('收尾契约可读源码', false, String(e.message))
}

// ---------- 汇总 ----------
try { rmSync(TMP, { recursive: true, force: true }) } catch (e) { }
console.log('\n  通过 ' + pass + ' 项 / 失败 ' + fail + ' 项')
if (fail > 0) {
  console.error('\n  ❌ 念诗收尾令牌 / sayLine 朗读入口回归失败')
  process.exit(1)
}
console.log('\n  ✅ 念诗收尾令牌 / sayLine 朗读入口回归通过')
