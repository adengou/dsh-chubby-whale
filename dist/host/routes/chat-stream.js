/**
 * host/routes/chat-stream.ts —— 流式聊天（SSE）
 *
 * 目的：让肥鲸"边生成边开口"。原来必须等整段回复生成完才合成语音，
 * 用户感觉"说完话要等一两秒"；流式之后模型吐第一个字就能开始念。
 *
 * 协议（服务端 → 客户端，一行一条）：
 *   data: {"delta":"文字片段"}
 *   data: {"done":true,"reply":"完整回复","cached":false}
 *   data: {"error":"原因"}            // 失败时；客户端据此回退到普通 /chat
 *
 * 建立 SSE 流之前就被拒的情况（不写 SSE 帧，直接 HTTP 413 JSON）：
 *   · 整包请求体 > 6MB：{"ok":false,"error":"too large"}
 *   · 单图 base64 > 4MB 字符（≈3MB 原图）：{"ok":false,"error":"image too large","reply":"…"}
 *   客户端对非 2xx 一律回退 /chat（见 src/client/chat.ts 的 tryStream），文案由 /chat 的 reply 给出。
 *
 * 缓存与记忆行为与普通 /chat 一致：
 *   · 请求解析、system 片段、messages 结构全部走 host/chat-core.ts（同一输入 → 同一请求体）；
 *   · 命中缓存：直接发一条 delta + done(cached:true)
 *   · 未命中：边转发边累积，结束时写缓存、写记忆、记 token；半截（中断/客户端断开）一律不落盘。
 *   · 客户端断连（B94）：req 'aborted' / req close(complete=false) / res close(响应没写完) 都算
 *     「客户端走了」——立刻 abort 上游、不写记忆不记账；正常结束的 res close（writableFinished）
 *     不算断连。判定与 /chat、/asr 共用 host/http.ts 的 watchClientGone 一份实现。
 *
 * 记账口径（2026-11-06 起与普通 /chat 一致）：
 *   · 成功回复：亲密度 +1、经验 +1（可升级）、appendTurns、token、onReply；
 *   · 完整回复第 10 次触发长期记忆摘要（写回前做代际校验，/clear-memory 后不复活旧记忆）；
 *   · 缓存命中：只加亲密度，不加经验、不写记忆、不 onReply；
 *   · 半截/中断/客户端断开：一律不落盘、不记账。
 * 依赖由 index.ts 装配注入（loadState/saveState/addExp/saveMemorySummary）；路由不绕过端口直连 store。
 *
 * 超时语义（2026-11-05 起）：
 *   · 30s 是**空闲超时**——每收到一段上游数据就重置，模型还在吐字就不算超时；
 *     （此前它被当成「整条请求的总时长」，慢模型讲到一半会被硬切）
 *   · 120s 是总时长硬上限，兜底防「上游一直有数据但永远不结束」；
 *   · 每 12s 写一行 `: ping` 注释帧保活，客户端解析器会跳过以 : 开头的行。
 *
 * 纯函数与其它路由共用 host/chat-core.ts，不再从 routes/chat.ts 横向 import。
 */
import { sendTooLarge, watchClientGone } from '../http.js';
import { readJsonBody } from '../body.js';
import { sendJson, sendSseHeaders } from '../respond.js';
import { estimateCostCny, readUsageSplit } from '../../shared/pricing.js';
import { DEFAULT_CHAT_MODEL } from '../config.js';
import { CHAT_URL, CHAT_CACHE_TTL, CHAT_MAX_TOKENS, chatCacheKey, chatContextFingerprint, readChatRequest, buildChatMessages, summarizeMemory, maybeCreateReminder, } from '../chat-core.js';
import { parseSseBuffer } from '../../shared/sse.js';
const CHAT_IDLE_TIMEOUT = 30 * 1000; // 空闲超时：连续这么久没有上游数据才中止
const CHAT_MAX_DURATION = 120 * 1000; // 总时长硬上限：不论有没有数据，到点就断
const SSE_PING_MS = 12 * 1000; // SSE 心跳间隔
const CHAT_MAX_BODY = 6 * 1024 * 1024;
/** 图片超限文案：与 host/routes/chat.ts 的同一句保持一致（路由之间不横向 import，各持一份） */
const IMAGE_TOO_LARGE_FALLBACK = '主人，这张图太大啦（原图超过约 3MB），本鲸一口吞不下，换张小一点的再发吧～';
/**
 * 客户端已经走了的日志标签（B94）：与上游超时/网络错误分开，排障时一眼能分清谁先放弃。
 * 分两条对应时机：外呼/读流途中断开（中止外呼）/ 还没发起外呼就断开（body 阶段断连）。
 */
const LOG_CLIENT_ABORT_OUTBOUND = '[chat-stream] CHAT-CLIENT-ABORT 客户端已断开，上游外呼已中止（不计入上游超时/网络失败）';
const LOG_CLIENT_ABORT_REQUEST = '[chat-stream] CHAT-CLIENT-ABORT 客户端已断开，请求中止（未发起外呼）';
export function createChatStreamHandler(opts) {
    // 与普通 /chat 共用同一个装配值（index.ts 的 readChatModel），缓存 key 也带它
    const model = opts.model || DEFAULT_CHAT_MODEL;
    /**
     * 「每 10 次聊天压缩一次长期记忆」的计数器：与普通 /chat 一样**每个 handler 一份**。
     * 原来放在模块级，等于全进程共享——同一个模块建两个 handler（测试、双插件实例）时，
     * 第二个实例的成功请求会替第一个实例凑数，摘要提前触发（scripts/test-chat-routes.mjs 用例 B 复现）。
     */
    let summaryCount = 0;
    return async function handleChatStream(req, res) {
        // SSE 头：立刻发出，避免客户端等到第一个 token 才开始
        const started = Date.now();
        const send = (obj) => {
            try {
                res.write('data: ' + JSON.stringify(obj) + '\n\n');
            }
            catch { }
        };
        // 超时与保活状态放在函数级：任何退出路径（缓存命中/无 Key/连接失败/正常结束/抛错）
        // 都要能在最后的 finally 里清干净，否则定时器会一直挂在事件循环上。
        let pingTimer = null;
        let idleTimer = null;
        let totalTimer = null;
        let ctl = null;
        let abortReason = '';
        /** 上游已读完（收尾阶段）：这之后客户端断开不该再 abort（也没有可 abort 的东西了） */
        let finished = false;
        const stopPing = () => {
            if (pingTimer) {
                try {
                    clearInterval(pingTimer);
                }
                catch { }
                ;
                pingTimer = null;
            }
        };
        const clearTimers = () => {
            if (idleTimer) {
                try {
                    clearTimeout(idleTimer);
                }
                catch { }
                ;
                idleTimer = null;
            }
            if (totalTimer) {
                try {
                    clearTimeout(totalTimer);
                }
                catch { }
                ;
                totalTimer = null;
            }
        };
        /** 空闲/总时长谁先到都走同一个 AbortController；只记第一次的原因，便于日志定位 */
        const abortUpstream = (why) => {
            if (abortReason)
                return;
            abortReason = why;
            try {
                if (ctl)
                    ctl.abort();
            }
            catch { }
        };
        /** 收到上游数据就重置空闲计时：优先 timer.refresh()，老运行时退回「清旧建新」 */
        const touchIdle = () => {
            if (!ctl || (ctl.signal && ctl.signal.aborted))
                return;
            if (idleTimer && typeof idleTimer.refresh === 'function') {
                try {
                    idleTimer.refresh();
                    return;
                }
                catch { }
            }
            if (idleTimer) {
                try {
                    clearTimeout(idleTimer);
                }
                catch { }
            }
            idleTimer = setTimeout(() => abortUpstream('idle timeout ' + CHAT_IDLE_TIMEOUT + 'ms'), CHAT_IDLE_TIMEOUT);
        };
        /**
         * 断连观察器（B94，与 /asr、/chat 共用 host/http.ts 的同一套判定）：
         * 覆盖 req 'aborted' / req close(complete=false) / res close(响应没写完) 三种真实断连形状，
         * 正常结束的 res close（writableFinished=true）不会命中 —— 基线只看 res close 时，
         * 客户端在**上传 body 阶段**断开会漏掉（req 侧没人听）。
         * 客户端一走就 abort 上游：没有读者的流继续读到 30s 空闲/120s 硬上限，等于白烧 token；
         * 收尾阶段（上游已读完）不再 abort。
         */
        const client = watchClientGone(req, res, () => { if (!finished)
            abortUpstream('client closed'); });
        try {
            const parsed = await readJsonBody(req, CHAT_MAX_BODY);
            if (!parsed.ok) {
                sendTooLarge(res);
                return;
            }
            const body = parsed.body;
            // 请求解析统一走 chat-core：与普通 /chat 同一套截断/lang/voice 口径
            const reqInfo = readChatRequest(body);
            const message = reqInfo.message;
            const lang = reqInfo.lang;
            const isVoice = reqInfo.isVoice;
            const image = reqInfo.image;
            // 用 trim 判空：只发空格/换行不该白调一次模型
            if (!message.trim()) {
                res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
                send({ error: 'empty message' });
                res.end();
                return;
            }
            // 图片体积兜底（与 /chat 同一上限、同一状态码、同一句文案）：必须排在 sendSseHeaders 之前，
            // 否则 200 SSE 头已经发出去，客户端只能看到一条 error 帧，拿不到「请求被拒」的语义。
            if (reqInfo.imageTooLarge) {
                console.error('[chat-stream] IMAGE-TOO-LARGE b64=' + image.b64.length);
                sendJson(res, { ok: false, error: 'image too large', reply: IMAGE_TOO_LARGE_FALLBACK }, 413);
                return;
            }
            // 与 /chat 同口径：流式路径也要把「提醒我」落成提醒（B106）
            try {
                maybeCreateReminder(opts.addReminder, message, Date.now());
            }
            catch (err) {
                console.error('[chat-stream] REMINDER-CREATE-FAIL ' + String((err && err.message) || err));
            }
            sendSseHeaders(res);
            // 立刻把 SSE 头刷出去，客户端不必等首帧（断连监听已由上面的 watchClientGone 挂好）
            try {
                res.flushHeaders && res.flushHeaders();
            }
            catch { }
            // SSE 心跳：浏览器/反向代理会掐掉长时间没有数据的连接（豆包/nginx 一类默认 60s 左右），
            // 每 12s 写一行注释帧（以 : 开头，客户端解析器直接跳过）既保活又不污染事件流。
            // 正常结束/出错统一由 finally 里的 stopPing 清掉，不会残留定时器。
            pingTimer = setInterval(() => {
                try {
                    if (res.writableEnded)
                        return;
                    res.write(': ping\n\n');
                }
                catch { }
            }, SSE_PING_MS);
            // 心跳不该阻止进程退出（unref 只是在事件循环里「不计入活跃句柄」）
            try {
                if (pingTimer && typeof pingTimer.unref === 'function')
                    pingTimer.unref();
            }
            catch { }
            // 先读上下文：缓存 key 带上下文指纹；prompt 只带最近几条（省 token）
            const memSummary = (() => { try {
                return String(opts.loadMemorySummary ? opts.loadMemorySummary() : '');
            }
            catch {
                return '';
            } })();
            let history = [];
            try {
                history = opts.loadHistory() || [];
            }
            catch {
                history = [];
            }
            const cacheOn = !opts.cacheEnabled || opts.cacheEnabled() !== false;
            // 模型名进 key：换模型后旧缓存自动失效（与普通 /chat 一致）
            const cacheKey = chatCacheKey(lang, message, isVoice, chatContextFingerprint(memSummary, history), model);
            // 与普通 /chat 一致：太短的消息不缓存；带图的消息也不缓存（缓存 key 里没有图片内容）
            const cacheUsable = reqInfo.cacheable && !image.b64;
            if (opts.cache && cacheOn && cacheUsable) {
                try {
                    const hit = await opts.cache.getJson(cacheKey, 'json', CHAT_CACHE_TTL);
                    // 判空口径与 /chat 一致（cached.reply.trim().length > 0）：缓存里若是一条纯空白回复，
                    // 流式原来会当成命中，回一句「   」并把这一轮的记账全跳过（/chat 会正常走模型）。
                    if (hit && typeof hit.reply === 'string' && hit.reply.trim().length > 0) {
                        // 缓存命中与 /chat 同口径：只加亲密度，不加经验、不写记忆、不 onReply
                        let cachedIntimacy = 0;
                        try {
                            if (opts.loadState && opts.saveState) {
                                const st0 = opts.loadState();
                                st0.intimacy = Math.min(100, (Number(st0.intimacy) || 0) + 1);
                                opts.saveState(st0);
                                cachedIntimacy = Number(st0.intimacy) || 0;
                            }
                        }
                        catch { }
                        send({ delta: hit.reply });
                        send({ done: true, reply: hit.reply, cached: true, intimacy: cachedIntimacy, ms: Date.now() - started });
                        res.end();
                        return;
                    }
                }
                catch { }
            }
            const key = opts.getKey();
            if (!key) {
                // 只发 error 帧、不带兜底文案：error 帧的协议语义就是「本路径失败」。
                // 回退链（src/client/chat.ts）：收到 error 帧即 throw → 未念过任何字时 tryStream 返回 false
                // → send() 继续走普通 /chat，那里的 NO_KEY 回包带 reply 文案，由客户端展示/朗读。
                // 补一条 reply 字段不破坏兼容（加字段不改已有字段），但既然回退链成立就没必要改协议。
                send({ error: 'NO_KEY' });
                res.end();
                return;
            }
            // 与普通 /chat 同一份 system 片段与消息结构（语言规则 → 长期记忆 → 语音说明，有图走多模态）
            const messages = buildChatMessages({
                systemPrompt: opts.systemPrompt,
                lang,
                memSummary,
                isVoice,
                history,
                message,
                image,
            });
            // 超时从「准备发上游请求」这一刻才开始：读请求体、查缓存慢，不该算进模型响应时间
            ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
            if (ctl) {
                totalTimer = setTimeout(() => abortUpstream('total timeout ' + CHAT_MAX_DURATION + 'ms'), CHAT_MAX_DURATION);
                touchIdle();
            }
            // 客户端在发起外呼之前就走了（读完 body 就断开/切页）：把中止补到刚建好的 controller 上。
            // fetch 拿到的是已中止的 signal，真实网络请求不会真的打出去；日志由下面的 connect 分支统一出。
            if (client.gone() && ctl && !ctl.signal.aborted) {
                try {
                    ctl.abort();
                }
                catch { }
            }
            let upstream = null;
            try {
                upstream = await fetch(CHAT_URL, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
                    body: JSON.stringify({
                        model,
                        messages,
                        max_tokens: CHAT_MAX_TOKENS,
                        temperature: 0.8,
                        thinking: { type: 'disabled' },
                        stream: true,
                        stream_options: { include_usage: true },
                    }),
                    signal: ctl ? ctl.signal : undefined,
                });
            }
            catch (err) {
                // 客户端先走了：这次外呼是我们自己 abort 的（不是上游超时/网络故障），断开后也没人收帧
                if (client.gone()) {
                    console.error(LOG_CLIENT_ABORT_OUTBOUND);
                    try {
                        res.end();
                    }
                    catch { }
                    return;
                }
                // 空闲/总时长中止时抛的是 AbortError，消息没用，用我们记下的原因
                send({ error: 'connect: ' + (abortReason || String(err?.message || err)) });
                res.end();
                return;
            }
            if (!upstream.ok || !upstream.body) {
                send({ error: 'HTTP ' + upstream.status });
                res.end();
                return;
            }
            // 响应头已到：接下来按「两段数据之间的间隔」算空闲
            touchIdle();
            let aborted = false;
            /** 上游是否已经读到 done（= 这份回复是完整的）。半截与完整的判定只看它，不看客户端在不在。 */
            let sawDone = false;
            const reader = upstream.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            let reply = '';
            let usage = null;
            let firstDeltaAt = 0;
            /**
             * 消费一批已解析的 SSE 帧。
             * 正文优先；choices[0].delta.content 为空时取 reasoning_content 回退（新模型若忽略
             * thinking:{type:'disabled'} 会只吐 reasoning_content，不补这条用户看到的就是空回复）。
             * 抽成函数是因为流结束后还要对残留尾巴再消费一次（见下面的收尾 flush）。
             */
            const consume = (events) => {
                for (const j of events) {
                    const d = j?.choices?.[0]?.delta;
                    let piece = '';
                    if (typeof d?.content === 'string' && d.content)
                        piece = d.content;
                    else if (typeof d?.reasoning_content === 'string' && d.reasoning_content)
                        piece = d.reasoning_content;
                    if (piece) {
                        if (!firstDeltaAt)
                            firstDeltaAt = Date.now();
                        reply += piece;
                        send({ delta: piece });
                    }
                    if (j?.usage)
                        usage = j.usage;
                }
            };
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) {
                        sawDone = true;
                        break;
                    }
                    touchIdle(); // 每收到一段就重置空闲计时：又慢又长的回复不会再被 30s 硬切
                    buf += dec.decode(value, { stream: true });
                    const parsedSse = parseSseBuffer(buf);
                    buf = parsedSse.rest;
                    consume(parsedSse.events);
                }
                // 收尾 flush：parseSseBuffer 只认「以换行结尾」的行，上游若在最后一个 data 行后直接断连接
                // （没有行尾换行），整帧会原样留在 rest 里。不补这一刀的话，最后一段正文与 usage 帧被静默丢弃，
                // 半截回复还会被当成完整回复：实测整条回复变成「主人……本鲸刚刚走神了。」并写进长期记忆。
                buf += dec.decode(); // 冲掉分块边界上残留的多字节字符
                if (buf.trim()) {
                    consume(parseSseBuffer(buf + '\n').events);
                    buf = '';
                }
            }
            catch (err) {
                aborted = true;
                // 客户端先走了：这是我们自己 abort 的，不是上游故障；连接已断，也别再往死 socket 上写 error 帧
                if (client.gone())
                    console.error(LOG_CLIENT_ABORT_OUTBOUND);
                else
                    send({ error: 'stream: ' + (abortReason || String(err?.message || err)) });
            }
            finally {
                // 流已结束（正常或异常），超时定时器再留着只会误伤后续收尾
                clearTimers();
            }
            // 上游已读完：后面的收尾与客户端断开无关，close 事件不再 abort
            finished = true;
            // 半截 = 上游没读完（read 抛错、空闲/总时长超时、被我们 abort 都落在这里）：
            // 半截回复绝不能写进缓存和记忆（否则被永久命中），也不记 token —— 没有最终 usage，估算只会虚记。
            if (!sawDone) {
                if (client.gone())
                    console.error('[chat-stream] CHAT-CLIENT-ABORT 客户端已断开且上游未读完：本轮不写缓存/记忆、不记 token、不加经验');
                try {
                    res.end();
                }
                catch { }
                return;
            }
            // 走到这里说明**上游已经读完**（这份回复是完整的）。客户端可能在最后几帧才走 —— 那和 /chat 的
            // 「完整回复照常记账」同一口径（已付费的回复不该因为回不去就丢掉）；只留一条诊断便于排障。
            if (aborted || client.gone()) {
                console.error('[chat-stream] CHAT-CLIENT-ABORT-DELIVERED 客户端已断开但上游已读完：照常记账（不写 done 帧）');
            }
            const text = reply.trim() || '主人……本鲸刚刚走神了。';
            // 收尾：token / 记忆 / done（与普通 /chat 同口径）
            // token 口径：
            //   · 请求体已带 stream_options.include_usage，usage 在 [DONE] 之前的最后一帧里给，拿到就记；
            //   · 中断（空闲/总时长超时、客户端断开、上游异常）在上面的 aborted / client.gone() 分支已 return，
            //     不计 token —— 半截流没有最终 usage，估算只会虚记，宁可漏记；
            //   · 上游不回 usage（部分兼容服务不实现）时同样跳过，不猜。
            try {
                const u = usage;
                if (u && typeof u.total_tokens === 'number' && opts.addTokens) {
                    // 与 /chat 同口径：有拆分就带金额，没拆分只记总量
                    const split = readUsageSplit(u);
                    const cost = split ? estimateCostCny(split, opts.model) : null;
                    opts.addTokens('chat', u.total_tokens, split
                        ? { promptTokens: split.promptTokens, completionTokens: split.completionTokens, cacheHitTokens: split.cacheHitTokens, costCny: cost ? cost.cny : undefined }
                        : undefined);
                }
            }
            catch { }
            try {
                if (typeof opts.appendTurns === 'function')
                    opts.appendTurns(message, text);
                else
                    console.error('[chat-stream] MEMORY-APPEND-MISSING 没有 appendTurns，跳过记忆写入');
            }
            catch (err) {
                console.error('[chat-stream] MEMORY-APPEND-ERR ' + String(err?.message || err));
            }
            // 亲密度 +1（与 /chat 同口径）
            let intimacy = 0;
            try {
                if (opts.loadState && opts.saveState) {
                    const st0 = opts.loadState();
                    st0.intimacy = Math.min(100, (Number(st0.intimacy) || 0) + 1);
                    opts.saveState(st0);
                    intimacy = Number(st0.intimacy) || 0;
                }
            }
            catch { }
            // 成长 +1（来源 chat，受日上限/来源上限约束）
            // 空回复仍计 1 次经验/L2：与 /chat 同口径（审计确认是取舍；跳过属行为变更，未改）
            let upgraded = false;
            try {
                if (opts.addExp) {
                    const g = opts.addExp(1, 'chat');
                    upgraded = Boolean(g && g.upgraded);
                }
            }
            catch { }
            // 每 10 次聊天压缩一次长期记忆（与 /chat 同口径：取最近 14 条 + 本轮）
            summaryCount = (summaryCount + 1) % 10;
            const wantSummary = summaryCount === 0 && Array.isArray(history) && history.length >= 6 && Boolean(opts.saveMemorySummary);
            let sumConvo = '';
            if (wantSummary) {
                try {
                    const lines = history.slice(-14).map((m) => (m.role === 'user' ? '主人' : '肥鲸') + '：' + String(m.content || ''));
                    lines.push('主人：' + message);
                    lines.push('肥鲸：' + text);
                    sumConvo = lines.join('\n');
                }
                catch { }
            }
            // 客户端已走就别再往死 socket 写 done 帧（记账照做，回包跳过）
            if (!client.gone()) {
                send({ done: true, reply: text, cached: false, intimacy, upgraded, firstDeltaMs: firstDeltaAt ? firstDeltaAt - started : 0, ms: Date.now() - started });
                res.end();
            }
            // 缓存落盘放在 done/res.end 之后：cache.setJson 内部要 await 磁盘写 + prune 扫描，
            // 放在收尾前会把客户端看到的「说完」推迟。内存条目在 setJson 开头就同步写入，命中率不受影响。
            if (opts.cache && cacheOn && cacheUsable && reply.trim()) {
                try {
                    await opts.cache.setJson(cacheKey, { reply: text }, 'json', CHAT_CACHE_TTL);
                }
                catch { }
            }
            // L2 可变人格：完整回复收尾后才计数（中断/客户端断开/缓存命中都不算），不 await
            try {
                if (opts.onReply)
                    opts.onReply();
            }
            catch { }
            // 长期记忆摘要（与 /chat 同口径，每 10 次）：后台跑不 await；写回前做代际校验
            if (wantSummary && opts.saveMemorySummary && sumConvo) {
                try {
                    const saveSummary = opts.saveMemorySummary;
                    const historyAtReply = (() => { try {
                        return opts.loadHistory().length;
                    }
                    catch {
                        return 0;
                    } })();
                    const summaryAtReply = memSummary;
                    void summarizeMemory(key, sumConvo, memSummary || '（无）', (s2) => {
                        try {
                            const nowHistory = opts.loadHistory();
                            if (Array.isArray(nowHistory) && nowHistory.length < historyAtReply) {
                                console.error('[chat-stream] SUMMARY-SKIP 记忆已被清空');
                                return;
                            }
                        }
                        catch { }
                        try {
                            const nowSummary = String(opts.loadMemorySummary ? opts.loadMemorySummary() || '' : '');
                            if (nowSummary !== summaryAtReply) {
                                console.error('[chat-stream] SUMMARY-SKIP 摘要已被改写');
                                return;
                            }
                        }
                        catch { }
                        saveSummary(s2);
                    }, model, opts.addTokens);
                }
                catch { }
            }
        }
        catch (err) {
            try {
                // 请求体都没收完客户端就断了（req 'aborted' / ECONNRESET）：不算内部错误，也不往死连接写 error 帧
                if (client.gone())
                    console.error(LOG_CLIENT_ABORT_REQUEST);
                else
                    send({ error: String(err?.message || err) });
                res.end();
            }
            catch { }
        }
        finally {
            // 所有退出路径统一收口：心跳 interval、两个超时定时器、req/res 上的断连监听，一个都不许残留
            clearTimers();
            stopPing();
            client.dispose();
        }
    };
}
