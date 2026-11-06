/**
 * host/repos/state.ts —— 亲密度状态仓储（state.json）
 * 从 host/store.ts 拆出；写盘走 host/atomic.ts，读坏文件按 [store] 前缀留痕并备份。
 * 读入容错 UTF-8 BOM，写出统一 UTF-8 无 BOM。
 *
 * 亲密度是 0..100 的整数：读入先清洗（非数字/负数归 0，超 100 截到 100），
 * 写出也再清洗一次——路由/备份导入拿到的旧值再脏，落盘的永远是合法值。
 */
import { join } from 'node:path';
import { writeJsonAtomic, isMissingFileError, quarantineFile, readTextNoBom } from '../atomic.js';
/** 亲密度的唯一清洗口径：非有限数 → 0，向下取整，夹到 [0, 100] */
function cleanIntimacy(value) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return 0;
    return Math.max(0, Math.min(100, Math.floor(n)));
}
export function createStateRepo(dataDir) {
    const STATE = join(dataDir, 'state.json');
    function loadState() {
        try {
            const obj = JSON.parse(readTextNoBom(STATE));
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                obj.intimacy = cleanIntimacy(obj.intimacy);
                return obj;
            }
        }
        catch (err) {
            if (!isMissingFileError(err))
                quarantineFile(STATE, err, '[store]');
        }
        return { intimacy: 0 };
    }
    function saveState(obj) {
        const out = (obj && typeof obj === 'object' && !Array.isArray(obj)) ? { ...obj, intimacy: cleanIntimacy(obj.intimacy) } : { intimacy: 0 };
        try {
            writeJsonAtomic(STATE, out);
        }
        catch (err) {
            console.error('[store] WRITE-FAIL ' + String(STATE) + ' err=' + String(err?.message || err));
        }
    }
    return { loadState, saveState };
}
