/**
 * host/routes/feedback.ts —— 意见反馈接收路由
 *
 * 只做三件事：校验文本 → 交给 deliverFeedback（先落盘、有凭据才发信）→ 如实回执。
 * **绝不回传收件邮箱**：前端与响应里都看不到它，邮箱只活在 host 侧配置中。
 */
import { sendJson } from '../respond.js';
import { deliverFeedback } from '../feedback/send.js';
/** 单条反馈字数上限（够写清问题，也不至于把邮件撑爆） */
const MAX_FEEDBACK_CHARS = 4000;
export function createFeedbackHandler(opts) {
    async function handleFeedback(req, res) {
        const method = String((req && req.method) || 'POST').toUpperCase();
        if (method !== 'POST') {
            sendJson(res, { ok: false, error: 'method not allowed' }, 405);
            return;
        }
        try {
            const body = await readJsonBody(req);
            const raw = String((body && body.text) || '').trim();
            if (!raw) {
                sendJson(res, { ok: false, error: '反馈内容不能为空' }, 400);
                return;
            }
            // 按码点截断：不让 4000 个 emoji 把 8000 个代理项写进文件/邮件
            const text = Array.from(raw).slice(0, MAX_FEEDBACK_CHARS).join('');
            const result = await deliverFeedback({
                text,
                at: Date.now(),
                runtimeDir: opts.runtimeDir,
                smtp: safeLoad(opts.loadSmtp),
            });
            // 回执只给「是否发信 / 是否落盘」，不带任何收件人信息
            sendJson(res, { ok: result.ok, sent: result.sent, error: result.error || '' });
        }
        catch (err) {
            sendJson(res, { ok: false, error: String((err && err.message) || err).slice(0, 120) });
        }
    }
    return { handleFeedback };
}
/** 读请求体（限制体积，防止恶意大包） */
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > 64 * 1024) {
                reject(new Error('body too large'));
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolve(raw ? JSON.parse(raw) : {});
            }
            catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}
/** 配置读取失败一律按「没有凭据」处理，绝不让读配置把路由打挂 */
function safeLoad(fn) {
    try {
        return fn();
    }
    catch (e) {
        return null;
    }
}
