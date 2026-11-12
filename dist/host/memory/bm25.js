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
/** 中文/英文混合分词（零依赖） */
export function tokenize(text) {
    const raw = String(text || '').toLowerCase().trim();
    if (!raw)
        return [];
    const out = [];
    try {
        const Seg = Intl.Segmenter;
        if (typeof Seg === 'function') {
            const seg = new Seg('zh', { granularity: 'word' });
            for (const piece of seg.segment(raw)) {
                const w = String(piece.segment || '').trim();
                if (!w)
                    continue;
                // 标点/空白丢弃；单字保留（中文短词有意义）
                if (/^[\p{L}\p{N}]+$/u.test(w))
                    out.push(w);
            }
            return out;
        }
    }
    catch {
        // 环境不支持 Segmenter：退回按空白 + 标点切
    }
    for (const part of raw.split(/[\s，。！？、；：""''（）()\[\]{}<>《》/\\|,.;:!?]+/)) {
        const w = part.trim();
        if (w && /^[\p{L}\p{N}]+$/u.test(w))
            out.push(w);
    }
    return out;
}
/** 建索引（docs 由调用方提供，函数不改它） */
export function buildIndex(docs) {
    const postings = new Map();
    const tfs = [];
    const lengths = [];
    let totalLen = 0;
    for (let i = 0; i < docs.length; i++) {
        const words = tokenize(docs[i] && docs[i].text);
        const tf = new Map();
        for (const w of words)
            tf.set(w, (tf.get(w) || 0) + 1);
        tfs.push(tf);
        lengths.push(words.length);
        totalLen += words.length;
        for (const w of tf.keys()) {
            let set = postings.get(w);
            if (!set) {
                set = new Set();
                postings.set(w, set);
            }
            set.add(i);
        }
    }
    return {
        size: docs.length,
        postings,
        tfs,
        lengths,
        avgLen: docs.length ? totalLen / docs.length : 0,
        docs: docs.slice(),
    };
}
/** BM25 打分（k1=1.2, b=0.75 为常用默认值） */
export function scoreBm25(index, query, k1 = 1.2, b = 0.75) {
    const qWords = tokenize(query);
    if (!qWords.length || !index.size)
        return [];
    const out = [];
    for (let i = 0; i < index.size; i++) {
        const tf = index.tfs[i];
        if (!tf)
            continue;
        let score = 0;
        for (const w of qWords) {
            const f = tf.get(w) || 0;
            if (!f)
                continue;
            const n = index.postings.get(w)?.size || 0;
            if (!n)
                continue;
            const idf = Math.log(1 + (index.size - n + 0.5) / (n + 0.5));
            const denom = f + k1 * (1 - b + (b * index.lengths[i]) / (index.avgLen || 1));
            score += idf * ((f * (k1 + 1)) / denom);
        }
        if (score > 0)
            out.push({ idx: i, score });
    }
    return out;
}
/**
 * 两段式检索 + 三因子排序 + 去重（完善版召回）
 *   1. AND 精确命中（所有查询词都出现）；无结果再 OR 回退；
 *   2. final = relevance × importance × recency（recency 按 30 天半衰期衰减）；
 *   3. 相似文本（前 12 字相同）只留分数最高的一条，保证多样性。
 */
export function recall(index, query, opts = {}) {
    const limit = Math.max(1, Math.min(50, opts.limit || 8));
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const halfLife = Math.max(1, opts.halfLifeDays || 30);
    const qWords = tokenize(query);
    if (!qWords.length || !index.size)
        return { hits: [], fallback: false };
    const scored = scoreBm25(index, query);
    if (!scored.length)
        return { hits: [], fallback: false };
    // ① AND 精确命中：文档里包含全部查询词
    const exact = scored.filter(({ idx }) => {
        const tf = index.tfs[idx];
        return qWords.every((w) => (tf.get(w) || 0) > 0);
    });
    const fallback = exact.length === 0;
    const pool = fallback ? scored : exact;
    // ② 三因子：relevance × importance × recency
    const hits = pool.map(({ idx, score }) => {
        const doc = index.docs[idx] || {};
        const importance = Math.max(0, Math.min(1, Number(doc.importance != null ? doc.importance : 0.5)));
        const at = Number.isFinite(doc.at) ? doc.at : now;
        const ageDays = Math.max(0, (now - at) / 86400000);
        const recency = Math.pow(0.5, ageDays / halfLife);
        return {
            id: String(doc.id || idx),
            display: String(doc.display || doc.text || ''),
            score,
            final: score * (0.5 + importance) * (0.5 + recency),
            importance,
            at,
        };
    });
    // ③ 去重（前 12 字相同视为同一事件）
    const seen = new Set();
    const unique = [];
    for (const h of hits.sort((a, b) => b.final - a.final)) {
        const key = h.display.slice(0, 12);
        if (seen.has(key))
            continue;
        seen.add(key);
        unique.push(h);
        if (unique.length >= limit)
            break;
    }
    return { hits: unique, fallback };
}
