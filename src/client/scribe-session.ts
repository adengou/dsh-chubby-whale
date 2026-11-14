/**
 * client/scribe-session.ts —— 「小鲸代笔」会话状态机（纯逻辑：不碰 DOM / React / 网络 / 存储）
 *
 * 2026-11-14 主人 7 条改版后的模型：**以整篇正文 text:string 为唯一文档状态**。
 *   · 面板里是一张可编辑的「纸」：主人可以随意改字、删字、改标点、回车分段；
 *   · 语音识别出的整句由 voice-bridge 的 onScribe 交到 push()，
 *     push 把句子**直接接在当前段落末尾**（不换行、不编号、不列表）；
 *   · 断句纠偏（2026-11-14）：push 带语音收尾 meta（尾部静音/说话时长）时，用
 *     shared/sentence-boundary.ts 的 normalizeSegment 判断这句是否真的说完 ——
 *     没等够静音就被端点切出来的半句，句号降级成逗号（没有句末标点则补逗号），
 *     感叹号/问号与已经以逗号结尾的片段保持原样；meta 缺失时完全保持旧行为。
 *   · 中文句间直接接；英文/数字与英文/数字相邻时补一个空格；
 *   · 主人在正文里回车（text 里出现 \n）＝马上新起一段，下一句接到新段落里；
 *   · 没有「停止」这种文档状态：只有 idle / active / paused（pause 只是暂停听写），
 *     保存随时可点、保存后正文保留。
 *
 * 保留的行为：
 *   · 同句 1.5 秒去重（ASR 重复回调 / 一句被切成两段）；
 *   · 2000 句计数上限（防麦克风一直开着把正文撑爆；用户删字不回退计数）；
 *   · 空句忽略、trim；所有方法同步、不抛错。
 *
 * 明确不做：不往第三方窗口粘贴、不写聊天输入框、不调用 sendText / fetch / 浏览器存储，
 * 也不自动保存文件。IO 全在 client.ts。
 */

import { normalizeSegment, type SegmentMeta } from '../shared/sentence-boundary.js'

export type ScribeSessionStatus = 'idle' | 'active' | 'paused'

/** push() 的结果：调用方据此决定要不要给面板提示（全部是纯数据） */
export type ScribePushResult = {
  /** 句子是否真的接进正文 */
  ok: boolean
  /** 空文本 / 未在听写等，明确被忽略 */
  ignored?: boolean
  /** 命中同句去重（重复的那次不接） */
  duplicate?: boolean
  /** 被忽略/拒绝的原因码：empty / not-active / duplicate / limit */
  code?: string
  /** 给主人看的一句话（面板/气泡可直接用；空串表示不必提示） */
  reason?: string
}

/** getState() 的快照（text 是副本字符串，外部改不到内部） */
export type ScribeSessionState = {
  status: ScribeSessionStatus
  /** 状态便捷布尔：面板按钮显隐直接读这两个 */
  active: boolean
  paused: boolean
  /** 整篇正文（唯一文档状态；用户编辑也走 setText） */
  text: string
  /** 已接进正文的句数（只增不减，用于上限与状态显示） */
  count: number
  /** 最后接进正文的句子（没有则为空串） */
  lastSentence: string
  /** 最近一次被忽略/拒绝的原因（成功接句会清空） */
  lastError: string
  /** 最近一次原因码（供诊断；成功接句会清空） */
  lastErrorCode: string
}

export type ScribeSessionOptions = {
  /** 注入时钟（测试用；默认 Date.now） */
  now?: () => number
  /** 同句去重窗口（毫秒；默认 1500） */
  dedupeMs?: number
  /** 句数上限（默认 2000；只统计 push 接进来的句子，不含用户手打） */
  maxSentences?: number
}

export type ScribeSession = {
  /** 开始听写（不清正文；已 active 时幂等；paused 时等价 resume） */
  start: () => ScribeSessionState
  /** 暂停听写（正文保留；之后 push 一律 not-active，不自动停止/保存） */
  pause: () => ScribeSessionState
  /** 从暂停恢复听写（非 paused 时无效） */
  resume: () => ScribeSessionState
  /** 用户编辑正文（原样保存，只把 CRLF/CR 归一成 \n） */
  setText: (text: string) => ScribeSessionState
  /**
   * 收一句：trim → 断句纠偏（meta 有值时按"是否真的说完"把句号改逗号/补逗号）
   * → 接在当前段落末尾（不自动换行）。meta 省略时行为与旧版完全一致。
   */
  push: (sentence: string, meta?: SegmentMeta) => ScribePushResult
  /** 清空正文与句数（状态不变；保存前后都可清） */
  clear: () => ScribeSessionState
  /** 当前快照 */
  getState: () => ScribeSessionState
  /** 整篇正文（= getState().text，保存 TXT/DOCX 直接用） */
  getText: () => string
}

const DEFAULT_DEDUPE_MS = 1500
const DEFAULT_MAX_SENTENCES = 2000

/** 归一化上限：非法/非正数回落到默认值，避免 0 或负数把功能锁死 */
function positiveInt(v: any, fallback: number): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n) || n <= 0) return fallback
  return n
}

/**
 * 把一句接进正文：不自动换行、不编号。
 * 规则（主人第 5 条）：
 *   · 正文为空 / 最后一段是空段（结尾是 \n）→ 直接接；
 *   · 结尾是英文/数字且句子开头也是英文/数字 → 中间补一个空格；
 *   · 其余（中文、标点、空白结尾）→ 直接接，中文句间不留空格。
 */
/** 内部：把一句接进正文（规则见下函数注释）；不导出，避免扩大模块接口 */
function joinScribeSentence(docText: string, sentence: string): string {
  const base = String(docText == null ? '' : docText)
  const add = String(sentence == null ? '' : sentence)
  if (!add) return base
  if (!base) return add
  const last = base.charAt(base.length - 1)
  if (last === '\n') return base + add
  if (/[A-Za-z0-9]$/.test(last) && /^[A-Za-z0-9]/.test(add)) return base + ' ' + add
  return base + add
}

/**
 * 建一台代笔会话状态机。
 * 纯函数式接口：所有方法同步、不抛错（内部异常也归一成状态），
 * 因此面板/语音回调里可以直接调用，不需要 try/catch 包裹。
 */
export function createScribeSession(options: ScribeSessionOptions = {}): ScribeSession {
  const now: () => number = typeof options.now === 'function' ? options.now : () => Date.now()
  const dedupeMs = positiveInt(options.dedupeMs, DEFAULT_DEDUPE_MS)
  const maxSentences = positiveInt(options.maxSentences, DEFAULT_MAX_SENTENCES)

  let status: ScribeSessionStatus = 'idle'
  let text = ''
  let count = 0
  let lastSentence = ''
  let lastError = ''
  let lastErrorCode = ''

  // 去重只记「上一次真正接进正文的句子 + 时刻」：窗口外的同句（主人真的又说了一遍）照收。
  let lastText = ''
  let lastAt = -Infinity

  function fail(code: string, reason: string): ScribePushResult {
    lastError = reason
    lastErrorCode = code
    return { ok: false, ignored: code !== 'limit', duplicate: code === 'duplicate', code, reason }
  }

  function state(): ScribeSessionState {
    return {
      status,
      active: status === 'active',
      paused: status === 'paused',
      text,
      count,
      lastSentence,
      lastError,
      lastErrorCode,
    }
  }

  function clearErrors(): void {
    lastError = ''
    lastErrorCode = ''
  }

  function start(): ScribeSessionState {
    status = 'active'
    clearErrors()
    return state()
  }

  function pause(): ScribeSessionState {
    if (status === 'active') status = 'paused'
    return state()
  }

  function resume(): ScribeSessionState {
    if (status === 'paused') {
      status = 'active'
      clearErrors()
    }
    return state()
  }

  function setText(raw: any): ScribeSessionState {
    // 用户编辑：正文原样保存，只统一换行符（textarea 在 Windows 上可能给 \r\n）
    text = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n')
    // 用户一改文档，上一次「暂停时说了话被丢」之类的红字就该让位，别一直挂着
    clearErrors()
    return state()
  }

  function push(rawSentence: any, meta?: SegmentMeta): ScribePushResult {
    const trimmed = String(rawSentence == null ? '' : rawSentence).trim()
    if (!trimmed) return fail('empty', '')
    if (status !== 'active') {
      return fail('not-active', status === 'paused' ? '听写已暂停，点话筒继续' : '还没开始听写')
    }
    // 断句纠偏：语音端点在"静音没等够"时切出来的半句，ASR 仍会在末尾补「。」；
    // 用收尾 meta 判断后把句号降级成逗号（或补逗号），完整句/！？/已带逗号的原样保留。
    // meta 缺失（旧调用方/非语音来源）时 normalizeSegment 直接原样返回 → 行为不变。
    const sentence = normalizeSegment(trimmed, meta)
    const at = now()
    if (sentence === lastText && at - lastAt < dedupeMs) {
      // 去重不覆盖 lastAt：连续重复的第三、四次仍然被同一个窗口挡住
      return fail('duplicate', '')
    }
    if (count >= maxSentences) {
      return fail('limit', '句子太多了（上限 ' + maxSentences + ' 句），先保存或清空再记')
    }
    text = joinScribeSentence(text, sentence)
    count++
    lastSentence = sentence
    lastText = sentence
    lastAt = at
    clearErrors()
    return { ok: true }
  }

  function clear(): ScribeSessionState {
    text = ''
    count = 0
    lastSentence = ''
    lastText = ''
    lastAt = -Infinity
    clearErrors()
    return state()
  }

  function getText(): string {
    return text
  }

  return { start, pause, resume, setText, push, clear, getState: state, getText }
}
