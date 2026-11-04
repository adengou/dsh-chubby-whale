/**
 * shared/tts.ts —— TTS 纯函数（浏览器端与 Node 端共用，方便单元验证）
 * 分段、语速校验、edge-tts 参数构造。
 */
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
 * 按标点切段，每段不超过 maxLen 字。
 * 只切分、不丢字：返回值 join('') 必须等于入参 trim() 后原文。
 */
export function splitTtsSegments(text, maxLen = 80) {
    const t = String(text || '').trim();
    if (!t)
        return [];
    if (t.length <= maxLen)
        return [t];
    const boundary = /[。！？!?；;…，,、\n\r]/;
    const minCut = Math.max(20, Math.floor(maxLen / 2));
    const out = [];
    let start = 0;
    while (start < t.length) {
        let end = Math.min(t.length, start + maxLen);
        if (end < t.length) {
            // 从上限往前找标点，尽量在句子边界切
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
