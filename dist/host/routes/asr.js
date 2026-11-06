/**
 * host/routes/asr.ts —— 语音识别路由（硅基流动 Qwen3-ASR）
 * POST JSON { audio: base64, format: 'webm'|'wav'|'mp3' } → { text }
 * Key 由入口注入（getKey），路由不再自己读 config.json / 环境变量。
 * 体积：请求体（base64）上限 12MB → 413；解码后音频上限 8MB；外呼超时 60 秒
 */
import { hashBytes } from '../cache.js';
import { isNoiseText } from '../../shared/noise.js';
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
export function createAsrHandler(opts) {
    return async function handleAsr(req, res) {
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
            // 解码后再判音频上限（8MB）
            if (buf.length > ASR_MAX_AUDIO) {
                sendJson(res, { ok: false, error: 'audio too large', text: '' });
                return;
            }
            const key = opts.getKey();
            if (!key) {
                sendJson(res, { ok: false, error: 'NO_KEY', text: '', hint: '没配语音识别 Key（siliconflowKey），语音听不见；打字也能聊' });
                return;
            }
            // 用完整音频字节做 key（只取前 4000 字符容易撞 key）
            // key 里带模型名：换 ASR 模型后不会命中旧文本
            const ck = hashBytes(Buffer.concat([Buffer.from('v1|' + ASR_MODEL + '|'), buf]));
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
                }, ASR_TIMEOUT);
            }
            catch (err) {
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
            const noise = isNoiseText(recognized);
            if (opts.cache && recognized && !noise) {
                try {
                    await opts.cache.setJson(ck, { text: recognized });
                }
                catch { }
            }
            sendJson(res, { ok: true, text: noise ? '' : recognized, noise: noise || undefined });
        }
        catch (err) {
            try {
                sendError(res, err, { text: '' });
            }
            catch { }
        }
    };
}
