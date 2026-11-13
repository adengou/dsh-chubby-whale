/**
 * host/poem-index.ts —— 诗句关键词索引（「按诗里的字词触发」）
 *
 * 用途：把诗库（741 首 + data/poets 目录）逐首分词，建「词 → 诗」索引，
 * 用户说的话里只要出现某首诗里的 2~4 字词，就能命中那首诗。
 * 与人工主题表（poem-echo.ts，管「意境触发」）分工：
 *   · 本模块 = 关键词触发（用户说「寻寻觅觅」「梧桐」「东风」…）；
 *   · poem-echo  = 意境触发（用户说「坚持」「往事」这类诗里没有的词）；
 *   · 调用方优先用关键词，没命中再落到意境。
 *
 * 规矩：
 *   · 纯函数、零依赖（Intl.Segmenter 是标准库）；
 *   · 不读文件、不联网；诗句由调用方从诗库读出后传进来；
 *   · 确定性：同样的索引与文本永远同样的结果，不掷骰子。
 */

/** 一首诗（调用方从诗库读出的最少字段） */
export type PoemSource = { title: string; author: string; lines: string[] }

/** 索引里的一条：词命中的那句诗 */
export type PoetEntry = { title: string; author: string; line: string }

/** 词 → 诗句条目（同一词可能出现在多首诗里） */
export type PoemIndex = Map<string, PoetEntry[]>

/** 虚词/代词/高频无意义词：出现在诗句里也不当关键词 */
const STOP = new Set([
  '这个', '那个', '什么', '怎么', '一个', '一下', '没有', '不是', '就是', '可以', '还是',
  '因为', '所以', '但是', '如果', '已经', '我们', '你们', '他们', '自己', '时候', '现在',
  '今天', '明天', '昨天', '一样', '一起', '这样', '那样', '多少', '几多', '何处', '不知',
  '不见', '人间', '天下', '不知', '如何', '为何', '只是', '只有', '只是', '却道', '莫道',
  '我的', '你的', '他的', '她的', '它的', '一个', '一片', '一声', '一时',
])

/** 只在诗句里出现、但没有辨识度的常见词 */
const BANAL = new Set([
  '春风', '秋风', '东风', '西风', '明月', '白云', '青山', '流水', '落花', '夕阳', '黄昏',
  '江南', '长安', '故人', '君子', '美人', '相思', '离别', '多情', '无情', '有心',
])

/**
 * 取 2~4 字纯中文词：分词结果 + 滑窗并用。
 * 为什么两者都要：分词器会把「春红」切成「春/红」、把「一晌贪欢」切成「一晌/贪欢」，
 * 单靠分词会漏掉用户真正会说的词；滑窗补齐，重复由 Set 去掉。
 */
function wordsOf(text: string): string[] {
  const out = new Set<string>()
  const s = String(text || '')
  if (!s) return []
  const push = (w: string) => {
    if (w.length >= 2 && w.length <= 4 && /^\p{Script=Han}+$/u.test(w)) out.add(w)
  }
  try {
    const Seg = (Intl as any).Segmenter
    if (typeof Seg === 'function') {
      const seg = new Seg('zh', { granularity: 'word' })
      for (const piece of seg.segment(s)) {
        if (!piece.isWordLike) continue
        push(String(piece.segment || '').trim())
      }
    }
  } catch (e) { }
  for (let i = 0; i < s.length; i++) {
    for (const n of [4, 3, 2]) {
      if (i + n <= s.length) push(s.slice(i, i + n))
    }
  }
  return Array.from(out)
}

/** 词是否值得当关键词（去虚词、去太常见的景语） */
function usable(w: string): boolean {
  if (w.length < 2 || w.length > 4) return false
  if (STOP.has(w) || BANAL.has(w)) return false
  return true
}

/**
 * 建索引：每首诗逐句分词，词 → [条目]。
 * 同一首诗同一个词只收一次（避免同诗多句重复占位）。
 */
export function buildPoemIndex(poems: PoemSource[]): PoemIndex {
  const idx: PoemIndex = new Map()
  for (const p of poems) {
    if (!p || typeof p !== 'object') continue
    const title = String(p.title || '').trim()
    const author = String(p.author || '').trim()
    if (!title) continue
    const seen = new Set<string>()
    // 诗题/词牌名也是关键词：「雨霖铃」「声声慢」「乌夜啼」「虞美人」要能直接命中
    // （「·」后的题目部分也单独切；词牌部分用滑窗兜住「雨霖铃」这种三字牌名）
    const titleParts = [title].concat(title.includes('·') ? [title.split('·')[0], title.split('·').slice(1).join('·')] : [])
    for (const tp of titleParts) {
      const tpText = String(tp || '').trim()
      if (!tpText) continue
      for (const w of wordsOf(tpText)) {
        if (!usable(w) || seen.has(w)) continue
        seen.add(w)
        const entry: PoetEntry = { title, author, line: String((Array.isArray(p.lines) && p.lines[0]) || '') }
        const list = idx.get(w)
        if (list) { if (!list.some((x) => x.title === title && x.author === author)) list.push(entry) }
        else idx.set(w, [entry])
      }
    }
    for (const raw of Array.isArray(p.lines) ? p.lines : []) {
      const line = String(raw || '').trim()
      if (!line) continue
      for (const w of wordsOf(line)) {
        if (!usable(w)) continue
        const key = w
        if (seen.has(key)) continue
        seen.add(key)
        const list = idx.get(key)
        const entry: PoetEntry = { title, author, line }
        if (list) list.push(entry)
        else idx.set(key, [entry])
      }
    }
  }
  return idx
}

/** 词哈希（用于多首同词时的确定性轮换） */
function hashWord(w: string): number {
  let h = 0
  for (const ch of w) h = (h * 31 + (ch.codePointAt(0) || 0)) >>> 0
  return h
}

/**
 * 关键词匹配：从用户文本里找最长的、索引里存在的词（2~4 字）。
 * 多个词时取最长（「寻寻觅觅」优先于「寻觅」）；等长取文本里先出现的。
 * 返回命中的诗 + 那句诗 + 命中的词；没命中返回 null。
 */
export function matchPoemKeyword(text: string, index: PoemIndex): (PoetEntry & { word: string }) | null {
  // 去掉空白再匹配：「冷 冷」当成「冷冷」（用户打字带空格很常见）
  const src = String(text || '').replace(/\s+/g, '')
  if (!src || !index || index.size === 0) return null
  // 候选：用户文本里所有 2~4 字连续片段（用分词 + 滑窗双保险）
  const cands = new Set<string>(wordsOf(src))
  for (let i = 0; i < src.length; i++) {
    for (const n of [4, 3, 2]) {
      const w = src.slice(i, i + n)
      if (w.length === n && /^\p{Script=Han}+$/u.test(w)) cands.add(w)
    }
  }
  let best = ''
  for (const w of cands) {
    if (!index.has(w)) continue
    if (w.length > best.length) best = w
  }
  if (!best) return null
  const list = (index.get(best) || []).slice()
  if (!list.length) return null
  // 多首同词：先按「标题里带副题」的长度降序排——带副题的通常是名篇
  // （如「虞美人·春花秋月何时了」优先于只写词牌的「虞美人」），
  // 再按词哈希 + 文本长度取模轮换（确定性，同一句话永远同一首）。
  list.sort((a, b) => String(b.title).length - String(a.title).length)
  const picked = list[(hashWord(best) + src.length) % list.length]
  return { title: picked.title, author: picked.author, line: picked.line, word: best }
}
