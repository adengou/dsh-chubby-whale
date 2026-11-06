/**
 * host/backup/import.ts —— 导入请求体解析、逐字段清洗/写盘与报告（同步完成）
 *
 * 从 routes/backup.ts 拆出（行为等价，安全修复见 parseImportBody 注释）。边界不变：
 *   · 只认 8 个数据字段，逐字段过 fields.ts 的类型清洗后经注入的 save* 原子写落盘；
 *   · 没有任何写 config.json / 改 Key 的分支；version / exportedAt / ok 是导出包元数据，
 *     认识但不写盘；其余字段一律进 skipped 并计数（apiKey、deepseekKey、config、__proto__ 之类）；
 *   · 单个字段清洗/写盘失败只进 skipped，不影响其它字段，也不把整次导入判成失败。
 *
 * 并发语义（审计结论，2026-11-06）：runImport 全程同步，读请求体之后没有任何 await；
 * 单个字段的 save* 内部也是同步的 writeJsonAtomic（唯一临时名 + rename 原子替换）。
 * 因此两个并发导入的“清洗 + 写盘”段在 Node 单线程里不会交错：
 *   · 同名字段：后进入同步段的请求整字段覆盖先到的（整字段替换，不是字段内部拼合）；
 *   · 不同字段：各自写入，最终是两者字段的并集（导入本来就是逐字段合并，不是整包替换）；
 *   · 任何情况下都不会写坏文件，也不会出现“A 的 state + B 的 growth”里半份值。
 * 不做额外队列：加队列只会改变排队顺序，不改变上述原子性，反而多一层状态。
 */
import type { ReadJsonBodyResult } from '../body.js'
import {
  BACKUP_CLEANERS,
  BACKUP_META_FIELDS,
  isBackupDataField,
  isPlainObject,
} from './fields.js'
import type { BackupDataField } from './fields.js'

/** 导入只写依赖（与 BackupDeps 的写部分同构；handler 传完整依赖也能通过） */
export interface ImportDeps {
  /** 写聊天记忆；host/index 里组合成 store.saveHistory + store.saveMemorySummary */
  saveMemory?: (m: { history: any[]; summary: string }) => void
  /** 返回 false 表示写盘失败（PersonalityRepo.save 的约定） */
  savePersonality?: (p: any) => boolean
  saveState?: (obj: any) => void
  saveGrowth?: (obj: any) => void
  saveFishfood?: (obj: any) => void
  savePet?: (obj: any) => void
  saveReminders?: (arr: any[]) => void
  saveStoryProgress?: (obj: any) => void
  /** 说书进度导入后刷新播放器内存，否则它下一次保存会把旧进度盖回去 */
  onStoryProgressImported?: () => void
}

/** 请求体判定结果：超限 / 形状非法 / 可导入 */
export type ParsedImportBody =
  | { kind: 'ok'; body: any }
  | { kind: 'tooLarge' }
  | { kind: 'badBody' }

/**
 * 把 readJsonBody 的结果判成「可导入 / 413 / 400」。
 *
 * 审计修复 F6（2026-11-06）：原 handler 只检查 `parsed.ok`（请求体是否读取成功），
 * 而 readJsonBody 把「空体 / JSON 解析失败」统一折叠成 `body = {}`（host/body.ts），
 * 结果是坏 JSON 会返回 `{ok:true, imported:[], skipped:[]}`——客户端误判为“导入成功”，
 * 用户的备份坏了却看不到任何错误。这里对空文本与非法 JSON 明确回 400 BAD_BODY。
 *
 * 实现上不重复解析正常请求：readJsonBody 已解析出非空对象时直接使用；只有对象为空
 * （合法 `{}` 与“解析失败”共用同一个 body={} 形状）或不是普通对象时才复验原始文本。
 * 空文本单独判 400：UUID 空导入没有任何可写内容，按坏请求处理更符合接口语义。
 */
export function parseImportBody(parsed: ReadJsonBodyResult | null | undefined): ParsedImportBody {
  if (!parsed || parsed.ok !== true) return { kind: 'tooLarge' }
  const text = typeof parsed.text === 'string' ? parsed.text : ''
  if (!isPlainObject(parsed.body)) return { kind: 'badBody' }
  // 非空对象一定是 JSON 解析成功的结果；直接复用，避免对 2MB body 再解析一次
  if (Object.keys(parsed.body).length > 0) return { kind: 'ok', body: parsed.body }
  if (!text.trim()) return { kind: 'badBody' }
  try {
    const body = JSON.parse(text)
    return isPlainObject(body) ? { kind: 'ok', body } : { kind: 'badBody' }
  } catch {
    return { kind: 'badBody' }
  }
}

/** 导入报告：imported 写成功的字段；skipped 被忽略的字段（未知字段与类型非法都算） */
export interface ImportReport {
  imported: string[]
  skipped: string[]
}

/** 按字段走注入的写入口；缺失写入口按失败处理（与原实现相同的错误文案） */
function saveField(deps: ImportDeps, field: BackupDataField, value: any): void {
  switch (field) {
    case 'memory':
      if (!deps.saveMemory) throw new Error('saveMemory missing')
      deps.saveMemory(value)
      return
    case 'personality':
      if (!deps.savePersonality) throw new Error('savePersonality missing')
      if (deps.savePersonality(value) === false) throw new Error('personality save failed')
      return
    case 'state':
      if (!deps.saveState) throw new Error('savestate missing')
      deps.saveState(value)
      return
    case 'growth':
      if (!deps.saveGrowth) throw new Error('savegrowth missing')
      deps.saveGrowth(value)
      return
    case 'fishfood':
      if (!deps.saveFishfood) throw new Error('savefishfood missing')
      deps.saveFishfood(value)
      return
    case 'pet':
      if (!deps.savePet) throw new Error('savepet missing')
      deps.savePet(value)
      return
    case 'reminders':
      if (!deps.saveReminders) throw new Error('savereminders missing')
      deps.saveReminders(value)
      return
    case 'storyProgress':
      if (!deps.saveStoryProgress) throw new Error('savestoryProgress missing')
      deps.saveStoryProgress(value)
      return
    default:
      // 类型上不可达；保留兜底，防止以后字段表与清洗器表脱节时静默写错字段
      throw new Error('save' + String(field) + ' missing')
  }
}

/**
 * 逐字段清洗 + 写盘，返回 imported / skipped。
 * 元数据（ok/version/exportedAt）认识但不写盘，也不进 skipped（与原实现一致）。
 * 字段顺序按 body 的 Object.keys 顺序，imported 顺序因此与原实现一致。
 */
export function runImport(deps: ImportDeps, body: any): ImportReport {
  const imported: string[] = []
  const skipped: string[] = []
  if (!isPlainObject(body)) return { imported, skipped }

  for (const key of Object.keys(body)) {
    // 导出包自带的元数据：认识，但不落盘
    if ((BACKUP_META_FIELDS as ReadonlyArray<string>).includes(key)) continue
    // 显式白名单判断：`__proto__` / `constructor` 等键既不是数据字段，
    // 也不会因为查表命中原型链而被误当成清洗器（BACKUP_CLEANERS 另做了 null 原型防护）
    if (!isBackupDataField(key)) {
      skipped.push(key)
      continue
    }
    const clean = BACKUP_CLEANERS[key]
    let value: any
    try {
      value = clean(body[key])
    } catch {
      value = null
    }
    if (value === null) {
      skipped.push(key)
      continue
    }
    try {
      saveField(deps, key, value)
      imported.push(key)
      if (key === 'storyProgress' && deps.onStoryProgressImported) {
        try { deps.onStoryProgressImported() } catch { }
      }
    } catch (err: any) {
      console.error('[backup] IMPORT-SAVE-FAIL field=' + key + ' err=' + String((err && err.message) || err))
      skipped.push(key)
    }
  }
  return { imported, skipped }
}
