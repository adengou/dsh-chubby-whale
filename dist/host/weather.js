/**
 * host/weather.ts —— 天气取数与清洗（`/briefing` 与 `/weather` 共用）
 *
 * 数据源：wttr.in（免费、无需 Key）。只在被请求时外呼一次，不做后台轮询。
 * `/briefing` 只要一行「多云 +19°C」；`/weather` 要结构化字段自己拼话，所以这里
 * 只负责「取 + 清洗」，怎么用交给调用方。
 *
 * 为什么清洗规则写在这一个地方：简报是**按行**切段的，任何含「待办/提醒」的行都会被
 * 客户端归到第二段；天气路由的气泡/TTS 也不能把 HTML 错误页念出来。两边同一套规则，
 * 避免一边修了另一边还在漏。
 */
/** 天气外呼超时：wttr.in 偶发很慢，到点就放掉，别让聊天/简报陪着等 */
export const WEATHER_TIMEOUT_MS = 6000;
/** 天气文本上限（按「字」= Unicode 码点）：正常十几个字，超长几乎都是错误页/HTML */
export const WEATHER_MAX_CHARS = 40;
/**
 * 天气文本清洗：压成单行 + 去控制字符 + 剥掉「待办/提醒」字样 + 按码点截断。
 *
 * 为什么必须做（客户端契约决定，不是美化）：
 *   · briefing 的 parseBriefing 按行切两段，**任何**含「待办/提醒」的行都会被归到第二段；
 *     wttr.in 出问题时会回多行错误页/HTML，原样拼进 text 就会凭空多出一个「待办」段、
 *     或者把日期/天气整行顶掉；
 *   · 正常回包也就十几个字，但错误页可能几百 KB——不截断会撑爆气泡与朗读（TTS 逐字念）。
 * 按码点截断，避免切出半个 emoji（与 host/personality/merge.ts 的 clampText 同一做法）。
 */
export function cleanWeather(raw) {
    const single = String(raw == null ? '' : raw)
        // 控制字符（含 \r \n \t）、零宽字符、行/段分隔符统一当空白
        .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    // 天气描述里出现这两个词没有正当理由，留着会污染 briefing 的两段切分
    const safe = single.replace(/待办|提醒/g, ' ').replace(/\s+/g, ' ').trim();
    const chars = Array.from(safe);
    return chars.length > WEATHER_MAX_CHARS ? chars.slice(0, WEATHER_MAX_CHARS).join('') : safe;
}
/** 城市名白名单：2–20 个汉字/字母（可带空格、中点、连字符），挡掉路径穿越与超长串 */
const CITY_RE = /^[\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 ·\-]{0,19}$/;
/** 数字字段归一：非有限数一律 null（缺字段不编 0） */
function num(raw) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}
/** wttr.in 的本地化描述在 `lang_zh-cn` 里（键名带连字符），其次是 `lang_xx`、最后英文 `weatherDesc` */
function pickDesc(c) {
    const groups = [c && c['lang_zh-cn'], c && c.lang_xx, c && c.weatherDesc];
    for (const g of groups) {
        try {
            const v = Array.isArray(g) && g.length ? g[0] : null;
            const s = v && typeof v === 'object' ? String(v.value || '') : String(v || '');
            const cleaned = cleanWeather(s);
            if (cleaned)
                return Array.from(cleaned).slice(0, 12).join('');
        }
        catch { }
    }
    return '';
}
/**
 * 取某城市当前天气。
 * @param city 城市名（中文/英文都行；wttr.in 自己解析）
 * @param opts.fetchImpl 测试注入；缺省用全局 fetch
 * @param opts.timeoutMs 覆盖默认 6s
 * @returns 失败一律 `{ ok:false, error }`，绝不抛错（调用方只判断 ok）
 */
export async function fetchWeatherNow(city, opts = {}) {
    const name = String(city == null ? '' : city).trim();
    if (!name)
        return { ok: false, error: 'NO_CITY' };
    if (!CITY_RE.test(name))
        return { ok: false, error: 'BAD_CITY' };
    const f = opts.fetchImpl || globalThis.fetch;
    if (typeof f !== 'function')
        return { ok: false, error: 'NO_FETCH' };
    const ms = typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
        ? opts.timeoutMs
        : WEATHER_TIMEOUT_MS;
    const url = 'https://wttr.in/' + encodeURIComponent(name) + '?format=j1&lang=zh-cn';
    /** 中止信号：优先 AbortSignal.timeout（Node 18+/现代浏览器），没有就退化成不设超时 */
    let signal;
    try {
        signal = AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
    }
    catch {
        signal = undefined;
    }
    let resp;
    try {
        resp = await f(url, signal ? { signal } : {});
    }
    catch (err) {
        console.error('[chubby-whale] WEATHER-FETCH-FAIL ' + String(err && err.message || err));
        return { ok: false, error: 'FETCH_FAIL' };
    }
    if (!resp || !resp.ok) {
        console.error('[chubby-whale] WEATHER-HTTP ' + String(resp && resp.status));
        return { ok: false, error: 'HTTP_' + String(resp && resp.status) };
    }
    let data = null;
    try {
        data = await resp.json();
    }
    catch {
        // wttr.in 被限流时会回纯文本 "Weather..."，不是 JSON
        console.error('[chubby-whale] WEATHER-BAD-JSON');
        return { ok: false, error: 'BAD_JSON' };
    }
    const c = data && Array.isArray(data.current_condition) ? data.current_condition[0] : null;
    if (!c)
        return { ok: false, error: 'NO_DATA' };
    const tempC = num(c.temp_C);
    const feelsLikeC = num(c.FeelsLikeC);
    const humidity = num(c.humidity);
    const windKmph = num(c.windspeedKmph);
    const desc = pickDesc(c);
    // 温度都没有的响应不拼（没法答「多少度」）
    if (tempC === null)
        return { ok: false, error: 'NO_TEMP' };
    const parts = [name + '现在' + (desc || '天气')];
    parts.push(String(Math.round(tempC)) + '℃');
    if (feelsLikeC !== null)
        parts.push('体感' + String(Math.round(feelsLikeC)) + '℃');
    if (humidity !== null)
        parts.push('湿度' + String(Math.round(humidity)) + '%');
    if (windKmph !== null)
        parts.push('风' + String(Math.round(windKmph)) + 'km/h');
    return {
        ok: true,
        city: name,
        text: cleanWeather(parts.join('，')),
        tempC,
        feelsLikeC,
        humidity,
        windKmph,
        desc,
    };
}
