/**
 * scripts/gen-font.mjs —— 把泰文字体子集生成进客户端（自动生成，勿手改产物）
 *
 * 为什么：Windows 微软雅黑没有泰文字形，换泰语会显示方框；靠"用户自己装泰文字体"
 * 不是修复。这里把 Noto Sans Thai 的泰文子集（约 9KB，OFL 1.1）内联成 data URL，
 * 由客户端注入 @font-face（family: ChubbyThai），任何系统都能显示泰文。
 *
 * 输入：assets/fonts/NotoSansThai-Regular.woff2
 * 输出：src/client/thai-font.ts（base64 + @font-face CSS）
 *
 * 用法：
 *   node scripts/gen-font.mjs           # 生成
 *   node scripts/gen-font.mjs --check   # 只检查是否与字体文件一致（npm test 用）
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FONT = resolve(ROOT, 'assets/fonts/NotoSansThai-Regular.woff2')
const OUT = resolve(ROOT, 'src/client/thai-font.ts')

const buf = readFileSync(FONT)
if (buf.subarray(0, 4).toString('latin1') !== 'wOF2') {
  console.error('  ❌ 不是 woff2 文件：' + FONT)
  process.exit(1)
}
const b64 = buf.toString('base64')
const css = "@font-face{font-family:'ChubbyThai';font-style:normal;font-weight:400;font-display:swap;"
  + "src:url(data:font/woff2;base64," + b64 + ") format('woff2');"
  + 'unicode-range:U+02D7,U+0303,U+0331,U+0E01-0E5B,U+200C-200D,U+25CC;}'

const file = '/* 本文件由 scripts/gen-font.mjs 自动生成，请勿手改。\n'
  + ' * 字体：Noto Sans Thai（OFL-1.1），泰文子集内联为 data URL，见 assets/fonts/OFL.txt。\n'
  + ' * 作用：不依赖用户系统是否安装泰文字体，气泡/菜单/聊天面板都能显示泰文。\n'
  + ' */\n\n'
  + '/** 内联字体的字节数（woff2） */\n'
  + 'export const THAI_FONT_BYTES = ' + buf.length + '\n\n'
  + '/** @font-face 规则（family: ChubbyThai） */\n'
  + "export const THAI_FONT_FACE = '" + css.replace(/'/g, "\\'") + "'\n\n"
  + '/** 字体族名（style 里引用） */\n'
  + "export const THAI_FONT_FAMILY = 'ChubbyThai'\n"

if (process.argv.includes('--check')) {
  let cur = ''
  try { cur = readFileSync(OUT, 'utf8') } catch (e) { cur = '' }
  if (cur !== file) {
    console.error('  ❌ src/client/thai-font.ts 与字体文件不一致：请运行 node scripts/gen-font.mjs')
    process.exit(1)
  }
  console.log('  ✅ thai-font.ts 与 assets/fonts/NotoSansThai-Regular.woff2 一致（' + buf.length + ' B）')
  process.exit(0)
}

writeFileSync(OUT, file, 'utf8')
console.log('  ✅ 已生成 src/client/thai-font.ts（' + buf.length + ' B 字体 / ' + file.length + ' B 源码）')
