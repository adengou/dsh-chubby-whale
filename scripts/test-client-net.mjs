/**
 * scripts/test-client-net.mjs —— 客户端取数请求超时治理（B105）
 *
 * 背景（B102 审计）：`/culture`、`/poem`、`/story/books` 这类取数请求走 client/http.ts 的
 * `getJson`，改造前没有任何超时预算。云端数据源不可达时，界面最坏要等宿主「清单 10s +
 * 文件 10s」才看到失败，观感是「卡住」而不是「失败」。
 *
 * 本脚本验证（离线、不联网、esbuild 打包真实源码后全局打桩 fetch）：
 *   A. http.ts：getJson / postJson / delJson 的默认预算 15s（≥ 宿主 10s 链路预算）
 *   B. 覆盖与兼容：显式 timeout 覆盖、timeout:0 关闭、调用方自带 signal 不叠加、
 *      外部 abort 不被误报成超时、没有 AbortController 的老浏览器仍能按预算失败、
 *      到点后的迟到响应被丢弃且不产生未处理拒绝
 *   C. chat-route.ts：/poem 显式 15s、/culture 显式 20s（/story/books 走默认 15s）；
 *      超时后走**既有**失败文案（诗册没读到 / 这个没读到）
 *   D. 既有 timeoutSignal 口径不变（说书 B98 依赖它）
 *   E. 变异自检（默认开启）：把 DEFAULT_TIMEOUT_MS 改回「无超时」后，A 组断言必须变红，
 *      证明这套断言真的有牙。`--no-mutate` 可跳过。
 *
 * 用法：node scripts/test-client-net.mjs [--no-mutate]
 * 退出码：0 = 全过；1 = 有失败
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import esbuild from 'esbuild'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = path.join(ROOT, '.client-net-tmp')
const ENTRY = path.join(TMP, 'entry.ts')
const WITH_MUTATE = !process.argv.includes('--no-mutate')

let pass = 0
let fail = 0
const failures = []

function ok(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log('  ✅ ' + name + (detail ? '  ' + detail : ''))
  } else {
    fail++
    failures.push(name + (detail ? '  ' + detail : ''))
    console.log('  ❌ ' + name + (detail ? '  ' + detail : ''))
  }
}

function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
    '期望 ' + JSON.stringify(expected) + ' / 实际 ' + JSON.stringify(actual))
}

async function group(title, fn) {
  console.log('\n[' + title + ']')
  try {
    await fn()
  } catch (e) {
    ok(title + '：未抛异常', false, String((e && e.stack) || e))
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等一个可能永远不 settle 的 Promise：超时抛 TEST-TIMEOUT，避免「改造前」跑测试时挂死 */
function settleWithin(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('TEST-TIMEOUT（' + ms + 'ms 内未 settle）')), ms)
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) },
    )
  })
}

// ---------- 打包 ----------

/**
 * 打一个暴露 http / route 两个命名空间的 ESM 包。
 * rules: [[文件名, 原文, 替换]]，只作用于指定文件（变异自检用）。
 */
async function buildBundle(tag, rules = []) {
  const outfile = path.join(TMP, 'bundle-' + tag + '.mjs')
  const plugin = {
    name: 'mutate-client-net',
    setup(b) {
      b.onLoad({ filter: /\.ts$/ }, (args) => {
        if (!/src[\\/]client[\\/]/.test(args.path)) return null
        let src = readFileSync(args.path, 'utf8')
        for (const [file, from, to] of rules) {
          if (path.basename(args.path) !== file) continue
          if (src.indexOf(from) < 0) throw new Error('变异目标不存在（源码已变？）：' + from.slice(0, 80))
          src = src.split(from).join(to)
        }
        return { contents: src, loader: 'ts' }
      })
    },
  }
  await esbuild.build({
    entryPoints: [ENTRY],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
    plugins: [plugin],
  })
  return import(pathToFileURL(outfile).href + '?tag=' + encodeURIComponent(tag))
}

function writeEntry() {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  writeFileSync(ENTRY, [
    'export * as http from ' + JSON.stringify(path.join(ROOT, 'src/client/http.ts').replace(/\\/g, '/')),
    'export * as route from ' + JSON.stringify(path.join(ROOT, 'src/client/chat-route.ts').replace(/\\/g, '/')),
  ].join('\n'))
}

// ---------- 打桩 ----------

/** 永不回包（模拟宿主/云端不可达）；记录每次 fetch 收到的 init */
function stubPendingFetch() {
  const calls = []
  globalThis.fetch = (url, init) => {
    calls.push({ url: String(url), init: init || {} })
    return new Promise(() => { })
  }
  return calls
}

/** 可控回包：deferred.resolve(body) 才 settle */
function stubDeferredFetch() {
  const calls = []
  let resolveIt = null
  globalThis.fetch = (url, init) => {
    calls.push({ url: String(url), init: init || {} })
    return new Promise((resolve) => { resolveIt = resolve })
  }
  return {
    calls,
    resolve(body) {
      if (!resolveIt) throw new Error('还没有在途 fetch 可回包')
      resolveIt({ ok: true, status: 200, json: async () => body })
    },
  }
}

/** 立刻回包 / 立刻失败 */
function stubFetch(handler) {
  const calls = []
  globalThis.fetch = (url, init) => {
    calls.push({ url: String(url), init: init || {} })
    return handler(String(url), init || {}, calls.length)
  }
  return calls
}

function timeoutLike() {
  if (typeof DOMException === 'function') return new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  const e = new Error('timeout')
  e.name = 'TimeoutError'
  return e
}

/**
 * 截获 ≥ limitMs 的 setTimeout：只记录、不真的排（否则默认 15s 的用例会把测试拖到 15s）。
 * 小的定时器照常走真实 setTimeout（显式 timeout 的用例要用）。
 */
function captureLongTimers(limitMs = 1000) {
  const real = globalThis.setTimeout
  const seen = []
  const fake = { __fakeTimer: true, unref() { return this } }
  globalThis.setTimeout = function (cb, ms, ...args) {
    const n = Number(ms) || 0
    seen.push(n)
    if (n >= limitMs) return fake
    return real(cb, n, ...args)
  }
  return {
    seen,
    wait: (ms) => new Promise((r) => real(r, ms)),
    restore() { globalThis.setTimeout = real },
  }
}

/**
 * 观察一次调用的预算：返回 { seen, value }。
 * seen = 它排过的 ≥1s 定时器列表（默认预算/显式大预算都在这里现形）；
 * value = 被调对象的同步返回值（路由命中 true/false 用）。
 */
async function observeBudget(call) {
  const cap = captureLongTimers()
  try {
    const value = call()
    // 计时器被截获后请求会一直挂着：挂个空 catch，别让「永不 settle」变成噪音
    Promise.resolve(value).catch(() => { })
    await cap.wait(30)
    return { seen: cap.seen.slice(), value }
  } finally {
    cap.restore()
  }
}

// ---------- 断言套件 ----------

async function suite(mods) {
  const { http, route } = mods

  await group('A. http.ts：默认预算 15s（不短于宿主 10s 链路预算）', async () => {
    const getCalls = stubPendingFetch()
    const getSeen = (await observeBudget(() => http.getJson('/culture?type=minsu'))).seen
    ok('getJson 不传参 → 排 15000ms 预算', getSeen.indexOf(15000) >= 0, 'seen=' + getSeen.join(','))
    ok('默认预算不短于宿主数据接口的 10s', getSeen.some((n) => n >= 10000), 'seen=' + getSeen.join(','))
    ok('默认预算通过 AbortController 传给 fetch（连接可被中止）',
      !!getCalls[0] && !!getCalls[0].init.signal)

    stubPendingFetch()
    const postSeen = (await observeBudget(() => http.postJson('/reminders', { text: '喝水' }))).seen
    ok('postJson 不传参 → 排 15000ms 预算', postSeen.indexOf(15000) >= 0, 'seen=' + postSeen.join(','))

    stubPendingFetch()
    const delSeen = (await observeBudget(() => http.delJson('/cache'))).seen
    ok('delJson 不传参 → 排 15000ms 预算', delSeen.indexOf(15000) >= 0, 'seen=' + delSeen.join(','))

    globalThis.fetch = undefined
  })

  await group('B. 覆盖与兼容（调用方优先 / 老浏览器 / 迟到结果）', async () => {
    // B1 显式 timeout 覆盖默认：三个入口都要真的按 60ms 失败
    for (const [name, call] of [
      ['getJson', (ms) => http.getJson('/poem', { timeout: ms })],
      ['postJson', (ms) => http.postJson('/chat', {}, { timeout: ms })],
      ['delJson', (ms) => http.delJson('/cache', { timeout: ms })],
    ]) {
      stubPendingFetch()
      const t0 = Date.now()
      let err = null
      try {
        await settleWithin(call(60), 1500)
      } catch (e) {
        err = e
      }
      const spent = Date.now() - t0
      ok(name + ' 显式 timeout:60 → 抛 TimeoutError', !!err && err.name === 'TimeoutError',
        err ? String(err.name) : '没有拒绝')
      ok(name + ' 超时耗时落在预算附近（40–1200ms）', spent >= 40 && spent <= 1200, spent + 'ms')
    }

    // B2 timeout:0 = 不设超时（调用方显式关闭；语义与 timeoutSignal(0) 一致）
    const deferred = stubDeferredFetch()
    const cap0 = captureLongTimers()
    const p0 = http.getJson('/state', { timeout: 0 })
    p0.catch(() => { })
    await cap0.wait(40)
    const zeroSeen = cap0.seen.slice()
    cap0.restore()
    ok('timeout:0 → 不排 15s 默认预算', zeroSeen.indexOf(15000) < 0, 'seen=' + zeroSeen.join(','))
    ok('timeout:0 → 40ms 后仍在等（真的没有超时）', !!deferred.calls.length)
    deferred.resolve({ ok: true, marker: 'slow-ok' })
    const zeroData = await settleWithin(p0, 1000)
    eq('timeout:0 → 回包后照常解析', zeroData, { ok: true, marker: 'slow-ok' })

    // B3 调用方自带 signal：不叠加默认预算，signal 原样交给 fetch（说书 B98 / 聊天 30s 的既有语义）
    const sigCalls = stubPendingFetch()
    const ctl = new AbortController()
    const capSig = captureLongTimers()
    const ps = http.getJson('/story/books', { signal: ctl.signal })
    ps.catch(() => { })
    await capSig.wait(40)
    const sigSeen = capSig.seen.slice()
    capSig.restore()
    ok('调用方自带 signal → 不叠加默认 15s 预算', sigSeen.indexOf(15000) < 0, 'seen=' + sigSeen.join(','))
    ok('调用方 signal 原样传给 fetch（不被包装）', sigCalls[0] && sigCalls[0].init.signal === ctl.signal)
    ctl.abort()
    let abortErr = null
    try { await settleWithin(ps, 1000) } catch (e) { abortErr = e }
    ok('外部 abort → AbortError（不误报成 TimeoutError）',
      !!abortErr && abortErr.name === 'AbortError', abortErr ? String(abortErr.name) : '没有拒绝')

    // B4 显式预算 + 外部 signal：预算仍生效，但中止原因是调用方的 AbortError
    stubPendingFetch()
    const ctl2 = new AbortController()
    const p4 = http.getJson('/chat', { timeout: 500, signal: ctl2.signal })
    p4.catch(() => { })
    await sleep(20)
    ctl2.abort()
    let err4 = null
    try { await settleWithin(p4, 1000) } catch (e) { err4 = e }
    ok('显式预算 + 外部 abort → 立即按 AbortError 结算（不等到 500ms）',
      !!err4 && err4.name === 'AbortError', err4 ? String(err4.name) : '没有拒绝')

    // B5 老浏览器：没有 AbortController 也要按预算失败（setTimeout 兜底，不依赖 AbortSignal.timeout/any）
    const savedAC = globalThis.AbortController
    stubPendingFetch()
    try {
      // eslint-disable-next-line no-global-assign
      globalThis.AbortController = undefined
      let oldErr = null
      const t0 = Date.now()
      try {
        await settleWithin(http.getJson('/poem', { timeout: 60 }), 1500)
      } catch (e) {
        oldErr = e
      }
      ok('无 AbortController：仍抛 TimeoutError', !!oldErr && oldErr.name === 'TimeoutError',
        oldErr ? String(oldErr.name) : '没有拒绝')
      ok('无 AbortController：超时耗时约 60ms', Date.now() - t0 >= 40 && Date.now() - t0 <= 1200,
        (Date.now() - t0) + 'ms')
    } finally {
      globalThis.AbortController = savedAC
    }

    // B6 到点后的迟到响应：丢弃，不产生未处理拒绝、不把超时改写成成功
    let unhandled = 0
    const onUnhandled = () => { unhandled++ }
    process.on('unhandledRejection', onUnhandled)
    try {
      stubFetch(() => new Promise((resolve) => {
        setTimeout(() => resolve({ ok: true, status: 200, json: async () => ({ late: true }) }), 120)
      }))
      let lateErr = null
      try {
        await settleWithin(http.getJson('/poem', { timeout: 25 }), 1000)
      } catch (e) {
        lateErr = e
      }
      ok('迟到响应不会把超时改写成成功', !!lateErr && lateErr.name === 'TimeoutError',
        lateErr ? String(lateErr.name) : '没有拒绝')
      await sleep(200)
      ok('迟到响应被丢弃且没有未处理拒绝', unhandled === 0, 'unhandled=' + unhandled)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }

    globalThis.fetch = undefined
  })

  await group('C. chat-route.ts：/poem 15s、/culture 20s、超时走既有文案', async () => {
    const bubbles = []
    const host = {
      persona: {}, narrationRate: () => '+0%',
      bubble: (t) => bubbles.push(String(t)),
      say() { }, speak() { }, narrate() { }, clearNarrate() { }, talkFor() { },
      story: { start() { }, next() { }, reset() { }, abort() { }, playPiece() { } },
      storyState: {
        busy: { current: false }, narrating: { current: false },
        auto: { current: false }, book: { current: '' },
      },
    }
    const router = route.createLocalRouter(host)

    // C1 /poem 显式预算 15s（不是默认值碰巧等于 15s：这里断言的是 route 层显式传参）
    const poemCalls = stubPendingFetch()
    const poemObs = await observeBudget(() => router.route('背首诗'))
    ok('/poem 取数排 15000ms 预算', poemObs.seen.indexOf(15000) >= 0, 'seen=' + poemObs.seen.join(','))
    ok('/poem 预算通过 AbortController 传给 fetch',
      !!poemCalls[0] && !!poemCalls[0].init.signal)
    ok('「背首诗」被本地路由接住', poemObs.value === true)

    // C2 /culture 显式预算 20s
    stubPendingFetch()
    const cultureObs = await observeBudget(() => router.route('讲个典故'))
    ok('/culture 取数排 20000ms 预算', cultureObs.seen.indexOf(20000) >= 0, 'seen=' + cultureObs.seen.join(','))
    ok('culture 显式预算长于 poem（典故/成语数据源更慢）',
      Math.max(...cultureObs.seen) > Math.max(...poemObs.seen),
      'culture=' + Math.max(...cultureObs.seen) + 'ms / poem=' + Math.max(...poemObs.seen) + 'ms')

    // C3 /story/books 没有显式预算，走 http 默认 15s
    stubPendingFetch()
    const booksObs = await observeBudget(() => router.route('报书名'))
    ok('/story/books 取数走默认 15000ms 预算', booksObs.seen.indexOf(15000) >= 0, 'seen=' + booksObs.seen.join(','))

    // C4 超时后走既有失败文案（不新造文案）
    stubFetch(() => Promise.reject(timeoutLike()))
    bubbles.length = 0
    router.route('背首诗')
    await sleep(30)
    eq('念诗超时 → 既有文案「诗册没读到」', bubbles[bubbles.length - 1], '诗册没读到')

    bubbles.length = 0
    router.route('讲个成语')
    await sleep(30)
    eq('成语超时 → 既有文案「这个没读到」', bubbles[bubbles.length - 1], '这个没读到')

    bubbles.length = 0
    router.route('报书名')
    await sleep(30)
    eq('书单超时 → 既有文案「书单没取到，稍后再试」', bubbles[bubbles.length - 1], '书单没取到，稍后再试')

    globalThis.fetch = undefined
  })

  await group('D. 既有 timeoutSignal 口径不变（说书 B98 依赖）', async () => {
    eq('timeoutSignal(0) → undefined', http.timeoutSignal(0), undefined)
    eq('timeoutSignal(非数字) → undefined', http.timeoutSignal('abc'), undefined)
    const sig = http.timeoutSignal(40)
    ok('timeoutSignal(40) 到点 abort', !!sig && sig.aborted === false)
    await sleep(80)
    ok('到点后 aborted=true', !!sig && sig.aborted === true)
    ok('拒绝原因仍是 TimeoutError', !!sig && sig.reason && sig.reason.name === 'TimeoutError',
      String(sig && sig.reason && sig.reason.name))
  })
}

// ---------- 主流程 ----------

try {
  writeEntry()
  const mods = await buildBundle('base')
  await suite(mods)

  if (WITH_MUTATE) {
    console.log('\n[E. 变异自检：把默认超时改回「无超时」]')
    try {
      const mutated = await buildBundle('no-default', [
        ['http.ts', 'const DEFAULT_TIMEOUT_MS = 15000', 'const DEFAULT_TIMEOUT_MS = 0'],
      ])
      stubPendingFetch()
      const seen = (await observeBudget(() => mutated.http.getJson('/culture?type=minsu'))).seen
      ok('变异体「默认超时改回无超时」被 A 组断言抓出（不再排 15000ms）',
        seen.indexOf(15000) < 0, 'seen=' + seen.join(','))
      globalThis.fetch = undefined
    } catch (e) {
      ok('变异自检可执行（源码结构未变）', false, String((e && e.message) || e))
    }
  }

  console.log('\n[client-net] 通过 ' + pass + ' 项 / 失败 ' + fail + ' 项')
  if (fail) {
    console.log('[client-net] 失败清单：')
    for (const f of failures) console.log('  - ' + f)
    process.exitCode = 1
  } else {
    console.log('[client-net] ✅ 全部通过')
  }
} finally {
  rmSync(TMP, { recursive: true, force: true })
  try { globalThis.fetch = undefined } catch (e) { }
}
