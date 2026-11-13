/**
 * client/whale-speak.ts —— 鲸语口癖（肥鲸偶尔冒一个自创鲸鱼词）
 *
 * 只做一件事：按「场景词池 + 60 秒冷却 + 亲密度」决定这一次要不要鲸一句。
 *   · 返回值要么是**一个短词**（2–3 个汉字、不带标点），要么是 null；
 *   · 拼进气泡由调用方负责；**绝不用于 TTS 朗读**——鲸语是给人看的拟声口癖，
 *     念出来会打断配音节奏，也会把「养成感」变成噪音；
 *   · 纯逻辑、零依赖：不碰 DOM / localStorage / 网络，也不自己起定时器；
 *     时间由 `now` 注入（缺省取 Date.now()），测试才能把冷却与节奏钉死。
 *
 * 为什么命中判定不用 Math.random（可测性）：
 *   真随机的概率闸门只能靠「跑很多次大概会中」来断言，偶发红灯时分不清是实现错了
 *   还是运气差。这里改成**确定性伪随机**：每次「机会」往累加器里加上本档命中率
 *   （20 / 45 / 70），攒满 100 就命中并扣掉 100。于是每 100 次机会正好命中
 *   20 / 45 / 70 次，而且均匀铺开（20% 档 = 每第 5 次机会中一次）；亲密度越高，
 *   命中次数只多不少，单测可以用固定序列精确对比。
 *   代价是节奏偏规律，但 60 秒冷却本身已把「密度」压得很低，观感反而像
 *   「偶尔想起一句」——这正是养成感要的效果。
 *
 * 词池共 10 个自创词；「鲸动」暂未分配到场景，作为保留词留在池子里（任何场景都不返回）。
 */

/** 亲密度档位的命中率：每 100 次机会的命中次数 */
const RATE_LOW = 20
const RATE_MID = 45
const RATE_HIGH = 70

/** 同一进程内两次鲸语的最小间隔（毫秒）：60 秒内最多冒一次 */
const COOLDOWN_MS = 60_000

export type WhaleSpeakCtx = { trigger: 'greet' | 'reply' | 'idle' | 'feed'; intimacy?: number; mood?: string }

/**
 * 场景词池：总池 10 词按场景分（greet 3 / reply 3 / idle 3 / feed 2）。
 * 用 Object.freeze 钉住——本模块只清运行状态，不提供任何改词池的入口。
 */
const SCENE_WORDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  greet: Object.freeze(['鲸喜', '鲸软', '鲸蹦']),
  reply: Object.freeze(['咕噜', '鲸奇', '鲸呆']),
  idle: Object.freeze(['鲸懒', '鲸泡', '鲸闹']),
  feed: Object.freeze(['鲸软', '咕噜']),
})

// ---- 运行状态（同一进程内共用；resetWhaleWords 全部清零） ----
/** 概率累加器：每次机会加上本档命中率，满 100 命中并扣 100（见文件头说明） */
let acc = 0
/** 命中次数：用来轮换词，保证同一场景里几个词轮流出现、不偏心 */
let hits = 0
/** 上次真正返回词的时刻；null = 还没说过 */
let lastAt: number | null = null

/**
 * 亲密度 → 命中率（%）。
 * 分档边界：<30 → 20；30–69 → 45；>=70 → 70。
 * 未传 / NaN / 负数一律落最低档（宁可少说，也不要因为脏数据刷屏）。
 */
function hitRate(intimacy?: number): number {
  const v = Number(intimacy)
  if (!Number.isFinite(v) || v < 30) return RATE_LOW
  if (v < 70) return RATE_MID
  return RATE_HIGH
}

/**
 * 这一次要不要鲸一句。
 *
 * @param ctx 场景（greet/reply/idle/feed）与可选亲密度；`mood` 目前只作占位，不参与判定。
 *            非法 ctx（null / 缺 trigger / 未知 trigger）返回 null，绝不抛错。
 * @param now 当前时刻（毫秒，缺省 Date.now()）；注入固定值即可复现冷却行为。
 * @returns 一个鲸语短词；未命中、冷却中或 ctx 非法时返回 null。
 */
export function pickWhaleWord(ctx: WhaleSpeakCtx, now: number = Date.now()): string | null {
  if (!ctx || typeof ctx !== 'object') return null
  const trigger = (ctx as { trigger?: unknown }).trigger
  // 必须挡类型：'toString' / '__proto__' 这类键在普通对象上取到的是原型成员，不是词池
  if (typeof trigger !== 'string') return null
  const pool = SCENE_WORDS[trigger]
  if (!Array.isArray(pool) || pool.length === 0) return null
  const at = Number(now)
  const stamp = Number.isFinite(at) ? at : Date.now()
  // 冷却优先：冷却期内的调用既不消耗机会、也不推进累加器
  if (lastAt !== null && stamp - lastAt < COOLDOWN_MS) return null
  acc += hitRate(ctx.intimacy)
  if (acc < 100) return null
  acc -= 100
  lastAt = stamp
  const word = pool[hits % pool.length]
  hits++
  return word
}

/** 清空冷却、累加器与命中计数（仅供测试/调试；生产逻辑不要调） */
export function resetWhaleWords(): void {
  acc = 0
  hits = 0
  lastAt = null
}
