/**
 * client/voice/voices.ts —— 朗读音色白名单与读写（从 voice.ts 外提）
 *
 * 白名单同时是 /tts 请求前的校验：列表外的值（旧配置、手改 localStorage、菜单传坏值）
 * 一律回退默认晓伊，绝不把坏值送给 edge-tts。
 * 'auto' 不在 edge-tts 的语音表里，但宿主 routes/tts.ts 认它：按文本语言自动选晓伊/Ana。
 */
import { str } from '../util.js'
import { deepFreeze } from '../../shared/immutable.js'

/** 可用音色 —— 与菜单「换个声音 ▸」的列表一一对应 */
export const TTS_VOICES: string[] = [
  'zh-CN-XiaoyiNeural',
  'zh-CN-XiaoxiaoNeural',
  'zh-CN-XiaochenNeural',
  'zh-CN-YunxiNeural',
  'zh-CN-YunyangNeural',
  'en-US-AnaNeural',
  'en-US-JennyNeural',
  'en-GB-SoniaNeural',
  'auto',
]
deepFreeze(TTS_VOICES)

/** 默认音色：晓伊（与菜单默认与 C# 版一致） */
export const DEFAULT_VOICE = 'zh-CN-XiaoyiNeural'

/** 音色名规范化：白名单外（含空值/坏值）一律回退 */
export function normalizeVoiceName(name: unknown, fallback: string = DEFAULT_VOICE): string {
  const n = str(name).trim()
  return TTS_VOICES.indexOf(n) >= 0 ? n : fallback
}

/** 读菜单里选过的音色（localStorage）；读不到或非法 → 默认晓伊 */
export function readStoredVoiceName(): string {
  try { return normalizeVoiceName(localStorage.getItem('chubby-tts-voice')) } catch (e) { return DEFAULT_VOICE }
}
