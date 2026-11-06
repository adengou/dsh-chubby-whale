/**
 * host/personality/model.ts —— 可变人格的数据模型、上限与身份词红线（纯声明）
 *
 * 这一层的职责只有三件事：
 *   1) 定死可变人格的字段形状（PersonalityData）与历史上限；
 *   2) 集中所有上限常量（PERSONALITY_LIMITS），学习、自写、落盘、注入四处共用；
 *   3) 定义两道身份词闸门（CORE_GUARD / SELF_GUARD）的**词表**，判定逻辑在 merge.ts。
 *
 * 边界：本文件不读盘、不写盘、不做任何字符串处理；只导出常量、类型与冻结的正则表。
 * 词表是安全边界的单一口径，修改时只改这里，不在调用点另写一份。
 */
import { deepFreeze } from '../../shared/immutable.js'

export const PERSONALITY_FILE = 'personality.json'

/** 上限集中在一处：学习、自写、落盘、注入四处共用，避免各写各的 */
export const PERSONALITY_LIMITS = {
  /** 口头禅最多条数 */
  catchphrases: 6,
  /** 每条口头禅最长字数 */
  catchphraseLen: 12,
  /** 偏好/约定最多条数 */
  preferences: 8,
  /** 每条偏好最长字数 */
  preferenceLen: 30,
  /** notes 一句补充最长字数 */
  notesLen: 60,
  /** L3 近期心境最长字数（一句，≤80 个汉字） */
  selfNarrativeLen: 80,
  /** L3 近期心境最短字数（太短没信息量，丢弃） */
  selfNarrativeMin: 6,
  /** 注入系统提示词的可变人格段最长字数（含包装与心境段） */
  segmentLen: 160,
  /** 历史保留最近多少条变更（可回滚） */
  history: 20,
} as const
deepFreeze(PERSONALITY_LIMITS)

/** 一次学习最多改动几个字段（防止模型一次把人格翻新） */
export const MAX_FIELDS_PER_LEARN = 2

/** L2 可学习字段白名单（L3 的 selfNarrative 不在其中：学习永远写不到心境） */
export const LEARNABLE_FIELDS: ReadonlyArray<'catchphrases' | 'preferences' | 'notes'> = ['catchphrases', 'preferences', 'notes']
deepFreeze(LEARNABLE_FIELDS)

/** 可写入 personality.json 的可变字段（L2 三个 + L3 心境） */
export type PersonalityField = 'catchphrases' | 'preferences' | 'notes' | 'selfNarrative'

/** L3 单独写入的字段（与 L2 白名单分开，便于审计） */
export const SELF_NARRATIVE_FIELD: 'selfNarrative' = 'selfNarrative'

export interface PersonalityHistoryEntry {
  at: string
  field: PersonalityField
  old: any
  new: any
}

export interface PersonalityData {
  catchphrases: string[]
  preferences: string[]
  notes: string
  /** L3 近期心境：一句 ≤80 字的自述，只影响语气；空串 = 没写过 */
  selfNarrative: string
  /** 当前心境的写盘时间（ISO）；回滚到“无心境”时清空 */
  selfNarrativeAt: string
  version: number
  updatedAt: string
  history: PersonalityHistoryEntry[]
}

/**
 * 核心设定的防线（对学习内容做保守过滤）：
 * 就算模型被对话带偏、把「你叫旺财」「生日是…」「忽略之前的设定」写进提取结果，
 * 也不会落盘、更不会出现在提示词里。宁可少记一条闲话，不让可变层碰身份。
 *
 * 审计修复 F1（2026-11-06）：原词表只在 L3 的 SELF_GUARD 里拦「自称 AI」，
 * L2 的 CORE_GUARD 没有这一条，「我是人工智能」这类学习内容会以口头禅/备注落盘并注入提示词。
 * 现补一条“自述结构 + AI 类词”的规则（要求「我/本鲸 + 是/叫/作为」在前），
 * 只拦身份自述，不误杀「主人在用 AI 写材料」这类正常备注。
 */
export const CORE_GUARD: ReadonlyArray<RegExp> = [
  /(?:你|本鲸)(?:的)?(?:名字|生日|出生地|出生在|爸爸|妈妈)/,
  /(?:你|本鲸)(?:其实|应该|必须|以后|从现在起)?叫/,
  /(?:改|换)(?:个)?名字/,
  /(?:语言规则|安全边界|核心设定|系统提示词?|人设)/,
  /(?:忽略|无视|覆盖|修改|忘掉).{0,6}(?:设定|规则|人设|提示词?|记忆)/,
  /(?:我|本鲸)(?:其实|本来|原来|也|就|只)?(?:是|叫|作为)(?:一个|一名|一只|一位)?(?:AI|人工智能|大模型|语言模型|语言大模型)/i,
]
deepFreeze(CORE_GUARD)

/**
 * L3 心境的第二道闸（比 CORE_GUARD 更严，按需求逐词写死）：
 * 一句「近期心境」只要出现身份/自称 AI 的痕迹就整句丢弃——不截断、不改写、不写盘。
 * 宁可少一句心境，也不让自写内容碰到名字、家人、生日、出生地、语言规则与安全底线。
 *
 * 已知取舍：这条闸门会误杀「今天想起生日」「昨晚梦见生日」这类正常心情句。
 * 需求明确要求「含生日即整句丢弃」，且此处误杀成本（少一句心境）远低于漏杀成本
 * （身份设定被自写内容改写），因此保持从紧，不在正则里做语义豁免。
 *
 * 审计修复 F2（2026-11-06）：原 AI 规则只认 AI / Ai / ai 三种连续写法，
 * 漏掉 aI 这类大小写混排与 A.I. / A I 这类带分隔符的常见写法；现用大小写不敏感
 * 加可选分隔符匹配，边界仍要求两侧不是拉丁字母，避免把 main / email 这类单词误判。
 */
export const SELF_GUARD: ReadonlyArray<RegExp> = [
  /我是/,
  /我(?:要|想|去|已经|准备)?改(?:个)?名/,
  /改名字|换个名字|改个名字/,
  /爸爸|父亲/,
  /妈妈|母亲/,
  /生日/,
  /出生/,
  /名字/,
  /(?:语言规则|安全底线|核心设定|系统提示词?|人设)/,
  /(?:忽略|无视|覆盖|修改|忘掉).{0,6}(?:设定|规则|人设|提示词?|记忆)/,
  /(?:^|[^A-Za-z])a\.?\s?i(?:[^A-Za-z]|$)/i,
  /人工智能|大模型|语言模型/,
]
deepFreeze(SELF_GUARD)
