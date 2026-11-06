/**
 * client/reminder-manage.ts —— 提醒管理面板（纯流程，可在 Node 里离线单测）
 *
 * 原来「提醒清单…」只列不删。这里把清单收成一块可操作的面板：
 *   · 打开后列出序号，气泡里提示「回数字可删除 / 回 d 顺延 10 分钟」；
 *   · 面板最近打开 60 秒内，下一条输入（聊天框打字 / 语音识别结果）先交给这里：
 *       纯数字 → DELETE /reminders?id=<id>
 *       d      → 把最近到期的提醒顺延 10 分钟
 *   · 超过 60 秒一律放行，避免把正常对话吞掉；
 *   · 顺延没有改期接口（host 只支持 DELETE / POST），所以用「先添加新时间、再删除旧条目」
 *     实现：添加失败时原提醒还在，绝不因一次顺延把主人的提醒弄丢。
 *
 * 本模块只管流程与文案；取数、气泡全部由 host 注入，方便离线验证。
 */

import { getJson, postJson, delJson } from './http.js'

/** 面板有效窗：最近打开后 60 秒内才接住数字输入 */
export const MANAGE_WINDOW_MS = 60000

/** 顺延时长：10 分钟 */
export const POSTPONE_MS = 10 * 60 * 1000

/** 面板操作提示（气泡文案，与需求逐字对应） */
export const MANAGE_HINT = '回复数字可删除 / 回 d 顺延 10 分钟'

/** 面板宿主能力（client.ts 注入；getJson 等缺省用 client/http.ts 的实现） */
export type ManageHost = {
  bubble: (text: string, ms?: number) => void
  getJson?: (path: string, init?: any) => Promise<any>
  postJson?: (path: string, body?: any, init?: any) => Promise<any>
  delJson?: (path: string, init?: any) => Promise<any>
  /** 测试注入时钟；生产默认 Date.now */
  now?: () => number
}

/** 面板里的一条提醒（只保留展示与顺延需要的字段） */
export type ManageItem = {
  id: string
  text: string
  at: any
  nextAt?: any
  repeat?: number | null
}

/** 解析后的管理指令 */
export type ManageInput =
  | { kind: 'delete'; index: number }
  | { kind: 'postpone' }
  | null

/**
 * 归一化输入：去掉空白与常见标点（语音识别常带句号/逗号），字母统一小写。
 * 只用于判断「是不是管理指令」，不改动交给聊天的原文。
 */
export function normalizeManageInput(text: unknown): string {
  return String(text == null ? '' : text)
    .replace(/[\s。，、！？；：,.!?;:…~～·"'“”‘’（）()【】\[\]]/g, '')
    .toLowerCase()
}

/** 纯数字 → 删除第 N 条；d → 顺延；其余返回 null（放行给聊天） */
export function parseManageInput(text: unknown): ManageInput {
  const t = normalizeManageInput(text)
  if (!t) return null
  if (/^\d{1,3}$/.test(t)) return { kind: 'delete', index: Number(t) }
  if (t === 'd') return { kind: 'postpone' }
  return null
}

/** 本地时分（补零），顺延成功的气泡要用「顺延到 xx:xx」 */
export function formatClock(at: any): string {
  const d = new Date(at)
  if (isNaN(d.getTime())) return '--:--'
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return hh + ':' + mm
}

/** 清单里显示的时间：照旧用中文 locale，坏时间原样回退 */
function stampOf(item: ManageItem): string {
  const raw = item.nextAt || item.at
  const d = new Date(raw)
  if (isNaN(d.getTime())) return String(raw == null ? '' : raw)
  try { return d.toLocaleString('zh-CN') } catch (e) { return formatClock(d) }
}

/** 清单气泡文本：序号 + 正文 + 时间（+ 重复标记），末尾固定跟操作提示 */
export function boardText(items: ManageItem[], prefix?: string): string {
  const lines = items.map((it, i) => {
    const rep = Number(it.repeat) > 0 ? '（重复）' : ''
    return (i + 1) + '. ' + it.text + '（' + stampOf(it) + '）' + rep
  })
  const head = prefix ? prefix + '\n' : ''
  if (!lines.length) return head + '没有提醒了'
  return head + lines.join('\n') + '\n' + MANAGE_HINT
}

/** 把 /reminders 响应收成面板条目：坏条目、已完成的条目跳过 */
export function normalizeReminderList(payload: any): ManageItem[] {
  const arr = Array.isArray(payload && payload.reminders)
    ? payload.reminders
    : (Array.isArray(payload) ? payload : [])
  const out: ManageItem[] = []
  for (const x of arr) {
    if (!x || typeof x !== 'object') continue
    if (x.done === true) continue
    const id = String(x.id == null ? '' : x.id)
    if (!id) continue
    out.push({
      id,
      text: String(x.text == null ? '' : x.text),
      at: x.at,
      nextAt: x.nextAt,
      repeat: x.repeat,
    })
  }
  return out
}

/** 选「最近到期」的一条：nextAt || at 最小；时间都坏就取第一条 */
export function pickNextDue(items: ManageItem[]): ManageItem | null {
  if (!items || !items.length) return null
  let pick = items[0]
  let pickMs = Infinity
  for (const it of items) {
    const ms = new Date(it.nextAt || it.at).getTime()
    if (Number.isFinite(ms) && ms < pickMs) {
      pickMs = ms
      pick = it
    }
  }
  return pick
}

export interface ReminderManager {
  /** 打开面板：拉清单、列序号、开 60 秒有效窗；失败只轻提示 */
  open: () => Promise<void>
  /** 接住一条输入：命中（数字 / d 且窗内）返回 true，调用方不要再送聊天 */
  intercept: (text: string) => boolean
  /** 当前是否在有效窗内（诊断/单测用） */
  isOpen: () => boolean
  /** 当前缓存的清单快照（诊断/单测用） */
  items: () => ManageItem[]
  /** 有效窗长度（毫秒） */
  windowMs: number
}

export function createReminderManager(host: ManageHost): ReminderManager {
  const clock = typeof host.now === 'function' ? host.now : () => Date.now()
  const fetchJson = typeof host.getJson === 'function' ? host.getJson : getJson
  const sendJson = typeof host.postJson === 'function' ? host.postJson : postJson
  const removeJson = typeof host.delJson === 'function' ? host.delJson : delJson

  /** 面板打开时刻（0 = 未打开/已失效） */
  let openedAt = 0
  /** 最近一次展示的清单（序号以它为准） */
  let board: ManageItem[] = []
  /** 请求序号：并发打开/刷新时只认最新一次，防止旧响应盖住新清单 */
  let seq = 0

  function isOpen(now: number = clock()): boolean {
    if (!(openedAt > 0) || !board.length) return false
    const age = now - openedAt
    // age < 0 = 系统时钟被往回调：按失效处理，否则窗永远关不上、数字会被一直吞
    return age >= 0 && age <= MANAGE_WINDOW_MS
  }

  /** 失效时顺手清干净，之后数字输入直接放行 */
  function expire(): void {
    openedAt = 0
    board = []
  }

  /**
   * 把可能同步抛错的请求收成 Promise。
   * fetchJson / sendJson / removeJson 在极端环境（fetch 被禁用、参数非法）会同步抛；
   * 旧写法 `Promise.resolve(fetchJson(...))` 的参数求值发生在 Promise 之外，异常会直接冒出
   * intercept，主循环只会静默吞掉。统一转成 rejected，落到同一套兜底文案。
   */
  function safeRequest<T>(fn: () => Promise<T>): Promise<T> {
    try { return Promise.resolve(fn()) } catch (e) { return Promise.reject(e) }
  }

  /**
   * 拉服务端清单重新编号并冒泡（删除/顺延后都用它，序号以服务端为准）。
   * 刷新失败就让面板失窗：旧序号可能已经不对，不能再接数字。
   */
  function showBoard(prefix: string, failText: string): void {
    const my = ++seq
    safeRequest(() => fetchJson('/reminders')).then((d: any) => {
      if (my !== seq) return
      const arr = normalizeReminderList(d)
      board = arr
      if (!arr.length) {
        openedAt = 0
        host.bubble(prefix, 5000)
        return
      }
      host.bubble(boardText(arr, prefix), 12000)
    }).catch(() => {
      if (my !== seq) return
      openedAt = 0
      board = []
      host.bubble(failText, 5000)
    })
  }

  function open(): Promise<void> {
    const my = ++seq
    openedAt = 0
    return safeRequest(() => fetchJson('/reminders')).then((d: any) => {
      // 期间又打开了一次：这次结果作废
      if (my !== seq) return
      const arr = normalizeReminderList(d)
      board = arr
      if (!arr.length) {
        // 空清单不开窗：否则紧接着的数字输入会被白白吞掉
        openedAt = 0
        host.bubble('还没有提醒～', 3000)
        return
      }
      // 窗从「清单真正展示」开始算：接口慢 5 秒时不能把这 5 秒算进 60 秒里
      openedAt = clock()
      host.bubble(boardText(arr, '提醒清单（' + arr.length + ' 条）：'), 12000)
    }).catch(() => {
      if (my !== seq) return
      openedAt = 0
      board = []
      host.bubble('提醒清单查不到', 5000)
    })
  }

  /** 删除/顺延成功后刷新清单，把提示和最新序号放在同一条气泡里 */
  function afterDelete(): void {
    showBoard('删掉了', '删掉了，清单没刷新过来')
  }

  /**
   * 删除第 index 条（1 基序号）。
   * 请求还没回来时先按「已删掉」更新本地序号：主人回数字很快时，第二次删除必须按
   * 新序号算；否则会拿旧序号去删下一条，删错人。
   * 失败时不拿旧快照硬回滚（可能掩盖期间别的变化），直接拉服务端清单复位。
   */
  function removeAt(index: number): void {
    const it = board[index - 1]
    if (!it) {
      host.bubble('没有第 ' + index + ' 条，回数字再选一次', 4000)
      return
    }
    const next = board.slice()
    next.splice(index - 1, 1)
    board = next
    safeRequest(() => removeJson('/reminders?id=' + encodeURIComponent(it.id))).then((d: any) => {
      if (!(d && d.ok)) {
        showBoard('没删掉，最新清单：', '没删掉，清单也没刷出来')
        return
      }
      afterDelete()
    }).catch(() => showBoard('没删掉，最新清单：', '没删掉，清单也没刷出来'))
  }

  /**
   * 顺延最近到期的提醒 10 分钟。
   * 顺序：先 POST 新提醒 → 成功后 DELETE 旧条目。
   * 添加失败时原提醒还在，清单不动；删除失败时新提醒已经加上了，必须刷新清单，
   * 让主人看见「新的 + 旧的」两条并能自己删掉——不刷新的话再按一次 d 会再加一条。
   */
  function postpone(): void {
    const pick = pickNextDue(board)
    if (!pick) {
      host.bubble('清单里没有能顺延的提醒', 4000)
      return
    }
    const dueMs = new Date(pick.nextAt || pick.at).getTime()
    // 已到点的从「现在」起顺延；还没到点的在原定时间上顺延，保持主人的原意
    const base = Number.isFinite(dueMs) ? Math.max(clock(), dueMs) : clock()
    const at = new Date(base + POSTPONE_MS)
    const when = formatClock(at)
    const body = {
      text: pick.text,
      at: at.toISOString(),
      repeat: Number(pick.repeat) || 0,
    }
    safeRequest(() => sendJson('/reminders', body)).then((d: any) => {
      if (!(d && d.ok)) {
        host.bubble('顺延没成，原提醒还在', 4000)
        return
      }
      safeRequest(() => removeJson('/reminders?id=' + encodeURIComponent(pick.id))).then((d2: any) => {
        if (!(d2 && d2.ok)) {
          showBoard('顺延到 ' + when + '，但旧提醒没删掉：', '顺延到 ' + when + '，但旧提醒没删掉')
          return
        }
        showBoard('顺延到 ' + when, '顺延到 ' + when)
      }).catch(() => showBoard('顺延到 ' + when + '，但旧提醒没删掉：', '顺延到 ' + when + '，但旧提醒没删掉'))
    }).catch(() => host.bubble('顺延没成，原提醒还在', 4000))
  }

  /**
   * 接住下一条输入。只有「窗内 + 纯数字/d」才返回 true；
   * 其他输入（正常对话）原样放行，绝不吞掉。
   */
  function intercept(text: string): boolean {
    if (!isOpen()) {
      // 窗过期（或清单已空）：清干净，后续数字不再拦截
      if (openedAt > 0) expire()
      return false
    }
    const cmd = parseManageInput(text)
    if (!cmd) return false
    if (cmd.kind === 'delete') removeAt(cmd.index)
    else postpone()
    // 指令已接住：即使序号不存在，也不再送给模型（面板开着时这属于操作输入）
    return true
  }

  return {
    open,
    intercept,
    isOpen: () => isOpen(),
    items: () => board.slice(),
    windowMs: MANAGE_WINDOW_MS,
  }
}
