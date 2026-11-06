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
import { readdir, readFile, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, logWarn, readStats, unavailableError } from './tts/common.js'
import { markInterpreterVerified, peekProbeOutcome, resolveProbe } from './tts/python.js'
import { createWorkerRunner } from './tts/worker.js'
import { synthViaCli } from './tts/spawn.js'
import type { TtsEngine, TtsSynthRequest } from './ports.js'

// 类型定义在端口层（host/ports.ts）；这里再导出，保持旧导入路径可用
export type { TtsEngine, TtsSynthRequest }
// 探测缓存清理：排障/测试用，旧导入路径（tts-engine）继续可用
export { resetTtsInterpreterProbe } from './tts/python.js'

export interface TtsEngineStats {
  /** 命中的解释器（探测通过或合成验证通过；未确认/不可用时为 null） */
  interpreter: string | null
  /** 探测状态：none=未探测，ok=已确认可用，timeout=待合成验证，unavailable=确定不可用 */
  probeState: 'none' | 'ok' | 'timeout' | 'unavailable'
  /** 是否已经有进程内探测结果（含超时未决） */
  probeCached: boolean
  probes: number
  probeFailures: number
  probeTimeouts: number
  lastProbeError: string
  workerStarts: number
  workerKills: number
  cliKills: number
  timeouts: number
}

/** 只读统计快照：给测试和排障用，调用方改不到内部状态 */
export function getTtsEngineStats(): TtsEngineStats {
  const outcome = peekProbeOutcome()
  const stats = readStats()
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
  }
}

export function createEdgeTtsEngine(opts: { python?: string; timeoutMs?: number } = {}): TtsEngine & { dispose(): void } {
  // 合成总预算：默认 20s，允许测试传更小值，但绝不放大到 20s 以上
  const timeoutMs = Math.min(Math.max(1, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS)
  const worker = createWorkerRunner()
  // 进程崩溃/句柄没放开会留下 chubby-tts-*.mp3：启动时顺手扫一次过期残留
  void sweepStaleTmp()

  function remaining(startedAt: number): number {
    return Math.max(1, timeoutMs - (Date.now() - startedAt))
  }

  return {
    /** 预热：提前解析解释器并拉起常驻 worker；任何失败都吞掉，不影响插件启动 */
    async warm(): Promise<void> {
      try {
        const outcome = await resolveProbe(opts.python)
        const interp = outcome.interp || (outcome.failed ? null : outcome.pending)
        if (!interp) return
        // worker 的 ready 行本身就是一次完整的 import edge_tts 验证：
        // 探测超时（慢机器）时，这里成功即可把解释器升级为可用并缓存。
        const ok = await worker.warm(interp)
        if (ok) markInterpreterVerified(interp, outcome)
      } catch (e) {
        logWarn('warm 失败（忽略）', e)
      }
    },
    async synthesize(req: TtsSynthRequest): Promise<Buffer> {
      const startedAt = Date.now()
      const outcome = await resolveProbe(opts.python)
      // 确定不可用 → 501；探测超时（慢机器）→ 用 pending 候选直接合成验证
      const interp = outcome.interp || (outcome.failed ? null : outcome.pending)
      if (!interp) {
        // 探测阶段已确认不可用（缓存，每段不再重试）：路由据此回 501
        throw unavailableError('本机没有可用的 python 解释器，或未安装 edge_tts')
      }
      const tmpFile = join(tmpdir(), 'chubby-tts-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.mp3')
      try {
        // worker 的失败用返回值表达（不抛异常）；进程不可信的两种情况（超时 / stdin 写失败）
        // 由 worker runner 自己 kill，这里不要再补一刀——否则一段文本级失败会连带
        // 杀掉健康的 worker（并发请求被迫改走慢路径，下次还要重付启动开销）。
        let done = false
        try {
          done = await worker.synth(interp, req, tmpFile, remaining(startedAt))
        } catch (e) {
          // 兜底：万一 worker 层破了"失败不抛异常"的契约，也按回退处理
          logWarn('worker 合成异常，回退单次 spawn', e)
          done = false
        }
        if (!done) {
          const left = remaining(startedAt)
          // 预算已经被 worker 吃光时，再 spawn 一个 python 只会立刻被超时杀掉，
          // 纯属白起进程 + 白留临时文件：直接按超时失败。
          if (left < MIN_CLI_BUDGET_MS) throw new Error('tts timeout')
          await synthViaCli(interp, req, tmpFile, left)
        }
        const buf = await readFile(tmpFile)
        if (!buf || !buf.length) throw new Error('tts produced empty audio')
        // 合成成功即证明解释器可用：把"探测超时、未确认"的候选升级并缓存，后续不再犹豫
        markInterpreterVerified(interp, outcome)
        return buf
      } finally {
        await removeTemp(tmpFile)
      }
    },
    /** 测试/宿主关闭用：停掉常驻 worker（不属于 TtsEngine 端口，路由不依赖） */
    dispose(): void {
      try { worker.dispose() } catch { }
    },
  }
}

/** 合成临时文件前缀：只清扫自己产生的文件，绝不动 tmp 里的其它东西 */
const TMP_PREFIX = 'chubby-tts-'
/** 超过 1 小时的残留才清：正在用的文件生命周期是秒级，1 小时的只可能是崩溃遗留 */
const TMP_STALE_MS = 60 * 60 * 1000
/** 回退单次 spawn 至少要留这么多预算，否则不值得起进程 */
const MIN_CLI_BUDGET_MS = 1000

/**
 * 删临时文件：Windows 上 python 可能还握着 mp3 句柄（edge_tts 是边下边写），
 * 立即 unlink 会 EBUSY/EPERM。重试几次再放弃；真的删不掉就留给下次启动的 sweepStaleTmp。
 */
async function removeTemp(file: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try {
      await unlink(file)
      return
    } catch {
      if (i === 2) return
      await new Promise((r) => setTimeout(r, i === 0 ? 100 : 200))
    }
  }
}

/** 启动时清扫：tmp 里超过 1 小时的 chubby-tts-*.mp3（崩溃遗留 / 句柄一直没放开） */
async function sweepStaleTmp(): Promise<void> {
  const dir = tmpdir()
  let names: string[] = []
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(TMP_PREFIX) || !name.endsWith('.mp3')) continue
    const full = join(dir, name)
    try {
      const st = await stat(full)
      if (Date.now() - Number(st.mtimeMs || 0) < TMP_STALE_MS) continue
      await unlink(full)
    } catch { }
  }
}
