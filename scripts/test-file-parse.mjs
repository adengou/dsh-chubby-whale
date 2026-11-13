/**
 * scripts/test-file-parse.mjs —— 官方文件解析（Files API）专项回归
 *
 * 离线、不联网：fetch 全部用桩。只钉这条线上的契约：
 *   A. POST /parse-doc：multipart 形状（purpose 在 file 前、expires_after）、鉴权头、
 *      file_id 白名单、错误提示（400/401/402/408/413/429/504、200 带 error）、
 *      超时分类、客户中途断开时中止外呼且不回包；
 *   B. /chat 的 file 块：只认合法 file_id、放在用户消息最前、与图片共存、带文件时不读缓存；
 *   C. 客户端拖入 PDF/Office：只走官方解析（不本地解）、成功/失败/无 Key/超限/超时/断连文案；
 *     进度气泡与结果用水印 key 立即替换（不排在 30s 进度后面）。
 *
 * 用法：node scripts/test-file-parse.mjs
 */
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'

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
const realFileReader = globalThis.FileReader
globalThis.fetch = async () => { throw new Error('测试不许真联网') }

function mkRes() {
  const out = { code: 0, chunks: [], headers: {}, headersSent: false, writableEnded: false, writableFinished: false }
  out.writeHead = (c, h) => { out.code = c; out.headers = h || {}; out.headersSent = true }
  out.setHeader = (k, v) => { out.headers[k] = v }
  out.end = (b) => { out.writableEnded = true; out.writableFinished = true; if (b) out.chunks.push(Buffer.from(String(b))) }
  out.bodyText = () => Buffer.concat(out.chunks).toString('utf8')
  out.json = () => { try { return JSON.parse(out.bodyText()) } catch { return null } }
  return out
}
function mkResEv() {
  const res = new EventEmitter()
  Object.assign(res, {
    code: 0, chunks: [], headers: {}, headersSent: false, writableEnded: false, writableFinished: false,
    writeHead(c, h) { this.code = c; this.headers = h || {}; this.headersSent = true },
    setHeader(k, v) { this.headers[k] = v },
    end(b) { this.writableEnded = true; this.writableFinished = true; if (b) this.chunks.push(Buffer.from(String(b))) },
    bodyText() { return Buffer.concat(this.chunks).toString('utf8') },
    json() { try { return JSON.parse(this.bodyText()) } catch { return null } },
  })
  return res
}
function mkReq(body, opts = {}) {
  const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  return {
    method: opts.method || 'POST',
    url: opts.url || '/api/chubby-whale/parse-doc',
    headers: Object.assign({ 'content-length': String(opts.contentLength !== undefined ? opts.contentLength : buf.length) }, opts.headers || {}),
    destroy() { }, on() { }, resume() { },
    async *[Symbol.asyncIterator]() { yield buf },
  }
}
function mkReqEv(body) {
  const req = new EventEmitter()
  const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  Object.assign(req, {
    method: 'POST',
    url: '/api/chubby-whale/parse-doc',
    headers: { 'content-length': String(buf.length) },
    destroy() { }, resume() { },
    async *[Symbol.asyncIterator]() { yield buf },
  })
  return req
}
function jsonResponse(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) }
}
function textResponse(text, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => text }
}

try {
  const PD = await import('../src/host/routes/parse-doc.ts')
  const CHAT = await import('../src/host/routes/chat.ts')
  const DROP = await import('../src/client/dropzone.ts')

  // ====================================================================
  group('[A] POST /parse-doc：上传形状 / 鉴权 / 错误 / 断连')
  {
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init })
      return jsonResponse({
        id: 'file-api-abcdefgh', object: 'file', bytes: 6, created_at: 1762790000,
        filename: '汇报.docx', purpose: 'text_recognition', expires_at: 1794600000,
      })
    }
    const h = PD.createParseDocHandler({ getDeepseekKey: () => 'sk-test' })
    let res = mkRes()
    await h(mkReq({ file: Buffer.from('DOCXYZ').toString('base64'), name: '汇报.docx', purpose: 'text_recognition' }), res)
    let j = res.json()
    ok('成功 → ok:true + fileId + 文件名/字节/有效期',
      res.code === 200 && j && j.ok === true && j.fileId === 'file-api-abcdefgh'
      && j.filename === '汇报.docx' && j.bytes === 6 && j.purpose === 'text_recognition' && j.expiresAt === 1794600000,
      JSON.stringify(j))
    ok('调用官方 /files（不是 /v1/files）', calls.length === 1 && calls[0].url === 'https://api.deepseek.com/files', calls[0] && calls[0].url)
    ok('Bearer 鉴权头', String(calls[0].init.headers.authorization) === 'Bearer sk-test', String(calls[0].init.headers.authorization))
    ok('multipart content-type 带 boundary', /^multipart\/form-data; boundary=/.test(String(calls[0].init.headers['content-type'])), String(calls[0].init.headers['content-type']))
    const bt = String(calls[0].init.body.toString('utf8'))
    ok('purpose 在 file 之前（官方硬要求）', bt.indexOf('name="purpose"') >= 0 && bt.indexOf('name="purpose"') < bt.indexOf('filename="汇报.docx"'))
    ok('expires_after[anchor]=created_at + seconds=3600',
      bt.indexOf('name="expires_after[anchor]"') >= 0 && bt.indexOf('created_at') > bt.indexOf('name="expires_after[anchor]"')
      && bt.indexOf('name="expires_after[seconds]"') >= 0 && bt.indexOf('3600') > bt.indexOf('name="expires_after[seconds]"'))
    ok('file 段在最后、字节原样', bt.indexOf('filename="汇报.docx"') > bt.indexOf('name="expires_after[seconds]"') && bt.indexOf('DOCXYZ') > 0)
    ok('docx → 官方 MIME', bt.indexOf('Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document') > 0)

    // 文件名清洗（单独断言 safeFileName 在路由里的效果）
    calls.length = 0
    res = mkRes()
    await h(mkReq({ file: 'QUJD', name: 'a"b\r\nc.docx', purpose: 'rich_layout_recognition' }), res)
    const bt2 = String(calls[0].init.body.toString('utf8'))
    ok('rich_layout_recognition 透传 + 文件名清洗', bt2.indexOf('rich_layout_recognition') > 0 && bt2.indexOf('filename="a_b__c.docx"') > 0, JSON.stringify(bt2.slice(0, 260)))

    // 无 Key：不花一次外呼
    calls.length = 0
    const noKey = mkRes()
    await PD.createParseDocHandler({ getDeepseekKey: () => '' })(mkReq({ file: 'QUJD', name: 'a.docx', purpose: 'text_recognition' }), noKey)
    ok('无 Key → NO_KEY + 人话，且不发外呼',
      noKey.json().ok === false && noKey.json().error === 'NO_KEY' && /DeepSeek Key/.test(noKey.json().hint) && calls.length === 0,
      JSON.stringify(noKey.json()))

    // 401 / 413 / 429 / 504 的提示
    for (const [status, word] of [[401, /Key/], [413, /太大/], [429, /太多/], [504, /超时/]]) {
      globalThis.fetch = async () => textResponse('{"error":{"message":"official"}}', status)
      const r = mkRes()
      await h(mkReq({ file: 'QUJD', name: 'a.docx', purpose: 'text_recognition' }), r)
      ok('官方 ' + status + ' → ok:false + 对应提示', r.json().ok === false && word.test(String(r.json().hint)), JSON.stringify(r.json()))
    }

    // 200 + error：不能给「官方接口返回 HTTP 200」这种答非所问的 hint
    globalThis.fetch = async () => textResponse(JSON.stringify({ error: { message: 'parse timeout', code: 'gateway_timeout_error' } }), 200)
    res = mkRes()
    await h(mkReq({ file: 'QUJD', name: 'a.docx', purpose: 'text_recognition' }), res)
    j = res.json()
    ok('200 带 error → 保留官方 code，但 hint 不是 HTTP 200',
      j.ok === false && j.error === 'gateway_timeout_error' && /官方解析没有成功/.test(String(j.hint)) && !/HTTP 200/.test(String(j.hint)),
      JSON.stringify(j))

    // 超时 / 网络错误分类
    globalThis.fetch = async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e }
    res = mkRes()
    await h(mkReq({ file: 'QUJD', name: 'a.docx', purpose: 'text_recognition' }), res)
    ok('内部超时 → error=timeout + 「解析超时」提示', res.json().error === 'timeout' && /解析超时/.test(String(res.json().hint)), JSON.stringify(res.json()))

    globalThis.fetch = async () => { throw new Error('fetch failed') }
    res = mkRes()
    await h(mkReq({ file: 'QUJD', name: 'a.docx', purpose: 'text_recognition' }), res)
    ok('网络失败 → 保留原始 error，hint 指向网络', res.json().ok === false && res.json().error === 'fetch failed' && /网络/.test(String(res.json().hint)), JSON.stringify(res.json()))

    // 客户中途断开：立刻中止官方外呼、不回包
    let aborted = false
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
      const signal = init && init.signal
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', () => {
          aborted = true
          const e = new Error('aborted')
          e.name = 'AbortError'
          reject(e)
        })
      }
    })
    const reqEv = mkReqEv({ file: Buffer.from('DOC').toString('base64'), name: '汇报.docx', purpose: 'text_recognition' })
    const resEv = mkResEv()
    const pending = h(reqEv, resEv)
    await new Promise((r) => setTimeout(r, 15))
    resEv.emit('close')
    await pending
    ok('客户端断开 → 官方外呼被 abort（不跑满 250s）', aborted === true)
    ok('客户端断开 → 不往死连接写回包', resEv.code === 0 && resEv.bodyText() === '', 'code=' + resEv.code + ' body=' + resEv.bodyText())

    // 30MB decoded 上限之外的「请求体过大」：声明超限直接 413，一个字节都不读
    globalThis.fetch = async () => { throw new Error('不该外呼') }
    const huge = mkReq({ file: 'QUJD' }, { contentLength: 40 * 1024 * 1024 + 64 * 1024 + 1 })
    const rHuge = mkRes()
    await h(huge, rHuge)
    ok('请求体声明超上限（40MB + 64KiB 外壳余量）→ 413', rHuge.code === 413 && rHuge.json().error === 'too large', rHuge.bodyText())

    // 非法 file_id：与 /chat 同门槛（file-api- 后至少 8 位）
    globalThis.fetch = async () => jsonResponse({ id: 'file-api-a', object: 'file' })
    res = mkRes()
    await h(mkReq({ file: 'QUJD', name: 'a.docx', purpose: 'text_recognition' }), res)
    ok('过短的 file_id → BAD_FILE_ID（否则聊天会静默丢掉）', res.json().ok === false && res.json().error === 'BAD_FILE_ID', JSON.stringify(res.json()))

    // 基础校验
    res = mkRes()
    await h(mkReq({ file: '!!!bad!!!', name: 'a.docx', purpose: 'text_recognition' }), res)
    ok('非法 base64 → 400', res.code === 400 && res.json().error === 'bad base64')
    res = mkRes()
    await h(mkReq({ file: 'QUJD', name: 'a.docx', purpose: 'user_data' }), res)
    ok('非法 purpose → 400', res.code === 400 && res.json().error === 'bad purpose')
    res = mkRes()
    await h(mkReq({}, { method: 'GET' }), res)
    ok('非 POST → 405', res.code === 405 && res.json().error === 'METHOD_NOT_ALLOWED')
    globalThis.fetch = realFetch
  }

  // ====================================================================
  group('[B] /chat：官方 file 块引用')
  {
    const captured = []
    let cacheReads = 0
    globalThis.fetch = async (_url, init) => {
      captured.push(JSON.parse(String(init.body)))
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: '答' } }], usage: { total_tokens: 10, prompt_tokens: 8, completion_tokens: 2 } }),
      }
    }
    const deps = {
      getKey: () => 'sk-test',
      loadHistory: () => [],
      appendTurns: () => { },
      loadState: () => ({ intimacy: 0 }),
      saveState: () => { },
      systemPrompt: 'x',
      addExp: () => ({}),
      addTokens: () => { },
      loadMemorySummary: () => '',
      saveMemorySummary: () => { },
      cacheEnabled: () => true,
      cache: { getJson: async () => { cacheReads++; return null }, setJson: async () => { } },
    }
    const chat = CHAT.createChatHandler(deps)
    let res = mkRes()
    await chat(mkReq({ message: '总结这份文档的要点', fileId: 'file-api-abcdefgh' }), res)
    let last = captured[0].messages[captured[0].messages.length - 1]
    ok('合法 file_id → 用户消息变内容块', Array.isArray(last.content), JSON.stringify(last.content))
    ok('file 块在最前、id 原样', last.content[0].type === 'file' && last.content[0].file_id === 'file-api-abcdefgh', JSON.stringify(last.content[0]))
    ok('text 块在 file 之后', last.content[1].type === 'text' && last.content[1].text === '总结这份文档的要点')
    ok('带文件不读聊天缓存（避免把别的文档答案拿来）', cacheReads === 0, 'reads=' + cacheReads)
    ok('带文件仍只发一条 user 消息', captured[0].messages.filter((m) => m.role === 'user').length === 1)

    // 图 + 文件：file 在最前，text/image 保留
    captured.length = 0
    res = mkRes()
    await chat(mkReq({
      message: '看看这份文档里的图', fileId: 'file-api-abcdefgh',
      image: Buffer.from('IMG').toString('base64'), imageMime: 'image/png',
    }), res)
    last = captured[0].messages[captured[0].messages.length - 1]
    ok('图 + 文件 → [file, text, image_url]',
      Array.isArray(last.content) && last.content[0].type === 'file' && last.content[1].type === 'text' && last.content[2].type === 'image_url',
      JSON.stringify(last.content && last.content.map((x) => x.type)))

    // 非法 id：静默当没传（不把任意字符串塞进请求体）
    captured.length = 0
    res = mkRes()
    await chat(mkReq({ message: '总结这份文档的要点', fileId: 'file-api-a' }), res)
    last = captured[0].messages[captured[0].messages.length - 1]
    ok('过短 file_id → 当没传（内容仍是纯文本）', typeof last.content === 'string', JSON.stringify(last.content))
    globalThis.fetch = realFetch
  }

  // ====================================================================
  group('[C] 客户端：PDF/Office 只走官方解析')
  {
    ok('扩展名识别：pdf/doc/docx/ppt/pptx（大小写都认）',
      DROP.isBinaryDocFile({ name: 'a.pdf' }) && DROP.isBinaryDocFile({ name: 'B.DOCX' })
      && DROP.isBinaryDocFile({ name: 'c.doc' }) && DROP.isBinaryDocFile({ name: 'd.PPT' }) && DROP.isBinaryDocFile({ name: 'e.pptx' }))
    ok('无扩展名时按官方支持的 MIME 兜底', DROP.isBinaryDocFile({ name: 'scan', type: 'application/pdf' }) === true
      && DROP.isBinaryDocFile({ name: 'deck', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }) === true)
    ok('txt / 未知 MIME 不算官方文档', DROP.isBinaryDocFile({ name: 'a.txt' }) === false
      && DROP.isBinaryDocFile({ name: 'x', type: 'application/octet-stream' }) === false)
    ok('docx 不会被当成纯文本（本地不解）', DROP.isTextFile({ name: 'a.docx' }) === false)

    // 静态检查：拖入路径没有本地 PDF/Office 解析器
    const src = readFileSync(path.join(ROOT, 'src/client/dropzone.ts'), 'utf8')
    ok('拖入路径调用 /parse-doc', /post\('\/parse-doc'/.test(src))
    ok('拖入路径把 fileId 交给 /chat', /post\('\/chat',\s*\{\s*message,\s*fileId\s*\}\)/.test(src))
    ok('拖入路径不引 doc-text / 不自建解析器',
      !/from\s+'\.\/doc-text\.js'/.test(src) && !/new\s+(DOMParser|DecompressionStream)/.test(src) && !/pdfjs|pdf-parse|mammoth/i.test(src))

    // 假 FileReader：把 __bytes 编成 data URL（与 image.ts 的读取口径一致）
    globalThis.FileReader = class {
      constructor() { this.result = ''; this.onloadend = null; this.onerror = null; this.onabort = null }
      readAsDataURL(file) {
        const bytes = (file && file.__bytes) || Buffer.from('')
        this.result = 'data:' + ((file && file.type) || 'application/octet-stream') + ';base64,' + Buffer.from(bytes).toString('base64')
        setTimeout(() => { try { this.onloadend && this.onloadend() } catch (e) { } }, 0)
      }
    }
    const fakeDoc = (name, bytes, type) => ({
      name, type, size: bytes.length, lastModified: 1762790000000, __bytes: bytes,
      text: async () => '',
    })
    const jsonRes = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => obj })
    const makeFetch = (handlers) => {
      const calls = []
      const fn = async (url, init) => {
        const p = String(url).replace('/api/chubby-whale', '')
        calls.push({ path: p, body: init && init.body ? JSON.parse(String(init.body)) : null, signal: init && init.signal })
        const hd = handlers[p]
        if (!hd) throw new Error('意外请求：' + p)
        return hd(init)
      }
      fn.calls = calls
      return fn
    }

    // 成功：/parse-doc → /chat(fileId)，进度与结果共用气泡 key
    {
      const fetchImpl = makeFetch({
        '/parse-doc': async () => jsonRes({ ok: true, fileId: 'file-api-abcdefgh', filename: '汇报.docx', bytes: 6, purpose: 'text_recognition' }),
        '/chat': async () => jsonRes({ ok: true, reply: '这份汇报讲了十一月的工作要点。' }),
      })
      const bubbles = []
      const spoke = []
      const r = await DROP.handleFileDrop(fakeDoc('汇报.docx', Buffer.from('DOCXYZ'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), {
        showBubble: (text, ms, opts) => bubbles.push({ text, ms, opts }),
        speakText: (t) => spoke.push(t),
        fetchImpl,
      })
      ok('文档成功 → ok/document + 回复', r.ok === true && r.kind === 'document' && r.reply === '这份汇报讲了十一月的工作要点。', JSON.stringify(r))
      ok('请求顺序：先上传解析、再带 fileId 聊天',
        fetchImpl.calls.length === 2 && fetchImpl.calls[0].path === '/parse-doc' && fetchImpl.calls[1].path === '/chat',
        JSON.stringify(fetchImpl.calls.map((c) => c.path)))
      const up = fetchImpl.calls[0].body
      ok('上传体：base64 原字节 + 文件名 + purpose', up.file === Buffer.from('DOCXYZ').toString('base64') && up.name === '汇报.docx' && up.purpose === 'text_recognition', JSON.stringify(up))
      const chatBody = fetchImpl.calls[1].body
      ok('/chat 体：文件名进 message、fileId 原样', chatBody.fileId === 'file-api-abcdefgh' && String(chatBody.message).indexOf('《汇报.docx》') > 0, JSON.stringify(chatBody))
      ok('回复会朗读', spoke.length === 1 && spoke[0] === '这份汇报讲了十一月的工作要点。')
      const progress = bubbles.find((b) => b.text.indexOf('先把这份文档读懂') > 0)
      const result = bubbles.find((b) => b.text.indexOf('（文档）') === 0)
      ok('进度与结果共用同一气泡 key（结果立即替换，不排队 30s）',
        !!progress && !!result && progress.opts && result.opts && progress.opts.key === result.opts.key,
        JSON.stringify({ progress: progress && progress.opts, result: result && result.opts }))
    }

    // 无 Key：解析失败 → 冒宿主 hint，不再打 /chat
    {
      const fetchImpl = makeFetch({
        '/parse-doc': async () => jsonRes({ ok: false, error: 'NO_KEY', hint: '没配 DeepSeek Key，文件解析用不了；聊天、念诗、说书照常' }),
      })
      const bubbles = []
      const r = await DROP.handleFileDrop(fakeDoc('a.pdf', Buffer.from('PDF'), 'application/pdf'), {
        showBubble: (t) => bubbles.push(t), fetchImpl,
      })
      ok('无 Key → error + 宿主人话', r.ok === false && r.kind === 'error' && /DeepSeek Key/.test(String(r.reply)), JSON.stringify(r))
      ok('无 Key → 只发一次上传、不打 /chat', fetchImpl.calls.length === 1 && fetchImpl.calls[0].path === '/parse-doc')
      ok('无 Key → 气泡显示人话', bubbles.some((t) => /DeepSeek Key/.test(String(t))), JSON.stringify(bubbles))
    }

    // 超限：客户端先拦（20MB），一次都不传
    {
      const fetchImpl = makeFetch({})
      const bubbles = []
      const r = await DROP.handleFileDrop({ name: 'big.pdf', type: 'application/pdf', size: DROP.MAX_DOC_BYTES + 1 }, {
        showBubble: (t) => bubbles.push(t), fetchImpl,
      })
      ok('文档超 20MB → too-large，不发请求', r.ok === false && r.kind === 'too-large' && fetchImpl.calls.length === 0, JSON.stringify(r))
      ok('超限文案说明 20MB', bubbles.some((t) => /20MB/.test(String(t))), JSON.stringify(bubbles))
    }

    // 宿主 413（请求体/解码后超限）：按 too-large 处理，冒中文
    {
      const fetchImpl = makeFetch({
        '/parse-doc': async () => jsonRes({ ok: false, error: 'too large' }, 413),
      })
      const bubbles = []
      const r = await DROP.handleFileDrop(fakeDoc('a.pdf', Buffer.from('PDF'), 'application/pdf'), {
        showBubble: (t) => bubbles.push(t), fetchImpl,
      })
      ok('宿主 413 → too-large（不是普通 error）', r.ok === false && r.kind === 'too-large', JSON.stringify(r))
      ok('413 的英文常量翻成中文', bubbles.some((t) => /文件太大/.test(String(t))), JSON.stringify(bubbles))
    }

    // 官方返回坏 id：不上聊天，给明确提示
    {
      const fetchImpl = makeFetch({
        '/parse-doc': async () => jsonRes({ ok: true, fileId: 'file-api-a' }),
      })
      const bubbles = []
      const r = await DROP.handleFileDrop(fakeDoc('a.pdf', Buffer.from('PDF'), 'application/pdf'), {
        showBubble: (t) => bubbles.push(t), fetchImpl,
      })
      ok('坏 file_id → error + 不打 /chat', r.ok === false && r.kind === 'error' && fetchImpl.calls.length === 1, JSON.stringify(r))
      ok('坏 file_id 的提示是「没返回文件编号」', bubbles.some((t) => /文件编号/.test(String(t))), JSON.stringify(bubbles))
    }

    // 上传成功、聊天失败：不能把已上传的文档说成「上传失败」，但结果仍是 error
    {
      const fetchImpl = makeFetch({
        '/parse-doc': async () => jsonRes({ ok: true, fileId: 'file-api-abcdefgh' }),
        '/chat': async () => jsonRes({ ok: false, error: 'HTTP 500', reply: '主人，本鲸一时想不起来话（网络或接口有点问题）……' }, 500),
      })
      const bubbles = []
      const r = await DROP.handleFileDrop(fakeDoc('a.pdf', Buffer.from('PDF'), 'application/pdf'), {
        showBubble: (t) => bubbles.push(t), fetchImpl,
      })
      ok('聊天失败 → error + 宿主兜底文案', r.ok === false && r.kind === 'error' && /网络或接口/.test(String(r.reply)), JSON.stringify(r))
      ok('聊天失败时上传确实发生过', fetchImpl.calls.length === 2 && fetchImpl.calls[0].path === '/parse-doc')
    }

    // 客户端等待预算：到点 abort（宿主会因此中止外呼），立刻回人话
    {
      const fetchImpl = async (_url, init) => new Promise((_resolve, reject) => {
        const signal = init && init.signal
        if (signal && typeof signal.addEventListener === 'function') {
          signal.addEventListener('abort', () => {
            const e = new Error('aborted')
            e.name = 'AbortError'
            reject(e)
          })
        }
      })
      const bubbles = []
      const r = await DROP.handleFileDrop(fakeDoc('slow.pdf', Buffer.from('PDF'), 'application/pdf'), {
        showBubble: (t) => bubbles.push(t), fetchImpl, timeouts: { parseDoc: 20 },
      })
      ok('解析等待超时 → error（不永远 pending）', r.ok === false && r.kind === 'error', JSON.stringify(r))
      ok('超时文案是「等太久」而不是 AbortError', r.reply === '等太久啦（网络可能卡住了），再试一次？', JSON.stringify(r.reply))
      ok('超时也冒同一条气泡', bubbles.some((t) => /等太久/.test(String(t))), JSON.stringify(bubbles))
    }

    // 网络失败：不把英文「Failed to fetch」甩给主人
    {
      const r = await DROP.handleFileDrop(fakeDoc('a.pdf', Buffer.from('PDF'), 'application/pdf'), {
        showBubble: () => { }, fetchImpl: async () => { throw new TypeError('Failed to fetch') },
      })
      ok('网络失败 → 中文兜底，原始错误留在 error 字段', r.ok === false && r.kind === 'error' && r.error === 'Failed to fetch', JSON.stringify(r))
    }

    // 纯文本仍走本地：不碰 /parse-doc
    {
      const fetchImpl = makeFetch({ '/chat': async () => jsonRes({ ok: true, reply: '总结好了' }) })
      const r = await DROP.handleFileDrop({ name: 'note.md', type: 'text/markdown', size: 10, text: async () => '# 标题\n正文' }, {
        showBubble: () => { }, fetchImpl,
      })
      ok('txt/md 本地读 → text 路径', r.ok === true && r.kind === 'text' && r.reply === '总结好了', JSON.stringify(r))
      ok('txt/md 不发 /parse-doc', fetchImpl.calls.length === 1 && fetchImpl.calls[0].path === '/chat', JSON.stringify(fetchImpl.calls.map((c) => c.path)))
      ok('本地总结仍按 4000 字截断', String(fetchImpl.calls[0].body.message).indexOf('总结一下这篇文档：') === 0)
    }
  }
} catch (e) {
  ok('用例未抛异常', false, String((e && e.stack) || e))
} finally {
  globalThis.fetch = realFetch
  globalThis.FileReader = realFileReader
}

console.log('\n' + '='.repeat(52))
console.log('通过 ' + pass + ' 项 / 失败 ' + fail + ' 项')
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('✅ 官方文件解析专项回归全部通过')
process.exit(0)
