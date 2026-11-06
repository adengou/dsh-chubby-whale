/**
 * host/tts-engine.ts —— 语音合成引擎（可替换实现）
 *
 * 路由只依赖 TtsEngine 接口：`synthesize({ text, voice, rate, pitch }) → Buffer`。
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
 *   探测方式：spawn 候选解释器执行 `-c "import edge_tts; print('ok')"`，硬超时 2 秒；
 *   结果（命中的解释器，或"全部不可用"）在本进程内缓存，后续合成不重复探测；
 *   排障/测试可调用 resetTtsInterpreterProbe() 清缓存重探。
 *   注意「超时」≠「不可用」：慢机器/冷缓存上 import edge_tts 可能超过 2 秒（本机实测 2.2s），
 *   超时的候选保留为 pending，交给常驻 worker 的 ready（≤10s）或首次单次合成验证；
 *   只有 ENOENT / 非 0 退出 / 没有 ok 输出才判定为确定不可用并缓存 501 语义。
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
 * 实现说明（2026-11-05 改为常驻 worker）：
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
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'
import { buildEdgeTtsArgs, TTS_PROBE_CODE, TTS_UNAVAILABLE } from '../shared/tts.js'
import type { TtsEngine, TtsSynthRequest } from './ports.js'

// 类型定义在端口层（host/ports.ts）；这里再导出，保持旧导入路径可用
export type { TtsEngine, TtsSynthRequest }

/**
 * 本模块所在目录（dist/host）。tsc 产物是 ESM，没有 __dirname；
 * Node 22+ 有 import.meta.dirname，退路是 fileURLToPath(import.meta.url)。
 * 所有脚本/资源路径都用 join() 从它拼出来，不依赖进程 cwd、不手拼分隔符。
 */
const HERE = typeof (import.meta as any).dirname === 'string'
  ? String((import.meta as any).dirname)
  : fileURLToPath(new URL('.', import.meta.url))

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
`

const WORKER_FILE = 'tts-worker-v1.py'
/** 解释器探测硬超时：任务要求 ≤2s（够 import edge_tts，又不至于让首段等太久） */
const PROBE_TIMEOUT_MS = 2000
/** 合成总预算上限：任务要求 ≤20s（含 worker 启动） */
const DEFAULT_TIMEOUT_MS = 20000
const MAX_TIMEOUT_MS = 20000
/** 常驻 worker 首行 ready 的最长等待（探测已确认 edge_tts 能导入，正常 <2s） */
const READY_TIMEOUT_MS = 10000
/** worker 长时间没人用就退出，别一直占内存；下次有请求会重新拉起 */
const IDLE_KILL_MS = 5 * 60 * 1000
/** worker 启动失败后的冷却时间：这段时间内直接走单次 spawn，不每段重试 */
const WORKER_RETRY_MS = 60 * 1000
/** 日志里 stderr 最多保留的字符数（任务要求前 500 字） */
const STDERR_LOG_MAX = 500

type PythonInterp = { cmd: string; args: string[]; label: string }

type Pending = { resolve: (v: boolean) => void; reject: (e: any) => void; timer: any }

type WorkerState = {
  child: ChildProcess
  buf: string
  pending: Map<number, Pending>
  idleTimer: any
  dead: boolean
  /** python 的 stderr / worker 自报错误，最多留尾部 2000 字，打日志时取前 500 */
  err: string
  outDecoder: StringDecoder
  errDecoder: StringDecoder
}

type ProbeOutcome = {
  /** 命中的解释器（探测通过，或后续合成验证通过） */
  interp: PythonInterp | null
  /** true = 确定不可用（ENOENT / 导入报错 / 没有 ok 输出） */
  failed: boolean
  /** 探测超时、尚未确认的候选（failed=false 且 interp=null 时有效，交给合成验证） */
  pending: PythonInterp | null
  reason: string
}

/** 进程内探测缓存：成功/失败都缓存；失败后不再逐段 spawn 探测 */
const probeCache: { outcome: ProbeOutcome | null; inflight: Promise<ProbeOutcome> | null } = {
  outcome: null,
  inflight: null,
}
let probeGeneration = 0

/** 运行统计（测试与排障用；跨 engine 实例累计，reset 不清零） */
const stats = {
  probes: 0,
  probeFailures: 0,
  probeTimeouts: 0,
  lastProbeError: '',
  workerStarts: 0,
  workerKills: 0,
  cliKills: 0,
  timeouts: 0,
}

/** 子进程统一 UTF-8：Windows 的 python 默认可能按 cp936 读 stdin，中文 JSON 会乱码 */
function pythonEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' }
}

/** 清理控制字符、压空白后截取前 max 字（不打印请求文本，只用于 python 报错） */
function tailText(s: string, max = STDERR_LOG_MAX): string {
  const clean = String(s || '')
    .replace(/[\u0000-\u0008\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.slice(0, max)
}

function shortError(e: any): string {
  const raw = e && (e.message || e.code || String(e))
  return tailText(raw || 'unknown', 300)
}

function logWarn(msg: string, err?: any): void {
  console.warn('[tts] ' + msg + (err ? '：' + shortError(err) : ''))
}

/** 统一杀子进程：先 child.kill()；Windows 上 500ms 后仍未退出才 taskkill /T /F 兜底 */
function killChild(child: ChildProcess): void {
  const pid = child.pid
  try { child.kill() } catch { }
  if (process.platform !== 'win32' || !pid) return
  // taskkill 兜底只在必要时用：正常退出（exitCode/signalCode 已置）绝不再补刀，
  // 避免误杀复用了同一 PID 的其他进程。
  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      const tk = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      tk.on('error', () => { })
      try { tk.unref() } catch { }
    } catch { }
  }, 500)
  try { (timer as any).unref && (timer as any).unref() } catch { }
}

/** 解析显式指定的解释器：完整路径 / 命令名 / 带参数（`py -3`）都认 */
function parseExplicit(raw: string | undefined | null): PythonInterp | null {
  const s = String(raw || '').trim()
  if (!s) return null
  // 1) 整串就是一个存在的可执行文件（路径可能带空格，不能先按空格拆）
  if (existsSync(s)) return { cmd: s, args: [], label: s }
  const parts = s.split(/\s+/).filter(Boolean)
  // 2) `py -3` / `python3 -X` 这类命令 + 参数；不含路径分隔符时才拆，
  //    避免把 "C:\Program Files\Python\python.exe"（不存在或拼错）拆成 "C:\Program"
  if (parts.length > 1 && !/[\\/]/.test(s)) {
    return { cmd: parts[0], args: parts.slice(1), label: s }
  }
  return { cmd: s, args: [], label: s }
}

/** 平台默认探测链（与文件头的支持矩阵一一对应） */
function defaultCandidates(): PythonInterp[] {
  if (process.platform === 'win32') {
    return [
      { cmd: 'python', args: [], label: 'python' },
      { cmd: 'py', args: ['-3'], label: 'py -3' },
      { cmd: 'python3', args: [], label: 'python3' },
    ]
  }
  return [
    { cmd: 'python3', args: [], label: 'python3' },
    { cmd: 'python', args: [], label: 'python' },
  ]
}

function probeOne(interp: PythonInterp): Promise<{ ok: boolean; timeout: boolean; reason: string }> {
  stats.probes++
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(interp.cmd, [...interp.args, '-c', TTS_PROBE_CODE], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: pythonEnv(),
      })
    } catch (e) {
      resolve({ ok: false, timeout: false, reason: 'spawn 失败：' + shortError(e) })
      return
    }
    const outDecoder = new StringDecoder('utf8')
    const errDecoder = new StringDecoder('utf8')
    let out = ''
    let err = ''
    let settled = false
    let timer: any = null
    const finish = (ok: boolean, timeout: boolean, reason: string): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      // 超时/异常路径才需要补 kill；正常 exit 时 exitCode 已置，killChild 内部会跳过 taskkill
      if (!ok) killChild(child)
      resolve({ ok, timeout, reason })
    }
    timer = setTimeout(() => finish(false, true, '探测超时（>' + PROBE_TIMEOUT_MS + 'ms）'), PROBE_TIMEOUT_MS)
    try { (timer as any).unref && (timer as any).unref() } catch { }
    child.stdout?.on('data', (c: Buffer) => { out = (out + outDecoder.write(c)).slice(-1000) })
    child.stderr?.on('data', (c: Buffer) => { err = (err + errDecoder.write(c)).slice(-1000) })
    child.on('error', (e: any) => finish(false, false, '启动失败：' + shortError(e)))
    child.on('exit', (code: number | null) => {
      if (code === 0 && /(^|\s)ok(\s|$)/.test(out)) {
        finish(true, false, 'ok')
      } else if (code === 0) {
        finish(false, false, '退出码 0 但没有 ok 输出')
      } else {
        finish(false, false, '退出码 ' + code + (err.trim() ? '：' + tailText(err, STDERR_LOG_MAX) : ''))
      }
    })
  })
}

/**
 * 依次探测候选；显式指定的解释器只用它自己，失败即降级（不偷偷换解释器）。
 * 超时的候选不再继续试后面的（默认链上的候选是同一个解释器，继续试只会多等 2s），
 * 直接返回 pending，交给 worker/首次合成验证。
 */
async function runProbe(explicit: PythonInterp | null): Promise<ProbeOutcome> {
  const candidates = explicit ? [explicit] : defaultCandidates()
  const failures: string[] = []
  for (const c of candidates) {
    const r = await probeOne(c)
    if (r.ok) {
      console.log('[tts] python 解释器探测通过：' + c.label)
      return { interp: c, failed: false, pending: null, reason: 'ok' }
    }
    stats.lastProbeError = r.reason
    if (r.timeout) {
      stats.probeTimeouts++
      console.warn('[tts] python 解释器探测超时（' + c.label + '）：' + r.reason + '；保留该解释器，交给首次合成验证')
      return { interp: null, failed: false, pending: c, reason: '探测超时，待合成验证' }
    }
    stats.probeFailures++
    failures.push(c.label + ' → ' + r.reason)
    console.warn('[tts] python 解释器不可用（' + c.label + '）：' + r.reason)
  }
  const reason = failures.length ? failures.join('；') : '没有候选解释器'
  console.error(
    '[tts] 未找到可用的 python + edge_tts（' + reason + '），'
    + (explicit ? '显式指定的解释器不可用，不回落到自动探测；' : '')
    + '语音合成降级为浏览器朗读（路由回 501）',
  )
  return { interp: null, failed: true, pending: null, reason }
}

/**
 * 解析出口：进程内缓存；并发请求共享同一次探测。
 * 任何内部异常都在这里兜住，绝不把 rejected Promise 抛给调用方。
 */
async function resolveProbe(explicitRaw?: string): Promise<ProbeOutcome> {
  if (probeCache.outcome) return probeCache.outcome
  if (probeCache.inflight) return await probeCache.inflight
  // 优先级：环境变量 > 调用参数 > 平台默认链
  const explicit = parseExplicit(process.env.CHUBBY_WHALE_PYTHON) || parseExplicit(explicitRaw)
  const generation = probeGeneration
  const task = runProbe(explicit)
  probeCache.inflight = task
  try {
    const outcome = await task
    if (generation === probeGeneration) probeCache.outcome = outcome
    return outcome
  } catch (e) {
    const outcome: ProbeOutcome = { interp: null, failed: true, pending: null, reason: '探测异常：' + shortError(e) }
    if (generation === probeGeneration) probeCache.outcome = outcome
    return outcome
  } finally {
    if (probeCache.inflight === task) probeCache.inflight = null
  }
}

/**
 * 合成验证成功后，把"探测超时、未确认"的候选升级为可用并缓存。
 * 只在缓存仍是同一份结果时改写，避免覆盖 reset 之后的新探测。
 */
function markInterpreterVerified(interp: PythonInterp, previous: ProbeOutcome): void {
  if (previous.interp || !previous.pending) return
  if (probeCache.outcome !== previous) return
  probeCache.outcome = { interp, failed: false, pending: null, reason: '合成验证通过' }
  console.log('[tts] 探测超时但合成验证通过，缓存解释器：' + interp.label)
}

/** 清空探测缓存（排障/测试用；生产不需要） */
export function resetTtsInterpreterProbe(): void {
  probeGeneration++
  probeCache.outcome = null
  probeCache.inflight = null
}

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
  const outcome = probeCache.outcome
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

/**
 * 把 worker 源码落盘。路径一律 join 构造：
 * 优先放本模块同目录（join(__dirname, ...)，随产物走、路径确定）；
 * 全局安装/只读镜像写不进去时回退系统临时目录。
 */
async function ensureWorkerFile(): Promise<string> {
  const targets = [join(HERE, WORKER_FILE), join(tmpdir(), 'chubby-' + WORKER_FILE)]
  let lastError: any = null
  for (const p of targets) {
    try {
      const old = existsSync(p) ? await readFile(p, 'utf8').catch(() => '') : ''
      if (old !== WORKER_SOURCE) await writeFile(p, WORKER_SOURCE, 'utf8')
      return p
    } catch (e) {
      lastError = e
    }
  }
  throw lastError || new Error('tts worker script not writable')
}

function unavailableError(message: string): Error {
  const e: any = new Error(message)
  e.code = TTS_UNAVAILABLE
  return e
}

export function createEdgeTtsEngine(opts: { python?: string; timeoutMs?: number } = {}): TtsEngine & { dispose(): void } {
  // 合成总预算：默认 20s，允许测试传更小值，但绝不放大到 20s 以上
  const timeoutMs = Math.min(Math.max(1, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS)
  let seq = 0
  let worker: WorkerState | null = null
  let starting: Promise<WorkerState | null> | null = null
  /** worker 启动失败后的冷却截止时间（0 = 不冷却） */
  let workerRetryAt = 0

  function remaining(startedAt: number): number {
    return Math.max(1, timeoutMs - (Date.now() - startedAt))
  }

  function killWorker(): void {
    const w = worker
    if (!w) return
    worker = null
    stats.workerKills++
    if (w.idleTimer) { try { clearTimeout(w.idleTimer) } catch { } }
    for (const [, p] of w.pending) {
      try { clearTimeout(p.timer) } catch { }
      try { p.reject(new Error('tts worker stopped')) } catch { }
    }
    w.pending.clear()
    w.dead = true
    killChild(w.child)
  }

  function touchIdle(w: WorkerState): void {
    if (w.dead) return
    if (w.idleTimer) { try { clearTimeout(w.idleTimer) } catch { } }
    w.idleTimer = setTimeout(() => { try { killWorker() } catch { } }, IDLE_KILL_MS)
    try { (w.idleTimer as any).unref && (w.idleTimer as any).unref() } catch { }
  }

  function startWorker(interp: PythonInterp, readyTimeoutMs: number): Promise<WorkerState | null> {
    if (worker && !worker.dead) return Promise.resolve(worker)
    if (starting) return starting
    // 近期启动失败过 → 冷却期内直接回退单次 spawn，不每段白等一次 ready 超时
    if (workerRetryAt && Date.now() < workerRetryAt) return Promise.resolve(null)
    const run = async (): Promise<WorkerState | null> => {
      let pyFile = ''
      try {
        pyFile = await ensureWorkerFile()
      } catch (e) {
        logWarn('worker 脚本落盘失败，改用单次 spawn', e)
        return null
      }
      let child: ChildProcess
      try {
        child = spawn(interp.cmd, [...interp.args, pyFile], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: pythonEnv(),
        })
      } catch (e) {
        logWarn('worker 启动失败，改用单次 spawn', e)
        return null
      }
      stats.workerStarts++
      const w: WorkerState = {
        child,
        buf: '',
        pending: new Map(),
        idleTimer: null,
        dead: false,
        err: '',
        outDecoder: new StringDecoder('utf8'),
        errDecoder: new StringDecoder('utf8'),
      }
      const ok = await new Promise<boolean>((resolve) => {
        let settled = false
        let timer: any = null
        const finish = (v: boolean): void => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          resolve(v)
        }
        const readyMs = Math.max(1, Math.min(READY_TIMEOUT_MS, readyTimeoutMs))
        timer = setTimeout(() => { finish(false); killChild(child) }, readyMs)
        try { (timer as any).unref && (timer as any).unref() } catch { }
        const onData = (chunk: Buffer): void => {
          w.buf += w.outDecoder.write(chunk)
          let idx = w.buf.indexOf('\n')
          while (idx >= 0) {
            const line = w.buf.slice(0, idx).trim()
            w.buf = w.buf.slice(idx + 1)
            idx = w.buf.indexOf('\n')
            if (!line) continue
            let msg: any = null
            try { msg = JSON.parse(line) } catch { continue }
            if (!msg) continue
            if (msg.ready === true) { finish(true); continue }
            if (msg.ready === false) {
              w.err = (w.err + ' ' + String(msg.error || '')).slice(-2000)
              finish(false)
              continue
            }
            if (typeof msg.id === 'number') {
              const p = w.pending.get(msg.id)
              if (p) {
                w.pending.delete(msg.id)
                if (msg.ok === false && msg.error) w.err = (w.err + ' ' + String(msg.error)).slice(-2000)
                p.resolve(Boolean(msg.ok))
              }
            }
          }
        }
        child.stdout?.on('data', onData)
        child.stderr?.on('data', (c: Buffer) => { w.err = (w.err + w.errDecoder.write(c)).slice(-2000) })
        child.on('error', () => finish(false))
        child.on('exit', () => finish(false))
      })
      if (!ok) {
        workerRetryAt = Date.now() + WORKER_RETRY_MS
        if (w.err) console.warn('[tts] worker 启动失败（' + interp.label + '）：' + tailText(w.err))
        else console.warn('[tts] worker 启动失败（' + interp.label + '）：未收到 ready')
        killChild(child)
        return null
      }
      worker = w
      // 运行期 worker 崩溃/退出：立刻失败掉所有排队请求，别等 20s 超时
      child.on('exit', (code: number | null) => {
        w.dead = true
        if (worker === w) worker = null
        const errs = w.err ? '：' + tailText(w.err) : ''
        for (const [, p] of w.pending) {
          try { clearTimeout(p.timer) } catch { }
          try { p.reject(new Error('tts worker exited (' + code + ')' + errs)) } catch { }
        }
        w.pending.clear()
      })
      touchIdle(w)
      return w
    }
    starting = run()
    const p = starting
    void p.finally(() => { if (starting === p) starting = null }) as any
    return p
  }

  /** 走常驻 worker：true=合成成功；false=不可用（交给上层回退单次 spawn） */
  async function synthViaWorker(interp: PythonInterp, req: TtsSynthRequest, outFile: string, budgetMs: number): Promise<boolean> {
    const w = await startWorker(interp, Math.min(READY_TIMEOUT_MS, budgetMs))
    if (!w) return false
    const id = ++seq
    const payload = JSON.stringify({ id, text: req.text, voice: req.voice, rate: req.rate, pitch: req.pitch, out: outFile })
    const ok = await new Promise<boolean>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        w.pending.delete(id)
        w.dead = true
        stats.timeouts++
        // 超时：整个 worker 已经不可信（可能卡在网络/ffmpeg 上），杀掉由上层回退单次 spawn
        killWorker()
        reject(new Error('tts timeout'))
      }, Math.max(1, budgetMs))
      const pending: Pending = {
        resolve: (v: boolean) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e: any) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(e)
        },
        timer,
      }
      w.pending.set(id, pending)
      try {
        w.child.stdin?.write(payload + '\n')
      } catch (e) {
        w.pending.delete(id)
        pending.reject(new Error('tts worker write failed：' + shortError(e)))
      }
    })
    if (!ok) {
      if (w.err) console.warn('[tts] worker 合成失败，回退单次 spawn：' + tailText(w.err))
      killWorker()
    } else {
      touchIdle(w)
    }
    return ok
  }

  /** 回退路径：每次 spawn 一个 python -m edge_tts（与旧实现一致） */
  async function synthViaCli(interp: PythonInterp, req: TtsSynthRequest, outFile: string, budgetMs: number): Promise<void> {
    const args = [...interp.args, ...buildEdgeTtsArgs({ voice: req.voice, rate: req.rate, pitch: req.pitch, text: req.text, out: outFile })]
    await new Promise<void>((resolve, reject) => {
      let child: ChildProcess
      try {
        child = spawn(interp.cmd, args, {
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: true,
          env: pythonEnv(),
        })
      } catch (e) {
        reject(unavailableError('python 启动失败：' + shortError(e)))
        return
      }
      const errDecoder = new StringDecoder('utf8')
      let err = ''
      let settled = false
      let timer: any = null
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        fn()
      }
      timer = setTimeout(() => {
        if (settled) return
        settled = true
        stats.timeouts++
        stats.cliKills++
        killChild(child)
        reject(new Error('tts timeout'))
      }, Math.max(1, budgetMs))
      try { (timer as any).unref && (timer as any).unref() } catch { }
      child.stderr?.on('data', (c: Buffer) => { err = (err + errDecoder.write(c)).slice(-2000) })
      child.on('error', (e: any) => {
        finish(() => reject(unavailableError('python 启动失败：' + shortError(e))))
      })
      child.on('exit', (code: number | null) => {
        finish(() => {
          if (code === 0) {
            resolve()
            return
          }
          const tail = tailText(err)
          if (tail) console.warn('[tts] python 合成失败（退出码 ' + code + '）：' + tail)
          // 解释器在、但 edge_tts 模块缺失（探测后被卸载/换了解释器）→ 仍归为不可用，路由 501
          const missing = /ModuleNotFoundError|No module named|ImportError/.test(err)
          const e: any = new Error('tts exit ' + code + (tail ? '：' + tail : ''))
          if (missing) e.code = TTS_UNAVAILABLE
          reject(e)
        })
      })
    })
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
        const w = await startWorker(interp, READY_TIMEOUT_MS)
        if (w) markInterpreterVerified(interp, outcome)
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
        let done = false
        try {
          done = await synthViaWorker(interp, req, tmpFile, remaining(startedAt))
        } catch {
          // worker 超时/崩溃：下一步回退单次 spawn；此处不把异常直接抛给调用方
          done = false
        }
        if (!done) {
          killWorker()
          await synthViaCli(interp, req, tmpFile, remaining(startedAt))
        }
        const buf = await readFile(tmpFile)
        if (!buf || !buf.length) throw new Error('tts produced empty audio')
        // 合成成功即证明解释器可用：把"探测超时、未确认"的候选升级并缓存，后续不再犹豫
        markInterpreterVerified(interp, outcome)
        return buf
      } finally {
        try { await unlink(tmpFile) } catch { }
      }
    },
    /** 测试/宿主关闭用：停掉常驻 worker（不属于 TtsEngine 端口，路由不依赖） */
    dispose(): void {
      try { killWorker() } catch { }
    },
  }
}
