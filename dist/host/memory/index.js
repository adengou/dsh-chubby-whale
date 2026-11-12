/**
 * host/memory/index.ts —— 肥鲸记忆模块（独立模块，只暴露接口）
 *
 * 对外接口（唯一入口，其他模块不得直接读写 memory.json）：
 *   · remember(user, reply, meta?)  追加一轮对话，返回记录条数
 *   · recall(query, opts?)          检索相关记忆（BM25 + 两段式 + 三因子 + 去重）
 *   · tick(now?)                    跑一次衰减/压缩（由宿主定时调用）
 *   · stats()                       模块状态（条数/分层/压缩比）
 *   · loadRecent(n)                 取最近 n 条原始历史（供 prompt 拼装，保持旧行为）
 *   · loadSummary()/saveSummary(s)  长期摘要读写（供摘要器使用）
 *   · clear()                       清空
 *
 * 数据分层（同一条 memory.json，不用新库）：
 *   · hot  ：summary 里保留的长期事实 + 最近 7 天摘要（每轮注入，约 3000 字内）
 *   · warm ：原文条目（带 importance / lastRecalledAt / compressedLevel），命中才召回
 *   · cold ：超过 120 天且低重要度的条目，压缩成一行目录后删除正文
 *
 * 说明：本模块不依赖向量模型/第三方检索库——BM25 全在本地计算。
 */
import { join } from 'node:path';
import { readTextNoBom, writeJsonAtomic, isMissingFileError, quarantineFile } from '../atomic.js';
import { deepFreeze } from '../../shared/immutable.js';
import { buildIndex, recall as bm25Recall } from './bm25.js';
/** 原始历史最多保留多少条（40 轮） */
const HISTORY_LIMIT = 80;
/** 衰减参数（天） */
export const DECAY_DAYS = deepFreeze({ first: 21, second: 45, third: 120 });
/** 冷层压缩阈值（importance 低于此值才允许压缩/删除） */
const COLD_IMPORTANCE = 0.35;
function clamp01(n) {
    if (!Number.isFinite(n))
        return 0.5;
    return Math.max(0, Math.min(1, n));
}
function newId(at, i) {
    return 'm' + at.toString(36) + '-' + i.toString(36);
}
export function createMemoryModule(dataDir) {
    const MEMORY = join(dataDir, 'memory.json');
    let index = null;
    let indexSize = -1;
    function load() {
        try {
            const obj = JSON.parse(readTextNoBom(MEMORY));
            if (Array.isArray(obj)) {
                return { history: migrate(obj), summary: '', savedAt: '' };
            }
            if (obj && typeof obj === 'object') {
                return {
                    history: migrate(Array.isArray(obj.history) ? obj.history : []),
                    summary: String(obj.summary || ''),
                    savedAt: String(obj.savedAt || ''),
                    catalog: Array.isArray(obj.catalog) ? obj.catalog.map(String) : [],
                };
            }
        }
        catch (err) {
            if (!isMissingFileError(err))
                quarantineFile(MEMORY, err, '[memory]');
        }
        return { history: [], summary: '', savedAt: '', catalog: [] };
    }
    /** 老格式（role/content 二元组）迁移成新结构：缺的时间/重要度按旧行为补默认值 */
    function migrate(arr) {
        const now = Date.now();
        return (arr || []).map((m, i) => {
            if (m && typeof m === 'object' && 'role' in m) {
                const at = Number.isFinite(m.at) ? Number(m.at) : now;
                return {
                    id: String(m.id || newId(at, i)),
                    role: m.role === 'assistant' ? 'assistant' : 'user',
                    content: String(m.content || ''),
                    at,
                    importance: clamp01(m.importance != null ? Number(m.importance) : 0.5),
                    lastRecalledAt: Number.isFinite(m.lastRecalledAt) ? Number(m.lastRecalledAt) : at,
                    compressedLevel: Number.isFinite(m.compressedLevel) ? Number(m.compressedLevel) : 0,
                    pinned: m.pinned === true,
                };
            }
            return { id: newId(now, i), role: 'user', content: String(m || ''), at: now, importance: 0.5, lastRecalledAt: now, compressedLevel: 0 };
        });
    }
    function save(file) {
        try {
            writeJsonAtomic(MEMORY, {
                history: file.history.slice(-HISTORY_LIMIT),
                summary: String(file.summary || ''),
                catalog: (file.catalog || []).slice(-200),
                savedAt: new Date().toISOString(),
            });
        }
        catch (err) {
            console.error('[memory] WRITE-FAIL ' + String(MEMORY) + ' err=' + String(err?.message || err));
        }
    }
    /** 重建检索索引（文档 = 未压缩的原文 + 冷层目录行） */
    function ensureIndex(file) {
        if (index && indexSize === file.history.length)
            return index;
        const docs = [];
        for (const e of file.history) {
            if (e.compressedLevel >= 4)
                continue;
            docs.push({ id: e.id, text: e.content, display: e.content, importance: e.importance, at: e.at });
        }
        for (const line of file.catalog || []) {
            docs.push({ id: 'c-' + line.slice(0, 16), text: line, display: line, importance: 0.5, at: Date.now() });
        }
        index = buildIndex(docs);
        indexSize = file.history.length;
        return index;
    }
    function remember(userText, replyText, meta) {
        const file = load();
        const now = Number.isFinite(meta?.at) ? meta.at : Date.now();
        const imp = clamp01(meta?.importance != null ? Number(meta.importance) : 0.5);
        file.history.push({
            id: newId(now, file.history.length),
            role: 'user', content: String(userText || ''), at: now, importance: imp, lastRecalledAt: now, compressedLevel: 0,
        });
        file.history.push({
            id: newId(now, file.history.length + 1),
            role: 'assistant', content: String(replyText || ''), at: now, importance: imp, lastRecalledAt: now, compressedLevel: 0,
        });
        file.history = file.history.slice(-HISTORY_LIMIT);
        if (file.history.length !== indexSize)
            indexSize = -1;
        save(file);
        return file.history.length;
    }
    function recall(query, opts) {
        const file = load();
        const idx = ensureIndex(file);
        return bm25Recall(idx, query, opts);
    }
    /** 衰减/压缩：冷层逐级压缩，重新被提起的计时回退 */
    function tick(nowArg) {
        const now = Number.isFinite(nowArg) ? nowArg : Date.now();
        const file = load();
        let changed = false;
        const catalog = file.catalog || [];
        for (const e of file.history) {
            if (e.pinned)
                continue;
            const days = Math.max(0, (now - Math.max(e.at, e.lastRecalledAt)) / 86400000);
            if (days < DECAY_DAYS.first)
                continue;
            // 低重要度的才压缩；高重要度只降权不删
            if (e.importance > COLD_IMPORTANCE)
                continue;
            if (days >= DECAY_DAYS.third) {
                // 120 天：正文删除，只留主题目录行（不管之前压到几级）
                const topic = e.content.slice(0, 24).replace(/\s+/g, ' ');
                if (topic)
                    catalog.push(topic);
                e.compressedLevel = 4;
                e.content = '';
                changed = true;
            }
            else if (days >= DECAY_DAYS.second && e.compressedLevel < 2) {
                e.compressedLevel = 2;
                e.content = e.content.slice(0, 60);
                changed = true;
            }
            else if (e.compressedLevel < 1) {
                e.compressedLevel = 1;
                e.content = e.content.slice(0, 200);
                changed = true;
            }
        }
        // 已删除正文的空条目移除（目录里留了主题）
        const before = file.history.length;
        file.history = file.history.filter((e) => e.content.length > 0 || e.pinned);
        if (file.history.length !== before)
            changed = true;
        if (changed) {
            file.catalog = catalog;
            indexSize = -1;
            save(file);
        }
    }
    function stats() {
        const file = load();
        const warm = file.history.filter((e) => e.compressedLevel <= 1).length;
        const cold = file.history.filter((e) => e.compressedLevel >= 2).length;
        const pinned = file.history.filter((e) => e.pinned).length;
        return {
            history: file.history.length,
            warm,
            cold,
            pinned,
            summaryLen: String(file.summary || '').length,
            catalogLen: (file.catalog || []).length,
        };
    }
    function loadRecent(n) {
        const file = load();
        const k = Math.max(0, Math.min(HISTORY_LIMIT, Math.floor(n) || 0));
        return file.history.slice(-k);
    }
    function loadSummary() { return load().summary; }
    function saveSummary(s) {
        const file = load();
        file.summary = String(s || '');
        save(file);
    }
    function clear() {
        try {
            writeJsonAtomic(MEMORY, { history: [], summary: '', catalog: [], savedAt: new Date().toISOString() });
        }
        catch (err) {
            console.error('[memory] WRITE-FAIL ' + String(MEMORY) + ' err=' + String(err?.message || err));
        }
        index = null;
        indexSize = -1;
    }
    return { remember, recall, tick, stats, loadRecent, loadSummary, saveSummary, clear };
}
