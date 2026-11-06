/**
 * client/actions/culture.ts —— 文化气菜单的动作处理器（说书 / 念诗 / 典故 / 弹琴）
 *
 * 每个动作一行注册：table.define('poem', (host) => { … })
 * 新增菜单动作时只改这里（+ client/menu.ts 的菜单数据），不动 client.ts。
 */


import { hasStoryAutoStorage, isStoryAutoOn, setStoryAuto } from '../story-auto.js'
import type { ActionHost, ActionTable } from '../actions.js'
import { getJson } from '../http.js'
import { estimateMelodySeconds } from '../melody.js'
import { collapsePoemBody, collapseText, taleParts, estimateSpeakMs } from '../text.js'
import { startProgress, stopProgress } from '../narration-progress.js'
import { setNarrationRate, setChatRate, poemRate } from '../rates.js'
import { clearT } from '../util.js'

/** 念诗需要的最小能力集（菜单动作与点播路由共用） */
export type ReciteHost = Pick<ActionHost, 'bubble' | 'talkFor' | 'narrate' | 'clearNarrate' | 'say' | 'speak' | 'persona' | 'narrationRate'>

/**
 * 同入口连点防重：同一个入口（念诗/民间故事/典故/成语/每日内容）在 gapMs 内只放行一次。
 * 没有这道闸时，连点两下会排两段同样的朗读进 TTS 队列，听起来就是「叠加播放」。
 * 故意只挡「连点」：窗口 1.5 秒，听完一段后再点不受影响。
 */
const recentStarts = new Map<string, number>()
export function beginOnce(key: string, gapMs = 1500): boolean {
  const now = Date.now()
  const last = recentStarts.get(key) || 0
  if (now - last < gapMs) return false
  recentStarts.set(key, now)
  return true
}

/**
 * 取消念诗：清掉念诗进度（下一次开念不会带着上一首的「第 x/N 句」）。
 * 说明：开念已改为同步调用 speak()，所以「停止说话」直接清 TTS 队列就能拦住；
 * 这个导出保留给「停止说话/歇会儿」接线用（当前 actions/system.ts 只 import、尚未调用）。
 */
export function cancelRecite(): void {
  try { stopProgress() } catch (e) { }
}

/**
 * 念诗的 per-call 收尾令牌：只有「最后一次开念」的 onDone 才有权清锁/收尾。
 *
 * client.ts 的 narrateOwner 挡的是「换使用方」（诗尾晚到会话说书已经接过锁）；同一使用方
 * 连念两首时，两次 narrate 用的是同一个 ownerId —— 旧诗的 onDone 晚到或重复到达，仍会被
 * 当成"自己人"，把新诗的叙述锁清掉、把新诗的进度停掉，还替新诗补一句「念完啦」。
 * 参照 actions/content.ts 的 narrateGen：开念时领号，收尾先比号，过期一律作废；
 * 同一次收尾也只放行一次（TTS 兜底与真 onDone 双回调不重复动锁）。
 */
let poemGen = 0

/** 念诗：气泡 + 叙述锁 + 朗读 + 念完收尾（菜单「念首诗」与点播「背首诗」共用一份） */
export function recitePoem(host: ReciteHost, poem: any): void {
  // 连点两次「念首诗」/「背首诗」：第二下直接忽略，不把两首诗排进队列
  if (!beginOnce('poem')) { host.bubble('正在念呢，稍等～', 2000); return }
  const body = String(poem.text || '')
  const author = String(poem.author || '佚名')
  const lines = body.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
  const totalLines = lines.length
  const intro = '念首诗——' + poem.title + '，' + (poem.dynasty ? poem.dynasty + '，' : '') + author + '。'
  // 进度：按诗句字数累计，气泡显示「第 x/N 句」；开场白要传进去，否则会被算成第 1 句
  try { startProgress('念诗·' + String(poem.title || ''), lines, intro) } catch (e) { }
  host.bubble('念诗·' + poem.title + '（' + author + '）' + (totalLines > 1 ? '· 共 ' + totalLines + ' 句' : ''), 15000)
  host.talkFor(6000)
  const speech = intro + collapsePoemBody(body)
  const my = ++poemGen
  host.narrate(estimateSpeakMs(speech))
  host.say(host.persona.line('poemStart'), 4000)
  // 直接开念：原来延迟 600ms 等气泡先亮，但那 600ms 里点「停止说话」拦不住这次开念
  // （TTS 队列还没这一段，stopSpeaking 无从取消）。气泡是同步写进 DOM 的，而 TTS 合成还要几秒，
  // 先气泡后开口的顺序不会倒过来；开念后「停止说话」能当场清队列。
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    // 后来的念诗已经接过锁：同一使用方的 ownerId 没变，narrateOwner 那道闸挡不住，
    // 所以旧诗的迟到/重复回调必须在这一层作废——不清新诗的锁、不停新诗的进度、
    // 不替新诗说「念完啦」。
    if (my !== poemGen) return
    try { stopProgress() } catch (e) { }
    host.clearNarrate()
    host.say(host.persona.line('poemDone'), 6000, { rate: '-8%', pitch: '+15Hz' })
  }
  try {
    host.speak(speech, {
      rate: poemRate(host.narrationRate()),
      onDone: release,
    })
  } catch (e) { }
}

import { pickCouplet } from '../duilian.js'

/** 叙述收尾：气泡 + 一句「讲完啦～」（民间故事 / 典故 / 成语三处共用） */
function finishSpeech(host: ActionHost, doneText: string): void {
  host.bubble(doneText, 5000)
  try { host.speak('讲完啦～') } catch (e) { }
}

export function registerCultureActions(table: ActionTable<ActionHost>): void {
  // 上一副对联放在闭包里：模块级单例会在"重复注册/测试多实例"之间串味
  let lastCouplet = ''
  // 「6 秒后揭晓下联」的定时器只留一个：同一时刻只允许有一条待揭晓，
  // 旧实现每次点击各排一个，连点两下就会先后冒出两副下联。
  let revealTimer: any = null

  /**
   * 出对联（随机／按分类共用一份）：
   *   · 连点用 beginOnce 挡在 6 秒揭晓窗口内，第二下只提示、不排队；
   *   · 揭晓定时器同一时刻只留一个，万一漏进来第二下也只是换一副，
   *     不会出现「上联 A、上联 B、下联 B、下联 A」这种两副同时揭晓。
   * withCat 只控制气泡前缀：按分类点播保留【分类】，随机一副保持原样。
   */
  function showCouplet(host: ActionHost, cat?: string, withCat?: boolean): void {
    if (!beginOnce('couplet', 6000)) { host.bubble('正在出对联，等本鲸揭晓～', 2000); return }
    const c = pickCouplet(lastCouplet, cat)
    lastCouplet = c.upper
    host.bubble((withCat ? '【' + c.cat + '】' : '') + '上联：' + c.upper + '（先对一对，本鲸 6 秒后揭晓下联）', 5600)
    clearT(revealTimer)
    revealTimer = setTimeout(() => {
      revealTimer = null
      try { host.bubble('下联：' + c.lower + '\n——' + c.source, 7000) } catch (e) { }
    }, 6000)
  }
  // —— 念首诗 ——
  table.define('poem', (host) => {
    getJson('/poem').then((d: any) => {
      const p = (d && d.ok && d.item) ? d.item : null
      if (!p) { host.bubble('诗册没读到'); return }
      recitePoem(host, p)
    }).catch(() => host.bubble('诗册没读到'))
  })

  // —— 说书（连载）——
  table.define('culture-story', (host) => { host.story.start('') })
  table.define('culture-story-next', (host) => { host.story.next() })
  table.define('story-reset', (host) => { host.story.reset() })
  /**
   * 连播开关的当前值：与菜单标签读同一个源。
   *
   * 菜单「连播：开/关」由 client/render.ts 的 readMenuRuntime() 决定，读的是
   * localStorage 的 `chubby-story-auto`（键不存在=开，'0'=关）；旧实现这里却按
   * storyState.auto（内存里的一次性开关）取反。而 client/story.ts 讲完最后一回时
   * 会把 auto 清成 false 且不动 localStorage —— 于是菜单显示「开」，点一下却先把
   * 它设成 true：看着像点了没反应，关掉得点两下。
   *
   * 读同一个源之后：菜单显示什么，点下去就关什么。localStorage 读不到（禁存储）时
   * 退回内存值 —— 那种环境本来就没有持久化，至少让开关改得动，气泡按实际值说。
   */
  function storyAutoPref(host: ActionHost): boolean {
    // 读侧统一走 story-auto.ts（兼容历史脏值 'on'/'1'）；禁存储时才退回内存值
    if (!hasStoryAutoStorage()) {
      // 禁存储/隐私模式：退回内存里的一次性开关（否则「开」会被当成真实值，点一下方向会反）
      return host && host.storyState && host.storyState.auto ? !!host.storyState.auto.current : true
    }
    return isStoryAutoOn()
  }
  // 连播开关：默认开（主人要求）；关掉后一段讲完就停，状态记在 localStorage
  table.define('story-auto', (host: ActionHost) => {
    const next = !storyAutoPref(host)
    try { if (host.storyState && host.storyState.auto) host.storyState.auto.current = next } catch (e) { }
    setStoryAuto(next)
    host.bubble(next ? '连播：开——讲完这段自动接下一段' : '连播：关——讲完这段就停', 4000)
  })
  // 叙述语速：菜单里选一档，立即生效（典故/成语/讲东西都用它）
  table.definePrefix('narration-rate:', (host, suffix) => {
    const v = String(suffix || '')
    if (setNarrationRate(v)) host.bubble('叙述语速：' + v, 4000)
    else host.bubble('这个语速值不认', 3000)
  })
  // 聊天语速：菜单里选一档，立即生效（聊天回复 / 喊名字应答都用它）
  table.definePrefix('chat-rate:', (host, suffix) => {
    const rate = String(suffix || '').trim()
    if (!setChatRate(rate)) { host.bubble('这个语速值不认', 3000); return }
    host.bubble('聊天语速：' + rate, 4000)
  })
  // 念诗语速：菜单里选一档，立即生效
  table.definePrefix('poem-rate:', (host, suffix) => {
    const rate = String(suffix || '')
    if (!/^-\d{1,2}%$/.test(rate)) { host.bubble('这个语速值不认', 3000); return }
    try { localStorage.setItem('chubby-poem-rate', rate) } catch (e) { }
    host.bubble('念诗语速：' + rate, 4000)
  })
  // 说书语速：菜单里选一档，立即生效（只影响说书）
  table.definePrefix('story-rate:', (host, suffix) => {
    const rate = String(suffix || '')
    if (!/^-\d{1,2}%$/.test(rate)) { host.bubble('这个语速值不认', 3000); return }
    try { localStorage.setItem('chubby-story-rate', rate) } catch (e) { }
    host.bubble('说书语速：' + rate, 4000)
  })

  // —— 民间故事：标题 + 出处 + 整篇完整念（不截断；长故事靠 TTS 队列逐块念完），叙述语速 ——
  table.define('culture-tale', (host) => {
    if (!beginOnce('tale')) { host.bubble('正在讲呢，稍等～', 2000); return }
    getJson('/culture?type=minsu').then((d: any) => {
      if (!(d && d.ok && d.item)) { host.bubble('故事没讲成'); return }
      const tp = taleParts(d.item.title)
      const body = collapseText(d.item.text)
      host.bubble('讲民间故事·' + tp.title + (tp.book ? '（出自《' + tp.book + '》）' : ''), 9000)
      host.talkFor(5000)
      host.speak('讲个民间故事——' + tp.title + (tp.book ? '，出自《' + tp.book + '》' : '') + '。' + body, {
        rate: host.narrationRate(),
        onDone: () => finishSpeech(host, '故事讲完啦～'),
      })
    }).catch(() => host.bubble('故事没讲成'))
  })

  // —— 典故 ——
  table.define('culture-allusion', (host) => {
    if (!beginOnce('allusion')) { host.bubble('正在讲呢，稍等～', 2000); return }
    getJson('/culture?type=chengyu').then((d: any) => {
      if (!(d && d.ok && d.item)) { host.bubble('典故没讲成'); return }
      const body = collapseText(d.item.text)
      host.bubble('讲典故·' + d.item.title + '（' + (d.item.src || '') + '）', 9000)
      host.talkFor(5000)
      host.speak('讲个典故——' + String(d.item.title || '') + '，出自' + String(d.item.src || '') + '。' + body, {
        rate: host.narrationRate(),
        onDone: () => finishSpeech(host, '典故讲完啦～'),
      })
    }).catch(() => host.bubble('典故没讲成'))
  })

  // —— 成语辨析（一律叙述语速，不按长度改）——
  table.define('culture-idiom', (host) => {
    if (!beginOnce('idiom')) { host.bubble('正在讲呢，稍等～', 2000); return }
    getJson('/culture?type=idiom').then((d: any) => {
      if (!(d && d.ok && d.item)) { host.bubble('没查到'); return }
      host.bubble('成语辨析·' + d.item.title, 8000)
      const sp = String(d.item.title || '') + '：' + String(d.item.text || '')
      host.speak(sp, {
        rate: host.narrationRate(),
        onDone: () => finishSpeech(host, '这个成语讲完啦～'),
      })
    }).catch(() => host.bubble('没查到'))
  })

  table.define('culture-couplet', (host) => { showCouplet(host) })

  // —— 出个对联（按分类）：culture-couplet:<分类> ——
  table.definePrefix('culture-couplet:', (host, cat) => { showCouplet(host, cat, true) })
  // —— 弹首曲子：先停朗读，再弹；弹完顺带说一句（带自检记录）——
  table.definePrefix('music:', (host, name) => {
    host.stopSpeak()
    getJson('/melody?name=' + encodeURIComponent(name)).then((d: any) => {
      if (!(d && d.ok && d.song)) { host.bubble('这首曲子没找到'); return }
      const songName = String(d.song.name || '这首曲子')
      const bpm = Number(d.song.bpm) || 100
      const notes = d.song.notes || []
      const estSec = estimateMelodySeconds(notes, bpm)
      host.bubble('弹《' + songName + '》♪（约 ' + estSec + ' 秒）', 6000)
      host.playMelody(notes, bpm, () => {
        host.bubble('弹完啦～《' + songName + '》', 6000)
        host.talkFor(1500)
        try {
          host.diag({ melodyVoice: { at: Date.now(), requested: true, ok: false, err: '' } })
          host.speak('弹完啦～')
          // 1.2 秒后还没进入播放就记一笔（供主人用 __chubbyWhale.melodyVoice 自查）
          setTimeout(() => {
            try {
              const w: any = (typeof window !== 'undefined') ? (window as any).__chubbyWhale : null
              const info = w && w.melodyVoice
              if (info && !host.voicePlaying()) info.err = 'TTS 未开始（可能被浏览器拦或合成失败）'
            } catch (e) { }
          }, 1200)
        } catch (e: any) {
          host.diag({ melodyVoice: { requested: false, err: String(e) } })
        }
      })
    }).catch(() => host.bubble('弹琴失败'))
  })
}
