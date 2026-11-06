/**
 * scripts/test-host-http.mjs —— B89 宿主 HTTP 层专项回归（http.ts / body.ts / respond.ts）
 *
 * 覆盖：超限（声明 / 流式 / 硬上限）、413 能否真的送达、坏 JSON、BOM、无 content-type、
 * 读流中断（EOF 早断）、HEAD 语义、重复写、错误对象脱敏、超时/超限判定。
 *
 * 用法：node scripts/test-host-http.mjs
 *   · 单独运行，不改 package.json 与 scripts/test.mjs（与 test-*.mjs 的既有约定一致）；
 *   · 只起 127.0.0.1 的临时端口，不联网、不读真实运行数据；
 *   · 真实 socket 用例都在 4s 内超时收口，不会挂住测试进程。
 */

import { register } from 'node:module'
import http from 'node:http'

register(new URL('./ts-resolve.mjs', import.meta.url))

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

const H = await import('../src/host/http.ts')
const B = await import('../src/host/body.ts')
const R = await import('../src/host/respond.ts')
const { readBody, isBodyTooLarge, isTimeoutError, sendTooLarge } = H
const { readJsonBody } = B
const { sendJson, sendError, sendText, sendBuffer, sendSseHeaders } = R

// ---------- 假请求 / 假响应（单元级） ----------

/** 假请求：按 chunk 产出；可选在读完第 N 个后抛读流错误；记录 destroy/resume 是否被调用 */
function fakeReq({ chunks = [], headers = {}, throwAt = -1 } = {}) {
  const state = { destroyed: 0, resumed: 0, listeners: 0, pulled: 0 }
  const req = {
    headers,
    state,
    on() { state.listeners++ },
    destroy() { state.destroyed++ },
    resume() { state.resumed++ },
    async *[Symbol.asyncIterator]() {
      state.pulled++
      for (let i = 0; i < chunks.length; i++) {
        if (i === throwAt) break
        yield Buffer.isBuffer(chunks[i]) ? chunks[i] : Buffer.from(String(chunks[i]))
      }
      if (throwAt >= 0 && throwAt <= chunks.length) {
        const e = new Error('aborted')
        e.code = 'ECONNRESET'
        throw e
      }
    },
  }
  return req
}

/** 假响应：像 Node 一样维护 headersSent / writableEnded，记录写入次数 */
function fakeRes() {
  const res = {
    code: 0,
    headers: null,
    body: '',
    endCalls: 0,
    headersSent: false,
    writableEnded: false,
    writeHead(c, h) { res.code = c; res.headers = h || {}; res.headersSent = true },
    end(b) {
      res.endCalls++
      res.writableEnded = true
      if (b !== undefined) res.body += typeof b === 'string' ? b : Buffer.from(b).toString('utf8')
    },
    json() { try { return JSON.parse(res.body) } catch { return null } },
  }
  return res
}

/** readBody 抛错时把错误接住，返回 {error} */
async function catchErr(fn) {
  try { await fn(); return { threw: false } } catch (e) { return { threw: true, error: e } }
}

// ---------- 1. readBody：上限、双保险、drain 与断连 ----------
console.log('\n[1] readBody：体积上限 / content-length 与实际流双保险')

const small = fakeReq({ chunks: ['{"a":1}'], headers: { 'content-length': '7' } })
ok('正常：原样读回字节', (await readBody(small, 1024)).toString('utf8') === '{"a":1}')

const declaredHuge = fakeReq({ chunks: ['x'], headers: { 'content-length': String(2 * 1024 * 1024) } })
const hugeErr = await catchErr(() => readBody(declaredHuge, 1024))
ok('声明 2MB > 上限：抛 BODY_TOO_LARGE', hugeErr.threw && isBodyTooLarge(hugeErr.error))
ok('声明超限：一个字节都不读（既有语义：不读流、不落盘）', declaredHuge.state.pulled === 0, 'pulled=' + declaredHuge.state.pulled)
ok('声明超限：不 destroy（路由的 413 才送得出去，连接交给 connection:close）', declaredHuge.state.destroyed === 0,
  'destroy=' + declaredHuge.state.destroyed)

const streamOver = fakeReq({ chunks: ['x'.repeat(600), 'x'.repeat(600), 'x'.repeat(600)] })
const streamErr = await catchErr(() => readBody(streamOver, 1024))
ok('流式 1800 > 上限 1024（预算内）：抛 BODY_TOO_LARGE', streamErr.threw && isBodyTooLarge(streamErr.error))
ok('预算内超限不 destroy（先读空，413 才送得出去）', streamOver.state.destroyed === 0, 'destroy=' + streamOver.state.destroyed)

const beyondBudget = fakeReq({ chunks: ['x'.repeat(600), 'x'.repeat(1100000)] })
const beyondErr = await catchErr(() => readBody(beyondBudget, 1024))
ok('超出丢弃预算（> 上限+1MB）：抛错并断连', beyondErr.threw && isBodyTooLarge(beyondErr.error) && beyondBudget.state.destroyed === 1,
  'destroy=' + beyondBudget.state.destroyed)

const eof = fakeReq({ chunks: ['{"a"'], throwAt: 1 })
const eofErr = await catchErr(() => readBody(eof, 1024))
ok('EOF 早断：读流错误向上抛（不静默给半截数据）', eofErr.threw && eofErr.error.code === 'ECONNRESET', String(eofErr.error && eofErr.error.code))

ok('isBodyTooLarge：只认 BODY_TOO_LARGE', isBodyTooLarge({ code: 'BODY_TOO_LARGE' }) === true && isBodyTooLarge(new Error('x')) === false)
ok('isTimeoutError：TimeoutError / AbortError', isTimeoutError({ name: 'TimeoutError' }) && isTimeoutError({ name: 'AbortError' }) && !isTimeoutError({ name: 'TypeError' }))

// ---------- 2. readJsonBody：坏 JSON / 空体 / BOM / content-type / 超限 ----------
console.log('\n[2] readJsonBody：坏 JSON / 空体 / BOM / 无 content-type')

const badJson = fakeReq({ chunks: ['not json at all'], headers: {} })
const bad = await readJsonBody(badJson, 1024)
ok('坏 JSON：不抛，body 退化成 {}（既有约定，路由各自回 400）', bad.ok === true && JSON.stringify(bad.body) === '{}')
ok('坏 JSON：text 仍保留原文（供调用方复验/报错）', bad.text === 'not json at all')

const emptyBody = await readJsonBody(fakeReq({ chunks: [] }), 1024)
ok('空体：body = {}，text = ""', emptyBody.ok === true && emptyBody.text === '' && JSON.stringify(emptyBody.body) === '{}')

const bomReq = fakeReq({ chunks: [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')])] })
const bom = await readJsonBody(bomReq, 1024)
ok('带 UTF-8 BOM：照常解析成 {a:1}（修复前是 body={}）', bom.ok === true && bom.body && bom.body.a === 1)
ok('带 BOM：text 已剥掉 U+FEFF', bom.text === '{"a":1}')

const noType = fakeReq({ chunks: ['{"b":2}'], headers: {} })
const noTypeParsed = await readJsonBody(noType, 1024)
ok('无 content-type：照常按 JSON 解析（本插件内部接口的既有约定，不 415）', noTypeParsed.ok === true && noTypeParsed.body.b === 2)

const overLimit = await readJsonBody(fakeReq({ chunks: ['x'.repeat(2000)] }), 1024)
ok('超限：返回 {ok:false,tooLarge:true}（不抛）', overLimit.ok === false && overLimit.tooLarge === true)

const arrayBody = await readJsonBody(fakeReq({ chunks: ['[1,2]'] }), 1024)
ok('顶层数组：照实解析（由调用方判形状）', arrayBody.ok === true && Array.isArray(arrayBody.body) && arrayBody.body.length === 2)

const readFail = await catchErr(() => readJsonBody(fakeReq({ chunks: ['{"x"'], throwAt: 1 }), 1024))
ok('读流错误：继续向上抛（不折成空 body）', readFail.threw && readFail.error.code === 'ECONNRESET')

// ---------- 3. respond：状态码 / 脱敏 / 重复写 ----------
console.log('\n[3] sendJson / sendError / sendTooLarge：响应头 / 错误脱敏 / 二次写')

const r1 = fakeRes()
sendJson(r1, { ok: true, n: 1 })
ok('sendJson：200 + application/json; charset=utf-8', r1.code === 200 && /^application\/json/.test(r1.headers['content-type']) && r1.body === '{"ok":true,"n":1}')

const r2 = fakeRes()
sendError(r2, { message: 'boom' }, { reply: '兜底' })
const e2 = r2.json()
ok('sendError：{ok:false,error:message,...extra}，默认 200',
  r2.code === 200 && e2.ok === false && e2.error === 'boom' && e2.reply === '兜底')

const secretErr = new Error('boom')
secretErr.stack = 'Error: boom\n  at C:\\Users\\someone\\secret-project\\src\\index.ts:1:1'
secretErr.code = 'EACCES'
secretErr.path = 'C:\\Users\\someone\\secret-project\\data\\state.json'
secretErr.apiKey = 'sk-should-not-leak'
const r3 = fakeRes()
sendError(r3, secretErr, { reply: 'x' })
const e3 = r3.json()
ok('错误脱敏：只回 message，不带 stack/code/path/apiKey',
  Object.keys(e3).sort().join(',') === 'error,ok,reply' &&
  !JSON.stringify(e3).includes('secret-project') &&
  !JSON.stringify(e3).includes('sk-should-not-leak') &&
  e3.stack === undefined && e3.code === undefined && e3.path === undefined,
  JSON.stringify(e3))

const r4 = fakeRes()
sendTooLarge(r4)
ok('sendTooLarge：413 + JSON + connection:close + {error:"too large"}',
  r4.code === 413 && r4.headers.connection === 'close' && r4.json().error === 'too large' && r4.json().ok === false)

const r5 = fakeRes()
sendJson(r5, { n: 1 })
let doubleThrew = false
try { sendJson(r5, { n: 2 }) } catch { doubleThrew = true }
ok('重复写：第二次 sendJson 不抛、也不再写（保住第一份响应）',
  doubleThrew === false && r5.endCalls === 1 && r5.body === '{"n":1}', 'endCalls=' + r5.endCalls)

const r6 = fakeRes()
sendJson(r6, { n: 1 })
sendText(r6, 500, 'late')
sendBuffer(r6, Buffer.from('late'), 'audio/mpeg')
sendSseHeaders(r6)
ok('已回包后 sendText/sendBuffer/sendSseHeaders 都是 no-op（不抛 ERR_HTTP_HEADERS_SENT）',
  r6.endCalls === 1 && r6.code === 200 && r6.body === '{"n":1}')

// ---------- 4. 真实 socket：413 真的送到客户端 / HEAD 无 body / 不二次写 ----------
console.log('\n[4] 真实 HTTP：超限 413 送达 / HEAD / 重复写')

const handlerErrors = []
const routes = new Map()
const server = http.createServer((req, res) => {
  const path = String(req.url || '/').split('?')[0]
  const h = routes.get(path)
  if (!h) { res.writeHead(404); res.end(); return }
  Promise.resolve(h(req, res)).catch((e) => {
    handlerErrors.push(String((e && e.message) || e))
    try { res.end() } catch { }
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const LIMIT = 1024
routes.set('/limit', async (req, res) => {
  const parsed = await readJsonBody(req, LIMIT)
  if (!parsed.ok) { sendTooLarge(res); return }
  sendJson(res, { ok: true, len: parsed.text.length })
})
routes.set('/head', (_req, res) => sendJson(res, { ok: true, big: 'x'.repeat(50) }))
routes.set('/bom', async (req, res) => {
  const parsed = await readJsonBody(req, LIMIT)
  sendJson(res, { ok: parsed.ok, body: parsed.ok ? parsed.body : null })
})
routes.set('/double', (_req, res) => {
  sendJson(res, { n: 1 })
  sendJson(res, { n: 2 })
})

/** 原始请求：可指定声明长度、分块慢发、半关；4s 收口 */
function request(path, { method = 'POST', headers = {}, chunks = [], gapMs = 5 } = {}) {
  return new Promise((resolve) => {
    const out = { status: 0, body: '', err: null }
    let settled = false
    const done = (extra) => { if (!settled) { settled = true; clearTimeout(timer); resolve(Object.assign(out, extra || {})) } }
    const timer = setTimeout(() => { try { req.destroy() } catch { } ; done({ err: out.err || 'timeout' }) }, 4000)
    const req = http.request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      out.status = res.statusCode
      res.setEncoding('utf8')
      res.on('data', (d) => { out.body += d })
      res.on('end', () => done())
      res.on('error', (e) => done({ err: e.code || e.message }))
    })
    req.on('error', (e) => done({ err: e.code || e.message }))
    let i = 0
    const step = () => {
      if (i >= chunks.length) { try { req.end() } catch { } ; return }
      try { req.write(chunks[i]) } catch { }
      i++
      setTimeout(step, gapMs)
    }
    step()
  })
}

const declaredOver = await request('/limit', {
  headers: { 'content-type': 'application/json', 'content-length': String(5000) },
  chunks: ['x'.repeat(5000)],
})
ok('声明 5000 > 上限 1024（预算内）：客户端真的收到 413（修复前是 ECONNRESET）',
  declaredOver.status === 413 && !!declaredOver.body && JSON.parse(declaredOver.body).error === 'too large',
  'status=' + declaredOver.status + ' err=' + declaredOver.err)

const chunkedOver = await request('/limit', {
  headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
  chunks: ['x'.repeat(600), 'x'.repeat(600), 'x'.repeat(600)],
})
ok('chunked 1800 > 上限 1024（预算内）：客户端也收到 413',
  chunkedOver.status === 413 && JSON.parse(chunkedOver.body || '{}').ok === false,
  'status=' + chunkedOver.status + ' err=' + chunkedOver.err)

const hardOver = await request('/limit', {
  headers: { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024) },
  chunks: ['x'.repeat(100)],
})
ok('声明 2MB 但只发 100 字节：不读流也能回 413（不用等对方传完）',
  hardOver.status === 413 && JSON.parse(hardOver.body || '{}').error === 'too large',
  'status=' + hardOver.status + ' err=' + hardOver.err + ' body=' + hardOver.body)

const bomRes = await request('/bom', {
  headers: { 'content-type': 'application/json' },
  chunks: [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')])],
})
ok('真实请求带 UTF-8 BOM：服务端照常解析成 {a:1}',
  bomRes.status === 200 && JSON.stringify(JSON.parse(bomRes.body || '{}').body) === '{"a":1}', 'body=' + bomRes.body)

const headRes = await request('/head', { method: 'HEAD', headers: {} })
ok('HEAD：200 但 body 为空（Node 不为 HEAD 写体）', headRes.status === 200 && headRes.body === '' && !headRes.err,
  'status=' + headRes.status + ' body=' + JSON.stringify(headRes.body))
const getRes = await request('/head', { method: 'GET', headers: {} })
ok('同一路径 GET：body 正常', getRes.status === 200 && getRes.body === JSON.stringify({ ok: true, big: 'x'.repeat(50) }))

const doubleRes = await request('/double', { method: 'GET', headers: {} })
ok('真实响应重复写：不发生 ERR_HTTP_HEADERS_SENT，客户端拿到第一份响应',
  doubleRes.status === 200 && doubleRes.body === '{"n":1}' && handlerErrors.length === 0,
  'body=' + doubleRes.body + ' handlerErrors=' + JSON.stringify(handlerErrors))

// ---------- 收尾 ----------
try { server.closeAllConnections() } catch { }
await new Promise((resolve) => server.close(resolve))

console.log('\n────────────────────')
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项')
if (fail > 0) process.exit(1)
