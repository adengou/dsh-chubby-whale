/**
 * host/routes/misc.ts —— 图片/状态/余额/成长/鱼粮/宠物/清除记忆/缓存路由（可复用模块）
 * 只依赖注入的读取器（load*）与动作（feedPet/clearMemory/…），不直接摸 store/cache 实现。
 *
 * 约定：本插件沿用「HTTP 200 承载业务失败（ok:false）」的既有口径，只有参数/方法
 * 本身不合法时才用 4xx（/cache 的 action 校验是唯一一处）。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { growthStage } from '../../shared/growth.js';
import { fetchJson, isTimeoutError } from '../http.js';
import { sendJson, sendText, sendError, sendBuffer } from '../respond.js';
import { PRICING_CHECKED_AT, PRICING_SOURCE } from '../../shared/pricing.js';
/** 余额查询超时：15 秒 */
const BALANCE_TIMEOUT = 15 * 1000;
/** 亲密度上限（与 state.json 同口径） */
const INTIMACY_MAX = 100;
/** 鱼账本分桶键（与 host/repos/fishfood.ts 的 byKind 同名同序；改动要两边一起改） */
const TOKEN_KINDS = ['chat', 'story', 'summary', 'personality'];
/** 亲密度展示口径：非数字/负数归 0，超 100 截到 100（真源另在 repos/state.ts 清洗） */
function cleanIntimacy(value) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return 0;
    return Math.max(0, Math.min(INTIMACY_MAX, Math.floor(n)));
}
/** 非负整数（经验/token 展示用）：NaN/负数/Infinity 一律归 0 */
function nonNegInt(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
/** 取 query 参数里的 action；URL 坏掉时返回 null（由调用方按方法判定） */
function readAction(req) {
    try {
        const url = new URL(String((req && req.url) || ''), 'http://x');
        return url.searchParams.get('action');
    }
    catch {
        return null;
    }
}
export function createMiscHandlers(opts) {
    async function handleAsset(_req, res) {
        try {
            const buf = await readFile(opts.assetPath);
            sendBuffer(res, buf, 'image/png', { 'cache-control': 'no-store' });
        }
        catch {
            sendText(res, 404, 'asset not found');
        }
    }
    /** 皮肤画廊：/skin/<n> → assets/gallery/bg-<n>.webp（n 0-48） */
    async function handleSkin(req, res) {
        try {
            const url = String(req && req.url ? req.url : '');
            const mm = url.match(/[?&]?n=(\d+)/) || url.match(/\/skin\/(\d+)/);
            const n = mm ? parseInt(mm[1], 10) : 0;
            if (!Number.isFinite(n) || n < 0 || n > 48) {
                sendText(res, 404, 'bad skin index');
                return;
            }
            const file = join(opts.skinsDir || '', 'bg-' + (n < 10 ? '0' : '') + n + '.webp');
            const buf = await readFile(file);
            sendBuffer(res, buf, 'image/webp', { 'cache-control': 'public, max-age=86400' });
        }
        catch {
            sendText(res, 404, 'skin not found');
        }
    }
    async function handleState(_req, res) {
        try {
            const st = opts.loadState() || {};
            sendJson(res, { ok: true, intimacy: cleanIntimacy(st.intimacy) });
        }
        catch (err) {
            sendError(res, err, { intimacy: 0 });
        }
    }
    async function handleBalance(_req, res) {
        try {
            const key = opts.getKey();
            if (!key) {
                sendJson(res, { ok: false, error: 'NO_KEY', balance: null });
                return;
            }
            const r = await fetchJson('https://api.deepseek.com/user/balance', { headers: { authorization: `Bearer ${key}` } }, BALANCE_TIMEOUT);
            if (!r.ok) {
                console.error('[misc] BALANCE-HTTP ' + r.status);
                sendJson(res, { ok: false, error: `HTTP ${r.status}`, balance: null });
                return;
            }
            const data = r.data;
            // 200 但回包形状不对（不是对象 / balance_infos 不是数组）属于上游坏了：
            // 给可诊断的 BAD_RESPONSE，别把 "infos.find is not a function" 这种内部报错当错误文案
            if (!data || typeof data !== 'object' || !Array.isArray(data.balance_infos)) {
                console.error('[misc] BALANCE-SHAPE 回包缺少 balance_infos 数组');
                sendJson(res, { ok: false, error: 'BAD_RESPONSE', balance: null });
                return;
            }
            const infos = data.balance_infos;
            const cny = infos.find((x) => Boolean(x) && x.currency === 'CNY') || infos.find((x) => Boolean(x)) || null;
            // balance / currency 必须恒有值：undefined 会被 JSON.stringify 整个丢掉，
            // 客户端拿到「ok:true 但没有 balance 字段」会当成没刷出来（而不是"没有余额信息"）
            const balance = cny && cny.total_balance != null ? cny.total_balance : null;
            const currency = cny && typeof cny.currency === 'string' && cny.currency ? cny.currency : 'CNY';
            sendJson(res, { ok: true, balance, currency });
        }
        catch (err) {
            // 超时/网络错误：照旧回 ok:false + balance:null，日志里留 BALANCE-TIMEOUT 标签
            if (isTimeoutError(err))
                console.error('[misc] BALANCE-TIMEOUT ' + BALANCE_TIMEOUT + 'ms 无响应，已中止');
            else
                console.error('[misc] BALANCE-ERR ' + String(err?.message || err));
            sendJson(res, { ok: false, error: isTimeoutError(err) ? 'timeout' : String(err?.message || err), balance: null });
        }
    }
    async function handleGrowth(_req, res) {
        try {
            const g = opts.loadGrowth() || {};
            const exp = nonNegInt(g.exp);
            const st = growthStage(exp);
            sendJson(res, { ok: true, exp, stage: st.name, nextExp: st.nextExp });
        }
        catch (err) {
            sendError(res, err, { exp: 0, stage: growthStage(0).name, nextExp: growthStage(0).nextExp });
        }
    }
    /** 金额清洗：非负有限，保留 6 位小数（与记账时精度一致） */
    function nonNegCost(v) {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0)
            return 0;
        return Math.round(Math.min(1e9, n) * 1e6) / 1e6;
    }
    /**
     * 分桶输出（2026-11-07 B98）：四个桶固定都出现，缺字段/脏值一律 0。
     * 老 fishfood.json 没有 byKind → 全 0 桶（不是 null、不是缺字段），老客户端读不到也不报错。
     */
    function readKindBuckets(value) {
        const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const out = {};
        for (const kind of TOKEN_KINDS) {
            const b = src[kind] && typeof src[kind] === 'object' && !Array.isArray(src[kind]) ? src[kind] : {};
            out[kind] = {
                tokens: nonNegInt(b.tokens),
                costCny: nonNegCost(b.costCny),
                dayTokens: nonNegInt(b.dayTokens),
                dayCostCny: nonNegCost(b.dayCostCny),
                monthTokens: nonNegInt(b.monthTokens),
                monthCostCny: nonNegCost(b.monthCostCny),
            };
        }
        return out;
    }
    async function handleFishfood(_req, res) {
        try {
            // loadFishfood 读入时已做跨天/跨月滚动，这里拿到的今日/本月计数不会停在昨天
            const f = opts.loadFishfood() || {};
            const chatTokens = nonNegInt(f.chatTokens);
            const storyTokens = nonNegInt(f.storyTokens);
            // 鱼账本（2026-11-07）：token 明细 + 人民币估算。金额由 shared/pricing.ts 在**记账时**算好落下，
            // 这里只读不算 —— 否则跨高峰/空闲边界重算会与当时实际单价不一致。
            const promptTokens = nonNegInt(f.promptTokens);
            const completionTokens = nonNegInt(f.completionTokens);
            const cacheHitTokens = nonNegInt(f.cacheHitTokens);
            const costCny = nonNegCost(f.costCny);
            sendJson(res, {
                ok: true,
                chatTokens,
                storyTokens,
                total: chatTokens + storyTokens,
                dayTokens: nonNegInt(f.dayTokens),
                // —— 明细与金额（老版本文件里没有这些字段，按 0 处理）——
                promptTokens,
                completionTokens,
                cacheHitTokens,
                costCny,
                dayCostCny: nonNegCost(f.dayCostCny),
                monthCostCny: nonNegCost(f.monthCostCny),
                monthTokens: nonNegInt(f.monthTokens),
                // —— 分桶（B98）：聊天 / 说书 / 摘要 / 人格，各带 tokens 与金额（含当日/当月）——
                // 缺 byKind 的老账本 → 四个 0 桶；上面那些既有字段一个都没动。
                byKind: readKindBuckets(f.byKind),
                // 估算说明：金额随高峰/空闲单价变化，且只有拿到 usage 拆分才计（说明来自 shared/pricing.ts）
                costIsEstimate: true,
                priceSource: PRICING_SOURCE,
                priceCheckedAt: PRICING_CHECKED_AT,
            });
        }
        catch (err) {
            sendError(res, err, { chatTokens: 0, storyTokens: 0, total: 0, dayTokens: 0, byKind: readKindBuckets(null) });
        }
    }
    async function handlePet(req, res) {
        try {
            const url = new URL(String((req && req.url) || ''), 'http://x');
            if (url.searchParams.get('action') === 'feed' && opts.feedPet) {
                const pet = opts.feedPet();
                // 亲密度以 state.json 为准：喂食只负责"加"，不再让 pet_state.intimacy 自成一套
                let intimacy = cleanIntimacy(pet && pet.intimacy);
                let bumped = false;
                if (opts.bumpIntimacy) {
                    try {
                        const v = Number(opts.bumpIntimacy(2));
                        if (Number.isFinite(v)) {
                            intimacy = cleanIntimacy(v);
                            bumped = true;
                        }
                    }
                    catch (e) { }
                }
                // 加分失败（写 state.json 出错/返回非数字）时仍要显示当前亲密度：
                // 用 loadIntimacy 兜底，否则喂一次食会把面板显示成 0，而 state 里的值其实还在
                if (!bumped && opts.loadIntimacy) {
                    try {
                        const v = Number(opts.loadIntimacy());
                        if (Number.isFinite(v))
                            intimacy = cleanIntimacy(v);
                    }
                    catch (e) { }
                }
                sendJson(res, { ok: true, pet: { ...(pet || {}), intimacy } });
                return;
            }
            const pet = opts.loadPet ? opts.loadPet() : { feeds: 0, hunger: 0, mood: 'normal' };
            let intimacy = cleanIntimacy(pet && pet.intimacy);
            if (opts.loadIntimacy) {
                try {
                    const v = Number(opts.loadIntimacy());
                    if (Number.isFinite(v))
                        intimacy = cleanIntimacy(v);
                }
                catch (e) { }
            }
            sendJson(res, { ok: true, pet: { ...(pet || {}), intimacy } });
        }
        catch (err) {
            sendError(res, err);
        }
    }
    /**
     * 聊天缓存：GET 看条数，DELETE 清空；也接受 ?action=stat|clear（显式优先于方法）。
     * action 只认这两个值，其它值回 400 BAD_ACTION——参数写错时不能悄悄当成 stat 返回 0。
     */
    async function handleCache(req, res) {
        try {
            const rawAction = readAction(req);
            const action = rawAction == null ? '' : String(rawAction).trim().toLowerCase();
            if (action && action !== 'clear' && action !== 'stat') {
                sendJson(res, { ok: false, error: 'BAD_ACTION' }, 400);
                return;
            }
            const method = String((req && req.method) || 'GET').toUpperCase();
            const doClear = action ? action === 'clear' : method === 'DELETE';
            if (doClear) {
                let n = 0;
                try {
                    if (opts.clearChatCache)
                        n = await opts.clearChatCache();
                }
                catch (err) {
                    sendError(res, err, { cleared: 0 });
                    return;
                }
                sendJson(res, { ok: true, cleared: nonNegInt(n) });
                return;
            }
            let count = 0;
            try {
                if (opts.chatCacheCount)
                    count = await opts.chatCacheCount();
            }
            catch { }
            let byType = {};
            try {
                if (opts.cacheStats)
                    byType = await opts.cacheStats() || {};
            }
            catch { }
            const total = Object.keys(byType).length ? Object.values(byType).reduce((a, b) => a + (Number(b) || 0), 0) : count;
            sendJson(res, { ok: true, count: nonNegInt(total), byType });
        }
        catch (err) {
            sendError(res, err);
        }
    }
    async function handleClearMemory(_req, res) {
        let memoryError = null;
        try {
            if (opts.clearMemory)
                opts.clearMemory();
        }
        catch (err) {
            memoryError = err;
        }
        // 无论记忆清空成功与否，聊天缓存都要清：否则「它把主人忘了，却还说着同一句话」。
        // 只清聊天记忆与聊天缓存；L2 可变人格 / L3 近期心境是人格资产，不属于「聊天记忆」，不在这里清。
        let cleared = 0;
        try {
            if (opts.clearChatCache)
                cleared = await opts.clearChatCache();
        }
        catch { }
        cleared = nonNegInt(cleared);
        try {
            res.setHeader && res.setHeader('x-cache-cleared', String(cleared));
        }
        catch { }
        if (memoryError) {
            sendError(res, memoryError, { cacheCleared: cleared });
            return;
        }
        sendJson(res, { ok: true, cacheCleared: cleared });
    }
    function handleStatus(_req, res) {
        try {
            sendJson(res, { ok: true, name: 'dsh-chubby-whale', key: Boolean(opts.getKey()) });
        }
        catch (err) {
            sendError(res, err, { key: false });
        }
    }
    return { handleAsset, handleSkin, handleState, handleBalance, handleStatus, handleGrowth, handleFishfood, handlePet, handleClearMemory, handleCache };
}
