import { str } from './util.js'
import { deepFreeze } from '../shared/immutable.js'
/**
 * client/wake.ts —— 唤醒词门（纯逻辑，不碰 DOM / 网络，可在 Node 里单测）
 *
 * 为什么要有这一层：语音待命默认常开麦，ASR 每 6 秒窗口一上传，
 * 客厅里任何一句话都会被当成"对鱼说话"，于是鱼会自说自话地接话。
 * 这里不改上传节奏，只加一道门：
 *   · 识别文本里含唤醒词（大肥鱼 / 肥鲸 / …）→ 刷新 30 秒有效窗
 *   · 有效窗内 → 识别结果照常交给聊天
 *   · 有效窗已过 → 丢掉（ASR 上传不减少，减少的是误触发与误回话）
 * 唤醒词本身从交给聊天的文本里剥掉："大肥鱼，讲个故事" → "讲个故事"。
 */

/** 唤醒词（ASR 对这几个词识别率较高；「大肥鱼」是主唤醒词） */
export const WAKE_WORDS: string[] = ['大肥鱼', '小蓝鱼', '肥鲸', '肥鱼', '小鱼', '蓝鱼', '鱼鱼', '肥肥']
deepFreeze(WAKE_WORDS)

/** 自定义唤醒词的存储键（空/不存 = 用默认词表） */
export const WAKE_WORD_KEY = 'chubby-wake-word'

/** 读取自定义唤醒词：返回 undefined 表示用默认词表；返回 [词] 表示只用这一个词 */
export function loadCustomWakeWords(): string[] | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined
    const v = String(localStorage.getItem(WAKE_WORD_KEY) || '').trim()
    if (!v) return undefined
    // 长度上限：太长的词 ASR 基本识别不到，也避免存进奇怪内容
    return [v.slice(0, 12)]
  } catch (e) {
    return undefined
  }
}

/** 设置自定义唤醒词；传空串恢复默认词表。返回最终是否为自定义 */
export function setCustomWakeWord(word: string): boolean {
  try {
    const v = str(word).trim().slice(0, 12)
    if (!v) { localStorage.removeItem(WAKE_WORD_KEY); return false }
    localStorage.setItem(WAKE_WORD_KEY, v)
    return true
  } catch (e) {
    return false
  }
}

/** 被唤醒后多久之内说话算"接着聊"（毫秒） */
export const WAKE_WINDOW_MS = 30000

export type WakeCheck = {
  /** 这段文本里出现了唤醒词 */
  hit: boolean
  /** 能不能交给聊天（命中唤醒词，或还在有效窗内） */
  pass: boolean
  /** 交给聊天的文本：命中时剥掉唤醒词；未命中保持原文 */
  text: string
  /** 命中的唤醒词（未命中为空串） */
  word: string
  /** 有效窗还剩多久（毫秒；不放过行时为 0） */
  remainingMs: number
}

export type WakeGate = {
  check: (text: string, now?: number) => WakeCheck
  /** 现在是否在有效窗内 */
  awake: (now?: number) => boolean
  /** 有效窗剩余毫秒 */
  remainingMs: (now?: number) => number
  /** 清空有效窗（停止语音待命时用） */
  reset: () => void
  windowMs: number
  /** 唤醒词表（诊断/提示文案要用，别在别处再写一份） */
  words: string[]
}

/** 繁体折简体：ASR 偶尔给「大肥魚」「小藍魚」，不折就永远匹配不上 */
const TRAD_TO_SIMPLE: Record<string, string> = { '魚': '鱼', '飛': '飞', '藍': '蓝', '籃': '篮', '蘭': '兰', '鯨': '鲸' }

/** 归一化：去掉空白与常见标点、统一小写（ASR 会给出"大肥鱼，"这种带标点的结果） */
export function normalizeWakeText(text: unknown): string {
  return str(text)
    .split('')
    .map((c) => TRAD_TO_SIMPLE[c] || c)
    .join('')
    .replace(/[\s。，、！？；：,.!?;:…~～·"'“”‘’（）()【】\[\]]/g, '')
    .toLowerCase()
}

/**
 * 谐音容错：ASR 把「大肥鱼」识别成「大粉鱼」「大飞鱼」时，主人会以为鱼没反应。
 * 只在大/小 + 1 个易混字 + 鱼/鲸 这种短句上放行，避免把「大鲤鱼」这类正常词当唤醒。
 */
const WAKE_FUZZY: RegExp[] = [
  /^大(肥|飞|粉|菲|非|废|悲|白|百|杯)鱼/,
  /^小(蓝|篮|兰)?(鱼|鲸)/,
  /^(肥|飞)(鲸|鱼)/,
  /^大(肥|飞)鲸/,
]

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 从一句话里剥掉唤醒词。
 * 命中判定走"归一化后包含"（容忍标点/空格把词隔开），
 * 剥离优先在原文上做（保留其余标点），剥不干净再用归一化文本兜底。
 */
export function stripWakeWords(input: unknown, words: string[] = WAKE_WORDS): { hit: boolean; text: string; word: string } {
  const raw = str(input)
  const norm = normalizeWakeText(raw)
  if (!norm) return { hit: false, text: '', word: '' }

  // 长词优先：'小蓝鱼' 命中时不能被 '蓝鱼' 先剥成 '小'
  const sorted = (words || []).filter(Boolean).map((w) => String(w)).sort((a, b) => b.length - a.length)
  const hits = sorted.filter((w) => {
    const nw = normalizeWakeText(w)
    if (!nw) return false
    // 三字以上（大肥鱼）：句中出现即可
    if (nw.length >= 3) return norm.indexOf(nw) >= 0
    // 两个字（小鱼/鱼鱼/肥鱼/蓝鱼/肥肥）：只认句首，或整句极短，
    // 否则"我想看小鱼"会被误唤醒，还会把"我想看"当成主人说的话送进模型
    return norm.startsWith(nw) || (norm.length <= 4 && norm.indexOf(nw) >= 0)
  })
  if (!hits.length) {
    // 字面没命中 → 试谐音容错（整句要短，避免长句里恰好含「大X鱼」被误唤醒）
    if (norm.length <= 12) {
      for (const re of WAKE_FUZZY) {
        const m = norm.match(re)
        if (m) {
          const rest = norm.replace(re, '')
          const keep = /[\u4e00-\u9fa5a-z0-9]/i.test(rest) ? rest : ''
          return { hit: true, text: keep, word: m[0] }
        }
      }
    }
    return { hit: false, text: raw.trim(), word: '' }
  }

  // 在原文上剥（每个字之间容忍空白，ASR 偶尔会插空格）
  let out = raw
  for (const w of hits) {
    const pattern = w.split('').map(escapeRe).join('\\s*')
    out = out.replace(new RegExp(pattern, 'gi'), ' ')
  }
  out = out.replace(/^[\s。，、！？；：,.!?;:…~～·]+/, '').replace(/[\s。，、！？；：,.!?;:…~～·]+$/, '')
  // 原文剥不干净（词被标点/空格隔断）→ 用归一化文本兜底，别把唤醒词带进聊天
  if (normalizeWakeText(out) === norm) {
    out = norm
    for (const w of hits) out = out.split(normalizeWakeText(w)).join('')
  }
  // 剥完只剩标点 → 当作"只喊了名字"
  if (!/[\u4e00-\u9fa5a-z0-9]/i.test(out)) out = ''
  return { hit: true, text: out, word: hits[0] }
}

/**
 * 唤醒门：记住最近一次被唤醒的时刻，之后 windowMs 内放行。
 * now 可在测试里注入，生产默认 Date.now()。
 */
export function createWakeGate(opts: { words?: string[]; windowMs?: number; now?: () => number } = {}): WakeGate {
  const words = (opts.words && opts.words.length ? opts.words : WAKE_WORDS).slice()
  const windowMs = Math.max(1000, Number(opts.windowMs) || WAKE_WINDOW_MS)
  const clock = typeof opts.now === 'function' ? opts.now : () => Date.now()
  let lastHitAt = 0

  function awake(now: number = clock()): boolean {
    return lastHitAt > 0 && now - lastHitAt <= windowMs
  }
  function remainingMs(now: number = clock()): number {
    return awake(now) ? Math.max(0, windowMs - (now - lastHitAt)) : 0
  }

  return {
    windowMs,
    words,
    awake,
    remainingMs,
    reset(): void { lastHitAt = 0 },
    check(text: string, now: number = clock()): WakeCheck {
      const r = stripWakeWords(text, words)
      if (r.hit) {
        lastHitAt = now
        return { hit: true, pass: true, text: r.text, word: r.word, remainingMs: windowMs }
      }
      const pass = awake(now)
      return { hit: false, pass, text: str(text).trim(), word: '', remainingMs: remainingMs(now) }
    },
  }
}
