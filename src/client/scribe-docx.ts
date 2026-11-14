/**
 * client/scribe-docx.ts —— 把代笔面板的正文生成为最小 OOXML .docx（纯函数，无第三方依赖）
 *
 * 为什么自己写：插件运行在浏览器端（client bundle），不能依赖 Node 的 fs/zip 库；
 * 用户点「保存 → DOCX 文档」时只需要一个 Word 能打开的最小包，不需要样式、图片、页眉页脚。
 * 这里用「STORE（不压缩）」方式手写 ZIP + OOXML 三件套：
 *
 *   [Content_Types].xml          声明各 part 的 MIME
 *   _rels/.rels                  包级关系：officeDocument → word/document.xml
 *   word/document.xml            正文：按 \n 分段，每行一个 <w:p>（空行保留空段落 <w:p/>）
 *   word/_rels/document.xml.rels 空的文档级关系（Word 打开时更稳）
 *   docProps/core.xml            标题 / 作者 / 创建时间
 *   docProps/app.xml             生成程序名
 *
 * 约束：
 *   · 纯函数：不读文件、不弹窗、不写 localStorage、不调用 fetch；
 *   · 所有正文走 xmlEscape()，`< & > " '` 与控制字符都处理，句子里的尖括号不会把 XML 弄坏；
 *   · 返回 Uint8Array，调用方自己决定 Blob 下载还是测试里解包校验。
 *
 * 测试（scripts/test-scribe-docx.mjs）会按 ZIP 中央目录逐项解包并核对 CRC32，
 * 所以这里的字节布局是**受测试钉住**的，改 ZIP 结构要同步改测试。
 */

/** 保存 DOCX 时浏览器 Blob 的 MIME（Word 认这个类型） */
export const SCRIBE_DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export type ScribeDocxInput = {
  /** 文档标题（写进 docProps/core.xml；缺省「小鲸代笔」） */
  title?: string
  /**
   * 面板正文全文（唯一文档状态）：按 \n 分段，每个非空行一个 <w:p>；
   * 空行保留空段落（<w:p/>）；\r\n / \r 会先归一成 \n。
   */
  text?: string
  /** 兼容旧调用：没有 text 时把字符串数组按行拼成正文 */
  sentences?: string[]
  /** 生成时刻（测试注入；缺省 new Date()） */
  now?: Date
}

export type ScribeDocxPart = {
  /** ZIP 内路径（ASCII，正斜杠） */
  name: string
  /** UTF-8 文本内容 */
  text: string
}

/** XML 1.0 不允许的控制字符（保留 \t \n \r），其余直接去掉，避免 Word 报「文件损坏」 */
const XML_CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

/**
 * XML 文本转义：& 必须最先换，否则会把后面生成的 &lt; 再转一遍。
 * 单引号/双引号也转（句子可能出现在属性位置以外的文本里，统一口径最省心）。
 */
export function xmlEscape(text: string): string {
  return String(text == null ? '' : text)
    .replace(XML_CTRL_RE, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * 正文 → 段落数组：按 \n 分段，**保留空行**（空行就是空段落，符合 Word 直觉）。
 * 换行符先归一化；空字符串正文返回空数组（生成只有 sectPr 的合法文档）。
 */
function textParagraphs(text: any): string[] {
  const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n')
  if (!src) return []
  return src.split('\n')
}

/** 输入统一成正文全文：优先 text；旧调用可传 sentences 数组（按行拼） */
function inputText(input: ScribeDocxInput): string {
  if (typeof input.text === 'string') return input.text
  if (Array.isArray(input.sentences)) {
    return input.sentences.map((s) => String(s == null ? '' : s)).join('\n')
  }
  return ''
}

/** W3CDTF 时间（core.xml 用）：2026-11-14T16:00:00Z */
function w3cTime(d: Date): string {
  try {
    const iso = d.toISOString()
    return iso.replace(/\.\d{3}Z$/, 'Z')
  } catch (e) {
    return '1970-01-01T00:00:00Z'
  }
}

/** OOXML 正文：每行一个 <w:p>，空行保留空段落；空正文也能生成合法文档（只有 sectPr） */
function documentXml(paragraphs: string[]): string {
  const body = paragraphs.map((line) => {
    // 空行 = 空段落（Word 里表现为一个空行）
    if (line === '') return '<w:p/>'
    // xml:space="preserve"：保留句首/句尾空格（Word 默认会折叠）
    return '<w:p><w:r><w:t xml:space="preserve">' + xmlEscape(line) + '</w:t></w:r></w:p>'
  }).join('')
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:body>' + body
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
    + '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'
    + '</w:sectPr></w:body></w:document>'
}

/** 组装 .docx 的所有 part（导出给测试用：可以不建 zip 就检查 XML） */
export function scribeDocxParts(input: ScribeDocxInput = {}): ScribeDocxPart[] {
  const title = String(input.title == null ? '' : input.title).trim() || '小鲸代笔'
  const paragraphs = textParagraphs(inputText(input))
  const now = input.now instanceof Date && !isNaN(input.now.getTime()) ? input.now : new Date()
  const stamp = w3cTime(now)
  const escTitle = xmlEscape(title)

  return [
    {
      name: '[Content_Types].xml',
      text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
        + '</Types>',
    },
    {
      name: '_rels/.rels',
      text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
        + '</Relationships>',
    },
    {
      name: 'word/document.xml',
      text: documentXml(paragraphs),
    },
    {
      name: 'word/_rels/document.xml.rels',
      text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    },
    {
      name: 'docProps/core.xml',
      text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"'
        + ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"'
        + ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        + '<dc:title>' + escTitle + '</dc:title>'
        + '<dc:creator>小鲸代笔</dc:creator>'
        + '<cp:lastModifiedBy>小鲸代笔</cp:lastModifiedBy>'
        + '<dcterms:created xsi:type="dcterms:W3CDTF">' + stamp + '</dcterms:created>'
        + '<dcterms:modified xsi:type="dcterms:W3CDTF">' + stamp + '</dcterms:modified>'
        + '</cp:coreProperties>',
    },
    {
      name: 'docProps/app.xml',
      text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
        + '<Application>小鲸代笔</Application>'
        + '</Properties>',
    },
  ]
}

/** TXT 保存内容：正文原样（空正文返回空串；兼容旧的字符串数组按行拼） */
export function scribeTxt(text?: string | string[]): string {
  if (Array.isArray(text)) return text.map((s) => String(s == null ? '' : s)).join('\n')
  return String(text == null ? '' : text)
}

/** 文件名：小鲸代笔-20261114-1630.docx（按本地时间，补零） */
export function scribeDocxFileName(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const d = now instanceof Date && !isNaN(now.getTime()) ? now : new Date()
  return '小鲸代笔-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.docx'
}

// ======================================================================
// ZIP 写入（STORE，不压缩）—— 只服务上面的 OOXML 文本 part
// ======================================================================

/** CRC32 查表（ZIP 用的就是 IEEE 802.3 多项式 0xEDB88320） */
const CRC_TABLE: number[] = (() => {
  const table: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    table.push(c >>> 0)
  }
  return table
})()

const UTF8_ENCODER: { encode: (s: string) => Uint8Array } = (() => {
  try {
    return new TextEncoder()
  } catch (e) {
    // 理论上不会走到：现代浏览器与 Node 都有 TextEncoder。真没有就抛给调用方，绝不静默生成坏文件。
    return { encode: (): Uint8Array => { throw new Error('TextEncoder 不可用，无法生成 docx') } }
  }
})()

/** 字符串 → UTF-8 字节 */
export function utf8Bytes(text: string): Uint8Array {
  return UTF8_ENCODER.encode(String(text == null ? '' : text))
}

/** CRC32：与 ZIP 中央目录里的 crc-32 字段同口径 */
export function crc32(bytes: Uint8Array): number {
  let c = 0xFFFFFFFF
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

/** DOS 时间/日期（ZIP 头字段；年份 1980 起算，秒按 2 秒精度） */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, d.getFullYear()))
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  return { time: time & 0xFFFF, date: date & 0xFFFF }
}

/** 动态字节数组（比反复拼接 number[] 快，也避免超长字符串） */
class ByteWriter {
  private buf: Uint8Array
  private len = 0

  constructor(capacity = 1024) {
    this.buf = new Uint8Array(Math.max(64, capacity))
  }

  private ensure(extra: number): void {
    const need = this.len + extra
    if (need <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < need) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
  }

  bytes(data: Uint8Array): void {
    this.ensure(data.length)
    this.buf.set(data, this.len)
    this.len += data.length
  }

  u16(v: number): void {
    this.ensure(2)
    this.buf[this.len++] = v & 0xFF
    this.buf[this.len++] = (v >>> 8) & 0xFF
  }

  u32(v: number): void {
    this.ensure(4)
    this.buf[this.len++] = v & 0xFF
    this.buf[this.len++] = (v >>> 8) & 0xFF
    this.buf[this.len++] = (v >>> 16) & 0xFF
    this.buf[this.len++] = (v >>> 24) & 0xFF
  }

  result(): Uint8Array {
    return this.buf.slice(0, this.len)
  }

  get length(): number {
    return this.len
  }
}

const ZIP_LOCAL_SIG = 0x04034b50
const ZIP_CENTRAL_SIG = 0x02014b50
const ZIP_EOCD_SIG = 0x06054b50
/** 通用位标记第 11 位：文件名是 UTF-8（这里文件名全 ASCII，但显式声明不吃亏） */
const ZIP_FLAG_UTF8 = 0x0800
const ZIP_VERSION = 20 // 2.0：支持 STORE
/** 外部属性：普通文件（unix 0644 << 16），Word 不校验，但正规一些 */
const ZIP_EXTERNAL_ATTR = (0o100644 << 16) >>> 0

type ZipEntry = { name: Uint8Array; data: Uint8Array; crc: number; offset: number; time: number; date: number }

/**
 * 把若干 UTF-8 文本 part 打成 ZIP（STORE）。返回完整 .zip 字节。
 * 纯内存、无 IO；条目顺序 = parts 顺序（测试可预测）。
 */
export function zipStore(parts: ScribeDocxPart[], now: Date = new Date()): Uint8Array {
  const { time, date } = dosDateTime(now)
  const writer = new ByteWriter(4096)
  const entries: ZipEntry[] = []

  for (const part of Array.isArray(parts) ? parts : []) {
    const name = utf8Bytes(part.name)
    const data = utf8Bytes(part.text)
    const crc = crc32(data)
    const offset = writer.length
    entries.push({ name, data, crc, offset, time, date })
    // —— 本地文件头 ——
    writer.u32(ZIP_LOCAL_SIG)
    writer.u16(ZIP_VERSION)
    writer.u16(ZIP_FLAG_UTF8)
    writer.u16(0) // method 0 = STORE
    writer.u16(time)
    writer.u16(date)
    writer.u32(crc)
    writer.u32(data.length) // compressed size（STORE 下相等）
    writer.u32(data.length) // uncompressed size
    writer.u16(name.length)
    writer.u16(0) // extra length
    writer.bytes(name)
    writer.bytes(data)
  }

  // —— 中央目录 ——
  const centralStart = writer.length
  for (const entry of entries) {
    writer.u32(ZIP_CENTRAL_SIG)
    writer.u16(ZIP_VERSION) // version made by
    writer.u16(ZIP_VERSION) // version needed
    writer.u16(ZIP_FLAG_UTF8)
    writer.u16(0) // method STORE
    writer.u16(entry.time)
    writer.u16(entry.date)
    writer.u32(entry.crc)
    writer.u32(entry.data.length)
    writer.u32(entry.data.length)
    writer.u16(entry.name.length)
    writer.u16(0) // extra
    writer.u16(0) // comment
    writer.u16(0) // disk number start
    writer.u16(0) // internal attrs
    writer.u32(ZIP_EXTERNAL_ATTR)
    writer.u32(entry.offset)
    writer.bytes(entry.name)
  }
  const centralSize = writer.length - centralStart

  // —— EOCD ——
  writer.u32(ZIP_EOCD_SIG)
  writer.u16(0) // this disk
  writer.u16(0) // disk with central dir
  writer.u16(entries.length)
  writer.u16(entries.length)
  writer.u32(centralSize)
  writer.u32(centralStart)
  writer.u16(0) // comment length

  return writer.result()
}

/**
 * 生成完整 .docx 字节（最小 OOXML + STORE ZIP）。
 * 纯函数：相同输入（含 now）得到完全相同的字节，方便测试与复现。
 */
export function buildScribeDocx(input: ScribeDocxInput = {}): Uint8Array {
  const now = input.now instanceof Date && !isNaN(input.now.getTime()) ? input.now : new Date()
  return zipStore(scribeDocxParts(input), now)
}
