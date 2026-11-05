/**
 * host/routes/personality.ts —— L2 可变人格 + L3 近期心境的读写接口
 *
 *   GET  /api/chubby-whale/personality          读当前可变人格（含 selfNarrative/selfNarrativeAt）+ 历史
 *   POST /api/chubby-whale/personality/revert   回滚上一条变更（把最后一条历史的 old 恢复，心境同样适用）
 *
 * 只依赖注入的 PersonalityRepo 与状态读取器，不直接摸文件；
 * 路由注册在 host/routes.ts 的路由表里，入口只接线。
 *
 * 响应形态：顶层平铺当前值（catchphrases/preferences/notes/selfNarrative/selfNarrativeAt/
 * version/updatedAt），同一份再放进 personality 子对象，前端取哪种都行；history 单独给。
 * learning / writing 两块分别报告 L2 学习与 L3 自写的开关与计数器，互不混淆。
 */
import { sendJson, sendError } from '../respond.js';
import { PERSONALITY_LIMITS } from '../personality.js';
export function createPersonalityHandlers(opts) {
    function snapshot() {
        const p = opts.repo.load();
        const enabled = opts.learningEnabled ? opts.learningEnabled() !== false : true;
        const learning = opts.learnerStatus ? opts.learnerStatus() : { enabled };
        const writingEnabled = opts.writingEnabled ? opts.writingEnabled() !== false : true;
        const writing = opts.writerStatus ? opts.writerStatus() : { enabled: writingEnabled };
        const current = {
            catchphrases: p.catchphrases,
            preferences: p.preferences,
            notes: p.notes,
            selfNarrative: p.selfNarrative,
            selfNarrativeAt: p.selfNarrativeAt,
            version: p.version,
            updatedAt: p.updatedAt,
        };
        return {
            ok: true,
            enabled,
            writingEnabled,
            ...current,
            personality: current,
            history: p.history,
            limits: PERSONALITY_LIMITS,
            learning,
            writing,
        };
    }
    /** 读当前可变人格 + 历史；非 GET 回 405（本插件惯例：业务失败也用 JSON 说明） */
    function handlePersonality(req, res) {
        try {
            const method = req && req.method ? String(req.method).toUpperCase() : 'GET';
            if (method !== 'GET' && method !== 'HEAD') {
                sendJson(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
                return;
            }
            sendJson(res, snapshot());
        }
        catch (err) {
            sendError(res, err);
        }
    }
    /** 回滚上一条变更；没有历史时回 ok:false + NO_HISTORY，并带上当前快照方便前端刷新 */
    async function handleRevert(req, res) {
        try {
            const method = req && req.method ? String(req.method).toUpperCase() : '';
            if (method !== 'POST') {
                sendJson(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
                return;
            }
            // 回滚不需要请求体；客户端若发了 body，顺手排空，避免占着 keep-alive 连接
            try {
                if (req && typeof req.resume === 'function' && !req.readableEnded)
                    req.resume();
            }
            catch { }
            const result = opts.repo.revert();
            if (!result) {
                sendJson(res, { ...snapshot(), ok: false, error: 'NO_HISTORY' });
                return;
            }
            if (!result.saved) {
                sendJson(res, { ...snapshot(), ok: false, error: 'SAVE_FAILED' });
                return;
            }
            sendJson(res, { ...snapshot(), ok: true, reverted: result.entry });
        }
        catch (err) {
            sendError(res, err);
        }
    }
    return { handlePersonality, handleRevert };
}
