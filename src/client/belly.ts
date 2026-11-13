/**
 * client/belly.ts —— 「鱼账本」token 总量 → 肥鲸进食参数（纯计算，不碰 DOM / 存储 / 网络）
 *
 * 分工：本模块只做两件事——
 *   · digest：把「今天吃了多少 token」换成肚子状态 BellyState（体型倍数 / 今日口数 / 是否吃饱），
 *     调用方自己持久化，下次再原样传回来；
 *   · chewPlan：把肚子状态换成一次进食动画的参数（体型倍数 + 冒几颗心）。
 * 动画怎么画、爱心怎么飘，全在主代码里，这里不产生任何副作用。
 *
 * 为什么必须把 prev 传进来：账本里只有「总量」，没有「上次的总量」，而状态形状被定死成三元组，
 * 塞不下基线 token。所以口数按总量分档重建（chewCount = floor(total / 1 万)），
 * 再用 prev.chewCount 判断是「又吃了」还是「账本被重置了」：
 *   · 口数没少 → 只许涨、不许倒退（同一帧反复读同一个数字，动画不会抖）；
 *   · 口数变少 → 账本被清空 / 跨天清零 / 换了数据源，整只退回基线，不挂着昨天的肚子。
 *
 * 容错口径：任何入参都不抛错。NaN / 负数 / undefined / 字符串等非数字一律按 0；
 * 体型夹在 [1.0, 1.12]，喂到天上去也不会超出（溢出不是错误，只是封顶）。
 */

/** 肚子状态：调用方原样保存、下次原样传回即可（本模块不持有任何全局状态） */
export type BellyState = { scale: number; chewCount: number; full: boolean }

/** 每 1 万 token 算「一口」：这是动画节奏的分度，不是计价单位（改它等于改吃相，别随手动） */
const TOKENS_PER_CHEW = 10000
/** 今日 50 万 token（约 50 口）就算吃饱；再多也还是「吃饱」，不另设更饱的档 */
const FULL_TOKENS = 500000
/** 体型下限 / 上限：1.12 是「稍微鼓一点」的极限，再大就会顶到画面布局 */
const SCALE_MIN = 1
const SCALE_MAX = 1.12
/**
 * 体型鼓到上限所需的总量：30 万 token。
 * 刻意取在饱腹阈值（50 万）之前：先鼓到最胖、再吃饱，
 * 否则 30~50 万这一大段体型一动不动，看着像坏了。
 */
const SCALE_CAP_TOKENS = 300000

/**
 * 把任何入参洗成非负整数 token。
 * 非数字（undefined / null / 字符串 / 布尔 / 对象）按 0：账本是 host 写出来的 JSON，
 * 类型错了就是坏了，猜它反而凭空多出几口（Number('120k') 是 NaN，Number(true) 是 1）。
 * 唯一的例外是 +Infinity：落在 MAX_SAFE_INTEGER 而不是 0——账本真崩了的时候，
 * 宁可让鲸鱼吃饱趴着，也不要它突然瘦回去（瘦回去看起来像「账被吃了」）。
 */
function sanitizeTokens(v: unknown): number {
  if (typeof v !== 'number' || Number.isNaN(v)) return 0
  if (!Number.isFinite(v)) return v > 0 ? Number.MAX_SAFE_INTEGER : 0
  if (v <= 0) return 0
  return Math.floor(v)
}

/**
 * 体型倍数夹到 [1.0, 1.12]。
 * 非有限值（NaN / Infinity）退回 1.0：上限只该由真实 token 顶到，不该被一个坏值撞上去，
 * 否则一次脏数据就让鲸鱼永远胖着，再也看不出进食。
 */
function clampScale(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return SCALE_MIN
  if (n < SCALE_MIN) return SCALE_MIN
  if (n > SCALE_MAX) return SCALE_MAX
  return n
}

/** 总量 → 今日口数：向下取整，不够一口就不算（先跳一帧再回退比不动更难看） */
function chewsFor(total: number): number {
  return Math.floor(total / TOKENS_PER_CHEW)
}

/** 总量 → 体型倍数：按比例线性长到 SCALE_CAP_TOKENS 封顶（不按口累加，浮点误差不会越攒越大） */
function scaleFor(total: number): number {
  const ratio = total >= SCALE_CAP_TOKENS ? 1 : total / SCALE_CAP_TOKENS
  return clampScale(SCALE_MIN + (SCALE_MAX - SCALE_MIN) * ratio)
}

/** 基线：只用总量重建（首次调用、以及账本重置后都走这里） */
function baseline(total: number): BellyState {
  return { scale: scaleFor(total), chewCount: chewsFor(total), full: total >= FULL_TOKENS }
}

/**
 * 把上次的状态洗成可信形状；null / 非对象一律当「没有上次」（返回 null）。
 * 数组虽然也是对象，但一定不是这里要的三元组，同样按没有上次处理，
 * 免得 [1.12] 这种形状算出个怪体型。
 */
function readPrev(prev: unknown): BellyState | null {
  if (!prev || typeof prev !== 'object' || Array.isArray(prev)) return null
  const p = prev as Partial<BellyState>
  const n = Number(p.chewCount)
  return {
    scale: clampScale(p.scale),
    chewCount: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0,
    full: p.full === true,
  }
}

/**
 * 账本总量 → 新的肚子状态。
 *
 * 规格四条，按判定顺序：
 *   1. 首次（prev 为 null / 非对象）：以当前总量为基线，chewCount 是「今天已经吃了几口」；
 *   2. 口数变少：账本被重置 / 清理 / 跨天，回到基线（这不是「吃得少了」，是新的一天）；
 *   3. 口数没少：体型取「上次」与「按总量算」的较大值——没有增量时正好原样返回，
 *      有增量时跟着涨，并被夹在 1.12 内，既单调又不会突然瘦；
 *   4. 吃饱一旦成立就保持（在重置分支里才允许回到不饱）。
 */
export function digest(prev: BellyState | null, totalTokens: number): BellyState {
  const total = sanitizeTokens(totalTokens)
  const base = baseline(total)

  const before = readPrev(prev)
  if (!before) return base

  // 重置：口数倒退说明总量被清过（或换了个账本）。整只退回基线，
  // 否则体型会卡在昨天的 1.12，一整天看不出「刚开张」。
  // 判定粒度是一口（1 万）：状态里没有基线 token，同一口内回落几百 token 看不出来，
  // 但那种回落本来也不该让动画抖一下，跨过一口才算真的换了账本。
  if (base.chewCount < before.chewCount) return base

  // 不倒退：取较大值。同总量时两者相等 → 结果与上次逐字段相同（同输入同输出）；
  // 增量不足一口时 base.scale 略高一点，体型仍会随 token 缓涨，不会卡成台阶。
  const scale = clampScale(Math.max(before.scale, base.scale))
  // 吃饱同理：到过 50 万就不再「饿回去」；真要取消这个状态，上面的重置分支已经办到了。
  const full = before.full || base.full
  return { scale, chewCount: base.chewCount, full }
}

/**
 * 肚子状态 → 一次进食动画的参数。
 *
 * hearts 取 0~5 的整数，口数越多心越多，吃饱再补一颗；
 * 封顶 5 是因为再多就成了「爱心雨」，反而看不出是在吃东西。
 * 纯函数：只读入参，不碰时间 / 随机数 / 全局状态，所以同一帧算多少遍都一样，动画可以重放。
 */
export function chewPlan(state: BellyState): { scale: number; hearts: number } {
  // 复用同一套清洗：state 是从存储里读回来的，坏值不许抛错，也不许把 transform 写成 NaN。
  const s = readPrev(state)
  if (!s) return { scale: SCALE_MIN, hearts: 0 }

  const chews = s.chewCount
  // 口数分档（括号里是按每口 1 万换算的等价 token 量）：
  //   1 口（1 万）→ 1 颗；5 口（5 万）→ 2 颗；15 口（15 万）→ 3 颗；30 口（30 万）→ 4 颗
  let hearts = 0
  if (chews >= 30) hearts = 4
  else if (chews >= 15) hearts = 3
  else if (chews >= 5) hearts = 2
  else if (chews >= 1) hearts = 1

  // 吃饱再补一颗：即使 state 是别处拼出来的（口数为 0 但 full 为真），也至少冒一颗心，
  // 不至于「吃饱了却一点动静都没有」。
  if (s.full) hearts += 1
  if (hearts > 5) hearts = 5

  return { scale: s.scale, hearts }
}
