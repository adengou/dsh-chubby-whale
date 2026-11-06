/**
 * host/body.ts —— 读请求体 + JSON 解析（可复用）
 *
 * 原先 chat / chat-stream / asr / tts / reminders 各自重复：
 *   readBody → 判 BODY_TOO_LARGE → 打日志 → sendTooLarge → toString → try JSON.parse
 * 这里只统一「读 + 判 + 解析」；日志标签、413 响应由调用方决定（保持原有各路由的日志文案）。
 */
import { isBodyTooLarge, readBody } from './http.js'

export type ReadJsonBodyResult =
  | { ok: true; raw: Buffer; text: string; body: any }
  | { ok: false; tooLarge: true }

/**
 * 去掉文本开头的 UTF-8 BOM（U+FEFF）。
 * Node 的 Buffer.toString('utf8') 不会再吞 BOM，而 JSON.parse 不容忍它（坑 15 / 坑 37 的同一个坑）：
 * 带 BOM 的 `{"a":1}` 会落到「解析失败 → body={}」，客户端拿到的是「空请求」而不是自己的数据。
 * 这里只在解析前剥一次，`raw` 仍是原始字节，调用方要原样留证不受影响。
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * 带上限读请求体并解析 JSON。
 * - 超过 maxBytes：返回 {ok:false,tooLarge:true}（不抛），调用方回 413；
 * - 空体或 JSON 解析失败：body = {}（与既有路由一致，不把 400 当成错误路径）；
 * - 其它读流错误（连接中断等）：继续向上抛，由路由的兜底 catch 处理。
 */
export async function readJsonBody(req: any, maxBytes: number): Promise<ReadJsonBodyResult> {
  let raw: Buffer
  try {
    raw = await readBody(req, maxBytes)
  } catch (err: any) {
    if (isBodyTooLarge(err)) return { ok: false, tooLarge: true }
    throw err
  }
  const text = stripBom(raw.toString('utf8'))
  let body: any = {}
  try { body = text ? JSON.parse(text) : {} } catch { body = {} }
  return { ok: true, raw, text, body }
}
