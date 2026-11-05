/**
 * client/dropzone.ts —— 拖进来的文件处理（照 C# Files.cs：图片走视觉，文本文档走总结）
 * 纯逻辑：不碰 DOM 之外的东西（showBubble / speakText 由调用方注入，便于单测）
 */

import { imageToB64 } from './image.js'

/** 一次最多吃 4MB（C# 是 12MB，网页版请求体小一点更稳） */
export const MAX_DROP_BYTES = 4 * 1024 * 1024
/** 文档只取前 8000 字，别把上下文撑爆 */
export const MAX_TEXT_CHARS = 8000
/** 图片问题：非空提示词（服务端 message: '' 会 400） */
export const VISION_PROMPT = '看看这张图，说说你看到了什么'
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

/** 文档正文 → 送给模型的 message（截前 8000 字） */
export function buildTextPrompt(text: string): string {
  return '总结一下这篇文档：\n' + String(text || '').slice(0, MAX_TEXT_CHARS)
}

/** 图片读成 base64（去掉 data: 前缀） */
export function readFileAsBase64(file: any): Promise<string> {
  return new Promise((resolve) => {
    try {
      const fr = new FileReader()
      fr.onloadend = () => { const s = String(fr.result || ''); resolve(s.indexOf(',') >= 0 ? s.slice(s.indexOf(',') + 1) : s) }
      fr.onerror = () => resolve('')
      fr.readAsDataURL(file)
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
    return r.json()
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
    try {
      const reply0 = await post({ message: VISION_PROMPT, image: b64, imageMime: mime })
      const reply = String((reply0 && reply0.reply) || '').trim() || '这条鱼看不懂这张图……'
      bubble('（看图）' + reply, 10000)
      if (speak) speak(reply)
      return { ok: true, kind: 'image', message: VISION_PROMPT, reply }
    } catch (e: any) {
      bubble('图片处理失败', 4000)
      return { ok: false, kind: 'error', error: String((e && e.message) || e) }
    }
  }

  // 文本类：读前 8000 字，让模型总结
  if (isTextFile(file)) {
    let text = ''
    try { text = String(await file.text()) } catch (e) { text = '' }
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
      if (speak) speak(reply)
      return { ok: true, kind: 'text', message, reply }
    } catch (e: any) {
      bubble('文档处理失败', 4000)
      return { ok: false, kind: 'error', error: String((e && e.message) || e) }
    }
  }

  bubble('这个格式本鱼还不会看', 4000)
  return { ok: false, kind: 'unsupported', error: 'unsupported type' }
}
