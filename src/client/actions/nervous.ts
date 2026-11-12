/**
 * client/actions/nervous.ts —— 神经系统的开关动作
 *
 * 独立文件是为了让整个「神经」模块可一键撤除：删目录 + client.ts 的接入 + 本文件注册。
 */
import type { ActionHost, ActionTable } from '../actions.js'
import { getJson } from '../http.js'
import { nervousEnabled, setNervousEnabled, nervousEnergy, nervousSnapshot } from '../nervous/index.js'

export function registerNervousActions(table: ActionTable<ActionHost>): void {
  table.define('nervous', (host) => {
    const on = !nervousEnabled()
    setNervousEnabled(on)
    if (!on) { host.bubble('神经感知：关（人家安静待着）', 3000); return }
    const e = nervousEnergy()
    host.bubble('神经感知：开（本鲸能感觉到你在忙' + (e == null ? '' : '，精神 ' + Math.round(e) + '%') + '）', 4000)
  })

  // 看一眼状态：二维情绪 + 宿主事件订阅数，调参与排障用
  table.define('nervous-status', async (host) => {
    const snap = nervousSnapshot()
    if (!snap) { host.bubble('神经感知还没挂上（刷新页面试试）', 4000); return }
    let hostLine = '宿主事件：没连上'
    try {
      const r = await getJson('/nervous?limit=1')
      if (r && r.ok) {
        const sub = Array.isArray(r.subscribed) ? r.subscribed.length : 0
        hostLine = '宿主事件：订阅 ' + sub + ' 类' + (sub > 0 ? '' : '（可能还没重启）')
      }
    } catch (e) { }
    host.bubble('精神 ' + Math.round(snap.arousal) + ' / 心情 ' + Math.round(snap.valence) + '；' + hostLine, 8000)
  })
}
