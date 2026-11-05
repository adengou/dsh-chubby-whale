/**
 * dsh-chubby-whale —— Host 端入口（模块化组装）
 * 编译输出 dist/index.js（插件加载入口）。
 *
 * 本文件只做四件事：
 *   ① 路径与运行目录（DATA_DIR / RUNTIME_DIR）② 依赖装配（store/cache/prefs/key）
 *   ③ 构造各能力 handler ④ 按路由表交给 ctx.effect 托管
 * 业务在 host/ 下按职责拆分：routes/*（HTTP）、repos/*（持久化）、story/*（说书）、
 * chat-core.ts（聊天纯函数）、prefs.ts（偏好）、atomic/body/respond/http（小工具）。
 */
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, existsSync, copyFileSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readApiKey, readSiliconFlowKey, readDataSource } from './host/config.js';
import { createStore } from './host/store.js';
import { createCache } from './host/cache.js';
import { createPrefs, createCacheToggleHandler } from './host/prefs.js';
import { createChatHandler } from './host/routes/chat.js';
import { createChatStreamHandler } from './host/routes/chat-stream.js';
import { createStoryHandlers } from './host/routes/story.js';
import { createStoryRepo } from './host/story/repo.js';
import { createStoryPlayer } from './host/story/player.js';
import { createLocalDataPort } from './host/data/local.js';
import { createCloudDataPort, CLOUD_DATA_BASE } from './host/data/cloud.js';
import { createStorySource } from './host/data/story-source.js';
import { createMiscHandlers } from './host/routes/misc.js';
import { createReminderHandlers } from './host/routes/reminders.js';
import { createCultureHandlers } from './host/routes/culture.js';
import { createPoemHandler } from './host/routes/poem.js';
import { createBriefingHandlers } from './host/routes/briefing.js';
import { createTtsHandler } from './host/routes/tts.js';
import { createAsrHandler } from './host/routes/asr.js';
import { createRouteTable } from './host/routes.js';
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
    // 偏好（目前只有聊天缓存开关）：独立模块 + 路由工厂
    const prefs = createPrefs(RUNTIME_DIR);
    const cacheToggle = createCacheToggleHandler(prefs);
    const store = createStore(RUNTIME_DIR);
    const ttsCache = createCache({ dir: join(RUNTIME_DIR, 'cache', 'tts'), memBytes: 12 * 1024 * 1024 }); // 音频内存上限 12MB（磁盘不限）
    const chatCache = createCache({ dir: join(RUNTIME_DIR, 'cache', 'chat'), memBytes: 3 * 1024 * 1024 }); // 聊天回复很小
    const asrCache = createCache({ dir: join(RUNTIME_DIR, 'cache', 'asr'), memBytes: 3 * 1024 * 1024 }); // 识别结果很小
    const getKey = () => readApiKey(PLUGIN_DIR);
    /**
     * 内容数据源：默认本地 data/；config.json / cordis config / 环境变量要求云端时才走云端。
     * 云端实现持有本地实现作为失败回退，构造时不发任何网络请求（首次用到才拉）。
     */
    const dataSource = readDataSource(PLUGIN_DIR, config);
    const localData = createLocalDataPort({
        dataDir: DATA_DIR,
        story: createStoryRepo({ dataDir: DATA_DIR, workerPath: join(__dirname, 'story-worker.js') }),
    });
    const dataPort = dataSource === 'cloud' ? createCloudDataPort({ local: localData }) : localData;
    if (dataSource === 'cloud') {
        console.log('[chubby-whale] dataSource=cloud base=' + CLOUD_DATA_BASE + '（网络失败自动回退本地）');
    }
    const chat = createChatHandler({
        getKey,
        loadHistory: store.loadHistory,
        appendTurns: store.appendTurns,
        loadState: store.loadState,
        saveState: store.saveState,
        systemPrompt: SYSTEM_PROMPT,
        addExp: store.addExp,
        addTokens: store.addTokens,
        cache: chatCache,
        loadMemorySummary: store.loadMemorySummary,
        saveMemorySummary: store.saveMemorySummary,
        cacheEnabled: prefs.chatCacheEnabled,
    });
    const chatStream = createChatStreamHandler({
        getKey,
        loadHistory: store.loadHistory,
        appendTurns: store.appendTurns,
        systemPrompt: SYSTEM_PROMPT,
        addTokens: store.addTokens,
        cache: chatCache,
        loadMemorySummary: store.loadMemorySummary,
        cacheEnabled: prefs.chatCacheEnabled,
    });
    const story = createStoryHandlers({
        player: createStoryPlayer({
            // 说书播放器只认 listBooks/loadBook；数据源（本地/云端）由 DataPort 投影进来
            repo: createStorySource(dataPort),
            progressFile: join(RUNTIME_DIR, 'story_progress.json'),
        }),
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
    const culture = createCultureHandlers({ dataDir: DATA_DIR, runtimeDir: RUNTIME_DIR, dataPort });
    const poem = createPoemHandler({ runtimeDir: RUNTIME_DIR, dataDir: DATA_DIR, dataPort });
    const briefing = createBriefingHandlers({
        loadGrowth: store.loadGrowth,
        loadReminders: store.loadReminders,
    });
    const tts = createTtsHandler({ cache: ttsCache });
    const asr = createAsrHandler({ getKey: () => readSiliconFlowKey(PLUGIN_DIR), cache: asrCache });
    // 路径 → handler 的映射集中在 host/routes.ts，入口不再逐条写 reg(...)
    const routeTable = createRouteTable({
        misc, chat, chatStream, cacheToggle, story, reminders, culture, poem, briefing, tts, asr,
    });
    // 所有路由统一交给 ctx.effect 托管：插件热重载/禁用时先跑返回的清理器把旧路由摘掉，
    // 第二次 apply 才不会撞 dsh-host-webserver 的 duplicate 检查，旧 store/cache 闭包也不会留在路由表里。
    const registerRoutes = () => {
        const disposers = [];
        try {
            for (const route of routeTable) {
                const dispose = ctx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler });
                if (typeof dispose === 'function')
                    disposers.push(dispose);
            }
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
