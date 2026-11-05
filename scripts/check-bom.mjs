/**
 * scripts/check-bom.mjs —— 构建/发布前守卫
 * PowerShell 的 `Set-Content -Encoding UTF8` 会写入 BOM（EF BB BF），
 * 而 DSH 读 package.json / cordis.patch.yml 时直接 JSON.parse，带 BOM 会抛
 * "Unexpected token ''" 并**静默跳过整个插件**（dsh: skipping profile bundle）。
 * 这里在构建期就把带 BOM 的文本文件揪出来，宁可构建失败也不让坏包出去。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOT = process.cwd()
const EXTS = new Set(['.json', '.yml', '.yaml', '.ts', '.js', '.mjs', '.md'])
const SKIP_DIRS = new Set(['node_modules', '.git'])

const offenders = []
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) { walk(full); continue }
    if (!EXTS.has(extname(name).toLowerCase())) continue
    const buf = readFileSync(full)
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      offenders.push(full.slice(ROOT.length + 1))
    }
  }
}
walk(ROOT)

if (offenders.length > 0) {
  console.error('[check-bom] 以下文件带 UTF-8 BOM，会导致 DSH 解析失败：')
  for (const f of offenders) console.error('  - ' + f)
  console.error('[check-bom] 修复：用 UTF8Encoding(false) 重写（无 BOM）')
  process.exit(1)
}
console.log('[check-bom] 通过：没有 BOM')