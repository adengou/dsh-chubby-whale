/**
 * scripts/gen-module-index.mjs —— 生成《模块接口清单》（架构宪章配套）
 *
 * 扫描 src/host、src/client、src/shared 的顶层 export，生成 docs/模块接口清单.md：
 * 每个模块一行「导出项（函数/常量/类型）」，作为“模块只暴露标准接口”的契约底账。
 *
 * 只读扫描 + 只写 docs/模块接口清单.md；不参与构建与测试。
 *   node scripts/gen-module-index.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const SRC = path.join(ROOT, 'src')
const OUT = path.join(ROOT, 'docs', '模块接口清单.md')

const LAYERS = [
  { key: 'host', label: '宿主（Node）' },
  { key: 'client', label: '浏览器端' },
  { key: 'shared', label: '共享纯逻辑' },
]

const EXPORT_RE = /^export\s+(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm
const REEXPORT_RE = /^export\s+\{([^}]+)\}\s+from/gm
const STARE_RE = /^export\s+\*\s+from\s+['"]([^'"]+)['"]/gm

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.isFile() && p.endsWith('.ts')) out.push(p)
  }
  return out
}

function exportsOf(file) {
  const text = fs.readFileSync(file, 'utf8')
  const names = new Set()
  for (const m of text.matchAll(EXPORT_RE)) names.add(m[1])
  for (const m of text.matchAll(REEXPORT_RE)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()
      if (name) names.add(name.trim())
    }
  }
  for (const m of text.matchAll(STARE_RE)) names.add('* from ' + m[1])
  return [...names].sort()
}

function main() {
  const rows = []
  let totalModules = 0
  let totalExports = 0
  for (const layer of LAYERS) {
    const dir = path.join(SRC, layer.key)
    if (!fs.existsSync(dir)) continue
    const files = walk(dir).sort()
    const items = []
    for (const f of files) {
      const rel = path.relative(ROOT, f).replace(/\\/g, '/')
      const names = exportsOf(f)
      totalModules++
      totalExports += names.length
      if (names.length === 0) continue
      items.push({ rel, names })
    }
    rows.push({ layer, items })
  }

  const lines = []
  lines.push('# 模块接口清单（自动生成）')
  lines.push('')
  lines.push('> 由 `node scripts/gen-module-index.mjs` 生成，请勿手改。')
  lines.push('>')
  lines.push('> 架构宪章：**模块只对外暴露这些导出，外部不得读取模块内部实现**。')
  lines.push('> 新增/修改导出 = 接口变更，必须同步调用点并在提交信息里写明。')
  lines.push('')
  lines.push(`> 统计：${totalModules} 个模块文件，${totalExports} 个导出项。`)
  lines.push('')
  for (const r of rows) {
    lines.push('## ' + r.layer.label + '（`src/' + r.layer.key + '/`）')
    lines.push('')
    lines.push('| 模块 | 导出（接口） |')
    lines.push('| --- | --- |')
    for (const it of r.items) {
      lines.push('| `' + it.rel.replace('src/' + r.layer.key + '/', '') + '` | ' + it.names.map((n) => '`' + n + '`').join('、') + ' |')
    }
    lines.push('')
  }
  const next = lines.join('\n')
  const check = process.argv.includes('--check')
  if (check) {
    let prev = ''
    try { prev = fs.readFileSync(OUT, 'utf8') } catch { /* 首次 */ }
    if (prev !== next) {
      const prevLines = prev.split('\n')
      const nextLines = next.split('\n')
      const same = nextLines.filter((l, i) => prevLines[i] === l).length
      console.log('模块接口清单已过期：' + OUT)
      console.log('  现有 ' + prevLines.length + ' 行 / 本次生成 ' + nextLines.length + ' 行（相同 ' + same + ' 行）')
      console.log('  请运行 node scripts/gen-module-index.mjs 更新后提交')
      process.exit(1)
    }
    console.log('模块接口清单一致：' + totalModules + ' 个模块 / ' + totalExports + ' 项导出 ✅')
    process.exit(0)
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, next, 'utf8')
  console.log('已生成 ' + OUT)
  console.log('模块 ' + totalModules + ' 个 / 导出 ' + totalExports + ' 项')
}

main()
