/**
 * host/repos/pet.ts —— 宠物状态仓储（pet_state.json：feeds/hunger/mood/intimacy）
 *
 * 从 host/store.ts 拆出：离线越久越饿（每小时 +3）、喂食 -30 饥饿 +2 亲密（照 C# 版）。
 * 写盘走 host/atomic.ts；读坏文件按 [store] 前缀留痕并备份。
 * 读入容错 UTF-8 BOM，写出统一 UTF-8 无 BOM。
 */
import { join } from 'node:path';
import { writeJsonAtomic, isMissingFileError, quarantineFile, readTextNoBom } from '../atomic.js';
export function createPetRepo(dataDir) {
    const PET = join(dataDir, 'pet_state.json');
    function loadPet() {
        try {
            const obj = JSON.parse(readTextNoBom(PET));
            if (obj && typeof obj === 'object')
                return obj;
        }
        catch (err) {
            if (!isMissingFileError(err))
                quarantineFile(PET, err, '[store]');
        }
        return { feeds: 0, hunger: 0, mood: 'normal', lastSeen: 0 };
    }
    function savePet(obj) {
        try {
            writeJsonAtomic(PET, obj);
        }
        catch (err) {
            console.error('[store] WRITE-FAIL ' + String(PET) + ' err=' + String(err?.message || err));
        }
    }
    function tickPet() {
        const p = loadPet();
        const now = Date.now();
        if (p.lastSeen) {
            const hoursAway = (now - Number(p.lastSeen)) / 3600000;
            if (hoursAway > 0)
                p.hunger = Math.min(100, (Number(p.hunger) || 0) + hoursAway * 3);
        }
        p.lastSeen = now;
        savePet(p);
        return p;
    }
    function feedPet() {
        const p = tickPet();
        p.feeds = (Number(p.feeds) || 0) + 1;
        p.hunger = Math.max(0, (Number(p.hunger) || 0) - 30);
        p.intimacy = Math.min(100, (Number(p.intimacy) || 0) + 2); // 照 C#：喂食亲密 +2
        p.mood = 'happy';
        savePet(p);
        return p;
    }
    function setMood(mood) {
        const p = loadPet();
        p.mood = mood;
        savePet(p);
    }
    return { loadPet, savePet, tickPet, feedPet, setMood };
}
