/**
 * host/tts-engine.ts —— 语音合成引擎（可替换实现）· 编排层
 *
 * 路由只依赖 TtsEngine 接口：`synthesize({ text, voice, rate, pitch }) → Buffer`。
 * 本文件只做编排：解析解释器（先探测、超时则交给合成验证）→ 常驻 worker 合成 →
 * 失败回退单次 spawn → 读回 mp3 → 升级解释器缓存。具体实现在 tts/ 子模块：
 *   tts/python.ts  解释器候选与探测（parseExplicit / defaultCandidates / probeOne / 进程内缓存）
 *   tts/worker.ts  常驻 worker 生命周期（启动 / ready / 请求 / 冷却 / idle 回收）
 *   tts/spawn.ts   单次合成回退（python -m edge_tts）
 *   tts/common.ts  共享常量、统计、UTF-8 子进程工具与 kill 兜底
 * 对外导出保持拆分前不变：createEdgeTtsEngine / getTtsEngineStats / resetTtsInterpreterProbe
 * 与类型 TtsEngine / TtsSynthRequest / TtsEngineStats。
 *
 * ── 跨平台支持矩阵（2026-11-06 加入 python 解释器探测）─────────────────────
 *   平台      默认探测顺序（未显式指定时）        说明
 *   Windows   python → py -3 → python3            安装器常把 python 注册成商店别名；py -3 覆盖多版本；
 *                                                  python3 只在部分 MSYS/Store 环境存在，排最后兜底
 *   Linux     python3 → python                    多数发行版不预装 python，python3 才是标准名；
 *                                                  若 python 存在也可能是 python2（探测 import 会失败）
 *   macOS     python3 → python                    系统自带 /usr/bin/python3，不保证有 python
 *
 *   显式指定优先级最高，且命中后不再回落到自动探测（避免"配错了却悄悄换成另一个解释器"）：
 *   ① 环境变量 CHUBBY_WHALE_PYTHON（支持完整路径，也支持 `py -3` 这种命令带参数写法）
 *   ② createEdgeTtsEngine({ python })（代码级覆盖；当前 index.ts 不传，留给测试/宿主定制）
 *   ③ 上面矩阵里的平台默认链
 *
 *   探测与缓存的细节见 tts/python.ts。超时的候选保留为 pending，
 *   交给常驻 worker 的 ready（≤10s）或首次单次合成验证；只有确定不可用才缓存 501 语义。
 *   全部失败 → synthesize() 抛 code='TTS_UNAVAILABLE'（路由回 501），
 *   客户端据此降级到浏览器 speechSynthesis；warm() 永不抛异常。
 *
 * ── 子进程健壮性 ───────────────────────────────────────────────────────────
 *   · 所有 python 子进程统一 UTF-8：spawn 时注入 PYTHONIOENCODING=utf-8 / PYTHONUTF8=1，
 *     stdout/stderr 用 StringDecoder 拼接，避免多字节字符跨 chunk 被劈成 U+FFFD。
 *   · 合成总预算 20 秒（含常驻 worker 启动），超时 kill；退出码非 0 时取 stderr
 *     前 500 字进日志（只记 python 报错，不记合成文本与请求内容）。
 *   · Windows 上 child.kill() 对 python 再起的子进程无效，可能留孤儿：只在 kill 后
 *     500ms 仍未退出时用 `taskkill /PID <pid> /T /F` 兜底（参数数组、不拼 shell 字符串）。
 *
 * ── 常驻 worker（2026-11-05）──────────────────────────────────────────────
 *   原来是「每合成一段就 spawn 一次 python -m edge_tts」，
 *   实测冷合成 4.5 秒，其中约 2.5 秒耗在 python 启动 + import edge_tts 上。
 *   现在改为：第一次用到时启动一个常驻 python 进程（先把 edge_tts 导入好），
 *   之后每段只通过 stdin/stdout 传一行 JSON，省掉反复启动的开销。
 *   若 worker 启动失败（没装依赖 / 崩溃 / 只读环境落盘失败），自动回退到 spawn 单次合成，
 *   行为与旧实现一致；worker 失败后 60 秒内不再重试，避免每段都白等一次启动超时。
 *
 * 错误语义（路由据此回 501 让客户端降级到浏览器朗读）：
 *   - 本机没装 python / edge-tts → err.code = 'TTS_UNAVAILABLE'
 *   - 合成超时 / 进程非 0 退出 / 网络失败 → 普通 Error（路由 500）
 */
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, logWarn, readStats, unavailableError } from './tts/common.js';
import { markInterpreterVerified, peekProbeOutcome, resolveProbe } from './tts/python.js';
import { createWorkerRunner } from './tts/worker.js';
import { synthViaCli } from './tts/spawn.js';
// 探测缓存清理：排障/测试用，旧导入路径（tts-engine）继续可用
export { resetTtsInterpreterProbe } from './tts/python.js';
/** 只读统计快照：给测试和排障用，调用方改不到内部状态 */
export function getTtsEngineStats() {
    const outcome = peekProbeOutcome();
    const stats = readStats();
    return {
        interpreter: outcome && outcome.interp ? outcome.interp.label : null,
        probeState: !outcome ? 'none' : outcome.interp ? 'ok' : outcome.failed ? 'unavailable' : 'timeout',
        probeCached: Boolean(outcome),
        probes: stats.probes,
        probeFailures: stats.probeFailures,
        probeTimeouts: stats.probeTimeouts,
        lastProbeError: stats.lastProbeError,
        workerStarts: stats.workerStarts,
        workerKills: stats.workerKills,
        cliKills: stats.cliKills,
        timeouts: stats.timeouts,
    };
}
export function createEdgeTtsEngine(opts = {}) {
    // 合成总预算：默认 20s，允许测试传更小值，但绝不放大到 20s 以上
    const timeoutMs = Math.min(Math.max(1, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);
    const worker = createWorkerRunner();
    function remaining(startedAt) {
        return Math.max(1, timeoutMs - (Date.now() - startedAt));
    }
    return {
        /** 预热：提前解析解释器并拉起常驻 worker；任何失败都吞掉，不影响插件启动 */
        async warm() {
            try {
                const outcome = await resolveProbe(opts.python);
                const interp = outcome.interp || (outcome.failed ? null : outcome.pending);
                if (!interp)
                    return;
                // worker 的 ready 行本身就是一次完整的 import edge_tts 验证：
                // 探测超时（慢机器）时，这里成功即可把解释器升级为可用并缓存。
                const ok = await worker.warm(interp);
                if (ok)
                    markInterpreterVerified(interp, outcome);
            }
            catch (e) {
                logWarn('warm 失败（忽略）', e);
            }
        },
        async synthesize(req) {
            const startedAt = Date.now();
            const outcome = await resolveProbe(opts.python);
            // 确定不可用 → 501；探测超时（慢机器）→ 用 pending 候选直接合成验证
            const interp = outcome.interp || (outcome.failed ? null : outcome.pending);
            if (!interp) {
                // 探测阶段已确认不可用（缓存，每段不再重试）：路由据此回 501
                throw unavailableError('本机没有可用的 python 解释器，或未安装 edge_tts');
            }
            const tmpFile = join(tmpdir(), 'chubby-tts-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.mp3');
            try {
                let done = false;
                try {
                    done = await worker.synth(interp, req, tmpFile, remaining(startedAt));
                }
                catch {
                    // worker 超时/崩溃：下一步回退单次 spawn；此处不把异常直接抛给调用方
                    done = false;
                }
                if (!done) {
                    worker.kill();
                    await synthViaCli(interp, req, tmpFile, remaining(startedAt));
                }
                const buf = await readFile(tmpFile);
                if (!buf || !buf.length)
                    throw new Error('tts produced empty audio');
                // 合成成功即证明解释器可用：把"探测超时、未确认"的候选升级并缓存，后续不再犹豫
                markInterpreterVerified(interp, outcome);
                return buf;
            }
            finally {
                try {
                    await unlink(tmpFile);
                }
                catch { }
            }
        },
        /** 测试/宿主关闭用：停掉常驻 worker（不属于 TtsEngine 端口，路由不依赖） */
        dispose() {
            try {
                worker.dispose();
            }
            catch { }
        },
    };
}
