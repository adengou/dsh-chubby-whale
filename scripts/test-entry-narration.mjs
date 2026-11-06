/**
 * scripts/test-entry-narration.mjs —— 组件入口（src/client.ts）叙述锁回归（独立脚本，不进 npm test）
 *
 * 覆盖两件事（改动都在「组件入口的注入处」，不碰 client/narration.ts 的既有导出）：
 *
 *   A. 叙述锁「持有者令牌」：念诗与说书共用一把锁（narration.ts 只有一份 until）。
 *      念诗中途点「讲段书」，说书会接过锁；诗尾 onDone 晚到时的 clearNarrate 只许解自己的锁，
 *      不许清掉说书那一段的锁与 narrating 标记（否则 voice-bridge 的 onSegment 不再冒泡，
 *      气泡不更新、麦克风提前拾音）。
 *
 *   B. 说书长段的「只报警不放锁」探针：估算 ≤2 分钟的段由 client/story.ts 的兜底自愈；
 *      长段（1000 字≈4 分钟）丢了 onDone 会永久卡「正讲着呢」。入口在 narrate(ms) 后挂
 *      一次性探针：到 1.5×估算时若仍占着锁只写诊断（__chubbyWhale.narrateOverdue /
 *      narrateOverdueInfo），绝不强制清锁；收尾/停止/卸载必须把探针定时器一起撤掉。
 *
 * 做法：esbuild 把 src/client.ts 离线打成 ESM（不碰 dist、不联网），把三个注入点
 *   client/story.js、client/chat-route.js、client/voice-bridge.js
 * 换成桩模块抓 host，再用假 React 跑一次 WhaleBody —— 于是测试拿到的 narrate/clearNarrate
 * 就是入口真正注入给「说书 / 菜单动作 / 点播路由」的那几条。定时器可注入：探针到点由测试
 * 手动触发，不真等 6 分钟。
 *
 * 用法：node scripts/test-entry-narration.mjs [--src <src 目录>]
 *   --src 给负向验证用：把基线 client.ts 放进一份 src 副本再跑，本脚本必须变红。
 */

import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
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

const TMP = mkdtempSync(join(tmpdir(), 'chubby-entry-narration-'))
const BUNDLE = join(TMP, 'client-entry.mjs')

// ---------- esbuild：离线打包 src/client.ts，并桩掉三个注入点 ----------
const STUB_SOURCES = {
  story: `export function createStoryController(host) {
  globalThis.__b78StoryHost = host
  return { playPiece() {}, start() {}, next() {}, reset() {} }
}`,
  'chat-route': `export function createLocalRouter(host) {
  globalThis.__b78RouteHost = host
  return { route() { return false } }
}`,
  'voice-bridge': `export function createVoiceBridge(host) {
  globalThis.__b78BridgeHost = host
  return {
    get: () => null,
    ensure: () => ({}),
    start: async () => null,
    stop() {}, dispose() {}, speak() {}, stopSpeak() {}, mute() {},
    setVoiceName() {}, voiceName: () => '', preview() {},
    wakeInfo: () => ({ words: [] }),
  }
}`,
}

const stubPlugin = {
  name: 'b78-entry-injection-stubs',
  setup(b) {
    b.onResolve({ filter: /^\.\/client\/(story|chat-route|voice-bridge)\.js$/ }, (args) => {
      const importer = String(args.importer || '').replace(/\\/g, '/')
      // 只替换 client.ts 自己的注入点；别的模块引用同名文件仍走真实现
      if (!/client\.ts$/.test(importer)) return null
      const m = args.path.match(/^\.\/client\/(story|chat-route|voice-bridge)\.js$/)
      return { path: m[1], namespace: 'b78-entry-stub' }
    })
    b.onLoad({ filter: /.*/, namespace: 'b78-entry-stub' }, (args) => ({
      contents: STUB_SOURCES[args.path],
      loader: 'js',
    }))
  },
}

try {
  await build({
    stdin: { contents: "export * as entry from './client.ts'\n", resolveDir: SRC, sourcefile: 'b78-entry.ts', loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    charset: 'utf8',
    logLevel: 'silent',
    outfile: BUNDLE,
    plugins: [stubPlugin],
  })
  ok('esbuild 打包 src/client.ts（离线 / 不碰 dist）', true, SRC)
} catch (e) {
  ok('esbuild 打包 src/client.ts（离线 / 不碰 dist）', false, String((e && e.message) || e))
  console.error(String((e && e.stack) || e))
  process.exit(1)
}

// ---------- 全局打桩：window / 存储 / 定时器 ----------
function makeStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => { map.set(String(k), String(v)) },
    removeItem: (k) => { map.delete(String(k)) },
    clear: () => { map.clear() },
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size },
  }
}

/** 定时器：全部收进表里，探针由测试手动触发（真实等待 6 分钟不现实） */
const timers = new Map()
let timerSeq = 0
function fakeSetTimeout(fn, ms, ...args) {
  const id = ++timerSeq
  timers.set(id, { fn, ms, args })
  return id
}
function fakeClearTimeout(id) { timers.delete(id) }
function fakeInterval() { return 0 }

function timersOf(ms) {
  return Array.from(timers.entries())
    .filter(([, t]) => t.ms === ms)
    .map(([id, t]) => ({ id, fn: t.fn }))
}
/** 取走（并执行过一次后不会再自动跑）第一个该延时的回调 */
function takeTimer(ms) {
  const list = timersOf(ms)
  if (!list.length) return null
  timers.delete(list[0].id)
  return list[0].fn
}
function hasTimer(ms) { return timersOf(ms).length > 0 }

const storage = makeStorage()
const session = makeStorage()
let loaded = null
const win = {
  innerWidth: 1280,
  innerHeight: 720,
  localStorage: storage,
  sessionStorage: session,
  addEventListener() { },
  removeEventListener() { },
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  __ModuleLoader__: { load(def) { loaded = def } },
}

globalThis.window = win
globalThis.localStorage = storage
globalThis.sessionStorage = session
globalThis.setTimeout = fakeSetTimeout
globalThis.clearTimeout = fakeClearTimeout
globalThis.setInterval = fakeInterval

// ---------- 假 React：只跑一次渲染，hooks 用固定槽位 ----------
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

let mod = null
try {
  mod = await import(pathToFileURL(BUNDLE).href + '?k=' + Date.now())
  ok('载入打包产物（顶层 __ModuleLoader__.load 已挂上）', !!(mod && mod.entry) && !!loaded)
} catch (e) {
  ok('载入打包产物（顶层 __ModuleLoader__.load 已挂上）', false, String((e && e.message) || e))
  console.error(String((e && e.stack) || e))
  process.exit(1)
}

// ---------- 跑一次 WhaleBody：自动注入 ActionHost / StoryHost / LocalRouteHost ----------
let plugin = null
let render = null
try {
  plugin = loaded.factory(requireStub)
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
  } catch (e) {
    ok('WhaleBody 渲染（假 React）', false, String((e && e.message) || e))
  }
}

const winNs = win.__chubbyWhale || {}
const storyHost = globalThis.__b78StoryHost
const routeHost = globalThis.__b78RouteHost
const bridgeHost = globalThis.__b78BridgeHost
const lock = bridgeHost && bridgeHost.narration
const diag = (win.__chubbyWhale || {})

// ======================================================================
console.log('\n[1] 注入点：三个使用方各拿一条 narrate/clearNarrate，桥拿到同一把锁')
try {
  ok('渲染没有落到兜底错误占位', !winNs.renderError, String(winNs.renderError || ''))
  ok('说书 host 已注入', !!(storyHost && typeof storyHost.narrate === 'function' && typeof storyHost.clearNarrate === 'function'))
  ok('菜单动作 host 已注入（点播路由另一条）', !!(routeHost && typeof routeHost.narrate === 'function' && typeof routeHost.clearNarrate === 'function'))
  ok('语音桥 host 已注入（拿得到同一把叙述锁）', !!(bridgeHost && bridgeHost.narration && typeof bridgeHost.narration.active === 'function'))
  ok('说书与点播不是同一个句柄函数（持有者可区分）', !!storyHost && !!routeHost && storyHost.narrate !== routeHost.narrate)
} catch (e) {
  ok('注入点可验证', false, String((e && e.message) || e))
}

// ======================================================================
console.log('\n[2] 负向复现：念诗中途点「讲段书」，诗尾 onDone 不许清说书的锁')
try {
  routeHost.narrate(240000)   // 念诗上锁（诗尾 onDone 会晚到）
  ok('念诗上锁后锁生效', lock.active() === true, 'remaining=' + lock.remaining())
  storyHost.narrate(60000)    // 中途点「讲段书」：说书接过锁
  ok('说书接锁后 narrating=true（气泡跟说书更新）', bridgeHost.narrating() === true)
  const leftBefore = lock.remaining()
  routeHost.clearNarrate()    // 诗尾 onDone 这时才回来
  ok('诗尾 onDone 不清说书的锁（旧实现在这里会把 until 清零）', lock.active() === true, 'remaining=' + lock.remaining())
  ok('诗尾 onDone 不清说书的叙述标记', bridgeHost.narrating() === true)
  ok('锁没有被诗尾延长/缩短（还是说书那次的时长）', Math.abs(lock.remaining() - leftBefore) < 2000, leftBefore + ' → ' + lock.remaining())
  storyHost.clearNarrate()    // 说书自己的收尾
  ok('说书自己收尾正常解锁', lock.active() === false)
  ok('说书自己收尾清掉叙述标记', bridgeHost.narrating() === false)
} catch (e) {
  ok('持有者令牌可验证', false, String((e && e.message) || e))
}

// ======================================================================
console.log('\n[3] 反向对照：念诗自己最后一次上锁 → 自己的 clearNarrate 照常生效')
try {
  routeHost.narrate(20000)
  ok('念诗单独上锁', lock.active() === true)
  routeHost.clearNarrate()
  ok('没有别人接锁时，诗尾 onDone 正常解锁', lock.active() === false)
  ok('叙述标记同步清掉', bridgeHost.narrating() === false)
} catch (e) {
  ok('单使用方清锁可验证', false, String((e && e.message) || e))
}

// ======================================================================
console.log('\n[4] 长段探针：1.5×估算只报警一次，绝不强行清锁')
try {
  const before = Number(diag.narrateOverdue || 0)

  // ① 已收尾（说书 busy=false）时：探针即使到点也不该报警（避免把正常偏慢当异常）
  storyHost.narrate(240000)
  const quietProbe = takeTimer(360000)
  storyHost.refs.busy.current = false
  if (typeof quietProbe === 'function') quietProbe()
  ok('说书已不占线时探针不报警（不误报）', Number(diag.narrateOverdue || 0) === before)
  storyHost.clearNarrate()

  // ② 仍在讲（busy=true，onDone 没回来）→ 到点只写诊断
  storyHost.narrate(240000)   // 1000 字≈4 分钟的长段：story.ts 只给 ≤2 分钟的段挂兜底
  storyHost.refs.busy.current = true   // 真实现里 playPiece 调 narrate 前会置 busy
  ok('长段上锁', lock.active() === true, 'remaining=' + lock.remaining())
  ok('探针按 1.5×估算挂上（240s → 360s）', hasTimer(360000))
  const probe = takeTimer(360000)
  ok('取到探针回调', typeof probe === 'function')
  if (typeof probe === 'function') probe()   // 模拟到点（不真等 6 分钟）
  ok('到点只写诊断计数（narrateOverdue +1）', Number(diag.narrateOverdue || 0) === before + 1, String(diag.narrateOverdue || 0))
  const info = diag.narrateOverdueInfo || {}
  ok('诊断带来源与估算（story / 240000ms / 360000ms）',
    info.label === 'story' && info.estMs === 240000 && info.afterMs === 360000,
    JSON.stringify(info))
  ok('探针不放锁（锁仍在）', lock.active() === true, 'remaining=' + lock.remaining())
  ok('探针不动叙述标记', bridgeHost.narrating() === true)
  storyHost.refs.busy.current = false
  storyHost.clearNarrate()
  ok('长段收尾后才解锁', lock.active() === false)
} catch (e) {
  ok('长段探针可验证', false, String((e && e.message) || e))
}

// ======================================================================
console.log('\n[5] 探针生命周期：收尾 / 停止 / 卸载都不能留悬挂 timer 或事后误报')
try {
  // ① 收尾撤探针：clearNarrate 之后旧探针即使被强触发也不再报警
  storyHost.narrate(60000)
  ok('短段探针按下限 30s 挂上', hasTimer(90000), '期望 90000ms，实有 ' + JSON.stringify(Array.from(timers.values()).map((t) => t.ms)))
  const staleProbe = takeTimer(90000)
  storyHost.clearNarrate()
  const beforeStale = Number(diag.narrateOverdue || 0)
  if (typeof staleProbe === 'function') staleProbe()
  ok('收尾后旧探针不再报警', Number(diag.narrateOverdue || 0) === beforeStale)
  ok('收尾后没有残留探针定时器', !hasTimer(90000))

  // ② 权威停止（"停止说话"/卸载同一路径）：清锁 + 撤探针
  storyHost.narrate(240000)
  storyHost.refs.busy.current = true
  ok('长段探针再次挂上', hasTimer(360000))
  bridgeHost.stopSpeaking()   // client.ts 注入的 host.stopSpeaking = stopTts（卸载 cleanup 也走它）
  ok('停止说话清掉叙述锁', lock.active() === false)
  ok('停止说话撤掉探针定时器（无悬挂）', !hasTimer(360000))
  ok('停止说话清掉叙述标记', bridgeHost.narrating() === false)
  ok('停止说话放开说书占线（不会卡「正讲着呢」）', storyHost.refs.busy.current === false)

  // ③ 极短段：探针压到 30s 下限，避免把正常合成/排队误报成卡住
  routeHost.narrate(1000)
  ok('极短段探针压到 30s 下限', hasTimer(30000))
  routeHost.clearNarrate()
  ok('极短段收尾后不留 timer', !hasTimer(30000))
} catch (e) {
  ok('探针生命周期可验证', false, String((e && e.message) || e))
}

// ---------- 汇总 ----------
try { rmSync(TMP, { recursive: true, force: true }) } catch (e) { }
console.log('\n  通过 ' + pass + ' 项 / 失败 ' + fail + ' 项')
if (fail > 0) {
  console.error('\n  ❌ 入口叙述锁回归失败')
  process.exit(1)
}
console.log('\n  ✅ 入口叙述锁回归通过')
