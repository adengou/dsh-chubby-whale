/**
 * client/sim.ts —— 统一文本相似度（回声判定与重复发言判定的公共算法）
 *
 * 为什么需要它：之前回声/重复判断散落着四五条经验规则（完全相等、前 6 字相同、
 * 前 8 字相同、被说过的话包含、短词包含…），规则一多就互相打补丁：
 *   · 门槛写死 6 字 → "master" 这种短词漏网，会被重复回答
 *   · 只比开头 → 中间改了字的回声仍然漏
 *
 * 这里换成一个可解释的度量：字符二元组（bigram）的 Jaccard 相似度。
 *   · 同一句话因标点/空格/大小写不同 → 归一化后完全相等，相似度 1
 *   · ASR 把一句话切成两段造成重叠 → 相似度高（通常 >0.8）
 *   · 不同问题（"今天天气" vs "讲个故事"）→ 相似度低（通常 <0.2）
 *
 * 纯函数、无副作用，可直接在 Node 里单测（scripts/test.mjs 已覆盖；
 * B91 补充的短句/窗口/minLen 边界见 scripts/test-audio-sim.mjs）。
 */

/** 归一化：去空白/标点/大小写差异，只留可比较的字符 */
export function normalizeText(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[\s。，！？、；：,.!?;:"'”’“”（）()【】\[\]<>《》~～`@#$%^&*_+=|\\/-]/g, '')
}

/** 字符二元组集合（长度 1 的文本退化为单字符集合） */
export function bigrams(s: string): Set<string> {
  const out = new Set<string>()
  const t = String(s || '')
  if (!t) return out
  if (t.length === 1) { out.add(t); return out }
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
  return out
}

/** Jaccard 相似度：交集 / 并集，范围 0–1 */
export function similarity(a: string, b: string): number {
  const A = bigrams(normalizeText(a))
  const B = bigrams(normalizeText(b))
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  const union = A.size + B.size - inter
  return union === 0 ? 0 : inter / union
}

export type RepeatOptions = {
  /** 相似度阈值，默认 0.85（同一句话的 ASR 变体一般都在这个之上） */
  threshold?: number
  /** 参与比较的最短长度（太短的字容易误判，默认 4） */
  minLen?: number
  /** 时间窗（毫秒），默认 20000 */
  windowMs?: number
  /** 被比较的"最近说过的话"，需带 at 时间戳 */
  recent: Array<{ text: string; at: number }>
  /** 当前时间，默认 Date.now() */
  now?: number
}

/**
 * 是否算"重复"（回声或同一句被切成两段）：
 *   ① 归一化后完全相等（且长度 ≥ minLen）
 *   ② 较短的一方被较长的一方完整包含（≥minLen 字）
 *   ③ bigram 相似度 ≥ threshold（两边都要 ≥minLen）
 *
 * ① 为什么要和 ②③ 用同一道 minLen 门槛（2026-11-07 修）：
 *   minLen 的承诺是"太短的字不参与比较"（太短容易误判），但旧实现里只有 ②③ 遵守，
 *   ① 无条件下判 —— 于是 8 秒内把同一句两字/三字命令重说一遍就被判成重复吞掉：
 *     · 「继续」「再来」这类短指令是主人的新请求，不是"同一句被切成两段"；
 *     · 「停」「别」更严重：它们是打断词（text.ts 的 SHORT_ECHO_ALLOW、
 *       echo-filter 的 interrupt 白名单都明确要求放行），第二声被吞 = 喊不停说书。
 *   自己说的话被麦克风听回去仍会被 echo-filter 的整句/前缀/短词规则挡下（与本函数无关），
 *   所以收紧这里不会放松回声防线；≥minLen 的完全重复照旧算重复。
 */
export function isRepeat(text: string, opts: RepeatOptions): boolean {
  const threshold = opts.threshold === undefined ? 0.85 : opts.threshold
  const minLen = opts.minLen === undefined ? 4 : opts.minLen
  const windowMs = opts.windowMs === undefined ? 20000 : opts.windowMs
  const now = opts.now === undefined ? Date.now() : opts.now
  const cur = normalizeText(text)
  if (!cur) return false
  for (const item of opts.recent || []) {
    if (now - Number(item && item.at || 0) > windowMs) continue
    const prev = normalizeText(item && item.text ? item.text : '')
    if (!prev) continue
    if (cur === prev && cur.length >= minLen) return true
    const shortOne = cur.length <= prev.length ? cur : prev
    const longOne = cur.length <= prev.length ? prev : cur
    if (shortOne.length >= minLen && longOne.indexOf(shortOne) >= 0) return true
    if (cur.length >= minLen && prev.length >= minLen && similarity(cur, prev) >= threshold) return true
  }
  return false
}
