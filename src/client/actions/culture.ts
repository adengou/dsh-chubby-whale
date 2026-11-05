/**
 * client/actions/culture.ts —— 文化气菜单的动作处理器（说书 / 念诗 / 典故 / 弹琴）
 *
 * 每个动作一行注册：table.define('poem', (host) => { … })
 * 新增菜单动作时只改这里（+ client/menu.ts 的菜单数据），不动 client.ts。
 */

import { pickCouplet } from '../duilian.js'

let lastCouplet = ''

import type { ActionHost, ActionTable } from '../actions.js'
import { getJson } from '../http.js'
import { estimateMelodySeconds } from '../melody.js'
import { collapsePoemBody, collapseText, taleParts, estimateSpeakMs } from '../text.js'

/** 念诗需要的最小能力集（菜单动作与点播路由共用） */
export type ReciteHost = Pick<ActionHost, 'bubble' | 'talkFor' | 'narrate' | 'clearNarrate' | 'say' | 'speak' | 'persona' | 'narrationRate'>

/** 念诗：气泡 + 叙述锁 + 朗读 + 念完收尾（菜单「念首诗」与点播「背首诗」共用一份） */
export function recitePoem(host: ReciteHost, poem: any): void {
  const body = String(poem.text || '')
  const author = String(poem.author || '佚名')
  host.bubble('念诗·' + poem.title + '（' + author + '）', 15000)
  host.talkFor(6000)
  const speech = '念首诗——' + poem.title + '，' + (poem.dynasty ? poem.dynasty + '，' : '') + author + '。' + collapsePoemBody(body)
  host.narrate(estimateSpeakMs(speech))
  host.say(host.persona.line('poemStart'), 4000)
  setTimeout(() => {
    try {
      host.speak(speech, {
        rate: host.narrationRate,
        onDone: () => {
          host.clearNarrate()
          host.say(host.persona.line('poemDone'), 6000, { rate: '-8%', pitch: '+15Hz' })
        },
      })
    } catch (e) { }
  }, 600)
}

import { pickCouplet } from '../duilian.js'

let lastCouplet = ''

export function registerCultureActions(table: ActionTable<ActionHost>): void {
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

  // —— 民间故事：标题 + 出处 + 整篇（超 6000 字才截），叙述语速 ——
  table.define('culture-tale', (host) => {
    getJson('/culture?type=minsu').then((d: any) => {
      if (!(d && d.ok && d.item)) { host.bubble('故事没讲成'); return }
      const tp = taleParts(d.item.title)
      const body = collapseText(d.item.text)
      host.bubble('讲民间故事·' + tp.title + (tp.book ? '（出自《' + tp.book + '》）' : ''), 9000)
      host.talkFor(5000)
      host.speak('讲个民间故事——' + tp.title + (tp.book ? '，出自《' + tp.book + '》' : '') + '。' + body.slice(0, 6000), {
        rate: host.narrationRate,
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
        rate: host.narrationRate,
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
        rate: host.narrationRate,
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
