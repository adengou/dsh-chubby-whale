import { deepFreeze } from '../shared/immutable.js'
import { growthStage } from '../shared/growth.js'
/**
 * client/look.ts —— 成长阶段 → 外观参数（L5 外观进化）
 *
 * 纯函数、无 DOM 依赖：
 *   · 视觉档位只由经验值决定（阈值对齐 shared/growth.ts 的前两档边界 200 / 800）；
 *   · 体型 / 背鳍光点 / 光晕 / 甩尾节奏四个参数可独立叠加；
 *   · 拉不到 /growth 时统一回落到初识档（lookForGrowth(null)）。
 *
 * 说明：host 的成长阶段共 5 档（初识/熟悉/亲密/知心/家人），外观收敛为 3 档：
 *   初识 <200；熟络 200–799；黏人 ≥800（知心、家人沿用黏人档，不再另加参数）。
 *   档位名只用于外观诊断；菜单与 /growth 缺字段时的回落名一律取 shared/growth.ts 的
 *   host 阶段名（熟悉/亲密/知心/家人），两套名字不能混用。
 */

export interface GrowthInfo {
  exp: number
  stage: string
  nextExp: number
  /** 外观档位：0 初识 / 1 熟络 / 2 黏人 */
  tier: number
}

export interface Look {
  tier: number
  /** 外观档位名（仅内部用；菜单仍显示服务端阶段名） */
  label: string
  /** 体型缩放（canvas 元素 transform，不裁剪画面） */
  scale: number
  /** 背鳍光点数量 */
  dots: number
  /** 光晕峰值透明度；0 = 不画 */
  halo: number
  /** 甩尾/水花的目标间隔（毫秒，实际带 ±20% 抖动） */
  tailEveryMs: number
}

/** 外观档位阈值：与 host 的成长阶段边界 200 / 800 对齐 */
export const TIER_EXP = [0, 200, 800]
deepFreeze(TIER_EXP)
export const TIER_NAMES = ['初识', '熟络', '黏人']
deepFreeze(TIER_NAMES)

/** 外观档位（冻结：lookFor 会把元素直接交给 UI，冻结后外部改不动） */
const LOOKS: Look[] = [
  { tier: 0, label: '初识', scale: 1, dots: 2, halo: 0, tailEveryMs: 14000 },
  { tier: 1, label: '熟络', scale: 1.04, dots: 4, halo: 0.12, tailEveryMs: 9000 },
  { tier: 2, label: '黏人', scale: 1.08, dots: 6, halo: 0.22, tailEveryMs: 5500 },
]
deepFreeze(LOOKS)

/**
 * 经验值 → 外观档位（0/1/2）。
 * NaN / 负数按 0 处理；+Infinity 必须落到最高档（否则「经验越大档位反而回落」，破坏单调性）。
 */
export function tierOf(exp: number): number {
  const e = Number(exp)
  if (Number.isNaN(e) || e <= 0) return 0
  for (let i = TIER_EXP.length - 1; i > 0; i--) {
    if (e >= TIER_EXP[i]) return i
  }
  return 0
}

/** 经验值 → 外观参数 */
export function lookFor(exp: number): Look {
  return LOOKS[tierOf(exp)]
}

/** 成长数据 → 外观参数；空值/坏值一律回落初识档 */
export function lookForGrowth(info?: GrowthInfo | null): Look {
  if (!info || typeof info.exp !== 'number') return LOOKS[0]
  return LOOKS[tierOf(info.exp)]
}

export const DEFAULT_GROWTH: GrowthInfo = { exp: 0, stage: '初识', nextExp: 200, tier: 0 }
deepFreeze(DEFAULT_GROWTH)

/** 解析 GET /growth 响应；ok 不为 true 或经验值非法时返回 null（调用方按初识处理） */
export function parseGrowth(d: any): GrowthInfo | null {
  if (!d || typeof d !== 'object' || !d.ok) return null
  const raw = Number(d.exp)
  if (!isFinite(raw)) return null
  const exp = Math.max(0, Math.floor(raw))
  const tier = tierOf(exp)
  // 缺字段时按 host 同源规则回落（stage 名与 nextExp 都以 5 档为准），
  // 不能拿外观档位名（熟络/黏人）冒充服务端阶段名。
  const host = growthStage(exp)
  const n = Number(d.nextExp)
  let nextExp = 0
  if (isFinite(n) && n >= 0) nextExp = Math.floor(n)
  else nextExp = host.nextExp
  const stage = (typeof d.stage === 'string' && d.stage) ? d.stage : host.name
  return { exp, stage, nextExp, tier }
}

export type GrowthFetcher = (path: string, init?: any) => Promise<any>

/** 拉一次 /growth：网络错误、非 ok、坏 JSON 都静默返回 null（绝不抛错） */
export function fetchGrowth(getJson: GrowthFetcher): Promise<GrowthInfo | null> {
  try {
    return Promise.resolve(getJson('/growth', { cache: 'no-store' }))
      .then((d: any) => parseGrowth(d))
      .catch(() => null)
  } catch (e) {
    return Promise.resolve(null)
  }
}
