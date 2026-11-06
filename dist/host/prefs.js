/**
 * host/prefs.ts —— 插件偏好（prefs.json）与聊天缓存开关路由
 *
 * 偏好存运行目录（~/.dsh-chubby-whale/prefs.json），不进仓库、不与其他插件共享。
 * 原先这两件事都内联在 index.ts 的组装代码里（组装层写业务），现在独立成能力模块：
 * 新增一个偏好只改本文件；/cache-toggle 路由由工厂直接产出，index 只接线。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripBom, writeJsonAtomic } from './atomic.js';
import { sendJson } from './respond.js';
import { isBodyTooLarge, readBody, sendTooLarge } from './http.js';
/** /cache-toggle 请求体上限：只需一个 {"enabled":true}，16KB 足够，超限回 413 */
const CACHE_TOGGLE_MAX_BODY = 16 * 1024;
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
                warnBadFile('READ-FAIL ' + String(PREFS_FILE) + ' err=' + String((err && err.message) || err));
            }
            return {};
        }
        let parsed;
        try {
            parsed = JSON.parse(stripBom(text));
        }
        catch (err) {
            warnBadFile('READ-FAIL ' + String(PREFS_FILE) + ' 坏 JSON，已按默认值处理 err=' + String((err && err.message) || err));
            return {};
        }
        if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            warnBadFile('READ-FAIL ' + String(PREFS_FILE) + ' 形状不是对象，已按默认值处理');
            return {};
        }
        return parsed;
    }
    function save(p) {
        // 原子写：写坏一次就整份偏好丢失（与 store 同一套工具）
        try {
            writeJsonAtomic(PREFS_FILE, p);
        }
        catch (err) {
            console.error('[prefs] WRITE-FAIL ' + String(PREFS_FILE) + ' err=' + String(err?.message || err));
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
