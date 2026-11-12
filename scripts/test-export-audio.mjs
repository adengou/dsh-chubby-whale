/**
 * scripts/test-export-audio.mjs —— 分段导出（稿子 → mp3 + srt）的纯函数回归
 *
 * 只测不依赖浏览器的部分：切句、srt 时间、srt 拼装、ID3 头剥离。
 * 合成与解码链路需要真实 TTS 和 Web Audio，不在离线用例里跑。
 *
 * 用法：node scripts/test-export-audio.mjs（失败退出码 1）
 */

import { register } from 'node:module'

register(new URL('./ts-resolve.mjs', import.meta.url))

const { splitScript, srtTime, buildSrt, stripId3, MAX_SEG_CHARS } = await import('../src/client/voice/export-audio.ts')

let failed = 0
function check(name, cond, extra = '') {
  if (cond) console.log('ok   ' + name)
  else { failed++; console.error('FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

// 1) 空 / 空白
check('空稿返回空数组', splitScript('').length === 0)
check('纯空白返回空数组', splitScript('  \n\t ').length === 0)

// 2) 短句合并：总长不超过上限时合成一段
{
  const out = splitScript('第一句。第二句！第三句？')
  check('短句合并成一段', out.length === 1, JSON.stringify(out))
  check('合并段保留原文', out[0] === '第一句。第二句！第三句？', out[0])
}

// 3) 超长无标点：按上限硬切
{
  const out = splitScript('字'.repeat(200))
  check('200 字切成 3 段', out.length === 3, JSON.stringify(out.map((s) => s.length)))
  check('每段不超过上限', out.every((s) => s.length <= MAX_SEG_CHARS), JSON.stringify(out.map((s) => s.length)))
  check('总字数不丢', out.join('').length === 200)
}

// 4) 多句超限：按句边界切，不切断句子
{
  const sentence = '这是完整的一句话，用来测试切分。' // 17 字
  const out = splitScript(sentence.repeat(10))
  check('按句切而不是按字切', out.every((s) => s.endsWith('。')), JSON.stringify(out.map((s) => s.length)))
  check('长文总字数不丢', out.join('').length === sentence.repeat(10).length)
}

// 5) srt 时间格式
check('0 秒格式', srtTime(0) === '00:00:00,000', srtTime(0))
check('61.5 秒格式', srtTime(61.5) === '00:01:01,500', srtTime(61.5))
check('负数归零', srtTime(-3) === '00:00:00,000', srtTime(-3))

// 6) srt 拼装
{
  const srt = buildSrt([
    { start: 0, end: 1.2, text: '第一句。' },
    { start: 1.2, end: 3, text: '第二句。' },
  ])
  check('序号从 1 开始', srt.indexOf('1\n') === 0, srt)
  check('时间箭头正确', srt.indexOf('00:00:00,000 --> 00:00:01,200') > 0, srt)
  check('两条都在', srt.indexOf('第二句。') > 0 && srt.indexOf('2\n') > 0, srt)
}

// 7) ID3v2 头剥离
{
  const payload = new Uint8Array([0xaa, 0xbb, 0xcc])
  const withId3 = new Uint8Array(10 + payload.length)
  withId3.set([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]) // 'ID3' v2.4 无扩展头 size=0
  withId3.set(payload, 10)
  const stripped = stripId3(withId3)
  check('ID3 头被去掉', stripped.length === 3 && stripped[0] === 0xaa, Array.from(stripped).join(','))
}
{
  const raw = new Uint8Array([0xff, 0xfb, 0x90, 0x00])
  check('非 ID3 原样返回', stripId3(raw).length === 4)
}

if (failed) {
  console.error('失败 ' + failed + ' 项')
  process.exit(1)
}
console.log('全部通过')
