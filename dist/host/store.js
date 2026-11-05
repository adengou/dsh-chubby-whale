/**
 * host/store.ts —— 持久化门面（各领域仓储已拆到 host/repos/）
 *
 * 拆分历史：原先这里一个 createStore 同时管记忆、亲密度、成长、鱼粮、提醒、宠物、说书进度，
 * 路由拿到的是 20 多个方法的"万能桶"。现在按领域拆成窄接口：
 *   host/repos/memory.ts     memory.json
 *   host/repos/state.ts      state.json（亲密度）
 *   host/repos/growth.ts     growth.json（成长阶段与经验上限）
 *   host/repos/fishfood.ts   fishfood.json（token 统计）
 *   host/repos/reminders.ts  reminders.json
 *   host/repos/pet.ts        pet_state.json
 *
 * 本文件只做组合，保持旧调用方（index/路由）的 store.xxx 形状不变；
 * 新代码应直接依赖对应 repo 的接口，不要再往门面上加方法。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic, isMissingFileError, quarantineFile } from './atomic.js';
import { createMemoryRepo } from './repos/memory.js';
import { createStateRepo } from './repos/state.js';
import { createGrowthRepo } from './repos/growth.js';
import { createTokenRepo } from './repos/fishfood.js';
import { createReminderRepo } from './repos/reminders.js';
import { createPetRepo } from './repos/pet.js';
// 成长规则已移到 host/repos/growth.ts；这里 re-export 保持旧导入路径可用
// （misc/briefing 仍从 store 取 growthStage，仓库内不出现循环依赖）。
export { GROWTH_STAGES, EXP_DAILY_CAP, EXP_SOURCE_CAP, EXP_SOURCE_DEFAULT_CAP, growthStage } from './repos/growth.js';
export function createStore(dataDir) {
    const STORY_PROGRESS = join(dataDir, 'story_progress.json');
    const memory = createMemoryRepo(dataDir);
    const stateRepo = createStateRepo(dataDir);
    const growthRepo = createGrowthRepo(dataDir);
    const tokenRepo = createTokenRepo(dataDir);
    const reminderRepo = createReminderRepo(dataDir);
    const petRepo = createPetRepo(dataDir);
    // ===== 说书进度（遗留） =====
    // 说书路由已改由 host/story/player.ts 管理同一文件，本组方法目前无调用者；
    // 保留是为了不破坏可能存在的旧调用方，后续确认无引用后可删除。
    function loadStoryProgress() {
        try {
            return JSON.parse(readFileSync(STORY_PROGRESS, 'utf8'));
        }
        catch (err) {
            if (!isMissingFileError(err))
                quarantineFile(STORY_PROGRESS, err, '[store]');
            return {};
        }
    }
    function saveStoryProgress(obj) {
        try {
            writeJsonAtomic(STORY_PROGRESS, obj);
        }
        catch (err) {
            console.error('[store] WRITE-FAIL ' + String(STORY_PROGRESS) + ' err=' + String(err?.message || err));
        }
    }
    return {
        loadHistory: memory.loadHistory, saveHistory: memory.saveHistory, appendTurns: memory.appendTurns,
        clearMemory: memory.clearMemory, loadMemorySummary: memory.loadMemorySummary, saveMemorySummary: memory.saveMemorySummary,
        loadState: stateRepo.loadState, saveState: stateRepo.saveState,
        loadStoryProgress, saveStoryProgress,
        loadGrowth: growthRepo.loadGrowth, saveGrowth: growthRepo.saveGrowth, addExp: growthRepo.addExp,
        loadFishfood: tokenRepo.loadFishfood, saveFishfood: tokenRepo.saveFishfood, addTokens: tokenRepo.addTokens,
        loadReminders: reminderRepo.loadReminders, saveReminders: reminderRepo.saveReminders,
        addReminder: reminderRepo.addReminder, dueReminders: reminderRepo.dueReminders, removeReminder: reminderRepo.removeReminder,
        loadPet: petRepo.loadPet, savePet: petRepo.savePet, tickPet: petRepo.tickPet,
        feedPet: petRepo.feedPet, setMood: petRepo.setMood,
    };
}
