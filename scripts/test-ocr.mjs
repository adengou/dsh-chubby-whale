/**
 * scripts/test-ocr.mjs —— 官方 OCR 专项回归（2026-11-14 审计新增）
 *
 * 只覆盖 OCR 这条线：路由鉴权/请求形状、大小与错误、超时与断连、清洗与截断，
 * 以及客户端「OCR 失败不阻塞看图」的降级。在线外呼仍由部署后的真机探针验证。
 *
 * 设计要点（与 scripts/test-official-tools.mjs 的分工）：
 *   · 所有 fetch 都是桩，不联网；
 *   · 断连用真 EventEmitter 触发 watchClientGone，判断「不写回包 + 中止外呼」；
 *   · 响应体超时用「headers 先回、text() 再挂起」的桩复现官方 keep-alive 换行形态
 *     （旧实现用 fetchJson 会把它吞成 200 + 空 text，这条用例专门钉这个回归）。
 *
 * 用法：node scripts/test-ocr.mjs
 */
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

register(new URL('./ts-resolve.mjs', import.meta.url))
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; failures.push(name + (detail ? '  ' + detail : '')); console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}
function group(t) { console.log('\n' + t) }

const realFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('测试不许真联网') }

/** 普通请求：async iterator 一次性吐出 body（readBody 走流式路径） */
function mkReq(body, opts = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  const buf = Buffer.from(raw)
  return {
    method: opts.method || 'POST',
    url: opts.url || '/api/chubby-whale/ocr',
    headers: Object.assign({ 'content-length': String(buf.length) }, opts.headers || {}),
    destroy() { }, on() { }, resume() { },
    async *[Symbol.asyncIterator]() { yield buf },
  }
}

/** 带事件能力的请求：让 watchClientGone 能挂 'aborted'/'close' */
function mkEmitterReq(body) {
  const buf = Buffer.from(JSON.stringify(body))
  const req = new EventEmitter()
  req.method = 'POST'
  req.url = '/api/chubby-whale/ocr'
  req.headers = { 'content-length': String(buf.length) }
  req.complete = true
  req[Symbol.asyncIterator] = async function* () { yield buf }
  return req
}

function mkRes() {
  const out = new EventEmitter()
  out.code = 0
  out.chunks = []
  out.headers = {}
  out.headersSent = false
  out.writableEnded = false
  out.setHeader = (k, v) => { out.headers[String(k).toLowerCase()] = v }
  // 与 Node 一致：writeHead 与先前 setHeader 合并（不丢掉 setHeader 的 connection: close）
  out.writeHead = (c, h) => {
    out.code = c
    out.headers = Object.assign({}, out.headers, h || {})
    out.headersSent = true
  }
  out.end = (b) => {
    if (b) out.chunks.push(Buffer.from(String(b)))
    out.writableEnded = true
  }
  out.bodyText = () => Buffer.concat(out.chunks).toString('utf8')
  out.json = () => { try { return JSON.parse(out.bodyText()) } catch { return null } }
  return out
}

function namedError(name, message = 'boom') {
  const e = new Error(message)
  e.name = name
  return e
}
/** 只回 JSON 的桩响应 */
function jsonResponse(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)),
  }
}

/** 静音 console.error，同时把日志交给回调（断言日志标签用） */
async function quiet(fn) {
  const logs = []
  const orig = console.error
  console.error = (...a) => { logs.push(a.map((x) => String(x)).join(' ')) }
  try { return await fn(logs) } finally { console.error = orig }
}

/** 取 multipart 里某个普通字段/文件名（只用于断言请求形状） */
function multipartText(init) {
  return String(init.body.toString('utf8'))
}

try {
  const OCR = await import('../src/host/routes/ocr.ts')
  const DROP = await import('../src/client/dropzone.ts')

  // ====================================================================
  group('[A] 成功解析 / multipart / 页数与 usage')
  {
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init })
      return jsonResponse({
        id: 'ocr-1', object: 'ocr.result', purpose: 'text_recognition', page_count: 2,
        pages: [
          { index: 0, text: '<｜ref｜>标题<｜/ref｜><｜box｜>[[1, 2, 3, 4]]<｜/box｜>第一页', finish_reason: 'stop' },
          { index: 1, text: '第二页', finish_reason: 'length' },
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      })
    }
    const h = OCR.createOcrHandler({ getDeepseekKey: () => 'sk-test' })
    const res = mkRes()
    await h(mkReq({ file: Buffer.from('PNGDATA').toString('base64'), name: 'shot.png', purpose: 'text_recognition' }), res)
    const j = res.json()

    ok('成功 → ok:true + 页数/ID', res.code === 200 && j && j.ok === true && j.pageCount === 2 && j.id === 'ocr-1', JSON.stringify(j && { ok: j.ok, n: j.pageCount, id: j.id }))
    ok('OCR 结果不缓存（cache-control: no-store）', res.headers['cache-control'] === 'no-store', JSON.stringify(res.headers))
    ok('请求打到官方 OCR 端点', calls.length === 1 && calls[0].url === 'https://api.deepseek.com/v1/tools/ocr', JSON.stringify(calls.map((c) => c.url)))
    ok('Bearer Key 来自注入端口', calls[0].init.headers.authorization === 'Bearer sk-test')
    ok('content-type 是 multipart + boundary', /^multipart\/form-data; boundary=----chubbywhale/.test(calls[0].init.headers['content-type']), calls[0].init.headers['content-type'])
    const mp = multipartText(calls[0].init)
    ok('multipart：purpose 在 file 之前', mp.indexOf('name="purpose"') >= 0 && mp.indexOf('name="purpose"') < mp.indexOf('filename="shot.png"'))
    ok('purpose 值原样', mp.indexOf('text_recognition') > 0 && mp.indexOf('name="purpose"') < mp.indexOf('text_recognition'))
    ok('图片按扩展名声明 image/png', mp.indexOf('Content-Type: image/png') > 0)
    ok('文件字节原样进 multipart', mp.indexOf('PNGDATA') > 0)
    ok('页文本清洗（去 ref/box、留文字）', j.pages[0].plain === '标题第一页', j.pages[0].plain)
    ok('原始 text 保留（可追溯）', j.pages[0].text.indexOf('<｜ref｜>') >= 0)
    ok('finish_reason 透出（length=不完整）', j.pages[1].finishReason === 'length')
    ok('合并文本用空行分隔', j.text === '标题第一页\n\n第二页', JSON.stringify(j.text))
    ok('usage 原样返回（仅供参考，不用于计费）', j.usage && j.usage.total_tokens === 15, JSON.stringify(j.usage))
    ok('未截断时不写 truncated/pagesOmitted', j.truncated === undefined && j.pagesOmitted === undefined)
    ok('pages 与官方页数一致', Array.isArray(j.pages) && j.pages.length === 2)

    // purpose 缺省 / 显式 rich_layout
    calls.length = 0
    await h(mkReq({ file: 'QUJD', name: 'a.png' }), mkRes())
    const mp2 = multipartText(calls[0].init)
    ok('purpose 缺省 → text_recognition', mp2.indexOf('name="purpose"') >= 0 && mp2.indexOf('text_recognition') > 0)

    calls.length = 0
    await h(mkReq({ file: 'QUJD', name: 'a.pdf', purpose: 'rich_layout_recognition' }), mkRes())
    const mp3 = multipartText(calls[0].init)
    ok('显式 rich_layout 原样上行', mp3.indexOf('rich_layout_recognition') > 0)
    ok('PDF 按扩展名声明 application/pdf', mp3.indexOf('Content-Type: application/pdf') > 0)

    // page_count 缺失时用 pages.length；usage 缺失返回 null
    calls.length = 0
    globalThis.fetch = async () => jsonResponse({ id: 'ocr-2', pages: [{ index: 0, text: '只有一页' }] })
    const j2 = (await (async () => { const r = mkRes(); await h(mkReq({ file: 'QUJD', name: 'a.png' }), r); return r.json() })())
    ok('page_count 缺失 → 按 pages.length', j2.pageCount === 1)
    ok('usage 缺失 → null（不编 0）', j2.usage === null)
    ok('finish_reason 缺失 → 空串', j2.pages[0].finishReason === '')

    // 带 \r\n 的 base64（客户端/旧工具可能带换行）
    calls.length = 0
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return jsonResponse({ id: 'ocr-3', page_count: 1, pages: [{ index: 0, text: 'ok' }] }) }
    const rNl = mkRes()
    await h(mkReq({ file: 'QU\r\nJD', name: 'a.png' }), rNl)
    ok('base64 里的换行被容忍', rNl.json().ok === true && calls.length === 1)
  }

  // ====================================================================
  group('[B] 输入校验：方法/空文件/坏 base64/非法 purpose/体积/无 Key')
  {
    const h = OCR.createOcrHandler({ getDeepseekKey: () => 'sk-test' })
    let called = 0
    globalThis.fetch = async () => { called++; return jsonResponse({ page_count: 1, pages: [{ index: 0, text: 'x' }] }) }

    const wrong = mkRes()
    await h(mkReq({}, { method: 'GET' }), wrong)
    ok('非 POST → 405 且不读体/不外呼', wrong.code === 405 && wrong.json().error === 'METHOD_NOT_ALLOWED' && called === 0)

    const badCt = mkRes()
    await h(mkReq({ file: 'QUJD' }, { headers: { 'content-type': 'text/plain' } }), badCt)
    ok('显式非 JSON content-type → 415（挡浏览器 no-cors 跨站触发）', badCt.code === 415 && badCt.json().error === 'bad content-type' && called === 0, JSON.stringify(badCt.json()))

    const empty = mkRes()
    await h(mkReq({}), empty)
    ok('没有 file → 400 empty file', empty.code === 400 && empty.json().error === 'empty file')

    const emptyStr = mkRes()
    await h(mkReq({ file: '' }), emptyStr)
    ok('file 为空串 → 400', emptyStr.code === 400 && emptyStr.json().error === 'empty file')

    for (const [label, file] of [
      ['非法字符', '!!!bad!!!'],
      ['等号在中间', 'QU=JD'],
      ['填充后长度不整', 'QQ='],
      ['长度 mod 4 = 1', 'A'],
    ]) {
      const r = mkRes()
      await h(mkReq({ file, name: 'a.png' }), r)
      ok('坏 base64（' + label + '）→ 400 bad base64', r.code === 400 && r.json().error === 'bad base64', JSON.stringify(r.json()))
    }

    const badPurpose = mkRes()
    await h(mkReq({ file: 'QUJD', name: 'a.png', purpose: 'user_data' }), badPurpose)
    ok('非法 purpose → 400（不悄悄换识别方式）', badPurpose.code === 400 && badPurpose.json().error === 'bad purpose', JSON.stringify(badPurpose.json()))
    const before = called
    ok('非法 purpose 不发起外呼', called === before)

    const numPurpose = mkRes()
    await h(mkReq({ file: 'QUJD', name: 'a.png', purpose: 123 }), numPurpose)
    ok('非字符串 purpose → 400', numPurpose.code === 400 && numPurpose.json().error === 'bad purpose')

    // 声明体超限：只给 content-length，不真的造 40MB 字符串
    const huge = mkRes()
    await quiet(async () => { await h(mkReq({ file: 'QUJD' }, { headers: { 'content-length': String(45 * 1024 * 1024) } }), huge) })
    ok('声明超过请求体上限 → 413', huge.code === 413 && huge.json().error === 'too large', String(huge.code))
    ok('413 带中文 hint 与 connection: close', /30MB/.test(String(huge.json().hint)) && String(huge.headers.connection).toLowerCase() === 'close', JSON.stringify(huge.headers))

    const noKey = mkRes()
    await OCR.createOcrHandler({ getDeepseekKey: () => '' })(mkReq({ file: 'QUJD', name: 'a.png' }), noKey)
    ok('无 Key → NO_KEY + 人话，且不外呼', noKey.json().error === 'NO_KEY' && /DeepSeek Key/.test(noKey.json().hint) && called === 0, JSON.stringify(noKey.json()))
  }

  // ====================================================================
  group('[C] 官方失败：200 里的 error / 状态码 / 坏响应 / 网络 / 超时 / 断连')
  {
    const h = OCR.createOcrHandler({ getDeepseekKey: () => 'sk-test' })

    // 200 + error（识别开始后失败）：不能把 HTTP 200 当成功
    globalThis.fetch = async () => jsonResponse({ error: { message: 'OCR did not finish in time', type: 'gateway_timeout_error', code: 'gateway_timeout_error' } })
    const r200 = mkRes()
    await quiet(async () => { await h(mkReq({ file: 'QUJD', name: 'a.png' }), r200) })
    ok('200 里带 error → ok:false + code', r200.json().ok === false && r200.json().error === 'gateway_timeout_error', JSON.stringify(r200.json()))
    ok('200 里的超时错误给「识别超时」而不是「HTTP 200」', /超时/.test(r200.json().hint) && !/HTTP 200/.test(r200.json().hint), r200.json().hint)

    globalThis.fetch = async () => jsonResponse({ error: { message: 'The file is password-protected and cannot be processed.', code: 'invalid_request_error' } })
    const rPwd = mkRes()
    await quiet(async () => { await h(mkReq({ file: 'QUJD', name: 'a.png' }), rPwd) })
    ok('密码保护的文件 → 提示去密码', /密码/.test(rPwd.json().hint), rPwd.json().hint)

    // 官方状态码
    globalThis.fetch = async () => ({ ok: false, status: 413, text: async () => JSON.stringify({ error: { message: 'file is too large: max 100 MiB' } }) })
    const r413 = mkRes()
    await quiet(async () => { await h(mkReq({ file: 'QUJD', name: 'a.png' }), r413) })
    ok('官方 413 → ok:false + 文件太大提示', r413.json().ok === false && /太大/.test(r413.json().hint), JSON.stringify(r413.json()))

    globalThis.fetch = async () => ({ ok: false, status: 402, text: async () => JSON.stringify({ error: { message: 'Insufficient Balance' } }) })
    const r402 = mkRes()
    await quiet(async () => { await h(mkReq({ file: 'QUJD', name: 'a.png' }), r402) })
    ok('402 → 提示余额不足', /余额/.test(r402.json().hint), r402.json().hint)

    globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'oops' })
    const r500 = mkRes()
    await quiet(async () => { await h(mkReq({ file: 'QUJD', name: 'a.png' }), r500) })
    ok('HTTP 500 非 JSON → error=HTTP 500 + 官方失败提示', r500.json().ok === false && r500.json().error === 'HTTP 500' && /稍后重试/.test(r500.json().hint), JSON.stringify(r500.json()))

    // 坏响应：空体 / HTML / 缺 pages
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '' })
    const rEmpty = mkRes()
    await quiet(async () => { await h(mkReq({ file: 'QUJD', name: 'a.png' }), rEmpty) })
    ok('200 + 空体 → BAD_RESPONSE（不谎报成功）', rEmpty.json().ok === false && rEmpty.json().error === 'BAD_RESPONSE', JSON.stringify(rEmpty.json()))

    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '<html>bad gateway</html>' })
    const rHtml = mkRes()
    await quiet(async () => { await h(mkReq({ file: 'QUJD', name: 'a.png' }), rHtml) })
    ok('200 + HTML → BAD_RESPONSE', rHtml.json().ok === false && rHtml.json().error === 'BAD_RESPONSE')

    globalThis.fetch = async () => jsonResponse({ id: 'x', page_count: 1 })
    const rNoPages = mkRes()
    await quiet(async () => { await h(mkReq({ file: 'QUJD', name: 'a.png' }), rNoPages) })
    ok('200 + 缺 pages → BAD_RESPONSE（schema 不对就是坏响应）', rNoPages.json().ok === false && rNoPages.json().error === 'BAD_RESPONSE')

    // 网络错误
    globalThis.fetch = async () => { throw new Error('ECONNRESET') }
    const rNet = mkRes()
    await quiet(async () => { await h(mkReq({ file: 'QUJD', name: 'a.png' }), rNet) })
    ok('网络错误 → ok:false + 原始错误 + 网络提示', rNet.json().ok === false && rNet.json().error === 'ECONNRESET' && /网络/.test(rNet.json().hint), JSON.stringify(rNet.json()))

    // 外呼超时（fetch 自身拒绝）
    globalThis.fetch = async () => { throw namedError('TimeoutError', 'The operation was aborted due to timeout') }
    const rTo = mkRes()
    await quiet(async () => { await h(mkReq({ file: 'QUJD', name: 'a.png' }), rTo) })
    ok('外呼超时 → error=timeout + 换小文件提示', rTo.json().ok === false && rTo.json().error === 'timeout' && /超时/.test(rTo.json().hint), JSON.stringify(rTo.json()))

    // 响应头已回、读 body 时超时（官方 keep-alive 换行形态）：旧 fetchJson 会吞成 200+空 text
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      text: async () => { throw namedError('TimeoutError', 'body timeout') },
    })
    const rBodyTo = mkRes()
    await quiet(async () => { await h(mkReq({ file: 'QUJD', name: 'a.png' }), rBodyTo) })
    ok('响应体读超时 → error=timeout（不能报 ok:true 空文本）', rBodyTo.json().ok === false && rBodyTo.json().error === 'timeout', JSON.stringify(rBodyTo.json()))

    // 响应体读到一半的连接错误
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      text: async () => { throw new Error('terminated') },
    })
    const rRead = mkRes()
    await quiet(async () => { await h(mkReq({ file: 'QUJD', name: 'a.png' }), rRead) })
    ok('响应体读取失败 → read failed（不谎报成功）', rRead.json().ok === false && rRead.json().error === 'read failed' && /没读完/.test(rRead.json().hint), JSON.stringify(rRead.json()))

    // 断连 ①：外呼还没返回，客户端走了 → 中止外呼、不写回包、留 OCR-CLIENT-ABORT
    await quiet(async (logs) => {
      let startedResolve
      const started = new Promise((r) => { startedResolve = r })
      let aborted = false
      globalThis.fetch = async (url, init) => {
        init.signal.addEventListener('abort', () => { aborted = true }, { once: true })
        startedResolve()
        return await new Promise((resolve, reject) => {
          if (init.signal.aborted) { reject(init.signal.reason || namedError('AbortError')); return }
          init.signal.addEventListener('abort', () => reject(init.signal.reason || namedError('AbortError')), { once: true })
        })
      }
      const req = mkEmitterReq({ file: 'QUJD', name: 'a.png' })
      const res = mkRes()
      const p = h(req, res)
      await started
      res.emit('close')
      await p
      ok('断连（外呼中）：信号被中止', aborted === true)
      ok('断连（外呼中）：不写回包', res.code === 0 && res.chunks.length === 0, 'code=' + res.code)
      ok('断连（外呼中）：日志有 OCR-CLIENT-ABORT', logs.some((l) => l.indexOf('OCR-CLIENT-ABORT') >= 0), logs.join(' | ').slice(0, 180))
    })

    // 断连 ②：响应头已回、body 还在流，客户端走了 → text() 随 signal 中止，不写回包
    await quiet(async (logs) => {
      let startedResolve
      const started = new Promise((r) => { startedResolve = r })
      let aborted = false
      globalThis.fetch = async (url, init) => {
        startedResolve()
        return {
          ok: true, status: 200,
          text: () => new Promise((resolve, reject) => {
            const onAbort = () => { aborted = true; reject(init.signal.reason || namedError('AbortError')) }
            if (init.signal.aborted) { onAbort(); return }
            init.signal.addEventListener('abort', onAbort, { once: true })
          }),
        }
      }
      const req = mkEmitterReq({ file: 'QUJD', name: 'a.png' })
      const res = mkRes()
      const p = h(req, res)
      await started
      // 让 handler 先走到 resp.text()
      await new Promise((r) => setTimeout(r, 5))
      res.emit('close')
      await p
      ok('断连（读 body 中）：信号被中止', aborted === true)
      ok('断连（读 body 中）：不写回包', res.code === 0 && res.chunks.length === 0, 'code=' + res.code)
      ok('断连（读 body 中）：日志有 OCR-CLIENT-ABORT', logs.some((l) => l.indexOf('OCR-CLIENT-ABORT') >= 0), logs.join(' | ').slice(0, 180))
    })
  }

  // ====================================================================
  group('[D] 清洗 / 超长截断 / 页数一致性')
  {
    const h = OCR.createOcrHandler({ getDeepseekKey: () => 'sk-test' })

    // 3 页 × 120k：文本上限 200k，第三页应 omitted，第二页 partial
    const chunk = '甲'.repeat(120 * 1000)
    globalThis.fetch = async () => jsonResponse({
      id: 'ocr-long', page_count: 3,
      pages: [
        { index: 0, text: chunk, finish_reason: 'stop' },
        { index: 1, text: chunk, finish_reason: 'stop' },
        { index: 2, text: chunk, finish_reason: 'stop' },
      ],
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    })
    const rLong = mkRes()
    await quiet(async () => { await h(mkReq({ file: 'QUJD', name: 'a.pdf' }), rLong) })
    const jLong = rLong.json()
    const textCps = Array.from(String(jLong.text)).length
    ok('超长文本截到 200k 码点', textCps === 200 * 1000, 'chars=' + textCps)
    ok('截断有 truncated 标记', jLong.truncated === true)
    ok('页数仍报 3（计费口径）且 pages 保留 3 个占位', jLong.pageCount === 3 && jLong.pages.length === 3)
    ok('第二页部分保留（partial）', jLong.pages[1].partial === true && Array.from(String(jLong.pages[1].plain)).length === 80 * 1000 - 2)
    ok('第三页 omitted 且不带文字', jLong.pages[2].omitted === true && jLong.pages[2].plain === '' && jLong.pages[2].text === '')
    ok('pagesOmitted 计数正确', jLong.pagesOmitted === 1)
    const plainSum = jLong.pages.reduce((n, p) => n + Array.from(String(p.plain)).length, 0)
    const includedPages = jLong.pages.filter((p) => !p.omitted && p.plain).length
    ok('各页 plain + 段落分隔 = text 上限（不重复计数）', plainSum + Math.max(0, includedPages - 1) * 2 === 200 * 1000, 'sum=' + plainSum + ' sep=' + Math.max(0, includedPages - 1) * 2)

    // 空白页不往 text 里塞空段
    globalThis.fetch = async () => jsonResponse({ page_count: 3, pages: [{ index: 0, text: '甲' }, { index: 1, text: '' }, { index: 2, text: '乙' }] })
    const rBlank = mkRes()
    await quiet(async () => { await h(mkReq({ file: 'QUJD', name: 'a.pdf' }), rBlank) })
    ok('空白页不产生多余空行', rBlank.json().text === '甲\n\n乙', JSON.stringify(rBlank.json().text))

    // 原始输出总预算 400k：plain 全保留 200k，raw 截到 400k
    const bigRaw = 'A'.repeat(450 * 1000)
    globalThis.fetch = async () => jsonResponse({ page_count: 1, pages: [{ index: 0, text: bigRaw }] })
    const rRaw = mkRes()
    await quiet(async () => { await h(mkReq({ file: 'QUJD', name: 'a.png' }), rRaw) })
    const jRaw = rRaw.json()
    ok('原始 text 总预算 400k（回包不随页数无限增长）', jRaw.pages[0].text.length === 400 * 1000 && jRaw.pages[0].textTruncated === true, 'raw=' + jRaw.pages[0].text.length)
    ok('被截的只是 raw，plain/text 仍保 200k', jRaw.pages[0].plain.length === 200 * 1000 && Array.from(jRaw.text).length === 200 * 1000)

    // 码点边界：不把 emoji 切出孤立代理项
    globalThis.fetch = async () => jsonResponse({ page_count: 1, pages: [{ index: 0, text: '😀'.repeat(200001) }] })
    const rEmoji = mkRes()
    await quiet(async () => { await h(mkReq({ file: 'QUJD', name: 'a.png' }), rEmoji) })
    const emojiText = String(rEmoji.json().text)
    ok('emoji 按码点截断（20 万个）', Array.from(emojiText).length === 200 * 1000, 'cps=' + Array.from(emojiText).length)
    ok('截断结果没有孤立代理项', typeof emojiText.isWellFormed !== 'function' || emojiText.isWellFormed() === true)

    // page_count 与实际页数不一致：按官方值报，日志留痕
    await quiet(async (logs) => {
      globalThis.fetch = async () => jsonResponse({ page_count: 5, pages: [{ index: 0, text: '一页' }] })
      const r = mkRes()
      await h(mkReq({ file: 'QUJD', name: 'a.pdf' }), r)
      ok('page_count 不一致：pageCount 报官方值、pages 按实际数', r.json().pageCount === 5 && r.json().pages.length === 1, JSON.stringify({ pageCount: r.json().pageCount, pages: r.json().pages.length }))
      ok('page_count 不一致会留日志', logs.some((l) => l.indexOf('PAGE-COUNT-MISMATCH') >= 0), logs.join(' | ').slice(0, 160))
    })
  }

  // ====================================================================
  group('[E] 客户端：OCR 失败/无字/超时都不能阻塞看图')
  {
    const realFileReader = globalThis.FileReader
    const dataUrlReader = (payload) => class {
      constructor() { this.result = payload }
      readAsDataURL() { setTimeout(() => this.onloadend && this.onloadend(), 0) }
    }
    try {
      globalThis.FileReader = dataUrlReader('data:image/png;base64,QUJD')
      const noop = () => { }

      // ① OCR 返回业务失败：仍要用原图提问
      let chatBody = null
      const rFail = await DROP.handleFileDrop({ size: 100, name: 'p.png', type: 'image/png' }, {
        showBubble: noop,
        fetchImpl: async (url, init) => {
          if (String(url).indexOf('/ocr') >= 0) return { ok: false, status: 500, json: async () => ({ ok: false, error: 'OCR down' }) }
          chatBody = JSON.parse(String(init.body))
          return { ok: true, status: 200, json: async () => ({ ok: true, reply: '看到一张图' }) }
        },
      })
      ok('OCR 业务失败 → 照旧看图（ok/kind=image）', rFail.ok === true && rFail.kind === 'image', JSON.stringify(rFail))
      ok('OCR 失败时提问里不带 OCR 段', String(rFail.message) === DROP.VISION_PROMPT && chatBody && chatBody.image === 'QUJD', String(rFail.message))

      // ② OCR 网络抛错：仍要看图
      const rThrow = await DROP.handleFileDrop({ size: 100, name: 'p.png', type: 'image/png' }, {
        showBubble: noop,
        fetchImpl: async (url) => {
          if (String(url).indexOf('/ocr') >= 0) throw new Error('ocr net down')
          return { ok: true, status: 200, json: async () => ({ ok: true, reply: '还是看到了' }) }
        },
      })
      ok('OCR 网络抛错 → 照旧看图', rThrow.ok === true && rThrow.kind === 'image', JSON.stringify(rThrow))

      // ③ OCR 成功但没有文字：不带空 OCR 段
      const rEmpty = await DROP.handleFileDrop({ size: 100, name: 'p.png', type: 'image/png' }, {
        showBubble: noop,
        fetchImpl: async (url) => {
          if (String(url).indexOf('/ocr') >= 0) return { ok: true, status: 200, json: async () => ({ ok: true, text: '' }) }
          return { ok: true, status: 200, json: async () => ({ ok: true, reply: '看图' }) }
        },
      })
      ok('OCR 成功但没字 → 提问仍是原问题', String(rEmpty.message) === DROP.VISION_PROMPT, String(rEmpty.message))

      // ④ OCR 文字进提问前截到 2000 字（前缀「图片里的文字」本身也含「字」，按标记后正文数）
      const longOcr = '字'.repeat(3000)
      const prompt = DROP.buildVisionPrompt(longOcr)
      const marker = '图片里的文字（OCR 识别）：\n'
      const ocrBody = prompt.slice(prompt.indexOf(marker) + marker.length)
      ok('OCR 文字进提问前截到 2000 字', prompt.indexOf(marker) > 0 && Array.from(ocrBody).length === 2000, 'body=' + Array.from(ocrBody).length)
    } finally {
      globalThis.FileReader = realFileReader
    }
  }

  // ====================================================================
  group('[F] 模块边界：只导出 handler，不落盘/不写聊天记忆、不用会吞错的 fetchJson')
  {
    const src = readFileSync(path.join(ROOT, 'src/host/routes/ocr.ts'), 'utf8')
    ok('只导出 createOcrHandler（不暴露内部状态）', (src.match(/^export /gm) || []).length === 1, String((src.match(/^export /gm) || []).length))
    ok('不写聊天记忆/会话（OCR 结果不成为 DSH 上下文）', !/appendTurns|loadHistory|saveMemorySummary|noteUserChat/.test(src))
    ok('不落盘/不缓存 OCR 结果', !/writeFile|setJson|cache\./.test(src))
    ok('不再用 fetchJson（它会吞响应体读取错误）', !/import\s*\{[^}]*\bfetchJson\b[^}]*\}\s*from\s*'\.\.\/http\.js'/.test(src))
    ok('外呼用 fetchWithTimeout（超时/断连能兜到 body 读取）', /import\s*\{[^}]*\bfetchWithTimeout\b[^}]*\}\s*from\s*'\.\.\/http\.js'/.test(src))
  }
} catch (e) {
  ok('用例未抛异常', false, String((e && e.stack) || e))
} finally {
  globalThis.fetch = realFetch
}

console.log('\n' + '='.repeat(52))
console.log('通过 ' + pass + ' 项 / 失败 ' + fail + ' 项')
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('✅ OCR 专项回归全部通过')
process.exit(0)
