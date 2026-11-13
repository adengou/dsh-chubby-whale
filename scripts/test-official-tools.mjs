/**
 * scripts/test-official-tools.mjs —— 官方全家桶接入（OCR / 文件解析 / 联网）专项回归
 *
 * 离线、不联网：fetch 全部用桩，只钉「请求怎么拼、响应怎么解析、失败怎么说」。
 * 真实外呼另由部署后的 /ocr /parse-doc /chat 探针验证（见 CHANGELOG / 交接）。
 *
 * 覆盖：
 *   A. official.ts：multipart 顺序（purpose 必须在 file 前）、文件名清洗、OCR 标记清洗
 *   B. /ocr：成功解析（含 ref/box 标记）、无 Key、HTTP 413、200 里带 error、bad base64、405
 *   C. /parse-doc：成功拿 file_id、purpose 顺序、非法 purpose、官方坏 id、402
 *   D. /chat：联网工具声明、来源拼接、file_id 内容块、非 flash 忽略、联网不计缓存、工具费用
 *   E. 客户端：图片提示拼 OCR、PDF/Office 走官方解析（静态接线）
 *   F. 纯函数：来源去重/拼接、联网计费
 *
 * 用法：node scripts/test-official-tools.mjs
 */
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

function mkReq(body, opts = {}) {
  const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  return {
    method: opts.method || 'POST',
    url: opts.url || '/api/chubby-whale/x',
    headers: Object.assign({ 'content-length': String(buf.length) }, opts.headers || {}),
    destroy() { }, on() { }, resume() { },
    async *[Symbol.asyncIterator]() { yield buf },
  }
}
function mkRes() {
  const out = { code: 0, chunks: [], headers: {} }
  out.writeHead = (c, h) => { out.code = c; out.headers = h || {} }
  out.setHeader = (k, v) => { out.headers[k] = v }
  out.end = (b) => { if (b) out.chunks.push(Buffer.from(String(b))) }
  out.bodyText = () => Buffer.concat(out.chunks).toString('utf8')
  out.json = () => { try { return JSON.parse(out.bodyText()) } catch { return null } }
  return out
}

try {
  const OF = await import('../src/host/official.ts')
  const OCR = await import('../src/host/routes/ocr.ts')
  const PD = await import('../src/host/routes/parse-doc.ts')
  const CHAT = await import('../src/host/routes/chat.ts')
  const PRICE = await import('../src/shared/pricing.ts')
  const CIT = await import('../src/shared/citations.ts')
  const DROP = await import('../src/client/dropzone.ts')

  // ====================================================================
  group('[A] official.ts：multipart 顺序 / 文件名 / OCR 清洗')
  {
    const mp = OF.buildMultipart([
      { name: 'purpose', value: 'text_recognition' },
      { name: 'file', filename: 'a.docx', contentType: 'application/x', data: Buffer.from('XYZ') },
    ])
    const s = mp.body.toString('utf8')
    ok('multipart 里 purpose 在 file 之前（官方硬要求）', s.indexOf('name="purpose"') >= 0 && s.indexOf('name="purpose"') < s.indexOf('filename="a.docx"'))
    ok('file 段内容原样在体里', s.indexOf('XYZ') >= 0)
    ok('Content-Type 带 boundary', /^multipart\/form-data; boundary=----chubbywhale/.test(mp.contentType))

    ok('purpose 白名单', OF.normalizePurpose('text_recognition') === 'text_recognition'
      && OF.normalizePurpose('rich_layout_recognition') === 'rich_layout_recognition'
      && OF.normalizePurpose('user_data') === null && OF.normalizePurpose('') === null)
    ok('文件名去掉引号/换行/反斜杠', OF.safeFileName('a"b\r\nc\\d.docx') === 'a_b__c_d.docx', OF.safeFileName('a"b\r\nc\\d.docx'))
    ok('空文件名有兜底', OF.safeFileName('') === 'file')

    const cleaned = OF.cleanOcrText('<｜ref｜>标题<｜/ref｜><｜box｜>[[12, 34, 56, 78]]<｜/box｜>正文\n\n\n尾巴')
    ok('OCR 标记清洗：留文字、去坐标', cleaned === '标题正文\n\n尾巴', JSON.stringify(cleaned))
    ok('clipText 按码点截断', OF.clipText('😀😀😀', 2) === '😀😀…', OF.clipText('😀😀😀', 2))
  }

  // ====================================================================
  group('[B] /ocr：请求形状与响应解析')
  {
    const calls = []
    const fetchStub = async (url, init) => {
      calls.push({ url: String(url), body: init.body, headers: init.headers })
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          id: 'ocr-1', object: 'ocr.result', purpose: 'text_recognition', page_count: 2,
          pages: [
            { index: 0, text: '<｜ref｜>标题<｜/ref｜><｜box｜>[[1,2,3,4]]<｜/box｜>第一页', finish_reason: 'stop' },
            { index: 1, text: '第二页', finish_reason: 'length' },
          ],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        }),
      }
    }
    const h = OCR.createOcrHandler({ getDeepseekKey: () => 'sk-test' })
    globalThis.fetch = fetchStub
    const res = mkRes()
    await h(mkReq({ file: Buffer.from('PNGDATA').toString('base64'), name: 'shot.png', purpose: 'text_recognition' }), res)
    const j = res.json()
    ok('OCR 成功 → ok:true + 页数', res.code === 200 && j && j.ok === true && j.pageCount === 2, JSON.stringify(j && { ok: j.ok, n: j.pageCount }))
    ok('调用的是官方 OCR 端点', calls.length === 1 && calls[0].url === 'https://api.deepseek.com/v1/tools/ocr', JSON.stringify(calls.map((c) => c.url)))
    const bodyText = String(calls[0].body.toString('utf8'))
    ok('multipart：purpose 在 file 之前', bodyText.indexOf('name="purpose"') < bodyText.indexOf('filename="shot.png"'))
    ok('文件名进 multipart', bodyText.indexOf('filename="shot.png"') >= 0)
    ok('页文本清洗（去 ref/box）', j.pages[0].plain === '标题第一页', j.pages[0].plain)
    ok('原始 text 保留（可追溯）', j.pages[0].text.indexOf('<｜ref｜>') >= 0)
    ok('合并文本用空行分隔', j.text === '标题第一页\n\n第二页', JSON.stringify(j.text))
    ok('finishReason 透出（length 表示不完整）', j.pages[1].finishReason === 'length')

    // 无 Key
    const noKey = mkRes()
    await OCR.createOcrHandler({ getDeepseekKey: () => '' })(mkReq({ file: 'QUJD', name: 'a.png' }), noKey)
    ok('没有 Key → NO_KEY + 人话', noKey.json().error === 'NO_KEY' && /DeepSeek Key/.test(noKey.json().hint), JSON.stringify(noKey.json()))

    // HTTP 413
    const h413 = OCR.createOcrHandler({ getDeepseekKey: () => 'k' })
    globalThis.fetch = async () => ({ ok: false, status: 413, text: async () => '{"error":{"message":"file is too large: max 100 MiB"}}' })
    const r413 = mkRes()
    await h413(mkReq({ file: 'QUJD', name: 'a.png' }), r413)
    ok('官方 413 → ok:false + 「文件太大」提示', r413.json().ok === false && /太大/.test(r413.json().hint), JSON.stringify(r413.json()))

    // 200 里带 error（识别开始后失败）
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ error: { message: 'OCR did not finish in time', code: 'gateway_timeout_error' } }) })
    const rerr = mkRes()
    await h413(mkReq({ file: 'QUJD', name: 'a.png' }), rerr)
    ok('200 里 error → ok:false + code', rerr.json().ok === false && rerr.json().error === 'gateway_timeout_error', JSON.stringify(rerr.json()))

    // bad base64 / 405
    globalThis.fetch = fetchStub
    const bad = mkRes()
    await h(mkReq({ file: '!!!bad!!!', name: 'a.png' }), bad)
    ok('非法 base64 → 400', bad.code === 400 && bad.json().error === 'bad base64', String(bad.code))
    const wrong = mkRes()
    await h(mkReq({}, { method: 'GET' }), wrong)
    ok('非 POST → 405', wrong.code === 405 && wrong.json().error === 'METHOD_NOT_ALLOWED')
    globalThis.fetch = realFetch
  }

  // ====================================================================
  group('[C] /parse-doc：Files API 上传与 file_id')
  {
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: init.body })
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'file-api-abc12345', object: 'file', bytes: 3, filename: '汇报.docx', purpose: 'text_recognition', expires_at: 1794600000 }) }
    }
    const h = PD.createParseDocHandler({ getDeepseekKey: () => 'k' })
    const res = mkRes()
    await h(mkReq({ file: Buffer.from('DOC').toString('base64'), name: '汇报.docx', purpose: 'text_recognition' }), res)
    const j = res.json()
    ok('上传成功 → fileId', j && j.ok === true && j.fileId === 'file-api-abc12345', JSON.stringify(j))
    ok('调用的是官方 /files', calls[0].url === 'https://api.deepseek.com/files')
    const bt = String(calls[0].body.toString('utf8'))
    ok('purpose 在 file 之前', bt.indexOf('name="purpose"') < bt.indexOf('filename='))
    ok('带 1 小时有效期', bt.indexOf('expires_after[anchor]') >= 0 && bt.indexOf('created_at') >= 0 && bt.indexOf('expires_after[seconds]') >= 0)
    ok('file 段在最后（官方口径）', bt.indexOf('filename=') > bt.indexOf('expires_after[seconds]'))

    const badPurpose = mkRes()
    await h(mkReq({ file: 'QUJD', name: 'a.docx', purpose: 'user_data' }), badPurpose)
    ok('非法 purpose → 400', badPurpose.code === 400 && badPurpose.json().error === 'bad purpose')

    // 官方回了个不是 file-api 的 id
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ id: 'oops' }) })
    const badId = mkRes()
    await h(mkReq({ file: 'QUJD', name: 'a.docx', purpose: 'text_recognition' }), badId)
    ok('官方坏 id → BAD_FILE_ID', badId.json().ok === false && badId.json().error === 'BAD_FILE_ID', JSON.stringify(badId.json()))

    // 402 余额不足
    globalThis.fetch = async () => ({ ok: false, status: 402, text: async () => '{"error":{"message":"Insufficient Balance","code":"invalid_request_error"}}' })
    const r402 = mkRes()
    await h(mkReq({ file: 'QUJD', name: 'a.docx', purpose: 'text_recognition' }), r402)
    ok('402 → 提示余额不足', r402.json().ok === false && /余额/.test(r402.json().hint), JSON.stringify(r402.json()))
    globalThis.fetch = realFetch
  }

  // ====================================================================
  group('[D] /chat：联网工具 / file_id / 计费')
  {
    const captured = []
    const adds = []
    let cacheReads = 0
    const deps = {
      getKey: () => 'sk-test',
      loadHistory: () => [],
      appendTurns: () => { },
      loadState: () => ({ intimacy: 0 }),
      saveState: () => { },
      systemPrompt: 'x',
      addExp: () => ({}),
      addTokens: (kind, n, detail) => { adds.push({ kind, n, detail }) },
      loadMemorySummary: () => '',
      saveMemorySummary: () => { },
      cacheEnabled: () => true,
      cache: { getJson: async () => { cacheReads++; return null }, setJson: async () => { } },
      model: 'deepseek-flash',
      noteUserChat: () => { },
    }
    globalThis.fetch = async (url, init) => {
      captured.push(JSON.parse(String(init.body)))
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          choices: [{
            message: {
              content: '答复正文',
              annotations: [{ type: 'url_citation', url_citation: { url: 'https://a.com/x', title: '甲文' } }],
              server_tool_calls: [{
                index: 0,
                calls: [{
                  index: 0, type: 'deepseek_web_search', kind: 'search', status: 'completed',
                  sources: [{ url: 'https://b.com/y', title: '乙文' }, { url: 'https://a.com/x', title: '甲文' }],
                }],
              }],
            },
          }],
          usage: { total_tokens: 100, prompt_tokens: 80, completion_tokens: 20, server_tool_use: { tool_search: 1, tool_fetch: 1 } },
        }),
      }
    }
    const chat = CHAT.createChatHandler(deps)

    let res = mkRes()
    await chat(mkReq({ message: '最近有什么新闻', web: true }), res)
    const j = res.json()
    ok('web=true → 请求里声明两个官方工具',
      Array.isArray(captured[0].tools) && captured[0].tools.length === 2
      && captured[0].tools[0].type === 'deepseek_web_search' && captured[0].tools[1].type === 'deepseek_read_url',
      JSON.stringify(captured[0].tools))
    ok('回复末尾附来源（annotations + sources，按 URL 去重）',
      j.reply.indexOf('答复正文') === 0 && j.reply.indexOf('来源：') > 0
      && j.reply.indexOf('https://a.com/x') > 0 && j.reply.indexOf('https://b.com/y') > 0,
      JSON.stringify(j.reply))
    ok('响应里带结构化 sources', Array.isArray(j.sources) && j.sources.length === 2, JSON.stringify(j.sources))
    ok('联网回合不读聊天缓存', cacheReads === 0, 'reads=' + cacheReads)
    const toolAdd = adds.find((a) => a.kind === 'chat')
    ok('记账带联网工具费（2 次 × 0.005 = 0.01 起）', !!toolAdd && toolAdd.detail && toolAdd.detail.costCny >= 0.01,
      JSON.stringify(toolAdd && toolAdd.detail))

    // file_id → 内容块
    captured.length = 0
    res = mkRes()
    await chat(mkReq({ message: '总结这份文档', fileId: 'file-api-abcdefghij' }), res)
    const msgs = captured[0].messages
    const last = msgs[msgs.length - 1]
    ok('file_id → 用户消息内容块数组', Array.isArray(last.content), JSON.stringify(last.content))
    ok('file 块在最前、id 原样', last.content[0].type === 'file' && last.content[0].file_id === 'file-api-abcdefghij', JSON.stringify(last.content[0]))
    ok('文字块在 file 之后', last.content[1].type === 'text' && last.content[1].text === '总结这份文档')
    ok('默认不带工具', captured[0].tools === undefined)

    // 非 flash 模型：忽略联网
    captured.length = 0
    const chatPro = CHAT.createChatHandler(Object.assign({}, deps, { model: 'deepseek-v4-pro' }))
    res = mkRes()
    await chatPro(mkReq({ message: '查一下', web: true }), res)
    ok('非 deepseek-flash：忽略联网工具', captured[0].tools === undefined, JSON.stringify(captured[0].tools))

    // 非法 fileId 当没传
    captured.length = 0
    res = mkRes()
    await chat(mkReq({ message: '你好', fileId: 'not-a-file-id' }), res)
    const last2 = captured[0].messages[captured[0].messages.length - 1]
    ok('非法 fileId → 当没传（不拼内容块）', typeof last2.content === 'string', JSON.stringify(last2.content))
    globalThis.fetch = realFetch
  }

  // ====================================================================
  group('[E] 客户端：OCR 拼提示 / PDF-Office 走官方解析（静态接线）')
  {
    ok('图片提问会拼 OCR 文字', DROP.buildVisionPrompt('抬头：某某文件').indexOf('图片里的文字') >= 0
      && DROP.buildVisionPrompt('抬头：某某文件').indexOf('抬头：某某文件') > 0)
    ok('没有 OCR 文字时就是原提问', DROP.buildVisionPrompt('') === DROP.VISION_PROMPT)
    ok('文档提问带文件名', DROP.buildDocPrompt('汇报.docx') === '总结一下这篇文档《汇报.docx》的要点。')
    ok('PDF/Word/PPT 识别为官方解析', DROP.isBinaryDocFile({ name: 'a.pdf' }) && DROP.isBinaryDocFile({ name: 'b.DOCX' }) && DROP.isBinaryDocFile({ name: 'c.pptx' }))
    ok('txt 不算官方解析', DROP.isBinaryDocFile({ name: 'a.txt' }) === false && DROP.isTextFile({ name: 'a.txt' }))
    const src = readFileSync(path.join(ROOT, 'src/client/dropzone.ts'), 'utf8')
    ok('图片路径调用 /ocr', /post\('\/ocr'/.test(src))
    ok('文档路径调用 /parse-doc + /chat(fileId)', /post\('\/parse-doc'/.test(src) && /fileId/.test(src))
  }

  // ====================================================================
  group('[F] 来源整理与联网计费')
  {
    const cites = CIT.collectCitations({
      annotations: [{ url_citation: { url: 'https://a.com', title: 'A' } }],
      server_tool_calls: [{ calls: [{ page: { url: 'https://b.com', title: 'B' }, sources: [{ url: 'https://a.com', title: 'A' }, { url: 'https://c.com', title: '' }] }] }],
    })
    ok('来源去重且保序', cites.length === 3 && cites[0].url === 'https://a.com' && cites[1].url === 'https://b.com' && cites[2].url === 'https://c.com',
      JSON.stringify(cites))
    ok('非 http(s) 丢弃', CIT.collectCitations({ annotations: [{ url_citation: { url: 'javascript:alert(1)' } }] }).length === 0)
    ok('appendCitations 拼成编号列表', CIT.appendCitations('正文', cites).indexOf('1. A — https://a.com') > 0)
    ok('没有来源不硬加', CIT.appendCitations('正文', []) === '正文')
    ok('正文已有「来源：」不重复拼', CIT.appendCitations('正文\n\n来源：\n1. x', cites) === '正文\n\n来源：\n1. x')

    ok('联网计费：2 搜 + 1 抓 = 0.015 元', PRICE.estimateWebToolCostCny({ server_tool_use: { tool_search: 2, tool_fetch: 1 } }) === 0.015)
    ok('没有 server_tool_use → null（不猜 0）', PRICE.estimateWebToolCostCny({ total_tokens: 10 }) === null)
    ok('单次搜索 0.005 元', PRICE.estimateWebToolCostCny({ server_tool_use: { tool_search: 1 } }) === 0.005)
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
console.log('✅ 官方全家桶接入回归全部通过')
process.exit(0)
