// @ts-nocheck
/**
 * reminder 模块 —— 提醒的创建、定时触发、持久化与启动恢复。
 *
 * 设计要点：
 * - 纯 ESM，除 Node 内置模块外不依赖任何第三方包；
 * - 全部可变状态（提醒表、定时器、监听器）都留在工厂闭包里；
 * - 对外只返回一个冻结的接口对象，不暴露任何内部字段。
 */
import { randomUUID } from 'node:crypto';
const STORE_KEY = 'reminder.items';
const GRACE_MS = 500;
const MAX_TIMER_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_PENDING = 50;
const MAX_FINISHED = 100;
const MIN_IN_SECONDS = 1;
const MAX_IN_SECONDS = 30 * 24 * 60 * 60;
const MAX_BUFFERED_EVENTS = 100;
const VALID_STATUS = new Set(['pending', 'fired', 'cancelled']);
export function createReminderModule(deps) {
    const { store, clock, logger, config } = deps || {};
    if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
        throw new TypeError('reminder 模块缺少可用的 store');
    }
    if (!clock || typeof clock.now !== 'function') {
        throw new TypeError('reminder 模块缺少可用的 clock');
    }
    // ---- 闭包内状态 ----
    const items = new Map(); // id -> 内部提醒记录
    const timers = new Map(); // id -> setTimeout 句柄
    const auxTimers = new Set(); // 辅助定时器（如暂存事件的延迟派发）
    const listeners = new Set(); // onDue 监听器
    const buffered = []; // 还没有监听器时暂存的事件
    const maxPending = resolveMaxPending(config);
    let disposed = false;
    let finishedSeq = 0;
    let writeChain = Promise.resolve();
    // ---- 基础工具 ----
    function resolveMaxPending(cfg) {
        if (!cfg || cfg.maxPending === undefined || cfg.maxPending === null) {
            return DEFAULT_MAX_PENDING;
        }
        const value = Number(cfg.maxPending);
        if (Number.isFinite(value) && value >= 0)
            return Math.floor(value);
        return DEFAULT_MAX_PENDING;
    }
    function safeLog(level, message, error) {
        try {
            const fn = logger && logger[level];
            if (typeof fn === 'function')
                fn.call(logger, message, error);
        }
        catch {
            // 日志失败不能影响提醒本身
        }
    }
    function compareId(a, b) {
        if (a === b)
            return 0;
        return a < b ? -1 : 1;
    }
    function countPending() {
        let count = 0;
        for (const record of items.values()) {
            if (record.status === 'pending')
                count += 1;
        }
        return count;
    }
    function endedAtOf(record) {
        if (Number.isFinite(record.endedAt))
            return record.endedAt;
        if (Number.isFinite(record.firedAt))
            return record.firedAt;
        return record.createdAt;
    }
    function toPublic(record) {
        const view = {
            id: record.id,
            text: record.text,
            dueAt: record.dueAt,
            status: record.status,
            createdAt: record.createdAt,
        };
        if (record.status === 'fired' && Number.isFinite(record.firedAt)) {
            view.firedAt = record.firedAt;
        }
        return view;
    }
    function persist() {
        const snapshot = {};
        for (const [id, record] of items)
            snapshot[id] = toPublic(record);
        writeChain = writeChain
            .then(() => store.set(STORE_KEY, snapshot))
            .catch((err) => safeLog('error', '[reminder] 持久化提醒失败', err));
        return writeChain;
    }
    // ---- 恢复 ----
    function toEntries(raw) {
        if (!raw || typeof raw !== 'object')
            return [];
        if (Array.isArray(raw))
            return raw.map((value, index) => [String(index), value]);
        if (raw instanceof Map)
            return [...raw.entries()].map(([key, value]) => [String(key), value]);
        return Object.entries(raw);
    }
    function normalizeRecord(raw, key) {
        if (!raw || typeof raw !== 'object')
            return null;
        const id = typeof key === 'string' && key.length > 0
            ? key
            : typeof raw.id === 'string' && raw.id.length > 0
                ? raw.id
                : null;
        if (!id)
            return null;
        if (typeof raw.text !== 'string')
            return null;
        if (!VALID_STATUS.has(raw.status))
            return null;
        const dueAt = Number(raw.dueAt);
        const createdAt = Number(raw.createdAt);
        if (!Number.isFinite(dueAt) || !Number.isFinite(createdAt))
            return null;
        const record = {
            id,
            text: raw.text,
            dueAt,
            status: raw.status,
            createdAt,
        };
        if (raw.status === 'fired') {
            const firedAt = Number(raw.firedAt);
            record.firedAt = Number.isFinite(firedAt) ? firedAt : createdAt;
            record.endedAt = record.firedAt;
        }
        else if (raw.status === 'cancelled') {
            const endedAt = Number(raw.endedAt);
            record.endedAt = Number.isFinite(endedAt) ? endedAt : createdAt;
        }
        return record;
    }
    async function restore() {
        let raw;
        try {
            raw = await store.get(STORE_KEY, {});
        }
        catch (err) {
            safeLog('error', '[reminder] 读取提醒数据失败', err);
            return;
        }
        if (disposed)
            return;
        let changed = false;
        for (const [key, value] of toEntries(raw)) {
            const record = normalizeRecord(value, key);
            if (!record) {
                changed = true;
                safeLog('warn', '[reminder] 忽略一条无法识别的提醒记录');
                continue;
            }
            if (items.has(record.id)) {
                changed = true;
                continue;
            }
            items.set(record.id, record);
        }
        // 重建“结束顺序”，让“保留最近 100 条”在重启后仍然稳定。
        const finished = [];
        for (const record of items.values()) {
            if (record.status !== 'pending')
                finished.push(record);
        }
        finished.sort((a, b) => endedAtOf(a) - endedAtOf(b) || compareId(a.id, b.id));
        for (const record of finished) {
            finishedSeq += 1;
            record.finishedSeq = finishedSeq;
        }
        const sizeBeforePrune = items.size;
        pruneFinished();
        if (items.size !== sizeBeforePrune)
            changed = true;
        if (changed)
            await persist();
        const now = clock.now();
        const overdue = [];
        for (const record of items.values()) {
            if (record.status !== 'pending')
                continue;
            if (record.dueAt <= now)
                overdue.push(record.id);
            else
                scheduleAt(record.id);
        }
        if (overdue.length > 0) {
            safeLog('info', `[reminder] 启动恢复：补触发 ${overdue.length} 条提醒`);
            for (const id of overdue)
                fire(id);
        }
    }
    // ---- 定时与触发 ----
    function clearTimer(id) {
        const handle = timers.get(id);
        if (handle === undefined)
            return;
        timers.delete(id);
        try {
            clearTimeout(handle);
        }
        catch {
            // 定时器已失效时无需处理
        }
    }
    function arm(id, waitMs, callback) {
        const handle = setTimeout(() => {
            timers.delete(id);
            if (disposed)
                return;
            callback();
        }, Math.max(0, waitMs));
        timers.set(id, handle);
    }
    function scheduleSoon(id) {
        clearTimer(id);
        if (disposed)
            return;
        const record = items.get(id);
        if (!record || record.status !== 'pending')
            return;
        arm(id, 0, () => fire(id));
    }
    function scheduleAt(id) {
        clearTimer(id);
        if (disposed)
            return;
        const record = items.get(id);
        if (!record || record.status !== 'pending')
            return;
        const delay = record.dueAt - clock.now();
        if (delay <= GRACE_MS) {
            scheduleSoon(id);
            return;
        }
        if (delay <= MAX_TIMER_MS) {
            arm(id, delay, () => fire(id));
            return;
        }
        // 超过 24h 的提醒先挂 24h，到点后重新评估、重挂。
        arm(id, MAX_TIMER_MS, () => {
            const current = items.get(id);
            if (!current || current.status !== 'pending')
                return;
            if (current.dueAt - clock.now() > 0)
                scheduleAt(id);
            else
                fire(id);
        });
    }
    function fire(id) {
        if (disposed)
            return false;
        const record = items.get(id);
        if (!record || record.status !== 'pending')
            return false;
        clearTimer(id);
        record.status = 'fired';
        record.firedAt = clock.now();
        record.endedAt = record.firedAt;
        finishedSeq += 1;
        record.finishedSeq = finishedSeq;
        const event = toPublic(record);
        pruneFinished();
        persist();
        dispatch(event);
        return true;
    }
    function dispatch(event) {
        if (disposed)
            return;
        if (listeners.size === 0) {
            buffered.push(event);
            if (buffered.length > MAX_BUFFERED_EVENTS) {
                buffered.splice(0, buffered.length - MAX_BUFFERED_EVENTS);
            }
            return;
        }
        notify(event);
    }
    function notify(event) {
        for (const listener of [...listeners]) {
            try {
                const result = listener(event);
                if (result && typeof result.then === 'function' && typeof result.catch === 'function') {
                    result.catch((err) => safeLog('warn', '[reminder] onDue 监听器执行失败', err));
                }
            }
            catch (err) {
                safeLog('warn', '[reminder] onDue 监听器执行失败', err);
            }
        }
    }
    function flushBuffered() {
        if (disposed || listeners.size === 0 || buffered.length === 0)
            return;
        const batch = buffered.splice(0, buffered.length);
        const handle = setTimeout(() => {
            auxTimers.delete(handle);
            if (disposed)
                return;
            if (listeners.size === 0) {
                buffered.unshift(...batch);
                if (buffered.length > MAX_BUFFERED_EVENTS) {
                    buffered.splice(0, buffered.length - MAX_BUFFERED_EVENTS);
                }
                return;
            }
            for (const event of batch)
                notify(event);
        }, 0);
        auxTimers.add(handle);
    }
    // ---- 清理已结束记录 ----
    function pruneFinished() {
        const finished = [];
        for (const record of items.values()) {
            if (record.status !== 'pending')
                finished.push(record);
        }
        if (finished.length <= MAX_FINISHED)
            return;
        finished.sort((a, b) => (b.finishedSeq || 0) - (a.finishedSeq || 0) ||
            endedAtOf(b) - endedAtOf(a) ||
            compareId(b.id, a.id));
        for (let index = MAX_FINISHED; index < finished.length; index += 1) {
            const record = finished[index];
            clearTimer(record.id);
            items.delete(record.id);
        }
    }
    // ---- 输入解析 ----
    function computeDueAt(input) {
        const hasInSeconds = input.inSeconds !== undefined && input.inSeconds !== null;
        if (hasInSeconds) {
            const seconds = Number(input.inSeconds);
            if (!Number.isFinite(seconds) ||
                seconds < MIN_IN_SECONDS ||
                seconds > MAX_IN_SECONDS) {
                throw new Error('提醒时间无效');
            }
            return clock.now() + Math.round(seconds * 1000);
        }
        const at = input.at;
        let dueAt = NaN;
        if (typeof at === 'number') {
            dueAt = at;
        }
        else if (typeof at === 'string' && at.trim().length > 0) {
            dueAt = Date.parse(at.trim());
        }
        if (!Number.isFinite(dueAt))
            throw new Error('提醒时间无效');
        return dueAt;
    }
    function normalizeText(value) {
        if (typeof value !== 'string')
            throw new Error('提醒内容无效');
        const text = value.trim();
        if (text.length === 0)
            throw new Error('提醒内容无效');
        return text;
    }
    // ---- 启动恢复（异步进行，读写方法会等待它） ----
    const ready = restore().catch((err) => {
        safeLog('error', '[reminder] 恢复提醒数据失败', err);
    });
    // ---- 对外接口 ----
    async function add(input) {
        if (disposed)
            throw new Error('提醒模块已关闭');
        await ready;
        if (disposed)
            throw new Error('提醒模块已关闭');
        const source = input && typeof input === 'object' ? input : {};
        const dueAt = computeDueAt(source);
        const text = normalizeText(source.text);
        if (countPending() >= maxPending) {
            throw new Error('待触发的提醒太多了，先等几条响过吧');
        }
        const createdAt = clock.now();
        const record = {
            id: randomUUID(),
            text,
            dueAt,
            status: 'pending',
            createdAt,
        };
        items.set(record.id, record);
        const result = toPublic(record);
        await persist();
        if (disposed)
            return result;
        if (dueAt <= createdAt + GRACE_MS)
            scheduleSoon(record.id);
        else
            scheduleAt(record.id);
        return result;
    }
    async function list() {
        await ready;
        const rows = [];
        for (const record of items.values())
            rows.push(toPublic(record));
        rows.sort((a, b) => a.dueAt - b.dueAt || a.createdAt - b.createdAt || compareId(a.id, b.id));
        return rows;
    }
    async function cancel(id) {
        await ready;
        if (disposed)
            return false;
        if (typeof id !== 'string')
            return false;
        const record = items.get(id);
        if (!record || record.status !== 'pending')
            return false;
        clearTimer(id);
        record.status = 'cancelled';
        record.endedAt = clock.now();
        finishedSeq += 1;
        record.finishedSeq = finishedSeq;
        pruneFinished();
        await persist();
        return true;
    }
    function onDue(listener) {
        if (typeof listener !== 'function') {
            throw new TypeError('onDue 需要传入函数');
        }
        if (disposed)
            return () => { };
        listeners.add(listener);
        flushBuffered();
        return () => {
            listeners.delete(listener);
        };
    }
    function health() {
        return { ok: true, pending: countPending() };
    }
    async function dispose() {
        if (!disposed) {
            disposed = true;
            for (const handle of timers.values()) {
                try {
                    clearTimeout(handle);
                }
                catch {
                    // 忽略已失效的句柄
                }
            }
            timers.clear();
            for (const handle of auxTimers) {
                try {
                    clearTimeout(handle);
                }
                catch {
                    // 忽略已失效的句柄
                }
            }
            auxTimers.clear();
            listeners.clear();
            buffered.length = 0;
        }
        try {
            await writeChain;
        }
        catch {
            // writeChain 内部已记录错误
        }
    }
    return Object.freeze({
        name: 'reminder',
        version: '0.1.0',
        health,
        add,
        list,
        cancel,
        onDue,
        dispose,
    });
}
