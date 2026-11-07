/**
 * shared/remind-nl.ts —— 「说一句话就建提醒」的自然语言解析（纯函数，宿主与测试共用）
 *
 * 为什么要有它（2026-11-07 用户实测发现）：
 *   主人对鱼说「十分钟后提醒我吃早餐」，鱼回了一句「好，十分钟后提醒主人吃早餐」，
 *   但 `~/.dsh-chubby-whale/reminders.json` 根本不存在 —— 提醒一条都没建，永远不会响，
 *   简报的「待办」段也就没有它。查遍 chat 链路（client/intent.ts、shared/noise.ts、
 *   routes/chat.ts、chat-core.ts）没有任何「提醒意图」识别：鱼只会顺着话答应，没有排程能力。
 *   这个文件补的就是那一步：把「提醒我 + 时间 + 任务」解析成可落库的提醒。
 *
 * 设计原则（宁可漏，不可错）：
 *   · **必须有明确时间**才建（没时间 → null，行为与以前一致，不乱建）；
 *   · 必须出现「提醒我 / 提醒主人 / 记得提醒」这类第一人称祈使，且排除「他提醒我」这种转述；
 *   · 最多解析一次（一条消息只建一条提醒），解析不出就如实不建；
 *   · 纯函数：不读文件、不看系统时区以外的状态，`nowMs` 由调用方传入，便于离线测试。
 *
 * 支持的说法（保守清单，够用且不易误判）：
 *   · 相对：`N分钟后` / `N小时后` / `N秒后` / `半小时后` / `一个半小时后`
 *   · 绝对：`今天/今晚/今早/明天/明早/明晚 + N点[M分]`、单独的 `N点[M分]`（已过则算明天）
 *   · 重复：句子里有「每天」→ repeat=86400，首响取最近一次该时刻
 *   任务正文 = 去掉时间短语与提醒词之后剩下的部分；去掉后为空则不建（避免建出「提醒：提醒」）。
 */
/** 任务正文上限：与 routes/reminders.ts、备份导入的 reminderTextLen 同口径 */
const TASK_MAX = 200;
/** 绝对时刻的合法边界：1970 之后、2100 之前（防止解析出离谱年份） */
const MIN_MS = 0;
const MAX_MS = 4102444800000; // 2100-01-01T00:00:00Z
/** 中文数字（只收常用个位与十几，够日常说法） */
const CN_NUM = {
    零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};
function numOf(raw) {
    const s = String(raw || '').trim();
    if (!s)
        return null;
    if (/^\d+$/.test(s))
        return Number(s);
    if (s === '半')
        return 0.5;
    if (/^十[一二三四五六七八九]$/.test(s))
        return 10 + CN_NUM[s.slice(1)];
    if (s.length === 1 && Object.prototype.hasOwnProperty.call(CN_NUM, s))
        return CN_NUM[s];
    return null;
}
/** 把句子里的一段原文抠掉（保留其余正文） */
function stripText(text, piece) {
    if (!piece)
        return text;
    return text.split(piece).join(' ');
}
function clipTask(raw) {
    let s = String(raw || '')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/[，。！？、；：「」『』（）()【】\s]+/g, ' ')
        .trim();
    // 去掉残留的提醒词与语气词
    s = s
        .replace(/^(?:请|麻烦|帮我|给我|记得|一定要|要)+/g, '')
        .replace(/(?:吧|呀|啊|哦|喔|啦|好吗|行吗|可以吗)$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!s)
        return '';
    const chars = Array.from(s);
    return chars.length > TASK_MAX ? chars.slice(0, TASK_MAX).join('') : s;
}
/** 本地时区的某天 0 点 */
function startOfDayLocal(ms) {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
/** 校准到「本地 h:m」，basisMs 决定哪一天 */
function atLocalDay(basisMs, hour, minute) {
    if (!Number.isFinite(hour) || !Number.isFinite(minute))
        return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59)
        return null;
    const d = new Date(basisMs);
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0, 0).getTime();
    return Number.isFinite(t) ? t : null;
}
function isPast(ms, now) {
    return !Number.isFinite(ms) || ms <= now;
}
/**
 * 解析一条「提醒我」的祈使句。
 * @returns 命中返回 {task, at, repeat}；没有明确时间 / 不是第一人称祈使 / 任务为空 → null
 */
export function parseReminderIntent(text, nowMs) {
    const raw = typeof text === 'string' ? text.trim() : '';
    if (!raw || raw.length > 500)
        return null;
    const now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now();
    // 1) 必须是第一人称提醒祈使；排除「他/她/老师…提醒我」这类转述
    if (!/(提醒我|提醒主人|记得提醒)/.test(raw))
        return null;
    if (/(他|她|别人|老师|妈妈|爸爸|朋友|同学|同事|医生)[^。！？\s]{0,6}提醒我/.test(raw))
        return null;
    const repeat = /每天|每天|天天|每日/.test(raw) ? 86400 : 0;
    let rest = raw;
    let targetMs = null;
    // 2) 相对时间：半小时后 / 一个半小时后 / N分钟后 / N小时后 / N秒后
    // 「一个半小时后」= 1.5 小时：把「半」放在小时前或后都认（旧正则只认「半小时后」，会把「一个」留在正文里）
    const rel1 = /(?:(\d{1,3}|[一二两三四五六七八九十]{1,2}|半)\s*个?\s*(半)?\s*个?\s*(?:小时|钟头)\s*(?:之|以)?后)/.exec(rest);
    const rel2 = /(?:(\d{1,3}|[一二两三四五六七八九十]{1,2}|半)\s*个?\s*(?:分钟|分)\s*(?:之|以)?后)/.exec(rest);
    const rel3 = /(?:(\d{1,3})\s*(?:秒钟|秒)\s*(?:之|以)?后)/.exec(rest);
    if (rel1) {
        const n = numOf(rel1[1]);
        if (n !== null && n > 0 && Number.isFinite(n)) {
            // 「半」单独出现（半小时后）算 0.5；「一个半小时」= 1 + 0.5
            const half = rel1[2] ? 0.5 : (n === 0.5 ? 0 : 0);
            const hours = (n === 0.5 ? 0.5 : n + half);
            const ms = Math.round(hours * 3600_000);
            if (ms > 0) {
                targetMs = now + ms;
                rest = stripText(rest, rel1[0]);
            }
        }
    }
    if (targetMs === null && rel2) {
        const n = numOf(rel2[1]);
        if (n !== null && n > 0) {
            targetMs = now + Math.round(n * 60_000);
            rest = stripText(rest, rel2[0]);
        }
    }
    if (targetMs === null && rel3) {
        const n = numOf(rel3[1]);
        if (n !== null && n > 0) {
            targetMs = now + Math.round(n * 1000);
            rest = stripText(rest, rel3[0]);
        }
    }
    // 3) 绝对时间：「明天/今晚/今早/明早/明晚 + N点[M分]」或单独的「N点[M分]」
    if (targetMs === null) {
        const dayWord = /(明天|明日|今晚|今早|今天|明早|明晚|明儿)/.exec(rest);
        const clock = /(\d{1,2}|[一二两三四五六七八九十]{1,2})\s*[点時时]\s*(半|\d{1,2}|[一二三四五六七八九十]{1,2})?\s*分?/.exec(rest);
        if (clock) {
            const hour = numOf(clock[1]);
            let minute = 0;
            if (clock[2]) {
                const mv = numOf(clock[2]);
                if (mv === 0.5)
                    minute = 30;
                else if (mv !== null)
                    minute = mv;
            }
            if (hour !== null && hour >= 0 && hour <= 23) {
                // 12 小时制的口语：晚上 7 点 → 19 点；早上 9 点 → 9 点
                let h = Math.floor(hour);
                const pm = /(晚上|今晚|明晚|下午|傍晚)/.test(rest);
                const am = /(早上|今早|明早|凌晨|上午)/.test(rest);
                if (pm && h < 12)
                    h += 12;
                if (am && h === 12)
                    h = 0;
                let baseDay = startOfDayLocal(now);
                if (dayWord) {
                    const w = dayWord[1];
                    if (w === '明天' || w === '明日' || w === '明早' || w === '明晚' || w === '明儿')
                        baseDay += 86400_000;
                }
                let t = atLocalDay(baseDay, h, minute);
                if (t !== null) {
                    // 没写「明天」且时间已过 → 顺延到明天（避免建一条永远不响的过去提醒）
                    if (!dayWord && isPast(t, now))
                        t = atLocalDay(baseDay + 86400_000, h, minute);
                    targetMs = t;
                    rest = stripText(rest, clock[0]);
                    if (dayWord)
                        rest = stripText(rest, dayWord[0]);
                }
            }
        }
    }
    if (targetMs === null || !Number.isFinite(targetMs))
        return null;
    if (targetMs <= MIN_MS || targetMs > MAX_MS)
        return null;
    // 相对时间算出「过去」是不可能的（上面已保证 >0），但重复提醒的绝对时间可能已过 → 已在上面顺延
    if (isPast(targetMs, now) && repeat === 0)
        return null;
    // 4) 任务正文：去掉提醒词与残余时间词
    let task = rest
        .replace(/提醒我|提醒主人|记得提醒|提醒一下|提醒/g, ' ')
        .replace(/每天|天天|每日/g, ' ')
        .replace(/明天|明日|今晚|今早|今天|明早|明晚|明儿|早上|上午|中午|下午|晚上|傍晚|凌晨/g, ' ')
        .replace(/\bs*个?(?:小时|钟头|分钟|分|秒)\s*(?:之|以)?后/g, ' ')
        .replace(/[点時时]\s*(?:半|\d{1,2})?\s*分?/g, ' ')
        .replace(/(?:一个|两个|三个|\d+\s*个)\s*(?=收|看|吃|喝|去|做|开|关|拿|洗|买)/g, ' ');
    task = clipTask(task);
    if (!task)
        return null;
    return {
        task,
        at: new Date(targetMs).toISOString(),
        repeat,
    };
}
