/**
 * host/backup/fields.ts —— 备份数据字段白名单、上限与导入清洗（纯函数）
 *
 * 从 routes/backup.ts 拆出（行为等价，安全修复见各函数注释）。这一层只做三件事：
 *   1) 定死可导出/可导入的 8 个数据字段与导出包元数据；
 *   2) 集中体积上限与字段级上限（条数、单条字符串长度），导入清洗与导出共用同一份口径；
 *   3) 把外部 JSON 逐字段重建成内部对象（只读白名单、只写新对象），非法值返回 null → skipped。
 *
 * 安全边界：
 *   · 字段名只认 BACKUP_DATA_FIELDS；`__proto__` / `constructor` 等原型链键既不是数据字段，
 *     也不会被当成清洗器查表命中（BACKUP_CLEANERS 用 null 原型 + 白名单双重判断）；
 *   · 动态键写入（growth.src / storyProgress）跳过 `__proto__` / `constructor` / `prototype`，
 *     只写自有属性，避免把外部键名变成原型污染跳板；
 *   · personality 先过 sanitizePersonality（可变层四字段 + 上限），再补一道 CORE_GUARD：
 *     L3 心境与心境历史是外部 JSON 直接给的内容，必须与 L2 学习同一道身份词闸门。
 *
 * 本文件不读盘、不写盘、不 import 任何路由/仓储实现。
 */
import { deepFreeze } from '../../shared/immutable.js';
import { sanitizePersonality, isSafeLearnedText } from '../personality.js';
/** 备份体积上限：2MB（导出超限 413；导入 body 超限 413） */
export const BACKUP_MAX_BYTES = 2 * 1024 * 1024;
/** 可导出的数据字段（导入白名单同一份：只接受这 8 个） */
export const BACKUP_DATA_FIELDS = [
    'memory', 'personality', 'state', 'growth', 'fishfood', 'pet', 'reminders', 'storyProgress',
];
/** 导出包自带的元数据：导入时认识，但不写盘（防止把版本号/时间戳当数据） */
export const BACKUP_META_FIELDS = ['ok', 'version', 'exportedAt'];
/**
 * 字段级上限（导入清洗与导出共用）。
 *
 * 取值依据：
 *   · memoryHistory=40 与 host/repos/memory.ts 的 MEMORY_LIMIT 同口径：入库本来只留最新 40 条，
 *     导入层先截断，保证「导入的内存占用 / 落盘文件大小」与运行时一致；
 *   · memoryContentLen=8000 / memorySummaryLen=2000：正常聊天单条远低于此，但 2MB 请求体
 *     内可以塞 40 条各 50KB 的「聊天内容」，不设上限会把 memory.json 撑到 2MB 并拖慢每次读盘；
 *   · reminders=200：正常提醒是个位数，2MB 内可塞数万条；dueReminders 每次全量遍历，
 *     不设上限会把一次误导入变成长期的同步遍历负担；
 *   · growthSources=50 / storyEntries=2000 / storyKeyLen=400：动态键对象的上限，
 *     正常数据（5 个经验来源、17 本书的说书进度）远低于上限，留足余量。
 */
export const BACKUP_LIMITS = deepFreeze({
    memoryHistory: 40,
    memoryContentLen: 8000,
    memorySummaryLen: 2000,
    reminders: 200,
    reminderTextLen: 200,
    reminderStampLen: 40,
    growthSources: 50,
    storyEntries: 2000,
    storyKeyLen: 400,
});
/** 普通对象（数组、null、函数都不算） */
export function isPlainObject(v) {
    return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}
/** 有限数字（严格 typeof number；字符串数字不算，类型校验不放松） */
function isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
}
function toNonNegInt(v) {
    return isNum(v) ? Math.max(0, Math.floor(v)) : 0;
}
function clip(v, max) {
    return String(v == null ? '' : v).slice(0, max);
}
/** 动态键里永远不写的三个名字（会命中对象原型/构造器语义） */
const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];
/** 外部 JSON 给的键名是否允许直接写进内部对象 */
function isUnsafeKey(key) {
    return UNSAFE_KEYS.indexOf(key) >= 0;
}
// ===== 导入：逐字段类型清洗（非法返回 null → skipped） =====
/**
 * 聊天记忆：{history:[{role,content}], summary}；老格式（整份就是数组）也认。
 *
 * 审计修复 F1（2026-11-06）：history 先截到 40 条（与 repos/memory.ts 的 MEMORY_LIMIT 一致，
 * 保留最新），单条 content ≤8000 字、summary ≤2000 字。原实现不设上限，导入后由仓储
 * 的 slice(-40) 兜底条数，但单条长度与 summary 没有任何上限，2MB 内的请求可把 memory.json
 * 写到接近 2MB，之后每次聊天读盘都要解析这份大文件。
 */
export function cleanMemory(value) {
    const cleanTurns = (raw) => {
        if (!Array.isArray(raw))
            return null;
        const out = [];
        for (const t of raw) {
            if (!isPlainObject(t))
                continue;
            const role = t.role === 'user' || t.role === 'assistant' ? t.role : '';
            if (!role || typeof t.content !== 'string')
                continue;
            out.push({ role, content: clip(t.content, BACKUP_LIMITS.memoryContentLen) });
        }
        // 与运行时的「只留最新 40 条」同口径；不截断会让导入后的内存/文件超过仓储预期
        return out.length > BACKUP_LIMITS.memoryHistory ? out.slice(-BACKUP_LIMITS.memoryHistory) : out;
    };
    if (Array.isArray(value)) {
        const history = cleanTurns(value);
        return history === null ? null : { history, summary: '' };
    }
    if (!isPlainObject(value))
        return null;
    // 空对象没有可写内容：当非法处理，避免一次误导入把记忆清空
    if (!('history' in value) && !('summary' in value))
        return null;
    const history = value.history === undefined ? [] : cleanTurns(value.history);
    if (history === null)
        return null;
    if (value.summary !== undefined && typeof value.summary !== 'string')
        return null;
    return {
        history,
        summary: typeof value.summary === 'string' ? clip(value.summary, BACKUP_LIMITS.memorySummaryLen) : '',
    };
}
/** 亲密度：{intimacy:number} */
export function cleanState(value) {
    if (!isPlainObject(value) || !isNum(value.intimacy))
        return null;
    return { intimacy: Math.max(0, Math.floor(value.intimacy)) };
}
/**
 * 成长：{exp:number, dayKey?:string, dayExp?:number, src?:{来源:number}}
 *
 * 审计修复 F2（2026-11-06）：src 是外部 JSON 提供的动态键对象。原实现直接
 * `src[clip(k, 20)] = 数值`，`__proto__` / `constructor` / `prototype` 会被当作普通属性写入
 * （当前值都是数字，改不了 Object.prototype，但键名语义已偏离，且一旦以后写入对象值
 * 就会变成原型污染跳板）。现在跳过这三个键，并限制来源数量 ≤50。
 */
export function cleanGrowth(value) {
    if (!isPlainObject(value) || !isNum(value.exp))
        return null;
    const out = { exp: Math.max(0, Math.floor(value.exp)) };
    if (typeof value.dayKey === 'string')
        out.dayKey = clip(value.dayKey, 20);
    if (isNum(value.dayExp))
        out.dayExp = Math.max(0, Math.floor(value.dayExp));
    if (isPlainObject(value.src)) {
        const src = {};
        let kept = 0;
        for (const k of Object.keys(value.src)) {
            if (kept >= BACKUP_LIMITS.growthSources)
                break;
            if (isUnsafeKey(k) || !isNum(value.src[k]))
                continue;
            const key = clip(k, 20);
            if (isUnsafeKey(key))
                continue;
            src[key] = Math.max(0, Math.floor(value.src[k]));
            kept++;
        }
        out.src = src;
    }
    return out;
}
/** 鱼粮：token 计数与日/月滚动标记 */
export function cleanFishfood(value) {
    if (!isPlainObject(value))
        return null;
    const out = {};
    for (const k of ['chatTokens', 'storyTokens', 'totalTokens', 'monthTokens', 'dayTokens']) {
        if (isNum(value[k]))
            out[k] = Math.max(0, Math.floor(value[k]));
    }
    if (typeof value.day === 'string')
        out.day = clip(value.day, 20);
    if (typeof value.month === 'string')
        out.month = clip(value.month, 20);
    return Object.keys(out).length ? out : null;
}
/** 宠物：数值项 + 心情字符串 */
export function cleanPet(value) {
    if (!isPlainObject(value))
        return null;
    const out = {};
    // lastFeedAt：喂食时刻（mood 的 happy 窗口要用它；漏掉会让导入后情绪退回 normal）
    for (const k of ['feeds', 'hunger', 'lastSeen', 'lastFeedAt', 'intimacy']) {
        if (isNum(value[k]))
            out[k] = Math.max(0, Math.floor(value[k]));
    }
    if (typeof value.mood === 'string')
        out.mood = clip(value.mood, 20);
    return Object.keys(out).length ? out : null;
}
/**
 * 提醒：数组，逐项重建（坏项丢弃）；非空数组全是坏项 → null，避免误清空。
 *
 * 审计修复 F3（2026-11-06）：最多保留最新 200 条（与 memory 的“保留最新”同口径）。
 * 原实现不设上限，2MB 内可写入数万条；写盘后 dueReminders 每次轮询都全量遍历。
 * 备注：过去时间的 `at` 仍按原样保留，下一次 dueReminders 会立即触发一次——这是
 * 备份恢复的语义（恢复后提醒照常到点），本次审计只报告、不改数据含义。
 */
export function cleanReminders(value) {
    if (!Array.isArray(value))
        return null;
    const out = [];
    for (const r of value) {
        if (!isPlainObject(r))
            continue;
        if (typeof r.text !== 'string' || !r.text.trim())
            continue;
        if (typeof r.at !== 'string' || !r.at.trim())
            continue;
        out.push({
            id: typeof r.id === 'string' && r.id ? clip(r.id, 64) : Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            text: clip(r.text, BACKUP_LIMITS.reminderTextLen),
            at: clip(r.at, BACKUP_LIMITS.reminderStampLen),
            repeat: isNum(r.repeat) && r.repeat > 0 ? Math.round(r.repeat) : null,
            nextAt: typeof r.nextAt === 'string' ? clip(r.nextAt, BACKUP_LIMITS.reminderStampLen) : null,
            fired: r.fired === true,
            done: r.done === true,
            remindCount: toNonNegInt(r.remindCount),
            createdAt: typeof r.createdAt === 'string' ? clip(r.createdAt, BACKUP_LIMITS.reminderStampLen) : new Date().toISOString(),
        });
    }
    if (out.length === 0 && value.length > 0)
        return null;
    return out.length > BACKUP_LIMITS.reminders ? out.slice(-BACKUP_LIMITS.reminders) : out;
}
/**
 * 说书进度：{'书|段': true, _current:'书名'}；没有任何合法项 → null，避免误清空。
 *
 * 审计修复 F4（2026-11-06）：跳过 `__proto__` / `constructor` / `prototype` 键，条目上限 2000。
 * 原实现把任意键名直接写到 `out[...]`，虽当前值固定为 true（不构成原型污染），
 * 但键名会原样保存到 story_progress.json，不应允许外部 JSON 控制 `__proto__` 这类保留名。
 */
export function cleanStoryProgress(value) {
    if (!isPlainObject(value))
        return null;
    const out = {};
    let kept = 0;
    for (const k of Object.keys(value)) {
        if (kept >= BACKUP_LIMITS.storyEntries)
            break;
        if (isUnsafeKey(k))
            continue;
        if (k === '_current') {
            if (typeof value[k] === 'string' && value[k]) {
                out._current = clip(value[k], 40);
                kept++;
            }
            continue;
        }
        if (value[k] === true) {
            const key = clip(k, BACKUP_LIMITS.storyKeyLen);
            if (!isUnsafeKey(key)) {
                out[key] = true;
                kept++;
            }
        }
    }
    return kept > 0 ? out : null;
}
/** 心境历史值是否可用（空串是合法的“原有/现有心境为空”，非空才过 CORE_GUARD） */
function isSafeNarrativeValue(v) {
    return v === '' || isSafeLearnedText(v);
}
/**
 * 人格：只走 sanitizePersonality（可变层四字段 + 元数据），核心设定永远进不来。
 *
 * 审计修复 F5（2026-11-06）：补一道 CORE_GUARD。sanitizePersonality 对 L2 学习内容
 * （口头禅/偏好/备注）用 CORE_GUARD 过滤，但 selfNarrative 只过 L3 的 SELF_GUARD；
 * 导入是外部 JSON 直接指定心境，SELF_GUARD 不拦「本鲸叫旺财」这类「自称 + 叫」结构，
 * 而 CORE_GUARD 会拦。这里对当前心境与心境历史（回滚会把 old 恢复成当前心境）
 * 再走一遍 isSafeLearnedText，命中即清空/丢弃该条历史，保证“导入写不进核心设定”的承诺成立。
 * 注：personality.ts 门面没有暴露 CORE_GUARD 词表，这里只调用它导出的判定函数，不另抄词表。
 */
export function cleanPersonality(value) {
    if (!isPlainObject(value))
        return null;
    const data = sanitizePersonality(value);
    if (data.selfNarrative && !isSafeLearnedText(data.selfNarrative)) {
        data.selfNarrative = '';
        data.selfNarrativeAt = '';
    }
    data.history = data.history.filter((entry) => (entry.field !== 'selfNarrative' || (isSafeNarrativeValue(entry.old) && isSafeNarrativeValue(entry.new))));
    return data;
}
/**
 * 字段 → 清洗器（与 BACKUP_DATA_FIELDS 一一对应）。
 *
 * 用 null 原型：即使调用方漏做白名单判断，`BACKUP_CLEANERS['__proto__']` / `['constructor']`
 * 也不会命中原型链上的对象，避免“查表得到一个非函数/非空值”的隐式行为。
 */
export const BACKUP_CLEANERS = Object.assign(Object.create(null), {
    memory: cleanMemory,
    personality: cleanPersonality,
    state: cleanState,
    growth: cleanGrowth,
    fishfood: cleanFishfood,
    pet: cleanPet,
    reminders: cleanReminders,
    storyProgress: cleanStoryProgress,
});
deepFreeze(BACKUP_CLEANERS);
/** 字段名是否是备份数据字段（显式白名单，不查原型链） */
export function isBackupDataField(name) {
    return BACKUP_DATA_FIELDS.indexOf(name) >= 0;
}
