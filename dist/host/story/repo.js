/**
 * host/story/repo.ts —— 说书数据仓库（可复用）
 *
 * 职责只有三件事：枚举书单、按需解析一本书、按 mtime 缓存/并发去重。
 * 不碰进度、不碰 HTTP、不碰客户端队列——那些在 host/story/player.ts。
 * 解析放 Worker 线程（一本 30MB JSON 不能阻塞主线程）；坏文件/超时都 resolve 空数组，绝不 reject。
 */
import { readdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
/** 内存里最多留几本书：一本 JSON 可能几 MB，无限缓存会一直涨 */
const BOOK_CACHE_MAX = 2;
/** 单本书解析超时：30 秒 */
const READ_TIMEOUT_MS = 30000;
export function createStoryRepo(opts) {
    const STORY_DIR = join(opts.dataDir, 'story');
    const bookCache = new Map();
    /**
     * 进行中的读盘请求：book → { mtimeMs, promise }。
     * 并发来两个请求时如果各起一个 Worker，就是两个线程同时读 30MB JSON，
     * 内存峰值和 CPU 都翻倍；这里按「书 + mtime」去重，两个请求共用同一次解析。
     */
    const inflight = new Map();
    /** 文件最后修改时间（读不到返回 0）；缓存据此失效，改数据不必重启 */
    function fileMtime(p) {
        try {
            return statSync(p).mtimeMs;
        }
        catch {
            return 0;
        }
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
    /** 按需加载一本书的切片（Worker 解析，内存缓存）；index 用原数组序号（照 C#） */
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
    /**
     * 读一本书。坏文件/超时都不抛：记 STORY-LOAD-FAIL 后返回空数组，
     * 让上层继续试下一本（一本坏不能拖垮整个说书功能）。
     * 同一本书（且文件没被改过）已有请求在跑时复用那个 Promise，不再另起 Worker。
     */
    function loadBook(book) {
        const file = join(STORY_DIR, book + '.json');
        const mt = fileMtime(file);
        const cached = bookCache.get(book);
        if (cached && mt > 0 && cached.mtimeMs === mt) {
            // 命中：顺手 touch 一下，保持 LRU 顺序
            bookCache.delete(book);
            bookCache.set(book, cached);
            return Promise.resolve(cached.chunks);
        }
        const running = inflight.get(book);
        // 文件没被改过才复用；mtime 变了说明数据刚更新，得重新读，不能拿旧书糊弄
        if (running && running.mtimeMs === mt)
            return running.promise;
        const task = readBook(book, file, mt);
        inflight.set(book, { mtimeMs: mt, promise: task });
        const release = () => {
            const cur = inflight.get(book);
            if (cur && cur.promise === task)
                inflight.delete(book); // 只摘自己这条，别误删后来者
        };
        task.then(release, release);
        return task;
    }
    /** 起 Worker 解析一本书（30s 超时；失败/崩溃都 resolve 空数组，绝不 reject） */
    function readBook(book, file, mt) {
        return new Promise((resolve) => {
            let done = false;
            let worker = null;
            let timer = null;
            const stopWorker = () => { try {
                if (worker)
                    worker.terminate();
            }
            catch { } };
            const fail = (err) => {
                if (done)
                    return;
                done = true;
                // 超时/崩溃/解析失败都要把另外两样收干净，别留一个 30s 定时器或活着的线程
                if (timer) {
                    try {
                        clearTimeout(timer);
                    }
                    catch { }
                    ;
                    timer = null;
                }
                stopWorker();
                console.error('STORY-LOAD-FAIL book=' + book + ' err=' + String(err?.message || err));
                resolve([]);
            };
            try {
                const w = new Worker(opts.workerPath);
                worker = w;
                timer = setTimeout(() => { fail('timeout 30s'); }, READ_TIMEOUT_MS);
                w.once('message', (msg) => {
                    clearTimeout(timer);
                    timer = null;
                    if (done)
                        return;
                    if (msg && msg.ok) {
                        done = true;
                        const list = normalizeBook(book, msg.chunks);
                        bookCache.set(book, { chunks: list, mtimeMs: mt });
                        // LRU：超上限就丢最早的那本（Map 保持插入顺序）
                        while (bookCache.size > BOOK_CACHE_MAX) {
                            const oldest = bookCache.keys().next().value;
                            if (oldest === undefined)
                                break;
                            bookCache.delete(oldest);
                        }
                        stopWorker();
                        resolve(list);
                    }
                    else
                        fail(msg?.error || 'parse failed');
                });
                w.once('error', (err) => fail(err));
                // Worker 崩了（线程里未捕获异常、被 OOM 杀掉）不会发 message 也不会发 error，只有 exit；
                // 不接这一条，请求会一直悬到 30 秒超时才回空。done 在成功/失败时已置位，
                // 所以 terminate() 引发的 exit(code=1) 不会被误报成崩溃。
                w.once('exit', (code) => {
                    if (!done && code !== 0)
                        fail('worker exit ' + code);
                });
                w.postMessage({ book, file });
            }
            catch (err) {
                fail(err);
            }
        });
    }
    return { listBooks, loadBook };
}
