/**
 * shared/tts.ts —— TTS 纯函数（浏览器端与 Node 端共用，方便单元验证）
 * 分段、语速校验、edge-tts 参数构造、跨平台探测用的错误码与探测脚本。
 */
/** 错误码：本机没有可用的 python/edge_tts → 路由回 501，客户端降级浏览器 speechSynthesis */
export const TTS_UNAVAILABLE = 'TTS_UNAVAILABLE';
/**
 * 解释器探测脚本：只导入 edge_tts 并打印 ok，不合成、不联网。
 * 放在 shared 里是为了让「探测」与「引擎」共用同一份命令，避免两处字符串漂移。
 */
export const TTS_PROBE_CODE = "import edge_tts; print('ok')";
/** 语速格式校验：+12% / -15% / +0% */
export function isValidRate(s) {
    return typeof s === 'string' && /^[+-]\d{1,2}%$/.test(s.trim());
}
/** 音调格式校验：+10Hz / -5Hz */
export function isValidPitch(s) {
    return typeof s === 'string' && /^[+-]\d{1,3}Hz$/.test(s.trim());
}
/** 语速规范化：合法就用，不合法退回默认（说书 -15%，普通聊天 +0%） */
export function normalizeRate(s, defaultRate = '+0%') {
    return isValidRate(s) ? String(s).trim() : defaultRate;
}
/**
 * 按标点切段，每段不超过 maxLen 字；**首段更短**（照 C# TextTools.SplitForTts）：
 * 第一段上限 min(maxLen, 14)——第一段越快合成完，开口越早，感知延迟主要来自等第一段。
 * 只切分、不丢字：返回值 join('') 必须等于入参 trim() 后原文。
 */
export function splitTtsSegments(text, maxLen = 80) {
    const t = String(text || '').trim();
    if (!t)
        return [];
    const limit = Math.max(8, Math.floor(Number(maxLen) || 80));
    const firstMax = Math.min(limit, 14);
    const boundary = /[。！？!?；;…，,、\n\r]/;
    const out = [];
    let start = 0;
    while (start < t.length) {
        const cap = out.length === 0 ? firstMax : limit;
        let end = Math.min(t.length, start + cap);
        if (end < t.length) {
            // 从上限往前找标点，尽量在句子边界切（首段太短就不硬切标点）
            const minCut = Math.max(2, Math.floor(cap / 3));
            let cut = -1;
            for (let i = end - 1; i >= start + minCut; i--) {
                if (boundary.test(t[i])) {
                    cut = i + 1;
                    break;
                }
            }
            if (cut > start)
                end = cut;
            // 别把代理对（emoji 等）劈成两半
            const code = t.charCodeAt(end - 1);
            if (code >= 0xd800 && code <= 0xdbff && end - 2 > start)
                end -= 1;
        }
        out.push(t.slice(start, end));
        start = end;
    }
    return out;
}
/** emoji / 杂项符号 / 变体选择符：这些字符念出来很怪，清洗时直接丢掉 */
function isEmojiCodePoint(code) {
    return (code >= 0x1f000 && code <= 0x1faff) // 表情、交通、补充符号
        || (code >= 0x2600 && code <= 0x27bf) // ☀❤✂ 等杂项符号与装饰符号
        || (code >= 0x2b00 && code <= 0x2bff) // ⬛⭐ 等
        || (code >= 0xfe00 && code <= 0xfe0f) // 变体选择符
        || code === 0x200d // 零宽连接符
        || code === 0x20e3; // 组合键帽
}
/**
 * 清洗 TTS 文本（照 C# TextTools.Clean）：
 * 去掉 markdown 标记（* # ` ~ > |）与 emoji，换行/连续空白压成单个空格，去首尾空白。
 * 只用于朗读；气泡里显示的仍是原文。
 */
export function cleanTtsText(raw) {
    const s = String(raw == null ? '' : raw);
    let out = '';
    for (const ch of s) {
        const code = ch.codePointAt(0) || 0;
        // 控制符丢掉（\n \t 下面换成空格）
        if ((code < 0x20 && code !== 0x0a && code !== 0x09) || code === 0x7f)
            continue;
        if (ch === '*' || ch === '#' || ch === '`' || ch === '~' || ch === '>' || ch === '|')
            continue;
        if (isEmojiCodePoint(code))
            continue;
        out += (ch === '\n' || ch === '\t' || ch === '\r') ? ' ' : ch;
    }
    return out.replace(/\s+/g, ' ').trim();
}
/**
 * 构造 edge-tts 的参数数组。
 * 注意：-15% 以横杠开头，分开传会被 click 当成选项（exit 2）→ 必须 --rate=-15% 单参数。
 * C# 版踩过这个坑，这里保持一致。
 */
export function buildEdgeTtsArgs(o) {
    const args = ['-m', 'edge_tts', '--voice', o.voice];
    if (isValidRate(o.rate))
        args.push('--rate=' + String(o.rate).trim());
    if (isValidPitch(o.pitch))
        args.push('--pitch=' + String(o.pitch).trim());
    args.push('--text', o.text, '--write-media', o.out);
    return args;
}
