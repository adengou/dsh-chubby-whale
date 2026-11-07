/**
 * scripts/test-migrate.mjs —— B105「运行数据迁移与运行目录加固」专项回归
 *
 * 覆盖 B100 配置分身审计指出的 4 个问题（每条都有对应断言）：
 *   [1] pre-B74 崩溃留下的 0 字节目标：旧实现用 existsSync 判「已迁移」，
 *       于是 0 字节 dst 被永久当成已迁移，插件包里的旧数据再也搬不过去。
 *       新口径：视为上次崩溃的半成品——先把原文件改名成 `<名>.empty-<时间戳>.bak` 留证，
 *       再落新文件；连续跑两次结果必须一致（幂等）。
 *   [2] 崩溃遗留的 `.migrating-*` 临时文件/临时目录：旧实现永不清理。
 *       新口径：运行目录第一层、按 mtime（>1 小时）清扫；刚从盘上冒出来的可能是
 *       另一个实例在途的拷贝，不动。幂等。
 *   [3] migrate 建目录没用 0700（atomic.ensurePrivateDir 才有）：POSIX 首建是 0755。
 *       新口径：建目录即 0700，POSIX 下再 chmod 一次收紧旧目录；Windows 忽略权限、不报错。
 *       Windows 本机没法真的 stat 出 0700，所以用注入 platform/mkdir/chmod 验证调用口径，
 *       再加一道源码核对（不许再出现裸 `{ recursive: true }` 的 mkdir）。
 *   [4] 三份运行数据名单不一致（migrate 9 / store 11 / auto-backup 9）。
 *       新口径：store.ts 里一份「运行数据全名单」为唯一真源，migrate 与 hardenRuntimeDir
 *       都从它读；culture-seen.json / poem-seen.json 在内，缺文件不算错误。
 *
 * 用法：node scripts/test-migrate.mjs
 *   （单独运行：package.json 的 npm test 链不在本批可改范围内，由主代理决定何时接链。
 *     只读源码 + 临时目录，不联网、不碰真实运行数据 ~/.dsh-chubby-whale。）
 */

import { register } from 'node:module'
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

register(new URL('./ts-resolve.mjs', import.meta.url))

const M = await import('../src/host/migrate.ts')
const S = await import('../src/host/store.ts')

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

const dirs = []
const tmp = (tag) => {
  const d = mkdtempSync(join(tmpdir(), 'chubby-b105-' + tag + '-'))
  dirs.push(d)
  return d
}
const cleanup = () => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }) } catch { } } }

/** 捕获 console.log（迁移进度/清理日志都在这里，既避免刷屏也便于断言） */
function captureConsole() {
  const origLog = console.log
  const logs = []
  console.log = (...a) => { logs.push(a.map(String).join(' ')) }
  return {
    logs,
    text: () => logs.join('\n'),
    has: (sub) => logs.some((l) => l.indexOf(sub) >= 0),
    restore: () => { console.log = origLog },
  }
}

/** 目录第一层的条目名（排序；目录不存在时返回空数组） */
const entries = (dir) => { try { return readdirSync(dir).sort() } catch { return [] } }

/** 0 字节半成品的留证备份：`<名>.empty-<时间戳>.bak` */
const baks = (dir, base) => entries(dir).filter((n) => n.indexOf(base + '.empty-') === 0 && n.endsWith('.bak'))

/** 崩溃残留的迁移临时名（文件或目录） */
const migratingLeftovers = (dir) => entries(dir).filter((n) => n.indexOf('.migrating-') >= 0)

/** 读文本；读不到返回 null（断言里用 null 判失败，不让一个缺文件把整轮测试打断） */
const readOr = (file) => { try { return readFileSync(file, 'utf8') } catch { return null } }

/** 运行数据全名单（migrate 9 ∪ store 11 ∪ auto-backup 9 的并集） */
const ALL_FILES = [
  'memory.json', 'personality.json', 'state.json', 'pet_state.json', 'growth.json',
  'fishfood.json', 'reminders.json', 'story_progress.json',
  'culture-seen.json', 'poem-seen.json', 'prefs.json',
]

try {
  // ================= 1. 0 字节目标：崩溃半成品可覆盖，但必须留证且幂等 =================
  console.log('\n[1] 0 字节目标（pre-B74 崩溃半成品）：改名留证 + 覆盖 + 幂等')
  {
    const data = tmp('mig-empty-data')
    const run = tmp('mig-empty-run')
    const PKG = '{"history":[],"summary":"package"}'
    writeFileSync(join(data, 'memory.json'), PKG, 'utf8')
    writeFileSync(join(run, 'memory.json'), '', 'utf8')   // 崩溃留下的 0 字节 dst

    const cap1 = captureConsole()
    M.migrateRuntimeData(data, run)
    cap1.restore()

    ok('0 字节目标：被插件包数据替换（旧实现因 existsSync 永久跳过）',
      readFileSync(join(run, 'memory.json'), 'utf8') === PKG)
    const b1 = baks(run, 'memory.json')
    ok('0 字节目标：原文件改名成 <名>.empty-<时间戳>.bak 留证', b1.length === 1, b1.join(','))
    ok('0 字节目标：留证内容就是那个 0 字节原文',
      b1.length === 1 && readFileSync(join(run, b1[0]), 'utf8') === '')
    ok('0 字节目标：插件包源文件保留、字节不变',
      readFileSync(join(data, 'memory.json'), 'utf8') === PKG)
    ok('0 字节目标：日志点明「0 字节 / 半成品」，排障不用猜',
      cap1.has('0 字节') || cap1.has('半成品'), cap1.text().slice(0, 200))

    const afterFirst = entries(run)
    const cap2 = captureConsole()
    M.migrateRuntimeData(data, run)
    cap2.restore()

    ok('幂等：第二次目标内容不变', readFileSync(join(run, 'memory.json'), 'utf8') === PKG)
    ok('幂等：不再新增 .bak', baks(run, 'memory.json').length === 1, baks(run, 'memory.json').join(','))
    ok('幂等：目录条目集合与第一次后完全一致',
      JSON.stringify(entries(run)) === JSON.stringify(afterFirst), entries(run).join(','))
    ok('幂等：第二次运行不再打印迁移日志', cap2.logs.length === 0, cap2.text().slice(0, 200))

    // 回归：非 0 字节 = 用户数据，绝不覆盖
    const data2 = tmp('mig-keep-data')
    const run2 = tmp('mig-keep-run')
    writeFileSync(join(data2, 'memory.json'), PKG, 'utf8')
    writeFileSync(join(run2, 'memory.json'), '{"user":"new"}', 'utf8')
    const cap3 = captureConsole()
    M.migrateRuntimeData(data2, run2)
    cap3.restore()
    ok('回归：非 0 字节目标仍然绝不覆盖',
      readFileSync(join(run2, 'memory.json'), 'utf8') === '{"user":"new"}')
    ok('回归：不覆盖时也不产生 .bak', baks(run2, 'memory.json').length === 0)

    // 源缺失：0 字节目标原样保留（没有更好的东西可放，别制造垃圾备份）
    const data3 = tmp('mig-nosrc-data')
    const run3 = tmp('mig-nosrc-run')
    writeFileSync(join(run3, 'memory.json'), '', 'utf8')
    const cap4 = captureConsole()
    M.migrateRuntimeData(data3, run3)
    cap4.restore()
    ok('插件包没有同名源：0 字节目标原样保留、不产生 .bak',
      readFileSync(join(run3, 'memory.json'), 'utf8') === '' && baks(run3, 'memory.json').length === 0)

    // 拷贝失败：0 字节目标不被改名（失败不毁证、下次还能重试）
    const data4 = tmp('mig-fail-data')
    const run4 = tmp('mig-fail-run')
    writeFileSync(join(data4, 'memory.json'), PKG, 'utf8')
    writeFileSync(join(run4, 'memory.json'), '', 'utf8')
    const cap5 = captureConsole()
    M.migrateRuntimeData(data4, run4, {
      copyFile: (_src, dst) => { writeFileSync(dst, '{"half', 'utf8'); throw new Error('disk full') },
    })
    cap5.restore()
    ok('拷贝失败：0 字节目标仍在、也没被改名（先拷贝再改名，顺序不能反）',
      readFileSync(join(run4, 'memory.json'), 'utf8') === '' && baks(run4, 'memory.json').length === 0)
    ok('拷贝失败：不留 .migrating-* 临时文件',
      migratingLeftovers(run4).length === 0, migratingLeftovers(run4).join(','))
    const cap6 = captureConsole()
    M.migrateRuntimeData(data4, run4)
    cap6.restore()
    ok('拷贝失败后下次启动补上（并只留证一份）',
      readFileSync(join(run4, 'memory.json'), 'utf8') === PKG && baks(run4, 'memory.json').length === 1)

    // 源本身也是 0 字节：不搬（否则「半成品换半成品」每次启动都多一个 .bak，破坏幂等）
    const data5 = tmp('mig-both-empty-data')
    const run5 = tmp('mig-both-empty-run')
    writeFileSync(join(data5, 'memory.json'), '', 'utf8')
    writeFileSync(join(run5, 'memory.json'), '', 'utf8')
    const before5 = entries(run5)
    const cap7 = captureConsole()
    M.migrateRuntimeData(data5, run5)
    M.migrateRuntimeData(data5, run5)
    cap7.restore()
    ok('源也是 0 字节：不做替换、不产生 .bak、两次运行目录一致',
      readFileSync(join(run5, 'memory.json'), 'utf8') === '' &&
      baks(run5, 'memory.json').length === 0 &&
      JSON.stringify(entries(run5)) === JSON.stringify(before5))
  }

  // ================= 2. .migrating-* 崩溃残留：清理且幂等 =================
  console.log('\n[2] .migrating-* 崩溃残留：清扫（>1 小时）、保护在途、幂等')
  {
    const data = tmp('mig-sweep-data')
    const run = tmp('mig-sweep-run')
    writeFileSync(join(data, 'memory.json'), '{"m":1}', 'utf8')
    mkdirSync(join(data, 'cache', 'tts'), { recursive: true })
    writeFileSync(join(data, 'cache', 'tts', 'a.bin'), 'tts-cache', 'utf8')

    const oldSec = Date.now() / 1000 - 2 * 60 * 60      // 2 小时前
    const staleFile = join(run, 'memory.json.migrating-9999-deadbeef')
    writeFileSync(staleFile, '{"half', 'utf8')
    utimesSync(staleFile, oldSec, oldSec)
    const staleDir = join(run, 'cache.migrating-9999-deadbee1')
    mkdirSync(staleDir, { recursive: true })
    writeFileSync(join(staleDir, 'partial.bin'), 'p', 'utf8')
    utimesSync(staleDir, oldSec, oldSec)
    // 刚刚创建的：可能是另一个实例正在拷（主实例 + 临时 3099 实例共用运行目录），不能删
    const freshFile = join(run, 'state.json.migrating-9999-cafebabe')
    writeFileSync(freshFile, '{"in-flight"', 'utf8')

    const cap = captureConsole()
    M.migrateRuntimeData(data, run)
    cap.restore()

    ok('崩溃残留：>1 小时的 .migrating-* 文件被清掉', !existsSync(staleFile))
    ok('崩溃残留：>1 小时的 .migrating-* 临时目录被整棵清掉', !existsSync(staleDir))
    ok('在途保护：刚创建的 .migrating-* 不动（另一实例可能正在拷）', existsSync(freshFile))
    ok('清理有日志可排障（含数量）', cap.has('崩溃残留'), cap.text().slice(0, 200))
    ok('清理不误伤迁移：文件与缓存目录都到位',
      readFileSync(join(run, 'memory.json'), 'utf8') === '{"m":1}' &&
      readFileSync(join(run, 'cache', 'tts', 'a.bin'), 'utf8') === 'tts-cache')
    ok('清理后只剩那个在途临时文件',
      migratingLeftovers(run).length === 1 && migratingLeftovers(run)[0] === 'state.json.migrating-9999-cafebabe',
      migratingLeftovers(run).join(','))

    const after = entries(run)
    const cap2 = captureConsole()
    M.migrateRuntimeData(data, run)
    cap2.restore()
    ok('清理是幂等的：第二次运行目录条目集合不变',
      JSON.stringify(entries(run)) === JSON.stringify(after), entries(run).join(','))
    ok('清理是幂等的：第二次不再打印日志', cap2.logs.length === 0, cap2.text().slice(0, 200))
  }

  // ================= 3. POSIX 建目录 0700（注入 platform），Windows 忽略但不报错 =================
  console.log('\n[3] 建运行目录：POSIX 即 0700；Windows 忽略权限且不报错')
  {
    const data = tmp('mig-perm-data')
    writeFileSync(join(data, 'memory.json'), '{"m":1}', 'utf8')

    // 3.1 / 3.2 注入 platform='linux'（Windows 本机也能验证 POSIX 分支的调用口径）
    const run = tmp('mig-perm-run')
    const mkdirCalls = []
    const chmodCalls = []
    let threwPosix = false
    const capP = captureConsole()
    try {
      M.migrateRuntimeData(data, run, {
        platform: 'linux',
        mkdir: (dir, opts) => { mkdirCalls.push({ dir, opts }); mkdirSync(dir, { recursive: true }) },
        chmod: (dir, mode) => { chmodCalls.push({ dir, mode }) },
      })
    } catch { threwPosix = true }
    capP.restore()
    ok('POSIX：建运行目录带 mode=0o700（旧实现递归建目录默认 0755，靠 store 事后收紧）',
      !threwPosix && mkdirCalls.length >= 1 && mkdirCalls[0].opts &&
      mkdirCalls[0].opts.recursive === true && mkdirCalls[0].opts.mode === 0o700,
      JSON.stringify(mkdirCalls[0] && mkdirCalls[0].opts))
    ok('POSIX：再 chmod 0700 收紧已存在的旧目录',
      chmodCalls.length === 1 && chmodCalls[0].mode === 0o700, JSON.stringify(chmodCalls))
    ok('POSIX：注入路径下迁移照常完成', readFileSync(join(run, 'memory.json'), 'utf8') === '{"m":1}')

    // 3.3 注入 platform='win32'：不 chmod、不因权限报错
    const run2 = tmp('mig-perm-win')
    const chmodWin = []
    let threwWin = false
    const capW = captureConsole()
    try {
      M.migrateRuntimeData(data, run2, {
        platform: 'win32',
        mkdir: (dir) => { mkdirSync(dir, { recursive: true }) },
        chmod: (_dir, mode) => { chmodWin.push(mode) },
      })
    } catch { threwWin = true }
    capW.restore()
    ok('Windows：不尝试 chmod（没有权限位语义）', !threwWin && chmodWin.length === 0, chmodWin.join(','))
    ok('Windows：迁移照常完成', readFileSync(join(run2, 'memory.json'), 'utf8') === '{"m":1}')

    // 3.4 真实平台（本机 Windows）：不抛、目录真的建出来（含多级）
    const run3 = join(tmp('mig-perm-real'), 'nested', 'runtime')
    let threwReal = false
    const capR = captureConsole()
    try { M.migrateRuntimeData(data, run3) } catch { threwReal = true }
    capR.restore()
    ok('真实平台（无注入）：不抛、多级目录真的建出来',
      !threwReal && readFileSync(join(run3, 'memory.json'), 'utf8') === '{"m":1}')

    // 3.5 源码核对：不许再出现「裸 recursive: true」的 mkdir（那就是 0755 的来源）
    const src = readFileSync(join(process.cwd(), 'src', 'host', 'migrate.ts'), 'utf8')
    ok('源码：建目录调用带 mode: 0o700',
      /\{\s*recursive:\s*true,\s*mode:\s*0o700\s*\}/.test(src))
    ok('源码：有一道 chmod 0o700（收紧升级前就存在的旧目录）', /chmod\([^)]*0o700\)/.test(src))

    // 3.6 运行目录位置被文件占住（环境异常）：不抛、也不能去 chmod 那个文件
    const blockerRoot = tmp('mig-perm-blocker')
    const blocker = join(blockerRoot, 'blocked')
    writeFileSync(blocker, 'x', 'utf8')
    const chmodBlocker = []
    let threwBlocker = false
    const capB = captureConsole()
    try {
      M.migrateRuntimeData(data, blocker, {
        platform: 'linux',
        chmod: (_dir, mode) => { chmodBlocker.push(mode) },
      })
    } catch { threwBlocker = true }
    capB.restore()
    ok('运行目录被文件占住：不抛、不 chmod 那个文件、文件内容不变',
      !threwBlocker && chmodBlocker.length === 0 && readOr(blocker) === 'x', chmodBlocker.join(','))
  }

  // ================= 4. 名单收敛：store 一份真源，migrate 与 harden 都读它 =================
  console.log('\n[4] 运行数据名单收敛（store 单一真源）')
  {
    ok('store 导出运行数据全名单（内部层用，不改对外接口）',
      Array.isArray(S.RUNTIME_DATA_FILES), typeof S.RUNTIME_DATA_FILES)
    const got = Array.isArray(S.RUNTIME_DATA_FILES) ? [...S.RUNTIME_DATA_FILES].sort() : []
    ok('名单 = 11 项（migrate 9 ∪ store 11 ∪ auto-backup 9 的并集）', got.length === 11, got.join(','))
    ok('名单含 culture-seen.json / poem-seen.json（POSIX 不能留 0644）',
      got.indexOf('culture-seen.json') >= 0 && got.indexOf('poem-seen.json') >= 0)
    ok('名单含 personality.json / prefs.json（旧 migrate 只有 9 项，这两份会漏搬）',
      got.indexOf('personality.json') >= 0 && got.indexOf('prefs.json') >= 0)
    ok('名单与预期逐项一致（没有多余项）',
      JSON.stringify(got) === JSON.stringify([...ALL_FILES].sort()), got.join(','))

    // migrate 真的按同一份名单搬全部 11 项
    const data = tmp('mig-list-data')
    const run = tmp('mig-list-run')
    for (const f of ALL_FILES) writeFileSync(join(data, f), JSON.stringify({ file: f }), 'utf8')
    const cap = captureConsole()
    M.migrateRuntimeData(data, run)
    cap.restore()
    const missing = ALL_FILES.filter((f) => {
      try { return readFileSync(join(run, f), 'utf8') !== JSON.stringify({ file: f }) } catch { return true }
    })
    ok('migrate 按同一份名单搬全部 11 项（不再只有 9 项）', missing.length === 0, missing.join(','))
    ok('名单收敛后仍然不留 .migrating-* 残留', migratingLeftovers(run).length === 0, migratingLeftovers(run).join(','))

    // 缺文件不算错误：只搬存在的
    const data2 = tmp('mig-list-few')
    const run2 = tmp('mig-list-few-run')
    const few = ['memory.json', 'culture-seen.json', 'poem-seen.json', 'prefs.json']
    for (const f of few) writeFileSync(join(data2, f), '{"x":1}', 'utf8')
    let threw = false
    const capFew = captureConsole()
    try { M.migrateRuntimeData(data2, run2) } catch { threw = true }
    capFew.restore()
    ok('缺文件不算错误：只搬存在的 4 项、不抛',
      !threw && JSON.stringify(entries(run2)) === JSON.stringify([...few].sort()), entries(run2).join(','))
    let storeThrew = false
    try { S.createStore(run2) } catch { storeThrew = true }
    ok('createStore（hardenRuntimeDir）：名单里缺文件不抛', !storeThrew)

    // 源码：唯一真源，且没有第二份硬编码名单
    const mig = readFileSync(join(process.cwd(), 'src', 'host', 'migrate.ts'), 'utf8')
    ok('源码：migrate 从 store 读同一份名单',
      /import\s*\{[^}]*RUNTIME_DATA_FILES[^}]*\}\s*from\s*'\.\/store\.js'/.test(mig))
    ok('源码：migrate 不再自带 MIGRATED_FILES 名单', !/MIGRATED_FILES/.test(mig))
    const st = readFileSync(join(process.cwd(), 'src', 'host', 'store.ts'), 'utf8')
    ok('源码：hardenRuntimeDir 遍历同一份名单', /function hardenRuntimeDir[\s\S]{0,800}RUNTIME_DATA_FILES/.test(st))
    ok('源码：旧的 PRIVATE_DATA_FILES 名字已收敛（不留两份表）', !/PRIVATE_DATA_FILES/.test(st))
  }

  // ================= 5. 回归：正常路径两跑一致、无残留、源保留 =================
  console.log('\n[5] 回归：正常迁移两跑一致、无残留、源文件保留')
  {
    const data = tmp('mig-normal-data')
    const run = tmp('mig-normal-run')
    const PKG = '{"history":[{"role":"user","content":"hi"}],"summary":""}'
    for (const f of ALL_FILES) writeFileSync(join(data, f), PKG, 'utf8')
    mkdirSync(join(data, 'cache', 'tts'), { recursive: true })
    writeFileSync(join(data, 'cache', 'tts', 'a.bin'), 'tts-cache', 'utf8')

    const cap = captureConsole()
    M.migrateRuntimeData(data, run)
    cap.restore()
    const afterFirst = entries(run)
    ok('正常迁移：11 份数据 + cache/ 全部到位',
      ALL_FILES.every((f) => readOr(join(run, f)) === PKG) && existsSync(join(run, 'cache', 'tts', 'a.bin')))
    ok('正常迁移：不留 .migrating-* 残留', migratingLeftovers(run).length === 0, migratingLeftovers(run).join(','))
    ok('正常迁移：源文件保留、字节不变', ALL_FILES.every((f) => readOr(join(data, f)) === PKG))

    const cap2 = captureConsole()
    M.migrateRuntimeData(data, run)
    cap2.restore()
    ok('正常迁移幂等：第二次目录条目集合不变',
      JSON.stringify(entries(run)) === JSON.stringify(afterFirst), entries(run).join(','))
    ok('正常迁移幂等：第二次不打印日志', cap2.logs.length === 0, cap2.text().slice(0, 200))
  }
} catch (err) {
  fail++
  console.log('\n  ❌ 未捕获异常：' + String((err && err.stack) || err))
} finally {
  cleanup()
}

console.log('\n通过 ' + pass + ' 项 / 失败 ' + fail + ' 项')
if (fail > 0) {
  console.log('❌ 有断言失败')
  process.exit(1)
}
console.log('✅ 全部通过')
