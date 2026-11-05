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

/** 归一化：去掉空白与常见标点、统一小写（ASR 会给出"大肥鱼，"这种带标点的结果） */
export function normalizeWakeText(text: unknown): string {
  return String(text == null ? '' : text)
    .replace(/[\s。，、！？；：,.!?;:…~～·"'“”‘’（）()【】\[\]]/g, '')
    .toLowerCase()
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 从一句话里剥掉唤醒词。
 * 命中判定走"归一化后包含"（容忍标点/空格把词隔开），
 * 剥离优先在原文上做（保留其余标点），剥不干净再用归一化文本兜底。
 */
export function stripWakeWords(input: unknown, words: string[] = WAKE_WORDS): { hit: boolean; text: string; word: string } {
  const raw = String(input == null ? '' : input)
  const norm = normalizeWakeText(raw)
  if (!norm) return { hit: false, text: '', word: '' }

  // 长词优先：'小蓝鱼' 命中时不能被 '蓝鱼' 先剥成 '小'
  const sorted = (words || []).filter(Boolean).map((w) => String(w)).sort((a, b) => b.length - a.length)
  const hits = sorted.filter((w) => norm.indexOf(normalizeWakeText(w)) >= 0)
  if (!hits.length) return { hit: false, text: raw.trim(), word: '' }

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
      return { hit: false, pass, text: String(text == null ? '' : text).trim(), word: '', remainingMs: remainingMs(now) }
    },
  }
}
