/**
 * client/actions/feedback.ts —— 意见反馈（客户端）
 *
 * 流程：菜单「意见反馈…」→ 自绘多行输入框 → POST /feedback → 后台投递。
 * 隐私：收件邮箱只在 host 侧，客户端与回执里都看不到它。
 */
import { postJson } from '../http.js'
import { promptText } from './prompt-modal.js'
import type { ActionHost, ActionTable } from '../actions.js'

export function registerFeedbackActions(table: ActionTable<ActionHost>): void {
  table.define('feedback', async (host) => {
    const raw = await promptText({
      title: '意见反馈（多行，Ctrl+Enter 提交）',
      placeholder: '遇到什么问题、希望怎么改，都可以写在这里……',
      multiline: true,
      maxLength: 4000,
      okText: '提交',
    })
    // 取消 / 空内容都不打扰后台
    const text = String(raw || '').trim()
    if (!text) return
    host.bubble('本鲸把反馈送出去…', 20000)
    try {
      const r = await postJson('/feedback', { text }, { timeout: 30000 })
      if (r && r.ok && r.sent === 'smtp') host.bubble('反馈已发送，谢谢主人！', 6000)
      else if (r && r.ok) host.bubble('反馈已记录（本机保存），谢谢主人！', 6000)
      else host.bubble('反馈没送成：' + String((r && r.error) || '接口没回内容'), 6000)
    } catch (e: any) {
      host.bubble('反馈没送成：' + String((e && e.message) || e).slice(0, 80), 6000)
    }
  })
}
