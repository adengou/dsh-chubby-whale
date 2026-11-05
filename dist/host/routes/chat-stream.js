/**
 * host/routes/chat-stream.ts —— 流式聊天（SSE）
 *
 * 目的：让肥鲸"边生成边开口"。原来必须等整段回复生成完才合成语音，
 * 用户感觉"说完话要等一两秒"；流式之后模型吐第一个字就能开始念。
 *
 * 协议（服务端 → 客户端，一行一条）：
 *   data: {"delta":"文字片段"}
 *   data: {"done":true,"reply":"完整回复","cached":false}
 *   data: {"error":"原因"}            // 失败时；客户端据此回退到普通 /chat
 *
 * 缓存与记忆行为与普通 /chat 一致：
 *   · 命中缓存：直接发一条 delta + done(cached:true)
 *   · 未命中：边转发边累积，结束时写缓存、写记忆、记 token
 */
import { readBody, isBodyTooLarge, sendTooLarge } from '../http.js';
import { chatCacheKey, recentHistory, HISTORY_IN_PROMPT, detectLang } from './chat.js';
import { shortHash } from '../cache.js';
import { parseSseBuffer } from '../../shared/sse.js';
const CHAT_URL = 'https://api.deepseek.com/chat/completions';
const CHAT_TIMEOUT = 30 * 1000;
const CHAT_CACHE_TTL = 7 * 24 * 3600 * 1000;
const CHAT_MAX_BODY = 6 * 1024 * 1024;
function normalizeLang(raw) {
    const s = String(raw || '').toLowerCase();
    return s.startsWith('en') ? 'en' : 'zh';
}
export function createChatStreamHandler(opts) {
    return async function handleChatStream(req, res) {
        // SSE 头：立刻发出，避免客户端等到第一个 token 才开始
        const started = Date.now();
        const send = (obj) => {
            try {
                res.write('data: ' + JSON.stringify(obj) + '\n\n');
            }
            catch { }
        };
        try {
            let raw;
            try {
                raw = await readBody(req, CHAT_MAX_BODY);
            }
            catch (err) {
                if (isBodyTooLarge(err)) {
                    sendTooLarge(res);
                    return;
                }
                throw err;
            }
            let body = {};
            try {
                body = JSON.parse(raw.toString('utf8') || '{}');
            }
            catch {
                body = {};
            }
            const message = String(body?.message || '').trim();
            const rawLang = (typeof body?.lang === 'string' && /^(zh|en|auto)$/.test(body.lang)) ? body.lang : 'auto';
            const lang = rawLang === 'auto' ? detectLang(message) : rawLang;
            const isVoice = !!body?.voice;
            if (!message) {
                res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
                send({ error: 'empty message' });
                res.end();
                return;
            }
            res.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-store',
                connection: 'keep-alive',
                'x-accel-buffering': 'no',
            });
            // 立刻把 SSE 头刷出去，客户端不必等首帧；同时记录客户端断开
            try {
                res.flushHeaders && res.flushHeaders();
            }
            catch { }
            let clientGone = false;
            try {
                if (typeof res.on === 'function')
                    res.on('close', () => { clientGone = true; });
            }
            catch { }
            // 先读上下文：缓存 key 带上下文指纹；prompt 只带最近几条（省 token）
            const memSummary = (() => { try {
                return String(opts.loadMemorySummary ? opts.loadMemorySummary() : '');
            }
            catch {
                return '';
            } })();
            let history = [];
            try {
                history = opts.loadHistory() || [];
            }
            catch {
                history = [];
            }
            const prevUser = recentHistory(history, HISTORY_IN_PROMPT).filter((m) => m && m.role === 'user').slice(-1)[0];
            const ctxFp = (() => { try {
                return shortHash(memSummary) + '|' + shortHash(String((prevUser && prevUser.content) || ''));
            }
            catch (e) {
                return '';
            } })();
            const cacheOn = !opts.cacheEnabled || opts.cacheEnabled() !== false;
            const cacheKey = chatCacheKey(lang, message, isVoice, ctxFp);
            // 与普通 /chat 一致：太短的消息不缓存
            const cacheable = message.length >= (isVoice ? 2 : 6);
            if (opts.cache && cacheOn && cacheable) {
                try {
                    const hit = await opts.cache.getJson(cacheKey, 'json', CHAT_CACHE_TTL);
                    if (hit && typeof hit.reply === 'string' && hit.reply) {
                        send({ delta: hit.reply });
                        send({ done: true, reply: hit.reply, cached: true, ms: Date.now() - started });
                        res.end();
                        return;
                    }
                }
                catch { }
            }
            const key = opts.getKey();
            if (!key) {
                send({ error: 'NO_KEY' });
                res.end();
                return;
            }
            const messages = [{ role: 'system', content: opts.systemPrompt + (lang === 'en' ? '\n【Language】Answer in English.' : '\n【语言规则】主人用中文提问，请用中文回答。') + (memSummary ? ('\n（关于主人的长期记忆：' + memSummary + '）') : '') }];
            for (const m of recentHistory(history, HISTORY_IN_PROMPT)) {
                if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
                    messages.push({ role: m.role, content: m.content });
            }
            messages.push({ role: 'user', content: message });
            const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const timer = ctl ? setTimeout(() => { try {
                ctl.abort();
            }
            catch { } }, CHAT_TIMEOUT) : null;
            let upstream = null;
            try {
                upstream = await fetch(CHAT_URL, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
                    body: JSON.stringify({
                        model: 'deepseek-flash',
                        messages,
                        max_tokens: 260,
                        temperature: 0.8,
                        thinking: { type: 'disabled' },
                        stream: true,
                        stream_options: { include_usage: true },
                    }),
                    signal: ctl ? ctl.signal : undefined,
                });
            }
            catch (err) {
                if (timer)
                    clearTimeout(timer);
                send({ error: 'connect: ' + String(err?.message || err) });
                res.end();
                return;
            }
            if (!upstream.ok || !upstream.body) {
                if (timer)
                    clearTimeout(timer);
                send({ error: 'HTTP ' + upstream.status });
                res.end();
                return;
            }
            let aborted = false;
            const reader = upstream.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            let reply = '';
            let usage = null;
            let firstDeltaAt = 0;
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done)
                        break;
                    buf += dec.decode(value, { stream: true });
                    const parsed = parseSseBuffer(buf);
                    buf = parsed.rest;
                    for (const j of parsed.events) {
                        const delta = j?.choices?.[0]?.delta?.content;
                        if (typeof delta === 'string' && delta) {
                            if (!firstDeltaAt)
                                firstDeltaAt = Date.now();
                            reply += delta;
                            send({ delta });
                        }
                        if (j?.usage)
                            usage = j.usage;
                    }
                }
            }
            catch (err) {
                aborted = true;
                send({ error: 'stream: ' + String(err?.message || err) });
            }
            finally {
                if (timer)
                    clearTimeout(timer);
            }
            // 流中断或客户端已断开：这段回复是半截的，绝不能写进缓存和记忆（否则被永久命中）
            if (aborted || clientGone) {
                try {
                    res.end();
                }
                catch { }
                ;
                return;
            }
            const text = reply.trim() || '主人……本鲸刚刚走神了。';
            // 收尾：写缓存 / 记忆 / token（与普通 /chat 同口径）
            if (opts.cache && cacheOn && cacheable && reply.trim()) {
                try {
                    await opts.cache.setJson(cacheKey, { reply: text }, 'json', CHAT_CACHE_TTL);
                }
                catch { }
            }
            try {
                const u = usage;
                if (u && typeof u.total_tokens === 'number' && opts.addTokens)
                    opts.addTokens('chat', u.total_tokens);
            }
            catch { }
            try {
                if (typeof opts.appendTurns === 'function')
                    opts.appendTurns(message, text);
            }
            catch { }
            send({ done: true, reply: text, cached: false, firstDeltaMs: firstDeltaAt ? firstDeltaAt - started : 0, ms: Date.now() - started });
            res.end();
        }
        catch (err) {
            try {
                send({ error: String(err?.message || err) });
                res.end();
            }
            catch { }
        }
    };
}
