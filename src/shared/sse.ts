/**
 * shared/sse.ts —— SSE 增量解析（纯函数，可单测）
 *
 * 为什么单独抽出来：流式对话的解析逻辑原来写在客户端 tryStreamChat 里，
 * 与网络、UI 混在一起，没法单独验证"分块到达"这种边界情况
 * （例如一个 JSON 被拆成两个 chunk 到达）。
 *
 * 约定：调用方把已收到的字符串拼进 buffer，交给 parseSseBuffer，
 * 返回：
 *   events  —— 这一批完整事件里 data 行解析出的**对象**（非 JSON / 非 data 行会被跳过）
 *   rest    —— 还没收完的尾巴，需拼到下一次
 *   invalid —— 解析失败、或解析出来不是对象的行数（便于发现上游格式变化，不抛异常）
 */

export type SseParseResult = {
  events: any[]
  rest: string
  invalid: number
}

export function parseSseBuffer(buffer: string): SseParseResult {
  const events: any[] = []
  let invalid = 0
  let rest = String(buffer || '')
  // 统一换行，避免 \r\n 造成"看起来有行却没解析"
  rest = rest.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  let idx = rest.indexOf('\n')
  while (idx >= 0) {
    const line = rest.slice(0, idx).trim()
    rest = rest.slice(idx + 1)
    idx = rest.indexOf('\n')
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const v = JSON.parse(payload)
      // 只收对象：`data: null` / 数字 / 字符串都不是本协议的帧。放进去会让调用方
      // （client/chat.ts 直接读 obj.error / obj.delta）在 null 上抛 TypeError，
      // 表现成「流式没接上 → 回退普通 /chat」，白烧一轮模型。这类帧计入 invalid。
      if (v && typeof v === 'object') events.push(v)
      else invalid++
    } catch (e) {
      invalid++
    }
  }
  return { events, rest, invalid }
}
