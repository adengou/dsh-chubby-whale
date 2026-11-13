/**
 * host/routes/ocr.ts —— 官方 OCR（DeepSeek /v1/tools/ocr），2026-11-14 新增
 *
 *   POST /api/chubby-whale/ocr
 *     { file: <base64>, name: 'xxx.png', purpose?: 'text_recognition'|'rich_layout_recognition' }
 *     → { ok:true, id, pageCount, purpose, text, truncated?, pagesOmitted?, pages:[{index,text,plain,finishReason,partial?,textTruncated?,omitted?}], usage }
 *     → { ok:false, error, detail?, hint? }
 *
 * 定位（与图片理解分工）：图片理解是「看懂了什么」，OCR 是「一个字不差地取字」。
 * 表格、截图、扫描件走 OCR，避免让视觉模型去猜数字；两者可以同时用（客户端把 OCR 文字
 * 拼进图片提问里，模型既看图也看准确文字）。
 *
 * 官方口径（照 api-docs 2026-11-13 / 2026-11-14 复核）：
 *   · multipart 两个必填字段 file / purpose，多传字段返回 400；
 *   · 文件不超过 100 MiB、1000 页；上传 120s（中途停顿不超过 30s）、总时长 180s；
 *   · 识别开始后状态码已是 200，失败时响应体是 { error: { message, code } }：
 *     **不能只看 HTTP 状态码**，200 也可能是失败；空/非 JSON 的 200 同样不能当成功；
 *   · 每 1000 页 1.5 元，按成功页数计费；**客户端断开不会取消服务端识别**，
 *     已完成的照常计费（官方文档原文）。所以本路由中止的只是**本地等待**，
 *     不能把「客户端走了」当成「省了钱」；断开仍单独记 OCR-CLIENT-ABORT 日志，
 *     因为「用户取消」与「上游超时」在排障和计费上不是一回事。
 * 文件不落 Files API、不交给对话模型——要「基于文档问答」请走 /parse-doc + 聊天 file 块。
 *
 * 回包上限（2026-11-14 复核）：
 *   · text 最多 200k 码点（够一次对话用）；
 *   · pages 的原始输出另有 400k 码点总预算，只用于追溯 ref/box 标记，超出逐页截断并标 textTruncated；
 *   · 文本预算用完后，后续非空页给 omitted 占位（pages.length 仍等于官方页数），
 *     不再把一份 1000 页文档的全文都塞进回包。
 */
import { fetchWithTimeout, isAbortError, isTimeoutOnly, watchClientGone } from '../http.js'
import { readJsonBody } from '../body.js'
import { sendJson, sendError } from '../respond.js'
import type { OcrRouteDeps } from '../ports.js'
import {
  OCR_ENDPOINT, OCR_TIMEOUT_MS, OCR_MAX_FILE,
  buildMultipart, cleanOcrText, normalizePurpose, officialErrorHint, safeFileName,
} from '../official.js'

/** 返回文本总长上限（码点）：够上层按需再截即可，避免一份 1000 页文档把回包撑爆 */
const MAX_TEXT_CHARS = 200 * 1000
/** 逐页原始输出（含 ref/box 标记）的总预算（码点）；只用于追溯，不喂模型 */
const MAX_RAW_CHARS = 400 * 1000
/**
 * 请求体上限：30 MiB 文件的 base64 正好 40 MiB，JSON 外壳（file/name/purpose）还要几十字节。
 * 直接拿 official.ts 的 OCR_MAX_BODY（40 MiB）当读体上限，会把 30 MiB 文件卡在门口，
 * 「文件太大」的友好提示永远走不到。这里只给外壳留 64 KiB 余量，真正的上限仍按解码后 30 MiB 判。
 */
const OCR_BODY_LIMIT = Math.ceil(OCR_MAX_FILE * 4 / 3) + 64 * 1024

/**
 * 客户端已经走了的日志标签：与上游超时/网络错误分开，排障时一眼能分清谁先放弃。
 * 外呼那条特意写明「官方可能已完成并计费」——官方文档明确客户端断开不取消识别。
 */
const LOG_CLIENT_ABORT_OUTBOUND = '[ocr] OCR-CLIENT-ABORT 客户端已断开，本地等待已中止（官方识别可能已在服务端完成并按页计费）'
const LOG_CLIENT_ABORT_REQUEST = '[ocr] OCR-CLIENT-ABORT 客户端已断开，请求中止（未发起外呼）'

/** 扩展名 → multipart 的 Content-Type（官方按内容判格式，这里只是规矩地声明） */
function contentTypeOf(name: string): string {
  const n = String(name || '').toLowerCase()
  const i = n.lastIndexOf('.')
  const ext = i >= 0 ? n.slice(i) : ''
  switch (ext) {
    case '.png': return 'image/png'
    case '.jpg': case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    case '.bmp': return 'image/bmp'
    case '.tif': case '.tiff': return 'image/tiff'
    case '.pdf': return 'application/pdf'
    case '.doc': return 'application/msword'
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case '.ppt': return 'application/vnd.ms-powerpoint'
    case '.pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    default: return 'application/octet-stream'
  }
}

/** 日志/回包里的单行文本：官方错误也按不可信输入处理，压掉换行（防日志注入）并限长 */
function oneLine(raw: any, max = 200): string {
  return String(raw == null ? '' : raw).replace(/[\r\n]+/g, ' ').trim().slice(0, max)
}

/**
 * base64 统一校验（2026-11-14 复核）：除了字符集，还要拒掉
 *   · `=` 出现在中间、填充超过 2 个；
 *   · 长度 mod 4 == 1（不可能是合法 base64）；
 *   · 带填充但总长不是 4 的倍数（`QUJD=` / `QQ=` 这类）。
 * 允许无填充（`QQ`）——Buffer 能解，浏览器 btoa 只会产有填充的，别为兼容性把正常请求拒了。
 */
function isBase64Text(raw: string): boolean {
  const t = String(raw == null ? '' : raw).replace(/[\r\n]/g, '')
  if (!t) return false
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(t)) return false
  if (t.length % 4 === 1) return false
  if (t.indexOf('=') >= 0 && t.length % 4 !== 0) return false
  return true
}

/** base64 解码后的字节数（不真的解码，先按长度判超限；容忍 \r\n） */
function decodedBase64Bytes(raw: string): number {
  const t = String(raw == null ? '' : raw).replace(/[\r\n]/g, '')
  if (!t) return 0
  const pad = t.endsWith('==') ? 2 : t.endsWith('=') ? 1 : 0
  return Math.floor(t.length * 3 / 4) - pad
}

/**
 * 官方错误 → 人话。状态码优先用 official.ts 的表；200/带 error 的情况
 * （识别开始后失败）按官方文档列出的 message 归类，**不能回「HTTP 200」这种像成功的提示**。
 */
function ocrErrorHint(status: number, errObj: any): string {
  const msg = oneLine(typeof errObj === 'string' ? errObj : (errObj && errObj.message), 300).toLowerCase()
  if (msg) {
    if (/password/.test(msg)) return '文件有打开密码，去掉密码再传'
    if (/more than 1000 pages/.test(msg)) return '文档超过 1000 页，拆成小份再试'
    if (/could not be decoded|could not be parsed|format is not supported/.test(msg)) return '文件格式不支持或已损坏，换一份试试'
    if (/did not finish|within 180 seconds/.test(msg)) return '识别超时了，换小一点的文件再试'
    if (/temporarily unavailable|internal server error/.test(msg)) return '官方服务繁忙，稍后重试'
    if (/file is too large/.test(msg)) return '文件太大（官方上限 100 MiB）'
  }
  if (Number(status) === 200) return '识别没有完成（官方返回了错误），稍后重试'
  return officialErrorHint(status)
}

/**
 * 回 413：与 host/http.ts 的 sendTooLarge 同口径（先声明 connection: close，避免未读完的
 * 请求体留在 keep-alive 连接里），但带上给主人看的中文 hint（sendTooLarge 的固定文案没有）。
 */
function sendOcrTooLarge(res: any): void {
  try {
    if (res && typeof res.setHeader === 'function') res.setHeader('connection', 'close')
    sendJson(res, { ok: false, error: 'too large', hint: '文件太大（本插件上限 30MB）' }, 413)
  } catch { }
}

export function createOcrHandler(opts: OcrRouteDeps) {
  return async function handleOcr(req: any, res: any): Promise<void> {
    const client = watchClientGone(req, res)
    try {
      // OCR 结果可能含公文/截图里的敏感文字：不让浏览器/中间代理把它缓存下来
      try { if (res && typeof res.setHeader === 'function') res.setHeader('cache-control', 'no-store') } catch { }
      const method = req && req.method ? String(req.method).toUpperCase() : 'POST'
      if (method !== 'POST') {
        sendJson(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405)
        return
      }
      // 只收 application/json：恶意网页可用 no-cors + text/plain 跨站触发一次付费 OCR；
      // 要求 JSON 会逼它走 preflight（宿主不答 CORS，浏览器就发不出去）。非浏览器调用方
      // 不带 content-type 时仍放行（兼容 curl/老客户端），不是身份鉴权，只是挡浏览器 CSRF。
      const ctype = String((req && req.headers && req.headers['content-type']) || '').toLowerCase()
      if (ctype && ctype.indexOf('application/json') !== 0) {
        sendJson(res, { ok: false, error: 'bad content-type', hint: '请求体要用 application/json' }, 415)
        return
      }
      const parsed = await readJsonBody(req, OCR_BODY_LIMIT)
      if (!parsed.ok) {
        console.error('[ocr] BODY-TOO-LARGE > ' + OCR_BODY_LIMIT + ' bytes')
        sendOcrTooLarge(res)
        return
      }
      const body = parsed.body || {}
      const b64 = typeof body.file === 'string' ? body.file : ''
      if (!b64) {
        sendJson(res, { ok: false, error: 'empty file', hint: '没有收到文件' }, 400)
        return
      }
      // base64 合法性：非法字符会让 Buffer 解出空/坏字节，官方只会回「无法解码」
      if (!isBase64Text(b64)) {
        sendJson(res, { ok: false, error: 'bad base64', hint: '文件内容不完整，重新选一次再试' }, 400)
        return
      }
      // 先按长度估算解码后大小：30MiB 原文件在 Buffer.from 之前就能判掉，避免白解一份大 base64
      if (decodedBase64Bytes(b64) > OCR_MAX_FILE) {
        console.error('[ocr] FILE-TOO-LARGE base64=' + b64.length + ' ≈ ' + decodedBase64Bytes(b64) + ' bytes > ' + OCR_MAX_FILE)
        sendOcrTooLarge(res)
        return
      }
      const buf = Buffer.from(b64, 'base64')
      if (!buf.length) {
        sendJson(res, { ok: false, error: 'empty file' }, 400)
        return
      }
      // 估算与实际不一致时兜底（例如带填充的边界），绝不对超限文件发起付费外呼
      if (buf.length > OCR_MAX_FILE) {
        console.error('[ocr] FILE-TOO-LARGE ' + buf.length + ' bytes > ' + OCR_MAX_FILE)
        sendOcrTooLarge(res)
        return
      }
      // purpose 白名单：显式传了非法值直接 400，不悄悄换一种识别方式（rich_layout ↔ text 输出不同）
      const rawPurpose = body.purpose == null ? '' : oneLine(body.purpose, 40)
      const purpose = rawPurpose ? normalizePurpose(rawPurpose) : 'text_recognition'
      if (!purpose) {
        sendJson(res, {
          ok: false,
          error: 'bad purpose',
          hint: 'purpose 只能是 text_recognition 或 rich_layout_recognition',
        }, 400)
        return
      }
      const name = safeFileName(body.name)
      // 请求体读完时客户端可能刚好走了：不再发起一次注定没人接的付费外呼
      if (client.gone()) {
        console.error(LOG_CLIENT_ABORT_REQUEST)
        return
      }
      const key = String(opts.getDeepseekKey() || '')
      if (!key) {
        sendJson(res, {
          ok: false,
          error: 'NO_KEY',
          hint: '没配 DeepSeek Key，OCR 用不了；聊天、念诗、说书照常',
        })
        return
      }
      // 官方要求 multipart：file + purpose（顺序不敏感，但按文档示例 purpose 在前）
      const mp = buildMultipart([
        { name: 'purpose', value: purpose },
        { name: 'file', filename: name, contentType: contentTypeOf(name), data: buf },
      ])
      // 不用 fetchJson：它在 resp.text() 失败时用 .catch(() => '') 吞掉错误，会把
      // 「识别中途超时/断连」伪装成 200 + 空响应体。这里自己读，才分得清超时、断连与坏响应。
      let resp: any = null
      try {
        resp = await fetchWithTimeout(OCR_ENDPOINT, {
          method: 'POST',
          headers: { authorization: 'Bearer ' + key, 'content-type': mp.contentType },
          body: mp.body,
        }, OCR_TIMEOUT_MS, client.signal)
      } catch (err: any) {
        if (client.gone()) {
          console.error(LOG_CLIENT_ABORT_OUTBOUND)
          return
        }
        const timedOut = isTimeoutOnly(err)
        const aborted = isAbortError(err)
        const msg = oneLine(err?.message || err)
        if (timedOut) console.error('[ocr] OCR-TIMEOUT ' + OCR_TIMEOUT_MS + 'ms 无响应')
        else if (aborted) console.error('[ocr] OCR-ABORT 外呼被中止')
        else console.error('[ocr] OCR-NETWORK ' + msg)
        sendJson(res, {
          ok: false,
          error: timedOut ? 'timeout' : (aborted ? 'aborted' : (msg || 'network error')),
          hint: timedOut ? '识别超时了，换小一点的文件再试' : (aborted ? '请求被中止了，再试一次' : '网络没接上官方接口'),
        })
        return
      }
      // 官方在识别过程中先回 200 头、再持续发换行保活；fetch() 在响应头到达时就 resolve，
      // 所以 180s 超时与客户端断连真正要兜的是下面的 resp.text()，不能只 catch fetch。
      let text = ''
      try {
        text = await resp.text()
      } catch (err: any) {
        if (client.gone()) {
          console.error(LOG_CLIENT_ABORT_OUTBOUND)
          return
        }
        const timedOut = isTimeoutOnly(err)
        const aborted = isAbortError(err)
        const msg = oneLine(err?.message || err)
        if (timedOut) console.error('[ocr] OCR-TIMEOUT ' + OCR_TIMEOUT_MS + 'ms 响应体未读完')
        else if (aborted) console.error('[ocr] OCR-ABORT 响应体读取被中止')
        else console.error('[ocr] OCR-READ-FAIL ' + msg)
        sendJson(res, {
          ok: false,
          error: timedOut ? 'timeout' : (aborted ? 'aborted' : 'read failed'),
          hint: timedOut ? '识别超时了，换小一点的文件再试' : (aborted ? '请求被中止了，再试一次' : '官方响应没读完，稍后重试'),
        })
        return
      }
      // 响应读完才走：客户端已走就不再解析/回包（官方可能已完成，日志里留痕）
      if (client.gone()) {
        console.error(LOG_CLIENT_ABORT_OUTBOUND)
        return
      }
      const status = Number(resp && resp.status) || 0
      let data: any = null
      if (text) {
        try { data = JSON.parse(text) } catch { data = null }
      }
      const errObj = data && typeof data === 'object' && data.error ? data.error : null
      if (!resp || !resp.ok || errObj) {
        const errMsg = errObj
          ? (typeof errObj === 'string' ? errObj : String(errObj.message || errObj.type || ''))
          : ''
        const detail = oneLine(errMsg || text)
        const code = errObj
          ? (typeof errObj === 'object' && errObj.code ? String(errObj.code) : 'OCR_FAILED')
          : ('HTTP ' + status)
        console.error('[ocr] OCR-FAIL status=' + status + ' ' + detail)
        sendJson(res, { ok: false, error: code, detail, hint: ocrErrorHint(status, errObj) })
        return
      }
      // 200 必须是官方 schema（pages 数组）。空体/HTML/半截 JSON 一律按坏响应处理，
      // 不能返回 ok:true + 空 text —— 那会把「没识别」说成「识别成功且没字」。
      if (!data || typeof data !== 'object' || !Array.isArray(data.pages)) {
        console.error('[ocr] OCR-BAD-RESPONSE ' + oneLine(text, 120))
        sendJson(res, {
          ok: false,
          error: 'BAD_RESPONSE',
          detail: oneLine(text),
          hint: '官方返回的内容看不懂，稍后重试',
        })
        return
      }
      const pagesIn: any[] = data.pages
      const pages: any[] = []
      const parts: string[] = []
      let textChars = 0
      let rawChars = 0
      let pagesOmitted = 0
      let truncated = false
      for (let i = 0; i < pagesIn.length; i++) {
        const p = pagesIn[i] && typeof pagesIn[i] === 'object' ? pagesIn[i] : {}
        const raw = p.text == null ? '' : String(p.text)
        const plain = cleanOcrText(raw)
        const n = Number(p.index)
        const index = Number.isFinite(n) ? Math.trunc(n) : i
        const finishReason = p.finish_reason == null ? '' : String(p.finish_reason)
        if (!plain) {
          // 空白页/只有标记的页：不占文本预算，也不往 text 里塞空段
          pages.push({ index, text: '', plain: '', finishReason })
          continue
        }
        // 段落分隔符也算进上限：否则 1000 个短页会多出 1998 个字符，text 就不再是「最多 200k」
        const sep = parts.length > 0 ? 2 : 0
        const room = MAX_TEXT_CHARS - textChars - sep
        if (room <= 0) {
          // 文本预算用完：保留页序与页数，文字置空并标 omitted（不把后半本文档塞进回包）
          pagesOmitted++
          truncated = true
          pages.push({ index, text: '', plain: '', finishReason, omitted: true })
          continue
        }
        const plainCp = Array.from(plain)
        const partial = plainCp.length > room
        const keptCp = partial ? plainCp.slice(0, room) : plainCp
        const kept = partial ? keptCp.join('') : plain
        textChars += keptCp.length + sep
        if (kept) parts.push(kept)
        if (partial) truncated = true
        // 原始输出只做追溯，另有总预算（含 ref/box 标记，可能比 plain 长很多）
        let rawOut = ''
        let rawCut = false
        if (raw) {
          const rawRoom = MAX_RAW_CHARS - rawChars
          if (rawRoom > 0) {
            const rawCp = Array.from(raw)
            const take = Math.min(rawCp.length, rawRoom)
            rawOut = take >= rawCp.length ? raw : rawCp.slice(0, take).join('')
            rawCut = take < rawCp.length
            rawChars += take
          } else {
            rawCut = true
          }
        }
        const page: any = { index, text: rawOut, plain: kept, finishReason }
        if (partial) page.partial = true
        if (rawCut) page.textTruncated = true
        pages.push(page)
      }
      const textOut = parts.join('\n\n')
      // 官方口径 page_count === pages.length；真不一致时以实际页数落日志，pageCount 仍报官方值（计费口径）
      const reported = Number(data.page_count)
      const pageCount = Number.isFinite(reported) && reported > 0 ? Math.trunc(reported) : pagesIn.length
      if (Number.isFinite(reported) && reported > 0 && Math.trunc(reported) !== pagesIn.length) {
        console.error('[ocr] PAGE-COUNT-MISMATCH reported=' + Math.trunc(reported) + ' actual=' + pagesIn.length)
      }
      sendJson(res, {
        ok: true,
        id: String(data.id || ''),
        purpose: normalizePurpose(data.purpose) || purpose,
        pageCount,
        text: textOut,
        truncated: truncated || undefined,
        pagesOmitted: pagesOmitted || undefined,
        pages,
        usage: data.usage && typeof data.usage === 'object' ? data.usage : null,
      })
    } catch (err: any) {
      try {
        if (client.gone()) {
          console.error(LOG_CLIENT_ABORT_REQUEST)
          return
        }
        sendError(res, { message: oneLine(err?.message || err) }, { ok: false })
      } catch { }
    } finally {
      client.dispose()
    }
  }
}
