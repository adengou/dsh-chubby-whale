/**
 * client/narration-progress.ts —— 叙述进度（念诗：第几句 / 共几句）
 *
 * 为什么单独一个模块：念诗的朗读分段由 voice.ts 切句，"第几句"只有念诗入口知道
 * （诗句行数与字数）。这里存一份轻量状态，voice-bridge 每段开播时调 bump() 推进。
 *
 * 算法要点：不能按标点数量数句（开场白"念首诗——雨霖铃，宋，柳永。"会把进度一下子推 3 句）。
 * 改为**按字数累计**：把已在念的字数减去开场白长度，再和每句的累计字数比较，
 * 得出当前念到第几句。
 */

type State = {
  /** 气泡前缀，如「念诗·雨霖铃」 */
  label: string
  /** 每句的正文字数（去掉空白） */
  lineLens: number[]
  /** 每句结束处的累计字数 */
  cum: number[]
  /** 开场白字数（"念首诗——X，唐，Y。"），推进时要扣掉 */
  introLen: number
  /** 已念的总字数（含开场白） */
  spoken: number
}

let current: State | null = null

export function startProgress(label: string, lines: string[], intro = ''): void {
  const lens = (lines || []).map((l) => String(l || '').replace(/\s+/g, '').length).filter((n) => n > 0)
  const cum: number[] = []
  let sum = 0
  for (const n of lens) { sum += n; cum.push(sum) }
  current = {
    label: String(label || ''),
    lineLens: lens,
    cum,
    introLen: String(intro || '').replace(/\s+/g, '').length,
    spoken: 0,
  }
}

export function stopProgress(): void {
  current = null
}

export function progressActive(): boolean {
  return current !== null
}

/**
 * 当前念到第几句（1 起；还在开场白时返回 0）。
 * 口径：用"这一段开始前已经念完的字数"去比每句累计字数，
 * 已念完几句就 +1（正在念的这句），避免"读完第一句显示 2/5"的错位。
 */
export function progressIndex(): number {
  if (!current) return 0
  const eff = current.spoken - current.introLen
  if (eff < 0) return 0
  let done = 0
  for (const c of current.cum) { if (c <= eff) done++ }
  const total = current.cum.length
  return Math.min(total, done + 1)
}

/**
 * 推进进度并拼气泡文案。
 * @param segment 这一段被朗读的文本
 * @returns 拼好进度的气泡文案；没有进度时返回空串
 */
export function bumpProgress(segment: string): string {
  if (!current) return ''
  const seg = String(segment || '')
  // 先按"本段开始前已念的字数"算进度，再把本段字数记入；
  // 反过来的话，开场白念完时会被算成"第 1 句"，实机看起来就错位了。
  const idx = progressIndex()
  current.spoken += seg.replace(/\s+/g, '').length
  const total = current.cum.length
  const head = total > 0 && idx > 0 ? current.label + '（第 ' + idx + '/' + total + ' 句）' : current.label
  return head + (seg.trim() ? '：' + seg.trim() : '')
}
