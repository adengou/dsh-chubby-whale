/**
 * host/routes/story.ts —— 说书路由（薄 HTTP 层）
 * 选段/进度/连播队列在 host/story/player.ts，读盘与 Worker 缓存在 host/story/repo.ts；
 * 这里只解析请求参数、读 x-client-id、回 JSON。
 *
 * 方法约定（2026-11-06 审计补）：
 *   · books / start / next 只接受 GET —— 客户端就是 GET，连续播放也沿用这个既有协议；
 *   · reset 只接受 POST —— 它清进度、改「当前书」，属于状态变更，不能被 GET/预取/爬虫顺手触发。
 * 参数校验（2026-11-06 审计补）：书名/提示词 trim 后限长，并挡掉路径分隔符、控制字符与 `..`；
 *   云端清单里的书名是外部数据，不能原样透传给按文件名读盘的实现。
 *
 * 进度次序（2026-11-07，B97）：播放器只**预约**要讲的那一段，不落盘；这里等响应真的写出去
 *   才调 player.confirm 记账（见 sendPick）。客户端超时/被停止导致连接提前断开时调 player.discard，
 *   这一段回到「未讲」——「没听到的段被记成已讲」正是靠这一步修掉的。
 */
import { readJsonBody } from '../body.js'
import { sendTooLarge } from '../http.js'
import { sendJson, sendError } from '../respond.js'
import type { StoryPick, StoryPlayer } from '../story/player.js'

/** /start /next 成功分支：chunk 平铺进响应体，served 只给路由自己确认进度用（不出现在响应里） */
type ServedPick = Extract<StoryPick, { ok: true }>

// 2026-11-07 B97：删掉原来那行**值级兼容导出**（把播放器的作者表挂在薄路由上）。
// 它让**薄 HTTP 路由**携带播放器的业务数据（全仓零引用），与 ADR 0002「路由只经端口」相悖；
// 作者表本身仍由 host/story/player.ts 导出，需要的人直接 import 那里。

/** 书名/提示词上限：最长书名 4 字，64 已留足余量；超长一律拒，不拿超长串做模糊匹配 */
const MAX_BOOK_LEN = 64
/** POST /reset 请求体上限：只有一个 book 字段，4KB 足够 */
const RESET_MAX_BODY = 4 * 1024
/** 书名里不允许出现：路径分隔符、控制字符、上跳片段（`..`） */
const BAD_BOOK_RE = /[\\/\u0000-\u001F\u007F]|\.\./

export function createStoryHandlers(opts: { player: StoryPlayer }) {
  /** 客户端标识只保留 \w.-，最长 64；拿不到时用空串共用单队列（照旧） */
  function clientId(req: any): string {
    try {
      const raw = req?.headers?.['x-client-id']
      const v = Array.isArray(raw) ? raw[0] : raw
      if (typeof v !== 'string') return ''
      return v.replace(/[^\w.-]/g, '').slice(0, 64)
    } catch { return '' }
  }

  function methodOf(req: any): string {
    return String((req && req.method) || 'GET').toUpperCase()
  }

  /**
   * 书名参数校验。start 允许空（空=接着当前书讲），reset 必须给书名。
   * @returns value 合法书名；error 非空表示应回 400（`no book` / `bad book`）
   */
  function readBookParam(raw: any): { value: string; error: string } {
    const value = String(raw == null ? '' : raw).trim()
    if (!value) return { value: '', error: 'no book' }
    if (value.length > MAX_BOOK_LEN || BAD_BOOK_RE.test(value)) return { value: '', error: 'bad book' }
    return { value, error: '' }
  }

  function sendBadRequest(res: any, error: string): void {
    sendJson(res, { ok: false, error }, 400)
  }

  /** 405 + Allow：错误码语义统一放这里，别各路由自己拼 */
  function rejectMethod(res: any, allow: string): void {
    try { res.setHeader('allow', allow) } catch { }
    sendJson(res, { ok: false, error: 'method not allowed' }, 405)
  }

  /**
   * 说书接口一律 no-store：/next /start 是会推进进度的 GET，
   * 被浏览器/中间缓存按 URL 复用会重复念同一段或跳段。
   */
  function noStore(res: any): void {
    try { res.setHeader('cache-control', 'no-store') } catch { }
  }

  async function handleBooks(req: any, res: any): Promise<void> {
    noStore(res)
    if (methodOf(req) !== 'GET') { rejectMethod(res, 'GET'); return }
    try {
      sendJson(res, { ok: true, books: await opts.player.books() })
    } catch (err: any) {
      sendError(res, err, { books: [] })
    }
  }

  /**
   * 说书段送出后记账（B97）—— 这是「进度次序」的唯一落点：
   *   · 'finish'（数据已全部交给系统）= 送出 → confirm，这一段才被记成已讲；
   *   · 'close' 时还没写完（客户端超时/被停止，fetch 被 abort 直接断连）= 没送出 → discard，
   *     这一段回到「未讲」，下一次请求还会再讲它；
   *   · sendJson 自己抛错（res.end 抛错）→ 同样 discard，并把错照旧交给外层 catch；
   *   · 没有事件面的响应（离线假件/内存实现）监听不了：sendJson 正常返回即视为送出。
   * finish 只代表数据交到了内核，客户端拿到之后自己丢弃（比如朗读中途「停止说话」）服务端看不见，
   * 那条路要客户端回执才能闭合，不在本批次范围内。
   */
  function sendPick(res: any, player: StoryPlayer, picked: ServedPick): void {
    const served = picked && picked.served
    const book = served && typeof served.book === 'string' ? served.book : ''
    const index = served ? Number(served.index) : NaN
    const canSettle = book !== '' && Number.isInteger(index) && index >= 0
      && typeof player.confirm === 'function' && typeof player.discard === 'function'
    /** 能不能监听响应事件：假 res（测试）与内存实现不一定有 EventEmitter 的 removeListener */
    const listening = canSettle && !!(res && typeof res.on === 'function' && typeof res.removeListener === 'function')
    let settled = false
    function detach(): void {
      if (!listening) return
      try {
        res.removeListener('finish', onFinish)
        res.removeListener('close', onClose)
        res.removeListener('error', onError)
      } catch (e: any) { }
    }
    function confirm(): void {
      if (settled) return
      settled = true
      detach()
      try { player.confirm(book, index) } catch (e: any) { }
    }
    function drop(): void {
      if (settled) return
      settled = true
      detach()
      try { player.discard(book, index) } catch (e: any) { }
    }
    function onFinish(): void { confirm() }
    // close 先于 finish = 响应没写完（客户端超时/被停止、连接被重置）→ 撤销，这一段回到未讲。
    // 正常写完时 finish 先到，随后到达的 close 只是 settled 之后的空操作。
    function onClose(): void { drop() }
    function onError(): void { drop() }
    // 连接在写之前就已经断了：实测 Node 里客户端先行断开时 'close' 早已发过（监听不到），
    // 而且 destroyed 之后再 end()，writableFinished 照样会变成 true——只能认 destroyed。
    if (res && res.destroyed === true) { drop(); return }
    // 响应已经被别处写过：这份 JSON 到不了客户端，别把这一段记成已讲
    if (res && res.headersSent === true) { drop(); return }
    if (listening) {
      try {
        res.on('finish', onFinish)
        res.on('close', onClose)
        res.on('error', onError)
      } catch (e: any) { }
    }
    try {
      sendJson(res, { ok: true, ...picked.chunk, remain: picked.remain })
    } catch (err: any) {
      drop()
      throw err
    }
    if (!canSettle) return
    // 没有事件面的响应（离线假件/内存实现）监听不到 finish：sendJson 正常返回即视为送出。
    if (!listening) { confirm(); return }
    // 写到一半连接没了（end() 不抛、也不再来 finish）：同样撤销
    if (res && res.destroyed === true) drop()
  }

  async function handleStoryStart(req: any, res: any): Promise<void> {
    noStore(res)
    if (methodOf(req) !== 'GET') { rejectMethod(res, 'GET'); return }
    try {
      const url = new URL(req.url, 'http://x')
      // 客户端同时带 book 与 hint（同值）；只带 book 的调用方也要能点播，所以 book 作为 hint 的别名
      const hintRaw = url.searchParams.get('hint')
      const bookRaw = url.searchParams.get('book')
      const chosen = String(hintRaw == null ? '' : hintRaw).trim() || String(bookRaw == null ? '' : bookRaw).trim()
      let hint = ''
      if (chosen) {
        const parsed = readBookParam(chosen)
        if (parsed.error) { sendBadRequest(res, parsed.error); return }
        hint = parsed.value
      }
      const picked = await opts.player.start(hint, clientId(req), { defer: true })
      if ('error' in picked) {
        sendJson(res, { ok: false, error: picked.error })
        return
      }
      sendPick(res, opts.player, picked)
    } catch (err: any) {
      sendError(res, err)
    }
  }

  async function handleStoryNext(req: any, res: any): Promise<void> {
    noStore(res)
    if (methodOf(req) !== 'GET') { rejectMethod(res, 'GET'); return }
    try {
      const picked = await opts.player.next(clientId(req), { defer: true })
      if ('error' in picked) {
        sendJson(res, { ok: false, error: picked.error })
        return
      }
      sendPick(res, opts.player, picked)
    } catch (err: any) {
      sendError(res, err)
    }
  }

  /** 从头讲这本书：清掉该书全部进度（book|index 前缀），并把「当前书」指过去 */
  async function handleStoryReset(req: any, res: any): Promise<void> {
    noStore(res)
    if (methodOf(req) !== 'POST') { rejectMethod(res, 'POST'); return }
    try {
      const url = new URL(req.url, 'http://x')
      // 先按 content-length 直接拒：能省掉白读一个大包（也避免慢客户端长时间占连接）。
      // 2026-11-07 起 readBody 对「声明超限」不再断连（不读流、直接抛，由 sendTooLarge 的
      // connection: close 收尾），所以下面那层流式读取是兜底而不是唯一出路。
      const declared = Number(req?.headers?.['content-length'])
      if (Number.isFinite(declared) && declared > RESET_MAX_BODY) { sendTooLarge(res); return }
      // 再读体（流式累计超限同样中止）：不读就没法兜底 413，客户端还在发的 body 会一直占着连接
      const body = await readJsonBody(req, RESET_MAX_BODY)
      if (!body.ok) { sendTooLarge(res); return }
      const fromQuery = url.searchParams.get('book')
      const payload = body.body && typeof body.body === 'object' && !Array.isArray(body.body) ? body.body : {}
      // query 优先（客户端现行写法），body 作为兼容入口；坏 JSON 时 body 退化成 {}，不会把请求打成 500
      const parsed = readBookParam(String(fromQuery == null ? '' : fromQuery).trim() ? fromQuery : payload.book)
      if (parsed.error) { sendBadRequest(res, parsed.error); return }
      const result = await opts.player.reset(parsed.value, clientId(req))
      if ('error' in result) {
        sendJson(res, { ok: false, error: result.error })
        return
      }
      sendJson(res, { ok: true, book: result.book })
    } catch (err: any) {
      sendError(res, err)
    }
  }

  return { handleBooks, handleStoryStart, handleStoryNext, handleStoryReset }
}
