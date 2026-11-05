/**
 * client/actions/voice.ts —— 语音类菜单动作（待命 / 语音聊天 / 朗读 / 音色 / 端点 / 自检）
 *
 * 「唤醒」的整段启停逻辑在 client/voice-bridge.ts（效果等同于原 runAction 的 wake 分支），
 * 这里只负责菜单动作到 host 的映射。
 */

import type { ActionHost, ActionTable } from '../actions.js'
import { normalizeVoiceName } from '../voice.js'

export function registerVoiceActions(table: ActionTable<ActionHost>): void {
  // —— 语音待命：开=建/启语音模块；关=停录音（实例留着复用）——
  table.define('wake', (host) => { host.toggleStandby() })

  // —— 语音聊天：只决定识别到的话要不要送给模型 ——
  table.define('chatmode', (host) => {
    const nowOn = !host.voiceChat()
    host.setVoiceChat(nowOn)
    try { localStorage.setItem('chubby-voicechat', nowOn ? 'on' : 'off') } catch (e) { }
    host.bubble(nowOn ? '语音聊天：开，本鲸会接话' : '语音聊天：关，只听不接话')
  })

  // —— 语音朗读总开关 ——
  table.define('voice', (host) => {
    const nowOn = !host.voiceOn()
    host.setVoiceOn(nowOn)
    try { localStorage.setItem('chubby-voice', nowOn ? 'on' : 'off') } catch (e) { }
    if (!nowOn) host.stopSpeak()
    host.bubble(nowOn ? '语音朗读：开' : '语音朗读：关（省着点用）')
  })

  // —— 端点检测模式切换：经典（默认）/ 自适应（APE）——
  table.define('endpoint', (host) => {
    try {
      const v: any = host.voice()
      // 当前模式以语音实例为准（endpointInfo 现在报真实模式）；没实例才退回 localStorage
      const cur = (v && v.endpointInfo)
        ? v.endpointInfo().mode
        : (() => { try { return localStorage.getItem('chubby-endpoint') === 'ape' ? 'ape' : 'classic' } catch (e) { return 'classic' } })()
      const next = cur === 'ape' ? 'classic' : 'ape'
      localStorage.setItem('chubby-endpoint', next)
      if (v && v.setEndpointMode) v.setEndpointMode(next)
      // 提示按切换后的真实模式来说，避免"点了没变"的错觉
      const real = (v && v.endpointInfo) ? v.endpointInfo().mode : next
      host.bubble(real === 'ape' ? '端点检测：自适应（试用）' : '端点检测：经典（稳定）', 4000)
    } catch (e) { host.bubble('切换失败', 3000) }
  })

  // —— 语音自检：直接读语音模块统计，不用开控制台 ——
  table.define('ear-check', (host) => {
    try {
      const v: any = host.voice()
      const st: any = v ? v.stats : null
      if (!st) { host.bubble('语音模块还没起来（语音待命可能是关的）', 6000); return }
      const line = '语音自检（新模块）：' + String(v.status())
        + '\n录音段 ' + st.windows + '｜上传 ' + st.uploaded + '｜识别出字 ' + st.asrTexts + '｜交给对话 ' + st.heard
        + '\n丢：太安静 ' + st.skippedSilent + '｜回声/重复 ' + st.echoDropped + '｜识别失败 ' + st.asrFail
        + '\n去重：重复丢弃 ' + (st.dupDropped || 0) + ' 次（同一句话被切成两段时用）'
        + '\n端点检测：' + (v.endpointInfo ? (v.endpointInfo().mode === 'ape' ? '自适应' : '经典') : '?')
        + (function () { try { const t = v.lastTtsInfo ? v.lastTtsInfo() : null; if (!t) return ''; return '\n朗读：最后一段 ' + (t.failed ? '失败' : '已开播') + '｜文本开头「' + t.text + '」' } catch (e) { return '' } })()
        + (function () { try { const s = v.lastSegment ? v.lastSegment() : null; if (!s) return ''; return '\n上一段：' + s.mode + '｜窗口 ' + s.winMs + 'ms｜说话 ' + s.peMs + 'ms｜静音 ' + s.quMs + 'ms' + (s.floor !== null ? '｜底噪 ' + s.floor + 'dB' : '') + (s.target ? '｜目标 ' + s.target + 'ms' : '') + '\n识别结果：' + s.text } catch (e) { return '' } })()
        + '\n朗读：请求 ' + st.ttsRequests + '｜开播 ' + st.ttsPlayed + '｜失败 ' + st.ttsFail + '｜僵尸复位 ' + st.ttsZombie
        + '\n音色：' + (v.voiceName ? v.voiceName() : '?')
        + (function () {
          try {
            const w = host.wakeInfo ? host.wakeInfo() : null
            if (!w) return ''
            const head = w.awake
              ? ('醒着（还剩 ' + Math.round((Number(w.remainingMs) || 0) / 1000) + ' 秒）')
              : ('待唤醒（先喊「' + ((w.words && w.words[0]) || '大肥鱼') + '」）')
            return '\n唤醒词：' + head + '｜唤醒 ' + w.hits + ' 次｜放行 ' + w.passed + '｜挡下 ' + w.dropped
          } catch (e) { return '' }
        })()
        + (st.lastError ? '\n最近错误：' + st.lastError : '')
      host.bubble(line, 15000)
      try { navigator.clipboard.writeText(JSON.stringify(st)) } catch (e) { }
    } catch (e: any) { host.bubble('自检失败：' + String(e && e.message), 5000) }
  })

  // —— 换个声音：存下来 + 立即改语音实例音色 + 用宿主 /tts 试听 ——
  table.definePrefix('voice:', (host, v) => {
    // 白名单外（旧值/手改 localStorage）回退默认，绝不把坏音色送进 edge-tts
    const name = normalizeVoiceName(v)
    host.setTtsVoice(name)
    // 「自动」没有第三段音色名，别把 undefined 冒给主人看
    const shown = name === 'auto' ? '自动' : (name.split('-')[2] || name)
    host.bubble('音色换好啦：' + shown)
    // 试听走宿主 /tts（strict）：不再用浏览器 speechSynthesis，失败静默
    try { host.previewVoice('主人，这个声音好听吗？') } catch (e) { }
  })
}
