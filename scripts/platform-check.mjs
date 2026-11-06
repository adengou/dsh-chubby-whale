/**
 * scripts/platform-check.mjs —— 三平台可运行性检查（静态扫描 + 纯逻辑模拟，不启动服务、不联网）
 *
 * 背景：插件要同时在 Windows / Linux / macOS 上跑，平台相关代码（python 解释器链、
 * 主目录、chmod、BOM 容错）散在 host 层，靠人工看容易漏。这里把它变成可执行检查：
 *
 *   [1] 平台绑定扫描（src/**）：硬编码 Windows 路径、process.platform 分支兜底、
 *       spawn 是否用 shell 字符串拼接、fs 路径是否走 join；
 *   [2] Python 解释器候选链：用 esbuild 把 src/host/tts/python.ts 转成 CJS 后在
 *       沙箱里执行，模拟 win32 / linux / darwin，打印真实候选顺序并与文档矩阵对照；
 *   [3] 运行目录：断言 ~/.dsh-chubby-whale 来自 homedir()，并用 path.posix / path.win32
 *       模拟两边 join 结果；
 *   [4] 权限分支：模拟两个平台，断言 chmod 只在非 win32 执行（spy 记录调用与 mode）；
 *   [5] BOM 容错：对 stripBom / readTextNoBom 做纯函数断言（含 U+FEFF 前缀、纯 BOM 文件）；
 *   [6] 诗名索引路径：client seedFromDisk 从 cwd 向上找 data/poem-titles.json（最多 4 层，
 *       用系统临时目录模拟 cwd 在子目录），host 路由缺省 dataDir = join(process.cwd(), 'data')；
 *   [7] Node 版本：package.json engines.node 必须 >=22.3（seedFromDisk 依赖 process.getBuiltinModule）。
 *
 * 设计约束：
 *   · 只读 src；临时目录沙箱建在 os.tmpdir() 下，用完即删，不碰项目文件；
 *     不启动 HTTP/子进程（spawn 只是被扫描，不会真执行）；
 *   · TS 源码加载走 esbuild transform + new Function 沙箱，不依赖 dist、不依赖当前平台；
 *   · 断言以「源码真实实现」为准：实现与文档矩阵不一致只报 ⚠️ 并打印实际顺序，不判失败。
 *
 * 用法：node scripts/platform-check.mjs
 * 退出码：0=通过（允许 ⚠️）；1=有 ❌（违规或断言失败）
 */

import * as nodeFs from 'node:fs'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')

// ---------------------------------------------------------------------------
// esbuild（devDependency，项目构建已依赖它）——用于把 TS 源码转成可在沙箱执行的 CJS
// ---------------------------------------------------------------------------
let transformSync = null
let loadError = ''
try {
  ({ transformSync } = await import('esbuild'))
} catch (e) {
  loadError = String((e && e.message) || e)
}

// ---------------------------------------------------------------------------
// 结果计数与输出
// ---------------------------------------------------------------------------
let passed = 0
let warned = 0
let failed = 0
const I = '  '

function ok(title, extra = '') {
  passed++
  console.log(I + '✅ ' + title + (extra ? '  ' + extra : ''))
}
function warn(title, extra = '') {
  warned++
  console.log(I + '⚠️ ' + title + (extra ? '  ' + extra : ''))
}
function bad(title, extra = '') {
  failed++
  console.log(I + '❌ ' + title + (extra ? '  ' + extra : ''))
}
function note(text) {
  console.log(I + '   ' + text)
}
function section(n, title) {
  console.log('\n[' + n + '] ' + title)
}

// ---------------------------------------------------------------------------
// 基础工具：遍历、源码去注释、括号匹配、行号
// ---------------------------------------------------------------------------

/** 收集 src/** 下的 .ts（含 .d.ts），返回 { rel, text } */
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full))
    else if (name.endsWith('.ts')) out.push({ rel: relative(ROOT, full).replace(/\\/g, '/'), text: readFileSync(full, 'utf8') })
  }
  return out
}

/**
 * 去掉 // 与 /* *\/ 注释，保留字符串内容与换行（行号不变）。
 * 字符串里的 // 不会被误当注释——这是后续扫描不误报的前提。
 */
function stripComments(src) {
  let out = ''
  let i = 0
  let state = 'code' // code | line | block | str
  let quote = ''
  while (i < src.length) {
    const c = src[i]
    const d = src[i + 1]
    if (state === 'code') {
      if (c === '/' && d === '/') { out += '  '; i += 2; state = 'line'; continue }
      if (c === '/' && d === '*') { out += '  '; i += 2; state = 'block'; continue }
      if (c === "'" || c === '"' || c === '`') { state = 'str'; quote = c; out += c; i++; continue }
      out += c; i++; continue
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; i++; continue }
      out += c === '\r' ? '\r' : ' '; i++; continue
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { out += '  '; i += 2; state = 'code'; continue }
      out += c === '\n' || c === '\r' ? c : ' '; i++; continue
    }
    // str
    if (c === '\\') { out += c + (d === undefined ? '' : d); i += 2; continue }
    if (c === quote) { state = 'code'; out += c; i++; continue }
    out += c; i++
  }
  return out
}

/** 从字符串起始引号 i 跳到结束引号之后（跳过转义） */
function skipString(text, i) {
  const q = text[i]
  let j = i + 1
  while (j < text.length) {
    if (text[j] === '\\') { j += 2; continue }
    if (text[j] === q) return j + 1
    j++
  }
  return text.length
}

/** 括号/花括号配对：open 处是 ( 或 {，返回配对的闭括号下标 */
function matchPair(code, open) {
  const openCh = code[open]
  const closeCh = openCh === '(' ? ')' : '}'
  let depth = 0
  for (let i = open; i < code.length; i++) {
    const c = code[i]
    if (c === "'" || c === '"' || c === '`') { i = skipString(code, i) - 1; continue }
    if (c === openCh) depth++
    else if (c === closeCh) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** 顶层逗号拆分（跳过字符串与嵌套括号） */
function splitTopLevel(text) {
  const parts = []
  let start = 0
  let depth = 0
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === "'" || c === '"' || c === '`') { i = skipString(text, i); continue }
    if (c === '(' || c === '[' || c === '{') { depth++; i++; continue }
    if (c === ')' || c === ']' || c === '}') { depth--; i++; continue }
    if (c === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; i++; continue }
    i++
  }
  parts.push(text.slice(start))
  return parts
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length
}

function esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function nextNonSpace(code, i) {
  while (i < code.length && /\s/.test(code[i])) i++
  return i
}

// ---------------------------------------------------------------------------
// [1] 平台绑定扫描规则
// ---------------------------------------------------------------------------

/** 硬编码 Windows 盘符路径、UNC 路径、反斜杠字符串拼接 */
function findWindowsPathIssues(code) {
  const out = []
  const lineText = (idx) => {
    const s = code.lastIndexOf('\n', idx) + 1
    const e = code.indexOf('\n', idx)
    return code.slice(s, e === -1 ? code.length : e).trim().slice(0, 90)
  }

  // 盘符路径：C:\ 或 C:/（排除 https:// 这类协议里的 s:/ —— 要求盘符前不是字母数字）
  const driveRe = /(?<![A-Za-z0-9_$])[A-Za-z]:[\\/]/g
  let m
  while ((m = driveRe.exec(code))) {
    out.push({ index: m.index, note: '硬编码 Windows 盘符路径：' + lineText(m.index) })
  }

  // UNC 路径：源码字符串里连续 4 个反斜杠且后面跟主机名/共享名（\\\\server\\share）
  const bs4 = '\\'.repeat(4)
  for (let i = code.indexOf(bs4); i !== -1; i = code.indexOf(bs4, i + 1)) {
    if (/[A-Za-z0-9_.$-]/.test(code[i + 4] || '')) {
      out.push({ index: i, note: '硬编码 UNC / 反斜杠路径：' + lineText(i) })
    }
  }

  // 反斜杠字面量参与拼接：`x + '\\' + y` / `'\\' + y`
  const concatRe = /(['"])\\{1,2}\1\s*\+|\+\s*(['"])\\{1,2}\2/g
  while ((m = concatRe.exec(code))) {
    out.push({ index: m.index, note: '用反斜杠字面量拼路径，应使用 path.join：' + lineText(m.index) })
  }
  return out
}

/** 判断 process.platform 所在分支是否有兜底：默认参数 / 提前返回 / else / 三元 */
function findPlatformBranches(code) {
  const out = []
  const re = /process\.platform/g
  let m
  while ((m = re.exec(code))) {
    const idx = m.index
    const lineStart = code.lastIndexOf('\n', idx) + 1
    const lineEnd = code.indexOf('\n', idx)
    const line = code.slice(lineStart, lineEnd === -1 ? code.length : lineEnd)
    const before = code.slice(lineStart, idx)
    const local = idx - lineStart
    out.push(
      classifyPlatformSite(code, idx, line, before, local),
    )
  }
  return out
}

function classifyPlatformSite(code, idx, line, before, local) {
  // 三元：? 与 : 都在后面
  const q = line.indexOf('?', local)
  const colon = line.indexOf(':', local)
  if (q !== -1 && colon !== -1 && q < colon) {
    return { index: idx, line, kind: 'ternary', note: '三元表达式（含 else 分支）' }
  }
  // 函数默认参数：`platform: string = process.platform`
  if (/[A-Za-z_$][\w$]*\s*:\s*[^=;{}]+=\s*$/.test(before)) {
    return { index: idx, line, kind: 'default-param', note: '函数默认参数（调用方可覆盖）' }
  }
  // if 条件
  const ifPos = findIfHead(before)
  if (ifPos !== -1) {
    const lineStart = Math.max(0, idx - before.length)
    const open = code.indexOf('(', lineStart + ifPos)
    if (open !== -1 && open < idx) {
      const close = matchPair(code, open)
      if (close > idx) {
        const j = nextNonSpace(code, close + 1)
        if (code[j] === '{') {
          const end = matchPair(code, j)
          if (end !== -1) {
            const body = code.slice(j + 1, end)
            if (/\b(?:return|throw)\b/.test(body)) {
              return { index: idx, line, kind: 'if-return', note: 'if 分支提前返回（有兜底）' }
            }
            const k = nextNonSpace(code, end + 1)
            if (code.startsWith('else', k)) {
              return { index: idx, line, kind: 'if-else', note: 'if/else 成对（有兜底）' }
            }
            return { index: idx, line, kind: 'if-no-fallback', note: 'if 分支后没有 else / 默认返回，非 Windows 平台行为未定义' }
          }
        }
        // 单行 if：看同一行条件之后有没有 return / throw
        const stmtEnd = code.indexOf('\n', close)
        const stmt = code.slice(close + 1, stmtEnd === -1 ? code.length : stmtEnd)
        if (/\b(?:return|throw)\b/.test(stmt)) {
          return { index: idx, line, kind: 'if-return', note: '单行 if 提前返回（有兜底）' }
        }
        return { index: idx, line, kind: 'if-single-no-return', note: '单行 if 没有 return/else，非 Windows 平台无兜底' }
      }
    }
  }
  return { index: idx, line, kind: 'expr', note: '不在 if 分支内，无法静态判断兜底' }
}

/** 在 process.platform 之前找最近的 if 头（同一行，且中间没有语句分隔符） */
function findIfHead(before) {
  for (let i = before.length - 2; i >= 0; i--) {
    if (!before.startsWith('if', i)) continue
    const prev = before[i - 1] || ''
    const next = before[i + 2] || ''
    if (/[\w$]/.test(prev) || !/[\s(]/.test(next)) continue
    const tail = before.slice(i + 2)
    if (/[;{}]/.test(tail)) return -1
    return i
  }
  return -1
}

/** spawn 是否用 shell 字符串拼接 / shell:true；返回调用数与问题 */
function findSpawnIssues(code) {
  const issues = []
  let calls = 0
  const re = /\bspawn\s*\(/g
  let m
  while ((m = re.exec(code))) {
    calls++
    const open = code.indexOf('(', m.index)
    const close = matchPair(code, open)
    if (close === -1) continue
    const call = code.slice(open + 1, close)
    if (/shell\s*:\s*true/.test(call)) {
      issues.push({ index: m.index, note: 'spawn 使用 shell: true，应直接传参数数组' })
    }
    const args = splitTopLevel(call)
    const first = (args[0] || '').trim()
    if (!first) continue
    if (/^`/.test(first) && /\$\{/.test(first)) {
      issues.push({ index: m.index, note: 'spawn 首参是模板字符串（shell 拼接），应拆成 cmd + args 数组' })
      continue
    }
    if (/(^|[^=!<>+\-*/])\+(?!=)/.test(first)) {
      issues.push({ index: m.index, note: 'spawn 首参是字符串拼接，应拆成 cmd + args 数组' })
      continue
    }
    if (/^['"`]/.test(first)) {
      const second = (args[1] || '').trim()
      const inner = first.slice(1, -1)
      if (!/^\[/.test(second) && /\s/.test(inner)) {
        issues.push({ index: m.index, note: 'spawn 用 shell 字符串（应传 cmd + args 数组）' })
      }
    }
  }
  return { calls, issues }
}

const FS_APIS = new Set([
  'readFileSync', 'readFile', 'writeFileSync', 'writeFile', 'appendFileSync', 'appendFile',
  'mkdirSync', 'mkdir', 'existsSync', 'exists', 'readdirSync', 'readdir',
  'renameSync', 'rename', 'unlinkSync', 'unlink', 'copyFileSync', 'copyFile',
  'cpSync', 'cp', 'statSync', 'stat', 'lstatSync', 'lstat', 'openSync', 'open',
  'opendirSync', 'opendir', 'rmSync', 'rm', 'accessSync', 'access',
])

/** 解析文件里从 node:fs 导入的函数名与命名空间 */
function fsBindings(code) {
  const names = new Set()
  const namespaces = new Set()
  const re = /import\s+([^'"]+?)\s+from\s+['"]node:fs(?:\/promises)?['"]/g
  let m
  while ((m = re.exec(code))) {
    const clause = m[1]
    const braces = clause.match(/\{([\s\S]*?)\}/)
    if (braces) {
      for (const part of braces[1].split(',')) {
        const n = part.trim().split(/\s+as\s+/).pop().trim()
        if (n) names.add(n)
      }
    }
    const ns = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/)
    if (ns) namespaces.add(ns[1])
    else if (/^\s*[A-Za-z_$][\w$]*\s*$/.test(clause)) namespaces.add(clause.trim())
  }
  return { names, namespaces }
}

/** 判断 fs 调用的路径参数是否绕过 join：返回 kind */
function classifyPathArg(arg, code) {
  const s = String(arg || '').trim()
  if (!s) return { kind: 'empty' }
  if (/^(?:\d+|0x[0-9a-f]+)$/i.test(s)) return { kind: 'fd' }
  if (/^(?:[A-Za-z_$][\w$]*\.)*(?:join|resolve|dirname|fileURLToPath)\s*\(/.test(s)) return { kind: 'join' }
  if (/^['"`]/.test(s)) {
    if (s.startsWith('`') && /\$\{/.test(s)) return { kind: 'template' }
    const inner = s.slice(1, -1)
    if (/[\\/]/.test(inner)) return { kind: 'literal-path' }
    return { kind: 'literal-file' }
  }
  if (/\$\{/.test(s)) return { kind: 'template' }
  const sepLiteral = /(['"`])[^'"`]*[\\/][^'"`]*\1/.test(s)
  if (sepLiteral && /(^|[^=!<>])\+(?!=)/.test(s)) return { kind: 'concat' }

  // 纯标识符：向同文件的一层定义追溯（file → join(...) 视为合规）
  const ident = s.match(/^([A-Za-z_$][\w$]*)$/)
  if (ident) {
    const defRe = new RegExp('(?:const|let|var)\\s+' + esc(ident[1]) + '\\s*(?::[^=]+)?=\\s*([^\\n;]+)')
    const d = code.match(defRe)
    if (d) {
      const rhs = d[1].trim()
      if (/^(?:[A-Za-z_$][\w$]*\.)*(?:join|resolve|dirname|fileURLToPath)\s*\(/.test(rhs)) return { kind: 'join' }
      if (/\$\{/.test(rhs)) return { kind: 'template' }
      if (/^['"`]/.test(rhs)) {
        const inner = rhs.slice(1, -1)
        if (/[\\/]/.test(inner)) return { kind: 'literal-path' }
      }
      if (/(['"`])[^'"`]*[\\/][^'"`]*\1/.test(rhs) && /(^|[^=!<>])\+(?!=)/.test(rhs)) return { kind: 'concat' }
    }
    return { kind: 'expr' }
  }
  return { kind: 'expr' }
}

/** 扫 fs 调用：字面量路径 / 模板拼接 / 字符串拼接（应走 join） */
function findFsPathIssues(code) {
  const bindings = fsBindings(code)
  const issues = []
  let calls = 0
  let joined = 0

  const scan = (re, nsName) => {
    let m
    while ((m = re.exec(code))) {
      calls++
      const open = code.indexOf('(', m.index + (nsName ? m[0].indexOf('.') + 1 : 0))
      const close = matchPair(code, open)
      if (close === -1) continue
      const arg = splitTopLevel(code.slice(open + 1, close))[0]
      const fn = nsName ? m[1] : m[0].slice(0, m[0].indexOf('(')).trim()
      const kind = classifyPathArg(arg, code).kind
      if (kind === 'join') { joined++; continue }
      if (kind === 'literal-path' || kind === 'concat' || kind === 'template') {
        issues.push({ index: m.index, note: 'fs 路径未走 join（' + fn + '）：' + String(arg || '').trim().slice(0, 80) })
      }
    }
  }

  for (const name of bindings.names) {
    scan(new RegExp('\\b' + esc(name) + '\\s*\\(', 'g'), false)
  }
  for (const ns of bindings.namespaces) {
    scan(new RegExp('\\b' + esc(ns) + '\\.([A-Za-z_$][\\w$]*)\\s*\\(', 'g'), true)
  }
  return { calls, joined, issues }
}

// ---------------------------------------------------------------------------
// TS 源码加载：esbuild 转 CJS，在 new Function 沙箱里执行（不碰真实 fs/子进程）
// ---------------------------------------------------------------------------
function loadTs(relFile, stubs, proc) {
  if (!transformSync) throw new Error('esbuild 不可用：' + loadError)
  const src = readFileSync(join(ROOT, relFile), 'utf8')
  const { code } = transformSync(src, { loader: 'ts', format: 'cjs', target: 'node22', platform: 'node' })
  const mod = { exports: {} }
  const req = (id) => {
    if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id]
    throw new Error('未提供 stub 模块：' + id)
  }
  // localStorage 显式传 undefined：client 模块里 `typeof localStorage === 'undefined'` 走降级分支，
  // 不受 Node 22+ 实验性全局 localStorage 影响（本检查不写任何浏览器缓存）
  const fn = new Function('require', 'module', 'exports', 'process', 'console', 'localStorage', code)
  fn(req, mod, mod.exports, proc, console, undefined)
  return mod.exports
}

/** 加载 atomic.ts，返回模块与 chmod 调用记录 */
function loadAtomic(platform, readText) {
  const chmods = []
  const fsStub = {
    mkdirSync() { },
    openSync() { return 3 },
    writeFileSync() { },
    fsyncSync() { },
    closeSync() { },
    renameSync() { },
    unlinkSync() { },
    existsSync() { return true },
    chmodSync(file, mode) { chmods.push({ file: String(file), mode: Number(mode) }) },
    readFileSync() { return readText },
  }
  const mod = loadTs(
    'src/host/atomic.ts',
    { 'node:fs': fsStub, 'node:path': path },
    { platform, pid: 4242, env: {} },
  )
  return { mod, chmods }
}

// ---------------------------------------------------------------------------
// [1] 平台绑定扫描
// ---------------------------------------------------------------------------
function checkBindings(files) {
  section(1, '平台绑定扫描（src/**，' + files.length + ' 个 .ts）')

  const groups = {
    winPath: [],
    platform: [],
    spawn: [],
    fsPath: [],
  }
  let branchCount = 0
  let looseBranches = []
  let spawnCalls = 0
  let fsCalls = 0
  let fsJoined = 0

  for (const f of files) {
    const code = stripComments(f.text)
    const add = (group, hit) => {
      groups[group].push({ rel: f.rel, line: lineOf(code, hit.index), note: hit.note })
    }
    for (const hit of findWindowsPathIssues(code)) add('winPath', hit)
    const branches = findPlatformBranches(code)
    branchCount += branches.length
    for (const b of branches) {
      if (b.kind === 'if-no-fallback' || b.kind === 'if-single-no-return') add('platform', b)
      else if (b.kind === 'expr') looseBranches.push({ rel: f.rel, line: lineOf(code, b.index) })
    }
    const sp = findSpawnIssues(code)
    spawnCalls += sp.calls
    for (const hit of sp.issues) add('spawn', hit)
    const fs = findFsPathIssues(code)
    fsCalls += fs.calls
    fsJoined += fs.joined
    for (const hit of fs.issues) add('fsPath', hit)
  }

  const report = (title, list, okDetail) => {
    if (list.length === 0) { ok(title, okDetail); return }
    bad(title + '：' + list.length + ' 处')
    for (const v of list.slice(0, 12)) note(v.rel + ':' + v.line + '  ' + v.note)
    if (list.length > 12) note('…另有 ' + (list.length - 12) + ' 处')
  }

  report('硬编码 Windows 路径 / UNC / 反斜杠拼接', groups.winPath, '0 处')
  report(
    'process.platform 分支兜底',
    groups.platform,
    branchCount + ' 处平台判断，全部有默认参数 / 提前返回 / else / 三元兜底',
  )
  report('spawn 参数数组', groups.spawn, spawnCalls + ' 处调用，均传 cmd + args 数组，无 shell:true')
  report(
    'fs 路径走 join',
    groups.fsPath,
    fsCalls + ' 处调用，' + fsJoined + ' 处直接 join，其余为变量/成员表达式（0 处字面量拼接）',
  )
  if (looseBranches.length > 0) {
    warn(
      'process.platform 有 ' + looseBranches.length + ' 处不在 if 分支内，兜底需人工确认',
      looseBranches.map((x) => x.rel + ':' + x.line).slice(0, 5).join('，'),
    )
  }

  // 扫描器自检：确保规则不是"永远通过"
  const selfCases = [
    { name: 'Windows 盘符', hit: (t) => findWindowsPathIssues(t).length > 0, sample: "const p = 'C:\\data\\x.json'" },
    { name: 'platform 无兜底', hit: (t) => findPlatformBranches(t).some((b) => b.kind === 'if-no-fallback'), sample: "if (process.platform === 'win32') { go() }" },
    { name: 'spawn 拼接', hit: (t) => findSpawnIssues(t).issues.length > 0, sample: "spawn('python ' + file)" },
    { name: 'fs 字面量路径', hit: (t) => findFsPathIssues(stripComments(t)).issues.length > 0, sample: "import { readFileSync } from 'node:fs'\nreadFileSync('data/poems.json')" },
  ]
  const missed = selfCases.filter((c) => !c.hit(c.sample)).map((c) => c.name)
  if (missed.length === 0) ok('扫描规则自检', selfCases.length + ' 类违规样本全部命中')
  else bad('扫描规则自检', '未命中：' + missed.join('、'))
}

// ---------------------------------------------------------------------------
// [2] Python 解释器候选链
// ---------------------------------------------------------------------------
function checkPython() {
  section(2, 'Python 解释器候选链（src/host/tts/python.ts 真实实现）')
  if (!transformSync) {
    bad('加载 TS 源码失败', '需要 devDependency esbuild：' + loadError)
    return
  }

  const pyStubs = {
    'node:fs': { existsSync: () => false },
    'node:child_process': { spawn: () => { throw new Error('本检查不启动子进程') } },
    'node:string_decoder': { StringDecoder: class { } },
    '../../shared/tts.js': { TTS_PROBE_CODE: 'probe' },
    './common.js': {
      PROBE_TIMEOUT_MS: 2000,
      STDERR_LOG_MAX: 300,
      bumpStat() { },
      killChild() { },
      pythonEnv() { return {} },
      setLastProbeError() { },
      shortError: (e) => String(e),
      tailText: (s) => String(s),
    },
  }

  const platforms = ['win32', 'linux', 'darwin']
  const chains = {}
  try {
    for (const p of platforms) {
      const mod = loadTs('src/host/tts/python.ts', pyStubs, { platform: p, env: {} })
      if (typeof mod.defaultCandidates !== 'function') throw new Error('没有导出 defaultCandidates()')
      const list = mod.defaultCandidates()
      chains[p] = list.map((c) => ({
        cmd: String(c && c.cmd),
        args: Array.isArray(c && c.args) ? c.args.map(String) : [],
        label: String((c && c.label) || (c && c.cmd) || ''),
      }))
    }
  } catch (e) {
    bad('从源码执行 defaultCandidates()', '失败：' + String((e && e.message) || e))
    return
  }

  const labels = (p) => chains[p].map((c) => c.label)
  const render = (p) => labels(p).join(' → ')

  const malformed = platforms.filter((p) => chains[p].length === 0 || chains[p].some((c) => !c.cmd || !c.label))
  if (malformed.length === 0) ok('三平台候选链可解析（cmd / args / label 齐全）')
  else bad('候选链结构不完整', malformed.join('、'))

  if (JSON.stringify(labels('win32')) !== JSON.stringify(labels('linux'))) {
    ok('平台分支存在', 'win32 ≠ linux（按 process.platform 分流）')
  } else {
    bad('平台分支缺失', 'win32 与 linux 候选链相同：' + render('win32'))
  }

  // 同平台重复调用结果一致（纯函数，不依赖模块状态）
  try {
    const mod = loadTs('src/host/tts/python.ts', pyStubs, { platform: 'linux', env: {} })
    const a = mod.defaultCandidates().map((c) => c.label).join(',')
    const b = mod.defaultCandidates().map((c) => c.label).join(',')
    if (a === b) ok('defaultCandidates() 是纯函数', '重复调用结果一致')
    else bad('defaultCandidates() 返回值不稳定', a + ' / ' + b)
  } catch (e) {
    bad('defaultCandidates() 重复调用失败', String((e && e.message) || e))
  }

  // 文档矩阵对照：以实现为准，不一致只警告
  const EXPECTED = {
    win32: ['python', 'py -3', 'python3'],
    linux: ['python3', 'python'],
    darwin: ['python3', 'python'],
  }
  const mismatched = platforms.filter((p) => JSON.stringify(labels(p)) !== JSON.stringify(EXPECTED[p]))
  if (mismatched.length === 0) {
    ok('候选链与文档矩阵一致', 'win32：python → py -3 → python3；POSIX：python3 → python')
  } else {
    warn('实现与文档矩阵不一致（以实现为准）', mismatched.map((p) => p + '：' + render(p)).join('；'))
  }

  // 平台矩阵输出自检：三行齐备且每行都有候选（防止 note() 的重排把某平台吞掉）
  const matrix = platforms.map((p) => ({ p, line: p.padEnd(7) + render(p) }))
  const missingRows = matrix.filter((r) => !r.line.trimStart().startsWith(r.p) || r.line.trim().length <= r.p.length)
  if (missingRows.length === 0) ok('平台矩阵三行齐备', 'win32 / linux / darwin 均有非空候选链')
  else bad('平台矩阵缺行', missingRows.map((r) => r.p).join('、') || '（无）')

  note('平台矩阵（从 defaultCandidates() 实测）：')
  for (const r of matrix) note('  ' + r.line)
}

// ---------------------------------------------------------------------------
// [3] 运行目录与路径分隔符
// ---------------------------------------------------------------------------
function checkHome(files) {
  section(3, '运行目录与路径分隔符（~/.dsh-chubby-whale）')

  const indexFile = files.find((f) => f.rel === 'src/index.ts')
  if (!indexFile) {
    bad('找不到 src/index.ts', '无法验证 RUNTIME_DIR')
  } else {
    const code = stripComments(indexFile.text)
    const hasHomedirImport = /import\s*\{[^}]*\bhomedir\b[^}]*\}\s*from\s*'node:os'/.test(code)
    const hasRuntime = /RUNTIME_DIR\s*=\s*join\(\s*homedir\(\)\s*,\s*['"]\.dsh-chubby-whale['"]\s*\)/.test(code)
    if (hasHomedirImport && hasRuntime) {
      ok('RUNTIME_DIR 使用 homedir() + join', "const RUNTIME_DIR = join(homedir(), '.dsh-chubby-whale')")
    } else if (hasRuntime) {
      bad('RUNTIME_DIR 有 join(homedir(), ...) 但 homedir 不是从 node:os 导入', '检查 src/index.ts 的 import')
    } else {
      bad('RUNTIME_DIR 未使用 homedir()', '不得写死主目录')
    }
  }

  // 全仓写死主目录
  const hardHome = []
  const hardHomeRe = /(['"`])(?:\/(?:home|Users)\/|[A-Za-z]:\\+Users\\)/i
  for (const f of files) {
    const code = stripComments(f.text)
    const m = hardHomeRe.exec(code)
    if (m) hardHome.push(f.rel + ':' + lineOf(code, m.index))
  }
  if (hardHome.length === 0) ok('全仓无写死主目录', '0 处 /home、/Users、C:\\Users')
  else bad('发现写死主目录：' + hardHome.length + ' 处', hardHome.slice(0, 6).join('，'))

  // path.posix / path.win32 模拟 join 结果
  const posix = path.posix.join('/home/whale', '.dsh-chubby-whale')
  const win = path.win32.join('C:\\Users\\whale', '.dsh-chubby-whale')
  const posix2 = path.posix.join('/home/whale/', '.dsh-chubby-whale')
  const win2 = path.win32.join('C:\\Users\\whale\\', '.dsh-chubby-whale')
  if (posix === '/home/whale/.dsh-chubby-whale' && posix2 === posix) {
    ok('POSIX join 结果', posix)
  } else {
    bad('POSIX join 结果异常', posix + ' / ' + posix2)
  }
  if (win === 'C:\\Users\\whale\\.dsh-chubby-whale' && win2 === win) {
    ok('Windows join 结果', win)
  } else {
    bad('Windows join 结果异常', win + ' / ' + win2)
  }
}

// ---------------------------------------------------------------------------
// [4] 权限分支（chmod 只在非 win32 执行）
// ---------------------------------------------------------------------------
function checkPermissions() {
  section(4, '权限分支（src/host/atomic.ts，chmod 仅 POSIX）')
  if (!transformSync) {
    bad('加载 TS 源码失败', '需要 devDependency esbuild：' + loadError)
    return
  }

  const win = loadAtomic('win32', '{}')
  const winPosix = win.mod.isPosixModePlatform()
  const winFile = win.mod.chmodPrivateFile('/tmp/chubby-whale-check')
  const winDir = win.mod.chmodPrivateDir('/tmp/chubby-whale-check')
  if (winPosix === false && winFile === false && winDir === false && win.chmods.length === 0) {
    ok('win32：完全跳过 chmod', '0 次调用，chmodPrivateFile/Dir 返回 false')
  } else {
    bad(
      'win32：仍执行了 chmod',
      'isPosix=' + winPosix + '，file=' + winFile + '，dir=' + winDir + '，调用 ' + win.chmods.length + ' 次',
    )
  }

  for (const p of ['linux', 'darwin']) {
    const posix = loadAtomic(p, '{}')
    const posixMode = posix.mod.isPosixModePlatform() === true
    const fileOk = posix.mod.chmodPrivateFile('/tmp/chubby-whale-check') === true
    const dirOk = posix.mod.chmodPrivateDir('/tmp/chubby-whale-check') === true
    const modes = posix.chmods.map((c) => c.mode.toString(8))
    const fileMode = modes[0] === '600'
    const dirMode = modes[1] === '700'
    if (posixMode && fileOk && dirOk && fileMode && dirMode) ok(p + '：chmod 生效', '文件 0600 / 目录 0700')
    else bad(p + '：chmod 分支异常', 'isPosix=' + posixMode + '，记录模式=' + (modes.join(',') || '无'))
  }
}

// ---------------------------------------------------------------------------
// [5] BOM 容错
// ---------------------------------------------------------------------------
function checkBom() {
  section(5, 'BOM 容错（stripBom / readTextNoBom）')
  if (!transformSync) {
    bad('加载 TS 源码失败', '需要 devDependency esbuild：' + loadError)
    return
  }

  const withBom = loadAtomic('linux', '\uFEFF{"a":1}')
  const noBom = loadAtomic('linux', '{"b":2}')
  const bomOnly = loadAtomic('linux', '\uFEFF')
  const mod = withBom.mod

  const cases = [
    ['stripBom 剥离 U+FEFF', mod.stripBom('\uFEFF{}') === '{}', JSON.stringify(mod.stripBom('\uFEFF{}'))],
    ['无 BOM 原样返回', mod.stripBom('{}') === '{}', JSON.stringify(mod.stripBom('{}'))],
    ['空串 / 纯 BOM 安全', mod.stripBom('') === '' && mod.stripBom('\uFEFF') === '', '"" / ""'],
    ['readTextNoBom 读带 BOM JSON 可解析', JSON.parse(mod.readTextNoBom('/tmp/x.json')).a === 1, '\\uFEFF{"a":1} → {"a":1}'],
    ['readTextNoBom 读无 BOM 不变', noBom.mod.readTextNoBom('/tmp/y.json') === '{"b":2}', '{"b":2}'],
    [
      'readTextNoBom 纯 BOM 文件返回空串',
      bomOnly.mod.readTextNoBom('/tmp/bom-only.json') === '',
      '文件内容仅有 \\uFEFF → ""（不是 "\\uFEFF"）',
    ],
  ]
  for (const [name, cond, detail] of cases) {
    if (cond) ok(name, detail)
    else bad(name, '断言失败')
  }
}

// ---------------------------------------------------------------------------
// [6] 诗名索引路径：client seedFromDisk 向上查找 + host 路由 dataDir 兜底
// ---------------------------------------------------------------------------

/** 伪造 process 注入 loadTs：让模块加载期的 seedFromDisk() 按指定 cwd 读真实 fs */
function fakeProcess(cwdDir) {
  return {
    platform: 'linux',
    pid: 4242,
    env: {},
    cwd: () => cwdDir,
    getBuiltinModule: (id) => (id === 'node:fs' ? nodeFs : id === 'node:path' ? path : undefined),
  }
}

/** 在指定 cwd 下加载 client/poem-titles.ts（seedFromDisk 未导出，靠模块加载期自动执行） */
function loadClientPoemTitles(cwdDir) {
  return loadTs(
    'src/client/poem-titles.ts',
    {
      '../shared/immutable.js': { deepFreeze: (x) => x },
      './http.js': { getJson: () => Promise.resolve({ ok: false }), timeoutSignal: () => undefined },
      './util.js': { str: (x) => (x == null ? '' : String(x)) },
    },
    fakeProcess(cwdDir),
  )
}

async function checkPoemTitles() {
  section(6, '诗名索引：cwd 向上查找（client）与 dataDir 兜底（host）')
  if (!transformSync) {
    bad('加载 TS 源码失败', '需要 devDependency esbuild：' + loadError)
    return
  }

  // --- 静态：client seedFromDisk 的向上查找结构（不给导出就能断言的前提）---
  const clientRel = 'src/client/poem-titles.ts'
  const clientCode = stripComments(readFileSync(join(ROOT, clientRel), 'utf8'))
  const probes = [
    ['从 cwd 起步', /\w+\.cwd\(\)/],
    ['最多 4 层的向上循环', /for\s*\(\s*let\s+i\s*=\s*0\s*;\s*i\s*<\s*4\s*;\s*i\+\+\s*\)/],
    ['候选 = join(dir, "data", "poem-titles.json")', /\w+\.join\(\s*dir\s*,\s*['"]data['"]\s*,\s*['"]poem-titles\.json['"]\s*\)/],
    ['逐级取父目录 dirname(dir)', /\w+\.dirname\(\s*dir\s*\)/],
    ['到根目录即停止（parent === dir）', /parent\s*===\s*dir/],
    ['内置模块走 process.getBuiltinModule("node:fs")', /\w+\.getBuiltinModule\(\s*['"]node:fs['"]\s*\)/],
    ['无 getBuiltinModule 时降级为空表', /getBuiltinModule\s*!==\s*['"]function['"]/],
  ]
  const missed = probes.filter(([, re]) => !re.test(clientCode)).map(([name]) => name)
  if (missed.length === 0) {
    ok('client seedFromDisk 静态结构', 'cwd 起、最多 4 层、dirname 逐级上溯、到根停止（' + clientRel + '）')
  } else {
    bad('client seedFromDisk 静态结构缺失', '未命中：' + missed.join('、'))
  }

  // --- 运行时：临时目录模拟「cwd 在子目录」---
  const dataTitles = ['静夜思', '将进酒', '水调歌头']
  const norm = dataTitles.slice().sort((a, b) => b.length - a.length)
  let tmpRoot = ''
  try {
    tmpRoot = mkdtempSync(join(tmpdir(), 'chubby-platform-poem-'))
    mkdirSync(join(tmpRoot, 'data'), { recursive: true })
    writeFileSync(join(tmpRoot, 'data', 'poem-titles.json'), JSON.stringify({ titles: dataTitles }), 'utf8')
    for (const sub of ['a/b/c', 'deep/x/y/z/w/v']) mkdirSync(join(tmpRoot, ...sub.split('/')), { recursive: true })

    const cases = [
      { name: 'cwd 即项目根：直接命中 data/poem-titles.json', cwd: tmpRoot, hit: true },
      { name: 'cwd 在 3 层子目录：第 4 个候选命中（4 层上限内）', cwd: join(tmpRoot, 'a', 'b', 'c'), hit: true },
      { name: 'cwd 在 6 层子目录：不越过 4 层上限', cwd: join(tmpRoot, 'deep', 'x', 'y', 'z', 'w', 'v'), hit: false },
    ]
    for (const c of cases) {
      let titles = null
      let err = ''
      try {
        titles = Array.from(loadClientPoemTitles(c.cwd).poemTitles())
      } catch (e) {
        err = String((e && e.message) || e)
      }
      if (c.hit) {
        const good =
          Array.isArray(titles) &&
          titles.length === norm.length &&
          titles[0] === norm[0] &&
          norm.every((t) => titles.includes(t))
        if (good) ok('client seedFromDisk ' + c.name, titles.join(' / '))
        else bad('client seedFromDisk ' + c.name, err || 'titles=' + JSON.stringify(titles))
      } else if (Array.isArray(titles) && titles.length === 0) {
        ok('client seedFromDisk ' + c.name, '返回空表，调用方保持降级')
      } else {
        bad('client seedFromDisk ' + c.name, err || 'titles=' + JSON.stringify(titles))
      }
    }

    // --- host 路由：静态兜底 + 运行时用缺省 dataDir 从 cwd/data 读 ---
    const hostRel = 'src/host/routes/poem-titles.ts'
    const hostCode = stripComments(readFileSync(join(ROOT, hostRel), 'utf8'))
    if (/join\(\s*process\.cwd\(\)\s*,\s*['"]data['"]\s*\)/.test(hostCode)) {
      ok('host 路由 dataDir 兜底 = join(process.cwd(), "data")', hostRel + '（静态）')
    } else {
      bad('host 路由 dataDir 兜底缺失', '源码未出现 join(process.cwd(), "data")')
    }

    const res = { body: null }
    const hostMod = loadTs(
      hostRel,
      {
        '../respond.js': { sendJson: (r, obj) => { r.body = obj } },
        'node:fs': nodeFs,
        'node:path': path,
      },
      fakeProcess(tmpRoot),
    )
    const handler = hostMod.createPoemTitlesHandler({})
    await handler.handlePoemTitles({}, res)
    if (res.body && res.body.ok === true && res.body.count === dataTitles.length) {
      ok('host 路由缺省 dataDir 从 cwd/data 读取', 'ok=true，count=' + res.body.count)
    } else {
      bad('host 路由缺省 dataDir 读取失败', JSON.stringify(res.body))
    }
  } catch (e) {
    bad('诗名索引临时目录沙箱', String((e && e.message) || e))
  } finally {
    if (tmpRoot) {
      try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { }
    }
  }
}

// ---------------------------------------------------------------------------
// [7] Node 版本约束（engines.node）
// ---------------------------------------------------------------------------
function checkEngines() {
  section(7, 'Node 版本约束（package.json engines.node）')
  let pkg = null
  try {
    pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  } catch (e) {
    bad('读取 package.json 失败', String((e && e.message) || e))
    return
  }
  const why = 'process.getBuiltinModule 自 Node 22.3.0 起提供（client seedFromDisk 依赖它读 data/poem-titles.json）'
  const spec = pkg && pkg.engines && pkg.engines.node
  if (typeof spec === 'string' && spec.trim()) {
    ok('engines.node 已声明', JSON.stringify(spec.trim()))
  } else {
    bad('engines.node 未声明', '必须 >=22.3；' + why)
    return
  }
  // 只接受 ">=major.minor"：^ / ~ / 不带下界都不算锁定最低可运行版本
  const m = /^>=\s*(\d+)\.(\d+)/.exec(spec.trim())
  const minOk = !!m && Number(m[1]) * 1000 + Number(m[2]) >= 22003
  if (minOk) ok('engines.node 不低于 22.3', spec.trim() + ' ≥ 22.3；' + why)
  else bad('engines.node 低于 22.3', spec.trim() + '；' + why)

  const curMajor = Number(process.versions.node.split('.')[0])
  const curMinor = Number(process.versions.node.split('.')[1])
  if (curMajor * 1000 + curMinor >= 22003) {
    ok('当前运行 Node 满足声明', 'node ' + process.version)
  } else {
    warn(
      '当前运行 Node 低于 22.3',
      'process.getBuiltinModule 不可用 → seedFromDisk 返回空表，诗名识别退化为泛化意图（host 路由不受影响）',
    )
  }
}

// ---------------------------------------------------------------------------
// 结论
// ---------------------------------------------------------------------------
const files = walk(SRC)
console.log('平台适配检查（静态扫描 + 纯逻辑模拟；不启动服务、不联网）')
console.log(I + '当前运行平台：' + process.platform + ' / node ' + process.version)
checkBindings(files)
checkPython()
checkHome(files)
checkPermissions()
checkBom()
await checkPoemTitles()
checkEngines()

section(8, '结论')
console.log(I + '通过 ' + passed + ' 项 / 警告 ' + warned + ' 项 / 失败 ' + failed + ' 项')
if (failed === 0) {
  console.log(I + '✅ 三平台静态适配检查通过')
  process.exit(0)
}
console.log(I + '❌ 存在失败项，修复后重跑：node scripts/platform-check.mjs')
process.exit(1)
