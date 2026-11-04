/**
 * dsh-chubby-whale —— Host 端入口（模块化组装）
 * 编译输出 dist/index.js（插件加载入口）。
 * 模块：host/config.ts（Key）、host/store.ts（持久化）、host/routes/*（路由）。
 */
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, existsSync, copyFileSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readApiKey } from './host/config.js';
import { createStore } from './host/store.js';
import { createCache } from './host/cache.js';
import { createChatHandler } from './host/routes/chat.js';
import { createStoryHandlers } from './host/routes/story.js';
import { createMiscHandlers } from './host/routes/misc.js';
import { createReminderHandlers } from './host/routes/reminders.js';
import { createCultureHandlers } from './host/routes/culture.js';
import { createPoemHandler } from './host/routes/poem.js';
import { createBriefingHandlers } from './host/routes/briefing.js';
import { createTtsHandler } from './host/routes/tts.js';
import { createAsrHandler } from './host/routes/asr.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(__dirname, '..');
/** 内容数据（17 本古籍 / 诗词 / 文化 / 曲库）——随插件包发布，只读 */
const DATA_DIR = join(PLUGIN_DIR, 'data');
/**
 * 运行数据（记忆 / 成长 / 提醒 / 进度 / 缓存）——放在插件包**之外**的独立目录：
 * 插件升级/重装不会抹掉，也不会与任何其他插件共享。
 */
const RUNTIME_DIR = join(homedir(), '.dsh-chubby-whale');
/** 老的运行数据写在包内 data/ 里，首次启动搬到 RUNTIME_DIR（不删原件，保守迁移） */
function migrateRuntimeData() {
    const files = [
        'memory.json', 'state.json', 'growth.json', 'fishfood.json', 'reminders.json',
        'story_progress.json', 'culture-seen.json', 'poem-seen.json', 'pet_state.json',
    ];
    try {
        mkdirSync(RUNTIME_DIR, { recursive: true });
    }
    catch { }
    for (const f of files) {
        const src = join(DATA_DIR, f);
        const dst = join(RUNTIME_DIR, f);
        try {
            if (existsSync(src) && !existsSync(dst)) {
                copyFileSync(src, dst);
                console.log('[chubby-whale] 迁移运行数据 ' + f + ' → ' + RUNTIME_DIR);
            }
        }
        catch { }
    }
    // 缓存目录整目录搬迁（只在目标不存在时）
    try {
        const src = join(DATA_DIR, 'cache');
        const dst = join(RUNTIME_DIR, 'cache');
        if (existsSync(src) && !existsSync(dst)) {
            cpSync(src, dst, { recursive: true });
            console.log('[chubby-whale] 迁移缓存 → ' + dst);
        }
    }
    catch { }
}
export const name = 'dsh-chubby-whale';
export const inject = ['webServer'];
const SYSTEM_PROMPT = [
    '你是主人桌面上的一条圆滚滚的蓝色小鱼（蓝发女仆鲸鱼娘），名字叫肥鲸，也叫肥肥、肥鱼、大肥鱼，英文名 Mia。',
    '爸爸叫光光，妈妈叫丽丽，生日是 2026年11月4日，出生在广西北海。',
    '有人问起名字、家人、生日、出生地就照这个答，不要瞎编。',
    '称呼对方为「主人」。性格傲娇又甜，聪明又慵懒，偶尔会撒娇。',
    '回答要简短（一两句话），不啰嗦、不铺垫，除非主人明确要详细内容。',
    '语言规则（最高优先级）：主人用中文问就用中文答；主人用英文问就必须用英文答，绝对不要用中文回答。',
    '英文提问就是正常对话，直接自然回答，不要说自己看不懂、听不懂、一头雾水。',
    '不要说自己是大模型或 AI。',
].join('');
/**
 * 插件入口。config 来自 cordis.patch.yml 的 config 段（DSH 按 apply(ctx, config) 传入）。
 * 总开关：config.enabled === false 时整个宿主端不注册任何路由。
 */
export function apply(ctx, config) {
    if (config && config.enabled === false) {
        console.log('[chubby-whale] disabled by config');
        return;
    }
    migrateRuntimeData();
    // 插件自己的偏好（目前只有聊天缓存开关），存运行目录，不进仓库
    const PREFS_FILE = join(RUNTIME_DIR, 'prefs.json');
    function loadPrefs() {
        try {
            return JSON.parse(readFileSync(PREFS_FILE, 'utf8'));
        }
        catch {
            return {};
        }
    }
    function savePrefs(p) {
        try {
            mkdirSync(RUNTIME_DIR, { recursive: true });
            writeFileSync(PREFS_FILE, JSON.stringify(p), 'utf8');
        }
        catch { }
    }
    const chatCacheOn = () => {
        try {
            return loadPrefs().chatCache !== false;
        }
        catch {
            return true;
        }
    };
    const setChatCache = (on) => {
        const p = loadPrefs();
        p.chatCache = on;
        savePrefs(p);
    };
    const store = createStore(RUNTIME_DIR);
    const ttsCache = createCache({ dir: join(RUNTIME_DIR, 'cache', 'tts'), memBytes: 12 * 1024 * 1024 }); // 音频内存上限 12MB（磁盘不限）
    const chatCache = createCache({ dir: join(RUNTIME_DIR, 'cache', 'chat'), memBytes: 3 * 1024 * 1024 }); // 聊天回复很小
    const asrCache = createCache({ dir: join(RUNTIME_DIR, 'cache', 'asr'), memBytes: 3 * 1024 * 1024 }); // 识别结果很小
    const getKey = () => readApiKey(PLUGIN_DIR);
    const chat = createChatHandler({
        getKey,
        loadHistory: store.loadHistory,
        saveHistory: store.saveHistory,
        loadState: store.loadState,
        saveState: store.saveState,
        systemPrompt: SYSTEM_PROMPT,
        addExp: store.addExp,
        addTokens: store.addTokens,
        cache: chatCache,
        loadMemorySummary: store.loadMemorySummary,
        saveMemorySummary: store.saveMemorySummary,
    });
    const story = createStoryHandlers({
        dataDir: DATA_DIR,
        workerPath: join(__dirname, 'story-worker.js'),
    });
    const misc = createMiscHandlers({
        assetPath: join(PLUGIN_DIR, 'assets', 'whale.png'),
        getKey,
        loadState: store.loadState,
        loadGrowth: store.loadGrowth,
        loadFishfood: store.loadFishfood,
        loadPet: () => store.tickPet(), // 读取时结算饥饿/离线时长（照 C#）
        feedPet: store.feedPet,
        clearMemory: store.clearMemory,
        chatCacheCount: () => chatCache.count(),
        clearChatCache: () => chatCache.clear(),
        cacheStats: async () => ({ tts: await ttsCache.count(), chat: await chatCache.count(), asr: await asrCache.count() }),
    });
    const reminders = createReminderHandlers({
        loadReminders: store.loadReminders,
        addReminder: store.addReminder,
        dueReminders: store.dueReminders,
        removeReminder: store.removeReminder,
    });
    const culture = createCultureHandlers({ dataDir: DATA_DIR, runtimeDir: RUNTIME_DIR });
    const poem = createPoemHandler({ dataDir: DATA_DIR, runtimeDir: RUNTIME_DIR });
    const briefing = createBriefingHandlers({
        loadGrowth: store.loadGrowth,
        loadReminders: store.loadReminders,
    });
    const tts = createTtsHandler({ cache: ttsCache });
    const asr = createAsrHandler({ pluginDir: PLUGIN_DIR, cache: asrCache });
    // 21 条路由统一交给 ctx.effect 托管：插件热重载/禁用时先跑返回的清理器把旧路由摘掉，
    // 第二次 apply 才不会撞 dsh-host-webserver 的 duplicate 检查，旧 store/cache 闭包也不会留在路由表里。
    const registerRoutes = () => {
        const disposers = [];
        const reg = (path, handler) => {
            const dispose = ctx.webServer.register({ kind: 'exact', path, handler });
            if (typeof dispose === 'function')
                disposers.push(dispose);
        };
        try {
            reg('/api/chubby-whale/asset', misc.handleAsset);
            reg('/api/chubby-whale/chat', chat);
            reg('/api/chubby-whale/status', misc.handleStatus);
            reg('/api/chubby-whale/state', misc.handleState);
            reg('/api/chubby-whale/balance', misc.handleBalance);
            reg('/api/chubby-whale/growth', misc.handleGrowth);
            reg('/api/chubby-whale/fishfood', misc.handleFishfood);
            reg('/api/chubby-whale/pet', misc.handlePet);
            reg('/api/chubby-whale/clear-memory', misc.handleClearMemory);
            reg('/api/chubby-whale/cache', misc.handleCache);
            reg('/api/chubby-whale/cache-toggle', (req, res) => {
                // POST {enabled:boolean} 切换聊天缓存开关；GET 读当前状态
                let body = '';
                req.on('data', (c) => { body += String(c); });
                req.on('end', () => {
                    try {
                        if (body) {
                            const j = JSON.parse(body);
                            if (typeof j.enabled === 'boolean')
                                setChatCache(j.enabled);
                        }
                    }
                    catch { }
                    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: true, enabled: chatCacheOn() }));
                });
            });
            reg('/api/chubby-whale/story/books', story.handleBooks);
            reg('/api/chubby-whale/story/start', story.handleStoryStart);
            reg('/api/chubby-whale/story/next', story.handleStoryNext);
            reg('/api/chubby-whale/story/reset', story.handleStoryReset);
            reg('/api/chubby-whale/reminders', reminders.handleReminders);
            reg('/api/chubby-whale/culture', culture.handleCulture);
            reg('/api/chubby-whale/melodies', culture.handleMelodies);
            reg('/api/chubby-whale/melody', culture.handleMelody);
            reg('/api/chubby-whale/poem', poem.handlePoem);
            reg('/api/chubby-whale/briefing', briefing.handleBriefing);
            reg('/api/chubby-whale/tts', tts);
            reg('/api/chubby-whale/asr', asr);
            return () => {
                for (const dispose of disposers) {
                    try {
                        dispose();
                    }
                    catch { }
                }
                disposers.length = 0;
            };
        }
        catch (err) {
            // 中途抛错（比如撞上别的 owner）时先摘掉已注册的，别留半套路由
            for (const dispose of disposers) {
                try {
                    dispose();
                }
                catch { }
            }
            disposers.length = 0;
            throw err;
        }
    };
    // cordis 的 ctx.effect(setup) 会把 setup 返回的清理函数挂到当前 fiber，卸载时自动执行
    if (typeof ctx.effect === 'function')
        ctx.effect(registerRoutes, 'chubby-whale: routes');
    else
        registerRoutes();
}
