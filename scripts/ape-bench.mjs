/**
 * scripts/ape-bench.mjs —— 判停算法基准（合成声学序列，离线可跑）
 *
 * 目的：给判停（APE）的几次调参一个可复现的尺子。任何一次改参数，
 * 跑这个脚本就能看到"每种噪声场景下多久收口"，避免凭感觉调、也避免改坏没发现。
 *
 * 用法：node scripts/ape-bench.mjs
 * 输出：每个场景的收口时间（ms）与原因；异常场景会标红。
 */

import { register } from 'node:module'

// 源码里跨模块 import 写的是编译后的 .js；直接加载 .ts 时用钩子回退到 .ts
register(new URL('./ts-resolve.mjs', import.meta.url))
const { simulateSegment, APE_DEFAULTS } = await import('../src/client/ape.ts')

const F = APE_DEFAULTS.frameMs
const push = (seq, db, ms) => { for (let i = 0; i < Math.round(ms / F); i++) seq.push(db) }

/** 抖动序列：在 base 上下 ±amp 交替，制造"不平稳"的噪声（模拟电视/远处说话） */
function wave(seq, base, amp, ms) {
  const n = Math.round(ms / F)
  for (let i = 0; i < n; i++) seq.push(base + (i % 2 === 0 ? amp : -amp))
}

const cases = []

// ① 纯静音：不该形成提交（没有有效说话）
{
  const seq = []
  push(seq, -72, 8000)
  cases.push({ name: '纯静音 8s', seq, expectCommit: false, maxMs: Infinity })
}

// ② 说话 780ms → 真静音：应在 2.2s 内收口
{
  const seq = []
  push(seq, -70, 600)
  push(seq, -45, 780)
  push(seq, -72, 3000)
  cases.push({ name: '说话→静音', seq, expectCommit: true, minMs: 1200, maxMs: 2400, reason: 'quiet' })
}

// ③ 说话 780ms → 稳态环境噪声（空调/风扇）：噪声尾当安静，2.2s 内收口
{
  const seq = []
  push(seq, -70, 600)
  push(seq, -45, 780)
  push(seq, -55, 3000)
  cases.push({ name: '说话→稳态噪声', seq, expectCommit: true, minMs: 1200, maxMs: 3200, reason: 'quiet' })
}

// ④ 说话 780ms → 波动噪声（±4dB，落在中间带）：靠 maxWaitAfterSpeechMs 兜底，3s 内收口
{
  const seq = []
  push(seq, -70, 600)
  push(seq, -45, 780)
  wave(seq, -60, 4, 4000)
  cases.push({ name: '说话→波动噪声', seq, expectCommit: true, minMs: 1800, maxMs: 4000, reason: 'quiet' })
}

// ⑤ 一直说话 8s：必须在 maxSegmentMs 上限处溢出提交，不能无限吃录音
//    注意：前面留 300ms 环境底噪 —— 判停算法靠"说话前的底噪"做对比，
//    如果录音第一帧就是持续大声，物理上无法区分"人声"和"恒定噪声"（真实场景里总有起音过程）
{
  const seq = []
  push(seq, -70, 300)
  push(seq, -45, 8000)
  cases.push({ name: '持续说话 8s', seq, expectCommit: true, minMs: APE_DEFAULTS.maxSegmentMs, maxMs: APE_DEFAULTS.maxSegmentMs + F * 2, reason: 'overflow' })
}

let bad = 0
console.log('  场景                  收口(ms)  原因      判定')
for (const c of cases) {
  const r = simulateSegment(c.seq)
  const ms = r.frames * F
  const reason = r.step.commitReason || '-'
  let verdict = 'OK'
  if (!c.expectCommit) {
    if (r.step.commit) { verdict = '异常：不该提交'; bad++ }
  } else if (!r.step.commit) {
    verdict = '异常：没有提交'; bad++
  } else if (ms < (c.minMs || 0) - 1 || ms > (c.maxMs || Infinity) + 1) {
    verdict = '异常：超出范围'; bad++
  } else if (c.reason && reason !== c.reason) {
    verdict = '异常：原因不符'; bad++
  }
  console.log('  ' + c.name.padEnd(20) + String(ms).padStart(7) + '  ' + reason.padEnd(9) + verdict)
}
console.log('\n  参数：frameMs=' + F + ' minSpeechMs=' + APE_DEFAULTS.minSpeechMs +
  ' steadyWindowFrames=' + APE_DEFAULTS.steadyWindowFrames +
  ' steadyMs=' + APE_DEFAULTS.steadyMs + ' maxWaitAfterSpeechMs=' + APE_DEFAULTS.maxWaitAfterSpeechMs +
  ' maxSegmentMs=' + APE_DEFAULTS.maxSegmentMs)
console.log(bad === 0 ? '  ✅ 判停基准全部通过' : '  ❌ 有 ' + bad + ' 个场景异常')
if (bad > 0) process.exit(1)
