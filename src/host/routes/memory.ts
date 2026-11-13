/**
 * host/routes/memory.ts —— 记忆摘要只读路由（鲸落/记忆胶囊用）
 *
 * 只提供两样东西：长期记忆摘要（summary）和从摘要里提取的抽象主题词。
 * 刻意不返回 history 原文：胶囊要送人，原文绝不能出这台机器。
 *
 * 边界：
 *   · 只读，只认 GET/HEAD；
 *   · 摘要缺失/为空 → 返回空数组，不造内容；
 *   · 提词是启发式的（按标点切分 + 长度过滤），不是理解，调用方不应把它当「总结」。
 */
import { sendJson } from '../respond.js'

/** 主题词上限：太多就不像「印象」了 */
const MAX_TOPICS = 8
/** 单个主题词上限（字） */
const MAX_TOPIC_CHARS = 8

/** 从摘要里提取主题词：按标点切分，取中文片段，去重、截断 */
function extractTopics(summary: string): string[] {
  const raw = String(summary || '')
  if (!raw.trim()) return []
  const pieces = raw.split(/[，。；、,.;!?！？\s\n\r\t]+/)
  const out: string[] = []
  const seen = new Set<string>()
  for (const p of pieces) {
    const w = p.replace(/^[：:（(【\[]+|[）)】\]]+$/g, '').trim()
    if (!w) continue
    if (!/^\p{Script=Han}+$/u.test(w)) continue // 只留纯中文片段，混英文的不当主题
    const clipped = Array.from(w).slice(0, MAX_TOPIC_CHARS).join('')
    if (!clipped || seen.has(clipped)) continue
    seen.add(clipped)
    out.push(clipped)
    if (out.length >= MAX_TOPICS) break
  }
  return out
}

export function createMemoryHandlers(opts: {
  /** 读长期记忆摘要（由 store 注入；失败由调用方兜底） */
  loadMemorySummary: () => string
}) {
  async function handleMemory(req: any, res: any): Promise<void> {
    const method = String((req && req.method) || 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, { ok: false, error: 'method not allowed' }, 405)
      return
    }
    try {
      const summary = String(opts.loadMemorySummary() || '')
      sendJson(res, { ok: true, summary, topics: extractTopics(summary) })
    } catch (err: any) {
      // 读不到就如实说读不到，不回编造的摘要
      sendJson(res, { ok: false, error: String((err && err.message) || err), summary: '', topics: [] })
    }
  }

  return { handleMemory }
}

export { extractTopics }
