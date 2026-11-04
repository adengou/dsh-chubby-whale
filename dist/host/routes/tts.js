/**
 * host/routes/tts.ts —— 语音合成路由（可复用模块，带缓存）
 * 调本机 Python edge-tts（zh-CN-XiaoyiNeural）合成 mp3，异步不阻塞。
 * 缓存：文本+音色 hash → 复用 mp3（省时间、省调用）
 */
import { spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hashKey } from '../cache.js';
export function createTtsHandler(opts) {
    const DEFAULT_VOICE = opts.voice || 'zh-CN-XiaoyiNeural';
    const cache = opts.cache;
    return async function handleTts(req, res) {
        let tmpFile = '';
        try {
            const chunks = [];
            for await (const chunk of req)
                chunks.push(chunk);
            const text = Buffer.concat(chunks).toString('utf8');
            let body = {};
            try {
                body = text ? JSON.parse(text) : {};
            }
            catch {
                body = {};
            }
            const msg = typeof body?.text === 'string' ? body.text.slice(0, 500) : '';
            const voiceIn = typeof body?.voice === 'string' ? body.voice : '';
            const isZh = /[\u4e00-\u9fa5]/.test(msg);
            let voice = (voiceIn && /^[a-zA-Z0-9-]+$/.test(voiceIn)) ? voiceIn : '';
            if (!voice || voice === 'auto' || voice === 'zh-CN-XiaoyiNeural' || voice === 'en-US-AnaNeural') {
                voice = isZh ? 'zh-CN-XiaoyiNeural' : 'en-US-AnaNeural';
            }
            const rate = isZh ? '+12%' : '+8%';
            const pitch = isZh ? '+10Hz' : '+15Hz';
            if (!msg) {
                res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: 'empty text' }));
                return;
            }
            // 缓存命中
            const ck = hashKey(voice + '|' + msg);
            if (cache) {
                const hit = await cache.getJson(ck, 'mp3');
                if (hit) {
                    res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' });
                    res.end(hit);
                    return;
                }
            }
            tmpFile = join(tmpdir(), 'chubby-tts-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.mp3');
            await new Promise((resolve, reject) => {
                const child = spawn('python', ['-m', 'edge_tts', '--voice', voice, '--rate=' + rate, '--pitch=' + pitch, '--text', msg, '--write-media', tmpFile], {
                    stdio: 'ignore',
                });
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
                child.on('error', (err) => { clearTimeout(timer); reject(err); });
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
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
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
