/**
 * host/routes/reminders.ts —— 提醒路由（可复用模块）
 */
import { readBody, isBodyTooLarge, sendTooLarge } from '../http.js';
/** 请求体上限：提醒只有 text/at/repeat 三个短字段，32KB 足够，超了直接 413 不读进内存 */
const REMINDER_MAX_BODY = 32 * 1024;
export function createReminderHandlers(opts) {
    async function handleReminders(req, res) {
        try {
            const url = new URL(req.url, 'http://x');
            if (req.method === 'GET') {
                const action = url.searchParams.get('action') || 'list';
                if (action === 'due') {
                    const due = opts.dueReminders();
                    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: true, due }));
                    return;
                }
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: true, reminders: opts.loadReminders() }));
                return;
            }
            if (req.method === 'POST') {
                // 走统一 readBody 带上限：原来直接 for-await 读 req，无上限
                let raw;
                try {
                    raw = await readBody(req, REMINDER_MAX_BODY);
                }
                catch (err) {
                    if (isBodyTooLarge(err)) {
                        console.error('[reminders] BODY-TOO-LARGE > ' + REMINDER_MAX_BODY + ' bytes');
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
                const msg = typeof body?.text === 'string' ? body.text.slice(0, 200) : '';
                const at = typeof body?.at === 'string' ? body.at : '';
                const repIn = Number(body?.repeat) || 0;
                // 重复间隔（秒）：只接受 1 分钟 ~ 7 天，其余按不重复处理
                const repeat = repIn >= 60 && repIn <= 86400 * 7 ? Math.round(repIn) : 0;
                if (!msg || !at || !Number.isFinite(new Date(at).getTime())) {
                    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: false, error: 'text and at required' }));
                    return;
                }
                const item = opts.addReminder(msg, at, repeat);
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: true, reminder: item }));
                return;
            }
            if (req.method === 'DELETE') {
                const id = url.searchParams.get('id') || '';
                if (id)
                    opts.removeReminder(id);
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: true }));
                return;
            }
            res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
        }
        catch (err) {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
        }
    }
    return { handleReminders };
}
