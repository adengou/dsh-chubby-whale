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

/**
 * 朗读时长估算：给叙述锁（client/narration.ts）一个「大约还要念多久」的保守值。
 *
 * 旧实现按 UTF-16 码元 × 260ms + 3000ms 估，中文没问题；英文/数字却被当成一个字一个字念：
 * `hello world` 10 码元 → 5860ms，而 Edge TTS 实际约 1.2 秒；`1324` 也被算成 4040ms。
 * 估小会让叙述锁提前放行、麦克风把鱼自己的声音听回去；估大只是多静音一会儿，
 * 所以这里按语种分别取保守单价（宁可略大），而不是按码元一刀切：
 *   - 中文（汉字 + 全角标点）每字约 260ms —— 与旧实现单价相同；——、……、弯引号等
 *     中文常用普通标点也按 260ms/字计；
 *   - 英文单词每词约 300ms（默认语速约 3 词/秒）；
 *   - 数字每位约 200ms；
 *   - 半角句读 , . ! ? ; : 每个 100ms 的停顿；
 *   - 中文叙述沿用旧公式的 3000ms 固定余量（起播 + 合成 + 句末停顿），因此
 *     **纯中文（含全角标点）的结果与旧实现完全相等，不缩小**；
 *   - 纯英文/数字用 600ms 固定余量；短文本还有叙述锁 8 秒下限兜底（narration.ts）。
 *
 * 用例：estimateSpeakMs('hello world')  → 1200（旧 5860，实际约 1.2s）
 *       estimateSpeakMs('你好世界')      → 4040（旧 4040，不缩小）
 *       estimateSpeakMs('1324')          → 1400（旧 4040；4 位 × 200 + 600）
 *
 * 单调性：每个码元只增加非负时长（词内字母不重复计费，新词才 +300），文本变长估算不会变小。
 * 有限性：JS 字符串上限约 2^30 个码元，按每码元最多 300ms 计约 3e11ms，远小于 MAX_SAFE_INTEGER。
 */
export function estimateSpeakMs(text: any): number {
  const s = String(text == null ? '' : text)
  if (!s.trim()) return 0
  let cjk = 0
  let cjkPuncts = 0
  let cjkScript = false   // 汉字/全角区（含「，。！？」）：触发中文叙述的 3000ms 余量
  let words = 0
  let digits = 0
  let halfPuncts = 0
  let inWord = false
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (isSpeakDigit(c)) {
      digits++
      inWord = false
      continue
    }
    if (isSpeakWordLetter(c)) {
      if (!inWord) {
        words++
        inWord = true
      }
      continue
    }
    // 撇号/连字符不打断单词：don't、hello-world 按一个词念
    if (inWord && isSpeakWordJoiner(c)) continue
    inWord = false
    if (isCjkSpeakChar(c)) {
      cjk++
      cjkScript = true
      continue
    }
    // 中文排版常用的普通标点（——、……、弯引号、间隔号）也按每字 260ms 计，
    // 但单独出现时不把整句当成中文、不加 3000ms 余量（避免英文弯引号把估算抬到 3 秒级）。
    if (isCjkSpeakPunct(c)) {
      cjkPuncts++
      continue
    }
    if (isHalfSpeakPunct(c)) halfPuncts++
  }
  const base = cjkScript ? 3000 : 600
  const ms = base + (cjk + cjkPuncts) * 260 + words * 300 + digits * 200 + halfPuncts * 100
  return Math.round(Math.min(ms, Number.MAX_SAFE_INTEGER))
}

/** 朗读估算里的「字母」：ASCII + Latin-1 补充区（café、naïve 仍算作一个词） */
function isSpeakWordLetter(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f)
}

/** 词内连接符：撇号 / 连字符（不单独发音，也不拆词） */
function isSpeakWordJoiner(c: number): boolean {
  return c === 0x27 || c === 0x2d
}

/**
 * 中文与全角标点：汉字（基本区 4E00-9FFF、扩展 A 3400-4DBF、兼容区 F900-FAFF）
 * + CJK 标点（3000-303F，含「。、」）+ 全角区（FF00-FFEF，含「，！？：；」与全角数字字母）。
 * 这些一律按每字 260ms 计，与旧实现保持一致。
 */
function isCjkSpeakChar(c: number): boolean {
  return (c >= 0x4e00 && c <= 0x9fff)
    || (c >= 0x3400 && c <= 0x4dbf)
    || (c >= 0xf900 && c <= 0xfaff)
    || (c >= 0x3000 && c <= 0x303f)
    || (c >= 0xff00 && c <= 0xffef)
}

/** 半角句读：TTS 会停顿，按 100ms 计（空格、emoji 等其余字符不计时） */
function isHalfSpeakPunct(c: number): boolean {
  return c === 0x2c || c === 0x2e || c === 0x21 || c === 0x3f || c === 0x3b || c === 0x3a
}

/**
 * 中文排版常用的「普通标点」：破折号 —、省略号 …、弯引号 ‘’“”、间隔号 ·
 * （2010-2027 与 00B7）。单价按 260ms/字计，但不算中文脚本、不单独触发 3000ms 余量。
 */
function isCjkSpeakPunct(c: number): boolean {
  return (c >= 0x2010 && c <= 0x2027) || c === 0xb7
}

/** 半角数字：逐位计 200ms */
function isSpeakDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39
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

