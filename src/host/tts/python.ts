/**
 * host/tts/python.ts —— python 解释器候选与探测（含进程内缓存）
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
 *   排障/测试可调用 resetTtsInterpreterProbe() 清缓存重探（对外仍由 tts-engine 导出）。
 *   注意「超时」≠「不可用」：慢机器/冷缓存上 import edge_tts 可能超过 2 秒（本机实测 2.2s），
 *   超时的候选保留为 pending，交给常驻 worker 的 ready（≤10s）或首次单次合成验证；
 *   只有 ENOENT / 非 0 退出 / 没有 ok 输出才判定为确定不可用并缓存 501 语义。
 *   全部失败 → synthesize() 抛 code='TTS_UNAVAILABLE'（路由回 501），
 *   客户端据此降级到浏览器 speechSynthesis；warm() 永不抛异常。
 */
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { TTS_PROBE_CODE } from '../../shared/tts.js'
import {
  PROBE_TIMEOUT_MS,
  STDERR_LOG_MAX,
  bumpStat,
  killChild,
  pythonEnv,
  setLastProbeError,
  shortError,
  tailText,
} from './common.js'
import type { PythonInterp } from './common.js'

export type ProbeOutcome = {
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

/** 解析显式指定的解释器：完整路径 / 命令名 / 带参数（`py -3`）都认 */
export function parseExplicit(raw: string | undefined | null): PythonInterp | null {
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
export function defaultCandidates(): PythonInterp[] {
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

/** 探测单个候选：只有 exit 0 且输出里有独立单词 ok 才算通过 */
export function probeOne(interp: PythonInterp): Promise<{ ok: boolean; timeout: boolean; reason: string }> {
  bumpStat('probes')
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
    setLastProbeError(r.reason)
    if (r.timeout) {
      bumpStat('probeTimeouts')
      console.warn('[tts] python 解释器探测超时（' + c.label + '）：' + r.reason + '；保留该解释器，交给首次合成验证')
      return { interp: null, failed: false, pending: c, reason: '探测超时，待合成验证' }
    }
    bumpStat('probeFailures')
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
export async function resolveProbe(explicitRaw?: string): Promise<ProbeOutcome> {
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
export function markInterpreterVerified(interp: PythonInterp, previous: ProbeOutcome): void {
  if (previous.interp || !previous.pending) return
  if (probeCache.outcome !== previous) return
  probeCache.outcome = { interp, failed: false, pending: null, reason: '合成验证通过' }
  console.log('[tts] 探测超时但合成验证通过，缓存解释器：' + interp.label)
}

/** 清空探测缓存（排障/测试用；生产不需要）。对外仍从 tts-engine 导出，保持旧导入路径可用 */
export function resetTtsInterpreterProbe(): void {
  probeGeneration++
  probeCache.outcome = null
  probeCache.inflight = null
}

/** 只读快照：给统计快照用（不交给调用方改动内部缓存） */
export function peekProbeOutcome(): ProbeOutcome | null {
  return probeCache.outcome
}
