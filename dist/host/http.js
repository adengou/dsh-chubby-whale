/**
 * host/http.ts —— 外呼 fetch 超时与请求体读取（可复用模块）
 * 项目没有 Log 模块，超时/网络错误统一走 console.error（标签照 C# 版：CHAT-TIMEOUT / BALANCE-TIMEOUT / ASR-TIMEOUT）
 */
/** 请求体超限的错误码（readBody 抛出，路由据此回 413） */
const BODY_TOO_LARGE = 'BODY_TOO_LARGE';
/**
 * 超限后还愿意「读掉并丢弃」的字节数上限。
 * 为什么需要：readBody 抛错后路由要写 413，但如果先 destroy 了连接，413 永远送不到客户端
 * （客户端只看得到 ECONNRESET，实测见 scripts/test-host-http.mjs）。超一点点是常态
 * （16KB 上限的请求多发了 1KB、2MB 的备份包多打了 200KB），把这点尾巴读空再抛，
 * 413 才真的能回出去；超过预算（对方还在猛发）仍然立刻断连，不拿内存和带宽陪跑。
 */
const DRAIN_GRACE = 1024 * 1024;
function bodyTooLarge() {
    const e = new Error('body too large');
    e.code = BODY_TOO_LARGE;
    return e;
}
/** 是不是请求体超限的错误（路由据此回 413） */
export function isBodyTooLarge(err) {
    return Boolean(err && err.code === BODY_TOO_LARGE);
}
/** 超时/中止类错误（AbortSignal.timeout 抛 TimeoutError，手动 abort 抛 AbortError） */
export function isTimeoutError(err) {
    const n = String((err && err.name) || '');
    return n === 'TimeoutError' || n === 'AbortError';
}
/** N 毫秒后自动中止的 signal（Node 18+ 的 AbortSignal.timeout，项目 engines 要求 >=22） */
export function timeoutSignal(ms) {
    return AbortSignal.timeout(ms);
}
/** 带超时的 fetch（薄封装：超时拒绝时抛 TimeoutError） */
export async function fetchWithTimeout(url, init = {}, ms = 30000) {
    return fetch(url, { ...(init || {}), signal: timeoutSignal(ms) });
}
/**
 * 带超时的 fetch + 一次性读文本（能解析就顺手给 JSON）。
 * 不因 HTTP 非 2xx 抛错——路由要自己拿 status 决定回什么文案。
 */
export async function fetchJson(url, init = {}, ms = 30000) {
    const resp = await fetchWithTimeout(url, init, ms);
    const text = await resp.text().catch(() => '');
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    }
    catch {
        data = null;
    }
    return { ok: resp.ok, status: resp.status, data, text };
}
/** 回 413（请求体超限）：JSON 兜底文案由客户端自己出 */
export function sendTooLarge(res) {
    try {
        // 连接可能已被 abortRequest 断掉：写不出去是预期结果，别让 EPIPE/ECONNRESET 冒成未捕获异常
        if (res && typeof res.on === 'function')
            res.on('error', () => { });
        res.writeHead(413, { 'content-type': 'application/json; charset=utf-8', connection: 'close' });
        res.end(JSON.stringify({ ok: false, error: 'too large' }));
    }
    catch { }
}
/**
 * 超限且「丢弃预算」也用完时把连接断掉。
 * 为什么此时必须断：只从 for-await 里 throw 出去只是「不再消费」，客户端还在发的 body 会继续占着
 * socket，HTTP 服务也走不到 keep-alive 复用，等于每个超大请求漏一条连接。
 * destroy 优先（客户端立刻收到 RST，剩余数据丢弃）；没有 destroy 就 resume 把剩下的读空丢掉。
 * 注意：这条路径客户端收不到 413（连接先断了），所以只在明显超大时才用——
 * 小额超限走 readBody 里的有限 drain，让 413 能送达。
 */
function abortRequest(req) {
    // destroy/半截读取都可能触发 error（EPIPE/ECONNRESET），先挂空监听，避免冒成未捕获异常
    try {
        if (req && typeof req.on === 'function')
            req.on('error', () => { });
    }
    catch { }
    try {
        if (req && typeof req.destroy === 'function') {
            req.destroy();
            return;
        }
    }
    catch { }
    try {
        if (req && typeof req.resume === 'function')
            req.resume();
    }
    catch { }
}
/**
 * 读请求体，超过 maxBytes 判超限并抛 BODY_TOO_LARGE。
 * 两道保险：
 *   · 先看 content-length：声明值已超限就**连读都不读**直接拒（既有语义，调用方据此“不读流、不落盘”）；
 *   · 读的过程中累计超限（无 content-length / 声明偏小）也当场判超限，不把整份大包收进内存。
 *
 * 超限后不立刻 destroy：路由要写 413，先断连接的话客户端只看到 ECONNRESET（413 永远送不到）。
 * 声明超限时函数直接返回、一个字节都不读，连接由 sendTooLarge 的 `connection: close` 收掉；
 * 流式超限时先在 maxBytes + DRAIN_GRACE 的预算内把剩余数据读掉并丢弃，再把错误抛给路由；
 * 预算用尽还不结束才 abortRequest 断连，避免超大/慢速的体占住连接与内存。
 */
export async function readBody(req, maxBytes) {
    const declared = Number(req && req.headers && req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
        throw bodyTooLarge(); // 不读、不断连：让路由的 413 送得出去
    }
    const chunks = [];
    let total = 0;
    let overflow = false;
    for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (!overflow) {
            if (total <= maxBytes) {
                chunks.push(buf);
                continue;
            }
            // 刚越线：半份数据对调用方没意义，先放掉，别继续涨内存
            overflow = true;
            chunks.length = 0;
        }
        if (total > maxBytes + DRAIN_GRACE) {
            abortRequest(req); // 丢弃预算也用完：不陪跑，直接断连
            throw bodyTooLarge();
        }
    }
    if (overflow)
        throw bodyTooLarge(); // 已经读空，路由这时写 413 能送到客户端
    return Buffer.concat(chunks);
}
