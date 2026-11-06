/**
 * host/routes/story.ts —— 说书路由（薄 HTTP 层）
 * 选段/进度/连播队列在 host/story/player.ts，读盘与 Worker 缓存在 host/story/repo.ts；
 * 这里只解析请求参数、读 x-client-id、回 JSON。
 *
 * 方法约定（2026-11-06 审计补）：
 *   · books / start / next 只接受 GET —— 客户端就是 GET，连续播放也沿用这个既有协议；
 *   · reset 只接受 POST —— 它清进度、改「当前书」，属于状态变更，不能被 GET/预取/爬虫顺手触发。
 * 参数校验（2026-11-06 审计补）：书名/提示词 trim 后限长，并挡掉路径分隔符、控制字符与 `..`；
 *   云端清单里的书名是外部数据，不能原样透传给按文件名读盘的实现。
 */
import { readJsonBody } from '../body.js';
import { sendTooLarge } from '../http.js';
import { sendJson, sendError } from '../respond.js';
/** 兼容旧导出：作者表已随业务移到 host/story/player.ts */
export { STORY_AUTHORS } from '../story/player.js';
/** 书名/提示词上限：最长书名 4 字，64 已留足余量；超长一律拒，不拿超长串做模糊匹配 */
const MAX_BOOK_LEN = 64;
/** POST /reset 请求体上限：只有一个 book 字段，4KB 足够 */
const RESET_MAX_BODY = 4 * 1024;
/** 书名里不允许出现：路径分隔符、控制字符、上跳片段（`..`） */
const BAD_BOOK_RE = /[\\/\u0000-\u001F\u007F]|\.\./;
export function createStoryHandlers(opts) {
    /** 客户端标识只保留 \w.-，最长 64；拿不到时用空串共用单队列（照旧） */
    function clientId(req) {
        try {
            const raw = req?.headers?.['x-client-id'];
            const v = Array.isArray(raw) ? raw[0] : raw;
            if (typeof v !== 'string')
                return '';
            return v.replace(/[^\w.-]/g, '').slice(0, 64);
        }
        catch {
            return '';
        }
    }
    function methodOf(req) {
        return String((req && req.method) || 'GET').toUpperCase();
    }
    /**
     * 书名参数校验。start 允许空（空=接着当前书讲），reset 必须给书名。
     * @returns value 合法书名；error 非空表示应回 400（`no book` / `bad book`）
     */
    function readBookParam(raw) {
        const value = String(raw == null ? '' : raw).trim();
        if (!value)
            return { value: '', error: 'no book' };
        if (value.length > MAX_BOOK_LEN || BAD_BOOK_RE.test(value))
            return { value: '', error: 'bad book' };
        return { value, error: '' };
    }
    function sendBadRequest(res, error) {
        sendJson(res, { ok: false, error }, 400);
    }
    /** 405 + Allow：错误码语义统一放这里，别各路由自己拼 */
    function rejectMethod(res, allow) {
        try {
            res.setHeader('allow', allow);
        }
        catch { }
        sendJson(res, { ok: false, error: 'method not allowed' }, 405);
    }
    /**
     * 说书接口一律 no-store：/next /start 是会推进进度的 GET，
     * 被浏览器/中间缓存按 URL 复用会重复念同一段或跳段。
     */
    function noStore(res) {
        try {
            res.setHeader('cache-control', 'no-store');
        }
        catch { }
    }
    async function handleBooks(req, res) {
        noStore(res);
        if (methodOf(req) !== 'GET') {
            rejectMethod(res, 'GET');
            return;
        }
        try {
            sendJson(res, { ok: true, books: await opts.player.books() });
        }
        catch (err) {
            sendError(res, err, { books: [] });
        }
    }
    async function handleStoryStart(req, res) {
        noStore(res);
        if (methodOf(req) !== 'GET') {
            rejectMethod(res, 'GET');
            return;
        }
        try {
            const url = new URL(req.url, 'http://x');
            // 客户端同时带 book 与 hint（同值）；只带 book 的调用方也要能点播，所以 book 作为 hint 的别名
            const hintRaw = url.searchParams.get('hint');
            const bookRaw = url.searchParams.get('book');
            const chosen = String(hintRaw == null ? '' : hintRaw).trim() || String(bookRaw == null ? '' : bookRaw).trim();
            let hint = '';
            if (chosen) {
                const parsed = readBookParam(chosen);
                if (parsed.error) {
                    sendBadRequest(res, parsed.error);
                    return;
                }
                hint = parsed.value;
            }
            const picked = await opts.player.start(hint, clientId(req));
            if ('error' in picked) {
                sendJson(res, { ok: false, error: picked.error });
                return;
            }
            sendJson(res, { ok: true, ...picked.chunk, remain: picked.remain });
        }
        catch (err) {
            sendError(res, err);
        }
    }
    async function handleStoryNext(req, res) {
        noStore(res);
        if (methodOf(req) !== 'GET') {
            rejectMethod(res, 'GET');
            return;
        }
        try {
            const picked = await opts.player.next(clientId(req));
            if ('error' in picked) {
                sendJson(res, { ok: false, error: picked.error });
                return;
            }
            sendJson(res, { ok: true, ...picked.chunk, remain: picked.remain });
        }
        catch (err) {
            sendError(res, err);
        }
    }
    /** 从头讲这本书：清掉该书全部进度（book|index 前缀），并把「当前书」指过去 */
    async function handleStoryReset(req, res) {
        noStore(res);
        if (methodOf(req) !== 'POST') {
            rejectMethod(res, 'POST');
            return;
        }
        try {
            const url = new URL(req.url, 'http://x');
            // 先读体（带上限）：不读就没法回 413，客户端还在发的 body 会一直占着连接
            const body = await readJsonBody(req, RESET_MAX_BODY);
            if (!body.ok) {
                sendTooLarge(res);
                return;
            }
            const fromQuery = url.searchParams.get('book');
            const payload = body.body && typeof body.body === 'object' && !Array.isArray(body.body) ? body.body : {};
            // query 优先（客户端现行写法），body 作为兼容入口；坏 JSON 时 body 退化成 {}，不会把请求打成 500
            const parsed = readBookParam(String(fromQuery == null ? '' : fromQuery).trim() ? fromQuery : payload.book);
            if (parsed.error) {
                sendBadRequest(res, parsed.error);
                return;
            }
            const result = await opts.player.reset(parsed.value, clientId(req));
            if ('error' in result) {
                sendJson(res, { ok: false, error: result.error });
                return;
            }
            sendJson(res, { ok: true, book: result.book });
        }
        catch (err) {
            sendError(res, err);
        }
    }
    return { handleBooks, handleStoryStart, handleStoryNext, handleStoryReset };
}
