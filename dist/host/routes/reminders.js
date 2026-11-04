/**
 * host/routes/reminders.ts —— 提醒路由（可复用模块）
 */
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
                const chunks = [];
                for await (const chunk of req)
                    chunks.push(chunk);
                const text = Buffer.concat(chunks).toString('utf8');
                let body = {};
                try {
                    body = text ? JSON.parse(text) : {};
                }
                catch {
                    body = {};
                }
                const msg = typeof body?.text === 'string' ? body.text.slice(0, 200) : '';
                const at = typeof body?.at === 'string' ? body.at : '';
                if (!msg || !at) {
                    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: false, error: 'text and at required' }));
                    return;
                }
                const item = opts.addReminder(msg, at);
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
