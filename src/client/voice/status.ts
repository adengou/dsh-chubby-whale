/**
 * client/voice/status.ts —— 语音状态、统计与诊断快照（从 voice.ts 外提）
 *
 * 边界：这里只放「数据结构 + 读写小工具」，不做任何状态转移判定。
 *   何时 listening → recognizing → speaking 仍只由 voice.ts 决定；
 *   本模块只负责：状态去重与回调隔离、统计对象创建、上一段/上一句诊断快照。
 *
 * 为什么不把状态机搬进来：状态转移与录音器、朗读队列、网络请求的生命周期缠在一起，
 * 搬出来会把“只有一处在改状态”拆成两处，违背 voice.ts 顶部的设计原则①。
 */

export type VoiceStatus = 'idle' | 'listening' | 'recognizing' | 'thinking' | 'speaking'

export type VoiceStats = {
  windows: number          // 录过多少段
  skippedSilent: number    // 因太安静被丢
  uploaded: number         // 上传次数
  asrFail: number          // 识别失败
  /** 上一段还在识别时被丢弃的段数（忙则丢，不排队；2026-11-07） */
  asrBusyDropped?: number
  asrRetry?: number        // 超时自动重试次数（2026-11-06）
  asrTexts: number         // 识别出文字的段数
  heard: number            // 通过过滤、真正交给上层的
  echoDropped: number      // 被回声/重复过滤掉
  shortDropped: number     // 刚朗读过、只听到 1~2 字碎片（回声残留）
  ttsRequests: number      // 朗读请求数
  ttsPlayed: number        // 真正开始播放
  ttsFail: number          // 合成/播放失败
  ttsZombie: number
  dupDropped?: number      // 因重复被丢掉的识别结果（防重复回答）
  qDropped?: number        // 朗读队列超上限被丢弃的最旧段数（防断网时无限堆积）
  lastError: string
}

/**
 * 新建一份全零统计。
 * 刻意不做成模块级共享常量：多个语音实例（或多标签页）共用一份计数会互相污染。
 *
 * dupDropped 原先漏在初值里（类型标了可选，读取处各自 `|| 0` 兜着），
 * 但「全零统计」的契约要求每个字段都在：否则一次性 JSON 快照（自检复制/诊断面板）
 * 会缺这一项，排障时看到的是一份不完整的账。
 */
export function createVoiceStats(): VoiceStats {
  return {
    windows: 0, skippedSilent: 0, uploaded: 0, asrFail: 0, asrBusyDropped: 0, asrRetry: 0, asrTexts: 0, heard: 0,
    echoDropped: 0, shortDropped: 0, dupDropped: 0, qDropped: 0, ttsRequests: 0, ttsPlayed: 0, ttsFail: 0, ttsZombie: 0, lastError: '',
  }
}

export type StatusHolder = {
  get: () => VoiceStatus
  set: (s: VoiceStatus) => void
}

/**
 * 状态持有者：值相同时不重复回调（原来 `if (status === s) return`），
 * 回调异常一律吞掉 —— 上层 UI 出错不能反过来打断语音状态机。
 */
export function createStatusHolder(sink?: (s: VoiceStatus) => void): StatusHolder {
  let status: VoiceStatus = 'idle'
  return {
    get: () => status,
    set(s: VoiceStatus): void {
      if (status === s) return
      status = s
      try { if (sink) sink(s) } catch (e) { }
    },
  }
}

/** 诊断快照：上一段录音电平、上一句朗读结果、当前 APE 帧状态（只读给上层看） */
export type DiagSnapshots = {
  setApe: (v: any) => void
  getApe: () => any
  setSegment: (v: any) => void
  getSegment: () => any
  setTts: (v: any) => void
  getTts: () => any
}

export function createDiagSnapshots(): DiagSnapshots {
  let lastApe: any = null
  let lastSegment: any = null
  let lastTts: any = null
  return {
    setApe: (v: any) => { lastApe = v },
    getApe: () => lastApe,
    setSegment: (v: any) => { lastSegment = v },
    getSegment: () => lastSegment,
    setTts: (v: any) => { lastTts = v },
    getTts: () => lastTts,
  }
}
