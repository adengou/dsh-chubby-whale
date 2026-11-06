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
 *   - 调用方中止（req.signal，客户端断连）→ Error 且 name='AbortError'（没有 code，路由按断连处理）
 *
 * ── 断连中止（2026-11-07 B94，B95 补上跨进程取消）─────────────────────────
 *   路由把「客户端走了」变成 req.signal 传进来。本层只做四件事，且刻意**不杀**常驻 worker：
 *     ① 立刻放弃等待：探测 / 等 worker / 等回包三段都被 signal 打断（raceAbort、tts/worker.ts 的
 *        pending 摘除），不再干等到 20s 预算耗尽；
 *     ② 清理并作废本次产物：临时 mp3 照旧在 finally 删；worker 那条路如果 python 还在往里写
 *        （Windows 句柄没放开、unlink 报 EBUSY），再排一次延迟清理，绝不复用这份文件；
 *     ③ 不回退重跑：worker 因 abort 返回 false 时不再走单次 spawn，避免同一段文本合成两遍。
 *     ④ 向共享 worker 发一条跨进程取消指令（B95）：{"cancel": <id>}。python 侧命中在跑的合成
 *        就在下一个分块边界停写、没轮到就标记作废，两种情况都立刻回一条取消回执；worker 仍然不杀。
 *        协议格式与「回执即时 ≠ 停写即时」的能力边界写在 tts/worker.ts 文件头。
 *   取舍（为什么"不等待"而不是"连 python 一起停"）：常驻 worker 是**跨请求共享**的（并发的另几段
 *   还在排队），为一次断连杀掉它，会连带失败掉别人的合成、还要重付一次启动 + import 开销
 *   （实测冷启动约 2.5s）。B94 的做法是让 worker 把这一段跑完、回包被丢弃；B95 进一步让它
 *   「停写 + 回执」，实测省掉这段网络与磁盘上的白跑，但取消本身仍受分块边界限制（不是 SIGKILL）。
 *   单次 spawn 回退路径不受此限：那个 python 是**本请求独占**的，abort 时直接 kill（tts/spawn.ts）。
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
  /**
   * 成功向常驻 worker 发出跨进程取消指令的次数（B95；跨 engine 实例累计，口径同其它计数）。
   * 「成功」= 那行 {"cancel": <id>} 真的写进了 worker 的 stdin（write 没抛、流没销毁）；
   * 管道已坏写不进去的不算。**不是「中止次数」**：还没把请求交给 worker 就中止的
   * （等探测 / 等 worker 启动 / 传入已中止的 signal）不计入；单次 spawn 回退路径直接 kill
   * 本请求独占的子进程，也没有协议消息，同样不计入。
   */
  aborted: number
}

/**
 * 取消指令成功写出的计数（B95）。刻意放在模块级而不是 engine 实例里：与 tts/common.ts 的其它
 * 统计同口径（跨实例累计），排障时不会因为换了个 engine 实例就归零。
 * 只由 createWorkerRunner 的 onCancelSent 回调自增 —— 那里已经保证了「真的写出去了」。
 */
let abortedSends = 0

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
    aborted: abortedSends,
  }
}

export function createEdgeTtsEngine(opts: { python?: string; timeoutMs?: number } = {}): TtsEngine & { dispose(): void } {
  // 合成总预算：默认 20s，允许测试传更小值，但绝不放大到 20s 以上
  const timeoutMs = Math.min(Math.max(1, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS)
  // 取消指令写成功一次就 +1（B95）；写不进去时 runner 不回调，所以这里不用再判一次
  const worker = createWorkerRunner({ onCancelSent: () => { abortedSends++ } })
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
      const sig = req.signal
      // 调用方已经放弃（客户端断连）：连解释器探测都不必等，直接按中止返回
      if (sig && sig.aborted) throw abortError()
      const startedAt = Date.now()
      // 探测结果进程内缓存、并发共享：abort 只让「本请求」不再等它，探测自己继续跑完
      // （≤2s，别的请求与后续请求还要用它的结论；取消共享探测反而会让别人多等一次）
      const outcome = await raceAbort(resolveProbe(opts.python), sig)
      if (!outcome) throw abortError()
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
          // req 里已经带着 signal：worker 的「等 ready / 等回包」两段都会被 abort 打断（tts/worker.ts）
          done = await worker.synth(interp, req, tmpFile, remaining(startedAt))
        } catch (e) {
          // 兜底：万一 worker 层破了"失败不抛异常"的契约，也按回退处理
          logWarn('worker 合成异常，回退单次 spawn', e)
          done = false
        }
        // worker 侧「按 abort 提前放弃」也返回 false：这里必须先认出中止，否则会误走单次 spawn、
        // 把刚被放弃的那段又完整合成一遍（B94 要治的浪费之一）。
        if (sig && sig.aborted) throw abortError()
        if (!done) {
          const left = remaining(startedAt)
          // 预算已经被 worker 吃光时，再 spawn 一个 python 只会立刻被超时杀掉，
          // 纯属白起进程 + 白留临时文件：直接按超时失败。
          if (left < MIN_CLI_BUDGET_MS) throw new Error('tts timeout')
          // 回退路径同样带 signal：abort 时直接杀掉这个一次性子进程（本请求独占，杀得干净）
          await synthViaCli(interp, req, tmpFile, left)
          if (sig && sig.aborted) throw abortError()
        }
        const buf = await readFile(tmpFile)
        if (!buf || !buf.length) throw new Error('tts produced empty audio')
        // 合成成功即证明解释器可用：把"探测超时、未确认"的候选升级并缓存，后续不再犹豫
        markInterpreterVerified(interp, outcome)
        return buf
      } finally {
        const removed = await removeTemp(tmpFile)
        // 中止时 python 可能还在往这个文件里写（常驻 worker 刻意不杀，取舍见文件头）：
        // Windows 上句柄没放开会 EBUSY，removeTemp 的几次重试（约 300ms）未必等到它写完。
        // 这里再排一次延迟清理，别让一个作废请求的 mp3 躺到下次引擎创建时才被 sweep 掉。
        if (!removed && sig && sig.aborted) scheduleLateCleanup(tmpFile)
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
/** 中止后临时文件第一次删不掉（python 还握着句柄）时，隔多久再补删一次 */
const LATE_CLEANUP_MS = 5000

/**
 * 中止类错误：name='AbortError'，与 fetch / AbortSignal 同一口径，排障时能和「真正的合成失败」
 * 「超时」分开。**刻意不设 code**：TTS_UNAVAILABLE 的语义是「本机没有 python/edge_tts，改走浏览器
 * 朗读」，中止不是它；路由会先用 client.gone() 把断连摘出去，所以也不会落进失败记账。
 */
function abortError(message = 'tts aborted by caller'): Error {
  const e: any = new Error(message)
  e.name = 'AbortError'
  return e
}

/**
 * 在 signal 中止时立刻放弃等待：被等的 Promise 继续跑（探测结果仍会写进模块级缓存），
 * 我们只是不再等它 —— 「abort 立刻返回」就靠这个，不需要取消共享工作。
 * 不传 signal 时原样返回（同一个 Promise 身份），行为与改动前完全一致。
 * 被等的 Promise 自己 reject 时按 undefined 收尾：探测那侧契约是「绝不 reject」，
 * 真 reject 了也只会让本次按中止返回，而不是把未知异常拖进合成的失败口径。
 */
function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  if (!signal) return p
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise<T | undefined>((resolve) => {
    let settled = false
    const onAbort = (): void => finish(undefined)
    const finish = (v: T | undefined): void => {
      if (settled) return
      settled = true
      try { signal.removeEventListener('abort', onAbort) } catch { }
      resolve(v)
    }
    try { signal.addEventListener('abort', onAbort, { once: true }) } catch { }
    p.then((v) => finish(v), () => finish(undefined))
  })
}

/**
 * 延迟再清一次临时文件（只在 abort 路径、且第一次删失败时用）。
 * 定时器 unref：不拖住宿主退出，也不让测试因为一个清理定时器挂着不结束。
 */
function scheduleLateCleanup(file: string): void {
  try {
    const timer = setTimeout(() => { void removeTemp(file) }, LATE_CLEANUP_MS)
    if ((timer as any).unref) (timer as any).unref()
  } catch { }
}

/**
 * 删临时文件：Windows 上 python 可能还握着 mp3 句柄（edge_tts 是边下边写），
 * 立即 unlink 会 EBUSY/EPERM。重试几次；真的删不掉就返回 false 交给调用方决定
 * （abort 路径会再排一次延迟清理，其它路径留给下次启动的 sweepStaleTmp）。
 */
async function removeTemp(file: string): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    try {
      await unlink(file)
      return true
    } catch {
      if (i === 2) return false
      await new Promise((r) => setTimeout(r, i === 0 ? 100 : 200))
    }
  }
  return false
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
