/**
 * host/store.ts —— 持久化存储（可复用模块）
 * 记忆（memory.json）、状态（state.json）、说书进度（story_progress.json）、
 * 成长（growth.json）、鱼粮（fishfood.json）、提醒（reminders.json）、宠物状态（pet_state.json）
 * 写盘一律「写 .tmp → fsync → rename」原子替换；读坏文件先备份成 .bad-<时间戳> 再走默认值
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync, existsSync } from 'node:fs';
import { join } from 'node:path';
export const GROWTH_STAGES = [
    { exp: 0, name: '初识' },
    { exp: 200, name: '熟悉' },
    { exp: 800, name: '亲密' },
    { exp: 2500, name: '知心' },
    { exp: 5000, name: '家人' },
];
/** 每天最多涨 12 点经验（照 C# Growth.DailyCap） */
export const EXP_DAILY_CAP = 12;
/** 各来源的每日上限（照 C# Growth.SourceCap；未知来源按 3） */
export const EXP_SOURCE_CAP = { chat: 5, praise: 6, feed: 6, story: 4, company: 6 };
export const EXP_SOURCE_DEFAULT_CAP = 3;
export function growthStage(exp) {
    let idx = 0;
    for (let i = 0; i < GROWTH_STAGES.length; i++) {
        if (exp >= GROWTH_STAGES[i].exp)
            idx = i;
    }
    const next = idx + 1 < GROWTH_STAGES.length ? GROWTH_STAGES[idx + 1].exp : 0;
    return { index: idx, name: GROWTH_STAGES[idx].name, nextExp: next };
}
/** 今天（本地时区）的 'YYYY-MM-DD'，跨天判断用 */
function todayKey() {
    const d = new Date();
    const p = (n) => (n < 10 ? '0' + n : String(n));
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
export function createStore(dataDir) {
    const MEMORY = join(dataDir, 'memory.json');
    const STATE = join(dataDir, 'state.json');
    const STORY_PROGRESS = join(dataDir, 'story_progress.json');
    const GROWTH = join(dataDir, 'growth.json');
    const FISHFOOD = join(dataDir, 'fishfood.json');
    const REMINDERS = join(dataDir, 'reminders.json');
    const PET = join(dataDir, 'pet_state.json');
    const MEMORY_LIMIT = 40;
    function ensure() {
        try {
            mkdirSync(dataDir, { recursive: true });
        }
        catch { }
    }
    /** 原子写 JSON：写 file.tmp → fsync → rename 覆盖（Windows 的 rename 可以覆盖已存在文件） */
    function writeJsonAtomic(file, obj) {
        ensure();
        const tmp = file + '.tmp';
        const text = JSON.stringify(obj);
        const fd = openSync(tmp, 'w');
        try {
            writeFileSync(fd, text, 'utf8');
            try {
                fsyncSync(fd);
            }
            catch { } // 个别文件系统不支持 fsync，失败不当错误
        }
        finally {
            try {
                closeSync(fd);
            }
            catch { }
        }
        try {
            renameSync(tmp, file);
        }
        catch (err) {
            try {
                unlinkSync(tmp);
            }
            catch { } // 改名失败别留垃圾
            throw err;
        }
    }
    /** 文件不存在（首次运行）不算坏文件 */
    function isMissing(err) {
        return Boolean(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'));
    }
    /**
     * 读坏了：记日志 + 把坏文件改名成 file.bad-<时间戳> 备份，然后调用方走默认值。
     * 只备份一次——改完名下次读就是 ENOENT，不会再重复备份。
     */
    function quarantine(file, err) {
        console.error('[store] 读取失败 file=' + file + ' err=' + String((err && err.message) || err));
        try {
            if (!existsSync(file))
                return;
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const bad = file + '.bad-' + stamp;
            renameSync(file, bad);
            console.error('[store] 坏文件已备份 ' + file + ' → ' + bad);
        }
        catch (err2) {
            console.error('[store] 坏文件备份失败 file=' + file + ' err=' + String((err2 && err2.message) || err2));
        }
    }
    // ===== 聊天记忆（history + summary，照 C# 版） =====
    function loadMemoryObj() {
        try {
            const obj = JSON.parse(readFileSync(MEMORY, 'utf8'));
            if (Array.isArray(obj))
                return { history: obj, summary: '' };
            if (obj && typeof obj === "object") {
                return { history: Array.isArray(obj.history) ? obj.history : [], summary: String(obj.summary || '') };
            }
        }
        catch (err) {
            if (!isMissing(err))
                quarantine(MEMORY, err);
        }
        return { history: [], summary: '' };
    }
    function saveMemoryObj(obj) {
        try {
            writeJsonAtomic(MEMORY, { history: (obj.history || []).slice(-MEMORY_LIMIT), summary: String(obj.summary || ''), savedAt: new Date().toISOString() });
        }
        catch { }
    }
    /**
     * 追加一轮对话（主人一句 + 肥鲸一句）。
     * 读 → push → 写 全在同一个同步段里，中间没有 await，并发请求不会互相覆盖，也不会把 /clear-memory 之前的旧记忆写回。
     */
    function appendTurns(userText, replyText) {
        const m = loadMemoryObj();
        const h = Array.isArray(m.history) ? m.history : [];
        h.push({ role: 'user', content: String(userText || '') });
        h.push({ role: 'assistant', content: String(replyText || '') });
        m.history = h.slice(-MEMORY_LIMIT);
        saveMemoryObj(m);
        return m.history.length;
    }
    function loadHistory() { return loadMemoryObj().history; }
    function saveHistory(arr) { const m = loadMemoryObj(); m.history = arr; saveMemoryObj(m); }
    // 兼容层：index.ts 本批不在改动范围（仍在传 saveHistory），把原子追加挂在 saveHistory 上；
    // chat.ts 优先取 opts.appendTurns、取不到再取 saveHistory.appendTurns，不改 index.ts 也能修好并发丢写
    const saveHistoryCompat = saveHistory;
    saveHistoryCompat.appendTurns = appendTurns;
    function loadMemorySummary() { return loadMemoryObj().summary; }
    function saveMemorySummary(s) { const m = loadMemoryObj(); m.summary = String(s || ""); saveMemoryObj(m); }
    function clearMemory() {
        try {
            writeJsonAtomic(MEMORY, { history: [], summary: '', savedAt: new Date().toISOString() });
        }
        catch { }
    }
    // ===== 状态（亲密度） =====
    function loadState() {
        try {
            const obj = JSON.parse(readFileSync(STATE, 'utf8'));
            if (obj && typeof obj === 'object')
                return obj;
        }
        catch (err) {
            if (!isMissing(err))
                quarantine(STATE, err);
        }
        return { intimacy: 0 };
    }
    function saveState(obj) {
        try {
            writeJsonAtomic(STATE, obj);
        }
        catch { }
    }
    // ===== 说书进度 =====
    function loadStoryProgress() {
        try {
            return JSON.parse(readFileSync(STORY_PROGRESS, 'utf8'));
        }
        catch (err) {
            if (!isMissing(err))
                quarantine(STORY_PROGRESS, err);
            return {};
        }
    }
    function saveStoryProgress(obj) {
        try {
            writeJsonAtomic(STORY_PROGRESS, obj);
        }
        catch { }
    }
    // ===== 成长 =====
    /** 读成长数据；老文件缺 dayKey / dayExp / src 时按 0 兜底，其它字段与已有数据原样保留 */
    function loadGrowth() {
        try {
            const obj = JSON.parse(readFileSync(GROWTH, 'utf8'));
            if (obj && typeof obj === 'object')
                return obj;
        }
        catch (err) {
            if (!isMissing(err))
                quarantine(GROWTH, err);
        }
        return { exp: 0 };
    }
    function saveGrowth(obj) {
        try {
            writeJsonAtomic(GROWTH, obj);
        }
        catch { }
    }
    function addExp(amount, source) {
        const g = loadGrowth();
        const exp0 = Math.max(0, Number(g.exp) || 0);
        const prev = growthStage(exp0);
        const srcName = String(source || 'chat'); // 老调用方不传来源：按 chat 记（照 C# 的 AddExp(reason) 必须有来源）
        const capSrc = Object.prototype.hasOwnProperty.call(EXP_SOURCE_CAP, srcName) ? EXP_SOURCE_CAP[srcName] : EXP_SOURCE_DEFAULT_CAP;
        // 老文件兜底：缺 dayKey / dayExp / src / src[source] 都按 0 算，不动其它字段
        const today = todayKey();
        let dayExp = Number(g.dayExp) || 0;
        let src = (g.src && typeof g.src === 'object') ? g.src : {};
        if (String(g.dayKey || '') !== today) { // 跨天：日计数重置、各来源额度清零
            dayExp = 0;
            src = {};
            for (const k of Object.keys(EXP_SOURCE_CAP))
                src[k] = 0;
        }
        let capped = false;
        let gain = Math.floor(Number(amount) || 0);
        if (gain > 0) {
            const roomDay = EXP_DAILY_CAP - dayExp;
            if (roomDay <= 0) {
                capped = true;
                gain = 0;
                console.error('[store] GROWTH-CAP-DAY source=' + srcName + ' exp=' + exp0 + ' dayExp=' + dayExp + ' cap=' + EXP_DAILY_CAP);
            }
            else {
                if (gain > roomDay)
                    gain = roomDay;
                const used = Number(src[srcName]) || 0;
                const roomSrc = capSrc - used;
                if (roomSrc <= 0) {
                    capped = true;
                    gain = 0;
                    console.error('[store] GROWTH-CAP-SRC source=' + srcName + ' used=' + used + ' cap=' + capSrc + ' exp=' + exp0);
                }
                else if (gain > roomSrc) {
                    gain = roomSrc;
                }
            }
        }
        const exp = exp0 + (gain > 0 ? gain : 0);
        if (gain > 0) {
            dayExp += gain;
            src[srcName] = (Number(src[srcName]) || 0) + gain;
        }
        g.exp = exp;
        g.dayKey = today;
        g.dayExp = dayExp;
        g.src = src;
        saveGrowth(g);
        const stage = growthStage(exp);
        return { exp, stage, upgraded: stage.index > prev.index, prevStage: prev, capped };
    }
    // ===== 鱼粮（token 统计） =====
    function loadFishfood() {
        try {
            const obj = JSON.parse(readFileSync(FISHFOOD, 'utf8'));
            if (obj && typeof obj === 'object')
                return obj;
        }
        catch (err) {
            if (!isMissing(err))
                quarantine(FISHFOOD, err);
        }
        return { chatTokens: 0, storyTokens: 0 };
    }
    function saveFishfood(obj) {
        try {
            writeJsonAtomic(FISHFOOD, obj);
        }
        catch { }
    }
    /** 跨天/跨月把"今日/本月"清零（总量 totalTokens 不动，照 C# 的 date/month 滚动） */
    function rollFishfood(f) {
        const now = new Date();
        const day = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
        const month = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
        if (f.day !== day) {
            f.day = day;
            f.chatTokens = 0;
            f.storyTokens = 0;
            f.dayTokens = 0;
        }
        if (f.month !== month) {
            f.month = month;
            f.monthTokens = 0;
        }
    }
    function addTokens(kind, n) {
        const f = loadFishfood();
        rollFishfood(f);
        if (kind === 'story')
            f.storyTokens = (Number(f.storyTokens) || 0) + n;
        else
            f.chatTokens = (Number(f.chatTokens) || 0) + n;
        f.totalTokens = (Number(f.totalTokens) || 0) + n;
        f.monthTokens = (Number(f.monthTokens) || 0) + n;
        saveFishfood(f);
        return f;
    }
    // ===== 提醒 =====
    function loadReminders() {
        try {
            const arr = JSON.parse(readFileSync(REMINDERS, 'utf8'));
            if (Array.isArray(arr))
                return arr;
        }
        catch (err) {
            if (!isMissing(err))
                quarantine(REMINDERS, err);
        }
        return [];
    }
    function saveReminders(arr) {
        try {
            writeJsonAtomic(REMINDERS, arr);
        }
        catch { }
    }
    function addReminder(text, at, repeat) {
        const arr = loadReminders();
        const rep = Math.round(Number(repeat) || 0);
        const item = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            text,
            at,
            repeat: rep > 0 ? rep : null,
            nextAt: null,
            fired: false,
            done: false,
            remindCount: 0,
            createdAt: new Date().toISOString(),
        };
        arr.push(item);
        saveReminders(arr);
        return item;
    }
    function dueReminders() {
        const arr = loadReminders();
        const now = Date.now();
        const due = [];
        let changed = false;
        for (const r of arr) {
            if (!r || r.done)
                continue; // 已完成的一律跳过
            const stamp = r.nextAt || r.at;
            if (!stamp)
                continue;
            const when = new Date(stamp).getTime();
            if (!Number.isFinite(when) || when > now)
                continue;
            if (r.fired)
                continue;
            r.fired = true;
            r.remindCount = (Number(r.remindCount) || 0) + 1;
            due.push(r);
            changed = true;
            const rep = Number(r.repeat) || 0;
            if (rep > 0) {
                // 每天（或自定义间隔）的提醒：不标 done，只把下一次时间往后推
                // 从「原定时间」往后推，不用「触发时刻」——否则每天 9 点的提醒会一天比一天晚
                let nextMs = when + rep * 1000;
                let guard = 0;
                while (nextMs <= now && guard++ < 10000)
                    nextMs += rep * 1000;
                r.nextAt = new Date(nextMs).toISOString();
                r.at = r.nextAt;
                r.fired = false;
            }
            else {
                r.done = true;
            }
        }
        if (changed)
            saveReminders(arr);
        return due;
    }
    function removeReminder(id) {
        saveReminders(loadReminders().filter((r) => r.id !== id));
    }
    // ===== 宠物状态（feeds/hunger/mood，照 C# 版 的 state.json） =====
    function loadPet() {
        try {
            const obj = JSON.parse(readFileSync(PET, 'utf8'));
            if (obj && typeof obj === 'object')
                return obj;
        }
        catch (err) {
            if (!isMissing(err))
                quarantine(PET, err);
        }
        return { feeds: 0, hunger: 0, mood: 'normal', lastSeen: 0 };
    }
    function savePet(obj) {
        try {
            writeJsonAtomic(PET, obj);
        }
        catch { }
    }
    function tickPet() {
        const p = loadPet();
        const now = Date.now();
        if (p.lastSeen) {
            const hoursAway = (now - Number(p.lastSeen)) / 3600000;
            if (hoursAway > 0)
                p.hunger = Math.min(100, (Number(p.hunger) || 0) + hoursAway * 3);
        }
        p.lastSeen = now;
        savePet(p);
        return p;
    }
    function feedPet() {
        const p = tickPet();
        p.feeds = (Number(p.feeds) || 0) + 1;
        p.hunger = Math.max(0, (Number(p.hunger) || 0) - 30);
        p.intimacy = Math.min(100, (Number(p.intimacy) || 0) + 2); // 照 C#：喂食亲密 +2
        p.mood = 'happy';
        savePet(p);
        return p;
    }
    function setMood(mood) {
        const p = loadPet();
        p.mood = mood;
        savePet(p);
    }
    return {
        loadHistory, saveHistory, appendTurns, clearMemory, loadMemorySummary, saveMemorySummary,
        loadState, saveState,
        loadStoryProgress, saveStoryProgress,
        loadGrowth, saveGrowth, addExp,
        loadFishfood, saveFishfood, addTokens,
        loadReminders, saveReminders, addReminder, dueReminders, removeReminder,
        loadPet, savePet, tickPet, feedPet, setMood,
    };
}
