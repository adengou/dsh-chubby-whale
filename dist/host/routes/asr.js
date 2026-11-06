/**
 * host/routes/asr.ts —— 语音识别路由（硅基流动 Qwen3-ASR）
 * POST JSON { audio: base64, format: 'webm'|'wav'|'mp3' } → { text }
 * Key 由入口注入（getKey），路由不再自己读 config.json / 环境变量。
 * 体积：请求体（base64）上限 12MB → 413；解码后音频上限 8MB → 同样 413（口径统一，2026-11-07）
 * 外呼超时 60 秒；**客户端断开（30s 硬超时/切页/断网）立刻中止外呼**，不再把付费识别跑满 60s（B93）
 */
import { hashBytes } from '../../shared/hash.js';
import { isInterruptWord, isNoiseText } from '../../shared/noise.js';
import { fetchJson, isTimeoutError, sendTooLarge } from '../http.js';
import { readJsonBody } from '../body.js';
import { sendJson, sendError } from '../respond.js';
const ASR_MODEL = 'Qwen/Qwen3-ASR-1.7B';
const ENDPOINT = 'https://api.siliconflow.cn/v1/audio/transcriptions';
/** 识别结果的缓存有效期：7 天（音频字节内容 hash，同一个录音重放可直接命中） */
const ASR_CACHE_MAX_AGE = 7 * 24 * 3600 * 1000;
/** 请求体上限（base64 之后）：12MB */
const ASR_MAX_BODY = 12 * 1024 * 1024;
/** 解码后的音频上限：8MB */
const ASR_MAX_AUDIO = 8 * 1024 * 1024;
/** 外呼超时：60 秒 */
const ASR_TIMEOUT = 60 * 1000;
/**
 * 客户端已经走了的日志标签：与真正的上游超时/网络错误分开，排障时一眼能分清。
 * 分两条是因为两种时机差一步：外呼发出后断开（中止外呼）/ 请求体还没读完就断开（根本没发起外呼）。
 */
const LOG_CLIENT_ABORT_OUTBOUND = '[asr] ASR-CLIENT-ABORT 客户端已断开，上游外呼已中止（不计入 ASR 失败）';
const LOG_CLIENT_ABORT_REQUEST = '[asr] ASR-CLIENT-ABORT 客户端已断开，请求中止（未发起外呼，不计入 ASR 失败）';
/**
 * 盯住「客户端是不是走了」。返回的 signal 会被合进外呼超时（见 host/http.ts 的 fetchWithTimeout），
 * 客户端一走，还在等上游的那次付费外呼就立刻中止。
 *
 * 为什么不能只听 req 的 close（Node 24 本机实测，时间线见 scripts/test-asr-abort.mjs）：
 * 请求体读完时 req 就会发 close（此时 req.complete=true、res.writableEnded=false、响应还没写）——
 * 只看 close 会把**每个正常请求**都误判成断连。真正的断连有三种形状：
 *   ① req 'aborted'：请求体还没收完客户端就断了（Node 24 实测会发，虽已标记废弃）；
 *   ② req 'close' 且 req.complete === false：①的兜底（老版本/某些客户端不发 aborted）；
 *   ③ res 'close' 且响应没写完（writableEnded 与 writableFinished 都为 false）：客户端发完了
 *      body、等不到结果先走了 —— 客户端 30s 硬超时就是这个形状（宿主还在跑 60s 的那次）。
 * 正常结束的 res 'close' 里 writableFinished=true，不会命中 ③，所以不会误中止正常请求。
 */
function watchClientGone(req, res) {
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
            off(req, 'aborted', onReqAborted);
            off(req, 'close', onReqClose);
            off(res, 'close', onResClose);
        },
    };
}
export function createAsrHandler(opts) {
    return async function handleAsr(req, res) {
        // 先挂上断连观察器：从读 body 到外呼返回的整段都在它的看护下，结束时必须 dispose（finally）
        const client = watchClientGone(req, res);
        try {
            const parsed = await readJsonBody(req, ASR_MAX_BODY);
            if (!parsed.ok) {
                console.error('[asr] BODY-TOO-LARGE > ' + ASR_MAX_BODY + ' bytes');
                sendTooLarge(res);
                return;
            }
            const body = parsed.body;
            const audioB64 = typeof body?.audio === 'string' ? body.audio : '';
            // format 会被拼进 multipart 头，必须白名单，否则可 CRLF 注入伪造表单段
            const rawFormat = typeof body?.format === 'string' ? body.format : 'webm';
            const format = /^(webm|wav|mp3)$/.test(rawFormat) ? rawFormat : 'webm';
            if (!audioB64) {
                sendJson(res, { ok: false, error: 'empty audio' }, 400);
                return;
            }
            // base64 合法性：非法字符解码成空 buffer，会让所有坏音频共用同一个缓存 key
            if (!/^[A-Za-z0-9+/=\r\n]+$/.test(audioB64)) {
                sendJson(res, { ok: false, error: 'bad base64', text: '' }, 400);
                return;
            }
            // 先判 base64 长度（content-length 缺失时的兜底），再解码
            if (audioB64.length > ASR_MAX_BODY) {
                console.error('[asr] BODY-TOO-LARGE base64=' + audioB64.length);
                sendTooLarge(res);
                return;
            }
            const buf = Buffer.from(audioB64, 'base64');
            // 解码后再判音频上限（8MB）。
            // 必须与上面「请求体超限」同一口径回 413：同一个路由对「太大」给出 200/413 两种状态码，
            // 客户端虽只看 ok 字段、表现不变，但代理、网关、访问日志只认状态码——200 会被记成
            // 「识别成功」，排障时查不出来（2026-11-07 B92 实测：8MB+1 字节走的正是这条分支）。
            if (buf.length > ASR_MAX_AUDIO) {
                console.error('[asr] AUDIO-TOO-LARGE ' + buf.length + ' bytes > ' + ASR_MAX_AUDIO);
                sendJson(res, { ok: false, error: 'audio too large', text: '' }, 413);
                return;
            }
            const key = opts.getKey();
            if (!key) {
                sendJson(res, { ok: false, error: 'NO_KEY', text: '', hint: '没配语音识别 Key（siliconflowKey），语音听不见；打字也能聊' });
                return;
            }
            // 用完整音频字节做 key（只取前 4000 字符容易撞 key）
            // key 里带模型名：换 ASR 模型后不会命中旧文本
            // key 里还必须带 format：同一份字节在 multipart 里声明的 Content-Type / filename 不同，
            // 上游的解码方式就不同。原来只按「模型 + 字节」缓存，实测同一份字节先用 format=wav
            // 识别成功，再以 format=webm 上传会直接命中上一次的文本（cached:true）——A 容器的结果
            // 顶了 B 容器的请求。v1 前缀的旧条目没有 format，刻意升到 v2 让它们自然失效（7 天 TTL 内
            // 最多少几次命中，不会读出别人的文本）。
            const ck = hashBytes(Buffer.concat([Buffer.from('v2|' + ASR_MODEL + '|' + format + '|'), buf]));
            if (opts.cache) {
                const hit = await opts.cache.getJson(ck, 'json', ASR_CACHE_MAX_AGE);
                if (hit && typeof hit.text === 'string') {
                    sendJson(res, { ok: true, text: hit.text, cached: true });
                    return;
                }
            }
            // 识别语言：默认 zh（不传会自动检测，短句常被识别成英文）
            const asrLang = 'zh'; // 固定中文：不传该参数时模型自动检测，短句常被识别成英文（"No, no"）
            // 构造 multipart
            const boundary = '----chubbywhale' + Math.random().toString(36).slice(2, 10);
            const mime = format === 'wav' ? 'audio/wav' : format === 'mp3' ? 'audio/mpeg' : 'audio/webm';
            const head = Buffer.from('--' + boundary + '\r\n' +
                'Content-Disposition: form-data; name="model"\r\n\r\n' + ASR_MODEL + '\r\n' +
                '--' + boundary + '\r\n' +
                'Content-Disposition: form-data; name="language"\r\n\r\n' + asrLang + '\r\n' +
                '--' + boundary + '\r\n' +
                'Content-Disposition: form-data; name="file"; filename="audio.' + format + '"\r\n' +
                'Content-Type: ' + mime + '\r\n\r\n');
            const tail = Buffer.from('\r\n--' + boundary + '--\r\n');
            const payload = Buffer.concat([head, buf, tail]);
            let r = null;
            try {
                r = await fetchJson(ENDPOINT, {
                    method: 'POST',
                    headers: {
                        authorization: 'Bearer ' + key,
                        'content-type': 'multipart/form-data; boundary=' + boundary,
                    },
                    body: payload,
                }, ASR_TIMEOUT, client.signal);
            }
            catch (err) {
                // 客户端已经走了（30s 硬超时/切页面/断网重发）：这次外呼是**我们自己** abort 的，
                // 不是上游超时、也不是网络故障。处理口径：
                //   · 不写缓存（没拿到结果，也避免把半截状态记进缓存）；
                //   · 不记失败（不计入 ASR-TIMEOUT/ASR-NETWORK 的排障口径），只留专用诊断；
                //   · 不回包（连接已经断了，没人收；写了也只是往死 socket 上叠一次写）。
                if (client.gone()) {
                    console.error(LOG_CLIENT_ABORT_OUTBOUND);
                    return;
                }
                // 超时/网络错误：用户看到的仍是 ok:false + 空文本，日志里留标签
                if (isTimeoutError(err))
                    console.error('[asr] ASR-TIMEOUT ' + ASR_TIMEOUT + 'ms 无响应，已中止');
                else
                    console.error('[asr] ASR-NETWORK ' + String(err?.message || err));
                sendJson(res, { ok: false, error: isTimeoutError(err) ? 'timeout' : String(err?.message || err), text: '' });
                return;
            }
            if (!r.ok) {
                console.error('[asr] ASR-HTTP ' + r.status);
                sendJson(res, { ok: false, error: 'HTTP ' + r.status + ' ' + String(r.text || '').slice(0, 200), text: '' });
                return;
            }
            const recognized = String(r.data?.text || '').trim();
            // 静音/气口/片头片尾会被识别成"嗯""谢谢观看"这类编词：
            // ① 不写缓存（缓存里曾堆满 17 字节的噪声条目）② 当空文本返回，别让上层当真话
            // 打断词（停/别/不/闭嘴/打住）例外：它们和单字气口同形，但必须原样上行——
            // 否则客户端的「朗读时喊停」直通路径永远收不到指令（2026-11-06 分身取证）。
            const noise = isNoiseText(recognized);
            const interrupt = isInterruptWord(recognized);
            if (opts.cache && recognized && !noise && !interrupt) {
                try {
                    await opts.cache.setJson(ck, { text: recognized });
                }
                catch { }
            }
            sendJson(res, { ok: true, text: noise ? '' : recognized, noise: noise || undefined });
        }
        catch (err) {
            try {
                // 连请求体都没收完客户端就断了（req 'aborted' / ECONNRESET）：同上，不算上游失败、不回包
                if (client.gone()) {
                    console.error(LOG_CLIENT_ABORT_REQUEST);
                    return;
                }
                sendError(res, err, { text: '' });
            }
            catch { }
        }
        finally {
            // 结束就摘监听：req/res 是每请求对象，不摘也不会串到下一个请求，但已经结束的 handler
            // 没必要继续响应 'close'/'aborted'（多做一次无意义的 abort），排障时也容易看花眼
            client.dispose();
        }
    };
}
