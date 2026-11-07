/**
 * scripts/test-xplat-paths.mjs —— 跨平台落盘 / 子进程路径审计（Windows / Linux / macOS）
 *
 * 目标（本批审计范围）：`src/host/atomic.ts`、`src/host/store.ts`、`src/host/tts/**` 里
 * 「三平台行为不一致」的那几条路径，用**平台无关的等价断言**钉住：
 *
 *   · 不真跑 Linux/macOS（本机只有 Windows），而是把平台差异变成**可注入的输入**：
 *     `process.platform` 由沙箱注入（与 scripts/platform-check.mjs 同一手法），
 *     `node:fs` 换成可编程的假实现——于是「Windows 只读目标回 EPERM」「POSIX 只看目录权限」
 *     这类平台语义可以直接写成断言的**前提条件**，测的是我们的分支逻辑，不是内核。
 *   · POSIX 侧的建模依据写在这里，别当成实测：rename(2) 只要求父目录可写，目标自身
 *     权限位与覆盖无关（Windows 是被测过的那一侧，见下面 [1] 的注释与 docs）。
 *
 * 覆盖：
 *   [1] 原子写覆盖「只读目标」：Windows 清只读位重试一次（实测 EPERM 的解毒路径）；
 *       POSIX 同一场景不需要（且**绝不**去 chmod 目标，避免出人意料地改用户文件权限）
 *   [2] fsync 矩阵：POSIX = 文件 + 父目录（rename 的目录项才算落盘）；Windows = 全跳过；
 *       目录 fsync 失败（网络盘 / FUSE）不影响「写入成功」的结论
 *   [3] 失败路径：rename 非瞬时错误 → 抛错 + 清临时文件 + 不 fsync 目录 + 不 chmod 目标
 *   [4] 重试策略没被新分支改变（EBUSY×2 → 第 3 次成功；持续 EPERM → 抛出）
 *   [5] worker 脚本落点：只读安装目录 → 落到**私有临时目录**（mkdtemp，POSIX 0700），
 *       不再是「固定名字直接放 /tmp」；建不出私有目录时优雅降级（不 spawn、不抛）
 *   [6] 静态护栏：atomic.ts 导出面不变（docs/模块接口清单 是自动生成的，分身无权改 docs）；
 *       worker.ts 里不再出现旧固定名写法，也没有 process.platform 分支（三平台同一份逻辑）
 *   [7] store.ts：崩溃残留 `.tmp` 按 mtime 清扫（真 fs，平台无关）；新鲜文件 / 非 .tmp /
 *       同名目录一律不动
 *
 * 用法：node scripts/test-xplat-paths.mjs
 * 退出码：0 = 全过；1 = 有断言失败
 *
 * 注：本文件尚未并入 package.json 的 npm test（本批禁止改 package.json），由主代理决定何时接链。
 */

import { register } from 'node:module'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, utimesSync,
} from 'node:fs'
import * as nodePath from 'node:path'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const I = '  '

let passed = 0
let failed = 0
function ok(title, extra = '') { passed++; console.log(I + '✅ ' + title + (extra ? '  ' + extra : '')) }
function bad(title, extra = '') { failed++; console.error(I + '❌ ' + title + (extra ? '  ' + extra : '')) }
function check(title, cond, extra = '') { if (cond) ok(title, extra); else bad(title, extra) }
function section(n, title) { console.log('\n[' + n + '] ' + title) }

const tmpRoots = []
function mkTmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpRoots.push(d)
  return d
}

let transformSync = null
let buildFn = null
let esbuildErr = ''
try {
  const esb = await import('esbuild')
  transformSync = esb.transformSync
  buildFn = esb.build
} catch (e) {
  esbuildErr = String((e && e.message) || e)
}

// ---------------------------------------------------------------------------
// 沙箱装载：transformSync 转 CJS 后在 new Function 里跑（process 可注入）
// 只适用于没有 import.meta 的模块（atomic.ts）；worker.ts 走下面的 build 通道。
// ---------------------------------------------------------------------------
function loadTs(relFile, stubs, proc) {
  const src = readFileSync(join(ROOT, relFile), 'utf8')
  const { code } = transformSync(src, { loader: 'ts', format: 'cjs', target: 'node22', platform: 'node' })
  const mod = { exports: {} }
  const req = (id) => {
    if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id]
    throw new Error('未提供 stub 模块：' + id)
  }
  const fn = new Function('require', 'module', 'exports', 'process', 'console', code)
  fn(req, mod, mod.exports, proc, console)
  return mod.exports
}

// ---------------------------------------------------------------------------
// [1]~[4] atomic.ts：可编程的假 fs + 注入平台
// ---------------------------------------------------------------------------
/**
 * 假 fs：模拟原子写用到的全部 api，并把平台差异写成开关。
 * `state.readOnlyTargets` 里的路径：Windows 上 rename 回 EPERM（本机实测语义），POSIX 上照常成功
 * （POSIX 建模依据：rename(2) 只需父目录可写，与目标权限位无关）。
 */
function fakeAtomicFs(platform, state) {
  const log = { opened: [], fsyncs: [], closed: [], renames: [], chmods: [], unlinked: [] }
  const fdPaths = new Map()
  let nextFd = 100
  const isReadonly = (p) => state.readOnlyTargets.has(String(p))
  const fsStub = {
    mkdirSync() { },
    openSync(p, flags) {
      const fd = nextFd++
      fdPaths.set(fd, String(p))
      log.opened.push({ path: String(p), flags: String(flags || ''), fd })
      return fd
    },
    writeFileSync() { },
    fsyncSync(fd) {
      log.fsyncs.push({ fd, path: fdPaths.get(fd) || '' })
      if (state.fsyncThrowsFor && state.fsyncThrowsFor(fdPaths.get(fd) || '')) {
        const e = new Error('EINVAL: fsync not supported'); e.code = 'EINVAL'; throw e
      }
    },
    closeSync(fd) { log.closed.push(fd) },
    renameSync(from, to) {
      log.renames.push({ from: String(from), to: String(to) })
      if (state.renameError) {
        const e = new Error('simulated rename failure'); e.code = state.renameError; throw e
      }
      if (platform === 'win32' && isReadonly(to)) {
        const e = new Error('EPERM: operation not permitted, rename'); e.code = 'EPERM'; throw e
      }
    },
    unlinkSync(p) { log.unlinked.push(String(p)) },
    existsSync(p) {
      const s = String(p)
      if (state.missing && state.missing.has(s)) return false
      return true
    },
    chmodSync(p, mode) {
      log.chmods.push({ path: String(p), mode: Number(mode) })
      // Windows 的 chmod：有写位 = 清掉 FILE_ATTRIBUTE_READONLY
      if ((Number(mode) & 0o200) !== 0) state.readOnlyTargets.delete(String(p))
    },
    readFileSync() { return '{}' },
  }
  const deps = {
    'node:fs': fsStub,
    'node:path': nodePath,
  }
  return { fsStub, deps, log, fdPaths }
}

function makeState(over = {}) {
  return Object.assign({ readOnlyTargets: new Set(), renameError: null, missing: new Set(), fsyncThrowsFor: null }, over)
}

function loadAtomicWith(platform, state) {
  if (!transformSync) return null
  const fake = fakeAtomicFs(platform, state)
  const proc = { platform, pid: 4242, env: {} }
  const mod = loadTs('src/host/atomic.ts', fake.deps, proc)
  return { mod, log: fake.log }
}

const ATOMIC_TARGET = '/data/chubby/memory.json'
const ATOMIC_DIR = '/data/chubby'

function atomicCases() {
  section(1, '原子写覆盖「只读目标」：Windows 清只读位重试 / POSIX 压根不需要')

  if (!transformSync) {
    bad('加载 atomic.ts 失败', '需要 devDependency esbuild：' + esbuildErr)
    return
  }

  // —— Windows：目标只读 → rename EPERM（实测）→ 清只读位 → 第二次 rename 成功
  {
    const state = makeState({ readOnlyTargets: new Set([ATOMIC_TARGET]) })
    const { mod, log } = loadAtomicWith('win32', state)
    let threw = null
    try { mod.writeFileAtomic(ATOMIC_TARGET, 'v2') } catch (e) { threw = e }
    check('win32：只读目标照样写得进去（不再恒失败）', threw === null, threw ? String(threw.code || threw.message) : '')
    const renames = log.renames.filter((r) => r.to === ATOMIC_TARGET)
    check('win32 → 先 EPERM 再重试成功（只 2 次 rename，不为确定性失败白等 3 轮）', renames.length === 2, 'renames=' + renames.length)
    const chmods = log.chmods.filter((c) => c.path === ATOMIC_TARGET)
    check('win32 → 清只读位只做一次且是 0666', chmods.length === 1 && chmods[0].mode === 0o666, JSON.stringify(chmods))
    const chmodIdx = log.chmods.findIndex((c) => c.path === ATOMIC_TARGET)
    check('win32 → 顺序：rename 失败 → chmod → rename', chmodIdx >= 0 && log.unlinked.length === 0, 'unlinked=' + log.unlinked.length)
    check('win32 → 没有多删临时文件（改名成功不清理）', log.unlinked.length === 0, JSON.stringify(log.unlinked))
    check('win32 → 全程不做 fsync（含目录）', log.fsyncs.length === 0, 'fsync=' + log.fsyncs.length)
  }

  // —— POSIX：同一个"只读"目标，rename 本来就能覆盖 → 一次成功、不去 chmod 用户文件
  for (const platform of ['linux', 'darwin']) {
    const state = makeState({ readOnlyTargets: new Set([ATOMIC_TARGET]) })
    const { mod, log } = loadAtomicWith(platform, state)
    let threw = null
    try { mod.writeFileAtomic(ATOMIC_TARGET, 'v2') } catch (e) { threw = e }
    check(platform + '：只读目标一次覆盖成功（POSIX rename 只看目录权限）', threw === null, threw ? String(threw.code || threw.message) : '')
    check(platform + '：不去 chmod 目标文件（不改用户权限位）', log.chmods.filter((c) => c.path === ATOMIC_TARGET).length === 0)
    check(platform + '：rename 只调一次', log.renames.filter((r) => r.to === ATOMIC_TARGET).length === 1)
  }

  // —— Windows：rename EPERM 但目标不存在（多半是杀毒/句柄），没有"只读位"可清 → 直接抛
  {
    const state = makeState({ renameError: 'EPERM', missing: new Set([ATOMIC_TARGET]) })
    const { mod, log } = loadAtomicWith('win32', state)
    let threw = null
    try { mod.writeFileAtomic(ATOMIC_TARGET, 'x') } catch (e) { threw = e }
    check('win32：EPERM 但目标不存在 → 抛错（不瞎 chmod）', threw && threw.code === 'EPERM', threw ? String(threw.code) : 'no throw')
    check('win32：目标不存在时一次 chmod 都没有', log.chmods.length === 0, JSON.stringify(log.chmods))
    check('win32：失败后清掉临时文件', log.unlinked.length === 1, JSON.stringify(log.unlinked))
    check('win32：失败后不 fsync 目录', log.fsyncs.length === 0, 'fsync=' + log.fsyncs.length)
  }

  section(2, 'fsync 矩阵：POSIX = 文件 + 父目录；Windows = 全跳过')

  for (const platform of ['linux', 'darwin']) {
    const state = makeState()
    const { mod, log } = loadAtomicWith(platform, state)
    mod.writeFileAtomic(ATOMIC_TARGET, 'x')
    const target = join(ATOMIC_DIR, 'memory.json')
    const fileFsync = log.fsyncs.filter((f) => f.path !== ATOMIC_DIR && String(f.path).indexOf('memory.json.') >= 0)
    const dirFsync = log.fsyncs.filter((f) => f.path === ATOMIC_DIR)
    check(platform + '：文件 fsync 一次', fileFsync.length === 1, JSON.stringify(log.fsyncs))
    check(platform + '：父目录 fsync 一次（rename 的目录项才算落盘）', dirFsync.length === 1, JSON.stringify(log.fsyncs))
    const dirOpen = log.opened.filter((o) => o.path === ATOMIC_DIR)
    check(platform + '：目录以只读方式打开且被关闭', dirOpen.length === 1 && dirOpen[0].flags === 'r' && log.closed.includes(dirOpen[0].fd))
    // 目录 fsync 在改名成功之后：最后两次 fsync 里，目录是后一个
    check(platform + '：顺序 = 先文件后目录', log.fsyncs.length >= 2 && log.fsyncs[log.fsyncs.length - 1].path === ATOMIC_DIR)
    check(platform + '：目标路径是 ' + target.replace(/\\/g, '/').slice(-14) + ' 结尾', String(log.renames[0].to).endsWith('memory.json'), String(log.renames[0].to))
  }

  {
    // 目录 fsync 不支持（网络盘 / FUSE）：写入仍算成功
    const state = makeState({ fsyncThrowsFor: (p) => p === ATOMIC_DIR })
    const { mod, log } = loadAtomicWith('linux', state)
    let threw = null
    try { mod.writeFileAtomic(ATOMIC_TARGET, 'x') } catch (e) { threw = e }
    check('linux：目录 fsync 失败不把写入变成失败', threw === null, threw ? String(threw.message) : '')
    check('linux：目录 fsync 确实尝试过', log.fsyncs.some((f) => f.path === ATOMIC_DIR))
  }

  section(3, '失败路径：非瞬时 rename 错误 → 抛错 / 清临时文件 / 不乱 fsync')

  for (const platform of ['win32', 'linux', 'darwin']) {
    const state = makeState({ renameError: 'ENOSPC' })
    const { mod, log } = loadAtomicWith(platform, state)
    let threw = null
    try { mod.writeFileAtomic(ATOMIC_TARGET, 'x') } catch (e) { threw = e }
    const targetChmods = log.chmods.filter((c) => c.path === ATOMIC_TARGET)
    check(platform + '：ENOSPC → 抛错', Boolean(threw) && threw.code === 'ENOSPC', threw ? String(threw.code) : 'no throw')
    check(platform + '：ENOSPC → 只试 1 次（不重试、不清目标只读位）', log.renames.length === 1 && targetChmods.length === 0, 'renames=' + log.renames.length + ' targetChmods=' + targetChmods.length)
    check(platform + '：ENOSPC → 清掉临时文件', log.unlinked.length === 1, JSON.stringify(log.unlinked))
    check(platform + '：ENOSPC → 不 fsync 目录', log.fsyncs.every((f) => f.path !== ATOMIC_DIR))
  }

  section(4, '重试策略未被新分支改变（Windows 占用类错误仍是 1+3 次）')
  {
    const state = makeState({ renameError: 'EBUSY' })
    const { mod, log } = loadAtomicWith('win32', state)
    // EBUSY 持续失败 + 目标存在 → 清一次只读位后再来一轮（4+4），但绝不能无限循环
    let threw = null
    try { mod.writeFileAtomic(ATOMIC_TARGET, 'x') } catch (e) { threw = e }
    check('win32：持续 EBUSY 有界（≤ 8 次 rename）后抛出', Boolean(threw) && log.renames.length <= 8, 'renames=' + log.renames.length)
    check('win32：持续 EBUSY 时清只读位最多一次', log.chmods.length <= 1, JSON.stringify(log.chmods))
  }
  {
    const state = makeState({ renameError: 'EPERM' })
    const { mod, log } = loadAtomicWith('linux', state)
    let threw = null
    try { mod.writeFileAtomic(ATOMIC_TARGET, 'x') } catch (e) { threw = e }
    check('linux：持续 EPERM（目录不可写）→ 抛错', Boolean(threw) && threw.code === 'EPERM')
    check('linux：POSIX 分支绝不 chmod 目标（只给临时文件上 0600）',
      log.chmods.every((c) => c.path !== ATOMIC_TARGET), JSON.stringify(log.chmods))
    check('linux：重试 1+3 次（4 次 rename）', log.renames.length === 4, 'renames=' + log.renames.length)
  }
}

// ---------------------------------------------------------------------------
// [5] worker.ts：只读安装目录 → 私有临时目录（走 esbuild build，保留 import.meta）
// ---------------------------------------------------------------------------
class FakeChild extends EventEmitter {
  constructor(cmd, args) {
    super()
    this.cmd = cmd
    this.args = args
    this.pid = 4321
    this.exitCode = null
    this.signalCode = null
    this.destroyed = false
    this.stdin = { write() { return true }, on() { }, destroyed: false }
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
  }
  kill() { this.signalCode = 'SIGTERM'; return true }
}

async function loadWorkerBundle(stubs) {
  const SANDBOX = mkTmp('xplat-worker-')
  const out = await buildFn({
    entryPoints: [join(ROOT, 'src/host/tts/worker.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
    plugins: [{
      name: 'xplat-worker-stub',
      setup(b) {
        const map = {
          'node:child_process': 'stub:cp',
          'node:fs': 'stub:fs',
          'node:fs/promises': 'stub:fsp',
          'node:os': 'stub:os',
        }
        for (const k of Object.keys(map)) b.onResolve({ filter: new RegExp('^' + k.replace(/[/]/g, '\\/') + '$') }, () => ({ path: map[k], namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => {
          const h = 'const h = globalThis.__xplatWorkerHarness\n'
          if (a.path === 'stub:cp') return { contents: h + 'export function spawn(...a){ return h.spawn(...a) }', loader: 'js' }
          if (a.path === 'stub:fs') return { contents: h + 'export function existsSync(p){ return h.existsSync(p) }', loader: 'js' }
          if (a.path === 'stub:fsp') return { contents: h + 'export async function readFile(p){ return h.readFile(p) }\nexport async function writeFile(p,d){ return h.writeFile(p,d) }', loader: 'js' }
          return { contents: h + 'export function tmpdir(){ return h.tmpdir() }', loader: 'js' }
        })
      },
    }],
  })
  const file = join(SANDBOX, 'worker-bundle.mjs')
  writeFileSync(file, out.outputFiles[0].text, 'utf8')
  return import(pathToFileURL(file).href)
}

async function workerCases() {
  section(5, 'worker 脚本落点：固定名 /tmp → 私有临时目录（mkdtemp，POSIX 0700）')

  if (!buildFn) {
    bad('加载 worker.ts 失败', '需要 devDependency esbuild：' + esbuildErr)
    return
  }

  const realGetBuiltinModule = process.getBuiltinModule
  try {
    // —— 场景 A：安装目录只读（全局安装在 root 名下 / 只读镜像）→ 落到私有目录
    {
      const fakeTmp = mkTmp('xplat-faketmp-')
      const privateDir = join(fakeTmp, 'chubby-tts-worker-Xk29Qa')
      const log = { mkdtemp: [], writes: [], spawns: [], taskkill: 0 }
      const harness = {
        spawn(cmd, args) {
          const child = new FakeChild(cmd, Array.isArray(args) ? args : [])
          if (cmd === 'taskkill') { log.taskkill++; return child }
          log.spawns.push({ cmd, args: child.args })
          setImmediate(() => { child.exitCode = 1; child.emit('exit', 1) })
          return child
        },
        existsSync: () => false,
        readFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
        writeFile: async (p) => {
          const s = String(p)
          log.writes.push(s)
          if (!s.startsWith(fakeTmp)) throw Object.assign(new Error('EACCES: 只读安装目录'), { code: 'EACCES' })
        },
        tmpdir: () => fakeTmp,
      }
      globalThis.__xplatWorkerHarness = harness
      process.getBuiltinModule = (id) => {
        if (id !== 'node:fs') throw new Error('unexpected ' + id)
        return { mkdtempSync: (prefix) => { log.mkdtemp.push(String(prefix)); return privateDir } }
      }
      const W = await loadWorkerBundle()
      const runner = W.createWorkerRunner()
      const warm = await runner.warm({ cmd: 'python3', args: [], label: 'python3' })
      runner.dispose()

      check('落点策略：先试安装目录，再退私有目录', log.writes.length === 2, JSON.stringify(log.writes.map((w) => w.split(/[\\/]/).pop())))
      check('私有目录用 mkdtemp 建（前缀带分隔符，不是拼出来的固定名）', log.mkdtemp.length === 1 && log.mkdtemp[0] === join(fakeTmp, 'chubby-tts-worker-'), JSON.stringify(log.mkdtemp))
      const expected = join(privateDir, 'tts-worker-v1.py')
      check('worker 脚本落在私有目录里', log.writes[1] === expected, log.writes[1])
      check('不再用「固定名直接放临时根」的旧写法', log.writes.every((w) => w !== join(fakeTmp, 'chubby-tts-worker-v1.py')), JSON.stringify(log.writes))
      check('spawn 拿到的是私有目录里的脚本', log.spawns.length === 1 && log.spawns[0].args[log.spawns[0].args.length - 1] === expected, JSON.stringify(log.spawns.map((s) => s.args)))
      check('私有目录建不出来前不抛（warm 返回 false 而不是崩）', warm === false)
      check('私有目录只用 args 数组 spawn（无 shell 拼接）', log.spawns.every((s) => Array.isArray(s.args) && s.args.every((a) => typeof a === 'string')))
    }

    // —— 场景 B：私有目录也建不出来（只读 /tmp）→ 退单次 spawn，不抛、不 spawn worker
    {
      const fakeTmp = mkTmp('xplat-faketmp2-')
      const log = { spawns: [] }
      globalThis.__xplatWorkerHarness = {
        spawn(cmd, args) {
          const child = new FakeChild(cmd, Array.isArray(args) ? args : [])
          if (cmd === 'taskkill') return child
          log.spawns.push({ cmd, args: child.args })
          setImmediate(() => { child.exitCode = 1; child.emit('exit', 1) })
          return child
        },
        existsSync: () => false,
        readFile: async () => { throw new Error('ENOENT') },
        writeFile: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) },
        tmpdir: () => fakeTmp,
      }
      process.getBuiltinModule = () => ({ mkdtempSync: () => { throw Object.assign(new Error('EACCES: /tmp 只读'), { code: 'EACCES' }) } })
      const W = await loadWorkerBundle()
      const runner = W.createWorkerRunner()
      let threw = null
      let warm = null
      try { warm = await runner.warm({ cmd: 'python3', args: [], label: 'python3' }) } catch (e) { threw = e }
      runner.dispose()
      check('落盘全失败时 warm 不抛异常', threw === null, threw ? String(threw.message) : '')
      check('落盘全失败时 warm 返回 false（调用方走单次 spawn）', warm === false)
      check('落盘全失败时不硬起 python（不 spawn worker）', log.spawns.length === 0, JSON.stringify(log.spawns))
    }
  } finally {
    process.getBuiltinModule = realGetBuiltinModule
    delete globalThis.__xplatWorkerHarness
  }
}

// ---------------------------------------------------------------------------
// [6] 静态护栏：导出面不变 / 旧写法不再出现 / 无平台分支
// ---------------------------------------------------------------------------
function staticCases() {
  section(6, '静态护栏：导出面与写法（防下批无意回退）')

  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  }

  const atomicSrc = readFileSync(join(ROOT, 'src/host/atomic.ts'), 'utf8')
  const workerSrc = readFileSync(join(ROOT, 'src/host/tts/worker.ts'), 'utf8')
  const storeSrc = readFileSync(join(ROOT, 'src/host/store.ts'), 'utf8')

  // 导出面必须与 docs/模块接口清单.md 一致（docs 由 scripts/gen-module-index.mjs 自动生成，
  // 分身不许改 docs → 也就意味着不许增删导出）
  const exportRe = /^export\s+(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm
  const reexportRe = /^export\s+\{([^}]+)\}\s*(?:from)?/gm
  const names = new Set()
  for (const m of atomicSrc.matchAll(exportRe)) names.add(m[1])
  for (const m of reexportRe.matchAll ? atomicSrc.matchAll(reexportRe) : []) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop()
      if (n) names.add(n.trim())
    }
  }
  const got = [...names].sort().join(',')
  const want = [
    'chmodPrivateDir', 'chmodPrivateFile', 'ensurePrivateDir', 'isMissingFileError',
    'isPosixModePlatform', 'isRetriableRenameError', 'quarantineFile', 'readTextNoBom',
    'renameWithRetry', 'stripBom', 'writeFileAtomic', 'writeJsonAtomic',
  ].sort().join(',')
  check('atomic.ts 导出面未变（模块接口清单不用重生成）', got === want, got === want ? '' : '实际：' + got)

  const workerCode = stripComments(workerSrc)
  check('worker.ts 不再把固定名字直接放临时根', workerCode.indexOf("'chubby-' + WORKER_FILE") < 0)
  check('worker.ts 私有目录逻辑无 process.platform 分支（三平台同一份）', workerCode.indexOf('process.platform') < 0)
  check('worker.ts 仍走 getBuiltinModule 取 mkdtemp（不动 import 面，测试沙箱不受影响）',
    workerCode.indexOf("getBuiltinModule('node:fs')") >= 0 && workerCode.indexOf('mkdtempSync') >= 0)

  const atomicCode = stripComments(atomicSrc)
  check('atomic.ts 目录 fsync 有 POSIX 守卫', /function fsyncDir[\s\S]*?isPosixModePlatform\(\)/.test(atomicCode))
  check('atomic.ts 清只读位有 POSIX 提前返回（Linux/macOS 绝不 chmod 目标）',
    /function markTargetWritable[\s\S]*?isPosixModePlatform\(\)\) return false/.test(atomicCode))
  check('atomic.ts 清只读位只在可重试错误上试（ENOSPC 之类不折腾）',
    /function markTargetWritable[\s\S]*?!isRetriableRenameError\(err\)\) return false/.test(atomicCode))

  const storeCode = stripComments(storeSrc)
  check('store.ts 清扫 .tmp 带 mtime 阈值（不删新鲜临时文件）',
    storeCode.indexOf('STALE_TMP_MS') >= 0 && /now - mtime <= STALE_TMP_MS/.test(storeCode))
  check('store.ts 清扫只认 .tmp 后缀 + 只删普通文件',
    storeCode.indexOf("endsWith('.tmp')") >= 0 && storeCode.indexOf('isFile()') >= 0)
}

// ---------------------------------------------------------------------------
// [7] store.ts：崩溃残留 .tmp 清扫（真 fs，三平台同一行为）
// ---------------------------------------------------------------------------
async function storeCases() {
  section(7, 'store.ts：崩溃残留 .tmp 按 mtime 清扫（真文件系统）')

  register(new URL('./ts-resolve.mjs', import.meta.url))
  let createStore = null
  try {
    ({ createStore } = await import(pathToFileURL(join(ROOT, 'src/host/store.ts')).href))
  } catch (e) {
    bad('加载 store.ts 失败', String((e && e.message) || e))
    return
  }

  const dir = mkTmp('xplat-store-')
  const oldT = Date.now() - 2 * 60 * 60 * 1000
  const newT = Date.now()

  const stale = join(dir, 'memory.json.4242.ab12cd.tmp')
  const fresh = join(dir, 'state.json.4242.ef34gh.tmp')
  const notTmp = join(dir, 'notes.txt')
  const keepTmpDir = join(dir, 'backup.tmp')
  writeFileSync(stale, 'half', 'utf8')
  writeFileSync(fresh, 'half', 'utf8')
  writeFileSync(notTmp, 'x', 'utf8')
  mkdirSync(keepTmpDir)
  utimesSync(stale, new Date(oldT), new Date(oldT))
  utimesSync(notTmp, new Date(oldT), new Date(oldT))
  utimesSync(keepTmpDir, new Date(oldT), new Date(oldT))
  utimesSync(fresh, new Date(newT), new Date(newT))

  const logs = []
  const realLog = console.log
  console.log = (...a) => { logs.push(a.join(' ')); realLog.apply(console, a) }
  let threw = null
  try { createStore(dir) } catch (e) { threw = e } finally { console.log = realLog }

  check('createStore 不因清扫抛异常', threw === null, threw ? String(threw.message) : '')
  check('两小时前的 .tmp 被清掉（崩溃残留）', !existsSync(stale))
  check('刚写的 .tmp 保留（在途写入不能误删）', existsSync(fresh))
  check('同名目录 .tmp 不删（只删普通文件）', existsSync(keepTmpDir))
  check('非 .tmp 文件不删', existsSync(notTmp))
  check('目录里剩下的条目数正确', readdirSync(dir).sort().join(',') === ['backup.tmp', 'notes.txt', 'state.json.4242.ef34gh.tmp'].sort().join(','), readdirSync(dir).join(','))
  check('清扫会留一行日志（可排障）', logs.some((l) => l.indexOf('崩溃残留的临时文件 1 个') >= 0), logs.filter((l) => l.indexOf('临时文件') >= 0).join(' | '))

  // 门面仍然正常：原子写读回一致（清扫不能碰坏主路径）
  const before = readdirSync(dir).sort()
  const store = createStore(dir)
  store.saveState({ intimacy: 7 })
  const back = store.loadState()
  check('清扫之后 store 门面照常读写', back && back.intimacy === 7, JSON.stringify(back))
  // 只多了 state.json（原子写产物），没有多出任何临时文件
  const added = readdirSync(dir).sort().filter((n) => before.indexOf(n) < 0)
  check('原子写之后目录里只多出 state.json（无 .tmp 残留）', added.join(',') === 'state.json', 'added=' + added.join(','))
}

// ---------------------------------------------------------------------------
// [8] 真 fs：路径含空格 / 中文 / emoji（三平台同一套命名规则）
// ---------------------------------------------------------------------------
async function pathCases() {
  section(8, '真文件系统：路径含空格 / 中文 / emoji（原子写 + 坏文件隔离）')

  const A = await import(pathToFileURL(join(ROOT, 'src/host/atomic.ts')).href)
  const dir = mkTmp('xplat path 中文 😀-')
  check('临时目录名带空格/中文/emoji 也能建（NTFS/ext4/APFS 都支持）', existsSync(dir), dir)

  const target = join(dir, '记忆 文件 🐟.json')
  let threw = null
  try { A.writeJsonAtomic(target, { ok: true, 鱼: '肥' }) } catch (e) { threw = e }
  check('中文 + emoji + 空格文件名可以原子写', threw === null, threw ? String(threw.message) : '')
  check('内容可回读', existsSync(target) && JSON.parse(readFileSync(target, 'utf8')).鱼 === '肥')
  check('写成功不留临时文件', readdirSync(dir).every((n) => !n.endsWith('.tmp')), readdirSync(dir).join(','))

  const bad = join(dir, '坏 文件 😵.json')
  writeFileSync(bad, '{ 坏掉', 'utf8')
  let qThrew = null
  const realErr = console.error
  console.error = () => { }
  try { A.quarantineFile(bad, new Error('parse'), '[test]') } catch (e) { qThrew = e } finally { console.error = realErr }
  const badNames = readdirSync(dir).filter((n) => n.indexOf('坏 文件 😵.json.bad-') === 0)
  check('坏文件隔离名对这类路径也成立', qThrew === null && badNames.length === 1, badNames.join(','))
  check('隔离名不含 Windows 非法字符（: * ? " < > |）', badNames.length === 1 && !/[:*?"<>|]/.test(badNames[0]), badNames[0])
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  console.log('\n=== 跨平台落盘 / 子进程路径审计（Windows / Linux / macOS）===')
  atomicCases()
  await workerCases()
  staticCases()
  await storeCases()
  await pathCases()

  for (const d of tmpRoots) { try { rmSync(d, { recursive: true, force: true }) } catch { } }

  console.log('\n' + I + '通过 ' + passed + ' 项 / 失败 ' + failed + ' 项')
  if (failed > 0) {
    console.error(I + '❌ 有断言失败')
    process.exit(1)
  }
  console.log(I + '✅ 全部通过（平台差异用注入建模：POSIX 侧依据 rename(2) 语义，Windows 侧为本机实测）')
}

await main()
