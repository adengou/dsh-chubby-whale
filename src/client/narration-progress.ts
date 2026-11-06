/**
 * client/narration-progress.ts —— 叙述进度（念诗：第几句 / 共几句）
 *
 * 设计：进度状态收在工厂闭包里（createProgress），默认导出一个实例函数供现有调用方使用；
 * 想在测试或多实例场景里独立一份，就自己 createProgress()，互不干扰。
 *
 * 算法要点：不能按标点数量数句（开场白"念首诗——雨霖铃，宋，柳永。"会把进度一下子推 3 句）。
 * 改为**按字数累计**：把已在念的字数减去开场白长度，再和每句的累计字数比较。
 */

export type Progress = {
  /** 开始一段叙述（label 用于气泡前缀，lines 是正文逐句，intro 是开场白） */
  start: (label: string, lines: string[], intro?: string) => void
  /** 结束（中断/念完都要调，否则下一次会带着上一段的状态） */
  stop: () => void
  /** 是否有活动中的进度 */
  active: () => boolean
  /** 当前念到第几句（1 起；还在开场白时返回 0） */
  index: () => number
  /** 推进并拼气泡文案；无进度返回空串 */
  bump: (segment: string) => string
}

type State = {
  label: string
  /** 每句结束处的累计字数 */
  cum: number[]
  introLen: number
  spoken: number
}

export function createProgress(): Progress {
  let current: State | null = null

  function index(): number {
    if (!current) return 0
    const eff = current.spoken - current.introLen
    if (eff < 0) return 0
    let done = 0
    for (const c of current.cum) { if (c <= eff) done++ }
    const total = current.cum.length
    return Math.min(total, done + 1)
  }

  return {
    start(label: string, lines: string[], intro = ''): void {
      const lens = (lines || [])
        .map((l) => String(l || '').replace(/\s+/g, '').length)
        .filter((n) => n > 0)
      const cum: number[] = []
      let sum = 0
      for (const n of lens) { sum += n; cum.push(sum) }
      current = {
        label: String(label || ''),
        cum,
        introLen: String(intro || '').replace(/\s+/g, '').length,
        spoken: 0,
      }
    },
    stop(): void { current = null },
    active(): boolean { return current !== null },
    index,
    bump(segment: string): string {
      if (!current) return ''
      const seg = String(segment || '')
      // 先按"本段开始前已念的字数"算进度，再把本段字数记入；
      // 反过来的话，开场白念完时会被算成"第 1 句"，实机看起来就错位了。
      const idx = index()
      current.spoken += seg.replace(/\s+/g, '').length
      const total = current.cum.length
      const head = total > 0 && idx > 0 ? current.label + '（第 ' + idx + '/' + total + ' 句）' : current.label
      return head + (seg.trim() ? '：' + seg.trim() : '')
    },
  }
}

/** 默认实例：现有调用方（culture.ts / voice-bridge.ts / client.ts）共用一份 */
const defaultProgress = createProgress()

export const startProgress = defaultProgress.start
export const stopProgress = defaultProgress.stop
export const progressActive = defaultProgress.active
export const progressIndex = defaultProgress.index
export const bumpProgress = defaultProgress.bump
