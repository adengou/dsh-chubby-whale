/**
 * scripts/test-scribe-docx.mjs —— 「小鲸代笔」DOCX 生成器回归（纯离线，不写真实文件）
 *
 * 2026-11-14 主人 7 条改版后的模型：面板正文是整篇 text，按 \n 分段。
 * 覆盖：
 *   · XML 转义：< & > " '、控制字符、& 不能二次转义；
 *   · text → 段落：每个非空行一个 <w:p>，空行保留空段落（<w:p/>），CRLF 归一；
 *   · OOXML part 齐全（[Content_Types].xml / _rels/.rels / word/document.xml / …）；
 *   · 自己手写的 STORE ZIP：EOCD/中央目录/本地头可被独立解析，CRC32 与内容对得上；
 *   · 相同输入（含注入时间）字节完全一致；空正文也能生成合法包；
 *   · TXT 原样保存全文；无第三方依赖（源码级检查）。
 *
 * 这个测试自带一个最小 ZIP 解包器（只认 STORE，不依赖任何库），
 * 所以生成器的字节布局被独立验证，而不是拿实现自己的函数自证。
 *
 * 用法：node scripts/test-scribe-docx.mjs   （全过退出码 0）
 */

import { register } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

register(new URL('./ts-resolve.mjs', import.meta.url))

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.error('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const show = (v) => (v === null || typeof v === 'undefined' ? String(v) : JSON.stringify(v))

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const M = await import('../src/client/scribe-docx.ts')
const { buildScribeDocx, scribeDocxParts, scribeDocxFileName, scribeTxt, xmlEscape, crc32, utf8Bytes, zipStore } = M

// ======================================================================
// 最小 ZIP 解包器（独立实现，避免拿被测函数自证）
// ======================================================================
const CRC_TABLE = (() => {
  const t = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t.push(c >>> 0)
  }
  return t
})()
function crcRef(bytes) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}
function u16(buf, at) { return buf[at] | (buf[at + 1] << 8) }
function u32(buf, at) { return (buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16) | (buf[at + 3] << 24)) >>> 0 }
const decoder = new TextDecoder('utf-8')

/** 解析 STORE ZIP → [{name, data, method, crc, compSize, uncompSize, localSigOk}] */
function unzip(buf) {
  if (!(buf instanceof Uint8Array)) throw new Error('不是 Uint8Array')
  // 找 EOCD：从尾部往前扫（注释最长 65535）
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
    if (u32(buf, i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('找不到 EOCD')
  const disk = u16(buf, eocd + 4)
  const cdDisk = u16(buf, eocd + 6)
  const count = u16(buf, eocd + 10)
  const cdSize = u32(buf, eocd + 12)
  const cdOffset = u32(buf, eocd + 16)
  if (disk !== 0 || cdDisk !== 0) throw new Error('多磁盘 ZIP 不支持')
  if (cdOffset + cdSize !== eocd) throw new Error('中央目录偏移/大小与 EOCD 对不上')
  const out = []
  let at = cdOffset
  for (let i = 0; i < count; i++) {
    if (u32(buf, at) !== 0x02014b50) throw new Error('中央目录签名不对 @' + at)
    const method = u16(buf, at + 10)
    const crc = u32(buf, at + 16)
    const compSize = u32(buf, at + 20)
    const uncompSize = u32(buf, at + 24)
    const nameLen = u16(buf, at + 28)
    const extraLen = u16(buf, at + 30)
    const commentLen = u16(buf, at + 32)
    const localOffset = u32(buf, at + 42)
    const name = decoder.decode(buf.slice(at + 46, at + 46 + nameLen))
    const localSigOk = u32(buf, localOffset) === 0x04034b50
    const localNameLen = u16(buf, localOffset + 26)
    const localExtraLen = u16(buf, localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    if (dataStart + compSize > buf.length) throw new Error('数据越界：' + name)
    const data = buf.slice(dataStart, dataStart + compSize)
    out.push({ name, data, method, crc, compSize, uncompSize, localSigOk })
    at += 46 + nameLen + extraLen + commentLen
  }
  return out
}
function entriesOf(buf) {
  const map = {}
  for (const e of unzip(buf)) map[e.name] = decoder.decode(e.data)
  return map
}
function bytesEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
/** document.xml 里的段落数组（<w:p/> 记空串） */
function paragraphsOf(xml) {
  const out = []
  const re = /<w:p\/>|<w:p><w:r><w:t xml:space="preserve">([\s\S]*?)<\/w:t><\/w:r><\/w:p>/g
  let m
  while ((m = re.exec(xml))) out.push(m[1] === undefined ? '' : m[1])
  return out
}

// ======================================================================
console.log('\n[A] XML 转义')
{
  ok('& 最先转义、不二次转义', xmlEscape('a & b') === 'a &amp; b' && xmlEscape('&lt;') === '&amp;lt;')
  ok('< > 转义', xmlEscape('<第一句>') === '&lt;第一句&gt;')
  ok('双引号/单引号转义', xmlEscape('"双" \'单\'') === '&quot;双&quot; &apos;单&apos;')
  ok('控制字符被剔除（\\u0001）', xmlEscape('a\u0001b') === 'ab')
  ok('制表符/换行等合法空白保留', xmlEscape('a\tb') === 'a\tb')
  ok('null/undefined 变空串', xmlEscape(null) === '' && xmlEscape(undefined) === '')
  ok('中文原样保留', xmlEscape('小鲸代笔·一句一落') === '小鲸代笔·一句一落')
}

// ======================================================================
console.log('\n[B] text → 段落：每行一段、空行保留空段落、转义、顺序')
{
  const now = new Date(2026, 10, 14, 16, 5, 0)
  const text = '<第一段> & "引号"\n第二段\n\n第四段（第三段是空行）'
  const parts = scribeDocxParts({ title: '我的稿子 & 测试', text, now })
  const names = parts.map((p) => p.name)
  ok('六个 part 齐全且顺序确定', eq(names, [
    '[Content_Types].xml', '_rels/.rels', 'word/document.xml',
    'word/_rels/document.xml.rels', 'docProps/core.xml', 'docProps/app.xml',
  ]), names.join(' / '))
  const doc = parts.find((p) => p.name === 'word/document.xml').text
  const paras = paragraphsOf(doc)
  ok('按 \\n 分成 4 段（含 1 个空行）', paras.length === 4, show(paras))
  ok('空行保留为空段落', paras[2] === '')
  ok('段落顺序与正文一致', paras[0].indexOf('&lt;第一段&gt;') >= 0 && paras[1] === '第二段' && paras[3].indexOf('第四段') >= 0)
  ok('正文特殊字符已转义（不会破坏文档）', doc.indexOf('&lt;第一段&gt; &amp; &quot;引号&quot;') >= 0)
  ok('正文段落用 xml:space="preserve" 保留首尾空格', doc.indexOf('xml:space="preserve"') >= 0)
  ok('含 WordprocessingML 命名空间与 sectPr', doc.indexOf('http://schemas.openxmlformats.org/wordprocessingml/2006/main') >= 0 && doc.indexOf('<w:sectPr>') >= 0)
  const core = parts.find((p) => p.name === 'docProps/core.xml').text
  ok('标题写进 core.xml 且已转义', core.indexOf('<dc:title>我的稿子 &amp; 测试</dc:title>') >= 0)
  ok('创建/修改时间用注入时刻（W3CDTF）', core.indexOf('2026-11-14T') >= 0 && core.indexOf(':05:00Z') >= 0)
  const ct = parts.find((p) => p.name === '[Content_Types].xml').text
  ok('Content_Types 声明了 document.xml 的 main+xml 类型', ct.indexOf('word/document.xml') >= 0 && ct.indexOf('wordprocessingml.document.main+xml') >= 0)
  const rels = parts.find((p) => p.name === '_rels/.rels').text
  ok('包级关系指向 word/document.xml', rels.indexOf('Target="word/document.xml"') >= 0)
  ok('空标题回落「小鲸代笔」', scribeDocxParts({ text: '' }).find((p) => p.name === 'docProps/core.xml').text.indexOf('<dc:title>小鲸代笔</dc:title>') >= 0)

  // 回车/空行语义：用户输入什么就分什么段
  ok('CRLF 归一成段落分隔', paragraphsOf(scribeDocxParts({ text: '甲\r\n乙\r丙' }).find((p) => p.name === 'word/document.xml').text).join('|') === '甲|乙|丙')
  ok('连续两个空行 → 两个空段落', (() => {
    const p = paragraphsOf(scribeDocxParts({ text: '甲\n\n\n乙' }).find((x) => x.name === 'word/document.xml').text)
    return p.length === 4 && p[1] === '' && p[2] === ''
  })())
  ok('结尾回车 → 末尾一个空段落', (() => {
    const p = paragraphsOf(scribeDocxParts({ text: '甲\n' }).find((x) => x.name === 'word/document.xml').text)
    return p.length === 2 && p[0] === '甲' && p[1] === ''
  })())
  ok('空正文 → 0 段但有 sectPr（合法文档）', (() => {
    const xml = scribeDocxParts({ text: '' }).find((p) => p.name === 'word/document.xml').text
    return paragraphsOf(xml).length === 0 && xml.indexOf('<w:body>') >= 0 && xml.indexOf('<w:sectPr>') >= 0
  })())
  ok('旧 sentences 数组输入兼容（按行拼成正文）', paragraphsOf(scribeDocxParts({ sentences: ['甲', '乙'] }).find((p) => p.name === 'word/document.xml').text).join('|') === '甲|乙')
}

// ======================================================================
console.log('\n[C] ZIP 字节：可独立解包、CRC 对得上、确定性')
{
  ok('CRC32 已知向量：123456789 → 0xCBF43926', crc32(utf8Bytes('123456789')) === 0xCBF43926, '0x' + crc32(utf8Bytes('123456789')).toString(16))
  const now = new Date(2026, 10, 14, 16, 5, 0)
  const bytes = buildScribeDocx({ title: '标题', text: '第一段。\n第二段！', now })
  ok('返回 Uint8Array 且以 PK\\x03\\x04 开头', bytes instanceof Uint8Array && u32(bytes, 0) === 0x04034b50)
  const entries = unzip(bytes)
  ok('解包条目数 = 6', entries.length === 6, String(entries.length))
  ok('每个条目都是 STORE（method=0）、本地头签名正确', entries.every((e) => e.method === 0 && e.localSigOk))
  ok('每个条目 CRC32 与中央目录一致', entries.every((e) => crcRef(e.data) === e.crc))
  ok('每个条目压缩/原始大小一致（未压缩）', entries.every((e) => e.compSize === e.uncompSize && e.uncompSize === e.data.length))
  const map = entriesOf(bytes)
  ok('解包后 document.xml 与 parts 生成内容逐字一致',
    map['word/document.xml'] === scribeDocxParts({ title: '标题', text: '第一段。\n第二段！', now }).find((p) => p.name === 'word/document.xml').text)
  ok('UTF-8 中文能正确解出', map['word/document.xml'].indexOf('第一段。') >= 0 && map['word/document.xml'].indexOf('第二段！') >= 0)
  ok('document.xml 里正好两个段落', paragraphsOf(map['word/document.xml']).length === 2)
  ok('[Content_Types].xml / _rels/.rels / docProps 都能解出', !!map['[Content_Types].xml'] && !!map['_rels/.rels'] && !!map['docProps/core.xml'] && !!map['docProps/app.xml'])

  const twice = buildScribeDocx({ title: '标题', text: '第一段。\n第二段！', now })
  ok('相同输入（含注入时间）字节完全一致', bytesEqual(bytes, twice))
  const other = buildScribeDocx({ title: '标题', text: '第一段。\n第二段！', now: new Date(2026, 10, 15, 9, 30, 0) })
  ok('不同时间生成不同字节（时间进了 ZIP 头/core.xml）', !bytesEqual(bytes, other))

  const empty = buildScribeDocx({ text: '', now })
  const emptyMap = entriesOf(empty)
  ok('空正文也能生成合法 docx（解包成功、0 段、有 sectPr）', paragraphsOf(emptyMap['word/document.xml']).length === 0 && emptyMap['word/document.xml'].indexOf('<w:sectPr>') >= 0)
  ok('zipStore 对外可单独用（parts → zip）', (() => {
    const z = zipStore([{ name: 'a.txt', text: '小鲸' }], now)
    const es = unzip(z)
    return es.length === 1 && es[0].name === 'a.txt' && decoder.decode(es[0].data) === '小鲸' && crcRef(es[0].data) === es[0].crc
  })())
}

// ======================================================================
console.log('\n[D] TXT（原样保存全文）/ 文件名 / 无第三方依赖')
{
  ok('scribeTxt 原样返回全文（保留换行/空行/首尾空格）', scribeTxt('第一段\n\n  第二段  ') === '第一段\n\n  第二段  ', show(scribeTxt('第一段\n\n  第二段  ')))
  ok('scribeTxt 空正文为空串', scribeTxt('') === '' && scribeTxt() === '')
  ok('scribeTxt 兼容旧数组输入（按行拼）', scribeTxt(['甲', '乙']) === '甲\n乙')
  ok('文件名格式：小鲸代笔-YYYYMMDD-HHmm.docx', scribeDocxFileName(new Date(2026, 10, 14, 16, 5)) === '小鲸代笔-20261114-1605.docx', scribeDocxFileName(new Date(2026, 10, 14, 16, 5)))
  const src = readFileSync(join(ROOT, 'src/client/scribe-docx.ts'), 'utf8')
  ok('没有第三方 import / require', !/^\s*import\s/m.test(src) && !/require\s*\(/.test(src))
  ok('没有 Node fs/path 等内置模块依赖', !/from\s+['"](node:)?(fs|path|zlib)['"]/.test(src))
}

// ======================================================================
console.log('\n────────────────────')
if (fail === 0) console.log('✅ 通过 ' + pass + ' 项，失败 0 项')
else console.log('❌ 通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
