/**
 * shared/team-contract.ts —— 鲸鱼看板与 AgentTeam 的唯一公开契约。
 *
 * 只放类型，不放实现：
 *   · shared/team-board.ts   纯函数实现摘要/展示
 *   · client/team-source.ts  投影/审批适配器
 *   · client/team-surface.ts 独立挂件 + 调度器线路
 *
 * 约束：本文件不 import 任何 DSH 内部模块、不碰 DOM、不读日志。
 */
export {};
