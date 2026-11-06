/**
 * client/voice/voices.ts —— 朗读音色白名单的**旧导入路径**（实现已提到 shared/voices.ts）
 *
 * 白名单与归一化现在是 src/shared/voices.ts（宿主 /tts 与客户端共用同一份，B93）。
 * 本文件只做 re-export，保持 `./voice/voices.js` 与 `./voice.js` 这两条既有导入路径可用，
 * 调用方（menu.ts / actions/voice.ts / voice-bridge.ts / voice.ts）无需改动。
 *
 * 只有 readStoredVoiceName 是浏览器专属（localStorage），仍留在客户端：
 * 它不属于「白名单同源」，宿主也不该读客户端存储。
 */

import { DEFAULT_VOICE, normalizeVoiceName } from '../../shared/voices.js'

export { TTS_VOICES, DEFAULT_VOICE, normalizeVoiceName } from '../../shared/voices.js'

/** 读菜单里选过的音色（localStorage）；读不到或非法 → 默认晓伊 */
export function readStoredVoiceName(): string {
  try { return normalizeVoiceName(localStorage.getItem('chubby-tts-voice')) } catch (e) { return DEFAULT_VOICE }
}
