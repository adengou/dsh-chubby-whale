/**
 * client/actions/capsule.ts —— 鲸落 / 接住漂来的鲸（记忆胶囊的导出与导入）
 *
 * 隐私红线（本文件实现约束）：
 *   · 胶囊里只有「抽象主题词 + 一句梦话」，数据来自 /memory 的摘要视图，
 *     **不打包、不导出任何聊天原文**；
 *   · 导入只让肥鲸“梦见”一句，不写入记忆、不覆盖现有记忆；
 *   · 两端都是用户显式点菜单触发，没有自动同步、没有后台网络。
 *
 * 动作：
 *   capsule-export  导出 .json 胶囊文件
 *   capsule-import  选一个胶囊文件 → 校验 → 只冒一句梦话
 */
import { getJson } from '../http.js'
import { packCapsule, readCapsule, capsuleDream } from '../memory-capsule.js'
import type { ActionHost, ActionTable } from '../actions.js'

/** 下载一个 JSON 文件（与 proofread 下载 txt 同一套做法） */
function saveJson(name: string, obj: any): void {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => { try { URL.revokeObjectURL(url) } catch (e) { } }, 15000)
}

export function registerCapsuleActions(table: ActionTable<ActionHost>): void {
  // —— 鲸落：把摘要里的抽象主题打包成胶囊 ——
  table.define('capsule-export', (host) => {
    getJson('/memory', { cache: 'no-store' })
      .then((d: any) => {
        if (!d || !d.ok) { host.bubble('记忆摘要取不到，胶囊没做成'); return }
        const topics = Array.isArray(d.topics) ? d.topics : []
        const cap = packCapsule({ madeAt: Date.now(), intimacy: 0, topics })
        const d2 = new Date()
        const pad = (n: number): string => String(n).padStart(2, '0')
        const stem = '肥鲸记忆胶囊-' + d2.getFullYear() + pad(d2.getMonth() + 1) + pad(d2.getDate())
        try {
          saveJson(stem + '.json', cap)
        } catch (e: any) {
          host.bubble('胶囊文件没存下来：' + String((e && e.message) || e))
          return
        }
        host.bubble('鲸落好啦：' + stem + '.json（' + cap.topics.length + ' 个主题，不含原文）', 9000)
      })
      .catch(() => host.bubble('记忆摘要取不到，胶囊没做成'))
  })

  // —— 接住漂来的鲸：导入胶囊，只梦见一句，不写记忆 ——
  table.define('capsule-import', (host) => {
    try {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.json,application/json'
      input.onchange = () => {
        const f = input.files && input.files[0]
        if (!f) return
        const reader = new FileReader()
        reader.onload = () => {
          let cap: any = null
          try { cap = readCapsule(JSON.parse(String(reader.result || 'null'))) } catch (e) { cap = null }
          if (!cap) { host.bubble('这个胶囊读不出来（格式不对或版本不认）'); return }
          const dream = capsuleDream(cap)
          if (dream) host.bubble(dream, 11000)
          // 只存一句梦话，下次打开还能再梦一次；不碰 memory.json
          try { localStorage.setItem('chubby-capsule-dream', JSON.stringify({ at: Date.now(), dream })) } catch (e) { }
        }
        reader.readAsText(f, 'utf-8')
      }
      input.click()
    } catch (e) {
      host.bubble('打不开文件选择')
    }
  })
}
