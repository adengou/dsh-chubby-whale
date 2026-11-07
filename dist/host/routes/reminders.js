/**
 * host/routes/reminders.ts —— 提醒路由（可复用模块）
 * HTTP 层只做参数校验与响应；增删/到期判断由注入的提醒端口提供。
 *
 * 路由层定死的三件事（端口只做仓储，不替路由兜输入）：
 *   · text 最多 200「字」，按 Unicode 码点截断——绝不切出孤立代理项（半个 emoji）；
 *   · at 能解析成真实时间后**统一落成 UTC ISO**（绝对时刻不随宿主时区/换机器漂移，
 *     长度 ≤ 40，与备份导入 BACKUP_LIMITS.reminderStampLen 同口径）；
 *   · 方法错误回 405 + METHOD_NOT_ALLOWED，与简报/配置/统计等路由同一错误码。
 */
import { sendTooLarge } from '../http.js';
import { readJsonBody } from '../body.js';
import { sendJson, sendError } from '../respond.js';
/** 请求体上限：提醒只有 text/at/repeat 三个短字段，32KB 足够，超了直接 413 不读进内存 */
const REMINDER_MAX_BODY = 32 * 1024;
/** 正文上限（按「字」= Unicode 码点计，与备份导入的 reminderTextLen 同口径） */
const REMINDER_TEXT_MAX = 200;
/**
 * 按码点截断正文。
 * 旧实现 `body.text.slice(0, 200)` 按 UTF-16 码元切：199 个字符 + 一个 emoji 时，
 * 第 200 个码元恰好是代理对的前半截 → 落盘成孤立代理项（列表/气泡显示成乱码，
 * JSON 里也只剩 "\ud83d"）。这里先 Array.from 拆成码点再拼，超长不切坏字。
 */
function clipText(text) {
    const chars = Array.from(text);
    return chars.length > REMINDER_TEXT_MAX ? chars.slice(0, REMINDER_TEXT_MAX).join('') : text;
}
/**
 * at 落库规范化：能解析成真实时间才收，收下就统一转成 UTC ISO。
 *
 * 只校验不规范化的问题（实测）：
 *   · `Wed Nov 04 2026 09:00:00 GMT+0800 (中国标准时间)`（Date.toString()，42 字）本身
 *     **不带机器可读时区**，原样落盘后 dueReminders 再用 new Date(stamp) 解析——换宿主时区
 *     /换机器（备份恢复到别的机器、跨平台）就不是同一个绝对时刻了；
 *   · `2026-11-04T09:00:00+08:00` 这类带偏移的写法各写各的格式，列表里口径不一；
 *   · 长度不受控（42 字 vs 备份导入侧对 at 的 40 字上限）。
 * toISOString() 恒为 UTC（≤27 字，含扩展年份），与备份导入同口径；无法解析返回 null → 400。
 */
function canonicalAt(raw) {
    const ms = new Date(raw).getTime();
    if (!Number.isFinite(ms))
        return null;
    try {
        const iso = new Date(ms).toISOString();
        return iso.length <= 40 ? iso : null;
    }
    catch {
        return null;
    }
}
export function createReminderHandlers(opts) {
    async function handleReminders(req, res) {
        try {
            const url = new URL(req.url, 'http://x');
            if (req.method === 'GET') {
                const action = url.searchParams.get('action') || 'list';
                if (action === 'due') {
                    sendJson(res, { ok: true, due: opts.dueReminders() });
                    return;
                }
                sendJson(res, { ok: true, reminders: opts.loadReminders() });
                return;
            }
            if (req.method === 'POST') {
                // 走统一 readJsonBody 带上限与 JSON 解析：原来直接 for-await 读 req，无上限
                const parsed = await readJsonBody(req, REMINDER_MAX_BODY);
                if (!parsed.ok) {
                    console.error('[reminders] BODY-TOO-LARGE > ' + REMINDER_MAX_BODY + ' bytes');
                    sendTooLarge(res);
                    return;
                }
                const body = parsed.body;
                const msg = typeof body?.text === 'string' ? clipText(body.text) : '';
                const rawAt = typeof body?.at === 'string' ? body.at : '';
                const at = rawAt ? canonicalAt(rawAt) : null;
                const repIn = Number(body?.repeat) || 0;
                // 重复间隔（秒）：只接受 1 分钟 ~ 7 天，其余按不重复处理
                const repeat = repIn >= 60 && repIn <= 86400 * 7 ? Math.round(repIn) : 0;
                if (!msg || !at) {
                    sendJson(res, { ok: false, error: 'text and at required' }, 400);
                    return;
                }
                sendJson(res, { ok: true, reminder: opts.addReminder(msg, at, repeat) });
                return;
            }
            if (req.method === 'DELETE') {
                const id = url.searchParams.get('id') || '';
                if (id)
                    opts.removeReminder(id);
                sendJson(res, { ok: true });
                return;
            }
            sendJson(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
        }
        catch (err) {
            sendError(res, err);
        }
    }
    return { handleReminders };
}
