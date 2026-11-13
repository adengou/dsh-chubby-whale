/**
 * host/routes/parse-doc.ts —— 官方文件解析（Files API），2026-11-14 新增
 *
 *   POST /api/chubby-whale/parse-doc
 *     { file: <base64>, name: '汇报.docx', purpose?: 'text_recognition'|'rich_layout_recognition' }
 *     → { ok:true, fileId:'file-api-…', filename, bytes, purpose, expiresAt }
 *     → { ok:false, error, hint? }
 *
 * 与 OCR 的分工：OCR 只把文字取出来（不交给模型）；这里把 PDF/Word/PPT 上传、由服务端解析，
 * 拿到 file_id 后在**对话请求**里用 `{type:'file', file_id}` 引用，模型就能基于整份文档回答。
 * 解析在上传时完成，解析成功才返回 file_id（所以这个接口的耗时包含了解析时间）。
 *
 * 官方口径（照 api-docs 2026-11-13）：
 *   · POST /files，multipart；**purpose 必须写在 file 之前**；
 *   · purpose=text_recognition / rich_layout_recognition 时才收 PDF/Word/PPT；
 *   · 文档 100 MiB、1000 页；上传 120s、解析 120s；每 1000 页 1.5 元；
 *   · 上传的原始文件与解析结果都不支持下载。
 *
 * 生命周期：本插件给每份文件设 1 小时有效期（expires_after），不做删除调用——
 * 对话是「拖进来就问一次」，file_id 用完即弃，避免把 25 GiB / 10000 个的额度堆满。
 */
import { fetchJson, isAbortError, isTimeoutOnly, sendTooLarge, watchClientGone } from '../http.js';
import { readJsonBody } from '../body.js';
import { sendJson, sendError } from '../respond.js';
import { FILES_ENDPOINT, FILES_TIMEOUT_MS, FILES_MAX_BODY, FILES_MAX_FILE, buildMultipart, normalizePurpose, officialErrorHint, safeFileName, } from '../official.js';
/** 文件在 Files API 上的有效期：1 小时（官方允许 3600–2592000 秒） */
const FILE_TTL_SECONDS = 3600;
/**
 * 单次「上传 + 解析」的客户端预算。
 *
 * 官方口径（文件解析指南，2026-11-14）：文档上传需在 **120 秒**内完成，提交解析后
 * **120 秒**内出结果 —— 最坏是 240 秒。共享常量 FILES_TIMEOUT_MS 目前只有 200 秒，
 * 两边都接近上限的合法请求会被我们自己提前掐断（表现为 timeout，官方那边其实还在解析、
 * 仍会计费）。这里先按 250 秒兜住（10 秒回包余量）；等 official.ts 的统一常量改到 250 秒后，
 * Math.max 会自动跟随，本文件不需要再改。
 */
const FILES_CALL_TIMEOUT_MS = Math.max(FILES_TIMEOUT_MS, 250 * 1000);
/**
 * 官方失败时给主人看的提示。
 * 与 OCR 路由的差别：解析开始后官方也可能用 200 + `{error}` 回包，这时 status 是 200，
 * 不能再套 officialErrorHint（会得到「官方接口返回 HTTP 200」这种答非所问的提示）。
 */
function parseFailureHint(status, errObj) {
    if (status >= 400)
        return officialErrorHint(status);
    if (errObj)
        return '官方解析没有成功（可能超时或结果不完整），稍后重试';
    return '官方接口没有正常返回（HTTP ' + status + '）';
}
function contentTypeOf(name) {
    const n = String(name || '').toLowerCase();
    const i = n.lastIndexOf('.');
    const ext = i >= 0 ? n.slice(i) : '';
    switch (ext) {
        case '.pdf': return 'application/pdf';
        case '.doc': return 'application/msword';
        case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        case '.ppt': return 'application/vnd.ms-powerpoint';
        case '.pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
        case '.png': return 'image/png';
        case '.jpg':
        case '.jpeg': return 'image/jpeg';
        case '.webp': return 'image/webp';
        case '.gif': return 'image/gif';
        case '.bmp': return 'image/bmp';
        case '.tif':
        case '.tiff': return 'image/tiff';
        default: return 'application/octet-stream';
    }
}
export function createParseDocHandler(opts) {
    return async function handleParseDoc(req, res) {
        const client = watchClientGone(req, res);
        try {
            const method = req && req.method ? String(req.method).toUpperCase() : 'POST';
            if (method !== 'POST') {
                sendJson(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
                return;
            }
            const parsed = await readJsonBody(req, FILES_MAX_BODY);
            if (!parsed.ok) {
                console.error('[parse-doc] BODY-TOO-LARGE > ' + FILES_MAX_BODY + ' bytes');
                sendTooLarge(res);
                return;
            }
            const body = parsed.body || {};
            const b64 = typeof body.file === 'string' ? body.file : '';
            if (!b64) {
                sendJson(res, { ok: false, error: 'empty file', hint: '没有收到文件' }, 400);
                return;
            }
            if (!/^[A-Za-z0-9+/=\r\n]+$/.test(b64)) {
                sendJson(res, { ok: false, error: 'bad base64' }, 400);
                return;
            }
            if (b64.length > FILES_MAX_BODY) {
                console.error('[parse-doc] FILE-TOO-LARGE base64=' + b64.length);
                sendTooLarge(res);
                return;
            }
            const buf = Buffer.from(b64, 'base64');
            if (!buf.length) {
                sendJson(res, { ok: false, error: 'empty file' }, 400);
                return;
            }
            if (buf.length > FILES_MAX_FILE) {
                console.error('[parse-doc] FILE-TOO-LARGE ' + buf.length + ' bytes > ' + FILES_MAX_FILE);
                sendJson(res, { ok: false, error: 'file too large', hint: '文件太大（本插件上限 30MB）' }, 413);
                return;
            }
            // 只 accept 文档类 purpose（user_data 走本地纯文本，不需要上传）
            const purpose = normalizePurpose(body.purpose);
            if (!purpose) {
                sendJson(res, { ok: false, error: 'bad purpose', hint: '只支持 text_recognition / rich_layout_recognition' }, 400);
                return;
            }
            const name = safeFileName(body.name);
            const key = String(opts.getDeepseekKey() || '');
            if (!key) {
                sendJson(res, {
                    ok: false,
                    error: 'NO_KEY',
                    hint: '没配 DeepSeek Key，文件解析用不了；聊天、念诗、说书照常',
                });
                return;
            }
            // **顺序是契约**：purpose 必须在 file 之前（官方 400 的口径之一）
            const mp = buildMultipart([
                { name: 'purpose', value: purpose },
                { name: 'expires_after[anchor]', value: 'created_at' },
                { name: 'expires_after[seconds]', value: String(FILE_TTL_SECONDS) },
                { name: 'file', filename: name, contentType: contentTypeOf(name), data: buf },
            ]);
            let r = null;
            try {
                r = await fetchJson(FILES_ENDPOINT, {
                    method: 'POST',
                    headers: { authorization: 'Bearer ' + key, 'content-type': mp.contentType },
                    body: mp.body,
                }, FILES_CALL_TIMEOUT_MS, client.signal);
            }
            catch (err) {
                if (client.gone()) {
                    // 官方口径：客户端中途断开时，服务端仍会把这次解析执行完并计费；我们能做的是
                    // 不再等它、也不把这次外呼记成上游超时/网络失败（否则排障时会怪错人）。
                    console.error('[parse-doc] FILES-CLIENT-ABORT 客户端已断开，外呼已中止（官方解析可能仍在进行并计费）');
                    return;
                }
                const timedOut = isTimeoutOnly(err);
                if (timedOut)
                    console.error('[parse-doc] FILES-TIMEOUT ' + FILES_CALL_TIMEOUT_MS + 'ms 无响应');
                else if (isAbortError(err))
                    console.error('[parse-doc] FILES-ABORT 外呼被中止');
                else
                    console.error('[parse-doc] FILES-NETWORK ' + String(err?.message || err));
                sendJson(res, {
                    ok: false,
                    error: timedOut ? 'timeout' : String(err?.message || err),
                    hint: timedOut ? '解析超时了，换小一点的文件再试' : '网络没接上官方接口',
                });
                return;
            }
            // 外呼期间客户端走了：文件可能已经在官方解析完并保存/计费，但结果没有收件人。
            // 不再往死连接写回包（写了也只会触发 EPIPE/ECONNRESET 噪音），只留一条诊断。
            if (client.gone()) {
                console.error('[parse-doc] FILES-CLIENT-GONE 客户端已断开，解析结果不再回包（官方可能已保存并计费）');
                return;
            }
            const errObj = r && r.data && r.data.error ? r.data.error : null;
            if (!r || !r.ok || errObj) {
                const status = Number(r && r.status) || 0;
                const msg = String((errObj && errObj.message) || (r && r.text) || '').slice(0, 200);
                console.error('[parse-doc] FILES-FAIL status=' + status + ' ' + msg);
                sendJson(res, {
                    ok: false,
                    error: errObj ? String(errObj.code || 'PARSE_FAILED') : ('HTTP ' + status),
                    detail: msg,
                    hint: parseFailureHint(status, errObj),
                });
                return;
            }
            const data = r.data || {};
            const fileId = String(data.id || '');
            // 与 /chat 的 fileId 白名单保持同一门槛（file-api- 后至少 8 位）：
            // 这里若放行过短的 id，解析接口会回 ok，但聊天路由会把它当非法值静默丢掉，
            // 主人看到的是「文档已解析」+ 模型完全没读到文档，很难排查。
            if (!/^file-api-[A-Za-z0-9_-]{8,}$/.test(fileId)) {
                console.error('[parse-doc] FILES-BAD-ID ' + JSON.stringify(String(fileId).slice(0, 60)));
                sendJson(res, { ok: false, error: 'BAD_FILE_ID', hint: '官方没有返回有效的 file_id' });
                return;
            }
            const expiresAt = Number(data.expires_at) || null;
            sendJson(res, {
                ok: true,
                fileId,
                filename: String(data.filename || name),
                bytes: Number(data.bytes) || buf.length,
                purpose: String(data.purpose || purpose),
                expiresAt,
            });
            // 官方只在「确实设置了有效期」时才回 expires_at。没回说明这次 expires_after 没生效，
            // 文件可能永久占着 25 GiB / 10000 个的额度（本插件不做删除调用，只靠 TTL 清理）。
            if (!expiresAt) {
                console.error('[parse-doc] FILES-NO-EXPIRY 官方未返回 expires_at，文件可能不会按 1 小时过期');
            }
        }
        catch (err) {
            try {
                if (client.gone())
                    return;
                sendError(res, err, { ok: false });
            }
            catch { }
        }
        finally {
            client.dispose();
        }
    };
}
