/**
 * client/actions/proofread.ts —— 公文校对（菜单动作）
 *
 * 贴一段稿子 → 宿主 /proofread 外呼一次 → 气泡先报前几百字，完整清单下载成 txt。
 * 与聊天分开：不写记忆、不计亲密度，校对完不会影响它平时聊天。
 */
import { postJson } from '../http.js'
import { str } from '../util.js'
import { isSupportedDocName, pickDocument, readDocumentText } from '../doc-text.js'
import type { ActionHost, ActionTable } from '../actions.js'

export function registerProofreadActions(table: ActionTable<ActionHost>): void {
  table.define('proofread', async (host) => {
    // 文件框按 accept 自己过滤（txt/md/json/log/csv/docx），不另写说明
    const file = await pickDocument()
    // 「所有文件」绕过 accept 时先验扩展名：不认识就不读，连内容都不碰
    if (file && !isSupportedDocName(file.name)) {
      host.bubble('这个格式读不了：只认 txt/md/json/log/csv/docx', 7000)
      return
    }
    let text = ''
    if (file) {
      host.bubble('本鲸先读一遍文档…', 30000)
      const r: any = await readDocumentText(file)
      if (!r.ok) { host.bubble('读不了这个文档：' + String(r.error || '读取失败'), 8000); return }
      text = String(r.text || '').trim()
    } else {
      let raw: any = null
      try {
        raw = typeof window !== 'undefined' && typeof (window as any).prompt === 'function'
          ? (window as any).prompt('也可以直接把稿子贴进来（8000 字以内）：', '')
          : null
      } catch (e) { }
      text = str(raw).trim()
    }
    if (!text) return
    if (text.length > 8000) {
      host.bubble('太长了（' + text.length + ' 字），一次只能校对 8000 字以内', 6000)
      return
    }
    host.bubble('本鲸帮你看一遍，稍等…', 60000)
    try {
      const r = await postJson('/proofread', { text }, { timeout: 120000 })
      const result = str(r?.result).trim()
      if (!r || !r.ok || !result) {
        host.bubble('没校对成：' + str(r?.error || '接口没回内容'), 6000)
        return
      }
      const shown = result.length > 400 ? result.slice(0, 400) + '\n（完整清单已下载）' : result
      host.bubble(shown, 20000)
      const blob = new Blob([result], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const d = new Date()
      const pad = (n: number): string => String(n).padStart(2, '0')
      const a = document.createElement('a')
      a.href = url
      a.download = '肥鲸校对-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.txt'
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => { try { URL.revokeObjectURL(url) } catch (e) { } }, 15000)
    } catch (e: any) {
      host.bubble('没校对成：' + String((e && e.message) || e).slice(0, 80), 6000)
    }
  })
}
