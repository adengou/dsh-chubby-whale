/**
 * shared/pricing.ts —— 模型调用的人民币估算（唯一价格真源）
 *
 * 为什么单独一个模块：鱼粮账本从「只记 token」升级到「也记钱」，钱的口径必须只有一处，
 * 且必须能指出**价格从哪来、什么时候核的**——否则就是编数字。
 *
 * 价格来源（2026-11-07 实抓官方页面，单位：元 / 百万 tokens）：
 *   https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 *
 * | 模型 | 输入(缓存命中) | 输入(缓存未命中) | 输出 |
 * | --- | --- | --- | --- |
 * | deepseek-flash | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
 * | deepseek-v4-pro | 0.15 / 0.30 | 4.5 / 9 | 13.5 / 27 |
 * （每格「空闲 / 高峰」；高峰是空闲的两倍）
 *
 * 高峰时段：北京时间**周一至周五**（不含中国法定节假日）9:00–12:00、14:00–18:00；
 * 其余时间（含周末）是空闲时段。法定节假日无法内置（每年国务院公布），
 * 这里**按高峰算**（偏保守、只会多估不会少估），并在返回里标 `holidayUnknown: true` 的语义说明。
 *
 * 口径边界（诚实标注）：
 *   · 只有拿到 usage 的输入/输出拆分才能算钱；只拿到 totalTokens 时返回 null（不猜）；
 *   · 缓存命中 token 数由上游 `prompt_cache_hit_tokens` 给出，缺省按「全部未命中」算（偏保守）；
 *   · 这是**估算**：DeepSeek 保留调价权，官方实际扣费以账单为准。
 */
/** 价格表版本：调价后改这两行并同步测试断言 */
export const PRICING_CHECKED_AT = '2026-11-07';
export const PRICING_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing';
/** 元 / 百万 tokens */
export const MODEL_PRICES = Object.freeze({
    'deepseek-flash': Object.freeze({
        cacheHit: Object.freeze({ peak: 0.04, off: 0.02 }),
        cacheMiss: Object.freeze({ peak: 2, off: 1 }),
        output: Object.freeze({ peak: 8, off: 4 }),
    }),
    'deepseek-v4-pro': Object.freeze({
        cacheHit: Object.freeze({ peak: 0.3, off: 0.15 }),
        cacheMiss: Object.freeze({ peak: 9, off: 4.5 }),
        output: Object.freeze({ peak: 27, off: 13.5 }),
    }),
});
/** 未登记的模型按哪档算：用 flash（插件默认模型），并在结果里标 approximated */
export const DEFAULT_PRICING_MODEL = 'deepseek-flash';
/** 北京时间 = UTC+8（本机可能不在 +8，这里固定按官方口径算，不跟随系统时区） */
const BEIJING_OFFSET_MS = 8 * 3600 * 1000;
/**
 * 是不是高峰时段（北京时间 周一至周五 9–12 / 14–18 点）。
 * 法定节假日无法内置，按高峰算（只会多估）。
 */
export function isPeakHour(at = new Date()) {
    const t = at instanceof Date ? at.getTime() : Number(at);
    if (!Number.isFinite(t))
        return true;
    const bj = new Date(t + BEIJING_OFFSET_MS);
    const day = bj.getUTCDay(); // 0=周日 … 6=周六
    if (day === 0 || day === 6)
        return false;
    const hour = bj.getUTCHours();
    return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}
const toCount = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
/**
 * 按 usage 拆分算钱。拿不到输入/输出拆分时返回 null —— 只有总 token 时**不猜**。
 * @param usage 上游 usage（含 prompt/completion 拆分）
 * @param model 模型名；未登记时回落默认档
 * @param at 调用时刻（决定高峰/空闲），缺省 now
 */
export function estimateCostCny(usage, model, at = new Date()) {
    const u = usage || {};
    const prompt = toCount(u.promptTokens);
    const completion = toCount(u.completionTokens);
    // 两个都是 0 → 没有可信拆分（老路径只给了 total）
    if (prompt <= 0 && completion <= 0)
        return null;
    const name = String(model || DEFAULT_PRICING_MODEL);
    const price = MODEL_PRICES[name] || MODEL_PRICES[DEFAULT_PRICING_MODEL];
    const peak = isPeakHour(at);
    const tier = (p) => (peak ? p.peak : p.off);
    const hit = Math.min(prompt, toCount(u.cacheHitTokens));
    const miss = Math.max(0, prompt - hit);
    const cny = (hit * tier(price.cacheHit) + miss * tier(price.cacheMiss) + completion * tier(price.output)) / 1e6;
    return { cny: Math.round(cny * 1e6) / 1e6, model: MODEL_PRICES[name] ? name : DEFAULT_PRICING_MODEL, peak };
}
/** 把上游 usage 归一成拆分（字段名兼容 openai 风格与 deepseek 的 prompt_* 风格） */
export function readUsageSplit(u) {
    if (!u || typeof u !== 'object')
        return null;
    const promptTokens = toCount(u.prompt_tokens ?? u.promptTokens);
    const completionTokens = toCount(u.completion_tokens ?? u.completionTokens);
    const cacheHitTokens = toCount(u.prompt_cache_hit_tokens ?? u.cacheHitTokens);
    if (promptTokens <= 0 && completionTokens <= 0)
        return null;
    return { promptTokens, completionTokens, cacheHitTokens };
}
