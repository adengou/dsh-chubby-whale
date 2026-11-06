/**
 * host/personality/store.ts —— personality.json 的读写仓储（原子写 + 坏文件隔离）
 *
 * 持久化位置：~/.dsh-chubby-whale/personality.json，写盘走 host/atomic.ts 的原子写。
 * 读坏文件按 [personality] 前缀记日志、备份 .bad-<时间戳>，随后按空人格处理；
 * 读入时先剥 BOM（PowerShell 写出的 BOM 会让 JSON.parse 失败、误伤整份人格）。
 *
 * 本层只做“读 → 纯函数算 → 原子写”的接线，业务规则（清洗/合并/回滚/渲染）全在
 * merge.ts 与 segment.ts。IO 异常不抛给聊天链路：读失败返回空人格，写失败只记日志并回 false。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic, isMissingFileError, quarantineFile } from '../atomic.js'
import { PERSONALITY_FILE } from './model.js'
import type { PersonalityData, PersonalityHistoryEntry } from './model.js'
import {
  emptyPersonality,
  sanitizePersonality,
  applyCandidate,
  applySelfNarrative,
  revertLast,
} from './merge.js'
import { buildPersonalitySegment } from './segment.js'

export interface PersonalityLearnResult {
  data: PersonalityData
  changed: PersonalityHistoryEntry[]
  /** 是否真的写盘成功（没变化时为 false，写盘失败也为 false） */
  saved: boolean
}

export interface PersonalityRevertResult {
  data: PersonalityData
  entry: PersonalityHistoryEntry
  saved: boolean
}

export interface PersonalityNarrativeResult {
  data: PersonalityData
  /** 是否产生实际变更（空文本 / 与当前相同 → false，不写盘） */
  changed: boolean
  /** 是否真的写盘成功 */
  saved: boolean
}

export interface PersonalityRepo {
  /** 读当前可变人格（含历史），坏文件隔离后返回空人格 */
  load(): PersonalityData
  /** 原子写；成功返回 true，失败只记日志（不把 IO 异常抛给聊天链路） */
  save(data: PersonalityData): boolean
  /** 合并一次提取结果并落盘；没有新信息时不写盘 */
  learn(candidate: any, now?: Date): PersonalityLearnResult
  /** L3：写入一句近期心境（带历史回滚）；空/未变化不写盘 */
  writeNarrative(text: string, now?: Date): PersonalityNarrativeResult
  /** 回滚上一条变更；无可回滚时返回 null */
  revert(now?: Date): PersonalityRevertResult | null
  /** 当前人格对应的提示词附加段（≤160 字，空则空串） */
  segment(): string
}

export function createPersonalityRepo(runtimeDir: string): PersonalityRepo {
  const file = join(runtimeDir, PERSONALITY_FILE)

  function load(): PersonalityData {
    let text = ''
    try {
      // 容错 BOM：带 BOM 的 JSON.parse 会失败，导致人格被误隔离
      text = String(readFileSync(file, 'utf8')).replace(/^\uFEFF/, '')
    } catch (err: any) {
      if (!isMissingFileError(err)) quarantineFile(file, err, '[personality]')
      return emptyPersonality()
    }
    try {
      return sanitizePersonality(JSON.parse(text))
    } catch (err: any) {
      quarantineFile(file, err, '[personality]')
      return emptyPersonality()
    }
  }

  function save(data: PersonalityData): boolean {
    try {
      writeJsonAtomic(file, sanitizePersonality(data))
      return true
    } catch (err: any) {
      console.error('[personality] SAVE-ERR ' + String((err && err.message) || err))
      return false
    }
  }

  function learn(candidate: any, now: Date = new Date()): PersonalityLearnResult {
    const base = load()
    const result = applyCandidate(base, candidate, now.toISOString())
    if (!result.changed.length) return { data: base, changed: [], saved: false }
    const saved = save(result.data)
    return { data: result.data, changed: result.changed, saved }
  }

  function writeNarrative(text: string, now: Date = new Date()): PersonalityNarrativeResult {
    const base = load()
    const result = applySelfNarrative(base, text, now.toISOString())
    if (!result.changed.length) return { data: base, changed: false, saved: false }
    const saved = save(result.data)
    return { data: result.data, changed: true, saved }
  }

  function revert(now: Date = new Date()): PersonalityRevertResult | null {
    const base = load()
    const result = revertLast(base, now.toISOString())
    if (!result) return null
    const saved = save(result.data)
    return { data: result.data, entry: result.entry, saved }
  }

  return { load, save, learn, writeNarrative, revert, segment: (): string => buildPersonalitySegment(load()) }
}
