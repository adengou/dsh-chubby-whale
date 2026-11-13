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
import { sendJson } from '../respond.js';
import { tokenize } from '../memory/bm25.js';
/** 主题词上限：太多就不像「印象」了 */
const MAX_TOPICS = 8;
/** 单个主题词上限（字） */
const MAX_TOPIC_CHARS = 8;
/**
 * 从摘要里提取主题词。
 *
 * 教训（2026-11-13）：早先按标点切片段，切出来的是「主人称呼肥鲸为小」这种句子碎片，
 * 被主人一眼识破是胡说。改成中文分词（Intl.Segmenter）抽 2-4 字的词、去停用词、按词频取前 8，
 * 宁可比原来短、比原来少，也不能把长句碎片当主题。
 */
/** 元话语/虚词/代词：出现在摘要里也不该被当成主题 */
const TOPIC_STOP = new Set(['主人', '称呼', '提到', '说到', '聊到', '讲到', '问到', '说到过', '我', '你', '他', '她', '它', '我们', '你们', '他们', '的', '了', '吗', '呢', '吧', '啊', '哦', '呀', '和', '与', '在', '是', '有', '就', '也', '都', '很', '要', '会', '说', '问', '提', '到', '把', '被', '给', '让', '这', '那', '什么', '怎么', '一个', '一下', '可以', '应该', '然后', '所以', '但是', '因为', '如果', '还是', '就是', '已经', '没有', '不是', '这个', '那个', '一些', '这样', '那样', '喜欢', '还有', '最近', '也在', '觉得', '知道', '现在', '今天', '昨天', '明天', '时候', '问题', '事情', '东西', '地方', '一样', '一起', '一直', '总是', '可能', '需要', '希望', '感觉', '认为', '表示', '进行', '使用', '开始', '结束', '接着', '最后', '一些', '这种', '那种', '比较', '非常', '特别', '真的', '有点', '一点', '几个', '两个', '三个', '然后', '所以', '但是', '因为', '如果', '还是', '已经', '没有', '不是']);
function extractTopics(summary, historyText) {
    // 主题 = 聊天历史里反复出现的实词（摘要只是顺带补一点）
    // 为什么不用摘要切词：摘要是流水账，切出来尽是「主人称呼肥鲸为小」「天大」这类碎片；
    // 历史里重复出现的词才配叫主题，零碎的会被词频淘汰。
    const source = (String(historyText || '') + '\n' + String(summary || '')).slice(0, 200000);
    if (!source.trim())
        return [];
    const freq = new Map();
    let toks = [];
    try {
        toks = tokenize(source);
    }
    catch (e) {
        return [];
    }
    for (const w of toks) {
        const t = String(w || "").trim();
        if (t.length < 2 || t.length > 4)
            continue;
        if (!/^\p{Script=Han}+$/u.test(t))
            continue;
        if (TOPIC_STOP.has(t))
            continue;
        freq.set(t, (freq.get(t) || 0) + 1);
    }
    // 至少出现 2 次才算主题：一次性的碎片不配进胶囊
    return Array.from(freq.entries())
        .filter((x) => x[1] >= 2)
        .sort((a, b) => (b[1] - a[1]) || (a[0].length - b[0].length))
        .slice(0, 8)
        .map((x) => x[0]);
}
export function createMemoryHandlers(opts) {
    async function handleMemory(req, res) {
        const method = String((req && req.method) || 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
            sendJson(res, { ok: false, error: 'method not allowed' }, 405);
            return;
        }
        try {
            const summary = String(opts.loadMemorySummary() || '');
            let historyText = '';
            try {
                const h = opts.loadHistory ? opts.loadHistory() : [];
                if (Array.isArray(h)) {
                    // 只取用户说的话：助手回复（肥鲸自己的台词，如「尾巴甩水花」「歪头」）会把角色描写词顶成「话题」
                    historyText = h
                        .filter((x) => !x || !x.role || String(x.role) === 'user')
                        .map((x) => String((x && (x.content || x.text)) || ''))
                        .join('\n');
                }
            }
            catch (e) { }
            sendJson(res, { ok: true, summary, topics: extractTopics(summary, historyText) });
        }
        catch (err) {
            // 读不到就如实说读不到，不回编造的摘要
            sendJson(res, { ok: false, error: String((err && err.message) || err), summary: '', topics: [] });
        }
    }
    return { handleMemory };
}
export { extractTopics };
