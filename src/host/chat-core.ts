/**
 * host/chat-core.ts —— 聊天领域纯函数（普通 /chat 与流式 /chat-stream 共用）
 *
 * 这些逻辑原先在 routes/chat.ts 里，流式路由再反过来从 chat.ts 横向 import——
 * 路由之间互相依赖，改一处容易断另一处。现在提到本文件：
 *   · 语言判定与缓存 key 规范化
 *   · 历史截断 / 上下文指纹 / prompt 消息组装
 * 不涉及 HTTP、不涉及 fetch、不持有任何状态，便于离线断言（scripts/selftest.mjs 仍用 chat.ts 的再导出）。
 */
import { shortHash, hashKey } from './cache.js'

/** DeepSeek 对话接口地址（聊天与摘要共用） */
export const CHAT_URL = 'https://api.deepseek.com/chat/completions'
/** 只把最近 8 条历史喂给模型（4 轮）；更早的靠长期记忆摘要，省 token */
export const HISTORY_IN_PROMPT = 8
/** 聊天回复缓存 7 天 */
export const CHAT_CACHE_TTL = 7 * 24 * 3600 * 1000

/**
 * 聊天缓存的规范化：语音闲聊要"同一句话就命中"，所以
 *   - 去掉标点/空白/大小写差异（「你好吗？」「你好吗」「你好嗎?」→ 同一个键）
 *   - 不把历史长度/记忆摘要放进键（否则每聊一句键就变，缓存等于没有）
 * 代价：同一句话在不同上下文会得到同一条回复——对语音闲聊这正是省 token 的关键。
 */
export function normalizeChatText(s: string): string {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、；：,.!?;:"'”’“”（）()【】\[\]<>《》~`@#$%^&*_+=|\\/-]/g, '')
}

/** 按内容判语言：有中文→zh；无中文但有拉丁字母→en；否则 auto。纯函数，便于离线断言 */
export function detectLang(message: string): 'zh' | 'en' | 'auto' {
  const t = String(message || '')
  if (/[\u4e00-\u9fa5]/.test(t)) return 'zh'
  if (/[A-Za-z]{2,}/.test(t)) return 'en'
  return 'auto'
}

/** 取最近 n 条（只做截断，不改内容）；纯函数，便于离线断言 */
export function recentHistory(history: any[], n: number): any[] {
  const arr = Array.isArray(history) ? history : []
  const k = Math.max(0, Math.floor(Number(n) || 0))
  return k === 0 ? [] : arr.slice(-k)
}

/** 缓存 key：语言 + 规范化文本 + 是否语音 + 上下文指纹（语音和打字分开存，避免互相串） */
export function chatCacheKey(lang: string, message: string, isVoice: boolean, ctx = ''): string {
  // v2：把上下文指纹（长期记忆摘要 + 上一轮用户消息）算进 key，上下文变了不复用旧答案
  return hashKey('v2|' + lang + '|' + (isVoice ? 'voice' : 'text') + '|' + normalizeChatText(message) + '|' + ctx)
}

/**
 * 上下文指纹（长期记忆摘要 + 上一轮用户消息）。
 * 缓存 key 必须带上上下文：prompt 里拼了完整 history 和长期记忆摘要，
 * 只按「语言|问题」算 key 会让同一句话永远命中第一条回复。
 */
export function chatContextFingerprint(memSummary: string, history: any[]): string {
  try {
    const prevUser = recentHistory(history, HISTORY_IN_PROMPT).filter((m: any) => m && m.role === 'user').slice(-1)[0]
    return shortHash(String(memSummary || '')) + '|' + shortHash(normalizeChatText(String((prevUser && prevUser.content) || '')))
  } catch { return '' }
}

/** 把历史快照转成模型消息（只收 user/assistant 且 content 为字符串，截断到最近 8 条） */
export function historyMessages(history: any[]): any[] {
  const out: any[] = []
  for (const m of recentHistory(history, HISTORY_IN_PROMPT)) {
    if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}

/** 拼 system 提示：人设 + 语言规则 + 长期记忆 +（可选）语音输入说明 */
export function composeSystemPrompt(base: string | (() => string), parts: Array<string | false | null | undefined>): string {
  const text = typeof base === 'function' ? base() : base
  return String(text || '') + parts.filter(Boolean).join('')
}
