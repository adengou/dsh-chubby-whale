/**
 * story-worker.ts —— 说书数据解析 Worker（Node Worker Threads）
 * 大 JSON（30 MB）在独立线程解析，不阻塞主线程。
 */
import { parentPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
if (parentPort) {
    parentPort.on('message', (payload) => {
        try {
            const text = readFileSync(payload.file, 'utf8');
            const arr = JSON.parse(text);
            parentPort.postMessage({ ok: true, book: payload.book, chunks: arr });
        }
        catch (err) {
            parentPort.postMessage({ ok: false, book: payload.book, error: String(err?.message || err) });
        }
    });
}
