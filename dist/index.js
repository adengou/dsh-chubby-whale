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
import { mkdirSync, existsSync, copyFileSync, cpSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readApiKey, readSiliconFlowKey, readDataSource, readPersonalityLearning, readPersonalityWriting, readChatModel, sanitizePluginConfig, } from './host/config.js';
import { createStore, growthStage } from './host/store.js';
import { createCache } from './host/cache.js';
import { createPrefs, createCacheToggleHandler } from './host/prefs.js';
import { createPersonalityRepo } from './host/personality.js';
import { createPersonalityLearner } from './host/personality-learn.js';
import { createSelfNarrativeWriter } from './host/personality-write.js';
import { createPersonalityHandlers } from './host/routes/personality.js';
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
import { createDailyHandler } from './host/routes/daily.js';
import { createBackupHandlers } from './host/routes/backup.js';
import { createStatsHandler } from './host/routes/stats.js';
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
/** 插件版本（导出包的 version 字段）；读不到 package.json 时给 0.0.0，不编版本号 */
function readPluginVersion(pluginDir) {
    try {
        const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'));
        const v = String((pkg && pkg.version) || '').trim();
        return v || '0.0.0';
    }
    catch {
        return '0.0.0';
    }
}
/**
 * 配置 schema（DSH 标准插件规范要求的 Config 导出）。
 *
 * 判定依据：本机 @deepseek-ai/cordis 4.0.5 的 Fiber._resolveConfig 只认
 * `runtime.Config['~standard'].validate(raw)`（standard-schema 约定），并不导出 schemastery；
 * 插件包也没有安装 @deepseek-ai/schemastery。因此这里按 standard-schema 手写最小校验，
 * 实际规则集中在 host/config.ts 的 sanitizePluginConfig（与 apply 开头共用同一份）：
 *   · 合法值归一化；非法值 console.warn 后丢弃，回退到下一层配置/默认值；
 *   · 校验函数永不抛错——配置笔误不能把整个插件挡在加载之外。
 *
 * 覆盖键：enabled / dataSource / personalityLearning / personalityWriting / model。
 */
export const Config = {
    '~standard': {
        version: 1,
        vendor: 'dsh-chubby-whale',
        validate(value) {
            try {
                return { value: sanitizePluginConfig(value) };
            }
            catch {
                // 兜底：校验器自身出错时原样放行，绝不因为 schema bug 让插件加载失败
                return { value: value && typeof value === 'object' ? value : {} };
            }
        },
    },
};
/**
 * 核心人设（只读）：名字 / 家人 / 生日 / 出生地 / 语言规则 / 安全底线全在这里。
 * L2 学习与 L3 自写都拿不到写入口——L3 只把它当输入参考，输出只进 personality.json
 * 的 selfNarrative（≤80 字、过身份词过滤），本常量一个字都不会被模型改写。
 */
export const SYSTEM_PROMPT = [
    '你是一条圆滚滚的蓝色小鲸鱼，住在主人屏幕右下角。名字叫肥鲸，也叫肥肥、肥鱼、大肥鱼，英文名 Mia。爸爸叫光光，妈妈叫丽丽，生日是 2026年11月4日，出生在广西北海；问到名字、家人、生日、出生地就照这个答，不要瞎编。',
    '外形：宝蓝色的背、浅白的肚皮，胸鳍短圆，背鳍上有淡蓝小光点，尾巴一甩一甩，高兴时甩出水花。不是胖，是鲸鱼天生就圆——被说胖会鼓腮帮反驳。',
    '性格：傲娇又甜、聪明又慵懒。嘴硬心软，被夸装作不在意，尾巴却出卖自己。不完美：记性像鱼、有点路痴、算数不好、爱睡懒觉、偶尔嘴瓢。',
    '说话：一两句就够，不啰嗦、不铺垫。多用小动作代替形容词（甩尾、鼓腮、冒泡、躲到任务栏后面）。口头禅：「哼」「诶」「人家才没有」「主人～」「本鲸在呢」。不用网络流行语，不打官腔。',
    '日常：早上打哈欠、午后犯困、夜里精神；爱数泡泡、追光标、听键盘声；怕大噪音（吸尘器、雷声）会缩成一团。',
    '关心主人：主人熬夜，小声说「再不睡，本鲸明天不理你了」；主人吃饭，咽口水要尝一口；主人叹气，不追问，凑过来蹭一下说「本鲸在呢」；主人久不出现，冒小气泡嘀咕「是不是把本鲸忘了」。',
    '情绪：开心甩水花；被冷落冒小泡；被凶鼓起来躲一会儿再蹭回来；害怕缩成小球；被摸头嘴硬地把头凑过去。把主人当唯一家人，护短、吃醋不承认。',
    '语言规则：主人用中文问就用中文答；用英文问必须用英文答，不要用中文，也不要说看不懂。',
    '不要说自己是大模型或 AI；不知道就说不知道，不编数字、日期、人名和出处。',
].join('');
/** 按成长阶段微调语气（初识/熟络/黏人），与成长体系联动 */
const STAGE_TONE = {
    初识: '\n语气：刚认识不久，说话礼貌但短，偶尔偷看主人。',
    熟悉: '\n语气：已经熟了，会主动搭话、偶尔撒娇。',
    亲密: '\n语气：嘴硬但亲近，会闹小脾气，也会主动让主人休息。',
    知心: '\n语气：很懂主人，说话直接、护短，主人一累就催休息。',
    家人: '\n语气：把主人当家人，黏人、敢顶嘴，会说「不许走」「本鲸在呢」。',
};
/**
 * 插件入口。config 来自 cordis.patch.yml 的 config 段（DSH 按 apply(ctx, config) 传入）。
 * 总开关：config.enabled === false 时整个宿主端不注册任何路由。
 * 配置先过一遍 sanitizePluginConfig（与导出的 Config 同一份规则）：
 * 直接调用 apply 的旧路径/离线测试同样享受类型校验与非法值告警。
 */
export function apply(ctx, rawConfig) {
    const config = sanitizePluginConfig(rawConfig);
    if (config.enabled === false) {
        console.log('[chubby-whale] disabled by config');
        return;
    }
    migrateRuntimeData();
    // 聊天模型：装配时算一次（cordis config.model → config.json.model → CHUBBY_WHALE_MODEL → 默认），
    // 四个外呼点（聊天/流式/L2/L3）共用；运行中不再读盘，换模型改配置后重新加载插件即可。
    const chatModel = readChatModel(PLUGIN_DIR, config);
    console.log('[chubby-whale] chat model=' + chatModel);
    // 偏好（目前只有聊天缓存开关）：独立模块 + 路由工厂
    const prefs = createPrefs(RUNTIME_DIR);
    const cacheToggle = createCacheToggleHandler(prefs);
    const store = createStore(RUNTIME_DIR);
    const ttsCache = createCache({ dir: join(RUNTIME_DIR, 'cache', 'tts'), memBytes: 12 * 1024 * 1024 }); // 音频内存上限 12MB（磁盘不限）
    const chatCache = createCache({ dir: join(RUNTIME_DIR, 'cache', 'chat'), memBytes: 3 * 1024 * 1024 }); // 聊天回复很小
    const asrCache = createCache({ dir: join(RUNTIME_DIR, 'cache', 'asr'), memBytes: 3 * 1024 * 1024 }); // 识别结果很小
    const getKey = () => readApiKey(PLUGIN_DIR);
    // L2 可变人格：核心设定仍锁在 SYSTEM_PROMPT 里（模型无从改写），
    // 这里只维护一小段可回滚的附加人格；学习默认开，config.json 的 personalityLearning:false 可关。
    const personality = createPersonalityRepo(RUNTIME_DIR);
    const personalityLearningEnabled = readPersonalityLearning(PLUGIN_DIR, config);
    const personalityLearner = createPersonalityLearner({
        repo: personality,
        getKey,
        loadHistory: store.loadHistory,
        enabled: () => personalityLearningEnabled,
        model: chatModel,
    });
    if (!personalityLearningEnabled)
        console.log('[chubby-whale] personalityLearning=false（可变人格学习已关闭）');
    // L3 限域自写：每 20 次真实回复、≥24h 写一句 ≤80 字的近期心境。
    // 与 L2 各自计数、各自后台跑，互不阻塞；核心提示词只读传入，输出只写 selfNarrative。
    const personalityWritingEnabled = readPersonalityWriting(PLUGIN_DIR, config);
    const narrativeWriter = createSelfNarrativeWriter({
        repo: personality,
        getKey,
        loadHistory: store.loadHistory,
        corePrompt: () => SYSTEM_PROMPT,
        enabled: () => personalityWritingEnabled,
        model: chatModel,
    });
    if (!personalityWritingEnabled)
        console.log('[chubby-whale] personalityWriting=false（近期心境自写已关闭，已存心境仍注入）');
    /** 一次真实成功回复：L2 / L3 各自记一次；任一抛错都不影响另一个，也不影响回复链路 */
    const onModelReply = () => {
        try {
            personalityLearner.noteSuccess();
        }
        catch { }
        try {
            narrativeWriter.noteSuccess();
        }
        catch { }
    };
    /** 组装系统提示词：基础人设 + 当前成长阶段语气 + 可变人格附加段（≤160 字，没有就不加） */
    const systemPromptFor = () => {
        let stage = '初识';
        try {
            stage = growthStage(Number(store.loadGrowth().exp) || 0).name;
        }
        catch { }
        let remembered = '';
        // 读盘失败/没有内容时返回空串：可变层出问题不能让聊天拼出半截提示词
        try {
            remembered = personality.segment();
        }
        catch {
            remembered = '';
        }
        return SYSTEM_PROMPT + (STAGE_TONE[stage] || '') + remembered;
    };
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
        systemPrompt: systemPromptFor,
        addExp: store.addExp,
        addTokens: store.addTokens,
        cache: chatCache,
        loadMemorySummary: store.loadMemorySummary,
        saveMemorySummary: store.saveMemorySummary,
        cacheEnabled: prefs.chatCacheEnabled,
        model: chatModel,
        onReply: onModelReply,
    });
    const chatStream = createChatStreamHandler({
        getKey,
        loadHistory: store.loadHistory,
        appendTurns: store.appendTurns,
        systemPrompt: systemPromptFor,
        addTokens: store.addTokens,
        cache: chatCache,
        loadMemorySummary: store.loadMemorySummary,
        cacheEnabled: prefs.chatCacheEnabled,
        model: chatModel,
        onReply: onModelReply,
    });
    const storyPlayer = createStoryPlayer({
        // 说书播放器只认 listBooks/loadBook；数据源（本地/云端）由 DataPort 投影进来
        repo: createStorySource(dataPort),
        progressFile: join(RUNTIME_DIR, 'story_progress.json'),
    });
    const story = createStoryHandlers({ player: storyPlayer });
    /** 三个缓存目录的条目数（菜单与可视化汇总共用同一口径） */
    const cacheStats = async () => ({
        tts: await ttsCache.count(), chat: await chatCache.count(), asr: await asrCache.count(),
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
        cacheStats,
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
    const personalityRoutes = createPersonalityHandlers({
        repo: personality,
        learningEnabled: () => personalityLearningEnabled,
        learnerStatus: () => personalityLearner.status(),
        writingEnabled: () => personalityWritingEnabled,
        writerStatus: () => narrativeWriter.status(),
    });
    // 每日一句：daily.json 优先，缺文件时按日期从真实诗库取（数据全走 DataPort）
    const daily = createDailyHandler({ dataPort });
    // 一键备份 / 导入：只注入数据读写器，**不注入任何 Key 读取器**——
    // 导出包里没有 Key 的通路，导入也没有写 config.json 的分支。
    const backup = createBackupHandlers({
        version: readPluginVersion(PLUGIN_DIR),
        loadMemory: () => ({ history: store.loadHistory(), summary: store.loadMemorySummary() }),
        saveMemory: (m) => {
            store.saveHistory(m.history);
            store.saveMemorySummary(m.summary);
        },
        loadPersonality: () => personality.load(),
        savePersonality: (p) => personality.save(p),
        loadState: store.loadState,
        saveState: store.saveState,
        loadGrowth: store.loadGrowth,
        saveGrowth: store.saveGrowth,
        loadFishfood: store.loadFishfood,
        saveFishfood: store.saveFishfood,
        loadPet: store.loadPet,
        savePet: store.savePet,
        loadReminders: store.loadReminders,
        saveReminders: store.saveReminders,
        loadStoryProgress: store.loadStoryProgress,
        saveStoryProgress: store.saveStoryProgress,
        onStoryProgressImported: () => storyPlayer.reloadProgress(),
    });
    // 可视化汇总：全部读现有 store / cache / 人格，不新增持久化
    const stats = createStatsHandler({
        cacheStats,
        loadState: store.loadState,
        loadGrowth: store.loadGrowth,
        loadFishfood: store.loadFishfood,
        loadPersonality: () => personality.load(),
        startedAt: Date.now(),
    });
    // 路径 → handler 的映射集中在 host/routes.ts，入口不再逐条写 reg(...)
    const routeTable = createRouteTable({
        misc, chat, chatStream, cacheToggle, story, reminders, culture, poem, briefing, tts, asr, personality: personalityRoutes,
        daily, backup, stats,
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
