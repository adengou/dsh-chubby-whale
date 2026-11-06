/**
 * scripts/check-text.mjs —— 文字材料体检（数据 + 自己写的文案）
 *
 * 检查项（只报"确定无疑"的问题，避免过度纠错）：
 *   ① 异体字「沈沈」应为「沉沉」（主人指出《雨霖铃》这一处后统一清查）
 *   ② 半角标点夹在汉字中间（, ; : ! ?）—— 明显是从别的格式转过来时漏的
 *   ③ 乱码字符 U+FFFD、BOM 头、零宽字符
 *   ④ 重复标点的统计（只统计、不判错，因为「。：」这类多半是引号丢失造成的，
 *      贸然替换会改变原文，需要人工确认）
 *
 * 用法：node scripts/check-text.mjs        （报告，不修改）
 *       node scripts/check-text.mjs --fix  （只修 ① ② 两类，其余只报告）
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'

const FIX = process.argv.includes('--fix')
const files = ['data/poems.json', 'data/persona.json', 'data/melodies.json', 'data/duilian.json', 'data/culture/chengyu.json', 'data/culture/idioms.json', 'data/culture/minsu.json']
try { for (const f of readdirSync('data/story').filter((x) => x.endsWith('.json'))) files.push('data/story/' + f) } catch { }

const problems = { 沈沈: [], asciiPunct: [], fffd: [], bom: [], zeroWidth: [], dupPunct: [] }
let fixedShen = 0
let fixedAscii = 0

const asciiRules = [
  [/[\u4e00-\u9fa5],[\u4e00-\u9fa5]/g, '半角逗号'],
  [/[\u4e00-\u9fa5];[\u4e00-\u9fa5]/g, '半角分号'],
  [/[\u4e00-\u9fa5]:[\u4e00-\u9fa5]/g, '半角冒号'],
  [/[\u4e00-\u9fa5]\?[\u4e00-\u9fa5]/g, '半角问号'],
  [/[\u4e00-\u9fa5]![\u4e00-\u9fa5]/g, '半角叹号'],
]

for (const file of files) {
  let buf
  try { buf = readFileSync(file) } catch { continue }
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) problems.bom.push(file)
  let s = buf.toString('utf8')
  const orig = s

  if (s.includes('\uFFFD')) problems.fffd.push(file)
  if (/[\u200B-\u200D\u2060\uFEFF]/.test(s)) problems.zeroWidth.push(file)

  let shenCount = 0
  if (s.includes('沈沈')) {
    shenCount = (s.match(/沈沈/g) || []).length
    problems.沈沈.push(file + ' × ' + shenCount)
  }
  for (const [re, name] of asciiRules) {
    const hits = s.match(re) || []
    if (hits.length) problems.asciiPunct.push(file + ' ' + name + ' × ' + hits.length)
  }
  const dups = s.match(/[，。、；：！？]{2,}/g) || []
  if (dups.length) problems.dupPunct.push(file + ' × ' + dups.length)

  if (FIX) {
    const before = s
    s = s.replace(/沈沈/g, '沉沉')
    s = s.replace(/([\u4e00-\u9fa5]),([\u4e00-\u9fa5])/g, '$1，$2')
    s = s.replace(/([\u4e00-\u9fa5]);([\u4e00-\u9fa5])/g, '$1；$2')
    s = s.replace(/([\u4e00-\u9fa5]):([\u4e00-\u9fa5])/g, '$1：$2')
    s = s.replace(/([\u4e00-\u9fa5])\?([\u4e00-\u9fa5])/g, '$1？$2')
    s = s.replace(/([\u4e00-\u9fa5])!([\u4e00-\u9fa5])/g, '$1！$2')
    if (s !== before) {
      writeFileSync(file, s, 'utf8')
      fixedShen += shenCount
      fixedAscii += 1
    }
  }
  if (s !== orig) { /* 已写回 */ }
}

const show = (name, arr, limit = 8) => {
  console.log('\n  [' + name + '] ' + arr.length + ' 个文件')
  arr.slice(0, limit).forEach((x) => console.log('    ' + x))
  if (arr.length > limit) console.log('    …共 ' + arr.length + ' 个文件')
}

console.log('  扫描 ' + files.length + ' 个数据文件' + (FIX ? '（--fix 模式）' : '（只报告）'))
show('异体字 沈沈→沉沉', problems.沈沈)
show('半角标点夹在汉字中', problems.asciiPunct)
show('乱码 U+FFFD', problems.fffd)
show('BOM 头', problems.bom)
show('零宽字符', problems.zeroWidth)
show('连续重复标点（只统计，需人工判断）', problems.dupPunct)

if (FIX) console.log('\n  已修：沈沈 ' + fixedShen + ' 处；含半角标点的文件 ' + fixedAscii + ' 个')

// 退出码：①②③④⑤ 任一存在即失败（方便接进 npm test）
const hard = problems.沈沈.length + problems.asciiPunct.length + problems.fffd.length + problems.bom.length + problems.zeroWidth.length
if (hard > 0) {
  console.log('\n  ❌ 有 ' + hard + ' 项确定性问题')
  process.exit(1)
}
console.log('\n  ✅ 确定性问题为 0（重复标点仅统计）')
