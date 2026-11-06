/**
 * host/respond.ts —— HTTP 响应小工具（可复用）
 *
 * 背景：各路由原先每处都手写 `res.writeHead(200, {'content-type': ...}) + res.end(JSON.stringify(...))`，
 * 全仓 40 余处，改响应头/字段时容易漏。这里只做「写头 + 序列化」这一件事，业务字段仍由调用方决定。
 *
 * 注意：本插件大量使用「HTTP 200 承载业务失败（ok:false）」的既有约定，sendError 默认沿用；
 * 需要真状态码（400/405/500）时显式传 status。
 */
/**
 * 响应是否已经写过：已发头或已 end 过就别再写。
 * Node 的 ServerResponse 二次 writeHead 会抛 ERR_HTTP_HEADERS_SENT；而本插件大量
 * 「catch 里无条件 sendError」的写法（backup / culture / misc / tts 等）一旦在回包之后再抛，
 * 这个异常会从 catch 里冒出去，宿主 webserver 只能把连接 destroy 掉——客户端反而丢掉已经
 * 写好的那份响应。这里统一改成「已经回过就不动」：保留第一份响应，也不再往外抛。
 */
function alreadyResponded(res) {
    return Boolean(res && (res.headersSent || res.writableEnded));
}
/** 返回 JSON 响应；status 缺省 200（与既有路由一致） */
export function sendJson(res, payload, status = 200) {
    if (alreadyResponded(res))
        return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
}
/** `{ ok: false, error: <err.message||err>, ...extra }`，默认 HTTP 200 */
export function sendError(res, error, extra, status = 200) {
    const message = String((error && error.message) || error);
    sendJson(res, Object.assign({ ok: false, error: message }, extra || {}), status);
}
/** 纯文本响应（图片缺失等非 JSON 场景） */
export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
    if (alreadyResponded(res))
        return;
    res.writeHead(status, { 'content-type': contentType });
    res.end(text);
}
/** 二进制响应（音频等）；额外响应头由调用方给，保持各接口原有缓存策略 */
export function sendBuffer(res, buffer, contentType, headers = {}) {
    if (alreadyResponded(res))
        return;
    res.writeHead(200, Object.assign({ 'content-type': contentType }, headers));
    res.end(buffer);
}
/** SSE 响应头（流式聊天）；不再被缓冲的 x-accel-buffering 是给反向代理看的 */
export function sendSseHeaders(res) {
    if (alreadyResponded(res))
        return;
    res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
    });
}
