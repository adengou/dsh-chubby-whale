/**
 * host/routes/story.ts —— 说书路由（薄 HTTP 层）
 * 选段/进度/连播队列在 host/story/player.ts，读盘与 Worker 缓存在 host/story/repo.ts；
 * 这里只解析请求参数、读 x-client-id、回 JSON。
 */
import { sendJson, sendError } from '../respond.js'
import type { StoryPlayer } from '../story/player.js'

/** 兼容旧导出：作者表已随业务移到 host/story/player.ts */
export { STORY_AUTHORS } from '../story/player.js'

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

  async function handleBooks(_req: any, res: any): Promise<void> {
    try {
      sendJson(res, { ok: true, books: await opts.player.books() })
    } catch (err: any) {
      sendError(res, err, { books: [] })
    }
  }

  async function handleStoryStart(req: any, res: any): Promise<void> {
    try {
      const url = new URL(req.url, 'http://x')
      const hint = url.searchParams.get('hint') || ''
      const picked = await opts.player.start(hint, clientId(req))
      if ('error' in picked) {
        sendJson(res, { ok: false, error: picked.error })
        return
      }
      sendJson(res, { ok: true, ...picked.chunk, remain: picked.remain })
    } catch (err: any) {
      sendError(res, err)
    }
  }

  async function handleStoryNext(req: any, res: any): Promise<void> {
    try {
      const picked = await opts.player.next(clientId(req))
      if ('error' in picked) {
        sendJson(res, { ok: false, error: picked.error })
        return
      }
      sendJson(res, { ok: true, ...picked.chunk, remain: picked.remain })
    } catch (err: any) {
      sendError(res, err)
    }
  }

  /** 从头讲这本书：清掉该书全部进度（book|index 前缀），并把「当前书」指过去 */
  async function handleStoryReset(req: any, res: any): Promise<void> {
    try {
      const url = new URL(req.url, 'http://x')
      const want = String(url.searchParams.get('book') || '').trim()
      const result = await opts.player.reset(want, clientId(req))
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
