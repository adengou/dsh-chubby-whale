/**
 * host/tts/spawn.ts —— 单次合成（回退路径）：每次 spawn 一个 `python -m edge_tts`
 *
 * 与拆分前的 synthViaCli 行为一致：
 *   · 参数构造走 shared/tts.buildEdgeTtsArgs（-15% 这类负值必须 --rate=-15% 单参数）；
 *   · stdio 只接 stderr（stdout 不需要），stderr 用 StringDecoder 拼，避免多字节字符被劈；
 *   · 超时 kill 子进程并记 stats.timeouts / stats.cliKills；
 *   · 解释器在、但 edge_tts 模块缺失（探测后被卸载/换了解释器）→ 仍归为不可用（501），
 *     其余非 0 退出按普通 Error（路由 500）。
 *   · 调用方中止（req.signal，客户端断连，2026-11-07 B94）：这个 python 是**本请求独占**的，
 *     直接 kill（与常驻 worker 的"不杀"取舍相反，那边是跨请求共享的），并以 name='AbortError'
 *     拒绝 —— 上层据此按中止收尾，不会把这次算成合成失败。
 *
 * kill 兜底（Windows taskkill /T /F）在 tts/common.ts，python 探测与 worker 共用同一份实现。
 */
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { buildEdgeTtsArgs, TTS_UNAVAILABLE } from '../../shared/tts.js';
import { bumpStat, killChild, pythonEnv, shortError, tailText, unavailableError } from './common.js';
/**
 * 中止类错误：name='AbortError'（与 fetch/AbortSignal 同一口径），刻意不带 code ——
 * TTS_UNAVAILABLE 的语义是「本机没 python/edge_tts，改走浏览器朗读」，中止不是它。
 */
function abortError() {
    const e = new Error('tts aborted by caller');
    e.name = 'AbortError';
    return e;
}
/** 回退路径：每次 spawn 一个 python -m edge_tts（与旧实现一致） */
export async function synthViaCli(interp, req, outFile, budgetMs) {
    const args = [...interp.args, ...buildEdgeTtsArgs({ voice: req.voice, rate: req.rate, pitch: req.pitch, text: req.text, out: outFile })];
    const sig = req.signal;
    // 调用方已经放弃：一个进程都别起（连 spawn + kill 都省了；也避免留临时产物）
    if (sig && sig.aborted)
        throw abortError();
    await new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(interp.cmd, args, {
                stdio: ['ignore', 'ignore', 'pipe'],
                windowsHide: true,
                env: pythonEnv(),
            });
        }
        catch (e) {
            reject(unavailableError('python 启动失败：' + shortError(e)));
            return;
        }
        const errDecoder = new StringDecoder('utf8');
        let err = '';
        let settled = false;
        let timer = null;
        function finish(fn) {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            if (sig) {
                try {
                    sig.removeEventListener('abort', onAbort);
                }
                catch { }
            }
            fn();
        }
        function onAbort() {
            // 本请求独占的子进程：abort 直接杀。用 killChild（含 Windows taskkill /T /F 兜底），
            // 免得 python 再起的子进程变成孤儿。计 cliKills：这是真的杀了一个 CLI 进程；
            // 但**不记 timeouts** —— 中止不是超时，两种口径混在一起会让排障时误判成慢机器。
            bumpStat('cliKills');
            killChild(child);
            finish(() => reject(abortError()));
        }
        timer = setTimeout(() => {
            if (settled)
                return;
            bumpStat('timeouts');
            bumpStat('cliKills');
            killChild(child);
            // 走统一收尾（清定时器 / 摘 abort 监听），否则这次请求的 signal 上会留一个死监听
            finish(() => reject(new Error('tts timeout')));
        }, Math.max(1, budgetMs));
        try {
            timer.unref && timer.unref();
        }
        catch { }
        if (sig) {
            try {
                sig.addEventListener('abort', onAbort, { once: true });
            }
            catch { }
        }
        child.stderr?.on('data', (c) => { err = (err + errDecoder.write(c)).slice(-2000); });
        child.on('error', (e) => {
            finish(() => reject(unavailableError('python 启动失败：' + shortError(e))));
        });
        child.on('exit', (code) => {
            finish(() => {
                if (code === 0) {
                    resolve();
                    return;
                }
                const tail = tailText(err);
                if (tail)
                    console.warn('[tts] python 合成失败（退出码 ' + code + '）：' + tail);
                // 解释器在、但 edge_tts 模块缺失（探测后被卸载/换了解释器）→ 仍归为不可用，路由 501
                const missing = /ModuleNotFoundError|No module named|ImportError/.test(err);
                const e = new Error('tts exit ' + code + (tail ? '：' + tail : ''));
                if (missing)
                    e.code = TTS_UNAVAILABLE;
                reject(e);
            });
        });
    });
}
