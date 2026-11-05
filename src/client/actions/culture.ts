/**
 * client/actions/culture.ts —— 文化气菜单的动作处理器（说书 / 念诗 / 典故 / 弹琴）
 *
 * 每个动作一行注册：table.define('poem', (host) => { … })
 * 新增菜单动作时只改这里（+ client/menu.ts 的菜单数据），不动 client.ts。
 */


import type { ActionHost, ActionTable } from '../actions.js'
import { getJson } from '../http.js'
import { estimateMelodySeconds } from '../melody.js'
import { collapsePoemBody, collapseText, taleParts, estimateSpeakMs } from '../text.js'
import { startProgress, stopProgress } from '../narration-progress.js'
import { setNarrationRate } from '../rates.js'

/** 念诗语速：菜单里选过就用选的（-15%/-20%/-25%/-30%），否则沿用叙述语速 -25% */
function poemRate(fallback: string): string {
  try {
    const v = localStorage.getItem('chubby-poem-rate')
    if (v && /^-\d{1,2}%$/.test(v)) return v
  } catch (e) { }
  return fallback
}

/** 念诗需要的最小能力集（菜单动作与点播路由共用） */
export type ReciteHost = Pick<ActionHost, 'bubble' | 'talkFor' | 'narrate' | 'clearNarrate' | 'say' | 'speak' | 'persona' | 'narrationRate'>

/** 念诗：气泡 + 叙述锁 + 朗读 + 念完收尾（菜单「念首诗」与点播「背首诗」共用一份） */
export function recitePoem(host: ReciteHost, poem: any): void {
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
  host.narrate(estimateSpeakMs(speech))
  host.say(host.persona.line('poemStart'), 4000)
  setTimeout(() => {
    try {
      host.speak(speech, {
        rate: poemRate(host.narrationRate()),
        onDone: () => {
          try { stopProgress() } catch (e) { }
          host.clearNarrate()
          host.say(host.persona.line('poemDone'), 6000, { rate: '-8%', pitch: '+15Hz' })
        },
      })
    } catch (e) { }
  }, 600)
}

import { pickCouplet } from '../duilian.js'

export function registerCultureActions(table: ActionTable<ActionHost>): void {
  // 上一副对联放在闭包里：模块级单例会在"重复注册/测试多实例"之间串味
  let lastCouplet = ''
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
  // 连播开关：默认开（主人要求）；关掉后一段讲完就停，状态记在 localStorage
  table.define('story-auto', (host: any) => {
    const cur = host && host.storyState && host.storyState.auto ? !!host.storyState.auto.current : true
    const next = !cur
    try { if (host.storyState && host.storyState.auto) host.storyState.auto.current = next } catch (e) { }
    try { localStorage.setItem('chubby-story-auto', next ? '1' : '0') } catch (e) { }
    host.bubble(next ? '连播：开——讲完这段自动接下一段' : '连播：关——讲完这段就停', 4000)
  })
  // 叙述语速：菜单里选一档，立即生效（典故/成语/讲东西都用它）
  table.definePrefix('narration-rate:', (host, suffix) => {
    const v = String(suffix || '')
    if (setNarrationRate(v)) host.bubble('叙述语速：' + v, 4000)
    else host.bubble('这个语速值不认', 3000)
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

  // —— 民间故事：标题 + 出处 + 整篇（超 6000 字才截），叙述语速 ——
  table.define('culture-tale', (host) => {
    getJson('/culture?type=minsu').then((d: any) => {
      if (!(d && d.ok && d.item)) { host.bubble('故事没讲成'); return }
      const tp = taleParts(d.item.title)
      const body = collapseText(d.item.text)
      host.bubble('讲民间故事·' + tp.title + (tp.book ? '（出自《' + tp.book + '》）' : ''), 9000)
      host.talkFor(5000)
      host.speak('讲个民间故事——' + tp.title + (tp.book ? '，出自《' + tp.book + '》' : '') + '。' + body.slice(0, 6000), {
        rate: host.narrationRate(),
        onDone: () => { host.bubble('故事讲完啦～', 5000); try { host.speak('讲完啦～') } catch (e) { } },
      })
    }).catch(() => host.bubble('故事没讲成'))
  })

  // —— 典故 ——
  table.define('culture-allusion', (host) => {
    getJson('/culture?type=chengyu').then((d: any) => {
      if (!(d && d.ok && d.item)) { host.bubble('典故没讲成'); return }
      const body = collapseText(d.item.text)
      host.bubble('讲典故·' + d.item.title + '（' + (d.item.src || '') + '）', 9000)
      host.talkFor(5000)
      host.speak('讲个典故——' + String(d.item.title || '') + '，出自' + String(d.item.src || '') + '。' + body, {
        rate: host.narrationRate(),
        onDone: () => { host.bubble('典故讲完啦～', 5000); try { host.speak('讲完啦～') } catch (e) { } },
      })
    }).catch(() => host.bubble('典故没讲成'))
  })

  // —— 成语辨析（一律叙述语速，不按长度改）——
  table.define('culture-idiom', (host) => {
    getJson('/culture?type=idiom').then((d: any) => {
      if (!(d && d.ok && d.item)) { host.bubble('没查到'); return }
      host.bubble('成语辨析·' + d.item.title, 8000)
      const sp = String(d.item.title || '') + '：' + String(d.item.text || '')
      host.speak(sp, {
        rate: host.narrationRate(),
        onDone: () => { host.bubble('这个成语讲完啦～', 5000); try { host.speak('讲完啦～') } catch (e) { } },
      })
    }).catch(() => host.bubble('没查到'))
  })

  table.define('culture-couplet', (host) => {
    const c = pickCouplet(lastCouplet)
    lastCouplet = c.upper
    host.bubble('上联：' + c.upper + '（先对一对，本鲸 6 秒后揭晓下联）', 5600)
    setTimeout(() => { try { host.bubble('下联：' + c.lower + '\n——' + c.source, 7000) } catch (e) { } }, 6000)
  })

  // —— 出个对联（按分类）：culture-couplet:<分类> ——
  table.definePrefix('culture-couplet:', (host, cat) => {
    const c = pickCouplet(lastCouplet, cat)
    lastCouplet = c.upper
    host.bubble('【' + c.cat + '】上联：' + c.upper + '（先对一对，本鲸 6 秒后揭晓下联）', 5600)
    setTimeout(() => { try { host.bubble('下联：' + c.lower + '\n——' + c.source, 7000) } catch (e) { } }, 6000)
  })
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
