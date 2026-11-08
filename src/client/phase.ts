/**
 * client/phase.ts —— 工作状态机（原创实现）
 *
 * 只做三件事：接收"思考/工作/等待/成功/出错"事件、保证成功/出错这类
 * 一次性状态只维持一小段时间、到点自动回到 waiting。
 *
 * 时间由调用方传入（now 毫秒），不读 Date.now()，便于离线测试。
 * 没有引入任何第三方代码；状态与时长按本插件需要定。
 */

export type WorkPhase = 'waiting' | 'thinking' | 'working' | 'success' | 'error'

/** 一次性状态持续多久（毫秒） */
export const PHASE_ONE_SHOT_MS = 900

export type PhaseMachine = {
  enter: (p: WorkPhase, now: number) => WorkPhase
  tick: (now: number) => WorkPhase
  current: () => WorkPhase
}

function isOneShot(p: WorkPhase): boolean {
  return p === 'success' || p === 'error'
}

export function createPhaseMachine(opts: { oneShotMs?: number } = {}): PhaseMachine {
  const oneShotMs = Math.max(100, Number(opts.oneShotMs) || PHASE_ONE_SHOT_MS)
  let cur: WorkPhase = 'waiting'
  let until = 0

  function enter(p: WorkPhase, now: number): WorkPhase {
    const t = Number.isFinite(now) ? now : 0
    // 一次性状态还没播完时，普通状态不能把它顶掉（否则成功动画一闪就没）
    if (isOneShot(cur) && t < until && !isOneShot(p)) return cur
    if (p === cur) return cur
    cur = p
    until = isOneShot(p) ? t + oneShotMs : 0
    return cur
  }

  function tick(now: number): WorkPhase {
    const t = Number.isFinite(now) ? now : 0
    if (isOneShot(cur) && t >= until) cur = 'waiting'
    return cur
  }

  return { enter, tick, current: () => cur }
}
