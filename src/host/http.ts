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
    // 连接可能已被 abortRequest 断掉：写不出去是预期结果，别让 EPIPE/ECONNRESET 冒成未捕获异常
    if (res && typeof res.on === 'function') res.on('error', () => { })
    res.writeHead(413, { 'content-type': 'application/json; charset=utf-8', connection: 'close' })
    res.end(JSON.stringify({ ok: false, error: 'too large' }))
  } catch { }
}

/**
 * 请求体超限时把连接断掉。
 * 为什么必须断：只从 for-await 里 throw 出去只是「不再消费」，客户端还在发的 body 会继续占着
 * socket，HTTP 服务也走不到 keep-alive 复用，等于每个超大请求漏一条连接。
 * destroy 优先（客户端立刻收到 RST，剩余数据丢弃）；没有 destroy 就 resume 把剩下的读空丢掉。
 */
function abortRequest(req: any): void {
  // destroy/半截读取都可能触发 error（EPIPE/ECONNRESET），先挂空监听，避免冒成未捕获异常
  try { if (req && typeof req.on === 'function') req.on('error', () => { }) } catch { }
  try {
    if (req && typeof req.destroy === 'function') { req.destroy(); return }
  } catch { }
  try { if (req && typeof req.resume === 'function') req.resume() } catch { }
}

/**
 * 读请求体，超过 maxBytes 立刻中止并抛 BODY_TOO_LARGE。
 * 先看 content-length（有就直接拒，连读都不读），读的过程中累计超限也当场抛，不把整份大包收进内存。
 * 抛错前先 abortRequest 断连，否则超限后客户端仍在传的 body 会一直占着连接。
 */
export async function readBody(req: any, maxBytes: number): Promise<Buffer> {
  const declared = Number(req && req.headers && req.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    abortRequest(req)
    throw bodyTooLarge()
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any)
    total += buf.length
    if (total > maxBytes) {
      abortRequest(req)   // 先把连接断掉，再抛给路由回 413
      throw bodyTooLarge()
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}
