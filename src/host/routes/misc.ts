/**
 * host/routes/misc.ts —— 图片/状态/余额/成长/鱼粮/宠物/清除记忆路由（可复用模块）
 */
import { readFile } from 'node:fs/promises'
import { growthStage } from '../store.js'
import { fetchJson, isTimeoutError } from '../http.js'

/** 余额查询超时：15 秒 */
const BALANCE_TIMEOUT = 15 * 1000

export function createMiscHandlers(opts: {
  assetPath: string
  getKey: () => string
  loadState: () => any
  loadGrowth: () => any
  loadFishfood: () => any
  loadPet?: () => any
  feedPet?: () => any
  clearMemory?: () => void
}) {
  async function handleAsset(_req: any, res: any): Promise<void> {
    try {
      const buf = await readFile(opts.assetPath)
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' })
      res.end(buf)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('asset not found')
    }
  }

  async function handleState(_req: any, res: any): Promise<void> {
    const st = opts.loadState()
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, intimacy: Number(st.intimacy) || 0 }))
  }

  async function handleBalance(_req: any, res: any): Promise<void> {
    try {
      const key = opts.getKey()
      if (!key) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'NO_KEY', balance: null }))
        return
      }
      const r = await fetchJson('https://api.deepseek.com/user/balance', { headers: { authorization: `Bearer ${key}` } }, BALANCE_TIMEOUT)
      if (!r.ok) {
        console.error('[misc] BALANCE-HTTP ' + r.status)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: `HTTP ${r.status}`, balance: null }))
        return
      }
      const data: any = r.data
      const infos = data?.balance_infos || []
      const cny = infos.find((x: any) => x.currency === 'CNY') || infos[0] || null
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, balance: cny ? cny.total_balance : null, currency: cny ? cny.currency : 'CNY' }))
    } catch (err: any) {
      // 超时/网络错误：照旧回 ok:false + balance:null，日志里留 BALANCE-TIMEOUT 标签
      if (isTimeoutError(err)) console.error('[misc] BALANCE-TIMEOUT ' + BALANCE_TIMEOUT + 'ms 无响应，已中止')
      else console.error('[misc] BALANCE-ERR ' + String(err?.message || err))
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: isTimeoutError(err) ? 'timeout' : String(err?.message || err), balance: null }))
    }
  }

  async function handleGrowth(_req: any, res: any): Promise<void> {
    const g = opts.loadGrowth()
    const st = growthStage(Number(g.exp) || 0)
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, exp: Number(g.exp) || 0, stage: st.name, nextExp: st.nextExp }))
  }

  async function handleFishfood(_req: any, res: any): Promise<void> {
    const f = opts.loadFishfood()
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({
      ok: true,
      chatTokens: Number(f.chatTokens) || 0,
      storyTokens: Number(f.storyTokens) || 0,
      total: (Number(f.chatTokens) || 0) + (Number(f.storyTokens) || 0),
    }))
  }

  async function handlePet(req: any, res: any): Promise<void> {
    try {
      const url = new URL(req.url, 'http://x')
      if (url.searchParams.get('action') === 'feed' && opts.feedPet) {
        const p = opts.feedPet()
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, pet: p }))
        return
      }
      const p = opts.loadPet ? opts.loadPet() : { feeds: 0, hunger: 0, mood: 'normal' }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, pet: p }))
    } catch (err: any) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }))
    }
  }

  async function handleClearMemory(_req: any, res: any): Promise<void> {
    try {
      if (opts.clearMemory) opts.clearMemory()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true }))
    } catch (err: any) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }))
    }
  }

  function handleStatus(_req: any, res: any): void {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, name: 'dsh-chubby-whale', key: Boolean(opts.getKey()) }))
  }

  return { handleAsset, handleState, handleBalance, handleStatus, handleGrowth, handleFishfood, handlePet, handleClearMemory }
}
