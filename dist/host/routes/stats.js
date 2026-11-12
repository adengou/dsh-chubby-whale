/**
 * host/routes/stats.ts —— 可视化汇总（只读）
 *
 *   GET /api/chubby-whale/stats
 *
 * 返回：
 *   {
 *     ok,
 *     cache: { tts, chat, asr },                       // 三个缓存目录的条目数
 *     fishfood: { chatTokens, storyTokens, total,       // total = chat + story（与 /fishfood 同口径）
 *                 promptTokens, completionTokens, cacheHitTokens, costCny, dayCostCny,
 *                 byKind: { chat, story, summary, personality } },  // B98 分桶：tokens/costCny + 当日/当月
 *     growth: { exp, stage, nextExp },                 // 与 /growth 同口径
 *     intimacy,                                        // state.json，0..100（与 /state 同口径）
 *     personality: { catchphrases, preferences, notes, selfNarrative },
 *     uptimeMs                                         // 插件本次装配至今
 *   }
 *
 * 数值口径：所有数字字段都是有限非负整数——NaN / Infinity / 负数 / 数字字符串都在这里归一，
 * 不让 NaN 进 JSON（JSON.stringify 会把 NaN 变成 null，客户端拿到 null 会显示成"没有值"）。
 * intimacy 和 /state 一样夹到 [0, 100]：同一份 state.json 不许在两个接口给出两个亲密度。
 *
 * 数据全部来自现有 store / cache / 人格仓储的读取器，不新增任何持久化文件，也不写盘。
 */
import { growthStage } from '../../shared/growth.js';
import { sendJson, sendError } from '../respond.js';
function resolve(v, fallback) {
    if (typeof v === 'function') {
        try {
            const got = v();
            return got === undefined || got === null ? fallback : got;
        }
        catch {
            return fallback;
        }
    }
    return v === undefined || v === null ? fallback : v;
}
/** 非负整数（NaN/负数/小数一律归零或取整，展示用不需要负值） */
function count(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
/** 金额清洗：非负、有限、6 位小数（与 /fishfood、repos/fishfood.ts 同一口径） */
function money(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0)
        return 0;
    return Math.round(Math.min(1e9, n) * 1e6) / 1e6;
}
/** 鱼账本分桶键（与 host/repos/fishfood.ts 的 byKind 同名同序；改动要两边一起改） */
const TOKEN_KINDS = ['chat', 'story', 'summary', 'personality'];
/**
 * 分桶输出（2026-11-07 B98）：四个桶固定都出现，缺字段/脏值/老文件没有 byKind → 全 0 桶。
 * 与 /fishfood 的 byKind 同口径；既有 fishfood 字段一个都不改。
 */
function kindBuckets(value) {
    const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const out = {};
    for (const kind of TOKEN_KINDS) {
        const b = src[kind] && typeof src[kind] === 'object' && !Array.isArray(src[kind]) ? src[kind] : {};
        out[kind] = {
            tokens: count(b.tokens),
            costCny: money(b.costCny),
            dayTokens: count(b.dayTokens),
            dayCostCny: money(b.dayCostCny),
            monthTokens: count(b.monthTokens),
            monthCostCny: money(b.monthCostCny),
        };
    }
    return out;
}
/** 亲密度上限（与 host/repos/state.ts、host/routes/misc.ts 同一口径） */
const INTIMACY_MAX = 100;
/** 亲密度展示口径：非数字/负数归 0，超 100 截到 100（与 /state 同口径，不许两个接口两个值） */
function intimacyOf(value) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return 0;
    return Math.max(0, Math.min(INTIMACY_MAX, Math.floor(n)));
}
function strList(value) {
    return (Array.isArray(value) ? value : []).filter((x) => typeof x === 'string');
}
export function createStatsHandler(opts) {
    const nowFn = opts.now || (() => Date.now());
    async function buildStats() {
        let cache = {};
        try {
            const raw = opts.cacheStats ? await opts.cacheStats() : {};
            cache = raw && typeof raw === 'object' ? raw : {};
        }
        catch {
            cache = {};
        }
        const growth = opts.loadGrowth() || {};
        const exp = count(growth.exp);
        const stage = growthStage(exp);
        const fish = opts.loadFishfood() || {};
        const chatTokens = count(fish.chatTokens);
        const storyTokens = count(fish.storyTokens);
        const state = opts.loadState() || {};
        const p = opts.loadPersonality ? (opts.loadPersonality() || {}) : {};
        const startedAt = Number(opts.startedAt) || 0;
        const elapsed = nowFn() - startedAt;
        // 时钟坏了（now() 非有限数）时 elapsed 是 NaN，JSON 会把它写成 null；这里给 0，保持数字类型
        const uptimeMs = startedAt > 0 && Number.isFinite(elapsed) ? Math.max(0, Math.floor(elapsed)) : 0;
        // 自检字段是"外部注入"的：形状由调用方决定，这里逐项归一再出包；
        // 支持 getter（备份份数/模型名要反映"现在"，而不是插件加载那一刻）
        const ttsRaw = resolve(opts.tts, {}) || {};
        const backupRaw = resolve(opts.backup, {}) || {};
        const dataSource = String(resolve(opts.dataSource, 'local') || 'local');
        const model = String(resolve(opts.model, '') || '');
        const version = String(resolve(opts.version, '') || '');
        return {
            ok: true,
            // 2026-11-12：之前只算了 const version，却没放进返回体，/stats 永远没有 version 字段
            version,
            cache: { tts: count(cache.tts), chat: count(cache.chat), asr: count(cache.asr) },
            fishfood: {
                chatTokens, storyTokens, total: chatTokens + storyTokens,
                // 鱼账本（2026-11-07）：明细与人民币估算同 /fishfood 口径（金额在记账时算好，这里只读）
                promptTokens: count(fish.promptTokens),
                completionTokens: count(fish.completionTokens),
                cacheHitTokens: count(fish.cacheHitTokens),
                costCny: Math.max(0, Math.round((Number(fish.costCny) || 0) * 1e6) / 1e6),
                dayCostCny: Math.max(0, Math.round((Number(fish.dayCostCny) || 0) * 1e6) / 1e6),
                // 分桶（B98）：聊天 / 说书 / 摘要 / 人格，各带 tokens 与金额（含当日/当月）
                byKind: kindBuckets(fish.byKind),
            },
            growth: { exp, stage: stage.name, nextExp: stage.nextExp },
            intimacy: intimacyOf(state.intimacy),
            personality: {
                catchphrases: strList(p.catchphrases),
                preferences: strList(p.preferences),
                notes: typeof p.notes === 'string' ? p.notes : '',
                selfNarrative: typeof p.selfNarrative === 'string' ? p.selfNarrative : '',
            },
            uptimeMs,
            // 自检：数据源 / 模型 / TTS 引擎 / 备份（缺省不报错；坏值也不许把 null/负数/怪类型漏出去）
            dataSource,
            model,
            tts: {
                available: ttsRaw.available === true,
                interpreter: typeof ttsRaw.interpreter === 'string' ? ttsRaw.interpreter : '',
                cooling: ttsRaw.cooling === true,
            },
            backup: { lastAt: count(backupRaw.lastAt), count: count(backupRaw.count) },
        };
    }
    async function handleStats(req, res) {
        try {
            const method = req && req.method ? String(req.method).toUpperCase() : 'GET';
            if (method !== 'GET' && method !== 'HEAD') {
                sendJson(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
                return;
            }
            sendJson(res, await buildStats());
        }
        catch (err) {
            sendError(res, err);
        }
    }
    return { handleStats };
}
