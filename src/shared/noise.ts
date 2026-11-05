import { deepFreeze } from './immutable.js'

/**
 * shared/noise.ts —— "这不是人话"的统一判定（client / host 共用一份）
 *
 * 为什么独立出来：以前 client 的 voice.ts 有一份 NOISE_TEXTS，host 的 ASR 路由不认识它，
 * 结果静音/气口被识别成「嗯。」「谢谢观看」后照样写进缓存（缓存里大量 17 字节条目），
 * 既占磁盘又会在下次命中时把噪声当真话返回。两边共用一份判定就不会各说各话。
 */

/** 识别服务常把静音/气口/片头片尾编成的词，一律当噪声 */
export const NOISE_TEXTS: string[] = [
  '嗯', '呃', '啊', '哦', '恩', '嗯嗯', '啊啊',
  '谢谢观看', '谢谢大家', '字幕', '请不吝点赞', '点赞', '订阅', '转发', '打赏', '再见',
  '本鱼在听', '嗯本鱼在听', '字幕由', '明镜与点点',
]
deepFreeze(NOISE_TEXTS)

/** 归一化：去空白与标点、统一小写 */
export function normalizeNoiseKey(text: unknown): string {
  return String(text == null ? '' : text)
    .replace(/\s+/g, '')
    .replace(/[。，、！？；：,.!?;:…~～·""''（）()【】\[\]]/g, '')
    .toLowerCase()
}

/**
 * 判断一段识别结果是不是"没人说话"。
 * 规则：
 *   ① 归一化后为空，或只有一个字符（"嗯"「啊」这类气口）
 *   ② 命中噪声词表
 *   ③ 同一个字重复 ≥3 次且整句很短（"嗯嗯嗯嗯"）
 */
export function isNoiseText(text: unknown): boolean {
  const k = normalizeNoiseKey(text)
  if (!k) return true
  if (k.length <= 1) return true
  if (NOISE_TEXTS.indexOf(k) >= 0) return true
  if (k.length <= 6 && /^([\u4e00-\u9fa5])\1{2,}$/.test(k)) return true
  return false
}
