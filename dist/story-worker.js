/**
 * story-worker.ts —— 说书数据解析 Worker（Node Worker Threads）
 * 大 JSON（30 MB）在独立线程解析，不阻塞主线程。
 */
import { parentPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
if (parentPort) {
    parentPort.on('message', (payload) => {
        try {
            let text = readFileSync(payload.file, 'utf8');
            // 剥 UTF-8 BOM：同功能另三处都剥（player.ts 进度文件、data/local.ts、data/cloud.ts），
            // 只有这里没剥 —— 用户拿 PowerShell `Set-Content -Encoding UTF8` 改过书就带 BOM，
            // 于是整本书静默读成 0 段（JSON.parse 报 "Unexpected token '﻿'"），还被 repo 按 mtime 负缓存住。
            // 2026-11-07 B96 分身取证 + 本处修复。
            if (text.charCodeAt(0) === 0xfeff)
                text = text.slice(1);
            const arr = JSON.parse(text);
            parentPort.postMessage({ ok: true, book: payload.book, chunks: arr });
        }
        catch (err) {
            parentPort.postMessage({ ok: false, book: payload.book, error: String(err?.message || err) });
        }
    });
}
