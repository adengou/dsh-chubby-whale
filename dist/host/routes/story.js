/**
 * host/routes/story.ts —— 说书路由（对齐 C# 版 Story.cs 的 Next() 算法）
 * 选段：按数组顺序找第一个未读段（key = book|index，避免回目里 piece 重复导致误判）；
 * 一本读完自动下一本；17 本全读完才清空进度重来。
 * 进度文件：{"book|index": true, "_current": "书名"}
 * 连播：每个客户端（x-client-id）一条队列，多标签页互不抢段；拿不到 id 时共用单队列。
 */
import { readdir } from 'node:fs/promises';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
export const STORY_AUTHORS = {
    '聊斋志异': '蒲松龄', '三国演义': '罗贯中', '西游记': '吴承恩', '水浒传': '施耐庵',
    '红楼梦': '曹雪芹', '儒林外史': '吴敬梓', '镜花缘': '李汝珍', '三言二拍': '冯梦龙、凌濛初',
    '官场现形记': '李宝嘉', '老残游记': '刘鹗', '世说新语': '刘义庆', '封神演义': '许仲琳',
    '东周列国志': '冯梦龙', '隋唐演义': '褚人获', '说岳全传': '钱彩', '杨家将演义': '熊大木',
    '三侠五义': '石玉昆', '喻世明言': '冯梦龙', '警世通言': '冯梦龙', '醒世恒言': '冯梦龙',
};
export function createStoryHandlers(opts) {
    const STORY_DIR = join(opts.dataDir, 'story');
    const PROGRESS = join(opts.dataDir, 'story_progress.json');
    const bookCache = new Map();
    const progress = loadProgress();
    // 每个客户端一条连播队列：{ queue: 本书剩余未读段, book: 书名 }
    const clientQueues = new Map();
    function loadProgress() {
        try {
            const obj = JSON.parse(readFileSync(PROGRESS, 'utf8'));
            const out = {};
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                for (const k of Object.keys(obj)) {
                    if (k === '_current') {
                        if (typeof obj[k] === 'string')
                            out[k] = obj[k];
                    }
                    else if (obj[k]) {
                        out[k] = true;
                    }
                }
            }
            return out;
        }
        catch {
            return {};
        }
    }
    function saveProgress() {
        try {
            mkdirSync(opts.dataDir, { recursive: true });
            writeFileSync(PROGRESS, JSON.stringify(progress), 'utf8');
        }
        catch { }
    }
    function storyKey(book, index) {
        return String(book || '') + '|' + String(index);
    }
    async function listBooks() {
        try {
            const files = await readdir(STORY_DIR);
            return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
        }
        catch {
            return [];
        }
    }
    function resolveBook(books, want) {
        const w = String(want || '').trim();
        if (!w)
            return '';
        if (books.indexOf(w) >= 0)
            return w;
        let hit = '';
        for (const b of books) {
            if (b.indexOf(w) >= 0 || w.indexOf(b) >= 0) {
                if (b.length > hit.length)
                    hit = b;
            }
        }
        return hit;
    }
    function currentBook(books) {
        try {
            const cur = progress['_current'];
            if (typeof cur === 'string' && cur && books.indexOf(cur) >= 0)
                return cur;
        }
        catch { }
        return books.length ? books[0] : '';
    }
    // 按需加载一本书的切片（Worker 解析，内存缓存）；index 用原数组序号（照 C#）
    function normalizeBook(book, raw) {
        const out = [];
        if (!Array.isArray(raw))
            return out;
        for (let i = 0; i < raw.length; i++) {
            const c = raw[i];
            if (!c || typeof c !== 'object')
                continue;
            const text = String(c.text == null ? '' : c.text);
            if (!text.trim())
                continue;
            out.push({
                book: String(c.book || book),
                title: String(c.title || ''),
                piece: Number(c.piece) || 1,
                total: Number(c.total) || 1,
                text,
                index: i,
            });
        }
        return out;
    }
    function loadBook(book) {
        const cached = bookCache.get(book);
        if (cached)
            return Promise.resolve(cached);
        return new Promise((resolve, reject) => {
            try {
                const w = new Worker(opts.workerPath);
                const timer = setTimeout(() => { try {
                    w.terminate();
                }
                catch { } reject(new Error('story load timeout')); }, 30000);
                w.once('message', (msg) => {
                    clearTimeout(timer);
                    try {
                        w.terminate();
                    }
                    catch { }
                    if (msg && msg.ok) {
                        const list = normalizeBook(book, msg.chunks);
                        bookCache.set(book, list);
                        resolve(list);
                    }
                    else
                        reject(new Error(msg?.error || 'parse failed'));
                });
                w.once('error', (err) => { clearTimeout(timer); reject(err); });
                w.postMessage({ book, file: join(STORY_DIR, book + '.json') });
            }
            catch (err) {
                reject(err);
            }
        });
    }
    // 播一段（组装开场白/结尾，照 fish-pet 的 Speak-StoryChunk）
    function buildChunk(c, isFirst, isLast) {
        const bookName = String(c.book || '故事');
        const title = String(c.title || '');
        const piece = Number(c.piece) || 1;
        const total = Number(c.total) || 1;
        const spoken = String(c.text || '');
        const author = STORY_AUTHORS[bookName] || '';
        const cleanTitle = title.replace(/正文\s*/g, '');
        const intro = isFirst ? ('话说，今天给主人讲一段《' + bookName + '》' + (author ? '，' + author + '著' : '') + '，' + cleanTitle + '。') : '';
        const tail = isLast ? '这一回，就讲到这里。' : '';
        return {
            book: bookName,
            title,
            piece,
            total,
            isFirst,
            isLast,
            text: intro + spoken + tail,
            rate: '-15%',
        };
    }
    function isLastPiece(c) {
        return Number(c.piece) >= Number(c.total);
    }
    /** 本回剩余未读段（按数组顺序，供本客户端连播） */
    function queueAfter(chunks, book, piece) {
        return chunks
            .filter((c) => Number(c.index) > Number(piece.index) && !progress[storyKey(book, c.index)])
            .sort((a, b) => Number(a.index) - Number(b.index));
    }
    /** 照 C# Story.Next()：当前书里找第一个未读段；读完换下一本；全读完才清零重来 */
    async function pickNext(books, want) {
        if (books.length === 0)
            return null;
        const resolved = resolveBook(books, want);
        let target = resolved || currentBook(books);
        for (let attempt = 0; attempt < books.length; attempt++) {
            const chunks = await loadBook(target);
            const hit = chunks.find((c) => !progress[storyKey(target, c.index)]);
            if (hit) {
                progress[storyKey(target, hit.index)] = true;
                progress['_current'] = target;
                saveProgress();
                return { piece: hit, chunks, book: target };
            }
            const idx = books.indexOf(target);
            target = books[(idx + 1) % books.length];
        }
        // 整整一轮都没找到未读：17 本都讲完了，清空进度从头再来
        for (const k of Object.keys(progress)) {
            if (k !== '_current')
                delete progress[k];
        }
        saveProgress();
        const firstBook = books[0];
        const chunks = await loadBook(firstBook);
        const hit = chunks.find((c) => !progress[storyKey(firstBook, c.index)]);
        if (!hit)
            return null;
        progress[storyKey(firstBook, hit.index)] = true;
        progress['_current'] = firstBook;
        saveProgress();
        return { piece: hit, chunks, book: firstBook };
    }
    function clientId(req) {
        try {
            const raw = req?.headers?.['x-client-id'];
            const v = Array.isArray(raw) ? raw[0] : raw;
            if (typeof v !== 'string')
                return '';
            return v.replace(/[^\w.-]/g, '').slice(0, 64);
        }
        catch {
            return '';
        }
    }
    function stateFor(id) {
        let st = clientQueues.get(id);
        if (!st) {
            st = { queue: [], book: '' };
            clientQueues.set(id, st);
            if (clientQueues.size > 16) {
                for (const k of clientQueues.keys()) {
                    if (k !== id) {
                        clientQueues.delete(k);
                        break;
                    }
                }
            }
        }
        return st;
    }
    function send(res, payload) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
    }
    async function handleBooks(_req, res) {
        try {
            send(res, { ok: true, books: await listBooks() });
        }
        catch (err) {
            send(res, { ok: false, error: String(err?.message || err), books: [] });
        }
    }
    async function handleStoryStart(req, res) {
        try {
            const books = await listBooks();
            if (books.length === 0) {
                send(res, { ok: false, error: 'no books' });
                return;
            }
            const url = new URL(req.url, 'http://x');
            const hint = url.searchParams.get('hint') || '';
            const picked = await pickNext(books, hint);
            if (!picked) {
                send(res, { ok: false, error: 'no chunk' });
                return;
            }
            const st = stateFor(clientId(req));
            st.book = picked.book;
            st.queue = queueAfter(picked.chunks, picked.book, picked.piece);
            const out = buildChunk(picked.piece, true, isLastPiece(picked.piece));
            send(res, { ok: true, ...out, remain: st.queue.length });
        }
        catch (err) {
            send(res, { ok: false, error: String(err?.message || err) });
        }
    }
    async function handleStoryNext(req, res) {
        try {
            const books = await listBooks();
            if (books.length === 0) {
                send(res, { ok: false, error: 'no books' });
                return;
            }
            const st = stateFor(clientId(req));
            // 队列里若已被别的标签页讲过，就跳过
            while (st.queue.length > 0 && progress[storyKey(st.book, st.queue[0].index)])
                st.queue.shift();
            let piece = null;
            let isFirst = false;
            if (st.queue.length > 0) {
                piece = st.queue.shift();
            }
            else {
                const picked = await pickNext(books, '');
                if (!picked) {
                    send(res, { ok: true, done: true });
                    return;
                }
                piece = picked.piece;
                st.book = picked.book;
                st.queue = queueAfter(picked.chunks, picked.book, piece);
                isFirst = true;
            }
            const bk = st.book || String(piece.book || books[0]);
            progress[storyKey(bk, piece.index)] = true;
            progress['_current'] = bk;
            saveProgress();
            const out = buildChunk(piece, isFirst, isLastPiece(piece));
            send(res, { ok: true, ...out, remain: st.queue.length });
        }
        catch (err) {
            send(res, { ok: false, error: String(err?.message || err) });
        }
    }
    return { handleBooks, handleStoryStart, handleStoryNext };
}
