/**
 * host/routes/weather.ts —— 实时天气路由（2026-11-14 新增，天气 A 方案）
 *
 *   GET /api/chubby-whale/weather?city=<城市>
 *     → { ok:true, city, text, tempC, feelsLikeC, humidity, windKmph, desc, cached? }
 *     → { ok:false, error }   // 没查到就说没查到，绝不编一个温度
 *
 * 只读：只认 GET/HEAD；非 GET 回 405，也不会因为一次误调去外呼。
 * 数据源与清洗规则在 host/weather.ts（与 /briefing 共用）。
 *
 * 进程内缓存 10 分钟：wttr.in 对高频请求会限流（实测连续几次会回纯文本 "Weather..."，
 * 不是 JSON），同城 10 分钟内复用上一次结果既省一次外呼，也避免主人连问两次就查不到。
 * 缓存只放内存、不落盘：重启即失效，不会把昨天的天气当成今天的。
 */
import { fetchWeatherNow } from '../weather.js';
import { sendJson } from '../respond.js';
/** 同城结果缓存：10 分钟（天气变化的最小可感知粒度；wttr.in 本身也是每小时级别更新） */
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
/** 没给城市时的默认城市（主人的简报城市是北海） */
const DEFAULT_CITY = '北海';
export function createWeatherHandler(opts = {}) {
    const ttl = typeof opts.cacheTtlMs === 'number' && Number.isFinite(opts.cacheTtlMs) && opts.cacheTtlMs >= 0
        ? opts.cacheTtlMs
        : DEFAULT_CACHE_TTL_MS;
    const cache = new Map();
    function nowMs() {
        try {
            const v = Number(opts.now ? opts.now() : Date.now());
            return Number.isFinite(v) ? v : Date.now();
        }
        catch {
            return Date.now();
        }
    }
    async function handleWeather(req, res) {
        const method = req && req.method ? String(req.method).toUpperCase() : 'GET';
        if (method !== 'GET' && method !== 'HEAD') {
            sendJson(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
            return;
        }
        let city = '';
        try {
            const u = new URL(String(req && req.url || ''), 'http://local');
            city = String(u.searchParams.get('city') || '').trim();
        }
        catch { }
        if (!city)
            city = DEFAULT_CITY;
        // 同一城市 10 分钟内直接复用（含失败结果？不：失败不缓存，下次还要再试）
        if (ttl > 0) {
            const hit = cache.get(city);
            if (hit && nowMs() - hit.at < ttl) {
                // cached 只对成功结果有意义；失败结果不进缓存
                if (hit.value && hit.value.ok) {
                    sendJson(res, { ...hit.value, cached: true });
                    return;
                }
                cache.delete(city);
            }
        }
        let out;
        try {
            out = await fetchWeatherNow(city, { fetchImpl: opts.fetchImpl });
        }
        catch (err) {
            // fetchWeatherNow 自己不抛；这里只是最后一道保险，别让天气把请求打挂
            console.error('[chubby-whale] WEATHER-FAIL ' + String(err && err.message || err));
            out = { ok: false, error: 'FETCH_FAIL' };
        }
        if (out && out.ok && ttl > 0)
            cache.set(city, { at: nowMs(), value: out });
        sendJson(res, out);
    }
    return { handleWeather };
}
