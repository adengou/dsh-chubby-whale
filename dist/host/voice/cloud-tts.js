/**
 * host/voice/cloud-tts.ts —— 火山方舟「豆包语音 2.0」TTS（云端优先，失败由路由回退 edge-tts）
 *
 * 接口（2026-11-06 方舟官方文档核实，Agent Plan 个人版同样支持）：
 *   POST https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional
 *   Header: X-Api-Key、X-Api-Resource-Id: seed-tts-2.0、Content-Type: application/json
 *   Body:   {"req_params":{"text":"…","speaker":"zh_female_vv_uranus_bigtts",
 *                           "audio_params":{"format":"mp3","sample_rate":24000}}}
 *   响应：chunked 行流，每行一个 JSON：
 *     {"code":0,"data":"<base64 音频片段>"} 累加解码 -> 完整 mp3
 *     code === 20000000 表示结束；code > 0 表示错误
 *
 * 成本控制：按「日合成字数」熔断（默认 5000 字/天，可在 config.cloudVoice.dailyChars 改）；
 * 超限直接抛错 -> 路由回退 edge-tts（免费）-> 客户端始终有声。
 *
 * 安全：API Key 只从本地 config.json 读，不进包、不进备份导出。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../atomic.js';
/** 官方 HTTP 接口地址（个人版/企业版一致） */
export const CLOUD_TTS_URL = 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional';
/** 资源 ID：豆包语音合成模型 2.0 */
export const CLOUD_TTS_RESOURCE_ID = 'seed-tts-2.0';
/** 默认音色（文档示例的通用女声；可换成任意 seed-tts-2.0 音色） */
export const CLOUD_TTS_DEFAULT_SPEAKER = 'zh_female_vv_uranus_bigtts';
/** 合成请求超时（云端 HTTP 单次，通常 0.2–0.5s） */
const CLOUD_TTS_TIMEOUT_MS = 15000;
/** 从 pluginDir/config.json 读 cloudVoice 段（缺省/无 Key = 不启用） */
export function readCloudVoice(pluginDir) {
    const empty = {
        enabled: false, apiKey: '', speaker: CLOUD_TTS_DEFAULT_SPEAKER,
        resourceId: CLOUD_TTS_RESOURCE_ID, dailyChars: 5000,
    };
    try {
        const file = join(pluginDir, 'config.json');
        if (!existsSync(file))
            return empty;
        const raw = JSON.parse(String(readFileSync(file, 'utf8')).replace(/^\uFEFF/, ''));
        const cv = raw && typeof raw === 'object' ? raw.cloudVoice : null;
        if (!cv || typeof cv !== 'object')
            return empty;
        const apiKey = typeof cv.apiKey === 'string' ? cv.apiKey.trim() : '';
        if (!apiKey)
            return empty;
        const speaker = typeof cv.speaker === 'string' && cv.speaker ? cv.speaker : CLOUD_TTS_DEFAULT_SPEAKER;
        const resourceId = typeof cv.resourceId === 'string' && cv.resourceId ? cv.resourceId : CLOUD_TTS_RESOURCE_ID;
        const dailyChars = Number(cv.dailyChars);
        return {
            enabled: cv.enabled !== false,
            apiKey,
            speaker,
            resourceId,
            dailyChars: Number.isFinite(dailyChars) && dailyChars > 0 ? Math.floor(dailyChars) : 5000,
        };
    }
    catch {
        return empty;
    }
}
function todayKey(now = new Date()) {
    const p = (n) => (n < 10 ? '0' + n : String(n));
    return now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate());
}
function readUsage(runtimeDir) {
    try {
        const f = join(runtimeDir, 'cloud-usage.json');
        if (!existsSync(f))
            return { day: todayKey(), chars: 0 };
        const j = JSON.parse(String(readFileSync(f, 'utf8')).replace(/^\uFEFF/, ''));
        const day = typeof j?.day === 'string' ? j.day : todayKey();
        const chars = Number(j?.chars);
        return { day, chars: Number.isFinite(chars) && chars > 0 ? Math.floor(chars) : 0 };
    }
    catch {
        return { day: todayKey(), chars: 0 };
    }
}
function saveUsage(runtimeDir, u) {
    try {
        writeJsonAtomic(join(runtimeDir, 'cloud-usage.json'), u);
    }
    catch { }
}
/**
 * 创建云端 TTS 实例。synthesize 失败会抛错（路由据此回退 edge-tts）；
 * 超预算/未启用时也抛错 —— 调用方不必区分，统一兜底。
 */
export function createCloudTts(deps) {
    const log = deps.log || (() => { });
    const clock = deps.now || (() => new Date());
    function budgetLeft(cfg) {
        const u = readUsage(deps.runtimeDir);
        const today = todayKey(clock());
        return u.day === today ? cfg.dailyChars - u.chars : cfg.dailyChars;
    }
    return {
        enabled() {
            const cfg = deps.config();
            return Boolean(cfg && cfg.enabled && cfg.apiKey);
        },
        usage() {
            const cfg = deps.config();
            const u = readUsage(deps.runtimeDir);
            return { day: u.day, chars: u.chars, limit: cfg.dailyChars };
        },
        async synthesize(text) {
            const cfg = deps.config();
            if (!cfg.enabled || !cfg.apiKey)
                throw new Error('cloud-tts 未启用');
            const body = String(text || '').trim();
            if (!body)
                throw new Error('cloud-tts 空文本');
            // 日字数熔断：超了直接抛，路由回退 edge-tts
            if (budgetLeft(cfg) < body.length) {
                log('[tts] CLOUD-BUDGET 日字数超限（' + cfg.dailyChars + '），回退 edge-tts');
                throw new Error('cloud-tts 日预算用尽');
            }
            const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const timer = setTimeout(() => { try {
                ctl && ctl.abort();
            }
            catch { } }, CLOUD_TTS_TIMEOUT_MS);
            try {
                const res = await fetch(CLOUD_TTS_URL, {
                    method: 'POST',
                    headers: {
                        'X-Api-Key': cfg.apiKey,
                        'X-Api-Resource-Id': cfg.resourceId,
                        'Content-Type': 'application/json',
                        'X-Control-Require-Usage-Tokens-Return': '*',
                    },
                    body: JSON.stringify({
                        req_params: {
                            text: body,
                            speaker: cfg.speaker,
                            audio_params: { format: 'mp3', sample_rate: 24000 },
                        },
                    }),
                    signal: ctl ? ctl.signal : undefined,
                });
                if (!res.ok) {
                    const t = await res.text().catch(() => '');
                    throw new Error('cloud-tts HTTP ' + res.status + ' ' + t.slice(0, 200));
                }
                // 响应是 chunked 行流；text() 会全部拼好后按行解析
                const raw = await res.text();
                const parts = [];
                for (const line of raw.split('\n')) {
                    const s = line.trim();
                    if (!s)
                        continue;
                    let j = null;
                    try {
                        j = JSON.parse(s);
                    }
                    catch {
                        continue;
                    }
                    const code = Number(j && j.code);
                    if (code === 20000000)
                        break;
                    if (code > 0)
                        throw new Error('cloud-tts code=' + code + ' ' + String((j && j.message) || ''));
                    if (j && typeof j.data === 'string' && j.data)
                        parts.push(Buffer.from(j.data, 'base64'));
                }
                const buf = Buffer.concat(parts);
                if (!buf.length)
                    throw new Error('cloud-tts 没有返回音频');
                // 记账（成功才记）
                const u = readUsage(deps.runtimeDir);
                const today = todayKey(clock());
                saveUsage(deps.runtimeDir, { day: today, chars: (u.day === today ? u.chars : 0) + body.length });
                return buf;
            }
            finally {
                clearTimeout(timer);
            }
        },
    };
}
