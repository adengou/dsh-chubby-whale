/**
 * host/tts/worker.ts —— 常驻 edge_tts worker 的生命周期（启动/ready/请求/冷却/回收）
 *
 * 实现说明（2026-11-05 改为常驻 worker，2026-11-06 从 tts-engine.ts 拆出）：
 *   原来是「每合成一段就 spawn 一次 python -m edge_tts」，
 *   实测冷合成 4.5 秒，其中约 2.5 秒耗在 python 启动 + import edge_tts 上。
 *   现在改为：第一次用到时启动一个常驻 python 进程（先把 edge_tts 导入好），
 *   之后每段只通过 stdin/stdout 传一行 JSON，省掉反复启动的开销。
 *   若 worker 启动失败（没装依赖 / 崩溃 / 只读环境落盘失败），自动回退到 spawn 单次合成，
 *   行为与旧实现一致；worker 失败后 60 秒内不再重试，避免每段都白等一次启动超时。
 *
 * 并发语义（与拆分前一致）：
 *   · 同一 engine 实例内 startWorker 是单飞：ready 前到达的请求共享同一个启动 Promise，
 *     不会重复 spawn；队列本身没有长度上限，由各请求自己的合成预算兜底。
 *   · 预算口径：每个请求的 budgetMs 覆盖「等 ready / 等别人启动 + 本段等待」全过程，
 *     不是每段各给一份（否则 20s 预算会拖成 30s）。
 *   · ready 成功后运行期崩溃/退出：立刻用返回值失败掉所有排队请求，不必等 20s 超时。
 *   · 只有「进程不可信」（超时 / stdin 写失败）才 kill；某一段合成返回 ok:false 时
 *     保留健康 worker，避免连带拖垮同一时刻的其它请求。
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { IDLE_KILL_MS, READY_TIMEOUT_MS, WORKER_RETRY_MS, bumpStat, killChild, logWarn, pythonEnv, tailText, } from './common.js';
/** 常驻 worker 的 python 源码：导入一次 edge_tts，之后逐行收 JSON、合成、回写文件 */
const WORKER_SOURCE = `
import sys, json, asyncio

def main():
    try:
        import edge_tts
    except Exception as e:
        print(json.dumps({"ready": False, "error": repr(e)}), flush=True)
        return
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        rid = req.get("id")
        out = req.get("out") or ""
        try:
            async def run():
                c = edge_tts.Communicate(
                    req.get("text") or "",
                    req.get("voice") or "zh-CN-XiaoyiNeural",
                    rate=req.get("rate") or "+0%",
                    pitch=req.get("pitch") or "+0Hz",
                )
                await c.save(out)
            asyncio.run(run())
            print(json.dumps({"id": rid, "ok": True}), flush=True)
        except Exception as e:
            print(json.dumps({"id": rid, "ok": False, "error": repr(e)}), flush=True)

main()
`;
const WORKER_FILE = 'tts-worker-v1.py';
/**
 * 本模块所在目录（dist/host/tts）的上一级（dist/host）。tsc 产物是 ESM，没有 __dirname；
 * Node 22+ 有 import.meta.dirname，退路是 fileURLToPath(import.meta.url)。
 * 拆分前 tts-engine.ts 就在 dist/host，这里加 '..' 保持 worker 脚本落盘路径与旧实现一致
 * （dist/host/tts-worker-v1.py），不依赖进程 cwd、不手拼分隔符。
 */
const HERE = join(typeof import.meta.dirname === 'string'
    ? String(import.meta.dirname)
    : fileURLToPath(new URL('.', import.meta.url)), '..');
/**
 * 把 worker 源码落盘。路径一律 join 构造：
 * 优先放本模块同目录（拆分前的 dist/host），随产物走、路径确定；
 * 全局安装/只读镜像写不进去时回退系统临时目录。
 */
async function ensureWorkerFile() {
    const targets = [join(HERE, WORKER_FILE), join(tmpdir(), 'chubby-' + WORKER_FILE)];
    let lastError = null;
    for (const p of targets) {
        try {
            const old = existsSync(p) ? await readFile(p, 'utf8').catch(() => '') : '';
            if (old !== WORKER_SOURCE)
                await writeFile(p, WORKER_SOURCE, 'utf8');
            return p;
        }
        catch (e) {
            lastError = e;
        }
    }
    throw lastError || new Error('tts worker script not writable');
}
/** 每个 engine 实例一个 runner：worker / starting / 冷却 / seq 都是实例内状态（与拆分前一致） */
export function createWorkerRunner() {
    let seq = 0;
    let worker = null;
    let starting = null;
    /** worker 启动失败后的冷却截止时间（0 = 不冷却） */
    let workerRetryAt = 0;
    function killWorker() {
        const w = worker;
        if (!w)
            return;
        worker = null;
        bumpStat('workerKills');
        if (w.idleTimer) {
            try {
                clearTimeout(w.idleTimer);
            }
            catch { }
        }
        for (const [, p] of w.pending) {
            try {
                clearTimeout(p.timer);
            }
            catch { }
            // 用返回值而不是异常告诉调用方「这个 worker 没了，去走单次 spawn」
            try {
                p.resolve(false);
            }
            catch { }
        }
        w.pending.clear();
        w.dead = true;
        killChild(w.child);
    }
    function touchIdle(w) {
        if (w.dead)
            return;
        if (w.idleTimer) {
            try {
                clearTimeout(w.idleTimer);
            }
            catch { }
        }
        w.idleTimer = setTimeout(() => { try {
            killWorker();
        }
        catch { } }, IDLE_KILL_MS);
        try {
            w.idleTimer.unref && w.idleTimer.unref();
        }
        catch { }
    }
    function startWorker(interp, readyTimeoutMs) {
        if (worker && !worker.dead)
            return Promise.resolve(worker);
        if (starting)
            return starting;
        // 近期启动失败过 → 冷却期内直接回退单次 spawn，不每段白等一次 ready 超时
        if (workerRetryAt && Date.now() < workerRetryAt)
            return Promise.resolve(null);
        const run = async () => {
            let pyFile = '';
            try {
                pyFile = await ensureWorkerFile();
            }
            catch (e) {
                logWarn('worker 脚本落盘失败，改用单次 spawn', e);
                return null;
            }
            let child;
            try {
                child = spawn(interp.cmd, [...interp.args, pyFile], {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    windowsHide: true,
                    env: pythonEnv(),
                });
            }
            catch (e) {
                logWarn('worker 启动失败，改用单次 spawn', e);
                return null;
            }
            bumpStat('workerStarts');
            const w = {
                child,
                buf: '',
                pending: new Map(),
                idleTimer: null,
                dead: false,
                err: '',
                outDecoder: new StringDecoder('utf8'),
                errDecoder: new StringDecoder('utf8'),
            };
            const ok = await new Promise((resolve) => {
                let settled = false;
                let timer = null;
                const finish = (v) => {
                    if (settled)
                        return;
                    settled = true;
                    if (timer)
                        clearTimeout(timer);
                    resolve(v);
                };
                const readyMs = Math.max(1, Math.min(READY_TIMEOUT_MS, readyTimeoutMs));
                timer = setTimeout(() => { finish(false); killChild(child); }, readyMs);
                try {
                    timer.unref && timer.unref();
                }
                catch { }
                const onData = (chunk) => {
                    w.buf += w.outDecoder.write(chunk);
                    let idx = w.buf.indexOf('\n');
                    while (idx >= 0) {
                        const line = w.buf.slice(0, idx).trim();
                        w.buf = w.buf.slice(idx + 1);
                        idx = w.buf.indexOf('\n');
                        if (!line)
                            continue;
                        let msg = null;
                        try {
                            msg = JSON.parse(line);
                        }
                        catch {
                            continue;
                        }
                        if (!msg)
                            continue;
                        if (msg.ready === true) {
                            finish(true);
                            continue;
                        }
                        if (msg.ready === false) {
                            w.err = (w.err + ' ' + String(msg.error || '')).slice(-2000);
                            finish(false);
                            continue;
                        }
                        if (typeof msg.id === 'number') {
                            const p = w.pending.get(msg.id);
                            if (p) {
                                w.pending.delete(msg.id);
                                if (msg.ok === false && msg.error)
                                    w.err = (w.err + ' ' + String(msg.error)).slice(-2000);
                                p.resolve(Boolean(msg.ok));
                            }
                        }
                    }
                };
                child.stdout?.on('data', onData);
                child.stderr?.on('data', (c) => { w.err = (w.err + w.errDecoder.write(c)).slice(-2000); });
                // 管道自身的 error（EPIPE / 被子进程关掉）必须有人接：流上未处理的 'error'
                // 会变成未捕获异常，直接带走宿主进程。真正的失败由 pending 的预算兜底。
                child.stdout?.on('error', () => { });
                child.stderr?.on('error', () => { });
                child.stdin?.on('error', () => { });
                child.on('error', () => finish(false));
                child.on('exit', () => finish(false));
            });
            if (!ok) {
                workerRetryAt = Date.now() + WORKER_RETRY_MS;
                if (w.err)
                    console.warn('[tts] worker 启动失败（' + interp.label + '）：' + tailText(w.err));
                else
                    console.warn('[tts] worker 启动失败（' + interp.label + '）：未收到 ready');
                killChild(child);
                return null;
            }
            worker = w;
            // 运行期 worker 崩溃/退出：立刻失败掉所有排队请求，别等 20s 超时
            child.on('exit', (code) => {
                w.dead = true;
                if (worker === w)
                    worker = null;
                if (w.err)
                    console.warn('[tts] worker 退出（' + code + '）：' + tailText(w.err));
                for (const [, p] of w.pending) {
                    try {
                        clearTimeout(p.timer);
                    }
                    catch { }
                    try {
                        p.resolve(false);
                    }
                    catch { }
                }
                w.pending.clear();
            });
            touchIdle(w);
            return w;
        };
        starting = run();
        const p = starting;
        // 成功/失败都要清 starting；用 then(两个处理器) 而不是 finally，
        // 避免派生 Promise 在 run() 抛异常时变成未处理拒绝（Node 默认会因此终止宿主进程）
        const clear = () => { if (starting === p)
            starting = null; };
        void p.then(clear, clear);
        return p;
    }
    /**
     * 在预算内等一个 Promise 落地：超时返回 null（不取消原 Promise——startWorker 是单飞共享的，
     * 别的请求还要用它）。用在这里是为了让「等 ready / 等别的请求启动 worker」也算进本次预算。
     */
    function settleWithin(p, ms) {
        return new Promise((resolve) => {
            let done = false;
            let timer = null;
            const finish = (v) => {
                if (done)
                    return;
                done = true;
                if (timer)
                    clearTimeout(timer);
                resolve(v);
            };
            timer = setTimeout(() => finish(null), Math.max(1, ms));
            p.then((v) => finish(v), () => finish(null));
        });
    }
    /**
     * 让 worker 合成到 outFile。true=成功；false=本次不可用（调用方回退单次 spawn）。
     * budgetMs 是**这次调用**的总预算（含等待 ready、含等别人正在启动的 worker），
     * 不是「启动等一份、合成再等一份」——否则默认 20s 预算实际会拖到 30s。
     * 失败一律用返回值表达，不抛异常：抛异常会让上层多一条与回退路径并行的错误分支。
     */
    async function synth(interp, req, outFile, budgetMs) {
        const deadline = Date.now() + Math.max(1, budgetMs);
        const w = await settleWithin(startWorker(interp, deadline - Date.now()), deadline - Date.now());
        // 启动失败 / 冷却中 / 预算在启动阶段就用完了 → 交给上层单次 spawn
        if (!w)
            return false;
        const id = ++seq;
        const payload = JSON.stringify({ id, text: req.text, voice: req.voice, rate: req.rate, pitch: req.pitch, out: outFile });
        const ok = await new Promise((resolve) => {
            let settled = false;
            let timer = null;
            const finish = (v) => {
                if (settled)
                    return;
                settled = true;
                if (timer)
                    clearTimeout(timer);
                resolve(v);
            };
            timer = setTimeout(() => {
                if (settled)
                    return;
                settled = true;
                w.pending.delete(id);
                w.dead = true;
                bumpStat('timeouts');
                // 超时：整个 worker 已经不可信（可能卡在网络/ffmpeg 上），杀掉由上层回退单次 spawn
                killWorker();
                resolve(false);
            }, Math.max(1, deadline - Date.now()));
            w.pending.set(id, { resolve: finish, timer });
            try {
                w.child.stdin?.write(payload + '\n');
            }
            catch (e) {
                // stdin 写不进去 = 管道已坏，这个 worker 不能再用
                w.pending.delete(id);
                logWarn('worker 写入失败，回退单次 spawn', e);
                killWorker();
                finish(false);
            }
        });
        if (!ok) {
            // 注意：这里**不杀** worker。走到这里只可能有两种情况：
            //   ① 上面已经杀掉了（超时 / 写失败）——再杀是空操作；
            //   ② worker 回了 {"ok":false}（例如某段文本 NoAudioReceived）——进程本身健康，
            //      杀掉会连带失败掉其它并发请求，还要重新付出 worker 启动开销。
            if (w.err) {
                console.warn('[tts] worker 合成失败，回退单次 spawn：' + tailText(w.err));
                w.err = '';
            }
            return false;
        }
        touchIdle(w);
        return true;
    }
    return {
        async warm(interp) {
            const w = await startWorker(interp, READY_TIMEOUT_MS);
            return Boolean(w);
        },
        synth,
        kill() {
            try {
                killWorker();
            }
            catch { }
        },
        dispose() {
            try {
                killWorker();
            }
            catch { }
        },
    };
}
