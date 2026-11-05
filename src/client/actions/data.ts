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

import { getJson, postJson } from '../http.js'

/** 数据类动作的宿主能力（client.ts / system.ts 注入） */
export type DataHost = {
  bubble: (text: string, ms?: number) => void
  getJson?: (path: string, init?: any) => Promise<any>
  postJson?: (path: string, body?: any, init?: any) => Promise<any>
  /** 测试注入：文件选择器（默认用 <input type="file" accept=".json">） */
  pickFile?: (cb: (file: any) => void) => void
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
  const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim()
  if (!t) return ''
  return t.length > max ? t.slice(0, max) + '…' : t
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
    + '\n鱼粮：' + tokens + ' tokens'
    + '\n成长：' + stage + '｜亲密度 ' + intimacy + '/100'
    + '\n人格要点：' + points
}

/**
 * 用 Blob 触发本地下载（不发起任何网络请求）。
 * 返回 false 表示当前环境不具备下载条件（由调用方降级成轻提示）。
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
    try { a.click() } catch (err) { }
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

/** 导出：GET /data/export → 本地下载 JSON；失败只轻提示 */
export function exportBackup(host: DataHost): void {
  const fetchJson = host.getJson || getJson
  let p: Promise<any>
  try { p = Promise.resolve(fetchJson('/data/export')) } catch (e) {
    host.bubble('导出没成功', 5000)
    return
  }
  p.then((d: any) => {
    if (d == null || d.ok === false) {
      host.bubble('导出没成功', 5000)
      return
    }
    const name = backupFileName(host.now ? host.now() : new Date())
    const ok = downloadJson(d, name, host.env)
    host.bubble(ok ? ('备份已下载：' + name) : '这个浏览器不让下载备份', 6000)
  }).catch(() => host.bubble('导出没成功', 5000))
}

/** 读文件文本：优先 File.text()，老浏览器回退 FileReader */
export function readFileText(file: any): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      if (!file) { reject(new Error('no file')); return }
      if (typeof file.text === 'function') {
        file.text().then((t: any) => resolve(String(t == null ? '' : t)), reject)
        return
      }
      const FR = (typeof FileReader !== 'undefined') ? FileReader : null
      if (!FR) { reject(new Error('FileReader missing')); return }
      const fr = new FR()
      fr.onload = () => resolve(String(fr.result == null ? '' : fr.result))
      fr.onerror = () => reject(new Error('read failed'))
      fr.readAsText(file)
    } catch (e) {
      reject(e)
    }
  })
}

/** 解析备份文本：必须是 JSON 对象/数组，否则返回 null（由调用方提示「备份文件读不了」） */
export function parseImportText(text: any): any {
  const raw = String(text == null ? '' : text).trim()
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
    const parent = doc.body || doc.documentElement
    if (parent && typeof parent.appendChild === 'function') parent.appendChild(input)
    try { input.click() } catch (e) { cb(null); cleanup() }
  } catch (e) {
    cb(null)
  }
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
      readFileText(file).then((text: string) => {
        const body = parseImportText(text)
        if (!body) {
          host.bubble('备份文件读不了', 6000)
          return
        }
        let p: Promise<any>
        try { p = Promise.resolve(sendJson('/data/import', body)) } catch (e) {
          host.bubble('备份文件读不了', 6000)
          return
        }
        p.then((d: any) => {
          if (d && d.ok === false) {
            host.bubble('备份文件读不了', 6000)
            return
          }
          host.bubble(formatImportResult(d || {}), 7000)
        }).catch(() => host.bubble('备份文件读不了', 6000))
      }).catch(() => host.bubble('备份文件读不了', 6000))
    })
  } catch (e) {
    host.bubble('备份文件读不了', 6000)
  }
}
