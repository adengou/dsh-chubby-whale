/**
 * scripts/test-tts-engine.mjs —— TTS 引擎（常驻 worker / 解释器探测 / 临时文件）离线回归
 *
 * 为什么需要这个文件：`scripts/test.mjs` 的 [21] 只用「假引擎」测路由，`platform-check`
 * 只测 python.ts 的候选链纯函数。常驻 worker 的协议、预算、kill 后状态、冷却、临时文件
 * 清理这几条**没有任何自动化断言**——它们只靠"本机跑一下看看"，而真实 python 出故障时
 * 恰恰是本机跑不出来的那些路径（ready 超时 / worker 中途退出 / 合成返回 ok:false）。
 *
 * 做法：用 esbuild 把真实 TS 源码（tts/worker.ts、tts/python.ts、tts-engine.ts）打成 ESM
 * 沙箱，把 `node:child_process` / `node:fs` / `node:fs/promises` 换成进程内假实现：
 *   · 假 python 完全由本脚本驱动（何时 ready、何时回包、何时退出都确定）；
 *   · 临时文件走内存 Map，可注入 EBUSY 让 unlink 先失败——复现 Windows 上
 *     「python 还没放开文件句柄」的清理竞态；
 *   · 不联网、不启动真子进程、不依赖本机是否装了 python，全程 < 3 秒。
 *
 * 用法：node scripts/test-tts-engine.mjs
 * 退出码：0=全过；1=有断言失败（打印 ❌ 与实测值）
 */

import { build } from 'esbuild'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')

let passed = 0
let failed = 0
const I = '  '

function ok(title, extra = '') {
  passed++
  console.log(I + '✅ ' + title + (extra ? '  ' + extra : ''))
}
function bad(title, extra = '') {
  failed++
  console.log(I + '❌ ' + title + (extra ? '  ' + extra : ''))
}
function check(title, cond, extra = '') {
  if (cond) ok(title, extra)
  else bad(title, extra)
}
function section(n, title) {
  console.log('\n[' + n + '] ' + title)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// 进程内假实现：fs（内存 Map） + child_process（FakeChild）
// ---------------------------------------------------------------------------
const fsState = {
  files: new Map(),
  /** unlink 还需要失败几次（模拟 Windows 上句柄未释放 → EBUSY） */
  unlinkFailures: 0,
  unlinkCalls: 0,
  writeCalls: 0,
}

const calls = {
  probe: [],
  worker: [],
  cli: [],
  children: [],
}

let pidSeq = 0
let scenario = {}

function resetState(s) {
  fsState.files.clear()
  fsState.unlinkFailures = 0
  fsState.unlinkCalls = 0
  fsState.writeCalls = 0
  calls.probe.length = 0
  calls.worker.length = 0
  calls.cli.length = 0
  calls.children.length = 0
  scenario = s || {}
}

const fakeFs = {
  existsSync: () => false,
  readFile: async (p) => {
    if (!fsState.files.has(String(p))) {
      const e = new Error('ENOENT: ' + p)
      e.code = 'ENOENT'
      throw e
    }
    const v = fsState.files.get(String(p))
    return typeof v === 'string' ? Buffer.from(v) : Buffer.from(v)
  },
  writeFile: async () => {
    // worker 脚本落盘：只计数，不进「合成产物」表（否则临时文件清理断言会被它污染）
    fsState.writeCalls++
  },
  unlink: async (p) => {
    fsState.unlinkCalls++
    if (fsState.unlinkFailures > 0) {
      fsState.unlinkFailures--
      const e = new Error('EBUSY: resource busy or locked, unlink ' + p)
      e.code = 'EBUSY'
      throw e
    }
    if (!fsState.files.has(String(p))) {
      const e = new Error('ENOENT: ' + p)
      e.code = 'ENOENT'
      throw e
    }
    fsState.files.delete(String(p))
  },
  readdir: async () => [...fsState.files.keys()].map((p) => String(p).split(/[\\/]/).pop()),
  stat: async (p) => {
    if (!fsState.files.has(String(p))) {
      const e = new Error('ENOENT: ' + p)
      e.code = 'ENOENT'
      throw e
    }
    return { mtimeMs: fsState.mtimeMs || 0 }
  },
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
    this.stdinWrites = []
    this.hasExited = false
    /** @type {string[]} 累积的 stderr 文本（测试可读） */
    this.stderrText = ''
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
    const self = this
    this.stdin = {
      write(chunk) {
        const text = String(chunk)
        self.stdinWrites.push(text)
        for (const line of text.split('\n')) {
          if (!line.trim()) continue
          let msg = null
          try { msg = JSON.parse(line) } catch { msg = null }
          if (msg) self.onRequest(msg)
        }
        return true
      },
      end() {},
      on() {},
      destroy() {},
    }
    this.start()
  }

  /** 子进程向 stdout 吐一块（Buffer 或字符串，用于模拟多字节被劈开） */
  out(chunk) {
    if (this.hasExited) return
    this.stdout.emit('data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'))
  }

  err(text) {
    if (this.hasExited) return
    this.stderrText += String(text)
    this.stderr.emit('data', Buffer.from(String(text), 'utf8'))
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
      const mode = scenario.probe || 'ok'
      if (mode === 'hang') return
      setImmediate(() => {
        if (mode === 'ok') this.out('ok\n')
        else this.err('Traceback (most recent call last):\nModuleNotFoundError: No module named \'edge_tts\'\n')
        this.exit(mode === 'ok' ? 0 : 1)
      })
      return
    }
    if (this.kind === 'worker') {
      const mode = scenario.workerStart || 'ready'
      const delay = Number(scenario.readyDelayMs) || 0
      if (mode === 'hang') return
      if (mode === 'reject') {
        setTimeout(() => {
          this.out(JSON.stringify({ ready: false, error: "ModuleNotFoundError: No module named 'edge_tts'" }) + '\n')
        }, delay)
        return
      }
      if (mode === 'chunked') {
        // 把 ready 行切成两半（半行 + 跨块），验证逐行缓冲没被劈坏
        const line = JSON.stringify({ ready: true }) + '\n'
        const cut = Math.floor(line.length / 2)
        setTimeout(() => this.out(line.slice(0, cut)), delay)
        setTimeout(() => this.out(line.slice(cut)), delay + 5)
        return
      }
      setTimeout(() => this.out(JSON.stringify({ ready: true }) + '\n'), delay)
      return
    }
    // cli：单次合成 python -m edge_tts
    const mode = scenario.cli || 'ok'
    setImmediate(() => {
      if (mode === 'ok') {
        const media = this.args[this.args.indexOf('--write-media') + 1]
        if (media) fsState.files.set(String(media), Buffer.from('ID3fake-mp3'))
        this.exit(0)
      } else if (mode === 'missing') {
        this.err("ModuleNotFoundError: No module named 'edge_tts'\n")
        this.exit(1)
      } else {
        this.err('boom\n')
        this.exit(1)
      }
    })
  }

  /** worker 收到一行请求后的行为（默认：回 ok 并把假 mp3 写进内存 fs） */
  onRequest(msg) {
    const handler = scenario.onWorkerRequest
    if (typeof handler === 'function') {
      handler(this, msg)
      return
    }
    const media = String(msg.out || '')
    fsState.files.set(media, Buffer.from('ID3fake-mp3'))
    setImmediate(() => this.out(JSON.stringify({ id: msg.id, ok: true }) + '\n'))
  }
}

function fakeSpawn(cmd, args = [], opts = {}) {
  const argv = Array.isArray(args) ? args : []
  const kind = argv.some((a) => String(a).endsWith('.py'))
    ? 'worker'
    : argv.includes('-c')
      ? 'probe'
      : 'cli'
  const child = new FakeChild(kind, argv)
  calls[kind].push({ cmd, args: argv, opts, child })
  calls.children.push(child)
  return child
}

globalThis.__ttsHarness = { fs: fakeFs, spawn: fakeSpawn }

// ---------------------------------------------------------------------------
// TS 源码沙箱：esbuild 打包成 ESM，把子进程/文件系统换成上面的假实现
// ---------------------------------------------------------------------------
const STUB_MODULE = `
const h = globalThis.__ttsHarness
export function spawn(...a) { return h.spawn(...a) }
`
const STUB_FS = `
const h = globalThis.__ttsHarness
export function existsSync(p) { return h.fs.existsSync(p) }
export function readFileSync(p) { throw new Error('not stubbed: readFileSync') }
`
const STUB_FSP = `
const h = globalThis.__ttsHarness
export function readFile(p) { return h.fs.readFile(p) }
export function writeFile(p) { return h.fs.writeFile(p) }
export function unlink(p) { return h.fs.unlink(p) }
export function readdir(p) { return h.fs.readdir(p) }
export function stat(p) { return h.fs.stat(p) }
`

const SANDBOX_DIR = join(tmpdir(), 'chubby-tts-test-' + process.pid)

function sandboxPlugin() {
  return {
    name: 'tts-test-sandbox',
    setup(build) {
      build.onResolve({ filter: /^node:child_process$/ }, () => ({ path: 'stub:child_process', namespace: 'stub' }))
      build.onResolve({ filter: /^node:fs$/ }, () => ({ path: 'stub:fs', namespace: 'stub' }))
      build.onResolve({ filter: /^node:fs\/promises$/ }, () => ({ path: 'stub:fsp', namespace: 'stub' }))
      build.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => {
        if (a.path === 'stub:child_process') return { contents: STUB_MODULE, loader: 'js' }
        if (a.path === 'stub:fs') return { contents: STUB_FS, loader: 'js' }
        return { contents: STUB_FSP, loader: 'js' }
      })
    },
  }
}

let loadSeq = 0
async function loadTsModule(relFile) {
  const out = await build({
    entryPoints: [join(ROOT, relFile)],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
    plugins: [sandboxPlugin()],
  })
  const code = out.outputFiles[0].text
  const file = join(SANDBOX_DIR, 'b' + ++loadSeq + '-' + relFile.replace(/[\\/.]/g, '_') + '.mjs')
  writeFileSync(file, code, 'utf8')
  return import(pathToFileURL(file).href)
}

// ---------------------------------------------------------------------------
// 测试主体
// ---------------------------------------------------------------------------
const INTERP = { cmd: 'fake-python', args: [], label: 'fake-python' }
const REQ = { text: '你好，大肥鱼。', voice: 'zh-CN-XiaoyiNeural', rate: '+0%', pitch: '+0Hz' }
const OUT = join(tmpdir(), 'chubby-tts-ut.mp3')

/**
 * 统一读 runner.synth 的返回：契约是布尔（失败不抛异常）。这里也兼容对象/异常写法，
 * 方便在「改前 / 改后」两种实现上跑出可对比的红绿。
 */
async function callSynth(runner, req, out, budget) {
  try {
    const r = await runner.synth(INTERP, req, out, budget)
    if (typeof r === 'boolean') return { ok: r, legacy: true }
    return { ok: Boolean(r && r.ok), legacy: false }
  } catch (e) {
    return { ok: false, rejected: String((e && e.message) || e) }
  }
}

async function main() {
  mkdirSync(SANDBOX_DIR, { recursive: true })
  process.env.CHUBBY_WHALE_PYTHON = 'fake-python'
  const W = await loadTsModule('src/host/tts/worker.ts')
  const PY = await loadTsModule('src/host/tts/python.ts')
  const ENG = await loadTsModule('src/host/tts-engine.ts')

  // ---------------------------------------------------------------- worker
  section(1, '常驻 worker 协议（ready 判定 / 逐行 JSON / id 分发）')

  {
    resetState({ workerStart: 'chunked' })
    const runner = W.createWorkerRunner()
    const r = await callSynth(runner, REQ, OUT, 2000)
    check('ready 行被劈成两块仍能判定', r.ok === true, JSON.stringify(r))
    check('合成结果落到 out 文件', fsState.files.has(OUT), '文件数=' + fsState.files.size)
    check('合成失败返回 false 而不抛异常', r.rejected === undefined, 'rejected=' + r.rejected)
    runner.dispose()
  }

  {
    // 回包里的中文被劈在多字节字符中间：StringDecoder 必须拼回来，否则 msg 解析失败 → 请求悬挂
    resetState({
      onWorkerRequest(child, msg) {
        const payload = JSON.stringify({ id: msg.id, ok: false, error: '无法连接边缘节点' }) + '\n'
        const buf = Buffer.from(payload, 'utf8')
        const cut = buf.indexOf(Buffer.from('连', 'utf8')) + 1 // 劈在「连」的中间
        setImmediate(() => {
          child.out(buf.subarray(0, cut))
          setImmediate(() => child.out(buf.subarray(cut)))
        })
      },
    })
    const runner = W.createWorkerRunner()
    const r = await callSynth(runner, REQ, OUT, 2000)
    check('多字节回包跨块不悬挂（UTF-8 解码正确）', r.ok === false && r.rejected === undefined, JSON.stringify(r))
    runner.dispose()
  }

  {
    // 两个并发请求，id 必须各自对上（乱序回包）
    resetState({
      onWorkerRequest(child, msg) {
        const delay = msg.id === 1 ? 40 : 5
        fsState.files.set(String(msg.out), Buffer.from('ID3fake-mp3'))
        setTimeout(() => child.out(JSON.stringify({ id: msg.id, ok: true }) + '\n'), delay)
      },
    })
    const runner = W.createWorkerRunner()
    const [a, b] = await Promise.all([
      callSynth(runner, { ...REQ, text: '第一段' }, OUT + '1', 2000),
      callSynth(runner, { ...REQ, text: '第二段' }, OUT + '2', 2000),
    ])
    check('并发请求乱序回包各自命中', a.ok === true && b.ok === true, JSON.stringify([a, b]))
    check('并发请求只起了一个 worker 进程', calls.worker.length === 1, 'worker 进程数=' + calls.worker.length)
    runner.dispose()
  }

  // ---------------------------------------------------------------- 预算
  section(2, '预算口径（合成总预算必须含 worker 启动）')

  {
    resetState({ readyDelayMs: 80, onWorkerRequest: () => { /* 永不回包 */ } })
    const runner = W.createWorkerRunner()
    const t0 = Date.now()
    const r = await callSynth(runner, REQ, OUT, 200)
    const dt = Date.now() - t0
    check(
      'budgetMs 覆盖 ready 等待 + 合成等待（不翻倍）',
      r.ok === false && dt <= 260,
      '实测 ' + dt + 'ms（预算 200ms；修复前 = 80+200≈280ms 起）',
    )
    runner.dispose()
  }

  {
    // 冷启动 + 共享启动 Promise：别人的启动耗时不能算进我的预算
    resetState({ readyDelayMs: 300 })
    const runner = W.createWorkerRunner()
    const warmP = runner.warm(INTERP)
    const t0 = Date.now()
    const r = await callSynth(runner, REQ, OUT, 40)
    const dt = Date.now() - t0
    check('共享启动中的请求也按自己的预算返回', r.ok === false && dt <= 130, '实测 ' + dt + 'ms（预算 40ms；修复前要等满启动 300ms）')
    await warmP
    runner.dispose()
  }

  // ---------------------------------------------------------------- kill/冷却
  section(3, 'kill 后状态 / 冷却 / 崩溃回收')

  {
    resetState({ onWorkerRequest: () => { /* 不回包 */ } })
    const runner = W.createWorkerRunner()
    const t0 = Date.now()
    const p = callSynth(runner, REQ, OUT, 5000)
    await sleep(30)
    const child = calls.worker[0].child
    child.exit(3)
    const r = await p
    const dt = Date.now() - t0
    check('运行期崩溃：在途请求立刻失败（不等满 20s 预算）', r.ok === false && dt < 500, JSON.stringify(r) + ' ' + dt + 'ms')
    resetState({})
    const r2 = await callSynth(runner, REQ, OUT, 2000)
    check('崩溃后下一个请求重新拉起 worker', r2.ok === true && calls.worker.length === 1, '新 worker 数=' + calls.worker.length)
    runner.dispose()
  }

  {
    resetState({ workerStart: 'reject' })
    const runner = W.createWorkerRunner()
    const w1 = await runner.warm(INTERP)
    const spawnsAfterFirst = calls.worker.length
    const w2 = await runner.warm(INTERP)
    check('worker 启动失败 → 冷却期内不再反复 spawn', w1 === false && w2 === false && calls.worker.length === spawnsAfterFirst, 'spawn 次数=' + calls.worker.length)
    const r = await callSynth(runner, REQ, OUT, 2000)
    check('冷却期内合成直接回落到单次合成（不白等 ready 超时）', r.ok === false, JSON.stringify(r))
    runner.dispose()
  }

  {
    resetState({ onWorkerRequest: () => { /* 不回包 */ } })
    const runner = W.createWorkerRunner()
    const r1 = await callSynth(runner, REQ, OUT, 80)
    const killed = calls.worker[0].child.killCalls
    resetState({})
    const r2 = await callSynth(runner, REQ, OUT, 2000)
    check('合成超时 → 杀掉 worker 且不进入启动冷却', r1.ok === false && killed >= 1 && r2.ok === true, 'kill=' + killed + ' 第二次=' + JSON.stringify(r2))
    runner.dispose()
  }

  // ---------------------------------------------------------------- 失败不误伤
  section(4, '单段合成失败（ok:false）不得误伤并发请求')

  {
    resetState({
      onWorkerRequest(child, msg) {
        if (msg.id === 1) {
          // 40ms 后才回 ok:false：此时 B 已经在 worker 的 pending 里排队
          setTimeout(() => child.out(JSON.stringify({ id: 1, ok: false, error: 'NoAudioReceived' }) + '\n'), 40)
          return
        }
        fsState.files.set(String(msg.out), Buffer.from('ID3fake-mp3'))
        setTimeout(() => child.out(JSON.stringify({ id: msg.id, ok: true }) + '\n'), 70)
      },
    })
    const runner = W.createWorkerRunner()
    const reqA = callSynth(runner, { ...REQ, text: '坏文本' }, OUT + 'A', 2000)
    await sleep(10)
    const reqB = callSynth(runner, { ...REQ, text: '好文本' }, OUT + 'B', 2000)
    const [a, b] = await Promise.all([reqA, reqB])
    check('失败的那段返回 false 且不抛异常', a.ok === false && a.rejected === undefined, JSON.stringify(a))
    check('并发的那段不受牵连（仍是 ok:true）', b.ok === true, JSON.stringify(b))
    check('worker 没有被杀（健康进程继续复用）', calls.worker[0].child.killCalls === 0, 'kill=' + calls.worker[0].child.killCalls)
    resetState({})
    const c = await callSynth(runner, REQ, OUT + 'C', 2000)
    check('后续请求复用同一个 worker 进程（没有重开）', c.ok === true && calls.worker.length === 0, '新 spawn 次数=' + calls.worker.length)
    runner.dispose()
  }

  // ---------------------------------------------------------------- 解释器缓存
  section(5, '解释器探测缓存（超时≠不可用 / 单飞 / 不泄漏内部对象）')

  {
    resetState({ probe: 'ok' })
    PY.resetTtsInterpreterProbe()
    const [a, b] = await Promise.all([PY.resolveProbe(), PY.resolveProbe()])
    check('并发探测单飞：只探测一次', calls.probe.length === 1, '探测次数=' + calls.probe.length)
    check('探测命中缓存同一个结论', a.interp && b.interp && a.interp.label === b.interp.label, a.interp && a.interp.label)

    const snap = PY.peekProbeOutcome()
    snap.interp.label = 'tampered'
    snap.failed = true
    const after = PY.peekProbeOutcome()
    check('peekProbeOutcome 返回副本（外部改不到内部缓存）', after.interp.label === 'fake-python' && after.failed === false, JSON.stringify({ label: after.interp.label, failed: after.failed }))
  }

  {
    resetState({ probe: 'fail' })
    PY.resetTtsInterpreterProbe()
    const o = await PY.resolveProbe()
    check('确定不可用 → failed=true（路由回 501）', o.failed === true && o.interp === null, JSON.stringify({ failed: o.failed, interp: o.interp }))
    check('不可用结论被缓存（每段不再重探）', calls.probe.length === 1 && PY.peekProbeOutcome().failed === true, '探测次数=' + calls.probe.length)
  }

  {
    // 探测超时（2s 硬超时）≠ 不可用：保留 pending，交给 worker ready 验证
    resetState({ probe: 'hang' })
    PY.resetTtsInterpreterProbe()
    const o = await PY.resolveProbe()
    check('探测超时 → pending（不判死）', o.failed === false && o.interp === null && !!o.pending, JSON.stringify({ failed: o.failed, pending: o.pending && o.pending.label }))
    check('超时结论不缓存成"不可用"', PY.peekProbeOutcome() && PY.peekProbeOutcome().failed === false, '缓存 failed=' + (PY.peekProbeOutcome() || {}).failed)
  }

  // ---------------------------------------------------------------- 引擎编排
  section(6, '引擎编排（临时文件清理 / 回退 / 501 语义）')

  {
    resetState({ probe: 'ok' })
    ENG.resetTtsInterpreterProbe()
    const eng = ENG.createEdgeTtsEngine()
    const buf = await eng.synthesize(REQ)
    check('合成返回 mp3 字节', Buffer.isBuffer(buf) && buf.length > 0, 'bytes=' + buf.length)
    check('成功后临时文件被清理', fsState.files.size === 0, '残留=' + [...fsState.files.keys()].join(',') || '无')
    eng.dispose()
  }

  {
    // Windows 上 python 还握着文件句柄：unlink 前几次 EBUSY，必须重试到成功（否则 tmp 永久漏 mp3）
    resetState({ probe: 'ok' })
    fsState.unlinkFailures = 2
    ENG.resetTtsInterpreterProbe()
    const eng = ENG.createEdgeTtsEngine()
    await eng.synthesize(REQ)
    check('unlink 遇 EBUSY 会重试（Windows 句柄未释放）', fsState.files.size === 0 && fsState.unlinkCalls >= 3, 'unlink 次数=' + fsState.unlinkCalls + ' 残留=' + fsState.files.size)
    eng.dispose()
  }

  {
    resetState({ probe: 'ok', onWorkerRequest: (child, msg) => {
      setImmediate(() => child.out(JSON.stringify({ id: msg.id, ok: false, error: 'edge_tts 失败' }) + '\n'))
    } })
    ENG.resetTtsInterpreterProbe()
    const eng = ENG.createEdgeTtsEngine()
    const buf = await eng.synthesize(REQ)
    check('worker 失败 → 回退单次合成仍出音', Buffer.isBuffer(buf) && calls.cli.length === 1, 'cli 次数=' + calls.cli.length)
    check('回退路径也清理临时文件', fsState.files.size === 0, '残留=' + fsState.files.size)
    eng.dispose()
  }

  {
    resetState({ probe: 'ok', onWorkerRequest: () => { /* 不回包 */ }, cli: 'fail' })
    ENG.resetTtsInterpreterProbe()
    const eng = ENG.createEdgeTtsEngine({ timeoutMs: 120 })
    let code = ''
    try {
      await eng.synthesize(REQ)
    } catch (e) {
      code = e && e.code ? String(e.code) : 'ERR'
    }
    check('超时 → 普通错误（非 501），且临时文件不留在 tmp', code !== 'TTS_UNAVAILABLE' && fsState.files.size === 0, 'code=' + code + ' 残留=' + fsState.files.size)
    eng.dispose()
  }

  {
    resetState({ probe: 'fail' })
    ENG.resetTtsInterpreterProbe()
    const eng = ENG.createEdgeTtsEngine()
    let code = ''
    try {
      await eng.synthesize(REQ)
    } catch (e) {
      code = e && e.code ? String(e.code) : 'ERR'
    }
    check('解释器不可用 → TTS_UNAVAILABLE（路由 501 → 浏览器降级）', code === 'TTS_UNAVAILABLE', 'code=' + code)
    const st = ENG.getTtsEngineStats()
    check('统计快照反映探测失败', st.probeState === 'unavailable' && st.probeCached === true && st.probeFailures >= 1, JSON.stringify({ probeState: st.probeState, probeFailures: st.probeFailures }))
    eng.dispose()
  }

  // ---------------------------------------------------------------- 结论
  console.log('\n通过 ' + passed + ' 项 / 失败 ' + failed + ' 项')
  if (failed === 0) console.log('  ✅ TTS 引擎离线回归通过')
  else console.log('  ❌ 有断言失败')
}

// 看门狗：源码里的探测/ready 定时器是 unref 的，单跑这个脚本时事件循环可能空掉
// （表现为 "Detected unsettled top-level await" 并静默退出 0）。这个 ref 的定时器
// 既保住事件循环，又给整套断言一个上限——卡住就算失败，不假装通过。
const watchdog = setTimeout(() => {
  console.log('\n❌ 测试超时：30s 内没跑完（有请求悬挂）')
  process.exit(1)
}, 30000)

try {
  await main()
} catch (e) {
  console.log('\n❌ 测试脚本自身抛异常：' + (e && e.stack ? e.stack : e))
  failed++
} finally {
  clearTimeout(watchdog)
  try { rmSync(SANDBOX_DIR, { recursive: true, force: true }) } catch {}
  delete process.env.CHUBBY_WHALE_PYTHON
}

process.exit(failed === 0 ? 0 : 1)
