/**
 * client/diary.ts —— 「你不在时的生活」：离线日记 / 昨晚的梦（纯文本拼装）
 *
 * 只做一件事：按真实输入（离线时长、记忆摘要、最近事件、亲密度）拼出一段
 * 2–4 句的鲸鱼视角短文，交给调用方决定要不要显示、要不要念。
 *   · 纯函数：不读系统时钟、不用随机数、不碰存储与网络、零依赖；
 *     同一输入两次调用必须一字不差，调用方才能放心做「每天最多一篇」。
 *   · 不编造用户的具体事实：summary 只按词表做抽象化转述（材料 → 一叠纸），
 *     词表里没有的词宁可不写，也不把 summary 里的人名、数字、操作原样搬出来。
 *
 * 为什么离线满 2 小时才写：
 *   2 小时以内多半只是刷新页面、切个窗口，主人其实还在；这时写「你不在时」的
 *   日记会变成每次刷新都塞一句的噪音，也把「等你」演成了假深情。2 小时是一段
 *   真正离开的下限——够本鲸在水里转一圈、攒下几片碎片，又不至于把白天拆成
 *   好几篇。调用方再按「每天最多一篇」做时间窗，本模块只负责文本。
 *
 * 为什么满 12 小时写成「昨晚的梦」：
 *   12 小时基本跨过了一整夜，主人多半睡过一觉；这时说「昨晚的梦」才不突兀。
 *   2–12 小时写成「今天见到你之前的碎片」，落点是当天、是零碎见闻，不是梦。
 */

/** 2 小时：低于这个离线时长的「离开」多半只是刷新，不值得写日记 */
const MIN_OFFLINE_MS = 2 * 60 * 60 * 1000

/** 12 小时：基本跨过一夜，从「今天的碎片」切到「昨晚的梦」 */
const DREAM_OFFLINE_MS = 12 * 60 * 60 * 1000

/** summary 可能很长，只扫前 2000 字；再长也只是从里面找词，没必要全量扫 */
const MAX_SUMMARY_CHARS = 2000

export type DiaryInput = {
  now: number
  lastSeenAt: number
  /** 记忆摘要（来自宿主 memory.json 的 summary，可为空串） */
  summary?: string
  /** 最近事件类型（如 'long-work' | 'late-night' | 'idle' | 'welcome-back'），可为空 */
  recentEvent?: string
  /** 当前亲密度 0-100，可为缺省 */
  intimacy?: number
}

/** 语气只分三档：<30 疏离、30–69 平常、>=70 黏人；缺省按平常 */
type Tone = 'low' | 'mid' | 'high'

/** 两种文体：当天碎片 / 昨晚的梦 */
type Mode = 'fragment' | 'dream'

/**
 * summary 词表：每个词只映射到一个抽象意象，不保留原词。
 * 故意不收医院、工资、姓名之类容易变成隐私复述的词——命中不了就只写环境。
 */
type KeywordGroup = { keys: readonly string[]; image: string }

const KEYWORD_GROUPS: readonly KeywordGroup[] = [
  { keys: ['材料', '文件', '报告', '论文', '文档', '表格', '稿子', '作业'], image: '一叠纸' },
  { keys: ['代码', '程序', '项目', '数据', '电脑', '键盘', '屏幕', '邮件', '消息'], image: '一排发光的小格子' },
  { keys: ['会议', '开会', '电话', '客户', '同事', '领导', '沟通'], image: '一串散不开的声音' },
  { keys: ['咖啡', '茶', '饭', '糖', '药', '零食', '水果'], image: '一圈暖暖的涟漪' },
  { keys: ['鱼干', '小鱼', '罐头'], image: '一小片鱼干' },
  { keys: ['音乐', '歌', '电影', '游戏', '诗', '故事', '小说'], image: '一串会游的音符' },
  { keys: ['猫', '狗', '鸟', '蝴蝶', '花', '草', '树'], image: '一个会摆尾的小影子' },
  { keys: ['学习', '考试', '上课', '课程', '复习', '背单词'], image: '一排整齐的贝壳' },
  { keys: ['出差', '旅行', '飞机', '火车', '地铁', '远方'], image: '一条远得看不见的航线' },
  { keys: ['睡觉', '休息', '困', '累', '熬夜', '失眠'], image: '一团软软的水母' },
  { keys: ['家人', '朋友', '主人', '回家', '回来', '想你'], image: '岸上的一点灯光' },
  { keys: ['工作', '加班', '任务', '公司', '忙'], image: '一串赶路的泡泡' },
  { keys: ['雨', '风', '雪', '天气', '冷', '热'], image: '一阵很轻的潮声' },
]

const DREAM_OPEN: Readonly<Record<Tone, string>> = {
  low: '昨晚本鲸梦见自己在深一点的水里。',
  mid: '昨晚本鲸做了一个梦。',
  high: '昨晚本鲸梦见你回来了。',
}

const FRAGMENT_OPEN: Readonly<Record<Tone, string>> = {
  low: '今天见到你之前，本鲸在深一点的水里待着。',
  mid: '今天见到你之前，本鲸捡到几片碎碎的光。',
  high: '今天见到你之前，本鲸数着泡泡等你。',
}

const DREAM_SCENE: Readonly<Record<Tone, string>> = {
  low: '泡泡从海沟底浮到水面，半路就散了。',
  mid: '咕噜一声，泡泡从海沟底浮到水面。',
  high: '咕噜一声，泡泡把梦托到了水面。',
}

const FRAGMENT_SCENE: Readonly<Record<Tone, string>> = {
  low: '咕噜一声，泡泡贴着海沟慢慢散了。',
  mid: '咕噜一声，泡泡贴着珊瑚散开了。',
  high: '咕噜一声，海沟的水都亮了一点。',
}

const DREAM_CLOSE: Readonly<Record<Tone, string>> = {
  low: '水面很静，本鲸没打算特意浮上去。',
  mid: '珊瑚晃了两下，本鲸就醒了。',
  high: '醒来时，本鲸想游到你身边。',
}

const FRAGMENT_CLOSE: Readonly<Record<Tone, string>> = {
  low: '本鲸没等多久，只是刚好路过。',
  mid: '鱼干还剩半条，本鲸分你一半。',
  high: '你回来得正好，泡泡还没散。',
}

/** 最近事件只影响一句环境描写；认不出的事件回落到默认环境句 */
const EVENT_SCENE: Readonly<Record<string, string>> = {
  'long-work': '主人忙的时候，本鲸把泡泡吹得小一点。',
  'late-night': '夜里的海很安静，本鲸的咕噜声显得有点大。',
  'idle': '水面很久没动静，本鲸数泡泡数到发呆。',
  'welcome-back': '听见你回来的动静，本鲸把尾巴摆正了。',
}

/** 亲密度 → 语气档；缺省、NaN、非数字都按平常处理，别因脏数据把语气写崩 */
function toneOf(intimacy: unknown): Tone {
  if (typeof intimacy !== 'number' || !Number.isFinite(intimacy)) return 'mid'
  if (intimacy < 30) return 'low'
  if (intimacy < 70) return 'mid'
  return 'high'
}

/**
 * 按标点/空白把 summary 切成小句，并记下每句在原文里的起点。
 * 用起点排序，保证「先出现的词先织进句子」，不受词表顺序影响。
 */
function splitClauses(text: string): Array<{ text: string; at: number }> {
  const out: Array<{ text: string; at: number }> = []
  const re = /[^，。！？；：、,.!?;:\s]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) out.push({ text: m[0], at: m.index })
  return out
}

/**
 * 从 summary 提取关键词：按小句扫词表，最多取 2 个不同意象。
 * 只认词表里的名词性词——这既是「简单规则」，也是不把 summary 原样搬进
 * 日记的保险：认不出的词一律不写，就不会编出「你昨天删了第 42 行」这种事实。
 */
function pickKeywordImages(summary: unknown): string[] {
  if (typeof summary !== 'string') return []
  const text = summary.slice(0, MAX_SUMMARY_CHARS)
  const hits: Array<{ at: number; group: number }> = []

  for (const clause of splitClauses(text)) {
    for (let g = 0; g < KEYWORD_GROUPS.length; g++) {
      const group = KEYWORD_GROUPS[g]
      let first = -1
      for (const key of group.keys) {
        const at = clause.text.indexOf(key)
        if (at >= 0 && (first < 0 || at < first)) first = at
      }
      if (first >= 0) hits.push({ at: clause.at + first, group: g })
    }
  }

  hits.sort((a, b) => a.at - b.at || a.group - b.group)
  const images: string[] = []
  const used = new Set<number>()
  for (const hit of hits) {
    if (used.has(hit.group)) continue
    used.add(hit.group)
    images.push(KEYWORD_GROUPS[hit.group].image)
    if (images.length >= 2) break
  }
  return images
}

/** 把抽象意象织成一句；两种文体各一套说法，不写任何具体动作 */
function keywordSentence(mode: Mode, image: string, order: number): string {
  if (mode === 'dream') {
    return order === 0
      ? '梦里有' + image + '，浮在珊瑚边上。'
      : '还有' + image + '，跟着泡泡慢慢转。'
  }
  return order === 0
    ? '水面漂来' + image + '，本鲸绕了两圈。'
    : '后来又漂来' + image + '，本鲸多看了两眼。'
}

/** 环境句：认得出的最近事件优先，否则按文体与语气取默认句 */
function sceneOf(mode: Mode, tone: Tone, recentEvent: unknown): string {
  if (typeof recentEvent === 'string') {
    const hit = EVENT_SCENE[recentEvent]
    if (typeof hit === 'string') return hit
  }
  return mode === 'dream' ? DREAM_SCENE[tone] : FRAGMENT_SCENE[tone]
}

/**
 * 拼一篇离线日记。
 *
 * @param input 离线时长、记忆摘要、最近事件、亲密度
 * @returns 2–4 句短句；离线不足 2 小时、时间字段非法或时间倒流时返回 null。
 *          同一输入永远返回同一段文字（没有随机、没有读时钟）。
 */
export function buildDiary(input: DiaryInput): string | null {
  if (!input || typeof input !== 'object') return null

  const now = input.now
  const lastSeenAt = input.lastSeenAt
  if (typeof now !== 'number' || typeof lastSeenAt !== 'number') return null
  if (!Number.isFinite(now) || !Number.isFinite(lastSeenAt)) return null

  const offlineMs = now - lastSeenAt
  // 时间倒流（lastSeenAt 比 now 还晚）同样按「没离开过」处理，不硬写一篇
  if (!Number.isFinite(offlineMs) || offlineMs < MIN_OFFLINE_MS) return null

  const mode: Mode = offlineMs >= DREAM_OFFLINE_MS ? 'dream' : 'fragment'
  const tone = toneOf(input.intimacy)
  const images = pickKeywordImages(input.summary)

  const parts: string[] = [mode === 'dream' ? DREAM_OPEN[tone] : FRAGMENT_OPEN[tone]]
  for (let i = 0; i < images.length; i++) parts.push(keywordSentence(mode, images[i], i))
  // 两个关键词已经占满四句的名额；这时舍弃环境句，保证「2–4 句」不越界
  if (images.length < 2) parts.push(sceneOf(mode, tone, input.recentEvent))
  parts.push(mode === 'dream' ? DREAM_CLOSE[tone] : FRAGMENT_CLOSE[tone])

  return parts.join('')
}
