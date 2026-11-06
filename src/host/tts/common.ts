/**
 * host/tts/common.ts —— TTS 子模块共享的常量、类型与子进程工具
 *
 * 拆分前这些内容都在 host/tts-engine.ts 里；现在 tts/ 下的 python / worker / spawn
 * 三个子模块都依赖这一层（避免子模块互相引用或反向依赖引擎编排层）。
 *
 * 封装边界（架构宪章）：运行统计对象不对外导出，外部只能 bumpStat / readStats，
 * 读到的还是副本，调用方改不到内部状态。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { TTS_UNAVAILABLE } from '../../shared/tts.js'

/** 解释器探测硬超时：任务要求 ≤2s（够 import edge_tts，又不至于让首段等太久） */
export const PROBE_TIMEOUT_MS = 2000
/** 合成总预算上限：任务要求 ≤20s（含 worker 启动） */
export const DEFAULT_TIMEOUT_MS = 20000
export const MAX_TIMEOUT_MS = 20000
/** 常驻 worker 首行 ready 的最长等待（探测已确认 edge_tts 能导入，正常 <2s） */
export const READY_TIMEOUT_MS = 10000
/** worker 长时间没人用就退出，别一直占内存；下次有请求会重新拉起 */
export const IDLE_KILL_MS = 5 * 60 * 1000
/** worker 启动失败后的冷却时间：这段时间内直接走单次 spawn，不每段重试 */
export const WORKER_RETRY_MS = 60 * 1000
/** 日志里 stderr 最多保留的字符数（任务要求前 500 字） */
export const STDERR_LOG_MAX = 500

/** 一个探测候选：命令 + 固定参数（`py -3` 这种） + 日志里的显示名 */
export type PythonInterp = { cmd: string; args: string[]; label: string }

/**
 * worker 排队中的一次请求：合成结果只通过 resolve 回传（失败不抛异常），timer 是本次预算。
 * 形状刻意不含 reject：worker 的失败要用返回值表达，抛异常会把调用方拖进退化路径之外的错误分支。
 */
export type Pending = { resolve: (v: boolean) => void; timer: any }

/** 运行统计快照（测试与排障用；跨 engine 实例累计，reset 不清零） */
export type TtsStatsSnapshot = {
  probes: number
  probeFailures: number
  probeTimeouts: number
  lastProbeError: string
  workerStarts: number
  workerKills: number
  cliKills: number
  timeouts: number
}

/** 进程内统计的读写都走模块内闭包，外部拿不到可变引用 */
const stats: TtsStatsSnapshot = {
  probes: 0,
  probeFailures: 0,
  probeTimeouts: 0,
  lastProbeError: '',
  workerStarts: 0,
  workerKills: 0,
  cliKills: 0,
  timeouts: 0,
}

/** 可自增的计数项（lastProbeError 是字符串，单独用 setLastProbeError 写） */
export type TtsStatKey = 'probes' | 'probeFailures' | 'probeTimeouts' | 'workerStarts' | 'workerKills' | 'cliKills' | 'timeouts'

export function bumpStat(key: TtsStatKey): void {
  stats[key]++
}

export function setLastProbeError(reason: string): void {
  stats.lastProbeError = reason
}

/** 只读快照：调用方改不到内部状态 */
export function readStats(): TtsStatsSnapshot {
  return { ...stats }
}

/** 子进程统一 UTF-8：Windows 的 python 默认可能按 cp936 读 stdin，中文 JSON 会乱码 */
export function pythonEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' }
}

/** 清理控制字符、压空白后截取前 max 字（不打印请求文本，只用于 python 报错） */
export function tailText(s: string, max = STDERR_LOG_MAX): string {
  const clean = String(s || '')
    .replace(/[\u0000-\u0008\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.slice(0, max)
}

export function shortError(e: any): string {
  const raw = e && (e.message || e.code || String(e))
  return tailText(raw || 'unknown', 300)
}

export function logWarn(msg: string, err?: any): void {
  console.warn('[tts] ' + msg + (err ? '：' + shortError(err) : ''))
}

/**
 * 统一杀子进程：先 child.kill()；Windows 上 500ms 后仍未退出才 taskkill /T /F 兜底。
 * 进程一旦退出（exit 事件到达）就撤销补刀：PID 可能在退出后被系统复用，
 * 撤销得越早，taskkill 误杀复用 PID 的窗口越小。
 */
export function killChild(child: ChildProcess): void {
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
  try {
    child.once('exit', () => { try { clearTimeout(timer) } catch { } })
  } catch { }
  try { (timer as any).unref && (timer as any).unref() } catch { }
}

/** 本机没有可用 python/edge_tts：路由据 code 回 501，客户端降级浏览器朗读 */
export function unavailableError(message: string): Error {
  const e: any = new Error(message)
  e.code = TTS_UNAVAILABLE
  return e
}
