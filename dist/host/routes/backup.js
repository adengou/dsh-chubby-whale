/**
 * host/routes/backup.ts —— 一键备份 / 导入（HTTP 层）
 *
 *   GET  /api/chubby-whale/data/export   导出（JSON，≤2MB，超了 413）
 *   POST /api/chubby-whale/data/import   导入（body ≤2MB，超了 413）
 *
 * 本文件只做 HTTP 层：方法校验、读请求体、状态码、响应组装。数据规则按职责拆在 backup/ 下：
 *   backup/fields.ts   8 个字段白名单、字段上限、逐字段类型清洗（含原型污染防护）
 *   backup/export.ts   导出包组装与体积判定（只读，不碰 config / Key）
 *   backup/import.ts   请求体判定（413/400）、逐字段清洗并写盘、imported/skipped 报告
 *
 * 安全边界（写死在本模块的设计里，不靠调用方自觉）：
 *   · 导出只经注入的 load* 读取记忆/人格/状态/成长/鱼粮/宠物/提醒/说书进度，
 *     **不读 config.json、不读环境变量、不 import host/config.ts**——API Key 没有进入导出包的通路；
 *     聊天原文按“备份恢复”语义保留（审计口径见 backup/export.ts 头注释）；
 *   · 导入只认 8 个数据字段，逐字段过类型清洗后经注入的 save* 原子写落盘；
 *     **没有任何写 config.json / 改 Key 的分支**；version / exportedAt / ok 是导出包元数据，
 *     认识但不写盘；其余字段一律进 skipped 并计数（apiKey、deepseekKey、config、__proto__ 之类）；
 *   · 人格导入再过一遍 sanitizePersonality + CORE_GUARD：模型/手改文件/外部备份都写不进
 *     核心设定（名字/家人/生日/语言规则）；
 *   · 体积：导出先序列化再量 UTF-8 字节数，超限 413 不带部分数据；导入由 readBody 在读取
 *     阶段先看 content-length、读中累计超限即断连，**不是读完整个 body 再判断**。
 *
 * 本文件不直接 import 任何仓储实现；写盘复用注入的 save*（内部各自走 host/atomic.ts 原子写），
 * 因此本文件不额外落任何新文件。
 */
import { sendJson, sendError } from '../respond.js';
import { readJsonBody } from '../body.js';
import { sendTooLarge } from '../http.js';
import { BACKUP_MAX_BYTES } from '../backup/fields.js';
import { buildExport, measureExportBytes, isExportTooLarge } from '../backup/export.js';
import { parseImportBody, runImport } from '../backup/import.js';
// 兼容旧导入路径：拆分前这些名字都从 routes/backup.ts 导出，测试与外部调用方仍从这里取。
// 值/类型与 backup/fields.ts 同源（re-export，不是第二份拷贝）。
export { BACKUP_MAX_BYTES, BACKUP_DATA_FIELDS, BACKUP_META_FIELDS, BACKUP_CLEANERS, BACKUP_LIMITS, cleanMemory, cleanState, cleanGrowth, cleanFishfood, cleanPet, cleanReminders, cleanStoryProgress, cleanPersonality, } from '../backup/fields.js';
export function createBackupHandlers(deps) {
    const nowFn = deps.now || (() => new Date());
    /** GET /data/export：导出包（≤2MB；超限 413，不回部分数据） */
    async function handleExport(req, res) {
        try {
            const method = req && req.method ? String(req.method).toUpperCase() : 'GET';
            if (method !== 'GET' && method !== 'HEAD') {
                sendJson(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
                return;
            }
            const payload = buildExport(deps, nowFn());
            // 先量体积再发：超限直接 413，不把半个包发出去
            const size = measureExportBytes(payload);
            if (isExportTooLarge(size)) {
                sendJson(res, { ok: false, error: 'TOO_LARGE', limit: BACKUP_MAX_BYTES }, 413);
                return;
            }
            sendJson(res, payload);
        }
        catch (err) {
            sendError(res, err);
        }
    }
    /**
     * POST /data/import：逐字段类型校验后落盘。
     * imported 写成功的字段；skipped 被忽略的字段（未知字段与类型非法都算）。
     * 元数据（ok/version/exportedAt）认识但不写盘，也不进 skipped。
     *
     * 请求体判定顺序（审计修复 F6）：
     *   ① readBody 超限 → 413（读取阶段就断连，不会先把 2MB+ 收进内存）；
     *   ② 空体 / 坏 JSON / 非对象（数组、标量） → 400 BAD_BODY；
     *   ③ 合法对象 → runImport（同步清洗 + 写盘，单字段失败进 skipped）。
     */
    async function handleImport(req, res) {
        try {
            const method = req && req.method ? String(req.method).toUpperCase() : '';
            if (method !== 'POST') {
                sendJson(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
                return;
            }
            let parsed;
            try {
                parsed = await readJsonBody(req, BACKUP_MAX_BYTES);
            }
            catch (err) {
                // 读流异常（连接中断等）不该被当成"导入成功"
                console.error('[backup] IMPORT-READ-FAIL ' + String((err && err.message) || err));
                sendError(res, err);
                return;
            }
            const judged = parseImportBody(parsed);
            if (judged.kind === 'tooLarge') {
                sendTooLarge(res);
                return;
            }
            if (judged.kind === 'badBody') {
                sendJson(res, { ok: false, error: 'BAD_BODY' }, 400);
                return;
            }
            const report = runImport(deps, judged.body);
            // 记忆/人格换了内容 → 旧聊天缓存必须作废（失败只记日志，不影响导入结果）
            if (deps.clearChatCache && (report.imported.indexOf('memory') >= 0 || report.imported.indexOf('personality') >= 0)) {
                try {
                    await deps.clearChatCache();
                }
                catch (e) {
                    console.error('[backup] CACHE-CLEAR-FAIL ' + String((e && e.message) || e));
                }
            }
            sendJson(res, { ok: true, imported: report.imported, skipped: report.skipped });
        }
        catch (err) {
            sendError(res, err);
        }
    }
    return { handleExport, handleImport };
}
