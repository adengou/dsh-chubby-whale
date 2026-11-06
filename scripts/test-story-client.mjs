/**
 * scripts/test-story-client.mjs —— 说书客户端（client/story.ts 等）离线回归
 *
 * 为什么不并进 scripts/test.mjs：那一份是主人指定的门禁，本轮不许改；
 * 这里按同样的口径（esbuild 打包 + 全桩 + 离线）单独跑，随时可复跑：
 *   node scripts/test-story-client.mjs
 *
 * 覆盖：
 *   A. 封装治理：说书只经 HTTP 接口取数、只经注入的 speak/narrate 出声；
 *      全文件不 import 语音模块、不摸 window 全局、不读语音内部状态。
 *   B. 连播状态机：首段气泡/语速/叙述锁；isLast=false 自动接段、重复 onDone 不多发；
 *      isLast=true（服务端 2026-11-07 起=整本讲完）关连播 + 落盘 + 报完；连播关不接段。
 *   C. 打断（P0）：请求在途期间叙述标记已立起来（client/chat.ts 才看得见、才能打断）；
 *      被外部清锁后迟到的响应作废；停下之后「接着说」能立刻重开。
 *   D. 失败语义：超时（AbortSignal.timeout 的 TimeoutError）报「等太久」而不是「连不上」；
 *      网络错报「连不上」；30 秒兜底释放占线并作废迟到结果。
 *   E. 入口边界：连点只发一次请求、正在讲时拒绝插队、reset 的四种分支、next 失败释放占线。
 *   F. 跨书：next 换书后书名跟着换（气泡/refs.book 同步）。
 *   G. 叙述锁与叙述进度（narration.ts / narration-progress.ts）：夹紧、自愈、按字数推进、
 *      多实例互不串味、没有 localStorage 记忆（因此不存在跨数据源脏值）。
 *   H. 中止在途请求（B97 留下的边界 / B98）：停止说话、歇会儿、新一轮请求开始时真的 abort 掉
 *      在途 fetch（服务端那边的 finish 不会再把没听到的一段记成已讲）；AbortError 静默，
 *      迟到结果一律丢弃；没有 AbortController 的老浏览器退回原超时路径。
 *
 * 纯离线：不联网、不碰 dist、不写仓库（临时目录跑完删除）。
 */

import { build } from 'esbuild'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
/** 项目内临时目录：esbuild 子进程写系统临时目录会被 Windows ACL 拒（与 verify-voice 同口径） */
const TMP = join(ROOT, '.story-client-tmp')

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.error('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

// ---------- 真实定时器留底，其余替换成可手动触发的假定时器 ----------
// 说书控制器里有两条兜底定时器（请求 30s、朗读约 20s+），真跑会把脚本吊住几十秒；
// 换成假定时器后可以精确断言「到点释放占线」，也不会留垃圾进程。
const realSetTimeout = globalThis.setTimeout.bind(globalThis)
const realSetImmediate = globalThis.setImmediate.bind(globalThis)
const timers = new Map()
let timerSeq = 0
function installFakeTimers() {
  globalThis.setTimeout = (fn, ms) => {
    const id = ++timerSeq
    timers.set(id, { fn, ms: Number(ms) || 0 })
    return id
  }
  globalThis.clearTimeout = (id) => {
    if (id !== undefined && id !== null) timers.delete(id)
  }
}
function clearTimers() { timers.clear() }
function pendingMs() { return Array.from(timers.values()).map((t) => t.ms) }
/** 只触发指定时长的定时器（说书的兜底都按固定毫秒注册，可精确定位） */
function fireTimers(ms) {
  for (const [id, t] of Array.from(timers)) {
    if (t.ms !== ms) continue
    timers.delete(id)
    try { t.fn() } catch (e) { console.error('   （定时器回调抛错：' + String(e && e.message) + '）') }
  }
}
/** 等微任务与 then 链落地（用真 setImmediate，不受上面的假定时器影响） */
function flush() { return new Promise((resolve) => realSetImmediate(resolve)) }

// ---------- localStorage 桩：只用于断言连播开关有没有落盘 ----------
const store = new Map()
function installStorage() {
  globalThis.localStorage = {
    getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
    setItem: (k, v) => { store.set(String(k), String(v)) },
    removeItem: (k) => { store.delete(String(k)) },
    clear: () => store.clear(),
  }
}

// ---------- fetch 桩：按队列回包，记录每次调用的 URL/method/header ----------
// B98：加「可控在途」defer()。它返回一个一直挂着的 promise，并像真 fetch 一样监听
// init.signal —— signal 一中止就以 AbortError 拒绝。这样才测得出「停止说书有没有真掐断请求」。
const calls = []
const responses = []
function abortError() { return new DOMException('The user aborted a request.', 'AbortError') }
function installFetch() {
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    calls.push({ url: u, init: init || {} })
    const next = responses.shift()
    if (!next) throw new Error('UNEXPECTED_FETCH ' + u)
    if (next.error) throw next.error
    if (next.defer) return deferredResponse(next, init)
    return { ok: true, status: 200, json: async () => next.body }
  }
}
/** 悬着的响应：测试里手动 resolve / reject；signal 中止时按真 fetch 的脾气拒绝 */
function deferredResponse(d, init) {
  return new Promise((resolve, reject) => {
    d.done = false
    d.settle = (err, body) => {
      if (d.done) return
      d.done = true
      if (err) reject(err)
      else resolve({ ok: true, status: 200, json: async () => body })
    }
    const sig = init && init.signal
    d.signal = sig || null
    d.signalCtor = sig && sig.constructor ? sig.constructor.name : 'none'
    if (!sig) return
    const onAbort = () => {
      d.aborted = true
      d.settle(abortError())
    }
    if (sig.aborted) { onAbort(); return }
    // ignoreAbort：模拟「abort 已经太晚 / 浏览器照样把响应送达」，用来测迟到结果的丢弃
    if (!d.ignoreAbort) sig.addEventListener('abort', onAbort, { once: true })
  })
}
function defer(over = {}) {
  const d = Object.assign({
    defer: true, ignoreAbort: false, aborted: false, done: false,
    signal: null, signalCtor: 'none', settle: null,
  }, over)
  responses.push(d)
  return d
}
function resolveDeferred(d, body) { if (d.settle) d.settle(null, body) }
function reply(body) { responses.push({ body }) }
function replyError(error) { responses.push({ error }) }
function resetFetch() { calls.length = 0; responses.length = 0 }
const urls = () => calls.map((c) => c.url)
const countUrl = (part) => calls.filter((c) => c.url.indexOf(part) >= 0).length
const bubbleText = (list) => list.join(' | ')

// ---------- 宿主桩：与 client.ts 的接线同形（clearNarrate 会连叙述标记一起清） ----------
let narrateCalls = 0
let clearCalls = 0
function mkHost(over = {}) {
  const bubbles = []
  const speaks = []
  const refs = { busy: { current: false }, narrating: { current: false }, auto: { current: true }, book: { current: '' } }
  const host = {
    clientId: 'c-story-test',
    persona: { line: (key) => '人设台词:' + key },
    narrate: () => { narrateCalls++ },
    clearNarrate: () => { clearCalls++; refs.narrating.current = false },
    bubble: (t) => { bubbles.push(String(t)) },
    speak: (t, o) => { speaks.push({ text: String(t), opts: o || {} }) },
    talkFor: () => { },
    narrationRate: () => '-25%',
    isVoiceOff: () => false,
    refs,
    ...over,
  }
  return { host, refs, bubbles, speaks }
}
function resetCounters() {
  narrateCalls = 0
  clearCalls = 0
  store.clear()
}

function piece(over = {}) {
  return Object.assign({
    ok: true, book: '西游记', title: '第一回', piece: 1, total: 4,
    isFirst: true, isLast: false, text: '话说那花果山上，有一块仙石。', remain: 3,
  }, over)
}

// ---------- 打包（esbuild；不碰 dist） ----------
mkdirSync(TMP, { recursive: true })
clearTimers()
installFakeTimers()
installStorage()
installFetch()
await build({
  entryPoints: {
    story: join(ROOT, 'src/client/story.ts'),
    'narration-progress': join(ROOT, 'src/client/narration-progress.ts'),
    narration: join(ROOT, 'src/client/narration.ts'),
  },
  outdir: TMP,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2020',
  logLevel: 'silent',
})
const mod = (name) => import(pathToFileURL(join(TMP, name + '.js')).href + '?t=' + Date.now())
const storyMod = await mod('story')
const progressMod = await mod('narration-progress')
const narrationMod = await mod('narration')
const { createStoryController } = storyMod

// ---------- A. 封装治理 ----------
console.log('\n[A] 封装治理：只经接口取数、只经入口出声')
const src = readFileSync(join(ROOT, 'src/client/story.ts'), 'utf8')
ok('说书不直接 import 语音实现（只经注入的 speak/narrate）',
  !/from\s+'\.\/voice(\.js)?'/.test(src) && !/from\s+'\.\/voice-bridge/.test(src) && !/from\s+'\.\/voice\//.test(src))
ok('说书不读语音内部状态（不摸 window.__chubbyWhale / 不碰 voice 实例）',
  src.indexOf('__chubbyWhale') < 0 && !/\bgetVoice\b|\.voiceName\(/.test(src))
{
  const keys = Array.from(src.matchAll(/localStorage\.(?:get|set|remove)Item\(\s*'([^']+)'/g)).map((m) => m[1])
  ok('说书只碰连播开关这一个存储键（不存进度/不存书号）',
    keys.every((k) => k === 'chubby-story-auto'), keys.join(',') || '（无）')
}
{
  clearTimers(); resetFetch(); resetCounters()
  const h = mkHost()
  const story = createStoryController(h.host)
  reply(piece())
  story.start('西游记')
  await flush()
  const c = calls[0]
  ok('开讲走 GET /story/start（不是 POST，不改服务端方法约定）',
    c && String(c.init.method || 'GET') === 'GET' && c.url.indexOf('/api/chubby-whale/story/start') === 0, c && c.url)
  ok('开讲带 book 与 hint 两个参数（服务端二者都认）',
    c && c.url.indexOf('?book=' + encodeURIComponent('西游记')) > 0 && c.url.indexOf('&hint=' + encodeURIComponent('西游记')) > 0, c && c.url)
  ok('开讲带 x-client-id（服务端按标签页分连播队列）',
    !!(c && c.init.headers && c.init.headers['x-client-id'] === 'c-story-test'))

  h.speaks[0].opts.onDone()
  await flush()
  const n = calls[1]
  ok('接段走 GET /story/next', n && String(n.init.method || 'GET') === 'GET' && /\/story\/next$/.test(n.url), n && n.url)
}
{
  clearTimers(); resetFetch(); resetCounters()
  const h = mkHost()
  const story = createStoryController(h.host)
  h.refs.book.current = '西游记'
  reply({ ok: true, book: '西游记' })
  story.reset()
  await flush()
  const c = calls[0]
  ok('从头讲用 POST /story/reset（状态变更不走 GET）',
    c && String(c.init.method || '') === 'POST' && c.url.indexOf('/story/reset?book=' + encodeURIComponent('西游记')) > 0, c && c.url)
  ok('reset 不带请求体（书名走 query，服务端两种都兼容）', !!(c && c.init.body === undefined))
}

// ---------- B. 首段：气泡 / 语速 / 叙述锁 ----------
console.log('\n[B] 连播状态机：首段与 isLast 语义')
{
  clearTimers(); resetFetch(); resetCounters()
  const h = mkHost()
  const story = createStoryController(h.host)
  reply(piece())
  story.start('西游记')
  await flush()
  ok('首段气泡标书名、回目与「第几段」', h.bubbles[0] === '正在讲《西游记》｜第一回（第 1/4 段）', h.bubbles[0])
  ok('上叙述锁（speak 之前就锁麦克风）', narrateCalls === 1 && h.refs.narrating.current === true && h.refs.busy.current === true)
  ok('说书语速取前端常量 -35%（不读服务端 rate 字段）',
    h.speaks.length === 1 && h.speaks[0].opts.rate === '-35%', String(h.speaks[0] && h.speaks[0].opts.rate))
  ok('正文原样交给朗读（不截断、不改写）', h.speaks[0].text === '话说那花果山上，有一块仙石。', h.speaks[0].text)
  ok('记住最近书名（「从头讲」要按它重置）', h.refs.book.current === '西游记')
}

// ---------- C. isLast=false → 自动接段；重复 onDone 不多发 ----------
{
  clearTimers(); resetFetch(); resetCounters()
  const h = mkHost()
  const story = createStoryController(h.host)
  reply(piece())
  story.start('')
  await flush()
  const done0 = h.speaks[0].opts.onDone
  reply(piece({ piece: 2, isFirst: false, title: '第一回', text: '第二段正文。' }))
  done0()
  await flush()
  ok('isLast=false + 连播开：自动请求下一段（只一次）', countUrl('/story/next') === 1, urls().join(','))
  ok('自动接段后继续念第二段', h.speaks.length === 2 && h.speaks[1].text === '第二段正文。')
  ok('段间给一句「接着往后讲」', h.bubbles.some((b) => b.indexOf('接着往后讲') >= 0), bubbleText(h.bubbles))
  ok('新段气泡换成 2/4', h.bubbles.some((b) => b.indexOf('（第 2/4 段）') >= 0), bubbleText(h.bubbles))
  done0()   // 旧段的 onDone 迟到（代际已作废）
  await flush()
  ok('旧 onDone 迟到不会重复接段', countUrl('/story/next') === 1, urls().join(','))
}

// ---------- D. isLast=true（整本讲完）→ 关连播 + 落盘 + 报完 ----------
{
  clearTimers(); resetFetch(); resetCounters()
  const h = mkHost()
  const story = createStoryController(h.host)
  story.playPiece(piece({ book: '聊斋', title: '画皮', piece: 2, total: 2, isLast: true, text: '讲完了的正文。' }))
  h.speaks[0].opts.onDone()
  await flush()
  ok('整本讲完：不再自动接段', calls.length === 0, urls().join(','))
  ok('整本讲完：关掉连播', h.refs.auto.current === false)
  ok('整本讲完：连播开关同步落盘（菜单读 localStorage，否则还显示「开」）',
    store.get('chubby-story-auto') === '0', String(store.get('chubby-story-auto')))
  ok('整本讲完：报「讲完」并说明怎么接着听',
    h.bubbles.some((b) => b.indexOf('讲完') >= 0 && b.indexOf('接着说') >= 0), bubbleText(h.bubbles))
  ok('整本讲完：占线与叙述标记都放开（不会卡在「正在说书」）',
    h.refs.busy.current === false && h.refs.narrating.current === false && clearCalls > 0)
}

// ---------- E. 连播关 / isLast 缺失 ----------
{
  clearTimers(); resetFetch(); resetCounters()
  const h = mkHost()
  h.refs.auto.current = false
  const story = createStoryController(h.host)
  story.playPiece(piece({ text: '单段正文。' }))
  h.speaks[0].opts.onDone()
  await flush()
  ok('连播关 + isLast=false：不自动接段', calls.length === 0, urls().join(','))
  ok('连播关：提示点菜单「接着说」', h.bubbles.some((b) => b.indexOf('点菜单「接着说」') >= 0), bubbleText(h.bubbles))
  ok('连播关：不会偷偷把连播打开', h.refs.auto.current === false)
}
{
  clearTimers(); resetFetch(); resetCounters()
  const h = mkHost()
  const story = createStoryController(h.host)
  story.playPiece({ book: '西游记', title: '某回', text: '缺字段的响应。' })   // 故意不给 isLast
  h.speaks[0].opts.onDone()
  await flush()
  ok('isLast 缺失（老宿主/坏响应）按「讲完」处理：不无限自动连播', calls.length === 0 && h.refs.auto.current === false, urls().join(','))
}

// ---------- F. 打断（P0）：请求在途也要亮叙述标记 ----------
console.log('\n[C] 打断与失败语义')
{
  clearTimers(); resetFetch(); resetCounters()
  const h = mkHost()
  const story = createStoryController(h.host)
  reply(piece())
  story.start('西游记')
  // 请求已发出、响应还没被消费：此刻 client/chat.ts 只看 narrating || ttsPlaying
  ok('请求在途期间叙述标记已立起来（P0 才有把手打断这一轮）',
    calls.length === 1 && h.refs.busy.current === true && h.refs.narrating.current === true)
  // 模拟 P0：client/chat.ts 先 stopTts（清两把锁）再回答
  h.refs.busy.current = false
  h.refs.narrating.current = false
  await flush()
  ok('P0 打断后迟到的响应作废：不念、不再接段',
    h.speaks.length === 0 && h.bubbles.every((b) => b.indexOf('正在讲') < 0), bubbleText(h.bubbles))
  ok('P0 打断后占线是干净的（不卡「正讲着呢」）', h.refs.busy.current === false && h.refs.narrating.current === false)
  // 打断之后「接着说」必须立刻能用
  reply(piece({ text: '重新开讲。' }))
  story.start('西游记')
  await flush()
  ok('打断后「接着说」能立刻重开（没被卡住）',
    calls.length === 2 && h.speaks.length === 1 && h.speaks[0].text === '重新开讲。', urls().join(','))
}
{
  clearTimers(); resetFetch(); resetCounters()
  const h = mkHost()
  const story = createStoryController(h.host)
  replyError(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
  story.start('')
  await flush()
  ok('超时（AbortSignal.timeout 的 TimeoutError）报「等太久」而不是「连不上」',
    h.bubbles.some((b) => b.indexOf('等太久') >= 0), bubbleText(h.bubbles))
  ok('超时不误报网络故障', !h.bubbles.some((b) => b.indexOf('连不上') >= 0), bubbleText(h.bubbles))
  ok('超时后占线释放', h.refs.busy.current === false && h.refs.narrating.current === false)
}
{
  clearTimers(); resetFetch(); resetCounters()
  const h = mkHost()
  const story = createStoryController(h.host)
  replyError(new TypeError('fetch failed'))
  story.start('')
  await flush()
  ok('网络错报「连不上」', h.bubbles.some((b) => b.indexOf('连不上') >= 0), bubbleText(h.bubbles))
  ok('网络错后占线释放', h.refs.busy.current === false && h.refs.narrating.current === false)
}
{
  clearTimers(); resetFetch(); resetCounters()
  const h = mkHost()
  const story = createStoryController(h.host)
  reply(piece({ text: '迟到的一段。' }))
  story.start('')
  ok('请求带了 30 秒兜底定时器', pendingMs().indexOf(30000) >= 0, pendingMs().join(','))
  fireTimers(30000)
  ok('兜底到点：释放占线并提示', h.refs.busy.current === false && h.refs.narrating.current === false
    && h.bubbles.some((b) => b.indexOf('等太久') >= 0), bubbleText(h.bubbles))
  await flush()
  ok('兜底之后迟到的响应被丢弃（不念出来）', h.speaks.length === 0)
}

// ---------- G. 入口边界：连点 / 插队 / reset / next 失败 ----------
console.log('\n[D] 入口边界：连点、插队、reset、失败')
{
  clearTimers(); resetFetch(); resetCounters()
  const h = mkHost()
  const story = createStoryController(h.host)
  reply(piece())
  story.start('聊斋')
  story.start('聊斋')
  await flush()
  ok('连点两次开讲只发一个请求（同步占线）', calls.length === 1, urls().join(','))
  ok('第二下被挡时给一句「正讲着呢」', h.bubbles.some((b) => b.indexOf('正讲着呢') >= 0), bubbleText(h.bubbles))
  const before = calls.length
  story.next()
  ok('正在讲时「接着说」不插队', calls.length === before, urls().join(','))
}
{
  clearTimers(); resetFetch(); resetCounters()
  const h = mkHost()
  const story = createStoryController(h.host)
  story.reset()
  ok('没讲过书时 reset 不发请求', calls.length === 0 && h.bubbles.some((b) => b.indexOf('还没讲书') >= 0), bubbleText(h.bubbles))
}
{
  clearTimers(); resetFetch(); resetCounters()
  const h = mkHost()
  const story = createStoryController(h.host)
  h.refs.book.current = '西游记'
  h.refs.busy.current = true
  story.reset()
  ok('正在讲时 reset 被拒（免得清掉正在念的进度）', calls.length === 0 && h.bubbles.some((b) => b.indexOf('歇会儿') >= 0), bubbleText(h.bubbles))
}
{
  clearTimers(); resetFetch(); resetCounters()
  const h = mkHost()
  const story = createStoryController(h.host)
  h.refs.book.current = '不存在的书'
  reply({ ok: false, error: 'unknown book' })
  story.reset()
  await flush()
  ok('reset 失败给中文提示（book 不在书单）',
    h.bubbles.some((b) => b.indexOf('书单里没有这本') >= 0) && h.refs.busy.current === false, bubbleText(h.bubbles))
}
{
  clearTimers(); resetFetch(); resetCounters()
  const h = mkHost()
  const story = createStoryController(h.host)
  reply({ ok: false, error: 'no readable book' })
  story.next()
  await flush()
  ok('接段失败给中文提示并释放占线',
    h.bubbles.some((b) => b.indexOf('书都读不出来') >= 0) && h.refs.busy.current === false, bubbleText(h.bubbles))
}
{
  clearTimers(); resetFetch(); resetCounters()
  const h = mkHost()
  const story = createStoryController(h.host)
  reply({ ok: false, error: 'no books' })
  story.start('')
  await flush()
  ok('空书单给中文提示', h.bubbles.some((b) => b.indexOf('书单是空的') >= 0), bubbleText(h.bubbles))
}

// ---------- H. 跨书：换书后书名跟着换 ----------
{
  clearTimers(); resetFetch(); resetCounters()
  const h = mkHost()
  const story = createStoryController(h.host)
  reply(piece({ book: '聊斋', title: '画皮', piece: 1, total: 2, text: '聊斋第一段。' }))
  story.start('聊斋')
  await flush()
  reply(piece({ book: '西游记', title: '第一回', piece: 1, total: 4, isFirst: true, text: '跨到西游。' }))
  h.speaks[0].opts.onDone()
  await flush()
  ok('换书后最近书名跟着换（「从头讲」不会指回旧书）', h.refs.book.current === '西游记', h.refs.book.current)
  ok('换书后气泡显示新书', h.bubbles.some((b) => b.indexOf('正在讲《西游记》') >= 0), bubbleText(h.bubbles))
}

// ---------- J. 中止在途请求（B98）：停止说书要真的掐断 fetch ----------
// 背景：服务端已改为「响应送出后才把该段记为已讲」。客户端只清 busy 不 abort 的话，
// 响应照样送达 → 服务端 finish → 主人根本没听的那一段被记成已讲。这里逐条钉住。
console.log('\n[F] 中止在途请求（B98）：停止说书要真的掐断 fetch')
{
  clearTimers(); resetFetch(); resetCounters()
  const h = mkHost()
  const story = createStoryController(h.host)
  const d = defer()
  story.start('西游记')
  await flush()
  ok('可控桩：请求挂着没落地（这才有「在途」可中止）', d.done === false && calls.length === 1, urls().join(','))
  ok('在途请求带着可主动中止的 AbortSignal', !!d.signal && d.signal.aborted === false && d.signalCtor === 'AbortSignal')
  story.next()
  ok('正在讲时的「接着说」被挡下，且不误伤在途请求',
    calls.length === 1 && d.done === false && d.aborted === false, bubbleText(h.bubbles))
  // 「停止说话 / 歇会儿」：client.ts 的 stopTts() 现在会先 story.abort()，再清 busy + narrating
  story.abort()
  h.refs.busy.current = false
  h.refs.narrating.current = false
  await flush()
  ok('停止之后在途请求真的被 abort（不是干等 25 秒超时）',
    d.signal.aborted === true && d.aborted === true && d.done === true)
  ok('AbortError 按「用户主动停」处理：不报「连不上」也不报「等太久」',
    !h.bubbles.some((b) => b.indexOf('连不上') >= 0 || b.indexOf('等太久') >= 0), bubbleText(h.bubbles))
  ok('停止之后不冒新段、状态干净（不算失败）',
    h.speaks.length === 0 && h.refs.busy.current === false && h.refs.narrating.current === false)
  reply(piece({ text: '停止后重新开讲。' }))
  story.start('西游记')
  await flush()
  ok('停止后「接着说」立刻能重开（没被 abort 逻辑卡住）',
    calls.length === 2 && h.speaks.length === 1 && h.speaks[0].text === '停止后重新开讲。', urls().join(','))
}
{
  clearTimers(); resetFetch(); resetCounters()
  const h = mkHost()
  const story = createStoryController(h.host)
  const d = defer()
  story.start('')
  await flush()
  // 2026-11-07 B98 收尾：中止改成显式调用（client.ts stopTts() → story.abort()），
  // 不再靠包 busy.current 的写。所以「只清 busy」本身**不再**中止——这是有意的契约，
  // 停口路径必须走 stopTts()（菜单 pause / tts-stop 本来就会先调 host.stopSpeak()）。
  h.refs.busy.current = false
  await flush()
  ok('只清 busy 不再隐式中止（契约：停口必须走 stopTts → story.abort()）',
    d.aborted === false && d.signal.aborted === false, 'aborted=' + d.aborted)
  story.abort()
  await flush()
  ok('显式 story.abort() 才中止在途请求',
    d.aborted === true && d.signal.aborted === true, 'aborted=' + d.aborted + ' signal=' + d.signal.aborted)
}
{
  // client.ts 每次渲染都会 createStoryController：在途状态必须按 refs 共享，
  // 这样「渲染 2 发的请求」也能被任何一次 stopTts()（挂在最新实例上）中止。
  clearTimers(); resetFetch(); resetCounters()
  const h = mkHost()
  const first = createStoryController(h.host)   // 渲染 1
  const second = createStoryController(h.host)  // 渲染 2：真正发请求的实例
  const d = defer()
  second.start('')
  await flush()
  first.abort()                                 // 停止走的是最新实例，但共享同一份在途状态
  await flush()
  ok('重渲染重建控制器后，abort 仍能掐断在途请求（共享状态按 refs 找回本轮）',
    d.aborted === true && d.signal.aborted === true, 'aborted=' + d.aborted)
  ok('重渲染后停止同样静默（不弹失败、不念旧段）',
    h.speaks.length === 0 && !h.bubbles.some((b) => b.indexOf('连不上') >= 0 || b.indexOf('等太久') >= 0),
    bubbleText(h.bubbles))
}
{
  clearTimers(); resetFetch(); resetCounters()
  const h = mkHost()
  const story = createStoryController(h.host)
  const d = defer({ ignoreAbort: true })   // 模拟 abort 太晚 / 浏览器照样把响应送达
  story.start('')
  await flush()
  story.abort()
  h.refs.busy.current = false
  h.refs.narrating.current = false
  await flush()
  ok('停止时确实对 signal 发了 abort（握手已断）', d.signal.aborted === true)
  resolveDeferred(d, piece({ text: '停止之后才到的正文。' }))
  await flush()
  ok('abort 之后迟到的响应被丢弃：不念、不弹错',
    h.speaks.length === 0 && !h.bubbles.some((b) => b.indexOf('连不上') >= 0 || b.indexOf('等太久') >= 0),
    bubbleText(h.bubbles))
  ok('迟到的响应不会把占线重新拉起来', h.refs.busy.current === false && h.refs.narrating.current === false)
}
{
  clearTimers(); resetFetch(); resetCounters()
  const h = mkHost()
  const story = createStoryController(h.host)
  const old = defer({ ignoreAbort: true })
  story.start('')
  await flush()
  story.abort()
  h.refs.busy.current = false
  h.refs.narrating.current = false
  await flush()
  const fresh = defer()
  story.start('')                 // 新一轮请求开始
  await flush()
  ok('新一轮请求用自己的 signal（不复用旧的那条）', fresh.signal !== old.signal && fresh.signal.aborted === false)
  resolveDeferred(old, piece({ text: '旧一轮迟到的正文。' }))
  await flush()
  ok('旧请求迟到：不念旧段、不抢新一轮的占线',
    h.speaks.length === 0 && h.refs.busy.current === true && h.refs.narrating.current === true, bubbleText(h.bubbles))
  resolveDeferred(fresh, piece({ text: '新一轮的正文。' }))
  await flush()
  ok('新一轮照常开念（未被旧的 AbortError 干扰）',
    h.speaks.length === 1 && h.speaks[0].text === '新一轮的正文。', h.speaks.map((s) => s.text).join(','))
}
{
  // 25 秒超时：原来是「超时信号只挂在 fetch 上」，现在要变成「到点真的 abort 本次请求」，
  // 但主人看到的文案仍是「等太久」而不是「连不上」。
  clearTimers(); resetFetch(); resetCounters()
  const h = mkHost()
  const story = createStoryController(h.host)
  const realTimeout = AbortSignal.timeout
  let fake = null
  try {
    AbortSignal.timeout = (ms) => { fake = new AbortController(); fake.ms = ms; return fake.signal }
    const d = defer()
    story.start('')
    await flush()
    ok('超时阈值仍是 REQUEST_TIMEOUT_MS（25 秒）', fake && fake.ms === 25000, String(fake && fake.ms))
    fake.abort()                  // 模拟 25 秒到点
    await flush()
    ok('超时到点真的掐断在途请求（不再等 30 秒兜底）',
      d.aborted === true && d.signal.aborted === true, 'aborted=' + d.aborted)
    ok('超时仍报「等太久」而不是「连不上」',
      h.bubbles.some((b) => b.indexOf('等太久') >= 0) && !h.bubbles.some((b) => b.indexOf('连不上') >= 0),
      bubbleText(h.bubbles))
    ok('超时后占线释放', h.refs.busy.current === false && h.refs.narrating.current === false)
  } finally {
    AbortSignal.timeout = realTimeout
  }
}
{
  // iOS Safari 12.2 以下没有 AbortController：必须退回原来的「只靠超时 signal + 30 秒兜底」路径，
  // 不能抛错、不能说书讲不了。
  clearTimers(); resetFetch(); resetCounters()
  const h = mkHost()
  const story = createStoryController(h.host)
  const realAC = globalThis.AbortController
  try {
    globalThis.AbortController = undefined
    reply(piece({ text: '没有 AbortController 也要能讲。' }))
    story.start('')
    await flush()
    ok('没有 AbortController 的老浏览器仍能正常说书（退回原超时路径）',
      h.speaks.length === 1 && h.speaks[0].text === '没有 AbortController 也要能讲。'
      && !h.bubbles.some((b) => b.indexOf('连不上') >= 0), bubbleText(h.bubbles))
  } finally {
    globalThis.AbortController = realAC
  }
}

// ---------- I. 叙述锁（narration.ts）：夹紧与自愈 ----------
console.log('\n[E] 叙述锁与叙述进度')
{
  const lock = narrationMod.createNarrationLock()
  ok('未上锁时 active=false、remaining=0', lock.active() === false && lock.remaining() === 0)
  lock.lock(60000)
  ok('上锁后 active=true', lock.active() === true)
  ok('剩余时长约等于请求值', Math.abs(lock.remaining() - 60000) < 50, String(lock.remaining()))
  lock.clear()
  ok('clear 之后不再 active', lock.active() === false && lock.remaining() === 0)
  lock.lock(1)
  ok('过短的锁夹紧到下限 8 秒', lock.remaining() > 7000, String(lock.remaining()))
  lock.lock(1e9)
  ok('过长的锁夹紧到上限 5 分钟', lock.remaining() <= 5 * 60 * 1000, String(lock.remaining()))
  lock.lock(Number.NaN)
  ok('非法时长按 60 秒兜底', Math.abs(lock.remaining() - 60000) < 50, String(lock.remaining()))
  const future = Date.now() + 10 * 60 * 1000
  ok('到点自愈：过期返回 true 并清锁', lock.expire(future) === true && lock.active() === false)
  ok('没过期时 expire 不动锁', (lock.lock(60000), lock.expire(Date.now()) === false && lock.active() === true))
  lock.clear()
  ok('导出常量是冻结的数（外部改不了阈值）',
    narrationMod.NARRATE_MIN_MS === 8000 && narrationMod.NARRATE_MAX_MS === 5 * 60 * 1000)
}

// ---------- J. 叙述进度（narration-progress.ts）：按字数推进、多实例隔离 ----------
{
  const p = progressMod.createProgress()
  ok('未开始时不 active、index=0', p.active() === false && p.index() === 0)
  ok('未开始时 bump 返回空串（说书/普通叙述不显示进度）', p.bump('随便一段') === '')
  p.start('念诗·雨霖铃', ['寒蝉凄切', '对长亭晚'], '念首诗——雨霖铃，宋，柳永。')
  ok('开场白阶段还不算第 1 句', p.index() === 0)
  const b1 = p.bump('念首诗——雨霖铃，宋，柳永。')
  ok('念开场白时气泡是纯标签', b1 === '念诗·雨霖铃：念首诗——雨霖铃，宋，柳永。', b1)
  ok('开场白念完进入第 1 句', p.index() === 1)
  const b2 = p.bump('寒蝉凄切')
  ok('第 1 句气泡带「第 1/2 句」', b2.indexOf('（第 1/2 句）') > 0 && b2.indexOf('寒蝉凄切') > 0, b2)
  ok('第 1 句念完进入第 2 句', p.index() === 2)
  const b3 = p.bump('对长亭晚')
  ok('最后一句气泡带「第 2/2 句」', b3.indexOf('（第 2/2 句）') > 0, b3)
  ok('念到末尾不会越界', p.index() === 2)
  p.stop()
  ok('stop 之后不再 active，也不残留进度', p.active() === false && p.index() === 0)
  const dirty = progressMod.createProgress()
  dirty.start('', ['   ', ''], '')
  ok('全是空白的诗句行被忽略（不会算成一句）', dirty.index() === 0 && dirty.bump('正文') === '：正文', JSON.stringify(dirty.bump('正文')))
  dirty.stop()
  const a = progressMod.createProgress()
  const b = progressMod.createProgress()
  a.start('A', ['一'], '')
  ok('多实例互不串味（测试/多面板可各用一份）', b.active() === false && a.active() === true)
  a.stop()
  ok('默认实例导出的是函数（老调用方不受影响）',
    typeof progressMod.startProgress === 'function' && typeof progressMod.bumpProgress === 'function')
  ok('叙述进度没有 localStorage 记忆（因此不存在跨数据源脏值）',
    readFileSync(join(ROOT, 'src/client/narration-progress.ts'), 'utf8').indexOf('localStorage') < 0)
}

// ---------- 收尾 ----------
try { rmSync(TMP, { recursive: true, force: true }) } catch (e) { }
const total = pass + fail
console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有失败') + '：' + pass + '/' + total + ' 项')
process.exitCode = fail === 0 ? 0 : 1
