/**
 * host/story/player.ts —— 说书业务（选段算法 + 进度 + 每客户端连播队列）
 *
 * 对齐 C# 版 Story.cs 的 Next() 算法：
 *   按数组顺序找第一个未读段（key = book|index）；一本读完自动下一本；17 本全读完才清空进度重来。
 *   进度文件：{"book|index": true, "_current": "书名"}
 *   单本坏文件/超时不拖垮全局：repo.loadBook 返回空数组，pickNext 继续试下一本。
 *   连播：每个客户端（x-client-id）一条队列，多标签页互不抢段；拿不到 id 时共用单队列。
 *
 * 这里不碰 req/res：HTTP 解析与响应在 host/routes/story.ts。
 */
import { readFileSync } from 'node:fs';
import { writeJsonAtomic } from '../atomic.js';
export const STORY_AUTHORS = {
    '聊斋志异': '蒲松龄', '三国演义': '罗贯中', '西游记': '吴承恩', '水浒传': '施耐庵',
    '红楼梦': '曹雪芹', '儒林外史': '吴敬梓', '镜花缘': '李汝珍', '三言二拍': '冯梦龙、凌濛初',
    '官场现形记': '李宝嘉', '老残游记': '刘鹗', '世说新语': '刘义庆', '封神演义': '许仲琳',
    '东周列国志': '冯梦龙', '隋唐演义': '褚人获', '说岳全传': '钱彩', '杨家将演义': '熊大木',
    '三侠五义': '石玉昆', '喻世明言': '冯梦龙', '警世通言': '冯梦龙', '醒世恒言': '冯梦龙',
    '初刻拍案惊奇': '凌濛初', '二刻拍案惊奇': '凌濛初',
};
export function createStoryPlayer(opts) {
    const repo = opts.repo;
    const progress = loadProgress();
    // 每个客户端一条连播队列：{ queue: 本书剩余未读段, book: 书名 }
    const clientQueues = new Map();
    function loadProgress() {
        try {
            const obj = JSON.parse(readFileSync(opts.progressFile, 'utf8'));
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
            // 原子写：唯一临时文件 + rename，截断坏文件会让进度静默清零
            writeJsonAtomic(opts.progressFile, progress);
        }
        catch (e) {
            console.error('STORY-PROGRESS-SAVE-FAIL ' + String(e?.message || e));
        }
    }
    function storyKey(book, index) {
        return String(book || '') + '|' + String(index);
    }
    /**
     * 重新读盘：清空内存进度后按文件内容重填（保持 progress 引用不变，闭包里的其它函数继续共用同一份）。
     * 备份导入说书进度后必须调用；否则 player 手里还是启动时的旧进度，下一次 pickNext 保存会把它写回去。
     */
    function reloadProgress() {
        const next = loadProgress();
        for (const k of Object.keys(progress))
            delete progress[k];
        for (const k of Object.keys(next))
            progress[k] = next[k];
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
    // 播一段（组装开场白/结尾，照 C# 版 的 Speak-StoryChunk）
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
            rate: '-30%', // 故事语速：主人反馈 -15% 太快，-30% 听感更稳（念诗是 -25%）
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
        let anyReadable = false;
        for (let attempt = 0; attempt < books.length; attempt++) {
            const chunks = await repo.loadBook(target);
            if (chunks.length > 0)
                anyReadable = true;
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
        // 一本书都读不出来：上层据此返回 no readable book，别再假装「讲完了」
        if (!anyReadable)
            return null;
        // 整整一轮都没找到未读：都讲完了，清空进度从头再来
        for (const k of Object.keys(progress)) {
            if (k !== '_current')
                delete progress[k];
        }
        saveProgress();
        // 从头再来也要跳过坏书：按顺序找第一本能读的
        for (let i = 0; i < books.length; i++) {
            const book = books[i];
            const chunks = await repo.loadBook(book);
            const hit = chunks.find((c) => !progress[storyKey(book, c.index)]);
            if (!hit)
                continue;
            progress[storyKey(book, hit.index)] = true;
            progress['_current'] = book;
            saveProgress();
            return { piece: hit, chunks, book };
        }
        return null;
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
    async function books() {
        return repo.listBooks();
    }
    async function start(hint, clientId) {
        const list = await repo.listBooks();
        if (list.length === 0)
            return { ok: false, error: 'no books' };
        const picked = await pickNext(list, hint);
        if (!picked)
            return { ok: false, error: 'no readable book' };
        const st = stateFor(clientId);
        st.book = picked.book;
        st.queue = queueAfter(picked.chunks, picked.book, picked.piece);
        const chunk = buildChunk(picked.piece, true, isLastPiece(picked.piece));
        return { ok: true, chunk, remain: st.queue.length };
    }
    async function next(clientId) {
        const list = await repo.listBooks();
        if (list.length === 0)
            return { ok: false, error: 'no books' };
        const st = stateFor(clientId);
        // 队列里若已被别的标签页讲过，就跳过
        while (st.queue.length > 0 && progress[storyKey(st.book, st.queue[0].index)])
            st.queue.shift();
        let piece = null;
        let isFirst = false;
        if (st.queue.length > 0) {
            piece = st.queue.shift();
        }
        else {
            const picked = await pickNext(list, '');
            if (!picked)
                return { ok: false, error: 'no readable book' };
            // 队列空后重新挑段：还是同一本书就不重复插开场白，真换书才开口
            const switched = !st.book || picked.book !== st.book;
            piece = picked.piece;
            st.book = picked.book;
            st.queue = queueAfter(picked.chunks, picked.book, piece);
            isFirst = switched;
        }
        const bk = st.book || String(piece.book || list[0]);
        progress[storyKey(bk, piece.index)] = true;
        progress['_current'] = bk;
        saveProgress();
        const chunk = buildChunk(piece, isFirst, isLastPiece(piece));
        return { ok: true, chunk, remain: st.queue.length };
    }
    async function reset(bookHint, clientId) {
        const list = await repo.listBooks();
        const want = String(bookHint || '').trim();
        const book = resolveBook(list, want) || want;
        if (!book)
            return { ok: false, error: 'no book' };
        for (const k of Object.keys(progress)) {
            if (k !== '_current' && k.startsWith(book + '|'))
                delete progress[k];
        }
        progress['_current'] = book;
        saveProgress();
        // 该客户端的连播队列里若还排着这本书的段，也一起丢掉，免得 reset 后又接着念旧的
        const st = stateFor(clientId);
        if (st.book === book)
            st.queue = [];
        return { ok: true, book };
    }
    return { books, start, next, reset, reloadProgress };
}
