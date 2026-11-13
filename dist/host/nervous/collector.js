/**
 * host/nervous/collector.ts —— 神经感知第三层：宿主侧只读事件收集器
 *
 * 只做一件事：订阅 dsh 的会话/代理事件，把「发生了什么」压成最小摘要，写进 200 条的环形缓冲；
 * 由 routes/nervous.ts 用 GET /api/chubby-whale/nervous 交给客户端轮询（client/nervous/host-sense.ts）。
 * 不归约情绪（那是客户端第二层 affect.ts 的事），不碰聊天记忆，不写任何文件。
 *
 * ── 事件名出处（全部来自本机已安装包的类型声明，不是猜的）──────────────────────
 *   · '@deepseek-ai/dsh-session'  lib/types/index.d.ts 第 63 行
 *       'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
 *     注释原文：Post-commit, fire-and-forget append feed … observer failures are logged and contained
 *     （后提交、即发即忘；订阅者抛错只被记录，不会让提交失败 —— 所以只读订阅对会话零影响）
 *   · 同文件第 43 行 'session/created'(session)、第 52 行 'session/disposed'(session)
 *   · '@deepseek-ai/dsh-agent'   lib/types/runtime-types.d.ts 第 279 行
 *       'agent/status'(this: Scoped<Agent>, payload: { agent: Agent; status: AgentStatus }): void
 *     注释原文：Agent status changed (`idle` ⇄ `running`)
 *
 * ── 为什么插件自己的 ctx 能收到这些事件 ────────────────────────────────────
 * 官方插件就是这么订的：'@deepseek-ai/dsh-session-title' lib/index.js 里
 *   ctx.on("session/event", (session, event) => { … })
 * （插件自己的 ctx，不是某个 agent 的子 ctx）；'@deepseek-ai/dsh-token-meter' 同样写法。
 * 派发侧的 scope 过滤不会漏掉我们：'@deepseek-ai/dsh-scope' lib/types/index.d.ts 第 86-97 行说明
 * scopeTarget「admits untagged listeners globally」—— 没有 scope 标签的监听（本插件即如此）
 * 能收到所有作用域里派发的事件。
 *
 * ── 三条硬约束 ──────────────────────────────────────────────────────────
 *   ① 只读：不改会话、不拦截、不 await、不做 IO；listener 内再套一层 try/catch，绝不外抛。
 *   ② 只存摘要：不落 message 正文、不落 tool 参数（arguments 里可能带主人原话），只留
 *      事件名 / seq / turn / step / 工具名 / 会话 id 前缀。
 *   ③ 失败隔离：任何一次订阅失败只打一条 warn，不影响插件加载，也不影响既有路由。
 *
 * 零第三方依赖：不 import @deepseek-ai/*，事件参数的形状按上面的 .d.ts 手工取字段（ctx 按 any 处理）。
 */
/** 契约规定的缓冲容量（docs/神经感知-接口契约.md 第三层：环形缓冲 200 条） */
const DEFAULT_CAP = 200;
// 诗词弹幕：用户一句话 → 本地匹配一句诗（纯函数，零依赖；不是第三方包）
import { matchPoem } from '../poem-echo.js';
/** 会话 id 只留前若干字符：够区分是哪个会话，又不把整串 id 塞进每条事件 */
const MAX_ID_LEN = 16;
/** 摘要里其余字符串字段（事件名、工具名、状态）的截断长度 */
const MAX_STR_LEN = 24;
/** 字符串裁剪：非字符串按空串处理，超长截断 */
function cut(v, max = MAX_STR_LEN) {
    const s = typeof v === 'string' ? v : '';
    return s.length > max ? s.slice(0, max) : s;
}
/** 取会话 id（Session.id 是 getter，detached 实例上可能抛错，一律吞掉） */
function sessionIdOf(session) {
    try {
        return cut(session && session.id, MAX_ID_LEN);
    }
    catch (e) {
        return '';
    }
}
/**
 * 把一条 SessionEvent 压成最小摘要。
 * 刻意不读 message / stream / usage：那些字段可能带主人原话与整段模型输出，
 * 对「感知有没有在干活」没有增量信息，却是隐私与体积的大头。
 */
function summarizeSessionEvent(session, event) {
    const data = {};
    data.event = 'session/event';
    data.name = cut(event && event.type) || 'unknown';
    const seq = Number(event && event.seq);
    if (Number.isFinite(seq))
        data.seq = seq;
    const payload = (event && event.data) || {};
    const turn = Number(payload.turn);
    if (Number.isFinite(turn))
        data.turn = turn;
    const step = Number(payload.step);
    if (Number.isFinite(step))
        data.step = step;
    // 只有 tool/call 的 data.name 是工具名；user/message 等事件里没有 name，不混用
    if (data.name === 'tool/call')
        data.tool = cut(payload.name);
    const sid = sessionIdOf(session);
    if (sid)
        data.session = sid;
    return data;
}
/** cap 归一：非有限数/非正数回默认值，小数向下取整 */
function resolveCap(cap) {
    const n = Math.floor(Number(cap));
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_CAP;
}
/**
 * 建一个宿主事件收集器。
 * cap 默认 200（契约值），可传入覆盖（离线测试用）。
 */
export function createHostCollector(opts) {
    const cap = resolveCap(opts && opts.cap);
    // ── 环形缓冲：固定长度数组 + 写指针，超出容量时覆盖最旧一条 ──────────────
    const buf = new Array(cap);
    let head = 0;
    let size = 0;
    /** 最新一条的 at；用于 at 单调化与 status() */
    let lastAt = 0;
    /**
     * 时间戳：同一毫秒内多条事件时递增 1，保证 at 严格单调。
     * 客户端按 at 去重（契约要求），同毫秒重复会让后一条被当成旧事件丢掉。
     */
    function stamp() {
        const now = Date.now();
        lastAt = now > lastAt ? now : lastAt + 1;
        return lastAt;
    }
    /** 写一条（环形覆盖） */
    function push(event) {
        buf[head] = event;
        head = (head + 1) % cap;
        if (size < cap)
            size++;
    }
    /** 最近 n 条，旧 → 新（n 省略 = 全部；n ≤ 0 = 空） */
    function recent(n) {
        let want = size;
        if (n !== undefined && n !== null) {
            const k = Math.floor(Number(n));
            want = Number.isFinite(k) && k > 0 ? Math.min(k, size) : 0;
        }
        if (want <= 0)
            return [];
        const out = [];
        const start = (head - want + cap * 2) % cap;
        for (let i = 0; i < want; i++) {
            const v = buf[(start + i) % cap];
            if (v)
                out.push(v);
        }
        return out;
    }
    // ── 订阅 ────────────────────────────────────────────────────────────
    const disposers = [];
    const subscribed = [];
    let started = false;
    /** 单个事件的订阅包装：ctx.on 不存在/抛错都只记一条 warn，绝不外抛 */
    function bind(ctx, name, listener) {
        try {
            if (!ctx || typeof ctx.on !== 'function')
                return;
            const off = ctx.on(name, listener);
            subscribed.push(name);
            if (typeof off === 'function') {
                disposers.push(() => { try {
                    off();
                }
                catch (e) { } });
            }
            else if (off && typeof off.dispose === 'function') {
                // 个别版本返回的是带 dispose() 的句柄而不是函数，两种都收
                disposers.push(() => { try {
                    off.dispose();
                }
                catch (e) { } });
            }
        }
        catch (e) {
            console.warn('[chubby-whale] nervous: 订阅 ' + name + ' 失败，已跳过（' + String((e && e.message) || e) + '）');
        }
    }
    /**
     * 从 user/message 事件里取用户文本：只用于本地主题匹配，
     * 不入缓冲、不落盘、不外传——命中后只推一条匹配结果。
     */
    function userTextOf(event) {
        try {
            const m = event && event.data && event.data.message;
            if (typeof m === 'string')
                return m;
            if (m && typeof m === 'object') {
                if (typeof m.text === 'string')
                    return m.text;
                const content = m.content;
                if (Array.isArray(content)) {
                    return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
                }
            }
        }
        catch (e) { }
        return '';
    }
    /** 'session/event'：一次会话日志追加（后提交、即发即忘；我们只读） */
    function onSessionEvent(session, event) {
        try {
            push({ at: stamp(), type: 'host', data: summarizeSessionEvent(session, event) });
        }
        catch (e) { }
        // 诗词弹幕：用户一句话 → 本地匹配一句诗 → 命中才把结果推进缓冲
        try {
            if (event && event.type === 'user/message') {
                const txt = Array.from(userTextOf(event)).slice(0, 1000).join('');
                if (txt) {
                    const echo = matchPoem(txt);
                    if (echo) {
                        push({ at: stamp(), type: 'host', data: { name: 'poem-echo', theme: echo.theme, line: echo.line, title: echo.title, author: echo.author } });
                    }
                }
            }
        }
        catch (e) { }
    }
    /** 'session/created' / 'session/disposed'：只记会话进出，不碰会话对象本身 */
    function onSessionLifecycle(kind, session) {
        try {
            const data = { event: kind };
            const sid = sessionIdOf(session);
            if (sid)
                data.session = sid;
            push({ at: stamp(), type: 'host', data });
        }
        catch (e) { }
    }
    /** 'agent/status'：idle ⇄ running，最直接的「主人在不在干活」信号 */
    function onAgentStatus(payload) {
        try {
            const data = { event: 'agent/status' };
            const status = cut(payload && payload.status);
            if (status)
                data.status = status;
            push({ at: stamp(), type: 'host', data });
        }
        catch (e) { }
    }
    function start(ctx) {
        if (started)
            return subscribed.slice();
        started = true;
        bind(ctx, 'session/event', (session, event) => onSessionEvent(session, event));
        bind(ctx, 'session/created', (session) => onSessionLifecycle('session/created', session));
        bind(ctx, 'session/disposed', (session) => onSessionLifecycle('session/disposed', session));
        bind(ctx, 'agent/status', (payload) => onAgentStatus(payload));
        // 一个都没订上：仍保持可用（recent 返回空数组），路由会照常回 ok:true
        if (!subscribed.length) {
            console.warn('[chubby-whale] nervous: 未订阅到任何宿主事件（收集器为空，/nervous 仍可用）');
        }
        return subscribed.slice();
    }
    function stop() {
        started = false;
        subscribed.length = 0;
        while (disposers.length) {
            const off = disposers.pop();
            try {
                if (off)
                    off();
            }
            catch (e) { }
        }
    }
    function status() {
        return { subscribed: subscribed.slice(), count: size, cap, lastAt };
    }
    return { start, stop, recent, status };
}
