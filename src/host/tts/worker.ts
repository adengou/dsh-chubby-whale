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
 *   · ready 成功后运行期崩溃/退出：立刻 reject 所有排队请求，不必等 20s 超时。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'
import type { TtsSynthRequest } from '../ports.js'
import {
  IDLE_KILL_MS,
  READY_TIMEOUT_MS,
  WORKER_RETRY_MS,
  bumpStat,
  killChild,
  logWarn,
  pythonEnv,
  shortError,
  tailText,
} from './common.js'
import type { Pending, PythonInterp } from './common.js'

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

/**
 * 本模块所在目录（dist/host/tts）的上一级（dist/host）。tsc 产物是 ESM，没有 __dirname；
 * Node 22+ 有 import.meta.dirname，退路是 fileURLToPath(import.meta.url)。
 * 拆分前 tts-engine.ts 就在 dist/host，这里加 '..' 保持 worker 脚本落盘路径与旧实现一致
 * （dist/host/tts-worker-v1.py），不依赖进程 cwd、不手拼分隔符。
 */
const HERE = join(
  typeof (import.meta as any).dirname === 'string'
    ? String((import.meta as any).dirname)
    : fileURLToPath(new URL('.', import.meta.url)),
  '..',
)

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

/** 常驻 worker 的对外接口：编排层只认这四件事，不碰内部状态 */
export interface WorkerRunner {
  /** 预热：把 worker 拉起来并等到 ready；true=已就绪 */
  warm(interp: PythonInterp): Promise<boolean>
  /** 让 worker 合成到 outFile：true=成功；false=worker 不可用（交给上层回退单次 spawn） */
  synth(interp: PythonInterp, req: TtsSynthRequest, outFile: string, budgetMs: number): Promise<boolean>
  /** 停掉当前 worker（冷却逻辑仍在 runner 内） */
  kill(): void
  /** 测试/宿主关闭用：停掉常驻 worker */
  dispose(): void
}

/**
 * 把 worker 源码落盘。路径一律 join 构造：
 * 优先放本模块同目录（拆分前的 dist/host），随产物走、路径确定；
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

/** 每个 engine 实例一个 runner：worker / starting / 冷却 / seq 都是实例内状态（与拆分前一致） */
export function createWorkerRunner(): WorkerRunner {
  let seq = 0
  let worker: WorkerState | null = null
  let starting: Promise<WorkerState | null> | null = null
  /** worker 启动失败后的冷却截止时间（0 = 不冷却） */
  let workerRetryAt = 0

  function killWorker(): void {
    const w = worker
    if (!w) return
    worker = null
    bumpStat('workerKills')
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
      bumpStat('workerStarts')
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
    // 成功/失败都要清 starting；用 then(两个处理器) 而不是 finally，
    // 避免派生 Promise 在 run() 抛异常时变成未处理拒绝（Node 默认会因此终止宿主进程）
    const clear = (): void => { if (starting === p) starting = null }
    void p.then(clear, clear)
    return p
  }

  async function synth(interp: PythonInterp, req: TtsSynthRequest, outFile: string, budgetMs: number): Promise<boolean> {
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
        bumpStat('timeouts')
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

  return {
    async warm(interp: PythonInterp): Promise<boolean> {
      const w = await startWorker(interp, READY_TIMEOUT_MS)
      return Boolean(w)
    },
    synth,
    kill(): void {
      try { killWorker() } catch { }
    },
    dispose(): void {
      try { killWorker() } catch { }
    },
  }
}
