/**
 * scripts/test-sentence-boundary.mjs —— 动态断句阈值 + 逗号落句
 *
 * 2026-11-14 主人最终口径：
 *   · 切句再慢一点：短语音等 900ms、长语音等 600ms，中间线性插值；
 *   · 全程只用逗号落句：句号/问号/感叹号/英文句点都改成「，」；
 *   · 已经是逗号/顿号/分号/冒号则保留；没有标点就补「，」。
 *
 * 纯函数、零依赖。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { requiredQuietMs, normalizeSegment } from '../src/shared/sentence-boundary.ts'

let pass = 0
const failures = []
function check(name, fn) {
  try { fn(); pass++; console.log('  ✅ ' + name) } catch (err) {
    failures.push({ name, err })
    console.log('  ❌ ' + name)
    console.log('     ' + String((err && err.message) || err).replace(/\n/g, '\n     '))
  }
}

console.log('[A] requiredQuietMs：短句 900、长句 600、中间插值')
check('0ms → 900', () => assert.equal(requiredQuietMs(0), 900))
check('200ms → 900', () => assert.equal(requiredQuietMs(200), 900))
check('800ms（短句上界）→ 900', () => assert.equal(requiredQuietMs(800), 900))
check('4000ms（长句下界）→ 600', () => assert.equal(requiredQuietMs(4000), 600))
check('4500ms → 600', () => assert.equal(requiredQuietMs(4500), 600))
check('10000ms → 600', () => assert.equal(requiredQuietMs(10000), 600))
check('1200ms → 863（线性插值）', () => assert.equal(requiredQuietMs(1200), 863))
check('1600ms → 825', () => assert.equal(requiredQuietMs(1600), 825))
check('2400ms → 750（中点）', () => assert.equal(requiredQuietMs(2400), 750))
check('3200ms → 675', () => assert.equal(requiredQuietMs(3200), 675))
check('0~6000ms 单调不增且夹在 [600,900]', () => {
  let prev = Infinity
  for (let ms = 0; ms <= 6000; ms += 50) {
    const q = requiredQuietMs(ms)
    assert.ok(q >= 600 && q <= 900, ms + 'ms → ' + q + ' 越界')
    assert.ok(q <= prev, ms + 'ms 趋势反弹')
    prev = q
  }
})
check('负数 → 900（最保守）', () => assert.equal(requiredQuietMs(-100), 900))
check('NaN → 900', () => assert.equal(requiredQuietMs(NaN), 900))
check('undefined → 900', () => assert.equal(requiredQuietMs(undefined), 900))
check('Infinity → 900', () => assert.equal(requiredQuietMs(Infinity), 900))

console.log('\n[B] normalizeSegment：全程逗号')
check('中文句号 → 逗号', () => assert.equal(normalizeSegment('你好。'), '你好，'))
check('英文句点 → 逗号', () => assert.equal(normalizeSegment('hello.'), 'hello，'))
check('感叹号 → 逗号', () => assert.equal(normalizeSegment('太好了！'), '太好了，'))
check('问号 → 逗号', () => assert.equal(normalizeSegment('真的吗？'), '真的吗，'))
check('无标点 → 补逗号', () => assert.equal(normalizeSegment('你好'), '你好，'))
check('已经是逗号 → 不重复', () => assert.equal(normalizeSegment('你好，'), '你好，'))
check('顿号/分号/冒号 → 保持', () => {
  assert.equal(normalizeSegment('甲、'), '甲、')
  assert.equal(normalizeSegment('甲；'), '甲；')
  assert.equal(normalizeSegment('甲：'), '甲：')
})
check('正文中间标点不动，只动结尾', () => {
  assert.equal(normalizeSegment('他说：“好。”'), '他说：“好，”')
})
check('空串不变', () => assert.equal(normalizeSegment(''), ''))
check('meta 不影响逗号规则', () => {
  assert.equal(normalizeSegment('完整句。', { pauseMs: 9999, speechMs: 5000 }), '完整句，')
  assert.equal(normalizeSegment('半句。', { pauseMs: 0, speechMs: 100 }), '半句，')
})

console.log('\n[C] 源码口径：900/600，不再出现 750/450 常量')
const source = readFileSync(new URL('../src/shared/sentence-boundary.ts', import.meta.url), 'utf8')
check('QUIET_MAX_MS = 900', () => assert.match(source, /const QUIET_MAX_MS = 900/))
check('QUIET_MIN_MS = 600', () => assert.match(source, /const QUIET_MIN_MS = 600/))
check('没有旧的 750/450 阈值常量', () => {
  assert.doesNotMatch(source, /const QUIET_MAX_MS = 750/)
  assert.doesNotMatch(source, /const QUIET_MIN_MS = 450/)
})
check('没有 DOM/网络/存储/定时器依赖', () => {
  assert.doesNotMatch(source, /\bdocument\b|\bwindow\b|fetch\(|localStorage|setTimeout|setInterval/)
})

console.log('\n' + '='.repeat(48))
console.log('通过 ' + pass + ' 项 / 失败 ' + failures.length + ' 项')
if (failures.length) {
  for (const f of failures) console.log('  - ' + f.name + ': ' + String((f.err && f.err.message) || f.err))
  process.exit(1)
}
console.log('✅ 动态断句 + 逗号落句测试通过')
