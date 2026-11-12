/**
 * host/memory/bm25.ts —— 轻量 BM25 关键词检索（零第三方依赖）
 *
 * 设计：
 *   · 中文分词用 Node 内置 `Intl.Segmenter`（标准库，不装包）；英文按词切分；
 *   · 索引只存在内存里，由调用方从落盘数据重建（避免维护第二份持久化）；
 *   · 只提供「建索引 / 查询 / 去重」三个纯函数，不碰文件、不碰网络。
 *
 * 说明：BM25 是确定性算法，同样输入永远同样输出——便于调试与测试。
 */

/** 一条可检索的记忆文档 */
export type MemoryDoc = {
  /** 稳定 id（落盘时生成） */
  id: string
  /** 用于匹配的文本（摘要/关键词，正文不参与，省内存） */
  text: string
  /** 人类可读的展示文本（命中后返回给调用方） */
  display?: string
  /** 重要度 0-1（用于三因子排序） */
  importance?: number
  /** 最近一次被想起/写入的时间戳（ms） */
  at?: number
}

export type MemoryHit = {
  id: string
  display: string
  /** BM25 原始分 */
  score: number
  /** 综合分（relevance × importance × recency） */
  final: number
  importance: number
  at: number
}

export type Bm25Index = {
  /** 文档总数 */
  size: number
  /** 词 → 含该词的文档下标 */
  postings: Map<string, Set<number>>
  /** 每篇文档的词频（词 → tf） */
  tfs: Map<string, number>[]
  /** 每篇文档长度（词数） */
  lengths: number[]
  /** 文档平均长度 */
  avgLen: number
  /** 文档原始数据 */
  docs: MemoryDoc[]
}

/** 中文/英文混合分词（零依赖） */
export function tokenize(text: string): string[] {
  const raw = String(text || '').toLowerCase().trim()
  if (!raw) return []
  const out: string[] = []
  try {
    const Seg = (Intl as any).Segmenter
    if (typeof Seg === 'function') {
      const seg = new Seg('zh', { granularity: 'word' })
      for (const piece of seg.segment(raw)) {
        const w = String(piece.segment || '').trim()
        if (!w) continue
        // 标点/空白丢弃；单字保留（中文短词有意义）
        if (/^[\p{L}\p{N}]+$/u.test(w)) out.push(w)
      }
      return out
    }
  } catch {
    // 环境不支持 Segmenter：退回按空白 + 标点切
  }
  for (const part of raw.split(/[\s，。！？、；：""''（）()\[\]{}<>《》/\\|,.;:!?]+/)) {
    const w = part.trim()
    if (w && /^[\p{L}\p{N}]+$/u.test(w)) out.push(w)
  }
  return out
}

/** 建索引（docs 由调用方提供，函数不改它） */
export function buildIndex(docs: MemoryDoc[]): Bm25Index {
  const postings = new Map<string, Set<number>>()
  const tfs: Map<string, number>[] = []
  const lengths: number[] = []
  let totalLen = 0

  for (let i = 0; i < docs.length; i++) {
    const words = tokenize(docs[i] && docs[i].text)
    const tf = new Map<string, number>()
    for (const w of words) tf.set(w, (tf.get(w) || 0) + 1)
    tfs.push(tf)
    lengths.push(words.length)
    totalLen += words.length
    for (const w of tf.keys()) {
      let set = postings.get(w)
      if (!set) { set = new Set<number>(); postings.set(w, set) }
      set.add(i)
    }
  }

  return {
    size: docs.length,
    postings,
    tfs,
    lengths,
    avgLen: docs.length ? totalLen / docs.length : 0,
    docs: docs.slice(),
  }
}

/** BM25 打分（k1=1.2, b=0.75 为常用默认值） */
export function scoreBm25(index: Bm25Index, query: string, k1 = 1.2, b = 0.75): { idx: number; score: number }[] {
  const qWords = tokenize(query)
  if (!qWords.length || !index.size) return []
  const out: { idx: number; score: number }[] = []

  for (let i = 0; i < index.size; i++) {
    const tf = index.tfs[i]
    if (!tf) continue
    let score = 0
    for (const w of qWords) {
      const f = tf.get(w) || 0
      if (!f) continue
      const n = index.postings.get(w)?.size || 0
      if (!n) continue
      const idf = Math.log(1 + (index.size - n + 0.5) / (n + 0.5))
      const denom = f + k1 * (1 - b + (b * index.lengths[i]) / (index.avgLen || 1))
      score += idf * ((f * (k1 + 1)) / denom)
    }
    if (score > 0) out.push({ idx: i, score })
  }
  return out
}

/**
 * 两段式检索 + 三因子排序 + 去重（完善版召回）
 *   1. AND 精确命中（所有查询词都出现）；无结果再 OR 回退；
 *   2. final = relevance × importance × recency（recency 按 30 天半衰期衰减）；
 *   3. 相似文本（前 12 字相同）只留分数最高的一条，保证多样性。
 */
export function recall(
  index: Bm25Index,
  query: string,
  opts: { limit?: number; now?: number; halfLifeDays?: number } = {},
): { hits: MemoryHit[]; fallback: boolean } {
  const limit = Math.max(1, Math.min(50, opts.limit || 8))
  const now = Number.isFinite(opts.now as number) ? (opts.now as number) : Date.now()
  const halfLife = Math.max(1, opts.halfLifeDays || 30)
  const qWords = tokenize(query)
  if (!qWords.length || !index.size) return { hits: [], fallback: false }

  const scored = scoreBm25(index, query)
  if (!scored.length) return { hits: [], fallback: false }

  // ① AND 精确命中：文档里包含全部查询词
  const exact = scored.filter(({ idx }) => {
    const tf = index.tfs[idx]
    return qWords.every((w) => (tf.get(w) || 0) > 0)
  })
  const fallback = exact.length === 0
  const pool = fallback ? scored : exact

  // ② 三因子：relevance × importance × recency
  const hits: MemoryHit[] = pool.map(({ idx, score }) => {
    const doc = index.docs[idx] || ({} as MemoryDoc)
    const importance = Math.max(0, Math.min(1, Number(doc.importance != null ? doc.importance : 0.5)))
    const at = Number.isFinite(doc.at as number) ? (doc.at as number) : now
    const ageDays = Math.max(0, (now - at) / 86400000)
    const recency = Math.pow(0.5, ageDays / halfLife)
    return {
      id: String(doc.id || idx),
      display: String(doc.display || doc.text || ''),
      score,
      final: score * (0.5 + importance) * (0.5 + recency),
      importance,
      at,
    }
  })

  // ③ 去重（前 12 字相同视为同一事件）
  const seen = new Set<string>()
  const unique: MemoryHit[] = []
  for (const h of hits.sort((a, b) => b.final - a.final)) {
    const key = h.display.slice(0, 12)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(h)
    if (unique.length >= limit) break
  }
  return { hits: unique, fallback }
}
