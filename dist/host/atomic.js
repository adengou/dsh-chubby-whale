/**
 * host/atomic.ts —— 文件原子写、编码容错与坏文件隔离（可复用）
 *
 * 用途：store / 说书进度 / 文化去重 / 念诗去重都曾各自手写一份「唯一临时名 + rename」，
 * 这里是唯一实现：写 .tmp → fsync（仅 POSIX）→ rename 覆盖，失败清掉临时文件。
 * 读坏文件统一「改名成 .bad-<时间戳> 备份 + 记日志」，调用方随后走默认值。
 *
 * 跨平台约定（Windows / Linux / macOS）：
 *   · 临时文件名唯一（pid + 随机串），rename 覆盖目标；POSIX 与 Windows 均支持覆盖已存在文件。
 *   · rename 在 Windows 上偶发 EPERM / EACCES / EBUSY（杀毒、索引、文件被其他句柄占用），
 *     这里做有限次重试（3 次、间隔 20ms），最终失败仍抛错并清理临时文件。
 *   · fsync 只在 POSIX 执行：Windows 的 FlushFileBuffers 语义与代价不同，且 dsh 进程崩溃
 *     不要求缓存落盘，跳过它避免每次写盘都多一次同步等待。
 *   · 权限位（0600 / 0700）只在 POSIX 收紧；Windows 没有对应语义，全部跳过（失败一律静默）。
 *   · 读入容错 UTF-8 BOM（PowerShell 5.1 的 -Encoding UTF8 会写 BOM），写出统一 UTF-8 无 BOM。
 */
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, existsSync, chmodSync, readFileSync, } from 'node:fs';
import { dirname } from 'node:path';
/** rename 失败后的重试次数（不含首次尝试）与间隔（毫秒） */
const RENAME_RETRY_LIMIT = 3;
const RENAME_RETRY_DELAY_MS = 20;
/** 只对「瞬时占用类」错误重试；ENOENT / ENOSPC 之类重试也没用，立即抛给调用方 */
const RETRIABLE_RENAME_CODES = ['EPERM', 'EACCES', 'EBUSY'];
/** 共享的等待数组：Atomics.wait 需要 TypedArray，复用一份避免每次重试都分配 */
let renameWaiter = null;
/** 同步小睡（原子写是同步 API，不能为 20ms 把调用方改成异步） */
function sleepSync(ms) {
    if (!(ms > 0))
        return;
    try {
        if (!renameWaiter)
            renameWaiter = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(renameWaiter, 0, 0, ms);
    }
    catch {
        // 极端环境禁用 Atomics.wait 时退化为忙等：保证仍是「间隔 20ms 重试」，不改变重试语义
        const end = Date.now() + ms;
        while (Date.now() < end) { /* spin */ }
    }
}
/** 该错误是否值得重试 rename（Windows 占用类错误） */
export function isRetriableRenameError(err) {
    const code = err && err.code;
    return typeof code === 'string' && RETRIABLE_RENAME_CODES.indexOf(code) >= 0;
}
/**
 * 带重试的 rename。依赖注入 rename 动作，便于离线单测（真实调用同步 renameSync）。
 * @param rename 实际执行 rename 的同步函数
 * @param opts.retries 重试次数上限（默认 3，即最多调用 1+3 次）
 * @param opts.delayMs 每次重试前的等待（默认 20ms）
 */
export function renameWithRetry(rename, opts) {
    const retries = opts && typeof opts.retries === 'number' ? opts.retries : RENAME_RETRY_LIMIT;
    const delayMs = opts && typeof opts.delayMs === 'number' ? opts.delayMs : RENAME_RETRY_DELAY_MS;
    let attempt = 0;
    for (;;) {
        try {
            rename();
            return;
        }
        catch (err) {
            if (attempt >= retries || !isRetriableRenameError(err))
                throw err;
            attempt++;
            sleepSync(delayMs);
        }
    }
}
/**
 * 当前平台是否有 POSIX 权限位语义（Windows 返回 false）。
 * 单独成函数而不是模块级常量：离线测试可以 mock process.platform 后直接调用验证分支。
 */
export function isPosixModePlatform(platform = process.platform) {
    return platform !== 'win32';
}
/** POSIX 下把文件收成 0600；Windows 跳过；chmod 失败静默（只读文件系统等）。返回是否执行了 chmod */
export function chmodPrivateFile(file) {
    if (!isPosixModePlatform())
        return false;
    try {
        chmodSync(file, 0o600);
        return true;
    }
    catch {
        return false;
    }
}
/** POSIX 下把目录收成 0700；Windows 跳过；失败静默 */
export function chmodPrivateDir(dir) {
    if (!isPosixModePlatform())
        return false;
    try {
        chmodSync(dir, 0o700);
        return true;
    }
    catch {
        return false;
    }
}
/** 建运行数据目录（POSIX 下 0700；Windows 只建目录、不碰权限） */
export function ensurePrivateDir(dir) {
    try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    catch { }
    chmodPrivateDir(dir);
}
/**
 * 剥掉 UTF-8 BOM（U+FEFF）。Node 的 readFileSync(..., 'utf8') 不会自动去掉 BOM，
 * 带 BOM 的 JSON 直接 JSON.parse 会抛「Unexpected token」。
 * 写出侧统一 UTF-8 无 BOM（writeFileSync 写字符串本身不会加 BOM）。
 */
export function stripBom(text) {
    const s = String(text == null ? '' : text);
    return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}
/** 读取 UTF-8 文本并剥掉 BOM（同步；ENOENT 等错误原样抛给调用方判断缺文件） */
export function readTextNoBom(file) {
    return stripBom(readFileSync(file, 'utf8'));
}
/**
 * 原子写文本/Buffer：先建父目录，写唯一临时文件（POSIX 创建即 0600），
 * POSIX 下 fsync 后 rename 覆盖目标；rename 失败按平台重试，最终失败清理临时文件。
 */
export function writeFileAtomic(file, data) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
    // POSIX：创建即 0600（umask 无法把权限放回去）；Windows 忽略 mode 参数
    const fd = openSync(tmp, 'w', 0o600);
    try {
        if (typeof data === 'string')
            writeFileSync(fd, data, 'utf8');
        else
            writeFileSync(fd, data);
        // fsync 只在 POSIX：Windows 按约定跳过（见文件头跨平台约定）
        if (isPosixModePlatform()) {
            try {
                fsyncSync(fd);
            }
            catch { } // 个别文件系统不支持 fsync，失败不当错误
        }
    }
    finally {
        try {
            closeSync(fd);
        }
        catch { }
    }
    chmodPrivateFile(tmp); // 兜底：临时文件若已存在，'w' 会保留旧权限
    try {
        renameWithRetry(() => renameSync(tmp, file));
    }
    catch (err) {
        try {
            unlinkSync(tmp);
        }
        catch { } // 改名失败别留垃圾
        throw err;
    }
}
/** 原子写 JSON（序列化后走字符串版本；JSON.stringify 不会带 BOM） */
export function writeJsonAtomic(file, obj) {
    writeFileAtomic(file, JSON.stringify(obj));
}
/** 文件不存在（首次运行）不算坏文件 */
export function isMissingFileError(err) {
    return Boolean(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'));
}
/**
 * 读坏了：记日志 + 把坏文件改名成 file.bad-<时间戳> 备份，然后调用方走默认值。
 * 只备份一次——改完名下次读就是 ENOENT，不会再重复备份。
 * tag 只用于日志前缀（与各模块原有日志保持一致）。
 *
 * 文件名跨平台：时间戳取 ISO 串后把 `:` 和 `.` 都换成 `-`（如 2026-11-06T09-47-55-123Z），
 * 不含 Windows 禁止的 `: * ? " < > |`，也不含路径分隔符，三平台都能建。改名同样走重试。
 */
export function quarantineFile(file, err, tag = '[file]') {
    console.error(tag + ' 读取失败 file=' + file + ' err=' + String((err && err.message) || err));
    try {
        if (!existsSync(file))
            return;
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const bad = file + '.bad-' + stamp;
        renameWithRetry(() => renameSync(file, bad));
        console.error(tag + ' 坏文件已备份 ' + file + ' → ' + bad);
    }
    catch (err2) {
        console.error(tag + ' 坏文件备份失败 file=' + file + ' err=' + String((err2 && err2.message) || err2));
    }
}
