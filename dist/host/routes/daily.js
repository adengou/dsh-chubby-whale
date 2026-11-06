/**
 * host/routes/daily.ts —— 每日一句
 *
 *   GET /api/chubby-whale/daily
 *
 * 取数优先级（数据只来自现有数据源，绝不编造）：
 *   ① data/daily.json（云端为 /culture/v1/daily.json，结构与本地一致 {items:[…]}）：
 *      有与今天匹配的条目就用它；没有今天时取「不晚于今天」的最近一条；
 *   ② 没有任何可用条目（本地首次运行没有这个文件是正常态）→ 从真实诗库取：
 *      按 yyyy-mm-dd 的日序号对诗库长度取模挑一首，text = lines.join('')，不截断；
 *   ③ 诗库也读不到 → {ok:false, error:'no-data'}（宁可空着，不编诗句）。
 *
 * 诗库经 DataPort 读（本地 data/poems.json 整册，云端第 0 片），路由不直接碰文件；
 * 本接口不写任何文件（不新增持久化）。
 */
import { sendJson, sendError } from '../respond.js';
/** 今天的 'YYYY-MM-DD'（本地时区，与成长/鱼粮跨天口径一致） */
export function todayKey(now = new Date()) {
    const p = (n) => (n < 10 ? '0' + n : String(n));
    return now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate());
}
/**
 * 日序号：'YYYY-MM-DD' → 距 1970-01-01 的天数。
 * 用 UTC 的日历算术（Date.UTC），不受本机时区/夏令时影响；非法日期返回 NaN。
 * 月/日允许不补零（'2026-9-1'）：daily.json 由外部工具生成时常见，
 * 按字符串比较会把它排到 '2026-10-01' 之后、误判成未来日期。
 */
export function dayIndexOf(date) {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(date == null ? '' : date).trim());
    if (!m)
        return NaN;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31))
        return NaN;
    const ms = Date.UTC(y, mo - 1, d);
    if (!Number.isFinite(ms))
        return NaN;
    // 回读校验：2019-02-30 这类会被 Date.UTC 进位，判为非法
    const back = new Date(ms);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d)
        return NaN;
    return Math.floor(ms / 86400000);
}
/**
 * 在 daily 条目里选今天这条：
 *   ① 日期完全匹配；② 没有今天 → 不晚于今天的最近一条；③ 全是未来日期 → 最早一条。
 * 一条都没有返回 null。
 * 日期一律先转成日序号再排序/比较：直接比字符串时 '2026-9-30' 会被当成比 '2026-10-01' 晚，
 * 导致「不晚于今天的最近一条」选到更早的那条。date 解析不了的条目丢弃（不猜）。
 */
export function pickDailyItem(items, today) {
    const entries = (Array.isArray(items) ? items : [])
        .filter((x) => Boolean(x && typeof x === 'object' && typeof x.date === 'string' && typeof x.text === 'string' && x.date && x.text))
        .map((x) => ({ item: x, day: dayIndexOf(x.date) }))
        .filter((e) => Number.isFinite(e.day))
        .sort((a, b) => a.day - b.day);
    if (entries.length === 0)
        return null;
    const todayDay = dayIndexOf(today);
    const exact = entries.find((e) => e.day === todayDay);
    if (exact)
        return exact.item;
    let past = null;
    for (const e of entries) {
        if (e.day <= todayDay)
            past = e.item;
        else
            break;
    }
    if (past)
        return past;
    return entries[0].item;
}
/**
 * 按日期从诗库挑一首：下标 = 日序号 mod 诗库长度。
 * 同一天必然同一首，相邻两天必然相邻两首（诗库长度 > 1 时不同）。
 * 只拼诗库里的原文，不改字、不截断、不补句。
 * 当日那首如果缺句子（数据不完整），从它往后环形找第一首可读的——
 * 否则一首脏数据会让「每日一句」整天返回 no-data。
 */
export function pickPoemForDay(poems, date) {
    const list = Array.isArray(poems) ? poems : [];
    const total = list.length;
    if (total === 0)
        return null;
    const day = dayIndexOf(date);
    if (!Number.isFinite(day))
        return null;
    const start = ((Math.trunc(day) % total) + total) % total;
    for (let k = 0; k < total; k++) {
        const idx = (start + k) % total;
        const p = list[idx];
        if (!p || typeof p !== 'object')
            continue;
        const lines = (Array.isArray(p.lines) ? p.lines : [])
            .map((x) => String(x == null ? '' : x).trim())
            .filter(Boolean);
        if (lines.length === 0)
            continue;
        const title = String(p.title || '').trim();
        const dynasty = String(p.dynasty || '').trim();
        const author = String(p.author || '').trim();
        const who = [dynasty, author].filter(Boolean).join('·');
        const source = ((title ? '《' + title + '》' : '') + (who ? ' ' + who : '')).trim();
        // 行与行直接相连，不用逗号/换行拼接（念诗与展示都按原文）
        return { index: idx, text: lines.join(''), source };
    }
    return null;
}
export function createDailyHandler(opts) {
    const nowFn = opts.now || (() => new Date());
    async function handleDaily(req, res) {
        try {
            const method = req && req.method ? String(req.method).toUpperCase() : 'GET';
            if (method !== 'GET' && method !== 'HEAD') {
                sendJson(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
                return;
            }
            const today = todayKey(nowFn());
            // ① daily.json 优先（本地缺文件时 DataPort 返回空数组，属于正常态）
            let items = [];
            try {
                items = await opts.dataPort.readDaily();
            }
            catch {
                items = [];
            }
            const hit = pickDailyItem(items, today);
            if (hit) {
                sendJson(res, {
                    ok: true,
                    date: hit.date,
                    type: hit.type || 'daily',
                    text: hit.text,
                    source: hit.source || '',
                    from: 'daily',
                });
                return;
            }
            // ② 诗库兜底：只从现有诗里取，不编造
            let poems = [];
            try {
                const chunk = await opts.dataPort.readPoemsChunk(0);
                poems = chunk && Array.isArray(chunk.items) ? chunk.items : [];
            }
            catch {
                poems = [];
            }
            const poem = pickPoemForDay(poems, today);
            if (!poem) {
                sendJson(res, { ok: false, error: 'no-data', date: today });
                return;
            }
            sendJson(res, {
                ok: true,
                date: today,
                type: 'poem',
                text: poem.text,
                source: poem.source,
                from: 'poem',
            });
        }
        catch (err) {
            sendError(res, err);
        }
    }
    return { handleDaily };
}
