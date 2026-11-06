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
/** 原图字节数小于这个就不折腾（本来就不费 token；比较的是解码后的字节，不是 base64 字符数） */
const KEEP_RAW_BELOW = 400 * 1024

/** 读成完整 data URL；失败返回 ''（FileReader 在个别环境缺失/被禁用时同样走这里） */
function readFileAsDataUrl(file: any): Promise<string> {
  return new Promise((resolve) => {
    try {
      const fr = new FileReader()
      fr.onloadend = () => {
        try { resolve(String((fr as any).result || '')) } catch (e) { resolve('') }
      }
      fr.onerror = () => resolve('')
      fr.readAsDataURL(file)
    } catch (e) {
      resolve('')
    }
  })
}

/** 从 data URL 头里取真实 MIME（x.png 的 file.type 可能为空，但 FileReader 一定会写头） */
function mimeFromDataUrl(dataUrl: string): string {
  const m = /^data:([^;,]+)/i.exec(String(dataUrl || ''))
  return m ? m[1].toLowerCase() : ''
}

/** 把 File/Blob 读成 data URL 去掉前缀的 base64；失败返回 '' */
export async function readFileAsBase64(file: any): Promise<string> {
  const s = await readFileAsDataUrl(file)
  const at = s.indexOf(',')
  return at >= 0 ? s.slice(at + 1) : s
}

/** 解码出可绘制的图像；优先 createImageBitmap，退化到 Image + objectURL */
function decodeImage(file: any): Promise<any | null> {
  return new Promise((resolve) => {
    try {
      const w: any = typeof window !== 'undefined' ? window : globalThis
      if (typeof w.createImageBitmap === 'function') {
        // 显式声明按 EXIF 方向解码（规范默认值也是 from-image，但旧实现可能不认，
        // 不传的话竖拍照片会在 canvas 里躺倒）；不认 options 的浏览器退回单参调用。
        let p: any
        try { p = w.createImageBitmap(file, { imageOrientation: 'from-image' }) } catch (e) { p = w.createImageBitmap(file) }
        Promise.resolve(p).then((bmp: any) => resolve(bmp)).catch(() => {
          // options 版本被拒绝（不是"图片坏了"）时再用单参试一次，别白白放弃压缩
          try {
            Promise.resolve(w.createImageBitmap(file)).then((bmp: any) => resolve(bmp)).catch(() => resolve(null))
          } catch (e) { resolve(null) }
        })
        return
      }
      const URLRef: any = w.URL || (globalThis as any).URL
      const ImageRef: any = w.Image
      if (!URLRef || typeof URLRef.createObjectURL !== 'function' || typeof ImageRef !== 'function') {
        resolve(null)
        return
      }
      // objectURL 的释放必须覆盖「创建之后抛错」这条路：旧写法把 createObjectURL 与
      // new Image / 赋值放在同一个 try 里，一旦这两步抛错就直接 resolve(null)，
      // 刚建好的 Blob URL 永远不会被 revoke（一次拖图就留一份到页面卸载）。
      let url = ''
      const done = (v: any) => {
        try { if (url) URLRef.revokeObjectURL(url) } catch (e) { }
        url = ''
        resolve(v)
      }
      try {
        url = URLRef.createObjectURL(file)
        const img = new ImageRef()
        img.onload = () => done(img)
        img.onerror = () => done(null)
        img.src = url
      } catch (e) { done(null) }
    } catch (e) {
      resolve(null)
    }
  })
}

/** 把文件压成适合视觉模型的 base64；任何环节失败都回退原图 */
export async function imageToB64(file: any, opts?: { maxEdge?: number; quality?: number }): Promise<CompressedImage | null> {
  const dataUrl = await readFileAsDataUrl(file)
  const at = dataUrl.indexOf(',')
  const raw = at >= 0 ? dataUrl.slice(at + 1) : dataUrl
  if (!raw) return null
  // 优先用 data URL 头里的真实类型：file.type 为空时旧代码会把 png 标成 jpeg
  const rawMime = mimeFromDataUrl(dataUrl) || String((file && file.type) || 'image/jpeg')
  const rawResult: CompressedImage = { b64: raw, mime: rawMime, width: 0, height: 0, compressed: false }
  try {
    // 已经够小：不压（省一次 canvas 编解码）。按解码后字节算，base64 字符要乘 3/4。
    const declared = Number(file && file.size)
    const rawBytes = isFinite(declared) && declared > 0 ? declared : Math.ceil(raw.length * 3 / 4)
    if (rawBytes <= KEEP_RAW_BELOW) return rawResult

    const maxEdge = Math.max(256, Math.min(4096, Math.round(Number(opts && opts.maxEdge) || DEFAULT_MAX_EDGE)))
    const quality = Math.min(0.95, Math.max(0.5, Number(opts && opts.quality) || DEFAULT_QUALITY))

    const img = await decodeImage(file)
    if (!img) return rawResult
    try {
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
      // JPEG 没有 alpha 通道：透明 PNG 直接画进 canvas 会变黑块，先铺白底
      if (typeof cx.fillRect === 'function') {
        cx.fillStyle = '#fff'
        cx.fillRect(0, 0, w, h)
      }
      cx.drawImage(img, 0, 0, w, h)
      const out = String(canvas.toDataURL('image/jpeg', quality) || '')
      const cut = out.indexOf(',')
      const b64 = cut >= 0 ? out.slice(cut + 1) : ''
      if (!b64) return rawResult
      // 压完反而更大（小图/透明图）：用原图
      if (b64.length >= raw.length) return rawResult
      return { b64, mime: 'image/jpeg', width: w, height: h, compressed: true }
    } finally {
      // ImageBitmap 不 close 会一直占着解码后的位图内存（批量拖图时很可观）
      try { if (img && typeof img.close === 'function') img.close() } catch (e) { }
    }
  } catch (e) {
    return rawResult
  }
}
