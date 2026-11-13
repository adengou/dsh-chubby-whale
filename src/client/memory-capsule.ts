/**
 * client/memory-capsule.ts —— 鲸落 / 记忆胶囊：把一段相处留下的抽象主题，打包成一颗轻量小文件
 *
 * 用途：分别的时候，把这段日子沉成一颗胶囊；朋友把它带回家，他家的肥鲸会「梦见」这边的事。
 *
 * 隐私红线（为什么只放主题词、不放原文）：
 *   ① 一次对话的原文里，常混着主人的私事、别人的隐私、还没打算说出口的话。这种内容一旦能被
 *      导出、转发、再导入到别人机器上，就再也收不回来了；
 *   ② 记忆胶囊是要**送人**的：送出去的应当只是「这段日子像什么」——几个主题词、一句梦话；
 *      而不是「这段日子说过什么」；
 *   ③ 主题词被看见，暴露的只是兴趣方向；原文被看见，暴露的是具体的人、事、时间与情绪。
 *      所以胶囊里只有 topics（主题词）与 dream（梦话）两个文字字段：没有「对话」字段，
 *      也没有「原文」字段，更没有发言者、记录条数、逐条时间戳。
 *
 * 契约：
 *   ① packCapsule 只做清洗与生成：零随机、不读系统时钟（madeAt 由调用方传入），
 *      同一输入两次结果完全相同，且产物一定能被 readCapsule 读回；
 *   ② readCapsule 只认对象，逐字段校验：不合规一律返回 null，绝不抛错；
 *      合规就返回同形对象——不做「解构后重新打包」式的隐式修正，截断仅对超长 topics 生效；
 *   ③ capsuleDream 依 topics 生成一句梦话：有主题词时取前两个，没有时回落通用句；
 *      c 非法（null / 非对象 / v 不对 / topics 类型错）返回 null；
 *   ④ 纯函数、零 import：不碰文件、DOM、localStorage、网络，也不发任何请求。
 */

export type Capsule = { v: 1; madeAt: number; intimacy: number; topics: string[]; dream: string }
export type CapsuleInput = { madeAt: number; intimacy?: number; topics?: string[] }

/** 主题词上限：最多 8 个，每个最多 8 个字符——「鲸落」要轻，一张便签就写得下 */
const MAX_TOPICS = 8
const MAX_TOPIC_CHARS = 8
/** 梦话上限：一句话，最多 200 字符（readCapsule 按同一把尺子校验，两边不能各说各话） */
const MAX_DREAM_CHARS = 200
/** 梦的固定开头：两边的海不一样，但潮水的味道是相通的 */
const DREAM_OPEN = '我好像闻到了另一片海的味道……'
/** 没有任何主题词时的通用梦话：与有主题时同源，避免两套语气 */
const DREAM_EMPTY = DREAM_OPEN + '那边有另一只鲸在慢慢游。'

/** 按字符（码点）切分：中文、emoji 都算一个字，不用 .length 把代理对拆成两半 */
function toChars(s: string): string[] {
  return Array.from(s)
}

/** 截到最多 n 个字符；没超就原样返回（已经合规的值一分不改） */
function cutChars(s: string, n: number): string {
  const chars = toChars(s)
  return chars.length <= n ? s : chars.slice(0, n).join('')
}

/** 自有属性判断：不让原型链上的值冒充胶囊字段，也挡住 JSON 里带进来的 "__proto__" */
function hasOwn(o: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key)
}

/**
 * 亲密度归一到 0–100 的整数：
 * 非数字与 NaN 按 0（没有可用的亲密度，不该让整颗胶囊失败）；±Infinity 沿夹取方向落到端点；
 * 其余先四舍五入再夹，免得 99.7 变成「比满还差一点」这种半档。
 */
function clampIntimacy(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}

/**
 * 清洗主题词：逐项 trim、去空、按码点截到 8 字、去重（保留第一次出现的顺序），最多 8 个。
 * 非数组按空数组；数组里的非字符串项直接跳过——打包是给本机用的，宁可少几个词，也不为此报错。
 */
function cleanTopics(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  for (const item of input) {
    if (typeof item !== 'string') continue
    const word = cutChars(item.trim(), MAX_TOPIC_CHARS)
    if (!word) continue
    if (out.indexOf(word) >= 0) continue
    out.push(word)
    if (out.length >= MAX_TOPICS) break
  }
  return out
}

/**
 * 梦话生成：取前两个主题词，用『』括起来——书名号太正式，引号又像在转述原话，
 * 『』只是把词托起来，像梦里听见的一个音节。
 */
function dreamFrom(topics: readonly string[]): string {
  const words: string[] = []
  for (const t of topics) {
    if (typeof t !== 'string') continue
    const word = cutChars(t.trim(), MAX_TOPIC_CHARS)
    if (!word) continue
    words.push(word)
    if (words.length >= 2) break
  }
  if (words.length === 0) return DREAM_EMPTY
  if (words.length === 1) return DREAM_OPEN + '那边有人在弄『' + words[0] + '』。'
  return DREAM_OPEN + '那边有人在弄『' + words[0] + '』和『' + words[1] + '』。'
}

/**
 * 依胶囊生成一句梦话。
 *
 * 只有「v 对、topics 是字符串数组」才谈得上做梦，其余一律 null；梦话与 madeAt / intimacy /
 * dream 无关，所以这三项不参与判定（导入后展示梦话不必回头校验整颗胶囊）。
 * topics 缺省、为空或全是空串 = 没有主题词 → 通用句。非法输入绝不抛错。
 */
export function capsuleDream(c: Capsule): string | null {
  try {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return null
    const o = c as unknown as Record<string, unknown>
    // v 是胶囊的身份位：不是 v1 就不是这颗胶囊（缺字段同样按非法处理）
    if (!hasOwn(o, 'v') || o.v !== 1) return null
    if (o.topics === undefined) return DREAM_EMPTY
    if (!Array.isArray(o.topics)) return null
    for (const t of o.topics) if (typeof t !== 'string') return null
    return dreamFrom(o.topics)
  } catch {
    return null
  }
}

/**
 * 把一段相处的痕迹打包成胶囊。
 *
 * madeAt 由调用方给（本模块不读系统时钟）：有限数字原样保留；给不出有效时间的用 0 表示
 * 「时间不明」——产物必须能被 readCapsule 读回，这条比补一个当前时间更重要。
 * 输出字段顺序固定为 v / madeAt / intimacy / topics / dream，同一输入两次结果完全一致。
 */
export function packCapsule(input: CapsuleInput): Capsule {
  const src: Partial<CapsuleInput> =
    input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const madeAt = typeof src.madeAt === 'number' && Number.isFinite(src.madeAt) ? src.madeAt : 0
  const intimacy = clampIntimacy(src.intimacy)
  const topics = cleanTopics(src.topics)
  // 梦话统一由 capsuleDream 生成（不另开一条生成路径）：胶囊送到朋友那边，
  // 他家的鲸梦见的也只是这几个主题词。
  const capsule: Capsule = { v: 1, madeAt, intimacy, topics, dream: '' }
  capsule.dream = capsuleDream(capsule) || DREAM_EMPTY
  return capsule
}

/**
 * 读一颗胶囊：只认对象，逐字段校验；不合规返回 null，绝不抛错。
 *
 * 合规就返回同形对象：除超长 topics 截断外不做任何改写——不补字段、不 trim、不去重、
 * 不把亲密度取整（只夹到 0–100），也不把外来字段带进胶囊。
 * "__proto__" 是原型污染键：JSON 里带进来的会变成自有字段，这种胶囊一律不收。
 */
export function readCapsule(raw: unknown): Capsule | null {
  try {
    // ① 只认对象：字符串（哪怕内容是合法 JSON）、数组、null、函数、数字都不认
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const o = raw as Record<string, unknown>
    // ② 原型污染：带自有 "__proto__" 键的，连读都不读
    if (hasOwn(o, '__proto__')) return null
    // ③ 五个字段必须都是自有字段（原型链上的值不能冒充胶囊字段）
    if (
      !hasOwn(o, 'v') ||
      !hasOwn(o, 'madeAt') ||
      !hasOwn(o, 'intimacy') ||
      !hasOwn(o, 'topics') ||
      !hasOwn(o, 'dream')
    ) {
      return null
    }
    // ④ v 必须严格等于 1（数字 1；"1" / true 都不算）
    if (o.v !== 1) return null
    // ⑤ madeAt 必须是有限数字；零与负数照收（1970 前后都是合法时刻）
    if (typeof o.madeAt !== 'number' || !Number.isFinite(o.madeAt)) return null
    // ⑥ intimacy 必须是数字：NaN / Infinity 不是可用的亲密度；合规值只夹到 0–100
    if (typeof o.intimacy !== 'number' || !Number.isFinite(o.intimacy)) return null
    const intimacy = Math.min(100, Math.max(0, o.intimacy))
    // ⑦ topics 必须是字符串数组（逐项校验，含第 9 项之后）；超长逐项截断、超量截到 8 个
    if (!Array.isArray(o.topics)) return null
    for (const t of o.topics) if (typeof t !== 'string') return null
    // ⑧ dream 必须是字符串且不超过 200 字符；超长直接判坏，不做截断
    if (typeof o.dream !== 'string') return null
    if (toChars(o.dream).length > MAX_DREAM_CHARS) return null

    const topics = o.topics.slice(0, MAX_TOPICS).map((t) => cutChars(t, MAX_TOPIC_CHARS))
    return { v: 1, madeAt: o.madeAt, intimacy, topics, dream: o.dream }
  } catch {
    // 取属性时可能触发抛错的 getter / Proxy：宁可当作坏胶囊，也绝不把异常抛给调用方
    return null
  }
}
