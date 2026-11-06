/**
 * host/repos/fishfood.ts —— 鱼粮（token 统计）仓储（fishfood.json）
 * 从 host/store.ts 拆出：跨天/跨月清零「今日/本月」，总量 totalTokens 不动（照 C# 的 date/month 滚动）。
 * 写盘走 host/atomic.ts；读坏文件按 [store] 前缀留痕并备份。
 * 读入容错 UTF-8 BOM，写出统一 UTF-8 无 BOM。
 */
import { join } from 'node:path';
import { writeJsonAtomic, isMissingFileError, quarantineFile, readTextNoBom } from '../atomic.js';
export function createTokenRepo(dataDir) {
    const FISHFOOD = join(dataDir, 'fishfood.json');
    function loadFishfood() {
        try {
            const obj = JSON.parse(readTextNoBom(FISHFOOD));
            if (obj && typeof obj === 'object')
                return obj;
        }
        catch (err) {
            if (!isMissingFileError(err))
                quarantineFile(FISHFOOD, err, '[store]');
        }
        return { chatTokens: 0, storyTokens: 0 };
    }
    function saveFishfood(obj) {
        try {
            writeJsonAtomic(FISHFOOD, obj);
        }
        catch (err) {
            console.error('[store] WRITE-FAIL ' + String(FISHFOOD) + ' err=' + String(err?.message || err));
        }
    }
    /** 跨天/跨月把"今日/本月"清零（总量 totalTokens 不动，照 C# 的 date/month 滚动） */
    function rollFishfood(f) {
        const now = new Date();
        const day = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
        const month = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
        if (f.day !== day) {
            f.day = day;
            f.chatTokens = 0;
            f.storyTokens = 0;
            f.dayTokens = 0;
        }
        if (f.month !== month) {
            f.month = month;
            f.monthTokens = 0;
        }
    }
    function addTokens(kind, n) {
        const f = loadFishfood();
        rollFishfood(f);
        if (kind === 'story')
            f.storyTokens = (Number(f.storyTokens) || 0) + n;
        else
            f.chatTokens = (Number(f.chatTokens) || 0) + n;
        // 今日 token 之前只清零不累加，永远是 0（面板上"今日"一直空着）
        f.dayTokens = (Number(f.dayTokens) || 0) + n;
        f.totalTokens = (Number(f.totalTokens) || 0) + n;
        f.monthTokens = (Number(f.monthTokens) || 0) + n;
        saveFishfood(f);
        return f;
    }
    return { loadFishfood, saveFishfood, addTokens };
}
