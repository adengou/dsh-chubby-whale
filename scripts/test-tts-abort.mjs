/**
 * scripts/test-tts-abort.mjs —— B94「客户端断连 → 中止 TTS 合成」专项回归（离线、不联网、不起真子进程）
 *
 * 为什么单独建这个文件：`scripts/test.mjs` 的 [21] 只覆盖「入参校验 / 缓存 / 失败闸门」，
 * `test-voice-routes.mjs` 只覆盖体积与白名单，`test-tts-engine.mjs` 只覆盖 worker 协议与超时 ——
 * 「客户端走了，宿主还在把合成跑完」这条浪费路径**没有任何断言**（B93 分身取证，与 /asr 同源）。
 * package.json 与 scripts/test.mjs 均未改，用 `node scripts/test-tts-abort.mjs` 单跑。
 *
 * 覆盖：
 *   A. 路由层 host/routes/tts.ts
 *      A1 正常请求不被误伤：req 读完 body 发 close（complete=true）+ res 正常结束 → 不 abort、200、
 *         引擎收到的 signal 存在且未中止、监听全部摘除
 *      A2 res close（响应没写完 = 客户端走了）→ 引擎收到的 signal 被 abort、不回包、不写缓存、
 *         日志是 TTS-CLIENT-ABORT
 *      A3 断连不记失败：连断 3 次（> DEGRADE_AFTER=2）后正常请求仍 200（没被推进 501 降级闸）
 *      A4 请求体没收完就断（req aborted + complete=false）→ 不调引擎、不回包、不算合成失败
 *      A5 云端路径断连 → 云端被 abort 后**不回退 edge-tts**（同一段不合成两遍）、不写缓存
 *      A6 云端正常成功 → 不误伤（走云端、不调引擎、signal 未中止）
 *   B. 云端 host/voice/cloud-tts.ts（自己的超时 × 调用方中止）
 *      B1 第 2 个参数 signal 传进 fetch，并与内部超时合并（init.signal 是另一个 AbortSignal）；
 *         客户端中止后立刻结束（不等 15s），不记账、不写 cloud-usage.json
 *      B2 不传 signal 时仍是原来的内部超时（AbortError 上抛，既有行为不变）
 *      B3 传入已中止的 signal → 立刻抛 AbortError，一个请求都不发
 *      B4 中止后预占额度已释放：下一次正常合成成功，用量只记正常那次
 *   C. 引擎 host/tts-engine.ts / tts/worker.ts / tts/spawn.ts（esbuild 沙箱：假 fs + 假子进程）
 *      C1 已中止的请求 → 立刻 AbortError，不探测、不起进程、不落临时文件
 *      C2 worker 不回包时中止 → 立刻放弃等待（不等 20s 预算）、不回退单次 spawn、
 *         临时文件被 unlink 清理、**不杀**共享 worker
 *      C3 无 signal 的正常合成照旧出音、临时文件照旧清理（既有行为不变）
 *      C4 回退单次合成期间中止 → 独占的 python 被真的杀掉、立刻 AbortError、不算超时
 *      C5 临时文件删不掉（Windows 句柄未释放 EBUSY）也不拖住中止，重试后才放弃
 *
 * 负向验证（2026-11-07 本机实测记录）：把这批改动的 6 个源文件回退到基线 e9cd3c4（先备份到临时
 * 目录，跑完按 SHA-256 校验原样恢复，实测 0 处不一致），再单跑本文件：
 *   基线结果 35 通过 / 26 失败 / exit 1 / 13.6s（改动后 61 通过 / 0 失败）。
 *   基线红的正是本批要钉的：
 *     · A1/A6「signal 没传下去」（引擎/云端都收到 undefined）；
 *     · A2 断连后照常回 200、写缓存、没有任何 TTS-CLIENT-ABORT 诊断；
 *     · A3 连断 3 次全进了缓存（sets=4）；A4 body 中断被当成合成失败回 500；
 *     · A5 云端路径断连后还继续写缓存；
 *     · B1 客户端中止后要等满 15s 超时；B3 已中止的 signal 仍发了 1 个外呼；
 *     · C1 已中止仍起 1 个探测 + 1 个 worker；C2/C4/C5 中止后卡住不返回（3s 上限打满），
 *       unlink=0 / 独占 CLI 没被杀；C3 还看到上一条被放弃的请求在 dispose 后回退起了 CLI
 *       （正是"断连不中止"的连锁浪费）。
 *   基线仍通过的（证明新断言没顺手改既有语义）：B2 内部超时、B4 中止后的记账、C3 正常合成出音、
 *   A1/A2/A5 的「正常路径」那几条。
 *
 * 用法：node scripts/test-tts-abort.mjs
 * 退出码：0 = 全过；1 = 有失败
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// 源码跨模块 import 写的是 `.js`，源码是 `.ts`：测试进程里注册解析钩子（与其它 test-*.mjs 同一套）
register(new URL('./ts-resolve.mjs', import.meta.url))

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else {
    fail++
    failures.push(name + (detail ? '  ' + detail : ''))
    console.log('  ❌ ' + name + (detail ? '  ' + detail : ''))
  }
}
function group(title) { console.log('\n' + title) }
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 2000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await tick(5)
  }
  return false
}
async function catchErr(fn) {
  try {
    await fn()
    return null
  } catch (e) {
    return e
  }
}
/**
 * 带上限地等一个可能被 abort 打断的操作（路由 handler / engine.synthesize）。
 * 为什么要上限：这个测试的负向验证要跑在**没实现断连中止**的旧代码上，那时这些等待会挂到
 * 15s/20s 预算甚至永不返回；没有上限的话整套断言就卡死，只能看到一个"超时"，看不出哪几条红。
 * 上限只影响「本来就该在毫秒级结束」的等待，正常路径不会因此变慢。
 */
async function bounded(fn, ms = 1500) {
  const t0 = Date.now()
  const work = (async () => {
    try { return { value: await fn() } } catch (e) { return { err: e } }
  })()
  const r = await Promise.race([work, new Promise((res) => setTimeout(() => res({ timeout: true }), ms))])
  return { ...r, ms: Date.now() - t0 }
}
/** 真实 fetch 的拒绝原因：与 AbortSignal 同口径的 AbortError */
function abortErr() {
  const e = new Error('This operation was aborted')
  e.name = 'AbortError'
  return e
}

// 收集日志：断言「断连有专用诊断、没被当成合成失败」
const logs = { error: [], warn: [] }
const origError = console.error
const origWarn = console.warn
console.error = (...a) => logs.error.push(a.join(' '))
console.warn = (...a) => logs.warn.push(a.join(' '))

// AbortSignal.timeout 的定时器是 unref 的：挂一个 ref 的定时器吊住事件循环
const keepAlive = setInterval(() => { }, 1000)

const ROOT = resolve(import.meta.dirname, '..')

// ---------------------------------------------------------------------------
// 假 req / res：形状照 Node 24（req 读完 body 发 close、res 正常结束带 writableFinished）
// ---------------------------------------------------------------------------
function mkEmitter(base = {}) {
  const ls = new Map()
  const e = Object.assign(base, {
    on(ev, fn) { if (!ls.has(ev)) ls.set(ev, []); ls.get(ev).push(fn); return e },
    removeListener(ev, fn) { const a = ls.get(ev) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); return e },
    listenerCount(ev) { return (ls.get(ev) || []).length },
    emit(ev) { for (const fn of Array.from(ls.get(ev) || [])) fn() },
  })
  return e
}

/** body 读完即发 req close（complete=true）—— 这正是「只看 close 会误判断连」的那个坑 */
function mkReq(body, opts = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  const req = mkEmitter({
    headers: Object.assign({ 'content-length': String(buf.length) }, opts.headers || {}),
    complete: opts.complete !== undefined ? opts.complete : true,
    destroy() { },
    resume() { },
    async *[Symbol.asyncIterator]() {
      if (opts.throwMidBody) {
        req.complete = false
        req.emit('aborted')
        const e = new Error('aborted')
        e.code = 'ECONNRESET'
        throw e
      }
      yield buf
      req.emit('close')
    },
  })
  return req
}

function mkRes() {
  const out = mkEmitter({
    code: 0,
    headers: {},
    chunks: [],
    headersSent: false,
    writableEnded: false,
    writableFinished: false,
  })
  out.writeHead = (c, h) => { out.code = c; out.headers = h || {}; out.headersSent = true }
  out.end = (b) => {
    if (b) out.chunks.push(Buffer.isBuffer(b) ? b : Buffer.from(String(b)))
    out.writableEnded = true
    out.writableFinished = true
    out.emit('close')
  }
  out.setHeader = (k, v) => { out.headers[k] = v }
  out.body = () => Buffer.concat(out.chunks)
  out.text = () => out.body().toString('utf8')
  out.json = () => { try { return JSON.parse(out.text()) } catch { return null } }
  return out
}

/** 内存缓存：sets 计数用来断言「断连那次没写缓存」 */
function createMemCache() {
  const map = new Map()
  let sets = 0
  return {
    map,
    get sets() { return sets },
    async getJson(key) { return map.has(key) ? map.get(key) : null },
    async setJson(key, value) { sets++; map.set(key, value) },
    memGet() { return undefined },
    memSet() { },
    async clear() { map.clear(); return 0 },
    async count() { return map.size },
  }
}

const TTS = await import('../src/host/routes/tts.ts')
const CLOUD = await import('../src/host/voice/cloud-tts.ts')

const tmpRoot = mkdtempSync(join(tmpdir(), 'chubby-tts-abort-'))
const realFetch = globalThis.fetch

// 看门狗：断连中止没生效时，少数等待会挂到 15s/20s 预算甚至永不返回；
// 30s 还没跑完就判失败（配合下面的 bounded，正常/负向两种跑法都不会静默挂住）。
const watchdog = setTimeout(() => {
  console.log('\n❌ 测试超时：30s 内没跑完（有等待没被 abort 打断 —— 大概率是断连中止没生效）')
  process.exit(1)
}, 30000)

try {
  // =========================================================================
  // A. 路由层
  // =========================================================================
  group('[A] /tts 客户端断连 → 中止合成（路由层）')

  /**
   * 引擎桩：文本以「断连」开头就一直挂着（只有 signal 中止才会结束），其余立刻出音。
   * hangSeen 记录每次收到的 signal，用来断言「路由真的把 signal 传下去了、并且真的 abort 了」。
   */
  function mkRouteEngine() {
    const calls = []
    const signals = []
    return {
      calls,
      signals,
      async synthesize(o) {
        calls.push(o)
        signals.push(o.signal)
        if (!String(o.text).startsWith('断连')) return Buffer.from('MP3:' + o.text)
        return new Promise((resolve, reject) => {
          const sig = o.signal
          if (!sig) { resolve(Buffer.from('MP3:' + o.text)); return }
          if (sig.aborted) { reject(abortErr()); return }
          sig.addEventListener('abort', () => reject(abortErr()), { once: true })
        })
      },
    }
  }

  // A1 正常请求不被误伤
  {
    const cache = createMemCache()
    const engine = mkRouteEngine()
    const handle = TTS.createTtsHandler({ cache, engine })
    const req = mkReq({ text: '主人好呀' })
    const res = mkRes()
    await handle(req, res)
    ok('A1 正常请求 → 200', res.code === 200, 'code=' + res.code)
    ok('A1 正常请求 → 出音频字节', res.text() === 'MP3:主人好呀', res.text().slice(0, 40))
    ok('A1 正常请求把未中止的 signal 传给引擎（复用同一套端口）',
      !!engine.signals[0] && typeof engine.signals[0].aborted === 'boolean' && engine.signals[0].aborted === false,
      'signal.aborted=' + (engine.signals[0] && engine.signals[0].aborted))
    ok('A1 正常请求：req 读完 body 的 close 没被当成断连', !logs.error.some((l) => l.includes('TTS-CLIENT-ABORT')))
    ok('A1 正常请求照旧写缓存', cache.sets === 1, 'sets=' + cache.sets)
    ok('A1 请求结束摘掉 req/res 上的监听（不跨请求残留）',
      req.listenerCount('close') === 0 && req.listenerCount('aborted') === 0 && res.listenerCount('close') === 0,
      'req=' + req.listenerCount('close') + '/' + req.listenerCount('aborted') + ' res=' + res.listenerCount('close'))
  }

  // A2 合成中断连
  {
    const cache = createMemCache()
    const engine = mkRouteEngine()
    const handle = TTS.createTtsHandler({ cache, engine })
    logs.error.length = 0
    const req = mkReq({ text: '断连中这一句' })
    const res = mkRes()
    const p = handle(req, res)
    const started = await waitFor(() => engine.calls.length === 1)
    res.emit('close')   // 客户端走了：响应还没写完
    const done = await bounded(() => p, 2000)
    ok('A2 客户端走了 → 引擎收到的 signal 被 abort',
      started && !!engine.signals[0] && engine.signals[0].aborted === true,
      'engine 收到 ' + engine.calls.length + ' 次')
    ok('A2 中止后 handler 立刻收尾（没有挂着等合成跑完）', !done.timeout, '耗时 ' + done.ms + 'ms')
    ok('A2 不回包（连接已断，没人收）', res.code === 0 && res.chunks.length === 0, 'code=' + res.code)
    ok('A2 断连不写缓存', cache.sets === 0, 'sets=' + cache.sets)
    ok('A2 日志是 TTS-CLIENT-ABORT（不计失败）', logs.error.some((l) => l.includes('TTS-CLIENT-ABORT')), JSON.stringify(logs.error))
    ok('A2 断连没被记成合成失败（没有"语音合成失败"/降级文案）',
      !logs.error.some((l) => l.includes('语音合成失败') || l.includes('改走浏览器朗读')))
    ok('A2 结束后监听也摘干净', req.listenerCount('close') === 0 && res.listenerCount('close') === 0)
  }

  // A3 断连不进降级闸 + 缓存行为不受影响
  {
    const cache = createMemCache()
    const engine = mkRouteEngine()
    const handle = TTS.createTtsHandler({ cache, engine })
    logs.error.length = 0
    let hangCount = 0
    for (let i = 0; i < 3; i++) {
      const res = mkRes()
      const p = handle(mkReq({ text: '断连第' + i + '次' }), res)
      await waitFor(() => engine.calls.length === i + 1)
      res.emit('close')
      const r = await bounded(() => p, 2000)
      if (r.timeout) hangCount++
    }
    const abortedAll = engine.signals.slice(0, 3).every((s) => s && s.aborted === true)
    ok('A3 连断 3 次都真的中止了（每次 handler 都及时收尾）', abortedAll && hangCount === 0,
      '挂住 ' + hangCount + ' 次')
    const res2 = mkRes()
    await handle(mkReq({ text: '正常一句' }), res2)
    // DEGRADE_AFTER 默认 2：若断连被记成失败，第 3 次就该回 501 并在窗口内继续 501
    ok('A3 断连 3 次（> DEGRADE_AFTER）后正常请求仍 200 —— 没被推进降级闸',
      res2.code === 200, 'code=' + res2.code + ' body=' + res2.text().slice(0, 60))
    ok('A3 缓存里只有正常那次（断连全都没进缓存）', cache.sets === 1 && cache.map.size === 1,
      'sets=' + cache.sets + ' size=' + cache.map.size)
    const before = engine.calls.length
    const res3 = mkRes()
    await handle(mkReq({ text: '正常一句' }), res3)
    ok('A3 正常缓存命中照旧（不调引擎、直接回音频）',
      engine.calls.length === before && res3.code === 200 && res3.text() === 'MP3:正常一句',
      'engine 调用 +' + (engine.calls.length - before))
  }

  // A4 请求体没收完就断
  {
    const engine = mkRouteEngine()
    const handle = TTS.createTtsHandler({ cache: createMemCache(), engine })
    logs.error.length = 0
    const res = mkRes()
    await handle(mkReq('{"text":"半截', { throwMidBody: true }), res)
    ok('A4 body 没收完就断 → 不调引擎', engine.calls.length === 0)
    ok('A4 body 没收完就断 → 不回包', res.code === 0 && res.chunks.length === 0, 'code=' + res.code)
    ok('A4 日志区分「未发起合成」那种断连',
      logs.error.some((l) => l.includes('TTS-CLIENT-ABORT') && l.includes('未发起合成')), JSON.stringify(logs.error))
  }

  // A5 云端路径断连 → 不回退 edge-tts
  {
    const cache = createMemCache()
    const cloudCalls = []
    const cloud = {
      enabled: () => true,
      synthesize(text, signal) {
        cloudCalls.push({ text, signal })
        return new Promise((resolve, reject) => {
          if (!signal) { resolve(Buffer.from('CLOUD:' + text)); return }
          if (signal.aborted) { reject(abortErr()); return }
          signal.addEventListener('abort', () => reject(abortErr()), { once: true })
        })
      },
    }
    const engine = mkRouteEngine()
    const handle = TTS.createTtsHandler({ cache, engine, cloudTts: cloud })
    logs.error.length = 0
    logs.warn.length = 0
    const res = mkRes()
    const p = handle(mkReq({ text: '云端断连这一句' }), res)
    await waitFor(() => cloudCalls.length === 1)
    res.emit('close')
    const done = await bounded(() => p, 2000)
    ok('A5 云端拿到路由给的 signal 且被 abort', cloudCalls.length === 1 && cloudCalls[0].signal && cloudCalls[0].signal.aborted === true)
    ok('A5 中止后 handler 立刻收尾（没有挂着等云端跑完）', !done.timeout, '耗时 ' + done.ms + 'ms')
    ok('A5 云端被中止后不回退 edge-tts（同一段不合成两遍）', engine.calls.length === 0,
      'edge 调用 ' + engine.calls.length + ' 次')
    ok('A5 云端路径断连 → 不回包、不写缓存', res.code === 0 && cache.sets === 0)
    ok('A5 云端路径断连 → 也没有 CLOUD-FAIL 回退告警',
      !logs.warn.some((l) => l.includes('CLOUD-FAIL')), JSON.stringify(logs.warn))
  }

  // A6 云端正常成功不误伤
  {
    const cache = createMemCache()
    const cloudCalls = []
    const cloud = {
      enabled: () => true,
      async synthesize(text, signal) { cloudCalls.push({ text, signal }); return Buffer.from('CLOUD:' + text) },
    }
    const engine = mkRouteEngine()
    const handle = TTS.createTtsHandler({ cache, engine, cloudTts: cloud })
    const res = mkRes()
    await handle(mkReq({ text: '云端正常一句' }), res)
    ok('A6 云端成功 → 200 且音频来自云端', res.code === 200 && res.text() === 'CLOUD:云端正常一句', res.text().slice(0, 40))
    ok('A6 云端成功时引擎不被调用', engine.calls.length === 0)
    ok('A6 云端成功时 signal 未中止', !!cloudCalls[0].signal && cloudCalls[0].signal.aborted === false)
    ok('A6 云端成功照旧写缓存', cache.sets === 1)
  }

  // =========================================================================
  // B. 云端 cloud-tts：自己的超时 × 调用方中止
  // =========================================================================
  group('[B] cloud-tts：signal 与 15s 超时合并（AbortSignal.any）')

  const CFG = { enabled: true, apiKey: 'k-test', speaker: 'sp', resourceId: 'rid', dailyChars: 1e9 }
  const API_CALLS = []
  /** 挂起的上游：只有 init.signal 中止才会结束（用来证明「等的是哪个 signal」） */
  function stubHang() {
    globalThis.fetch = (url, init = {}) => {
      const call = { url: String(url), init }
      API_CALLS.push(call)
      return new Promise((resolve, reject) => {
        const sig = init.signal
        if (!sig) return
        if (sig.aborted) { reject(abortErr()); return }
        sig.addEventListener('abort', () => reject(abortErr()), { once: true })
      })
    }
  }
  function stubOk() {
    globalThis.fetch = async (url, init = {}) => {
      API_CALLS.push({ url: String(url), init })
      const line = JSON.stringify({ code: 0, data: Buffer.from('ID3').toString('base64') }) + '\n'
        + JSON.stringify({ code: 20000000 }) + '\n'
      return { ok: true, status: 200, text: async () => line }
    }
  }

  // B1 客户端中止 → 立刻结束、不记账
  {
    const dir = mkdtempSync(join(tmpRoot, 'cloud-abort-'))
    API_CALLS.length = 0
    stubHang()
    const tts = CLOUD.createCloudTts({ config: () => CFG, runtimeDir: dir })
    const ctl = new AbortController()
    const t0 = Date.now()
    const p = bounded(() => tts.synthesize('你好', ctl.signal), 2000)
    await waitFor(() => API_CALLS.length === 1)
    const sent = API_CALLS[0].init.signal
    ok('B1 外呼 signal 是「超时 + 调用方」合并后的另一个 AbortSignal',
      !!sent && sent !== ctl.signal && typeof sent.addEventListener === 'function')
    ok('B1 中止前合并 signal 未中止', !!sent && sent.aborted === false)
    ctl.abort()
    const r = await p
    ok('B1 客户端中止 → 立刻结束（不等 15s 超时）',
      !r.timeout && r.err && r.err.name === 'AbortError' && Date.now() - t0 < 2000,
      (r.timeout ? '卡住未返回' : (r.err && r.err.name)) + ' ' + (Date.now() - t0) + 'ms')
    ok('B1 合并 signal 随之 abort（fetch 真的被断开）', !!sent && sent.aborted === true)
    ok('B1 中止不记账：没有 cloud-usage.json', !existsSync(join(dir, 'cloud-usage.json')))
    ok('B1 中止不记用量：usage().chars=0', tts.usage().chars === 0, 'chars=' + tts.usage().chars)

    // B4 中止后预占额度已释放：下一次正常合成成功，且用量只记正常那次
    API_CALLS.length = 0
    stubOk()
    const buf = await tts.synthesize('再来一句')
    ok('B4 中止后用同一实例正常合成成功（预占额度已还回去）', Buffer.isBuffer(buf) && buf.length === 3, 'bytes=' + buf.length)
    const usage = JSON.parse(readFileSync(join(dir, 'cloud-usage.json'), 'utf8'))
    ok('B4 用量只记正常那次（中止那次没混进日字数）', usage.chars === 4, JSON.stringify(usage))
  }

  // B2 不传 signal → 仍是原来的内部超时
  {
    const dir = mkdtempSync(join(tmpRoot, 'cloud-timeout-'))
    API_CALLS.length = 0
    stubHang()
    const tts = CLOUD.createCloudTts({ config: () => CFG, runtimeDir: dir, timeoutMs: 30 })
    const t0 = Date.now()
    const e = await catchErr(() => tts.synthesize('超时这一句'))
    ok('B2 不传 signal 时仍是内部超时（AbortError 上抛，行为不变）',
      e && e.name === 'AbortError' && Date.now() - t0 < 2000, (e && e.name) + ' ' + (Date.now() - t0) + 'ms')
    ok('B2 超时路径也不记账', !existsSync(join(dir, 'cloud-usage.json')))
  }

  // B3 已经中止的 signal → 一个请求都不发
  {
    const dir = mkdtempSync(join(tmpRoot, 'cloud-prealbort-'))
    API_CALLS.length = 0
    stubHang()
    const tts = CLOUD.createCloudTts({ config: () => CFG, runtimeDir: dir })
    const ctl = new AbortController()
    ctl.abort()
    const r = await bounded(() => tts.synthesize('早就断了', ctl.signal), 2000)
    const e = r.err
    ok('B3 已中止的 signal → 立刻抛 AbortError',
      !r.timeout && e && e.name === 'AbortError', r.timeout ? '卡住未返回' : (e && e.message))
    ok('B3 已中止的 signal → 一个外呼都不发', API_CALLS.length === 0, 'fetch=' + API_CALLS.length)
    ok('B3 已中止的 signal → 不记账', !existsSync(join(dir, 'cloud-usage.json')))
  }

  globalThis.fetch = realFetch

  // =========================================================================
  // C. 引擎：abort 时立刻放弃等待 + 清理产物（esbuild 沙箱）
  // =========================================================================
  group('[C] tts-engine / worker / spawn：abort 中止当前合成')

  const fsState = { files: new Map(), unlinkCalls: 0, unlinkFailures: 0 }
  const calls = { worker: [], cli: [], probe: [] }
  let scenario = {}
  let pidSeq = 0

  const fakeFs = {
    existsSync: () => false,
    readFile: async (p) => {
      if (!fsState.files.has(String(p))) {
        const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e
      }
      return Buffer.from(fsState.files.get(String(p)))
    },
    writeFile: async () => { },
    unlink: async (p) => {
      fsState.unlinkCalls++
      if (fsState.unlinkFailures > 0) {
        fsState.unlinkFailures--
        const e = new Error('EBUSY: resource busy or locked, unlink ' + p); e.code = 'EBUSY'; throw e
      }
      fsState.files.delete(String(p))
    },
    readdir: async () => [...fsState.files.keys()].map((p) => String(p).split(/[\\/]/).pop()),
    // 一律当作「刚写的新文件」：让启动时的 sweepStaleTmp 不碰本测试的临时产物
    stat: async (p) => {
      if (!fsState.files.has(String(p))) {
        const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e
      }
      return { mtimeMs: Date.now() }
    },
  }

  class FakeChild extends EventEmitter {
    constructor(kind, args) {
      super()
      this.kind = kind
      this.args = args
      this.pid = ++pidSeq
      this.exitCode = null
      this.signalCode = null
      this.killCalls = 0
      this.hasExited = false
      this.stdout = new EventEmitter()
      this.stderr = new EventEmitter()
      const self = this
      this.stdin = {
        write(chunk) {
          for (const line of String(chunk).split('\n')) {
            if (!line.trim()) continue
            let msg = null
            try { msg = JSON.parse(line) } catch { continue }
            if (msg) self.onRequest(msg)
          }
          return true
        },
        end() { }, on() { }, destroy() { },
      }
      this.start()
    }
    out(chunk) {
      if (this.hasExited) return
      this.stdout.emit('data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    }
    exit(code) {
      if (this.hasExited) return
      this.hasExited = true
      this.exitCode = code === undefined ? 0 : code
      this.emit('exit', this.exitCode)
    }
    kill() {
      this.killCalls++
      if (this.hasExited) return true
      this.signalCode = 'SIGTERM'
      setImmediate(() => {
        if (this.hasExited) return
        this.hasExited = true
        this.emit('exit', null)
      })
      return true
    }
    unref() { return this }
    ref() { return this }
    start() {
      if (this.kind === 'probe') {
        setImmediate(() => { this.out('ok\n'); this.exit(0) })
        return
      }
      if (this.kind === 'worker') {
        const delay = Number(scenario.readyDelayMs) || 0
        setTimeout(() => this.out(JSON.stringify({ ready: true }) + '\n'), delay)
        return
      }
      // cli：单次合成 python -m edge_tts
      if (scenario.cliMode === 'hang') return
      setImmediate(() => {
        const i = this.args.indexOf('--write-media')
        if (i >= 0) fsState.files.set(String(this.args[i + 1]), Buffer.from('ID3fake-mp3'))
        this.exit(0)
      })
    }
    onRequest(msg) {
      if (typeof scenario.onWorkerRequest === 'function') {
        scenario.onWorkerRequest(this, msg)
        return
      }
      if (msg.out) fsState.files.set(String(msg.out), Buffer.from('ID3fake-mp3'))
      setImmediate(() => this.out(JSON.stringify({ id: msg.id, ok: true }) + '\n'))
    }
  }

  function fakeSpawn(cmd, args = []) {
    const argv = Array.isArray(args) ? args : []
    const kind = argv.some((a) => String(a).endsWith('.py'))
      ? 'worker'
      : argv.includes('-c') ? 'probe' : 'cli'
    const child = new FakeChild(kind, argv)
    calls[kind].push({ cmd, args: argv, child })
    return child
  }

  globalThis.__ttsAbortHarness = { fs: fakeFs, spawn: fakeSpawn }

  const STUB_CP = `
const h = globalThis.__ttsAbortHarness
export function spawn(...a) { return h.spawn(...a) }
`
  const STUB_FS = `
const h = globalThis.__ttsAbortHarness
export function existsSync(p) { return h.fs.existsSync(p) }
`
  const STUB_FSP = `
const h = globalThis.__ttsAbortHarness
export function readFile(p) { return h.fs.readFile(p) }
export function writeFile(p) { return h.fs.writeFile(p) }
export function unlink(p) { return h.fs.unlink(p) }
export function readdir(p) { return h.fs.readdir(p) }
export function stat(p) { return h.fs.stat(p) }
`
  const SANDBOX = join(tmpRoot, 'sandbox')
  mkdirSync(SANDBOX, { recursive: true })

  async function loadEngine() {
    const out = await build({
      entryPoints: [join(ROOT, 'src/host/tts-engine.ts')],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      logLevel: 'silent',
      plugins: [{
        name: 'tts-abort-sandbox',
        setup(b) {
          b.onResolve({ filter: /^node:child_process$/ }, () => ({ path: 'stub:cp', namespace: 'stub' }))
          b.onResolve({ filter: /^node:fs$/ }, () => ({ path: 'stub:fs', namespace: 'stub' }))
          b.onResolve({ filter: /^node:fs\/promises$/ }, () => ({ path: 'stub:fsp', namespace: 'stub' }))
          b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => {
            if (a.path === 'stub:cp') return { contents: STUB_CP, loader: 'js' }
            if (a.path === 'stub:fs') return { contents: STUB_FS, loader: 'js' }
            return { contents: STUB_FSP, loader: 'js' }
          })
        },
      }],
    })
    const file = join(SANDBOX, 'engine.mjs')
    writeFileSync(file, out.outputFiles[0].text, 'utf8')
    return import(pathToFileURL(file).href)
  }

  function resetC(s) {
    fsState.files.clear()
    fsState.unlinkCalls = 0
    fsState.unlinkFailures = 0
    calls.worker.length = 0
    calls.cli.length = 0
    calls.probe.length = 0
    scenario = s || {}
  }

  const REQ = { text: '你好，大肥鱼。', voice: 'zh-CN-XiaoyiNeural', rate: '+0%', pitch: '+0Hz' }
  // 探测这层不测（原生 python.ts 有 2s 硬超时，离线环境没必要真等）：显式指定假解释器
  process.env.CHUBBY_WHALE_PYTHON = 'fake-python'
  const ENG = await loadEngine()

  // C1 已经中止的请求：连探测/进程都不该发生
  {
    resetC({})
    ENG.resetTtsInterpreterProbe()
    const eng = ENG.createEdgeTtsEngine({ timeoutMs: 20000 })
    const ctl = new AbortController()
    ctl.abort()
    const t0 = Date.now()
    const r = await bounded(() => eng.synthesize({ ...REQ, signal: ctl.signal }), 3000)
    const dt = Date.now() - t0
    ok('C1 已中止 → 立刻 AbortError', !r.timeout && r.err && r.err.name === 'AbortError' && dt < 300,
      (r.err && r.err.name) + ' ' + dt + 'ms')
    ok('C1 已中止 → 不 spawn 任何 python（探测/worker/CLI 都是 0）',
      calls.probe.length + calls.worker.length + calls.cli.length === 0,
      'probe=' + calls.probe.length + ' worker=' + calls.worker.length + ' cli=' + calls.cli.length)
    ok('C1 已中止 → 不落临时文件', fsState.files.size === 0, '残留=' + fsState.files.size)
    ok('C1 中止错误不带 TTS_UNAVAILABLE（路由不会被推到 501 降级）',
      r.err && r.err.code === undefined, 'code=' + (r.err && r.err.code))
    eng.dispose()
  }

  // C2 worker 不回包 + 中途 abort
  {
    resetC({ onWorkerRequest: () => { /* 永不回包 */ } })
    ENG.resetTtsInterpreterProbe()
    const eng = ENG.createEdgeTtsEngine({ timeoutMs: 20000 })
    const ctl = new AbortController()
    const p = bounded(() => eng.synthesize({ ...REQ, signal: ctl.signal }), 3000)
    const started = await waitFor(() => calls.worker.length === 1)
    await tick(40)   // 等 stdin 写入 + 临时文件建立
    const t0 = Date.now()
    ctl.abort()
    const r = await p
    const dt = Date.now() - t0
    ok('C2 worker 接管后 abort → 立刻放弃等待（不等 20s 预算）',
      started && !r.timeout && r.err && r.err.name === 'AbortError' && dt < 800,
      (r.err && r.err.name) + ' ' + dt + 'ms' + (r.timeout ? ' (卡住未返回)' : ''))
    ok('C2 abort 不回退单次 spawn（同一段不合成第二遍）', calls.cli.length === 0, 'cli 进程 ' + calls.cli.length + ' 个')
    ok('C2 abort 后临时文件被清理', fsState.files.size === 0, '残留=' + fsState.files.size)
    ok('C2 清理是真删（unlink 被调用过）', fsState.unlinkCalls >= 1, 'unlink=' + fsState.unlinkCalls)
    ok('C2 abort 不杀常驻 worker（跨请求共享，取舍见 tts-engine 文件头）',
      !!calls.worker[0] && calls.worker[0].child.killCalls === 0,
      'kill=' + (calls.worker[0] && calls.worker[0].child.killCalls))
    eng.dispose()
  }

  // C3 无 signal 的正常合成：既有行为不变
  {
    resetC({})
    ENG.resetTtsInterpreterProbe()
    const eng = ENG.createEdgeTtsEngine({ timeoutMs: 20000 })
    const r = await bounded(() => eng.synthesize({ ...REQ }), 3000)
    ok('C3 不带 signal 的正常合成照旧出 mp3',
      !r.timeout && Buffer.isBuffer(r.value) && r.value.length > 0, 'bytes=' + (r.value && r.value.length))
    ok('C3 正常路径临时文件照旧清理', fsState.files.size === 0, '残留=' + fsState.files.size)
    ok('C3 正常路径不起多余 CLI 进程', calls.cli.length === 0)
    eng.dispose()
  }

  // C4 回退单次合成期间 abort
  {
    resetC({
      // worker 回 ok:false → 上层回退 synthViaCli；CLI 挂着不回，只有 abort 能结束
      onWorkerRequest(child, msg) {
        setImmediate(() => child.out(JSON.stringify({ id: msg.id, ok: false, error: 'NoAudioReceived' }) + '\n'))
      },
      cliMode: 'hang',
    })
    ENG.resetTtsInterpreterProbe()
    const eng = ENG.createEdgeTtsEngine({ timeoutMs: 20000 })
    const timeoutsBefore = ENG.getTtsEngineStats().timeouts
    const ctl = new AbortController()
    const p = bounded(() => eng.synthesize({ ...REQ, signal: ctl.signal }), 3000)
    const spawned = await waitFor(() => calls.cli.length === 1, 3000)
    const cliChild = spawned ? calls.cli[0].child : null
    const t0 = Date.now()
    ctl.abort()
    const r = await p
    const dt = Date.now() - t0
    ok('C4 回退单次合成期间 abort → 立刻 AbortError',
      spawned && !r.timeout && r.err && r.err.name === 'AbortError' && dt < 800,
      (r.err && r.err.name) + ' ' + dt + 'ms' + (r.timeout ? ' (卡住未返回)' : ''))
    ok('C4 独占的 CLI python 被真的杀掉', !!cliChild && cliChild.killCalls >= 1, 'kill=' + (cliChild && cliChild.killCalls))
    ok('C4 abort 后不留临时文件', fsState.files.size === 0, '残留=' + fsState.files.size)
    ok('C4 中止不计成超时（timeouts 统计不变，语境不被污染）',
      ENG.getTtsEngineStats().timeouts === timeoutsBefore,
      'timeouts ' + timeoutsBefore + ' → ' + ENG.getTtsEngineStats().timeouts)
    eng.dispose()
  }

  // C5 临时文件删不掉（Windows 句柄未释放）时也不拖住中止
  {
    resetC({ onWorkerRequest: () => { /* 永不回包 */ } })
    // unlink 连续失败 3 次（= removeTemp 的 3 次尝试全部 EBUSY）→ 复现 Windows 句柄未释放
    fsState.unlinkFailures = 3
    ENG.resetTtsInterpreterProbe()
    const eng = ENG.createEdgeTtsEngine({ timeoutMs: 20000 })
    const ctl = new AbortController()
    const p = bounded(() => eng.synthesize({ ...REQ, signal: ctl.signal }), 3000)
    await waitFor(() => calls.worker.length === 1)
    await tick(40)
    const t0 = Date.now()
    ctl.abort()
    const r = await p
    const dt = Date.now() - t0
    ok('C5 临时文件 EBUSY 删不掉也不拖住中止（仍立刻 AbortError）',
      !r.timeout && r.err && r.err.name === 'AbortError' && dt < 2000,
      (r.err && r.err.name) + ' ' + dt + 'ms' + (r.timeout ? ' (卡住未返回)' : ''))
    ok('C5 unlink 反复重试后才放弃（不是一次就认输）', fsState.unlinkCalls >= 3, 'unlink=' + fsState.unlinkCalls)
    ok('C5 删不掉的残留不被当成合成结果（本次没有返回值）', r.value === undefined)
    eng.dispose()
  }
} catch (e) {
  fail++
  failures.push('测试脚本自身抛异常：' + String((e && e.stack) || e))
  console.log('\n❌ 测试脚本自身抛异常：' + String((e && e.stack) || e))
} finally {
  globalThis.fetch = realFetch
  clearTimeout(watchdog)
  clearInterval(keepAlive)
  console.error = origError
  console.warn = origWarn
  delete process.env.CHUBBY_WHALE_PYTHON
  try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { }
}

console.log('\n' + '='.repeat(52))
console.log('通过 ' + pass + ' 项 / 失败 ' + fail + ' 项')
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('✅ TTS 断连中止回归全部通过')
process.exit(0)
