import { BACKUP_CLEANERS, BACKUP_META_FIELDS, isBackupDataField, isPlainObject, } from './fields.js';
/**
 * 把 readJsonBody 的结果判成「可导入 / 413 / 400」。
 *
 * 审计修复 F6（2026-11-06）：原 handler 只检查 `parsed.ok`（请求体是否读取成功），
 * 而 readJsonBody 把「空体 / JSON 解析失败」统一折叠成 `body = {}`（host/body.ts），
 * 结果是坏 JSON 会返回 `{ok:true, imported:[], skipped:[]}`——客户端误判为“导入成功”，
 * 用户的备份坏了却看不到任何错误。这里对空文本与非法 JSON 明确回 400 BAD_BODY。
 *
 * 实现上不重复解析正常请求：readJsonBody 已解析出非空对象时直接使用；只有对象为空
 * （合法 `{}` 与“解析失败”共用同一个 body={} 形状）或不是普通对象时才复验原始文本。
 * 空文本单独判 400：UUID 空导入没有任何可写内容，按坏请求处理更符合接口语义。
 */
export function parseImportBody(parsed) {
    if (!parsed || parsed.ok !== true)
        return { kind: 'tooLarge' };
    const text = typeof parsed.text === 'string' ? parsed.text : '';
    if (!isPlainObject(parsed.body))
        return { kind: 'badBody' };
    // 非空对象一定是 JSON 解析成功的结果；直接复用，避免对 2MB body 再解析一次
    if (Object.keys(parsed.body).length > 0)
        return { kind: 'ok', body: parsed.body };
    if (!text.trim())
        return { kind: 'badBody' };
    try {
        const body = JSON.parse(text);
        return isPlainObject(body) ? { kind: 'ok', body } : { kind: 'badBody' };
    }
    catch {
        return { kind: 'badBody' };
    }
}
/** 按字段走注入的写入口；缺失写入口按失败处理（与原实现相同的错误文案） */
function saveField(deps, field, value) {
    switch (field) {
        case 'memory':
            if (!deps.saveMemory)
                throw new Error('saveMemory missing');
            deps.saveMemory(value);
            return;
        case 'personality':
            if (!deps.savePersonality)
                throw new Error('savePersonality missing');
            if (deps.savePersonality(value) === false)
                throw new Error('personality save failed');
            return;
        case 'state':
            if (!deps.saveState)
                throw new Error('savestate missing');
            deps.saveState(value);
            return;
        case 'growth':
            if (!deps.saveGrowth)
                throw new Error('savegrowth missing');
            deps.saveGrowth(value);
            return;
        case 'fishfood':
            if (!deps.saveFishfood)
                throw new Error('savefishfood missing');
            deps.saveFishfood(value);
            return;
        case 'pet':
            if (!deps.savePet)
                throw new Error('savepet missing');
            deps.savePet(value);
            return;
        case 'reminders':
            if (!deps.saveReminders)
                throw new Error('savereminders missing');
            deps.saveReminders(value);
            return;
        case 'storyProgress':
            if (!deps.saveStoryProgress)
                throw new Error('savestoryProgress missing');
            deps.saveStoryProgress(value);
            return;
        default:
            // 类型上不可达；保留兜底，防止以后字段表与清洗器表脱节时静默写错字段
            throw new Error('save' + String(field) + ' missing');
    }
}
/**
 * 逐字段清洗 + 写盘，返回 imported / skipped。
 * 元数据（ok/version/exportedAt）认识但不写盘，也不进 skipped（与原实现一致）。
 * 字段顺序按 body 的 Object.keys 顺序，imported 顺序因此与原实现一致。
 */
export function runImport(deps, body) {
    const imported = [];
    const skipped = [];
    if (!isPlainObject(body))
        return { imported, skipped };
    for (const key of Object.keys(body)) {
        // 导出包自带的元数据：认识，但不落盘
        if (BACKUP_META_FIELDS.includes(key))
            continue;
        // 显式白名单判断：`__proto__` / `constructor` 等键既不是数据字段，
        // 也不会因为查表命中原型链而被误当成清洗器（BACKUP_CLEANERS 另做了 null 原型防护）
        if (!isBackupDataField(key)) {
            skipped.push(key);
            continue;
        }
        const clean = BACKUP_CLEANERS[key];
        let value;
        try {
            value = clean(body[key]);
        }
        catch {
            value = null;
        }
        if (value === null) {
            skipped.push(key);
            continue;
        }
        try {
            saveField(deps, key, value);
            imported.push(key);
            if (key === 'storyProgress' && deps.onStoryProgressImported) {
                try {
                    deps.onStoryProgressImported();
                }
                catch { }
            }
        }
        catch (err) {
            console.error('[backup] IMPORT-SAVE-FAIL field=' + key + ' err=' + String((err && err.message) || err));
            skipped.push(key);
        }
    }
    return { imported, skipped };
}
