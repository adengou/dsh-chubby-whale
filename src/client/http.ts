/**
 * client/http.ts —— 浏览器端 HTTP 小工具
 *
 * 抽出来的理由：client.ts 里二十多处是同一个模板
 *   fetch(path).then(r => r.json()).then(d => …).catch(() => …)
 * 重复到没法一眼看出「哪些接口失败会静默」。
 *
 * 约定：错误语义与原来的 fetch().json() 完全一致——
 *   HTTP 4xx/5xx 不抛错（照旧解析 body），网络错误/JSON 解析错误 reject，
 *   调用方仍然用 .catch(...) 兜底。本模块不吞异常、不打印日志。
 */

/** 所有接口的统一前缀（voice/dropzone 内部仍用自己的 apiBase 常量） */
export const API_BASE = '/api/chubby-whale'

export type JsonInit = {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: any
  cache?: string
}

/** '/balance' → '/api/chubby-whale/balance'；绝对地址与已带前缀的原样返回 */
export function apiUrl(path: string): string {
  const p = String(path || '')
  if (!p) return API_BASE
  if (/^(https?:)?\/\//.test(p)) return p
  if (p.indexOf('/api/') === 0) return p
  return API_BASE + (p.charAt(0) === '/' ? p : '/' + p)
}

/** 说书队列按标签页分片用：x-client-id 请求头 */
export function clientHeaders(clientId?: string, extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = Object.assign({}, extra || {})
  if (clientId) h['x-client-id'] = clientId
  return h
}

/** 原始 GET（接受 Response 本身时用，例如需要读 body 流的场景） */
export function request(path: string, init?: JsonInit): Promise<any> {
  return fetch(apiUrl(path), Object.assign({}, init || {}) as any)
}

/** GET 并解析 JSON */
export function getJson(path: string, init?: JsonInit): Promise<any> {
  return request(path, init).then((r: any) => r.json())
}

/** 原始 POST（需要 Response 对象的流式接口用） */
export function postRaw(path: string, body?: any, init?: JsonInit): Promise<any> {
  const o: JsonInit = Object.assign({}, init || {})
  o.method = 'POST'
  if (body !== undefined) {
    o.headers = Object.assign({ 'content-type': 'application/json' }, o.headers || {})
    o.body = JSON.stringify(body)
  }
  return fetch(apiUrl(path), o as any)
}

/** POST JSON（body 省略时发空体，用于 /clear-memory 这类无参接口） */
export function postJson(path: string, body?: any, init?: JsonInit): Promise<any> {
  return postRaw(path, body, init).then((r: any) => r.json())
}

/** DELETE 并解析 JSON */
export function delJson(path: string, init?: JsonInit): Promise<any> {
  return fetch(apiUrl(path), Object.assign({ method: 'DELETE' }, init || {}) as any).then((r: any) => r.json())
}

/** AbortSignal.timeout 的安全包装：浏览器不支持时返回 undefined（绝不因此报错） */
export function timeoutSignal(ms: number): any {
  try {
    const AS: any = typeof AbortSignal !== 'undefined' ? AbortSignal : null
    if (AS && typeof AS.timeout === 'function') return AS.timeout(Number(ms) || 0)
  } catch (e) { }
  return undefined
}
