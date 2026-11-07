/**
 * host/auto-backup.ts —— 运行数据自动定时备份（2026-11-06 新增）
 *
 * 为什么：memory / personality / state / growth 这些是主人积累的"鱼的数据"，
 * 手动导出容易忘；这里每小时自动留一份快照，保留最近 N 份（默认 7）。
 *
 * 口径：
 *   · 只读运行数据文件、写到 RUNTIME_DIR/backup/ 目录（不进插件包、不碰 data/）；
 *   · 一份备份 = 一个 JSON（{ at, files: { 文件名: 内容 } }），失败静默（绝不因备份失败影响插件）；
 *   · 保留策略按文件名（auto-时间戳）排序删旧，最多 keep 份；
 *     诊断口径（autoBackupInfo.lastAt）也从文件名取时间——两处同一真源（坑 28），
 *     备份目录被整体拷贝/恢复过（mtime 变成恢复时间）时不会与裁剪口径打架；
 *   · 快照走 atomic.ts 的原子写：进程被杀不会留半截 JSON 假装是“一份备份”，
 *     再借裁剪把好的旧份挤掉；
 *   · setInterval 加 unref（不拖住进程退出）；启动时先备一份，之后每小时一次。
 *   · 时钟异常先归一（2026-11-07 B99）：非有限数/超出 Date 范围的毫秒按“现在”处理，
 *     否则文件名会变成 auto-NaN...，按字符串排序反而顶掉真正的新备份（见 normalizeNow）。
 *   · 同一定时器只允许一份（2026-11-07 B74）：装配层用 `ctx.effect` 登记清理器
 *     （**不是** `ctx.on('dispose')` —— cordis 没有该事件，卸载只派发 internal/plugin，
 *     详见 docs/坑.md 坑 11）。这里再按运行目录去重作为第二道防线：重复 start 先停旧的，
 *     保证热重载/禁用再启用时不会一次比一次多出定时器、也不会在插件停用后继续叠写备份。
 *
 * 兼容：宿主侧改动要重启 dsh web 才生效；备份目录只增不减（除旧份）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeFileAtomic } from './atomic.js';
/** 需要备份的运行数据文件（都在 RUNTIME_DIR 根下） */
export const AUTO_BACKUP_FILES = [
    'memory.json',
    'personality.json',
    'state.json',
    'growth.json',
    'fishfood.json',
    'reminders.json',
    'story_progress.json',
    'pet_state.json',
    'prefs.json',
];
/** 备份目录名 */
export const AUTO_BACKUP_DIR = 'backup';
/** setInterval 允许的最大延时；超过会被 Node 折成 1ms（TimeoutOverflowWarning），变成疯狂写盘 */
const MAX_TIMER_MS = 2147483647;
/** JS Date 能表示的最大毫秒（±8.64e15）；越界后 getFullYear() 等返回 NaN（Invalid Date） */
const MAX_DATE_MS = 8.64e15;
/**
 * 时间源归一：非有限数（时钟异常 / 注入的 now 给了 NaN）或超出 Date 表示范围的毫秒，
 * 一律按“现在”处理。
 *
 * 为什么必须挡（审计修复 2026-11-07 B99）：stamp() 直接拿毫秒构造 Date，
 * `nan` 会让 6 个时间字段全变 NaN、文件名成 `auto-NaNNaNNaN-NaNNaNNaN.json`。
 * 这个文件名以字母 N 开头，按字符串排序时排在 `auto-2026...` **之后**，
 * 于是裁剪把它当成“最新的一份”保留，反而把真正的新备份当旧份删掉；
 * 快照里的 `at` 还会被 JSON.stringify 写成 null（autoBackupInfo 只能退回 mtime）。
 * 时钟异常不该改变保留策略——宁可记成“现在”，也不让一份坏名字把整摞备份顶掉。
 */
function normalizeNow(ms) {
    const n = Number(ms);
    return Number.isFinite(n) && Math.abs(n) <= MAX_DATE_MS ? n : Date.now();
}
/** 时间戳 → auto-YYYYMMDD-HHmmss（文件名安全，无冒号） */
function stamp(ms) {
    const d = new Date(ms);
    const p = (n) => (n < 10 ? '0' + n : String(n));
    return 'auto-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
/** 从备份文件名反解时间（与裁剪同一口径）；解析不出返回 0 */
function stampMs(name) {
    const m = /^auto-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.json$/.exec(name);
    if (!m)
        return 0;
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
    return Number.isFinite(t) ? t : 0;
}
/** 立即备份一次，返回是否写成功（失败静默，不抛） */
export function backupOnce(opts) {
    try {
        const dir = join(opts.runtimeDir, AUTO_BACKUP_DIR);
        try {
            mkdirSync(dir, { recursive: true });
        }
        catch { }
        const files = {};
        let any = false;
        for (const name of AUTO_BACKUP_FILES) {
            try {
                const p = join(opts.runtimeDir, name);
                if (!existsSync(p))
                    continue;
                files[name] = readFileSync(p, 'utf8');
                any = true;
            }
            catch { }
        }
        if (!any)
            return false;
        // 时钟异常归一后再用：文件名与快照里的 at 必须共用同一个可信时间（见 normalizeNow）
        const nowMs = normalizeNow((opts.now || (() => Date.now()))());
        const out = join(dir, stamp(nowMs) + '.json');
        // 同一秒内重复备份：覆盖同名文件即可（幂等）
        writeFileAtomic(out, JSON.stringify({ at: nowMs, files }));
        // 保留最近 keep 份（按文件名排序 = 时间顺序）
        const keep = Math.max(1, Number(opts.keep) || 7);
        let list = [];
        try {
            list = readdirSync(dir).filter((f) => /^auto-.*\.json$/.test(f)).sort();
        }
        catch { }
        while (list.length > keep) {
            const old = list.shift();
            if (!old)
                break;
            try {
                rmSync(join(dir, old), { force: true });
            }
            catch { }
        }
        return true;
    }
    catch {
        return false;
    }
}
/** 备份目录的现状（最近时间与份数；诊断面板用） */
export function autoBackupInfo(runtimeDir) {
    try {
        const dir = join(runtimeDir, AUTO_BACKUP_DIR);
        if (!existsSync(dir))
            return { lastAt: 0, count: 0 };
        const list = readdirSync(dir).filter((f) => /^auto-.*\.json$/.test(f));
        let lastAt = 0;
        let lastMtime = 0;
        for (const f of list) {
            // 口径与裁剪一致：时间优先取文件名里的时间戳；文件名不合规（手工放进去的）才退回 mtime
            const named = stampMs(f);
            if (named > lastAt)
                lastAt = named;
            if (named > 0)
                continue;
            try {
                const st = statSync(join(dir, f));
                if (st.mtimeMs > lastMtime)
                    lastMtime = st.mtimeMs;
            }
            catch { }
        }
        return { lastAt: lastAt || lastMtime, count: list.length };
    }
    catch {
        return { lastAt: 0, count: 0 };
    }
}
/** 运行目录 → 停止函数：同一定时器只留一份（见文件头 2026-11-07 说明） */
const activeBackupTimers = new Map();
/**
 * 启动自动备份：立即备一份，之后每 intervalMs 一份。
 * 返回停止函数（插件 dispose 时调用，别让定时器挂着）。
 * 同一运行目录重复调用会先停掉上一份定时器，不会叠加；停止函数可安全重复调用。
 * 定时器 unref：不拖住宿主进程退出。
 */
export function startAutoBackup(opts) {
    const key = resolve(opts.runtimeDir);
    const prev = activeBackupTimers.get(key);
    if (prev) {
        try {
            prev();
        }
        catch { }
    }
    const intervalMs = Math.min(MAX_TIMER_MS, Math.max(60_000, Number(opts.intervalMs) || 3600_000));
    try {
        backupOnce(opts);
    }
    catch { }
    const timer = setInterval(() => { try {
        backupOnce(opts);
    }
    catch { } }, intervalMs);
    try {
        if (typeof timer.unref === 'function')
            timer.unref();
    }
    catch { }
    const stop = () => {
        try {
            clearInterval(timer);
        }
        catch { }
        if (activeBackupTimers.get(key) === stop)
            activeBackupTimers.delete(key);
    };
    activeBackupTimers.set(key, stop);
    return stop;
}
