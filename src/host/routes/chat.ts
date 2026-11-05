/**
 * host/routes/chat.ts —— 聊天路由（可复用模块）
 * 外呼统一走 host/http.ts：主聊天 30 秒、记忆摘要 20 秒（后台跑，不吊住回复）；请求体上限 6MB
 * 纯函数（语言判定/缓存 key/prompt 组装）在 host/chat-core.ts，流式路由共用同一份；
 * 本文件只做 HTTP 编排与「缓存 → 模型 → 记忆/成长」的调用顺序。
 *
 * 模型名不写死：由 index.ts 用 readChatModel 按配置算好，经 deps.model 注入；
 * max_tokens 预算见 chat-core.ts 的 CHAT_MAX_TOKENS / SUMMARY_MAX_TOKENS。
 */
import { fetchJson, isTimeoutError, sendTooLarge } from '../http.js'
import { readJsonBody } from '../body.js'
import { sendJson, sendError } from '../respond.js'
import type { ChatRouteDeps } from '../ports.js'
import { DEFAULT_CHAT_MODEL } from '../config.js'
import {
  CHAT_URL, CHAT_CACHE_TTL, CHAT_MAX_TOKENS, SUMMARY_MAX_TOKENS,
  detectLang, chatCacheKey, chatContextFingerprint, historyMessages, composeSystemPrompt,
} from '../chat-core.js'

// 兼容旧导入方（scripts/selftest.mjs、chat-stream 历史版本）：纯函数仍从本模块可导出
export { HISTORY_IN_PROMPT, normalizeChatText, detectLang, recentHistory, chatCacheKey } from '../chat-core.js'

const CHAT_TIMEOUT = 30 * 1000                 // 主聊天：30 秒
const SUMMARY_TIMEOUT = 20 * 1000              // 长期记忆摘要：20 秒
const CHAT_MAX_BODY = 6 * 1024 * 1024          // 6MB（图片 base64 约 4MB * 1.34）
const NET_FALLBACK = '主人，本鲸一时想不起来话（网络或接口有点问题）……'

/** 后台压缩长期记忆（不 await，失败只记日志）；模型与主聊天同一个装配值 */
async function summarizeMemory(key: string, convo: string, oldSummary: string, save: (s: string) => void, model: string): Promise<void> {
  const sys = '你在帮一条桌面宠物鱼整理长期记忆。把对话压缩成不超过80字的中文要点，只保留关于主人的事实（称呼、喜好、约定）和主人交代要记住的事。不要评论，不要加引号，只输出要点本身。'
  const body = JSON.stringify({ model, messages: [{ role: 'system', content: sys }, { role: 'user', content: '旧记忆：' + oldSummary + '\n最近对话：\n' + convo }], max_tokens: SUMMARY_MAX_TOKENS, temperature: 0.3, thinking: { type: 'disabled' } })
  try {
    const r = await fetchJson(CHAT_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body }, SUMMARY_TIMEOUT)
    if (!r.ok) { console.error('[chat] SUMMARY-HTTP ' + r.status + ' ' + String(r.text || '').slice(0, 200)); return }
    const s = String(r.data?.choices?.[0]?.message?.content || '').trim()
    if (s) save(s)
  } catch (err: any) {
    if (isTimeoutError(err)) console.error('[chat] SUMMARY-TIMEOUT ' + SUMMARY_TIMEOUT + 'ms 无响应，已中止')
    else console.error('[chat] SUMMARY-ERR ' + String(err?.message || err))
  }
}

export function createChatHandler(opts: ChatRouteDeps) {
  let summaryCount = 0
  let summarizing = false
  // 装配值优先；直接构造 handler（离线测试/旧调用方）时回落到配置模块的默认模型
  const model = opts.model || DEFAULT_CHAT_MODEL
  return async function handleChat(req: any, res: any): Promise<void> {
    try {
      const parsed = await readJsonBody(req, CHAT_MAX_BODY)
      if (!parsed.ok) {
        console.error('[chat] BODY-TOO-LARGE > ' + CHAT_MAX_BODY + ' bytes')
        sendTooLarge(res)
        return
      }
      const body = parsed.body
      const message = typeof body?.message === 'string' ? body.message.slice(0, 500) : ''
      const imageB64 = typeof body?.image === 'string' ? body.image : ''
      const chatLang = (typeof body?.lang === 'string' && /^(zh|en|auto)$/.test(body.lang)) ? body.lang : 'auto'
      // auto 模式下按内容判语言（与流式路径共用 detectLang）
      const effLang = chatLang === 'auto' ? detectLang(message) : chatLang
      const imageMime = typeof body?.imageMime === 'string' ? body.imageMime : 'image/jpeg'
      // 短句（<6 字）不进缓存：不然「在吗」「好的」会被复读机式复用（照 C# 的修法）
      const isVoice = body?.voice === true || body?.voice === 'true'
      // 语音闲聊门槛降到 2 个字（"在吗""讲个笑话"也要能命中）；打字仍要 ≥6 字
      const cacheable = message.trim().length >= (isVoice ? 2 : 6)
      // 用 trim 判空：只发空格/换行不该白调一次模型（图片消息走 VISION_PROMPT 自带文案）
      if (!message.trim()) {
        sendJson(res, { ok: false, error: 'empty message' }, 400)
        return
      }
      // 读一份历史快照 + 长期记忆：只用来拼 prompt / 算缓存 key，不再拿它整份写回
      const history = opts.loadHistory()
      let memSummary = ''
      try { memSummary = opts.loadMemorySummary ? String(opts.loadMemorySummary() || '') : '' } catch { }
      // 缓存 key 带上下文指纹（长期记忆摘要 + 上一轮用户消息）与模型名，上下文/模型变了都不复用旧答案
      const cacheKey = chatCacheKey(effLang, message, isVoice, chatContextFingerprint(memSummary, history), model)
      // 缓存查找排在 Key 检查之前：没配 Key 时本地缓存照样能用
      const cacheOn = !opts.cacheEnabled || opts.cacheEnabled() !== false
      if (cacheOn && opts.cache && !imageB64 && cacheable) {
        const cached = await opts.cache.getJson(cacheKey, 'json', CHAT_CACHE_TTL)
        if (cached && typeof cached.reply === 'string' && cached.reply.trim().length > 0) {
          let intimacy = 0
          try { const st0 = opts.loadState(); st0.intimacy = Math.min(100, (Number(st0.intimacy) || 0) + 1); opts.saveState(st0); intimacy = Number(st0.intimacy) || 0 } catch { }
          // 缓存命中只加亲密度，不加经验（本次审计要求）
          sendJson(res, { ok: true, reply: cached.reply, intimacy, upgraded: false, cached: true })
          return
        }
      }
      const key = opts.getKey()
      if (!key) {
        sendJson(res, { ok: false, error: 'NO_KEY', reply: '主人，本鲸还没拿到钥匙（DeepSeek Key），配一下就能聊啦～' })
        return
      }
      // 语言硬约束：英文提问必须英文作答（模型默认会跟着中文人设走，必须明说）
      const langHint = effLang === 'en'
        ? '\n【语言规则·必须遵守】主人这条消息是英文。你必须用英文回答（Reply in English only）。'
          + '不要用中文回答，不要说看不懂或一头雾水——这就是一句普通英文，直接自然回答即可。'
          + '中文只允许出现在解释专有名词时。'
        : (effLang === 'zh' ? '\n【语言规则】主人用中文提问，请用中文回答。' : '')
      const memHint = memSummary ? ('\n（关于主人的长期记忆：' + memSummary + '）') : ''
      // 语音输入是 ASR 结果，可能有错字/口语碎屑：明确告诉模型按大意理解，别纠正错字、别答非所问
      const voiceHint = isVoice
        ? '\n【输入说明】这条消息来自语音识别，可能出现错字、同音字、断句错误或口水词。'
          + '请按最合理的日常意思理解后直接回答，不要复述原句、不要纠正错字、不要反问「你是不是想说…」，'
          + '也不要因为听不清就说看不懂。'
        : ''
      const messages: any[] = [{ role: 'system', content: composeSystemPrompt(opts.systemPrompt, [langHint, memHint, voiceHint]) }]
      messages.push(...historyMessages(history))
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
      let data: any = null
      try {
        const r = await fetchJson(CHAT_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model,
            messages,
            max_tokens: CHAT_MAX_TOKENS,
            temperature: 0.8,
            thinking: { type: 'disabled' },
          }),
        }, CHAT_TIMEOUT)
        if (!r.ok) {
          console.error('[chat] CHAT-HTTP ' + r.status + ' ' + String(r.text || '').slice(0, 200))
          sendJson(res, { ok: false, error: `HTTP ${r.status}`, reply: NET_FALLBACK })
          return
        }
        data = r.data
      } catch (err: any) {
        // 超时/网络错误：用户看到的仍是原来的兜底文案，日志里留标签
        if (isTimeoutError(err)) console.error('[chat] CHAT-TIMEOUT ' + CHAT_TIMEOUT + 'ms 无响应，已中止')
        else console.error('[chat] CHAT-NETWORK ' + String(err?.message || err))
        sendJson(res, { ok: false, error: isTimeoutError(err) ? 'timeout' : String(err?.message || err), reply: NET_FALLBACK })
        return
      }
      // content 为空时回退取 reasoning_content（照 C#）；两者都空就是真的走神了
      const content = String(data?.choices?.[0]?.message?.content || '').trim()
      const reasoning = String(data?.choices?.[0]?.message?.reasoning_content || '').trim()
      const blank = !content && !reasoning
      const reply = content || reasoning || '主人……本鲸刚刚走神了。'
      // 鱼粮：token 统计
      try {
        const u = data?.usage
        if (u && typeof u.total_tokens === 'number' && opts.addTokens) opts.addTokens('chat', u.total_tokens)
      } catch { }
      // 空回复不写缓存（否则下次 '' 会被当成命中，一直复读空话）
      if (opts.cache && !imageB64 && cacheable && !blank) { try { await opts.cache.setJson(cacheKey, { reply }, 'json', CHAT_CACHE_TTL) } catch { } }
      // 记忆写回：单轮原子追加，不再「读整份 history → 覆盖写」（并发两路会互相覆盖，/clear-memory 也会被写回）
      try {
        // 记忆写入的唯一入口：index 直接注入 store.appendTurns（不再借用 saveHistory 上的兼容属性）
        if (typeof opts.appendTurns === 'function') opts.appendTurns(message, reply)
        else console.error('[chat] MEMORY-APPEND-MISSING 没有 appendTurns，跳过记忆写入')
      } catch (err: any) {
        console.error('[chat] MEMORY-APPEND-ERR ' + String(err?.message || err))
      }
      // 亲密度 +1
      const st = opts.loadState()
      st.intimacy = Math.min(100, (Number(st.intimacy) || 0) + 1)
      opts.saveState(st)
      // 成长 +1（来源 chat，受日上限与来源上限约束，可能升级）
      let upgraded = false
      try {
        if (opts.addExp) {
          const g = opts.addExp(1, 'chat')
          upgraded = Boolean(g && g.upgraded)
          if (g && g.capped) console.error('[chat] EXP-CAPPED source=chat exp=' + (Number(g.exp) || 0))
        }
      } catch { }
      // 每 10 次聊天压缩一次长期记忆：先把要用的东西全取出来，res.end 之后再让它在后台跑
      summaryCount = (summaryCount + 1) % 10
      const wantSummary = summaryCount === 0 && history.length >= 6 && Boolean(opts.saveMemorySummary) && !summarizing
      let convo = ''
      if (wantSummary) {
        const lines = history.slice(-14).map((m: any) => (m.role === 'user' ? '主人' : '肥鲸') + '：' + String(m.content || ''))
        lines.push('主人：' + message)
        lines.push('肥鲸：' + reply)
        convo = lines.join('\n')
      }
      const saveSummary = opts.saveMemorySummary
      sendJson(res, { ok: true, reply: reply || '主人……本鲸刚刚走神了。', intimacy: st.intimacy, upgraded })
      // L2 可变人格：只对模型真实回复计数（缓存命中不算），不 await，不阻塞响应
      try { if (opts.onReply) opts.onReply() } catch { }
      if (wantSummary && saveSummary) {
        summarizing = true
        void summarizeMemory(key, convo, memSummary || '（无）', saveSummary, model)
          .catch(() => { })
          .finally(() => { summarizing = false })
      }
    } catch (err: any) {
      try { sendError(res, err, { reply: '主人，本鲸卡住了（内部错误）……' }) } catch { }
    }
  }
}
