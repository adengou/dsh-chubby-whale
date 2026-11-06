/**
 * host/routes/briefing.ts —— 今日简报路由（可复用模块）
 * 内容：日期/星期 + 北海天气（wttr.in）+ 提醒数 + 成长阶段
 *
 * 调用方：菜单动作「今日简报」（client/actions/content.ts 的 briefing-card → getJson('/briefing')），
 * 回包形状固定为 { ok, text }，客户端按行切成「日期/天气/成长」与「待办」两段。
 * 只读：只认 GET/HEAD；非 GET 回 405，也不会因为一次误调去外呼天气。
 */
import { growthStage } from '../../shared/growth.js'
import { sendJson } from '../respond.js'

/** 非负整数（经验展示与 /growth 同口径：NaN/负数/小数归零或取整） */
function nonNegInt(value: any): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export function createBriefingHandlers(opts: {
  loadGrowth: () => any
  loadReminders: () => any[]
}) {
  async function handleBriefing(req: any, res: any): Promise<void> {
    const method = req && req.method ? String(req.method).toUpperCase() : 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405)
      return
    }
    const parts: string[] = []
    try {
      const now = new Date()
      const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()]
      parts.push(now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日 星期' + week)
    } catch { }
    // 天气
    try {
      const w = await fetch('https://wttr.in/Beihai?format=%C+%t&lang=zh', { signal: AbortSignal.timeout(6000) })
      if (w.ok) {
        const txt = (await w.text()).trim()
        if (txt) parts.push('北海天气：' + txt)
      }
    } catch { }
    // 成长（与 /growth 同口径：非负整数；g 为 null/怪值时不陪葬其它段）
    try {
      const g = opts.loadGrowth() || {}
      const exp = nonNegInt(g.exp)
      const st = growthStage(exp)
      parts.push('肥鲸成长：' + st.name + '（' + exp + '）')
    } catch { }
    // 提醒（非数组说明读不到，就别编一个"0 条"；坏项丢弃，好项照数）
    try {
      const rs = opts.loadReminders()
      if (Array.isArray(rs)) {
        const pending = rs.filter((r: any) => Boolean(r) && !r.done).length
        parts.push('待办提醒：' + pending + ' 条')
      }
    } catch { }
    sendJson(res, { ok: true, text: parts.join('\n') })
  }

  return { handleBriefing }
}
