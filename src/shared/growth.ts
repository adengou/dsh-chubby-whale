/**
 * shared/growth.ts —— 成长阶段规则（纯函数，路由与仓储共用）
 *
 * 为什么放在 shared：成长阶段表与"经验→阶段"是纯规则，路由（简报/菜单/统计）
 * 和仓储（exp 累加）都要用。放在 host/repos 里会逼着路由去 import 仓储层，
 * 形成"路由 → 实现"的反向依赖；放这里两边都只依赖规则本身。
 */

import { deepFreeze } from './immutable.js'

export const GROWTH_STAGES = [
  { exp: 0, name: '初识' },
  { exp: 200, name: '熟悉' },
  { exp: 800, name: '亲密' },
  { exp: 2500, name: '知心' },
  { exp: 5000, name: '家人' },
]
deepFreeze(GROWTH_STAGES)

/** 经验值 → 阶段（含下一阶段门槛；已是最高阶段时 nextExp=0） */
export function growthStage(exp: number): { index: number; name: string; nextExp: number } {
  let idx = 0
  for (let i = 0; i < GROWTH_STAGES.length; i++) {
    if (exp >= GROWTH_STAGES[i].exp) idx = i
  }
  const next = idx + 1 < GROWTH_STAGES.length ? GROWTH_STAGES[idx + 1].exp : 0
  return { index: idx, name: GROWTH_STAGES[idx].name, nextExp: next }
}
