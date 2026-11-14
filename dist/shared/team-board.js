/**
 * shared/team-board.ts —— 「鲸鱼看板」的纯函数核心。
 *
 * 职责边界：
 *   · 只做快照 → 摘要（summarizeTeamBoard）与摘要 → 展示意图（presentTeamSummary）；
 *   · 不读 clock、不读 DOM、不碰文件、不发网络请求，`now` 由调用方传入；
 *   · 类型全部来自 shared/team-contract.ts，本文件不扩展契约。
 *
 * 两个关键约定：
 *   1. fingerprint 只由「状态」组成（phase / counts / activeTask.id / stuckTaskIds /
 *      approvalIds），不包含 capturedAt。同一状态无论快照对象怎么重建、描述怎么变，
 *      fingerprint 都必须一致；因此这里手工拼字段，不 JSON.stringify。
 *   2. presentTeamSummary 的 previous 视为「上一次真正展示过的摘要」。它的 capturedAt
 *      是普通摘要冷却的计时起点；不要每一步轮询都把新摘要塞进来，否则冷却永远不过期。
 */
/** 普通摘要默认最小间隔 */
const DEFAULT_COOLDOWN_MS = 60_000;
const ERROR_ALERT_TTL = 6_000;
const ERROR_ALERT_RANK = 10;
const APPROVAL_ALERT_TTL = 6_000;
const APPROVAL_ALERT_RANK = 20;
const DONE_ALERT_TTL = 12_000;
const DONE_ALERT_RANK = 15;
const EMPTY_IDS = [];
const ZERO_COUNTS = {
    total: 0,
    inProgress: 0,
    readyPending: 0,
    blockedPending: 0,
    completed: 0,
    approvals: 0,
};
/**
 * 把一段状态稳定地压成指纹。
 *
 * 数组先排序：审批/阻塞集合来自外部投影，顺序不应影响「同一状态」的判定。
 * activeTask 只取 id——subject 改名、owner 变化属于展示内容，不是状态变化。
 */
function buildFingerprint(phase, counts, activeTaskId, stuckTaskIds, approvalIds) {
    const stuck = [...stuckTaskIds].sort().join(',');
    const approvals = [...approvalIds].sort().join(',');
    return [
        'phase=' + phase,
        'total=' + counts.total,
        'inProgress=' + counts.inProgress,
        'readyPending=' + counts.readyPending,
        'blockedPending=' + counts.blockedPending,
        'completed=' + counts.completed,
        'approvals=' + counts.approvals,
        'active=' + (activeTaskId === undefined ? '' : activeTaskId),
        'stuck=' + stuck,
        'approvalIds=' + approvals,
    ].join('|');
}
/** 空看板摘要；与 summarizeTeamBoard 对「可用、无任务」快照的结果保持一致。 */
export function emptyTeamBoardSummary(now) {
    return {
        phase: 'empty',
        counts: { ...ZERO_COUNTS },
        stuckTaskIds: [],
        approvalIds: [],
        fingerprint: buildFingerprint('empty', ZERO_COUNTS, undefined, EMPTY_IDS, EMPTY_IDS),
        capturedAt: now,
    };
}
/**
 * 快照 → 摘要。
 *
 * previous 目前不参与计算：摘要只描述「此刻是什么状态」，变化判断交给
 * presentTeamSummary。保留参数是为了与调用方签名稳定，也方便未来扩展
 * （例如跨快照的记忆型提示），但第一版不改变任何计数口径。
 */
export function summarizeTeamBoard(snapshot, previous, now) {
    const tasks = snapshot.tasks ?? [];
    const approvals = snapshot.approvals ?? [];
    let total = 0;
    let inProgress = 0;
    let readyPending = 0;
    let blockedPending = 0;
    let completed = 0;
    let firstInProgress;
    let firstReadyPending;
    const stuckTaskIds = [];
    for (const task of tasks) {
        // deleted 是完全不参与看板的状态：不算总数，更不算活跃/卡住。
        if (task.status === 'deleted')
            continue;
        total++;
        if (task.status === 'in_progress') {
            inProgress++;
            if (firstInProgress === undefined)
                firstInProgress = task;
        }
        else if (task.status === 'completed') {
            completed++;
        }
        else if (task.status === 'pending') {
            if (task.ready === true) {
                readyPending++;
                if (firstReadyPending === undefined)
                    firstReadyPending = task;
            }
            else {
                // 第一版只算「依赖未满足」的阻塞，不做 in_progress 超时判定。
                blockedPending++;
                stuckTaskIds.push(task.id);
            }
        }
    }
    // 审批按 id 去重，但计数仍用原始数组长度（同一审批出现两次仍算两条压力）。
    const approvalIds = [];
    const seenApprovalIds = new Set();
    for (const approval of approvals) {
        if (!seenApprovalIds.has(approval.id)) {
            seenApprovalIds.add(approval.id);
            approvalIds.push(approval.id);
        }
    }
    // 顺序即优先级，不要随意调整。
    const phase = !snapshot.available
        ? 'unavailable'
        : snapshot.failure
            ? 'error'
            : !snapshot.enabled
                ? 'unavailable'
                : approvals.length > 0
                    ? 'approval'
                    : total === 0
                        ? 'empty'
                        : completed === total
                            ? 'done'
                            : inProgress > 0
                                ? 'working'
                                : blockedPending > 0
                                    ? 'blocked'
                                    : readyPending > 0
                                        ? 'waiting'
                                        : 'empty';
    const activeView = firstInProgress ?? firstReadyPending;
    let activeTask;
    if (activeView !== undefined) {
        activeTask = { id: activeView.id, subject: activeView.subject };
        if (activeView.ownerName !== undefined)
            activeTask.ownerName = activeView.ownerName;
    }
    const counts = {
        total,
        inProgress,
        readyPending,
        blockedPending,
        completed,
        approvals: approvals.length,
    };
    return {
        phase,
        counts,
        ...(activeTask === undefined ? {} : { activeTask }),
        stuckTaskIds,
        approvalIds,
        fingerprint: buildFingerprint(phase, counts, activeTask?.id, stuckTaskIds, approvalIds),
        capturedAt: now,
    };
}
/** 普通计数摘要的文案；total 为 0 时没有可说的内容。 */
function buildAmbient(summary) {
    const c = summary.counts;
    if (c.total <= 0)
        return null;
    const parts = [];
    if (c.inProgress > 0)
        parts.push(c.inProgress + ' 个在做');
    if (c.readyPending > 0)
        parts.push(c.readyPending + ' 个等人接');
    if (c.blockedPending > 0)
        parts.push(c.blockedPending + ' 个卡住了');
    const text = parts.length > 0
        ? c.total + ' 个任务：' + parts.join('，')
        : c.total + ' 个任务：全部完成';
    const tone = c.blockedPending > 0 || summary.stuckTaskIds.length > 0 ? 'warn' : 'normal';
    return { text, tone };
}
/** 普通摘要的节流：首次可给；同 fingerprint 不重复；变化后至少隔 cooldownMs。 */
function shouldShowAmbient(summary, previous, now, options) {
    // previous === null：首次观测，允许给一条普通 ambient（不额外造 alert）。
    if (previous === null)
        return true;
    // 状态没变就不重复（哪怕冷却已过）；避免挂件每隔一分钟念同一句。
    if (previous.fingerprint === summary.fingerprint)
        return false;
    const cooldownMs = options.cooldownMs === undefined ? DEFAULT_COOLDOWN_MS : options.cooldownMs;
    return now - previous.capturedAt >= cooldownMs;
}
/**
 * 摘要 → 展示意图。
 *
 * 会返回 null 的情形：禁用、不可用/空看板、错误已提示过、审批已提示过、
 * 完成已提示过，以及既没有 ambient 也没有 alert。
 */
export function presentTeamSummary(summary, previous, now, options) {
    if (options.enabled === false)
        return null;
    const phase = summary.phase;
    if (phase === 'unavailable' || phase === 'empty')
        return null;
    let alert;
    if (phase === 'error') {
        // 错误只提示一次：同一段错误持续期间不反复打扰。
        if (previous?.phase !== 'error') {
            alert = {
                key: 'team:error',
                text: '看板暂不可用',
                ttl: ERROR_ALERT_TTL,
                rank: ERROR_ALERT_RANK,
            };
        }
    }
    else if (phase === 'approval') {
        // 第一次看到的新审批 id 才提示；旧审批仍在时，后面新加的审批不能被旧 id 挡住。
        const seen = new Set(previous === null ? [] : previous.approvalIds);
        const freshApprovalId = summary.approvalIds.find((id) => !seen.has(id));
        if (freshApprovalId !== undefined) {
            // reason / toolName 一律不进入文案：只需要主人知道「有东西要批」。
            alert = {
                key: 'team:approval:' + freshApprovalId,
                text: '有个子 Agent 在等你批东西',
                ttl: APPROVAL_ALERT_TTL,
                rank: APPROVAL_ALERT_RANK,
            };
        }
    }
    else if (phase === 'done') {
        // 完成只播报一次；key 带 fingerprint，不同批次的完成不会互相覆盖。
        // previous === null 表示刚启动就看到「全部完成」，不补播历史庆祝。
        if (previous !== null && previous.phase !== 'done') {
            alert = {
                key: 'team:done:' + summary.fingerprint,
                text: '鲸群回巢了',
                ttl: DONE_ALERT_TTL,
                rank: DONE_ALERT_RANK,
                anim: 'settle',
            };
        }
    }
    // error 阶段数据不可信，不展示普通摘要；approval/done 仍可带 ambient。
    let ambient = null;
    if (phase !== 'error' && shouldShowAmbient(summary, previous, now, options)) {
        ambient = buildAmbient(summary);
    }
    if (ambient === null && alert === undefined)
        return null;
    return alert === undefined ? { ambient } : { ambient, alert };
}
