/**
 * scripts/test-repos.mjs —— host/repos 六个仓储的永久回归（封装 / 数据完整性 / 幂等）
 *
 * 背景（B55 仓储分身审计）：
 *   仓储层是最靠近持久化的一层，出问题不会立刻报错，只会「悄悄写错」：
 *   重复提醒连响、负亲密度落盘、逾期很久的重复提醒下次又响、超大重复间隔把整份
 *   到点列表一起抛掉……这些都不是类型能拦住的。本脚本按源码真实语义逐条断言。
 *
 * 覆盖：
 *   [A] 封装治理：公开接口清单、不跨仓储直读、load 返回的是副本（没有内存缓存可污染）
 *   [B] memory：条数上限 / 成对追加 / 摘要不被覆盖 / 坏文件隔离
 *   [C] state：亲密度清洗口径（读写都夹到 [0,100] 整数）
 *   [D] growth：日上限 / 来源上限 / 部分截断的 capped / 跨天归零 / NaN·Infinity 清洗 / 升级判定
 *   [E] fishfood：读时跨天·跨月滚动 / 总量保留 / 脏值不进文件 / 安全整数封顶
 *   [F] pet：饥饿结算 / 时钟回拨 / 心情窗口 / 负亲密度（历史字段）不再落负数
 *   [G] reminders：一次性与重复的幂等、逾期很久不重复触发、超大间隔不炸、序号与删除
 *
 * 纯离线（不联网、不起 HTTP、不碰 dist），直接加载 src/*.ts。
 * 用法：node scripts/test-repos.mjs      # 失败退出码 1
 */
import { register } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
register(new URL('./ts-resolve.mjs', import.meta.url))
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href)

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.error('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

const tmpDirs = []
function mkTmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}
process.on('exit', () => {
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }) } catch { } }
})

/** 静默执行一段预期会打日志的代码（仓储层用 console.error 留痕，测试输出不必刷屏） */
function quiet(fn) {
  const real = console.error
  console.error = () => { }
  try { return fn() } finally { console.error = real }
}

const pad = (n) => (n < 10 ? '0' + n : String(n))
const todayKey = (d = new Date()) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
const monthKey = (d = new Date()) => d.getFullYear() + '-' + pad(d.getMonth() + 1)
const iso = (ms) => new Date(ms).toISOString()

// ---------------------------------------------------------------------------
// [A] 封装治理
// ---------------------------------------------------------------------------
console.log('\n[A] 封装治理：最小接口 / 不跨仓储直读 / load 交出的是副本')

const REPO_FILES = {
  memory: { file: 'memory.json', keys: ['appendTurns', 'clearMemory', 'loadHistory', 'loadMemorySummary', 'saveHistory', 'saveMemorySummary'] },
  state: { file: 'state.json', keys: ['loadState', 'saveState'] },
  growth: { file: 'growth.json', keys: ['addExp', 'loadGrowth', 'saveGrowth'] },
  fishfood: { file: 'fishfood.json', keys: ['addTokens', 'loadFishfood', 'saveFishfood'] },
  pet: { file: 'pet_state.json', keys: ['feedPet', 'loadPet', 'savePet', 'setMood', 'tickPet'] },
  reminders: { file: 'reminders.json', keys: ['addReminder', 'dueReminders', 'loadReminders', 'removeReminder', 'saveReminders'] },
}

try {
  const { createMemoryRepo } = await imp('src/host/repos/memory.ts')
  const { createStateRepo } = await imp('src/host/repos/state.ts')
  const { createGrowthRepo } = await imp('src/host/repos/growth.ts')
  const { createTokenRepo } = await imp('src/host/repos/fishfood.ts')
  const { createPetRepo } = await imp('src/host/repos/pet.ts')
  const { createReminderRepo } = await imp('src/host/repos/reminders.ts')

  const dir = mkTmp('whale-repos-a-')
  const repos = {
    memory: createMemoryRepo(dir),
    state: createStateRepo(dir),
    growth: createGrowthRepo(dir),
    fishfood: createTokenRepo(dir),
    pet: createPetRepo(dir),
    reminders: createReminderRepo(dir),
  }
  for (const name of Object.keys(REPO_FILES)) {
    const got = Object.keys(repos[name]).sort().join(',')
    const want = REPO_FILES[name].keys.join(',')
    ok(name + ' 只暴露最小接口', got === want, got === want ? '' : 'got=' + got)
  }

  // 静态：仓储之间不得互相 import，也不得读别的仓储的数据文件；
  // 仓储不得反向依赖 store / routes / index（宪章：跨模块只走公开接口）。
  for (const name of Object.keys(REPO_FILES)) {
    const src = readFileSync(join(ROOT, 'src/host/repos', name + '.ts'), 'utf8')
    const others = Object.keys(REPO_FILES).filter((n) => n !== name)
    const crossImport = others.filter((n) => new RegExp("from\\s+'\\./" + n + "\\.js'").test(src))
    // 只认「引号里的数据文件名」（join(dataDir, 'x.json')）；注释里提一句别的文件名不算直读
    const crossRead = others.filter((n) => src.indexOf("'" + REPO_FILES[n].file + "'") >= 0)
    const backDep = /from\s+'(\.\.\/(store|routes|index)|\.\.\/\.\.\/index)\.js'/.test(src)
    ok(name + ' 不跨仓储 import/直读', crossImport.length === 0 && crossRead.length === 0,
      crossImport.concat(crossRead).join(',') || '')
    ok(name + ' 不反向依赖 store/routes/index', !backDep)
  }

  // 动态：load 每次从盘上新解析（没有模块级缓存），调用方改返回值不污染持久层
  const a1 = repos.state.loadState()
  a1.intimacy = 77
  ok('state：改返回值不污染下一次读', repos.state.loadState().intimacy === 0)

  repos.memory.appendTurns('主人', '在呢')
  const h1 = repos.memory.loadHistory()
  h1.push({ role: 'user', content: '外部塞进来的' })
  h1[0].content = '被改了'
  const h2 = repos.memory.loadHistory()
  ok('memory：loadHistory 每次给新数组', h2.length === 2 && h2[0].content === '主人')

  const r1 = repos.reminders.loadReminders()
  r1.push({ id: 'x', text: '外部塞的', at: iso(Date.now() + 1000) })
  ok('reminders：loadReminders 每次给新数组', repos.reminders.loadReminders().length === 0)

  const g1 = repos.growth.loadGrowth()
  g1.exp = 999
  ok('growth：改返回值不写盘', Number(repos.growth.loadGrowth().exp) === 0)

  const f1 = repos.fishfood.loadFishfood()
  f1.totalTokens = 123
  ok('fishfood：改返回值不写盘', Number(repos.fishfood.loadFishfood().totalTokens || 0) === 0)

  const p1 = repos.pet.loadPet()
  p1.hunger = 99
  ok('pet：改返回值不写盘', Number(repos.pet.loadPet().hunger) === 0)
} catch (err) {
  ok('[A] 封装治理断言执行', false, String((err && err.stack) || err))
}

// ---------------------------------------------------------------------------
// [B] memory
// ---------------------------------------------------------------------------
console.log('\n[B] memory：条数上限 / 成对追加 / 摘要 / 坏文件')
try {
  const { createMemoryRepo } = await imp('src/host/repos/memory.ts')

  const dir = mkTmp('whale-repos-mem-')
  const repo = createMemoryRepo(dir)

  for (let i = 0; i < 25; i++) repo.appendTurns('主人' + i, '在呢' + i)
  const h = repo.loadHistory()
  ok('25 轮后只留最新 50 条（80 上限不截断）', h.length === 50, 'len=' + h.length)
  ok('最新一轮是最后一对', h[48].content === '主人24' && h[49].content === '在呢24')
  ok('截断后仍从 user 开始、成对交替', h[0].role === 'user' && h[1].role === 'assistant' && h[39].role === 'assistant')

  repo.saveMemorySummary('主人爱喝热水')
  repo.appendTurns('新的', '好的')
  ok('追加对话不覆盖摘要', repo.loadMemorySummary() === '主人爱喝热水')

  const raw = JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8'))
  ok('落盘带 savedAt 且 history 仍是 50', Array.isArray(raw.history) && raw.history.length === 50 && typeof raw.savedAt === 'string')

  repo.clearMemory()
  ok('clearMemory 连摘要一起清空', repo.loadHistory().length === 0 && repo.loadMemorySummary() === '')

  // 坏文件：隔离成 .bad-*，本次返回空记忆，不抛
  writeFileSync(join(dir, 'memory.json'), '{ 这不是 JSON')
  const badDir = dir
  const bad = quiet(() => createMemoryRepo(badDir).loadHistory())
  ok('坏 memory.json：返回空数组不抛', Array.isArray(bad) && bad.length === 0)
  ok('坏 memory.json：已备份成 .bad-*', readdirSync(badDir).some((n) => n.indexOf('memory.json.bad-') === 0))

  // 老格式（整份是数组）兼容
  const dir2 = mkTmp('whale-repos-mem2-')
  writeFileSync(join(dir2, 'memory.json'), JSON.stringify([{ role: 'user', content: '老' }, { role: 'assistant', content: '格式' }]))
  const old = createMemoryRepo(dir2).loadHistory()
  ok('老格式（整份数组）兼容', old.length === 2 && old[1].content === '格式')
} catch (err) {
  ok('[B] memory 断言执行', false, String((err && err.stack) || err))
}

// ---------------------------------------------------------------------------
// [C] state
// ---------------------------------------------------------------------------
console.log('\n[C] state：亲密度读写同口径清洗')
try {
  const { createStateRepo } = await imp('src/host/repos/state.ts')
  const dir = mkTmp('whale-repos-state-')
  const repo = createStateRepo(dir)

  repo.saveState({ intimacy: 150 })
  ok('>100 截到 100', repo.loadState().intimacy === 100)
  repo.saveState({ intimacy: -9 })
  ok('负数归 0', repo.loadState().intimacy === 0)
  repo.saveState({ intimacy: '12.9' })
  ok('小数向下取整（12.9 → 12）', repo.loadState().intimacy === 12)
  repo.saveState({ intimacy: NaN })
  ok('NaN 归 0', repo.loadState().intimacy === 0)
  const raw = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  ok('落盘里没有 NaN（JSON 里是合法数字）', raw.intimacy === 0)

  repo.saveState({ intimacy: 5, lastTalkAt: 123 })
  ok('其它字段原样保留', repo.loadState().lastTalkAt === 123)

  quiet(() => repo.saveState(null))
  ok('saveState(null) 落成 0 而不是写坏文件', repo.loadState().intimacy === 0)
} catch (err) {
  ok('[C] state 断言执行', false, String((err && err.stack) || err))
}

// ---------------------------------------------------------------------------
// [D] growth
// ---------------------------------------------------------------------------
console.log('\n[D] growth：日上限 / 来源上限 / capped / 跨天 / 脏值')
try {
  const { createGrowthRepo, EXP_DAILY_CAP, EXP_SOURCE_CAP } = await imp('src/host/repos/growth.ts')

  // 来源上限：chat=5
  const d1 = mkTmp('whale-repos-g1-')
  const g1 = createGrowthRepo(d1)
  let last = null
  for (let i = 0; i < 8; i++) last = quiet(() => g1.addExp(1, 'chat'))
  ok('chat 来源当日上限 ' + EXP_SOURCE_CAP.chat, last.exp === EXP_SOURCE_CAP.chat, 'exp=' + last.exp)
  ok('超出来源上限的请求 capped=true', last.capped === true)
  const g1raw = JSON.parse(readFileSync(join(d1, 'growth.json'), 'utf8'))
  ok('落盘 src.chat 与 dayExp 同口径', g1raw.src.chat === EXP_SOURCE_CAP.chat && g1raw.dayExp === EXP_SOURCE_CAP.chat)

  // 日上限：chat 5 + praise 6 = 11，feed 只能再拿 1
  let g2last = null
  for (let i = 0; i < 7; i++) g2last = quiet(() => g1.addExp(1, 'praise'))
  ok('praise 来源上限 6，合计 11', g2last.exp === 11, 'exp=' + g2last.exp)
  quiet(() => g1.addExp(1, 'feed'))
  g2last = quiet(() => g1.addExp(1, 'feed'))
  ok('跨来源合计卡在日上限 ' + EXP_DAILY_CAP, g2last.exp === EXP_DAILY_CAP, 'exp=' + g2last.exp)
  ok('日上限耗尽后 capped=true', g2last.capped === true)

  // 部分截断：dayExp=10，请求 5 只给 2，必须报 capped
  const d2 = mkTmp('whale-repos-g2-')
  writeFileSync(join(d2, 'growth.json'), JSON.stringify({ exp: 100, dayKey: todayKey(), dayExp: 10, src: {} }))
  const g2 = createGrowthRepo(d2)
  const part = quiet(() => g2.addExp(5, 'chat'))
  ok('部分截断（请求 5 只入 2）', part.exp === 102, 'exp=' + part.exp)
  ok('部分截断也报 capped=true（坑 44）', part.capped === true)

  // 跨天归零
  const d3 = mkTmp('whale-repos-g3-')
  writeFileSync(join(d3, 'growth.json'), JSON.stringify({
    exp: 50, dayKey: '2000-01-01', dayExp: EXP_DAILY_CAP, src: { chat: 5, praise: 6 },
  }))
  const g3 = createGrowthRepo(d3)
  const cross = g3.addExp(1, 'chat')
  ok('跨天：日计数与各来源额度清零', cross.exp === 51 && cross.capped === false, 'exp=' + cross.exp + ' capped=' + cross.capped)
  const g3raw = JSON.parse(readFileSync(join(d3, 'growth.json'), 'utf8'))
  ok('跨天后 dayKey 更新为今天', g3raw.dayKey === todayKey(), g3raw.dayKey)
  ok('跨天后 src.praise 归零、src.chat=1', g3raw.src.praise === 0 && g3raw.src.chat === 1)

  // NaN / Infinity / 负数 / 小数
  const d4 = mkTmp('whale-repos-g4-')
  const g4 = createGrowthRepo(d4)
  const nan = quiet(() => g4.addExp(NaN, 'chat'))
  ok('NaN 请求 → 0 经验、不落 NaN', nan.exp === 0 && nan.capped === false)
  const inf = quiet(() => g4.addExp(Infinity, 'praise'))
  ok('Infinity 请求 → 只拿来源上限、capped=true', inf.exp === EXP_SOURCE_CAP.praise && inf.capped === true, 'exp=' + inf.exp)
  const neg = quiet(() => g4.addExp(-3, 'chat'))
  ok('负数请求 → 不加经验', neg.exp === inf.exp)
  const g4raw = JSON.parse(readFileSync(join(d4, 'growth.json'), 'utf8'))
  ok('落盘 exp/dayExp 都是有限整数', Number.isInteger(g4raw.exp) && Number.isInteger(g4raw.dayExp) && Number.isFinite(g4raw.exp))

  // 脏文件：exp 是字符串、dayExp 负数、src 是数组
  const d5 = mkTmp('whale-repos-g5-')
  writeFileSync(join(d5, 'growth.json'), JSON.stringify({ exp: 'abc', dayKey: null, dayExp: -3, src: [] }))
  const g5 = createGrowthRepo(d5)
  const dirty = quiet(() => g5.addExp(1, 'chat'))
  ok('脏 exp 按 0 起算', dirty.exp === 1, 'exp=' + dirty.exp)
  const g5raw = JSON.parse(readFileSync(join(d5, 'growth.json'), 'utf8'))
  ok('脏 src 数组被重建为对象', g5raw.src && !Array.isArray(g5raw.src) && g5raw.src.chat === 1)
  ok('脏 dayExp 归零后重新累计', g5raw.dayExp === 1)

  // 升级判定
  const d6 = mkTmp('whale-repos-g6-')
  writeFileSync(join(d6, 'growth.json'), JSON.stringify({ exp: 199, dayKey: todayKey(), dayExp: 0, src: {} }))
  const g6 = createGrowthRepo(d6)
  const up = g6.addExp(1, 'chat')
  ok('199 → 200 触发升级（upgraded/prevStage）', up.exp === 200 && up.upgraded === true && up.prevStage.index === 0 && up.stage.index === 1)
} catch (err) {
  ok('[D] growth 断言执行', false, String((err && err.stack) || err))
}

// ---------------------------------------------------------------------------
// [E] fishfood
// ---------------------------------------------------------------------------
console.log('\n[E] fishfood：读时跨天/跨月滚动 / 总量保留 / 脏值')
try {
  const { createTokenRepo } = await imp('src/host/repos/fishfood.ts')

  const d1 = mkTmp('whale-repos-f1-')
  const t1 = createTokenRepo(d1)
  t1.addTokens('chat', 7)
  const firstRaw = JSON.parse(readFileSync(join(d1, 'fishfood.json'), 'utf8'))
  ok('首次写入就带 day/month 标记', firstRaw.day === todayKey() && firstRaw.month === monthKey(), JSON.stringify({ day: firstRaw.day, month: firstRaw.month }))
  const f = t1.addTokens('story', 3)
  ok('第二次累加不会清掉第一次的计数（新文件不带标记时实测 7 → 0）', f.chatTokens === 7 && f.storyTokens === 3)
  ok('今日与总量同步累计', f.dayTokens === 10 && f.totalTokens === 10 && f.monthTokens === 10)
  ok('落盘 day/month 是 YYYY-MM-DD / YYYY-MM', f.day === todayKey() && f.month === monthKey())

  // 老文件/备份导入没有 day/month 标记：只补标记、不清零（没有标记不等于跨天）
  const dLegacy = mkTmp('whale-repos-f1b-')
  const tLegacy = createTokenRepo(dLegacy)
  tLegacy.saveFishfood({ chatTokens: 50, storyTokens: 0, totalTokens: 100 })
  const legacyLoaded = tLegacy.loadFishfood()
  ok('无标记的老文件：计数保留、只补 day/month', legacyLoaded.chatTokens === 50 && legacyLoaded.day === todayKey() && legacyLoaded.month === monthKey())
  const legacyAdd = tLegacy.addTokens('chat', 5)
  ok('无标记的老文件继续累加不丢历史计数', legacyAdd.chatTokens === 55 && legacyAdd.dayTokens === 5 && legacyAdd.totalTokens === 105)

  // 读时滚动：旧日期文件，load 即清零今日/本月，总量不动；且读不写盘（坑 45 的口径）
  const d2 = mkTmp('whale-repos-f2-')
  const p = join(d2, 'fishfood.json')
  writeFileSync(p, JSON.stringify({
    chatTokens: 100, storyTokens: 50, dayTokens: 10, monthTokens: 30, totalTokens: 1000,
    day: '2000-01-01', month: '2000-01',
  }))
  const before = readFileSync(p, 'utf8')
  const t2 = createTokenRepo(d2)
  const rolled = t2.loadFishfood()
  ok('读时跨天：今日/分类清零', rolled.chatTokens === 0 && rolled.storyTokens === 0 && rolled.dayTokens === 0)
  ok('读时跨月：本月清零', rolled.monthTokens === 0)
  ok('总量 totalTokens 保留', rolled.totalTokens === 1000)
  ok('读时滚动只改内存、不写盘', readFileSync(p, 'utf8') === before)

  // 脏值：NaN / 负数 / Infinity 一律不进文件
  const d3 = mkTmp('whale-repos-f3-')
  const t3 = createTokenRepo(d3)
  t3.addTokens('chat', NaN)
  t3.addTokens('chat', -5)
  t3.addTokens('chat', Infinity)
  ok('无效用量不创建文件（不写 NaN）', !existsSync(join(d3, 'fishfood.json')))
  const okAdd = t3.addTokens('chat', 10)
  ok('无效用量不影响后续累计', okAdd.chatTokens === 10 && okAdd.totalTokens === 10)
  const raw3 = JSON.parse(readFileSync(join(d3, 'fishfood.json'), 'utf8'))
  ok('落盘数值全部有限', ['chatTokens', 'storyTokens', 'dayTokens', 'monthTokens', 'totalTokens'].every((k) => Number.isFinite(raw3[k])))

  // 安全整数封顶
  const d4 = mkTmp('whale-repos-f4-')
  writeFileSync(join(d4, 'fishfood.json'), JSON.stringify({
    chatTokens: 0, storyTokens: 0, dayTokens: 0, monthTokens: 0,
    totalTokens: Number.MAX_SAFE_INTEGER, day: todayKey(), month: monthKey(),
  }))
  const t4 = createTokenRepo(d4)
  const capped = t4.addTokens('chat', 5)
  ok('totalTokens 到安全整数上限就封顶', capped.totalTokens === Number.MAX_SAFE_INTEGER, String(capped.totalTokens))
  ok('封顶不影响分类计数', capped.chatTokens === 5)
} catch (err) {
  ok('[E] fishfood 断言执行', false, String((err && err.stack) || err))
}

// ---------------------------------------------------------------------------
// [F] pet
// ---------------------------------------------------------------------------
console.log('\n[F] pet：饥饿结算 / 时钟回拨 / 心情 / 历史亲密度')
try {
  const { createPetRepo } = await imp('src/host/repos/pet.ts')
  const nowMs = Date.now()

  // 离线每小时 +3，封顶 100
  const d1 = mkTmp('whale-repos-p1-')
  writeFileSync(join(d1, 'pet_state.json'), JSON.stringify({ feeds: 0, hunger: 10, mood: 'normal', lastSeen: nowMs - 10 * 3600 * 1000 }))
  const p1 = createPetRepo(d1).tickPet()
  ok('离线 10 小时饥饿 +30', Math.abs(p1.hunger - 40) < 0.001, String(p1.hunger))
  ok('结算后 lastSeen 推到 now', Math.abs(p1.lastSeen - Date.now()) < 2000)
  writeFileSync(join(d1, 'pet_state.json'), JSON.stringify({ feeds: 0, hunger: 99, mood: 'normal', lastSeen: nowMs - 100 * 3600 * 1000 }))
  const p1b = createPetRepo(d1).tickPet()
  ok('饥饿封顶 100 不是 300', p1b.hunger === 100, String(p1b.hunger))

  // 时钟回拨：lastSeen 在将来 → 不结算负数、不崩溃、lastSeen 回写 now
  const d2 = mkTmp('whale-repos-p2-')
  writeFileSync(join(d2, 'pet_state.json'), JSON.stringify({ feeds: 0, hunger: 50, mood: 'normal', lastSeen: nowMs + 3600 * 1000 }))
  const p2 = createPetRepo(d2).tickPet()
  ok('时钟回拨：饥饿不倒退也不增加', p2.hunger === 50, String(p2.hunger))
  ok('时钟回拨：lastSeen 回写为当前时间', Math.abs(p2.lastSeen - Date.now()) < 2000)

  // 心情：6 小时 happy 窗口 / 饥饿 >=70 算 hungry
  const d3 = mkTmp('whale-repos-p3-')
  writeFileSync(join(d3, 'pet_state.json'), JSON.stringify({ feeds: 1, hunger: 20, mood: 'normal', lastSeen: nowMs, lastFeedAt: nowMs - 3600 * 1000 }))
  ok('喂食后 1 小时内 mood=happy', createPetRepo(d3).tickPet().mood === 'happy')
  writeFileSync(join(d3, 'pet_state.json'), JSON.stringify({ feeds: 1, hunger: 20, mood: 'happy', lastSeen: nowMs, lastFeedAt: nowMs - 7 * 3600 * 1000 }))
  ok('喂食超过 6 小时 mood 回落 normal', createPetRepo(d3).tickPet().mood === 'normal')
  writeFileSync(join(d3, 'pet_state.json'), JSON.stringify({ feeds: 0, hunger: 80, mood: 'normal', lastSeen: nowMs, lastFeedAt: 0 }))
  ok('饥饿 80 → mood=hungry', createPetRepo(d3).tickPet().mood === 'hungry')

  // 喂食：feeds+1、饥饿 -30 不低于 0、mood=happy、lastFeedAt 写当前
  const d4 = mkTmp('whale-repos-p4-')
  writeFileSync(join(d4, 'pet_state.json'), JSON.stringify({ feeds: 2, hunger: 10, mood: 'normal', lastSeen: nowMs, lastFeedAt: 0 }))
  const fed = createPetRepo(d4).feedPet()
  ok('喂食 feeds+1 且饥饿不低于 0', fed.feeds === 3 && fed.hunger === 0 && fed.mood === 'happy')
  ok('喂食写 lastFeedAt', Number(fed.lastFeedAt) > 0 && Math.abs(fed.lastFeedAt - Date.now()) < 2000)

  // 历史字段 intimacy：旧文件里的负数不能被"再减一点"后落盘
  const d5 = mkTmp('whale-repos-p5-')
  writeFileSync(join(d5, 'pet_state.json'), JSON.stringify({ feeds: 0, hunger: 50, mood: 'normal', lastSeen: 0, intimacy: -50 }))
  const repo5 = createPetRepo(d5)
  const f1 = repo5.feedPet()
  ok('负亲密度喂食后不低于 0', f1.intimacy >= 0, String(f1.intimacy))
  const f2 = repo5.feedPet()
  ok('连续喂食也不会越喂越负', f2.intimacy >= 0, String(f2.intimacy))
  const raw5 = JSON.parse(readFileSync(join(d5, 'pet_state.json'), 'utf8'))
  ok('落盘 intimacy 在 [0,100]', raw5.intimacy >= 0 && raw5.intimacy <= 100, String(raw5.intimacy))

  // 历史字段上限：200 也只到 100
  writeFileSync(join(d5, 'pet_state.json'), JSON.stringify({ feeds: 0, hunger: 0, mood: 'normal', lastSeen: 0, intimacy: 200 }))
  const f3 = createPetRepo(d5).feedPet()
  ok('历史亲密度封顶 100', f3.intimacy === 100, String(f3.intimacy))

  // 脏字段：hunger 是字符串/负数
  const d6 = mkTmp('whale-repos-p6-')
  writeFileSync(join(d6, 'pet_state.json'), JSON.stringify({ feeds: -2, hunger: 'abc', mood: 3, lastSeen: 'x' }))
  const p6 = createPetRepo(d6).tickPet()
  ok('脏 hunger 归 0、不写 NaN', p6.hunger === 0 && Number.isFinite(p6.hunger))
  ok('脏 lastSeen 按首次运行处理', Number.isFinite(p6.lastSeen) && Math.abs(p6.lastSeen - Date.now()) < 2000)
} catch (err) {
  ok('[F] pet 断言执行', false, String((err && err.stack) || err))
}

// ---------------------------------------------------------------------------
// [G] reminders
// ---------------------------------------------------------------------------
console.log('\n[G] reminders：一次性/重复提醒的幂等与序号')
try {
  const { createReminderRepo } = await imp('src/host/repos/reminders.ts')
  const now = Date.now()

  // 新增：默认字段与 repeat 清洗
  const d1 = mkTmp('whale-repos-r1-')
  const repo = createReminderRepo(d1)
  const item = repo.addReminder('喝水', iso(now + 60000), 0)
  ok('新增提醒字段齐全', typeof item.id === 'string' && item.id.length > 0 && item.repeat === null && item.nextAt === null
    && item.fired === false && item.done === false && item.remindCount === 0 && typeof item.createdAt === 'string')
  const inf = repo.addReminder('诡异间隔', iso(now + 60000), Number.POSITIVE_INFINITY)
  ok('非有限 repeat 不落盘（按一次性）', inf.repeat === null, String(inf.repeat))
  const nanRep = repo.addReminder('坏间隔', iso(now + 60000), NaN)
  ok('NaN repeat 落成 null', nanRep.repeat === null)

  // 一次性：到点只响一次，第二次轮询为空
  const d2 = mkTmp('whale-repos-r2-')
  const once = createReminderRepo(d2)
  once.addReminder('喝水', iso(now - 1000), 0)
  const due1 = once.dueReminders()
  ok('一次性提醒到点返回 1 条', due1.length === 1 && due1[0].remindCount === 1)
  // 1.2.2 起：一次性提醒响过即删（不把 done=true 的空壳留在列表里），断言同步成「列表里已不存在」
  ok('一次性提醒响过即删', once.loadReminders().length === 0)
  ok('一次性提醒不会重复触发（幂等）', once.dueReminders().length === 0)

  // 未到点不触发
  const d3 = mkTmp('whale-repos-r3-')
  const future = createReminderRepo(d3)
  future.addReminder('以后', iso(now + 3600 * 1000), 0)
  ok('未到点的提醒不触发', future.dueReminders().length === 0)

  // 重复（每天）：只响一次，nextAt 推到未来，下一次轮询不再响
  const d4 = mkTmp('whale-repos-r4-')
  const daily = createReminderRepo(d4)
  daily.addReminder('每天吃药', iso(now - 2 * 86400 * 1000), 86400)
  const dd = daily.dueReminders()
  const dailySaved = daily.loadReminders()[0]
  ok('重复提醒到点返回 1 条', dd.length === 1 && dd[0].remindCount === 1)
  ok('重复提醒不标 done、nextAt 在未来', dailySaved.done === false && new Date(dailySaved.nextAt).getTime() > Date.now(), String(dailySaved.nextAt))
  ok('重复提醒不会同一时刻重复触发', daily.dueReminders().length === 0)

  // 逾期很久 + 小间隔（route 允许 60 秒）：nextAt 必须严格晚于 now，否则每次轮询都重复响
  const d5 = mkTmp('whale-repos-r5-')
  const tight = createReminderRepo(d5)
  tight.addReminder('每小时喝水', iso(now - 8 * 86400 * 1000), 60)
  const t1 = tight.dueReminders()
  const tightSaved = tight.loadReminders()[0]
  ok('逾期 8 天的小间隔重复提醒：只返回 1 条', t1.length === 1)
  ok('逾期 8 天的小间隔重复提醒：nextAt 严格晚于 now', new Date(tightSaved.nextAt).getTime() > Date.now(), String(tightSaved.nextAt))
  ok('逾期 8 天的小间隔重复提醒：下一次轮询不再重复响', tight.dueReminders().length === 0)

  // 超大重复间隔：不能让 toISOString() 抛 RangeError（会把整份到点列表一起废掉）
  const d6 = mkTmp('whale-repos-r6-')
  const huge = createReminderRepo(d6)
  huge.addReminder('天文数字间隔', iso(now - 3600 * 1000), 1e15)
  let threw = null
  let hugeDue = null
  try { hugeDue = quiet(() => huge.dueReminders()) } catch (err) { threw = err }
  ok('超大 repeat 不抛异常（RangeError 会把整份列表带崩）', threw === null, threw ? String(threw.message) : '')
  ok('超大 repeat：本次仍照常返回该条', Array.isArray(hugeDue) && hugeDue.length === 1)
  ok('超大 repeat：退化成一次性（done）而不是留下非法 nextAt', huge.loadReminders()[0].done === true)
  ok('超大 repeat：坏数据之后列表仍可继续用', Array.isArray(huge.loadReminders()) && huge.loadReminders().length === 1)

  // 坏 at：跳过这条，不影响同文件里正常的那条
  const d7 = mkTmp('whale-repos-r7-')
  writeFileSync(join(d7, 'reminders.json'), JSON.stringify([
    { id: 'bad', text: '坏时间', at: '不是时间', repeat: null, nextAt: null, fired: false, done: false, remindCount: 0 },
    { id: 'good', text: '好时间', at: iso(now - 1000), repeat: null, nextAt: null, fired: false, done: false, remindCount: 0 },
  ]))
  const mixed = createReminderRepo(d7)
  const mixedDue = mixed.dueReminders()
  ok('坏 at 被跳过、好提醒照常触发', mixedDue.length === 1 && mixedDue[0].id === 'good', JSON.stringify(mixedDue.map((x) => x.id)))

  // done 的条目不触发；删除按 id 精确删除
  const d8 = mkTmp('whale-repos-r8-')
  const del = createReminderRepo(d8)
  const a = del.addReminder('甲', iso(now - 1000), 0)
  const b = del.addReminder('乙', iso(now + 86400 * 1000), 0)
  del.saveReminders(del.loadReminders().map((r) => (r.id === a.id ? { ...r, done: true } : r)))
  ok('done 的条目不参与到点判定', del.dueReminders().length === 0)
  del.removeReminder(a.id)
  ok('按 id 只删指定的一条', del.loadReminders().length === 1 && del.loadReminders()[0].id === b.id)

  // 重复提醒的 at 同步推进（管理面板按 at 展示下一次时间）
  const d9 = mkTmp('whale-repos-r9-')
  const sync = createReminderRepo(d9)
  sync.addReminder('每天', iso(now - 86400 * 1000), 86400)
  sync.dueReminders()
  const fired = sync.loadReminders()[0]
  ok('重复提醒触发后 at 与 nextAt 一致（面板不会显示旧时间）', fired.at === fired.nextAt)
  ok('重复提醒 remindCount 递增', fired.remindCount === 1)
} catch (err) {
  ok('[G] reminders 断言执行', false, String((err && err.stack) || err))
}


// 成长值读入封顶（B105）：脏文件 / 导入的 1e308 不能原样落盘
{
  const dir = mkdtempSync(join(tmpdir(), 'growth-cap-'))
  try {
    writeFileSync(join(dir, 'growth.json'), JSON.stringify({ exp: 1e308, dayExp: 1e308 }))
    const { createGrowthRepo } = await imp('src/host/repos/growth.ts')
    const repo = createGrowthRepo(dir)
    const r = repo.addExp(1, 'chat')
    ok('成长值读入封顶（1e308 不当真值）', Number.isFinite(r.exp) && r.exp <= Number.MAX_SAFE_INTEGER, String(r.exp))
    const disk = JSON.parse(readFileSync(join(dir, 'growth.json'), 'utf8'))
    ok('落盘经验也是安全整数', Number.isFinite(disk.exp) && disk.exp <= Number.MAX_SAFE_INTEGER, String(disk.exp))
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { }
  }
}

console.log('\n' + '='.repeat(56))
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项')
if (fail > 0) process.exitCode = 1
