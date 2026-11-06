/**
 * client/actions/data.ts —— 数据备份的导出/导入 + 统计卡文案（纯流程，可离线单测）
 *
 * 隐私约定（主人 2026-11-05 定）：备份可能含聊天记录、人格与提醒，
 *   · 导出只在本地生成 Blob 触发浏览器下载，不经过任何第三方；
 *   · 导入只 POST 回本机 /api/chubby-whale/data/import；
 *   · 本模块不打印、不上报、不缓存备份内容。
 *
 * 失败一律静默降级成一句轻提示（「导出没成功」「备份文件读不了」），不弹错误框。
 */

import { str } from '../util.js'
import { getJson, postJson, delJson } from '../http.js'

/** 备份体积上限，与 host/backup/fields.ts 的 BACKUP_MAX_BYTES 同口径（2MB） */
const MAX_BACKUP_BYTES = 2 * 1024 * 1024

/** 数据类动作的宿主能力（client.ts / system.ts 注入） */
export type DataHost = {
  bubble: (text: string, ms?: number) => void
  getJson?: (path: string, init?: any) => Promise<any>
  postJson?: (path: string, body?: any, init?: any) => Promise<any>
  /** 清宿主的聊天缓存（导入后调用；失败静默） */
  delJson?: (path: string, init?: any) => Promise<any>
  /** 测试注入：文件选择器（默认用 <input type="file" accept=".json">） */
  pickFile?: (cb: (file: any) => void) => void
  /** 二次确认（默认用浏览器的 window.confirm；拿不到确认框的环境不拦，见 askImportConfirm） */
  confirm?: (msg: string) => boolean
  /** 测试注入：下载依赖（默认取全局 document / URL / Blob） */
  env?: { document?: any; url?: any; BlobCtor?: any }
  /** 测试注入时钟（默认当前时间） */
  now?: () => Date
}

/** 备份文件名：chubby-whale-backup-YYYY-MM-DD.json（本地日期） */
export function backupFileName(now: Date = new Date()): string {
  const d = now instanceof Date && !isNaN(now.getTime()) ? now : new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return 'chubby-whale-backup-' + y + '-' + m + '-' + day + '.json'
}

/**
 * 把接口返回的 imported / skipped 折算成条数：
 * 数字直接用；数组取长度；对象（分类计数）逐项求和；字符串能转数字就转。
 */
export function countOf(v: any): number {
  if (v == null) return 0
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (typeof v === 'boolean') return 0
  if (Array.isArray(v)) return v.length
  if (typeof v === 'object') {
    let n = 0
    for (const k of Object.keys(v)) n += countOf(v[k])
    return n
  }
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 导入结果气泡：报告 imported / skipped 的字段数（host 返回的是字段名数组） */
export function formatImportResult(d: any): string {
  const src = (d && typeof d === 'object') ? d : {}
  const imported = countOf(src.imported != null ? src.imported : (src.importedCount != null ? src.importedCount : src.added))
  const skipped = countOf(src.skipped != null ? src.skipped : (src.skippedCount != null ? src.skippedCount : src.ignored))
  return '导入了 ' + imported + ' 个字段，跳过 ' + skipped + ' 个字段'
}

/** 取第一个能转成有限数字的值 */
function numOf(...vals: any[]): number {
  for (const v of vals) {
    if (v == null || v === '') continue
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return 0
}

/** 摘要文本：压空白、截断；空值返回空串 */
function shortText(v: any, max = 16): string {
  const t = str(v).replace(/\s+/g, ' ').trim()
  if (!t) return ''
  return t.length > max ? t.slice(0, max) + '…' : t
}

/**
 * 鱼账本分桶的展示顺序与中文名（host /fishfood、/stats 的 byKind）。
 *
 * 为什么写死顺序：JSON 对象键序不保证，按 Object.keys 遍历可能把「人格」排到「聊天」
 * 前面，同一份数据两次刷新顺序还不一样。宿主侧也按 chat→story→summary→personality
 * 的顺序输出，两边一致。
 */
const KIND_BUCKETS: Array<{ key: string; label: string }> = [
  { key: 'chat', label: '聊天' },
  { key: 'story', label: '说书' },
  { key: 'summary', label: '摘要' },
  { key: 'personality', label: '人格' },
]

/**
 * 分桶概况（纯文本，一行）：`聊天 120（￥0.0001） · 说书 30；￥0.0001`
 *
 * 口径（2026-11-07 B98）：
 *   · 只显示**有数据**的桶——0 桶不显示（没花过和不知道都不该占位，更不该显示「聊天 0」）；
 *   · 单个桶只有金额才标 ￥，末尾合计也只在真有金额时出现；
 *   · byKind 缺失/形状不对（老账本、老备份、旧宿主）→ 返回空串，调用方连「分桶：」都不显示。
 *
 * 只在本模块内部给 formatStats 用，**刻意不 export**：本批不允许新增模块导出
 * （docs/模块接口清单.md 会对不上）。system.ts 的鱼粮指令里有一份同口径的本地实现，
 * 改口径时两处一起改。
 */
function formatKindBuckets(byKind: any): string {
  const src = (byKind && typeof byKind === 'object' && !Array.isArray(byKind)) ? byKind : null
  if (!src) return ''
  const parts: string[] = []
  let costSum = 0
  for (const { key, label } of KIND_BUCKETS) {
    const b = (src[key] && typeof src[key] === 'object' && !Array.isArray(src[key])) ? src[key] : null
    const tokens = numOf(b && b.tokens)
    const cost = numOf(b && b.costCny)
    if (tokens <= 0 && cost <= 0) continue
    parts.push(label + ' ' + tokens + (cost > 0 ? '（￥' + cost.toFixed(4) + '）' : ''))
    if (cost > 0) costSum += cost
  }
  if (parts.length === 0) return ''
  return parts.join(' · ') + (costSum > 0 ? '；￥' + costSum.toFixed(4) : '')
}

/** 数组、普通对象、单值都收成数组（人格字段可能是其中任一种） */
function asList(v: any): any[] {
  if (v == null) return []
  if (Array.isArray(v)) return v
  if (typeof v === 'object') {
    try { return Object.keys(v).map((k) => v[k]) } catch (e) { return [] }
  }
  return [v]
}

/**
 * 统计卡文案（气泡用，纯文本多行）：
 * 缓存 tts/chat/asr 条数、鱼粮总 token、成长阶段、亲密度、人格要点。
 * 对响应字段做宽容解析：顶层平铺 / 嵌在 stats / cache / fishfood / growth 里都认。
 */
export function formatStats(payload: any): string {
  const d = (payload && typeof payload === 'object') ? payload : {}
  const s = (d.stats && typeof d.stats === 'object') ? d.stats : d

  // —— 缓存：优先 byType / cache 对象，其次顶层 tts/chat/asr ——
  const cacheObj = (s.cache && typeof s.cache === 'object') ? s.cache : ((s.byType && typeof s.byType === 'object') ? s.byType : {})
  const tts = numOf(cacheObj.tts, s.tts, s.cacheTts)
  const chat = numOf(cacheObj.chat, s.chat, s.cacheChat)
  const asr = numOf(cacheObj.asr, s.asr, s.cacheAsr)

  // —— 鱼粮总 token ——
  const ff = (s.fishfood && typeof s.fishfood === 'object') ? s.fishfood : ((s.fishFood && typeof s.fishFood === 'object') ? s.fishFood : {})
  const tokens = numOf(ff.total, ff.totalTokens, s.totalTokens, (s.tokens && typeof s.tokens === 'object') ? s.tokens.total : s.tokens, s.fishfoodTotal)
    // 鱼账本（2026-11-07）：金额与 token 同源，没有就是 0（不显示，不冒充「花了 0 元」）
    const costCny = Number(ff.costCny) || 0
    // 分桶（B98）：聊天 / 说书 / 摘要 / 人格；老账本（无 byKind）返回空串，连标题都不显示
    const bucketLine = formatKindBuckets(ff.byKind)

  // —— 成长 / 亲密度 ——
  const g = (s.growth && typeof s.growth === 'object') ? s.growth : {}
  const stage = shortText(g.stage || s.stage || '--', 12) || '--'
  const intimacy = numOf(s.intimacy, s.state && s.state.intimacy)

  // —— 人格要点：取前 3 条短句（口头禅 / 偏好 / 备注 / 自述） ——
  const p = (s.personality && typeof s.personality === 'object') ? s.personality : {}
  const pts: string[] = []
  const addPoint = (v: any): void => {
    const t = shortText(v, 16)
    if (t && pts.indexOf(t) < 0 && pts.length < 3) pts.push(t)
  }
  for (const v of asList(p.points)) addPoint(v)
  for (const v of asList(p.catchphrases)) addPoint(v)
  for (const v of asList(p.preferences)) addPoint(v)
  for (const v of asList(p.notes)) addPoint(v)
  addPoint(p.selfNarrative)
  addPoint(s.selfNarrative)
  const points = pts.length ? pts.join('；') : '暂无'

  return '统计卡\n缓存：tts ' + tts + ' 条｜chat ' + chat + ' 条｜asr ' + asr + ' 条'
    + '\n鱼粮：' + tokens + ' tokens' + (costCny > 0 ? ' · ≈ ¥' + costCny.toFixed(4) : '')
    + (bucketLine ? '\n分桶：' + bucketLine : '')
    + '\n成长：' + stage + '｜亲密度 ' + intimacy + '/100'
    + '\n人格要点：' + points
}

/**
 * 用 Blob 触发本地下载（不发起任何网络请求）。
 * 返回 false 表示这次没有把下载真正交出去（环境不具备 / createObjectURL 或 click 抛错），
 * 由调用方降级成轻提示——不能返回 true，否则界面会谎报「已下载」。
 */
export function downloadJson(data: any, filename: string, env?: any): boolean {
  try {
    const e = env || {}
    const doc = e.document || (typeof document !== 'undefined' ? document : null)
    const URLX = e.url || (typeof URL !== 'undefined' ? URL : null)
    const B = e.BlobCtor || (typeof Blob !== 'undefined' ? Blob : null)
    if (!doc || !URLX || typeof URLX.createObjectURL !== 'function' || !B) return false

    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
    const blob = new B([text], { type: 'application/json;charset=utf-8' })
    const url = URLX.createObjectURL(blob)
    const a = doc.createElement('a')
    a.href = url
    a.download = filename
    try { a.style.display = 'none' } catch (err) { }
    try { a.setAttribute('data-chubby-download', '1') } catch (err) { }
    const parent = doc.body || doc.documentElement
    if (parent && typeof parent.appendChild === 'function') parent.appendChild(a)
    try {
      a.click()
    } catch (err) {
      // 点击被浏览器拦截/抛错：这次没有真的触发下载，不能返回 true（否则界面会谎报「已下载」）
      try { URLX.revokeObjectURL(url) } catch (e2) { }
      try {
        if (parent && typeof parent.removeChild === 'function') parent.removeChild(a)
        else if (typeof a.remove === 'function') a.remove()
      } catch (e2) { }
      return false
    }
    // 下载已触发：稍后清理临时节点与 objectURL（清理失败不影响下载）
    try {
      setTimeout(() => {
        try {
          if (parent && typeof parent.removeChild === 'function') parent.removeChild(a)
          else if (typeof a.remove === 'function') a.remove()
        } catch (err) { }
        try { URLX.revokeObjectURL(url) } catch (err) { }
      }, 0)
    } catch (err) { }
    return true
  } catch (e) {
    return false
  }
}

/**
 * 体积超限错误码要认两种写法：
 *   · 导出路由自己回 `TOO_LARGE`（src/host/routes/backup.ts 的 handleExport）；
 *   · 请求体超限走公共通道 src/host/http.ts 的 sendTooLarge → `'too large'`（导入就是这条）。
 * 旧实现只比 `err === 'TOO_LARGE'`，导入撞体积上限时会落到「备份文件读不了」——
 * 主人以为文件坏了，其实是太大，该换个小点的包。
 */
function isTooLargeError(err: any): boolean {
  return str(err).replace(/[^A-Za-z]/g, '').toUpperCase() === 'TOOLARGE'
}

/** 导出接口失败文案：413 是体积超限，和网络失败分开说（否则主人不知道换个小点的包） */
function exportFailText(d: any): string {
  const err = d && typeof d === 'object' ? (d as any).error : ''
  return isTooLargeError(err) ? '备份太大（超过 2MB），导出没成功' : '导出没成功'
}

/** 导出：GET /data/export → 本地下载 JSON；失败只轻提示 */
export function exportBackup(host: DataHost): void {
  const fetchJson = host.getJson || getJson
  let p: Promise<any>
  // 绕开浏览器缓存：否则可能拿到上一次（旧数据）的备份
  try { p = Promise.resolve(fetchJson('/data/export', { cache: 'no-store' })) } catch (e) {
    host.bubble('导出没成功', 5000)
    return
  }
  p.then((d: any) => {
    // 非对象说明拿到的不是备份包（错误页 HTML 等），不能当数据下载
    if (!d || typeof d !== 'object' || d.ok === false) {
      host.bubble(exportFailText(d), 6000)
      return
    }
    const name = backupFileName(host.now ? host.now() : new Date())
    const ok = downloadJson(d, name, host.env)
    host.bubble(ok ? ('备份已下载：' + name) : '浏览器没让下载，导出没成功', 6000)
  }).catch(() => host.bubble('导出没成功', 5000))
}

/** 读文件文本：优先 File.text()，老浏览器回退 FileReader */
export function readFileText(file: any): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      if (!file) { reject(new Error('no file')); return }
      if (typeof file.text === 'function') {
        file.text().then((t: any) => resolve(str(t)), reject)
        return
      }
      const FR = (typeof FileReader !== 'undefined') ? FileReader : null
      if (!FR) { reject(new Error('FileReader missing')); return }
      const fr = new FR()
      fr.onload = () => resolve(str(fr.result))
      fr.onerror = () => reject(new Error('read failed'))
      fr.readAsText(file)
    } catch (e) {
      reject(e)
    }
  })
}

/** 解析备份文本：必须是 JSON 对象/数组，否则返回 null（由调用方提示「备份文件读不了」） */
export function parseImportText(text: any): any {
  const raw = str(text).trim()
  if (!raw) return null
  let v: any = null
  try { v = JSON.parse(raw) } catch (e) { return null }
  if (!v || typeof v !== 'object') return null
  return v
}

/** 默认文件选择器：临时 <input type=file accept=".json">，选完即清理 */
export function pickJsonFile(cb: (file: any) => void): void {
  try {
    const doc = (typeof document !== 'undefined') ? document : null
    if (!doc || typeof doc.createElement !== 'function') { cb(null); return }
    const input = doc.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    try { input.style.display = 'none' } catch (e) { }
    const cleanup = (): void => {
      try {
        if (typeof input.remove === 'function') input.remove()
        else if (input.parentNode && typeof input.parentNode.removeChild === 'function') input.parentNode.removeChild(input)
      } catch (e) { }
    }
    input.onchange = () => {
      try {
        const f = input.files && input.files[0]
        if (f) cb(f)
        else cb(null)
      } catch (e) {
        cb(null)
      } finally {
        cleanup()
      }
    }
    // 取消选择（现代浏览器会发 cancel）：不清理的话 input 会一直留在 body 里
    try {
      if (typeof input.addEventListener === 'function') {
        input.addEventListener('cancel', () => { try { cb(null) } finally { cleanup() } })
      }
    } catch (e) { }
    const parent = doc.body || doc.documentElement
    if (parent && typeof parent.appendChild === 'function') parent.appendChild(input)
    try { input.click() } catch (e) { cb(null); cleanup() }
  } catch (e) {
    cb(null)
  }
}

/**
 * 导入接口失败文案：413 超限 / 400 坏请求 / 网络失败分开说，
 * 否则「备份太大」和「文件坏了」都显示同一句，主人不知道该怎么处理。
 */
function importFailText(d: any): string {
  const err = (d && typeof d === 'object') ? str((d as any).error).trim() : ''
  if (isTooLargeError(err)) return '备份太大（超过 2MB），没导入'
  if (err.toUpperCase() === 'BAD_BODY') return '备份文件格式不对，没导入'
  return '备份文件读不了'
}

/**
 * 导入前的二次确认。导入是**整字段覆盖**（src/host/backup/import.ts：同名字段后到者整字段替换，
 * 覆盖的是记忆/人格/状态/成长/鱼粮/宠物/提醒/说书进度），选错文件的代价不可撤销，
 * 所以落盘前必须先问一句（与 system.ts「清除记忆」同一约定）。
 *
 * 宿主可注入 confirm（测试用）；不注入就用浏览器 window.confirm。
 * 拿不到确认框的环境（Node 单测 / 无 UI 宿主）**不拦**：那种环境没有可问的人，
 * 拦下来只会让调用方在无 UI 环境里永远导不进去。
 * 确认框本身抛错（被浏览器禁用）按「没确认」处理，绝不静默执行。
 */
const IMPORT_CONFIRM_TEXT = '导入会按备份整字段覆盖本机的记忆/人格/成长/鱼粮/提醒，确定吗？'

function askImportConfirm(host: DataHost): boolean {
  const injected = host && typeof host.confirm === 'function' ? host.confirm : null
  if (injected) {
    try { return !!injected(IMPORT_CONFIRM_TEXT) } catch (e) { return false }
  }
  try {
    const w: any = (typeof window !== 'undefined') ? window : null
    if (w && typeof w.confirm === 'function') return !!w.confirm(IMPORT_CONFIRM_TEXT)
  } catch (e) { return false }
  return true
}

/** 导入后清宿主聊天缓存：旧回复不能继续套在新数据上（失败静默） */
function clearChatCache(host: DataHost): void {
  try {
    const del = typeof host.delJson === 'function' ? host.delJson : delJson
    try { Promise.resolve(del('/cache')).catch(() => { }) } catch (e) { }
  } catch (e) { }
}

/** 导入：选 .json → 读文本 → POST /data/import → 报告 imported / skipped */
export function importBackup(host: DataHost): void {
  const pick = typeof host.pickFile === 'function' ? host.pickFile : pickJsonFile
  const sendJson = host.postJson || postJson
  try {
    pick((file: any) => {
      if (!file) {
        // 取消选择不算错误，给一句轻提示即可
        host.bubble('没选备份文件', 3000)
        return
      }
      // 先看体积：超过 2MB 宿主会 413，提前说清，别把整个文件读进内存再失败
      const size = Number(file.size)
      if (Number.isFinite(size) && size > MAX_BACKUP_BYTES) {
        host.bubble('备份太大（超过 2MB），没导入', 6000)
        return
      }
      readFileText(file).then((text: string) => {
        const body = parseImportText(text)
        if (!body) {
          host.bubble('备份文件读不了', 6000)
          return
        }
        // 二次确认（只对已解析成对象的备份问；取消选择/读不了/太大这些早退路径不问）
        if (!askImportConfirm(host)) {
          host.bubble('没确认，导入取消', 4000)
          return
        }
        let p: Promise<any>
        try { p = Promise.resolve(sendJson('/data/import', body)) } catch (e) {
          host.bubble('备份文件读不了', 6000)
          return
        }
        p.then((d: any) => {
          // 非对象说明拿到的不是接口回执（错误页 HTML 等），不能当「导入成功」
          if (!d || typeof d !== 'object' || d.ok === false) {
            host.bubble(importFailText(d), 6000)
            return
          }
          const resultText = formatImportResult(d)
          host.bubble(resultText, 7000)
          // 导入写的是宿主侧数据，前端已展开的聊天/人格仍是旧的：清掉聊天缓存并提示刷新，
          // 否则旧回复继续命中，看着像「导入没生效」
          clearChatCache(host)
          try {
            setTimeout(() => {
              try { host.bubble(resultText + '；刷新页面后新数据才全部生效', 8000) } catch (e) { }
            }, 1200)
          } catch (e) { }
        }).catch(() => host.bubble('备份文件读不了', 6000))
      }).catch(() => host.bubble('备份文件读不了', 6000))
    })
  } catch (e) {
    host.bubble('备份文件读不了', 6000)
  }
}
