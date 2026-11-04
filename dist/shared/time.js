/**
 * shared/time.ts —— 提醒口语时间解析（照 C# Reminders.cs 的 ParseDue / CleanText）
 * 纯函数，浏览器端调用、Node 端可单元验证。
 * 支持：9点 / 9:30 / 9点半 / 今天9点 / 明天9点 / 后天9点 /
 *       上午9点 / 下午3点 / 中午12点 / 晚上8点 / 凌晨1点 /
 *       半小时后 / 20分钟后 / 一小时后 / 2小时后 / 2026-11-04 09:00 / 每天9点
 */
const DAY_MS = 86400000;
/**
 * 时段词 → 24 小时制（照汉语口语习惯）：
 *   下午 / 傍晚 / 晚上 → +12；下午12点 = 12:00，晚上12点 = 00:00（当天已过 → 顺延次日）
 *   中午 → 12 点方向：中午12点 = 12:00，中午1点 = 13:00，中午11点仍是 11:00
 *   凌晨 / 早上 / 上午 → 原值（上午9点 = 09:00）
 */
function applyPeriod(hour, word) {
    if (word === '下午')
        return hour === 12 ? 12 : (hour < 12 ? hour + 12 : hour);
    if (word === '傍晚' || word === '晚上')
        return hour === 12 ? 0 : (hour < 12 ? hour + 12 : hour);
    if (word === '中午')
        return hour < 10 ? hour + 12 : hour;
    return hour;
}
/** 去掉「提醒我 / 叫我 / 记得」这类前缀和首尾标点 */
export function cleanReminderText(raw) {
    let t = String(raw || '').trim();
    const leads = ['提醒我一下', '提醒一下', '提醒我', '提醒', '叫我一下', '叫我', '记得要', '记得', '到时候'];
    let changed = true;
    while (changed) {
        changed = false;
        for (const lead of leads) {
            if (t.startsWith(lead)) {
                t = t.slice(lead.length).trim();
                changed = true;
                break;
            }
        }
    }
    t = t.replace(/^[，,。.：:、\s]+/, '').replace(/[，,。.：:、\s]+$/, '');
    return t;
}
/**
 * 从一句话里解析提醒时间。解析不出返回 null。
 * @param now 当前时间（测试时可注入固定值）
 */
export function parseDue(raw, now = new Date()) {
    const src = String(raw || '').trim();
    if (!src)
        return null;
    const base = new Date(now.getTime());
    const daily = /每天|每日/.test(src);
    const done = (at, stripped) => ({
        at,
        repeat: daily ? 86400 : null,
        cleaned: cleanReminderText(stripped.replace(/每天|每日/g, '')),
    });
    // 1) 明确日期时间：2026-11-04 09:00 / 2026-11-04T09:00
    let m = src.match(/(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/);
    if (m) {
        const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
        if (!isNaN(dt.getTime()))
            return done(dt, src.replace(m[0], '').trim());
    }
    // 2) 相对时间：半小时后 / 20分钟后 / 一小时后 / 2小时后
    m = src.match(/半小时(?:后|以后)?/);
    if (m)
        return done(new Date(base.getTime() + 30 * 60000), src.replace(m[0], '').trim());
    m = src.match(/(\d+)\s*分钟(?:后|以后)?/);
    if (m) {
        const mins = Math.max(1, Math.min(24 * 60, Number(m[1]) || 1));
        return done(new Date(base.getTime() + mins * 60000), src.replace(m[0], '').trim());
    }
    m = src.match(/(一小时|1小时)(?:后|以后)?/);
    if (m)
        return done(new Date(base.getTime() + 60 * 60000), src.replace(m[0], '').trim());
    m = src.match(/(\d+)\s*小时(?:后|以后)?/);
    if (m) {
        const hours = Math.max(1, Math.min(24 * 7, Number(m[1]) || 1));
        return done(new Date(base.getTime() + hours * 3600000), src.replace(m[0], '').trim());
    }
    // 3) 时段词 + 今天/明天/后天 + 9点 / 9:30 / 9点半
    const day = src.match(/(今天|明天|后天)/);
    const clock = src.match(/(\d{1,2})\s*(?:点|:|：)\s*(半|\d{2})?/);
    if (clock) {
        const rawH = Number(clock[1]);
        if (Number.isFinite(rawH) && rawH >= 0 && rawH <= 23) {
            // 时段词必须紧挨在钟点前面（「明天下午3点」）；正文里的「晚上吃药」不参与换算
            const before = typeof clock.index === 'number' ? src.slice(0, clock.index) : '';
            const pm = before.match(/(凌晨|早上|上午|中午|下午|傍晚|晚上)[\s，,]*$/);
            const h = applyPeriod(rawH, pm ? pm[1] : '');
            let minute = 0;
            const mm = clock[2] || '';
            if (mm === '半')
                minute = 30;
            else if (mm)
                minute = Math.max(0, Math.min(59, Number(mm) || 0));
            const dayStart = new Date(base.getFullYear(), base.getMonth(), base.getDate());
            let target = new Date(dayStart.getTime());
            if (day) {
                if (day[1] === '明天')
                    target = new Date(dayStart.getTime() + DAY_MS);
                else if (day[1] === '后天')
                    target = new Date(dayStart.getTime() + 2 * DAY_MS);
            }
            target.setHours(h, minute, 0, 0);
            // 没说「今天/明天/后天」且时间已过 → 顺延到明天
            // （晚上12点 = 00:00 今天已过 → 次日 00:00，正是想要的行为）
            if (!day && target.getTime() <= base.getTime())
                target = new Date(target.getTime() + DAY_MS);
            let stripped = src.replace(clock[0], '').trim();
            // 时段词与钟点一起算时间，也从正文里一起删掉
            if (pm && typeof pm.index === 'number') {
                stripped = (stripped.slice(0, pm.index) + stripped.slice(pm.index + pm[1].length)).trim();
            }
            if (day)
                stripped = stripped.replace(day[1], '').trim();
            return done(target, stripped);
        }
    }
    return null;
}
/** 给气泡/清单用的友好时间文案 */
export function formatDue(at, repeatSeconds) {
    const d = new Date(at.getTime());
    const now = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    const prefix = repeatSeconds && repeatSeconds > 0 ? '每天 ' : (sameDay ? '今天 ' : '');
    return prefix + hh + ':' + mm;
}
