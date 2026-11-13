/**
 * client/dropzone.ts —— 拖进来的文件处理
 *
 * 三条路（2026-11-14 起接入官方全家桶）：
 *   · 图片：先跑官方 OCR 把字取准，再连同图片交给视觉模型（OCR 不是替换看图，是补它的短板：
 *     表格/截图里的数字、公文编号，让模型「猜」很容易错）；
 *   · PDF / Word / PowerPoint：**只走官方 Files API**（/parse-doc），拿 file_id 在聊天里引用。
 *     本文件不引任何 PDF/Office 解析库、也不碰 DecompressionStream/DOMParser——拖入这条路上
 *     没有「偷偷本地解」的备用分支（菜单「读文档 / 校对」仍走旧的 client/doc-text.ts，属历史遗留，
 *     不在拖入链路里）；
 *   · txt / md / json / log / csv：本地直接读（离线、免费，没必要上传）。
 *
 * 纯逻辑：不碰 DOM 之外的东西（showBubble / speakText 由调用方注入，便于单测）。
 */

import { str } from './util.js'
import { clipCodePoints } from '../shared/text.js'
import { imageToB64, readFileAsBase64 } from './image.js'

/** 图片一次最多吃 4MB（C# 是 12MB，网页版请求体小一点更稳） */
export const MAX_DROP_BYTES = 4 * 1024 * 1024
/**
 * 文档（PDF/Office）上限 20MB：官方允许 100MiB，宿主 /parse-doc 的 JSON 体上限则是 40MB
 * （official.ts）——30MB 原文件 base64 正好 40MiB，再加 JSON 头就会超。取 20MB 留出余量，
 * 也避免浏览器里一次拼出 ~27MB 字符串 + 宿主再解出 20MB Buffer 把内存顶高。
 */
export const MAX_DOC_BYTES = 20 * 1024 * 1024
/** 文档只取前 4000 字（原先 8000）：总结效果几乎无差，输入 token 省一半 */
export const MAX_TEXT_CHARS = 4000
/** OCR 文字拼进图片提问的上限（够覆盖一页公文正文） */
export const MAX_OCR_CHARS = 2000
/** 图片问题：非空提示词（服务端 message: '' 会 400） */
export const VISION_PROMPT = '看看这张图，说说你看到了什么'
/**
 * 单图 base64 上限，与宿主 src/host/routes/chat.ts 的 CHAT_MAX_IMAGE_B64 对齐（4MB 字符）。
 * 客户端先拦一道：4MB 原图在压缩失败回退时会得到约 5.3MB base64，
 * 直接上传只会换来一个 413，还白传一遍流量。
 */
const MAX_IMAGE_B64_CHARS = 4 * 1024 * 1024
const TEXT_EXTS = ['.txt', '.md', '.json', '.log', '.csv']
/** 需要官方服务端解析的文档类型（本地不解，避免 PDF/Office 自己造轮子） */
const BINARY_DOC_EXTS = ['.pdf', '.doc', '.docx', '.ppt', '.pptx']
/**
 * 扩展名之外的兜底：有些来源（邮件附件、移动端分享）文件名没有扩展名，
 * 但浏览器仍会给出 MIME。只认官方 text_recognition 支持的五类，不猜。
 */
const BINARY_DOC_MIMES = Object.freeze([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])

/**
 * 客户端等待预算：必须**比宿主的外呼预算长**，否则会把宿主本可回出的错误先掐掉。
 *   · /parse-doc：宿主 250s（上传 120 + 解析 120 + 余量），客户端留到 260s；
 *   · /ocr：宿主 180s，客户端 200s；
 *   · /chat：宿主主聊天 30s，客户端 45s。
 * 到点先 abort（客户端真的断开 → 宿主 watchClientGone 会中止外呼），再回一句人话。
 */
const PARSE_DOC_BUDGET_MS = 260 * 1000
const OCR_BUDGET_MS = 200 * 1000
const CHAT_BUDGET_MS = 45 * 1000

/** 每次拖入一个文件用一条气泡 key：进度 → 结果/失败可以**立刻替换**，不排在 30s 进度条后面 */
let dropSeq = 0

export interface DropDeps {
  /**
   * 第三个参数是可选的：key 让同一次拖入的「进度 → 结果/失败」立刻替换。
   * 老调用方/测试桩只接两个参数也兼容（多传的实参会被 JS 忽略）。
   */
  showBubble?: (text: string, ms?: number, opts?: { key?: string; transient?: boolean; staleAfter?: number }) => void
  speakText?: (text: string) => void
  /** 测试时可注入：默认用全局 fetch */
  fetchImpl?: any
  /**
   * 测试时可注入的客户端等待预算（毫秒）。0 / 负数 = 不设超时；
   * 不传时用 PARSE_DOC_BUDGET_MS / OCR_BUDGET_MS / CHAT_BUDGET_MS。
   */
  timeouts?: { parseDoc?: number; ocr?: number; chat?: number }
}

export interface DropResult {
  ok: boolean
  kind: 'image' | 'text' | 'document' | 'unsupported' | 'too-large' | 'empty' | 'error'
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

/** PDF / Word / PowerPoint：交给官方 Files API 解析（扩展名优先，MIME 兜底无扩展名文件） */
export function isBinaryDocFile(file: any): boolean {
  const name = String((file && file.name) || '').toLowerCase()
  for (const ext of BINARY_DOC_EXTS) {
    if (name.slice(-ext.length) === ext) return true
  }
  const mime = String((file && file.type) || '').toLowerCase().split(';')[0].trim()
  return BINARY_DOC_MIMES.indexOf(mime) >= 0
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

/** 官方解析后的文档提问：文件名进正文，模型知道自己在总结哪份 */
export function buildDocPrompt(name: string): string {
  const n = String(name || '').trim() || '这份文档'
  return '总结一下这篇文档《' + n + '》的要点。'
}

/** 图片提问：OCR 取到的文字拼在后面（没取到就只发原问题） */
export function buildVisionPrompt(ocrText?: string): string {
  const t = String(ocrText || '').trim()
  if (!t) return VISION_PROMPT
  return VISION_PROMPT + '\n\n图片里的文字（OCR 识别）：\n' + clipCodePoints(t, MAX_OCR_CHARS)
}

/**
 * 服务端业务失败 → 给主人看的一句话。
 * 优先 hint / reply（宿主已经写好的人话）；已知的共享英文常量翻成中文；
 * 其余 error 原样返回（测试与排障需要看到服务端到底说了什么）。
 */
function requestErrorText(data: any, status: number): string {
  const hint = String((data && (data.hint || data.reply)) || '').trim()
  if (hint) return hint
  const code = String((data && data.error) || '').trim()
  if (code === 'too large') return '文件太大啦，换小一点的再试'
  if (code === 'NO_KEY') return '没配 DeepSeek Key，文件解析用不了'
  if (code) return code
  return '请求失败' + (status ? '（HTTP ' + status + '）' : '')
}

/** 客户端等待预算到点：名字与宿主/客户端 http 工具同名（TimeoutError），文案给主人看 */
function timeoutError(ms: number): any {
  const err: any = new Error('请求超时（' + ms + 'ms）')
  err.name = 'TimeoutError'
  err.reply = '等太久啦（网络可能卡住了），再试一次？'
  return err
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
  const show = typeof d.showBubble === 'function' ? d.showBubble : null
  /**
   * 本次拖入的气泡 key：同一文件的「进度 → 结果/失败」用同一个 key。
   * 宿主的气泡调度器对「同线同 key」是**立刻替换**而不是排队——旧实现把进度气泡写成
   * 30s，结果气泡排在同一线路后面，解析 3 秒完成也要等 27 秒才看见回复。
   * 第三个参数老调用方/测试桩会忽略，不影响既有行为。
   */
  const bubbleKey = 'drop:file:' + (++dropSeq)
  const bubble = (text: string, ms?: number): void => {
    if (!show) return
    try { show(text, ms, { key: bubbleKey }) } catch (e) { }
  }
  const speak = typeof d.speakText === 'function' ? d.speakText : null
  const doFetch = d.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null)
  /** 预算：显式传 0 / 负数 = 不设超时（与 client/http.ts 的 timeout 口径一致） */
  const pickBudget = (v: any, fallback: number): number => {
    if (v === undefined || v === null) return fallback
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) return 0
    return n
  }
  const budgetFor = (path: string): number => {
    const t = d.timeouts || {}
    if (path === '/parse-doc') return pickBudget(t.parseDoc, PARSE_DOC_BUDGET_MS)
    if (path === '/ocr') return pickBudget(t.ocr, OCR_BUDGET_MS)
    return pickBudget(t.chat, CHAT_BUDGET_MS)
  }
  if (!file) {
    bubble('没拿到文件，再拖一次试试', 4000)
    return { ok: false, kind: 'empty', error: 'no file' }
  }
  const size = Number(file.size) || 0
  if (!doFetch) {
    bubble('本鱼连不上服务器', 4000)
    return { ok: false, kind: 'error', error: 'no fetch' }
  }
  const image = isImageFile(file)
  const binaryDoc = isBinaryDocFile(file)
  // 上限按类型分开：图片 4MB、文档 20MB（官方文档解析支持更大，但 base64 进 JSON 要克制）
  const cap = binaryDoc ? MAX_DOC_BYTES : MAX_DROP_BYTES
  if (size > cap) {
    bubble(binaryDoc ? '文件太大啦（超过 20MB），换小一点的' : '文件太大啦（超过 4MB），本鱼一口吃不下', 5000)
    return { ok: false, kind: 'too-large', error: 'too large' }
  }

  /**
   * POST JSON。关键点：
   *   ① 每个接口有客户端等待预算，到点 abort（浏览器真的断连 → 宿主中止外呼），
   *      不会因为宿主进程卡住/网络半死让 handleFileDrop 永远 pending；
   *   ② 预算必须比宿主外呼超时长（见文件头常量），先让宿主把它的人话错误回出来；
   *   ③ 业务失败优先用服务端的 hint/reply，已知的英文常量（too large / NO_KEY）翻成人话，
   *      未知 error 原样透出（测试与排障都靠它）。
   */
  const post = async (path: string, body: any): Promise<any> => {
    const budget = budgetFor(path)
    const ctl = budget > 0 && typeof AbortController !== 'undefined' ? new AbortController() : null
    const work = async (): Promise<any> => {
      const r = await doFetch('/api/chubby-whale' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl ? ctl.signal : undefined,
      })
      let data: any = null
      try { data = await r.json() } catch (e) { data = null }
      const status = Number(r && r.status) || 0
      // 旧实现不看状态码：宿主回 413 + {ok:false, reply:"这张图太大啦…"} 时会被
      // 当成正常回复继续往下走（显示的内容其实来自错误分支，ok 也是 true）。
      if (!data || (r && r.ok === false) || data.ok === false) {
        const msg = requestErrorText(data, status)
        const err: any = new Error(msg)
        err.reply = msg
        err.status = status
        throw err
      }
      return data
    }
    if (!ctl || !budget) return work()
    let timer: any = null
    const guard = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        // 先断连接：宿主 watchClientGone 会把还在跑的上传/解析外呼一起中止
        try { ctl.abort() } catch (e) { }
        reject(timeoutError(budget))
      }, budget)
    })
    try {
      return await Promise.race([work(), guard])
    } catch (e: any) {
      // abort 触发的 AbortError 没有 reply：统一换成同一句人话（不暴露 DOMException 名）
      if (ctl.signal.aborted && !(e && e.reply)) throw timeoutError(budget)
      throw e
    } finally {
      if (timer) { try { clearTimeout(timer) } catch (e) { } }
    }
  }
  const fail = (e: any, fallback: string): DropResult => {
    const reply = String((e && e.reply) || '').trim()
    const raw = String((e && e.message) || e || '').trim()
    // 网络错误（TypeError: Failed to fetch）不直接甩给主人；仍保留在 error 字段里供排障。
    const msg = reply || fallback
    bubble(msg, 5000)
    const tooLarge = Number(e && e.status) === 413
    return {
      ok: false,
      kind: tooLarge ? 'too-large' : 'error',
      error: raw || msg,
      reply: reply || undefined,
    }
  }

  // ============ 图片：OCR 取字 + 视觉 ============
  if (image) {
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
    // OCR 是加分项：失败/没字都照旧走视觉，不影响看图
    let ocrText = ''
    try {
      const o = await post('/ocr', { file: b64, name: String(file.name || 'image.png'), purpose: 'text_recognition' })
      ocrText = String((o && o.text) || '')
    } catch (e) { }
    const prompt = buildVisionPrompt(ocrText)
    try {
      const reply0 = await post('/chat', { message: prompt, image: b64, imageMime: mime })
      const reply = String((reply0 && reply0.reply) || '').trim() || '这条鱼看不懂这张图……'
      bubble('（看图）' + reply, 10000)
      // 朗读是附加动作：TTS 回调抛错不能把「已经识别成功」改判成失败（结果对象是调用方的唯一依据）
      if (speak) { try { speak(reply) } catch (e2) { } }
      return { ok: true, kind: 'image', message: prompt, reply }
    } catch (e: any) {
      return fail(e, '图片处理失败')
    }
  }

  // ============ PDF / Word / PowerPoint：官方 Files API 解析 ============
  if (binaryDoc) {
    // 进度气泡 30s：解析通常 2–3s，给足首屏反馈即可。**不要**开到 240s——气泡调度器
    // 同线路是排队的，一条 240s 的进度会把期间所有聊天回复压到解析结束之后。
    // 结果/失败用同一个 key 立刻替换这条进度，不会出现「3 秒解析完、回复等 27 秒」。
    bubble('本鲸先把这份文档读懂…（大文件可能要一两分钟）', 30000)
    try {
      const b64 = await readFileAsBase64(file)
      if (!b64) {
        bubble('文件读不出来，再拖一次试试', 5000)
        return { ok: false, kind: 'error', error: 'empty file' }
      }
      const up = await post('/parse-doc', { file: b64, name: String(file.name || 'document'), purpose: 'text_recognition' })
      const fileId = String((up && up.fileId) || '')
      // 与宿主 /chat 的白名单同门槛：过短的 id 到聊天路由会被静默丢掉，
      // 那时主人只会看到「解析成功」但模型没读到文档，必须在这里先拦住。
      if (!/^file-api-[A-Za-z0-9_-]{8,}$/.test(fileId)) {
        const badId: any = new Error('官方没给出有效的 file_id')
        badId.reply = '官方没返回文件编号，换一份再试'
        throw badId
      }
      const message = buildDocPrompt(String(file.name || ''))
      const reply0 = await post('/chat', { message, fileId })
      const reply = String((reply0 && reply0.reply) || '').trim() || '这份文档本鲸没看懂……'
      bubble('（文档）' + reply, 12000)
      if (speak) { try { speak(reply) } catch (e2) { } }
      return { ok: true, kind: 'document', message, reply }
    } catch (e: any) {
      return fail(e, '文档处理失败')
    }
  }

  // ============ 纯文本：本地读、本地截断 ============
  if (isTextFile(file)) {
    const text = String(await readTextFile(file) || '')
    if (!text.trim()) {
      bubble('这个文件里没读到字', 4000)
      return { ok: false, kind: 'error', error: 'empty text' }
    }
    const message = buildTextPrompt(text)
    bubble('本鲸看看这份文档…', 3000)
    try {
      const reply0 = await post('/chat', { message })
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
