/**
 * host/routes/poem-titles.ts —— 诗名索引路由（客户端「点诗」识别按需拉取）
 *
 * GET /api/chubby-whale/poem-titles
 *   成功 → { ok: true, count, titles: [...] }
 *   失败 → { ok: false, titles: [], error }（文件缺失/坏 JSON/空表都走这里；HTTP 仍 200，
 *          与既有「200 承载业务失败」约定一致）
 *
 * 为什么单独一条路由：634 个标题约 11 KB，原先内联在 client bundle 里，
 * 改成按需下发后只有真正点诗的人付这份体积。
 *
 * 取数口径（ADR 0002「路由只经端口取数据」）：
 *   · 优先 `opts.dataPort.readPoemTitles()`（DataPort 上的可选方法，本地/云端各自实现）。
 *     端口存在就**只认端口**：返回 null / 空表都按既有 ok:false 兜底，不再回读文件；
 *   · 只有端口**根本没有该能力**（旧宿主装配 / 离线单测的假端口）时才回退读包内文件，
 *     原因与移除条件见 loadTitlesFromFile 上方注释。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sendJson } from '../respond.js';
export function createPoemTitlesHandler(opts) {
    // 生产装配（index.ts）总会传 DATA_DIR；这里兜底用 cwd/data（与 client seedFromDisk 的查找出发点一致）
    const FILE = join(opts.dataDir || join(process.cwd(), 'data'), 'poem-titles.json');
    /** 成功读到的标题（只缓存成功结果：文件后来补上时不用重启就能恢复）——仅文件回退分支使用 */
    let cached = null;
    /** 过滤空串/非字符串：端口与文件两条路径共用同一口径，响应字段不变 */
    function pickTitles(list) {
        const out = [];
        if (!Array.isArray(list))
            return out;
        for (const item of list)
            if (typeof item === 'string' && item)
                out.push(item);
        return out;
    }
    /**
     * 过渡回退：从包内 data/poem-titles.json 读（改造前的唯一取数路径）。
     *
     * 为什么还留着：`DataPort.readPoemTitles` 是 2026-11-07（B86 数据端口收口）才加的
     * 可选方法。离线环境、测试里的最小假端口、以及还没升级装配层的旧宿主都可能没有
     * 这个方法；若把它当必选，这些宿主会直接拿不到诗名。端口能力存在时本函数**不会被调用**
     * （见 handlePoemTitles 的 fromPort 判断），所以不影响新装配。
     *
     * 移除条件：`DataPort.readPoemTitles` 改为必选、且装配层已注入端口
     * （index.ts 的 `createPoemTitlesHandler({ dataDir: DATA_DIR, dataPort })`）之后，
     * 删掉本函数、FILE、cached 以及 node:fs / node:path 两个 import。
     */
    function loadTitlesFromFile() {
        if (cached)
            return cached;
        const raw = readFileSync(FILE, 'utf8');
        const data = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
        const titles = pickTitles(data && data.titles);
        if (titles.length === 0)
            throw new Error('empty titles');
        cached = titles;
        return titles;
    }
    async function handlePoemTitles(_req, res) {
        // 只看「端口有没有这个方法」：有就只认端口（null 也算端口给出的结论），绝不再碰文件
        const fromPort = typeof (opts.dataPort && opts.dataPort.readPoemTitles) === 'function';
        try {
            let titles;
            if (fromPort) {
                // 端口实现承诺不抛（坏 JSON/缺文件 → null）；空表按没数据走既有失败兜底
                const data = await opts.dataPort.readPoemTitles();
                titles = pickTitles(data && data.titles);
                if (titles.length === 0)
                    throw new Error('empty titles');
            }
            else {
                titles = loadTitlesFromFile();
            }
            sendJson(res, { ok: true, count: titles.length, titles });
        }
        catch (err) {
            // 读不到就明确报失败：客户端会降级为「不识别具体诗名」，其他意图照常
            const src = fromPort ? ' source=dataPort' : ' file=' + FILE;
            console.error('POEM-TITLES-LOAD-FAIL' + src + ' err=' + String((err && err.message) || err));
            sendJson(res, { ok: false, titles: [], error: String((err && err.message) || err) });
        }
    }
    return { handlePoemTitles };
}
