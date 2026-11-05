/**
 * host/routes/tts.ts —— 语音合成路由（可复用模块，带缓存）
 * 调本机 Python edge-tts（zh-CN-XiaoyiNeural）合成 mp3，异步不阻塞。
 * 缓存：文本+音色+语速+音调 hash → 复用 mp3（省时间、省调用）
 * 语速由请求体 rate 决定（说书 -15%，普通聊天 +0%），服务端不再写死。
 */
import { spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hashKey } from '../cache.js';
import { readBody, isBodyTooLarge, sendTooLarge } from '../http.js';
import { buildEdgeTtsArgs, normalizeRate } from '../../shared/tts.js';
/** 单次合成的安全上限：客户端已按 80 字分段，这里只防整本大 JSON 被一次送进来 */
const MAX_TEXT = 6000;
/** 请求体上限：80 字一段的 JSON 只有几百字节，64KB 足够；超了多半是误发了整本数据 */
const TTS_MAX_BODY = 64 * 1024;
export function createTtsHandler(opts) {
    const DEFAULT_VOICE = opts.voice || 'zh-CN-XiaoyiNeural';
    const cache = opts.cache;
    return async function handleTts(req, res) {
        let tmpFile = '';
        try {
            // 走统一 readBody 带上限：原来直接 for-await 读 req，客户端塞多大就收多大，能把内存吃掉
            let raw;
            try {
                raw = await readBody(req, TTS_MAX_BODY);
            }
            catch (err) {
                if (isBodyTooLarge(err)) {
                    console.error('[tts] BODY-TOO-LARGE > ' + TTS_MAX_BODY + ' bytes');
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
            const msg = typeof body?.text === 'string' ? body.text.trim().slice(0, MAX_TEXT) : '';
            const voiceIn = typeof body?.voice === 'string' ? body.voice : '';
            const isZh = /[\u4e00-\u9fa5]/.test(msg);
            let voice = (voiceIn && /^[a-zA-Z0-9-]+$/.test(voiceIn)) ? voiceIn : '';
            if (!voice || voice === 'auto' || voice === 'zh-CN-XiaoyiNeural' || voice === 'en-US-AnaNeural') {
                voice = isZh ? 'zh-CN-XiaoyiNeural' : 'en-US-AnaNeural';
            }
            // 请求体里带了合法 rate 就用它（说书 -15%），没带默认 +0%
            const rate = normalizeRate(body?.rate, '+0%');
            // 音高：允许请求体指定（带情绪的语气），非法值回落到默认
            const pitchIn = typeof body?.pitch === 'string' ? body.pitch.trim() : '';
            const pitch = /^[+-]\d{1,3}Hz$/.test(pitchIn) ? pitchIn : (isZh ? '+10Hz' : '+15Hz');
            if (!msg) {
                res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: 'empty text' }));
                return;
            }
            // 缓存命中（rate/pitch 必须进 key，否则慢速说书和普通聊天会串味）
            const ck = hashKey(voice + '|' + rate + '|' + pitch + '|' + msg);
            if (cache) {
                const hit = await cache.getJson(ck, 'mp3');
                if (hit) {
                    res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' });
                    res.end(hit);
                    return;
                }
            }
            tmpFile = join(tmpdir(), 'chubby-tts-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.mp3');
            const args = buildEdgeTtsArgs({ voice, rate, pitch, text: msg, out: tmpFile });
            await new Promise((resolve, reject) => {
                const child = spawn('python', args, { stdio: 'ignore' });
                const timer = setTimeout(() => { try {
                    child.kill();
                }
                catch { } reject(new Error('tts timeout')); }, 20000);
                child.on('exit', (code) => {
                    clearTimeout(timer);
                    if (code === 0)
                        resolve();
                    else
                        reject(new Error('tts exit ' + code));
                });
                // 本机没装 python / edge-tts → 标记 TTS_UNAVAILABLE，让客户端降级到浏览器朗读
                child.on('error', (err) => {
                    clearTimeout(timer);
                    const e = new Error('tts unavailable: ' + String(err?.message || err));
                    e.code = 'TTS_UNAVAILABLE';
                    reject(e);
                });
            });
            const buf = await readFile(tmpFile);
            if (cache) {
                try {
                    await cache.setJson(ck, buf, 'mp3');
                }
                catch { }
            }
            res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' });
            res.end(buf);
        }
        catch (err) {
            try {
                // 合成不可用（没装 python/edge-tts）→ 501，客户端据此改用浏览器 speechSynthesis；其余 → 500
                const unavailable = err && err.code === 'TTS_UNAVAILABLE';
                res.writeHead(unavailable ? 501 : 500, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({
                    ok: false,
                    code: unavailable ? 'TTS_UNAVAILABLE' : 'TTS_FAILED',
                    error: String(err?.message || err),
                }));
            }
            catch { }
        }
        finally {
            if (tmpFile) {
                try {
                    await unlink(tmpFile);
                }
                catch { }
            }
        }
    };
}
