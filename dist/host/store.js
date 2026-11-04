/**
 * host/store.ts —— 持久化存储（可复用模块）
 * 记忆（memory.json）、状态（state.json）、说书进度（story_progress.json）、
 * 成长（growth.json）、鱼粮（fishfood.json）、提醒（reminders.json）、宠物状态（pet_state.json）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
export const GROWTH_STAGES = [
    { exp: 0, name: '初识' },
    { exp: 200, name: '熟悉' },
    { exp: 800, name: '亲密' },
    { exp: 2500, name: '知心' },
    { exp: 5000, name: '家人' },
];
export function growthStage(exp) {
    let idx = 0;
    for (let i = 0; i < GROWTH_STAGES.length; i++) {
        if (exp >= GROWTH_STAGES[i].exp)
            idx = i;
    }
    const next = idx + 1 < GROWTH_STAGES.length ? GROWTH_STAGES[idx + 1].exp : 0;
    return { index: idx, name: GROWTH_STAGES[idx].name, nextExp: next };
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
    // ===== 聊天记忆（history + summary，照 fish-pet） =====
    function loadMemoryObj() {
        try {
            const obj = JSON.parse(readFileSync(MEMORY, 'utf8'));
            if (Array.isArray(obj))
                return { history: obj, summary: '' };
            if (obj && typeof obj === "object") {
                return { history: Array.isArray(obj.history) ? obj.history : [], summary: String(obj.summary || '') };
            }
        }
        catch { }
        return { history: [], summary: '' };
    }
    function saveMemoryObj(obj) {
        try {
            ensure();
            writeFileSync(MEMORY, JSON.stringify({ history: (obj.history || []).slice(-MEMORY_LIMIT), summary: String(obj.summary || ''), savedAt: new Date().toISOString() }), 'utf8');
        }
        catch { }
    }
    function loadHistory() { return loadMemoryObj().history; }
    function saveHistory(arr) { const m = loadMemoryObj(); m.history = arr; saveMemoryObj(m); }
    function loadMemorySummary() { return loadMemoryObj().summary; }
    function saveMemorySummary(s) { const m = loadMemoryObj(); m.summary = String(s || ""); saveMemoryObj(m); }
    function clearMemory() {
        try {
            ensure();
            writeFileSync(MEMORY, JSON.stringify({ history: [], summary: '', savedAt: new Date().toISOString() }), 'utf8');
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
        catch { }
        return { intimacy: 0 };
    }
    function saveState(obj) {
        try {
            ensure();
            writeFileSync(STATE, JSON.stringify(obj), 'utf8');
        }
        catch { }
    }
    // ===== 说书进度 =====
    function loadStoryProgress() {
        try {
            return JSON.parse(readFileSync(STORY_PROGRESS, 'utf8'));
        }
        catch {
            return {};
        }
    }
    function saveStoryProgress(obj) {
        try {
            ensure();
            writeFileSync(STORY_PROGRESS, JSON.stringify(obj), 'utf8');
        }
        catch { }
    }
    // ===== 成长 =====
    function loadGrowth() {
        try {
            const obj = JSON.parse(readFileSync(GROWTH, 'utf8'));
            if (obj && typeof obj === 'object')
                return obj;
        }
        catch { }
        return { exp: 0 };
    }
    function saveGrowth(obj) {
        try {
            ensure();
            writeFileSync(GROWTH, JSON.stringify(obj), 'utf8');
        }
        catch { }
    }
    function addExp(amount) {
        const g = loadGrowth();
        const prev = growthStage(Number(g.exp) || 0);
        g.exp = Math.max(0, (Number(g.exp) || 0) + amount);
        saveGrowth(g);
        const stage = growthStage(g.exp);
        return { exp: g.exp, stage, upgraded: stage.index > prev.index, prevStage: prev };
    }
    // ===== 鱼粮（token 统计） =====
    function loadFishfood() {
        try {
            const obj = JSON.parse(readFileSync(FISHFOOD, 'utf8'));
            if (obj && typeof obj === 'object')
                return obj;
        }
        catch { }
        return { chatTokens: 0, storyTokens: 0 };
    }
    function saveFishfood(obj) {
        try {
            ensure();
            writeFileSync(FISHFOOD, JSON.stringify(obj), 'utf8');
        }
        catch { }
    }
    function addTokens(kind, n) {
        const f = loadFishfood();
        if (kind === 'story')
            f.storyTokens = (Number(f.storyTokens) || 0) + n;
        else
            f.chatTokens = (Number(f.chatTokens) || 0) + n;
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
        catch { }
        return [];
    }
    function saveReminders(arr) {
        try {
            ensure();
            writeFileSync(REMINDERS, JSON.stringify(arr), 'utf8');
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
    // ===== 宠物状态（feeds/hunger/mood，照 fish-pet 的 state.json） =====
    function loadPet() {
        try {
            const obj = JSON.parse(readFileSync(PET, 'utf8'));
            if (obj && typeof obj === 'object')
                return obj;
        }
        catch { }
        return { feeds: 0, hunger: 0, mood: 'normal', lastSeen: 0 };
    }
    function savePet(obj) {
        try {
            ensure();
            writeFileSync(PET, JSON.stringify(obj), 'utf8');
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
        loadHistory, saveHistory, clearMemory, loadMemorySummary, saveMemorySummary,
        loadState, saveState,
        loadStoryProgress, saveStoryProgress,
        loadGrowth, saveGrowth, addExp,
        loadFishfood, saveFishfood, addTokens,
        loadReminders, saveReminders, addReminder, dueReminders, removeReminder,
        loadPet, savePet, tickPet, feedPet, setMood,
    };
}
