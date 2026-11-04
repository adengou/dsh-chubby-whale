/**
 * host/http.ts —— 外呼 fetch 超时与请求体读取（可复用模块）
 * 项目没有 Log 模块，超时/网络错误统一走 console.error（标签照 C# 版：CHAT-TIMEOUT / BALANCE-TIMEOUT / ASR-TIMEOUT）
 */

/** 请求体超限的错误码（readBody 抛出，路由据此回 413） */
const BODY_TOO_LARGE = 'BODY_TOO_LARGE'

function bodyTooLarge(): any {
  const e: any = new Error('body too large')
  e.code = BODY_TOO_LARGE
  return e
}

/** 是不是请求体超限的错误（路由据此回 413） */
export function isBodyTooLarge(err: any): boolean {
  return Boolean(err && err.code === BODY_TOO_LARGE)
}

/** 超时/中止类错误（AbortSignal.timeout 抛 TimeoutError，手动 abort 抛 AbortError） */
export function isTimeoutError(err: any): boolean {
  const n = String((err && err.name) || '')
  return n === 'TimeoutError' || n === 'AbortError'
}

/** N 毫秒后自动中止的 signal（Node 18+ 的 AbortSignal.timeout，项目 engines 要求 >=22） */
export function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms)
}

/** 带超时的 fetch（薄封装：超时拒绝时抛 TimeoutError） */
export async function fetchWithTimeout(url: string, init: any = {}, ms = 30000): Promise<Response> {
  return fetch(url, { ...(init || {}), signal: timeoutSignal(ms) })
}

/**
 * 带超时的 fetch + 一次性读文本（能解析就顺手给 JSON）。
 * 不因 HTTP 非 2xx 抛错——路由要自己拿 status 决定回什么文案。
 */
export async function fetchJson(url: string, init: any = {}, ms = 30000): Promise<{ ok: boolean; status: number; data: any; text: string }> {
  const resp = await fetchWithTimeout(url, init, ms)
  const text = await resp.text().catch(() => '')
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { data = null }
  return { ok: resp.ok, status: resp.status, data, text }
}

/** 回 413（请求体超限）：JSON 兜底文案由客户端自己出 */
export function sendTooLarge(res: any): void {
  try {
    res.writeHead(413, { 'content-type': 'application/json; charset=utf-8', connection: 'close' })
    res.end(JSON.stringify({ ok: false, error: 'too large' }))
  } catch { }
}

/**
 * 读请求体，超过 maxBytes 立刻中止并抛 BODY_TOO_LARGE。
 * 先看 content-length（有就直接拒，连读都不读），读的过程中累计超限也当场抛，不把整份大包收进内存。
 */
export async function readBody(req: any, maxBytes: number): Promise<Buffer> {
  const declared = Number(req && req.headers && req.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) throw bodyTooLarge()
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any)
    total += buf.length
    if (total > maxBytes) throw bodyTooLarge()   // 抛出去让 for-await 自己销毁流，立即中止
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}
