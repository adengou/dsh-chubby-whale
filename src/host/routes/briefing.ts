/**
 * host/routes/briefing.ts —— 今日简报路由（可复用模块）
 * 内容：日期/星期 + 北海天气（wttr.in）+ 提醒数 + 成长阶段
 *
 * 调用方：菜单动作「今日简报」（client/actions/content.ts 的 briefing-card → getJson('/briefing')），
 * 回包形状固定为 { ok, text }，客户端按行切成「日期/天气/成长」与「待办」两段。
 * 只读：只认 GET/HEAD；非 GET 回 405，也不会因为一次误调去外呼天气。
 *
 * 两段切分是**按行 + 关键词**做的（client/actions/content.ts 的 parseBriefing：
 * 含「待办/提醒」的行归第二段），所以天气段必须是干净的单行短文本——见 cleanWeather。
 * 天气每次真实外呼（6s 超时），不做同实例缓存：缓存要经注入的缓存端口 + 改装配层，本批不动。
 */
import { growthStage } from '../../shared/growth.js'
import { sendJson } from '../respond.js'

/** 非负整数（经验展示与 /growth 同口径：NaN/负数/小数归零或取整） */
function nonNegInt(value: any): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** 天气外呼超时：wttr.in 偶发很慢，到点就放掉，简报其它段不能陪它等 */
const WEATHER_TIMEOUT_MS = 6000

/** 天气段上限（按「字」= Unicode 码点）：正常只回十来个字，超长几乎都是错误页/HTML */
const WEATHER_MAX_CHARS = 40

/**
 * 天气段清洗：压成单行 + 去控制字符 + 剥掉「待办/提醒」字样 + 按码点截断。
 *
 * 为什么必须做（客户端契约决定，不是美化）：
 *   · parseBriefing 按行切两段，**任何**含「待办/提醒」的行都会被归到第二段；
 *     wttr.in 出问题时会回多行错误页/HTML，原样拼进 text 就会凭空多出一个「待办」段、
 *     或者把日期/天气整行顶掉；
 *   · 正常回包也就十几个字，但错误页可能几百 KB——不截断会撑爆气泡与朗读（TTS 逐字念）。
 * 按码点截断，避免切出半个 emoji（与 host/personality/merge.ts 的 clampText 同一做法）。
 */
function cleanWeather(raw: any): string {
  const single = String(raw == null ? '' : raw)
    // 控制字符（含 \r \n \t）、零宽字符、行/段分隔符统一当空白
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // 天气描述里出现这两个词没有正当理由，留着会污染两段切分
  const safe = single.replace(/待办|提醒/g, ' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(safe)
  return chars.length > WEATHER_MAX_CHARS ? chars.slice(0, WEATHER_MAX_CHARS).join('') : safe
}

/**
 * 取当前时间：优先用注入的时钟（与 routes/daily.ts 的 now 端口同一写法），
 * 缺省用本地当前时间。注入值不是有效 Date / 抛错时回落到真实时钟——
 * 简报是只读展示，不能因为时钟实现坏了整份消失。
 */
function safeNow(fn?: () => Date): Date {
  if (typeof fn === 'function') {
    try {
      const d: any = fn()
      const ms = d && typeof d.getTime === 'function' ? d.getTime() : NaN
      if (Number.isFinite(ms)) return new Date(ms)
    } catch { }
  }
  return new Date()
}

export function createBriefingHandlers(opts: {
  loadGrowth: () => any
  loadReminders: () => any[]
  /**
   * 可注入时钟（可选）：跨天/跨年/时区相关的断言不再依赖真实系统时间。
   * 缺省即 `() => new Date()`（本地时区，与 daily.ts 的 todayKey / 鱼粮跨天同一口径）。
   */
  now?: () => Date
}) {
  async function handleBriefing(req: any, res: any): Promise<void> {
    const method = req && req.method ? String(req.method).toUpperCase() : 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405)
      return
    }
    const parts: string[] = []
    try {
      const now = safeNow(opts.now)
      const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()]
      parts.push(now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日 星期' + week)
    } catch { }
    // 天气（清洗/截断后只留一行；失败/超时/非 2xx 就不出这段）
    try {
      const w = await fetch('https://wttr.in/Beihai?format=%C+%t&lang=zh-cn', { signal: AbortSignal.timeout(WEATHER_TIMEOUT_MS) })
      if (w && w.ok) {
        const txt = cleanWeather(await w.text())
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
    //
    // 2026-11-07（主人反馈「说了提醒，简报里也没有这条」）：原来只报条数，看不到是哪件事。
    // 现在除了条数，再按到点时间列出最近 3 条的任务正文（只列盘上真实存在的，不编）。
    try {
      const rs = opts.loadReminders()
      if (Array.isArray(rs)) {
        const pendingList = rs
          .filter((r: any) => Boolean(r) && !r.done)
          .map((r: any) => {
            const raw = r.nextAt || r.at
            const ms = new Date(raw).getTime()
            return { text: String(r.text || '').trim(), ms: Number.isFinite(ms) ? ms : Infinity }
          })
          .filter((x: any) => Boolean(x.text))
          .sort((a: any, b: any) => a.ms - b.ms)
        parts.push('待办提醒：' + rs.filter((r: any) => Boolean(r) && !r.done).length + ' 条')
        const nowMs = safeNow(opts.now).getTime()
        const top = pendingList.slice(0, 3).map((x: any) => {
          if (!Number.isFinite(x.ms)) return x.text
          const d = new Date(x.ms)
          const hh = String(d.getHours()).padStart(2, '0')
          const mm = String(d.getMinutes()).padStart(2, '0')
          const today = safeNow(opts.now)
          const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
          // 只标「今天/明天」，更远的写日期：避免主人把明天的 9 点看成今天 9 点
          const diffDays = Math.round((
            new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
            - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
          ) / 86400000)
          const dayWord = diffDays === 0 ? '今天' : (diffDays === 1 ? '明天' : ((d.getMonth() + 1) + '月' + d.getDate() + '日'))
          return dayWord + hh + ':' + mm + ' ' + x.text
        })
        if (top.length) parts.push('待办：' + top.join('；'))
        void nowMs
      }
    } catch { }
    sendJson(res, { ok: true, text: parts.join('\n') })
  }

  return { handleBriefing }
}
