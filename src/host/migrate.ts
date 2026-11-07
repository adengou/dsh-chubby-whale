/**
 * host/migrate.ts —— 运行数据迁移（插件 data/ → 运行时目录）
 *
 * 只在目标不存在时拷贝，绝不覆盖用户现有数据；失败静默（环境差异）。
 * 从 index.ts 抽出：架构宪章要求 index 只做组装。
 *
 * 2026-11-07（B74）加固，两处都是“半途失败留下坏状态”的坑：
 *   · 先拷到同目录唯一临时名，再原子改名到位：copyFileSync 写到一半失败（磁盘满 / 进程被杀）
 *     不会在目标位置留半截文件。旧实现直接写目标，半截文件还能被解析成坏 JSON；
 *     更糟的是下次启动会因「目标已存在」把它永久当成“已迁移”，再也不会重试。
 *   · 落地用 link 优先、rename 兜底：link 天然 EEXIST，两个实例（主实例与临时 3099 实例）
 *     共用同一个运行目录时，不会把对方刚写出的新数据用插件包里的旧副本盖掉。
 *     link 不可用（跨卷 / FAT / exFAT）时退回“先查存在再改名”，只保留极小的竞态窗口。
 *   · 缓存目录整目录迁移同样走临时目录 + 改名。
 *
 * 2026-11-07（B105）补四处（B100 配置分身审计有证据）：
 *   · 「已迁移」不能只看 existsSync：pre-B74 的实现直接写目标位置，进程被杀会留下 **0 字节**的
 *     dst（`copyFileSync` 先创建空文件再灌内容）。existsSync 让它被永久当成“已迁移”，插件包里的
 *     旧数据再也搬不过去。现在把「存在但 0 字节的普通文件」视为上次崩溃的半成品：先把原文件改名成
 *     `<名>.empty-<时间戳>.bak` 留证，再落新文件（同一次运行里先拷贝成功、才动原文件，拷贝失败则
 *     一切原样，下次启动还能重试）。只认 0 字节：**有内容**的目标仍绝不覆盖——半截 JSON 与被用户
 *     改过的数据在文件层无法区分，宁可保持现状也不赌一把（残余风险见交付说明）。
 *   · 崩溃遗留的 `.migrating-*` 临时文件/目录以前没人清（正常与异常路径都会 discard，但进程被强杀
 *     /断电时没人执行）。现在按 mtime（> 1 小时）清运行目录第一层：一次拷贝是毫秒级，一小时前
 *     只可能是崩溃遗留；主实例与临时实例共用运行目录时，不会删掉对方在途的拷贝。
 *     阈值与 host/store.ts 的 .tmp 清扫同口径。
 *   · 建运行目录以前是裸 mkdirSync（POSIX 首建 0755，要靠 createStore 事后收紧，中间有个窗口）。
 *     现在建目录即 0700，并对已存在的旧目录再 chmod 一次；Windows 忽略 mode、没有权限位语义，
 *     跳过 chmod 且不报错。
 *   · 数据名单不再各写一份：本文件改从 host/store.ts 的「运行数据全名单」（RUNTIME_DATA_FILES）
 *     读，与 store 的 hardenRuntimeDir 用同一份表，缺文件不算错误。历史口径 migrate(9) /
 *     store(11) / auto-backup(9) 三份不一致，personality.json 与 prefs.json 从没被迁移过。
 *
 * 幂等：同一组输入连续跑两次，目录条目、文件内容、日志都一致（0 字节修复只做一次、残留只清一次、
 * 目标有内容就整体跳过）。0 字节的**源**不迁移：空 JSON 没有可读内容，硬搬到 0 字节目标上只会
 * 让「修复—再修复」每次启动都多出一个 .bak，破坏幂等。
 */
import {
  chmodSync, copyFileSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync,
} from 'node:fs'
import { join } from 'node:path'
import { isPosixModePlatform } from './atomic.js'
import { RUNTIME_DATA_FILES } from './store.js'

/** 迁移 I/O（只给测试注入用；默认走 node:fs） */
type MigrateIo = {
  copyFile?: (src: string, dst: string) => void
  copyDir?: (src: string, dst: string) => void
  /** 平台注入（默认 process.platform）：Windows 上也能验证 POSIX 的 0700 分支 */
  platform?: string
  /** 建目录注入（默认 mkdirSync）：用来断言调用参数带 mode=0o700 */
  mkdir?: (dir: string, opts: { recursive: true; mode: number }) => void
  /** chmod 注入（默认 chmodSync）：只在 POSIX 语义下调用 */
  chmod?: (dir: string, mode: number) => void
}

/** 崩溃残留迁移临时名的判定门槛：一小时前的 `.migrating-*` 只可能是崩溃遗留（一次拷贝是毫秒级） */
const STALE_MIGRATING_MS = 60 * 60 * 1000
/** 单次清扫上限：坏成一片时也别把启动卡成一次全目录删除 */
const STALE_MIGRATING_MAX = 200

/** 本模块的临时名形状（与 tempNameFor 成对）：`<目标名>.migrating-<pid>-<随机串>`，临时文件与临时目录同名规则 */
const MIGRATING_NAME_RE = /\.migrating-\d+-[a-z0-9]*$/

/** 临时名：与目标同目录（保证 rename 不跨卷），进程 + 随机串保证并发实例不撞名 */
function tempNameFor(dst: string): string {
  return dst + '.migrating-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
}

function discard(path: string): void {
  try { rmSync(path, { recursive: true, force: true }) } catch { }
}

/**
 * 建运行目录：POSIX 首建即 0700；已存在的旧目录再 chmod 一次收紧。
 * Windows 忽略 mkdir 的 mode、也没有权限位语义：跳过 chmod，不因权限报错（失败一律静默）。
 */
function ensureRuntimeDir(dir: string, io: MigrateIo): void {
  const mkdir = io.mkdir || ((d: string, opts: { recursive: true; mode: number }) => { mkdirSync(d, opts) })
  try { mkdir(dir, { recursive: true, mode: 0o700 }) } catch { }
  if (!isPosixModePlatform(io.platform || process.platform)) return
  // 只有「真的是目录」才 chmod：路径被文件占住时（环境异常）不能去改那个文件的权限
  try { if (!statSync(dir).isDirectory()) return } catch { return }
  const chmod = io.chmod || ((d: string, mode: number) => { chmodSync(d, mode) })
  try { chmod(dir, 0o700) } catch { }
}

/**
 * 清掉崩溃遗留的 `.migrating-*`（临时文件与临时目录）。
 *
 * 为什么需要：正常/异常路径都会 discard，但**进程被强杀 / 断电**时没人执行清理分支，残留会一直
 * 躺在运行目录里。它不影响读取（数据文件名不带 .migrating 段），只会让目录越来越脏、排障时
 * 被当成“未完成的迁移”。
 *
 * 保守：只看运行目录第一层（迁移临时名都与目标同目录，目标全在第一层）、只认本模块的命名、
 * 只删 mtime 早于一小时的（另一个实例在途的拷贝不会活过一秒）、最多删 STALE_MIGRATING_MAX 个、
 * 失败静默。返回删掉的个数（0 表示没有残留）。
 */
function sweepStaleMigrating(dir: string): number {
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return 0 }
  const now = Date.now()
  let removed = 0
  for (const name of names) {
    if (removed >= STALE_MIGRATING_MAX) break
    if (!MIGRATING_NAME_RE.test(name)) continue
    const full = join(dir, name)
    try {
      const st = lstatSync(full)
      const mtime = Number(st.mtimeMs)
      // mtime 异常（NaN）时保守不删：宁留垃圾，不删可能还想用的东西
      if (!Number.isFinite(mtime)) continue
      if (now - mtime <= STALE_MIGRATING_MS) continue
      rmSync(full, { recursive: true, force: true })
      removed++
    } catch { }
  }
  if (removed > 0) console.log('[chubby-whale] 已清理崩溃残留的迁移临时文件 ' + removed + ' 个：' + dir)
  return removed
}

/**
 * 目标位现在能不能写：
 *   · 不存在（含父路径不存在 / 不是目录）→ 能；
 *   · 存在但是 **0 字节普通文件** → 能（上次崩溃留下的半成品，先留证再覆盖）；
 *   · 其它（有内容 / 目录 / 符号链接 / stat 失败）→ 不能，绝不覆盖用户数据。
 *
 * 用 lstat 不跟随符号链接：链接本身不是本模块写出来的东西，别跟着它去判断。
 */
function isReplaceableDst(dst: string): boolean {
  let st: any
  try {
    st = lstatSync(dst)
  } catch (err: any) {
    return Boolean(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'))
  }
  return st.isFile() && st.size === 0
}

/**
 * 把 0 字节半成品改名留证：`<名>.empty-<时间戳>.bak`（时间戳与 atomic.ts 的 .bad-<时间戳>
 * 同口径：ISO 串里的 `:` `.` 换成 `-`，三平台都能建）。先复查一次「仍是 0 字节普通文件」——
 * 抢占前尺寸变了就说明它已经是有用的数据，放弃并把控制权交回调用方（不覆盖）。
 * 同一毫秒撞名（连续两次修复）时退一步加 pid。返回是否成功留证。
 */
function parkEmptyDst(dst: string): boolean {
  try {
    const st = lstatSync(dst)
    if (!st.isFile() || st.size !== 0) return false
  } catch {
    return false
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const first = dst + '.empty-' + stamp + '.bak'
  try {
    renameSync(dst, first)
    console.log('[chubby-whale] 目标为 0 字节半成品（上次崩溃遗留），已改名留证：' + first)
    return true
  } catch { }
  const second = dst + '.empty-' + stamp + '-' + process.pid + '.bak'
  try {
    renameSync(dst, second)
    console.log('[chubby-whale] 目标为 0 字节半成品（上次崩溃遗留），已改名留证：' + second)
    return true
  } catch {
    return false
  }
}

/**
 * 抢占目标位（此时源已拷贝成功、临时文件已就绪）：
 *   · 目标不存在 → true（直接用临时文件落位）
 *   · 目标 0 字节 → 改名留证后 true
 *   · 其它 → false（绝不覆盖，调用方丢掉临时文件）
 * 两个实例同时修复同一个 0 字节文件时，只有一个能 rename 成功，另一个返回 false。
 */
function claimDst(dst: string): boolean {
  if (!isReplaceableDst(dst)) return false
  let exists = false
  try { lstatSync(dst); exists = true } catch { }
  if (!exists) return true
  return parkEmptyDst(dst)
}

/**
 * 把临时副本原子落到目标位置；目标已存在时返回 false（绝不覆盖用户数据）。
 * 成功/失败都不会留下临时名：link 成功后临时名只是第二个硬链接，删掉目录项即可。
 */
function placeIfAbsent(tmp: string, dst: string): boolean {
  try {
    linkSync(tmp, dst)
    discard(tmp)
    return true
  } catch (err: any) {
    if (err && err.code === 'EEXIST') {
      discard(tmp)
      return false
    }
  }
  // 目录不支持 link，部分文件系统（FAT/exFAT/跨卷）也不支持：退回“先查存在再改名”
  if (existsSync(dst)) {
    discard(tmp)
    return false
  }
  renameSync(tmp, dst)
  return true
}

/** 源文件值不值得搬：0 字节的源没有迁移价值（空 JSON 读不出来，硬搬还会让 0 字节修复反复发生） */
function shouldCopySource(src: string): boolean {
  let st: any
  try { st = lstatSync(src) } catch { return false }
  // 非普通文件（符号链接等）保持旧的「存在就拷」行为：真正的失败由拷贝路径兜底
  if (!st.isFile()) return true
  return st.size > 0
}

/**
 * 单个文件迁移：源存在且目标可写（不存在 / 0 字节半成品）才动手；
 * 任何失败都只清临时文件，不抛给插件加载。
 */
function migrateFile(src: string, dst: string, copyFile: (src: string, dst: string) => void, label: string): void {
  try {
    if (!shouldCopySource(src) || !isReplaceableDst(dst)) return
    const tmp = tempNameFor(dst)
    try {
      // 顺序不能反：先拷贝成功，再动原文件。拷贝失败时 0 字节原文件还在，下次启动还能重试。
      copyFile(src, tmp)
      if (!claimDst(dst)) { discard(tmp); return }
      if (placeIfAbsent(tmp, dst)) console.log('[chubby-whale] 迁移运行数据 ' + label + ' → ' + dst)
    } catch {
      discard(tmp)
    }
  } catch { }
}

/** 缓存目录迁移：与文件同一套「临时 + 原子落地」，部分拷贝不会留在 cache/ 里；0 字节占位文件同样先留证 */
function migrateDir(src: string, dst: string, copyDir: (src: string, dst: string) => void, label: string): void {
  try {
    if (!existsSync(src) || !isReplaceableDst(dst)) return
    const tmp = tempNameFor(dst)
    try {
      copyDir(src, tmp)
      if (!claimDst(dst)) { discard(tmp); return }
      if (placeIfAbsent(tmp, dst)) console.log('[chubby-whale] ' + label + ' → ' + dst)
    } catch {
      discard(tmp)
    }
  } catch { }
}

export function migrateRuntimeData(dataDir: string, runtimeDir: string, io?: MigrateIo): void {
  const opts: MigrateIo = io || {}
  const copyFile = opts.copyFile || copyFileSync
  const copyDir = opts.copyDir || ((src: string, dst: string) => cpSync(src, dst, { recursive: true }))
  ensureRuntimeDir(runtimeDir, opts)
  sweepStaleMigrating(runtimeDir)   // 先清上次崩溃的残骸，再做本次迁移
  // 名单唯一真源在 host/store.ts（与 hardenRuntimeDir 同一份），这里不另写一份
  for (const f of RUNTIME_DATA_FILES) migrateFile(join(dataDir, f), join(runtimeDir, f), copyFile, f)
  migrateDir(join(dataDir, 'cache'), join(runtimeDir, 'cache'), copyDir, '迁移缓存')
}
