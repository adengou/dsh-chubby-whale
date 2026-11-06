/**
 * host/personality.ts —— L2「可变人格」+ L3「近期心境」的对外门面（personality/**）
 *
 * 这里是这条边界唯一对外的接口；实现按职责拆在 personality/ 下，本文件只做转发，
 * 导出名与行为保持不变（personality-learn.ts / personality-write.ts / routes/personality.ts /
 * routes/backup.ts / index.ts 都从本文件进）：
 *
 *   personality/model.ts    数据模型、上限常量、身份词词表（CORE_GUARD / SELF_GUARD）
 *   personality/merge.ts    清洗 / 去重 / 合并 / 一次最多 2 字段 / 回滚（纯函数）
 *   personality/segment.ts  注入系统提示词的附加段与超限舍弃（纯函数）
 *   personality/store.ts    personality.json 读写仓储（原子写、坏文件隔离）
 *
 * 分层约定（不变）：
 *   · 核心设定（名字 / 家人 / 生日 / 出生地 / 语言规则 / 安全边界）只写在 src/index.ts 的
 *     SYSTEM_PROMPT 常量里，本模块**不存、不写、不改**这些字段；L2 提取结果按白名单只收
 *     catchphrases / preferences / notes，L3 只写 selfNarrative（≤80 字的一句心境），
 *     其它键一律丢弃。模型输出永远进不了核心提示词。
 *   · 可变人格只是 SYSTEM_PROMPT 末尾的一小段附加（总长 ≤160 字），改坏了用历史回滚。
 *   · L3 心境额外过 SELF_GUARD 身份词红线（我是/改名/爸爸/妈妈/生日…），命中即丢弃。
 *
 * 持久化：~/.dsh-chubby-whale/personality.json，走 host/atomic.ts 原子写。
 * 读坏文件按 [personality] 前缀记日志、备份 .bad-<时间戳>，随后按空人格处理。
 */

export {
  PERSONALITY_FILE,
  PERSONALITY_LIMITS,
  MAX_FIELDS_PER_LEARN,
  LEARNABLE_FIELDS,
  SELF_NARRATIVE_FIELD,
} from './personality/model.js'
export type {
  PersonalityField,
  PersonalityHistoryEntry,
  PersonalityData,
} from './personality/model.js'

export {
  isSafeLearnedText,
  isUnsafeSelfNarrative,
  stripSelfNarrative,
  cleanSelfNarrative,
  validateSelfNarrative,
  mergeList,
  emptyPersonality,
  sanitizePersonality,
  applyCandidate,
  applySelfNarrative,
  revertLast,
} from './personality/merge.js'
export type { SelfNarrativeReason, SelfNarrativeCheck } from './personality/merge.js'

export { buildPersonalitySegment } from './personality/segment.js'

export { createPersonalityRepo } from './personality/store.js'
export type {
  PersonalityLearnResult,
  PersonalityRevertResult,
  PersonalityNarrativeResult,
  PersonalityRepo,
} from './personality/store.js'
