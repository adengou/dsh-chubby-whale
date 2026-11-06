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

/**
 * 单字打断词：语音场景里最短的有效指令。
 * 它们和「嗯/啊」一样只有一个字，但语义上必须放行——客户端专门留了
 * 「朗读时喊停」的直通路径，宿主如果按「单字=气口」吞掉，喊停就永远无效。
 */
export const INTERRUPT_WORDS: string[] = ['停', '别', '不', '闭嘴', '打住']
deepFreeze(INTERRUPT_WORDS)

/**
 * 归一化：NFKC（全角→半角、兼容字符折叠）→ 去零宽 → 去空白与标点 → 统一小写。
 *
 * 为什么要 NFKC（2026-11-07 修）：识别服务会吐半角片假名标点，`｡`（U+FF61）不在中文
 * 标点表里，于是「嗯｡」归一化后还剩两个字 → 单字规则失效、被当成真话送进模型；
 * 「停｡」更糟：认不出是打断词，喊停掐不掉朗读。NFKC 把 ｡ → 。、＂ → "、Ａ → A、
 * ～ → ~，再统一小写，全角脏值才不会各说各话。
 * 零宽字符（\u200b-\u200f / \u2060 / BOM）同理：不删就会把单字撑成两个字。
 */
export function normalizeNoiseKey(text: unknown): string {
  return String(text == null ? '' : text)
    .normalize('NFKC')
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/\s+/g, '')
    .replace(/[。，、！？；：,.!?;:…~～·""''（）()【】\[\]「」『』《》〈〉"'`]/g, '')
    .toLowerCase()
}

/**
 * 判断一段识别结果是不是"没人说话"。
 * 规则：
 *   ⓪ 打断词（停/别/不/闭嘴/打住）先放行——它们和单字气口同形但语义相反
 *   ① 归一化后为空，或只有一个字符（"嗯"「啊」这类气口）
 *   ② 命中噪声词表
 *   ③ 整句只有一个字重复 ≥3 次（"嗯嗯嗯…"）：不设总长上限
 *      —— 旧实现卡在 length<=6，"啊"重复 7 次反而逃脱，越像气口越判成真话，是反直觉的漏洞
 */
export function isNoiseText(text: unknown): boolean {
  const k = normalizeNoiseKey(text)
  if (!k) return true
  if (isInterruptWord(k)) return false
  if (k.length <= 1) return true
  if (NOISE_TEXTS.indexOf(k) >= 0) return true
  if (/^([\u4e00-\u9fa5])\1{2,}$/.test(k)) return true
  return false
}

/** 是不是打断词（输入会先归一化，大小写/标点不影响判定） */
/**
 * 可以直接掐断朗读的**整句**指令（2026-11-07 B93 收口）。
 * 为什么要有：echo-filter 与 voice-bridge 各抄过一份（前者 19 条、后者 8 条），
 * 于是「停下来吧」在回声闸门里能放行、在桥接里却认不出，喊停时灵时不灵。
 * 这里作为唯一真源：新增口语说法只改这一处。
 */
export const INTERRUPT_PHRASES: readonly string[] = Object.freeze([
  '停下', '停下来', '停下来吧', '停一下', '停一停', '停吧',
  '别说了', '别讲了', '别念了', '别吵', '别说下去了',
  '不要说了', '不用说了', '安静', '打住', '够了', '暂停', '算了',
])

/**
 * 是不是「让本鱼停下」的指令：既认单个规范打断词，也认整句说法。
 * 只认**整句**（归一化后完全相等）——正文里恰好含「别」「不」的正常发言不能被吞掉。
 */
export function isInterruptCommand(text: unknown): boolean {
  const k = normalizeNoiseKey(text)
  if (!k) return false
  if (isInterruptWord(k)) return true
  return INTERRUPT_PHRASES.indexOf(k) >= 0
}

export function isInterruptWord(text: unknown): boolean {
  const k = normalizeNoiseKey(text)
  return k.length > 0 && INTERRUPT_WORDS.indexOf(k) >= 0
}
