/**
 * shared/citations.ts —— 联网工具（deepseek_web_search / deepseek_read_url）的来源整理
 *
 * 官方在 Chat Completions 里把引用放在 `message.annotations`（url_citation），
 * 把「搜到了什么 / 读了哪个网页」放在 `message.server_tool_calls` 的各步 calls 里。
 * 两处都收，按 URL 归一去重。**只收 url/title**：sources[].snippet、page.content、
 * signature 都是网页内容，既不拼进回复、也不写进记忆（记忆只留模型自己的正文）。
 *
 * 2026-11-14 审计后口径：
 *   · 同一 URL 按「协议 + 主机 + 非默认端口 + 去尾斜杠路径 + 查询串」归一，忽略 #片段；
 *   · 先出现的 annotation 可能没有标题，后面的 sources/page 有标题时补上（不丢这条来源）；
 *   · 标题压空白、去控制字符、URL 形式的「标题」清空；超长按 Unicode 码点截断；
 *   · 展示最多 5 条，URL 仅展示时截断，内部仍保留可解析的完整地址；
 *   · 正文已有「来源/参考来源/参考资料/Sources」段时不重复拼。
 *
 * 只做纯函数：不改 message、不发请求。气泡里展示纯文本来源（项目不用 markdown 渲染）。
 */
import { clipCodePoints } from './text.js'

export type Citation = {
  url: string
  /** 可能为空：官方在标题未知时会回空串或 URL */
  title: string
}

/** 默认最多展示几条（与旧口径一致） */
const MAX_CITATIONS = 5
/** 标题最多多少个字（码点；超出加省略号） */
const MAX_TITLE_CHARS = 80
/** URL 展示最多多少个字（码点；超出加省略号） */
const MAX_URL_CHARS = 300
/** 原始 URL 字符串硬上限：再长基本不是正常来源，直接丢弃 */
const MAX_URL_INPUT_CHARS = 4096

type ParsedUrl = {
  /** 保留原始（去首尾空白）形式，用于展示/回包 */
  url: string
  /** 去重键：忽略 #片段、主机大小写、默认端口、尾斜杠 */
  key: string
}

/**
 * 解析并归一 http(s) URL。
 * 非 http(s)、空串、带空白/控制字符、解析失败的一律返回 null —— 不猜、不修。
 */
function parseHttpUrl(raw: any): ParsedUrl | null {
  const s = String(raw == null ? '' : raw).trim()
  if (!s || s.length > MAX_URL_INPUT_CHARS) return null
  // 控制字符/空白一律拒绝：来源行是纯文本，不能因为一个换行把「来源」区拆成两段
  if (/[\u0000-\u001f\u007f-\u009f\s]/.test(s)) return null
  let u: URL
  try { u = new URL(s) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (!u.hostname) return null
  const defaultPort = (u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')
  const host = u.hostname.toLowerCase() + (u.port && !defaultPort ? ':' + u.port : '')
  // 根路径 / 归一成空：https://a.com 与 https://a.com/ 算同一条
  const path = u.pathname.replace(/\/+$/, '')
  // #片段只是页内位置，不作为「另一条来源」；查询串保留（不同查询是不同页面）
  return { url: s, key: u.protocol + '//' + host + path + (u.search || '') }
}

/** 按码点截断并补省略号；没超限时原样返回 */
function clipChars(s: string, max: number): string {
  const cut = clipCodePoints(s, max)
  return cut.length < s.length ? cut + '…' : s
}

/** 标题清洗：压空白、去控制字符、清掉「标题其实还是 URL」的情况，超长按码点截断 */
function cleanTitle(raw: any): string {
  const s = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return ''
  // 官方在标题未知时会把 URL 原样放进 title；这种「标题」等于没有
  if (/^https?:\/\//i.test(s)) return ''
  return clipChars(s, MAX_TITLE_CHARS)
}

/** 展示用 URL 截断（不动内部原值，避免截断后的地址反过来解析失败） */
function clipUrl(url: string): string {
  return clipChars(url, MAX_URL_CHARS)
}

/** 正文里是不是已经有来源段（模型自己写过），避免拼两份；只有标题没有内容时仍补我们的来源 */
function hasSourceBlock(text: string): boolean {
  const m = /(^|\n)[ \t]*(?:来源|参考来源|参考资料|sources?)[ \t]*[：:]/i.exec(text)
  if (!m) return false
  return /\S/.test(text.slice(m.index + m[0].length))
}

/** 去掉「只有标题、没有内容」的空来源段，避免拼完变成两个「来源：」 */
function stripEmptySourceHeader(text: string): string {
  const re = /(^|\n)[ \t]*(?:来源|参考来源|参考资料|sources?)[ \t]*[：:][ \t]*$/i
  return re.test(text) ? text.replace(re, '').replace(/\s+$/, '') : text
}

/**
 * 从官方响应的一条 assistant message 里收集来源。
 * @param message `choices[0].message`
 * @param max 最多保留几条（默认 5；非有限数回落到默认值）
 */
export function collectCitations(message: any, max = MAX_CITATIONS): Citation[] {
  const out: Citation[] = []
  const byKey = new Map<string, Citation>()
  const push = (urlRaw: any, titleRaw: any): void => {
    const parsed = parseHttpUrl(urlRaw)
    if (!parsed) return
    const title = cleanTitle(titleRaw)
    const hit = byKey.get(parsed.key)
    if (hit) {
      // 先出现的 annotation 可能只带 URL；后面的 sources/page 有标题时补上，而不是把这条来源丢掉
      if (!hit.title && title) hit.title = title
      return
    }
    const item: Citation = { url: parsed.url, title }
    byKey.set(parsed.key, item)
    out.push(item)
  }
  try {
    // 1) Chat Completions 的 message.annotations：{type:'url_citation', url_citation:{url,title}}
    const anns = message && Array.isArray(message.annotations) ? message.annotations : []
    for (const a of anns) {
      const c = a && a.url_citation ? a.url_citation : null
      if (c) push(c.url, c.title)
      // 兼容直接平铺的 {type:'url_citation', url, title}（不同协议版本）
      else if (a && a.type === 'url_citation') push(a.url, a.title)
    }
    // 2) server_tool_calls[].calls[]：page（读过的网页）与 sources（搜到的结果）
    //    只取 url/title；snippet/content/signature 是网页内容，绝不往回复或记忆里带。
    const steps = message && Array.isArray(message.server_tool_calls) ? message.server_tool_calls : []
    for (const step of steps) {
      const calls = step && Array.isArray(step.calls) ? step.calls : []
      for (const call of calls) {
        // 官方 status='failed' 的调用没有可信结果（抓取失败/搜索失败），不拿它的 page/sources 当来源
        if (!call || call.status === 'failed') continue
        if (call.page && call.page.url) push(call.page.url, call.page.title)
        const srcs = call && Array.isArray(call.sources) ? call.sources : []
        for (const s of srcs) if (s && s.url) push(s.url, s.title)
      }
    }
  } catch { }
  const cap = Number(max)
  const limit = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : MAX_CITATIONS
  return out.slice(0, limit)
}

/**
 * 把来源拼到回复末尾（纯文本，气泡能读；client 朗读前会去掉这一段，避免念 URL）。
 * 没有来源/正文为空时原样返回，不硬加空行。
 */
export function appendCitations(reply: string, cites: Citation[]): string {
  const text = String(reply == null ? '' : reply)
  if (!text.trim()) return text
  const list: Citation[] = []
  const idxByKey = new Map<string, number>()
  for (const c of Array.isArray(cites) ? cites : []) {
    if (!c || !c.url) continue
    const parsed = parseHttpUrl(c.url)
    if (!parsed) continue
    const idx = idxByKey.get(parsed.key)
    if (idx !== undefined) {
      if (!list[idx].title) {
        const t = cleanTitle(c.title)
        if (t) list[idx].title = t
      }
      continue
    }
    if (list.length >= MAX_CITATIONS) continue
    idxByKey.set(parsed.key, list.length)
    list.push({ url: parsed.url, title: cleanTitle(c.title) })
  }
  if (!list.length) return text
  // 正文末尾已经有来源段就不重复拼（模型偶尔自己写了）
  if (hasSourceBlock(text)) return text
  const body = stripEmptySourceHeader(text.replace(/\s+$/, ''))
  const lines = list.map((c, i) => (i + 1) + '. ' + (c.title ? c.title + ' — ' : '') + clipUrl(c.url))
  return (body ? body + '\n\n' : '') + '来源：\n' + lines.join('\n')
}
