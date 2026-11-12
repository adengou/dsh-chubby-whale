/**
 * host/routes/proofread.ts —— 公文校对（独立路由）
 *
 * 为什么不复用 /chat：校对是一次性任务，不该写进聊天记忆、不该计亲密度/鱼粮，
 * 也不该被聊天缓存（按消息文本 hash）串味。这里只借配置里的 Key 和模型名，
 * 拼一条系统指令直接外呼，把模型回的问题清单原样交回客户端。
 */
import { fetchJson, sendTooLarge } from '../http.js';
import { readJsonBody } from '../body.js';
import { sendJson } from '../respond.js';
import { CHAT_URL } from '../chat-core.js';
/** 单次校对文本上限：一份材料正文通常 3000~6000 字，留一点余量 */
const MAX_TEXT = 8000;
const MAX_BODY = 256 * 1024;
const TIMEOUT_MS = 90 * 1000;
const MAX_TOKENS = 2000;
const SYSTEM_PROMPT = [
    '你是一名严谨的中文公文校对员。只做校对，不改写全文。',
    '逐条列出下面文本中的问题，每条一行，格式：',
    '- [类型] 原文片段 → 问题说明（可选：建议改法）',
    '类型限定为：错别字、标点、序号、格式、语病、事实存疑。',
    '没有问题的类型不要凑数；整段没问题就回一句「未发现问题」。',
    '不要输出开场白、总结或鼓励性的话。',
].join('\n');
export function createProofreadHandler(deps) {
    return async function handleProofread(req, res) {
        const parsed = await readJsonBody(req, MAX_BODY);
        if (!parsed.ok) {
            sendTooLarge(res);
            return;
        }
        const text = String(parsed.body?.text || '').trim();
        if (!text) {
            sendJson(res, { ok: false, error: 'empty text' }, 400);
            return;
        }
        if (text.length > MAX_TEXT) {
            sendJson(res, { ok: false, error: 'text too large', limit: MAX_TEXT }, 413);
            return;
        }
        const key = deps.key();
        if (!key) {
            sendJson(res, { ok: false, error: 'no key' }, 503);
            return;
        }
        try {
            const r = await fetchJson(CHAT_URL, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
                body: JSON.stringify({
                    model: deps.model,
                    messages: [
                        { role: 'system', content: SYSTEM_PROMPT },
                        { role: 'user', content: text },
                    ],
                    max_tokens: MAX_TOKENS,
                    temperature: 0.2,
                    thinking: { type: 'disabled' },
                }),
            }, TIMEOUT_MS);
            if (!r.ok) {
                sendJson(res, { ok: false, error: 'HTTP ' + r.status }, 502);
                return;
            }
            const result = String(r.data?.choices?.[0]?.message?.content || '').trim();
            sendJson(res, { ok: true, result });
        }
        catch (e) {
            sendJson(res, { ok: false, error: String((e && e.message) || e) }, 502);
        }
    };
}
