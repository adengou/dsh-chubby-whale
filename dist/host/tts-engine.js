/**
 * host/tts-engine.ts —— 语音合成引擎（可替换实现）
 *
 * 路由只依赖 TtsEngine 接口：`synthesize({ text, voice, rate, pitch }) → Buffer`。
 * 默认实现调本机 edge-tts（python -m edge_tts），以后换在线 TTS 只需换一个实现，
 * 路由与缓存逻辑不用动。
 *
 * 错误语义（路由据此回 501 让客户端降级到浏览器朗读）：
 *   - 本机没装 python / edge-tts → err.code = 'TTS_UNAVAILABLE'
 *   - 合成超时 / 进程非 0 退出 → 普通 Error
 */
import { spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildEdgeTtsArgs } from '../shared/tts.js';
/** 默认引擎：本机 edge-tts */
export function createEdgeTtsEngine(opts = {}) {
    const python = opts.python || 'python';
    const timeoutMs = opts.timeoutMs || 20000;
    return {
        async synthesize(req) {
            const tmpFile = join(tmpdir(), 'chubby-tts-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.mp3');
            try {
                const args = buildEdgeTtsArgs({ voice: req.voice, rate: req.rate, pitch: req.pitch, text: req.text, out: tmpFile });
                await new Promise((resolve, reject) => {
                    const child = spawn(python, args, { stdio: 'ignore' });
                    const timer = setTimeout(() => { try {
                        child.kill();
                    }
                    catch { } reject(new Error('tts timeout')); }, timeoutMs);
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
                return await readFile(tmpFile);
            }
            finally {
                try {
                    await unlink(tmpFile);
                }
                catch { }
            }
        },
    };
}
