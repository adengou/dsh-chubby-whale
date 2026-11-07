/**
 * host/chat-core.ts —— 聊天领域纯函数（普通 /chat 与流式 /chat-stream 共用）
 *
 * 这些逻辑原先在 routes/chat.ts 里，流式路由再反过来从 chat.ts 横向 import——
 * 路由之间互相依赖，改一处容易断另一处。现在提到本文件：
 *   · 请求体解析（消息截断 / lang / voice / 图片 mime）
 *   · 语言判定与缓存 key 规范化
 *   · 历史截断 / 上下文指纹 / prompt 片段与消息组装
 * 不涉及 HTTP、不涉及 fetch、不持有任何状态，便于离线断言（scripts/selftest.mjs 仍用 chat.ts 的再导出）。
 */
import { shortHash, hashKey } from '../shared/hash.js';
import { estimateCostCny, readUsageSplit } from '../shared/pricing.js';
import { clipCodePoints } from '../shared/text.js';
import { fetchJson } from './http.js';
import { DEEPSEEK_CHAT_URL } from '../shared/deepseek.js';
/** DeepSeek 对话接口地址（聊天与摘要共用） */
import { parseReminderIntent } from '../shared/remind-nl.js';
export const CHAT_URL = DEEPSEEK_CHAT_URL;
/** 只把最近 8 条历史喂给模型（4 轮）；更早的靠长期记忆摘要，省 token */
export const HISTORY_IN_PROMPT = 8;
/** 聊天回复缓存 7 天 */
export const CHAT_CACHE_TTL = 7 * 24 * 3600 * 1000;
/** 单条用户消息最多带多少字（两条路径共用；此前流式没有截断） */
const CHAT_MAX_MESSAGE_CHARS = 500;
/** 能被缓存的最短字数：语音 2 字（「在吗」「讲个笑话」也要能命中）、打字 6 字 */
const CHAT_CACHE_MIN_VOICE = 2;
const CHAT_CACHE_MIN_TEXT = 6;
/**
 * 图片 base64 最多允许多少字符（两条路径共用；4MB 字符 ≈ 3MB 原图，base64 按 4/3 膨胀）。
 * 为什么不能只靠 6MB 请求体上限：那个上限管的是「整包 JSON」，一张 4MB 图 + 长文字照样能塞进来，
 * 而视觉模型按像素计费、上游对单图大小也有硬限，超了就是白烧一次注定失败的请求。
 * 所以解析阶段只标出 imageTooLarge，状态码与文案由两条路由各自按同一口径回。
 */
const CHAT_MAX_IMAGE_B64 = 4 * 1024 * 1024;
/**
 * 聊天 / 流式的 max_tokens 预算（2026-11 调整：260 → 800）。
 * 新模型若忽略 thinking:{type:'disabled'}、把预算花在 reasoning_content 上，260 会出现「只思考不回答」；
 * 预算给到 800 后即使思考占掉一部分，也仍有足够额度吐出正文。
 */
export const CHAT_MAX_TOKENS = 800;
/** 后台摘要类调用（长期记忆压缩 / L2 学习 / L3 自写）的 max_tokens 预算（原 160~320 偏低） */
export const SUMMARY_MAX_TOKENS = 400;
/**
 * 聊天缓存的规范化：语音闲聊要"同一句话就命中"，所以
 *   - 去掉标点/空白/大小写差异（「你好吗？」「你好吗」「你好嗎?」→ 同一个键）
 *   - 不把历史长度/记忆摘要放进键（否则每聊一句键就变，缓存等于没有）
 * 代价：同一句话在不同上下文会得到同一条回复——对语音闲聊这正是省 token 的关键。
 */
/**
 * 聊天里说的提醒（2026-11-07 B106）。
 *
 * 用户实测：对鱼说「十分钟后提醒我吃早餐」，鱼答应了，但 reminders.json 根本没这个文件——
 * 它只是记住了对话，没有排程。这里把「提醒我 + 时间 + 任务」解析出来并写进提醒仓储，
 * 与菜单「记个饭点…」走同一个 addReminder 端口，所以提醒清单、到点轮询、简报待办都能看到它。
 *
 * 去重：同一条消息可能被客户端重试（网络抖动），60 秒内同一个「任务|时刻」只建一次；
 * 上限 64 条键，防止长期运行无限增长。
 */
const reminderDedupe = new Map();
const REMINDER_DEDUPE_MS = 60 * 1000;
const REMINDER_DEDUPE_MAX = 64;
/** @returns 真正新建的提醒；没命中/被去重/端口未接 → null */
export function maybeCreateReminder(addReminder, message, now = Date.now()) {
    if (typeof addReminder !== 'function')
        return null;
    const hit = parseReminderIntent(message, now);
    if (!hit)
        return null;
    // 键按「任务 + 到点分钟」：客户端重试会晚几百毫秒~几秒，用精确 ISO 当键会让同一条提醒重复建。
    const atMs = new Date(hit.at).getTime();
    const key = hit.task + '|' + (Number.isFinite(atMs) ? Math.round(atMs / 60000) : hit.at);
    const seen = reminderDedupe.get(key);
    if (seen !== undefined && now - seen < REMINDER_DEDUPE_MS)
        return null;
    // 先占位再写：即使 addReminder 抛错也不会因为「写失败→重试」把去重表撑大
    if (reminderDedupe.size >= REMINDER_DEDUPE_MAX) {
        const oldest = reminderDedupe.keys().next();
        if (!oldest.done)
            reminderDedupe.delete(oldest.value);
    }
    reminderDedupe.set(key, now);
    const created = addReminder(hit.task, hit.at, hit.repeat || 0);
    console.log('[chat] REMINDER-CREATED task=' + hit.task.slice(0, 40) + ' at=' + hit.at + (hit.repeat ? ' repeat=' + hit.repeat : ''));
    return created;
}
export function normalizeChatText(s) {
    return String(s || '')
        .trim()
        .toLowerCase()
        .replace(/[\s\u3000]+/g, '')
        .replace(/[，。！？、；：,.!?;:"'”’“”（）()【】\[\]<>《》~`@#$%^&*_+=|\\/-]/g, '');
}
/** 按内容判语言：有中文→zh；无中文但有拉丁字母→en；否则 auto。纯函数，便于离线断言 */
export function detectLang(message) {
    const t = String(message || '');
    if (/[\u4e00-\u9fa5]/.test(t))
        return 'zh';
    if (/[A-Za-z]{2,}/.test(t))
        return 'en';
    return 'auto';
}
/**
 * 请求体 → 本轮聊天参数（两条路径唯一入口）。
 * 统一这些口径，避免「同一条消息在两条路径上被截断成不同文本 / 缓存 key 分叉」：
 *   · message：只认字符串，截到 CHAT_MAX_MESSAGE_CHARS（流式此前完全不截）；
 *   · lang：只认 zh/en/auto，其它值（含非字符串）一律 auto，auto 再按内容判定；
 *   · voice：只认布尔 true 或 'true'（流式此前用 !!body.voice，'false' 会被当成语音）；
 *   · image：mime 只接受 image/<token>，其余回落 image/jpeg（客户端可伪造该字段）；
 *     base64 超过 CHAT_MAX_IMAGE_B64（4MB 字符 ≈ 3MB 原图）时置 imageTooLarge，
 *     由路由回 413 + 文案（两条路径同一上限、同一状态码）；
 *   · cacheable：语音 ≥2 字、打字 ≥6 字（短句进缓存会变成复读机）。
 */
export function readChatRequest(body) {
    // 按码点截断（B101）：原来 `body.message.slice(0, 500)` 数的是 UTF-16 码元，
    // 500 个 emoji 会被截成 250 个，499 个汉字 + 一个 emoji 时还会切出孤立代理项——
    // 这条 message 要进 prompt 外呼、进 chatCacheKey、并经 appendTurns 落进 memory.json。
    const message = typeof (body && body.message) === 'string'
        ? clipCodePoints(body.message, CHAT_MAX_MESSAGE_CHARS)
        : '';
    const b64 = typeof (body && body.image) === 'string' ? body.image : '';
    const rawMime = typeof (body && body.imageMime) === 'string' ? body.imageMime.trim() : '';
    const mime = /^image\/[A-Za-z0-9.+-]{1,32}$/.test(rawMime) ? rawMime : 'image/jpeg';
    const voice = body && body.voice;
    const isVoice = voice === true || voice === 'true';
    const rawLang = body && body.lang;
    const declared = rawLang === 'zh' || rawLang === 'en' || rawLang === 'auto' ? rawLang : 'auto';
    const lang = declared === 'auto' ? detectLang(message) : declared;
    const cacheable = message.trim().length >= (isVoice ? CHAT_CACHE_MIN_VOICE : CHAT_CACHE_MIN_TEXT);
    // 只判字符数，不解码：解码一张超大图本身就要几百毫秒内存分配，没必要
    const imageTooLarge = b64.length > CHAT_MAX_IMAGE_B64;
    return { message, image: { b64, mime }, imageTooLarge, isVoice, lang, cacheable };
}
/** 取最近 n 条（只做截断，不改内容）；纯函数，便于离线断言 */
export function recentHistory(history, n) {
    const arr = Array.isArray(history) ? history : [];
    const k = Math.max(0, Math.floor(Number(n) || 0));
    return k === 0 ? [] : arr.slice(-k);
}
/**
 * 缓存 key：语言 + 规范化文本 + 是否语音 + 模型名 + 上下文指纹（语音和打字分开存，避免互相串）。
 * 模型名进 key：换模型后旧缓存自动失效，不会把上一个模型的口吻/质量参差的回复继续拿出来用。
 */
export function chatCacheKey(lang, message, isVoice, ctx = '', model = '') {
    // v3：在 v2（上下文指纹）基础上把模型名算进 key；升级前的 v2 key 自然失配，等于清空旧缓存
    return hashKey('v3|' + lang + '|' + (isVoice ? 'voice' : 'text') + '|' + normalizeChatText(message) + '|' + String(model || '') + '|' + ctx);
}
/**
 * 上下文指纹（长期记忆摘要 + 上一轮用户消息）。
 * 缓存 key 必须带上上下文：prompt 里拼了完整 history 和长期记忆摘要，
 * 只按「语言|问题」算 key 会让同一句话永远命中第一条回复。
 */
/**
 * 缓存上下文指纹。
 * 注意：这里**故意不把"上一轮用户消息"算进去**——
 * 带上它会让「同一句话第二次问」永远 miss（实测两次 cached:false，
 * 今日聊天 token 已 31 万），而语音闲聊的价值恰恰是同一句能命中。
 * 只保留长期记忆摘要：主人身份/喜好变了才让旧回复失效。
 */
export function chatContextFingerprint(memSummary, _history = []) {
    try {
        return shortHash(String(memSummary || ''));
    }
    catch {
        return '';
    }
}
/** 把历史快照转成模型消息（只收 user/assistant 且 content 为字符串，截断到最近 8 条） */
export function historyMessages(history) {
    const out = [];
    for (const m of recentHistory(history, HISTORY_IN_PROMPT)) {
        if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') {
            out.push({ role: m.role, content: m.content });
        }
    }
    return out;
}
/** 拼 system 提示：人设 + 语言规则 + 长期记忆 +（可选）语音输入说明 */
export function composeSystemPrompt(base, parts) {
    const text = typeof base === 'function' ? base() : base;
    return String(text || '') + parts.filter(Boolean).join('');
}
/**
 * 语言规则片段：英文提问必须英文作答（模型默认会跟着中文人设走，必须明说）；
 * auto（数字/符号等判不出语言）**不加任何语言指令**。
 * /chat-stream 此前把 auto 也拼成「请用中文回答」、en 只有一句短提示——同一句话两条路径 prompt 不同。
 */
function chatLangHint(lang) {
    if (lang === 'en') {
        return '\n【语言规则·必须遵守】主人这条消息是英文。你必须用英文回答（Reply in English only）。'
            + '不要用中文回答，不要说看不懂或一头雾水——这就是一句普通英文，直接自然回答即可。'
            + '中文只允许出现在解释专有名词时。';
    }
    return lang === 'zh' ? '\n【语言规则】主人用中文提问，请用中文回答。' : '';
}
/** 长期记忆片段（空摘要不占 token） */
function chatMemoryHint(memSummary) {
    return memSummary ? ('\n（关于主人的长期记忆：' + memSummary + '）') : '';
}
/**
 * 语音输入说明：ASR 结果可能有错字/口语碎屑，明确告诉模型按大意理解。
 * /chat 有、/chat-stream 原来完全没有——而客户端语音聊天走的是流式，等于主路径上一直缺这段说明。
 */
function chatVoiceHint(isVoice) {
    if (!isVoice)
        return '';
    return '\n【输入说明】这条消息来自语音识别，可能出现错字、同音字、断句错误或口水词。'
        + '请按最合理的日常意思理解后直接回答，不要复述原句、不要纠正错字、不要反问「你是不是想说…」，'
        + '也不要因为听不清就说看不懂。';
}
/**
 * 组 prompt 消息：system（人设 + 语言 + 记忆 + 语音）→ 最近 HISTORY_IN_PROMPT 条历史 → 本轮用户消息。
 * 两条路径共用这一个函数，保证同一输入下 messages 结构（role/条数/片段顺序）完全一致。
 * 有图时最后一条按多模态数组发（text + image_url），无图时是纯字符串。
 */
export function buildChatMessages(opts) {
    const imageB64 = opts.image && opts.image.b64 ? opts.image.b64 : '';
    const messages = [{
            role: 'system',
            content: composeSystemPrompt(opts.systemPrompt, [
                chatLangHint(opts.lang),
                chatMemoryHint(opts.memSummary || ''),
                chatVoiceHint(opts.isVoice),
            ]),
        }];
    messages.push(...historyMessages(opts.history || []));
    if (imageB64) {
        messages.push({
            role: 'user',
            content: [
                { type: 'text', text: opts.message || '请描述这张图片，用中文回答。' },
                { type: 'image_url', image_url: { url: 'data:' + opts.image.mime + ';base64,' + imageB64 } },
            ],
        });
    }
    else {
        messages.push({ role: 'user', content: opts.message });
    }
    return messages;
}
// ───────────── 内部模型调用的鱼账本记账（B97） ─────────────
//
// 口径**照抄** routes/chat.ts（唯一区别是把 kind 标成来源），三条内部链路各写一份：
//   · 只记「真拿到 2xx 回复」的那次外呼——超时/网络错/HTTP 非 2xx 的 usage 不可信，宁可漏记不虚记；
//   · usage 缺失、或没有数字型 total_tokens → 不记、不猜（与聊天一致）；
//   · 有输入/输出拆分才估金额：estimateCostCny 拿不到拆分返回 null，此时不传 detail（不猜 0 元）；
//   · 未注入记账端口（老宿主装配、离线测试不注入）→ 直接跳过；
//   · 整段 try 住：账本写失败绝不能影响摘要/人格主链路，也不改变任何返回值。
//
// 为什么三处各写一份、不抽公共件：抽成 chat-core 的导出会改变模块接口，而
// `scripts/gen-module-index.mjs --check` 要求 docs/模块接口清单.md 同步更新；
// 本批次（B97）只允许改 chat-core / personality-learn / personality-write / ports，不允许动 docs，
// 所以刻意不新增任何导出，让接口契约与文档保持原样。
//
// kind 用 'summary' / 'personality' 这两个**新值**是安全的：repos/fishfood.ts 只把 'story'
// 单独计进 storyTokens，其余 kind 一律并进 chatTokens，而 day/month/total 三个总量与 kind 无关，
// 所以总量口径与传 'chat' 逐字节相同（已读该文件确认，见 scripts/test-internal-usage.mjs 第 [5] 节）。
// detail 额外带一个 `source` 标明来源：仓储只认 promptTokens/completionTokens/cacheHitTokens/costCny，
// 未知字段直接忽略、不写坏文件，纯留痕；将来要把来源写进账本时不用再改这三个调用点。
/**
 * 后台压缩长期记忆（不 await，失败只记日志）；模型与主聊天同一个装配值。
 *
 * 第 6 个参数是可选的鱼账本记账端口（B97）：不传时行为与改动前**完全一致**（不记账、不抛错）。
 * 仓库里两个调用点（routes/chat.ts、routes/chat-stream.ts）目前还没传它——接线属于另一个批次，
 * 在接上之前这条例行调用仍然漏账，属已知缺口。
 */
export async function summarizeMemory(key, convo, oldSummary, save, model, addTokens) {
    const sys = '你在帮一条桌面宠物鱼整理长期记忆。把对话压缩成不超过80字的中文要点，只保留关于主人的事实（称呼、喜好、约定）和主人交代要记住的事。不要评论，不要加引号，只输出要点本身。';
    const body = JSON.stringify({ model, messages: [{ role: 'system', content: sys }, { role: 'user', content: '旧记忆：' + oldSummary + '\n最近对话：\n' + convo }], max_tokens: SUMMARY_MAX_TOKENS, temperature: 0.3, thinking: { type: 'disabled' } });
    try {
        const r = await fetchJson(CHAT_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body }, 20000);
        if (!r.ok) {
            console.error('[chat] SUMMARY-HTTP ' + r.status + ' ' + String(r.text || '').slice(0, 200));
            return;
        }
        // 鱼账本（B97）：这次摘要外呼确实花掉了 token，拿到 usage 就记账；拿不到不猜（与聊天同一口径）。
        // 放在解析/写回之前：save 回调抛错不该把这次已经花掉的 token 一起吞掉。
        try {
            const u = r.data && r.data.usage;
            if (u && typeof u.total_tokens === 'number' && typeof addTokens === 'function') {
                const split = readUsageSplit(u);
                const cost = split ? estimateCostCny(split, model) : null;
                addTokens('summary', u.total_tokens, split
                    ? { promptTokens: split.promptTokens, completionTokens: split.completionTokens, cacheHitTokens: split.cacheHitTokens, costCny: cost ? cost.cny : undefined, source: 'summary' }
                    : undefined);
            }
        }
        catch { }
        const s = String(r.data?.choices?.[0]?.message?.content || '').trim();
        if (s)
            save(s);
    }
    catch (err) {
        console.error('[chat] SUMMARY-ERR ' + String(err?.message || err));
    }
}
