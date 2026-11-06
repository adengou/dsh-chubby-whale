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

/**
 * 白名单查表（小写名 → 规范写法）。
 * 大小写不敏感是刻意的（2026-11-07）：手改 localStorage / 旧配置里出现
 * "EN-US-ANANEURAL" 这类只差大小写的**合法**音色时，旧实现因为 indexOf 精确匹配
 * 直接判成非法，把用户选的音色静默重置成晓伊。查表后返回的是白名单里的规范写法，
 * 送给 edge-tts 的仍是大小写正确的名字。
 * 这张表只在模块加载时构建一次、不导出，外部改不到。
 */
const VOICE_BY_KEY: Map<string, string> = (() => {
  const m = new Map<string, string>()
  for (const v of TTS_VOICES) m.set(v.toLowerCase(), v)
  return m
})()

/** 音色名规范化：白名单外（含空值/坏值）一律回退 */
export function normalizeVoiceName(name: unknown, fallback: string = DEFAULT_VOICE): string {
  // String(x) 本身会抛（Object.create(null)、自定义 toString 抛错）：
  // 音色名从 localStorage / 菜单参数来，坏值只能回退，不能让整条朗读链崩在这里。
  let n = ''
  try { n = str(name).trim() } catch (e) { return fallback }
  if (!n) return fallback
  const hit = VOICE_BY_KEY.get(n.toLowerCase())
  return hit || fallback
}

/** 读菜单里选过的音色（localStorage）；读不到或非法 → 默认晓伊 */
export function readStoredVoiceName(): string {
  try { return normalizeVoiceName(localStorage.getItem('chubby-tts-voice')) } catch (e) { return DEFAULT_VOICE }
}
