/**
 * client/text.ts —— 纯文本工具（不碰 DOM / React / 网络）
 *
 * 原来散在 client.ts 顶部的 collapseText / collapsePoemBody / taleParts、
 * sayLine & speakReply 里各写一遍的「去标点归一 + 时间窗去重」、
 * tryStreamChat 里的「按句切分」，统一收到这里。
 * 全部是可直接在 node 里单测的纯函数。
 */

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
  if (i > 0 && i < t.length - 1) return { book: t.slice(0, i), title: t.slice(i + 1) }
  return { title: t, book: '' }
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
 * 与原来 tryStreamChat 里的 flush 逐字等价：每段 trim 后非空才返回，
 * 顺序保持原文顺序。
 */
export function createSentenceBuffer(maxLen = 40): SentenceBuffer {
  const limit = Math.max(2, Number(maxLen) || 40)
  let tail = ''
  function take(force: boolean): string[] {
    const out: string[] = []
    for (;;) {
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
