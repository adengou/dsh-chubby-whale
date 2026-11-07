/**
 * scripts/test-culture-source.mjs —— 文化数据源（外呼链路）永久回归（纯离线，只连 127.0.0.1）
 *
 * 背景（B102 文化外呼链路审计，2026-11-07）：
 *   ① `src/host/data/cloud.ts` 取外部数据时自建 fetch：有 10 秒超时，但**响应体没有上限**——
 *      `JSON.parse(stripBom(await res.text()))` 会先把整个回包读进内存。外部接口/CDN/劫持页
 *      回一个几百 MB（或 chunked 永不结束）的包，就等于把 dsh web 的内存吃穿；HTML 错误页
 *      也会被当成「解析失败」再回退，行为对但无任何上限保护。
 *      本文件锁住：content-length 声明超限要**一个字节都不读**就判失败；没声明/声明偏小要
 *      按流累计、越线立刻取消；没有 body 流的替身实现退化成「读完再按 UTF-8 字节数判」。
 *   ② 超时硬编码 10 秒，离线没法秒级验证。`createCloudDataPort` 因此接受可选注入
 *      `timeoutMs` / `maxBytes`（生产默认仍是 10s / 16MB，见 CLOUD_FETCH_TIMEOUT_MS /
 *      CLOUD_MAX_BODY_BYTES），把「超时 → 回退本地」变成可断言用例。
 *   ③ 外部接口不可达时**界面不能乱**：要么用本地数据，要么如实说「没读到」，
 *      绝不允许编一条内容填上。这里用本地假 HTTP 服务 + 已关闭端口验证这条底线。
 *
 * 纪律：不联网（只连 127.0.0.1 随机端口）、不碰 dist、不依赖外网 DNS；失败退出码 1。
 * 用法：node scripts/test-culture-source.mjs
 */
import { register } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
register(new URL('./ts-resolve.mjs', import.meta.url))

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.error('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href)
const tmpDirs = []
function mkTmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}

/** 静默执行（预期会打日志的路径不刷屏），同时收日志 */
async function capture(fn) {
  const logs = []
  const realError = console.error
  const realWarn = console.warn
  const realLog = console.log
  console.error = (...a) => logs.push(a.join(' '))
  console.warn = (...a) => logs.push(a.join(' '))
  console.log = (...a) => logs.push(a.join(' '))
  try {
    return { value: await fn(), logs }
  } finally {
    console.error = realError
    console.warn = realWarn
    console.log = realLog
  }
}

/** 假本地数据源：每个读口都留标记，用来判断「有没有回退到本地」 */
function mkLocal(marker, empty = false) {
  const stats = { index: 0, book: 0, culture: 0, poem: 0, duilian: 0, daily: 0 }
  return {
    stats,
    readStoryIndex: async () => { stats.index++; return empty ? [] : [{ book: marker }] },
    readStoryBook: async () => { stats.book++; return empty ? [] : [{ book: marker, title: 't', piece: 1, total: 1, text: marker, index: 0 }] },
    readCulture: async (kind) => { stats.culture++; return empty ? [] : [{ name: marker, src: marker, text: marker + '·' + kind }] },
    readPoemsChunk: async (i) => { stats.poem++; return { index: i, total: 1, items: empty ? [] : [{ title: marker, author: marker, lines: [marker] }] } },
    readDuilian: async () => { stats.duilian++; return { total: 0, items: [], cats: {} } },
    readDaily: async () => { stats.daily++; return empty ? [] : [{ date: '2026-11-07', text: marker }] },
  }
}

/** 起一个 127.0.0.1 随机端口的假 HTTP 服务；handler 收 (path, req, res) */
async function withServer(handler, fn) {
  const server = createServer((req, res) => {
    let path = String(req.url || '')
    try { path = decodeURIComponent(path) } catch { /* 保持原样 */ }
    path = path.replace(/^\/v1\//, '')
    try { handler(path, req, res) } catch (e) { try { res.destroy() } catch { } }
  })
  await new Promise((res, rej) => {
    server.once('error', rej)
    server.listen(0, '127.0.0.1', () => res())
  })
  const base = 'http://127.0.0.1:' + server.address().port + '/v1/'
  try {
    return await fn(base)
  } finally {
    try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections() } catch { }
    await new Promise((res) => server.close(() => res()))
  }
}

/** 拿一个「确实没人监听」的本地端口（先占再关） */
async function deadBase() {
  const s = createServer(() => { })
  await new Promise((res) => s.listen(0, '127.0.0.1', () => res()))
  const port = s.address().port
  await new Promise((res) => s.close(() => res()))
  return 'http://127.0.0.1:' + port + '/v1/'
}

/** 文化路由的假 res（与 test.mjs 的用法一致） */
function mkRes() {
  const out = { code: 0, chunks: [] }
  out.writeHead = (c) => { out.code = c }
  out.end = (b) => { if (b) out.chunks.push(Buffer.from(String(b))) }
  out.setHeader = () => { }
  out.json = () => { try { return JSON.parse(Buffer.concat(out.chunks).toString('utf8')) } catch { return null } }
  return out
}

async function callRoute(handlers, url) {
  const res = mkRes()
  await handlers.handleCulture({ url }, res)
  return res.json()
}

// ---------------------------------------------------------------------------
// A. 外呼口径的默认值（防止有人把超时/上限悄悄改没）
// ---------------------------------------------------------------------------
// 两个默认值是模块私有的（对外接口只有 createCloudDataPort，见《模块接口清单》），
// 所以这里做源码级防漂移断言：值被改小/删掉都会在这里红。
console.log('\n[A] 外呼默认口径：超时 + 响应体上限')
let cloudMod = null
try {
  const cloudSrc = readFileSync(join(ROOT, 'src/host/data/cloud.ts'), 'utf8')
  ok('默认单次外呼超时 = 10s（B93「外呼必须带超时」）', /const CLOUD_FETCH_TIMEOUT_MS\s*=\s*10000\b/.test(cloudSrc))
  ok('默认响应体上限 = 16MB', /const CLOUD_MAX_BODY_BYTES\s*=\s*16\s*\*\s*1024\s*\*\s*1024\b/.test(cloudSrc))
  cloudMod = await imp('src/host/data/cloud.ts')
  ok('导出面没变（模块接口清单只认 CLOUD_DATA_BASE / createCloudDataPort）',
    Object.keys(cloudMod).sort().join(',') === 'CLOUD_DATA_BASE,createCloudDataPort', Object.keys(cloudMod).join(','))
} catch (e) {
  ok('A 组可执行', false, String(e && e.message))
}

// ---------------------------------------------------------------------------
// B. 正常外呼：按清单取数 / 并发单飞 / 缓存
// ---------------------------------------------------------------------------
console.log('\n[B] 正常外呼：清单 + 文件、并发两次点击、缓存')
try {
  const { createCloudDataPort } = cloudMod
  const asked = []
  await withServer((path, req, res) => {
    asked.push(path)
    if (path === 'manifest.json') {
      res.end(JSON.stringify({
        version: 'v1', generatedAt: 'g1',
        files: [{ path: 'culture/chengyu.json' }, { path: 'daily.json' }, { path: 'poem-titles.json' }, { path: 'melodies.json' }],
      }))
      return
    }
    if (path === 'culture/chengyu.json') { res.end(JSON.stringify({ items: [{ name: '一鼓作气', src: '左传', text: '振作士气' }, { name: '亡羊补牢', src: '战国策', text: '羊跑了再修圈' }] })); return }
    if (path === 'daily.json') { res.end(JSON.stringify({ items: [{ date: '2026-11-07', text: '云端每日' }] })); return }
    if (path === 'poem-titles.json') { res.end(JSON.stringify({ titles: ['静夜思', '望岳'] })); return }
    if (path === 'melodies.json') { res.end(JSON.stringify({ bpm: 100, songs: [{ name: '小星星', bpm: 120, notes: [1, 2, 3], lyrics: '一闪一闪' }] })); return }
    res.statusCode = 404
    res.end('')
  }, async (base) => {
    const local = mkLocal('LOCAL')
    const port = createCloudDataPort({ local, baseUrl: base })
    const [a, b] = await Promise.all([port.readCulture('chengyu'), port.readCulture('chengyu')])
    ok('并发两次读取都拿到云端数据', a[0] && a[0].name === '一鼓作气' && b[0] && b[0].name === '一鼓作气')
    ok('并发同一文件只外呼一次（单飞）', asked.filter((p) => p === 'culture/chengyu.json').length === 1, '请求 ' + asked.filter((p) => p === 'culture/chengyu.json').length + ' 次')
    ok('清单 30 秒内只拉一次', asked.filter((p) => p === 'manifest.json').length === 1)
    ok('返回值是拷贝，不是云端缓存本体', a !== b && a[0] !== b[0])

    const d = await port.readDaily()
    ok('第二批读口复用同一份清单', d[0] && d[0].text === '云端每日' && asked.filter((p) => p === 'manifest.json').length === 1)
    ok('成功结果进缓存（回头再读不再打网络）', asked.filter((p) => p === 'daily.json').length === 1)

    const t = await port.readPoemTitles()
    ok('诗名索引：清单声明了就取云端', t && t.titles.length === 2 && t.titles[0] === '静夜思', JSON.stringify(t))

    const m = await port.readMelodies()
    ok('曲库：清单声明了就取云端（songs 拷贝）', m && m.songs.length === 1 && m.songs[0].name === '小星星', JSON.stringify(m && m.songs))

    // 音乐路由：云端曲库经端口进来，列表只露 name/bpm
    const { createCultureHandlers } = await imp('src/host/routes/culture.ts')
    const dir = mkTmp('whale-culture-src-route-')
    const handlers = createCultureHandlers({ dataDir: dir, runtimeDir: dir, dataPort: port })
    const mr = mkRes()
    await handlers.handleMelodies({}, mr)
    const list = mr.json()
    ok('音乐路由：云端曲目列表只露 name/bpm', list.ok === true && list.songs.length === 1 && list.songs[0].name === '小星星' && !('notes' in list.songs[0]))
  })
} catch (e) {
  ok('B 组可执行', false, String(e && e.message))
}

// ---------------------------------------------------------------------------
// C. 外部接口不可达：回退本地，或如实说「没读到」——绝不编内容
// ---------------------------------------------------------------------------
console.log('\n[C] 接口不可达：本地兜底 / 如实 no-data（不编内容）')
try {
  const { createCloudDataPort } = cloudMod
  const { createCultureHandlers } = await imp('src/host/routes/culture.ts')
  const dead = await deadBase()

  // C1 本地有数据：回退到本地原文，一个字也不编
  {
    const port = createCloudDataPort({ local: mkLocal('本地成语'), baseUrl: dead, timeoutMs: 200 })
    const r = await capture(() => port.readCulture('chengyu'))
    ok('接口不可达 → 回退本地（不抛）', r.value[0] && r.value[0].name === '本地成语', JSON.stringify(r.value))
    ok('链路故障只留一条 CLOUD-DATA-FAIL', r.logs.filter((s) => s.includes('CLOUD-DATA-FAIL')).length === 1, JSON.stringify(r.logs))
    ok('回退的是本地原文（没有拼出额外内容）', r.value[0].text === '本地成语·chengyu', String(r.value[0].text))
  }

  // C2 本地也没有：路由如实返回 no-data，不能编一条
  {
    const dir = mkTmp('whale-culture-src-nodata-')
    const port = createCloudDataPort({ local: mkLocal('LOCAL', true), baseUrl: dead, timeoutMs: 200 })
    const handlers = createCultureHandlers({ dataDir: dir, runtimeDir: dir, dataPort: port })
    const got = await callRoute(handlers, '/api/chubby-whale/culture?type=chengyu')
    ok('云端不可达 + 本地无数据 → ok:true/item:null/reason=no-data', got && got.ok === true && got.item === null && got.reason === 'no-data', JSON.stringify(got).slice(0, 120))
  }

  // C3 本地有数据：路由把本地条目原样交出去（title/text 都来自数据）
  {
    const dir = mkTmp('whale-culture-src-local-')
    const port = createCloudDataPort({ local: mkLocal('LOCAL'), baseUrl: dead, timeoutMs: 200 })
    const handlers = createCultureHandlers({ dataDir: dir, runtimeDir: dir, dataPort: port })
    const got = await callRoute(handlers, '/api/chubby-whale/culture?type=chengyu')
    ok('路由回退本地：title 来自本地数据', got.item && got.item.title === 'LOCAL', JSON.stringify(got.item))
    ok('路由回退本地：text 来自本地数据', got.item && got.item.text === 'LOCAL·chengyu', String(got.item && got.item.text))
  }

  // C4 诗词/音乐读口同样「拿不到就如实说」：不编诗、不编曲
  {
    const dir = mkTmp('whale-culture-src-poem-')
    const { createPoemHandler } = await imp('src/host/routes/poem.ts')
    const emptyLocal = mkLocal('LOCAL', true)
    const deadPort = createCloudDataPort({ local: emptyLocal, baseUrl: dead, timeoutMs: 200 })
    const poem = createPoemHandler({ runtimeDir: dir, dataDir: dir, dataPort: deadPort })
    const pr = mkRes()
    await poem.handlePoem({ url: '/api/chubby-whale/poem' }, pr)
    const pj = pr.json()
    ok('诗词：云端不可达 + 本地无诗 → item:null + no-data（不编一首）', pj && pj.ok === true && pj.item === null && pj.reason === 'no-data', JSON.stringify(pj).slice(0, 120))

    const localPort = createCloudDataPort({ local: mkLocal('LOCAL'), baseUrl: dead, timeoutMs: 200 })
    const poem2 = createPoemHandler({ runtimeDir: mkTmp('whale-culture-src-poem2-'), dataDir: dir, dataPort: localPort })
    const pr2 = mkRes()
    await poem2.handlePoem({ url: '/api/chubby-whale/poem' }, pr2)
    const pj2 = pr2.json()
    ok('诗词：回退本地时诗句来自本地数据', pj2 && pj2.item && pj2.item.title === 'LOCAL' && pj2.item.text === 'LOCAL', JSON.stringify(pj2 && pj2.item))

    const music = createCultureHandlers({ dataDir: dir, runtimeDir: dir, dataPort: deadPort })
    const mr = mkRes()
    await music.handleMelodies({}, mr)
    const mj = mr.json()
    ok('音乐：云端不可达且无本地曲库 → ok:false + songs:[]（不编一首曲子）', mj && mj.ok === false && Array.isArray(mj.songs) && mj.songs.length === 0, JSON.stringify(mj).slice(0, 120))
  }
} catch (e) {
  ok('C 组可执行', false, String(e && e.message))
}

// ---------------------------------------------------------------------------
// D. 响应体上限：content-length 预判 / 流式越线 / 无 body 流 / 小包不误杀
// ---------------------------------------------------------------------------
console.log('\n[D] 响应体上限（内存安全）')
try {
  const { createCloudDataPort } = cloudMod
  const BASE = 'http://127.0.0.1:9/v1/'

  const MANIFEST = { version: 'v1', generatedAt: 'g1', files: [{ path: 'culture/chengyu.json' }] }
  /** 清单正常、只有文化文件走「坏回包」分支的替身 fetch */
  const dataOnly = (makeRes) => async (url) => {
    if (String(url).endsWith('/manifest.json')) {
      return { ok: true, status: 200, text: async () => JSON.stringify(MANIFEST) }
    }
    return makeRes()
  }

  // D1 声明超限：连 text() 都不该调用（一个字节都不读）
  {
    let textCalls = 0
    let cancelCalls = 0
    const port = createCloudDataPort({
      local: mkLocal('LOCAL'),
      baseUrl: BASE,
      maxBytes: 4096,
      fetchImpl: dataOnly(() => ({
        ok: true, status: 200,
        headers: { get: (k) => (String(k).toLowerCase() === 'content-length' ? '1048576' : null) },
        body: { cancel: () => { cancelCalls++; return Promise.resolve() } },
        text: async () => { textCalls++; return JSON.stringify({ items: [{ name: '不该被读', text: 'x' }] }) },
      })),
    })
    const r = await capture(() => port.readCulture('chengyu'))
    ok('content-length 声明超限 → 一个字节都不读', textCalls === 0, 'text() 调用 ' + textCalls + ' 次')
    ok('声明超限的处理：取消 body + 回退本地', cancelCalls === 1 && r.value[0].name === 'LOCAL', 'cancel ' + cancelCalls + ' 次')
    ok('超限按链路故障留痕（CLOUD-DATA-FAIL）', r.logs.some((s) => s.includes('CLOUD-DATA-FAIL')))
  }

  // D2 没有 body 流（离线替身/老运行时）：读完再按 UTF-8 字节数判
  {
    const big = JSON.stringify({ items: [{ name: '大包', text: 'x'.repeat(8192) }] })
    const port = createCloudDataPort({
      local: mkLocal('LOCAL'), baseUrl: BASE, maxBytes: 4096,
      fetchImpl: dataOnly(() => ({ ok: true, status: 200, text: async () => big })),
    })
    const r = await capture(() => port.readCulture('chengyu'))
    ok('无 body 流时按字节数判超限 → 回退本地', r.value[0].name === 'LOCAL', r.value[0] && r.value[0].name)
  }

  // D3 有 body 流但没声明长度：按流累计，越线立刻取消
  {
    let cancelled = 0
    const chunk = Buffer.from('x'.repeat(1024))
    const body = (async function* () {
      for (let i = 0; i < 64; i++) yield chunk
    })()
    body.cancel = () => { cancelled++; return Promise.resolve() }
    const port = createCloudDataPort({
      local: mkLocal('LOCAL'), baseUrl: BASE, maxBytes: 4096,
      fetchImpl: dataOnly(() => ({ ok: true, status: 200, body, text: async () => 'never' })),
    })
    const r = await capture(() => port.readCulture('chengyu'))
    ok('流式越线 → 取消 body 并回退本地', cancelled >= 1 && r.value[0].name === 'LOCAL', 'cancel ' + cancelled + ' 次 / ' + (r.value[0] && r.value[0].name))
  }

  // D4 小包不能被误杀（防止「一律回退」的假修复）
  {
    const small = JSON.stringify({ items: [{ name: '小包', text: 'ok' }] })
    const port = createCloudDataPort({
      local: mkLocal('LOCAL'), baseUrl: BASE, maxBytes: 4096,
      fetchImpl: dataOnly(() => ({
        ok: true, status: 200,
        headers: { get: () => String(Buffer.byteLength(small)) },
        text: async () => small,
      })),
    })
    const r = await capture(() => port.readCulture('chengyu'))
    ok('上限内的小包照常取云端（不误杀）', r.value[0] && r.value[0].name === '小包', JSON.stringify(r.value))
  }

  // D5 真实 HTTP（chunked 无 content-length）大包：必须在上限处收手并回退
  {
    const bigItem = { items: [{ name: '超大', text: 'x'.repeat(1024 * 1024) }] }
    const body = JSON.stringify(bigItem)
    await withServer((path, req, res) => {
      res.on('error', () => { })
      if (path === 'manifest.json') {
        res.end(JSON.stringify({ version: 'v1', generatedAt: 'g1', files: [{ path: 'culture/chengyu.json' }] }))
        return
      }
      // 故意不设 content-length：Node 自动走 chunked
      res.write(body.slice(0, 512))
      res.end(body.slice(512))
    }, async (base) => {
      const port = createCloudDataPort({ local: mkLocal('LOCAL'), baseUrl: base, maxBytes: 64 * 1024, timeoutMs: 5000 })
      const t0 = Date.now()
      const r = await capture(() => port.readCulture('chengyu'))
      const ms = Date.now() - t0
      ok('真实 HTTP 大包：在上限处收手并回退本地', r.value[0] && r.value[0].name === 'LOCAL', r.value[0] && r.value[0].name)
      ok('真实 HTTP 大包：没有把整包读完（< 2s）', ms < 2000, ms + 'ms')
    })
  }
} catch (e) {
  ok('D 组可执行', false, String(e && e.message))
}

// ---------------------------------------------------------------------------
// E. 超时：外部不回包 → 到点中止 → 回退本地（不能把宿主拖住）
// ---------------------------------------------------------------------------
console.log('\n[E] 超时（外呼必须有上限）')
try {
  const { createCloudDataPort } = cloudMod
  await withServer((path, req, res) => {
    if (path === 'manifest.json') return   // 永不回包：模拟卡死的上游
    res.end('{}')
  }, async (base) => {
    const port = createCloudDataPort({ local: mkLocal('LOCAL'), baseUrl: base, timeoutMs: 120 })
    const t0 = Date.now()
    const r = await capture(() => port.readCulture('chengyu'))
    const ms = Date.now() - t0
    ok('上游卡死 → 到点中止并回退本地', r.value[0] && r.value[0].name === 'LOCAL', r.value[0] && r.value[0].name)
    ok('中止发生在注入的超时附近（< 2s，不是 10s 死等）', ms < 2000, ms + 'ms')
    ok('超时按链路故障留痕', r.logs.some((s) => s.includes('CLOUD-DATA-FAIL')))
  })
} catch (e) {
  ok('E 组可执行', false, String(e && e.message))
}

// ---------------------------------------------------------------------------
// F. 坏回包：HTML 错误页 / 非 2xx / 空结构（数据缺失 ≠ 链路故障）
// ---------------------------------------------------------------------------
console.log('\n[F] 坏回包与数据缺失')
try {
  const { createCloudDataPort } = cloudMod
  const manifest = { version: 'v1', generatedAt: 'g1', files: [{ path: 'culture/chengyu.json' }, { path: 'daily.json' }] }

  // F1 200 + HTML 错误页：不能当 JSON 用，回退本地
  {
    let htmlServed = false
    await withServer((path, req, res) => {
      if (path === 'manifest.json') { res.end(JSON.stringify(manifest)); return }
      if (path === 'culture/chengyu.json') { htmlServed = true; res.setHeader('content-type', 'text/html'); res.end('<html><body>502 Bad Gateway</body></html>'); return }
      res.end(JSON.stringify({ items: [{ date: '2026-11-07', text: '云端每日' }] }))
    }, async (base) => {
      const port = createCloudDataPort({ local: mkLocal('LOCAL'), baseUrl: base, timeoutMs: 3000 })
      const r = await capture(() => port.readCulture('chengyu'))
      ok('200 + HTML 错误页：回退本地，不抛', htmlServed && r.value[0] && r.value[0].name === 'LOCAL', r.value[0] && r.value[0].name)
      ok('HTML 错误页按链路故障留痕', r.logs.some((s) => s.includes('CLOUD-DATA-FAIL')))
    })
  }

  // F2 非 2xx：回退本地
  {
    await withServer((path, req, res) => {
      if (path === 'manifest.json') { res.end(JSON.stringify(manifest)); return }
      res.statusCode = 503
      res.end('down')
    }, async (base) => {
      const port = createCloudDataPort({ local: mkLocal('LOCAL'), baseUrl: base, timeoutMs: 3000 })
      const r = await capture(() => port.readCulture('chengyu'))
      ok('503 → 回退本地，不抛', r.value[0] && r.value[0].name === 'LOCAL', r.value[0] && r.value[0].name)
    })
  }

  // F3 结构为空：算「数据缺失」，静默回退且**不进冷却**（别的读口还能走云端）
  {
    const asked = []
    await withServer((path, req, res) => {
      asked.push(path)
      if (path === 'manifest.json') { res.end(JSON.stringify(manifest)); return }
      if (path === 'culture/chengyu.json') { res.end(JSON.stringify({ items: 'not-an-array' })); return }
      res.end(JSON.stringify({ items: [{ date: '2026-11-07', text: '云端每日' }] }))
    }, async (base) => {
      const port = createCloudDataPort({ local: mkLocal('LOCAL'), baseUrl: base, timeoutMs: 3000 })
      const cul = await capture(() => port.readCulture('chengyu'))
      ok('结构为空 → 回退本地', cul.value[0] && cul.value[0].name === 'LOCAL')
      ok('数据缺失不刷 CLOUD-DATA-FAIL', cul.logs.filter((s) => s.includes('CLOUD-DATA-FAIL')).length === 0)
      const day = await port.readDaily()
      ok('数据缺失不进冷却：每日仍走云端', day[0] && day[0].text === '云端每日' && asked.indexOf('daily.json') >= 0)
    })
  }

  // F4 回包中途断连：不能变成未捕获异常
  {
    await withServer((path, req, res) => {
      if (path === 'manifest.json') { res.end(JSON.stringify(manifest)); return }
      res.write('{"items":[')
      setTimeout(() => { try { res.destroy() } catch { } }, 10)
    }, async (base) => {
      const port = createCloudDataPort({ local: mkLocal('LOCAL'), baseUrl: base, timeoutMs: 3000 })
      const r = await capture(() => port.readCulture('chengyu'))
      ok('回包中途断连 → 回退本地（无未捕获异常）', r.value[0] && r.value[0].name === 'LOCAL', r.value[0] && r.value[0].name)
    })
  }
} catch (e) {
  ok('F 组可执行', false, String(e && e.message))
}

// ---------------------------------------------------------------------------
// G. 路由层并发：同时点两次「来个典故」
// ---------------------------------------------------------------------------
console.log('\n[G] 路由层并发（同时两次点击）')
try {
  const { createCloudDataPort } = cloudMod
  const { createCultureHandlers } = await imp('src/host/routes/culture.ts')
  const asked = []
  await withServer((path, req, res) => {
    asked.push(path)
    if (path === 'manifest.json') { res.end(JSON.stringify({ version: 'v1', generatedAt: 'g1', files: [{ path: 'culture/chengyu.json' }] })); return }
    if (path === 'culture/chengyu.json') { res.end(JSON.stringify({ items: [{ name: '一鼓作气', text: '甲' }, { name: '亡羊补牢', text: '乙' }] })); return }
    res.end('{}')
  }, async (base) => {
    const dir = mkTmp('whale-culture-src-conc-')
    const port = createCloudDataPort({ local: mkLocal('LOCAL'), baseUrl: base, timeoutMs: 3000 })
    const handlers = createCultureHandlers({ dataDir: dir, runtimeDir: dir, dataPort: port })
    const [x, y] = await Promise.all([
      callRoute(handlers, '/api/chubby-whale/culture?type=chengyu'),
      callRoute(handlers, '/api/chubby-whale/culture?type=chengyu'),
    ])
    ok('并发两次都拿到 ok + item', x.ok === true && y.ok === true && !!x.item && !!y.item)
    ok('并发两次不重样（各自记 seen）', x.item.title !== y.item.title, x.item.title + ' / ' + y.item.title)
    ok('并发两次只外呼一次数据文件', asked.filter((p) => p === 'culture/chengyu.json').length === 1, '请求 ' + asked.filter((p) => p === 'culture/chengyu.json').length + ' 次')
  })
} catch (e) {
  ok('G 组可执行', false, String(e && e.message))
}

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------
for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }) } catch { } }
console.log('\n合计：通过 ' + pass + ' 项，失败 ' + fail + ' 项')
if (fail > 0) {
  console.error('❌ 文化外呼链路回归未通过')
  process.exitCode = 1
} else {
  console.log('✅ 文化外呼链路回归全部通过（离线，只连 127.0.0.1）')
}
