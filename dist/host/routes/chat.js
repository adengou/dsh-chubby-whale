/**
 * host/routes/chat.ts —— 聊天路由（可复用模块）
 * 外呼统一走 host/http.ts：主聊天 30 秒、记忆摘要 20 秒（后台跑，不吊住回复）；请求体上限 6MB
 */
import { hashKey, shortHash } from '../cache.js';
import { readBody, fetchJson, isBodyTooLarge, isTimeoutError, sendTooLarge } from '../http.js';
const CHAT_URL = 'https://api.deepseek.com/chat/completions';
const CHAT_TIMEOUT = 30 * 1000; // 主聊天：30 秒
const SUMMARY_TIMEOUT = 20 * 1000; // 长期记忆摘要：20 秒
const CHAT_CACHE_TTL = 7 * 24 * 3600 * 1000; // 聊天回复缓存 7 天
const CHAT_MAX_BODY = 6 * 1024 * 1024; // 6MB（图片 base64 约 4MB * 1.34）
export const HISTORY_IN_PROMPT = 8; // 只把最近 8 条历史喂给模型（4 轮）；更早的靠长期记忆摘要，省 token
const NET_FALLBACK = '主人，本鲸一时想不起来话（网络或接口有点问题）……';
/** 后台压缩长期记忆（不 await，失败只记日志） */
async function summarizeMemory(key, convo, oldSummary, save) {
    const sys = '你在帮一条桌面宠物鱼整理长期记忆。把对话压缩成不超过80字的中文要点，只保留关于主人的事实（称呼、喜好、约定）和主人交代要记住的事。不要评论，不要加引号，只输出要点本身。';
    const body = JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'system', content: sys }, { role: 'user', content: '旧记忆：' + oldSummary + '\n最近对话：\n' + convo }], max_tokens: 220, temperature: 0.3, thinking: { type: 'disabled' } });
    try {
        const r = await fetchJson(CHAT_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body }, SUMMARY_TIMEOUT);
        if (!r.ok) {
            console.error('[chat] SUMMARY-HTTP ' + r.status + ' ' + String(r.text || '').slice(0, 200));
            return;
        }
        const s = String(r.data?.choices?.[0]?.message?.content || '').trim();
        if (s)
            save(s);
    }
    catch (err) {
        if (isTimeoutError(err))
            console.error('[chat] SUMMARY-TIMEOUT ' + SUMMARY_TIMEOUT + 'ms 无响应，已中止');
        else
            console.error('[chat] SUMMARY-ERR ' + String(err?.message || err));
    }
}
/**
 * 聊天缓存的规范化：语音闲聊要"同一句话就命中"，所以
 *   - 去掉标点/空白/大小写差异（「你好吗？」「你好吗」「你好嗎?」→ 同一个键）
 *   - 不把历史长度/记忆摘要放进键（否则每聊一句键就变，缓存等于没有）
 * 代价：同一句话在不同上下文会得到同一条回复——对语音闲聊这正是省 token 的关键。
 */
export function normalizeChatText(s) {
    return String(s || '')
        .trim()
        .toLowerCase()
        .replace(/[\s\u3000]+/g, '')
        .replace(/[，。！？、；：,.!?;:"'”’“”（）()【】\[\]<>《》~`@#$%^&*_+=|\\/-]/g, '');
}
/** 缓存键：语言 + 规范化文本 + 是否语音（语音和打字分开存，避免互相串） */
/** 按内容判语言：有中文→zh；无中文但有拉丁字母→en；否则 auto。纯函数，便于离线断言 */
export function detectLang(message) {
    const t = String(message || '');
    if (/[\u4e00-\u9fa5]/.test(t))
        return 'zh';
    if (/[A-Za-z]{2,}/.test(t))
        return 'en';
    return 'auto';
}
/** 取最近 n 条（只做截断，不改内容）；纯函数，便于离线断言 */
export function recentHistory(history, n) {
    const arr = Array.isArray(history) ? history : [];
    const k = Math.max(0, Math.floor(Number(n) || 0));
    return k === 0 ? [] : arr.slice(-k);
}
export function chatCacheKey(lang, message, isVoice, ctx = '') {
    // v2：把上下文指纹（长期记忆摘要 + 上一轮用户消息）算进 key，上下文变了不复用旧答案
    return hashKey('v2|' + lang + '|' + (isVoice ? 'voice' : 'text') + '|' + normalizeChatText(message) + '|' + ctx);
}
export function createChatHandler(opts) {
    let summaryCount = 0;
    let summarizing = false;
    return async function handleChat(req, res) {
        try {
            let raw;
            try {
                raw = await readBody(req, CHAT_MAX_BODY);
            }
            catch (err) {
                if (isBodyTooLarge(err)) {
                    console.error('[chat] BODY-TOO-LARGE > ' + CHAT_MAX_BODY + ' bytes');
                    sendTooLarge(res);
                    return;
                }
                throw err;
            }
            const text = raw.toString('utf8');
            let body = {};
            try {
                body = text ? JSON.parse(text) : {};
            }
            catch {
                body = {};
            }
            const message = typeof body?.message === 'string' ? body.message.slice(0, 500) : '';
            const imageB64 = typeof body?.image === 'string' ? body.image : '';
            const chatLang = (typeof body?.lang === 'string' && /^(zh|en|auto)$/.test(body.lang)) ? body.lang : 'auto';
            // auto 模式下按内容判语言（与流式路径共用 detectLang）
            const detected = detectLang(message);
            const effLang = chatLang === 'auto' ? detected : chatLang;
            const imageMime = typeof body?.imageMime === 'string' ? body.imageMime : 'image/jpeg';
            // 短句（<6 字）不进缓存：不然「在吗」「好的」会被复读机式复用（照 C# 的修法）
            const isVoice = body?.voice === true || body?.voice === 'true';
            // 语音闲聊门槛降到 2 个字（"在吗""讲个笑话"也要能命中）；打字仍要 ≥6 字
            const cacheable = message.trim().length >= (isVoice ? 2 : 6);
            if (!message) {
                res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: 'empty message' }));
                return;
            }
            // 读一份历史快照 + 长期记忆：只用来拼 prompt / 算缓存 key，不再拿它整份写回
            const history = opts.loadHistory();
            let memSummary = '';
            try {
                memSummary = opts.loadMemorySummary ? String(opts.loadMemorySummary() || '') : '';
            }
            catch { }
            // 缓存 key 必须带上上下文：prompt 里拼了完整 history 和长期记忆摘要，
            // 只按「语言|问题」算 key 会让同一句话永远命中第一条回复；这里加 history 长度 + 摘要短指纹
            const ctxFp = (() => {
                try {
                    const prevUser = recentHistory(history, HISTORY_IN_PROMPT).filter((m) => m && m.role === 'user').slice(-1)[0];
                    return shortHash(String(memSummary || '')) + '|' + shortHash(normalizeChatText(String((prevUser && prevUser.content) || '')));
                }
                catch {
                    return '';
                }
            })();
            const cacheKey = chatCacheKey(effLang, message, isVoice, ctxFp);
            // 缓存查找排在 Key 检查之前：没配 Key 时本地缓存照样能用
            const cacheOn = !opts.cacheEnabled || opts.cacheEnabled() !== false;
            if (cacheOn && opts.cache && !imageB64 && cacheable) {
                const cached = await opts.cache.getJson(cacheKey, 'json', CHAT_CACHE_TTL);
                if (cached && typeof cached.reply === 'string' && cached.reply.trim().length > 0) {
                    let intimacy = 0;
                    try {
                        const st0 = opts.loadState();
                        st0.intimacy = Math.min(100, (Number(st0.intimacy) || 0) + 1);
                        opts.saveState(st0);
                        intimacy = Number(st0.intimacy) || 0;
                    }
                    catch { }
                    // 缓存命中只加亲密度，不加经验（本次审计要求）
                    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: true, reply: cached.reply, intimacy, upgraded: false, cached: true }));
                    return;
                }
            }
            const key = opts.getKey();
            if (!key) {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: 'NO_KEY', reply: '主人，本鲸还没拿到钥匙（DeepSeek Key），配一下就能聊啦～' }));
                return;
            }
            // 语言硬约束：英文提问必须英文作答（模型默认会跟着中文人设走，必须明说）
            const langHint = effLang === 'en'
                ? '\n【语言规则·必须遵守】主人这条消息是英文。你必须用英文回答（Reply in English only）。'
                    + '不要用中文回答，不要说看不懂或一头雾水——这就是一句普通英文，直接自然回答即可。'
                    + '中文只允许出现在解释专有名词时。'
                : (effLang === 'zh' ? '\n【语言规则】主人用中文提问，请用中文回答。' : '');
            const memHint = memSummary ? ('\n（关于主人的长期记忆：' + memSummary + '）') : '';
            // 语音输入是 ASR 结果，可能有错字/口语碎屑：明确告诉模型按大意理解，别纠正错字、别答非所问
            const voiceHint = isVoice
                ? '\n【输入说明】这条消息来自语音识别，可能出现错字、同音字、断句错误或口水词。'
                    + '请按最合理的日常意思理解后直接回答，不要复述原句、不要纠正错字、不要反问「你是不是想说…」，'
                    + '也不要因为听不清就说看不懂。'
                : '';
            const messages = [{ role: 'system', content: opts.systemPrompt + langHint + memHint + voiceHint }];
            for (const m of recentHistory(history, HISTORY_IN_PROMPT)) {
                if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') {
                    messages.push({ role: m.role, content: m.content });
                }
            }
            if (imageB64) {
                messages.push({
                    role: 'user',
                    content: [
                        { type: 'text', text: message || '请描述这张图片，用中文回答。' },
                        { type: 'image_url', image_url: { url: 'data:' + imageMime + ';base64,' + imageB64 } },
                    ],
                });
            }
            else {
                messages.push({ role: 'user', content: message });
            }
            let data = null;
            try {
                const r = await fetchJson(CHAT_URL, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
                    body: JSON.stringify({
                        model: 'deepseek-flash',
                        messages,
                        max_tokens: 260,
                        temperature: 0.8,
                        thinking: { type: 'disabled' },
                    }),
                }, CHAT_TIMEOUT);
                if (!r.ok) {
                    console.error('[chat] CHAT-HTTP ' + r.status + ' ' + String(r.text || '').slice(0, 200));
                    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: false, error: `HTTP ${r.status}`, reply: NET_FALLBACK }));
                    return;
                }
                data = r.data;
            }
            catch (err) {
                // 超时/网络错误：用户看到的仍是原来的兜底文案，日志里留标签
                if (isTimeoutError(err))
                    console.error('[chat] CHAT-TIMEOUT ' + CHAT_TIMEOUT + 'ms 无响应，已中止');
                else
                    console.error('[chat] CHAT-NETWORK ' + String(err?.message || err));
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: isTimeoutError(err) ? 'timeout' : String(err?.message || err), reply: NET_FALLBACK }));
                return;
            }
            // content 为空时回退取 reasoning_content（照 C#）；两者都空就是真的走神了
            const content = String(data?.choices?.[0]?.message?.content || '').trim();
            const reasoning = String(data?.choices?.[0]?.message?.reasoning_content || '').trim();
            const blank = !content && !reasoning;
            const reply = content || reasoning || '主人……本鲸刚刚走神了。';
            // 鱼粮：token 统计
            try {
                const u = data?.usage;
                if (u && typeof u.total_tokens === 'number' && opts.addTokens)
                    opts.addTokens('chat', u.total_tokens);
            }
            catch { }
            // 空回复不写缓存（否则下次 '' 会被当成命中，一直复读空话）
            if (opts.cache && !imageB64 && cacheable && !blank) {
                try {
                    await opts.cache.setJson(cacheKey, { reply }, 'json', CHAT_CACHE_TTL);
                }
                catch { }
            }
            // 记忆写回：单轮原子追加，不再「读整份 history → 覆盖写」（并发两路会互相覆盖，/clear-memory 也会被写回）
            try {
                // index.ts 本批不改，store 把 appendTurns 挂在 saveHistory 上做兼容入口
                const appendTurns = opts.appendTurns || opts.saveHistory?.appendTurns;
                if (typeof appendTurns === 'function')
                    appendTurns(message, reply);
                else
                    console.error('[chat] MEMORY-APPEND-MISSING 没有 appendTurns，跳过记忆写入');
            }
            catch (err) {
                console.error('[chat] MEMORY-APPEND-ERR ' + String(err?.message || err));
            }
            // 亲密度 +1
            const st = opts.loadState();
            st.intimacy = Math.min(100, (Number(st.intimacy) || 0) + 1);
            opts.saveState(st);
            // 成长 +1（来源 chat，受日上限与来源上限约束，可能升级）
            let upgraded = false;
            try {
                if (opts.addExp) {
                    const g = opts.addExp(1, 'chat');
                    upgraded = Boolean(g && g.upgraded);
                    if (g && g.capped)
                        console.error('[chat] EXP-CAPPED source=chat exp=' + (Number(g.exp) || 0));
                }
            }
            catch { }
            // 每 10 次聊天压缩一次长期记忆：先把要用的东西全取出来，res.end 之后再让它在后台跑
            summaryCount = (summaryCount + 1) % 10;
            const wantSummary = summaryCount === 0 && history.length >= 6 && Boolean(opts.saveMemorySummary) && !summarizing;
            let convo = '';
            if (wantSummary) {
                const lines = history.slice(-14).map((m) => (m.role === 'user' ? '主人' : '肥鲸') + '：' + String(m.content || ''));
                lines.push('主人：' + message);
                lines.push('肥鲸：' + reply);
                convo = lines.join('\n');
            }
            const saveSummary = opts.saveMemorySummary;
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, reply: reply || '主人……本鲸刚刚走神了。', intimacy: st.intimacy, upgraded }));
            if (wantSummary && saveSummary) {
                summarizing = true;
                void summarizeMemory(key, convo, memSummary || '（无）', saveSummary)
                    .catch(() => { })
                    .finally(() => { summarizing = false; });
            }
        }
        catch (err) {
            try {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: String(err?.message || err), reply: '主人，本鲸卡住了（内部错误）……' }));
            }
            catch { }
        }
    };
}
