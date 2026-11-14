/**
 * shared/cabinet.ts —— 「鲸群推演室」v0.1 协议核心。
 *
 * 职责边界：
 *   · 纯文本 + 纯函数：把主人的决定整理成一份推演简报（CabinetBrief），
 *     并给出可直接复制给模型的推演规则（CABINET_PROTOCOL）；
 *   · 不读写任务板、不启动子 Agent、不发消息、不读文件、不联网、不碰 DOM 与定时器；
 *   · 本模块只生成文字。任务板上的任何变化都必须由模型在主人明确发起后调用
 *     AgentTeam 工具产生，插件本体不自动改任务板。
 *
 * 定位：推演是「决策参谋」——四位角色给证据、假设、分歧与风险提示，最终拍板归主人。
 * 本文件的全部对外文案都不使用工程组织语境。
 */
/** 可选字段缺省时的占位文案；直接告诉模型「还缺什么」，而不是编造内容。 */
const DEFAULT_CONTEXT = '（未提供背景与约束；请先向主人确认）';
const DEFAULT_OPTIONS = '（未提供候选选项；请与主人一起列出）';
const DEFAULT_DEADLINE = '（未设定期限；按最便宜可逆实验优先推进，并请主人补充）';
/** 冻结单个角色，保证外部改不动推演名册。 */
function role(id, name, mandate) {
    return Object.freeze({ id, name, mandate });
}
/** 推演固定四人；顺序即简报与流程里的固定顺序。 */
export const CABINET_ROLES = Object.freeze([
    role('finance', '财务', '核算成本、现金流、投入产出与机会成本，给出量级和敏感性区间；只做风险提示，不代替会计、审计或投资顾问下结论。'),
    role('risk', '风险/法务', '识别合规、合同、责任与下行风险，标出法律与监管的不确定性；只做风险提示，不提供法律意见。'),
    role('customer', '客户代言人', '站在用户、客户和受影响方的立场，质疑价值、体验与信任成本；引用任何证据都要标明来源。'),
    role('contrarian', '反方', '专门找反例、失败路径和被忽略的前提，提出能推翻当前结论的证据条件。'),
]);
/** 四个角色通用的硬要求：证据 → 假设 → 置信度；没有证据就必须标「未核实」。 */
const CABINET_ROLE_DUTY = '每位推演视角都必须：查证据、标假设、给置信度（0–100%）；没有证据就写「未核实」，禁止编造来源、价格、法条或结论。';
/** 角色名册文本块（简报与规则共用，保证两边角色一致）。 */
function roleLine(item) {
    return '- ' + item.name + '（id: ' + item.id + '）：' + item.mandate;
}
const CABINET_ROLE_LINES = CABINET_ROLES.map((item) => roleLine(item)).join('\n');
/** 推演流程：任务板是唯一状态源；工具名允许模型照用，插件自己不调用。 */
const CABINET_PROCESS_STEPS = Object.freeze([
    '1. 用 team_task_create 建 5 张任务：标题分别以 [FIN]、[RISK]、[CUST]、[OPP] 开头，各对应一位视角；再建一张 [MEMO] 汇总任务；[MEMO] 的 blockedBy 必须包含四张角色任务。',
    '2. 用 subagent 启动四位具名角色（名称固定为 finance / risk / customer / contrarian），启动时把各自的 [FIN]/[RISK]/[CUST]/[OPP] 任务 id 和 [MEMO] 任务 id 交代清楚。',
    '3. 四个角色用 team_task_list、team_task_get 读任务板，用 team_task_update 认领并完成自己的角色任务；意见、证据和假设都写进任务板，标题保留前缀，方便鱼脚下显示「推演 x/4」。',
    '4. 用 send_message 做交叉质询：点名一位成员，针对最弱的一条证据或假设提问，被问者必须回应并更新自己的结论。',
    '5. 推演主持汇总四份意见后更新 [MEMO] 任务并向主人汇报；任务板是唯一状态源，聊天里的口头进度不算数，鱼只读任务板显示进度。',
    '6. 主人没有明确发起「鲸群推演室」时不建推演任务；鱼不自动改任务板，不在后台写入任何任务。',
]);
/** MEMO 必须六项齐全；简报与规则共用同一份清单。 */
const CABINET_OUTPUT_ITEMS = Object.freeze([
    '1. 决策备忘录：候选选项、评价标准、逐项评分（写清评分依据）。',
    '2. 分歧地图：谁和谁在哪里分歧，分歧来自事实还是价值判断。',
    '3. 假设账本：每条假设、依据、置信度，以及假设不成立时会怎样。',
    '4. 最便宜可逆实验：用最小代价先验证哪个关键假设，如何回滚。',
    '5. 待核实清单：尚未核实的事实、数据、来源与负责核实的人。',
    '6. 非专业意见声明：财务与风险/法务只做风险提示，不构成财务意见或法律意见；最终决定由主人作出。',
]);
/** 推演边界：不替主人决定、不自动执行、不编造来源、不自动改任务板。 */
const CABINET_BOUNDARY_ITEMS = Object.freeze([
    '- 鱼是推演主持，不是决策者：不替主人做决定，只整理选项、证据、分歧与未决问题。',
    '- 禁止自动执行决定：不自动下单、付款、签约、发布、发消息或改动真实资产与账号。',
    '- 禁止编造来源：找不到出处就标「未核实」，不虚构文号、价格、法条、专家或案例。',
    '- 财务与风险/法务只做风险提示；涉及真实金额、税务、合规或诉讼时，请主人找持证专业人士复核。',
    '- 鱼不自动改任务板：任务板的每次变化都必须来自主人在本会话中明确发起推演后、按上述流程对 AgentTeam 工具的显式调用。',
    '- 本协议与简报只给方法与风险提示，不含真实价格、报价、法条或法律结论；具体数字与条款由主人或持证专业人士核实。',
]);
/** 推演规则：可直接复制给模型的稳定文本；与简报共用角色、流程、输出与边界。 */
function buildCabinetProtocol() {
    return [
        '鲸群推演室 · 推演规则 v0.1',
        '',
        '一、身份',
        '鱼是推演主持，不是决策者：负责召集四位视角、整理证据与论点、把分歧和未决问题摆给主人。最终决定权始终在主人手里，鱼不替主人做决定。',
        '',
        '二、推演视角（固定四人）',
        CABINET_ROLE_LINES,
        '',
        CABINET_ROLE_DUTY,
        '',
        '三、流程（AgentTeam）',
        ...CABINET_PROCESS_STEPS,
        '',
        '四、输出结构（MEMO 六项齐全）',
        ...CABINET_OUTPUT_ITEMS,
        '',
        '五、边界',
        ...CABINET_BOUNDARY_ITEMS,
    ].join('\n');
}
export const CABINET_PROTOCOL = buildCabinetProtocol();
/** 可选字段归一化：非字符串或空白一律回退到占位文案，不把 undefined 带进简报。 */
function normalizeField(value, fallback) {
    if (typeof value !== 'string')
        return fallback;
    const trimmed = value.trim();
    return trimmed === '' ? fallback : trimmed;
}
/**
 * 生成一次推演简报。
 * 只做字符串拼装：同一输入永远得到同一输出，不产生任何外部副作用。
 * decision 去掉首尾空白后为空即抛 TypeError('decision is required')。
 */
export function buildCabinetPrompt(input) {
    const decision = typeof input?.decision === 'string' ? input.decision.trim() : '';
    if (decision === '')
        throw new TypeError('decision is required');
    const context = normalizeField(input?.context, DEFAULT_CONTEXT);
    const options = normalizeField(input?.options, DEFAULT_OPTIONS);
    const deadline = normalizeField(input?.deadline, DEFAULT_DEADLINE);
    const prompt = [
        '鲸群推演室 · 本次决定的推演简报',
        '',
        '请以「鲸群推演室」的方式处理本次决定。鱼是推演主持，不替主人做决定：只负责召集四位视角、整理证据与分歧，把选项和未决问题摆给主人。',
        '',
        '【决定】',
        decision,
        '',
        '【背景与约束】',
        context,
        '',
        '【候选选项】',
        options,
        '',
        '【期限】',
        deadline,
        '',
        '【推演视角（固定四人）】',
        CABINET_ROLE_LINES,
        '',
        CABINET_ROLE_DUTY,
        '',
        '【执行方式（必须使用 AgentTeam 工具）】',
        ...CABINET_PROCESS_STEPS,
        '',
        '【必须交付】',
        ...CABINET_OUTPUT_ITEMS,
        '',
        '【边界】',
        ...CABINET_BOUNDARY_ITEMS,
        '',
        '【现在开始】',
        '先向主人复述你对「决定、背景、候选选项、期限」的理解，指出还缺什么信息；得到主人确认后，再按上述流程召集推演，最后输出完整的六项交付物与非专业意见声明。',
    ].join('\n');
    return {
        decision,
        context,
        options,
        deadline,
        roles: CABINET_ROLES,
        prompt,
    };
}
