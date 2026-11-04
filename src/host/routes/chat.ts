/**
 * host/routes/chat.ts —— 聊天路由（可复用模块）
 */
import { hashKey } from '../cache.js'
export function createChatHandler(opts: {
  getKey: () => string
  loadHistory: () => any[]
  saveHistory: (arr: any[]) => void
  loadState: () => any
  saveState: (obj: any) => void
  systemPrompt: string
  addExp?: (n: number) => any
  addTokens?: (kind: string, n: number) => any
  cache?: any
  loadMemorySummary?: () => string
  saveMemorySummary?: (s: string) => void
}) {
  let summaryCount = 0
  return async function handleChat(req: any, res: any): Promise<void> {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const text = Buffer.concat(chunks).toString('utf8')
      let body: any = {}
      try { body = text ? JSON.parse(text) : {} } catch { body = {} }
      const message = typeof body?.message === 'string' ? body.message.slice(0, 500) : ''
      const imageB64 = typeof body?.image === 'string' ? body.image : ''
      const chatLang = (typeof body?.lang === 'string' && /^(zh|en|auto)$/.test(body.lang)) ? body.lang : 'auto'
      const imageMime = typeof body?.imageMime === 'string' ? body.imageMime : 'image/jpeg'
      // 短句（<6 字）不进缓存：不然「在吗」「好的」会被复读机式复用（照 C# 的修法）
      const cacheable = message.trim().length >= 6
      if (!message) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'empty message' }))
        return
      }
      const key = opts.getKey()
      if (!key) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'NO_KEY', reply: '主人，本鲸还没拿到钥匙（DeepSeek Key），配一下就能聊啦～' }))
        return
      }
      // 缓存：相同问题直接复用回复（省 token；问题太短不缓存）
      const cacheKey = hashKey(chatLang + '|' + message + (imageB64 ? '|img' : ''))
      if (opts.cache && !imageB64 && cacheable) {
        const cached = await opts.cache.getJson(cacheKey)
        if (cached && typeof cached.reply === 'string') {
          try { const st0 = opts.loadState(); st0.intimacy = Math.min(100, (Number(st0.intimacy) || 0) + 1); opts.saveState(st0) } catch { }
          try { if (opts.addExp) opts.addExp(1) } catch { }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, reply: cached.reply, intimacy: (Number((opts.loadState().intimacy) || 0)), upgraded: false, cached: true }))
          return
        }
      }
      const history = opts.loadHistory()
      const langHint = chatLang === 'en' ? '\n重要：无论用户用什么语言提问，你都必须用英文回答。' : ''
      let memSummary = ''
      try { memSummary = opts.loadMemorySummary ? String(opts.loadMemorySummary() || '') : '' } catch { }
      const memHint = memSummary ? ('\n（关于主人的长期记忆：' + memSummary + '）') : ''
      const messages: any[] = [{ role: 'system', content: opts.systemPrompt + langHint + memHint }]
      for (const m of history) {
        if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') {
          messages.push({ role: m.role, content: m.content })
        }
      }
      if (imageB64) {
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: message || '请描述这张图片，用中文回答。' },
            { type: 'image_url', image_url: { url: 'data:' + imageMime + ';base64,' + imageB64 } },
          ],
        })
      } else {
        messages.push({ role: 'user', content: message })
      }
      const resp = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: 'deepseek-flash',
          messages,
          max_tokens: 300,
          temperature: 0.8,
          thinking: { type: 'disabled' },
        }),
      })
      if (!resp.ok) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: `HTTP ${resp.status}`, reply: '主人，本鲸一时想不起来话（网络或接口有点问题）……' }))
        return
      }
      const data: any = await resp.json()
      const reply = String(data?.choices?.[0]?.message?.content || '').trim()
      // 鱼粮：token 统计
      try {
        const u = data?.usage
        if (u && typeof u.total_tokens === 'number' && opts.addTokens) opts.addTokens('chat', u.total_tokens)
      } catch { }
      if (opts.cache && !imageB64 && cacheable) { try { await opts.cache.setJson(cacheKey, { reply }) } catch { } }
      history.push({ role: 'user', content: message })
      history.push({ role: 'assistant', content: reply || '主人……本鲸刚刚走神了。' })
      opts.saveHistory(history)
      // 亲密度 +1
      const st = opts.loadState()
      st.intimacy = Math.min(100, (Number(st.intimacy) || 0) + 1)
      opts.saveState(st)
      // 成长 +1（可能升级）
      let upgraded = false
      try {
        if (opts.addExp) {
          const g = opts.addExp(1)
          upgraded = Boolean(g && g.upgraded)
        }
      } catch { }
      // 每 10 次聊天更新长期记忆摘要（照 fish-pet：旧记忆+最近16条 → LLM 压缩 ≤80 字）
      try {
        summaryCount = (summaryCount + 1) % 10
        if (summaryCount === 0 && history.length >= 6 && opts.saveMemorySummary) {
          const convo = history.slice(-16).map((m: any) => (m.role === 'user' ? '主人' : '肥鲸') + '：' + String(m.content || '')).join('\n')
          const sys2 = '你在帮一条桌面宠物鱼整理长期记忆。把对话压缩成不超过80字的中文要点，只保留关于主人的事实（称呼、喜好、约定）和主人交代要记住的事。不要评论，不要加引号，只输出要点本身。'
          const old = memSummary || '（无）'
          const body2 = JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'system', content: sys2 }, { role: 'user', content: '旧记忆：' + old + '\n最近对话：\n' + convo }], max_tokens: 220, temperature: 0.3, thinking: { type: 'disabled' } })
          const r2 = await fetch('https://api.deepseek.com/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: body2 })
          if (r2.ok) { const d2: any = await r2.json(); const s2 = String(d2?.choices?.[0]?.message?.content || '').trim(); if (s2) opts.saveMemorySummary(s2) }
        }
      } catch { }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, reply: reply || '主人……本鲸刚刚走神了。', intimacy: st.intimacy, upgraded }))
    } catch (err: any) {
      try {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: String(err?.message || err), reply: '主人，本鲸卡住了（内部错误）……' }))
      } catch { }
    }
  }
}
