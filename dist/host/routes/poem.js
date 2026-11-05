/**
 * host/routes/poem.ts —— 念诗路由
 * 数据：data/poems.json（739 首，结构 {poems:[{type,dynasty,title,author,lines,sources}]}）
 * 去重：data/poem-seen.json（["标题|作者|首句", ...]），一轮念完自动清空重来。
 * 文件缺失/损坏只记 POEM-LOAD-FAIL，按空诗册处理；空时返回 {ok:true,item:null,reason:'no-data'}。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
export function createPoemHandler(opts) {
    const POEMS_FILE = join(opts.dataDir, 'poems.json');
    const SEEN_FILE = join(opts.runtimeDir || opts.dataDir, 'poem-seen.json');
    let poems = null;
    let seen = null;
    function keyOf(p) {
        // 同题不同作很多（蝶恋花/浣溪沙 等），键里加上首句前 12 字
        const first = Array.isArray(p.lines) ? String(p.lines[0] || '') : String(p.text || '');
        return String(p.title || '') + '|' + String(p.author || '') + '|' + first.slice(0, 12);
    }
    function loadPoems() {
        if (poems)
            return poems;
        const out = [];
        const keys = new Set();
        try {
            const data = JSON.parse(readFileSync(POEMS_FILE, 'utf8'));
            const arr = Array.isArray(data) ? data : (Array.isArray(data?.poems) ? data.poems : null);
            if (!arr) {
                console.error('POEM-LOAD-FAIL file=' + POEMS_FILE + ' err=bad structure');
            }
            else {
                for (const p of arr) {
                    if (!p || typeof p !== 'object')
                        continue;
                    const title = String(p.title || '').trim();
                    if (!title)
                        continue;
                    const lines = Array.isArray(p.lines) ? p.lines.map((x) => String(x || '').trim()).filter(Boolean) : [];
                    if (lines.length === 0)
                        continue;
                    const item = {
                        type: String(p.type || ''),
                        dynasty: String(p.dynasty || ''),
                        title,
                        author: String(p.author || ''),
                        lines,
                    };
                    // 按 key 去重：同一首只留第一条
                    const k = keyOf(item);
                    if (keys.has(k))
                        continue;
                    keys.add(k);
                    out.push(item);
                }
            }
        }
        catch (err) {
            console.error('POEM-LOAD-FAIL file=' + POEMS_FILE + ' err=' + String(err?.message || err));
        }
        poems = out;
        return poems;
    }
    function loadSeen() {
        if (seen)
            return seen;
        const s = new Set();
        try {
            const arr = JSON.parse(readFileSync(SEEN_FILE, 'utf8'));
            if (Array.isArray(arr)) {
                for (const k of arr)
                    if (typeof k === 'string' && k.trim())
                        s.add(k.trim());
            }
        }
        catch { }
        seen = s;
        return seen;
    }
    function saveSeen() {
        try {
            mkdirSync(opts.dataDir, { recursive: true });
            writeFileSync(SEEN_FILE, JSON.stringify(Array.from(seen || [])), 'utf8');
        }
        catch { }
    }
    async function handlePoem(req, res) {
        try {
            const list = loadPoems();
            if (list.length === 0) {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: true, item: null, reason: 'no-data' }));
                return;
            }
            // 指定标题：按「完整标题 = 」优先，其次「包含」，命中就直接背这一首（不参与随机池）
            let want = '';
            try {
                const u = new URL(String(req?.url || ''), 'http://local');
                want = String(u.searchParams.get('title') || '').trim();
            }
            catch {
                want = '';
            }
            if (want) {
                const exact = list.filter((p) => String(p.title || '').trim() === want);
                const fuzzy = exact.length ? exact : list.filter((p) => String(p.title || '').includes(want));
                const hit = fuzzy.length ? fuzzy[Math.floor(Math.random() * fuzzy.length)] : null;
                if (hit) {
                    const sn0 = loadSeen();
                    sn0.add(keyOf(hit));
                    saveSeen();
                    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({
                        ok: true,
                        matched: true,
                        item: { title: hit.title, author: hit.author, dynasty: hit.dynasty, text: hit.lines.join('\n') },
                    }));
                    return;
                }
                // 没匹配到就回落随机（并告诉客户端 matched:false）
            }
            const sn = loadSeen();
            let pool = list.filter((p) => !sn.has(keyOf(p)));
            if (pool.length === 0) {
                // 一轮念完：清空记忆重来
                sn.clear();
                saveSeen();
                pool = list.slice();
            }
            const p = pool[Math.floor(Math.random() * pool.length)];
            sn.add(keyOf(p));
            saveSeen();
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                ok: true,
                item: {
                    title: p.title,
                    author: p.author,
                    dynasty: p.dynasty,
                    text: p.lines.join('\n'),
                },
            }));
        }
        catch (err) {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
        }
    }
    return { handlePoem };
}
