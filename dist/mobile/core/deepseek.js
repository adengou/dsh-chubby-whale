// @ts-nocheck
/**
 * 手机简版的模型适配层（deepseek 直连）
 *
 * 为什么不用 ctx.llm：dsh-chubby-whale 本身就不走宿主的 llm 服务，
 * 它直接用自己 config.json 里的 Key 调 https://api.deepseek.com/chat/completions。
 * 手机简版既然是它的附属，就复用它同一套 Key / 模型配置，口径一致、少一处配置。
 */
import { DEEPSEEK_CHAT_URL as CHAT_URL } from '../../shared/deepseek.js';
const DEFAULT_TIMEOUT_MS = 60000;
function msgOf(err) {
    if (!err)
        return '未知错误';
    if (typeof err === 'string')
        return err;
    return err.message || String(err);
}
export function createDeepSeek({ apiKey, model, baseUrl = CHAT_URL }) {
    async function* stream(request = {}) {
        if (!apiKey) {
            yield {
                type: 'error',
                message: '缺少 DeepSeek API Key：请在 dsh-chubby-whale 的 config.json 里配置 apiKey（或环境变量），手机简版与桌宠共用同一份配置。',
            };
            return;
        }
        const messages = [
            ...(request.system ? [{ role: 'system', content: String(request.system) }] : []),
            ...(request.messages || []).map((m) => ({
                role: m && m.role === 'assistant' ? 'assistant' : 'user',
                content: String((m && m.text) ?? ''),
            })),
        ];
        const body = { model, stream: true, messages };
        if (Number(request.maxTokens) > 0)
            body.max_tokens = Number(request.maxTokens);
        if (request.temperature !== undefined && request.temperature !== null)
            body.temperature = Number(request.temperature);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
        const onAbort = () => controller.abort();
        if (request.signal)
            request.signal.addEventListener('abort', onAbort);
        let text = '';
        try {
            const res = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            if (!res.ok) {
                const detail = await res.text().catch(() => '');
                yield { type: 'error', message: `模型接口返回 ${res.status}：${String(detail).slice(0, 300)}` };
                return;
            }
            if (!res.body) {
                yield { type: 'error', message: '模型接口没有返回数据流' };
                return;
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                let nl = buffer.indexOf('\n');
                while (nl >= 0) {
                    const line = buffer.slice(0, nl).trim();
                    buffer = buffer.slice(nl + 1);
                    if (line.startsWith('data:')) {
                        const payload = line.slice(5).trim();
                        if (payload && payload !== '[DONE]') {
                            try {
                                const json = JSON.parse(payload);
                                const delta = json?.choices?.[0]?.delta?.content;
                                if (typeof delta === 'string' && delta.length > 0) {
                                    text += delta;
                                    yield { type: 'delta', text: delta };
                                }
                            }
                            catch {
                                /* 半包或非 JSON 行，跳过 */
                            }
                        }
                    }
                    nl = buffer.indexOf('\n');
                }
            }
        }
        catch (err) {
            if (err && err.name === 'AbortError') {
                yield { type: 'error', message: '请求超时或已取消' };
            }
            else {
                yield { type: 'error', message: `模型请求失败：${msgOf(err)}` };
            }
            return;
        }
        finally {
            clearTimeout(timer);
            if (request.signal)
                request.signal.removeEventListener('abort', onAbort);
        }
        if (text.length === 0) {
            yield { type: 'error', message: '模型没有返回内容' };
            return;
        }
        yield { type: 'done', text };
    }
    async function generate(request = {}) {
        let text = '';
        for await (const event of stream(request)) {
            if (event.type === 'delta')
                text += event.text;
            else if (event.type === 'error')
                throw new Error(event.message);
            else if (event.type === 'done')
                text = event.text;
        }
        return text;
    }
    return Object.freeze({
        stream,
        generate,
        route: () => ({ provider: 'deepseek-direct', model }),
    });
}
