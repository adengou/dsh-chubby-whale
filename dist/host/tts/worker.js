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
 *
 * 调用方中止（2026-11-07 B94，req.signal = 客户端断连）：
 *   · 等 worker 启动的那段（settleWithin）与等回包的那段都会被 signal 打断，立即回 false，
 *     不再干等到 20s 预算耗尽；
 *   · **刻意不杀 worker**：它是跨请求共享的，杀一次会连带失败掉并发的其它段，还要重付启动开销
 *     （取舍详见 host/tts-engine.ts 的文件头）。做法是把本请求从 pending 里摘掉 ——
 *     python 稍后回包因为找不到对应项而被丢弃；产物由引擎侧作废清理。
 *
 * 跨进程取消指令（2026-11-07 B95 —— 替换 B94 那句「协议没有取消指令」的边界）：
 *   主进程 abort 时，除了摘 pending，还向 worker 的 stdin 写一行 `{"cancel": <id>}`。
 *   id 是这条请求的编号，一定已经随请求写过，所以不存在「取消一个 worker 没见过的 id」。
 *   worker 收到后**不等当前合成跑完**就回一条回执（python 侧由独立读线程发出）：
 *       {"id": <id>, "cancelled": true, "active": <bool>}
 *     · active=true  —— 取消命中了正在跑的那一段：已置停止标记，合成在**下一个分块边界**
 *       停写、不再往产物文件写、也不再回 ok/false；
 *     · active=false —— 该 id 还没轮到（已标记作废，轮到它时直接跳过、不产生产物），
 *       或者早已结束（没有可取消的东西，只回执）。
 *   回执在主进程侧是「识别后丢弃」：pending 在 abort 那一刻就摘掉了，收尾不等回执；
 *   显式认出 {"cancelled":true} 只是不让它走进「合成结果」那条分支，也不把它悬在半空。
 *
 *   python 侧的真实能力边界（如实记，别让人以为能掐断网络）：
 *     edge_tts 的 stream() 是同步等 websocket 收包的，取消标记只能在**收到下一块之后**
 *     被看到。所以「回执立即」成立（读线程发）≠「合成立即停」：真正停写最坏要等下一块
 *     数据到达、或底层连接超时。取消不是 SIGKILL —— 我们仍然不杀共享 worker。
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { IDLE_KILL_MS, READY_TIMEOUT_MS, WORKER_RETRY_MS, bumpStat, killChild, logWarn, pythonEnv, tailText, } from './common.js';
/**
 * 常驻 worker 的 python 源码：导入一次 edge_tts，之后逐行收 JSON、合成、回写文件。
 *
 * 为什么不是「主线程边读 stdin 边合成」（B94 及以前）：那种写法在合成期间根本不读 stdin，
 * 取消指令要等这一段跑完才被看见，回执就永远不是「立刻」。B95 改成：
 *   · 一个 daemon 读线程专门读 stdin：取消行进 take_cancel 立刻回执并置停止标记，
 *     合成请求进队列，由主线程串行执行（保序、与旧实现一样的串行语义）；
 *   · 合成用 edge_tts 的 stream() 分块写盘（本地 7.3.1 实测 save() 就是 stream() 的薄包装），
 *     每块之前看一眼停止标记 —— 命中就不再写产物。
 * 边界：stream() 等 websocket 收包是阻塞在 await 上的，停止标记最坏要等下一块到达才被看到；
 * 回执即时、停写不是瞬时。回执/结果都整行写出（out_lock），不会交错。
 */
const WORKER_SOURCE = `
import sys, json, asyncio, threading, queue


def main():
    try:
        import edge_tts
    except Exception as e:
        print(json.dumps({"ready": False, "error": repr(e)}), flush=True)
        return
    print(json.dumps({"ready": True}), flush=True)

    # Protocol (B95):
    #   request  {"id": N, "text": .., "voice": .., "rate": .., "pitch": .., "out": ..}
    #   cancel   {"cancel": N}                      written by the host on abort
    #   ack      {"id": N, "cancelled": true, "active": bool}
    #   result   {"id": N, "ok": true|false, "error": ..}
    # Boundary: edge_tts stream() blocks while awaiting the next websocket chunk, so the
    # stop flag is only observed *after* that chunk arrives. The ack is immediate (sent by
    # the reader thread) but the actual stop may lag by one chunk / the connection timeout.
    lock = threading.Lock()       # guards cancelled + state
    out_lock = threading.Lock()   # two threads write stdout; keep each line whole
    reqs = queue.Queue()
    cancelled = {}
    state = {"id": None, "ev": None}

    def emit(obj):
        with out_lock:
            print(json.dumps(obj), flush=True)

    def take_cancel(cid):
        with lock:
            cancelled[cid] = True
            while len(cancelled) > 512:
                cancelled.pop(next(iter(cancelled)))
            ev = state["ev"] if state["id"] == cid else None
        if ev is not None:
            ev.set()
        emit({"id": cid, "cancelled": True, "active": ev is not None})

    def reader():
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                continue
            if not isinstance(msg, dict):
                continue
            if "cancel" in msg:
                cid = msg.get("cancel")
                if isinstance(cid, int) and not isinstance(cid, bool):
                    take_cancel(cid)
                continue
            reqs.put(msg)
        reqs.put(None)

    threading.Thread(target=reader, daemon=True).start()

    async def synth(req, out, ev):
        c = edge_tts.Communicate(
            req.get("text") or "",
            req.get("voice") or "zh-CN-XiaoyiNeural",
            rate=req.get("rate") or "+0%",
            pitch=req.get("pitch") or "+0Hz",
        )
        stream = c.stream()
        try:
            with open(out, "wb") as f:
                async for chunk in stream:
                    if ev.is_set():
                        break
                    if chunk.get("type") == "audio":
                        f.write(chunk.get("data") or b"")
        finally:
            # close the websocket now instead of waiting for GC
            try:
                await stream.aclose()
            except Exception:
                pass

    while True:
        req = reqs.get()
        if req is None:
            return
        rid = req.get("id")
        if not isinstance(rid, int) or isinstance(rid, bool):
            continue
        ev = threading.Event()
        with lock:
            state["id"] = rid
            state["ev"] = ev
            stale = cancelled.pop(rid, False)
        if stale:
            # cancelled before it started: write nothing, answer nothing (ack already sent)
            with lock:
                if state["id"] == rid:
                    state["id"] = None
                    state["ev"] = None
            continue
        try:
            asyncio.run(synth(req, str(req.get("out") or ""), ev))
        except Exception as e:
            if not ev.is_set():
                emit({"id": rid, "ok": False, "error": repr(e)})
        else:
            if not ev.is_set():
                emit({"id": rid, "ok": True})
        finally:
            with lock:
                if state["id"] == rid:
                    state["id"] = None
                    state["ev"] = None


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
 * 私有临时目录（进程内只建一次）：worker 脚本的第二落点。
 *
 * ── 为什么要「目录」而不是直接写 tmpdir（2026-11-07 跨平台审计）──────────────
 *   原来的第二落点是 `join(tmpdir(), 'chubby-' + WORKER_FILE)`——一个**固定名字**直接放在
 *   临时根目录里。这在 Windows 上无害（%TEMP% 是每用户目录），但在 Linux/macOS 上
 *   `/tmp` 是全世界可写（mode 1777，只防删不防建）：
 *     · 另一个用户先建同名文件（0644，属他）→ 本进程 writeFile 直接 EACCES，
 *       worker 永远起不来，只能退单次 spawn（每段朗读都慢一截，日志里只有一行警告）；
 *     · 对方先建同名的**符号链接**指向别的文件 → 本进程的写盘会顺着链接写到那个文件上
 *       （CWE-377 不安全临时文件：写到哪由别人决定）；
 *     · 组可写 umask（如 0002 → 文件 0664）时，同组用户还能在我们「读完比对」之后、
 *       python「打开执行」之前把内容换掉（TOCTOU）→ 等于让我们执行任意脚本。
 *   `mkdtempSync` 建的是**本进程独占的新目录**：POSIX 规定权限 0700，umask 只能更严，
 *   别人既写不进来也猜不到名字，上面三条一起消失。Windows 上同样只是"更干净"（无副作用）。
 *
 * ── 为什么用 process.getBuiltinModule 而不是 import ─────────────────────────
 *   现有测试沙箱（test-tts-engine / test-tts-abort / test-tts-cancel）把 `node:fs`
 *   换成只导出 existsSync 的桩；在文件头新加 import 会让那些套件在加载期就炸。
 *   getBuiltinModule 是 Node 22.3+ 的内置模块通道（engines 已声明 >=22.3，client 侧
 *   poem-titles.ts 也是同一手法），既拿到真实实现，又不动模块的 import 面。
 *
 * 建不出来（只读的 /tmp、Node 版本过低）时抛错：调用方按「脚本落盘失败」处理——
 * 退单次 spawn，功能不受影响（只是慢一点），不把插件卡死。
 */
let workerTmpDir = null;
function privateWorkerDir() {
    if (workerTmpDir)
        return workerTmpDir;
    const p = process;
    if (typeof p.getBuiltinModule !== 'function')
        throw new Error('当前 Node 不支持 getBuiltinModule（需要 >=22.3）');
    const fs = p.getBuiltinModule('node:fs');
    if (!fs || typeof fs.mkdtempSync !== 'function')
        throw new Error('取不到 node:fs.mkdtempSync');
    workerTmpDir = String(fs.mkdtempSync(join(tmpdir(), 'chubby-tts-worker-')));
    return workerTmpDir;
}
/**
 * 把 worker 源码落盘。路径一律 join 构造：
 * 优先放本模块同目录（拆分前的 dist/host），随产物走、路径确定；
 * 全局安装/只读镜像写不进去时回退**私有临时目录**（见 privateWorkerDir，不再用固定名）。
 */
async function ensureWorkerFile() {
    const targets = [join(HERE, WORKER_FILE)];
    // 私有目录建不出来时不把它当候选：留着只会让错误信息更乱（真正的落盘错误仍在下面抛出）
    try {
        targets.push(join(privateWorkerDir(), WORKER_FILE));
    }
    catch { }
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
/**
 * 每个 engine 实例一个 runner：worker / starting / 冷却 / seq 都是实例内状态（与拆分前一致）。
 *
 * opts.onCancelSent：一行 {"cancel": id} **真的写进** worker stdin 时回调一次（B95）。
 * 只在这里回传「成功发出取消指令」这一件事——写不进去（管道已坏 / 流已销毁）就不回调，
 * 统计口径因此不会把「想取消但没发出去」算成取消。回调本身不抛异常（调用方只是自增计数）。
 */
export function createWorkerRunner(opts = {}) {
    const { onCancelSent } = opts;
    let seq = 0;
    let worker = null;
    let starting = null;
    /** worker 启动失败后的冷却截止时间（0 = 不冷却） */
    let workerRetryAt = 0;
    /**
     * 向 worker 写一行取消指令 `{"cancel": <id>}`。**不等回执**：回执到达时这条请求的
     * pending 早已摘除（onAbort 里先发指令、再收尾），收尾不依赖 worker 的响应速度。
     * 返回是否真的写进去了 —— false 的两种情况（stdin 已销毁 / write 抛错）都不计数。
     */
    function sendCancel(w, id) {
        const stdin = w.child.stdin;
        if (!stdin || stdin.destroyed)
            return false;
        try {
            stdin.write(JSON.stringify({ cancel: id }) + '\n');
            return true;
        }
        catch (e) {
            // 管道已坏：worker 多半也要死了，这里只记一笔，不改变「本次按中止收尾」的结论
            logWarn('取消指令写入失败（忽略）', e);
            return false;
        }
    }
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
                        // 取消回执（B95）：{"id":N,"cancelled":true,"active":bool}。
                        // pending 在 abort 那一刻就摘掉了（见 synth 的 onAbort），所以这里通常找不到对应项；
                        // 收尾**不等**这条回执。显式认出它的目的有两个：① 不让它走进下面「合成结果」的
                        // 分支（cancelled 不是 ok/false）；② 证明回执没有被静默丢弃——它是被理解后忽略的。
                        // 不在这里打日志：断连是常态，每条刷一行只会淹没真正的失败。
                        if (msg.cancelled === true)
                            continue;
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
     * signal 存在且中止时同样立刻返回 null：客户端都走了，没必要再陪别人把这次启动等完。
     */
    function settleWithin(p, ms, signal) {
        if (signal && signal.aborted)
            return Promise.resolve(null);
        return new Promise((resolve) => {
            let done = false;
            let timer = null;
            function finish(v) {
                if (done)
                    return;
                done = true;
                if (timer)
                    clearTimeout(timer);
                if (signal) {
                    try {
                        signal.removeEventListener('abort', onAbort);
                    }
                    catch { }
                }
                resolve(v);
            }
            function onAbort() { finish(null); }
            timer = setTimeout(() => finish(null), Math.max(1, ms));
            if (signal) {
                try {
                    signal.addEventListener('abort', onAbort, { once: true });
                }
                catch { }
            }
            p.then((v) => finish(v), () => finish(null));
        });
    }
    /**
     * 让 worker 合成到 outFile。true=成功；false=本次不可用（调用方回退单次 spawn）。
     * budgetMs 是**这次调用**的总预算（含等待 ready、含等别人正在启动的 worker），
     * 不是「启动等一份、合成再等一份」——否则默认 20s 预算实际会拖到 30s。
     * 失败一律用返回值表达，不抛异常：抛异常会让上层多一条与回退路径并行的错误分支。
     * req.signal 中止时同样返回 false —— 上层据 signal.aborted 区分「中止」与「真失败」，不重跑。
     */
    async function synth(interp, req, outFile, budgetMs) {
        const sig = req.signal;
        // 调用方已经走了：连 worker 都不必等（也别白等一次启动），直接回「本次不可用」
        if (sig && sig.aborted)
            return false;
        const deadline = Date.now() + Math.max(1, budgetMs);
        const w = await settleWithin(startWorker(interp, deadline - Date.now()), deadline - Date.now(), sig);
        // 启动失败 / 冷却中 / 预算在启动阶段就用完 / 调用方中止 → 交给上层（上层看 signal 决定是
        // 回退单次 spawn 还是按中止收尾）
        if (!w)
            return false;
        const id = ++seq;
        const payload = JSON.stringify({ id, text: req.text, voice: req.voice, rate: req.rate, pitch: req.pitch, out: outFile });
        const ok = await new Promise((resolve) => {
            let settled = false;
            let timer = null;
            function finish(v) {
                if (settled)
                    return;
                settled = true;
                if (timer)
                    clearTimeout(timer);
                // pending 在这里统一摘除：中止后 python 迟到的 ok/false 与取消回执都找不到对应项，
                // 自然被丢弃（回执另有显式分支，见上面的 stdout 解析）
                w.pending.delete(id);
                if (sig) {
                    try {
                        sig.removeEventListener('abort', onAbort);
                    }
                    catch { }
                }
                resolve(v);
            }
            function onAbort() {
                if (settled)
                    return;
                // 客户端走了：立刻放弃等待这一段，但**不杀 worker**（它是跨请求共享的，取舍见文件头）。
                // 先发取消指令（B95）再收尾：python 侧据此标记作废 / 在下一个分块边界停写，并回一条
                // 回执（回执到达时 pending 已摘，被识别后丢弃）。写不进去就不计数 —— 统计口径是
                // 「成功发出取消指令」，不是「想取消」。
                if (sendCancel(w, id)) {
                    try {
                        if (onCancelSent)
                            onCancelSent();
                    }
                    catch { }
                }
                finish(false);
            }
            timer = setTimeout(() => {
                if (settled)
                    return;
                w.pending.delete(id);
                w.dead = true;
                bumpStat('timeouts');
                // 超时：整个 worker 已经不可信（可能卡在网络/ffmpeg 上），杀掉由上层回退单次 spawn。
                // 这里**不发**取消指令：进程马上就没，发出去也没人读。
                killWorker();
                // 走统一的收尾（清定时器 / 摘 abort 监听），避免这次请求的 signal 上留一个死监听
                finish(false);
            }, Math.max(1, deadline - Date.now()));
            // 从 await settleWithin 回到这里之间 signal 仍可能被中止：已中止的 signal 不会再触发
            // abort 事件，不在这兜住就会一路挂到 20s 预算（B95 顺手补上的边界）。
            // 请求还没写出去，所以不需要（也不该）发取消指令。
            if (sig && sig.aborted) {
                finish(false);
                return;
            }
            w.pending.set(id, { resolve: finish, timer });
            if (sig) {
                try {
                    sig.addEventListener('abort', onAbort, { once: true });
                }
                catch { }
            }
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
            // （中止也走这里：同上，进程健康，不能为一次断连连累并发请求。取消指令已经发出去了，
            //  python 会在下一个分块边界停写并回执；这里只是不再等它。）
            // 中止不是合成失败：别把这段的 stderr 当成"回退单次 spawn"的告警打出去（上层会记
            // TTS-CLIENT-ABORT，两种口径混在一起排障时看花眼）。
            if (w.err && !(sig && sig.aborted)) {
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
