/**
 * host/backup/export.ts —— 导出包组装与体积上限（纯读，不写盘）
 *
 * 从 routes/backup.ts 拆出（行为等价）。边界不变：
 *   · 只经注入的 load* 读取记忆/人格/状态/成长/鱼粮/宠物/提醒/说书进度，
 *     **不读 config.json、不读环境变量、不 import host/config.ts**——API Key 没有进入导出包的通路；
 *   · 人格只出可变层四字段（sanitizePersonality），核心设定（名字/家人/生日/语言规则）不会出现在包里；
 *   · 导出包固定为「8 个数据字段 + ok/version/exportedAt 三个元数据」。
 *
 * 敏感内容口径（审计记录，2026-11-06，**本次不改**）：
 *   · memory 带的是最近 40 条聊天原文 + 摘要。原文属于主人本机隐私，但这是“一键备份”的
 *     预期语义——恢复时要能带回聊天记录，只导摘要会让备份变成半份数据，故保留原文；
 *   · 聊天原文里可能含主人主动粘贴的密钥/口令（例如对话里试过 `sk-...`）。这里不做内容级
 *     脱敏：一是无法可靠识别所有密钥形态，二是脱敏会永久改写备份内容，恢复后数据不可逆丢失。
 *     风险由“导出接口仅本机可访问 + 用户主动点击下载”承担；若日后要做，应在下载前给出提示，
 *     而不是静默改写包内容；
 *   · 导出包里没有 config.json、没有任何 Key 读取器，`apiKey`/`deepseekKey` 等字段不会出现。
 *
 * 体积：先组装再序列化量 UTF-8 字节数，超 BACKUP_MAX_BYTES 回 413、不带部分数据。
 * 导出数据源是本机文件，无法像导入那样在读取前按 content-length 预检；组装阶段的内存峰值
 * 受现有数据文件大小影响。运行时各仓储本身有上限（记忆 40 条、人格历史 20 条等），正常远低于 2MB。
 */
import { sanitizePersonality } from '../personality.js'
import { BACKUP_MAX_BYTES } from './fields.js'

/** 导出只读依赖（与 BackupDeps 的读部分同构；handler 传完整依赖也能通过） */
export interface ExportDeps {
  /** 插件版本（导出包里的 version） */
  version?: string
  loadMemory: () => { history?: any[]; summary?: string }
  loadPersonality: () => any
  loadState: () => any
  loadGrowth: () => any
  loadFishfood: () => any
  loadPet: () => any
  loadReminders: () => any[]
  loadStoryProgress: () => any
}

/**
 * 组装导出包。只读现有数据，不含 Key（本函数拿不到 config 的任何读取器）。
 * 字段取值尽量保真：状态/成长/鱼粮/宠物/提醒/说书进度原样带出，人格只出可变层四字段。
 */
export function buildExport(deps: ExportDeps, now: Date): any {
  const memory = (() => {
    try {
      const m = deps.loadMemory()
      return { history: Array.isArray(m && m.history) ? m.history : [], summary: String((m && m.summary) || '') }
    } catch {
      return { history: [], summary: '' }
    }
  })()
  const safe = (read: () => any, fallback: any): any => {
    try { const v = read(); return v === undefined || v === null ? fallback : v } catch { return fallback }
  }
  return {
    ok: true,
    version: String(deps.version || '0.0.0'),
    exportedAt: now.toISOString(),
    memory,
    personality: sanitizePersonality(safe(deps.loadPersonality, {})),
    state: safe(deps.loadState, {}),
    growth: safe(deps.loadGrowth, {}),
    fishfood: safe(deps.loadFishfood, {}),
    pet: safe(deps.loadPet, {}),
    reminders: safe(deps.loadReminders, []),
    storyProgress: safe(deps.loadStoryProgress, {}),
  }
}

/**
 * 量导出包的 UTF-8 字节数。序列化失败（循环引用、过深层级等）返回 Infinity，
 * 由调用方按“超限”处理——宁可回 413，也不把半个包发出去。
 */
export function measureExportBytes(payload: any): number {
  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8')
  } catch {
    return Infinity
  }
}

/** 导出包是否超过上限（单独成函数便于离线断言） */
export function isExportTooLarge(size: number): boolean {
  return !(size <= BACKUP_MAX_BYTES)
}
