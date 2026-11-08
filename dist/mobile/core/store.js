// @ts-nocheck
/**
 * 极简持久化（core/store.js）
 *
 * 一个 JSON 文件 + 内存缓存；get/set 都是异步且串行化的，避免并发写坏文件。
 * 写盘用「临时文件 + rename」，进程被杀也不会留下半个文件。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
export function createStore({ filePath, logger = console }) {
    /** @type {{ [key: string]: unknown } | null} */
    let cache = null;
    let loading = null;
    let writing = Promise.resolve();
    async function load() {
        if (cache)
            return cache;
        if (loading)
            return loading;
        loading = (async () => {
            try {
                const raw = await readFile(filePath, 'utf8');
                const parsed = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
                cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
            }
            catch (err) {
                if (err && err.code !== 'ENOENT') {
                    logger.warn?.(`[whale-mobile] 数据文件读取失败，改用空状态：${err.message}`);
                }
                cache = {};
            }
            return cache;
        })();
        return loading;
    }
    async function persist(snapshot) {
        const tmp = join(dirname(filePath), basename(filePath) + '.' + process.pid + '.tmp');
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
        await rename(tmp, filePath);
    }
    async function get(key, fallback = undefined) {
        const data = await load();
        return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback;
    }
    async function set(key, value) {
        const data = await load();
        data[key] = value;
        const snapshot = JSON.parse(JSON.stringify(data));
        writing = writing
            .then(() => persist(snapshot))
            .catch((err) => {
            logger.warn?.(`[whale-mobile] 数据写入失败：${err.message}`);
        });
        await writing;
        return value;
    }
    return Object.freeze({
        get,
        set,
        path: () => filePath,
        flush: () => writing,
    });
}
/** 默认数据目录：$DSH_HOME/whale-mobile/state.json */
export function resolveDataDir({ dataDir, dshHome, homeDir }) {
    const root = dataDir || join(dshHome || join(homeDir, '.dsh'), 'whale-mobile');
    return { root, stateFile: join(root, 'state.json') };
}
