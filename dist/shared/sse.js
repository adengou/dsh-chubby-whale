/**
 * shared/sse.ts —— SSE 增量解析（纯函数，可单测）
 *
 * 为什么单独抽出来：流式对话的解析逻辑原来写在客户端 tryStreamChat 里，
 * 与网络、UI 混在一起，没法单独验证"分块到达"这种边界情况
 * （例如一个 JSON 被拆成两个 chunk 到达）。
 *
 * 约定：调用方把已收到的字符串拼进 buffer，交给 parseSseBuffer，
 * 返回：
 *   events  —— 这一批完整事件里 data 行解析出的对象（非 JSON / 非 data 行会被跳过）
 *   rest    —— 还没收完的尾巴，需拼到下一次
 *   invalid —— 解析失败的行数（便于发现上游格式变化，不抛异常）
 */
export function parseSseBuffer(buffer) {
    const events = [];
    let invalid = 0;
    let rest = String(buffer || '');
    // 统一换行，避免 \r\n 造成"看起来有行却没解析"
    rest = rest.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let idx = rest.indexOf('\n');
    while (idx >= 0) {
        const line = rest.slice(0, idx).trim();
        rest = rest.slice(idx + 1);
        idx = rest.indexOf('\n');
        if (!line.startsWith('data:'))
            continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]')
            continue;
        try {
            events.push(JSON.parse(payload));
        }
        catch (e) {
            invalid++;
        }
    }
    return { events, rest, invalid };
}
