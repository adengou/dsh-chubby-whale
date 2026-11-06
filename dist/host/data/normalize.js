import { poemKeyOf } from '../../shared/poem.js';
/** 说书段落：与 host/story/repo.ts 原 normalizeBook 完全一致；index 用原数组序号（进度 key） */
export function normalizeStoryChunks(book, raw) {
    const out = [];
    if (!Array.isArray(raw))
        return out;
    for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (!c || typeof c !== 'object')
            continue;
        const text = String(c.text == null ? '' : c.text);
        if (!text.trim())
            continue;
        out.push({
            book: String(c.book || book),
            title: String(c.title || ''),
            piece: Number(c.piece) || 1,
            total: Number(c.total) || 1,
            text,
            index: i,
        });
    }
    return out;
}
/**
 * 诗的去重键：同题不同作很多（蝶恋花/浣溪沙 等），键里加上首句前 12 字。
 * poem 路由记录「已念过」也用它，保证与数据规范化口径一致。
 */
// 去重键定义在 shared/poem.ts（路由也要用，两边口径必须一致）
export { poemKeyOf };
/** 诗词条目：只留路由用到的字段，标题/首句为空的丢掉，按 poemKeyOf 去重 */
export function normalizePoemItems(raw) {
    const arr = Array.isArray(raw) ? raw : [];
    const out = [];
    const keys = new Set();
    for (const p of arr) {
        if (!p || typeof p !== 'object')
            continue;
        const title = String(p.title || '').trim();
        if (!title)
            continue;
        const lines = Array.isArray(p.lines) ? p.lines.map((x) => String(x || '').trim()).filter(Boolean) : [];
        if (lines.length === 0)
            continue;
        const item = {
            type: String(p.type || ''),
            dynasty: String(p.dynasty || ''),
            title,
            author: String(p.author || ''),
            lines,
        };
        const k = poemKeyOf(item);
        if (keys.has(k))
            continue;
        keys.add(k);
        out.push(item);
    }
    return out;
}
/** 文化条目的去重键：成语/典故按名称，民间故事按「书名|标题」 */
export function cultureKeyOf(kind, item) {
    if (kind === 'chengyu' || kind === 'idiom')
        return String(item?.name || '').trim();
    return (String(item?.book || '') + '|' + String(item?.title || '')).trim();
}
/**
 * 文化条目：只保留对象、丢弃空键、按 cultureKeyOf 去重（保留第一条）。
 * 条目浅拷贝后返回：本地/云端都把原始 parse 结果留在自己的缓存里，不交给路由（见文件头）。
 */
export function normalizeCultureItems(kind, raw) {
    const arr = Array.isArray(raw) ? raw : [];
    const out = [];
    const keys = new Set();
    for (const it of arr) {
        if (!it || typeof it !== 'object')
            continue;
        const k = cultureKeyOf(kind, it);
        if (!k || keys.has(k))
            continue;
        keys.add(k);
        out.push({ ...it });
    }
    return out;
}
/**
 * 对联：本地 {items:[{upper,lower,source,cat}]}，云端 {total,cats:{分类:[...]}}。
 * 统一输出 items（拍平）与 cats（按分类），按上下联去重。
 */
export function normalizeDuilian(raw) {
    const items = [];
    const cats = {};
    const seen = new Set();
    const push = (x, fallbackCat) => {
        if (!x || typeof x !== 'object')
            return;
        const upper = String(x.upper == null ? '' : x.upper).trim();
        const lower = String(x.lower == null ? '' : x.lower).trim();
        if (!upper && !lower)
            return;
        const key = upper + '|' + lower;
        if (seen.has(key))
            return;
        seen.add(key);
        const cat = String(x.cat == null ? '' : x.cat).trim() || fallbackCat;
        const item = { upper, lower };
        if (x.source)
            item.source = String(x.source);
        item.cat = cat;
        items.push(item);
        const bucket = cats[cat] || (cats[cat] = []);
        bucket.push(item);
    };
    if (raw && raw.cats && typeof raw.cats === 'object' && !Array.isArray(raw.cats)) {
        for (const cat of Object.keys(raw.cats)) {
            const list = raw.cats[cat];
            if (!Array.isArray(list))
                continue;
            for (const x of list)
                push(x, cat);
        }
    }
    else if (raw && Array.isArray(raw.items)) {
        for (const x of raw.items)
            push(x, '');
    }
    else if (Array.isArray(raw)) {
        for (const x of raw)
            push(x, '');
    }
    const data = {
        total: Number(raw && raw.total) || items.length,
        items,
        cats,
    };
    if (raw && typeof raw.note === 'string' && raw.note)
        data.note = raw.note;
    return data;
}
/** 每日一句：丢掉缺 date/text 的条目 */
export function normalizeDaily(raw) {
    const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.items) ? raw.items : []);
    const out = [];
    for (const x of arr) {
        if (!x || typeof x !== 'object')
            continue;
        const date = String(x.date || '').trim();
        const text = String(x.text || '').trim();
        if (!date || !text)
            continue;
        const item = { date, type: String(x.type || ''), text };
        if (x.source)
            item.source = String(x.source);
        out.push(item);
    }
    return out;
}
