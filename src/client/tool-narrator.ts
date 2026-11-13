/**
 * client/tool-narrator.ts —— 工具调用实况解说（纯函数）
 *
 * 肥鲸不下场解释「这个工具在干什么」，只在旁边把 DSH 干活的节奏翻译成一句鲸鱼视角的嘀咕：
 * 翻抽屉、吹泡泡、去别人家海里捞东西……要不要说、说什么，全在这里决定。
 * 订阅端 client/tool-watch.ts 只负责把 /nervous 的 tool/call 事件喂进来。
 *
 * 三条硬约束（也是 scripts/test-tool-narrator.mjs 守的东西）：
 *   1. 确定性：同一 (state, input) 永远得到同一句。选句只用「工具名哈希 + 序号」，
 *      不掷骰子、不读系统时钟；时间一律来自 input.at。
 *   2. 纯函数、零依赖：不碰 DOM、浏览器存储或网络，也不自己起定时器；
 *      state 由调用方保存并回传，本模块不持有任何外部可变状态。
 *   3. 防骚扰：任意两句解说至少隔 15 秒；同一句 30 秒内不许重复（理由见下面两处注释）。
 */

/** 工具大类：只用来选文案池，不对调用方暴露 */
type ToolKind = 'file' | 'edit' | 'shell' | 'web' | 'search' | 'plan' | 'other'

/** 文案组：同一组里「单次」与「连环」两种口径，保证切换节奏时不会撞句 */
type LinePair = { single: string; burst: string }

/** 输入：一次工具调用。seq 是宿主的事件序号（可选，只用于确定性选句） */
export type ToolNarrateInput = { tool: string; at: number; seq?: number }

/** 解说的全部记忆。调用方只负责原样回传，不要自己解读这些字段 */
export type NarratorState = {
  lastAt: number
  lastTool: string
  lastLineAt: number
  burstStartAt: number
  burstCount: number
}

/** 输出：归一后的 state + 这次要不要冒一句（null = 这次不说） */
export type NarratorResult = { state: NarratorState; line: string | null }

/**
 * 任意两句解说的最小间隔。
 *
 * 为什么是 15 秒：DSH 干活时工具调用是**成串**的（读一个文件、再读一个、再跑一下命令），
 * 如果每次调用都冒一句，气泡会像机枪一样刷屏，既盖住肥鲸本来在说的话，也让人烦。
 * 15 秒大约是一句气泡读完（tool-watch 给 5.2 秒停留）再眨一次眼的长度：
 * 既跟得上长任务的节奏，又留出安静的空档，像真的在旁边小声看，而不是报幕。
 */
const LINE_GAP_MS = 15_000

/**
 * 同一句话的封禁窗口。
 *
 * 为什么是 30 秒：15 秒冷却只保证「不连续刷」，不保证「不重复」。文案池每类只有
 * 3 组，30 秒里最多能冒 3 句（0s / 15s / 29.9s），同一句要是回来两遍，立刻就是
 * 复读机、出戏。30 秒 = 两倍最小间隔，正好把「一个短窗口内的重复」压掉，又不会
 * 长到让池子里的句子永远轮不上。
 */
const SAME_LINE_MS = 30_000

/**
 * 连续同类调用的观察窗。
 *
 * 只看「同一类、且上一次也是这一类」的连续段：状态里没有时间戳数组，滚动窗口存不下；
 * 以这一轮第一次同类调用为起点、60 秒内累计到 3 次，就认为它在「连着干同一类活」。
 */
const BURST_WINDOW_MS = 60_000

/** 同一类工具在观察窗内出现到第几次，改用「连环」文案 */
const BURST_MIN_COUNT = 3

/**
 * 「从未出过声」的时间戳。
 *
 * 为什么不用 0：0 是合法时间戳（at=0 的测试很常见），既当哨兵又当数据会让第一句
 * 被 15 秒冷却误杀。用 -Infinity 表示「无限久以前」，任何有限的 at 减去它都远超
 * 冷却窗口，第一句自然放行；它仍然是 number，不破坏 state 的类型契约。
 */
const NEVER_AT = Number.NEGATIVE_INFINITY

/** 最近几句的记忆上限：30 秒内最多 3 句（0s / 15s / 29.9s），再多也记不住 */
const RECENT_MAX = 3

/**
 * 最近出过的句子（含时间），挂在 state 的非枚举 Symbol 上随 state 回传。
 *
 * 为什么不用普通字段：规格把 NarratorState 的五个字段钉死了，不能加 lastLine；
 * 但「同一句 30 秒内不重复」必须知道上一句是什么。折中方案是隐藏记忆：
 *   · 非枚举 + Symbol ⇒ 不进 JSON、不进 Object.keys、不改变公开字段；
 *   · 不落在模块级变量里 ⇒ 不读取任何外部可变状态，同一 (state, input) 结果仍确定；
 *   · state 被 JSON 序列化/手工重建后记忆会丢，此时退回「15 秒时间槽轮换」的保守策略。
 * 这样既守住接口，又把防复读做到位。
 */
const RECENT = Symbol('tool-narrator/recent')

/** 最近一句的压缩记录 */
type RecentLine = { line: string; at: number }

/**
 * 分类关键词表。按「关键词在工具名里最早出现的位置」定类，而不是按表的先后。
 *
 * 为什么要按位置：工具名常带前缀/后缀，比如 todo_write 同时含 todo（plan）和
 * write（edit）；按表顺序会被后面的 write 抢走，按最早出现的位置才会归到 todo。
 * 同一位置命中两类时（如 browse 同时属于 file / web），保持这张表的先后（file 在前）。
 * 规格里 search 一词列在 web 下，所以名为 search 的工具归 web；真正的 search
 * 大类由 grep / glob / find / rg 这些更明确的关键词触发。
 */
const CLASS_KEYWORDS: ReadonlyArray<readonly [ToolKind, readonly string[]]> = [
  ['file', ['read', 'cat', 'view', 'open', 'browse', 'ls', 'list']],
  ['edit', ['write', 'edit', 'create', 'patch', 'apply']],
  ['shell', ['bash', 'shell', 'exec', 'run', 'command', 'terminal', 'pwsh', 'cmd']],
  ['web', ['web', 'search', 'fetch', 'http', 'browse']],
  ['search', ['grep', 'glob', 'find', 'rg']],
  ['plan', ['task', 'todo', 'plan']],
]

/**
 * 七类文案池：每类 3 组，每组一个单次口径 + 一个连环口径。
 *
 * 写文案的三条自我约束：
 *   · 不解释工具（不说「它在读文件」），只写旁边看到动作节奏的反应；
 *   · 鲸鱼视角（抽屉、泡泡、海底、沙、浪），带「咕噜」与「本鲸」；
 *   · 单次句是「一个小动作」，连环句必须让人听出「它在连着干」——但两种口径
 *     字面完全不同，切换时不会出现同一句。
 */
const POOLS: Readonly<Record<ToolKind, readonly LinePair[]>> = {
  file: [
    { single: '咕噜……它在翻你的抽屉。', burst: '它在翻好几个抽屉，咕噜咕噜。' },
    { single: '它把贝壳一片片翻过来看。', burst: '贝壳一片接一片，它翻得尾巴都翘了。' },
    { single: '又低头翻你的小箱子，本鲸看着呢。', burst: '箱子一个接一个，本鲸的泡泡都看困了。' },
  ],
  edit: [
    { single: '它拿笔在纸上涂涂改改。', burst: '它连着改了好几处，泡泡都冒歪了。' },
    { single: '咕噜，它给贝壳补了一笔。', burst: '补完一片又一片，它手都没停。' },
    { single: '它动笔了，本鲸不吵它。', burst: '改了一处又一处，本鲸在边上看着。' },
  ],
  shell: [
    { single: '这个泡泡吹得有点久。', burst: '泡泡一个接一个，吹个不停。' },
    { single: '咕噜……它沉下去了，还没浮上来。', burst: '它连着往下潜，本鲸的尾巴都摆累了。' },
    { single: '它在海底敲敲打打，本鲸等着。', burst: '海底的泡泡冒了一串又一串。' },
  ],
  web: [
    { single: '又去别人家海里捞东西了。', burst: '它一趟一趟往别人家海里跑。' },
    { single: '咕噜，它游到很远的海面去了。', burst: '别人家的浪，它一浪接一浪地翻。' },
    { single: '它探头看别人家的浪，本鲸不跟。', burst: '别人家海里的东西快被它捞遍了。' },
  ],
  search: [
    { single: '咕噜……它把头埋进沙子里找东西。', burst: '它在沙子里翻来翻去，找了好几样。' },
    { single: '它在珊瑚缝里扒拉，尾巴一甩一甩。', burst: '一片沙接一片沙，它扒拉个没完。' },
    { single: '它眯着眼在沙里挑，本鲸帮不上。', burst: '它把整片海底都筛了一遍，咕噜。' },
  ],
  plan: [
    { single: '它在小本本上划了一道。', burst: '它把清单划了好几遍，咕噜。' },
    { single: '咕噜，它把要做的事排成一排。', burst: '一条接一条，本鲸都替它眼晕。' },
    { single: '它低头数泡泡，数得很认真。', burst: '它的小本本快写满了，咕噜。' },
  ],
  other: [
    { single: '咕噜……它在忙些本鲸看不懂的。', burst: '它围着同一个泡泡转了好几圈。' },
    { single: '它围着个泡泡转，本鲸先不打扰。', burst: '一阵接一阵，本鲸的尾巴都看愣了。' },
    { single: '它又伸手够什么东西了，咕噜。', burst: '它忙得泡泡直冒，咕噜咕噜。' },
  ],
}

/** 取模到非负区间：seq 可能是负数，最后必须落在 [0, n) */
function mod(n: number, m: number): number {
  const r = n % m
  return r < 0 ? r + m : r
}

/** 工具名哈希（FNV-1a 变体）：只依赖字符码，跨引擎、跨次运行完全一致 */
function hashTool(name: string): number {
  let h = 2166136261
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 按关键词最早出现的位置归类；一个都没命中就是 other */
function classifyTool(name: string): ToolKind {
  const lower = name.toLowerCase()
  let kind: ToolKind = 'other'
  let bestAt = Infinity
  for (const group of CLASS_KEYWORDS) {
    for (const key of group[1]) {
      const at = lower.indexOf(key)
      if (at >= 0 && at < bestAt) {
        bestAt = at
        kind = group[0]
      }
    }
  }
  return kind
}

/** 有限数才认，否则回退（state 可能来自旧版本或手写对象） */
function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 读隐藏记忆；坏数据一律当作没有 */
function recentOf(state: NarratorState | null | undefined): RecentLine[] {
  if (!state || typeof state !== 'object') return []
  const raw = (state as any)[RECENT]
  if (!Array.isArray(raw)) return []
  const out: RecentLine[] = []
  for (const item of raw) {
    if (!item || typeof item.line !== 'string' || !item.line) continue
    const at = finiteOr(item.at, NaN)
    if (!Number.isFinite(at)) continue
    out.push({ line: item.line, at })
  }
  return out.slice(-RECENT_MAX)
}

/** 把隐藏记忆挂到新 state 上（失败也不影响出句：最多退化成按时间槽轮换） */
function attachRecent(state: NarratorState, recent: RecentLine[]): NarratorState {
  try {
    Object.defineProperty(state, RECENT, { value: recent, enumerable: false, configurable: true })
  } catch (e) { /* 极端情况：state 被冻结；记忆丢了不是功能错误 */ }
  return state
}

/** 把外部传进来的 state 归一：字段类型不对就回退，隐藏记忆尽量保留 */
function normalizeState(prev: NarratorState | null | undefined): NarratorState {
  const p: any = prev && typeof prev === 'object' ? prev : {}
  const count = Math.floor(finiteOr(p.burstCount, 0))
  const state: NarratorState = {
    lastAt: finiteOr(p.lastAt, 0),
    lastTool: typeof p.lastTool === 'string' ? p.lastTool : '',
    lastLineAt: finiteOr(p.lastLineAt, NEVER_AT),
    burstStartAt: finiteOr(p.burstStartAt, 0),
    burstCount: count > 0 ? count : 0,
  }
  return attachRecent(state, recentOf(prev))
}

/**
 * 选一句文案。
 *
 * 索引 = (工具名哈希 + 序号) mod 池长：
 *   · 哈希让不同工具（甚至同类的不同工具）落在不同句子，避免「所有读文件都同一句」；
 *   · 序号优先用宿主给的 seq；宿主没给时退化为 15 秒时间槽编号（Math.floor(at / 15000)），
 *     保证相邻两次合法解说不会因为序号缺失而永远挑中同一句；
 *   · 做完这层确定性选择后，再避开 30 秒内刚出过的句子（隐藏记忆）。正常节奏下
 *     30 秒内最多堆 2 句旧句，池子 3 组，必定还能找到一句没出过的。
 */
function pickLine(kind: ToolKind, tool: string, at: number, seq: number | undefined, burst: boolean, recent: RecentLine[]): string {
  const pool = POOLS[kind]
  const ordinal = typeof seq === 'number' && Number.isFinite(seq)
    ? Math.trunc(seq)
    : Math.floor(at / LINE_GAP_MS)
  // 哈希前先转小写：同一工具名大小写不同（Read_File / read_file）应落在同一句，
  // 否则「确定性」会被人为的大小写抖动破坏。
  const base = mod(hashTool(tool.toLowerCase()) + ordinal, pool.length)
  const blocked = new Set<string>()
  for (const item of recent) blocked.add(item.line)

  for (let i = 0; i < pool.length; i++) {
    const pair = pool[mod(base + i, pool.length)]
    const line = burst ? pair.burst : pair.single
    if (!blocked.has(line)) return line
  }
  // 理论上到不了：30 秒内最多 3 句、每类正好 3 组。真被坏 state 堵满时宁可不换也不返回 null。
  return burst ? pool[base].burst : pool[base].single
}

/**
 * 喂进一次工具调用，决定这次要不要冒一句。
 *
 * @param prev 上一次返回的 state；首次传 null
 * @param input tool=工具名（大小写不敏感）、at=事件时间（毫秒）、seq=可选事件序号
 * @returns 归一后的 state 与解说句；冷却中或输入非法时 line 为 null（state 仍会更新）
 */
export function narrateTool(prev: NarratorState | null, input: ToolNarrateInput): NarratorResult {
  const base = normalizeState(prev)

  // 非法输入只归一 state、绝不出句：tool 必须是非空字符串，at 必须是有限数字。
  // 这样宿主偶尔喂进半条事件/脏 JSON 时，桌宠不会冒出半句莫名其妙的话，也不会抛错。
  const tool = input && typeof input.tool === 'string' ? input.tool.trim() : ''
  const at = input && typeof input.at === 'number' && Number.isFinite(input.at) ? input.at : NaN
  if (!tool || !Number.isFinite(at)) return { state: base, line: null }

  // ── 连续同类调用：只看「上一类也是它」的连续段（见 BURST_WINDOW_MS 的注释） ──
  const kind = classifyTool(tool)
  const prevKind = base.lastTool ? classifyTool(base.lastTool) : null
  const sameRun = prevKind === kind && base.burstCount > 0
    && at >= base.burstStartAt
    && at - base.burstStartAt < BURST_WINDOW_MS
  const burstStartAt = sameRun ? base.burstStartAt : at
  const burstCount = sameRun ? base.burstCount + 1 : 1

  // 记忆里只留当前时刻仍在 30 秒窗口内的句子；at 回退（时钟倒退）的旧记忆也一并丢掉
  const recent = recentOf(base).filter((item) => at - item.at >= 0 && at - item.at < SAME_LINE_MS)

  // ── 冷却：两次解说之间至少隔 15 秒；被压制也要记下这次调用（换 lastTool、累计节奏） ──
  if (at - base.lastLineAt < LINE_GAP_MS) {
    const state = attachRecent({
      lastAt: at,
      lastTool: tool,
      lastLineAt: base.lastLineAt,
      burstStartAt,
      burstCount,
    }, recent)
    return { state, line: null }
  }

  /*
   * 为什么连续调用要换「连环」文案：
   * 单次句说的是「它翻了一个抽屉」，听得出是一次动作；可当同一类工具在一分钟里
   * 连着出现三回，真正值得说的是「它在一路翻下去」这个节奏。还用单次句，就像
   * 没看见它在连轴转，解说会显得迟钝。连环句只换旁观口径（好几个 / 一个接一个 /
   * 一趟一趟），依旧不解释工具本身——肥鲸只是把看到的节奏说出来。
   */
  const burst = burstCount >= BURST_MIN_COUNT
  const line = pickLine(kind, tool, at, input.seq, burst, recent)
  const state = attachRecent({
    lastAt: at,
    lastTool: tool,
    lastLineAt: at,
    burstStartAt,
    burstCount,
  }, [...recent, { line, at }].slice(-RECENT_MAX))
  return { state, line }
}
