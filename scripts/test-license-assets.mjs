/**
 * scripts/test-license-assets.mjs —— 代码/素材许可边界回归
 *
 * 只做静态检查：
 *   · LICENSE-ASSETS.md 存在且写清代码 MIT、素材不自动继承 MIT；
 *   · NOTICE 与 README 指向该文件；
 *   · package.json 的 files 白名单包含该文件；
 *   · 不把素材误写成 MIT。
 */

import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
const failures = []
function check(name, fn) {
  try { fn(); pass++; console.log('  ✅ ' + name) } catch (err) {
    failures.push({ name, err })
    console.log('  ❌ ' + name)
    console.log('     ' + String((err && err.message) || err).replace(/\n/g, '\n     '))
  }
}

console.log('[1] LICENSE-ASSETS.md 存在且边界清楚')
const assetsPath = join(ROOT, 'LICENSE-ASSETS.md')
check('文件存在', () => assert.equal(existsSync(assetsPath), true))
const assets = existsSync(assetsPath) ? readFileSync(assetsPath, 'utf8') : ''
check('代码按 MIT', () => assert.match(assets, /代码[\s\S]{0,40}MIT|MIT[\s\S]{0,40}代码/i))
check('素材不自动继承 MIT', () => assert.match(assets, /素材[\s\S]{0,80}(不自动继承|不自动|单独|边界)/))
check('明确 assets/ 与 data/', () => assert.match(assets, /assets\//) && assert.match(assets, /data\//))
check('禁止单独抽取/再分发', () => assert.match(assets, /单独抽取|再分发|销售/))
check('禁止训练模型', () => assert.match(assets, /训练/))
check('第三方许可优先', () => assert.match(assets, /第三方|OFL|seedream/))
check('不构成法律意见', () => assert.match(assets, /不构成法律意见/))
check('适用版本写明', () => assert.match(assets, /1\.7\.5|适用版本/))

console.log('\n[2] NOTICE / README / package 接线')
const notice = readFileSync(join(ROOT, 'NOTICE'), 'utf8')
check('NOTICE 指向 LICENSE-ASSETS.md', () => assert.match(notice, /LICENSE-ASSETS\.md/))
check('NOTICE 写清素材不自动继承 MIT', () => assert.match(notice, /不自动继承\s*MIT/))
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
check('README 指向 LICENSE-ASSETS.md', () => assert.match(readme, /LICENSE-ASSETS\.md/))
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
check('package files 包含 LICENSE-ASSETS.md', () => assert.ok(pkg.files.includes('LICENSE-ASSETS.md')))
check('package license 仍是 MIT（代码）', () => assert.equal(pkg.license, 'MIT'))

console.log('\n[3] 不把素材误写成 MIT')
check('LICENSE-ASSETS 没有“素材也 MIT”的绝对表述', () => {
  assert.doesNotMatch(assets, /素材[^\n]{0,30}(均为|全部|一律)\s*MIT/)
})

console.log('\n' + '='.repeat(48))
console.log('通过 ' + pass + ' 项 / 失败 ' + failures.length + ' 项')
if (failures.length) {
  for (const f of failures) console.log('  - ' + f.name + ': ' + String((f.err && f.err.message) || f.err))
  process.exit(1)
}
console.log('✅ 素材许可边界检查通过')
