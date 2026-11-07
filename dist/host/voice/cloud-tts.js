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
 * 日用量落盘 ~/.dsh-chubby-whale/cloud-usage.json（重启/跨进程接着算）；写盘失败时进程内
 * 计数兜底并留 CLOUD-USAGE-FAIL，熔断不会因为一次 IO 失败就失效。
 *
 * 健壮性：单次响应体积上限 16MB（声明超限不读流、流式超限提前 cancel），坏响应吃不掉宿主内存；
 * 超时（默认 15s，可注入）到点 abort，失败一律抛错交给路由回退，不记账。
 * 断连（2026-11-07 B94）：synthesize 的第 2 个参数是可选中止信号（路由在客户端走了时给出），
 * 与自己的超时用 AbortSignal.any 合并 —— 客户端一走就断开云端调用，不再等满 15s；同样不记账。
 *
 * 安全：API Key 只从本地 config.json 读，不进包、不进备份导出。
 * 配置读取口径（B101）：与 host/config.ts 的 readConfigJson 同一套 —— 去敏告警、只报形状、
 * 坏 JSON 只提示一次并回落默认；边界与理由见 readCloudVoice 上方的注释。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../atomic.js';
import { readConfigJson } from '../config.js';
/** 官方 HTTP 接口地址（个人版/企业版一致） */
export const CLOUD_TTS_URL = 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional';
/** 资源 ID：豆包语音合成模型 2.0 */
export const CLOUD_TTS_RESOURCE_ID = 'seed-tts-2.0';
/** 默认音色（文档示例的通用女声；可换成任意 seed-tts-2.0 音色） */
export const CLOUD_TTS_DEFAULT_SPEAKER = 'zh_female_vv_uranus_bigtts';
/** 合成请求超时（云端 HTTP 单次，通常 0.2–0.5s） */
const CLOUD_TTS_TIMEOUT_MS = 15000;
/**
 * 单次响应体积上限（字节，按 JSON 文本算：base64 比音频大约 4/3）。
 *
 * 为什么必须有：原来直接 `await res.text()`，chunked 流有多大就收多大——服务端 bug、
 * 中间层塞回一个错误页/HTML、或响应被劫持时，宿主进程的内存没有任何护栏
 * （实测 8MB 的假响应照收不误，再大也一样）。
 *
 * 上限怎么定：/tts 路由侧单段文本最多 6000 字（host/routes/tts.ts 的 MAX_TEXT），
 * 按 24kHz mp3 估算约 5–10MB base64；正常请求（客户端按 ≤80 字分段）只有几十~一百多 KB。
 * 取 16MB 既装得下最长的合法请求，又给坏响应一个硬天花板；超限一律抛错让路由回退
 * edge-tts（免费兜底，客户端仍有声），不拿宿主内存赌对方一定守规矩。
 */
const CLOUD_TTS_MAX_BYTES = 16 * 1024 * 1024;
/* ------------------------------------------------------------------------- *
 * config.json 的读取（B101 收敛：与 host/config.ts 的 readConfigJson 同一套口径）
 *
 * 口径（两处逐条对齐，改一边必须改另一边）：
 *   · 没有文件（ENOENT/ENOTDIR）是常态（Key 也可从环境变量来），静默按“未配置”处理；
 *   · 坏 JSON / 根不是普通对象：**只告警一次**并回落默认——旧实现在这里全静默，
 *     用户只会看到“语音没反应”，照坑 35 的教训，“没反应”比“报错”更糟；
 *   · 告警只报「形状」（类型/长度）与错误类型 + `at position N`，**绝不拼 err.message、
 *     绝不回显任何值**：Node ≥20 的 JSON 报错消息里带源文本片段，而 config.json 就放着 Key，
 *     直接拼等于把 Key 写进日志（B100 给 config.ts 补的加固，本文件此前是旁路，B101 补齐）；
 *   · BOM 一律走 atomic.ts 的 readTextNoBom，不再自写一份 /^\uFEFF/ 正则。
 *
 * 为什么这里是「同一份口径」而不是「同一个函数」（边界，别悄悄“优化”）：
 *   ① cloud-tts 的依赖白名单被 scripts/test-persona-cloud.mjs 的 [7] 钉成
 *      node:fs / node:path / ../atomic.js，多一个 import 就红（本批禁改该测试）；
 *   ② 把读取器从 config.ts 导出会改动导出面，npm test 里的 gen-module-index --check
 *      会要求重生成 docs/模块接口清单.md（本批禁改 docs）。
 *   两条解禁后才能真的共用实现；在那之前由 scripts/test-cloud-config.mjs 逐条比对两边的
 *   文案/去敏/去重/回落，任一边漂移即红。
 * ------------------------------------------------------------------------- */
const CLOUD_VOICE_KEY_FIELD = 'cloudVoice.apiKey';
/** 去敏告警去重：readCloudVoice 每次合成都会现读配置，同一条只提示一次 */
const warnedCloudConfig = new Set();
/**
 * 告警出口。前缀带 cloudVoice：同一个 config.json 由 host/config.ts 与本文件两处读，
 * 文案相同、来源不同，日志里要能分清是谁在报（也避免两行一模一样的日志看着像重复刷屏）。
 */
function warnCloudConfig(msg) {
    if (warnedCloudConfig.has(msg))
        return;
    warnedCloudConfig.add(msg);
    console.warn('[chubby-whale][cloudVoice] ' + msg);
}
/**
 * 值形状描述（只报类型/长度，绝不回显内容）。
 * 与 host/config.ts 的 shapeOf 同一口径；这里保留一份是因为它只用于 cloudVoice 段与 Key 字段的类型告警，
 * 不外泄内容，复制风险低（真正危险的「拼 err.message / 回显前 60 字符」已经随解析器一起并到 config.ts）。
 */
function shapeOf(raw) {
    try {
        if (raw === undefined)
            return 'undefined';
        if (raw === null)
            return 'null';
        if (Array.isArray(raw))
            return '数组（长度 ' + raw.length + '）';
        const t = typeof raw;
        if (t === 'object') {
            let keys = 0;
            try {
                keys = Object.keys(raw).length;
            }
            catch { }
            return '对象（' + keys + ' 个键）';
        }
        return t;
    }
    catch {
        return '无法识别的值';
    }
}
/** 从 pluginDir/config.json 读 cloudVoice 段（缺省/无 Key = 不启用；语义与默认值保持原样） */
export function readCloudVoice(pluginDir) {
    const empty = {
        enabled: false, apiKey: '', speaker: CLOUD_TTS_DEFAULT_SPEAKER,
        resourceId: CLOUD_TTS_RESOURCE_ID, dailyChars: 5000,
    };
    const raw = readConfigJson(pluginDir, warnCloudConfig);
    if (!raw)
        return empty;
    const cv = raw.cloudVoice;
    if (cv == null)
        return empty; // 没配这一段：常态，静默
    if (typeof cv !== 'object' || Array.isArray(cv)) {
        warnCloudConfig('config.json 的 cloudVoice 应为对象（实际 ' + shapeOf(cv) + '），已按未配置处理');
        return empty;
    }
    const apiKeyRaw = cv.apiKey;
    const apiKey = typeof apiKeyRaw === 'string' ? apiKeyRaw.trim() : '';
    if (!apiKey) {
        // 写成 number/对象要告警（用户只会看到“没声”，没有线索）；
        // null/undefined/空白字符串＝没配，静默（与 config.ts 的 readKeyField 同一口径）
        if (apiKeyRaw !== undefined && apiKeyRaw !== null && typeof apiKeyRaw !== 'string') {
            warnCloudConfig('config.json 的 ' + CLOUD_VOICE_KEY_FIELD + ' 应为字符串（实际 ' + shapeOf(apiKeyRaw) + '），已忽略');
        }
        return empty;
    }
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
/**
 * 写日用量；失败返回 false（调用方记一行日志，绝不把异常抛进聊天链路）。
 * 返回布尔而不是吞掉：熔断的全部依据就是这份计数，写不进去必须留痕。
 */
function saveUsage(runtimeDir, u) {
    try {
        writeJsonAtomic(join(runtimeDir, 'cloud-usage.json'), u);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * 带体积上限地读完响应文本（成功与失败两条路都走这里）。
 *   · 声明了 content-length 且已超限：一个字节都不读，直接判超限；
 *   · 没声明或声明偏小：边读边累计，超限立刻 cancel 掉流再抛（不把整份坏响应收进内存）；
 *   · 没有 body 流（离线测试里的假响应）时退回 res.text()，按 UTF-8 字节数补判上限。
 */
async function readResponseText(res, maxBytes) {
    const declared = Number(res && res.headers && typeof res.headers.get === 'function'
        ? res.headers.get('content-length') : NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
        throw new Error('cloud-tts 响应超限 ' + declared + ' > ' + maxBytes + ' 字节');
    }
    const body = res && res.body;
    if (!body || typeof body.getReader !== 'function') {
        const text = String(await res.text());
        const bytes = Buffer.byteLength(text, 'utf8');
        if (bytes > maxBytes)
            throw new Error('cloud-tts 响应超限 ' + bytes + ' > ' + maxBytes + ' 字节');
        return text;
    }
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            const step = await reader.read();
            if (!step || step.done)
                break;
            if (!step.value)
                continue;
            const buf = Buffer.from(step.value);
            total += buf.length;
            if (total > maxBytes)
                throw new Error('cloud-tts 响应超限 >' + maxBytes + ' 字节');
            chunks.push(buf);
        }
    }
    catch (err) {
        // 读取中途出错（含超时 abort / 超限）：把流放掉，别让连接挂着
        try {
            if (typeof reader.cancel === 'function')
                await reader.cancel();
        }
        catch { }
        throw err;
    }
    finally {
        try {
            if (typeof reader.releaseLock === 'function')
                reader.releaseLock();
        }
        catch { }
    }
    return Buffer.concat(chunks).toString('utf8');
}
/** 中止类错误：name='AbortError'，与 fetch/AbortSignal 同口径（路由按 client.gone() 认断连，不看 code） */
function abortError() {
    const e = new Error('cloud-tts aborted by caller');
    e.name = 'AbortError';
    return e;
}
/**
 * 把「自己的超时」与「调用方中止」合成一个 signal：任一触发都断开这次云端外呼。
 *
 * 为什么要合：客户端 30s 硬超时 / 切页面 / 断网时会走 signal；只等自己的 15s 超时的话，
 * 客户端早就走了、云端还在算（付费 + 占连接），这正是 B94 要治的浪费。
 *
 * 两条路：
 *   · 有 AbortSignal.any（Node ≥20.3，项目 engines ≥22.3）直接用：内部按弱引用管理源 signal，
 *     不往长期 signal 上留监听；
 *   · 没有 any 时手写组合：两边的 reason 原样转发（超时仍是 TimeoutError/AbortError 口径），
 *     监听在「触发」与「本次调用结束」时都摘掉。
 *
 * 为什么这里自带一份而不 import host/http.ts 的 combineSignals：cloud-tts 的依赖白名单只有
 * node:fs / node:path / atomic（scripts/test-persona-cloud.mjs 的 [7] 钉着这条），不能再加。
 */
function combineAbort(base, outer) {
    if (!outer)
        return { signal: base || undefined, dispose() { } };
    if (!base)
        return { signal: outer, dispose() { } };
    const AnySig = AbortSignal;
    if (typeof AnySig.any === 'function') {
        try {
            return { signal: AnySig.any([base, outer]), dispose() { } };
        }
        catch { }
    }
    const ctl = new AbortController();
    let hooked = false;
    function unhook() {
        if (!hooked)
            return;
        hooked = false;
        try {
            outer.removeEventListener('abort', onAbort);
        }
        catch { }
        try {
            base.removeEventListener('abort', onAbort);
        }
        catch { }
    }
    function onAbort(ev) {
        unhook();
        const src = ev && (ev.target || ev.currentTarget);
        try {
            if (src && src.reason !== undefined)
                ctl.abort(src.reason);
            else
                ctl.abort();
        }
        catch { }
    }
    // 传进来就已经中止的 signal 不会再发事件：先各自判一次，否则这次调用会一直等到超时
    if (base.aborted || outer.aborted) {
        const src = base.aborted ? base : outer;
        try {
            ctl.abort(src.reason);
        }
        catch { }
        return { signal: ctl.signal, dispose() { } };
    }
    hooked = true;
    try {
        base.addEventListener('abort', onAbort);
    }
    catch { }
    try {
        outer.addEventListener('abort', onAbort);
    }
    catch { }
    return { signal: ctl.signal, dispose: unhook };
}
/**
 * 创建云端 TTS 实例。synthesize 失败会抛错（路由据此回退 edge-tts）；
 * 超预算/未启用时也抛错 —— 调用方不必区分，统一兜底。
 */
export function createCloudTts(deps) {
    const log = deps.log || (() => { });
    const clock = deps.now || (() => new Date());
    const timeoutRaw = Number(deps.timeoutMs);
    const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : CLOUD_TTS_TIMEOUT_MS;
    /**
     * 进程内兜底计数。
     *
     * 为什么需要：日用量原本只认磁盘上的 cloud-usage.json，而写盘失败（只读目录、磁盘满、
     * 杀软占着句柄）被静默吞掉——实测把 cloud-usage.json 换成目录后，dailyChars=150 的额度
     * 连跑 3 次 100 字的合成全部放行、usage() 还是 0，熔断彻底失效（花的是真金白银）。
     * 现在成功一次就同时记内存与磁盘，取两者的最大值：磁盘写失败时进程内仍能挡住超额，
     * 重启后才有丢计数的风险（写盘成功时磁盘自然追平，不会重复计数）。
     */
    let memUsage = null;
    /**
     * 在途预占字数（2026-11-07 B93）：判定与记账之间隔着 await fetch，并发 N 个请求
     * 会一起通过判定，最多超额 (N-1)×单次字数。这里在发请求前先「预占」，判定时把预占算进去，
     * 请求结束（成功或失败）在 finally 释放。预占只影响熔断判定，不影响 usage() 报告的已用量。
     */
    let reservedChars = 0;
    /** 今天已用字数：磁盘与内存取大（磁盘可能是别的实例写的，内存是本进程的最低保障） */
    function usedChars(today) {
        const u = readUsage(deps.runtimeDir);
        const fromDisk = u.day === today ? u.chars : 0;
        const fromMem = memUsage && memUsage.day === today ? memUsage.chars : 0;
        return Math.max(fromDisk, fromMem);
    }
    function budgetLeft(cfg, today) {
        // 已用量 + 在途预占：并发请求不会同时看到「还有额度」
        return cfg.dailyChars - usedChars(today) - reservedChars;
    }
    return {
        enabled() {
            const cfg = deps.config();
            return Boolean(cfg && cfg.enabled && cfg.apiKey);
        },
        usage() {
            const cfg = deps.config();
            const today = todayKey(clock());
            return { day: today, chars: usedChars(today), limit: cfg.dailyChars };
        },
        async synthesize(text, signal) {
            const cfg = deps.config();
            if (!cfg.enabled || !cfg.apiKey)
                throw new Error('cloud-tts 未启用');
            const body = String(text || '').trim();
            if (!body)
                throw new Error('cloud-tts 空文本');
            // 调用方在进来之前就放弃了：连熔断判定/预占都不必做（也不会发请求）
            if (signal && signal.aborted)
                throw abortError();
            const today = todayKey(clock());
            // 日字数熔断：超了直接抛，路由回退 edge-tts
            if (budgetLeft(cfg, today) < body.length) {
                log('[tts] CLOUD-BUDGET 日字数超限（' + cfg.dailyChars + '），回退 edge-tts');
                throw new Error('cloud-tts 日预算用尽');
            }
            const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const timer = setTimeout(() => { try {
                ctl && ctl.abort();
            }
            catch { } }, timeoutMs);
            // 自己的超时 + 调用方中止合成一个 signal：任一触发都断开这次云端外呼（B94）
            const combo = combineAbort(ctl ? ctl.signal : null, signal);
            // 先占额度再发请求：判定与记账之间的 await 期间，别的请求不能再用同一份额度
            reservedChars += body.length;
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
                    signal: combo.signal,
                });
                if (!res.ok) {
                    // 错误页也走体积上限：有的网关会回一整页 HTML，读满内存才知道是 500
                    const t = await readResponseText(res, CLOUD_TTS_MAX_BYTES).catch(() => '');
                    throw new Error('cloud-tts HTTP ' + res.status + ' ' + t.slice(0, 200));
                }
                // 响应是 chunked 行流；整段读完后按行解析（半行不会跨包被判成坏帧）
                const raw = await readResponseText(res, CLOUD_TTS_MAX_BYTES);
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
                // 记账（成功才记）：内存与磁盘同时记，磁盘写失败也不能让熔断瞎掉
                const used = usedChars(today) + body.length;
                memUsage = { day: today, chars: used };
                if (!saveUsage(deps.runtimeDir, memUsage)) {
                    log('[tts] CLOUD-USAGE-FAIL 日用量写盘失败（进程内计数仍生效，重启后会丢）：day=' + today + ' chars=' + used);
                }
                return buf;
            }
            finally {
                clearTimeout(timer);
                combo.dispose();
                // 释放预占：成功时已记进用量（磁盘/内存），失败时这份额度要还回去
                reservedChars = Math.max(0, reservedChars - body.length);
            }
        },
    };
}
