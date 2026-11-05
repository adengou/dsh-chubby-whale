/**
 * client/image.ts —— 图片压缩（省 token / 省上传时间）
 *
 * 视觉模型按像素计费且要上传 base64：手机截屏/照片动辄 3–4 MB，
 * 直接传既慢又贵。这里统一压到「长边 ≤ 1280、JPEG 0.85」，
 * 体积通常降到 1/10 以内，识别效果几乎无感。
 *
 * 原则：**压缩失败一律回退原图**，绝不因为压缩把看图功能弄挂。
 */

export interface CompressedImage {
  /** 去掉 data: 前缀的 base64 */
  b64: string
  /** 压缩后的 MIME（成功压缩则为 image/jpeg） */
  mime: string
  /** 压缩后像素尺寸（未知时为 0） */
  width: number
  height: number
  /** 是否真的压缩了（false = 原图回退） */
  compressed: boolean
}

const DEFAULT_MAX_EDGE = 1280
const DEFAULT_QUALITY = 0.85
/** 原图 base64 小于这个就不折腾（本来就不费 token） */
const KEEP_RAW_BELOW = 400 * 1024

/** 把 File/Blob 读成 data URL 去掉前缀的 base64；失败返回 '' */
export function readFileAsBase64(file: any): Promise<string> {
  return new Promise((resolve) => {
    try {
      const fr = new FileReader()
      fr.onloadend = () => {
        const s = String((fr as any).result || '')
        resolve(s.indexOf(',') >= 0 ? s.slice(s.indexOf(',') + 1) : s)
      }
      fr.onerror = () => resolve('')
      fr.readAsDataURL(file)
    } catch (e) {
      resolve('')
    }
  })
}

/** 解码出可绘制的图像；优先 createImageBitmap，退化到 Image + objectURL */
function decodeImage(file: any): Promise<any | null> {
  return new Promise((resolve) => {
    try {
      const w: any = typeof window !== 'undefined' ? window : globalThis
      if (typeof w.createImageBitmap === 'function') {
        Promise.resolve(w.createImageBitmap(file)).then((bmp: any) => resolve(bmp)).catch(() => resolve(null))
        return
      }
      const URLRef: any = w.URL || (globalThis as any).URL
      const ImageRef: any = w.Image
      if (!URLRef || typeof URLRef.createObjectURL !== 'function' || typeof ImageRef !== 'function') {
        resolve(null)
        return
      }
      const url = URLRef.createObjectURL(file)
      const img = new ImageRef()
      const done = (v: any) => {
        try { URLRef.revokeObjectURL(url) } catch (e) { }
        resolve(v)
      }
      img.onload = () => done(img)
      img.onerror = () => done(null)
      img.src = url
    } catch (e) {
      resolve(null)
    }
  })
}

/** 把文件压成适合视觉模型的 base64；任何环节失败都回退原图 */
export async function imageToB64(file: any, opts?: { maxEdge?: number; quality?: number }): Promise<CompressedImage | null> {
  const raw = await readFileAsBase64(file)
  if (!raw) return null
  const rawMime = String((file && file.type) || 'image/jpeg')
  const rawResult: CompressedImage = { b64: raw, mime: rawMime, width: 0, height: 0, compressed: false }
  try {
    // 已经够小：不压（省一次 canvas 编解码）
    if (raw.length <= KEEP_RAW_BELOW) return rawResult

    const maxEdge = Math.max(256, Math.min(4096, Math.round(Number(opts && opts.maxEdge) || DEFAULT_MAX_EDGE)))
    const quality = Math.min(0.95, Math.max(0.5, Number(opts && opts.quality) || DEFAULT_QUALITY))

    const img = await decodeImage(file)
    if (!img) return rawResult
    const iw = Math.max(1, Number(img.width || img.naturalWidth) || 1)
    const ih = Math.max(1, Number(img.height || img.naturalHeight) || 1)
    const scale = Math.min(1, maxEdge / Math.max(iw, ih))
    const w = Math.max(1, Math.round(iw * scale))
    const h = Math.max(1, Math.round(ih * scale))

    const doc: any = typeof document !== 'undefined' ? document : null
    if (!doc || typeof doc.createElement !== 'function') return rawResult
    const canvas: any = doc.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const cx: any = canvas.getContext && canvas.getContext('2d')
    if (!cx || typeof canvas.toDataURL !== 'function') return rawResult
    cx.drawImage(img, 0, 0, w, h)
    const dataUrl = String(canvas.toDataURL('image/jpeg', quality) || '')
    const at = dataUrl.indexOf(',')
    const b64 = at >= 0 ? dataUrl.slice(at + 1) : ''
    if (!b64) return rawResult
    // 压完反而更大（小图/透明图）：用原图
    if (b64.length >= raw.length) return rawResult
    if (typeof img.close === 'function') { try { img.close() } catch (e) { } }
    return { b64, mime: 'image/jpeg', width: w, height: h, compressed: true }
  } catch (e) {
    return rawResult
  }
}
