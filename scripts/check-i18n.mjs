/**
 * scripts/check-i18n.mjs —— 英文菜单覆盖检查
 * 静态比对 buildMenu 里的 label 与 EN_MAP / TOGGLE_EN / tr() 动态前缀，列出缺失与死键。
 * 只报告，不改代码（发现缺失请手工补）。
 */
import fs from 'node:fs'
const p = new URL('../src/client/menu.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const t = fs.readFileSync(p, 'utf8')
const labels = [...new Set([...t.matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1]))]
function keysOf(name) {
  const i = t.indexOf('const ' + name)
  if (i < 0) return []
  const s = t.indexOf('{', i)
  let depth = 0, end = s
  for (let j = s; j < t.length; j++) { if (t[j] === '{') depth++; else if (t[j] === '}') { depth--; if (depth === 0) { end = j; break } } }
  return [...t.slice(s, end + 1).matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1])
}
const exact = new Set([...keysOf('EN_MAP'), ...keysOf('TOGGLE_EN')])
const dyn = [...t.matchAll(/label\.startsWith\('([^']+)'\)/g)].map((m) => m[1])
// 「X：开/关」可由 TOGGLE_EN 的「X：」前缀数组翻译（tr 按开/关取索引）
const covered = (s) => {
  if (exact.has(s)) return true
  if (dyn.some((d) => s.startsWith(d))) return true
  const m = s.match(/^(.*)：[开关]$/)
  if (m && exact.has(m[1] + '：')) return true
  return false
}
const missing = labels.filter((s) => !covered(s))
const dead = [...exact].filter((k) => !labels.includes(k) && !dyn.some((d) => k.startsWith(d)))
console.log('菜单文案 ' + labels.length + ' 项 / 精确键 ' + exact.size + ' / 动态前缀 ' + dyn.length)
console.log(missing.length ? '缺英文: ' + missing.join(' / ') : '缺英文: 0 ✅')
console.log(dead.length ? '死键: ' + dead.join(' / ') : '死键: 0 ✅')
process.exit(missing.length + dead.length === 0 ? 0 : 1)