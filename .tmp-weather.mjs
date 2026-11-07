// fix-weather-lang.mjs —— wttr.in 语言参数必须是 zh-cn（实测 lang=zh 仍回英文）
import { readFileSync, writeFileSync } from 'node:fs'

const p = 'src/host/routes/briefing.ts'
let s = readFileSync(p, 'utf8')

const oldUrl = 'https://wttr.in/Beihai?format=%C+%t&lang=zh'
const newUrl = 'https://wttr.in/Beihai?format=%C+%t&lang=zh-cn'
if (!s.includes(oldUrl)) throw new Error('天气 URL 未找到')
s = s.replace(oldUrl, newUrl)

const oldDoc = '  /** 天气外呼超时：wttr.in 偶发很慢，到点就放掉，简报其它段不能陪它等 */'
if (!s.includes(oldDoc)) throw new Error('超时注释未找到')
s = s.replace(
  oldDoc,
  [
    '  /**',
    '   * 天气外呼超时：wttr.in 偶发很慢，到点就放掉，简报其它段不能陪它等。',
    '   *',
    '   * 语言参数必须是 zh-cn（2026-11-07 实测）：wttr.in 对 lang=zh 仍回英文',
    '   * （Patchy rain nearby +27°C），lang=zh-cn 才给「附近有零星降雨 +27°C」。',
    '   * 主人截图里那句英文就是这条参数写错造成的。',
    '   */',
  ].join('\n'),
)

writeFileSync(p, s, 'utf8')
console.log('已改为 zh-cn:', s.includes('lang=zh-cn'))
