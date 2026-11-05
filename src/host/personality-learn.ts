/**
 * host/personality-learn.ts —— L2 可变人格的低频学习（省 token）
 *
 * 节奏（与需求一致）：
 *   · 每 LEARN_EVERY（20）次「模型真实成功回复」后才考虑一次；
 *   · 两次尝试之间至少隔 LEARN_MIN_INTERVAL_MS（6 小时），即 6 小时最多一次；
 *   · 只把最近 LEARN_MESSAGE_COUNT（16）条对话（8 轮）交给当前配置的聊天模型提取；
 *   · 失败静默：只在 console 记一行 [personality] 日志，绝不影响回复、不写坏人格；
 *   · 缓存命中的回复不计数（复读同一句学不到新东西），流式中断的半截回复也不计数。
 *
 * 安全边界：提取结果由 host/personality.ts 的白名单收口，只认
 * catchphrases / preferences / notes；核心设定（名字/家人/生日/出生地/语言规则/安全边界）
 * 不在可写字段里，模型输出再多也改不了核心提示词。
 */
import { fetchJson } from './http.js'
import { CHAT_URL, SUMMARY_MAX_TOKENS } from './chat-core.js'
import { DEFAULT_CHAT_MODEL } from './config.js'
import type { PersonalityRepo } from './personality.js'

/** 每多少次成功回复触发一次提取 */
export const LEARN_EVERY = 20
/** 两次提取尝试的最小间隔（6 小时） */
export const LEARN_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000
/** 一次提取带多少条最近对话（16 条 = 8 轮） */
export const LEARN_MESSAGE_COUNT = 16
/** 提取用模型：默认与聊天一致，装配时由 index.ts 注入配置值（deps.model 优先） */
export const LEARN_MODEL = DEFAULT_CHAT_MODEL
/** 提取请求的 max_tokens 预算（原 320 偏低：新模型思考也会吃预算） */
export const LEARN_MAX_TOKENS = SUMMARY_MAX_TOKENS
/** 提取请求超时：20 秒，失败就放弃，不排队重试 */
const LEARN_TIMEOUT = 20 * 1000
/** 单条历史喂给提取模型时截断到多少字（16 条 × 300 字以内，token 可控） */
const LEARN_LINE_MAX = 300

/**
 * 提取提示词：只要求 JSON，且明确禁止把鲸鱼的核心设定写进来。
 * 「没有新信息就返回空」让模型自己收手，配合 applyCandidate 的“无变化不写盘”，
 * 没新东西时不会产生版本、历史或请求以外的副作用。
 */
export const EXTRACTION_SYSTEM_PROMPT = [
  '你在帮桌面宠物鲸鱼「肥鲸」整理对主人的长期记忆。只输出一个 JSON 对象，不要解释、不要 Markdown、不要代码块。',
  '格式：{"catchphrases":["主人常说的口头禅"],"preferences":["主人的偏好或约定"],"notes":"一句补充"}',
  '规则：',
  '1) 只收主人明确说过、且以后还用得上的信息：口头禅、喜欢/讨厌的事、与主人的约定。',
  '2) 每类最多 3 条；每条口头禅不超过 12 字，每条偏好不超过 30 字，notes 不超过 60 字。',
  '3) 直接写内容，不要加「主人说」「主人喜欢」这类前缀，不要加书名号或引号。',
  '4) 鲸鱼自己的核心设定（名字、家人、生日、出生地、语言规则、安全边界）是锁定的，绝对不能写进 JSON；也不要收住址、电话、证件、账号密码等隐私。',
  '5) 没有值得记的新信息，就返回 {"catchphrases":[],"preferences":[],"notes":""}。',
].join('\n')

/** 把最近若干条对话压成「主人：… / 肥鲸：…」文本；没有可用内容时返回空串 */
export function buildExtractionUser(messages: any[]): string {
  const arr = Array.isArray(messages) ? messages : []
  const lines: string[] = []
  for (const m of arr.slice(-LEARN_MESSAGE_COUNT)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue
    const text = m.content.replace(/[\s\u3000]+/g, ' ').trim().slice(0, LEARN_LINE_MAX)
    if (!text) continue
    lines.push((m.role === 'user' ? '主人' : '肥鲸') + '：' + text)
  }
  return lines.join('\n')
}

/**
 * 解析提取结果（容错代码块与前后废话）：
 *   · 取第一个 { 到最后一个 } 再 JSON.parse；
 *   · 不是 JSON / 不是对象 → null（调用方据此放弃本次学习，不写任何东西）；
 *   · 只回三个白名单字段，未知键（名字/生日/家人等）直接忽略——这是核心设定不被写入的最后一道闸。
 */
export function parseExtraction(text: any): { catchphrases: string[]; preferences: string[]; notes: string } | null {
  const raw = String(text == null ? '' : text).trim()
  if (!raw) return null
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let obj: any
  try { obj = JSON.parse(raw.slice(start, end + 1)) } catch { return null }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const strings = (v: any): string[] => Array.isArray(v) ? v.filter((x: any) => typeof x === 'string') : []
  return {
    catchphrases: strings(obj.catchphrases),
    preferences: strings(obj.preferences),
    notes: typeof obj.notes === 'string' ? obj.notes : '',
  }
}

export interface LearnState {
  /** 距上次提取尝试后的成功回复数 */
  successes: number
  /** 上次提取尝试的时间戳（ms）；0 = 从未尝试 */
  lastAttemptAt: number
}

/**
 * 是否该发起一次提取：成功回复攒够 20 次，且距上次尝试 ≥6 小时。
 * 纯函数（now 由调用方传入），便于离线断言。
 */
export function shouldLearn(state: LearnState, now: number, opts: { every?: number; minIntervalMs?: number } = {}): boolean {
  const every = Math.max(1, Math.floor(Number(opts.every) || LEARN_EVERY))
  const minIntervalMs = Math.max(0, Number(opts.minIntervalMs) || LEARN_MIN_INTERVAL_MS)
  const successes = Math.floor(Number(state && state.successes) || 0)
  const last = Number(state && state.lastAttemptAt) || 0
  // lastAttemptAt=0 表示从未尝试过（不是“1970 年刚试过”），直接放行
  return successes >= every && (!last || now - last >= minIntervalMs)
}

export interface LearnResult {
  ok: boolean
  /** 变化了的字段名（无新信息时为空数组） */
  changed?: string[]
  /** 未执行/失败原因（disabled / running / NO_KEY / EMPTY / HTTP xxx / parse / error） */
  reason?: string
}

export interface LearnerStatus {
  enabled: boolean
  successes: number
  lastAttemptAt: string | null
  running: boolean
}

export interface PersonalityLearner {
  /** 记一次成功回复；满足条件时在后台发起提取（不阻塞、不 await） */
  noteSuccess(): boolean
  /** 立即执行一次提取（内部用；也可供离线验证注入假 fetch） */
  learnNow(): Promise<LearnResult>
  status(): LearnerStatus
}

export interface LearnerDeps {
  repo: PersonalityRepo
  getKey: () => string
  loadHistory: () => any[]
  /** 总开关（config.json 的 personalityLearning）；缺省视为开 */
  enabled?: () => boolean
  /** 便于离线测试注入时间源 */
  now?: () => number
  /** 便于离线测试注入假 fetch；默认走 host/http.ts 的 fetchJson */
  fetchJson?: typeof fetchJson
  model?: string
}

export function createPersonalityLearner(deps: LearnerDeps): PersonalityLearner {
  const enabled = (): boolean => (deps.enabled ? deps.enabled() !== false : true)
  const nowFn = deps.now || ((): number => Date.now())
  const fetchJsonFn = deps.fetchJson || fetchJson
  const model = deps.model || LEARN_MODEL
  const state: LearnState = { successes: 0, lastAttemptAt: 0 }
  let running = false

  async function learnNow(): Promise<LearnResult> {
    if (!enabled()) return { ok: false, reason: 'disabled' }
    if (running) return { ok: false, reason: 'running' }
    const key = String(deps.getKey() || '')
    if (!key) return { ok: false, reason: 'NO_KEY' }
    let convo = ''
    try { convo = buildExtractionUser(deps.loadHistory()) } catch { convo = '' }
    if (!convo) return { ok: false, reason: 'EMPTY' }

    running = true
    try {
      const r = await fetchJsonFn(CHAT_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
            { role: 'user', content: '最近对话：\n' + convo },
          ],
          max_tokens: LEARN_MAX_TOKENS,
          temperature: 0.2,
          thinking: { type: 'disabled' },
        }),
      }, LEARN_TIMEOUT)
      if (!r.ok) {
        console.error('[personality] LEARN-HTTP ' + r.status + ' ' + String(r.text || '').slice(0, 200))
        return { ok: false, reason: 'HTTP ' + r.status }
      }
      const candidate = parseExtraction(r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message
        ? r.data.choices[0].message.content : '')
      if (!candidate) {
        // 解析失败：本次不写盘（人格文件保持原样），只记一行日志
        console.error('[personality] LEARN-PARSE 提取结果不是合法 JSON，本次不写入')
        return { ok: false, reason: 'parse' }
      }
      const result = deps.repo.learn(candidate)
      if (!result.changed.length) return { ok: true, changed: [] }
      const fields = result.changed.map((c) => c.field)
      if (!result.saved) return { ok: false, reason: 'SAVE_FAILED', changed: fields }
      console.log('[personality] LEARN-OK fields=' + fields.join(',') + ' version=' + result.data.version)
      return { ok: true, changed: fields }
    } catch (err: any) {
      console.error('[personality] LEARN-ERR ' + String((err && err.message) || err))
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
      if (!shouldLearn(state, now)) return false
      // 先记尝试时间、清计数，再后台跑：6 小时窗口与 20 次计数都不会因失败而反复重试烧 token
      state.lastAttemptAt = now
      state.successes = 0
      void learnNow().catch(() => { })
      return true
    } catch {
      return false
    }
  }

  function status(): LearnerStatus {
    return {
      enabled: enabled(),
      successes: state.successes,
      lastAttemptAt: state.lastAttemptAt ? new Date(state.lastAttemptAt).toISOString() : null,
      running,
    }
  }

  return { noteSuccess, learnNow, status }
}
