/**
 * host/tts/spawn.ts —— 单次合成（回退路径）：每次 spawn 一个 `python -m edge_tts`
 *
 * 与拆分前的 synthViaCli 行为一致：
 *   · 参数构造走 shared/tts.buildEdgeTtsArgs（-15% 这类负值必须 --rate=-15% 单参数）；
 *   · stdio 只接 stderr（stdout 不需要），stderr 用 StringDecoder 拼，避免多字节字符被劈；
 *   · 超时 kill 子进程并记 stats.timeouts / stats.cliKills；
 *   · 解释器在、但 edge_tts 模块缺失（探测后被卸载/换了解释器）→ 仍归为不可用（501），
 *     其余非 0 退出按普通 Error（路由 500）。
 *
 * kill 兜底（Windows taskkill /T /F）在 tts/common.ts，python 探测与 worker 共用同一份实现。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { buildEdgeTtsArgs, TTS_UNAVAILABLE } from '../../shared/tts.js'
import type { TtsSynthRequest } from '../ports.js'
import { bumpStat, killChild, pythonEnv, shortError, tailText, unavailableError } from './common.js'
import type { PythonInterp } from './common.js'

/** 回退路径：每次 spawn 一个 python -m edge_tts（与旧实现一致） */
export async function synthViaCli(
  interp: PythonInterp,
  req: TtsSynthRequest,
  outFile: string,
  budgetMs: number,
): Promise<void> {
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
      bumpStat('timeouts')
      bumpStat('cliKills')
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
