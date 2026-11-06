/**
 * host/data/cloud.ts —— 云端数据源（可选，配置 dataSource=cloud 时启用）
 *
 * 数据来自 https://adengou.cn/culture/v1/（静态 JSON，无需 CORS）：
 *   manifest.json、daily.json、duilian.json、poems/poems-00..14.json、
 *   culture/chengyu.json、culture/idioms.json、culture/minsu-00..09.json、
 *   story/index.json、story/<书名>.json。
 *
 * 策略：
 *   · 按需拉：用到哪本小说/哪类文化/哪片诗才拉哪个文件；
 *   · 内存缓存：拉过的文件留在进程内；清单每 30 秒最多检查一次，
 *     version+generatedAt 变了才清空数据缓存、按新清单重拉（没变就继续用缓存）；
 *   · 网络失败静默回退本地：同一个故障周期只 console.error 一次，60 秒冷却期内
 *     直接走本地，不反复卡网络；恢复后打一条 recovered 日志。错误绝不抛给路由。
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
function encodePath(path) {
    return String(path).split('/').map((s) => encodeURIComponent(s)).join('/');
}
export function createCloudDataPort(opts) {
    const local = opts.local;
    const base = String(opts.baseUrl || CLOUD_DATA_BASE).replace(/\/+$/, '') + '/';
    const doFetch = opts.fetchImpl || ((url, init) => fetch(url, init));
    /** 文件路径 → 已解析的 JSON（清单签名变化时整体清空） */
    const fileCache = new Map();
    /** 单本古籍可能几 MB，内存里最多留 2 本（与本地 repo 的 BOOK_CACHE_MAX 一致） */
    const BOOK_CACHE_MAX = 2;
    let manifest = null;
    let manifestSig = '';
    let manifestAt = 0;
    let degradedUntil = 0;
    let failLogged = false;
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
     * 拿当前清单：TTL 内直接复用；过期就重新拉 manifest 比对 version+generatedAt。
     * 版本变了才清空已缓存的数据文件；版本没变，清单本身刷新后继续用旧缓存。
     */
    async function ensureManifest() {
        if (manifest && Date.now() - manifestAt < MANIFEST_TTL_MS)
            return manifest;
        const m = await fetchJson('manifest.json');
        if (!m || typeof m !== 'object' || !Array.isArray(m.files))
            throw new Error('bad manifest');
        const sig = String(m.version || '') + '|' + String(m.generatedAt || '');
        if (!manifest || sig !== manifestSig) {
            manifest = m;
            manifestSig = sig;
            fileCache.clear();
            console.log('[chubby-whale] cloud data manifest ' + (m.version || 'v?') + ' @ ' + (m.generatedAt || '?'));
        }
        else {
            // 版本没变：清单对象刷新到最新，但已缓存的数据文件继续用
            manifest = m;
        }
        manifestAt = Date.now();
        return manifest;
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
    /** 按清单读一个文件（只读清单里声明过的路径，避免拼出任意 URL） */
    async function readFile(path) {
        const m = await ensureManifest();
        if (!hasFile(m, path))
            throw new Error('not in manifest: ' + path);
        if (fileCache.has(path)) {
            cacheBookTouch(path);
            return fileCache.get(path);
        }
        const data = await fetchJson(path);
        fileCache.set(path, data);
        cacheBookTouch(path);
        return data;
    }
    /**
     * 云端调用 + 失败回退。
     * 同一个故障周期只打一次 CLOUD-DATA-FAIL；冷却期内直接走本地。
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
                throw new Error('story index empty');
            return out;
        }, () => local.readStoryIndex());
    }
    async function readStoryBook(book) {
        return withFallback('readStoryBook:' + book, async () => {
            const name = String(book || '').trim();
            if (!name)
                throw new Error('empty book name');
            const raw = await readFile('story/' + name + '.json');
            const chunks = normalizeStoryChunks(name, raw);
            if (chunks.length === 0)
                throw new Error('story book empty');
            return chunks;
        }, () => local.readStoryBook(book));
    }
    async function readCulture(kind) {
        return withFallback('readCulture:' + kind, async () => {
            const m = await ensureManifest();
            const files = cultureFiles(m, kind);
            if (files.length === 0)
                throw new Error('no cloud file for ' + kind);
            const items = [];
            for (const file of files) {
                const raw = await readFile(file);
                const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.items) ? raw.items : []);
                for (const it of arr)
                    items.push(it);
            }
            const out = normalizeCultureItems(kind, items);
            if (out.length === 0)
                throw new Error('culture data empty: ' + kind);
            return out;
        }, () => local.readCulture(kind));
    }
    async function readPoemsChunk(index) {
        const i = Number(index) || 0;
        return withFallback('readPoemsChunk:' + i, async () => {
            if (!Number.isInteger(i) || i < 0)
                throw new Error('bad chunk index');
            const m = await ensureManifest();
            const path = 'poems/poems-' + String(i).padStart(2, '0') + '.json';
            if (!hasFile(m, path))
                throw new Error('not in manifest: ' + path);
            const raw = await readFile(path);
            const items = normalizePoemItems(raw && raw.items);
            if (items.length === 0)
                throw new Error('poem chunk empty');
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
                throw new Error('duilian empty');
            return out;
        }, () => local.readDuilian());
    }
    async function readDaily() {
        return withFallback('readDaily', async () => {
            const raw = await readFile('daily.json');
            const out = normalizeDaily(raw);
            if (out.length === 0)
                throw new Error('daily empty');
            return out;
        }, () => local.readDaily());
    }
    return { readStoryIndex, readStoryBook, readCulture, readPoemsChunk, readDuilian, readDaily };
}
