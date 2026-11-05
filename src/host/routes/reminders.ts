/**
 * host/routes/reminders.ts —— 提醒路由（可复用模块）
 * HTTP 层只做参数校验与响应；增删/到期判断由注入的提醒端口提供。
 */
import { sendTooLarge } from '../http.js'
import { readJsonBody } from '../body.js'
import { sendJson, sendError } from '../respond.js'

/** 请求体上限：提醒只有 text/at/repeat 三个短字段，32KB 足够，超了直接 413 不读进内存 */
const REMINDER_MAX_BODY = 32 * 1024

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
          sendJson(res, { ok: true, due: opts.dueReminders() })
          return
        }
        sendJson(res, { ok: true, reminders: opts.loadReminders() })
        return
      }
      if (req.method === 'POST') {
        // 走统一 readJsonBody 带上限与 JSON 解析：原来直接 for-await 读 req，无上限
        const parsed = await readJsonBody(req, REMINDER_MAX_BODY)
        if (!parsed.ok) {
          console.error('[reminders] BODY-TOO-LARGE > ' + REMINDER_MAX_BODY + ' bytes')
          sendTooLarge(res)
          return
        }
        const body = parsed.body
        const msg = typeof body?.text === 'string' ? body.text.slice(0, 200) : ''
        const at = typeof body?.at === 'string' ? body.at : ''
        const repIn = Number(body?.repeat) || 0
        // 重复间隔（秒）：只接受 1 分钟 ~ 7 天，其余按不重复处理
        const repeat = repIn >= 60 && repIn <= 86400 * 7 ? Math.round(repIn) : 0
        if (!msg || !at || !Number.isFinite(new Date(at).getTime())) {
          sendJson(res, { ok: false, error: 'text and at required' }, 400)
          return
        }
        sendJson(res, { ok: true, reminder: opts.addReminder(msg, at, repeat) })
        return
      }
      if (req.method === 'DELETE') {
        const id = url.searchParams.get('id') || ''
        if (id) opts.removeReminder(id)
        sendJson(res, { ok: true })
        return
      }
      sendJson(res, { ok: false, error: 'method not allowed' }, 405)
    } catch (err: any) {
      sendError(res, err)
    }
  }

  return { handleReminders }
}
