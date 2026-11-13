/**
 * host/routes/chat.ts —— 聊天路由（可复用模块）
 * 外呼统一走 host/http.ts：主聊天 30 秒、记忆摘要 20 秒（后台跑，不吊住回复）；
 * 请求体上限 6MB，单图 base64 上限 4MB（≈3MB 原图，超限回 413，与流式同一口径）
 * 客户端断连（30s 硬超时/切页/断网）立刻中止外呼，不把模型跑完、不记账（B94）：
 *   · 中途被 abort：没有完整回复 → 不写记忆、不记鱼粮、不回包（日志是 CHAT-CLIENT-ABORT）；
 *   · 回复已完整拿到、只是回不去（abort 晚到一步）：照常记账/写记忆 —— 已经付过费，
 *     丢掉反而让记忆里少一轮真实对话。两条口径都由 scripts/test-chat-abort.mjs 钉住。
 * 纯函数（语言判定/缓存 key/prompt 组装）在 host/chat-core.ts，流式路由共用同一份；
 * 本文件只做 HTTP 编排与「缓存 → 模型 → 记忆/成长」的调用顺序。
 *
 * 模型名不写死：由 index.ts 用 readChatModel 按配置算好，经 deps.model 注入；
 * max_tokens 预算见 chat-core.ts 的 CHAT_MAX_TOKENS / SUMMARY_MAX_TOKENS。
 */
import { fetchJson, isAbortError, isTimeoutError, isTimeoutOnly, sendTooLarge, watchClientGone } from '../http.js'
import { readJsonBody } from '../body.js'
import { sendJson, sendError } from '../respond.js'
import { estimateCostCny, readUsageSplit } from '../../shared/pricing.js'
import type { ChatRouteDeps } from '../ports.js'
import { DEFAULT_CHAT_MODEL } from '../config.js'
import {
  CHAT_URL, CHAT_CACHE_TTL, CHAT_MAX_TOKENS,
  chatCacheKey, chatContextFingerprint, readChatRequest, buildChatMessages, summarizeMemory, maybeCreateReminder,
} from '../chat-core.js'

// 兼容旧导入方（scripts/selftest.mjs、chat-stream 历史版本）：纯函数仍从本模块可导出
export { HISTORY_IN_PROMPT, normalizeChatText, detectLang, recentHistory, chatCacheKey } from '../chat-core.js'

const CHAT_TIMEOUT = 30 * 1000                 // 主聊天：30 秒（记忆摘要的超时在 chat-core.summarizeMemory 里）
const CHAT_MAX_BODY = 6 * 1024 * 1024          // 6MB（图片 base64 约 4MB * 1.34）
const NET_FALLBACK = '主人，本鲸一时想不起来话（网络或接口有点问题）……'
/** 图片超限文案：与 host/routes/chat-stream.ts 的同一句保持一致（路由之间不横向 import，各持一份） */
const IMAGE_TOO_LARGE_FALLBACK = '主人，这张图太大啦（原图超过约 3MB），本鲸一口吞不下，换张小一点的再发吧～'
/**
 * 客户端已经走了的日志标签（B94）：与上游超时/网络错误分开，排障时一眼能分清谁先放弃。
 * 分两条是因为时机差一步：外呼发出后断开（中止外呼）/ 请求体还没读完就断开（根本没发起外呼）。
 * 文案刻意不写 CHAT-TIMEOUT / CHAT-NETWORK 这两个标签名（与 /asr 的「不计入 ASR 失败」同口径）：
 * 否则按标签 grep 日志时会自己命中自己。
 */
const LOG_CLIENT_ABORT_OUTBOUND = '[chat] CHAT-CLIENT-ABORT 客户端已断开，上游外呼已中止（不计入上游超时/网络失败）'
const LOG_CLIENT_ABORT_REQUEST = '[chat] CHAT-CLIENT-ABORT 客户端已断开，请求中止（未发起外呼，不计入上游失败）'



export function createChatHandler(opts: ChatRouteDeps) {
  let summaryCount = 0
  let summarizing = false
  // 装配值优先；直接构造 handler（离线测试/旧调用方）时回落到配置模块的默认模型
  const model = opts.model || DEFAULT_CHAT_MODEL
  return async function handleChat(req: any, res: any): Promise<void> {
    // 先挂断连观察器：读 body → 外呼 → 写记忆的整段都在它的看护下，结束时必须 dispose（finally）。
    // 客户端 30s 硬超时/切页/断网先走了以后，宿主不再把这次付费外呼跑满、也不把半截状态记进账（B94）。
    const client = watchClientGone(req, res)
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
      // 图片体积兜底：6MB 管的是整包 JSON，管不住「单图过大」——上限口径在 chat-core，
      // 这里只负责按同一状态码/文案拒绝（不解析、不上传、不调模型，省一次必然失败的请求）
      if (reqInfo.imageTooLarge) {
        console.error('[chat] IMAGE-TOO-LARGE b64=' + imageB64.length)
        sendJson(res, { ok: false, error: 'image too large', reply: IMAGE_TOO_LARGE_FALLBACK }, 413)
        return
      }
      // 主人说「十分钟后提醒我吃早餐」这类话：解析并写进提醒仓储（B106）。
      // 放在缓存查找之前：同样的消息重发/缓存命中也要保证提醒存在；去重在 maybeCreateReminder 里做。
      try { maybeCreateReminder(opts.addReminder, message, Date.now()) } catch (err: any) {
        console.error('[chat] REMINDER-CREATE-FAIL ' + String((err && err.message) || err))
      }
      // 诗词弹幕的唯一触发点（2026-11-14）：只认鲸鱼自己的聊天面板。
      // 之前挂在宿主 user/message 上，工作区输入框里每打一句工作指令都可能冒诗。
      try { if (opts.noteUserChat) opts.noteUserChat(message) } catch (err: any) { }

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
        }, CHAT_TIMEOUT, client.signal)
        if (!r.ok) {
          console.error('[chat] CHAT-HTTP ' + r.status + ' ' + String(r.text || '').slice(0, 200))
          sendJson(res, { ok: false, error: `HTTP ${r.status}`, reply: NET_FALLBACK })
          return
        }
        data = r.data
      } catch (err: any) {
        // 客户端先走了（30s 硬超时/切页/断网）：这次外呼是**我们自己** abort 的，不是上游超时、
        // 也不是网络故障。处理口径与 /asr 一致：不回包（连接已断，没人收）、不写记忆、不记账，
        // 只留专用诊断（B94：此前这里会把它记成 CHAT-TIMEOUT，排障时分不清是谁先放弃的）。
        if (client.gone()) {
          console.error(LOG_CLIENT_ABORT_OUTBOUND)
          return
        }
        // 分类口径（host/http.ts）：内部超时 = TimeoutError；调用方中止但没标 gone = AbortError；其余算网络错
        if (isTimeoutOnly(err)) console.error('[chat] CHAT-TIMEOUT ' + CHAT_TIMEOUT + 'ms 无响应，已中止')
        else if (isAbortError(err)) console.error('[chat] CHAT-ABORT 外呼被中止（无客户端断连标记）')
        else console.error('[chat] CHAT-NETWORK ' + String(err?.message || err))
        // 回给客户端的 error 字段沿用旧口径（超时/中止类都算 timeout），不改客户端可见语义
        sendJson(res, { ok: false, error: isTimeoutError(err) ? 'timeout' : String(err?.message || err), reply: NET_FALLBACK })
        return
      }
      // content 为空时回退取 reasoning_content（照 C#）；两者都空就是真的走神了
      const content = String(data?.choices?.[0]?.message?.content || '').trim()
      const reasoning = String(data?.choices?.[0]?.message?.reasoning_content || '').trim()
      const blank = !content && !reasoning
      const reply = content || reasoning || '主人……本鲸刚刚走神了。'
      // 鱼粮：token 统计（口径见 chat-stream.ts 同一段注释）
      //   · 只记「本轮真拿到模型回复」的 usage.total_tokens：超时/网络/HTTP 非 2xx 都已在上面的
      //     分支 return，那种时候没有可信 usage，硬估会虚记，宁可漏记；
      //   · 上游没返回 usage（部分兼容服务不实现）时同样跳过，不猜；
      //   · 空回复走兜底文案仍算一次正常回复，token 照记——这次请求确实消耗了。
      try {
        const u = data?.usage
        if (u && typeof u.total_tokens === 'number' && opts.addTokens) {
          // 鱼账本（2026-11-07）：把输入/输出拆分与人民币估算一起记进 fishfood.json。
          // 拿不到拆分就只记总量（不猜金额）；金额随「模型 × 高峰/空闲」变化，见 shared/pricing.ts
          const split = readUsageSplit(u)
          const cost = split ? estimateCostCny(split, opts.model) : null
          opts.addTokens('chat', u.total_tokens, split
            ? { promptTokens: split.promptTokens, completionTokens: split.completionTokens, cacheHitTokens: split.cacheHitTokens, costCny: cost ? cost.cny : undefined }
            : undefined)
        }
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
      // 端口读写必须自己 try 住（与 /chat-stream 同口径）：loadState/saveState 抛错时，
      // 不能把「已经花掉 token 换来的回复」吞成一条内部错误——模型调用、token、记忆写回都已完成，
      // 这时回 ok:false 会让客户端把同一条消息重发一次，记忆里出现重复问答。
      // 状态失败只让 intimacy 回 0，回复照常返回。
      let intimacy = 0
      try {
        const st = opts.loadState()
        st.intimacy = Math.min(100, (Number(st.intimacy) || 0) + 1)
        opts.saveState(st)
        intimacy = Number(st.intimacy) || 0
      } catch (err: any) {
        console.error('[chat] STATE-ERR ' + String(err?.message || err))
      }
      // 成长 +1（来源 chat，受日上限与来源上限约束，可能升级）
      // 既有口径：空回复（content/reasoning 都空、已回退到兜底文案）同样计 1 次经验、1 次 L2。
      // 审计已确认这是取舍而非漏判；要改成「空回复不计」属行为变更，本次未动。
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
      sendJson(res, { ok: true, reply: reply || '主人……本鲸刚刚走神了。', intimacy, upgraded })
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
        // 第 6 参：后台摘要的 token 也要进鱼账本（2026-11-07 B97）
        }, model, opts.addTokens)
          .catch(() => { })
          .finally(() => { summarizing = false })
      }
    } catch (err: any) {
      try {
        // 请求体都没收完客户端就断了（req 'aborted' / ECONNRESET）：不算内部错误，也不往死连接写兜底包
        if (client.gone()) {
          console.error(LOG_CLIENT_ABORT_REQUEST)
          return
        }
        sendError(res, err, { reply: '主人，本鲸卡住了（内部错误）……' })
      } catch { }
    } finally {
      // 结束就摘监听：已结束的 handler 没必要继续响应 'close'/'aborted'（与 /asr 同一收口口径）
      client.dispose()
    }
  }
}
