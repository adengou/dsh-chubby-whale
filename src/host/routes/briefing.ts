/**
 * host/routes/briefing.ts —— 今日简报路由（可复用模块）
 * 内容：日期/星期 + 北海天气（wttr.in）+ 提醒数 + 成长阶段
 * 注意：当前前端未使用，保留备查（C# 版已砍掉每日简报，菜单不再调用）
 */
import { growthStage } from '../store.js'

export function createBriefingHandlers(opts: {
  loadGrowth: () => any
  loadReminders: () => any[]
}) {
  async function handleBriefing(_req: any, res: any): Promise<void> {
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
    // 成长
    try {
      const g = opts.loadGrowth()
      const st = growthStage(Number(g.exp) || 0)
      parts.push('肥鲸成长：' + st.name + '（' + (Number(g.exp) || 0) + '）')
    } catch { }
    // 提醒
    try {
      const rs = opts.loadReminders() || []
      const pending = rs.filter((r: any) => !r.done).length
      parts.push('待办提醒：' + pending + ' 条')
    } catch { }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, text: parts.join('\n') }))
  }

  return { handleBriefing }
}
