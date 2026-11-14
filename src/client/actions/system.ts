/**
 * client/actions/system.ts —— 系统类菜单动作的处理器（喂食 / 位置 / 余额 / 缓存 / 看图 / 提醒 …）
 *
 * 这里只做「动作 → 流程」，所有展示、朗读、状态归 host 管。
 * 新增一个系统动作 = 这里加一行 table.define(...)。
 */

import type { ActionHost, ActionTable } from '../actions.js'
import { promptText } from './prompt-modal.js'
import { getJson, postJson, delJson } from '../http.js'
import { VISION_PROMPT } from '../dropzone.js'
import { imageToB64 } from '../image.js'
import { parseDue, cleanReminderText } from '../../shared/time.js'
import { clipCodePoints } from '../../shared/text.js'
import { WHALE_WORKS_TEMPLATES } from '../../shared/whale-works.js'
import { clearT } from '../util.js'
import { exportBackup, importBackup } from './data.js'

/** 鲸群营造施工规范（guide 动作只显示路径，不打开外部程序） */
const WHALE_WORKS_GUIDE_PATH = 'docs/鲸群营造-工程流程.md'

/** 复制失败时统一提示手动查规范；文案钉死，测试与提示同源 */
const WHALE_WORKS_COPY_FAIL = '复制失败，请手动打开 ' + WHALE_WORKS_GUIDE_PATH

/**
 * 临时 textarea + execCommand('copy') 兜底（旧浏览器 / Clipboard API 被拒时）。
 * 任何异常都返回 false，不把复制失败冒到动作分发层。
 */
function copyViaTextarea(text: string): boolean {
  let area: any = null
  try {
    if (typeof document === 'undefined' || !document.body || typeof document.createElement !== 'function') return false
    area = document.createElement('textarea')
    area.value = text
    // 只读 + 移出视口：不闪屏，也不会弹软键盘；隐藏（display:none）时 execCommand 选不中
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-9999px'
    area.style.left = '-9999px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.focus()
    area.select()
    try { area.setSelectionRange(0, String(text).length) } catch (e) { }
    return typeof document.execCommand === 'function' && document.execCommand('copy') === true
  } catch (e) {
    return false
  } finally {
    try { if (area && area.parentNode) area.parentNode.removeChild(area) } catch (e) { }
  }
}

/**
 * 写剪贴板：优先 navigator.clipboard.writeText，失败（不支持/无权限/非安全上下文/
 * 返回 rejected Promise）再回退 textarea + execCommand。never rejects。
 */
function copyPlainText(text: string): Promise<boolean> {
  try {
    const nav: any = typeof navigator === 'undefined' ? null : navigator
    const clipboard = nav && nav.clipboard
    if (clipboard && typeof clipboard.writeText === 'function') {
      return Promise.resolve(clipboard.writeText(text))
        .then(() => true)
        .catch(() => copyViaTextarea(text))
    }
  } catch (e) {
    // navigator 读取或 writeText 同步抛错（策略禁用）→ 走兜底
  }
  return Promise.resolve(copyViaTextarea(text))
}

/** 施工队复制模板：成功说「已复制：<名字>」，失败指路规范文档。 */
function copyWhaleWorksTemplate(host: ActionHost, text: string, name: string): void {
  copyPlainText(text)
    .then((ok) => { host.bubble(ok ? '已复制：' + name : WHALE_WORKS_COPY_FAIL, ok ? 4000 : 6000) })
    .catch(() => { host.bubble(WHALE_WORKS_COPY_FAIL, 6000) })
}

/**
 * 鱼账本分桶（2026-11-07 B98）：展示顺序与中文名。
 * 宿主 /fishfood 与 /stats 的 byKind 键名就是这四个；顺序写死，不依赖对象键序。
 */
const KIND_BUCKETS: Array<{ key: string; label: string }> = [
  { key: 'chat', label: '聊天' },
  { key: 'story', label: '说书' },
  { key: 'summary', label: '摘要' },
  { key: 'personality', label: '人格' },
]

/** 取有限数字（缺字段/脏值按 0，不把 NaN 拼进气泡） */
function bucketNum(v: any): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * 分桶概况（一行纯文本）：`聊天 120（￥0.0001） · 说书 30；￥0.0001`
 *
 * 与 client/actions/data.ts 里的 formatKindBuckets **同口径**（那边给统计卡用）：
 *   · 只显示有数据的桶，0 桶不显示；
 *   · 桶里有金额才标 ￥，末尾合计只在真有金额时出现；
 *   · 没有 byKind / 全 0 → 返回空串，调用方连「分桶：」都不加。
 * 为什么不在 data.ts 导出共用：本批不允许新增模块导出（docs/模块接口清单.md 会过期）。
 * 改口径时两处一起改。
 */
function kindBucketText(byKind: any): string {
  const src = (byKind && typeof byKind === 'object' && !Array.isArray(byKind)) ? byKind : null
  if (!src) return ''
  const parts: string[] = []
  let costSum = 0
  for (const { key, label } of KIND_BUCKETS) {
    const b = (src[key] && typeof src[key] === 'object' && !Array.isArray(src[key])) ? src[key] : null
    const tokens = bucketNum(b && b.tokens)
    const cost = bucketNum(b && b.costCny)
    if (tokens <= 0 && cost <= 0) continue
    parts.push(label + ' ' + tokens + (cost > 0 ? '（￥' + cost.toFixed(4) + '）' : ''))
    if (cost > 0) costSum += cost
  }
  if (parts.length === 0) return ''
  return parts.join(' · ') + (costSum > 0 ? '；￥' + costSum.toFixed(4) : '')
}

export function registerSystemActions(table: ActionTable<ActionHost>): void {
  // 聊天缓存开关的在途状态：注册只发生一次（client.ts 建动作表时），闭包即单例
  let cacheToggleBusy = false
  let cacheToggleSeq = 0

  /**
   * 投喂上报：宿主记账后刷新成长外观。
   * 投喂已在本地生效，上报失败只静默（不弹错、不回滚碗数）。
   */
  function syncFeed(host: ActionHost): void {
    try {
      getJson('/pet?action=feed')
        .then(() => { try { host.syncGrowth() } catch (e) { } })
        .catch(() => { })
    } catch (e) { }
  }

  // —— 投喂 ——
  table.define('feed', (host) => {
    const r = host.persona.feed()
    // 每 8 碗说一次「饭碗账本」；平时说投喂台词
    if (r.bowls % 8 === 0) {
      host.say(host.persona.line('riceAccount'), 5000)
      syncFeed(host)
      return
    }
    host.say(r.text + (r.stageUp ? '（' + r.stage + '）' : ''), r.stageUp ? 6000 : 3500)
    host.heart()
    syncFeed(host)
  })

  // —— 位置与大小 ——
  table.define('home', (host) => { host.homePos(); host.bubble('回到角落啦') })
  // 流式回复开关：chubby-stream 以前只有人读、没人写（死键）
  table.define('stream-toggle', (host) => {
    try {
      const off = localStorage.getItem('chubby-stream') !== 'on'
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
      if (!d || !d.ok) { host.bubble('鱼粮查不到'); return }
      // 鱼账本（2026-11-07）：token 明细 + 人民币估算。金额缺省时只说 token ——
      // 绝不显示「¥0.00」冒充「花了 0 元」：0 与「不知道」是两件事。
      const inTok = Number(d.promptTokens) || 0
      const outTok = Number(d.completionTokens) || 0
      const hitTok = Number(d.cacheHitTokens) || 0
      const cny = Number(d.costCny) || 0
      const dayCny = Number(d.dayCostCny) || 0
      const parts = [
        '鱼粮账本：共 ' + (Number(d.total) || 0) + ' tokens（聊天 ' + (Number(d.chatTokens) || 0) + ' / 说书 ' + (Number(d.storyTokens) || 0) + '）',
        inTok > 0 ? '输入 ' + inTok + '（缓存命中 ' + hitTok + '）· 输出 ' + outTok : '',
        cny > 0 ? '≈ ¥' + cny.toFixed(4) + '（今日 ¥' + dayCny.toFixed(4) + '）' : '金额：暂无可拆分用量',
        cny > 0 ? '按官方价目（' + String(d.priceCheckedAt || '') + ' 核对）估算' : ''
      ].filter(Boolean)
      // 分桶（2026-11-07 B98）：聊天 / 说书 / 摘要 / 人格各花了多少。
      // 老账本没有 byKind → kindBucketText 返回空串，这一行连标题都不加（不显示 0 桶）。
      const text = parts.join('，')
      const buckets = kindBucketText(d.byKind)
      // 「本版起」：分桶只记新发生的用量，历史账不回填（拆不出来就不编）
      host.bubble(buckets ? text + '\n分桶（本版起）：' + buckets : text, 6000)
      // 进食动画：放在账本气泡之后（反过来会被账本文案覆盖，看起来像没触发）
      try { host.feedBelly?.(Number(d.total) || 0) } catch (e) { }
    }).catch(() => host.bubble('鱼粮查不到'))
  })
  table.define('growth', (host) => {
    // /state 只是补充亲密度：它挂了不能把已经拿到的成长数据一起拖成「查不到」
    Promise.all([getJson('/growth'), getJson('/state').catch(() => null)]).then(([g, s]: any[]) => {
      if (g && g.ok) {
        const nx = g.nextExp > 0 ? ('（经验 ' + g.exp + '/' + g.nextExp + '）') : '（满级）'
        // /state 失败时不能报「亲密度 0/100」：那是没拿到数据，不是真 0
        const raw = s && s.intimacy
        const it = (raw != null && raw !== '' && Number.isFinite(Number(raw)))
          ? (' · 亲密度 ' + Number(raw) + '/100')
          : ' · 亲密度查不到'
        // 菜单里刚拉到的数据同时用于外观刷新（体型/光点/光晕实时变，不用刷新页面）
        try { host.applyGrowth(g) } catch (e) { }
        host.bubble('成长：' + g.stage + nx + it, 5000)
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
        return
      }
      // NO_KEY 是最常见的失败：说清是「没配钥匙」而不是「接口坏了」
      const err = d && typeof d.error === 'string' ? d.error : ''
      if (err === 'NO_KEY') host.bubble('还没配 DeepSeek API Key，余额查不了', 6000)
      else if (err === 'timeout') host.bubble('余额接口超时，等会儿再看', 5000)
      else host.bubble('余额查不到', 5000)
    }).catch(() => host.bubble('余额查不到', 5000))
  })

  // —— 聊天语言 / 界面语言 ——
  table.definePrefix('chat-lang:', (host, v) => {
    const cl = v === 'en' ? 'en' : (v === 'zh' ? 'zh' : 'auto')
    try { localStorage.setItem('chubby-chatlang', cl) } catch (e) { }
    // auto 是合法值：以前落进 else 却显示「中文」，选「自动」看着像没生效
    host.bubble(cl === 'en' ? '聊天语言：English' : (cl === 'zh' ? '聊天语言：中文' : '聊天语言：自动（跟着主人说）'))
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
    // 乐观翻转：先改勾选，再等宿主回执；失败回滚。
    // 旧实现没有在途保护，也没有管同步抛错：
    //   · 连点两下会排两次 POST，回执乱序时后一次的成功会被前一次的回滚盖掉；
    //   · fetch 同步抛错（不可用时）时异常直接冒到分发层，乐观翻转永久留在错值上。
    if (cacheToggleBusy) { host.bubble('正在切换聊天缓存，稍等～', 2500); return }
    const nowOn = !host.chatCacheOn()
    host.setChatCacheOn(nowOn)
    cacheToggleBusy = true
    const my = ++cacheToggleSeq
    let guard: any = null
    let settled = false
    const finish = (real: boolean, text: string): void => {
      // 兜底超时先释放、之后又点了新的切换：旧回执一律作废，不能改界面
      if (settled || my !== cacheToggleSeq) return
      settled = true
      if (guard) { clearT(guard); guard = null }
      cacheToggleBusy = false
      host.setChatCacheOn(real)
      host.bubble(text, 5000)
    }
    try {
      // 8 秒无回执按失败回滚并放锁：锁不释放会让开关永远停在「稍等～」（占线）
      guard = setTimeout(() => finish(!nowOn, '切换失败'), 8000)
      Promise.resolve(postJson('/cache-toggle', { enabled: nowOn })).then((d: any) => {
        if (!d || !d.ok) { finish(!nowOn, '切换失败'); return }
        // 以宿主回报的实际值为准（策略可能强制某一侧）
        const real = typeof d.enabled === 'boolean' ? d.enabled : nowOn
        finish(real, '聊天缓存：' + (real ? '开（省 token）' : '关（每次重新回答）'))
      }).catch(() => finish(!nowOn, '切换失败'))
    } catch (e) {
      finish(!nowOn, '切换失败')
    }
  })
  table.define('clear-memory', (host) => {
    // 确认框本身可能被浏览器禁用/抛错：那种情况当作「没确认」，不执行
    let go = false
    try { go = !!(window as any).confirm('清除肥鲸对主人的聊天记忆？（成长/鱼粮/说书记录不受影响）') } catch (e) { go = false }
    if (!go) return
    let p: Promise<any>
    try { p = Promise.resolve(postJson('/clear-memory')) } catch (e) {
      host.bubble('清除失败', 4000)
      return
    }
    p.then((d: any) => {
      if (d && d.ok) {
        // host 侧已同时清聊天缓存（否则「忘了主人却还说着同一句话」）；
        // 本地消息也要清空，否则旧对话仍显示在面板里
        host.setMessages([])
        const n = Number(d.cacheCleared) || 0
        host.bubble('记忆清空啦' + (n > 0 ? '，聊天缓存也一起清了（' + n + ' 条）' : '') + '，我们重新认识吧～', 5000)
        return
      }
      host.bubble('清除失败', 4000)
    }).catch(() => host.bubble('清除失败', 4000))
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

  // —— 阅读文档：选文件 → 复用拖入链路的 OCR / 官方文件解析 ——
  table.define('read-doc', (host) => {
    try {
      const input = (document as any).createElement('input')
      input.type = 'file'
      input.accept = '.pdf,.doc,.docx,.ppt,.pptx,.txt,.md,.json,.log,.csv,image/*'
      input.onchange = () => {
        try {
          const file = input.files && input.files[0]
          if (!file) return
          if (typeof host.handleFileDrop === 'function') host.handleFileDrop(file)
          else host.bubble('文档入口没接上，试试重启桌宠', 4000)
        } catch (e) { host.bubble('文件读不出来', 4000) }
      }
      input.click()
    } catch (e) { host.bubble('打不开文件选择', 4000) }
  })

  // —— 鲸鱼看板：只切显示开关，不碰 AgentTeam ——
  table.define('team-board', (host) => {
    try {
      const cur = localStorage.getItem('chubby-team-board') !== 'off'
      localStorage.setItem('chubby-team-board', cur ? 'off' : 'on')
      if (typeof host.refreshTeamBoard === 'function') host.refreshTeamBoard()
      host.bubble(cur ? '鲸鱼看板关啦，任务板还在后台跑' : '鲸鱼看板开啦，会跟着任务板冒泡', 4000)
    } catch (e) {
      host.bubble('看板开关没存住', 4000)
    }
  })

  // —— 施工队（鲸群营造 v0.1）：只复制模板 / 显示规范路径 ——
  // 小鲸只读监理：不调 team_task_*、不建任务、不改任务板；模板只读自 WHALE_WORKS_TEMPLATES。
  table.define('whale-works:brief', (host) => {
    copyWhaleWorksTemplate(host, WHALE_WORKS_TEMPLATES.brief, '开工单')
  })
  table.define('whale-works:worker-card', (host) => {
    copyWhaleWorksTemplate(host, WHALE_WORKS_TEMPLATES.workerCard, '工人卡')
  })
  table.define('whale-works:acceptance', (host) => {
    copyWhaleWorksTemplate(host, WHALE_WORKS_TEMPLATES.acceptance, '验收单')
  })
  table.define('whale-works:guide', (host) => {
    host.bubble('施工规范：' + WHALE_WORKS_GUIDE_PATH + '（在本机用编辑器打开查看）', 8000)
  })

  // —— 语音试听 ——
  table.define('test-tts', (host) => {
    host.bubble('测试语音：主人听得到吗？', 4000)
    host.speak('测试语音，主人听得到吗？')
  })

  // —— 提醒 ——
  table.define('remind-add', async (host) => {
    // 照 C# Reminders.cs 的 ParseDue：一句话里就能带时间（明天9点 / 半小时后 / 每天9点…）
    // 桌面端是 Electron，window.prompt 不弹框；改用自绘输入框
    const msg = await promptText({ title: '提醒什么？', placeholder: '可以一起说时间，如「明天9点提醒我开会」', multiline: false, okText: '下一步' })
    if (!msg) return
    let parsed = parseDue(msg)
    if (!parsed) {
      const ans = await promptText({ title: '什么时候提醒？', placeholder: '如 9点 / 明天9点 / 半小时后 / 20分钟后 / 每天9点', defaultValue: '5分钟后', multiline: false, okText: '定' })
      if (!ans) return
      parsed = parseDue(ans)
      if (!parsed) { host.bubble('这个时间本鱼没听懂……试试「9点」「明天9点」「半小时后」', 5000); return }
    }
    // 与宿主 /reminders 同口径（B101）：按码点截到 200 字。
    // 旧写法 `.slice(0, 200)` 数的是 UTF-16 码元，会把 200 个 emoji 砍成 100 个，
    // 还可能在边界切出孤立代理项，跟着请求体落进 reminders.json。
    const text = clipCodePoints(String(parsed.cleaned || cleanReminderText(msg) || msg), 200)
    const dueAt = parsed.at
    const repeat = parsed.repeat || 0
    let p: Promise<any>
    try {
      p = Promise.resolve(postJson('/reminders', { text, at: dueAt.toISOString(), repeat }))
    } catch (e) {
      host.bubble('提醒没加上', 4000)
      return
    }
    p
      .then((d: any) => {
        if (d && d.ok) {
          const hh = String(dueAt.getHours()).padStart(2, '0')
          const mm = String(dueAt.getMinutes()).padStart(2, '0')
          const whenText = repeat > 0 ? ('每天 ' + hh + ':' + mm) : ((dueAt.getMonth() + 1) + '月' + dueAt.getDate() + '日 ' + hh + ':' + mm)
          host.bubble('好，' + whenText + ' 提醒你：' + text, 6000)
        } else host.bubble('提醒没加上', 4000)
      })
      .catch(() => host.bubble('提醒没加上', 4000))
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
  // —— 设置：只读查看当前生效的配置（不写盘、不含 Key 内容）——
  table.define('config-view', (host) => {
    getJson('/config', { cache: 'no-store' }).then((d: any) => {
      if (!(d && d.ok)) { host.bubble('配置读不到', 4000); return }
      const yn = (v: any) => (v ? '开' : '关')
      const lines = [
        '数据源：' + (d.dataSource || 'local') + ' · 模型：' + (d.model || '--'),
        '人格学习：' + yn(d.personalityLearning) + ' · 近期心境自写：' + yn(d.personalityWriting),
        '聊天缓存：' + yn(d.cacheEnabled),
        'DeepSeek Key：' + (d.hasDeepseekKey ? '已配置' : '未配置') + '（聊天和语音都用这一个）',
      ]
      host.bubble(lines.join('\n'), 12000)
    }).catch(() => host.bubble('配置读不到', 4000))
  })

  table.define('stats', (host) => {
    getJson('/stats', { cache: 'no-store' }).then((d: any) => {
      if (!(d && d.ok)) { host.bubble('统计还没准备好', 4000); return }
      const c = d.cache || {}
      const f = d.fishfood || {}
      const g = d.growth || {}
      const t = d.tts || {}
      const b = d.backup || {}
      const lines = [
        '缓存：tts ' + (c.tts || 0) + ' / chat ' + (c.chat || 0) + ' / asr ' + (c.asr || 0),
        '鱼粮：' + (f.total || 0) + ' token',
        '成长：' + (g.stage || '--') + '（' + (g.exp || 0) + '/' + (g.nextExp || 0) + '）',
        '亲密度：' + (d.intimacy || 0) + '/100',
        '数据源：' + (d.dataSource || 'local') + ' · 模型：' + (d.model || '--'),
        'TTS：' + (t.available ? '可用' : '不可用（浏览器朗读兜底）') + (t.interpreter ? '（' + t.interpreter + '）' : '') + (t.cooling ? ' · 冷却中' : ''),
        '备份：' + (b.count ? b.count + ' 份' : '无') + (b.lastAt ? '（最近 ' + new Date(b.lastAt).toLocaleString() + '）' : ''),
      ]
      host.bubble(lines.join('\n'), 12000)
    }).catch(() => host.bubble('统计还没准备好', 4000))
  })
}
