/**
 * scripts/test-tts-cancel.mjs —— B95「跨进程取消指令」专项回归（离线、不联网、不装 edge_tts）
 *
 * 为什么单独建这个文件：B94 的断连中止只做到「主进程不再等」——worker 里的 python 仍会把
 * 那一段合成跑完（协议里没有取消指令）。B95 给 stdin/stdout 行协议加了 {"cancel": <id>}，
 * 这条路径**没有任何既有断言**：test-tts-abort 用的是假子进程（只验主进程收尾），
 * test-tts-engine 只验正常合成/超时/崩溃，两边都看不见「python 真的收到取消了吗、
 * 回执真的立刻回来了吗、产物真的停写了吗」。
 *
 * 覆盖：
 *   P. 真 python 跑真 worker 源码（edge_tts 换成临时 PYTHONPATH 上的假模块，不联网）
 *      P0  worker ready（用假 edge_tts 也走同一份 WORKER_SOURCE）
 *      P1  正常合成照旧：{"id":N,"ok":true} + 产物写满（既有行为不变）
 *      P2  合成中取消 → 回执 {"id":N,"cancelled":true,"active":true} 在**整段跑完之前**就到
 *      P3  取消后停写产物（文件不再增长），且产物不完整 —— 「不再写产物」真的发生了
 *      P4  取消让 worker 立刻腾出手（后面的请求不用等被取消那段跑完）；
 *          被取消的 id 始终没有 ok/false 回包（不会和合成结果混为一谈）
 *      P5  取消**还没轮到**的请求 → active=false；轮到它时一个字节都不写、不回结果
 *      P6  取消一个已经结束的 id → 仍回执（不静默丢弃）、active=false，worker 不崩
 *   E. 主进程侧 host/tts/worker.ts + tts-engine.ts（esbuild 沙箱：假 fs + 假子进程）
 *      E0  统计快照有 aborted 字段；无 signal 的正常合成不发取消、不计数
 *      E1  abort → stdin 上「先请求、后 {"cancel": <同一 id>}」，aborted +1；
 *          立刻 AbortError、不回退 CLI、不杀共享 worker
 *      E2  已中止的 signal（请求都没发）→ 一条取消都不发、aborted 不变
 *      E3  等 worker 启动期间 abort → 请求没写出去，所以也不发取消、aborted 不变
 *      E4  取消那行写失败（管道坏）→ 不计数，但仍立刻按中止收尾、不回退 CLI
 *      E5  stdin 流已销毁 → 不尝试写、不计数
 *      E6  并发两段：中止其中一段，另一段照常出音、只发一条取消、aborted 恰好 +1
 *      E7  收到一条 id 指向**在途请求**的取消回执 → 绝不走进「合成结果」分支（不误杀）
 *
 * 负向验证（2026-11-07 本机实测）：把 src/host/tts/worker.ts、src/host/tts-engine.ts 还原到
 * 基线 6b77522（先备份到临时目录，跑完按 SHA-256 校验原样恢复，实测两文件哈希与改动后一致），
 * 再单跑本文件：
 *   基线 29 通过 / 20 失败 / exit 1；改后 49 通过 / 0 失败 / exit 0。
 *   基线红的 20 条正是本批要钉的（逐条摘自那次输出）：
 *     · P2 回执 1515ms 也没来（null）、active 取不到 —— 取消根本没人应答；
 *     · P3 取消后产物照写满（32000B → 40000B），「停写」没发生；
 *     · P4 被取消的 id 照样回 {"id":2,"ok":true}；
 *     · P5 排队中的取消同样没人应答；被取消的那段仍然建了产物文件（size=0，随后会写满）；
 *     · P6 取消已结束的 id 没有回执；
 *     · E0 统计快照里没有 aborted 字段；
 *     · E1 一条取消指令都没发（writes=1，只有请求本身）；
 *     · E4 连「尝试写取消」都没有（attempts=0）；
 *     · E6 并发中止时同样一条取消都没发；
 *     · E7 取消回执被当成 ok=false → 在途请求被误杀、回退 CLI 白合成一遍（拿到 ID3-from-cli）。
 *   基线仍通过的 29 条是「别改坏既有行为」的护栏：P0/P1 正常合成、P2 慢段确实开始写产物、
 *   P4 的耗时（等回执超时已经耗掉 1.5s，2s 的整段只剩 0.5s，所以这条计时在基线上也能过）、
 *   P5 在跑的那段不受牵连、E0 正常路径不发取消、E1 的 AbortError/不回退/不杀 worker、
 *   E2/E3/E5 的「不该发就别发」、E4 写失败仍按中止收尾、E6 并发的另一段照常出音。
 *   它们绿着才说明新断言没顺手改掉既有语义。
 *
 * 用法：node scripts/test-tts-cancel.mjs
 * 退出码：0 = 全过（跳过项会显式打印）；1 = 有失败
 */
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else {
    fail++
    failures.push(name + (detail ? '  ' + detail : ''))
    console.log('  ❌ ' + name + (detail ? '  ' + detail : ''))
  }
}
function skip(name, why) { console.log('  ⏭️  ' + name + '（跳过：' + why + '）') }
function group(title) { console.log('\n' + title) }

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))
async function waitUntil(fn, ms = 3000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await tick(5)
  }
  return false
}
/** 带上限地等一个可能被中止打断的操作（引擎/worker 的预算都是 20s 级，不能裸等） */
async function bounded(fn, ms = 3000) {
  const t0 = Date.now()
  const work = (async () => {
    try { return { value: await fn() } } catch (e) { return { err: e } }
  })()
  const r = await Promise.race([work, new Promise((res) => setTimeout(() => res({ timeout: true }), ms))])
  return { ...r, ms: Date.now() - t0 }
}

// 收集日志：取消指令写失败会走 logWarn，别让它刷花测试输出
const logs = { warn: [] }
const origWarn = console.warn
console.warn = (...a) => logs.warn.push(a.join(' '))
const keepAlive = setInterval(() => { }, 1000)

const ROOT = resolve(import.meta.dirname, '..')
const tmpRoot = mkdtempSync(join(tmpdir(), 'chubby-tts-cancel-'))

/**
 * 从 TS 源码里取出 worker 的 python 源码（WORKER_SOURCE 模板字面量）。
 * 刻意不 import 编译产物：测的就是「这段源码能不能跑」，绕过 dist 才不会被旧构建骗绿。
 */
function extractWorkerSource() {
  const file = join(ROOT, 'src/host/tts/worker.ts')
  const text = readFileSync(file, 'utf8')
  const marker = 'const WORKER_SOURCE = `'
  const s = text.indexOf(marker)
  if (s < 0) throw new Error('worker.ts 里找不到 WORKER_SOURCE 模板字面量')
  const from = s + marker.length
  const end = text.indexOf('`', from)
  if (end < 0) throw new Error('WORKER_SOURCE 模板字面量没有收尾反引号')
  const src = text.slice(from, end)
  if (src.includes('${')) throw new Error('WORKER_SOURCE 里出现了模板插值，测试无法原样取出')
  // 刻意不在这里断言「必须含 cancel 协议」：负向验证要把它跑在基线（B94，没有取消指令）上，
  // 让 P2..P6 逐条红出来；一旦这里先抛异常，就只剩 1 条红、看不出该红的到底是哪几条。
  if (!src.includes('"cancel"')) {
    console.log('  ℹ️  这份 WORKER_SOURCE 里没有 "cancel" 协议（基线？）——P 组会逐条红给你看')
  }
  return src
}

/** 找一台 python 3；跨平台候选顺序与 host/tts/python.ts 的默认链一致 */
function findPython() {
  const cands = process.platform === 'win32'
    ? [['python', []], ['py', ['-3']], ['python3', []]]
    : [['python3', []], ['python', []]]
  for (const [cmd, args] of cands) {
    let r
    try {
      r = spawnSync(cmd, [...args, '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', windowsHide: true })
    } catch {
      continue
    }
    if (r && r.status === 0 && String(r.stdout || '').trim() === '3') {
      return { cmd, args, label: cmd + (args.length ? ' ' + args.join(' ') : '') }
    }
  }
  return null
}

/**
 * 假 edge_tts：只用临时 PYTHONPATH 上的模块顶替，不联网、不依赖本机装没装。
 * 文本以 slow 开头 = 40 块 × 50ms（整段约 2s，够给取消留出观察窗口）；
 * 其余 = 3 块 × 1ms（用来验证「取消之后 worker 还能立刻干活」）。
 * 每块 1000 字节：产物大小能直接看出「停在第几块」，完整 = 40000 / 3000。
 * 同时提供 save()（与 edge_tts 7.3.1 的实现同形：stream() 的薄包装）——基线（B94）
 * 的 worker 调的就是 save()，不补它的话负向验证红的是「假模块缺方法」，不是「没有取消协议」。
 */
function writeFakeEdgeTts(dir) {
  const pkg = join(dir, 'edge_tts')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, '__init__.py'), [
    'import asyncio',
    '',
    'class Communicate:',
    '    def __init__(self, text, voice="", rate="", pitch="", volume=""):',
    '        t = str(text or "")',
    '        slow = t.startswith("slow")',
    '        self.chunks = 40 if slow else 3',
    '        self.delay = 0.05 if slow else 0.001',
    '',
    '    async def stream(self):',
    '        for _ in range(self.chunks):',
    '            await asyncio.sleep(self.delay)',
    '            yield {"type": "audio", "data": b"x" * 1000}',
    '        yield {"type": "WordBoundary", "data": {}}',
    '',
    '    async def save(self, audio_fname):',
    '        with open(audio_fname, "wb") as audio:',
    '            async for message in self.stream():',
    '                if message["type"] == "audio":',
    '                    audio.write(message["data"])',
    '',
  ].join('\n'), 'utf8')
  return dir
}

/** 起一个真 python worker（跑的是 TS 源码里那份 python 源码），收 stdout 的逐行 JSON */
function startWorker(py, scriptFile, shimDir) {
  const child = spawn(py.cmd, [...py.args, scriptFile], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: Object.assign({}, process.env, {
      PYTHONPATH: shimDir,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      PYTHONUNBUFFERED: '1',
    }),
  })
  const msgs = []
  let buf = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => { stderr += d })
  child.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let m
      try { m = JSON.parse(line) } catch { m = { raw: line } }
      msgs.push(m)
    }
  })
  return {
    child,
    msgs,
    get stderr() { return stderr },
    send(obj) { try { child.stdin.write(JSON.stringify(obj) + '\n') } catch { } },
    async waitFor(pred, ms = 3000) {
      const t0 = Date.now()
      while (Date.now() - t0 < ms) {
        for (const m of msgs) if (pred(m)) return m
        await tick(10)
      }
      return null
    },
    stop() { try { child.kill() } catch { } },
  }
}

const sizeOf = (p) => { try { return statSync(p).size } catch { return -1 } }
const idOf = (written) => {
  try { return JSON.parse(String(written).trim()).id } catch { return null }
}

// 看门狗：真 python + 沙箱两段加起来正常 ~6s，30s 还没跑完说明有等待悬挂
const watchdog = setTimeout(() => {
  console.log('\n❌ 测试超时：30s 内没跑完（有回执/收尾没被处理）')
  process.exit(1)
}, 30000)

try {
  // =========================================================================
  // P. 真 python 跑真 worker 源码（假 edge_tts）
  // =========================================================================
  group('[P] worker 协议（真 python + 假 edge_tts 模块）：取消指令 → 回执 → 停写')

  const py = findPython()
  const pyRef = { stopped: false, w: null }
  if (!py) {
    skip('P0 起 python worker', '本机找不到 python3')
    skip('P1..P6 取消协议', '没有 python3，无法跑真 worker')
  } else {
    const shimDir = writeFakeEdgeTts(join(tmpRoot, 'pyshim'))
    const workerFile = join(tmpRoot, 'tts-worker-v1.py')
    writeFileSync(workerFile, extractWorkerSource(), 'utf8')
    const w = startWorker(py, workerFile, shimDir)
    pyRef.w = w

    const ready = await w.waitFor((m) => m.ready === true, 8000)
    ok('P0 worker 起来并 ready（源码可执行）', Boolean(ready), ready ? py.label : ('stderr=' + w.stderr.slice(0, 200)))
    if (!ready) {
      w.stop()
      skip('P1..P6 取消协议', 'worker 没 ready')
    } else {
      // ---- P1 正常合成照旧（既有行为不变）
      const out1 = join(tmpRoot, 'p1.mp3')
      w.send({ id: 1, text: 'fast-1', voice: 'v', rate: '+0%', pitch: '+0Hz', out: out1 })
      const ok1 = await w.waitFor((m) => m.id === 1 && m.ok === true, 4000)
      ok('P1 正常合成照旧回 {"id":1,"ok":true}', Boolean(ok1), ok1 ? '' : JSON.stringify(w.msgs))
      ok('P1 产物按块写满（3 块 × 1000B）', sizeOf(out1) === 3000, 'size=' + sizeOf(out1))

      // ---- P2/P3/P4 合成中取消
      const out2 = join(tmpRoot, 'p2.mp3')
      w.send({ id: 2, text: 'slow-2', voice: 'v', rate: '+0%', pitch: '+0Hz', out: out2 })
      const started2 = await waitUntil(() => sizeOf(out2) > 0, 3000)
      ok('P2 慢段已经开始写产物（取消有对象可取消）', started2, 'size=' + sizeOf(out2))
      const tAck = Date.now()
      w.send({ cancel: 2 })
      const ack2 = await w.waitFor((m) => m.cancelled === true && m.id === 2, 1500)
      const ackMs = Date.now() - tAck
      // 整段合成要 40×50ms≈2s；回执若排在合成之后，就会是 ~2s
      ok('P2 取消回执即时（不是等整段跑完才回）', Boolean(ack2) && ackMs < 1200, ackMs + 'ms（整段 ≈2000ms）')
      ok('P2 回执带 active=true（命中了正在跑的那段）', Boolean(ack2) && ack2.active === true, JSON.stringify(ack2))

      await tick(300)
      const s1 = sizeOf(out2)
      await tick(300)
      const s2 = sizeOf(out2)
      ok('P3 取消后不再往产物里写（文件停止增长）', s1 === s2 && s2 > 0, s1 + 'B → ' + s2 + 'B')
      ok('P3 停写发生在跑完之前（产物不完整）', s2 > 0 && s2 < 40000, s2 + 'B / 40000B')

      const t3 = Date.now()
      w.send({ id: 3, text: 'fast-3', voice: 'v', rate: '+0%', pitch: '+0Hz', out: join(tmpRoot, 'p3.mp3') })
      const ok3 = await w.waitFor((m) => m.id === 3 && m.ok === true, 3000)
      const ms3 = Date.now() - t3
      ok('P4 取消后 worker 立刻腾出手（后续请求不用排队等那 2s）', Boolean(ok3) && ms3 < 1000, ms3 + 'ms')
      ok('P4 被取消的 id 始终没有 ok/false 回包（不与合成结果混淆）',
        !w.msgs.some((m) => m.id === 2 && typeof m.ok === 'boolean'),
        JSON.stringify(w.msgs.filter((m) => m.id === 2)))

      // ---- P5 取消还没轮到的请求
      const out4 = join(tmpRoot, 'p4.mp3')
      const out5 = join(tmpRoot, 'p5.mp3')
      w.send({ id: 4, text: 'slow-4', voice: 'v', rate: '+0%', pitch: '+0Hz', out: out4 })
      await waitUntil(() => sizeOf(out4) > 0, 3000)
      w.send({ id: 5, text: 'slow-5', voice: 'v', rate: '+0%', pitch: '+0Hz', out: out5 })
      await tick(60)   // 让 5 确实进了 worker 的读队列（还没轮到执行）
      const t5 = Date.now()
      w.send({ cancel: 5 })
      const ack5 = await w.waitFor((m) => m.cancelled === true && m.id === 5, 1500)
      ok('P5 取消排队中的请求 → 回执同样即时', Boolean(ack5) && Date.now() - t5 < 1200, (Date.now() - t5) + 'ms')
      ok('P5 回执带 active=false（还没轮到它，标记作废）', Boolean(ack5) && ack5.active === false, JSON.stringify(ack5))
      const ok4 = await w.waitFor((m) => m.id === 4 && m.ok === true, 5000)
      ok('P5 在跑的那一段不受牵连（照常 ok）', Boolean(ok4), ok4 ? '' : JSON.stringify(w.msgs.slice(-4)))
      await tick(250)
      ok('P5 被取消的那段一个产物字节都没写', sizeOf(out5) === -1, 'out5 size=' + sizeOf(out5))
      ok('P5 被取消的那段没有 ok/false 回包',
        !w.msgs.some((m) => m.id === 5 && typeof m.ok === 'boolean'),
        JSON.stringify(w.msgs.filter((m) => m.id === 5)))

      // ---- P6 取消一个已经结束的 id
      w.send({ cancel: 4 })
      const ack4 = await w.waitFor((m) => m.cancelled === true && m.id === 4, 1500)
      ok('P6 取消已结束的 id → 仍回执（不静默丢弃）', Boolean(ack4), JSON.stringify(ack4))
      ok('P6 回执 active=false（没有可取消的东西）', Boolean(ack4) && ack4.active === false)
      w.send({ id: 6, text: 'fast-6', voice: 'v', rate: '+0%', pitch: '+0Hz', out: join(tmpRoot, 'p6.mp3') })
      const ok6 = await w.waitFor((m) => m.id === 6 && m.ok === true, 3000)
      ok('P6 收到无匹配取消后 worker 仍健康', Boolean(ok6), ok6 ? '' : JSON.stringify(w.msgs.slice(-4)))
    }
    w.stop()
    pyRef.stopped = true
  }

  // =========================================================================
  // E. 主进程侧：取消指令的发出与统计（esbuild 沙箱）
  // =========================================================================
  group('[E] host/tts/worker.ts + tts-engine.ts：取消指令的发出/计数/回执处理')

  const fsState = { files: new Map(), unlinkCalls: 0 }
  const calls = { worker: [], cli: [], probe: [] }
  let scenario = {}
  let pidSeq = 0

  const fakeFs = {
    existsSync: () => false,
    readFile: async (p) => {
      if (!fsState.files.has(String(p))) {
        const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e
      }
      return Buffer.from(fsState.files.get(String(p)))
    },
    writeFile: async () => { },
    unlink: async (p) => { fsState.unlinkCalls++; fsState.files.delete(String(p)) },
    readdir: async () => [...fsState.files.keys()].map((p) => String(p).split(/[\\/]/).pop()),
    // 一律当作「刚写的新文件」：让启动时的 sweepStaleTmp 不碰本测试的临时产物
    stat: async () => ({ mtimeMs: Date.now() }),
  }

  class FakeChild extends EventEmitter {
    constructor(kind, args) {
      super()
      this.kind = kind
      this.args = args
      this.pid = ++pidSeq
      this.exitCode = null
      this.signalCode = null
      this.killCalls = 0
      this.hasExited = false
      /** 成功写进 stdin 的行（请求 + 取消） */
      this.stdinWrites = []
      /** 所有写入尝试（含被模拟失败的），用来断言「尝试过但没成功」 */
      this.writeAttempts = []
      this.stdout = new EventEmitter()
      this.stderr = new EventEmitter()
      const self = this
      this.stdin = {
        destroyed: Boolean(scenario.stdinDestroyed),
        write(chunk) {
          const text = String(chunk)
          self.writeAttempts.push(text)
          if (scenario.failCancelWrite && text.includes('"cancel"')) {
            const e = new Error('write EPIPE')
            e.code = 'EPIPE'
            throw e
          }
          self.stdinWrites.push(text)
          for (const line of text.split('\n')) {
            if (!line.trim()) continue
            let msg = null
            try { msg = JSON.parse(line) } catch { continue }
            if (msg) self.onRequest(msg)
          }
          return true
        },
        end() { }, on() { }, destroy() { },
      }
      this.start()
    }
    out(chunk) {
      if (this.hasExited) return
      this.stdout.emit('data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    }
    exit(code) {
      if (this.hasExited) return
      this.hasExited = true
      this.exitCode = code === undefined ? 0 : code
      this.emit('exit', this.exitCode)
    }
    kill() {
      this.killCalls++
      if (this.hasExited) return true
      this.signalCode = 'SIGTERM'
      setImmediate(() => {
        if (this.hasExited) return
        this.hasExited = true
        this.emit('exit', null)
      })
      return true
    }
    unref() { return this }
    ref() { return this }
    start() {
      if (this.kind === 'probe') {
        setImmediate(() => { this.out('ok\n'); this.exit(0) })
        return
      }
      if (this.kind === 'worker') {
        const delay = Number(scenario.readyDelayMs) || 0
        setTimeout(() => this.out(JSON.stringify({ ready: true }) + '\n'), delay)
        return
      }
      // cli：单次合成（回退路径）
      setImmediate(() => {
        const i = this.args.indexOf('--write-media')
        // 故意和 worker 写的标记不同：断言的是「结果来自 worker，不是回退」
        if (i >= 0) fsState.files.set(String(this.args[i + 1]), Buffer.from('ID3-from-cli'))
        this.exit(0)
      })
    }
    onRequest(msg) {
      // 取消指令：默认只记录；ackCancel 时回一条回执（模拟 python 读线程）
      if (typeof msg.cancel === 'number') {
        if (scenario.ackCancel) {
          setImmediate(() => this.out(JSON.stringify({ id: msg.cancel, cancelled: true, active: true }) + '\n'))
        }
        return
      }
      const handler = scenario.onWorkerRequest
      if (typeof handler === 'function') { handler(this, msg); return }
      fsState.files.set(String(msg.out), Buffer.from('WORKER-OK'))
      setImmediate(() => this.out(JSON.stringify({ id: msg.id, ok: true }) + '\n'))
    }
  }

  function fakeSpawn(cmd, args = []) {
    const argv = Array.isArray(args) ? args : []
    const kind = argv.some((a) => String(a).endsWith('.py'))
      ? 'worker'
      : argv.includes('-c') ? 'probe' : 'cli'
    const child = new FakeChild(kind, argv)
    calls[kind].push({ cmd, args: argv, child })
    return child
  }

  globalThis.__ttsCancelHarness = { fs: fakeFs, spawn: fakeSpawn }

  const STUB_CP = `
const h = globalThis.__ttsCancelHarness
export function spawn(...a) { return h.spawn(...a) }
`
  const STUB_FS = `
const h = globalThis.__ttsCancelHarness
export function existsSync(p) { return h.fs.existsSync(p) }
`
  const STUB_FSP = `
const h = globalThis.__ttsCancelHarness
export function readFile(p) { return h.fs.readFile(p) }
export function writeFile(p) { return h.fs.writeFile(p) }
export function unlink(p) { return h.fs.unlink(p) }
export function readdir(p) { return h.fs.readdir(p) }
export function stat(p) { return h.fs.stat(p) }
`
  const SANDBOX = join(tmpRoot, 'sandbox')
  mkdirSync(SANDBOX, { recursive: true })

  async function loadEngine() {
    const out = await build({
      entryPoints: [join(ROOT, 'src/host/tts-engine.ts')],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      logLevel: 'silent',
      plugins: [{
        name: 'tts-cancel-sandbox',
        setup(b) {
          b.onResolve({ filter: /^node:child_process$/ }, () => ({ path: 'stub:cp', namespace: 'stub' }))
          b.onResolve({ filter: /^node:fs$/ }, () => ({ path: 'stub:fs', namespace: 'stub' }))
          b.onResolve({ filter: /^node:fs\/promises$/ }, () => ({ path: 'stub:fsp', namespace: 'stub' }))
          b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => {
            if (a.path === 'stub:cp') return { contents: STUB_CP, loader: 'js' }
            if (a.path === 'stub:fs') return { contents: STUB_FS, loader: 'js' }
            return { contents: STUB_FSP, loader: 'js' }
          })
        },
      }],
    })
    const file = join(SANDBOX, 'engine.mjs')
    writeFileSync(file, out.outputFiles[0].text, 'utf8')
    return import(pathToFileURL(file).href)
  }

  function resetE(s) {
    fsState.files.clear()
    fsState.unlinkCalls = 0
    calls.worker.length = 0
    calls.cli.length = 0
    calls.probe.length = 0
    scenario = s || {}
  }

  const REQ = { text: '你好，大肥鱼。', voice: 'zh-CN-XiaoyiNeural', rate: '+0%', pitch: '+0Hz' }
  // 探测这层不测（原生 python.ts 有 2s 硬超时，离线环境没必要真等）：显式指定假解释器
  process.env.CHUBBY_WHALE_PYTHON = 'fake-python'
  const ENG = await loadEngine()

  // ---- E0 统计字段 + 正常路径不发取消
  {
    resetE({})
    ENG.resetTtsInterpreterProbe()
    const eng = ENG.createEdgeTtsEngine({ timeoutMs: 20000 })
    const st0 = ENG.getTtsEngineStats()
    ok('E0 统计快照里有 aborted 计数（B95 新增）', typeof st0.aborted === 'number', 'aborted=' + st0.aborted)
    const before = st0.aborted
    const r = await bounded(() => eng.synthesize({ ...REQ }), 3000)
    const child = calls.worker[0] && calls.worker[0].child
    ok('E0 无 signal 的正常合成照旧出音', !r.timeout && Buffer.isBuffer(r.value) && r.value.length > 0,
      'bytes=' + (r.value && r.value.length))
    ok('E0 正常路径一条取消指令都不发',
      Boolean(child) && !child.writeAttempts.some((t) => t.includes('"cancel"')),
      'writes=' + (child ? child.stdinWrites.length : -1))
    ok('E0 正常路径 aborted 不变', ENG.getTtsEngineStats().aborted === before,
      before + ' → ' + ENG.getTtsEngineStats().aborted)
    eng.dispose()
  }

  // ---- E1 abort → 先请求、后取消，aborted +1
  {
    resetE({ onWorkerRequest: () => { /* 永不回包 */ } })
    ENG.resetTtsInterpreterProbe()
    const eng = ENG.createEdgeTtsEngine({ timeoutMs: 20000 })
    const before = ENG.getTtsEngineStats().aborted
    const ctl = new AbortController()
    const p = bounded(() => eng.synthesize({ ...REQ, signal: ctl.signal }), 3000)
    const spawned = await waitUntil(() => calls.worker.length === 1, 3000)
    const child = spawned ? calls.worker[0].child : null
    const wrote = child ? await waitUntil(() => child.stdinWrites.length >= 1, 3000) : false
    const reqId = wrote ? idOf(child.stdinWrites[0]) : null
    ctl.abort()
    const r = await p
    ok('E1 abort → 立刻 AbortError（没挂到 20s 预算）',
      !r.timeout && r.err && r.err.name === 'AbortError', r.timeout ? '卡住未返回' : r.ms + 'ms')
    const cancelWrites = child ? child.stdinWrites.filter((t) => t.includes('"cancel"')) : []
    ok('E1 恰好写出一条取消指令', cancelWrites.length === 1, '条数=' + cancelWrites.length)
    let cancelMsg = null
    try { cancelMsg = JSON.parse(cancelWrites[0].trim()) } catch { }
    ok('E1 取消的是刚才那条请求的 id', Boolean(cancelMsg) && cancelMsg.cancel === reqId,
      'requestId=' + reqId + ' cancel=' + (cancelMsg && cancelMsg.cancel))
    ok('E1 顺序是「先请求、后取消」（不是凭空取消一个没发过的 id）',
      Boolean(child) && child.stdinWrites.indexOf(cancelWrites[0]) === 1, 'writes=' + (child && child.stdinWrites.length))
    ok('E1 aborted 计数 +1（成功发出才算）',
      ENG.getTtsEngineStats().aborted === before + 1,
      before + ' → ' + ENG.getTtsEngineStats().aborted)
    ok('E1 不回退单次 spawn（cli=0）', calls.cli.length === 0, 'cli=' + calls.cli.length)
    ok('E1 仍然不杀共享 worker', Boolean(child) && child.killCalls === 0, 'kill=' + (child && child.killCalls))
    eng.dispose()
  }

  // ---- E2 已中止的 signal：请求都没发，不该有取消
  {
    resetE({})
    ENG.resetTtsInterpreterProbe()
    const eng = ENG.createEdgeTtsEngine({ timeoutMs: 20000 })
    const before = ENG.getTtsEngineStats().aborted
    const ctl = new AbortController()
    ctl.abort()
    const r = await bounded(() => eng.synthesize({ ...REQ, signal: ctl.signal }), 3000)
    const wroteAny = calls.worker.concat(calls.probe, calls.cli).some((c) => c.child.writeAttempts.length > 0)
    ok('E2 已中止 → 立刻 AbortError，一个进程都不起',
      !r.timeout && r.err && r.err.name === 'AbortError' && calls.worker.length + calls.probe.length + calls.cli.length === 0,
      'worker=' + calls.worker.length + ' probe=' + calls.probe.length + ' cli=' + calls.cli.length)
    ok('E2 没写过任何 stdin（自然没有取消）', !wroteAny)
    ok('E2 aborted 不变（没发出去的不算）', ENG.getTtsEngineStats().aborted === before,
      before + ' → ' + ENG.getTtsEngineStats().aborted)
    eng.dispose()
  }

  // ---- E3 等 worker 启动期间 abort：请求没写出去，也就不发取消
  {
    resetE({ readyDelayMs: 400, onWorkerRequest: () => { } })
    ENG.resetTtsInterpreterProbe()
    const eng = ENG.createEdgeTtsEngine({ timeoutMs: 20000 })
    const before = ENG.getTtsEngineStats().aborted
    const ctl = new AbortController()
    const p = bounded(() => eng.synthesize({ ...REQ, signal: ctl.signal }), 4000)
    await waitUntil(() => calls.worker.length === 1, 3000)
    await tick(20)
    ctl.abort()
    const r = await p
    const child = calls.worker[0] && calls.worker[0].child
    ok('E3 等启动期间 abort → 立刻 AbortError',
      !r.timeout && r.err && r.err.name === 'AbortError', r.timeout ? '卡住未返回' : r.ms + 'ms')
    ok('E3 请求没写进 stdin（所以没有可取消的 id）',
      Boolean(child) && child.writeAttempts.length === 0, 'attempts=' + (child && child.writeAttempts.length))
    ok('E3 aborted 不变', ENG.getTtsEngineStats().aborted === before,
      before + ' → ' + ENG.getTtsEngineStats().aborted)
    await tick(450)   // 让那次启动自己落地，别把半启动的 worker 留给下一个场景
    eng.dispose()
  }

  // ---- E4 取消那行写失败：不计数，但仍按中止收尾
  {
    resetE({ onWorkerRequest: () => { }, failCancelWrite: true })
    ENG.resetTtsInterpreterProbe()
    const eng = ENG.createEdgeTtsEngine({ timeoutMs: 20000 })
    const before = ENG.getTtsEngineStats().aborted
    const ctl = new AbortController()
    const p = bounded(() => eng.synthesize({ ...REQ, signal: ctl.signal }), 3000)
    await waitUntil(() => calls.worker.length === 1, 3000)
    const child = calls.worker[0] && calls.worker[0].child
    await waitUntil(() => Boolean(child) && child.stdinWrites.length >= 1, 3000)
    ctl.abort()
    const r = await p
    const attempted = child ? child.writeAttempts.filter((t) => t.includes('"cancel"')).length : 0
    const written = child ? child.stdinWrites.filter((t) => t.includes('"cancel"')).length : 0
    ok('E4 取消那行确实尝试写了（但被模拟成 EPIPE）', attempted === 1, 'attempts=' + attempted + ' written=' + written)
    ok('E4 写失败 → aborted 不 +1（口径是"成功发出"）',
      ENG.getTtsEngineStats().aborted === before, before + ' → ' + ENG.getTtsEngineStats().aborted)
    ok('E4 写失败也不影响按中止收尾（仍立刻 AbortError）',
      !r.timeout && r.err && r.err.name === 'AbortError', r.timeout ? '卡住未返回' : r.ms + 'ms')
    ok('E4 写失败不回退单次 spawn', calls.cli.length === 0, 'cli=' + calls.cli.length)
    eng.dispose()
  }

  // ---- E5 stdin 流已销毁：不尝试写、不计数
  {
    resetE({ onWorkerRequest: () => { }, stdinDestroyed: true })
    ENG.resetTtsInterpreterProbe()
    const eng = ENG.createEdgeTtsEngine({ timeoutMs: 20000 })
    const before = ENG.getTtsEngineStats().aborted
    const ctl = new AbortController()
    const p = bounded(() => eng.synthesize({ ...REQ, signal: ctl.signal }), 3000)
    await waitUntil(() => calls.worker.length === 1, 3000)
    const child = calls.worker[0] && calls.worker[0].child
    await waitUntil(() => Boolean(child) && child.stdinWrites.length >= 1, 3000)
    ctl.abort()
    const r = await p
    const attempted = child ? child.writeAttempts.filter((t) => t.includes('"cancel"')).length : -1
    ok('E5 流已销毁 → 连写都不试（不产生半行）', attempted === 0, 'attempts=' + attempted)
    ok('E5 aborted 不变', ENG.getTtsEngineStats().aborted === before,
      before + ' → ' + ENG.getTtsEngineStats().aborted)
    ok('E5 仍立刻 AbortError', !r.timeout && r.err && r.err.name === 'AbortError',
      r.timeout ? '卡住未返回' : r.ms + 'ms')
    eng.dispose()
  }

  // ---- E6 并发两段：中止一段不误伤另一段，只发一条取消
  {
    resetE({
      ackCancel: true,
      onWorkerRequest(child, msg) {
        if (String(msg.text || '').startsWith('hang')) return   // A 永不回包
        setTimeout(() => {
          fsState.files.set(String(msg.out), Buffer.from('WORKER-OK'))
          child.out(JSON.stringify({ id: msg.id, ok: true }) + '\n')
        }, 60)
      },
    })
    ENG.resetTtsInterpreterProbe()
    const eng = ENG.createEdgeTtsEngine({ timeoutMs: 20000 })
    const before = ENG.getTtsEngineStats().aborted
    const ctl = new AbortController()
    const pA = bounded(() => eng.synthesize({ ...REQ, text: 'hang-这一段', signal: ctl.signal }), 4000)
    await waitUntil(() => calls.worker.length === 1, 3000)
    const child = calls.worker[0] && calls.worker[0].child
    await waitUntil(() => Boolean(child) && child.stdinWrites.length >= 1, 3000)
    const idA = idOf(child.stdinWrites[0])
    const pB = bounded(() => eng.synthesize({ ...REQ, text: '好的一段' }), 3000)
    const rB = await pB
    ctl.abort()
    const rA = await pA
    const cancelWrites = child ? child.stdinWrites.filter((t) => t.includes('"cancel"')) : []
    let cancelMsg = null
    try { cancelMsg = JSON.parse(cancelWrites[0].trim()) } catch { }
    ok('E6 中止的那段立刻 AbortError', !rA.timeout && rA.err && rA.err.name === 'AbortError',
      rA.timeout ? '卡住未返回' : rA.ms + 'ms')
    ok('E6 并发的另一段照常出音（结果来自 worker，不是回退）',
      !rB.timeout && rB.value && rB.value.toString() === 'WORKER-OK',
      rB.err ? String(rB.err.message) : (rB.value && rB.value.toString()))
    ok('E6 只发出一条取消，id 是被中止的那段', cancelWrites.length === 1 && Boolean(cancelMsg) && cancelMsg.cancel === idA,
      'count=' + cancelWrites.length + ' id=' + (cancelMsg && cancelMsg.cancel) + ' A=' + idA)
    ok('E6 aborted 恰好 +1', ENG.getTtsEngineStats().aborted === before + 1,
      before + ' → ' + ENG.getTtsEngineStats().aborted)
    ok('E6 没有回退单次 spawn', calls.cli.length === 0, 'cli=' + calls.cli.length)
    eng.dispose()
  }

  // ---- E7 取消回执指向在途请求：必须被识别后丢弃，不能当成合成结果
  {
    resetE({
      onWorkerRequest(child, msg) {
        // 200ms 后才回真结果：中间那条"取消回执"先到
        setTimeout(() => {
          fsState.files.set(String(msg.out), Buffer.from('WORKER-OK'))
          child.out(JSON.stringify({ id: msg.id, ok: true }) + '\n')
        }, 200)
      },
    })
    ENG.resetTtsInterpreterProbe()
    const eng = ENG.createEdgeTtsEngine({ timeoutMs: 20000 })
    const p = bounded(() => eng.synthesize({ ...REQ }), 3000)
    await waitUntil(() => calls.worker.length === 1, 3000)
    const child = calls.worker[0] && calls.worker[0].child
    await waitUntil(() => Boolean(child) && child.stdinWrites.length >= 1, 3000)
    const idB = idOf(child.stdinWrites[0])
    // 协议的畸形场景：回执的 id 指向一条还在等结果的请求（正常实现不会这样发，
    // 但解析器若把 cancelled 当成 ok/false，就会把它误杀 → 回退 CLI → 白合成一遍）
    if (child && typeof idB === 'number') {
      child.out(JSON.stringify({ id: idB, cancelled: true, active: true }) + '\n')
    }
    const r = await p
    ok('E7 回执不走进"合成结果"分支（在途请求不被误杀）',
      !r.timeout && !r.err && r.value && r.value.toString() === 'WORKER-OK',
      r.err ? String(r.err.message) : String(r.value && r.value.toString()))
    ok('E7 也没有因此回退单次 spawn', calls.cli.length === 0, 'cli=' + calls.cli.length)
    eng.dispose()
  }
} catch (e) {
  fail++
  failures.push('测试脚本自身抛异常：' + String((e && e.stack) || e))
  console.log('\n❌ 测试脚本自身抛异常：' + String((e && e.stack) || e))
} finally {
  clearTimeout(watchdog)
  clearInterval(keepAlive)
  console.warn = origWarn
  delete process.env.CHUBBY_WHALE_PYTHON
  try { if (pyRef.w) pyRef.w.stop() } catch { }
  try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { }
}

console.log('\n' + '='.repeat(52))
console.log('通过 ' + pass + ' 项 / 失败 ' + fail + ' 项')
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('✅ TTS 取消指令回归全部通过')
process.exit(0)
