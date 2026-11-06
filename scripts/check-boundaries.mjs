/**
 * scripts/check-boundaries.mjs —— 模块封装与污染防线
 *
 * 背景（主人定的硬规则）：模块只对外提供接口，不允许外部读写模块内部状态。
 * 纯约定靠不住，这里把它变成可执行检查，npx test 时自动跑。
 *
 * 规则：
 *   B1 导出可变字面量必须冻结（Object.freeze / as const / ReadonlyArray 标注），
 *      否则任何调用方都能 push/改值，等于把内部数据暴露出去。
 *      白名单：框架需要数组身份的导出（如 DSH 插件的 inject）写在 ALLOW_UNFROZEN。
 *   B2 禁止跨模块深路径导入：只允许 ../shared/ 与 ../../data/（公共层），
 *      不允许 import 到另一个模块的内部文件（那会绕过它的公开接口）。
 *   B3 禁止往 window / globalThis / document 上挂全局变量（防与其他插件互相污染）。
 *   B4 localStorage 键必须 chubby- 前缀（多插件共存时避免撞键）。
 *
 * 用法：node scripts/check-boundaries.mjs
 * 退出码：0=通过；1=有违规
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')

/** 允许不冻结的导出：名字 -> 原因 */
const ALLOW_UNFROZEN = new Set([
  'index.ts:inject',   // DSH 框架按数组身份读取插件注入声明
  'index.ts:Config',   // 框架配置 schema 对象，由框架自行处理
])

const violations = []
const warnings = []

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p)
    else if (name.endsWith('.ts')) checkFile(p)
  }
}

/** 粗略判断导出右侧是不是"可变字面量且没冻结" */
function isUnfrozenLiteral(rhs) {
  const s = String(rhs || '').trim()
  if (!/^(new (Map|Set|WeakMap|WeakSet)|\[|\{|Array\(|Object\.(create|assign))/.test(s)) return false
  if (/Object\.freeze\(/.test(s)) return false
  if (/as const/.test(s)) return false
  if (/\bReadonlyArray<|\breadonly\b/.test(s)) return false
  if (/^\[[\s\S]*\]$/.test(s) && /as const/.test(s)) return false
  return true
}

function checkFile(file) {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  const short = rel.replace(/^src\//, '')
  const src = readFileSync(file, 'utf8')
  const lines = src.split(/\r?\n/)

  // B1 出口冻结
  // 支持单行 `export const X = {...}` 与多行开头（只判断首行右侧，够用）
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^export\s+(?:const|let)\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*(.+)$/)
    if (!m) continue
    const name = m[1]
    const key = rel.includes('/') ? rel.split('/').pop() + ':' + name : short + ':' + name
    if (ALLOW_UNFROZEN.has(key)) continue
    // 多行字面量：当前行以 { 或 [ 结尾时，向后最多 40 行找冻结/断言
    let rhs = m[2]
    const after = src.slice(src.indexOf(lines[i]))
    if (new RegExp('(Object\\.freeze|deepFreeze)\\(\\s*' + name + '\\b').test(after)) continue
    if (/^[{[]\s*$/.test(rhs)) {
      if (/as const|ReadonlyArray<|readonly /.test(after.slice(0, 4000))) continue
    } else if (!isUnfrozenLiteral(rhs)) {
      continue
    }
    violations.push(`B1 ${rel}:${i + 1} 导出可变字面量未冻结：${name}（外部可改内部数据）`)
  }

  // B2 深路径导入
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/from\s+'([^']+)'/)
    if (!m) continue
    const spec = m[1]
    if (!spec.startsWith('.')) continue
    const parts = spec.split('/')
    const up = parts.filter((p) => p === '..').length
    if (up < 2) continue
    const allowed = /shared\//.test(spec) || /\.\.\/\.\.\/data\//.test(spec) || /\.\.\/\.\.\/assets\//.test(spec)
    if (!allowed) violations.push(`B2 ${rel}:${i + 1} 跨模块深路径导入（绕过公开接口）：${spec}`)
    // 跨层禁令：client 不得引用 host 内部文件，反之亦然；shared 不得依赖上层
    const here = rel.startsWith('src/client/') ? 'client' : rel.startsWith('src/host/') ? 'host' : rel.startsWith('src/shared/') ? 'shared' : 'root'
    const target = spec.includes('/host/') || spec.startsWith('../host/') ? 'host' : (spec.includes('/client/') || spec.startsWith('../client/')) ? 'client' : ''
    if (target && here !== 'root' && target !== here) violations.push(`B2 ${rel}:${i + 1} 跨层依赖（${here} → ${target}）：${spec}`)
    if (here === 'shared' && target) violations.push(`B2 ${rel}:${i + 1} 公共层反向依赖上层：${spec}`)
  }

  // B6 路由层不直接摸实现：routes/** 只能依赖 respond/body/http/ports/shared/data 纯函数，
  //    要拿数据一律走注入的端口（否则改实现就会波及路由）
  if (rel.includes('/host/routes/')) {
    const forbiddenRoutes = ["'../store.js'", "'../repos/", "'../story/repo.js'", "'../cache.js'", "'../data/"]
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/from '([^']+)'/)
      if (!m) continue
      if (forbiddenRoutes.some((f) => m[1].indexOf(f) === 0)) {
        violations.push(`B6 ${rel}:${i + 1} 路由直接依赖实现（应走注入端口）：${m[1]}`)
      }
    }
  }

  // B5 端口层零反依赖：host/ports.ts 只能引用 shared/ 或自身类型，不许 import 具体实现
  if (rel.endsWith('host/ports.ts')) {
    const forbidden = ["'./tts-engine.js'", "'./store.js'", "'./data/", "'./repos/", "'./routes/", "'./story/", "'./personality"]
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/from '([^']+)'/)
      if (!m) continue
      if (forbidden.some((f) => m[1].indexOf(f) === 0)) {
        violations.push(`B5 ${rel}:${i + 1} 端口层反向依赖具体实现：${m[1]}`)
      }
    }
  }

  // B3 全局挂载（要能认 (window as any).x = / window['x'] = 这类写法）
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*(\/\/|\*)/.test(line)) continue
    // 去掉 TS 断言后再判断： (window as any) / (globalThis as any)
    const norm = line.replace(/\(\s*(window|globalThis|document)\s+as\s+any\s*\)/g, '$1')
    const assign = norm.match(/(?:^|[^.\w$])(window|globalThis|document)\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])\s*=(?!=)/)
    if (!assign) continue
    if (/Object\.freeze/.test(line)) continue
    const key = assign[2] || assign[3] || ''
    if (key === '__chubbyWhale') {
      // 只允许往命名空间里写字段（__chubbyWhale.x = 1）；
      // 整对象替换（__chubbyWhale = {...}）会把别处挂的字段全丢掉
      // 允许 "已存在就用，不存在才建" 的写法（obj || (obj = {})）；
      // 只有"无条件整对象替换"才会丢掉别处挂的字段
      if (/__chubbyWhale\s*=(?!=)/.test(norm) && !/\|\|/.test(norm)) {
        violations.push(`B3 ${rel}:${i + 1} 整对象覆盖全局调试命名空间（会丢掉已挂的字段）：${line.trim().slice(0, 80)}`)
      }
      continue
    }
    if (key === '__chubbyErrors') continue
    violations.push(`B3 ${rel}:${i + 1} 往全局挂变量（易与其他插件互相污染）：${line.trim().slice(0, 80)}`)
  }

  // B4 localStorage 键前缀
  const re = /localStorage\.(?:get|set|remove)Item\(\s*'([^']+)'/g
  let mm
  while ((mm = re.exec(src)) !== null) {
    if (!mm[1].startsWith('chubby-')) violations.push(`B4 ${rel} localStorage 键缺 chubby- 前缀：${mm[1]}`)
  }
}

walk(SRC)

if (warnings.length) {
  console.log('  提示：')
  for (const w of warnings) console.log('    ' + w)
}
if (violations.length) {
  console.log(`  ❌ 封装检查未通过，共 ${violations.length} 处：`)
  for (const v of violations.slice(0, 60)) console.log('    ' + v)
  if (violations.length > 60) console.log(`    …另有 ${violations.length - 60} 处`)
  process.exit(1)
}
console.log('  ✅ 封装检查通过（导出冻结 / 无深路径导入 / 无全局污染 / 键前缀合规）')
