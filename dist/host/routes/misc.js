/**
 * host/routes/misc.ts —— 图片/状态/余额/成长/鱼粮/宠物/清除记忆/缓存路由（可复用模块）
 * 只依赖注入的读取器（load*）与动作（feedPet/clearMemory/…），不直接摸 store/cache 实现。
 */
import { readFile } from 'node:fs/promises';
import { growthStage } from '../../shared/growth.js';
import { fetchJson, isTimeoutError } from '../http.js';
import { sendJson, sendText, sendError, sendBuffer } from '../respond.js';
/** 余额查询超时：15 秒 */
const BALANCE_TIMEOUT = 15 * 1000;
export function createMiscHandlers(opts) {
    async function handleAsset(_req, res) {
        try {
            const buf = await readFile(opts.assetPath);
            sendBuffer(res, buf, 'image/png', { 'cache-control': 'public, max-age=86400' });
        }
        catch {
            sendText(res, 404, 'asset not found');
        }
    }
    async function handleState(_req, res) {
        const st = opts.loadState();
        sendJson(res, { ok: true, intimacy: Number(st.intimacy) || 0 });
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
            const infos = data?.balance_infos || [];
            const cny = infos.find((x) => x.currency === 'CNY') || infos[0] || null;
            sendJson(res, { ok: true, balance: cny ? cny.total_balance : null, currency: cny ? cny.currency : 'CNY' });
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
        const g = opts.loadGrowth();
        const st = growthStage(Number(g.exp) || 0);
        sendJson(res, { ok: true, exp: Number(g.exp) || 0, stage: st.name, nextExp: st.nextExp });
    }
    async function handleFishfood(_req, res) {
        const f = opts.loadFishfood();
        sendJson(res, {
            ok: true,
            chatTokens: Number(f.chatTokens) || 0,
            storyTokens: Number(f.storyTokens) || 0,
            total: (Number(f.chatTokens) || 0) + (Number(f.storyTokens) || 0),
        });
    }
    async function handlePet(req, res) {
        try {
            const url = new URL(req.url, 'http://x');
            if (url.searchParams.get('action') === 'feed' && opts.feedPet) {
                const pet = opts.feedPet();
                // 亲密度以 state.json 为准：喂食只负责"加"，不再让 pet_state.intimacy 自成一套
                let intimacy = Number(pet && pet.intimacy) || 0;
                if (opts.bumpIntimacy) {
                    try {
                        intimacy = Number(opts.bumpIntimacy(2)) || intimacy;
                    }
                    catch (e) { }
                }
                else if (opts.loadIntimacy) {
                    try {
                        intimacy = Number(opts.loadIntimacy()) || intimacy;
                    }
                    catch (e) { }
                }
                sendJson(res, { ok: true, pet: { ...(pet || {}), intimacy } });
                return;
            }
            const pet = opts.loadPet ? opts.loadPet() : { feeds: 0, hunger: 0, mood: 'normal' };
            let intimacy = Number(pet && pet.intimacy) || 0;
            if (opts.loadIntimacy) {
                try {
                    intimacy = Number(opts.loadIntimacy()) || intimacy;
                }
                catch (e) { }
            }
            sendJson(res, { ok: true, pet: { ...(pet || {}), intimacy } });
        }
        catch (err) {
            sendError(res, err);
        }
    }
    /** 聊天缓存：GET 看条数，DELETE 清空 */
    async function handleCache(req, res) {
        try {
            if (req.method === 'DELETE') {
                let n = 0;
                try {
                    if (opts.clearChatCache)
                        n = await opts.clearChatCache();
                }
                catch { }
                sendJson(res, { ok: true, cleared: n });
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
                    byType = await opts.cacheStats();
            }
            catch { }
            const total = Object.keys(byType).length ? Object.values(byType).reduce((a, b) => a + b, 0) : count;
            sendJson(res, { ok: true, count: total, byType });
        }
        catch (err) {
            sendError(res, err);
        }
    }
    async function handleClearMemory(_req, res) {
        try {
            if (opts.clearMemory)
                opts.clearMemory();
            // 连聊天缓存一起清：否则「它把主人忘了，却还说着同一句话」
            let cleared = 0;
            try {
                if (opts.clearChatCache)
                    cleared = await opts.clearChatCache();
            }
            catch { }
            try {
                res.setHeader && res.setHeader('x-cache-cleared', String(cleared));
            }
            catch { }
            sendJson(res, { ok: true, cacheCleared: typeof cleared === 'number' ? cleared : 0 });
        }
        catch (err) {
            sendError(res, err);
        }
    }
    function handleStatus(_req, res) {
        sendJson(res, { ok: true, name: 'dsh-chubby-whale', key: Boolean(opts.getKey()) });
    }
    return { handleAsset, handleState, handleBalance, handleStatus, handleGrowth, handleFishfood, handlePet, handleClearMemory, handleCache };
}
