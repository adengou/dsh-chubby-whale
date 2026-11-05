/**
 * host/tts-engine.ts —— 语音合成引擎（可替换实现）
 *
 * 路由只依赖 TtsEngine 接口：`synthesize({ text, voice, rate, pitch }) → Buffer`。
 *
 * 实现说明（2026-11-05 改为常驻 worker）：
 *   原来是「每合成一段就 spawn 一次 python -m edge_tts」，
 *   实测冷合成 4.5 秒，其中约 2.5 秒耗在 python 启动 + import edge_tts 上。
 *   现在改为：第一次用到时启动一个常驻 python 进程（先把 edge_tts 导入好），
 *   之后每段只通过 stdin/stdout 传一行 JSON，省掉反复启动的开销。
 *   若 worker 启动失败（没装 python / edge_tts / 崩溃），自动回退到原来的 spawn 方式，
 *   行为与之前完全一致，不会因为这项优化把语音弄哑。
 *
 * 错误语义（路由据此回 501 让客户端降级到浏览器朗读）：
 *   - 本机没装 python / edge-tts → err.code = 'TTS_UNAVAILABLE'
 *   - 合成超时 / 进程非 0 退出 → 普通 Error
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { buildEdgeTtsArgs } from '../shared/tts.js'

export interface TtsSynthRequest {
  text: string
  voice: string
  rate: string
  pitch: string
}

export interface TtsEngine {
  synthesize(req: TtsSynthRequest): Promise<Buffer>
  /** 预热：提前把常驻 worker 拉起来（只导入依赖，不合成），首句能省约 1.3 秒 */
  warm?(): Promise<void>
}

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

type Pending = { resolve: (v: boolean) => void; reject: (e: any) => void; timer: any }

type WorkerState = {
  child: ChildProcess
  buf: string
  pending: Map<number, Pending>
  idleTimer: any
  dead: boolean
}

export function createEdgeTtsEngine(opts: { python?: string; timeoutMs?: number } = {}): TtsEngine {
  const python = opts.python || 'python'
  const timeoutMs = opts.timeoutMs || 20000
  const READY_TIMEOUT = 15000
  const IDLE_KILL_MS = 5 * 60 * 1000
  let seq = 0
  let worker: WorkerState | null = null
  let starting: Promise<WorkerState | null> | null = null

  async function ensureWorkerFile(): Promise<string> {
    const p = join(tmpdir(), 'chubby-tts-worker-v1.py')
    if (!existsSync(p)) await writeFile(p, WORKER_SOURCE, 'utf8')
    return p
  }

  function killWorker(): void {
    if (!worker) return
    try { if (worker.idleTimer) clearTimeout(worker.idleTimer) } catch { }
    try { worker.child.kill() } catch { }
    for (const [, p] of worker.pending) {
      try { clearTimeout(p.timer); p.reject(new Error('tts worker stopped')) } catch { }
    }
    worker.pending.clear()
    worker = null
  }

  function touchIdle(w: WorkerState): void {
    if (w.idleTimer) clearTimeout(w.idleTimer)
    // 长时间没人用就退出，别一直占内存；下次有请求会重新拉起
    w.idleTimer = setTimeout(() => { try { killWorker() } catch { } }, IDLE_KILL_MS)
    try { (w.idleTimer as any).unref && (w.idleTimer as any).unref() } catch { }
  }

  function startWorker(): Promise<WorkerState | null> {
    if (worker && !worker.dead) return Promise.resolve(worker)
    if (starting) return starting
    const run = async (): Promise<WorkerState | null> => {
      let pyFile = ''
      try { pyFile = await ensureWorkerFile() } catch { return null }
      let child: ChildProcess
      try { child = spawn(python, [pyFile], { stdio: ['pipe', 'pipe', 'pipe'] }) } catch { return null }
      const w: WorkerState = { child, buf: '', pending: new Map(), idleTimer: null, dead: false }
      const ok = await new Promise<boolean>((resolve) => {
        let settled = false
        const done = (v: boolean): void => { if (!settled) { settled = true; resolve(v) } }
        const timer = setTimeout(() => done(false), READY_TIMEOUT)
        const onData = (chunk: Buffer): void => {
          w.buf += chunk.toString('utf8')
          let idx = w.buf.indexOf('\n')
          while (idx >= 0) {
            const line = w.buf.slice(0, idx).trim()
            w.buf = w.buf.slice(idx + 1)
            idx = w.buf.indexOf('\n')
            if (!line) continue
            let msg: any = null
            try { msg = JSON.parse(line) } catch { continue }
            if (!msg) continue
            if (msg.ready === true) { clearTimeout(timer); done(true); return }
            if (msg.ready === false) { clearTimeout(timer); done(false); return }
            if (typeof msg.id === 'number') {
              const p = w.pending.get(msg.id)
              if (p) { w.pending.delete(msg.id); clearTimeout(p.timer); p.resolve(Boolean(msg.ok)) }
            }
          }
        }
        child.stdout?.on('data', onData)
        child.stderr?.on('data', () => { })
        child.on('error', () => done(false))
        child.on('exit', () => done(false))
      })
      if (!ok) { try { child.kill() } catch { } ; return null }
      worker = w
      touchIdle(w)
      return w
    }
    starting = run()
    const p = starting
    p.finally(() => { if (starting === p) starting = null }) as any
    return p
  }

  /** 走常驻 worker：返回 true=合成成功；false=不可用（交给上层回退） */
  async function synthViaWorker(req: TtsSynthRequest, outFile: string): Promise<boolean> {
    const w = await startWorker()
    if (!w) return false
    const id = ++seq
    const payload = JSON.stringify({ id, text: req.text, voice: req.voice, rate: req.rate, pitch: req.pitch, out: outFile })
    const ok = await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        w.pending.delete(id)
        w.dead = true
        reject(new Error('tts timeout'))
      }, timeoutMs)
      w.pending.set(id, { resolve, reject, timer })
      try { w.child.stdin?.write(payload + '\n') } catch { reject(new Error('tts worker write failed')) }
    })
    touchIdle(w)
    return ok
  }

  /** 回退路径：每次 spawn 一个 python -m edge_tts（与旧实现一致） */
  async function synthViaCli(req: TtsSynthRequest, outFile: string): Promise<void> {
    const args = buildEdgeTtsArgs({ voice: req.voice, rate: req.rate, pitch: req.pitch, text: req.text, out: outFile })
    await new Promise<void>((resolve, reject) => {
      const child = spawn(python, args, { stdio: 'ignore' })
      const timer = setTimeout(() => { try { child.kill() } catch { } reject(new Error('tts timeout')) }, timeoutMs)
      child.on('exit', (code: number | null) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error('tts exit ' + code))
      })
      child.on('error', (err: any) => {
        clearTimeout(timer)
        const e: any = new Error('tts unavailable: ' + String(err?.message || err))
        e.code = 'TTS_UNAVAILABLE'
        reject(e)
      })
    })
  }

  return {
    async warm(): Promise<void> {
      try { await startWorker() } catch { }
    },
    async synthesize(req: TtsSynthRequest): Promise<Buffer> {
      const tmpFile = join(tmpdir(), 'chubby-tts-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.mp3')
      try {
        let done = false
        try { done = await synthViaWorker(req, tmpFile) } catch { done = false }
        if (!done) {
          // worker 不可用（没装 python / 没装 edge_tts / 崩溃）→ 回退旧方式
          try { killWorker() } catch { }
          await synthViaCli(req, tmpFile)
        }
        return await readFile(tmpFile)
      } finally {
        try { await unlink(tmpFile) } catch { }
      }
    },
  }
}
