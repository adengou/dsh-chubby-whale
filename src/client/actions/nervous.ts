/**
 * client/actions/nervous.ts —— 神经系统的开关动作
 *
 * 独立文件是为了让整个「神经」模块可一键撤除：删目录 + client.ts 的接入 + 本文件注册。
 */
import type { ActionHost, ActionTable } from '../actions.js'
import { nervousEnabled, setNervousEnabled, nervousEnergy } from '../nervous/index.js'

export function registerNervousActions(table: ActionTable<ActionHost>): void {
  table.define('nervous', (host) => {
    const on = !nervousEnabled()
    setNervousEnabled(on)
    if (!on) { host.bubble('神经感知：关（人家安静待着）', 3000); return }
    const e = nervousEnergy()
    host.bubble('神经感知：开（本鲸能感觉到你在忙' + (e == null ? '' : '，精神 ' + Math.round(e) + '%') + '）', 4000)
  })
}
