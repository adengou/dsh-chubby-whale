/**
 * host/routes/story.ts —— 说书路由（1:1 复刻 dsh-fish-pet 的 story.ps1 算法）
 * 选回目、整回连播、进度记忆（book|title|piece）、按需加载（Worker 读大 JSON）
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
    // 当前连播队列（模块级单例）
    let queue = [];
    let queueBook = '';
    let queueTitle = '';
    function loadProgress() {
        try {
            const obj = JSON.parse(readFileSync(PROGRESS, 'utf8'));
            const out = {};
            if (obj && typeof obj === 'object') {
                for (const k of Object.keys(obj))
                    if (obj[k])
                        out[k] = true;
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
    function storyKey(c) {
        return String(c.book || '') + '|' + String(c.title || '') + '|' + String(c.piece || '');
    }
    // 按需加载一本书的切片（Worker 解析，内存缓存）
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
                        bookCache.set(book, msg.chunks);
                        resolve(msg.chunks);
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
    async function handleBooks(_req, res) {
        try {
            const files = await readdir(STORY_DIR);
            const books = files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, books }));
        }
        catch (err) {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: String(err?.message || err), books: [] }));
        }
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
    function pickChunk(chunks, pick) {
        const pickBook = String(pick.book);
        queueBook = pickBook;
        queueTitle = String(pick.title);
        const q = chunks
            .filter((c) => String(c.book) === pickBook && String(c.title) === String(pick.title) && Number(c.piece) >= Number(pick.piece))
            .sort((a, b) => Number(a.piece) - Number(b.piece));
        queue = q;
    }
    async function handleStoryStart(req, res) {
        try {
            const url = new URL(req.url, 'http://x');
            const hint = url.searchParams.get('hint') || '';
            const books = await readdir(STORY_DIR);
            const bookList = books.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
            if (bookList.length === 0) {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: 'no books' }));
                return;
            }
            let book = '';
            if (hint) {
                for (const b of bookList) {
                    if (hint.indexOf(b) >= 0 || (b.length > 2 && hint.indexOf(b.slice(0, 2)) >= 0)) {
                        book = b;
                        break;
                    }
                }
            }
            if (!book)
                book = bookList[Math.floor(Math.random() * bookList.length)];
            const chunks = await loadBook(book);
            if (!chunks || chunks.length === 0) {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: 'empty book' }));
                return;
            }
            const fresh = chunks.filter((c) => !progress[storyKey(c)]);
            const pool = fresh.length > 0 ? fresh : chunks;
            const firstPieces = pool.filter((c) => Number(c.piece) === 1);
            const src = firstPieces.length > 0 ? firstPieces : pool;
            const pick = src[Math.floor(Math.random() * src.length)];
            if (!pick) {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: 'no chunk' }));
                return;
            }
            pickChunk(chunks, pick);
            const first = queue.shift();
            const isLast = Number(first.piece) >= Number(first.total);
            progress[storyKey(first)] = true;
            saveProgress();
            const out = buildChunk(first, true, isLast);
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, ...out, remain: queue.length }));
        }
        catch (err) {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
        }
    }
    async function handleStoryNext(_req, res) {
        try {
            if (queue.length === 0) {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: true, done: true }));
                return;
            }
            const c = queue.shift();
            const isLast = Number(c.piece) >= Number(c.total);
            progress[storyKey(c)] = true;
            saveProgress();
            const out = buildChunk(c, false, isLast);
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, ...out, remain: queue.length }));
        }
        catch (err) {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
        }
    }
    return { handleBooks, handleStoryStart, handleStoryNext };
}
