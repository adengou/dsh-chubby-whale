/**
 * host/routes/culture.ts —— 文化（成语/典故/民俗）与音乐路由（可复用模块）
 * 去重：culture-seen.json，结构与 C# 版兼容：
 *   {"allusions":[...],"tales":[...],"idioms":[...],"minsu":[...]}
 *   元素为「名称」或「书名|标题」；民间故事同时写 tales（C# 读它）和 minsu。
 *   读到旧格式 {"chengyu:名称": true} 时自动迁移成新结构。
 * 一轮讲完只清空同一类别的记录，别的类别进度保留；一轮重来时先排除上一则，
 * 避免「刚讲完又立刻同一则」（与念诗同口径，见 poem.ts 的同名处理）。
 * 数据经 DataPort 取（本地/云端由 index.ts 注入）；数据源读不到只记 CULTURE-LOAD-FAIL，按空池处理，绝不整类报错。
 * 原子写/坏文件隔离走 host/atomic.ts，JSON 响应走 host/respond.ts。
 */
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../atomic.js';
import { sendJson, sendError } from '../respond.js';
export function createCultureHandlers(opts) {
    const SEEN_FILE = join(opts.runtimeDir || opts.dataDir, 'culture-seen.json');
    let seen = null;
    /** 上一次讲出来的条目键（按类别）：一轮重来时先排除它，避免「刚讲完又立刻同一则」 */
    const lastServed = new Map();
    /** 文化数据经数据源端口取（本地/云端由 index.ts 注入）；实现已兜底，这里只防注入实现意外抛错 */
    async function loadCulture(kind) {
        try {
            const arr = await opts.dataPort.readCulture(kind);
            return Array.isArray(arr) ? arr : [];
        }
        catch (err) {
            console.error('CULTURE-LOAD-FAIL kind=' + kind + ' err=' + String(err?.message || err));
            return [];
        }
    }
    // 新格式字段 ← 内部前缀；民间故事写 tales + minsu 两份，让 C# 也能读
    function splitKey(k) {
        const i = k.indexOf(':');
        if (i <= 0)
            return null;
        const rawPrefix = k.slice(0, i);
        const name = k.slice(i + 1);
        if (!name)
            return null;
        const prefix = rawPrefix === 'allusion' ? 'chengyu'
            : (rawPrefix === 'tale' || rawPrefix === 'tales') ? 'minsu'
                : rawPrefix;
        if (prefix !== 'chengyu' && prefix !== 'idiom' && prefix !== 'minsu')
            return null;
        return { prefix, name };
    }
    function addSeen(out, list, prefix) {
        if (!Array.isArray(list))
            return;
        for (const raw of list) {
            const name = String(raw == null ? '' : raw).trim();
            if (!name)
                continue;
            out[prefix + ':' + name] = true;
        }
    }
    function loadSeen() {
        if (seen)
            return seen;
        const out = {};
        let legacy = false;
        try {
            const obj = JSON.parse(String(readFileSync(SEEN_FILE, 'utf8')).replace(/^\uFEFF/, ''));
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                const hasArrays = Array.isArray(obj.allusions) || Array.isArray(obj.tales)
                    || Array.isArray(obj.idioms) || Array.isArray(obj.minsu);
                if (hasArrays) {
                    addSeen(out, obj.allusions, 'chengyu');
                    addSeen(out, obj.idioms, 'idiom');
                    addSeen(out, obj.tales, 'minsu');
                    addSeen(out, obj.minsu, 'minsu');
                }
                else {
                    // 旧格式是扁平 {key: true}：按前缀迁移，读完顺手按新结构落盘
                    legacy = true;
                    for (const k of Object.keys(obj)) {
                        if (!obj[k])
                            continue;
                        const p = splitKey(k);
                        if (p)
                            out[p.prefix + ':' + p.name] = true;
                    }
                }
            }
            else {
                console.error('CULTURE-SEEN-LOAD-FAIL file=' + SEEN_FILE + ' err=bad structure');
            }
        }
        catch (err) {
            // 首次运行没有文件是正常态（ENOENT/ENOTDIR）；解析失败、读坏、没权限必须留痕，
            // 否则「进度莫名其妙全忘了」永远查不到原因
            if (!(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'))) {
                console.error('CULTURE-SEEN-LOAD-FAIL file=' + SEEN_FILE + ' err=' + String(err?.message || err));
            }
        }
        seen = out;
        if (legacy)
            saveSeen();
        return seen;
    }
    function saveSeen() {
        try {
            const sn = seen || {};
            const data = {
                allusions: [], tales: [], idioms: [], minsu: [],
            };
            const add = (field, name) => {
                if (name && data[field].indexOf(name) < 0)
                    data[field].push(name);
            };
            for (const k of Object.keys(sn)) {
                if (!sn[k])
                    continue;
                const p = splitKey(k);
                if (!p)
                    continue;
                if (p.prefix === 'chengyu')
                    add('allusions', p.name);
                else if (p.prefix === 'idiom')
                    add('idioms', p.name);
                else if (p.prefix === 'minsu') {
                    add('minsu', p.name);
                    add('tales', p.name);
                }
            }
            // 原子写：唯一临时名 + rename（失败清临时文件），见 host/atomic.ts
            writeJsonAtomic(SEEN_FILE, data);
        }
        catch (err) {
            console.error('CULTURE-SEEN-SAVE-FAIL file=' + SEEN_FILE + ' err=' + String(err?.message || err));
        }
    }
    /**
     * 随机挑一条没讲过的。一轮讲完只清掉同类前缀的记录，
     * 别的类别（典故/故事/成语）的进度不受影响。
     * 一轮重来后先排除刚讲过的上一条（池子只有一条时只能照旧重复）：
     * 否则新一轮第一则有 1/n 概率与上一则完全相同，用户看到的就是「刚讲完又讲一遍」。
     */
    function pickUnseen(arr, prefix, keyOf) {
        if (!arr || arr.length === 0)
            return null;
        const sn = loadSeen();
        const full = (x) => prefix + ':' + keyOf(x);
        let pool = arr.filter((x) => !sn[full(x)]);
        if (pool.length === 0) {
            for (const k of Object.keys(sn)) {
                if (k.startsWith(prefix + ':'))
                    delete sn[k];
            }
            saveSeen();
            const last = lastServed.get(prefix) || '';
            pool = arr.filter((x) => full(x) !== last);
            if (pool.length === 0)
                pool = arr.slice();
        }
        const item = pool[Math.floor(Math.random() * pool.length)];
        sn[full(item)] = true;
        lastServed.set(prefix, full(item));
        saveSeen();
        return item;
    }
    async function handleCulture(req, res) {
        try {
            const url = new URL(req.url, 'http://x');
            const type = url.searchParams.get('type') || 'chengyu';
            let item = null;
            if (type === 'chengyu') {
                const arr = await loadCulture('chengyu');
                const x = pickUnseen(arr, 'chengyu', (i) => String(i.name || ''));
                if (x)
                    item = { kind: 'chengyu', title: x.name, src: x.src, text: x.text };
            }
            else if (type === 'idiom') {
                const arr = await loadCulture('idiom');
                const x = pickUnseen(arr, 'idiom', (i) => String(i.name || ''));
                if (x)
                    item = { kind: 'idiom', title: x.name, cat: x.cat, text: (x.mean || '') + (x.wrong ? '；易误解为：' + String(x.wrong).replace('易误解为：', '') : '') };
            }
            else if (type === 'minsu') {
                const arr = await loadCulture('minsu');
                const x = pickUnseen(arr, 'minsu', (i) => String(i.book || '') + '|' + String(i.title || ''));
                if (x)
                    item = { kind: 'minsu', title: (x.book || '') + '·' + (x.title || ''), text: x.text };
            }
            else {
                item = { kind: 'unknown', title: '嗯？', text: '这个类型的文化小鲸还没学会。' };
            }
            // 池子为空：ok 但 item 为空，前端按 d.item 判空显示「没读到」
            if (!item)
                sendJson(res, { ok: true, item: null, reason: 'no-data' });
            else
                sendJson(res, { ok: true, item });
        }
        catch (err) {
            sendError(res, err);
        }
    }
    async function handleMelodies(_req, res) {
        try {
            const txt = await readFile(join(opts.dataDir, 'melodies.json'), 'utf8');
            const data = JSON.parse(txt);
            const songs = (data?.songs || []).map((s) => ({ name: s.name, bpm: s.bpm }));
            sendJson(res, { ok: true, songs });
        }
        catch (err) {
            sendError(res, err, { songs: [] });
        }
    }
    async function handleMelody(req, res) {
        try {
            const url = new URL(req.url, 'http://x');
            const name = url.searchParams.get('name') || '';
            const txt = await readFile(join(opts.dataDir, 'melodies.json'), 'utf8');
            const data = JSON.parse(txt);
            const song = (data?.songs || []).find((s) => s.name === name);
            if (!song) {
                sendJson(res, { ok: false, error: 'song not found' });
                return;
            }
            sendJson(res, { ok: true, song: { name: song.name, bpm: song.bpm || 100, notes: song.notes || [], lyrics: song.lyrics || '' } });
        }
        catch (err) {
            sendError(res, err);
        }
    }
    return { handleCulture, handleMelodies, handleMelody };
}
