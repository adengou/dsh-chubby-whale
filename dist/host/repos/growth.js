/**
 * host/repos/growth.ts —— 成长仓储与规则（growth.json）
 *
 * 从 host/store.ts 拆出：成长阶段表、每日/每来源经验上限、跨天重置都在这里。
 * 写盘走 host/atomic.ts；读坏文件按 [store] 前缀留痕并备份。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic, isMissingFileError, quarantineFile } from '../atomic.js';
export const GROWTH_STAGES = [
    { exp: 0, name: '初识' },
    { exp: 200, name: '熟悉' },
    { exp: 800, name: '亲密' },
    { exp: 2500, name: '知心' },
    { exp: 5000, name: '家人' },
];
/** 每天最多涨 12 点经验（照 C# Growth.DailyCap） */
export const EXP_DAILY_CAP = 12;
/** 各来源的每日上限（照 C# Growth.SourceCap；未知来源按 3） */
export const EXP_SOURCE_CAP = { chat: 5, praise: 6, feed: 6, story: 4, company: 6 };
export const EXP_SOURCE_DEFAULT_CAP = 3;
export function growthStage(exp) {
    let idx = 0;
    for (let i = 0; i < GROWTH_STAGES.length; i++) {
        if (exp >= GROWTH_STAGES[i].exp)
            idx = i;
    }
    const next = idx + 1 < GROWTH_STAGES.length ? GROWTH_STAGES[idx + 1].exp : 0;
    return { index: idx, name: GROWTH_STAGES[idx].name, nextExp: next };
}
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
            const obj = JSON.parse(readFileSync(GROWTH, 'utf8'));
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
        catch { }
    }
    function addExp(amount, source) {
        const g = loadGrowth();
        const exp0 = Math.max(0, Number(g.exp) || 0);
        const prev = growthStage(exp0);
        const srcName = String(source || 'chat'); // 老调用方不传来源：按 chat 记（照 C# 的 AddExp(reason) 必须有来源）
        const capSrc = Object.prototype.hasOwnProperty.call(EXP_SOURCE_CAP, srcName) ? EXP_SOURCE_CAP[srcName] : EXP_SOURCE_DEFAULT_CAP;
        // 老文件兜底：缺 dayKey / dayExp / src / src[source] 都按 0 算，不动其它字段
        const today = todayKey();
        let dayExp = Number(g.dayExp) || 0;
        let src = (g.src && typeof g.src === 'object') ? g.src : {};
        if (String(g.dayKey || '') !== today) { // 跨天：日计数重置、各来源额度清零
            dayExp = 0;
            src = {};
            for (const k of Object.keys(EXP_SOURCE_CAP))
                src[k] = 0;
        }
        let capped = false;
        let gain = Math.floor(Number(amount) || 0);
        if (gain > 0) {
            const roomDay = EXP_DAILY_CAP - dayExp;
            if (roomDay <= 0) {
                capped = true;
                gain = 0;
                console.error('[store] GROWTH-CAP-DAY source=' + srcName + ' exp=' + exp0 + ' dayExp=' + dayExp + ' cap=' + EXP_DAILY_CAP);
            }
            else {
                if (gain > roomDay)
                    gain = roomDay;
                const used = Number(src[srcName]) || 0;
                const roomSrc = capSrc - used;
                if (roomSrc <= 0) {
                    capped = true;
                    gain = 0;
                    console.error('[store] GROWTH-CAP-SRC source=' + srcName + ' used=' + used + ' cap=' + capSrc + ' exp=' + exp0);
                }
                else if (gain > roomSrc) {
                    gain = roomSrc;
                }
            }
        }
        const exp = exp0 + (gain > 0 ? gain : 0);
        if (gain > 0) {
            dayExp += gain;
            src[srcName] = (Number(src[srcName]) || 0) + gain;
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
