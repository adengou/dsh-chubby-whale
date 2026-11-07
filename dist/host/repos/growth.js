/**
 * host/repos/growth.ts —— 成长仓储与规则（growth.json）
 *
 * 从 host/store.ts 拆出：成长阶段表、每日/每来源经验上限、跨天重置都在这里。
 * 写盘走 host/atomic.ts；读坏文件按 [store] 前缀留痕并备份。
 * 读入容错 UTF-8 BOM，写出统一 UTF-8 无 BOM。
 */
import { deepFreeze } from '../../shared/immutable.js';
import { GROWTH_STAGES, growthStage } from '../../shared/growth.js';
import { join } from 'node:path';
import { writeJsonAtomic, isMissingFileError, quarantineFile, readTextNoBom } from '../atomic.js';
// 阶段表与"经验→阶段"规则在 shared/growth.ts（纯函数，路由也能直接用）
export { GROWTH_STAGES, growthStage };
/** 每天最多涨 12 点经验（照 C# Growth.DailyCap） */
export const EXP_DAILY_CAP = 12;
/** 各来源的每日上限（照 C# Growth.SourceCap；未知来源按 3） */
export const EXP_SOURCE_CAP = { chat: 5, praise: 6, feed: 6, story: 4, company: 6 };
deepFreeze(EXP_SOURCE_CAP);
export const EXP_SOURCE_DEFAULT_CAP = 3;
/**
 * 经验上限（2026-11-07 B105）：读入时封顶到安全整数。
 * 为什么：导入/手改的 growth.json 可以是 1e308，旧实现 Math.floor(Number(g.exp)||0) 会原样保留，
 * 再写盘还是 1e308；之后任何 exp + gain 都在浮点边界上抖，阶段与进度条也失去意义。
 * 与鱼粮 token 的 MAX_SAFE_INTEGER 口径一致（导入层也按同一数值封顶）。
 */
const MAX_EXP = Number.MAX_SAFE_INTEGER;
/** 今天（本地时区）的 'YYYY-MM-DD'，跨天判断用 */
function todayKey() {
    const d = new Date();
    const p = (n) => (n < 10 ? '0' + n : String(n));
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
export function createGrowthRepo(dataDir) {
    const GROWTH = join(dataDir, 'growth.json');
    /** 读成长数据；老文件缺 dayKey / dayExp / src 时按 0 兜底，其它字段与已有数据原样保留 */
    function loadGrowth() {
        try {
            const obj = JSON.parse(readTextNoBom(GROWTH));
            if (obj && typeof obj === 'object')
                return obj;
        }
        catch (err) {
            if (!isMissingFileError(err))
                quarantineFile(GROWTH, err, '[store]');
        }
        return { exp: 0 };
    }
    function saveGrowth(obj) {
        try {
            writeJsonAtomic(GROWTH, obj);
        }
        catch (err) {
            console.error('[store] WRITE-FAIL ' + String(GROWTH) + ' err=' + String(err?.message || err));
        }
    }
    function addExp(amount, source) {
        const g = loadGrowth();
        // 读入即封顶：脏文件里的 1e308/Infinity 只当「很多」，不当真值
        const exp0 = Math.min(MAX_EXP, Math.max(0, Math.floor(Number(g.exp) || 0)));
        const prev = growthStage(exp0);
        const srcName = String(source || 'chat'); // 老调用方不传来源：按 chat 记（照 C# 的 AddExp(reason) 必须有来源）
        const capSrc = Object.prototype.hasOwnProperty.call(EXP_SOURCE_CAP, srcName) ? EXP_SOURCE_CAP[srcName] : EXP_SOURCE_DEFAULT_CAP;
        // 老文件兜底：缺 dayKey / dayExp / src / src[source] 都按 0 算，不动其它字段
        const today = todayKey();
        let dayExp = Math.min(MAX_EXP, Math.max(0, Math.floor(Number(g.dayExp) || 0)));
        let src = (g.src && typeof g.src === 'object' && !Array.isArray(g.src)) ? g.src : {};
        if (String(g.dayKey || '') !== today) { // 跨天：日计数重置、各来源额度清零
            dayExp = 0;
            src = {};
            for (const k of Object.keys(EXP_SOURCE_CAP))
                src[k] = 0;
        }
        // 请求量只认「非负整数」；NaN → 0，Infinity 按「要很多」处理（仍会被上限截断），
        // 绝不让 exp 变成非有限数
        const amountNum = Number(amount);
        const requested = Number.isFinite(amountNum)
            ? Math.max(0, Math.floor(amountNum))
            : (amountNum > 0 ? Number.MAX_SAFE_INTEGER : 0);
        let gain = requested;
        // capped 的语义：这次请求「没拿满」就是被上限截了（哪怕只截了一部分）。
        // 原实现只在额度已用完时置 true，被日上限/来源上限部分截断时仍报 false，调用方会误以为全额入账。
        let capped = false;
        let used = 0;
        if (gain > 0) {
            const roomDay = EXP_DAILY_CAP - dayExp;
            if (roomDay <= 0) {
                capped = true;
                gain = 0;
                console.error('[store] GROWTH-CAP-DAY source=' + srcName + ' exp=' + exp0 + ' dayExp=' + dayExp + ' cap=' + EXP_DAILY_CAP);
            }
            else {
                used = Math.max(0, Math.floor(Number(src[srcName]) || 0));
                const roomSrc = capSrc - used;
                if (roomSrc <= 0) {
                    capped = true;
                    gain = 0;
                    console.error('[store] GROWTH-CAP-SRC source=' + srcName + ' used=' + used + ' cap=' + capSrc + ' exp=' + exp0);
                }
                else {
                    gain = Math.min(gain, roomDay, roomSrc);
                    if (gain < requested)
                        capped = true;
                }
            }
        }
        // 结果也要封顶：exp0 已经是 MAX_SAFE_INTEGER 时再加 gain 会越过 2^53（不再是安全整数，JSON 里会变 9007199254740992）
        const exp = Math.min(MAX_EXP, exp0 + gain);
        if (gain > 0) {
            dayExp += gain;
            src[srcName] = used + gain;
        }
        g.exp = exp;
        g.dayKey = today;
        g.dayExp = dayExp;
        g.src = src;
        saveGrowth(g);
        const stage = growthStage(exp);
        return { exp, stage, upgraded: stage.index > prev.index, prevStage: prev, capped };
    }
    return { loadGrowth, saveGrowth, addExp };
}
