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
 *
 * 权限（跨平台）：运行目录 ~/.dsh-chubby-whale 在 POSIX 下收成 0700，
 * 目录里的运行数据（含记忆/人格/状态/宠物这些隐私文件）收成 0600；Windows 跳过（无对应语义）。
 * 后续每次原子写也会把文件创建成 0600（见 host/atomic.ts），所以只有「升级前已存在」的
 * 旧文件需要这里补一次 chmod；失败静默，不影响功能。
 */
import { join } from 'node:path';
import { writeJsonAtomic, isMissingFileError, quarantineFile, ensurePrivateDir, chmodPrivateFile, readTextNoBom, } from './atomic.js';
import { createMemoryRepo } from './repos/memory.js';
import { createStateRepo } from './repos/state.js';
import { createGrowthRepo } from './repos/growth.js';
import { createTokenRepo } from './repos/fishfood.js';
import { createReminderRepo } from './repos/reminders.js';
import { createPetRepo } from './repos/pet.js';
// 成长规则已移到 host/repos/growth.ts；这里 re-export 保持旧导入路径可用
// （misc/briefing 仍从 store 取 growthStage，仓库内不出现循环依赖）。
export { GROWTH_STAGES, EXP_DAILY_CAP, EXP_SOURCE_CAP, EXP_SOURCE_DEFAULT_CAP, growthStage } from './repos/growth.js';
/**
 * 运行目录里的数据文件：全部属于主人本机隐私（聊天记忆、可变人格、亲密度、宠物状态…）。
 * POSIX 下统一补 0600；Windows 跳过。新增数据文件时记得加进这张表。
 */
const PRIVATE_DATA_FILES = [
    'memory.json', // 聊天记忆
    'personality.json', // L2 可变人格 / L3 近期心境
    'state.json', // 亲密度
    'pet_state.json', // 宠物状态
    'growth.json',
    'fishfood.json',
    'reminders.json',
    'story_progress.json',
    'culture-seen.json',
    'poem-seen.json',
    'prefs.json',
];
/** 收紧运行目录权限：建目录（0700）+ 给已存在的旧数据文件补 0600；POSIX 之外全部静默跳过 */
function hardenRuntimeDir(dataDir) {
    ensurePrivateDir(dataDir);
    for (const name of PRIVATE_DATA_FILES)
        chmodPrivateFile(join(dataDir, name));
}
export function createStore(dataDir) {
    hardenRuntimeDir(dataDir);
    const STORY_PROGRESS = join(dataDir, 'story_progress.json');
    const memory = createMemoryRepo(dataDir);
    const stateRepo = createStateRepo(dataDir);
    const growthRepo = createGrowthRepo(dataDir);
    const tokenRepo = createTokenRepo(dataDir);
    const reminderRepo = createReminderRepo(dataDir);
    const petRepo = createPetRepo(dataDir);
    // ===== 说书进度：整文件原始读写（备份导出/导入用） =====
    // 文件的进度键自 2026-11-06 起带数据源命名空间：`"<source>:<书名>|<序号>": true`
    // （source = local / cloud，由 index.ts 按 readDataSource() 注入给 player）；
    // `_current` 仍是「讲到哪本」的指针，不分数据源。
    // 命名空间规则、旧键迁移与只读兼容都在 host/story/player.ts：那里知道当前数据源，
    // 且迁移必须与启动/重新读盘的时机绑定。这里只负责原样搬运整份 JSON，备份包里的键不在此改写；
    // 旧格式（无 source: 前缀）的 `书名|序号` 键由 player 在启动/重读时归一到当前数据源。
    function loadStoryProgress() {
        try {
            return JSON.parse(readTextNoBom(STORY_PROGRESS));
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
