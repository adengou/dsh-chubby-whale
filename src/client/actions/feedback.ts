/**
 * client/actions/feedback.ts —— 意见反馈（客户端）
 *
 * 两条路并行，谁都不挡谁：
 *   1) **打开 Gitee 新建 issue 页**（标题/正文预填）：用户登录后点提交，作者收到通知；
 *      国内访问比 GitHub 稳，且**不暴露任何邮箱**；
 *   2) **POST /feedback 留档**：后台落盘（配了 SMTP 还能发信），内容长时完整版只留在本地。
 *
 * 隐私：收件邮箱（若配置了 SMTP）只活在 host 侧，客户端与回执里都看不到。
 */
import { postJson } from '../http.js'
import { promptText } from './prompt-modal.js'
import type { ActionHost, ActionTable } from '../actions.js'

/** Gitee 仓库地址（反馈 issue 的落点） */
const GITEE_REPO = 'https://gitee.com/adengou/dsh-chubby-whale'
/** URL 里带的正文上限：太长会被浏览器/服务端截断，完整内容走本地留档 */
const URL_BODY_MAX = 1500

/** 把反馈拼成 Gitee 新建 issue 的地址（预填标题与正文） */
function buildIssueUrl(text: string): string {
  const body = Array.from(String(text || ''))
  const clipped = body.slice(0, URL_BODY_MAX).join('')
  const tail = body.length > URL_BODY_MAX ? '\n\n（内容较长，已截断；完整内容见本地反馈文件）' : ''
  const title = '反馈：' + (Array.from(String(text || '').trim()).slice(0, 30).join('') || '使用问题')
  return (
    GITEE_REPO +
    '/issues/new?issue[title]=' + encodeURIComponent(title) +
    '&issue[description]=' + encodeURIComponent(clipped + tail)
  )
}

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

    // 1) 先本地留档（后台落盘；配了 SMTP 会发信）——失败不阻断打开 issue 页
    let sent = false
    try {
      const r = await postJson('/feedback', { text }, { timeout: 30000 })
      sent = !!(r && r.ok && r.sent === 'smtp')
    } catch (e) { }

    // 2) 打开 Gitee 新建 issue 页（预填），用户登录后点提交
    let opened = false
    try {
      window.open(buildIssueUrl(text), '_blank')
      opened = true
    } catch (e) { }

    if (opened) {
      host.bubble(
        (sent ? '反馈已发出，' : '') +
        '同时打开了 Gitee 反馈页：登录后点「创建」即可提交；本机也留了一份。',
        9000,
      )
    } else {
      host.bubble(
        sent ? '反馈已发出，谢谢！' : '反馈已记录（本机保存）。打开 Gitee → 我的仓库 → Issues 也能提。',
        8000,
      )
    }
  })
}
