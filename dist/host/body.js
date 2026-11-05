/**
 * host/body.ts —— 读请求体 + JSON 解析（可复用）
 *
 * 原先 chat / chat-stream / asr / tts / reminders 各自重复：
 *   readBody → 判 BODY_TOO_LARGE → 打日志 → sendTooLarge → toString → try JSON.parse
 * 这里只统一「读 + 判 + 解析」；日志标签、413 响应由调用方决定（保持原有各路由的日志文案）。
 */
import { isBodyTooLarge, readBody } from './http.js';
/**
 * 带上限读请求体并解析 JSON。
 * - 超过 maxBytes：返回 {ok:false,tooLarge:true}（不抛），调用方回 413；
 * - 空体或 JSON 解析失败：body = {}（与既有路由一致，不把 400 当成错误路径）；
 * - 其它读流错误（连接中断等）：继续向上抛，由路由的兜底 catch 处理。
 */
export async function readJsonBody(req, maxBytes) {
    let raw;
    try {
        raw = await readBody(req, maxBytes);
    }
    catch (err) {
        if (isBodyTooLarge(err))
            return { ok: false, tooLarge: true };
        throw err;
    }
    const text = raw.toString('utf8');
    let body = {};
    try {
        body = text ? JSON.parse(text) : {};
    }
    catch {
        body = {};
    }
    return { ok: true, raw, text, body };
}
