/**
 * host/data/cloud.ts —— 云端数据源（可选，配置 dataSource=cloud 时启用）
 *
 * 数据来自 https://adengou.cn/culture/v1/（静态 JSON，无需 CORS）：
 *   manifest.json、daily.json、duilian.json、poems/poems-00..14.json、
 *   culture/chengyu.json、culture/idioms.json、culture/minsu-00..09.json、
 *   story/index.json、story/<书名>.json。
 *
 * 诗名索引 / 曲库（2026-11-07 端口收口新增）也按同一口径处理：云端清单里声明了
 * poem-titles.json / melodies.json 就按需拉取，没声明就回退本地实现（包内只读文件）。
 *
 * 策略：
 *   · 按需拉：用到哪本小说/哪类文化/哪片诗才拉哪个文件；
 *   · 内存缓存：拉过的文件留在进程内；清单每 30 秒最多检查一次，
 *     version+generatedAt 变了才清空数据缓存、按新清单重拉（没变就继续用缓存）；
 *   · 并发单飞：同一文件（同一本书/同一片诗/同一类文化）同时来多个请求只下载并
 *     JSON.parse 一次，其余请求共享同一次结果；失败不缓存，下次重新拉；
 *   · 网络失败静默回退本地：同一个故障周期只 console.error 一次，60 秒冷却期内
 *     直接走本地，不反复卡网络；恢复后打一条 recovered 日志。错误绝不抛给路由。
 *   · 数据缺失（清单里没这个文件 / 规范化后为空 / 索引非法）**不算链路故障**：
 *     回退本地，但不进冷却、不刷错误日志（同一 op 只留一条）。否则一本云端缺书
 *     就会把诗词、文化、每日一起拖去本地兜底——局部数据问题被放大成全局降级。
 *
 * 跨平台：这里只有 URL 路径（一律 '/'，不是文件系统路径，无需 join）；
 * 响应体读入容错 UTF-8 BOM，避免 CDN/镜像加 BOM 后整类数据解析失败。
 */
import { stripBom } from '../atomic.js';
import { normalizeCultureItems, normalizeDaily, normalizeDuilian, normalizePoemItems, normalizeStoryChunks, } from './normalize.js';
export const CLOUD_DATA_BASE = 'https://adengou.cn/culture/v1/';
/** 单次请求超时；云端挂了也不能让本地说书/念诗一起卡死 */
const FETCH_TIMEOUT_MS = 10000;
/** 清单检查间隔：30 秒内复用上次检查结果，避免每次念诗都多打一个请求 */
const MANIFEST_TTL_MS = 30000;
/** 失败冷却：这段时间内不再尝试网络，直接回退本地 */
const FAIL_COOLDOWN_MS = 60000;
/** 数据缺失日志的去重表上限：书名列来自外部（云端清单/路由参数），不设上限会被刷爆 */
const MISS_LOG_MAX = 64;
/**
 * 「数据本身不可用」：清单里没有这个文件、规范化后为空、索引非法。
 *
 * 必须与网络故障分开：它重试也不会好，而且判定完全在本地（清单/缓存里就能算出来，
 * 不打网络）。若也进 60 秒冷却，一个读口的局部数据问题会连累其它读口一起降级。
 */
class DataUnavailable extends Error {
    constructor(message) {
        super(message);
        this.name = 'DataUnavailable';
    }
}
/** 抛「数据缺失」（不带冷却）；调用点都在 withFallback 内，由它负责静默回退本地 */
function dataUnavailable(message) {
    throw new DataUnavailable(message);
}
function encodePath(path) {
    return String(path).split('/').map((s) => encodeURIComponent(s)).join('/');
}
export function createCloudDataPort(opts) {
    const local = opts.local;
    const base = String(opts.baseUrl || CLOUD_DATA_BASE).replace(/\/+$/, '') + '/';
    const doFetch = opts.fetchImpl || ((url, init) => fetch(url, init));
    /** 文件路径 → 已解析的 JSON（清单签名变化时整体清空） */
    const fileCache = new Map();
    /**
     * 进程内单飞表：key → 进行中的 Promise（文件下载 / 清单刷新）。
     *
     * 与本地 story/repo.ts 的 inflight 差异及理由：
     *   · repo 的键是「书名 + mtime」，缓存的已经是规范化后的 chunks，去重放在 loadBook 入口；
     *   · 云端没有 mtime，等价的新鲜度信号是清单 version+generatedAt（manifestSig）；
     *     且说书/诗/文化/对联/每日等读口最终都落到按文件下载，所以去重放在
     *     「文件下载 + JSON.parse」这一层：一本书就是 story/<书名>.json，诗是 poems-XX.json。
     *     这样任何读口（含以后新加的）同 key 并发都只打一次网络、只 parse 一次，
     *     而各读口原有的校验、规范化、失败回退语义完全不动。
     *   · 规范化仍由各读口各做一遍（纯函数、只遍历已有数组，开销远小于网络+parse），
     *     避免把可变数组/对象共享给多个调用方（repo 也要 .slice() 就是为了这个）。
     *   · 失败时 Promise 从表里摘掉且不写 fileCache；下次请求重新下载，
     *     是否立刻重试仍由上层 withFallback 的 60 秒冷却决定（该语义未改）。
     */
    const inflight = new Map();
    /** 单本古籍可能几 MB，内存里最多留 2 本（与本地 repo 的 BOOK_CACHE_MAX 一致） */
    const BOOK_CACHE_MAX = 2;
    let manifest = null;
    let manifestSig = '';
    let manifestAt = 0;
    let degradedUntil = 0;
    let failLogged = false;
    /** 数据缺失的日志去重：同一 op 只留一条，清单换代时清空（上限见 MISS_LOG_MAX） */
    const missLogged = new Set();
    function logUnavailable(op, why) {
        if (missLogged.has(op) || missLogged.size >= MISS_LOG_MAX)
            return;
        missLogged.add(op);
        console.warn('[chubby-whale] cloud data unavailable op=' + op + ' why=' + why + ' fallback=local');
    }
    function manifestFiles(m) {
        return Array.isArray(m && m.files) ? m.files : [];
    }
    function hasFile(m, path) {
        return manifestFiles(m).some((f) => f && f.path === path);
    }
    /** 从清单取某类文化文件路径（成语/典故单文件，民间故事 10 个分片） */
    function cultureFiles(m, kind) {
        const all = manifestFiles(m).map((f) => String(f.path || ''));
        if (kind === 'chengyu')
            return all.filter((p) => p === 'culture/chengyu.json');
        if (kind === 'idiom')
            return all.filter((p) => p === 'culture/idioms.json');
        return all.filter((p) => p.startsWith('culture/minsu-')).sort();
    }
    function poemFiles(m) {
        return manifestFiles(m)
            .map((f) => String(f.path || ''))
            .filter((p) => /^poems\/poems-\d+\.json$/.test(p))
            .sort();
    }
    async function fetchJson(path) {
        // 每请求独立超时；finally 清定时器，避免拖住进程/累积计时器
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            // unref：dsh web 关停/重启时，这个 10 秒超时不该把进程退出拖住
            try {
                if (typeof timer.unref === 'function')
                    timer.unref();
            }
            catch { }
            const res = await doFetch(base + encodePath(path), {
                signal: controller.signal,
                headers: { accept: 'application/json' },
            });
            if (!res || !res.ok)
                throw new Error('HTTP ' + String(res && res.status));
            return JSON.parse(stripBom(await res.text()));
        }
        finally {
            clearTimeout(timer);
        }
    }
    /**
     * 单飞去重：同 key 只执行一次 task，后到者复用同一个 Promise。
     * 清理必须放 finally：成功、失败都摘，失败后不会永久挂在表里（避免下一次请求
     * 永远共享一个已失败的 Promise）；只摘自己那条，避免误删后来者。
     */
    function singleFlight(key, task) {
        const running = inflight.get(key);
        if (running)
            return running;
        const p = (async () => {
            try {
                return await task();
            }
            finally {
                if (inflight.get(key) === p)
                    inflight.delete(key);
            }
        })();
        inflight.set(key, p);
        return p;
    }
    /**
     * 拿当前清单：TTL 内直接复用；过期就重新拉 manifest 比对 version+generatedAt。
     * 版本变了才清空已缓存的数据文件；版本没变，清单本身刷新后继续用旧缓存。
     * 清单刷新也走单飞：冷启动时多个读口并发进来，只能打一次 manifest.json。
     */
    async function ensureManifest() {
        if (manifest && Date.now() - manifestAt < MANIFEST_TTL_MS)
            return manifest;
        return singleFlight('@manifest', async () => {
            const m = await fetchJson('manifest.json');
            if (!m || typeof m !== 'object' || !Array.isArray(m.files))
                throw new Error('bad manifest');
            const sig = String(m.version || '') + '|' + String(m.generatedAt || '');
            if (!manifest || sig !== manifestSig) {
                manifest = m;
                manifestSig = sig;
                fileCache.clear();
                missLogged.clear();
                console.log('[chubby-whale] cloud data manifest ' + (m.version || 'v?') + ' @ ' + (m.generatedAt || '?'));
            }
            else {
                // 版本没变：清单对象刷新到最新，但已缓存的数据文件继续用
                manifest = m;
            }
            manifestAt = Date.now();
            return manifest;
        });
    }
    /** 古籍正文缓存做 LRU：命中时移到末尾，写入后超上限丢最早的一本 */
    function cacheBookTouch(path) {
        if (!path.startsWith('story/') || path === 'story/index.json')
            return;
        const value = fileCache.get(path);
        fileCache.delete(path);
        fileCache.set(path, value);
        while (true) {
            const books = Array.from(fileCache.keys()).filter((k) => k.startsWith('story/') && k !== 'story/index.json');
            if (books.length <= BOOK_CACHE_MAX)
                break;
            fileCache.delete(books[0]);
        }
    }
    /**
     * 按清单读一个文件（只读清单里声明过的路径，避免拼出任意 URL）。
     *
     * 并发去重放在这一层：同一路径的并发请求只下载一次、只 JSON.parse 一次，
     * 后到者共享同一个 Promise；成功才写 fileCache（沿用原缓存策略），
     * 失败既不写缓存也会在 finally 里摘掉 inflight，下一轮请求重新试。
     *
     * key 里带清单签名（manifestSig），与本地 repo「书 + mtime」同理：清单换代后
     * 旧快照的下载不能被新请求复用；同一份快照内的并发请求才共享。
     * 下载期间清单换代了，则这份旧快照数据只回给当前等待者、不写回缓存，
     * 否则新清单下会读到上一版内容（下次请求会按新清单重拉）。
     */
    async function readFile(path) {
        const m = await ensureManifest();
        if (!hasFile(m, path))
            dataUnavailable('not in manifest: ' + path);
        if (fileCache.has(path)) {
            cacheBookTouch(path);
            return fileCache.get(path);
        }
        const sig = manifestSig;
        return singleFlight(sig + '|' + path, async () => {
            const data = await fetchJson(path);
            if (manifestSig === sig) {
                fileCache.set(path, data);
                cacheBookTouch(path);
            }
            return data;
        });
    }
    /**
     * 云端调用 + 失败回退。
     * 链路故障：同一个故障周期只打一次 CLOUD-DATA-FAIL，60 秒冷却期内直接走本地。
     * 数据缺失（DataUnavailable）：静默回退本地、不进冷却、同一 op 只留一条 warn（见文件头）。
     */
    async function withFallback(op, remote, fallback) {
        if (Date.now() < degradedUntil)
            return fallback();
        try {
            const out = await remote();
            if (failLogged) {
                console.log('[chubby-whale] cloud data recovered');
                failLogged = false;
                degradedUntil = 0;
            }
            return out;
        }
        catch (err) {
            // 数据缺失不是链路故障：重试不会好，而且判定在本地（清单/缓存里就能算出来，不打网络），
            // 这里绝不设冷却——否则一本云端缺书会让诗词/文化/每日一起降级 60 秒
            if (err instanceof DataUnavailable) {
                logUnavailable(op, String(err.message || err));
                return fallback();
            }
            if (!failLogged) {
                console.error('CLOUD-DATA-FAIL op=' + op + ' err=' + String(err?.message || err) + ' fallback=local');
                failLogged = true;
            }
            degradedUntil = Date.now() + FAIL_COOLDOWN_MS;
            return fallback();
        }
    }
    async function readStoryIndex() {
        return withFallback('readStoryIndex', async () => {
            const raw = await readFile('story/index.json');
            const books = Array.isArray(raw && raw.books) ? raw.books : [];
            const out = [];
            for (const b of books) {
                const book = String(b && b.book || '').trim();
                if (!book)
                    continue;
                const meta = { book };
                if (b.file)
                    meta.file = String(b.file);
                if (b.author)
                    meta.author = String(b.author);
                if (Number.isFinite(Number(b.bytes)))
                    meta.bytes = Number(b.bytes);
                if (Array.isArray(b.chapters))
                    meta.chapters = b.chapters;
                out.push(meta);
            }
            if (out.length === 0)
                dataUnavailable('story index empty');
            return out;
        }, () => local.readStoryIndex());
    }
    async function readStoryBook(book) {
        // 同一本书的并发下载由 readFile('story/<书名>.json') 单飞去重（见 readFile 注释），
        // 对应本地 repo.loadBook 的 inflight；这里只做校验、规范化与失败回退。
        return withFallback('readStoryBook:' + book, async () => {
            const name = String(book || '').trim();
            if (!name)
                dataUnavailable('empty book name');
            const raw = await readFile('story/' + name + '.json');
            const chunks = normalizeStoryChunks(name, raw);
            if (chunks.length === 0)
                dataUnavailable('story book empty');
            return chunks;
        }, () => local.readStoryBook(book));
    }
    async function readCulture(kind) {
        return withFallback('readCulture:' + kind, async () => {
            const m = await ensureManifest();
            const files = cultureFiles(m, kind);
            if (files.length === 0)
                dataUnavailable('no cloud file for ' + kind);
            const items = [];
            for (const file of files) {
                const raw = await readFile(file);
                const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.items) ? raw.items : []);
                for (const it of arr)
                    items.push(it);
            }
            const out = normalizeCultureItems(kind, items);
            if (out.length === 0)
                dataUnavailable('culture data empty: ' + kind);
            return out;
        }, () => local.readCulture(kind));
    }
    async function readPoemsChunk(index) {
        const i = Number(index) || 0;
        return withFallback('readPoemsChunk:' + i, async () => {
            if (!Number.isInteger(i) || i < 0)
                dataUnavailable('bad chunk index: ' + String(index));
            const m = await ensureManifest();
            const path = 'poems/poems-' + String(i).padStart(2, '0') + '.json';
            if (!hasFile(m, path))
                dataUnavailable('not in manifest: ' + path);
            const raw = await readFile(path);
            const items = normalizePoemItems(raw && raw.items);
            if (items.length === 0)
                dataUnavailable('poem chunk empty');
            return {
                index: Number.isFinite(Number(raw && raw.index)) ? Number(raw.index) : i,
                total: Number(raw && raw.total) || poemFiles(m).length || 1,
                items,
            };
        }, () => local.readPoemsChunk(index));
    }
    async function readDuilian() {
        return withFallback('readDuilian', async () => {
            const raw = await readFile('duilian.json');
            const out = normalizeDuilian(raw);
            if (out.items.length === 0)
                dataUnavailable('duilian empty');
            return out;
        }, () => local.readDuilian());
    }
    async function readDaily() {
        return withFallback('readDaily', async () => {
            const raw = await readFile('daily.json');
            const out = normalizeDaily(raw);
            if (out.length === 0)
                dataUnavailable('daily empty');
            return out;
        }, () => local.readDaily());
    }
    /**
     * 回退到本地实现的可选端口方法：老宿主 / 测试假端口可能没实现 readPoemTitles /
     * readMelodies（DataPort 上它们是可选方法）。缺失或抛错都按「本地也没数据」（null）
     * 处理，绝不把异常带出数据层——路由拿到的不是数据就是 null。
     */
    async function localOrNull(read) {
        if (typeof read !== 'function')
            return null;
        try {
            return await read.call(local);
        }
        catch {
            return null;
        }
    }
    /**
     * 诗名索引：云端清单声明了 poem-titles.json 就取云端，否则回退本地包内文件。
     * 清单没声明属于「数据缺失」（DataUnavailable）：静默回退、不进 60 秒冷却；
     * 坏 JSON / 网络失败走链路失败分支：记 CLOUD-DATA-FAIL 后回退本地，绝不抛。
     */
    async function readPoemTitles() {
        return withFallback('readPoemTitles', async () => {
            const raw = await readFile('poem-titles.json');
            const titles = [];
            if (raw && Array.isArray(raw.titles)) {
                for (const item of raw.titles)
                    if (typeof item === 'string' && item)
                        titles.push(item);
            }
            if (titles.length === 0)
                dataUnavailable('poem titles empty');
            return { titles };
        }, () => localOrNull(local.readPoemTitles));
    }
    /**
     * 曲库：云端清单声明了 melodies.json 就取云端，否则回退本地。
     * 返回顶层浅拷贝 + 新 songs 数组：fileCache 里的原始 parse 结果不直接递给路由
     * （与 normalize 系列同一条所有权纪律）。非对象结构按数据缺失处理。
     */
    async function readMelodies() {
        return withFallback('readMelodies', async () => {
            const raw = await readFile('melodies.json');
            if (!raw || typeof raw !== 'object')
                dataUnavailable('melodies bad structure');
            const songs = Array.isArray(raw.songs)
                ? raw.songs.filter((s) => s && typeof s === 'object').map((s) => ({ ...s }))
                : [];
            return { ...raw, songs };
        }, () => localOrNull(local.readMelodies));
    }
    return {
        readStoryIndex, readStoryBook, readCulture, readPoemsChunk, readDuilian, readDaily,
        readPoemTitles, readMelodies,
    };
}
