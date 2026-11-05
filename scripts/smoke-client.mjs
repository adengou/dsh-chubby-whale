/**
 * scripts/smoke-client.mjs —— 客户端产物冒烟测试（不需要浏览器）
 *
 * 为什么需要：`tsc` 只覆盖类型，esbuild 只打包；两者都发现不了"模块初始化时
 * 引用了一个不存在的变量"这类错误（我们真踩过：删掉的 NARRATION_RATE 还在用）。
 * 这里用最小 DOM/React 桩把 dist/client.js 在 Node 里真正跑一遍：
 *   ① 模块注册有没有报错
 *   ② factory 返回的描述符形状对不对（name/inject/apply）
 *   ③ apply() 会不会抛（含 slots 注入与注册路径）
 *
 * 用法：node scripts/smoke-client.mjs
 * 退出码：0=通过；1=失败
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const BUNDLE = process.env.SMOKE_CLIENT_FILE || 'dist/client.js'
const PKG = JSON.parse(readFileSync('package.json', 'utf8'))

/** 极简元素桩：够样式/动画/画布代码初始化用 */
function makeEl() {
  const el = {
    style: {},
    dataset: {},
    classList: { add() { }, remove() { }, toggle() { }, contains() { return false } },
    children: [],
    childNodes: [],
    appendChild(c) { el.children.push(c); return c },
    removeChild() { },
    insertBefore() { },
    setAttribute() { },
    removeAttribute() { },
    getAttribute() { return null },
    addEventListener() { },
    removeEventListener() { },
    remove() { },
    focus() { },
    blur() { },
    click() { },
    querySelector() { return null },
    querySelectorAll() { return [] },
    getBoundingClientRect() { return { top: 0, left: 0, width: 200, height: 200, right: 200, bottom: 200 } },
    getContext() {
      const ctx = {
        canvas: el, fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, font: '',
        clearRect() { }, fillRect() { }, strokeRect() { }, beginPath() { }, closePath() { },
        arc() { }, ellipse() { }, rect() { }, fill() { }, stroke() { }, clip() { },
        moveTo() { }, lineTo() { }, bezierCurveTo() { }, quadraticCurveTo() { },
        save() { }, restore() { }, translate() { }, rotate() { }, scale() { }, setTransform() { },
        drawImage() { }, createLinearGradient() { return { addColorStop() { } } },
        createRadialGradient() { return { addColorStop() { } } },
        measureText() { return { width: 10 } }, fillText() { }, strokeText() { },
        createImageData() { return { data: [] } }, putImageData() { },
      }
      return ctx
    },
    width: 0, height: 0, textContent: '', innerHTML: '', value: '',
  }
  return el
}

const mem = new Map()
const documentStub = {
  createElement: () => makeEl(),
  createElementNS: () => makeEl(),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() { },
  removeEventListener() { },
  body: makeEl(),
  head: makeEl(),
  documentElement: makeEl(),
  visibilityState: 'visible',
  hidden: false,
  hasFocus: () => true,
}

class AudioContextStub {
  constructor() { this.state = 'running'; this.destination = {}; this.currentTime = 0 }
  createGain() { return { gain: { value: 1, setValueAtTime() { }, linearRampToValueAtTime() { } }, connect() { }, disconnect() { } } }
  createAnalyser() {
    return { fftSize: 1024, frequencyBinCount: 512, smoothingTimeConstant: 0.8, connect() { }, disconnect() { }, getFloatTimeDomainData(arr) { arr.fill(0) }, getByteFrequencyData(arr) { arr.fill(0) } }
  }
  createBufferSource() { return { buffer: null, connect() { }, disconnect() { }, start() { }, stop() { }, onended: null } }
  createMediaStreamSource() { return { connect() { }, disconnect() { } } }
  decodeAudioData() { return Promise.resolve({ duration: 1 }) }
  resume() { return Promise.resolve() }
  close() { return Promise.resolve() }
}

const windowStub = {
  document: documentStub,
  addEventListener() { },
  removeEventListener() { },
  dispatchEvent() { },
  location: { search: '', href: 'http://127.0.0.1:3080/', hash: '', pathname: '/' },
  navigator: { userAgent: 'node-smoke', language: 'zh-CN', languages: ['zh-CN'], mediaDevices: { getUserMedia: async () => { throw new Error('no-mic') } } },
  localStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)) },
    removeItem: (k) => { mem.delete(k) },
  },
  matchMedia: () => ({ matches: false, addEventListener() { }, removeEventListener() { } }),
  requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  setTimeout, clearTimeout, setInterval, clearInterval,
  fetch: async () => ({ ok: false, status: 0, json: async () => ({}), text: async () => '' }),
  AudioContext: AudioContextStub,
  webkitAudioContext: AudioContextStub,
  MediaRecorder: class { constructor() { this.state = 'inactive' } start() { this.state = 'recording' } stop() { this.state = 'inactive' } },
  URL, Blob, AbortController, TextDecoder, TextEncoder, Promise, Date, Math, JSON,
  performance: { now: () => Date.now() },
}

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
  Fragment: Symbol('Fragment'),
  memo: (c) => c,
  forwardRef: (c) => c,
  useState: (init) => [typeof init === 'function' ? init() : init, () => { }],
  useRef: (init) => ({ current: init }),
  useEffect: () => { },
  useLayoutEffect: () => { },
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useReducer: (fn, init) => [init, () => { }],
  useContext: () => ({}),
  createContext: (v) => ({ Provider: (p) => p, Consumer: () => null, _v: v }),
}

let captured = null
windowStub.__ModuleLoader__ = { load: (mod) => { captured = mod } }

if (!existsSync(BUNDLE)) {
  console.log('  ⏭ 没有 ' + BUNDLE + '（先 npm run build），跳过客户端冒烟')
  process.exit(0)
}
const code = readFileSync(BUNDLE, 'utf8')
const params = ['window', 'document', 'navigator', 'localStorage', 'console', 'globalThis']
const argValues = [windowStub, documentStub, windowStub.navigator, windowStub.localStorage, console, globalThis]

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

try {
  // eslint-disable-next-line no-new-func
  const run = new Function(...params, code)
  run(...argValues)
  ok('模块加载不抛异常', true)
} catch (err) {
  ok('模块加载不抛异常', false, String(err && err.message || err))
}

ok('注册了模块描述符', !!captured && captured.id === 'dsh-chubby-whale', captured ? 'id=' + captured.id : '没有 load 调用')

if (captured && typeof captured.factory === 'function') {
  const requireStub = (name) => {
    if (name === 'react') return reactStub
    throw new Error('未预期的依赖: ' + name)
  }
  let mod = null
  try {
    mod = captured.factory(requireStub)
    ok('factory 正常返回', !!mod)
  } catch (err) {
    ok('factory 正常返回', false, String(err && err.message || err))
  }
  if (mod) {
    ok('描述符有 name', typeof mod.name === 'string' && mod.name.length > 0, 'name=' + mod.name)
    ok('描述符 inject 含 slots', Array.isArray(mod.inject) && mod.inject.indexOf('slots') >= 0)
    ok('apply 是函数', typeof mod.apply === 'function')
    // apply：最小 slots 桩（inject 直接回调、register 只记录）
    let registered = null
    const slots = {
      inject(_name, cb) { try { cb() } catch (e) { } },
      register(desc) { registered = desc },
    }
    try {
      mod.apply({ slots })
      ok('apply() 不抛异常', true)
      ok('注册了 shell.overlay', !!registered && registered.name === 'shell.overlay', registered ? 'name=' + registered.name : '没有 register')
    } catch (err) {
      ok('apply() 不抛异常', false, String(err && err.message || err))
    }
    const diag = windowStub.__chubbyWhale
    ok('诊断对象已挂载', !!diag && typeof diag === 'object')
    ok('诊断版本与 package 一致', !!diag && diag.version === PKG.version, diag ? 'diag=' + diag.version + ' pkg=' + PKG.version : '')
    ok('错误记录器是数组', Array.isArray(windowStub.__chubbyErrors))
  }
} else {
  ok('factory 可用', false, '模块描述符里没有 factory')
}

console.log('\\n  通过 ' + pass + ' 项，失败 ' + fail + ' 项')
if (fail > 0) process.exit(1)
