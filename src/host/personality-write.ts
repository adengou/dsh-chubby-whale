/**
 * host/personality-write.ts —— L3「限域人格自写」（只写一句“近期心境”）
 *
 * 节奏（与 L2 学习完全分开，各自计数、各自窗口、互不阻塞）：
 *   · 每 WRITE_EVERY（20）次「模型真实成功回复」后才考虑一次；
 *   · 距上次生成/尝试 ≥ WRITE_MIN_INTERVAL_MS（24 小时），即 24 小时最多一次；
 *   · 重启后计数归零，但还会读 personality.json 的 selfNarrativeAt，避免刚写过的重来一遍；
 *   · 只把最近 WRITE_MESSAGE_COUNT（16）条对话交给当前配置的聊天模型，外加核心人设原文作只读参考。
 *
 * 限域（这是本模块的全部边界）：
 *   · 输入里的核心人设（index.ts 的 SYSTEM_PROMPT）**只读**，从不写回、从不进 history；
 *     system 提示写死：只能写一句 80 字以内的近期心境，绝对不许改名字/家人/生日/出生地/
 *     语言规则/安全底线，不许自称 AI，不许写承诺或事实性断言，不要引号。
 *   · 输出由 host/personality.ts 的 validateSelfNarrative 收口：去引号/换行、6～80 字、
 *     含「我是 / 我改名 / 爸爸 / 妈妈 / 生日 / 出生 / 名字 / AI」等身份词直接丢弃
 *     （记 [personality] SELF-SKIP，不写盘）。
 *   · 写入唯一走 PersonalityRepo.writeNarrative，只动 selfNarrative 一个字段，带 history 回滚。
 *   · 失败/解析失败/超时静默放弃：不写盘、不阻塞回复、不影响 L2。
 */
import { fetchJson } from './http.js'
import { deepFreeze } from '../shared/immutable.js'
import { CHAT_URL, SUMMARY_MAX_TOKENS } from './chat-core.js'
import { DEFAULT_CHAT_MODEL } from './config.js'
import { validateSelfNarrative } from './personality.js'
import type { PersonalityRepo } from './personality.js'

/** 每多少次真实成功回复触发一次自写 */
export const WRITE_EVERY = 20
/** 两次自写尝试的最小间隔（24 小时） */
export const WRITE_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000
/** 一次自写带多少条最近对话（16 条 = 8 轮） */
export const WRITE_MESSAGE_COUNT = 16
/** 自写用模型：默认与聊天一致，装配时由 index.ts 注入配置值（deps.model 优先） */
export const WRITE_MODEL = DEFAULT_CHAT_MODEL
/** 自写请求的 max_tokens 预算（原 160 偏低：一句 80 字也可能被思考挤掉） */
export const WRITE_MAX_TOKENS = SUMMARY_MAX_TOKENS
/** 自写请求超时：20 秒，失败就放弃，不排队重试 */
export const WRITE_TIMEOUT = 20 * 1000
/** 单条历史喂给模型时截断到多少字（token 可控） */
const WRITE_LINE_MAX = 300

/**
 * 按 Unicode 码点截断：`String.prototype.slice` 按 UTF-16 码元切，正好切在 emoji 代理对中间
 * 会留下孤立代理（实测「'字'×299 + '🙂'」会切出半个表情 U+D83D）。喂模型的每行都走这里。
 * 与 host/personality/merge.ts 的 clampText 同一口径（按「字」而不是按码元）。
 */
function clipCodePoints(s: string, max: number): string {
  const chars = Array.from(s)
  return chars.length > max ? chars.slice(0, max).join('') : s
}

/**
 * 取正整数选项：显式 0 表示「最快（1）」，缺省 / 非数值才回落默认值。
 * 审计修复 F9（2026-11-07，同 personality-learn.ts）：原写法 `Number(v) || 默认值` 把显式 0
 * 当成「没传」回落 20，而负数反而被 `Math.max(1, ·)` 收成 1——0 与负数结果相反。
 */
function positiveOption(value: any, fallback: number): number {
  if (value === undefined || value === null) return fallback
  const n = Math.floor(Number(value))
  return Number.isFinite(n) ? Math.max(1, n) : fallback
}

/** 取非负毫秒选项：显式 0 表示「不设最小间隔」，缺省 / 非数值才回落默认值（同 F9 的 0 边界） */
function nonNegativeOption(value: any, fallback: number): number {
  if (value === undefined || value === null) return fallback
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, n) : fallback
}

/**
 * L3 的 system 提示：第一句是需求写死的限域条款，原样保留；
 * 后面几条只是把「一句、6～80 字、只写心情」说清楚，不放宽任何一条限制。
 */
export const SELF_NARRATIVE_SYSTEM_PROMPT = [
  '你是肥鲸。只能写一句 80 字以内的“近期心境”，只描述最近的心情/状态/语气倾向；绝对不许改名字、家人、生日、出生地、语言规则、安全底线；不许自称 AI；不许写承诺或事实性断言；不要引号。',
  '输出要求：',
  '1) 只输出这一句，不要解释、不要 Markdown、不要换行、不要加引号、不要解释你在做什么。',
  '2) 6～80 个汉字，第一人称，像自言自语的一句心情。',
  '3) 只写心情、状态、语气倾向：累了、想撒娇、话少、精神好一点之类；不写事实、计划、承诺、时间地点。',
  '4) 不许提名字、家人、生日、出生地、语言规则、安全底线；不许自称 AI 或大模型。',
  '5) 核心设定只读参考，禁止复述、禁止改写、禁止补充。',
].join('\n')
deepFreeze(SELF_NARRATIVE_SYSTEM_PROMPT)

/**
 * 拼 L3 的 user 消息：核心人设原文（只读，不进 history）+ 最近 16 条对话摘要。
 * 没有任何可用对话时返回空串，调用方据此放弃本次自写（不发请求、不写盘）。
 */
export function buildNarrativeUser(corePrompt: any, messages: any[]): string {
  const core = String(corePrompt == null ? '' : corePrompt).trim()
  const lines: string[] = []
  for (const m of Array.isArray(messages) ? messages.slice(-WRITE_MESSAGE_COUNT) : []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue
    const text = clipCodePoints(m.content.replace(/[\s\u3000]+/g, ' ').trim(), WRITE_LINE_MAX)
    if (!text) continue
    lines.push((m.role === 'user' ? '主人' : '肥鲸') + '：' + text)
  }
  if (!lines.length) return ''
  return '核心设定（只读参考，禁止复述或改写）：\n' + core + '\n\n最近对话：\n' + lines.join('\n')
}

export interface WriteState {
  /** 距上次自写尝试后的成功回复数 */
  successes: number
  /** 上次自写尝试的时间戳（ms）；0 = 从未尝试 */
  lastAttemptAt: number
}

/**
 * 是否该发起一次自写：成功回复攒够 20 次，且距上次尝试 ≥24 小时。
 * lastWrittenAt 是 personality.json 里已存心境的写盘时间（重启后仍生效，避免刚写过又来一次）。
 * 纯函数（now 由调用方传入），便于离线断言 24 小时窗口。
 */
export function shouldWrite(
  state: WriteState,
  now: number,
  opts: { every?: number; minIntervalMs?: number; lastWrittenAt?: number } = {},
): boolean {
  const every = positiveOption(opts.every, WRITE_EVERY)
  const minIntervalMs = nonNegativeOption(opts.minIntervalMs, WRITE_MIN_INTERVAL_MS)
  const successes = Math.floor(Number(state && state.successes) || 0)
  const lastAttempt = Number(state && state.lastAttemptAt) || 0
  const lastWritten = Number(opts.lastWrittenAt) || 0
  const last = Math.max(lastAttempt, lastWritten)
  // last=0 表示从未尝试/从未写过（不是“1970 年刚试过”），直接放行
  return successes >= every && (!last || now - last >= minIntervalMs)
}

export interface WriteResult {
  ok: boolean
  /** 成功写入的文本（仅 ok:true 且有实际写入/相同时给） */
  text?: string
  /** 未执行/失败原因（disabled / running / NO_KEY / EMPTY / HTTP xxx / TOO_SHORT / TOO_LONG / IDENTITY / SAVE_FAILED / error） */
  reason?: string
}

export interface WriterStatus {
  enabled: boolean
  successes: number
  lastAttemptAt: string | null
  lastNarrativeAt: string | null
  running: boolean
}

export interface SelfNarrativeWriter {
  /** 记一次成功回复；满足条件时在后台发起自写（不阻塞、不 await） */
  noteSuccess(): boolean
  /** 立即执行一次自写（内部用；也可供离线验证注入假 fetch） */
  writeNow(): Promise<WriteResult>
  status(): WriterStatus
}

export interface WriterDeps {
  repo: PersonalityRepo
  getKey: () => string
  loadHistory: () => any[]
  /** 核心人设原文（只读）：来自 index.ts 的 SYSTEM_PROMPT，绝不写回 */
  corePrompt: () => string
  /** 总开关（config.json 的 personalityWriting）；缺省视为开 */
  enabled?: () => boolean
  /** 便于离线测试注入时间源 */
  now?: () => number
  /** 便于离线测试注入假 fetch；默认走 host/http.ts 的 fetchJson */
  fetchJson?: typeof fetchJson
  model?: string
}

export function createSelfNarrativeWriter(deps: WriterDeps): SelfNarrativeWriter {
  const enabled = (): boolean => (deps.enabled ? deps.enabled() !== false : true)
  const nowFn = deps.now || ((): number => Date.now())
  const fetchJsonFn = deps.fetchJson || fetchJson
  const model = deps.model || WRITE_MODEL
  const state: WriteState = { successes: 0, lastAttemptAt: 0 }
  let running = false

  async function writeNow(): Promise<WriteResult> {
    if (!enabled()) return { ok: false, reason: 'disabled' }
    if (running) return { ok: false, reason: 'running' }
    const key = String(deps.getKey() || '')
    if (!key) return { ok: false, reason: 'NO_KEY' }
    let user = ''
    try { user = buildNarrativeUser(deps.corePrompt(), deps.loadHistory()) } catch { user = '' }
    if (!user) return { ok: false, reason: 'EMPTY' }

    running = true
    try {
      const r = await fetchJsonFn(CHAT_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SELF_NARRATIVE_SYSTEM_PROMPT },
            { role: 'user', content: user },
          ],
          max_tokens: WRITE_MAX_TOKENS,
          temperature: 0.7,
          thinking: { type: 'disabled' },
        }),
      }, WRITE_TIMEOUT)
      if (!r.ok) {
        console.error('[personality] SELF-HTTP ' + r.status + ' ' + String(r.text || '').slice(0, 200))
        return { ok: false, reason: 'HTTP ' + r.status }
      }
      const content = r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message
        ? r.data.choices[0].message.content : ''
      // 身份词/长度在这里收口：不合格整句丢弃，不写盘（只记一行 SELF-SKIP）
      const check = validateSelfNarrative(content)
      if (!check.ok) {
        console.error('[personality] SELF-SKIP reason=' + check.reason)
        return { ok: false, reason: check.reason }
      }
      const result = deps.repo.writeNarrative(check.text)
      if (!result.changed) {
        // 与现有心境一字不差：没有变更就不写盘、不产生历史
        console.error('[personality] SELF-SAME 与现有心境相同，不写盘')
        return { ok: true, reason: 'same', text: check.text }
      }
      if (!result.saved) {
        console.error('[personality] SELF-SAVE-ERR 写盘失败，本次不生效')
        return { ok: false, reason: 'SAVE_FAILED' }
      }
      console.log('[personality] SELF-OK len=' + Array.from(check.text).length + ' version=' + result.data.version)
      return { ok: true, text: check.text }
    } catch (err: any) {
      console.error('[personality] SELF-ERR ' + String((err && err.message) || err))
      return { ok: false, reason: 'error' }
    } finally {
      running = false
    }
  }

  function noteSuccess(): boolean {
    try {
      if (!enabled()) return false
      const now = nowFn()
      state.successes += 1
      if (running) return false
      if (state.successes < WRITE_EVERY) return false
      // 内存里的 24h 窗口先挡一道，避免每次回复都读盘
      if (state.lastAttemptAt && now - state.lastAttemptAt < WRITE_MIN_INTERVAL_MS) return false
      // 重启后靠已存心境的写盘时间兜底：刚写过就不重复生成
      let lastWrittenAt = 0
      try { lastWrittenAt = Date.parse(String(deps.repo.load().selfNarrativeAt || '')) || 0 } catch { lastWrittenAt = 0 }
      if (!shouldWrite(state, now, { lastWrittenAt })) return false
      // 先记尝试时间、清计数，再后台跑：24 小时窗口与 20 次计数都不会因失败而反复重试烧 token
      state.lastAttemptAt = now
      state.successes = 0
      void writeNow().catch(() => { })
      return true
    } catch {
      return false
    }
  }

  function status(): WriterStatus {
    let lastNarrativeAt: string | null = null
    try { lastNarrativeAt = deps.repo.load().selfNarrativeAt || null } catch { lastNarrativeAt = null }
    return {
      enabled: enabled(),
      successes: state.successes,
      lastAttemptAt: state.lastAttemptAt ? new Date(state.lastAttemptAt).toISOString() : null,
      lastNarrativeAt,
      running,
    }
  }

  return { noteSuccess, writeNow, status }
}
