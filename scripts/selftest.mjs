/**
 * scripts/selftest.mjs —— 离线自检（node 直接跑，不依赖浏览器、不重启 web）
 *
 *   node scripts/selftest.mjs
 *
 * 校验三件事：
 *   1) dist/client.js 能被浏览器式加载（__ModuleLoader__.load 注册正确）
 *   2) factory 返回 {inject, apply}，apply 能注册 shell.overlay 且交出组件
 *   3) 组件函数在"宽容 stub"下能渲染一遍不抛异常（冒烟）
 *   4) dist/index.js（host）能 import，导出 name/inject/apply
 *
 * 任何一项失败 → 退出码 1，并且不打印敏感信息。
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = join(ROOT, 'dist', 'client.js')
const HOST = join(ROOT, 'dist', 'index.js')
const PKG = join(ROOT, 'package.json')

let failed = 0
function ok(name) { console.log('  ✓ ' + name) }
function bad(name, err) {
  failed++
  console.log('  ✗ ' + name)
  if (err) console.log('      ' + String(err && err.message ? err.message : err).slice(0, 500))
}
function section(t) { console.log('\n' + t) }

// ===== 宽容 stub =====
function makeEl() {
  const el = {
    style: {}, dataset: {}, classList: { add() { }, remove() { }, contains() { return false }, toggle() { } },
    children: [], childNodes: [], parentNode: null,
    appendChild(c) { this.children.push(c); return c },
    removeChild(c) { return c },
    insertBefore(c) { this.children.push(c); return c },
    setAttribute() { }, removeAttribute() { }, getAttribute() { return null },
    hasAttribute() { return false },
    addEventListener() { }, removeEventListener() { }, dispatchEvent() { return true },
    setPointerCapture() { }, releasePointerCapture() { },
    getBoundingClientRect() { return { top: 0, left: 0, width: 240, height: 213, right: 240, bottom: 213 } },
    getContext() { return makeCtx() }, focus() { }, click() { }, scrollTo() { },
    querySelector() { return null }, querySelectorAll() { return [] },
    closest() { return null }, contains() { return false }, cloneNode() { return makeEl() },
    get firstChild() { return this.children[0] || null },
    get lastChild() { return this.children[this.children.length - 1] || null },
    get textContent() { return this._text || '' }, set textContent(v) { this._text = v },
    get innerHTML() { return this._html || '' }, set innerHTML(v) { this._html = v },
  }
  return el
}
function makeCtx() {
  const noop = () => { }
  return new Proxy({
    canvas: makeEl(),
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, font: '', textAlign: '', textBaseline: '',
    measureText: () => ({ width: 10 }), createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }), getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  }, { get(t, k) { if (k in t) return t[k]; return noop } })
}
function makeStorage() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)) },
    removeItem: (k) => { m.delete(k) },
    clear: () => m.clear(), key: () => null, get length() { return m.size },
  }
}
function makeReact() {
  const childrenOf = (props) => (props && props.children) || []
  const R = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      return { type, props: Object.assign({}, props || {}, { children: children.length ? children : childrenOf(props) }) }
    },
    useState(init) { return [typeof init === 'function' ? init() : init, () => { }] },
    useRef(init) { return { current: init } },
    useEffect(fn) { try { const c = fn(); if (typeof c === 'function') c() } catch (e) { throw e } },
    useMemo(fn) { return fn() },
    useCallback(fn) { return fn },
    useContext(ctx) { return (ctx && ctx._value) || {} },
    createContext(v) { return { _value: v, Provider: 'Provider', Consumer: 'Consumer' } },
    memo: (c) => c, forwardRef: (c) => c,
    useReducer(r, i) { return [i, () => { }] },
    useLayoutEffect(fn) { R.useEffect(fn) },
    useId() { return 'id' },
  }
  return R
}

function makeSandbox() {
  const doc = {
    createElement: () => makeEl(),
    createElementNS: () => makeEl(),
    createTextNode: () => makeEl(),
    head: makeEl(), body: makeEl(), documentElement: makeEl(),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener() { }, removeEventListener() { }, readyState: 'complete',
    visibilityState: 'visible', hidden: false,
  }
  const win = {
    innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1,
    location: { href: 'http://127.0.0.1:3080/', host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', protocol: 'http:' },
    navigator: { userAgent: 'selftest', language: 'zh-CN', mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { }, enabled: true }] }) } },
    localStorage: makeStorage(), sessionStorage: makeStorage(),
    setTimeout: (fn) => { return 0 }, clearTimeout() { }, setInterval: () => 0, clearInterval() { },
    requestAnimationFrame: () => 0, cancelAnimationFrame() { },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '', arrayBuffer: async () => new ArrayBuffer(8), headers: { get: () => null } }),
    Audio: class { play() { return Promise.resolve() } pause() { } },
    AudioContext: class { constructor() { this.currentTime = 0; this.destination = {} } createGain() { return { gain: { setValueAtTime() { }, exponentialRampToValueAtTime() { } }, connect() { } } } createOscillator() { return { frequency: { value: 0 }, type: '', connect() { }, start() { }, stop() { } } } createAnalyser() { return { fftSize: 512, getByteFrequencyData() { }, getByteTimeDomainData() { }, connect() { } } } createMediaStreamSource() { return { connect() { } } } close() { return Promise.resolve() } resume() { return Promise.resolve() } },
    MediaRecorder: class { static isTypeSupported() { return true } constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm' } start() { this.state = 'recording' } stop() { this.state = 'inactive'; if (this.onstop) this.onstop() } addEventListener() { } },
    SpeechSynthesisUtterance: class { },
    speechSynthesis: { getVoices: () => [], speak() { }, cancel() { }, pause() { }, resume() { } },
    SpeechRecognition: undefined, webkitSpeechRecognition: undefined,
    MediaStream: class { }, Blob: class { constructor(p) { this.size = (p && p.length) || 0; this.parts = p } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() { } },
    FileReader: class { readAsDataURL() { if (this.onloadend) this.onloadend() } readAsText() { if (this.onloadend) this.onloadend() } },
    Image: class { set src(v) { this.complete = true; this.naturalWidth = 1024; this.naturalHeight = 1024; if (this.onload) this.onload() } },
    performance: { now: () => Date.now() },
    console: { log() { }, warn() { }, error() { }, info() { }, debug() { } },
    prompt: () => '', confirm: () => true, alert() { },
    addEventListener() { }, removeEventListener() { },
    __DSH_LOADED__: null,
  }
  win.window = win
  win.globalThis = win
  win.document = doc
  win.self = win
  return { win, doc }
}

// ===== 1) client bundle =====
section('[1/3] dist/client.js（浏览器端）')
let clientSrc = ''
try {
  clientSrc = readFileSync(CLIENT, 'utf8')
} catch (e) {
  bad('读取 dist/client.js', e)
}
if (clientSrc) {
  if (/^\s*import\s/m.test(clientSrc)) bad('产物含顶层 import（坑 2）')
  else ok('无顶层 import（IIFE 打包正确）')

  const { win, doc } = makeSandbox()
  const loads = []
  win.__ModuleLoader__ = { load(spec) { loads.push(spec) } }
  win.React = makeReact()

  const ctx = vm.createContext(win)
  try {
    vm.runInContext(clientSrc, ctx, { filename: 'dist/client.js', timeout: 5000 })
    ok('脚本执行无异常')
  } catch (e) {
    bad('脚本执行', e)
  }

  if (loads.length !== 1) bad('__ModuleLoader__.load 调用次数应为 1，实际 ' + loads.length)
  else {
    const spec = loads[0]
    if (spec.id !== 'dsh-chubby-whale') bad('注册 id 应为 dsh-chubby-whale，实际 ' + spec.id)
    else ok('注册 id 正确')

    let mod = null
    try {
      const requireStub = (name) => {
        if (name === 'react') return win.React
        throw new Error('unexpected require: ' + name)
      }
      mod = spec.factory(requireStub)
      ok('factory 执行成功')
    } catch (e) { bad('factory 执行', e) }

    if (mod) {
      if (!Array.isArray(mod.inject) || mod.inject.indexOf('slots') < 0) bad('inject 应含 slots，实际 ' + JSON.stringify(mod.inject))
      else ok('inject 含 slots（服务名）')

      if (typeof mod.apply !== 'function') bad('apply 不是函数')
      else {
        const regs = []
        const fakeCtx = {
          slots: {
            inject(name, fn) { regs.push({ name }); try { fn() } catch (e) { failed++; console.log('      inject 回调异常: ' + e.message) } },
            register(desc, component) { regs.push({ desc, component }); },
          },
          on() { }, effect() { }, get() { return undefined },
        }
        try {
          mod.apply(fakeCtx)
          ok('apply 执行成功')
        } catch (e) { bad('apply 执行', e) }

        const overlay = regs.find((r) => r.desc && r.desc.name === 'shell.overlay')
        if (!overlay) bad('未注册 shell.overlay')
        else {
          ok('注册 shell.overlay（id=' + overlay.desc.id + '）')
          if (typeof overlay.component !== 'function') bad('overlay 组件不是函数')
          else {
            try {
              const tree = overlay.component({})
              ok('组件首次渲染不抛异常')
              if (!tree) bad('组件返回空树')
              else ok('组件返回渲染树')
            } catch (e) { bad('组件渲染', e) }
          }
        }
      }
    }
  }
}

// ===== 2) host =====
section('[2/3] dist/index.js（host 端）')
try {
  const m = await import('file:///' + HOST.replace(/\\/g, '/'))
  const exported = Object.keys(m)
  const need = ['name', 'inject', 'apply']
  const miss = need.filter((k) => !(k in m))
  if (miss.length) bad('缺少导出: ' + miss.join(','))
  else ok('导出 ' + exported.join(', '))
  if (m.name !== 'dsh-chubby-whale') bad('name 应为 dsh-chubby-whale，实际 ' + m.name)
  else ok('name 正确')
  if (!Array.isArray(m.inject) || m.inject.indexOf('webServer') < 0) bad('inject 应含 webServer')
  else ok('inject 含 webServer')
} catch (e) { bad('import host', e) }

// ===== 3) package.json / 生成物一致性 =====
section('[3/3] package.json 声明')
try {
  const pkg = JSON.parse(readFileSync(PKG, 'utf8'))
  const clientInject = pkg && pkg.dsh && pkg.dsh.client && pkg.dsh.client.inject
  const isPkgName = Array.isArray(clientInject) && clientInject.length > 0 && clientInject.every((n) => typeof n === 'string' && /^@[a-z0-9-]+\/[a-z0-9-]+$/.test(n))
  if (!isPkgName) bad('dsh.client.inject 应为非空 @scope/name 包名数组（不能填服务名 slots），实际 ' + JSON.stringify(clientInject))
  else ok('dsh.client.inject 用包名（' + clientInject.join(', ') + '）')
  if (pkg.main !== 'dist/index.js') bad('main 应指向 dist/index.js，实际 ' + pkg.main)
  else ok('main 指向 dist/index.js')
  if (!pkg.exports || pkg.exports['./client'] !== './dist/client.js') bad('./client 导出应指向 ./dist/client.js')
  else ok('./client 导出正确')
} catch (e) { bad('读取 package.json', e) }


// ===== 4) 省 token 纯函数 =====
section('[4/4] 省 token 纯函数（host）')
try {
  const chatMod = await import('file:///' + join(ROOT, 'dist', 'host', 'routes', 'chat.js').replace(/\\\\/g, '/'))
  const big = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i }))
  const r8 = chatMod.recentHistory(big, 8)
  if (r8.length !== 8 || r8[7].content !== 'm39') bad('recentHistory：40→8 且取最新 失败')
  else ok('recentHistory：40 条只带最新 8 条（prompt 省 token）')
  if (chatMod.recentHistory(null, 8).length !== 0) bad('recentHistory(null) 不安全')
  else ok('recentHistory(null) 安全返回 []')
  const k1 = chatMod.chatCacheKey('zh', '你好', false, 'ctxA')
  const k2 = chatMod.chatCacheKey('zh', '你好', false, 'ctxA')
  const k3 = chatMod.chatCacheKey('zh', '你好', 'text', 'ctxB')
  const k4 = chatMod.chatCacheKey('zh', '你好', true, 'ctxA')
  const k5 = chatMod.chatCacheKey('zh', '你好！', false, 'ctxA')
  if (k1 !== k2) bad('同输入同上下文应命中同一缓存')
  else ok('同输入同上下文 → 同 key（缓存可命中，省 token）')
  if (k1 === k3) bad('上下文变但 key 未变（会答非所问）')
  else ok('上下文变 → key 变（不复用旧答案）')
  if (k1 === k4) bad('语音与打字 key 冲突')
  else ok('语音与打字缓存分开')
  if (k1 !== k5) bad('标点归一未生效（浪费缓存）')
  else ok('标点归一：『你好』与『你好！』同 key')
  const d1 = chatMod.detectLang('你好')
  const d2 = chatMod.detectLang('hello world')
  const d3 = chatMod.detectLang('123')
  const d4 = chatMod.detectLang('你好 hello')
  if (d1 !== 'zh' || d2 !== 'en' || d3 !== 'auto' || d4 !== 'zh') bad('detectLang 判定不符（zh/en/auto）')
  else ok('detectLang：中文→zh、英文→en、无字母→auto、中英混排→zh（流式与普通路径一致）')
} catch (e) { bad('导入 chat.js 纯函数', e) }

console.log('\n' + (failed === 0 ? '自检通过 ✅' : '自检失败 ❌ ' + failed + ' 项'))
process.exit(failed === 0 ? 0 : 1)
