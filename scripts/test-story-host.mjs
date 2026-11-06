/**
 * scripts/test-story-host.mjs —— 说书宿主链路回归（路由运行时 + 播放器状态机 + 数据边界）
 *
 * 为什么单独一个文件：
 *   · test-story-security.mjs 只做**静态**断言（源码里有清洗/有 405），没有真跑 handler；
 *   · test-story-player.mjs 覆盖选段/进度/分段，但**没有覆盖路由层**（400/405/413/200+ok:false）
 *     与「并发 start」「reset 后重播」这类状态机时序。
 * 本脚本补这两块，不并入 npm test 的脚本表（package.json 不动），用 node 直接跑。
 *
 * 覆盖：
 *   A. 封装治理（静态）：routes/story.ts 不得直连文件系统/仓储/缓存，只经注入的 player 端口；
 *   B. /story/books：GET 正常、非 GET 405+Allow、no-store、端口抛错回 ok:false 且 books 兜底；
 *   C. /story/start：hint/book 别名与优先级、trim、路径穿越/控制字符/超长一律 400 且**不调端口**，
 *      x-client-id 清洗，业务失败 200+ok:false（项目既有约定），意外异常回 ok:false；
 *   D. /story/next：方法白名单、业务失败透传；
 *   E. /story/reset：只 POST、query 优先于 body、坏 JSON 退化为空体、4KB 上限（声明/流式都 413）、
 *      非法书名 400、未知书 200+ok:false；
 *   F. 参数面：说书接口不吃 rate/pitch/volume，chunk.rate 是服务端常量（客户端传值不生效）；
 *   G. 播放器状态机：并发 start 不重复选段、并发多客户端各拿一段、reset 后重播、单章书/空书边界、
 *      进度文件坏/缺、队列上限、index 不连续；
 *   H. 真实宿主链路（真实 17 本书 + Worker）：书单、合辑书书名投影、reset、回内分段与回末句、全库冷读；
 *   I. 仓储失败面：越界书名、坏 JSON、Worker 抛错/exit(1) 都要秒级回空（不留 20s 定时器）、日志纪律。
 *   K. 进度次序（B97）：只认「响应真的送出去」——finish 才确认，断开/res.end 抛错则撤销，断开后重讲还是这一段。
 *
 * BOM 书文件（2026-11-07 修复）：worker 已剥 UTF-8 BOM，断言见 [J] 段；
 * 纯离线：不联网、不起 HTTP、进度文件全在临时目录，跑完清理。
 * 用法：node scripts/test-story-host.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { register } from 'node:module'

// 源码里的跨模块导入写的是 .js（构建产物口径），测试直接加载 .ts 需要同一个解析钩子
register(new URL('./ts-resolve.mjs', import.meta.url))

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.error('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}
function info(msg) { console.log('  · ' + msg) }

/**
 * 收走仓储的失败日志（STORY-LOAD-FAIL / STORY-INDEX-FAIL）：
 *   ① 负向用例故意读坏书/坏名，别让 stderr 变成一串红字（cmd /c 下还会让退出码看起来是 1）；
 *   ② 顺手断言这些日志本身的纪律：只记一条、名字截断、不带换行（防伪造日志行）。
 * 只拦这两个标签，其它 console.error（包括 ok() 的 ❌）照常打出来。
 */
const repoLogs = []
{
  const realError = console.error.bind(console)
  console.error = function (...args) {
    const line = args.map((a) => String(a)).join(' ')
    if (/^(STORY-LOAD-FAIL|STORY-INDEX-FAIL)\b/.test(line)) { repoLogs.push(line); return }
    realError(...args)
  }
}

const { createStoryHandlers } = await import('../src/host/routes/story.ts')
const { createStoryPlayer } = await import('../src/host/story/player.ts')

const TMP = mkdtempSync(join(tmpdir(), 'whale-story-host-'))
let seq = 0
function progressFile(seed) {
  seq++
  const p = join(TMP, 'progress-' + seq + '.json')
  if (seed !== undefined) writeFileSync(p, typeof seed === 'string' ? seed : JSON.stringify(seed))
  return p
}
const readProgress = (p) => JSON.parse(readFileSync(p, 'utf8'))


// ───────────────────────── 请求/响应假件 ─────────────────────────
/**
 * 假响应：只实现 sendJson / sendTooLarge 用到的面（setHeader / writeHead / end / headersSent / writableEnded），
 * 外加进度次序用到的 finish/close/error 事件面（B97：路由要等「响应真的送出去」才 confirm 进度）。
 *   · 默认 end() 时立刻 finish（writableFinished=true）：等价于真实响应正常写完；
 *   · opts.autoFinish=false：end() 只把 writableEnded 置真，finish/close 由用例自己 emit；
 *   · opts.throwOnEnd：end() 直接抛错（模拟 res.end 抛错/连接已断）。
 * 记录状态码、响应头（小写键）与响应体字符串。
 */
function makeRes(opts = {}) {
  const listeners = new Map()
  const res = {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
    on(ev, fn) {
      if (typeof fn === 'function') {
        if (!listeners.has(ev)) listeners.set(ev, [])
        listeners.get(ev).push(fn)
      }
      return this
    },
    removeListener(ev, fn) {
      const arr = listeners.get(ev)
      if (!arr) return this
      const i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
      return this
    },
    emit(ev) {
      for (const fn of (listeners.get(ev) || []).slice()) fn()
      return this
    },
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v },
    writeHead(status, headers) {
      this.status = status
      this.headersSent = true
      for (const k of Object.keys(headers || {})) this.headers[k.toLowerCase()] = headers[k]
    },
    end(body) {
      if (opts.throwOnEnd) throw new Error('client-gone')
      this.body = body == null ? '' : String(body)
      this.writableEnded = true
      if (opts.autoFinish !== false) {
        this.writableFinished = true
        this.emit('finish')
      }
    },
    json() { try { return JSON.parse(this.body) } catch { return null } },
  }
  return res
}

/**
 * 假请求：Readable 的最小替身（readBody 只做 for await），
 * body 只有显式给了才挂 async iterator；content-length 默认按 body 字节数声明。
 */
function makeReq(opts = {}) {
  const method = opts.method || 'GET'
  const url = opts.url || '/'
  const headers = Object.assign({}, opts.headers || {})
  const req = { method, url, headers }
  if (opts.body !== undefined) {
    const buf = Buffer.from(opts.body)
    if (!('content-length' in headers) && opts.declare !== false) headers['content-length'] = String(buf.length)
    req[Symbol.asyncIterator] = async function* () { yield buf }
    req.on = () => { }
    req.destroy = () => { }
    req.resume = () => { }
  }
  return req
}

async function call(handler, req, res) {
  try { await handler(req, res) } catch (err) { res.threw = err }
  return res
}

/** 端口替身：记录调用，可注入返回值/抛错 */
function fakePlayer(over = {}) {
  const calls = { books: 0, start: [], next: [], reset: [], confirm: [], discard: [] }
  const chunk = (i) => ({
    book: '甲书', title: '第一回', piece: 1, total: 4, isFirst: true, isLast: false,
    text: '话说……', rate: '-30%', index: i,
  })
  const served = (i) => ({ book: '甲书', index: i })
  return {
    calls,
    books: async () => { calls.books++; if (over.booksThrow) throw new Error('boom-books'); return over.books || ['甲书', '乙书'] },
    start: async (hint, id) => {
      calls.start.push({ hint, id })
      if (over.startThrow) throw new Error('boom-start')
      if (over.start) return over.start(hint, id)
      return { ok: true, chunk: chunk(0), remain: 3, served: served(0) }
    },
    next: async (id) => {
      calls.next.push({ id })
      if (over.nextThrow) throw new Error('boom-next')
      if (over.next) return over.next(id)
      return { ok: true, chunk: chunk(1), remain: 2, served: served(1) }
    },
    reset: async (book, id) => {
      calls.reset.push({ book, id })
      if (over.resetThrow) throw new Error('boom-reset')
      if (over.reset) return over.reset(book, id)
      return { ok: true, book }
    },
    // B97：路由在响应送出后 confirm / 没送出时 discard
    confirm: (book, index) => {
      calls.confirm.push({ book, index })
      if (over.confirmThrow) throw new Error('boom-confirm')
      return over.confirm ? over.confirm(book, index) : true
    },
    discard: (book, index) => {
      calls.discard.push({ book, index })
      return over.discard ? over.discard(book, index) : true
    },
  }
}

const handlersOf = (player) => createStoryHandlers({ player })


// ---------- A. 封装治理（静态）----------
console.log('\n[A] 封装治理：路由只经注入端口')
try {
  const route = readFileSync(join(ROOT, 'src/host/routes/story.ts'), 'utf8')
  ok('不 import node:fs / node:path', !/from\s+['"]node:(fs|path|fs\/promises)['"]/.test(route))
  ok('不直连仓储/缓存/prefs/store', !/from\s+['"]\.\.\/(repos|store|cache|prefs|data)\//.test(route))
  ok('播放器只以 type 形式引入（不拿实现）', /import\s+type\s+\{[^}]*StoryPlayer[^}]*\}\s+from\s+['"]\.\.\/story\/player\.js['"]/.test(route))
  ok('无 readFileSync/readdir/JSON.parse 之类直读', !/\breadFileSync\b|\breaddir\b|\breadFile\b/.test(route))
  const src = readFileSync(join(ROOT, 'src/host/routes/story.ts'), 'utf8')
  // 2026-11-07 B97：值级兼容导出已删（薄路由不该携带播放器业务数据）
  ok('routes/story.ts 不再值级导出 STORY_AUTHORS', !/export\s*\{\s*STORY_AUTHORS\s*\}/.test(src))
} catch (e) {
  ok('封装治理静态检查执行', false, String(e && e.message))
}


// ---------- B. /story/books ----------
console.log('\n[B] GET /story/books')
try {
  const p = fakePlayer()
  const h = handlersOf(p)
  const r1 = await call(h.handleBooks, makeReq({ url: '/story/books' }), makeRes())
  ok('GET 回 200 + ok:true + 书单', r1.status === 200 && r1.json().ok === true && r1.json().books.length === 2,
    r1.body)
  ok('带 no-store', r1.headers['cache-control'] === 'no-store')
  const r2 = await call(h.handleBooks, makeReq({ method: 'POST', url: '/story/books' }), makeRes())
  ok('POST → 405 + Allow: GET', r2.status === 405 && r2.headers.allow === 'GET' && r2.json().ok === false, r2.body)
  ok('405 也带 no-store', r2.headers['cache-control'] === 'no-store')
  const p3 = fakePlayer({ booksThrow: true })
  const r3 = await call(handlersOf(p3).handleBooks, makeReq({ url: '/story/books' }), makeRes())
  ok('端口抛错 → 200 + ok:false + books:[] 兜底', r3.status === 200 && r3.json().ok === false &&
    Array.isArray(r3.json().books) && r3.json().books.length === 0, r3.body)
} catch (e) {
  ok('books 断言执行', false, String(e && e.message))
}


// ---------- C. /story/start ----------
console.log('\n[C] GET /story/start（书名/提示词清洗）')
const badBooks = [
  ['上跳 ..', '..'],
  ['上跳 ../x', '../x'],
  ['上跳 ..\\x', '..\\x'],
  ['绝对路径 /etc/passwd', '/etc/passwd'],
  ['Windows 盘符 C:\\Windows\\win.ini', 'C:\\Windows\\win.ini'],
  ['UNC \\\\srv\\share\\x', '\\\\srv\\share\\x'],
  ['NUL 字符', '三国\u0000演义'],
  ['控制字符 0x01', '三国\u0001演义'],
  ['DEL 0x7F', '三国\u007f演义'],
  ['换行', '三国\n演义'],
  ['超长 65', 'x'.repeat(65)],
]
try {
  for (const [name, value] of badBooks) {
    const p = fakePlayer()
    const r = await call(handlersOf(p).handleStoryStart,
      makeReq({ url: '/story/start?book=' + encodeURIComponent(value) }), makeRes())
    ok(name + ' → 400 bad book 且不调端口',
      r.status === 400 && r.json().ok === false && r.json().error === 'bad book' && p.calls.start.length === 0, r.body)
  }
  // URL 编码过的穿越片段（searchParams 解回 ..）
  {
    const p = fakePlayer()
    const r = await call(handlersOf(p).handleStoryStart, makeReq({ url: '/story/start?hint=%2e%2e%2fsecret' }), makeRes())
    ok('%2e%2e%2fsecret → 400 不调端口', r.status === 400 && p.calls.start.length === 0, r.body)
  }
  // 64 字（上限）放行
  {
    const p = fakePlayer()
    const r = await call(handlersOf(p).handleStoryStart, makeReq({ url: '/story/start?book=' + 'x'.repeat(64) }), makeRes())
    ok('64 字（上限内）放行并原样交给端口', r.status === 200 && p.calls.start.length === 1 &&
      p.calls.start[0].hint === 'x'.repeat(64), r.body)
  }
  // 前后空白 trim
  {
    const p = fakePlayer()
    const r = await call(handlersOf(p).handleStoryStart,
      makeReq({ url: '/story/start?book=' + encodeURIComponent('  西游记  ') }), makeRes())
    ok('书名前后空白被 trim', r.status === 200 && p.calls.start[0].hint === '西游记', r.body)
  }
  // 无参数 → 空 hint 接着当前书讲
  {
    const p = fakePlayer()
    const r = await call(handlersOf(p).handleStoryStart, makeReq({ url: '/story/start' }), makeRes())
    ok('无参数 → hint 空串（接着当前书）', r.status === 200 && p.calls.start[0].hint === '', r.body)
  }
  // book 作为 hint 的别名
  {
    const p = fakePlayer()
    await call(handlersOf(p).handleStoryStart, makeReq({ url: '/story/start?book=' + encodeURIComponent('西游记') }), makeRes())
    ok('只带 book 也能点播（别名）', p.calls.start[0].hint === '西游记')
  }
  // hint 优先于 book
  {
    const p = fakePlayer()
    await call(handlersOf(p).handleStoryStart,
      makeReq({ url: '/story/start?hint=' + encodeURIComponent('甲') + '&book=' + encodeURIComponent('乙') }), makeRes())
    ok('hint 与 book 同时给时 hint 优先', p.calls.start[0].hint === '甲')
  }
  // 业务失败：200 + ok:false
  {
    const p = fakePlayer({ start: async () => ({ ok: false, error: 'no books' }) })
    const r = await call(handlersOf(p).handleStoryStart, makeReq({ url: '/story/start' }), makeRes())
    ok('业务失败沿用 200 + ok:false（项目约定）', r.status === 200 && r.json().ok === false &&
      r.json().error === 'no books', r.body)
  }
  // 端口抛错：不把 500 崩给客户端
  {
    const p = fakePlayer({ startThrow: true })
    const r = await call(handlersOf(p).handleStoryStart, makeReq({ url: '/story/start' }), makeRes())
    ok('端口抛错 → 200 + ok:false（带错误文案）', r.status === 200 && r.json().ok === false &&
      r.json().error === 'boom-start', r.body)
  }
  // 响应形状：chunk 字段平铺 + remain
  {
    const p = fakePlayer()
    const r = await call(handlersOf(p).handleStoryStart, makeReq({ url: '/story/start' }), makeRes())
    const d = r.json()
    ok('响应平铺 chunk 字段并带 remain', d.ok === true && d.book === '甲书' && d.piece === 1 &&
      d.total === 4 && d.isFirst === true && d.isLast === false && d.remain === 3, r.body)
  }
  // 方法白名单
  {
    const p = fakePlayer()
    const r = await call(handlersOf(p).handleStoryStart, makeReq({ method: 'POST', url: '/story/start' }), makeRes())
    ok('POST /start → 405 + Allow: GET', r.status === 405 && r.headers.allow === 'GET' && p.calls.start.length === 0)
  }
  // x-client-id 清洗
  {
    const p = fakePlayer()
    await call(handlersOf(p).handleStoryStart, makeReq({
      url: '/story/start', headers: { 'x-client-id': 'a b/..\\c#d' },
    }), makeRes())
    ok('x-client-id 只留 [\\w.-]（空格/斜杠/# 被剔）', p.calls.start[0].id === 'ab..cd',
      JSON.stringify(p.calls.start[0].id))
  }
  {
    const p = fakePlayer()
    await call(handlersOf(p).handleStoryStart, makeReq({
      url: '/story/start', headers: { 'x-client-id': ['first-id', 'second-id'] },
    }), makeRes())
    ok('数组 header 取首个', p.calls.start[0].id === 'first-id', p.calls.start[0].id)
  }
  {
    const p = fakePlayer()
    await call(handlersOf(p).handleStoryStart, makeReq({ url: '/story/start', headers: { 'x-client-id': 12345 } }), makeRes())
    ok('非字符串 header → 空 id（共用单队列）', p.calls.start[0].id === '', JSON.stringify(p.calls.start[0].id))
  }
  {
    const p = fakePlayer()
    const long = 'z'.repeat(200)
    await call(handlersOf(p).handleStoryStart, makeReq({ url: '/story/start', headers: { 'x-client-id': long } }), makeRes())
    ok('超长 client id 截到 64', p.calls.start[0].id.length === 64, 'len=' + p.calls.start[0].id.length)
  }
} catch (e) {
  ok('start 断言执行', false, String(e && e.message))
}


// ---------- D. /story/next ----------
console.log('\n[D] GET /story/next')
try {
  const p = fakePlayer()
  const h = handlersOf(p)
  const r1 = await call(h.handleStoryNext, makeReq({ url: '/story/next' }), makeRes())
  ok('GET 回 200 + ok:true + remain', r1.status === 200 && r1.json().ok === true && r1.json().remain === 2, r1.body)
  ok('带 no-store', r1.headers['cache-control'] === 'no-store')
  const r2 = await call(h.handleStoryNext, makeReq({ method: 'DELETE', url: '/story/next' }), makeRes())
  ok('DELETE → 405 + Allow: GET', r2.status === 405 && r2.headers.allow === 'GET', r2.body)
  const p3 = fakePlayer({ next: async () => ({ ok: false, error: 'no readable book' }) })
  const r3 = await call(handlersOf(p3).handleStoryNext, makeReq({ url: '/story/next' }), makeRes())
  ok('坏书全灭 → 200 + ok:false no readable book', r3.status === 200 && r3.json().error === 'no readable book', r3.body)
  const p4 = fakePlayer({ nextThrow: true })
  const r4 = await call(handlersOf(p4).handleStoryNext, makeReq({ url: '/story/next' }), makeRes())
  ok('端口抛错 → 200 + ok:false', r4.status === 200 && r4.json().ok === false, r4.body)
} catch (e) {
  ok('next 断言执行', false, String(e && e.message))
}


// ---------- E. /story/reset ----------
console.log('\n[E] POST /story/reset')
try {
  // 只接受 POST
  {
    const p = fakePlayer()
    const r = await call(handlersOf(p).handleStoryReset, makeReq({ method: 'GET', url: '/story/reset?book=' + encodeURIComponent('甲书') }), makeRes())
    ok('GET /reset → 405 + Allow: POST 且不清进度', r.status === 405 && r.headers.allow === 'POST' && p.calls.reset.length === 0, r.body)
  }
  // query 书名
  {
    const p = fakePlayer()
    const r = await call(handlersOf(p).handleStoryReset,
      makeReq({ method: 'POST', url: '/story/reset?book=' + encodeURIComponent('甲书'), body: '' }), makeRes())
    ok('query 书名 → 调端口并回 book', r.status === 200 && r.json().ok === true && r.json().book === '甲书' &&
      p.calls.reset[0].book === '甲书', r.body)
    ok('reset 带 no-store', r.headers['cache-control'] === 'no-store')
  }
  // body 书名（兼容入口）
  {
    const p = fakePlayer()
    const r = await call(handlersOf(p).handleStoryReset,
      makeReq({ method: 'POST', url: '/story/reset', body: JSON.stringify({ book: '乙书' }) }), makeRes())
    ok('body 书名可用', r.status === 200 && p.calls.reset[0].book === '乙书', r.body)
  }
  // query 优先于 body
  {
    const p = fakePlayer()
    await call(handlersOf(p).handleStoryReset, makeReq({
      method: 'POST', url: '/story/reset?book=' + encodeURIComponent('甲书'),
      body: JSON.stringify({ book: '乙书' }),
    }), makeRes())
    ok('query 优先于 body', p.calls.reset[0].book === '甲书', p.calls.reset[0].book)
  }
  // 空书名 → 400 no book，不调端口
  {
    const p = fakePlayer()
    const r = await call(handlersOf(p).handleStoryReset, makeReq({ method: 'POST', url: '/story/reset', body: '' }), makeRes())
    ok('没给书名 → 400 no book，不调端口', r.status === 400 && r.json().error === 'no book' && p.calls.reset.length === 0, r.body)
  }
  // 非法书名 → 400 bad book，不调端口
  for (const [name, value] of [['穿越', '../x'], ['绝对路径', '/etc/passwd'], ['UNC', '\\\\srv\\x'], ['控制字符', 'a\u0000b']]) {
    const p = fakePlayer()
    const r = await call(handlersOf(p).handleStoryReset, makeReq({
      method: 'POST', url: '/story/reset?book=' + encodeURIComponent(value), body: '',
    }), makeRes())
    ok('reset ' + name + ' → 400 bad book 不调端口',
      r.status === 400 && r.json().error === 'bad book' && p.calls.reset.length === 0, r.body)
  }
  // 坏 JSON：query 有效时照常工作
  {
    const p = fakePlayer()
    const r = await call(handlersOf(p).handleStoryReset, makeReq({
      method: 'POST', url: '/story/reset?book=' + encodeURIComponent('甲书'), body: '{not json',
    }), makeRes())
    ok('坏 JSON + 有效 query 仍成功（body 退化为空体）', r.status === 200 && p.calls.reset[0].book === '甲书', r.body)
  }
  // 坏 JSON + 无 query → 400 no book（不是 500）
  {
    const p = fakePlayer()
    const r = await call(handlersOf(p).handleStoryReset, makeReq({
      method: 'POST', url: '/story/reset', body: '{not json',
    }), makeRes())
    ok('坏 JSON + 无 query → 400 no book', r.status === 400 && r.json().error === 'no book', r.body)
  }
  // 声明超限（content-length 5000 > 4KB）→ 413 且不调端口
  {
    const p = fakePlayer()
    const r = await call(handlersOf(p).handleStoryReset, makeReq({
      method: 'POST', url: '/story/reset?book=' + encodeURIComponent('甲书'),
      body: 'x'.repeat(5000), headers: { 'content-length': '5000' },
    }), makeRes())
    ok('声明超 4KB → 413 too large + connection: close，不调端口',
      r.status === 413 && r.json().error === 'too large' && r.headers.connection === 'close' && p.calls.reset.length === 0, r.body)
  }
  // 无 content-length（chunked）流式超限 → 同样 413
  {
    const p = fakePlayer()
    const r = await call(handlersOf(p).handleStoryReset, makeReq({
      method: 'POST', url: '/story/reset?book=' + encodeURIComponent('甲书'),
      body: 'x'.repeat(5000), declare: false,
    }), makeRes())
    ok('无 content-length 流式超限 → 413', r.status === 413 && r.json().error === 'too large' && p.calls.reset.length === 0, r.body)
  }
  // 恰好 4KB 放行（按字节算：中文一个 3 字节，不能按字符串长度补空格）
  {
    const p = fakePlayer()
    const base = JSON.stringify({ book: '甲书' })
    const body = base + ' '.repeat(4096 - Buffer.byteLength(base))
    ok('测试数据确实是 4096 字节', Buffer.byteLength(body) === 4096, 'bytes=' + Buffer.byteLength(body))
    const r = await call(handlersOf(p).handleStoryReset, makeReq({
      method: 'POST', url: '/story/reset', body,
    }), makeRes())
    ok('恰好 4KB 放行', r.status === 200 && p.calls.reset.length === 1, r.body)
  }
  // 业务失败（unknown book）→ 200 + ok:false
  {
    const p = fakePlayer({ reset: async () => ({ ok: false, error: 'unknown book' }) })
    const r = await call(handlersOf(p).handleStoryReset,
      makeReq({ method: 'POST', url: '/story/reset?book=' + encodeURIComponent('甲书'), body: '' }), makeRes())
    ok('unknown book → 200 + ok:false', r.status === 200 && r.json().ok === false && r.json().error === 'unknown book', r.body)
  }
  // 端口抛错
  {
    const p = fakePlayer({ resetThrow: true })
    const r = await call(handlersOf(p).handleStoryReset,
      makeReq({ method: 'POST', url: '/story/reset?book=' + encodeURIComponent('甲书'), body: '' }), makeRes())
    ok('端口抛错 → 200 + ok:false', r.status === 200 && r.json().ok === false, r.body)
  }
} catch (e) {
  ok('reset 断言执行', false, String(e && e.message))
}


// ---------- F. 参数面（rate/pitch/volume 不参与说书接口）----------
console.log('\n[F] 参数面：说书接口不吃音色/语速/音高参数')
try {
  const p = fakePlayer()
  const r = await call(handlersOf(p).handleStoryStart,
    makeReq({ url: '/story/start?rate=NaN&pitch=-999&volume=1e9&speed=abc' }), makeRes())
  const d = r.json()
  ok('rate/pitch/volume 之类参数被忽略（端口只收到 hint）', r.status === 200 && p.calls.start[0].hint === '' &&
    d.rate === '-30%' && d.pitch === undefined && d.volume === undefined, r.body)
  info('语速由服务端常量给出（player.buildChunk：rate=-30%），客户端传值不生效；音高/音量归 TTS 路由，不属于说书接口')
} catch (e) {
  ok('参数面断言执行', false, String(e && e.message))
}


// ───────────────────────── 播放器真实实现 ─────────────────────────
const chunkOf = (book, rows) => rows.map((r, i) => ({ book, title: r[0], piece: 1, total: r[1], text: r[2], index: i }))
const repoOf = (map) => ({
  listBooks: async () => Object.keys(map),
  loadBook: async (book) => (map[book] || []).slice(),
})

console.log('\n[G] 播放器状态机：并发 start / reset 重播 / 单章书')
try {
  // G1 同一客户端并发 start：两段不重复、进度都记账
  {
    const book = chunkOf('甲书', [['甲一', 4, '一'], ['甲一', 4, '二'], ['甲一', 4, '三'], ['甲一', 4, '四']])
    const pf = progressFile()
    const player = createStoryPlayer({ repo: repoOf({ 甲书: book }), progressFile: pf, source: 'local' })
    const [a, b] = await Promise.all([player.start('甲书', 'c1'), player.start('甲书', 'c1')])
    // 响应里没有内部段序号 index（只在进度键里用），对外可比的是 piece
    const pieces = [a.ok ? a.chunk.piece : -1, b.ok ? b.chunk.piece : -2].sort((x, y) => x - y)
    ok('并发 start 两次都成功', a.ok === true && b.ok === true, JSON.stringify([a.ok, b.ok]))
    ok('并发 start 不重复选段（两段不同）', a.ok && b.ok && a.chunk.text !== b.chunk.text &&
      pieces.join(',') === '1,2', pieces.join(','))
    const prog = readProgress(pf)
    // 这是**旧调用**（不带 opts）的即时落盘语义：离线脚本/旧调用方靠它续讲，必须保住。
    // 生产路由走的是 defer + 送出后 confirm，见 [K] 段。
    ok('并发 start 两段都写进进度（旧调用不带 opts：当场落盘，兼容语义）', prog['local:甲书|0'] === true && prog['local:甲书|1'] === true,
      Object.keys(prog).join(','))
    const c = await player.next('c1')
    ok('并发 start 后 next 不错位（第 3 段）', c.ok && c.chunk.text.indexOf('三') >= 0, c.ok ? c.chunk.text : String(c.error))
  }

  // G2 不同客户端并发 start：各拿一段（多标签页不抢同一段）
  {
    const book = chunkOf('甲书', [['甲一', 2, '一'], ['甲一', 2, '二']])
    const player = createStoryPlayer({ repo: repoOf({ 甲书: book }), progressFile: progressFile(), source: 'local' })
    const [a, b] = await Promise.all([player.start('甲书', 'tab-a'), player.start('甲书', 'tab-b')])
    ok('两个客户端并发 start 各拿不同段', a.ok && b.ok && a.chunk.text !== b.chunk.text,
      (a.ok ? a.chunk.text : 'x') + ' / ' + (b.ok ? b.chunk.text : 'y'))
  }

  // G2b 跨标签页现状：每个客户端有自己的队列，但「队列空了往哪本书接着讲」看的是全局 _current。
  //     这条只记录现状（不是断言）——是否改成「各标签页守自己的书」需要产品拍板。
  {
    const books = {
      甲: chunkOf('甲', [['甲一', 2, '甲一'], ['甲一', 2, '甲二']]),
      乙: chunkOf('乙', [['乙一', 2, '乙一'], ['乙一', 2, '乙二']]),
    }
    const player = createStoryPlayer({ repo: repoOf(books), progressFile: progressFile(), source: 'local' })
    await player.start('甲', 'tabA')
    await player.start('乙', 'tabB')
    const a2 = await player.next('tabA')   // 还在甲的队列里（甲二）
    const a3 = await player.next('tabA')   // 甲队列空了 → 从全局 _current（乙）挑
    info('跨标签页现状：tabA 自己的队列讲完后，下一段是《' + (a3.ok ? a3.chunk.book : '?') +
      '》（tabA 第 2 段仍是《' + (a2.ok ? a2.chunk.book : '?') + '》）')
  }

  // G3 reset 后重播：从头开始（同段序号 0），并记录是否重放开场白
  {
    const book = chunkOf('甲书', [['甲一', 2, '一'], ['甲一', 2, '二']])
    const player = createStoryPlayer({ repo: repoOf({ 甲书: book }), progressFile: progressFile(), source: 'local' })
    const first = await player.start('甲书', 'c3')
    await player.next('c3')
    const rt = await player.reset('甲书', 'c3')
    const again = await player.next('c3')
    ok('reset 回 book', rt.ok === true && rt.book === '甲书')
    ok('reset 后 next 从头重播（回到第 1 段）', first.ok && again.ok &&
      again.chunk.text.indexOf('一') >= 0 && again.chunk.text.indexOf('二') < 0,
      again.ok ? again.chunk.text : String(again.error))
    info('reset 后首段 isFirst=' + (again.ok ? again.chunk.isFirst : '?') + '（开场白是否重开）')
  }

  // G4 只有一章的书：isLast 真、remain 0，下一段自动换书
  {
    const one = chunkOf('单章书', [['唯一一回', 1, '独一段']])
    const two = chunkOf('双章书', [['第一回', 2, '双一'], ['第一回', 2, '双二']])
    const player = createStoryPlayer({
      repo: repoOf({ 单章书: one, 双章书: two }), progressFile: progressFile(), source: 'local',
    })
    const r = await player.start('单章书', 'c4')
    ok('单章书：remain=0 且 isLast=true', r.ok && r.remain === 0 && r.chunk.isLast === true,
      r.ok ? 'remain=' + r.remain + ' isLast=' + r.chunk.isLast : String(r.error))
    const nx = await player.next('c4')
    ok('单章书讲完自动换下一本（并重开放场白）', nx.ok && nx.chunk.book === '双章书' && nx.chunk.isFirst === true,
      nx.ok ? nx.chunk.book + ' isFirst=' + nx.chunk.isFirst : String(nx.error))
  }

  // G5 空书单 / 全空书：不崩、不假装讲完
  {
    const empty = createStoryPlayer({ repo: repoOf({}), progressFile: progressFile(), source: 'local' })
    const r1 = await empty.start('', 'c5')
    ok('空书单 start → no books', r1.ok === false && r1.error === 'no books')
    ok('空书单 next → no books', (await empty.next('c5')).error === 'no books')
    const allEmpty = createStoryPlayer({ repo: repoOf({ 空书: [] }), progressFile: progressFile(), source: 'local' })
    const r2 = await allEmpty.start('', 'c6')
    ok('只有空书 → no readable book', r2.ok === false && r2.error === 'no readable book')
  }

  // G6 进度文件坏掉/不存在：不崩，新建可写
  {
    const pf = progressFile('{broken json')
    const player = createStoryPlayer({ repo: repoOf({ 甲书: chunkOf('甲书', [['甲一', 1, '一']]) }), progressFile: pf, source: 'local' })
    const r = await player.start('甲书', 'c7')
    ok('进度文件坏 JSON → 当空进度继续讲', r.ok === true, r.ok ? '' : String(r.error))
    ok('进度文件随后被重写成合法 JSON', readProgress(pf)['local:甲书|0'] === true)
    const pf2 = join(TMP, 'progress-missing.json')
    const p2 = createStoryPlayer({ repo: repoOf({ 甲书: chunkOf('甲书', [['甲一', 1, '一']]) }), progressFile: pf2, source: 'local' })
    await p2.start('甲书', 'c8')
    ok('进度文件不存在时自动创建', existsSync(pf2) && readProgress(pf2)['local:甲书|0'] === true)
  }

  // G7 连播队列上限：17 个客户端不炸，各自都能接着讲
  {
    const book = chunkOf('甲书', Array.from({ length: 20 }, (_, i) => ['甲一', 20, '第' + (i + 1) + '段']))
    const player = createStoryPlayer({ repo: repoOf({ 甲书: book }), progressFile: progressFile(), source: 'local' })
    for (let i = 0; i < 17; i++) await player.start('甲书', 'c' + i)
    let allOk = true
    for (let i = 0; i < 17; i++) {
      const n = await player.next('c' + i)
      if (!n.ok) allOk = false
    }
    ok('17 个客户端（超过 16 上限）仍各自能接着讲', allOk)
  }

  // G8 数据里 index 不连续（normalize 会丢掉空正文段，index 保留原数组位置）
  {
    const gaps = [
      { book: '甲书', title: '甲一', piece: 1, total: 1, text: '', index: 0 },
      { book: '甲书', title: '甲一', piece: 1, total: 1, text: '第二段', index: 1 },
      { book: '甲书', title: '甲一', piece: 1, total: 1, text: '第三段', index: 2 },
    ].filter((c) => c.text.trim())
    const player = createStoryPlayer({ repo: repoOf({ 甲书: gaps }), progressFile: progressFile(), source: 'local' })
    const a = await player.start('甲书', 'c9')
    const b = await player.next('c9')
    ok('index 从 1 开始（首段被丢）时不跳段、不重复',
      a.ok && b.ok && a.chunk.text.indexOf('第二段') >= 0 && b.chunk.text.indexOf('第三段') >= 0,
      (a.ok ? a.chunk.text : String(a.error)) + ' / ' + (b.ok ? b.chunk.text : String(b.error)))
  }
} catch (e) {
  ok('播放器状态机断言执行', false, String(e && e.message))
}


// ---------- H. 真实宿主链路：路由 → 播放器 → DataPort → 仓储(Worker) → data/story ----------
console.log('\n[H] 真实宿主链路（真实 17 本书 + Worker 解析，只读 data/story）')
try {
  const workerPath = join(ROOT, 'dist', 'story-worker.js')
  const dataDir = join(ROOT, 'data')
  if (!existsSync(workerPath)) {
    console.log('  · 跳过：dist/story-worker.js 不存在（先 npm run build）')
  } else {
    const { createStoryRepo } = await import('../src/host/story/repo.ts')
    const { createStorySource } = await import('../src/host/data/story-source.ts')
    const { createLocalDataPort } = await import('../src/host/data/local.ts')
    const repo = createStoryRepo({ dataDir, workerPath })
    const port = createLocalDataPort({ dataDir, story: repo })
    const player = createStoryPlayer({
      repo: createStorySource(port), progressFile: progressFile(), source: 'local',
    })
    const h = handlersOf(player)
    const headers = { 'x-client-id': 'c-host-e2e' }

    // H1 书单
    const books = await call(h.handleBooks, makeReq({ url: '/story/books' }), makeRes())
    const names = books.json().books
    ok('真书单：200 + 17 本 + 排序 + 含三言二拍/西游记',
      books.status === 200 && names.length === 17 && names.indexOf('三言二拍') >= 0 && names.indexOf('西游记') >= 0 &&
      names.join(',') === names.slice().sort().join(','), 'n=' + names.length)

    // H2 合辑书：响应书名必须是「书单名」而不是段内子书名（否则 reset 会 unknown book）
    const r1 = await call(h.handleStoryStart,
      makeReq({ url: '/story/start?book=' + encodeURIComponent('三言二拍'), headers }), makeRes())
    const d1 = r1.json()
    ok('三言二拍 start：响应书名 = 书单名', r1.status === 200 && d1.ok === true && d1.book === '三言二拍', d1.book)
    ok('三言二拍 start：分段位置来自真实数据（1/10）', d1.piece === 1 && d1.total === 10, d1.piece + '/' + d1.total)
    ok('三言二拍 start：开场白含书名与作者', String(d1.text).indexOf('《三言二拍》') >= 0 &&
      String(d1.text).indexOf('冯梦龙') > 0, String(d1.text).slice(0, 40))
    ok('三言二拍 start：remain = 全书剩余段', d1.remain === 1057, 'remain=' + d1.remain)

    // H3 用响应里的书名直接 reset（客户端就是这么用的）
    const rt = await call(h.handleStoryReset, makeReq({
      method: 'POST', url: '/story/reset?book=' + encodeURIComponent(d1.book), body: '', headers,
    }), makeRes())
    ok('reset 用响应书名 → ok:true（子书名胜出的 bug 已由 source 层投影挡住）',
      rt.status === 200 && rt.json().ok === true && rt.json().book === '三言二拍', rt.body)

    // H4 reset 后重讲：回到第 1 段
    const r2 = await call(h.handleStoryStart,
      makeReq({ url: '/story/start?book=' + encodeURIComponent('三言二拍'), headers }), makeRes())
    const d2 = r2.json()
    ok('reset 后 start 回到第 1 段（真的从头讲）', d2.ok === true && d2.piece === 1 &&
      String(d2.text).indexOf('蒋兴哥重会珍珠衫') > 0, d2.piece + ' ' + String(d2.text).slice(0, 30))

    // H5 西游记：一回四段的回末句子
    const xy = await call(h.handleStoryStart,
      makeReq({ url: '/story/start?book=' + encodeURIComponent('西游记'), headers }), makeRes())
    const xy1 = xy.json()
    ok('西游记首段 1/4 且无回末句', xy1.ok === true && xy1.piece === 1 && xy1.total === 4 &&
      String(xy1.text).indexOf('这一回，就讲到这里。') < 0, xy1.piece + '/' + xy1.total)
    const seen = [xy1]
    for (let i = 0; i < 3; i++) {
      const nx = await call(h.handleStoryNext, makeReq({ url: '/story/next', headers }), makeRes())
      seen.push(nx.json())
    }
    ok('西游记连播四段 piece 依次 1,2,3,4', seen.map((d) => d.piece).join(',') === '1,2,3,4',
      seen.map((d) => d.piece).join(','))
    ok('只有第 4 段带「这一回，就讲到这里。」', seen.slice(0, 3).every((d) => String(d.text).indexOf('这一回') < 0) &&
      String(seen[3].text).indexOf('这一回，就讲到这里。') > 0)
    ok('第 2~4 段不重复开场白', seen.slice(1).every((d) => d.isFirst === false))

    // H6 全库冷读：17 本书都能解析、段序号连续、正文非空（顺带量一下总耗时）
    const t0 = Date.now()
    let totalChunks = 0
    let badIndex = ''
    let emptyText = 0
    for (const name of names) {
      const list = await repo.loadBook(name)
      totalChunks += list.length
      if (list.length === 0) { badIndex = name + ':empty'; break }
      for (let i = 0; i < list.length; i++) {
        if (!Number.isInteger(list[i].index) || list[i].index < 0) { badIndex = name + '@' + i + ':index=' + list[i].index; break }
        if (!String(list[i].text || '').trim()) emptyText++
      }
      if (list[0].index !== 0) badIndex = badIndex || name + ':first=' + list[0].index
      if (badIndex) break
    }
    info('17 本冷读总计 ' + totalChunks + ' 段，耗时 ' + (Date.now() - t0) + 'ms（Worker 解析 + mtime 缓存）')
    ok('17 本全部可解析且段序号是合法整数', badIndex === '', badIndex)
    ok('段内没有空正文（normalize 已过滤）', emptyText === 0, 'empty=' + emptyText)

    // H7 缓存与拷贝隔离：同一本书读两次，内容一致、实例不同
    const [c1, c2] = await Promise.all([repo.loadBook('西游记'), repo.loadBook('西游记')])
    ok('并发/缓存读取各拿一份数组', c1 !== c2 && c1.length === c2.length && c1.length === 378, 'n=' + c1.length)
    c1.reverse()
    const c3 = await repo.loadBook('西游记')
    ok('调用方 reverse 不影响后续读取顺序', c3[0].text === c2[0].text && c3[0].index === 0)

    // H8 数据形态说明（任务书说「本地 txt」，实际是 data/story/*.json）
    const { readdirSync } = await import('node:fs')
    const files = readdirSync(dataDir + '/story')
    ok('说书数据是 JSON 分章文件（不是 txt）', files.every((f) => f.endsWith('.json')), files.slice(0, 2).join(','))
  }
} catch (e) {
  ok('真实链路断言执行', false, String(e && e.message))
}


// ---------- I. 仓储失败面：Worker 崩溃/退出/坏 JSON 都不许把请求吊死 ----------
console.log('\n[I] 仓储失败面（Worker exit / error / 坏 JSON / 路径边界）')
try {
  const workerPath = join(ROOT, 'dist', 'story-worker.js')
  if (!existsSync(workerPath)) {
    console.log('  · 跳过：dist/story-worker.js 不存在（先 npm run build）')
  } else {
    const { createStoryRepo } = await import('../src/host/story/repo.ts')
    const dataDir = join(TMP, 'repo')
    mkdirSync(join(dataDir, 'story'), { recursive: true })
    writeFileSync(join(dataDir, 'story', '好书.json'), JSON.stringify([
      { book: '好书', title: '第一回', total: 2, text: '甲甲' },
      { book: '好书', title: '第一回', total: 2, text: '乙乙' },
    ]))
    writeFileSync(join(dataDir, 'story', '坏书.json'), '{not json')
    writeFileSync(join(dataDir, 'story', 'BOM书.json'), '\uFEFF' + JSON.stringify([{ book: 'BOM书', title: '一', total: 1, text: '丙丙' }]))
    // data 根下的「机密」文件：内容是合法段落数组，越界读成功就会拿到 1 段（比对象更好判别）
    writeFileSync(join(dataDir, 'secret.json'), JSON.stringify([
      { book: 'secret', title: '不许看', total: 1, text: '机密正文' },
    ]))

    const repo = createStoryRepo({ dataDir, workerPath })
    const books = await repo.listBooks()
    ok('书单只列 story/*.json（不含 data 根下的 secret.json）',
      books.indexOf('好书') >= 0 && books.indexOf('坏书') >= 0 && books.indexOf('secret') < 0, books.join(','))

    // 路径边界（与路由同口径，仓储是最后一道）
    for (const bad of ['../secret', '..\\secret', 'a/b', 'x'.repeat(65), '', '  ']) {
      ok('越界/非法书名读不出来：' + JSON.stringify(bad), (await repo.loadBook(bad)).length === 0)
    }

    // 坏 JSON：返回空数组（不抛），且第二次同样空（负缓存不得把进程吊住）
    const tBad1 = Date.now()
    const bad1 = await repo.loadBook('坏书')
    const tBad2 = Date.now()
    const bad2 = await repo.loadBook('坏书')
    ok('坏 JSON 书 → 空数组（不抛、不假装有内容）', bad1.length === 0 && bad2.length === 0,
      'first=' + (tBad2 - tBad1) + 'ms')

    // Worker 崩溃：未捕获异常 → error 事件 → 空数组，且必须在秒级返回（20s 定时器要被清掉）
    const throwWorker = join(TMP, 'throw-worker.mjs')
    writeFileSync(throwWorker, 'throw new Error("boom-in-worker")\n')
    const repoThrow = createStoryRepo({ dataDir, workerPath: throwWorker })
    const t0 = Date.now()
    const gotThrow = await repoThrow.loadBook('好书')
    const dtThrow = Date.now() - t0
    ok('Worker 抛错 → 空数组且秒级返回（无残留定时器）', gotThrow.length === 0 && dtThrow < 8000, dtThrow + 'ms')

    // Worker 不发消息直接 exit(1) → exit 事件兜底，同样秒级
    const exitWorker = join(TMP, 'exit-worker.mjs')
    writeFileSync(exitWorker, 'process.exit(1)\n')
    const repoExit = createStoryRepo({ dataDir, workerPath: exitWorker })
    const t1 = Date.now()
    const gotExit = await repoExit.loadBook('好书')
    const dtExit = Date.now() - t1
    ok('Worker 直接 exit(1) → 空数组且秒级返回（不悬到 20s 超时）', gotExit.length === 0 && dtExit < 8000, dtExit + 'ms')

    // 已知缺口：BOM 开头的书文件读不出来（修法在 src/story-worker.ts，超出本批次可改范围）
    const gotBom = await repo.loadBook('BOM书')
    info('BOM 文件当前读到 ' + gotBom.length + ' 段（已知缺口：story-worker 没剥 BOM，'
      + '而 progress/local/cloud 三处都剥；修法是 worker 里 JSON.parse(stripBom(text))）')

    // 日志纪律：外部书名进了日志，必须截断、单行、只记一条（别让坏请求伪造日志行）
    const badNameLogs = repoLogs.filter((l) => l.indexOf('err=bad book name') > 0)
    ok('非法书名各留一条 STORY-LOAD-FAIL 日志', badNameLogs.length >= 6, 'n=' + badNameLogs.length)
    ok('日志行不带换行/回车', repoLogs.every((l) => !/[\r\n]/.test(l)))
    ok('日志行长度受控（外部书名被截断）', badNameLogs.every((l) => l.length < 200),
      badNameLogs.map((l) => l.length).join(','))
  }
} catch (e) {
  ok('仓储失败面断言执行', false, String(e && e.message))
}


// ---------- J. BOM 书文件（2026-11-07 修复：worker 剥 BOM） ----------
console.log('\n[J] BOM 书文件能被解析（Windows 记事本/PowerShell UTF8 会加 BOM）')
try {
  const workerPath = join(ROOT, 'dist', 'story-worker.js')
  if (!existsSync(workerPath)) {
    console.log('  · 跳过：dist/story-worker.js 不存在（先 npm run build）')
  } else {
    const bomDir = join(TMP, 'bom-story')
    const bomStoryDir = join(bomDir, 'story')
    // 仓储按 <dataDir>/story/<书名>.json 查找（与 H 段真实链路同口径）
    mkdirSync(bomStoryDir, { recursive: true })
    const bookFile = join(bomStoryDir, 'BOM书.json')
    writeFileSync(bookFile, '\uFEFF' + JSON.stringify([{ book: 'BOM书', section: '一', total: 1, text: '带 BOM 的第一段' }]), 'utf8')
    const { createStoryRepo } = await import('../src/host/story/repo.ts')
    const repo = createStoryRepo({ dataDir: bomDir, workerPath })
    const chunks = await repo.loadBook('BOM书')
    ok('BOM 书文件能被解析（不是 0 段）', Array.isArray(chunks) && chunks.length === 1, 'n=' + (chunks ? chunks.length : 'null'))
    ok('BOM 书的正文正确', chunks && chunks[0] && chunks[0].text === '带 BOM 的第一段', chunks && chunks[0] && chunks[0].text)
    // 负向提示：同一文件去掉 BOM 也必须能读（证明不是靠副作用）
    writeFileSync(bookFile, JSON.stringify([{ book: 'BOM书', section: '一', total: 1, text: '无 BOM 的第一段' }]), 'utf8')
    const repo2 = createStoryRepo({ dataDir: bomDir, workerPath })
    const plain = await repo2.loadBook('BOM书')
    ok('无 BOM 的书照常解析（回归不受影响）', Array.isArray(plain) && plain.length === 1 && plain[0].text === '无 BOM 的第一段')
  }
} catch (e) {
  ok('BOM 书断言执行', false, String(e && e.message))
}


// ---------- K. 进度次序：响应真的送出去了才记账（B97） ----------
console.log('\n[K] 进度次序：finish 才确认；断开 / end 抛错撤销')
try {
  // K1 响应还没写完 → 不确认；finish 之后才确认一次，书/段与响应里那一段一致
  {
    const p = fakePlayer()
    const res = makeRes({ autoFinish: false })
    await call(handlersOf(p).handleStoryStart, makeReq({ url: '/story/start' }), res)
    const before = p.calls.confirm.length
    res.writableFinished = true
    res.emit('finish')
    ok('响应还没写完不确认；finish 之后才确认一次，书/段与响应里那一段一致',
      before === 0 && p.calls.confirm.length === 1 && p.calls.confirm[0].book === '甲书' && p.calls.confirm[0].index === 0,
      'before=' + before + ' after=' + JSON.stringify(p.calls.confirm))
    res.emit('close')   // 真实 Node 里 finish 之后还会 close：不许重复确认
    ok('finish 之后再 close 不重复确认、也不撤销',
      p.calls.confirm.length === 1 && p.calls.discard.length === 0, JSON.stringify(p.calls))
  }

  // K2 客户端在写完之前断开（fetch 被 abort）→ 撤销预约，这一段回到未讲
  {
    const p = fakePlayer()
    const res = makeRes({ autoFinish: false })
    await call(handlersOf(p).handleStoryNext, makeReq({ url: '/story/next' }), res)
    res.destroyed = true
    res.emit('close')
    ok('客户端在响应写完前断开 → 不确认、改为撤销（下一次还能讲这一段）',
      p.calls.confirm.length === 0 && p.calls.discard.length === 1 && p.calls.discard[0].index === 1,
      JSON.stringify(p.calls))
  }

  // K3 res.end 抛错（连接已断）→ 撤销，且不把异常漏给调用方
  {
    const p = fakePlayer()
    const res = makeRes({ throwOnEnd: true })
    await call(handlersOf(p).handleStoryStart, makeReq({ url: '/story/start' }), res)
    ok('res.end 抛错 → 不确认、改为撤销，路由不向外抛异常',
      !res.threw && p.calls.confirm.length === 0 && p.calls.discard.length === 1, JSON.stringify(p.calls))
  }

  // K4 端到端（真实播放器 + 真实进度文件）：写响应前没有记录；断开后重讲还是这一段
  {
    const book = chunkOf('甲书', [['甲一', 1, '第一段正文'], ['甲二', 1, '第二段正文']])
    const pf = progressFile()
    const player = createStoryPlayer({ repo: repoOf({ 甲书: book }), progressFile: pf, source: 'local' })
    const h = handlersOf(player)
    const url = '/story/start?book=' + encodeURIComponent('甲书')
    const headers = { 'x-client-id': 'k4' }

    const r1 = makeRes({ autoFinish: false })
    await call(h.handleStoryStart, makeReq({ url, headers }), r1)
    ok('真实链路：响应写出前进度文件里没有这一段（旧实现此刻已经有记录）',
      r1.json().ok === true && !existsSync(pf), existsSync(pf) ? JSON.stringify(readProgress(pf)) : '未创建')

    // 客户端超时/被停止 → fetch 被 abort → 连接断开：这一段不算讲过
    r1.destroyed = true
    r1.emit('close')
    const aborted = existsSync(pf) ? readProgress(pf) : {}
    ok('真实链路：断开之后这一段仍未讲（进度文件里没有它）',
      !('local:甲书|0' in aborted), JSON.stringify(aborted))

    // 下次点播：仍从第 1 段讲（没被跳过）
    const r2 = makeRes()
    await call(h.handleStoryStart, makeReq({ url, headers }), r2)
    ok('真实链路：断开后重新点播，还是第 1 段（没被跳过）',
      r2.json().ok === true && String(r2.json().text).indexOf('第一段正文') >= 0, String(r2.json().text).slice(0, 40))
    ok('真实链路：这次真的送出去之后才记进进度，且只记了送出去的那一段（没顺手记下一段）',
      readProgress(pf)['local:甲书|0'] === true && !('local:甲书|1' in readProgress(pf)) &&
      readProgress(pf)._current === '甲书', JSON.stringify(readProgress(pf)))
  }

  // K5 next 路径：那一段已经出队了，响应没送出必须塞回队首，不许顺着队列跳过去
  {
    const book = chunkOf('甲书', [['甲一', 1, '第一段'], ['甲二', 1, '第二段'], ['甲三', 1, '第三段']])
    const pf = progressFile()
    const player = createStoryPlayer({ repo: repoOf({ 甲书: book }), progressFile: pf, source: 'local' })
    const h = handlersOf(player)
    const headers = { 'x-client-id': 'k5' }
    const r0 = makeRes()
    await call(h.handleStoryStart, makeReq({ url: '/story/start?book=' + encodeURIComponent('甲书'), headers }), r0)

    const r1 = makeRes({ autoFinish: false })
    await call(h.handleStoryNext, makeReq({ url: '/story/next', headers }), r1)
    const seg1 = String(r1.json().text)
    r1.destroyed = true
    r1.emit('close')
    const afterAbort = readProgress(pf)

    const r2 = makeRes()
    await call(h.handleStoryNext, makeReq({ url: '/story/next', headers }), r2)
    const seg2 = String(r2.json().text)
    const saved = readProgress(pf)
    ok('next 断连：那一次不记账、这一段回到队首重讲，重讲送出去之后才记（不跳过）',
      r0.json().ok === true && seg1.indexOf('第二段') >= 0 && !('local:甲书|1' in afterAbort) &&
      seg2.indexOf('第二段') >= 0 && saved['local:甲书|1'] === true,
      'seg1=' + seg1.slice(-9) + ' seg2=' + seg2.slice(-9) + ' abortFile=' + JSON.stringify(afterAbort))
  }
} catch (e) {
  ok('进度次序断言执行', false, String(e && e.message))
}


// ---------- 汇总 ----------
try { rmSync(TMP, { recursive: true, force: true }) } catch (e) { }
console.log('\n────────────────────')
console.log((fail === 0 ? '✅ ' : '❌ ') + '通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
