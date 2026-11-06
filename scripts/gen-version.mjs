/**
 * scripts/gen-version.mjs —— 用 package.json 的版本号生成客户端版本常量
 *
 * 为什么需要：客户端原来在 src/client/styles.ts 里硬编码 `VERSION = '0.1.0'`，
 * 包都发到 1.0.1 了，标题栏还显示 v0.1.0（右键菜单/诊断对象也跟着错）。
 * 硬编码必然漂移，这里在构建前从唯一真源 package.json 生成，避免手改。
 *
 * 产出：src/client/version.ts（纳入版本管理，保证 tsc 随时可用）
 */

import { readFileSync, writeFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const version = String(pkg.version || '').trim()
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error('[gen-version] package.json 里的 version 不合法：' + JSON.stringify(pkg.version))
  process.exit(1)
}

const body = `/**
 * client/version.ts —— 客户端版本号（自动生成，请勿手改）
 *
 * 由 scripts/gen-version.mjs 在构建前用 package.json 的 version 生成；
 * 想改版本号请改 package.json，然后 npm run build。
 */

export const VERSION = '${version}'
`

let prev = ''
try { prev = readFileSync('src/client/version.ts', 'utf8') } catch { /* 首次生成 */ }
if (prev !== body) {
  writeFileSync('src/client/version.ts', body, 'utf8')
  console.log('[gen-version] 已生成 src/client/version.ts → ' + version)
} else {
  console.log('[gen-version] 版本未变：' + version)
}
