/**
 * scripts/check-no-shell.mjs —— 跨平台守卫：源码里不允许依赖 PowerShell / Windows 专属 shell 命令
 *
 * 为什么（2026-11-07 主人明确要求）：插件要同时跑在 Windows / Linux / macOS。
 *   注释里提到 PowerShell（比如解释 BOM 来源）没关系，**可执行代码**里调用它就不行：
 *   Linux/macOS 上没有 powershell/pwsh，硬编码 .ps1 也没有意义。
 *
 * 检查范围：src/**\/*.ts（运行时代码）与 scripts/**\/*.mjs、tools/**\/*.mjs（仓库工具）
 *   —— 工具脚本同样要跨平台，否则发版流程在非 Windows 上跑不通。
 *
 * 判定口径（只抓「字符串实参里出现命令名」，不抓注释）：
 *   · spawn/exec/execFile 的第一个参数是 'powershell' / 'pwsh' / 'powershell.exe'；
 *   · 字符串里出现 '.ps1' 作为要执行的路径（不是文档说明）；
 *   · 出现 'cmd /c' / 'cmd.exe /c'。
 * 例外：`process.platform === 'win32'` 分支里的 taskkill 是允许的（Windows 专属兜底，
 *   POSIX 走信号），所以 taskkill 不在禁止列表里。
 *
 * 退出码 0 = 干净；1 = 发现违规（逐行列出）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 递归收集文件（跳过 node_modules / dist / .git） */
function walk(dir, out = []) {
  let entries = []
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '.git' || name === 'cache') continue
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const targets = []
for (const sub of ['src', 'scripts', 'tools']) {
  for (const f of walk(join(ROOT, sub))) {
    if (!/\.(ts|mjs|js)$/.test(f)) continue
    // 守卫自己：规则字面量里就写着 "cmd /c"、".ps1"，扫自己必然误报
    // Windows 上 relative() 返回反斜杠，比较前统一成 /
    if (relative(ROOT, f).split('\\').join('/') === 'scripts/check-no-shell.mjs') continue
    targets.push(f)
  }
}

/** 去掉行注释与块注释，避免「注释里提到 powershell」被误判 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** 违规规则：只针对代码（去注释后） */
const RULES = [
  { name: '调用 PowerShell', re: /(spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*['"`](?:powershell|pwsh|powershell\.exe|pwsh\.exe)['"`]/ },
  { name: '执行 .ps1 脚本', re: /['"`][^'"`\n]*\.ps1['"`]/ },
  { name: 'cmd /c 直调', re: /(?:cmd(?:\.exe)?\s+\/[csd])/i },
]

const violations = []
for (const file of targets) {
  let src = ''
  try { src = readFileSync(file, 'utf8') } catch { continue }
  const code = stripComments(src)
  const lines = code.split('\n')
  for (let i = 0; i < lines.length; i++) {
    for (const rule of RULES) {
      if (rule.re.test(lines[i])) {
        violations.push(relative(ROOT, file) + ':' + (i + 1) + '  ' + rule.name + ' → ' + lines[i].trim().slice(0, 100))
      }
    }
  }
}

console.log('[check-no-shell] 扫描 ' + targets.length + ' 个源文件（src / scripts / tools）')
if (violations.length === 0) {
  console.log('  ✅ 没有 PowerShell / Windows 专属 shell 依赖（taskkill 的 win32 分支除外，POSIX 走信号）')
  process.exit(0)
}
console.error('  ❌ 发现 ' + violations.length + ' 处跨平台违规：')
for (const v of violations) console.error('     · ' + v)
process.exit(1)
