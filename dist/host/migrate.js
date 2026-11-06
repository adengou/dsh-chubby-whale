/**
 * host/migrate.ts —— 运行数据迁移（插件 data/ → 运行时目录）
 *
 * 只在目标不存在时拷贝，绝不覆盖用户现有数据；失败静默（环境差异）。
 * 从 index.ts 抽出：架构宪章要求 index 只做组装。
 *
 * 2026-11-07（B74）加固，两处都是“半途失败留下坏状态”的坑：
 *   · 先拷到同目录唯一临时名，再原子改名到位：copyFileSync 写到一半失败（磁盘满 / 进程被杀）
 *     不会在目标位置留半截文件。旧实现直接写目标，半截文件还能被解析成坏 JSON；
 *     更糟的是下次启动会因「目标已存在」把它永久当成“已迁移”，再也不会重试。
 *   · 落地用 link 优先、rename 兜底：link 天然 EEXIST，两个实例（主实例与临时 3099 实例）
 *     共用同一个运行目录时，不会把对方刚写出的新数据用插件包里的旧副本盖掉。
 *     link 不可用（跨卷 / FAT / exFAT）时退回“先查存在再改名”，只保留极小的竞态窗口。
 *   · 缓存目录整目录迁移同样走临时目录 + 改名。
 */
import { existsSync, mkdirSync, copyFileSync, cpSync, linkSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
/** 需要迁移的运行数据文件（都在插件包 data/ 根下） */
const MIGRATED_FILES = [
    'memory.json', 'state.json', 'growth.json', 'fishfood.json', 'reminders.json',
    'story_progress.json', 'culture-seen.json', 'poem-seen.json', 'pet_state.json',
];
/** 临时名：与目标同目录（保证 rename 不跨卷），进程 + 随机串保证并发实例不撞名 */
function tempNameFor(dst) {
    return dst + '.migrating-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
}
function discard(path) {
    try {
        rmSync(path, { recursive: true, force: true });
    }
    catch { }
}
/**
 * 把临时副本原子落到目标位置；目标已存在时返回 false（绝不覆盖用户数据）。
 * 成功/失败都不会留下临时名：link 成功后临时名只是第二个硬链接，删掉目录项即可。
 */
function placeIfAbsent(tmp, dst) {
    try {
        linkSync(tmp, dst);
        discard(tmp);
        return true;
    }
    catch (err) {
        if (err && err.code === 'EEXIST') {
            discard(tmp);
            return false;
        }
    }
    // 目录不支持 link，部分文件系统（FAT/exFAT/跨卷）也不支持：退回“先查存在再改名”
    if (existsSync(dst)) {
        discard(tmp);
        return false;
    }
    renameSync(tmp, dst);
    return true;
}
/** 单个文件迁移：源存在且目标不存在才动手；任何失败都只清临时文件，不抛给插件加载 */
function migrateFile(src, dst, copyFile, label) {
    try {
        if (!existsSync(src) || existsSync(dst))
            return;
        const tmp = tempNameFor(dst);
        try {
            copyFile(src, tmp);
            if (placeIfAbsent(tmp, dst))
                console.log('[chubby-whale] 迁移运行数据 ' + label + ' → ' + dst);
        }
        catch {
            discard(tmp);
        }
    }
    catch { }
}
/** 缓存目录迁移：与文件同一套“临时 + 原子落地”，部分拷贝不会留在 cache/ 里 */
function migrateDir(src, dst, copyDir, label) {
    try {
        if (!existsSync(src) || existsSync(dst))
            return;
        const tmp = tempNameFor(dst);
        try {
            copyDir(src, tmp);
            if (placeIfAbsent(tmp, dst))
                console.log('[chubby-whale] ' + label + ' → ' + dst);
        }
        catch {
            discard(tmp);
        }
    }
    catch { }
}
export function migrateRuntimeData(dataDir, runtimeDir, io) {
    const copyFile = (io && io.copyFile) || copyFileSync;
    const copyDir = (io && io.copyDir) || ((src, dst) => cpSync(src, dst, { recursive: true }));
    try {
        mkdirSync(runtimeDir, { recursive: true });
    }
    catch { }
    for (const f of MIGRATED_FILES)
        migrateFile(join(dataDir, f), join(runtimeDir, f), copyFile, f);
    migrateDir(join(dataDir, 'cache'), join(runtimeDir, 'cache'), copyDir, '迁移缓存');
}
