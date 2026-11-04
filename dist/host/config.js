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
        return JSON.parse(readFileSync(join(pluginDir, 'config.json'), 'utf8'));
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
/** Key 就绪情况（给 /status 与启动日志用） */
export function keyStatus(pluginDir) {
    return {
        deepseek: Boolean(readApiKey(pluginDir)),
        siliconflow: Boolean(readSiliconFlowKey(pluginDir)),
    };
}
