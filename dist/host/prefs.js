/**
 * host/prefs.ts —— 插件偏好（prefs.json）与聊天缓存开关路由
 *
 * 偏好存运行目录（~/.dsh-chubby-whale/prefs.json），不进仓库、不与其他插件共享。
 * 原先这两件事都内联在 index.ts 的组装代码里（组装层写业务），现在独立成能力模块：
 * 新增一个偏好只改本文件；/cache-toggle 路由由工厂直接产出，index 只接线。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { quarantineFile, stripBom, writeJsonAtomic } from './atomic.js';
import { sendJson } from './respond.js';
import { isBodyTooLarge, readBody, sendTooLarge } from './http.js';
/** /cache-toggle 请求体上限：只需一个 {"enabled":true}，16KB 足够，超限回 413 */
const CACHE_TOGGLE_MAX_BODY = 16 * 1024;
/** 日志用的有界文本：控制字符折成空格、超长截断（偏好值可能是手改进去的一整段文本） */
function clip(raw, max) {
    let s = '';
    try {
        s = raw == null ? '' : String(raw);
    }
    catch {
        return '(无法转成文本)';
    }
    s = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) + '…' : s;
}
/** 值形状（只报类型/长度，不回显内容） */
function shapeOf(raw) {
    try {
        if (raw === undefined)
            return 'undefined';
        if (raw === null)
            return 'null';
        if (Array.isArray(raw))
            return '数组（长度 ' + raw.length + '）';
        const t = typeof raw;
        if (t === 'object') {
            let keys = 0;
            try {
                keys = Object.keys(raw).length;
            }
            catch { }
            return '对象（' + keys + ' 个键）';
        }
        return t;
    }
    catch {
        return '无法识别的值';
    }
}
/**
 * JSON.parse 报错摘要：只取错误类型与 `at position N` 里的数字。
 * Node ≥20 的报错消息会带源文本片段，直接拼进日志等于把偏好文件内容写进日志。
 */
function jsonErrorBrief(err) {
    const name = clip(String((err && err.name) || 'Error'), 40);
    let position = '';
    try {
        const m = /at position (\d+)/.exec(String((err && err.message) || ''));
        if (m)
            position = ' @ position ' + m[1];
    }
    catch { }
    return name + position;
}
export function createPrefs(runtimeDir) {
    const PREFS_FILE = join(runtimeDir, 'prefs.json');
    /** 坏文件只提示一次：chatCacheEnabled 每次聊天都会被调用，不能让坏文件把日志刷满 */
    let warnedBadFile = false;
    function warnBadFile(msg) {
        if (warnedBadFile)
            return;
        warnedBadFile = true;
        console.error('[prefs] ' + msg);
    }
    /**
     * 读到坏文件时记下原文：写偏好前先把原文备份成 prefs.json.bad-<时间戳>，再写新值。
     * 旧实现直接 writeJsonAtomic 覆盖——手改坏一个逗号的 prefs.json 会被静默抹掉，
     * 与 store.ts / atomic.ts 的「坏文件先隔离再走默认值」口径不一致。
     */
    let badFileText = null;
    /**
     * 读偏好。降级口径（2026-11-07 B74 加固）：
     *   · 没有文件是常态（首次运行），静默返回 {}（chatCache 缺省 true）；
     *   · 坏 JSON / 数组 / 标量一律返回 {}，并提示一次；
     *     旧实现把数组原样返回，setChatCache 往数组上挂 chatCache 属性后 JSON.stringify 不保留它，
     *     于是“关了缓存”永远写不进去、每次读回来还是 true——用户看到的开关像坏了一样。
     */
    function load() {
        let text;
        try {
            text = String(readFileSync(PREFS_FILE, 'utf8'));
        }
        catch (err) {
            const code = err && err.code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR') {
                warnBadFile('READ-FAIL ' + String(PREFS_FILE) + ' err=' + clip((err && err.message) || err, 200));
            }
            return {};
        }
        let parsed;
        try {
            parsed = JSON.parse(stripBom(text));
        }
        catch (err) {
            // 只报错误类型与位置，不拼 err.message（Node ≥20 的报错带源文本片段）
            badFileText = text;
            warnBadFile('READ-FAIL ' + String(PREFS_FILE) + ' 坏 JSON，已按默认值处理（' + jsonErrorBrief(err) + '）');
            return {};
        }
        if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            badFileText = text;
            warnBadFile('READ-FAIL ' + String(PREFS_FILE) + ' 形状不是对象（' + shapeOf(parsed) + '），已按默认值处理');
            return {};
        }
        badFileText = null;
        return parsed;
    }
    function save(p) {
        // 坏文件原文还在：先隔离一份再重写（外部已经改好的情况不复盘：内容不一致就跳过备份）
        if (badFileText !== null) {
            const bad = badFileText;
            badFileText = null;
            let current = '';
            try {
                current = String(readFileSync(PREFS_FILE, 'utf8'));
            }
            catch { }
            if (current === bad) {
                try {
                    quarantineFile(PREFS_FILE, new Error('prefs.json 不是合法 JSON 或形状不是对象（已按默认值处理）'), '[prefs]');
                }
                catch { }
            }
        }
        // 原子写：写坏一次就整份偏好丢失（与 store 同一套工具）
        try {
            writeJsonAtomic(PREFS_FILE, p);
        }
        catch (err) {
            console.error('[prefs] WRITE-FAIL ' + String(PREFS_FILE) + ' err=' + clip(err?.message || err, 200));
        }
    }
    const chatCacheEnabled = () => {
        try {
            return load().chatCache !== false;
        }
        catch {
            return true;
        }
    };
    const setChatCache = (on) => {
        const p = load();
        p.chatCache = on;
        save(p);
    };
    return { load, save, chatCacheEnabled, setChatCache };
}
/**
 * /cache-toggle：POST {enabled:boolean} 切换聊天缓存开关；GET 读当前状态。
 * 2026-11 起请求体走 host/http.ts 的 readBody 并设 16KB 上限：原先手动 'data' 累加没有上限，
 * 一个超大 body 就能把整段字符串攒进内存。超限按项目既有约定回 413。
 */
export function createCacheToggleHandler(prefs) {
    return async (req, res) => {
        let text = '';
        try {
            text = (await readBody(req, CACHE_TOGGLE_MAX_BODY)).toString('utf8');
        }
        catch (err) {
            if (isBodyTooLarge(err)) {
                console.error('[prefs] CACHE-TOGGLE-BODY-TOO-LARGE > ' + CACHE_TOGGLE_MAX_BODY + ' bytes');
                sendTooLarge(res);
                return;
            }
            // 连接中断等读流错误：不再尝试写响应（对端大概率已断开），留一行日志
            console.error('[prefs] CACHE-TOGGLE-BODY ' + String((err && err.message) || err));
            return;
        }
        try {
            if (text) {
                const j = JSON.parse(text);
                if (typeof j.enabled === 'boolean')
                    prefs.setChatCache(j.enabled);
            }
        }
        catch { }
        sendJson(res, { ok: true, enabled: prefs.chatCacheEnabled() });
    };
}
