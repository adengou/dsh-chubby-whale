/**
 * scripts/check-i18n.mjs —— 英文菜单覆盖检查（启发式）
 * 取每行 label: 到 , action: 之间的字符串字面量当作文案（支持三元/拼接），
 * 与 EN_MAP / TOGGLE_EN 精确键 + tr() 动态前缀比对，列出缺失与死键。
 */
import fs from 'node:fs'
const p = new URL('../src/client/menu.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const t = fs.readFileSync(p, 'utf8')
const labels = []
for (const line of t.split(/\r?\n/)) {
  const i = line.indexOf('label:')
  if (i < 0) continue
  let rest = line.slice(i + 6)
  const stop = rest.indexOf(', action:')
  if (stop >= 0) rest = rest.slice(0, stop)
  for (const m of rest.matchAll(/'([^']+)'/g)) labels.push(m[1])
}
const uniq = [...new Set(labels)]
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
const covered = (s) => exact.has(s) || dyn.some((d) => s.startsWith(d)) || (/^(.*)：[开关]$/.test(s) && exact.has(s.replace(/[开关]$/, '')))
const missing = uniq.filter((s) => !covered(s))
const dead = [...exact].filter((k) => !uniq.includes(k) && !uniq.includes(k + '开') && !uniq.includes(k + '关') && !dyn.some((d) => k.startsWith(d)))
console.log('菜单文案 ' + uniq.length + ' 项 / 精确键 ' + exact.size + ' / 动态前缀 ' + dyn.length)
console.log(missing.length ? '缺英文: ' + missing.join(' / ') : '缺英文: 0 ✅')
console.log(dead.length ? '死键: ' + dead.join(' / ') : '死键: 0 ✅')
// 启发式检查：误报较多（表达式/拼接会混入），只提示不阻塞\nprocess.exit(0)