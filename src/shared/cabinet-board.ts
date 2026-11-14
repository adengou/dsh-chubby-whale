/**
 * shared/cabinet-board.ts —— 推演任务板只读检查器
 *
 * 只认推演协议约定的任务标题前缀：
 *   [FIN] 财务视角、[RISK] 风险/法务、[CUST] 客户代言人、[OPP] 反方、[MEMO] 汇总
 *
 * 目标：鱼脚下显示「推演 2/4 · 1 在做」，让主人知道 AgentTeam 已开工，
 * 而不是面板一关就什么都不见。
 *
 * 边界：
 *   · 纯函数，只 import type TeamTaskView；
 *   · 不读任务板、不写任务、不碰 DOM/时钟/网络；
 *   · 任务板仍是唯一状态源，这里只把公开任务视图翻译成一句进度。
 */

import type { TeamTaskView } from './team-contract.js'

export type CabinetRoleKey = 'FIN' | 'RISK' | 'CUST' | 'OPP'

export const CABINET_ROLE_PREFIXES: readonly CabinetRoleKey[] = Object.freeze(['FIN', 'RISK', 'CUST', 'OPP'])

export interface CabinetBoardReport {
  /** 任务板里有没有推演任务（没有任何前缀时 false，普通看板不受影响） */
  present: boolean
  /** 四位角色任务中已完成的数量（0–4） */
  done: number
  /** 四位角色任务中 in_progress 的数量 */
  active: number
  /** 四位角色任务中仍 pending 的数量 */
  waiting: number
  /** 尚未建任务的角色 */
  missing: readonly CabinetRoleKey[]
  /** 汇总任务状态：none=没建，pending=未完成，done=已完成 */
  memo: 'none' | 'pending' | 'done'
  /** 鱼脚下的一句话；present=false 时为空串 */
  chipText: string
  phase: 'idle' | 'missing' | 'working' | 'waiting' | 'memo' | 'done'
}

/** 从标题里取前缀；`[FIN] xxx` / `【FIN】xxx` 都认，大小写不敏感 */
function prefixOf(subject: unknown): string {
  const text = typeof subject === 'string' ? subject.trim() : ''
  const match = /^[\[【]\s*(FIN|RISK|CUST|OPP|MEMO)\s*[\]】]/i.exec(text)
  return match ? match[1].toUpperCase() : ''
}

/**
 * 检查任务板里的推演进度。
 *
 * @param tasks - 公开任务视图（只读；deleted 会被忽略）
 */
export function inspectCabinetBoard(tasks: readonly TeamTaskView[]): CabinetBoardReport {
  const roleTasks: Record<CabinetRoleKey, TeamTaskView | null> = {
    FIN: null, RISK: null, CUST: null, OPP: null,
  }
  let memoTask: TeamTaskView | null = null

  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task || task.status === 'deleted') continue
    const prefix = prefixOf(task.subject)
    if (prefix === 'MEMO') {
      // 多张 MEMO 时取最新 revision，避免旧任务把进度拉回去
      if (!memoTask || Number(task.revision) >= Number(memoTask.revision)) memoTask = task
      continue
    }
    if (prefix === 'FIN' || prefix === 'RISK' || prefix === 'CUST' || prefix === 'OPP') {
      const key = prefix as CabinetRoleKey
      if (!roleTasks[key] || Number(task.revision) >= Number(roleTasks[key]!.revision)) roleTasks[key] = task
    }
  }

  const present = !!memoTask || CABINET_ROLE_PREFIXES.some((key) => !!roleTasks[key])
  if (!present) {
    return { present: false, done: 0, active: 0, waiting: 0, missing: [], memo: 'none', chipText: '', phase: 'idle' }
  }

  const missing: CabinetRoleKey[] = []
  let done = 0
  let active = 0
  let waiting = 0
  for (const key of CABINET_ROLE_PREFIXES) {
    const task = roleTasks[key]
    if (!task) { missing.push(key); continue }
    if (task.status === 'completed') done++
    else if (task.status === 'in_progress') active++
    else waiting++
  }

  const memo: CabinetBoardReport['memo'] = !memoTask ? 'none' : (memoTask.status === 'completed' ? 'done' : 'pending')
  const total = CABINET_ROLE_PREFIXES.length
  const phase: CabinetBoardReport['phase'] =
    memo === 'done' && done === total ? 'done'
      : active > 0 ? 'working'
        : missing.length > 0 ? 'missing'
          : memo === 'pending' && done === total ? 'memo'
            : 'waiting'

  let chipText = ''
  if (phase === 'done') chipText = '推演完成'
  else {
    chipText = '推演 ' + done + '/' + total
    if (missing.length > 0) chipText += ' · 缺 ' + missing.length + (active > 0 ? ' · ' + active + ' 在做' : '')
    else if (active > 0) chipText += ' · ' + active + ' 在做'
    else if (memo === 'pending' && done === total) chipText += ' · 待汇总'
    else chipText += ' · 待开工'
  }

  return { present, done, active, waiting, missing, memo, chipText, phase }
}
