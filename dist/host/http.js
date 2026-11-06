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
/**
 * 错误名（B94）：只看 name，不猜 instanceof —— DOMException 跨 realm 不可靠，
 * 测试里的替身错误也只是 Object.assign(new Error(...), { name })。
 * 有的运行时/薄封装会把中止原因再包一层（err.reason = 原始 reason），这里顺手认一层。
 */
function errorName(err) {
    return String((err && err.name) || '');
}
/** 超时/中止类错误 —— **兼容旧语义：TimeoutError 与 AbortError 都算**（既有测试与 asr 路由按此口径） */
export function isTimeoutError(err) {
    const n = errorName(err);
    return n === 'TimeoutError' || n === 'AbortError';
}
/**
 * 只因**调用方**（外部 signal：客户端断连 / 切页 / 上层主动取消）中止 —— AbortError。
 * 依据：fetch 被中止时以 signal.reason 拒绝；AbortController.abort() 的默认 reason 是 AbortError。
 * 与内部超时（TimeoutError）互斥：路由据此把「客户端走了」与「上游太慢」分开记日志/记账
 * （B93 取证：两者混在 isTimeoutError 里时，CHAT-TIMEOUT / ASR-TIMEOUT 分不出是谁先放弃的）。
 */
export function isAbortError(err) {
    return errorName(err) === 'AbortError' || errorName(err && err.reason) === 'AbortError';
}
/**
 * 只是内部**超时**（AbortSignal.timeout(ms) 到点）—— TimeoutError；调用方中止不算。
 * 旧名 isTimeoutError 被「两者都算」的历史语义占着，区分用的新名字另起（B94）。
 */
export function isTimeoutOnly(err) {
    return errorName(err) === 'TimeoutError' || errorName(err && err.reason) === 'TimeoutError';
}
/** N 毫秒后自动中止的 signal（Node 18+ 的 AbortSignal.timeout，项目 engines 要求 >=22） */
export function timeoutSignal(ms) {
    return AbortSignal.timeout(ms);
}
/** 调用方给的 signal 两种写法都认（第 4 个参数 / init.signal）；不是合法 AbortSignal 就当没给 */
function pickSignal(signal, init) {
    const cand = signal || (init && init.signal);
    if (!cand)
        return undefined;
    return typeof cand.addEventListener === 'function' && typeof cand.aborted === 'boolean' ? cand : undefined;
}
/**
 * 取中止原因（B94）：先触发那一方的 reason 原样转发；老运行时 signal 没有 reason 时
 * 按来源补一个**同名**的 DOMException —— 否则内部超时会退化成 AbortError，
 * isTimeoutOnly 就再也认不出「这是超时还是客户端中止」（手写兜底路径的关键）。
 */
function abortReason(src, name) {
    if (src && src.reason !== undefined)
        return src.reason;
    const D = globalThis.DOMException;
    if (typeof D === 'function') {
        try {
            return new D('aborted: ' + name, name);
        }
        catch { }
    }
    const e = new Error('aborted: ' + name);
    e.name = name;
    return e;
}
/**
 * 把「内部超时」和「调用方中止」（客户端断连等外部 signal）合成一个 signal：任一触发都中止外呼。
 *
 * 为什么要合：只用内部超时的话，调用方已经放弃了（客户端 30s 硬超时、切页面、断网），
 * 宿主仍会把付费外呼跑满 ASR_TIMEOUT=60s —— 客户端早就超时重发了一次，等于同一句话付两次钱
 * （2026-11-07 B93 取证）。
 *
 * 两条路：
 *   · 有 AbortSignal.any（Node ≥20.3）就直接用：内部按弱引用管理源 signal 的监听，不会在
 *     长期存活的 signal 上留监听；由此派生的 signal 被 fetch 直接使用；
 *   · 老 Node 没有 any 时手写组合：把**先触发那一方**的 reason 原样转发（超时仍是 TimeoutError、
 *     外部中止仍是 AbortError，isTimeoutError 的口径不变）。
 *     监听怎么收尾（防重复监听/泄漏）：外部 signal 上的转发监听在「触发」或「本次外呼结束」时
 *     立刻摘掉（dispose）；超时 signal 上的监听刻意保留到它到点 —— 那个 signal 是本次调用自己的，
 *     而且超时必须继续盖住响应体读取（fetch resolve 之后才算开始读 body）。
 *     代价：老 Node 上「外部中止」只覆盖到响应头返回为止（之后的 body 读取只受内部超时约束）；
 *     Node ≥20.3 走 any 路径没有这个差别。
 */
function combineSignals(timeout, outer) {
    // 没有外部 signal：原样交回超时 signal —— 与改动前完全一致（错误仍是 TimeoutError）
    if (!outer)
        return { signal: timeout, dispose() { } };
    const AnySig = AbortSignal;
    if (typeof AnySig.any === 'function') {
        try {
            return { signal: AnySig.any([timeout, outer]), dispose() { } };
        }
        catch { }
    }
    const ctl = new AbortController();
    let hooked = false;
    /** 只摘外部 signal 上的转发监听（超时那份要留到到点，body 读取还要靠它兜底） */
    function unhookOuter() {
        if (!hooked)
            return;
        hooked = false;
        try {
            outer.removeEventListener('abort', onAbort);
        }
        catch { }
    }
    function onAbort(ev) {
        unhookOuter();
        // 事件没带源 signal（少数实现）时按「谁已经中止」判来源：绝不能把超时当调用方中止
        const given = ev && (ev.target || ev.currentTarget);
        const src = given || (timeout.aborted ? timeout : outer);
        try {
            ctl.abort(abortReason(src, src === timeout ? 'TimeoutError' : 'AbortError'));
        }
        catch { }
    }
    // 传进来就已经中止的 signal 不会再发事件：先各自判一次，否则这个请求会一直等超时
    if (timeout.aborted || outer.aborted) {
        const src = timeout.aborted ? timeout : outer;
        try {
            ctl.abort(abortReason(src, src === timeout ? 'TimeoutError' : 'AbortError'));
        }
        catch { }
        return { signal: ctl.signal, dispose() { } };
    }
    hooked = true;
    try {
        timeout.addEventListener('abort', onAbort);
    }
    catch { }
    try {
        outer.addEventListener('abort', onAbort);
    }
    catch { }
    return { signal: ctl.signal, dispose: unhookOuter };
}
/**
 * 带超时的 fetch（薄封装：超时拒绝时抛 TimeoutError）。
 * 可选第 4 个参数 signal（也认 init.signal）：调用方中止时立刻中断，错误名为 AbortError；
 * 不传时行为与改动前一致。
 */
export async function fetchWithTimeout(url, init = {}, ms = 30000, signal) {
    const combo = combineSignals(timeoutSignal(ms), pickSignal(signal, init));
    try {
        return await fetch(url, { ...(init || {}), signal: combo.signal });
    }
    finally {
        combo.dispose();
    }
}
/**
 * 带超时的 fetch + 一次性读文本（能解析就顺手给 JSON）。
 * 不因 HTTP 非 2xx 抛错——路由要自己拿 status 决定回什么文案。
 * signal：可选，调用方（如客户端断连）中止时立刻中断外呼。
 */
export async function fetchJson(url, init = {}, ms = 30000, signal) {
    const resp = await fetchWithTimeout(url, init, ms, signal);
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
/**
 * 盯住「客户端是不是走了」（B94：从 routes/asr.ts 的私有实现提成公共件，两条 chat 路由共用）。
 * 返回的 signal 交给 host/http.ts 的外呼（fetchWithTimeout / fetchJson 的第 4 个参数）：
 * 客户端一走，还在等上游的那次付费请求就立刻中止，不必跑满超时、也不把回复写进记忆。
 * onGone 可选：仅供路由在自己的 controller 上收口（如 /chat-stream 的空闲/总时长 controller），
 * 在 ctl.abort() 之后调用一次，抛错只吞掉。
 *
 * 为什么不能只听 req 的 close（Node 24 本机实测，时间线见 scripts/test-asr-abort.mjs）：
 * 请求体读完时 req 就会发 close（此时 req.complete=true、res.writableEnded=false、响应还没写）——
 * 只看 close 会把**每个正常请求**都误判成断连。真正的断连有三种形状：
 *   ① req 'aborted'：请求体还没收完客户端就断了（Node 24 实测会发，虽已标记废弃）；
 *   ② req 'close' 且 req.complete === false：①的兜底（老版本/某些客户端不发 aborted）；
 *   ③ res 'close' 且响应没写完（writableEnded 与 writableFinished 都为 false）：客户端发完了
 *      body、等不到结果先走了 —— 客户端 30s 硬超时就是这个形状（宿主还在跑 30s 的聊天/60s 的识别）。
 * 正常结束的 res 'close' 里 writableFinished=true，不会命中 ③，所以不会误中止正常请求。
 */
export function watchClientGone(req, res, onGone) {
    const ctl = new AbortController();
    let gone = false;
    const mark = () => {
        if (gone)
            return;
        gone = true;
        try {
            ctl.abort();
        }
        catch { }
        if (onGone) {
            try {
                onGone();
            }
            catch { }
        }
    };
    const onReqAborted = () => mark();
    const onReqClose = () => { if (!req || req.complete === false)
        mark(); };
    const onResClose = () => { if (!res || !(res.writableEnded || res.writableFinished))
        mark(); };
    const on = (target, ev, fn) => {
        // 测试里的假 req/res 未必是 EventEmitter：没有 on 就静默跳过（既有用例都是这种形状）
        if (!target || typeof target.on !== 'function')
            return;
        try {
            target.on(ev, fn);
        }
        catch { }
    };
    const off = (target, ev, fn) => {
        if (!target || typeof target.removeListener !== 'function')
            return;
        try {
            target.removeListener(ev, fn);
        }
        catch { }
    };
    on(req, 'aborted', onReqAborted);
    on(req, 'close', onReqClose);
    on(res, 'close', onResClose);
    return {
        signal: ctl.signal,
        gone: () => gone,
        dispose() {
            // req/res 是每请求对象，不摘也不会串到下一个请求；但已结束的 handler 没必要继续响应
            // 'close'/'aborted'（多做一次无意义的 abort），排障时也容易看花眼
            off(req, 'aborted', onReqAborted);
            off(req, 'close', onReqClose);
            off(res, 'close', onResClose);
        },
    };
}
