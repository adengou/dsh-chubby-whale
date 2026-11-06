/**
 * host/routes/config.ts —— 只读配置视图（2026-11-06 新增）
 *
 * 为什么：设置项现在都在 config.json 里手改，主人看不到"当前生效的是什么"。
 * 这里只**读**、绝不写（写配置需要校验与备份，风险高，单独立项）。
 *
 *   GET /api/chubby-whale/config
 *     → { ok, enabled, dataSource, model,
 *         personalityLearning, personalityWriting, cacheEnabled,
 *         hasDeepseekKey, hasSiliconflowKey }   // 只报"有没有"，绝不回 Key 内容
 *
 * 约定：不因读取失败而 500——各字段各自兜底，读不到就给缺省值。
 */
import { sendJson } from '../respond.js';
export function createConfigViewHandler(opts) {
    /** 逐字段安全取值（任何 getter 抛错都不影响整包） */
    function safe(fn, fallback) {
        try {
            if (typeof fn !== 'function')
                return fallback;
            const v = fn();
            return v == null ? fallback : v;
        }
        catch {
            return fallback;
        }
    }
    async function handleConfig(req, res) {
        try {
            const method = req && req.method ? String(req.method).toUpperCase() : 'GET';
            if (method !== 'GET' && method !== 'HEAD') {
                sendJson(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
                return;
            }
            sendJson(res, {
                ok: true,
                enabled: safe(opts.enabled, true),
                dataSource: String(safe(opts.dataSource, 'local')),
                model: String(safe(opts.model, '')),
                personalityLearning: safe(opts.personalityLearning, true),
                personalityWriting: safe(opts.personalityWriting, true),
                cacheEnabled: safe(opts.cacheEnabled, true),
                // 只报有没有 Key，绝不回内容
                hasDeepseekKey: safe(opts.hasDeepseekKey, false),
                hasSiliconflowKey: safe(opts.hasSiliconflowKey, false),
            });
        }
        catch {
            // 兜底：配置视图永远不把请求打挂
            try {
                sendJson(res, { ok: false, error: 'CONFIG_VIEW_FAILED' });
            }
            catch { }
        }
    }
    return { handleConfig };
}
