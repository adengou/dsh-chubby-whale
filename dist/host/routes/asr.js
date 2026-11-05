import { hashBytes } from '../cache.js';
import { readSiliconFlowKey } from '../config.js';
import { fetchJson, isBodyTooLarge, isTimeoutError, readBody, sendTooLarge } from '../http.js';
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
export { readSiliconFlowKey };
export function createAsrHandler(opts) {
    return async function handleAsr(req, res) {
        try {
            let raw;
            try {
                raw = await readBody(req, ASR_MAX_BODY);
            }
            catch (err) {
                if (isBodyTooLarge(err)) {
                    console.error('[asr] BODY-TOO-LARGE > ' + ASR_MAX_BODY + ' bytes');
                    sendTooLarge(res);
                    return;
                }
                throw err;
            }
            const text = raw.toString('utf8');
            let body = {};
            try {
                body = text ? JSON.parse(text) : {};
            }
            catch {
                body = {};
            }
            const audioB64 = typeof body?.audio === 'string' ? body.audio : '';
            // format 会被拼进 multipart 头，必须白名单，否则可 CRLF 注入伪造表单段
            const rawFormat = typeof body?.format === 'string' ? body.format : 'webm';
            const format = /^(webm|wav|mp3)$/.test(rawFormat) ? rawFormat : 'webm';
            if (!audioB64) {
                res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: 'empty audio' }));
                return;
            }
            // base64 合法性：非法字符解码成空 buffer，会让所有坏音频共用同一个缓存 key
            if (!/^[A-Za-z0-9+/=\r\n]+$/.test(audioB64)) {
                res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: 'bad base64', text: '' }));
                return;
            }
            // 先判 base64 长度（content-length 缺失时的兜底），再解码
            if (audioB64.length > ASR_MAX_BODY) {
                console.error('[asr] BODY-TOO-LARGE base64=' + audioB64.length);
                sendTooLarge(res);
                return;
            }
            const buf = Buffer.from(audioB64, 'base64');
            // 解码后再判音频上限（8MB）
            if (buf.length > ASR_MAX_AUDIO) {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: 'audio too large', text: '' }));
                return;
            }
            const key = readSiliconFlowKey(opts.pluginDir);
            if (!key) {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: 'NO_KEY', text: '' }));
                return;
            }
            // 用完整音频字节做 key（只取前 4000 字符容易撞 key）
            // key 里带模型名：换 ASR 模型后不会命中旧文本
            const ck = hashBytes(Buffer.concat([Buffer.from('v1|' + ASR_MODEL + '|'), buf]));
            if (opts.cache) {
                const hit = await opts.cache.getJson(ck, 'json', ASR_CACHE_MAX_AGE);
                if (hit && typeof hit.text === 'string') {
                    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: true, text: hit.text, cached: true }));
                    return;
                }
            }
            // 构造 multipart
            const boundary = '----chubbywhale' + Math.random().toString(36).slice(2, 10);
            const mime = format === 'wav' ? 'audio/wav' : format === 'mp3' ? 'audio/mpeg' : 'audio/webm';
            const head = Buffer.from('--' + boundary + '\r\n' +
                'Content-Disposition: form-data; name="model"\r\n\r\n' + ASR_MODEL + '\r\n' +
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
                }, ASR_TIMEOUT);
            }
            catch (err) {
                // 超时/网络错误：用户看到的仍是 ok:false + 空文本，日志里留标签
                if (isTimeoutError(err))
                    console.error('[asr] ASR-TIMEOUT ' + ASR_TIMEOUT + 'ms 无响应，已中止');
                else
                    console.error('[asr] ASR-NETWORK ' + String(err?.message || err));
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: isTimeoutError(err) ? 'timeout' : String(err?.message || err), text: '' }));
                return;
            }
            if (!r.ok) {
                console.error('[asr] ASR-HTTP ' + r.status);
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: 'HTTP ' + r.status + ' ' + String(r.text || '').slice(0, 200), text: '' }));
                return;
            }
            const text2 = String(r.data?.text || '').trim();
            if (opts.cache && text2) {
                try {
                    await opts.cache.setJson(ck, { text: text2 });
                }
                catch { }
            }
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, text: text2 }));
        }
        catch (err) {
            try {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: String(err?.message || err), text: '' }));
            }
            catch { }
        }
    };
}
