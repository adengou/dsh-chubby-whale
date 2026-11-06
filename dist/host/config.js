/**
 * host/config.ts —— 本插件自己的配置与 Key（与任何其他插件/宿主数据互相独立）
 *
 * Key 来源（只认本插件）：
 *   1) 本插件 config.json 的对应字段（推荐）
 *   2) 本插件专属环境变量：CHUBBY_WHALE_DEEPSEEK_KEY / CHUBBY_WHALE_SILICONFLOW_KEY
 *   3) 兼容回退：DEEPSEEK_API_KEY / SILICONFLOW_API_KEY（通用名，仅兜底）
 *
 * 刻意**不读** ~/.dsh/.credentials.yaml：那是 DSH 与其他插件共用的凭据库，
 * 读了就与其他插件耦合，别人换 Key 也会牵连本插件。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
function readConfigJson(pluginDir) {
    try {
        return JSON.parse(String(readFileSync(join(pluginDir, 'config.json'), 'utf8')).replace(/^\uFEFF/, ''));
    }
    catch {
        return null;
    }
}
function fromEnv(own, legacy) {
    try {
        const v = process.env[own];
        if (v && v.trim())
            return v.trim();
    }
    catch { }
    try {
        const v = process.env[legacy];
        if (v && v.trim())
            return v.trim();
    }
    catch { }
    return '';
}
/** DeepSeek Key（聊天 / 文档总结 / 对联） */
export function readApiKey(pluginDir) {
    const cfg = readConfigJson(pluginDir);
    if (cfg && typeof cfg.deepseekKey === 'string' && cfg.deepseekKey.trim())
        return cfg.deepseekKey.trim();
    return fromEnv('CHUBBY_WHALE_DEEPSEEK_KEY', 'DEEPSEEK_API_KEY');
}
/** 硅基流动 Key（语音识别） */
export function readSiliconFlowKey(pluginDir) {
    const cfg = readConfigJson(pluginDir);
    if (cfg && typeof cfg.siliconflowKey === 'string' && cfg.siliconflowKey.trim())
        return cfg.siliconflowKey.trim();
    return fromEnv('CHUBBY_WHALE_SILICONFLOW_KEY', 'SILICONFLOW_API_KEY');
}
/**
 * 语音识别语言（硅基流动 Qwen3-ASR 的 language 参数）：默认 zh。
 * 为什么默认 zh：不传该参数时模型自动检测，短句/带噪声的音频常被识别成英文（"No, no"），
 * 主人的语音几乎都是中文，显式指定能显著减少误识别。
 * config.json 可改：asrLanguage（zh / en / auto）
 */
export function readAsrLanguage(pluginDir) {
    const cfg = readConfigJson(pluginDir);
    const v = cfg && typeof cfg.asrLanguage === 'string' ? cfg.asrLanguage.trim().toLowerCase() : '';
    if (v === 'en' || v === 'auto')
        return v;
    return 'zh';
}
/** Key 就绪情况（给 /status 与启动日志用） */
export function keyStatus(pluginDir) {
    return {
        deepseek: Boolean(readApiKey(pluginDir)),
        siliconflow: Boolean(readSiliconFlowKey(pluginDir)),
    };
}
const warnedSources = new Set();
/** 接受 'local' | 'cloud'（大小写/空白不敏感）；未配置返回 null，非法值告警后按 local */
function parseDataSource(raw, from) {
    if (raw == null || String(raw).trim() === '')
        return null;
    const s = String(raw).trim().toLowerCase();
    if (s === 'local' || s === 'cloud')
        return s;
    const msg = '[chubby-whale] 无效的数据源配置（' + from + '=' + String(raw) + '），按 local 处理';
    if (!warnedSources.has(msg)) {
        warnedSources.add(msg);
        console.warn(msg);
    }
    return 'local';
}
/**
 * 数据源：默认 local（读插件包内 data/）。
 * 优先级：cordis config.dataSource → 本插件 config.json 的 dataSource → 环境变量 CHUBBY_WHALE_DATA_SOURCE → local。
 * 只认 'local' / 'cloud'，其它值告警并回退 local（绝不因为配置笔误把内容功能弄挂）。
 */
export function readDataSource(pluginDir, runtimeConfig) {
    const fromRuntime = parseDataSource(runtimeConfig && runtimeConfig.dataSource, 'cordis config');
    if (fromRuntime)
        return fromRuntime;
    const cfg = readConfigJson(pluginDir);
    const fromFile = parseDataSource(cfg && cfg.dataSource, 'config.json');
    if (fromFile)
        return fromFile;
    const fromEnv = parseDataSource(process.env.CHUBBY_WHALE_DATA_SOURCE, 'CHUBBY_WHALE_DATA_SOURCE');
    if (fromEnv)
        return fromEnv;
    return 'local';
}
/**
 * 布尔开关解析：只认明确的布尔值或 true/false/on/off/1/0/yes/no（大小写、空白不敏感）。
 * 认不出的值返回 null（按“未配置”处理，继续看下一层），绝不因配置笔误把功能弄成意外状态。
 */
export function parseSwitchValue(raw) {
    if (raw === undefined || raw === null || raw === '')
        return null;
    if (typeof raw === 'boolean')
        return raw;
    const s = String(raw).trim().toLowerCase();
    if (s === 'false' || s === 'off' || s === '0' || s === 'no' || s === 'disabled')
        return false;
    if (s === 'true' || s === 'on' || s === '1' || s === 'yes' || s === 'enabled')
        return true;
    return null;
}
/**
 * 开关读取顺序：cordis config → 本插件 config.json → （调用方默认值）。
 * 返回 null 表示两层都没配置。
 */
function readSwitch(pluginDir, runtimeConfig, key) {
    const fromRuntime = parseSwitchValue(runtimeConfig && runtimeConfig[key]);
    if (fromRuntime !== null)
        return fromRuntime;
    const cfg = readConfigJson(pluginDir);
    return parseSwitchValue(cfg && cfg[key]);
}
/**
 * L2 可变人格学习开关：默认开启。
 * 优先级：cordis config.personalityLearning → 本插件 config.json 的 personalityLearning → true。
 */
export function readPersonalityLearning(pluginDir, runtimeConfig) {
    const value = readSwitch(pluginDir, runtimeConfig, 'personalityLearning');
    return value === null ? true : value;
}
/**
 * L3 近期心境自写开关：默认开启。
 * 优先级：cordis config.personalityWriting → 本插件 config.json 的 personalityWriting → true。
 * 与 personalityLearning 分开：关掉 L2 学习不影响心境生成，关掉自写也不影响已存心境的注入。
 */
export function readPersonalityWriting(pluginDir, runtimeConfig) {
    const value = readSwitch(pluginDir, runtimeConfig, 'personalityWriting');
    return value === null ? true : value;
}
/**
 * 默认聊天模型：只在三层配置都没给时使用。
 * 模型名不写死在各个外呼点——官方目录改名、接入新模型时改配置即可，不用动代码。
 */
export const DEFAULT_CHAT_MODEL = 'deepseek-flash';
/** 模型名合法字符（与 DeepSeek 目录里的 id 一致）：防止配置里粘进整段文本被原样发给接口 */
const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/;
const warnedModels = new Set();
/** 解析模型名：非法值告警后返回 null（调用方继续看下一层/默认值） */
export function parseChatModel(raw, from) {
    if (raw == null)
        return null;
    const s = String(raw).trim();
    if (!s)
        return null;
    if (MODEL_NAME_RE.test(s))
        return s;
    const msg = '[chubby-whale] 无效的模型配置（' + from + '=' + s.slice(0, 80) + '），已忽略';
    if (!warnedModels.has(msg)) {
        warnedModels.add(msg);
        console.warn(msg);
    }
    return null;
}
/**
 * 聊天模型（聊天 / 流式 / L2 学习 / L3 自写四个外呼点共用）：
 *   cordis config.model → 本插件 config.json 的 model → 环境变量 CHUBBY_WHALE_MODEL → deepseek-flash。
 * 由 index.ts 在装配时算一次注入各 handler，运行中不再读盘。
 */
export function readChatModel(pluginDir, runtimeConfig) {
    const fromRuntime = parseChatModel(runtimeConfig && runtimeConfig.model, 'cordis config');
    if (fromRuntime)
        return fromRuntime;
    const cfg = readConfigJson(pluginDir);
    const fromFile = parseChatModel(cfg && cfg.model, 'config.json');
    if (fromFile)
        return fromFile;
    const fromEnv = parseChatModel(process.env.CHUBBY_WHALE_MODEL, 'CHUBBY_WHALE_MODEL');
    if (fromEnv)
        return fromEnv;
    return DEFAULT_CHAT_MODEL;
}
/** 本插件认识的配置键（未知键只告警、不丢弃，给以后的版本留余地） */
const KNOWN_CONFIG_KEYS = new Set(['enabled', 'dataSource', 'personalityLearning', 'personalityWriting', 'model']);
const warnedConfig = new Set();
function warnConfig(msg) {
    if (warnedConfig.has(msg))
        return;
    warnedConfig.add(msg);
    console.warn('[chubby-whale] ' + msg);
}
const shortValue = (raw) => {
    try {
        return JSON.stringify(raw).slice(0, 60);
    }
    catch {
        return String(raw).slice(0, 60);
    }
};
/**
 * 配置清洗（cordis Config schema 与 apply 共用同一份规则）：
 *   · 合法值归一化（dataSource 小写、开关转布尔、model 去空白）；
 *   · 非法值丢弃并 console.warn，绝不抛错——配置笔误不能把插件挡在加载之外；
 *   · 未知键保留但告警，不做静默吞掉。
 * 返回值可直接当作 apply 的 config 使用。
 */
export function sanitizePluginConfig(raw) {
    if (raw == null)
        return {};
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        warnConfig('配置应为对象，已按空配置处理（实际 ' + shortValue(raw) + '）');
        return {};
    }
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
        if (key === 'enabled') {
            if (typeof value === 'boolean')
                out.enabled = value;
            else
                warnConfig('config.enabled 应为布尔值（实际 ' + shortValue(value) + '），已忽略');
            continue;
        }
        if (key === 'dataSource') {
            const s = String(value == null ? '' : value).trim().toLowerCase();
            if (s === 'local' || s === 'cloud')
                out.dataSource = s;
            else
                warnConfig('config.dataSource 只认 local / cloud（实际 ' + shortValue(value) + '），已忽略');
            continue;
        }
        if (key === 'personalityLearning' || key === 'personalityWriting') {
            const b = parseSwitchValue(value);
            if (b === null)
                warnConfig('config.' + key + ' 应为布尔值（实际 ' + shortValue(value) + '），已忽略');
            else
                out[key] = b;
            continue;
        }
        if (key === 'model') {
            const m = parseChatModel(value, 'cordis config');
            if (m)
                out.model = m;
            continue;
        }
        out[key] = value;
        if (!KNOWN_CONFIG_KEYS.has(key))
            warnConfig('未知配置键 ' + key + '（已保留，但本版本不读取）');
    }
    return out;
}
