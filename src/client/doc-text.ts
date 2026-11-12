/**
 * client/doc-text.ts —— 把外接文档读成纯文本（零第三方依赖）
 *
 * 支持：
 *   · .txt / .md / .json / .log / .csv —— File.text() 直接读
 *   · .docx —— 浏览器原生 DecompressionStream 解 zip，DOMParser 抽 word/document.xml
 *   · .pdf —— 不支持：解析要第三方库，违背「无第三方依赖」；调用方给一句明确提示
 *
 * 交互入口（选文件框）也在这里，两个菜单动作共用，避免各写一份。
 */

const PLAIN_EXTS = ['.txt', '.md', '.json', '.log', '.csv']
/** 全部支持的扩展名（含 docx）；文件框的「所有文件」绕过 accept 时靠它兜底 */
const ALLOWED_EXTS = ['.txt', '.md', '.json', '.log', '.csv', '.docx']
/** 文档体积上限：一份正常公文远小于此，超过基本是把整本合集拖进来了 */
export const MAX_DOC_BYTES = 20 * 1024 * 1024
/** 选中文件的 accept 串：不含 pdf，避免用户选了才被拒 */
export const DOC_ACCEPT = '.txt,.md,.json,.log,.csv,.docx'

export type DocReadResult =
  | { ok: true; kind: 'plain' | 'docx'; text: string }
  | { ok: false; kind: 'unsupported' | 'error'; error: string }

function extOf(name: string): string {
  const n = String(name || '').toLowerCase()
  const i = n.lastIndexOf('.')
  return i >= 0 ? n.slice(i) : ''
}

/** 扩展名在支持清单里才放行；调用方在读文件**之前**用它拦截 */
export function isSupportedDocName(name: string): boolean {
  return ALLOWED_EXTS.indexOf(extOf(name)) >= 0
}

/** 程序化弹文件选择框；用户取消返回 null（不抛错） */
export function pickDocument(): Promise<File | null> {
  return new Promise((resolve) => {
    try {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = DOC_ACCEPT
      input.style.display = 'none'
      let settled = false
      const done = (f: File | null): void => {
        if (settled) return
        settled = true
        try { input.remove() } catch (e) { }
        resolve(f)
      }
      input.addEventListener('change', () => {
        const f = input.files && input.files[0] ? input.files[0] : null
        done(f)
      })
      // 取消选择不会触发 change（部分浏览器），窗口重新聚焦时兜底。
      // 留 1.5 秒余量：慢机器上 change 可能晚于 focus，300ms 会把「选了文件」误判成取消。
      window.addEventListener('focus', () => {
        setTimeout(() => {
          if (!input.files || !input.files.length) done(null)
        }, 1500)
      }, { once: true })
      document.body.appendChild(input)
      input.click()
    } catch (e) {
      resolve(null)
    }
  })
}

// ---------- zip（docx 解包用，只支持 store / deflate） ----------

function u16(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8)) & 0xffff
}

function u32(b: Uint8Array, o: number): number {
  return ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0)
}

function findEocd(b: Uint8Array): number {
  const min = Math.max(0, b.length - 66000)
  for (let i = b.length - 22; i >= min; i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) return i
  }
  return -1
}

async function inflateRaw(data: Uint8Array, method: number): Promise<Uint8Array> {
  if (method === 0) return data
  if (method !== 8) throw new Error('不支持的压缩方式：' + method)
  const DS: any = (globalThis as any).DecompressionStream
  if (!DS) throw new Error('当前浏览器不支持 DecompressionStream，读不了 docx')
  const stream = new Blob([data as any]).stream().pipeThrough(new DS('deflate-raw'))
  const out = await new Response(stream).arrayBuffer()
  return new Uint8Array(out)
}

/** 从 zip 里取一个条目（不校验 CRC：只读一次展示用，坏了会解压失败） */
async function extractZipEntry(zip: Uint8Array, want: string): Promise<Uint8Array | null> {
  const eocd = findEocd(zip)
  if (eocd < 0) throw new Error('不是有效的 zip（找不到目录区）')
  const total = u16(zip, eocd + 10)
  let p = u32(zip, eocd + 16) // central directory 起始偏移
  const decoder = new TextDecoder('utf-8')
  for (let i = 0; i < total; i++) {
    if (u32(zip, p) !== 0x02014b50) break
    const method = u16(zip, p + 10)
    const compSize = u32(zip, p + 20)
    const nameLen = u16(zip, p + 28)
    const extraLen = u16(zip, p + 30)
    const commentLen = u16(zip, p + 32)
    const localOff = u32(zip, p + 42)
    const name = decoder.decode(zip.subarray(p + 46, p + 46 + nameLen))
    if (name === want) {
      const lNameLen = u16(zip, localOff + 26)
      const lExtraLen = u16(zip, localOff + 28)
      const start = localOff + 30 + lNameLen + lExtraLen
      return inflateRaw(zip.subarray(start, start + compSize), method)
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  return null
}

/** word/document.xml → 纯文本：按 <w:p> 分段，段内 <w:t> 拼接 */
function docxXmlToText(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const paras = doc.getElementsByTagNameNS('*', 'p')
  const lines: string[] = []
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i]
    const ts = p.getElementsByTagNameNS('*', 't')
    let s = ''
    for (let j = 0; j < ts.length; j++) s += ts[j].textContent || ''
    lines.push(s)
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

async function readDocx(file: File): Promise<string> {
  const zip = new Uint8Array(await file.arrayBuffer())
  const xmlBuf = await extractZipEntry(zip, 'word/document.xml')
  if (!xmlBuf) throw new Error('docx 里没找到 word/document.xml')
  return docxXmlToText(new TextDecoder('utf-8').decode(xmlBuf))
}

/** 读一个文件为纯文本；不支持的格式给明确原因，不猜 */
export async function readDocumentText(file: File): Promise<DocReadResult> {
  try {
    if (!file) return { ok: false, kind: 'error', error: '没有文件' }
    if (file.size > MAX_DOC_BYTES) return { ok: false, kind: 'error', error: '文件太大（20MB 上限）' }
    const ext = extOf(file.name)
    if (PLAIN_EXTS.indexOf(ext) >= 0) {
      const text = await file.text()
      return { ok: true, kind: 'plain', text }
    }
    if (ext === '.docx') {
      const text = await readDocx(file)
      if (!text) return { ok: false, kind: 'error', error: '文档里没有文字' }
      return { ok: true, kind: 'docx', text }
    }
    if (ext === '.pdf') return { ok: false, kind: 'unsupported', error: 'PDF 读不了（要第三方解析库），先转成 docx 或 txt' }
    return { ok: false, kind: 'unsupported', error: '只支持 txt / md / json / log / csv / docx' }
  } catch (e: any) {
    return { ok: false, kind: 'error', error: String((e && e.message) || e) }
  }
}
