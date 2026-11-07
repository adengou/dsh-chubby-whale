/**
 * client/dropzone.ts —— 拖进来的文件处理（照 C# Files.cs：图片走视觉，文本文档走总结）
 * 纯逻辑：不碰 DOM 之外的东西（showBubble / speakText 由调用方注入，便于单测）
 */

import { str } from './util.js'
import { clipCodePoints } from '../shared/text.js'
import { imageToB64 } from './image.js'

// 图片读成 base64（去掉 data: 前缀）的实现已统一到 image.ts；这里原样再导出，保持 dropzone 的旧接口不变
export { readFileAsBase64 } from './image.js'

/** 一次最多吃 4MB（C# 是 12MB，网页版请求体小一点更稳） */
export const MAX_DROP_BYTES = 4 * 1024 * 1024
/** 文档只取前 4000 字（原先 8000）：总结效果几乎无差，输入 token 省一半 */
export const MAX_TEXT_CHARS = 4000
/** 图片问题：非空提示词（服务端 message: '' 会 400） */
export const VISION_PROMPT = '看看这张图，说说你看到了什么'
/**
 * 单图 base64 上限，与宿主 src/host/routes/chat.ts 的 CHAT_MAX_IMAGE_B64 对齐（4MB 字符）。
 * 客户端先拦一道：4MB 原图在压缩失败回退时会得到约 5.3MB base64，
 * 直接上传只会换来一个 413，还白传一遍流量。
 */
const MAX_IMAGE_B64_CHARS = 4 * 1024 * 1024
const TEXT_EXTS = ['.txt', '.md', '.json', '.log', '.csv']

export interface DropDeps {
  showBubble?: (text: string, ms?: number) => void
  speakText?: (text: string) => void
  /** 测试时可注入：默认用全局 fetch */
  fetchImpl?: any
}

export interface DropResult {
  ok: boolean
  kind: 'image' | 'text' | 'unsupported' | 'too-large' | 'empty' | 'error'
  /** 实际发给 /chat 的 message（文本路径上单测就查它） */
  message?: string
  reply?: string
  error?: string
}

export function isImageFile(file: any): boolean {
  return Boolean(file && typeof file.type === 'string' && file.type.indexOf('image/') === 0)
}

export function isTextFile(file: any): boolean {
  const name = String((file && file.name) || '').toLowerCase()
  for (const ext of TEXT_EXTS) {
    if (name.slice(-ext.length) === ext) return true
  }
  return false
}

/**
 * 文档正文 → 送给模型的 message（截前 4000 字）。
 *
 * 「字」= Unicode 码点（B101）：拖进来的是**未知外部文件**，整篇 emoji / 扩展 B 汉字
 * 很常见。旧写法 `.slice(0, 4000)` 按 UTF-16 码元切，4000 个 emoji 只留 2000 个，
 * 第 4000 个码元落在代理对中间时还会切出孤立代理项，跟着 /chat 请求体外呼。
 */
export function buildTextPrompt(text: string): string {
  return '总结一下这篇文档：\n' + clipCodePoints(text, MAX_TEXT_CHARS)
}

/** 优先 Blob.text()；老 Safari 没有这个方法时退回 FileReader，别把"读不出"误报成空文件 */
function readTextFile(file: any): Promise<string> {
  try {
    if (file && typeof file.text === 'function') {
      return Promise.resolve(file.text()).then((t: any) => str(t)).catch(() => readTextViaReader(file))
    }
  } catch (e) { }
  return readTextViaReader(file)
}

function readTextViaReader(file: any): Promise<string> {
  return new Promise((resolve) => {
    try {
      if (typeof FileReader === 'undefined') { resolve(''); return }
      const fr = new FileReader()
      fr.onloadend = () => {
        try { resolve(String((fr as any).result || '')) } catch (e) { resolve('') }
      }
      fr.onerror = () => resolve('')
      fr.readAsText(file)
    } catch (e) { resolve('') }
  })
}

/**
 * 处理拖进来的一个文件：图片识别 / 文档总结 / 其他格式提示。
 * 返回解析结果，方便单测直接断言 message 文本。
 */
export async function handleFileDrop(file: any, deps?: DropDeps): Promise<DropResult> {
  const d = deps || {}
  const bubble = typeof d.showBubble === 'function' ? d.showBubble : () => { }
  const speak = typeof d.speakText === 'function' ? d.speakText : null
  const doFetch = d.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null)
  if (!file) {
    bubble('没拿到文件，再拖一次试试', 4000)
    return { ok: false, kind: 'empty', error: 'no file' }
  }
  const size = Number(file.size) || 0
  if (size > MAX_DROP_BYTES) {
    bubble('文件太大啦（超过 4MB），本鱼一口吃不下', 5000)
    return { ok: false, kind: 'too-large', error: 'too large' }
  }
  if (!doFetch) {
    bubble('本鱼连不上服务器', 4000)
    return { ok: false, kind: 'error', error: 'no fetch' }
  }
  const post = async (body: any): Promise<any> => {
    const r = await doFetch('/api/chubby-whale/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    let data: any = null
    try { data = await r.json() } catch (e) { data = null }
    const status = Number(r && r.status) || 0
    // 旧实现不看状态码：宿主回 413 + {ok:false, reply:"这张图太大啦…"} 时会被
    // 当成正常回复继续往下走（显示的内容其实来自错误分支，ok 也是 true）。
    if (!data || (r && r.ok === false) || data.ok === false) {
      const msg = String((data && (data.reply || data.error)) || '').trim()
        || ('请求失败' + (status ? '（HTTP ' + status + '）' : ''))
      const err: any = new Error(msg)
      err.reply = msg
      err.status = status
      throw err
    }
    return data
  }
  const fail = (e: any, fallback: string): DropResult => {
    const msg = String((e && (e.reply || e.message)) || e || '').trim() || fallback
    bubble(msg, 5000)
    const tooLarge = Number(e && e.status) === 413
    return {
      ok: false,
      kind: tooLarge ? 'too-large' : 'error',
      error: msg,
      reply: e && e.reply ? String(e.reply) : undefined,
    }
  }

  // 图片：视觉模型
  if (isImageFile(file)) {
    bubble('本鲸看看这张图…', 3000)
    // 先压缩再上传：长边 ≤1280 / JPEG 0.85（失败自动回退原图）
    const img0 = await imageToB64(file)
    const b64 = img0 ? img0.b64 : ''
    const mime = (img0 && img0.mime) || file.type || 'image/jpeg'
    if (!b64) {
      bubble('图片读不出来，再拖一次试试', 4000)
      return { ok: false, kind: 'error', error: 'empty image' }
    }
    if (b64.length > MAX_IMAGE_B64_CHARS) {
      bubble('这张图太大啦（原图超过约 3MB），本鲸一口吞不下，换张小一点的再发吧～', 5000)
      return { ok: false, kind: 'too-large', error: 'image too large' }
    }
    try {
      const reply0 = await post({ message: VISION_PROMPT, image: b64, imageMime: mime })
      const reply = String((reply0 && reply0.reply) || '').trim() || '这条鱼看不懂这张图……'
      bubble('（看图）' + reply, 10000)
      // 朗读是附加动作：TTS 回调抛错不能把「已经识别成功」改判成失败（结果对象是调用方的唯一依据）
      if (speak) { try { speak(reply) } catch (e2) { } }
      return { ok: true, kind: 'image', message: VISION_PROMPT, reply }
    } catch (e: any) {
      return fail(e, '图片处理失败')
    }
  }

  // 文本类：读前 4000 字，让模型总结
  if (isTextFile(file)) {
    const text = String(await readTextFile(file) || '')
    if (!text.trim()) {
      bubble('这个文件里没读到字', 4000)
      return { ok: false, kind: 'error', error: 'empty text' }
    }
    const message = buildTextPrompt(text)
    bubble('本鲸看看这份文档…', 3000)
    try {
      const reply0 = await post({ message })
      const reply = String((reply0 && reply0.reply) || '').trim() || '这份文档本鲸没看懂……'
      bubble('（文档）' + reply, 12000)
      if (speak) { try { speak(reply) } catch (e2) { } }
      return { ok: true, kind: 'text', message, reply }
    } catch (e: any) {
      return fail(e, '文档处理失败')
    }
  }

  bubble('这个格式本鱼还不会看', 4000)
  return { ok: false, kind: 'unsupported', error: 'unsupported type' }
}
