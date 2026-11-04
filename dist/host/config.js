/**
 * host/config.ts —— 配置与 Key（可复用模块）
 * Key 来源：DSH 凭据 > 环境变量 > 插件 config.json
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
export function readApiKey(pluginDir) {
    try {
        const p = join(homedir(), '.dsh', '.credentials.yaml');
        const txt = readFileSync(p, 'utf8');
        const m = txt.match(/DEEPSEEK_API_KEY:\s*(sk-[A-Za-z0-9]+)/);
        if (m && m[1])
            return m[1];
    }
    catch { }
    try {
        if (process.env.DEEPSEEK_API_KEY)
            return process.env.DEEPSEEK_API_KEY.trim();
    }
    catch { }
    try {
        const cfg = JSON.parse(readFileSync(join(pluginDir, 'config.json'), 'utf8'));
        if (cfg && typeof cfg.deepseekKey === 'string' && cfg.deepseekKey.trim())
            return cfg.deepseekKey.trim();
    }
    catch { }
    return '';
}
