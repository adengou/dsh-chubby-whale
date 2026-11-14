/**
 * scripts/test-cabinet.mjs —— 「鲸群推演室」v0.1 协议核心自检。
 *
 * 不联网、不依赖 DOM；直接由 Node 24 剥离类型后加载 src/shared/cabinet.ts，
 * 同时静态扫描源码，确认它只是「纯文本 + 纯函数」：
 *   · 不 import 任何模块、不读文件、不联网、不碰 DOM、不起定时器；
 *   · 不调用 AgentTeam 工具（prompt 里允许并且必须提到工具名，测试只查「调用语法」）。
 *
 * 覆盖：接口导出 / decision 必填与空输入 / 正常中文 / 可选字段缺省 /
 *       四角色 id·名称·职责 / prompt 工具与输出要求 / 规则非专业意见声明 /
 *       简报与规则一致性 / 无可复制占位符 / 无工程语境 / 无真实价格与法律结论 /
 *       确定性 / 名册冻结。
 *
 * 运行：node scripts/test-cabinet.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE_PATH = new URL('../src/shared/cabinet.ts', import.meta.url)
const source = readFileSync(SOURCE_PATH, 'utf8')

const { CABINET_ROLES, CABINET_PROTOCOL, buildCabinetPrompt } = await import(
  '../src/shared/cabinet.ts'
)

let pass = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    pass++
    console.log('  ✅ ' + name)
  } catch (err) {
    failures.push({ name, err })
    console.log('  ❌ ' + name)
    const detail = err && err.message ? String(err.message) : String(err)
    console.log('     ' + detail.replace(/\n/g, '\n     '))
  }
}

/** decision 为空时必须抛 TypeError('decision is required')，不能返回半成品。 */
function expectDecisionError(fn) {
  assert.throws(fn, (err) => {
    assert.equal(err instanceof TypeError, true, '错误类型应为 TypeError，实际：' + (err && err.constructor && err.constructor.name))
    assert.equal(err.message, 'decision is required')
    return true
  })
}

const ROLE_IDS = ['finance', 'risk', 'customer', 'contrarian']
const ROLE_NAMES = ['财务', '风险/法务', '客户代言人', '反方']
const TOOL_NAMES = [
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
  'subagent',
  'send_message',
]
const OUTPUT_TITLES = [
  '决策备忘录',
  '分歧地图',
  '假设账本',
  '最便宜可逆实验',
  '待核实清单',
  '非专业意见声明',
]
const DEFAULT_CONTEXT = '（未提供背景与约束；请先向主人确认）'
const DEFAULT_OPTIONS = '（未提供候选选项；请与主人一起列出）'
const DEFAULT_DEADLINE = '（未设定期限；按最便宜可逆实验优先推进，并请主人补充）'

const NORMAL_INPUT = {
  decision: '  要不要把插件开源到 GitHub  ',
  context: ' 目前只在本地使用，担心被抄袭 ',
  options: ' A 立即开源 / B 不开源 / C 半年后开源 ',
  deadline: ' 本月底前 ',
}
const normal = buildCabinetPrompt(NORMAL_INPUT)

// ---------------------------------------------------------------------------
console.log('\n[1] 模块接口与静态纯函数边界')
// ---------------------------------------------------------------------------
check('运行期只导出 CABINET_ROLES / CABINET_PROTOCOL / buildCabinetPrompt', () => {
  assert.deepEqual(Object.keys({ CABINET_ROLES, CABINET_PROTOCOL, buildCabinetPrompt }).sort(), [
    'CABINET_PROTOCOL',
    'CABINET_ROLES',
    'buildCabinetPrompt',
  ])
})
check('源文件导出的接口清单与约定一致（类型已擦除，故静态核对）', () => {
  const names = [...source.matchAll(/^export\s+(?:type|interface|const|function)\s+([A-Za-z_$][\w$]*)/gm)].map(
    (m) => m[1],
  )
  assert.deepEqual(names.sort(), [
    'CABINET_PROTOCOL',
    'CABINET_ROLES',
    'CabinetBrief',
    'CabinetBriefInput',
    'CabinetRole',
    'CabinetRoleId',
    'buildCabinetPrompt',
  ])
})
check('源码没有任何 import（零依赖纯文本模块）', () => {
  assert.doesNotMatch(source, /^\s*import\s/m)
  assert.doesNotMatch(source, /\brequire\s*\(/)
})
check('源码没有 export default（接口只用具名导出）', () => {
  assert.doesNotMatch(source, /export\s+default/)
})
check('源码不读文件、不联网、不起子进程', () => {
  assert.doesNotMatch(source, /child_process|readFileSync|writeFileSync|readdirSync/)
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|\bWebSocket\b|\bhttps?\.request\b/)
})
check('源码不碰 DOM / 存储', () => {
  assert.doesNotMatch(source, /\b(document|window|localStorage|sessionStorage|navigator)\s*\./)
})
check('源码没有定时器与时钟依赖（同一输入同一输出）', () => {
  assert.doesNotMatch(source, /\bset(?:Timeout|Interval|Immediate)\s*\(/)
  assert.doesNotMatch(source, /\brequestAnimationFrame\s*\(|\bqueueMicrotask\s*\(/)
  assert.doesNotMatch(source, /\bDate\.now\b|\bnew Date\b|Math\.random/)
})
check('源码不调用 AgentTeam 工具（prompt 只允许模型调用；此处只查调用语法）', () => {
  const callRe = new RegExp('\\b(?:' + TOOL_NAMES.join('|') + '|subagent_fork)\\s*\\(')
  assert.doesNotMatch(source, callRe)
  // 工具名在文案里必须出现，否则 prompt 无法指导模型；只是不能写成代码调用。
  assert.match(source, /team_task_create/)
})
check('源码没有任务板 / 消息 / 子 Agent 的副作用调用', () => {
  assert.doesNotMatch(source, /\bteam_task_update\s*\(/)
  assert.doesNotMatch(source, /\bsubagent\s*\(/)
  assert.doesNotMatch(source, /\bsend_message\s*\(/)
})

// ---------------------------------------------------------------------------
console.log('\n[2] decision 必填：空白一律抛 TypeError')
// ---------------------------------------------------------------------------
check('decision 为空串 → TypeError(decision is required)', () => {
  expectDecisionError(() => buildCabinetPrompt({ decision: '' }))
})
check('decision 只有空白（含全角空格/换行/制表）→ 抛错', () => {
  expectDecisionError(() => buildCabinetPrompt({ decision: '   \t\n　  ' }))
})
check('缺少 decision 字段 → 抛错', () => {
  expectDecisionError(() => buildCabinetPrompt({}))
})
check('decision 为 null → 抛错', () => {
  expectDecisionError(() => buildCabinetPrompt({ decision: null }))
})
check('decision 为非字符串（数字/对象）→ 抛错', () => {
  expectDecisionError(() => buildCabinetPrompt({ decision: 42 }))
  expectDecisionError(() => buildCabinetPrompt({ decision: { text: '决定' } }))
})
check('整个 input 缺失 / 为 null → 抛错而不是生成空简报', () => {
  expectDecisionError(() => buildCabinetPrompt())
  expectDecisionError(() => buildCabinetPrompt(null))
})
check('抛错信息逐字固定，且不会先返回半成品', () => {
  try {
    buildCabinetPrompt({ decision: '  ' })
    assert.fail('应当抛错')
  } catch (err) {
    assert.equal(err instanceof TypeError, true)
    assert.equal(err.message, 'decision is required')
  }
})

// ---------------------------------------------------------------------------
console.log('\n[3] 正常中文简报')
// ---------------------------------------------------------------------------
check('decision / context / options / deadline 都去掉首尾空白', () => {
  assert.equal(normal.decision, '要不要把插件开源到 GitHub')
  assert.equal(normal.context, '目前只在本地使用，担心被抄袭')
  assert.equal(normal.options, 'A 立即开源 / B 不开源 / C 半年后开源')
  assert.equal(normal.deadline, '本月底前')
})
check('简报字段齐全且只有约定字段', () => {
  assert.deepEqual(Object.keys(normal).sort(), [
    'context',
    'deadline',
    'decision',
    'options',
    'prompt',
    'roles',
  ])
})
check('roles 指向同一份推演名册', () => {
  assert.equal(normal.roles, CABINET_ROLES)
})
check('prompt 带上决定、背景、选项与期限原文', () => {
  for (const text of [
    '要不要把插件开源到 GitHub',
    '目前只在本地使用，担心被抄袭',
    'A 立即开源 / B 不开源 / C 半年后开源',
    '本月底前',
  ]) {
    assert.ok(normal.prompt.includes(text), 'prompt 缺少：' + text)
  }
})
check('prompt 是中文字报：以「鲸群推演室」开头并含四个分节标题', () => {
  assert.match(normal.prompt, /^鲸群推演室/)
  for (const heading of ['【决定】', '【背景与约束】', '【候选选项】', '【期限】']) {
    assert.ok(normal.prompt.includes(heading), 'prompt 缺少分节：' + heading)
  }
})
check('prompt 不含 undefined / null / [object Object] 占位', () => {
  assert.doesNotMatch(normal.prompt, /undefined|\[object Object\]/)
})
check('prompt 是完整长文本（不是一句话模板）', () => {
  assert.ok(normal.prompt.length > 1000, 'prompt 过短：' + normal.prompt.length)
})

// ---------------------------------------------------------------------------
console.log('\n[4] 可选字段缺省')
// ---------------------------------------------------------------------------
const minimal = buildCabinetPrompt({ decision: '要不要给插件加语音功能' })

check('只给 decision 时三个可选字段回退到占位文案', () => {
  assert.equal(minimal.context, DEFAULT_CONTEXT)
  assert.equal(minimal.options, DEFAULT_OPTIONS)
  assert.equal(minimal.deadline, DEFAULT_DEADLINE)
})
check('占位文案会进入 prompt，让模型知道还缺什么', () => {
  for (const text of [DEFAULT_CONTEXT, DEFAULT_OPTIONS, DEFAULT_DEADLINE]) {
    assert.ok(minimal.prompt.includes(text), 'prompt 缺少占位：' + text)
  }
})
check('可选字段为空串 / 纯空白 → 回退占位', () => {
  const brief = buildCabinetPrompt({
    decision: '要不要换数据源',
    context: '',
    options: '   ',
    deadline: '\n\t ',
  })
  assert.equal(brief.context, DEFAULT_CONTEXT)
  assert.equal(brief.options, DEFAULT_OPTIONS)
  assert.equal(brief.deadline, DEFAULT_DEADLINE)
})
check('可选字段为非字符串 → 回退占位（不把对象拼进 prompt）', () => {
  const brief = buildCabinetPrompt({
    decision: '要不要换数据源',
    context: 42,
    options: null,
    deadline: { at: '月底' },
  })
  assert.equal(brief.context, DEFAULT_CONTEXT)
  assert.equal(brief.options, DEFAULT_OPTIONS)
  assert.equal(brief.deadline, DEFAULT_DEADLINE)
  assert.doesNotMatch(brief.prompt, /42|\[object Object\]/)
})
check('可选字段多余属性被忽略，不影响简报', () => {
  const brief = buildCabinetPrompt({
    decision: '要不要换数据源',
    context: '本地优先',
    extra: '不应出现',
  })
  assert.equal(brief.context, '本地优先')
  assert.equal(Object.prototype.hasOwnProperty.call(brief, 'extra'), false)
  assert.doesNotMatch(brief.prompt, /不应出现/)
})

// ---------------------------------------------------------------------------
console.log('\n[5] 四角色名册')
// ---------------------------------------------------------------------------
check('恰好四个角色，id 顺序固定', () => {
  assert.equal(CABINET_ROLES.length, 4)
  assert.deepEqual(
    CABINET_ROLES.map((role) => role.id),
    ROLE_IDS,
  )
})
check('四个角色名称逐字正确', () => {
  assert.deepEqual(
    CABINET_ROLES.map((role) => role.name),
    ROLE_NAMES,
  )
})
check('每个角色都有非空 mandate', () => {
  for (const role of CABINET_ROLES) {
    assert.equal(typeof role.mandate, 'string')
    assert.ok(role.mandate.trim().length >= 10, role.id + ' 的 mandate 过短')
  }
})
check('财务、风险/法务的 mandate 明确只做风险提示', () => {
  const byId = Object.fromEntries(CABINET_ROLES.map((role) => [role.id, role]))
  assert.match(byId.finance.mandate, /只做风险提示/)
  assert.match(byId.risk.mandate, /只做风险提示/)
  assert.doesNotMatch(byId.risk.mandate, /法律意见(?:是|为)/)
})
check('客户代言人强调来源、反方强调反例', () => {
  const byId = Object.fromEntries(CABINET_ROLES.map((role) => [role.id, role]))
  assert.match(byId.customer.mandate, /来源/)
  assert.match(byId.contrarian.mandate, /反例/)
})
check('id 与名称都唯一', () => {
  assert.equal(new Set(CABINET_ROLES.map((role) => role.id)).size, 4)
  assert.equal(new Set(CABINET_ROLES.map((role) => role.name)).size, 4)
})
check('名册数组与每个角色对象都被冻结', () => {
  assert.equal(Object.isFrozen(CABINET_ROLES), true)
  for (const role of CABINET_ROLES) assert.equal(Object.isFrozen(role), true)
})
check('外部 push / 改名会抛错（名册不可被篡改）', () => {
  assert.throws(() => CABINET_ROLES.push(CABINET_ROLES[0]))
  assert.throws(() => {
    CABINET_ROLES[0].name = '被改坏的名字'
  })
})

// ---------------------------------------------------------------------------
console.log('\n[6] prompt 必须包含的决策流程与边界')
// ---------------------------------------------------------------------------
check('点明「鲸群推演室」身份：鱼是推演主持，不替主人做决定', () => {
  assert.match(normal.prompt, /鲸群推演室/)
  assert.match(normal.prompt, /鱼是推演主持/)
  assert.match(normal.prompt, /不替主人做决定/)
})
check('四个角色名称与 id 都出现在 prompt 里', () => {
  for (const name of ROLE_NAMES) assert.ok(normal.prompt.includes(name), '缺少角色：' + name)
  for (const id of ROLE_IDS) assert.ok(normal.prompt.includes(id), '缺少角色 id：' + id)
})
check('每个角色的 mandate 原样进入 prompt（简报与名册一致）', () => {
  for (const role of CABINET_ROLES) {
    assert.ok(normal.prompt.includes(role.mandate), '缺少 mandate：' + role.id)
  }
})
check('每个角色都必须查证据、标假设、给置信度', () => {
  for (const word of ['查证据', '标假设', '置信度', '0–100%', '未核实']) {
    assert.ok(normal.prompt.includes(word), 'prompt 缺少要求：' + word)
  }
})
check('要求使用 AgentTeam 工具，六个工具名齐全', () => {
  assert.match(normal.prompt, /AgentTeam/)
  for (const tool of TOOL_NAMES) {
    assert.ok(normal.prompt.includes(tool), 'prompt 缺少工具名：' + tool)
  }
})
check('team_task_create 要建 MEMO 汇总任务与角色任务', () => {
  assert.match(normal.prompt, /team_task_create[^。\n]*MEMO[^。\n]*角色任务/)
})
check('subagent 启动具名角色 finance / risk / customer / contrarian', () => {
  assert.match(
    normal.prompt,
    /subagent[^。\n]*finance[^。\n]*risk[^。\n]*customer[^。\n]*contrarian/,
  )
})
check('team_task_update 用于认领与完成', () => {
  assert.match(normal.prompt, /team_task_update[^。\n]*认领[^。\n]*完成/)
})
check('send_message 用于交叉质询', () => {
  assert.match(normal.prompt, /send_message[^。\n]*交叉质询/)
})
check('任务板是唯一状态源', () => {
  assert.match(normal.prompt, /任务板是唯一状态源/)
})
check('输出六件套齐全，决策备忘录含选项/标准/评分', () => {
  for (const title of OUTPUT_TITLES) {
    assert.ok(normal.prompt.includes(title), 'prompt 缺少交付物：' + title)
  }
  for (const word of ['选项', '标准', '评分']) {
    assert.ok(normal.prompt.includes(word), '决策备忘录缺少：' + word)
  }
})
check('边界：禁止自动执行决定、禁止编造来源、财务/法务只做风险提示', () => {
  assert.match(normal.prompt, /禁止自动执行决定/)
  assert.match(normal.prompt, /禁止编造来源/)
  assert.match(normal.prompt, /只做风险提示/)
})
check('边界：鱼不自动改任务板，需要主人明确发起', () => {
  assert.match(normal.prompt, /鱼不自动改任务板/)
  assert.match(normal.prompt, /主人确认/)
})
check('prompt 不承诺自动执行 / 自动改任务板', () => {
  assert.doesNotMatch(normal.prompt, /(?:可以|会|将)自动(?:执行|改任务板)/)
})
check('prompt 要求建 MEMO 汇总任务（不只是角色任务）', () => {
  assert.match(normal.prompt, /\[MEMO\][^。\n]*汇总任务/)
})
check('prompt 不含工程组织语境', () => {
  assert.doesNotMatch(normal.prompt, /施工|包工头|工人|验收官|WhaleWorks|营造/)
})
check('prompt 同样不含真实价格、金额与法律结论', () => {
  assert.doesNotMatch(normal.prompt, /[¥￥]/)
  assert.doesNotMatch(normal.prompt, /\d+\s*(?:元|块|美元|万元|亿元)/)
  assert.doesNotMatch(normal.prompt, /《[^》]*法》/)
  assert.doesNotMatch(normal.prompt, /第[一二三四五六七八九十百千0-9]+条/)
})

// ---------------------------------------------------------------------------
console.log('\n[7] 推演规则 CABINET_PROTOCOL')
// ---------------------------------------------------------------------------
check('规则是可直接复制的长文本，不是空串或函数', () => {
  assert.equal(typeof CABINET_PROTOCOL, 'string')
  assert.ok(CABINET_PROTOCOL.length > 800, '规则过短：' + CABINET_PROTOCOL.length)
  assert.match(CABINET_PROTOCOL, /^鲸群推演室/)
  assert.match(CABINET_PROTOCOL, /规则/)
})
check('规则包含角色、流程、输出、边界四段', () => {
  for (const section of ['二、推演视角', '三、流程', '四、输出结构', '五、边界']) {
    assert.ok(CABINET_PROTOCOL.includes(section), '规则缺少章节：' + section)
  }
})
check('规则写全四位角色（名称 / id / mandate）', () => {
  for (const name of ROLE_NAMES) assert.ok(CABINET_PROTOCOL.includes(name))
  for (const id of ROLE_IDS) assert.ok(CABINET_PROTOCOL.includes(id))
  for (const role of CABINET_ROLES) assert.ok(CABINET_PROTOCOL.includes(role.mandate))
})
check('规则写明 AgentTeam 工具与任务板唯一状态源', () => {
  assert.match(CABINET_PROTOCOL, /AgentTeam/)
  for (const tool of TOOL_NAMES) assert.ok(CABINET_PROTOCOL.includes(tool))
  assert.match(CABINET_PROTOCOL, /任务板是唯一状态源/)
})
check('规则写明查证据 / 标假设 / 置信度', () => {
  for (const word of ['查证据', '标假设', '置信度']) {
    assert.ok(CABINET_PROTOCOL.includes(word), '规则缺少：' + word)
  }
})
check('规则写明六项输出，并含非专业意见声明', () => {
  for (const title of OUTPUT_TITLES) assert.ok(CABINET_PROTOCOL.includes(title))
  assert.match(CABINET_PROTOCOL, /非专业意见声明/)
})
check('规则写明边界：不替主人决定、禁止自动执行、禁止编造来源', () => {
  for (const phrase of ['不替主人做决定', '禁止自动执行决定', '禁止编造来源', '只做风险提示']) {
    assert.ok(CABINET_PROTOCOL.includes(phrase), '规则缺少边界：' + phrase)
  }
})
check('规则写明鱼不自动改任务板', () => {
  assert.match(CABINET_PROTOCOL, /鱼不自动改任务板/)
})
check('规则没有 {占位符}，可原样复制给模型', () => {
  assert.doesNotMatch(CABINET_PROTOCOL, /\{[^}\n]*\}/)
  assert.doesNotMatch(CABINET_PROTOCOL, /undefined|\[object Object\]/)
})
check('规则不含真实价格、金额与法律结论', () => {
  assert.doesNotMatch(CABINET_PROTOCOL, /[¥￥]/)
  assert.doesNotMatch(CABINET_PROTOCOL, /\d+\s*(?:元|块|美元|万元|亿元)/)
  assert.doesNotMatch(CABINET_PROTOCOL, /《[^》]*法》/)
  assert.doesNotMatch(CABINET_PROTOCOL, /第[一二三四五六七八九十百千0-9]+条/)
  assert.match(CABINET_PROTOCOL, /不含真实价格/)
})
check('规则不含工程组织语境', () => {
  assert.doesNotMatch(CABINET_PROTOCOL, /施工|包工头|工人|验收官|WhaleWorks|营造/)
})

// ---------------------------------------------------------------------------
console.log('\n[8] 简报与规则：不同但一致')
// ---------------------------------------------------------------------------
check('规则与本次简报不是同一段文本', () => {
  assert.notEqual(CABINET_PROTOCOL, normal.prompt)
})
check('规则不携带本次决定内容（规则稳定、简报临时）', () => {
  assert.equal(CABINET_PROTOCOL.includes('GitHub'), false)
  assert.equal(CABINET_PROTOCOL.includes('本月底前'), false)
})
check('两边角色名册与六项输出一致', () => {
  for (const name of ROLE_NAMES) {
    assert.ok(CABINET_PROTOCOL.includes(name) && normal.prompt.includes(name), name)
  }
  for (const title of OUTPUT_TITLES) {
    assert.ok(CABINET_PROTOCOL.includes(title) && normal.prompt.includes(title), title)
  }
})
check('两边共同承诺的核心边界一致', () => {
  for (const phrase of [
    '不替主人做决定',
    '禁止自动执行决定',
    '禁止编造来源',
    '只做风险提示',
    '任务板是唯一状态源',
    '鱼不自动改任务板',
  ]) {
    assert.ok(
      CABINET_PROTOCOL.includes(phrase) && normal.prompt.includes(phrase),
      '简报与规则不一致：' + phrase,
    )
  }
})
check('所有对外字符串都没有工程组织语境', () => {
  const all = [
    CABINET_PROTOCOL,
    CABINET_ROLES.map((role) => role.name).join('\n'),
    CABINET_ROLES.map((role) => role.mandate).join('\n'),
    normal.prompt,
  ].join('\n')
  assert.doesNotMatch(all, /施工|包工头|工人|验收官|WhaleWorks|营造/)
})

// ---------------------------------------------------------------------------
console.log('\n[9] 确定性与不可变性')
// ---------------------------------------------------------------------------
check('同一输入两次调用，输出完全一致', () => {
  const again = buildCabinetPrompt(NORMAL_INPUT)
  assert.deepEqual(again, normal)
  assert.equal(again.prompt, normal.prompt)
})
check('每次返回新对象（调用方改简报不会污染下一次）', () => {
  const first = buildCabinetPrompt({ decision: '要不要换数据源' })
  const second = buildCabinetPrompt({ decision: '要不要换数据源' })
  assert.notEqual(first, second)
  first.decision = '被调用方改掉'
  assert.equal(buildCabinetPrompt({ decision: '要不要换数据源' }).decision, '要不要换数据源')
})
check('不同决定生成不同简报', () => {
  const a = buildCabinetPrompt({ decision: '要不要换数据源' })
  const b = buildCabinetPrompt({ decision: '要不要换语音引擎' })
  assert.notEqual(a.prompt, b.prompt)
})
check('简报里的 roles 也是冻结名册', () => {
  assert.equal(Object.isFrozen(normal.roles), true)
  assert.equal(Object.isFrozen(normal.roles[0]), true)
})

// ---------------------------------------------------------------------------
console.log('')
if (failures.length > 0) {
  console.error(`失败 ${failures.length} 项，通过 ${pass} 项`)
  process.exitCode = 1
} else {
  console.log(`通过 ${pass} 项`)
}
