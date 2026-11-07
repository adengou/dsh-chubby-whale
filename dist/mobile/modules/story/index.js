// @ts-nocheck
/**
 * dsh-whale-mobile · story 模块「说书」
 *
 * 契约：
 *   createStoryModule(deps) -> Object.freeze({
 *     name, version, health, tell, list, get, remove, dispose
 *   })
 *
 * 约束：
 *   - 纯 ESM，零外部依赖（不 import 任何包）
 *   - 只通过 deps 注入的 llm / store / clock / logger / config 与宿主通信
 *   - 内部状态全部收敛在闭包里，不暴露任何内部字段
 */
const STORE_KEY = 'story.items';
const MODULE_NAME = 'story';
const MODULE_VERSION = '0.1.0';
const DEFAULT_WORDS = 800;
const MIN_WORDS = 200;
const MAX_WORDS = 3000;
const DEFAULT_MAX_WORDS = 3000;
const DEFAULT_HISTORY_LIMIT = 30;
const DEFAULT_TIMEOUT_MS = 60000;
const FAIL_PREFIX = '说书失败：';
const TITLE_MAX_CHARS = 80;
const TOPIC_MAX_CHARS = 120;
const STYLE_MAX_CHARS = 60;
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const ID_SUFFIX_LENGTH = 4;
const CJK_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;
const LATIN_WORD_PATTERN = /[A-Za-z]+(?:['’\-][A-Za-z]+)*/g;
/* ------------------------------------------------------------------ */
/* 纯函数工具（不依赖闭包）                                            */
/* ------------------------------------------------------------------ */
function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}
function randomSuffix(length) {
    let suffix = '';
    for (let index = 0; index < length; index += 1) {
        suffix += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
    }
    return suffix;
}
/**
 * 粗略字数：中文字符数（逐字）+ 英文单词数（按词）。
 * 不使用 String#length，因为标点、空白和换行不应计入口语化字数。
 */
function countWords(text) {
    if (typeof text !== 'string' || text.length === 0)
        return 0;
    const cjk = text.match(CJK_PATTERN);
    const latin = text.match(LATIN_WORD_PATTERN);
    return (cjk ? cjk.length : 0) + (latin ? latin.length : 0);
}
function normalizeField(value, maxLength) {
    if (typeof value !== 'string')
        return '';
    return value
        .replace(/[\u0000-\u001F\u007F]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}
function cleanTitle(value) {
    const cleaned = String(value == null ? '' : value)
        .replace(/[*_`#]/g, '')
        .replace(/^[「『“"'《<]+/, '')
        .replace(/[」』”"'》>]+$/, '')
        .replace(/\s+/g, ' ')
        .replace(/[。.!！?？、，,；;：:]+$/, '')
        .trim();
    if (!cleaned)
        return null;
    const clipped = cleaned.slice(0, TITLE_MAX_CHARS).trim();
    return clipped || null;
}
/** 识别首行标题：`# 标题`、`标题：xxx`、`**标题**` */
function extractTitle(line) {
    if (typeof line !== 'string')
        return null;
    let match = line.match(/^#{1,6}\s+(.+)$/);
    if (match)
        return cleanTitle(match[1]);
    match = line.match(/^(?:标题|题目|title)\s*[：:]\s*(.+)$/i);
    if (match)
        return cleanTitle(match[1]);
    match = line.match(/^\*\*(.+?)\*\*$/);
    if (match)
        return cleanTitle(match[1]);
    return null;
}
function stripCodeFence(text) {
    const match = text.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
    return match ? match[1].trim() : text;
}
/**
 * 把模型输出拆成 { title, text }。
 * 任何解析异常都必须退化成「无标题 + 原文正文」，绝不能让整个请求失败。
 */
function splitTitleAndBody(raw) {
    let text = String(raw == null ? '' : raw).replace(/^\uFEFF/, '').trim();
    text = stripCodeFence(text).trim();
    if (!text)
        return { title: null, text: '' };
    const lines = text.split(/\r?\n/);
    let firstIndex = -1;
    for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].trim() !== '') {
            firstIndex = index;
            break;
        }
    }
    if (firstIndex === -1)
        return { title: null, text: '' };
    const firstLine = lines[firstIndex].trim();
    const title = extractTitle(firstLine);
    if (title) {
        const body = lines.slice(firstIndex + 1).join('\n').trim();
        if (body)
            return { title, text: body };
        // 只有标题没有正文：保留整段内容，标题走兜底，绝不抛错。
        return { title: null, text: firstLine };
    }
    return { title: null, text: lines.slice(firstIndex).join('\n').trim() };
}
function safeParseStory(raw) {
    try {
        return splitTitleAndBody(raw);
    }
    catch {
        return {
            title: null,
            text: typeof raw === 'string' ? raw.trim() : '',
        };
    }
}
function buildFallbackTitle(topic, ordinal) {
    if (topic) {
        const shortTopic = topic.length > 40 ? `${topic.slice(0, 40)}…` : topic;
        return `关于${shortTopic}的故事`;
    }
    return `本鱼的第${ordinal}个故事`;
}
function describeTimeout(milliseconds) {
    return milliseconds >= 1000
        ? `${Math.round(milliseconds / 100) / 10} 秒`
        : `${Math.round(milliseconds)} 毫秒`;
}
function describeError(error) {
    if (error === null || error === undefined)
        return '未知错误';
    if (typeof error === 'string')
        return error.trim() || '未知错误';
    if (typeof error.message === 'string' && error.message.trim()) {
        return error.message.trim();
    }
    try {
        return String(error);
    }
    catch {
        return '未知错误';
    }
}
/* ------------------------------------------------------------------ */
/* 工厂                                                                */
/* ------------------------------------------------------------------ */
/**
 * @param {{
 *   llm: { generate: Function, stream?: Function },
 *   store: { get: Function, set: Function },
 *   clock?: { now: Function },
 *   logger?: { info?: Function, warn?: Function, error?: Function },
 *   config?: { maxWords?: number, historyLimit?: number, timeoutMs?: number }
 * }} deps
 */
export function createStoryModule(deps) {
    if (!deps || typeof deps !== 'object') {
        throw new TypeError('createStoryModule(deps)：deps 必须是对象');
    }
    if (!deps.llm || typeof deps.llm.generate !== 'function') {
        throw new TypeError('createStoryModule(deps)：deps.llm.generate 必须是函数');
    }
    if (!deps.store ||
        typeof deps.store.get !== 'function' ||
        typeof deps.store.set !== 'function') {
        throw new TypeError('createStoryModule(deps)：deps.store.get / deps.store.set 必须是函数');
    }
    const { llm, store } = deps;
    const clock = deps.clock && typeof deps.clock.now === 'function'
        ? deps.clock
        : { now: () => Date.now() };
    const logger = deps.logger && typeof deps.logger === 'object' ? deps.logger : {};
    const rawConfig = deps.config && typeof deps.config === 'object' ? deps.config : {};
    const wordCap = Math.min(MAX_WORDS, Math.max(1, Math.floor(positiveNumber(rawConfig.maxWords, DEFAULT_MAX_WORDS))));
    const historyLimit = Math.max(1, Math.floor(positiveNumber(rawConfig.historyLimit, DEFAULT_HISTORY_LIMIT)));
    const timeoutMs = Math.max(10, Math.floor(positiveNumber(rawConfig.timeoutMs, DEFAULT_TIMEOUT_MS)));
    /* ---------------- 闭包内状态 ---------------- */
    let disposed = false;
    let disposePromise = null;
    let storeTouched = false;
    let cachedCount = 0;
    let queue = Promise.resolve();
    const activeControllers = new Set();
    const inflightTells = new Set();
    /* ---------------- 基础工具 ---------------- */
    function safeLog(level, message, meta) {
        try {
            const method = logger[level];
            if (typeof method === 'function')
                method.call(logger, message, meta);
        }
        catch {
            /* 日志失败不影响主流程 */
        }
    }
    function now() {
        try {
            const value = Number(clock.now());
            return Number.isFinite(value) ? value : Date.now();
        }
        catch {
            return Date.now();
        }
    }
    function storyError(message, cause) {
        const text = describeError(message);
        const full = text.startsWith(FAIL_PREFIX) ? text : `${FAIL_PREFIX}${text}`;
        const error = new Error(full);
        error.name = 'StoryError';
        error.isStoryError = true;
        if (cause !== undefined)
            error.cause = cause;
        return error;
    }
    function normalizeFailure(error) {
        if (error && error.isStoryError)
            return error;
        if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) {
            return storyError(disposed ? '模块已释放，讲故事被中止' : '请求被中止', error);
        }
        return storyError(describeError(error), error);
    }
    function cloneStory(source) {
        const record = source && typeof source === 'object' ? source : {};
        return {
            id: typeof record.id === 'string' ? record.id : '',
            title: typeof record.title === 'string' ? record.title : '',
            text: typeof record.text === 'string' ? record.text : '',
            topic: typeof record.topic === 'string' ? record.topic : '',
            style: typeof record.style === 'string' ? record.style : '',
            createdAt: Number.isFinite(record.createdAt) ? record.createdAt : 0,
            wordCount: Number.isFinite(record.wordCount) ? record.wordCount : 0,
        };
    }
    function summarize(story) {
        const record = cloneStory(story);
        return {
            id: record.id,
            title: record.title,
            createdAt: record.createdAt,
            wordCount: record.wordCount,
            topic: record.topic,
        };
    }
    function updateCount(items) {
        storeTouched = true;
        cachedCount = Object.keys(items).length;
    }
    function enqueue(task) {
        if (disposed)
            return Promise.reject(storyError('模块已释放'));
        const run = queue.then(task);
        queue = run.then(() => undefined, () => undefined);
        return run;
    }
    /**
     * 读取故事库。tolerant=true 时读失败返回空库（用于只读接口与计数水合）；
     * 写路径必须用严格模式，避免读失败后把旧故事覆盖掉。
     */
    async function readItems(options) {
        const tolerant = Boolean(options && options.tolerant);
        let raw;
        try {
            raw = await store.get(STORE_KEY, {});
        }
        catch (error) {
            if (!tolerant)
                throw storyError('读取故事库失败', error);
            safeLog('warn', '[story] 读取故事库失败，按空库处理', error);
            return {};
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            return {};
        const items = {};
        for (const [id, value] of Object.entries(raw)) {
            if (!value || typeof value !== 'object' || Array.isArray(value))
                continue;
            if (typeof id !== 'string' || id === '')
                continue;
            items[id] = cloneStory(value);
        }
        return items;
    }
    /** 只保留最近 historyLimit 条（按 createdAt 升序删除最旧）。 */
    function prune(items) {
        const entries = Object.entries(items);
        if (entries.length <= historyLimit)
            return [];
        entries.sort((left, right) => left[1].createdAt - right[1].createdAt);
        const removed = [];
        while (entries.length > historyLimit) {
            const oldest = entries.shift();
            if (!oldest)
                break;
            delete items[oldest[0]];
            removed.push(oldest[0]);
        }
        return removed;
    }
    function createId(timestamp, items) {
        const base = `s_${Math.floor(timestamp).toString(36)}`;
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const id = `${base}${randomSuffix(ID_SUFFIX_LENGTH)}`;
            if (!Object.prototype.hasOwnProperty.call(items, id))
                return id;
        }
        return `${base}${randomSuffix(ID_SUFFIX_LENGTH + 2)}`;
    }
    function resolveWordTarget(value) {
        const requested = Number(value);
        const base = Number.isFinite(requested) && requested > 0
            ? Math.floor(requested)
            : DEFAULT_WORDS;
        const inRange = Math.min(MAX_WORDS, Math.max(MIN_WORDS, base));
        return Math.max(1, Math.min(inRange, wordCap));
    }
    function buildGenerationOptions({ topic, style, words }) {
        const system = [
            '你是「大肥鱼」——一条圆滚滚、软乎乎的 AI 胖鱼，最爱吃白饭，碗底压着偷吃来的 token。',
            '现在请你用大肥鱼的口吻，讲一个完整的原创故事。',
            '',
            '硬性要求：',
            '1. 故事必须有开头、发展、转折、收尾，是一篇完整的短篇故事，不是片段、提纲或流水账。',
            '2. 可以自然地掺进鱼、白饭、token 这些自家元素，但不要生硬堆砌，按主题取舍。',
            '3. 输出格式：第一行只写故事标题，形如「# 标题」；空一行后开始写正文。',
            '4. 只输出标题和正文，不要任何解释、前言、后记、点评，也不要用 ``` 代码块包裹。',
            `5. 字数目标：约 ${words} 字（中文字符计），允许上下浮动两成。`,
        ].join('\n');
        const userLines = [];
        userLines.push(topic ? `主题：${topic}` : '主题：自由发挥，讲一个连你自己都想钻进去的故事。');
        if (style)
            userLines.push(`风格：${style}`);
        userLines.push(`字数目标：约 ${words} 字。`);
        userLines.push('请按约定格式开始讲故事（第一行 # 标题，空行后正文）。');
        return {
            system,
            messages: [{ role: 'user', text: userLines.join('\n') }],
            maxTokens: Math.min(8192, Math.max(512, Math.round(words * 2) + 256)),
            temperature: 0.85,
        };
    }
    /* ---------------- 生成 ---------------- */
    async function generateStory({ topic, style, words }) {
        const controller = new AbortController();
        activeControllers.add(controller);
        let timedOut = false;
        let timer = null;
        const abortPromise = new Promise((_, reject) => {
            const onAbort = () => {
                if (timer !== null) {
                    clearTimeout(timer);
                    timer = null;
                }
                if (timedOut) {
                    reject(storyError(`模型生成超时（${describeTimeout(timeoutMs)}）`));
                    return;
                }
                reject(storyError(disposed ? '模块已释放，讲故事被中止' : '请求被中止'));
            };
            if (controller.signal.aborted)
                onAbort();
            else
                controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        timer = setTimeout(() => {
            timedOut = true;
            try {
                controller.abort();
            }
            catch {
                /* 忽略 abort 自身的异常 */
            }
        }, timeoutMs);
        try {
            const options = {
                ...buildGenerationOptions({ topic, style, words }),
                signal: controller.signal,
            };
            const pending = Promise.resolve().then(() => llm.generate(options));
            const output = await Promise.race([pending, abortPromise]);
            if (typeof output !== 'string' || output.trim() === '') {
                throw storyError('模型没有返回故事内容');
            }
            return output;
        }
        finally {
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            activeControllers.delete(controller);
        }
    }
    /* ---------------- 业务实现 ---------------- */
    async function tellStory(input) {
        const rawInput = input && typeof input === 'object' ? input : {};
        const topic = normalizeField(rawInput.topic, TOPIC_MAX_CHARS);
        const style = normalizeField(rawInput.style, STYLE_MAX_CHARS);
        const words = resolveWordTarget(rawInput.words);
        safeLog('info', '[story] 开始讲故事', {
            topic: topic || '（自由发挥）',
            style: style || '默认',
            words,
        });
        let rawText;
        try {
            rawText = await generateStory({ topic, style, words });
        }
        catch (error) {
            const failure = normalizeFailure(error);
            safeLog('error', '[story] 故事生成失败', failure);
            throw failure;
        }
        const parsed = safeParseStory(rawText);
        if (!parsed.text) {
            throw storyError('模型没有返回故事正文');
        }
        let record;
        try {
            record = await enqueue(async () => {
                if (disposed)
                    throw storyError('模块已释放，讲故事被中止');
                const items = await readItems();
                const createdAt = now();
                const existing = Object.keys(items).length;
                const id = createId(createdAt, items);
                const title = parsed.title || buildFallbackTitle(topic, existing + 1);
                const story = {
                    id,
                    title,
                    text: parsed.text,
                    topic,
                    style,
                    createdAt,
                    wordCount: countWords(parsed.text),
                };
                items[id] = story;
                const pruned = prune(items);
                try {
                    await store.set(STORE_KEY, items);
                }
                catch (error) {
                    safeLog('error', '[story] 保存故事失败', error);
                    throw storyError('故事保存失败', error);
                }
                updateCount(items);
                if (pruned.length > 0) {
                    safeLog('info', '[story] 清理超出上限的旧故事', {
                        removed: pruned.length,
                        historyLimit,
                    });
                }
                return story;
            });
        }
        catch (error) {
            throw normalizeFailure(error);
        }
        safeLog('info', '[story] 故事讲完了', {
            id: record.id,
            title: record.title,
            wordCount: record.wordCount,
        });
        return cloneStory(record);
    }
    function tell(input) {
        if (disposed) {
            return Promise.reject(storyError('模块已释放，不能再讲故事了'));
        }
        const operation = tellStory(input);
        inflightTells.add(operation);
        const cleanup = () => {
            inflightTells.delete(operation);
        };
        operation.then(cleanup, cleanup);
        return operation;
    }
    async function list() {
        const items = await readItems({ tolerant: true });
        updateCount(items);
        return Object.values(items)
            .map(summarize)
            .sort((left, right) => right.createdAt - left.createdAt);
    }
    async function get(id) {
        if (typeof id !== 'string' || id === '')
            return null;
        const items = await readItems({ tolerant: true });
        updateCount(items);
        if (!Object.prototype.hasOwnProperty.call(items, id))
            return null;
        const story = items[id];
        return story ? cloneStory(story) : null;
    }
    async function remove(id) {
        if (disposed)
            return false;
        if (typeof id !== 'string' || id === '')
            return false;
        try {
            return await enqueue(async () => {
                if (disposed)
                    return false;
                const items = await readItems();
                if (!Object.prototype.hasOwnProperty.call(items, id)) {
                    updateCount(items);
                    return false;
                }
                delete items[id];
                try {
                    await store.set(STORE_KEY, items);
                }
                catch (error) {
                    safeLog('error', '[story] 删除故事失败', error);
                    return false;
                }
                updateCount(items);
                safeLog('info', '[story] 已删除故事', { id });
                return true;
            });
        }
        catch (error) {
            safeLog('error', '[story] 删除故事失败', error);
            return false;
        }
    }
    function health() {
        return { ok: true, stories: cachedCount };
    }
    function dispose() {
        if (disposePromise)
            return disposePromise;
        disposed = true;
        const pending = [...inflightTells];
        for (const controller of activeControllers) {
            try {
                controller.abort();
            }
            catch {
                /* 忽略 abort 自身的异常 */
            }
        }
        activeControllers.clear();
        disposePromise = Promise.allSettled([queue, ...pending])
            .catch(() => undefined)
            .then(() => {
            safeLog('info', '[story] 模块已释放');
        });
        return disposePromise;
    }
    /* ---------------- 初始化：后台水合故事数 ---------------- */
    readItems({ tolerant: true })
        .then((items) => {
        if (!storeTouched && !disposed)
            cachedCount = Object.keys(items).length;
    })
        .catch(() => undefined);
    /* ---------------- 对外接口 ---------------- */
    return Object.freeze({
        name: MODULE_NAME,
        version: MODULE_VERSION,
        health,
        tell,
        list,
        get,
        remove,
        dispose,
    });
}
