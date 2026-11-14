/**
 * shared/whale-works.ts —— 「鲸群营造（WhaleWorks）」v0.1 纯函数施工检查器。
 *
 * 职责边界：
 *   · 输入只读的 TeamTaskView[] 快照，输出脚下看板需要的纯数据：
 *     施工阶段（phase）、分支统计（branches）、警告（warnings）、验收态（acceptance）、
 *     一句话文案（chipText）；
 *   · 不读 clock、不读 DOM、不碰文件、不发网络请求、不 import client/host 内部实现；
 *   · 类型只来自 shared/team-contract.ts，本文件不扩展契约。
 *
 * 层级识别（任务标题前缀，不区分大小写）：
 *   [A]   分支（包工头跟踪任务）        [A1]  分支 A 的叶子（工人任务）
 *   [V]   验收（全局验收官签字）        [D]   设计/总监级
 *   [E]   工程/史诗                     [FIX] 缺陷返工
 *   · [D1]/[E1]/[FIX1] 这类角色编号子任务仍归角色，不伪造成「分支 D/E/FIX」。
 *   · 空标题、无前缀、以及未列出的前缀（如 [Q] 以外的杂项）一律归入「未分类」：
 *     不进分支统计、不参与验收判定，也不会因此抛错（任务板脏数据不能把小鲸弄崩）。
 *   · deleted 一律忽略：不算总数、不进分支、不产生任何警告。
 *
 * 写死的口径（避免下游各算各的）：
 *   1. 分支统计：分支任务自身与叶子都计入所属分支；done/active/waiting/blocked 按任务状态，
 *      total = 四者之和（未知状态按 blocked 计，保证等式成立）。分支标签取第一条带文本的
 *      分支任务标题（去掉前缀）；没有可用标题时回退为「分支 A」。
 *   2. hasAcceptance：该分支施工全部完成（done === total 且 total > 0）且全局验收已签字，
 *      即「这个分支已经通过验收」。v0.1 只有全局一个验收签字，不做分支级验收。
 *   3. 警告分两级：error 触发 phase='warn'；warn 只计入 chipText 的「N 警告」。
 *   4. ACCEPTANCE_NOT_SIGNED 的触发口径：只要有 [V] 而验收任务没全部完成就提示（验收没签字
 *      不能收工）；ACCEPTANCE_MISSING 只在全部任务完成且根本没有 [V] 时提示。
 *   5. 死锁判定：叶子 [A1] 的 blockedBy 含父分支任务 [A] 的 id。这是文档 §7.4 明令禁止的
 *      「父级前缀当 blockedBy」，父任务等叶子、叶子等父任务，形成永久死锁。
 *   6. writeScopes 重叠 v0.1 只做「字符串精确交集」（trim 后相等），不推断 glob 前缀重叠；
 *      同一 scope 只报一次，空 scope 跳过；completed 任务不参与（已经不会再动文件）。
 *   7. chipText 是脚下看板的唯一文案来源：
 *      无任务 →「暂无施工」；验收已签 →「验收通过」；
 *      其余 →「施工 x/y 分支」，有待签验收追加「· n 待验」，有警告追加「· m 警告」。
 */
/** [A] / [A1] / [V] / [FIX] 等前缀；字母最多 4 个、数字最多 2 个，容错为主 */
const PREFIX_RE = /^\[([A-Za-z]{1,4})(\d{0,2})\]\s*([\s\S]*)$/;
/** 解析标题前缀；任何异常标题都安全落到「未分类」 */
function parsePrefix(title) {
    const miss = { role: 'none', branchKey: '', label: title, token: '' };
    if (title === '')
        return { role: 'none', branchKey: '', label: '', token: '' };
    const match = PREFIX_RE.exec(title);
    if (match === null)
        return miss;
    const letters = match[1].toUpperCase();
    const digits = match[2];
    const label = match[3].trim();
    // 数字后缀 = 叶子；字母前缀 = 分支。FIX/V/D/E 是角色前缀，不占普通分支；
    // 它们的数字子任务（如文档 DAG 里的 [D1] 设计工人）仍归角色，不伪造成「分支 D」。
    if (digits.length > 0) {
        if (letters === 'V')
            return { role: 'verify', branchKey: '', label, token: 'V' + digits };
        if (letters === 'D')
            return { role: 'director', branchKey: '', label, token: 'D' + digits };
        if (letters === 'E')
            return { role: 'engineering', branchKey: '', label, token: 'E' + digits };
        if (letters === 'FIX')
            return { role: 'fix', branchKey: '', label, token: 'FIX' + digits };
        return letters.length === 1
            ? { role: 'leaf', branchKey: letters, label, token: letters + digits }
            : miss;
    }
    if (letters === 'V')
        return { role: 'verify', branchKey: '', label, token: 'V' };
    if (letters === 'D')
        return { role: 'director', branchKey: '', label, token: 'D' };
    if (letters === 'E')
        return { role: 'engineering', branchKey: '', label, token: 'E' };
    if (letters === 'FIX')
        return { role: 'fix', branchKey: '', label, token: 'FIX' };
    if (letters.length === 1)
        return { role: 'branch', branchKey: letters, label, token: letters };
    return miss;
}
/** 结构性字段容错读取：投影可能缺字段，读不到就当空 */
function readStrings(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}
function readSubject(value) {
    return typeof value === 'string' ? value : '';
}
function readId(task) {
    return typeof task.id === 'string' ? task.id : '';
}
function isTaskCompleted(task) {
    return task.status === 'completed';
}
/** 与其它环节一致的阶段判定；顺序即优先级，按任务书固定 */
function decidePhase(input) {
    if (input.totalTasks === 0)
        return 'idle';
    if (input.hasErrorWarning)
        return 'warn';
    if (input.acceptance.signed)
        return 'done';
    if (input.acceptance.pending)
        return 'verify';
    if (input.blockedCount > 0)
        return 'blocked';
    if (input.activeCount > 0)
        return 'working';
    if (input.waitingCount > 0)
        return 'waiting';
    return input.completedTasks === input.totalTasks ? 'done' : 'working';
}
/**
 * 脚下看板一句话文案。
 * 示例：「施工 2/3 分支 · 1 待验 · 1 警告」；无任务「暂无施工」；验收完成「验收通过」。
 */
function buildChipText(input) {
    if (input.totalTasks === 0)
        return '暂无施工';
    if (input.signed)
        return '验收通过';
    const parts = [];
    if (input.branchTotal > 0) {
        parts.push('施工 ' + input.branchDone + '/' + input.branchTotal + ' 分支');
    }
    else {
        parts.push('暂无分支');
    }
    if (input.verifyOpenCount > 0)
        parts.push(input.verifyOpenCount + ' 待验');
    if (input.warningCount > 0)
        parts.push(input.warningCount + ' 警告');
    return parts.join(' · ');
}
/**
 * 施工检查器主入口：纯函数，同一输入永远得到同一输出。
 * 任何字段缺失/标题异常都不会抛错，只会降级成「未分类」或跳过该项检查。
 */
export function inspectWhaleWorks(tasks) {
    const list = Array.isArray(tasks) ? tasks : [];
    const parsed = [];
    const verifyTasks = [];
    const branchTasksByKey = new Map();
    const leavesByKey = new Map();
    const accumulatorByKey = new Map();
    let totalTasks = 0;
    let completedTasks = 0;
    let activeCount = 0;
    let waitingCount = 0;
    let blockedCount = 0;
    for (const task of list) {
        // deleted 完全不参与：不算总数、不进分支、不产生警告。
        if (task === null || task === undefined || task.status === 'deleted')
            continue;
        totalTasks++;
        if (isTaskCompleted(task))
            completedTasks++;
        else if (task.status === 'in_progress')
            activeCount++;
        else if (task.status === 'pending') {
            if (task.ready === true)
                waitingCount++;
            else
                blockedCount++;
        }
        const title = readSubject(task.subject).trim();
        const prefix = parsePrefix(title);
        const item = {
            task,
            id: readId(task),
            role: prefix.role,
            branchKey: prefix.branchKey,
            label: prefix.label,
            token: prefix.token,
            title,
        };
        parsed.push(item);
        if (item.role === 'verify')
            verifyTasks.push(item);
        if (item.role === 'branch' || item.role === 'leaf') {
            const key = item.branchKey;
            let accumulator = accumulatorByKey.get(key);
            if (accumulator === undefined) {
                accumulator = { key, label: '', total: 0, done: 0, active: 0, waiting: 0, blocked: 0 };
                accumulatorByKey.set(key, accumulator);
            }
            accumulator.total++;
            if (isTaskCompleted(task))
                accumulator.done++;
            else if (task.status === 'in_progress')
                accumulator.active++;
            else if (task.status === 'pending') {
                if (task.ready === true)
                    accumulator.waiting++;
                else
                    accumulator.blocked++;
            }
            else {
                // 未知状态按卡住计入，保证 total = done + active + waiting + blocked。
                accumulator.blocked++;
            }
            if (item.role === 'branch' && accumulator.label === '' && item.label !== '') {
                accumulator.label = item.label;
            }
            if (item.role === 'branch') {
                const bucket = branchTasksByKey.get(key);
                if (bucket === undefined)
                    branchTasksByKey.set(key, [item]);
                else
                    bucket.push(item);
            }
            else {
                const bucket = leavesByKey.get(key);
                if (bucket === undefined)
                    leavesByKey.set(key, [item]);
                else
                    bucket.push(item);
            }
        }
    }
    // ---- 验收态 -------------------------------------------------------------
    const verifyOpen = verifyTasks.filter((item) => !isTaskCompleted(item.task));
    const hasAcceptanceTask = verifyTasks.length > 0;
    const signed = hasAcceptanceTask && verifyOpen.length === 0;
    const pending = hasAcceptanceTask && !signed;
    const acceptance = { hasTask: hasAcceptanceTask, signed, pending };
    // ---- 分支 ---------------------------------------------------------------
    const branchKeys = [...accumulatorByKey.keys()].sort();
    const branches = branchKeys.map((key) => {
        const acc = accumulatorByKey.get(key);
        return {
            key: acc.key,
            label: acc.label !== '' ? acc.label : '分支 ' + acc.key,
            total: acc.total,
            done: acc.done,
            active: acc.active,
            waiting: acc.waiting,
            blocked: acc.blocked,
            hasAcceptance: signed && acc.total > 0 && acc.done === acc.total,
        };
    });
    // ---- 警告（顺序固定，便于快照对比）--------------------------------------
    const warnings = [];
    // 1) 死锁：叶子 blockedBy 自己的父分支任务
    for (const leaf of parsed) {
        if (leaf.role !== 'leaf')
            continue;
        const parents = branchTasksByKey.get(leaf.branchKey) ?? [];
        if (parents.length === 0)
            continue;
        const parentIds = new Set(parents.map((parent) => parent.id));
        const blockers = readStrings(leaf.task.blockedBy).filter((id) => parentIds.has(id));
        if (blockers.length === 0)
            continue;
        const uniqueBlockers = [...new Set(blockers)];
        warnings.push({
            code: 'LEAF_BLOCKED_BY_PARENT',
            level: 'error',
            message: '叶子 [' +
                leaf.token +
                '] ' +
                leaf.id +
                ' 的 blockedBy 指向父分支任务 ' +
                uniqueBlockers.join('、') +
                '：父任务要等叶子完成、叶子又在等父任务，形成死锁。',
            taskIds: [leaf.id, ...uniqueBlockers],
        });
    }
    // 2) 分支完成但叶子还没完成
    for (const key of branchKeys) {
        const parents = (branchTasksByKey.get(key) ?? []).filter((item) => isTaskCompleted(item.task));
        const openLeaves = (leavesByKey.get(key) ?? []).filter((item) => !isTaskCompleted(item.task));
        if (parents.length === 0 || openLeaves.length === 0)
            continue;
        const parentIds = parents.map((item) => item.id);
        const leafIds = openLeaves.map((item) => item.id);
        warnings.push({
            code: 'BRANCH_DONE_WITH_OPEN_LEAVES',
            level: 'warn',
            message: '分支 [' +
                key +
                '] 已完成，但还有 ' +
                leafIds.length +
                ' 个叶子未完成：' +
                leafIds.join('、') +
                '；分支完成不等于叶子完成。',
            taskIds: [...parentIds, ...leafIds],
        });
    }
    // 3/4) 验收缺失 / 未签字
    if (!hasAcceptanceTask) {
        if (totalTasks > 0 && completedTasks === totalTasks) {
            warnings.push({
                code: 'ACCEPTANCE_MISSING',
                level: 'error',
                message: totalTasks +
                    ' 个任务都已完成，但没有 [V] 验收任务：没有人签字，不能算竣工。',
                taskIds: [],
            });
        }
    }
    else if (!signed) {
        const openIds = verifyOpen.map((item) => item.id);
        warnings.push({
            code: 'ACCEPTANCE_NOT_SIGNED',
            level: 'warn',
            message: '验收任务 ' +
                openIds.join('、') +
                ' 还没签字：验收官不签字不能收工。',
            taskIds: openIds,
        });
    }
    // 5) 写作用域重叠（非 completed、非空 scope，同一 scope 只报一次）
    const scopeHolders = new Map();
    for (const item of parsed) {
        if (isTaskCompleted(item.task))
            continue;
        for (const raw of readStrings(item.task.writeScopes)) {
            const scope = raw.trim();
            if (scope === '')
                continue;
            let holders = scopeHolders.get(scope);
            if (holders === undefined) {
                holders = [];
                scopeHolders.set(scope, holders);
            }
            if (!holders.includes(item.id))
                holders.push(item.id);
        }
    }
    for (const scope of [...scopeHolders.keys()].sort()) {
        const holders = scopeHolders.get(scope);
        if (holders.length < 2)
            continue;
        warnings.push({
            code: 'WRITE_SCOPE_OVERLAP',
            level: 'warn',
            message: '写作用域重叠：' + scope + '（' + holders.join('、') + ' 同时声明）；advisory 不是锁，需要总监确认。',
            taskIds: holders,
        });
    }
    // 6) 前缀重复（[A] 与 [A1] 不同层，不算重复；完全相同的 [A] 两次算）
    const prefixHolders = new Map();
    for (const item of parsed) {
        if (item.token === '')
            continue;
        let holders = prefixHolders.get(item.token);
        if (holders === undefined) {
            holders = [];
            prefixHolders.set(item.token, holders);
        }
        holders.push(item.id);
    }
    for (const token of [...prefixHolders.keys()].sort()) {
        const holders = prefixHolders.get(token);
        if (holders.length < 2)
            continue;
        warnings.push({
            code: 'DUPLICATE_PREFIX',
            level: 'warn',
            message: '前缀 [' +
                token +
                '] 重复出现 ' +
                holders.length +
                ' 次：' +
                holders.join('、') +
                '；同一层出现多个同名任务会混淆施工层级。',
            taskIds: holders,
        });
    }
    // 7) 空标题
    for (const item of parsed) {
        if (item.title !== '')
            continue;
        warnings.push({
            code: 'EMPTY_TITLE',
            level: 'warn',
            message: '标题为空：' + (item.id === '' ? '(无 id)' : item.id) + ' 无法判断施工层级，已归入未分类。',
            taskIds: item.id === '' ? [] : [item.id],
        });
    }
    // ---- 阶段与文案 ---------------------------------------------------------
    const hasErrorWarning = warnings.some((warning) => warning.level === 'error');
    const phase = decidePhase({
        totalTasks,
        completedTasks,
        hasErrorWarning,
        acceptance,
        blockedCount,
        activeCount,
        waitingCount,
    });
    const branchDone = branches.filter((branch) => branch.total > 0 && branch.done === branch.total).length;
    const chipText = buildChipText({
        totalTasks,
        signed,
        branchTotal: branches.length,
        branchDone,
        verifyOpenCount: verifyOpen.length,
        warningCount: warnings.length,
    });
    return {
        phase,
        branches,
        warnings,
        acceptance,
        chipText,
        totalTasks,
        completedTasks,
    };
}
/**
 * 施工模板（v0.1）：小鲸只复制/展示，不自动建任务、不改任务板。
 * 占位符统一用 {花括号}，由复制方手工替换。
 */
export const WHALE_WORKS_TEMPLATES = Object.freeze({
    brief: [
        '[E] {工程名} 开工单',
        '目标：{一句话说明要达成什么}',
        '范围：{做哪些}；不做：{明确不做什么}',
        '验收：{验收标准}，由 {验收官} 独立签字',
        '预算：{轮次/时间/成本上限}',
        '产出：{交付物与路径}',
    ].join('\n'),
    workerCard: [
        '[工卡] {分支}／{叶子任务名}',
        '目标：{完成什么}',
        '输入：{文件/资料/依赖任务 id}',
        '输出：{产物路径}',
        '写作用域：{只允许改的路径}',
        '验收：{可复核的通过标准}',
        '证据：{evidence/{task-id}.md 写什么}',
        '上报：{包工头任务 id}；完成条件：{怎样算完成}',
    ].join('\n'),
    acceptance: [
        '[V] 独立验收单',
        '验收矩阵：{验收项} × {通过标准} × {证据位置}',
        '复跑：{命令/步骤，逐项记录结果}',
        '抽查：{随机抽查点}',
        '签字：验收官 {名字} / {日期}',
        '不通过：建 [FIX] 缺陷任务退回原包工头，不直接改 completed。',
    ].join('\n'),
    finalSummary: [
        '鲸群营造 · 竣工摘要',
        '分支：{A/B/C 各自完成情况}',
        '验收：{验收结论与签字}',
        '返工：{FIX 记录与结论}',
        '未决：{遗留风险/待办}',
        '版本：{版本号 / tag / 发布物}',
    ].join('\n'),
});
