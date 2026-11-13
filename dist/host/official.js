/**
 * host/official.ts —— DeepSeek 官方「全家桶」工具共用件（2026-11-14 接入）
 *
 * 只放三样东西，避免 OCR / 文件解析 / 联网三条路各抄一份：
 *   · 官方端点与超时；
 *   · multipart/form-data 组装（顺序必须由调用方掌控：/files 要求 purpose 在 file 之前）；
 *   · HTTP 状态码 → 人话错误（402 余额、413 太大、429 并发…），以及 OCR 原始输出的清洗。
 *
 * 刻意不做的事：不读 Key、不发请求（Key 由装配层注入给路由），不落盘、不缓存。
 */
/** OCR：识别 PDF/Word/PPT/图片里的文字，按页返回（文件不会存入 Files API） */
export const OCR_ENDPOINT = 'https://api.deepseek.com/v1/tools/ocr';
/** Files API：上传并解析文档，返回 file_id，再在对话里用 file 块引用 */
export const FILES_ENDPOINT = 'https://api.deepseek.com/files';
/** OCR 总时长上限 180s（官方口径：从开始上传算起，含识别与返回） */
export const OCR_TIMEOUT_MS = 180 * 1000;
/** 文件上传+解析：上传 120s、解析 120s，这里留到 200s */
export const FILES_TIMEOUT_MS = 250 * 1000;
/** OCR 请求体（base64 JSON）上限：官方单文件 100 MiB，本插件按 30 MiB 原文件兜住 */
export const OCR_MAX_BODY = 40 * 1024 * 1024;
/** 解码后原文件上限（与官方 100 MiB 留足余量；20MB 以上的公文极少见） */
export const OCR_MAX_FILE = 30 * 1024 * 1024;
/** 文件解析请求体/原文件上限（同上） */
export const FILES_MAX_BODY = 40 * 1024 * 1024 + 64 * 1024;
export const FILES_MAX_FILE = 30 * 1024 * 1024;
/** purpose 白名单：非法值直接拒，不发给官方换 400 */
export function normalizePurpose(raw) {
    const s = String(raw == null ? '' : raw).trim();
    return s === 'text_recognition' || s === 'rich_layout_recognition' ? s : null;
}
/** 文件名清洗：去掉引号/换行/反斜杠（会破坏 multipart 头），限长；空名给个兜底 */
export function safeFileName(raw) {
    const s = String(raw == null ? '' : raw)
        .replace(/[\u0000-\u001f\u007f"\\]/g, '_')
        .replace(/[/\\]/g, '_')
        .trim()
        .slice(0, 120);
    return s || 'file';
}
/**
 * 组装 multipart 请求体。**段顺序原样保留**——官方要求 /files 的 purpose 必须在 file 之前，
 * 这一条由调用方按参数顺序表达，本函数不排序、不重排。
 */
export function buildMultipart(parts) {
    const boundary = '----chubbywhale' + Math.random().toString(36).slice(2, 10);
    const chunks = [];
    for (const p of parts) {
        if (!p || !p.name)
            continue;
        if ('value' in p) {
            chunks.push(Buffer.from('--' + boundary + '\r\n' +
                'Content-Disposition: form-data; name="' + p.name + '"\r\n\r\n' +
                String(p.value) + '\r\n'));
        }
        else {
            chunks.push(Buffer.from('--' + boundary + '\r\n' +
                'Content-Disposition: form-data; name="' + p.name + '"; filename="' + p.filename + '"\r\n' +
                'Content-Type: ' + p.contentType + '\r\n\r\n'));
            chunks.push(p.data);
            chunks.push(Buffer.from('\r\n'));
        }
    }
    chunks.push(Buffer.from('--' + boundary + '--\r\n'));
    return { body: Buffer.concat(chunks), contentType: 'multipart/form-data; boundary=' + boundary };
}
/**
 * 官方错误 → 人话（给主人看的 hint）。
 * 只对已知状态码给具体原因，其余保留 HTTP 状态码原文，不编。
 */
export function officialErrorHint(status) {
    const n = Number(status) || 0;
    if (n === 400)
        return '文件格式不支持、解析不了，或者表单不合法';
    if (n === 401)
        return 'Key 无效或没配（DeepSeek Key）';
    if (n === 402)
        return '余额不足，先充点值';
    if (n === 403)
        return '这次请求被安全策略拒了';
    if (n === 408)
        return '上传太慢（中途停顿超过 30 秒），换个网络或小一点的文件';
    if (n === 413)
        return '文件太大（官方上限 100 MiB）';
    if (n === 429)
        return '同时处理的文件太多了，等一会儿再试';
    if (n === 500)
        return '官方处理失败，稍后重试';
    if (n === 503)
        return '官方服务繁忙，稍后重试';
    if (n === 504)
        return '官方处理超时，换小一点的文件再试';
    return '官方接口返回 HTTP ' + n;
}
/**
 * OCR 原始输出清洗：官方逐页结果里可能带 `<｜ref｜>…<｜/ref｜>` 与
 * `<｜box｜>[[x1,y1,x2,y2]]<｜/box｜>` 这类定位标记；直接当文本念会念出一串符号。
 * 保留标记里的文字、去掉坐标；压掉多余空行。
 */
export function cleanOcrText(raw) {
    return String(raw == null ? '' : raw)
        // 成对的 ref：留文字
        .replace(/<｜ref｜>([\s\S]*?)<｜\/ref｜>/g, '$1')
        // 坐标框：整段去掉
        .replace(/<｜box｜>\s*\[\[[\s\S]*?\]\]\s*<｜\/box｜>/g, '')
        // 其余未成对的特殊标记一律去掉
        .replace(/<｜[^｜]*｜>/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
/** 文本按码点截断（OCR/文件内容进 prompt 前的最后一道） */
export function clipText(raw, maxChars) {
    const chars = Array.from(String(raw == null ? '' : raw));
    const n = Math.max(0, Math.floor(Number(maxChars) || 0));
    return chars.length > n ? chars.slice(0, n).join('') + '…' : chars.join('');
}
