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
 *
 * 超时（B105）：
 *   · getJson / postJson / delJson 默认带 15s 总预算（DEFAULT_TIMEOUT_MS）。宿主数据接口
 *     自己已有 10s 超时，客户端预算不能比这条链路短，否则会把宿主本可返回的错误也掐掉。
 *   · 调用方可用 init.timeout 覆盖（毫秒；0 / 负数 / 非有限数 = 不设超时）。
 *   · 调用方自带 init.signal 时**不叠加**默认预算：说书（B98）与聊天各自管理 25s / 30s
 *     预算，默认值再压一层会把它们的既有语义改掉。显式 timeout 仍会生效。
 *   · 到点抛 name='TimeoutError' 的错误（与 host/http.ts 的 isTimeoutError 判据同名：
 *     TimeoutError / AbortError 都算）；到点后迟到的响应一律丢弃。
 *   · 老浏览器兼容：用 setTimeout + AbortController 手工组合，不依赖
 *     AbortSignal.timeout（Safari 16+）也不依赖 AbortSignal.any。连 AbortController
 *     都没有的远古环境仍会按预算失败（只是断不了连接）。
 */

/** 所有接口的统一前缀（voice/dropzone 内部仍用自己的 apiBase 常量） */
export const API_BASE = '/api/chubby-whale'

/**
 * 取数接口的默认总预算：15s。
 * 为什么不是 10s：宿主数据接口自己有 10s 超时（B102），客户端必须比它长，
 * 才能收到宿主「超时」的错误体而不是自己先放弃；15s = 宿主 10s + 一次错误回传余量。
 *
 * 不导出：模块接口清单（docs/模块接口清单.md）是受控文件，B105 只改三个文件，
 * 不新增对外符号；调用方要覆盖预算传 init.timeout 即可。
 */
const DEFAULT_TIMEOUT_MS = 15000

export type JsonInit = {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: any
  cache?: string
  /**
   * 本次请求的总预算（毫秒）。不传时 getJson/postJson/delJson 用 DEFAULT_TIMEOUT_MS；
   * 0 / 负数 / 非有限数 = 不设超时（与 timeoutSignal 的「0 表示没有超时」同一口径）。
   */
  timeout?: number
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

/**
 * 预算是正有限数才生效；0 / 负数 / NaN / Infinity 一律按「没有超时」处理
 */
function budgetOf(v: any): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n
}

/** 建一个可中止的控制器；没有 AbortController 的老浏览器（iOS Safari < 12.2）返回 null */
function makeAbortController(): any {
  try {
    const AC: any = typeof AbortController !== 'undefined' ? AbortController : null
    if (AC) return new AC()
  } catch (e) { }
  return null
}

/** 超时错误：name 固定 TimeoutError（与 host/http.ts 的 isTimeoutError 判据同名） */
function timeoutError(ms: number): any {
  const msg = '请求超时（' + ms + 'ms）'
  try {
    const D: any = typeof DOMException !== 'undefined' ? DOMException : null
    if (D) return new D(msg, 'TimeoutError')
  } catch (e) { }
  const err: any = new Error(msg)
  err.name = 'TimeoutError'
  return err
}

/** 调用方中止的原因：优先原样转发 signal.reason，老运行时补一个 AbortError */
function abortReasonOf(src: any): any {
  if (src && src.reason !== undefined) return src.reason
  try {
    const D: any = typeof DOMException !== 'undefined' ? DOMException : null
    if (D) return new D('aborted', 'AbortError')
  } catch (e) { }
  const err: any = new Error('aborted')
  err.name = 'AbortError'
  return err
}

/**
 * 带预算的 fetch。
 *   useDefault=true（getJson/postJson/delJson）：无显式 timeout、无调用方 signal 时用 15s。
 *   useDefault=false（postRaw）：不主动加预算，但调用方显式传 timeout 时照办。
 *
 * 到点做两件事：abort 内部 controller（真的断连接）并 reject TimeoutError。
 * 两条路都留着：即使运行时的 fetch 不认 signal（测试桩/怪实现），计时也会兑现失败，
 * 不会像改造前那样永远挂着。
 */
function fetchWithBudget(url: string, init: JsonInit | undefined, useDefault: boolean): Promise<any> {
  const o: any = Object.assign({}, init || {})
  const hasExplicit = o.timeout !== undefined && o.timeout !== null
  const wanted = hasExplicit
    ? budgetOf(o.timeout)
    : (useDefault && !o.signal ? DEFAULT_TIMEOUT_MS : 0)
  delete o.timeout
  const external: any = o.signal
  const canListen = !!external && typeof external.addEventListener === 'function'
  // 没有预算也没有可监听的中止源：与改造前完全一致，直接交回 fetch
  if (!wanted && !canListen) return fetch(url, o)

  const ctrl = wanted ? makeAbortController() : null
  const detach: Array<() => void> = []
  if (ctrl) {
    o.signal = ctrl.signal
    if (external) {
      // 把调用方的中止桥接到我们自己的 controller（不用 AbortSignal.any）
      if (external.aborted) {
        try { ctrl.abort() } catch (e) { }
      } else if (typeof external.addEventListener === 'function') {
        const forward = (): void => { try { ctrl.abort() } catch (e) { } }
        try {
          external.addEventListener('abort', forward)
          detach.push(() => { try { external.removeEventListener('abort', forward) } catch (e) { } })
        } catch (e) { }
      }
    }
  } else if (external) {
    // 没有预算、或没有 AbortController：signal 原样交给 fetch；中止仍由下面的监听兜住
    o.signal = external
  }

  return new Promise((resolve, reject) => {
    let done = false
    let timer: any = null
    const cleanup = (): void => {
      while (detach.length) {
        const fn = detach.pop()
        try { if (fn) fn() } catch (e) { }
      }
    }
    const finish = (fn: any, v: any): void => {
      if (done) return
      done = true
      try { if (timer) clearTimeout(timer) } catch (e) { }
      cleanup()
      fn(v)
    }
    if (wanted) {
      timer = setTimeout(() => {
        if (ctrl) { try { ctrl.abort() } catch (e) { } }
        finish(reject, timeoutError(wanted))
      }, wanted)
      // Node（测试/自检）里别让这个预算把进程吊住；浏览器 setTimeout 返回数字，没有 unref
      try { if (timer && typeof timer.unref === 'function') timer.unref() } catch (e) { }
    }
    // 调用方在预算内先中止：立刻按 AbortError 结算，不误报成超时
    // （即使某些 fetch 不认 signal，也在这一层兑现；预算为 0 时同样生效）
    if (canListen) {
      const onAbort = (): void => { finish(reject, abortReasonOf(external)) }
      if (external.aborted) { onAbort(); return }
      try {
        external.addEventListener('abort', onAbort)
        detach.push(() => { try { external.removeEventListener('abort', onAbort) } catch (e) { } })
      } catch (e) { }
    }
    // fetch 必须**同步**发出（与改造前一致）：说书 P0 与 poem-titles 退避都依赖
    // 「start() 返回时请求已在途」，改成微任务会晚一拍（B105 回归实测）
    let pending: any
    try {
      pending = fetch(url, o)
    } catch (e) {
      finish(reject, e)
      return
    }
    Promise.resolve(pending).then(
      (r: any) => finish(resolve, r),
      (e: any) => finish(reject, e),
    )
  })
}

/** 原始 GET（接受 Response 本身时用，例如需要读 body 流的场景；不带默认预算） */
export function request(path: string, init?: JsonInit): Promise<any> {
  return fetch(apiUrl(path), Object.assign({}, init || {}) as any)
}

/** GET 并解析 JSON（默认 15s 预算，init.timeout 可覆盖） */
export function getJson(path: string, init?: JsonInit): Promise<any> {
  return fetchWithBudget(apiUrl(path), init, true).then((r: any) => r.json())
}

/** POST 的 init 组装（postRaw / postJson 共用，避免两处 body/header 逻辑漂移） */
function postInit(body?: any, init?: JsonInit): JsonInit {
  const o: JsonInit = Object.assign({}, init || {})
  o.method = 'POST'
  if (body !== undefined) {
    o.headers = Object.assign({ 'content-type': 'application/json' }, o.headers || {})
    o.body = JSON.stringify(body)
  }
  return o
}

/** 原始 POST（需要 Response 对象的流式接口用；不主动加预算，显式 timeout 仍生效） */
export function postRaw(path: string, body?: any, init?: JsonInit): Promise<any> {
  return fetchWithBudget(apiUrl(path), postInit(body, init), false)
}

/** POST JSON（body 省略时发空体，用于 /clear-memory 这类无参接口；默认 15s 预算） */
export function postJson(path: string, body?: any, init?: JsonInit): Promise<any> {
  return fetchWithBudget(apiUrl(path), postInit(body, init), true).then((r: any) => r.json())
}

/** DELETE 并解析 JSON（默认 15s 预算，init.timeout 可覆盖） */
export function delJson(path: string, init?: JsonInit): Promise<any> {
  // init 里若带 method 不能覆盖掉 DELETE：函数名承诺的就是 DELETE（同理 postRaw 强制 POST）
  const o: JsonInit = Object.assign({}, init || {})
  o.method = 'DELETE'
  return fetchWithBudget(apiUrl(path), o, true).then((r: any) => r.json())
}

/**
 * AbortSignal.timeout 的安全包装：浏览器不支持时返回 undefined（绝不因此报错）。
 * ms 必须为正的有限数：0/NaN 调 AbortSignal.timeout(0) 会**立即**中止请求，
 * 调用方本意多半是「没有超时」，所以这里按不支持处理。
 *
 * 注意：默认预算**不走**这个包装（它依赖 Safari 16+ 的 AbortSignal.timeout）；
 * fetchWithBudget 用 setTimeout + AbortController，老浏览器同样有效。本函数保留给
 * 需要「纯 signal」的既有调用方（说书 B98 的超时桥接、poem-titles 的 8s 预热）。
 */
export function timeoutSignal(ms: number): any {
  try {
    const n = Number(ms)
    if (!Number.isFinite(n) || n <= 0) return undefined
    const AS: any = typeof AbortSignal !== 'undefined' ? AbortSignal : null
    if (AS && typeof AS.timeout === 'function') return AS.timeout(n)
  } catch (e) { }
  return undefined
}
