/**
 * host/routes/asr.ts —— 语音识别路由（DeepSeek 官方 /v1/tools/asr）
 * POST JSON { audio: base64, format: 'wav' } → { text }
 * Key 由入口注入（getDeepseekKey），路由不再自己读 config.json / 环境变量。
 * 体积：请求体（base64）上限 12MB → 413；解码后音频上限 8MB → 同样 413（口径统一，2026-11-07）
 * 外呼超时 60 秒；**客户端断开（30s 硬超时/切页/断网）立刻中止外呼**，不再把付费识别跑满 60s（B93）
 *
 * 2026-11-14：旧 ASR 全链路下线（主人决定，**无兜底**）。现在只走官方，
 * 官方只收 16-bit PCM WAV / Ogg；客户端录音后已统一转 WAV，转不动的音频直接回明确的错误，
 * 不再悄悄换供应商（换供应商会让「谁在听」变得不可见）。
 */
import { hashBytes } from '../../shared/hash.js';
import { isInterruptWord, isNoiseText } from '../../shared/noise.js';
import { fetchJson, isAbortError, isTimeoutOnly, sendTooLarge, watchClientGone } from '../http.js';
import { readJsonBody } from '../body.js';
import { sendJson, sendError } from '../respond.js';
/** DeepSeek 官方语音识别（2026-11-13 全家桶 API）：只要 file 字段，WAV/Ogg，语种自动 */
const OFFICIAL_ENDPOINT = 'https://api.deepseek.com/v1/tools/asr';
/** 官方只收 WAV/Ogg，本路由只按 WAV 构造 multipart */
const OFFICIAL_FORMAT = 'wav';
/** 汉字（含扩展 A） */
const HAN_RE = /[\u3400-\u4DBF\u4E00-\u9FFF]/;
/** 拉丁字母 */
const LATIN_RE = /[A-Za-z]/;
/** 明显不是英语的常见词（西/葡/法/意/越等），命中即判非英语 */
const NON_EN_STOP = /\b(el|la|los|las|lo|los|una|uno|unos|unas|de|del|que|para|por|com|con|não|nao|voce|você|muito|isso|aqui|está|esta|más|pero|como|quando|onde|obrigado|gracias|hola|bonjour|merci|je|suis|vous|nous|le|les|des|du|et|est|dans|pour|avec|sur|pas|plus|tout|fait|être|avoir|il|che|di|per|sono|una|della|delle|degli|essere|avere|ou|seja|partir|momento|homem|ser|torna|gente|fazer|tem|que|é|os|as|um|uma|em|no|na|nos|nas|do|da|dos|das|se|ao|aos|à|às|pelo|pela)\b/i;
/** 拉丁字母里的重音字符（英语基本不用） */
const ACCENTED_LATIN = /[\u00C0-\u024F\u0300-\u036F]/;
/** 英文启发式：拉丁字母、无重音、无常见非英语词，且像一句英语 */
function looksEnglish(text) {
    if (!LATIN_RE.test(text))
        return false;
    if (ACCENTED_LATIN.test(text))
        return false;
    const lower = text.toLowerCase();
    if (NON_EN_STOP.test(lower))
        return false;
    const words = lower.match(/[a-z]{2,}/g) || [];
    if (words.length >= 2)
        return true;
    return words.length >= 1 && /^(hello|hi|hey|thanks|thank|please|okay|ok|bye|goodbye|sorry|yes|stop|wait)$/.test(words[0]);
}
/**
 * 输出脚本是否符合识别语言：
 *   zh    → 必须含汉字（纯外语/纯数字/符号一律拒绝）
 *   en    → 必须含拉丁字母
 *   zh-en → 中文或英语（聊天语言=自动时用这个，只放中英，不放其它语种）
 *   auto  → 不拦（asrLanguage=auto 的旧行为）
 */
/**
 * 环境噪声误识别的典型形态：纯英文且只有 1-2 个词（"No, no" / "Okay" / "Thank you"）。
 * ASR 在静音/噪声上会编这类短英文——它不该被当主人说的话上行。
 * 真主人说英文一般更长（>=3 词）或带中文。
 */
function isShortEnglishNoise(text) {
    const s = String(text || '').trim();
    if (!s)
        return false;
    if (/[\u4e00-\u9fa5]/.test(s))
        return false;
    const words = s.split(/\s+/).filter(Boolean);
    if (words.length > 2)
        return false;
    if (!/^[A-Za-z][A-Za-z,'.?!\- ]*$/.test(s))
        return false;
    return true;
}
function scriptAccepted(text, lang) {
    if (lang === 'auto')
        return true;
    if (lang === 'en')
        return LATIN_RE.test(text);
    if (lang === 'zh-en')
        return HAN_RE.test(text) || looksEnglish(text);
    return HAN_RE.test(text);
}
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
            // format 会被拼进 multipart 头，必须白名单，否则可 CRLF 注入伪造表单段。
            // 缺省 wav：客户端现在只会传 WAV（录音后统一转码），缺字段时按 WAV 处理。
            const rawFormat = typeof body?.format === 'string' ? body.format.trim().toLowerCase() : OFFICIAL_FORMAT;
            if (!/^(webm|wav|mp3)$/.test(rawFormat)) {
                sendJson(res, { ok: false, error: 'bad format', text: '' }, 400);
                return;
            }
            const format = rawFormat;
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
            // 官方只收 WAV/Ogg：非 WAV 不再换供应商，直接把原因说清楚（客户端转码失败时走这里）
            if (format !== OFFICIAL_FORMAT) {
                console.error('[asr] AUDIO-FORMAT ' + format + '（官方只收 WAV）');
                sendJson(res, {
                    ok: false,
                    error: 'unsupported format',
                    text: '',
                    hint: '这段录音没能转成 WAV，官方语音识别收不了；打字也能聊',
                });
                return;
            }
            const deepseekKey = String(opts.getDeepseekKey() || '');
            if (!deepseekKey) {
                sendJson(res, {
                    ok: false,
                    error: 'NO_KEY',
                    text: '',
                    hint: '没配 DeepSeek Key（deepseekKey），语音识别用不了；聊天、念诗、说书、打字都照常',
                });
                return;
            }
            // 用完整音频字节做 key（只取前 4000 字符容易撞 key）
            // key 里带引擎名与模型名：换 ASR 模型后不会命中旧文本
            // key 里还必须带 format：同一份字节在 multipart 里声明的 Content-Type / filename 不同，
            // 上游的解码方式就不同。原来只按「模型 + 字节」缓存，实测同一份字节先用 format=wav
            // 识别成功，再以 format=webm 上传会直接命中上一次的文本（cached:true）——A 容器的结果
            // 顶了 B 容器的请求。v1 前缀的旧条目没有 format，刻意升到 v2 让它们自然失效（7 天 TTL 内
            // 最多少几次命中，不会读出别人的文本）。
            // v3：识别语言也进 key——同一段音频换 language（zh/en/auto）会得到不同文本，
            // 不把 asrLang 写进 key 的话，切语言后仍命中旧语言的缓存（2026-11-07 严查发现）。
            // 识别语言优先级：请求里的聊天语言（zh/en/auto）→ config.json 的 asrLanguage（zh/en/auto）→ zh。
            // 为什么：聊天语言=自动时主人会说英语，但 asrLanguage 默认 zh 的脚本闸门会把纯英文全丢掉，
            // 表现为"说英语没一点反应"。聊天语言=自动时上游也不锁 zh（自动检测），闸门只放中/英。
            // v6（2026-11-14）：旧 ASR 下线，引擎固定 official——旧缓存里可能躺着别家引擎的
            // 识别文本，升版本让它们自然失效，避免「换引擎后还念旧结果」。
            const rawChatLang = typeof body?.lang === 'string' ? String(body.lang).trim().toLowerCase() : '';
            const chatLang = rawChatLang === 'zh' || rawChatLang === 'en' || rawChatLang === 'auto' ? rawChatLang : '';
            const rawLang = opts.language ? String(opts.language() || '').trim().toLowerCase() : '';
            const configLang = rawLang === 'en' || rawLang === 'auto' ? rawLang : 'zh';
            const upstreamLang = chatLang ? (chatLang === 'auto' ? 'auto' : chatLang) : configLang;
            const gateLang = chatLang ? (chatLang === 'auto' ? 'zh-en' : chatLang) : (configLang === 'auto' ? 'auto' : configLang);
            const ck = hashBytes(Buffer.concat([Buffer.from('v6|official|official-asr|' + upstreamLang + '|' + gateLang + '|' + format + '|'), buf]));
            if (opts.cache) {
                const hit = await opts.cache.getJson(ck, 'json', ASR_CACHE_MAX_AGE);
                if (hit && typeof hit.text === 'string') {
                    // 旧缓存里可能还躺着外语（v3 之前的条目 7 天内有效）：命中也要过闸门，
                    // 不合格就当作没命中，重新识别一次（识别结果同样会被闸门拦）。
                    if (scriptAccepted(hit.text, gateLang)) {
                        sendJson(res, { ok: true, text: hit.text, cached: true });
                        return;
                    }
                    console.error('[asr] CACHE-SCRIPT-SKIP lang=' + gateLang + ' text=' + JSON.stringify(String(hit.text).slice(0, 60)));
                }
            }
            // 构造 multipart：官方只要一个 file 字段（不需要 model / language，语种自动）
            const boundary = '----chubbywhale' + Math.random().toString(36).slice(2, 10);
            const payload = Buffer.concat([
                Buffer.from('--' + boundary + '\r\n' +
                    'Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n' +
                    'Content-Type: audio/wav\r\n\r\n'),
                buf,
                Buffer.from('\r\n--' + boundary + '--\r\n'),
            ]);
            let r = null;
            try {
                r = await fetchJson(OFFICIAL_ENDPOINT, {
                    method: 'POST',
                    headers: {
                        authorization: 'Bearer ' + deepseekKey,
                        'content-type': 'multipart/form-data; boundary=' + boundary,
                    },
                    body: payload,
                }, ASR_TIMEOUT, client.signal);
            }
            catch (err) {
                if (client.gone()) {
                    console.error(LOG_CLIENT_ABORT_OUTBOUND);
                    return;
                }
                const timedOut = isTimeoutOnly(err);
                if (timedOut)
                    console.error('[asr] ASR-TIMEOUT ' + ASR_TIMEOUT + 'ms 无响应，已中止');
                else if (isAbortError(err))
                    console.error('[asr] ASR-ABORT 外呼被中止（非内部超时）');
                else
                    console.error('[asr] ASR-NETWORK ' + String(err?.message || err));
                sendJson(res, { ok: false, error: (timedOut || isAbortError(err)) ? 'timeout' : String(err?.message || err), text: '' });
                return;
            }
            if (!r) {
                sendJson(res, { ok: false, error: 'no asr provider', text: '' });
                return;
            }
            if (!r.ok) {
                console.error('[asr] ASR-HTTP ' + r.status);
                sendJson(res, { ok: false, error: 'HTTP ' + r.status + ' ' + String(r.text || '').slice(0, 200), text: '' });
                return;
            }
            const recognized = String(r.data?.text || '').trim();
            // 脚本闸门（2026-11-07 严查）：ASR 在静音/噪声/音乐上会"编"外语
            // （实测纯静音 → "No."；缓存里还有西/葡/越/泰整句）。language=zh 并不会阻止它。
            // 中文模式下：一个汉字都没有的输出一律当噪声（不写缓存、不上行），
            // 否则会被当主人说的话写进记忆，模型还会跟着回英文。
            if (recognized && !scriptAccepted(recognized, gateLang)) {
                console.error('[asr] SCRIPT-REJECT lang=' + gateLang + ' text=' + JSON.stringify(recognized.slice(0, 60)));
                sendJson(res, { ok: true, text: '', noise: true, rejected: 'script' });
                return;
            }
            // 静音/气口/片头片尾会被识别成"嗯""谢谢观看"这类编词：
            // ① 不写缓存（缓存里曾堆满 17 字节的噪声条目）② 当空文本返回，别让上层当真话
            // 打断词（停/别/不/闭嘴/打住）例外：它们和单字气口同形，但必须原样上行——
            // 否则客户端的「朗读时喊停」直通路径永远收不到指令（2026-11-06 分身取证）。
            const noise = isNoiseText(recognized) || isShortEnglishNoise(recognized);
            if (isShortEnglishNoise(recognized))
                console.error('[asr] SHORT-EN-NOISE ' + JSON.stringify(recognized.slice(0, 40)));
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
