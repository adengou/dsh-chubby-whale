/**
 * shared/voices.ts —— 朗读音色白名单与归一化（宿主 /tts 与浏览器菜单共用同一份）
 *
 * 为什么放在 shared：白名单原先只在 client/voice/voices.ts，宿主 routes/tts.ts 只做
 * `^[a-zA-Z0-9-]+$` 字符集校验，HTTP 直调传 `ja-JP-NanamiNeural` 这类白名单外音色
 * 会被原样接受（B92 取证：策略/成本缺口，不是命令注入）。提到 shared 后两边共用
 * TTS_VOICES，宿主也能按同一份名单回落，不再各自维护一份。
 *
 * 像 'auto' 这样的值不在 edge-tts 的语音表里，但宿主认它：按文本语言自动选晓伊/Ana。
 *
 * 依赖方向：shared 只依赖 shared/immutable.ts，不 import client/host。
 */
import { deepFreeze } from './immutable.js';
/** 可用音色 —— 与菜单「换个声音 ▸」的列表一一对应 */
export const TTS_VOICES = [
    'zh-CN-XiaoyiNeural',
    'zh-CN-XiaoxiaoNeural',
    'zh-CN-XiaochenNeural',
    'zh-CN-YunxiNeural',
    'zh-CN-YunyangNeural',
    'en-US-AnaNeural',
    'en-US-JennyNeural',
    'en-GB-SoniaNeural',
    'auto',
];
deepFreeze(TTS_VOICES);
/** 默认音色：晓伊（与菜单默认与 C# 版一致） */
export const DEFAULT_VOICE = 'zh-CN-XiaoyiNeural';
/**
 * 白名单查表（小写名 → 规范写法）。
 * 大小写不敏感是刻意的（2026-11-07）：手改 localStorage / 旧配置里出现
 * "EN-US-ANANEURAL" 这类只差大小写的**合法**音色时，旧实现因为 indexOf 精确匹配
 * 直接判成非法，把用户选的音色静默重置成晓伊。查表后返回的是白名单里的规范写法，
 * 送给 edge-tts 的仍是大小写正确的名字。
 * 这张表只在模块加载时构建一次、不导出，外部改不到。
 */
const VOICE_BY_KEY = (() => {
    const m = new Map();
    for (const v of TTS_VOICES)
        m.set(v.toLowerCase(), v);
    return m;
})();
/**
 * 音色名规范化：白名单外（含空值/坏值）一律回退。
 * @param name 待规范的音色名（来自 localStorage / 菜单 / HTTP 请求体，可能是任意坏值）
 * @param fallback 未命中时的返回值，默认 DEFAULT_VOICE；宿主可传 '' 表示「没命中」以便自行回落
 */
export function normalizeVoiceName(name, fallback = DEFAULT_VOICE) {
    // String(x) 本身会抛（Object.create(null)、自定义 toString 抛错）：
    // 音色名从 localStorage / 菜单参数 / 请求体来，坏值只能回退，不能让整条朗读链崩在这里。
    let n = '';
    try {
        n = (name == null ? '' : String(name)).trim();
    }
    catch {
        return fallback;
    }
    if (!n)
        return fallback;
    const hit = VOICE_BY_KEY.get(n.toLowerCase());
    return hit || fallback;
}
