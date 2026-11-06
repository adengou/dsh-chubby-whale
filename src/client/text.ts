/**
 * client/text.ts —— 纯文本工具（不碰 DOM / React / 网络）
 *
 * 原来散在 client.ts 顶部的 collapseText / collapsePoemBody / taleParts、
 * sayLine & speakReply 里各写一遍的「去标点归一 + 时间窗去重」、
 * tryStreamChat 里的「按句切分」，统一收到这里。
 * 全部是可直接在 node 里单测的纯函数。
 */

import { deepFreeze } from '../shared/immutable.js'

/** 正文换行/连续空白压成单空格（照 C# Culture.Collapse） */
export function collapseText(raw: any): string {
  return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim()
}

/** 诗句正文转朗读稿：换行→逗号；抹掉「。，」「，，」这类重复标点，免得 TTS 念出怪停顿 */
export function collapsePoemBody(raw: any): string {
  let t = String(raw == null ? '' : raw)
  t = t.replace(/\r/g, '')
  t = t.replace(/\n+/g, '，')
  t = t.replace(/[。！？；]+，/g, (m) => m.slice(0, 1))
  t = t.replace(/，{2,}/g, '，')
  t = t.replace(/，([。！？；])/g, '$1')
  return t.trim()
}

/** 民间故事标题在 culture 路由里是「书名·标题」拼一起的：拆开还原 C# TaleBubble 的拼法 */
export function taleParts(rawTitle: string): { title: string; book: string } {
  const t = String(rawTitle || '').trim()
  const i = t.indexOf('·')
  if (i < 0) return { title: t, book: '' }
  // 书名与标题都可能缺失：host 用 (book || '') + '·' + (title || '') 拼接，
  // 任一边为空就会留下前导/尾随的「·」。两边各自 trim，缺一边时当纯标题，
  // 避免气泡显示「讲民间故事··标题」、或把孤零零的「·」念出来。
  const book = t.slice(0, i).trim()
  const title = t.slice(i + 1).trim()
  if (book && title) return { book, title }
  return { title: title || book, book: '' }
}

/** 去标点与空白后的归一文本：判断「是不是同一句话」用 */
export function normalizePlain(text: any): string {
  return String(text == null ? '' : text).replace(/[\s。，！？,.!?、…~～]/g, '')
}

/** 按文字长度估朗读要多久（每字约 260ms，念诗 -25% 语速） */
export function estimateSpeakMs(text: any): number {
  return Math.round(String(text || '').length * 260) + 3000
}

export type Deduper = {
  /** 放行返回 true；窗口内重复返回 false 并回调 onDuplicate */
  allow: (text: string) => boolean
  reset: () => void
}

/**
 * 时间窗去重器：同一段归一文本在 windowMs 内只放行一次。
 * 台词库（25 秒）与回复朗读（30 秒）共用，只是窗口不同。
 */
/**
 * 回声归一化键：把朗读内容与 ASR 听回来的内容对齐成可比形式。
 * 为什么要专门处理"星号"：TTS 会把 `*动作*` 念成"星号 动作"，
 * 麦克风听回去后再和原文比对永远不中，于是自己的动作被当成主人发言。
 */
export function echoKey(s: any): string {
  return String(s == null ? '' : s)
    .replace(/星号|米字号/g, '*')
    .replace(/\*[^*]{1,60}\*/g, '')
    .replace(/[\s。，！？,.!?、…~～]/g, '')
}

/**
 * 朗读刚结束时的 1~2 字碎片判定。
 *
 * 实测：鱼念完带动作描写的话，麦克风会把自己的声音听回来，ASR 常吐出 1~2 个字
 * （例如「的歪」）。这类碎片长度太短、和原句比不中，会被当成主人发言送进模型。
 * 规则：只有"最近刚念过"时才拦；且命令词与常见两字回应（好的/晚安/讲吧…）一律放行。
 */
const SHORT_ECHO_ALLOW: string[] = [
  '停', '别', '不', '好', '喂',
  '停下', '停一下', '别说', '别念', '别讲', '闭嘴', '安静', '打住', '够了',
  '好的', '好呀', '好吧', '是的', '对的', '可以', '不行', '不要', '没有', '没事',
  '谢谢', '晚安', '早安', '再见', '等我', '稍等', '讲吧', '说吧', '唱吧', '念吧',
  '来吧', '开始', '继续', '没错', '试试', '嗯嗯',
]
deepFreeze(SHORT_ECHO_ALLOW)

export function isShortEchoFragment(plain: string, hadRecentSpeech: boolean): boolean {
  const p = String(plain || '')
  if (!hadRecentSpeech) return false
  if (p.length > 2) return false
  return SHORT_ECHO_ALLOW.indexOf(p) < 0
}

/**
 * 剥掉人设里的动作描写：Markdown 风格的 `*甩甩尾巴*` / 全角 `＊…＊`。
 *
 * 为什么必须在朗读前剥：TTS 会把星号念成"星号"，麦克风再听回去就变成假对话
 * （memory.json 里真出现过 7 条这种回声）。剥完顺便收拾标点后的空格。
 */
export function stripStageDirections(raw: any): string {
  let t = String(raw == null ? '' : raw)
  t = t.replace(/[\*＊][^*＊\n]{1,60}[\*＊]/g, ' ')
  t = t.replace(/[\*＊]/g, ' ')
  // 剥完动作后别留"主人， 白饭"这种标点后空格
  t = t.replace(/([，。！？；：、])\s+/g, '$1')
  return t.replace(/\s{2,}/g, ' ').trim()
}

export function createDeduper(opts: { windowMs: number; onDuplicate?: () => void }): Deduper {
  const windowMs = Math.max(0, Number(opts && opts.windowMs) || 0)
  let lastNorm = ''
  let lastAt = 0
  return {
    allow(text: string): boolean {
      const norm = normalizePlain(text)
      const now = Date.now()
      if (lastNorm && lastAt && now - lastAt < windowMs && norm === lastNorm) {
        try { if (opts.onDuplicate) opts.onDuplicate() } catch (e) { }
        return false
      }
      lastNorm = norm
      lastAt = now
      return true
    },
    reset(): void { lastNorm = ''; lastAt = 0 },
  }
}

export type SentenceBuffer = {
  /** 追加一段流式增量，返回本次可以朗读的整句（可能为空数组） */
  push: (delta: string) => string[]
  /** 收尾：把剩余未成句的文字全部吐出 */
  flush: () => string[]
}

/**
 * 流式切句器：句末标点（。！？!?；;换行）处切开；没标点就攒到 maxLen 字。
 * 与原来 tryStreamChat 里的 flush 正文逐字等价（空白本就 trim 掉）：每段 trim 后非空才返回，
 * 顺序保持原文顺序。
 */
export function createSentenceBuffer(maxLen = 40): SentenceBuffer {
  const limit = Math.max(2, Number(maxLen) || 40)
  let tail = ''
  function take(force: boolean): string[] {
    const out: string[] = []
    for (;;) {
      if (!tail) break
      // 先剥前导空白：否则以换行开头的增量（模型回复很常见）永远只匹配到那个换行本身
      // （m[0].length 为 1，不满足 >= 2），整段要攒到 maxLen 才吐，流式第一句明显延迟。
      // 这些空白本来也会被每段 trim 掉，剥掉不改变最终念出的正文。
      tail = tail.replace(/^\s+/, '')
      if (!tail) break
      const m = tail.match(/[\s\S]*?[。！？!?；;\n]/)
      if (m && m[0].length >= 2) {
        const seg = m[0].trim()
        tail = tail.slice(m[0].length)
        if (seg) out.push(seg)
        continue
      }
      if (force || tail.length >= limit) {
        const seg = tail.trim()
        tail = ''
        if (seg) out.push(seg)
      }
      break
    }
    return out
  }
  return {
    push(delta: string): string[] {
      tail += String(delta == null ? '' : delta)
      return take(false)
    },
    flush(): string[] {
      return take(true)
    },
  }
}

