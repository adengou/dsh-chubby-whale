/**
 * client/actions/system.ts —— 系统类菜单动作的处理器（喂食 / 位置 / 余额 / 缓存 / 看图 / 提醒 …）
 *
 * 这里只做「动作 → 流程」，所有展示、朗读、状态归 host 管。
 * 新增一个系统动作 = 这里加一行 table.define(...)。
 */

import type { ActionHost, ActionTable } from '../actions.js'
import { getJson, postJson, delJson } from '../http.js'
import { VISION_PROMPT } from '../dropzone.js'
import { imageToB64 } from '../image.js'
import { parseDue, cleanReminderText } from '../../shared/time.js'
import { exportBackup, importBackup, formatStats } from './data.js'

export function registerSystemActions(table: ActionTable<ActionHost>): void {
  // —— 投喂 ——
  table.define('feed', (host) => {
    const r = host.persona.feed()
    // 每 8 碗说一次「饭碗账本」；平时说投喂台词
    if (r.bowls % 8 === 0) {
      host.say(host.persona.line('riceAccount'), 5000)
      try { getJson('/pet?action=feed').then(() => { try { host.syncGrowth() } catch (e) { } }).catch(() => { }) } catch (e) { }
      return
    }
    host.say(r.text + (r.stageUp ? '（' + r.stage + '）' : ''), r.stageUp ? 6000 : 3500)
    host.heart()
    try { getJson('/pet?action=feed').then(() => { try { host.syncGrowth() } catch (e) { } }).catch(() => { }) } catch (e) { }
  })

  // —— 位置与大小 ——
  table.define('home', (host) => { host.homePos(); host.bubble('回到角落啦') })
// 流式回复开关：chubby-stream 以前只有人读、没人写（死键）
table.define('stream-toggle', (host) => {
  try {
    const off = localStorage.getItem('chubby-stream') === 'off'
    localStorage.setItem('chubby-stream', off ? 'on' : 'off')
    host.bubble(off ? '流式回复：开（边生成边说）' : '流式回复：关（等整段再开口）', 4000)
  } catch (e) { host.bubble('改不了（浏览器禁止存储）', 3000) }
})
  table.define('bigger', (host) => { host.nudgeScale(0.1) })
  table.define('smaller', (host) => { host.nudgeScale(-0.1) })
  // —— 让它游走：隐藏后仍可恢复（恢复点 / Ctrl+Shift+W / 菜单项都走 host.recover）——
  table.define('hide', (host) => {
    host.hide()
    host.bubble('本鲸先游走了，右下角的「○」或 Ctrl+Shift+W 能叫回来', 6000)
  })
  table.define('wake-recover', (host) => {
    let wasHidden = false
    try { wasHidden = !!host.isHidden() } catch (e) { }
    try { host.recover() } catch (e) { }
    host.bubble(wasHidden ? '本鲸回来啦' : '本鲸一直在呀', 3000)
  })
  table.define('version', (host) => { host.bubble('肥鲸 v' + host.version) })

  // —— 聊天面板 ——
  table.define('type', (host) => { host.setVoiceMode(false); host.setChatOpen(true) })

  // —— 停嘴 / 停琴 ——
  table.define('pause', (host) => {
    host.stopSpeak()
    host.stopMelody()
    host.storyState.busy.current = false
    host.bubble('歇会儿…')
  })
  table.define('music-stop', (host) => { host.stopMelody(); host.bubble('停下啦') })
  table.define('tts-stop', (host) => {
    host.stopSpeak()
    host.storyState.busy.current = false
    host.bubble('好，不说了')
  })

  // —— 账本 / 成长 / 亲密度 / 余额 ——
  table.define('fishfood', (host) => {
    getJson('/fishfood').then((d: any) => {
      if (d && d.ok) {
        host.bubble('鱼粮账本：聊天 ' + d.chatTokens + ' tokens，说书 ' + d.storyTokens + ' tokens，共 ' + d.total, 5000)
      } else host.bubble('鱼粮查不到')
    }).catch(() => host.bubble('鱼粮查不到'))
  })
  table.define('growth', (host) => {
    Promise.all([getJson('/growth'), getJson('/state')]).then(([g, s]: any[]) => {
      if (g && g.ok) {
        const nx = g.nextExp > 0 ? ('（经验 ' + g.exp + '/' + g.nextExp + '）') : '（满级）'
        const it = (s && s.intimacy) || 0
        // 菜单里刚拉到的数据同时用于外观刷新（体型/光点/光晕实时变，不用刷新页面）
        try { host.applyGrowth(g) } catch (e) { }
        host.bubble('成长：' + g.stage + nx + ' · 亲密度 ' + it + '/100', 5000)
      } else host.bubble('成长查不到')
    }).catch(() => host.bubble('成长查不到'))
  })
  table.define('intimacy', (host) => {
    getJson('/state').then((d: any) => { host.bubble('亲密度：' + ((d && d.intimacy) || 0) + ' / 100') }).catch(() => host.bubble('亲密度查不到'))
  })
  table.define('balance', (host) => {
    getJson('/balance').then((d: any) => {
      if (d && d.ok && d.balance != null) {
        host.setBalance('余额 ¥' + d.balance, '¥' + d.balance)
        host.bubble('余额还有 ' + d.balance + ' 元', 5000)
      } else host.bubble('余额查不到')
    }).catch(() => host.bubble('余额查不到'))
  })

  // —— 聊天语言 / 界面语言 ——
  table.definePrefix('chat-lang:', (host, v) => {
    const cl = v === 'en' ? 'en' : (v === 'zh' ? 'zh' : 'auto')
    try { localStorage.setItem('chubby-chatlang', cl) } catch (e) { }
    host.bubble(cl === 'en' ? '聊天语言：English' : '聊天语言：中文')
  })
  table.definePrefix('lang:', (host, v) => {
    const l = v === 'en' ? 'en' : 'zh'
    try { localStorage.setItem('chubby-lang', l) } catch (e) { }
    host.setLang(l)
    host.bubble(l === 'en' ? 'Language: English' : '界面语言：中文')
  })

  // —— 缓存 / 记忆 ——
  table.define('cache-clear', (host) => {
    delJson('/cache')
      .then((d: any) => host.bubble(d && d.ok ? ('聊天缓存清空啦（' + (d.cleared || 0) + ' 条）') : '缓存清空失败', 5000))
      .catch(() => host.bubble('缓存清空失败', 4000))
  })
  table.define('cache-toggle', (host) => {
    const nowOn = !host.chatCacheOn()
    host.setChatCacheOn(nowOn)
    postJson('/cache-toggle', { enabled: nowOn }).then((d: any) => {
      host.bubble(d && d.ok ? ('聊天缓存：' + (d.enabled ? '开（省 token）' : '关（每次重新回答）')) : '切换失败', 5000)
    }).catch(() => host.bubble('切换失败', 4000))
  })
  table.define('clear-memory', (host) => {
    try {
      if (!(window as any).confirm('清除肥鲸对主人的聊天记忆？（成长/鱼粮/说书记录不受影响）')) return
      postJson('/clear-memory').then((d: any) => {
        if (d && d.ok) { host.setMessages([]); host.bubble('记忆清空啦，我们重新认识吧～', 4000) }
        else host.bubble('清除失败')
      }).catch(() => host.bubble('清除失败'))
    } catch (e) { }
  })

  // —— 看张图：选文件 → 压缩 → 视觉对话 → 朗读 ——
  table.define('vision', (host) => {
    try {
      const input = (document as any).createElement('input')
      input.type = 'file'
      input.accept = 'image/*'
      input.onchange = async () => {
        try {
          const file = input.files && input.files[0]
          if (!file) return
          if (file.size > 4 * 1024 * 1024) { host.bubble('图片太大（超过 4MB）', 4000); return }
          // 先压缩再上传（长边 ≤1280 / JPEG 0.85；失败回退原图）
          const img0 = await imageToB64(file)
          const b64 = img0 ? img0.b64 : ''
          if (!b64) { host.bubble('图片读不出来', 4000); return }
          host.bubble('本鲸看看这张图…', 3000)
          host.setChatOpen(false)
          const hdr = (img0 && img0.mime) || file.type || 'image/jpeg'
          const d = await postJson('/chat', { message: VISION_PROMPT, image: b64, imageMime: hdr })
          const reply = (d && d.reply) || '这条鱼看不懂这张图……'
          host.bubble('（看图）' + reply, 10000)
          // 聊天回复：长回复（≥80 字）按叙述 -15%，短句正常语速
          host.speakReply(reply)
        } catch (e) { host.bubble('图片处理失败', 4000) }
      }
      input.click()
    } catch (e) { host.bubble('打不开文件选择', 4000) }
  })

  // —— 语音试听 ——
  table.define('test-tts', (host) => {
    host.bubble('测试语音：主人听得到吗？', 4000)
    host.speak('测试语音，主人听得到吗？')
  })

  // —— 提醒 ——
  table.define('remind-add', (host) => {
    // 照 C# Reminders.cs 的 ParseDue：一句话里就能带时间（明天9点 / 半小时后 / 每天9点…）
    const msg = (window as any).prompt('提醒什么？（可以一起说时间，如「明天9点提醒我开会」）')
    if (!msg) return
    let parsed = parseDue(msg)
    if (!parsed) {
      const ans = (window as any).prompt('什么时候提醒？（如 9点 / 明天9点 / 半小时后 / 20分钟后 / 每天9点）', '5分钟后')
      if (!ans) return
      parsed = parseDue(ans)
      if (!parsed) { host.bubble('这个时间本鱼没听懂……试试「9点」「明天9点」「半小时后」', 5000); return }
    }
    const text = String(parsed.cleaned || cleanReminderText(msg) || msg).slice(0, 200)
    const dueAt = parsed.at
    const repeat = parsed.repeat || 0
    postJson('/reminders', { text, at: dueAt.toISOString(), repeat })
      .then((d: any) => {
        if (d && d.ok) {
          const hh = String(dueAt.getHours()).padStart(2, '0')
          const mm = String(dueAt.getMinutes()).padStart(2, '0')
          const whenText = repeat > 0 ? ('每天 ' + hh + ':' + mm) : ((dueAt.getMonth() + 1) + '月' + dueAt.getDate() + '日 ' + hh + ':' + mm)
          host.bubble('好，' + whenText + ' 提醒你：' + text, 6000)
        } else host.bubble('提醒没加上')
      })
      .catch(() => host.bubble('提醒没加上'))
  })
  // —— 提醒：管理面板（列序号 + 接住下一条输入；逻辑在 client/reminder-manage.ts）——
  // 旧菜单项「提醒清单…」也指向面板，保证不依赖菜单是否新增项都能用。
  table.define('remind-manage', (host) => {
    try { host.openReminders() } catch (e) { host.bubble('提醒清单查不到', 4000) }
  })
  table.define('remind-list', (host) => {
    try { host.openReminders() } catch (e) { host.bubble('提醒清单查不到', 4000) }
  })

  // —— 数据备份：导出只在本机下载，导入只发回本机接口（逻辑在 client/actions/data.ts）——
  table.define('data-export', (host) => {
    exportBackup({ bubble: (text, ms) => host.bubble(text, ms) })
  })
  table.define('data-import', (host) => {
    importBackup({ bubble: (text, ms) => host.bubble(text, ms) })
  })

  // —— 统计卡：/stats 一次拿齐，失败只说「还没准备好」——
  table.define('stats', (host) => {
    getJson('/stats', { cache: 'no-store' }).then((d: any) => {
      if (!d || d.ok === false) {
        host.bubble('统计还没准备好', 5000)
        return
      }
      host.bubble(formatStats(d), 12000)
    }).catch(() => host.bubble('统计还没准备好', 5000))
  })
}
