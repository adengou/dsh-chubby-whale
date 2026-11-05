/**
 * scripts/check-diag-keys.mjs —— 诊断命名空间（window.__chubbyWhale）键冲突检查
 *
 * 背景：调试字段分散在 client.ts / chat.ts / voice.ts / voice-bridge.ts / actions/culture.ts
 * 等好几个模块里，各自往 window.__chubbyWhale 上挂键。现在没有冲突，但以后两个模块
 * 起同一个键（比如都叫 lastError）就会互相覆盖，排障时看到的是假数据。
 *
 * 规则：同一顶层键不允许被两个以上文件写入。
 * 说明：绝大多数写入是走别名的（const w = …__chubbyWhale; w.xxx = …），
 * 所以检查器必须同时认「直写」和「别名写」，否则等于只查了一小半（假绿）。
 *
 * 已知限制（如实写在头注释里，别假装全覆盖）：通过 Object.assign(d, {…}) 批量写的键、
 * 或经多层函数转手的命名空间，当前扫描不到；这类写法请尽量避免，或在改动时人工核对。
 *
 * 用法：node scripts/check-diag-keys.mjs
 * 退出码：0=通过；1=有冲突
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = 'src'
const NAMESPACE = '__chubbyWhale'

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (n.endsWith('.ts')) out.push(p)
  }
  return out
}

/** 键 → 写入过它的文件集合 */
const keyOwners = new Map()
function addKey(key, rel) {
  if (!key) return
  if (!keyOwners.has(key)) keyOwners.set(key, new Set())
  keyOwners.get(key).add(rel)
}

for (const file of walk(SRC)) {
  const src = readFileSync(file, 'utf8')
  if (src.indexOf(NAMESPACE) < 0) continue
  const rel = relative('.', file).replace(/\\/g, '/')
  // 先剥掉注释再扫：注释里写"xxx = yyy"不该被当成代码（否则修完还被自己注释误报）
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  // ① 直写：__chubbyWhale.xxx = …（排除 == / ===）
  for (const m of code.matchAll(/__chubbyWhale\s*\.\s*([A-Za-z_$][\w$]*)\s*=(?!=)/g)) addKey(m[1], rel)

  // ② 别名写：const w = …__chubbyWhale 之后 w.xxx = …
  const aliases = new Set()
  for (const a of code.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*[^\n]*__chubbyWhale/g)) {
    aliases.add(a[1])
  }
  // ③ 「本地取命名空间的小函数」：const d = diag()（chat.ts 就是这么写的）
  for (const a of code.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*diag\s*\(\s*\)/g)) {
    aliases.add(a[1])
  }
  for (const alias of aliases) {
    const re = new RegExp('(?:^|[^.\\w$])' + alias + '\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*=(?!=)', 'g')
    for (const a of code.matchAll(re)) addKey(a[1], rel)
  }
}

const files = new Set()
for (const owners of keyOwners.values()) for (const f of owners) files.add(f)

const conflicts = []
for (const [key, owners] of keyOwners) {
  if (owners.size > 1) conflicts.push(key + ' ← ' + Array.from(owners).join(' + '))
}

console.log('  诊断键：' + keyOwners.size + ' 个，涉及 ' + files.size + ' 个文件')
if (conflicts.length > 0) {
  console.log('  ❌ 同一诊断键被多个文件写入（会互相覆盖）：')
  for (const c of conflicts) console.log('    ' + c)
  process.exit(1)
}
console.log('  ✅ 诊断键无跨文件冲突（每个键只有一个写入方）')
