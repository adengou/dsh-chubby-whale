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
  chatCacheKey, chatContextFingerprint, readChatRequest, buildChatMessages, summarizeMemory,
} from '../chat-core.js'

// 兼容旧导入方（scripts/selftest.mjs、chat-stream 历史版本）：纯函数仍从本模块可导出
export { HISTORY_IN_PROMPT, normalizeChatText, detectLang, recentHistory, chatCacheKey } from '../chat-core.js'

const CHAT_TIMEOUT = 30 * 1000                 // 主聊天：30 秒
const SUMMARY_TIMEOUT = 20 * 1000              // 长期记忆摘要：20 秒
const CHAT_MAX_BODY = 6 * 1024 * 1024          // 6MB（图片 base64 约 4MB * 1.34）
const NET_FALLBACK = '主人，本鲸一时想不起来话（网络或接口有点问题）……'



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
      // 请求解析统一走 chat-core：流式与普通路径对「消息截断 / lang / voice / 图片 mime」口径一致
      const reqInfo = readChatRequest(body)
      const message = reqInfo.message
      const image = reqInfo.image
      const imageB64 = image.b64
      const isVoice = reqInfo.isVoice
      const cacheable = reqInfo.cacheable
      // 语言档位（auto 已按内容判定，与流式路径共用同一份 detectLang）
      const effLang = reqInfo.lang
      // 用 trim 判空：只发空格/换行不该白调一次模型（图片消息走 VISION_PROMPT 自带文案）
      if (!message.trim()) {
        sendJson(res, { ok: false, error: 'empty message' }, 400)
        return
      }
      // 读一份历史快照 + 长期记忆：只用来拼 prompt / 算缓存 key，不再拿它整份写回
      let history: any[] = []
      try { history = opts.loadHistory() || [] } catch { history = [] }
      let memSummary = ''
      try { memSummary = opts.loadMemorySummary ? String(opts.loadMemorySummary() || '') : '' } catch { }
      // 缓存 key 带上下文指纹（长期记忆摘要 + 上一轮用户消息）与模型名，上下文/模型变了都不复用旧答案
      const cacheKey = chatCacheKey(effLang, message, isVoice, chatContextFingerprint(memSummary, history), model)
      // 缓存查找排在 Key 检查之前：没配 Key 时本地缓存照样能用
      const cacheOn = !opts.cacheEnabled || opts.cacheEnabled() !== false
      if (cacheOn && opts.cache && !imageB64 && cacheable) {
        // 缓存读失败（磁盘/权限）只当未命中，不能把整条聊天打进兜底文案
        try {
          const cached = await opts.cache.getJson(cacheKey, 'json', CHAT_CACHE_TTL)
          if (cached && typeof cached.reply === 'string' && cached.reply.trim().length > 0) {
            let intimacy = 0
            try { const st0 = opts.loadState(); st0.intimacy = Math.min(100, (Number(st0.intimacy) || 0) + 1); opts.saveState(st0); intimacy = Number(st0.intimacy) || 0 } catch { }
            // 缓存命中只加亲密度，不加经验（本次审计要求）
            sendJson(res, { ok: true, reply: cached.reply, intimacy, upgraded: false, cached: true })
            return
          }
        } catch { }
      }
      const key = opts.getKey()
      if (!key) {
        sendJson(res, { ok: false, error: 'NO_KEY', reply: '主人，本鲸还没拿到钥匙（DeepSeek Key），配一下就能聊啦～' })
        return
      }
      // system 片段与消息结构统一由 chat-core 组装（语言硬约束 → 长期记忆 → 语音说明，有图走多模态）
      const messages = buildChatMessages({
        systemPrompt: opts.systemPrompt,
        lang: effLang,
        memSummary,
        isVoice,
        history,
        message,
        image,
      })
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
      // 缓存落盘放在回包之后：cache.setJson 内部还要 await 磁盘写 + prune 目录扫描，
      // 放在回包前会把主人可见的延迟拖上几十~几百毫秒。缓存本身已在 setJson 开头同步进内存，
      // 并发请求照样能命中，不损失命中率。
      // 空回复不写缓存（否则下次 '' 会被当成命中，一直复读空话）
      if (opts.cache && !imageB64 && cacheable && !blank) { try { await opts.cache.setJson(cacheKey, { reply }, 'json', CHAT_CACHE_TTL) } catch { } }
      // L2 可变人格：只对模型真实回复计数（缓存命中不算），不 await，不阻塞响应
      try { if (opts.onReply) opts.onReply() } catch { }
      if (wantSummary && saveSummary) {
        summarizing = true
        // 摘要本次是基于哪一份记忆产生的：20 秒后写回前先做代际校验
        const historyAtReply = history.length
        const summaryAtReply = memSummary
        void summarizeMemory(key, convo, memSummary || '（无）', (s: string) => {
          // 代际校验：这 20 秒里 /clear-memory 把记忆清过（历史归零或摘要被清空），
          // 就不能把清空前的旧对话摘要再写回去——否则「忘了又想起来」。
          try {
            const nowHistory = opts.loadHistory()
            if (Array.isArray(nowHistory) && nowHistory.length < historyAtReply) {
              console.error('[chat] SUMMARY-SKIP 记忆已被清空/缩短（generation mismatch），摘要不写回')
              return
            }
          } catch { }
          try {
            const nowSummary = String(opts.loadMemorySummary ? opts.loadMemorySummary() || '' : '')
            if (nowSummary !== summaryAtReply) {
              console.error('[chat] SUMMARY-SKIP 记忆摘要已被改写（generation mismatch），摘要不写回')
              return
            }
          } catch { }
          saveSummary(s)
        }, model)
          .catch(() => { })
          .finally(() => { summarizing = false })
      }
    } catch (err: any) {
      try { sendError(res, err, { reply: '主人，本鲸卡住了（内部错误）……' }) } catch { }
    }
  }
}
