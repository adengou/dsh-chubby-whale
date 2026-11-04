/**
 * host/routes/reminders.ts —— 提醒路由（可复用模块）
 */
export function createReminderHandlers(opts: {
  loadReminders: () => any[]
  addReminder: (text: string, at: string, repeat?: number) => any
  dueReminders: () => any[]
  removeReminder: (id: string) => void
}) {
  async function handleReminders(req: any, res: any): Promise<void> {
    try {
      const url = new URL(req.url, 'http://x')
      if (req.method === 'GET') {
        const action = url.searchParams.get('action') || 'list'
        if (action === 'due') {
          const due = opts.dueReminders()
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, due }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, reminders: opts.loadReminders() }))
        return
      }
      if (req.method === 'POST') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        const text = Buffer.concat(chunks).toString('utf8')
        let body: any = {}
        try { body = text ? JSON.parse(text) : {} } catch { body = {} }
        const msg = typeof body?.text === 'string' ? body.text.slice(0, 200) : ''
        const at = typeof body?.at === 'string' ? body.at : ''
        const repIn = Number(body?.repeat) || 0
        // 重复间隔（秒）：只接受 1 分钟 ~ 7 天，其余按不重复处理
        const repeat = repIn >= 60 && repIn <= 86400 * 7 ? Math.round(repIn) : 0
        if (!msg || !at || !Number.isFinite(new Date(at).getTime())) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: 'text and at required' }))
          return
        }
        const item = opts.addReminder(msg, at, repeat)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, reminder: item }))
        return
      }
      if (req.method === 'DELETE') {
        const id = url.searchParams.get('id') || ''
        if (id) opts.removeReminder(id)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
    } catch (err: any) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }))
    }
  }

  return { handleReminders }
}
