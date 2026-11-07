/**
 * scripts/test-briefing-reminders.mjs —— B100「简报 + 提醒」两条路由的专项回归
 *
 * 覆盖（只断言"应然"，不改 package.json / scripts/test.mjs）：
 *   A. 提醒：超长正文按「字」（Unicode 码点）截断——不切出孤立代理项（半个 emoji）；
 *   B. 提醒：at 规范化——带偏移/本地时区文案统一落成 UTC ISO（绝对时刻不随宿主时区漂移），
 *      长度与备份导入 BACKUP_LIMITS.reminderStampLen(40) 同口径；非法/非字符串 at 仍 400；
 *   C. 提醒：repeat 边界（60 ~ 7 天、NaN/Infinity/负数/字符串/小数）；
 *   D. 提醒：方法与回包形状——405 与简报同码 METHOD_NOT_ALLOWED，空体/非法时间 400，
 *      32KB 上限 413，DELETE 带/不带 id 的既有契约；
 *   E. 提醒 × 真实仓储联调（临时目录）：过去时间只响一次、重复提醒 nextAt 严格晚于现在、
 *      不连响、删除后不触发、路由 → 仓储 → 到点列表的完整链路；
 *   F. 简报：可注入时钟（与 daily.ts 的 now 端口同口径）——跨天/跨年/非法时钟/时钟抛错；
 *   G. 简报：天气段清洗——多行压成单行、剥掉「提醒/待办」字样（保护客户端两段切分）、
 *      按字截断、控制字符清理、失败/抛错不陪葬；
 *   H. 简报：首次运行无数据（读取器抛错/坏经验值/坏项）不编数字、不陪葬其它段；
 *   I. 封装治理静态检查：两条路由不直连 repos/store/cache/data/prefs、不碰文件系统，
 *      请求体必带上限、外呼必带超时。
 *
 * 纯离线：不联网、不起 HTTP、不碰 dist。提醒仓储联调只写系统临时目录并在 finally 删除。
 * 用法：node scripts/test-briefing-reminders.mjs      （退出码 0=全绿）
 * 说明：没有接进 npm test —— package.json 不在本批可改范围内（见交付说明）。
 */
import { register } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { readFileSync, mkdtempSync, rmSync, readdirSync, mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
// 测试直接加载 .ts：把找不到的 .js 回退到同名 .ts（与 scripts/test.mjs 同一钩子）
register(new URL('./ts-resolve.mjs', import.meta.url))
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href)
const readSrc = (rel) => readFileSync(join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

/** 孤立代理项（半个 emoji）：高代理后面不跟低代理，或低代理前面没有高代理 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const cpLen = (s) => Array.from(String(s == null ? '' : s)).length

/** 假 res：与 host/respond.ts 的用法（writeHead/end/on）一致 */
function mkRes() {
  const out = { code: 0, headers: null, body: '', closed: false }
  out.writeHead = (code, headers) => { out.code = code; out.headers = headers || null }
  out.setHeader = () => { }
  out.on = () => { }
  out.end = (body) => { out.closed = true; out.body = body ? String(body) : '' }
  out.json = () => { try { return JSON.parse(out.body) } catch { return null } }
  return out
}

/** 假 req：body 可以是对象（序列化）或原始字符串；headers 可覆盖（测 413 时用 content-length） */
function mkReq(body, method = 'GET', url = '/api/chubby-whale/reminders', over = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body == null ? {} : body)
  const buf = Buffer.from(text, 'utf8')
  return Object.assign({
    method,
    url,
    headers: {},
    destroy() { },
    on() { },
    resume() { },
    async *[Symbol.asyncIterator]() { yield buf },
  }, over)
}

async function call(handler, req) {
  const res = mkRes()
  await handler(req, res)
  return { code: res.code, json: res.json(), body: res.body, res }
}

/** 提醒路由工厂（注入内存假端口；added/removed 用于取证） */
async function makeReminderRoute() {
  const { createReminderHandlers } = await imp('src/host/routes/reminders.ts')
  const added = []
  const removed = []
  const handlers = createReminderHandlers({
    loadReminders: () => [{ id: 'r1', text: '喝水' }],
    addReminder: (text, at, repeat) => {
      const r = { id: 'r' + (added.length + 1), text, at, repeat }
      added.push(r)
      return r
    },
    dueReminders: () => [{ id: 'r1', text: '喝水' }],
    removeReminder: (id) => { removed.push(id) },
  })
  return { handlers, added, removed }
}
const postReminder = (handlers, body, over) => call(handlers.handleReminders, mkReq(body, 'POST', '/api/chubby-whale/reminders', over))

// ===========================================================================
// A. 提醒：超长正文按「字」截断
// ===========================================================================
console.log('\n[A] 提醒 · 超长正文按码点截断（不切坏 emoji）')
{
  const { handlers, added } = await makeReminderRoute()
  const at = new Date(Date.now() + 3600000).toISOString()

  await postReminder(handlers, { text: 'x'.repeat(500), at })
  ok('500 个 ASCII → 恰好 200 字（既有上限不变）', added[0].text.length === 200, 'len=' + added[0].text.length)

  await postReminder(handlers, { text: 'x'.repeat(199) + '😀' + '尾巴', at })
  const t = added[1].text
  ok('199 字 + emoji：不切出孤立代理项', !LONE_SURROGATE.test(t), JSON.stringify(t.slice(-6)))
  ok('按码点截断：200 字且完整保留那个 emoji', cpLen(t) === 200 && t.endsWith('😀'), '码点=' + cpLen(t))

  await postReminder(handlers, { text: '😀'.repeat(300), at })
  const e = added[2].text
  ok('300 个 emoji → 200 码点（不按 UTF-16 长度切）', cpLen(e) === 200 && !LONE_SURROGATE.test(e), 'utf16=' + e.length)

  // 检测器自检（负向）：确保上面的断言不是空转
  ok('检测器自检：孤立高代理项能被识别', LONE_SURROGATE.test('\uD83D'))
  ok('检测器自检：完整 emoji 不误报', !LONE_SURROGATE.test('😀'))
}

// ===========================================================================
// B. 提醒：at 规范化（冻结绝对时刻 + 长度上限）
// ===========================================================================
console.log('\n[B] 提醒 · at 落库规范化（时区冻结 / 40 字上限）')
{
  const { handlers, added } = await makeReminderRoute()

  const offset = '2026-11-04T09:00:00+08:00'
  await postReminder(handlers, { text: '带偏移', at: offset })
  ok('at 带 +08:00 → 存标准 UTC ISO（同一绝对时刻）',
    added[0].at === new Date(offset).toISOString(), String(added[0].at))

  // Date.toString() 形如 "Wed Nov 04 2026 09:00:00 GMT+0800 (中国标准时间)"：
  // 能被 new Date 解析、但本身**不带机器可读时区**，换了宿主时区/机器再解析就不是同一时刻。
  const localText = new Date(2026, 10, 4, 9, 0, 0).toString()
  await postReminder(handlers, { text: '本地时区文案', at: localText })
  ok('at 本地文案 → 存标准 ISO（再读不随宿主时区漂移）',
    added[1].at === new Date(localText).toISOString(), String(added[1].at))
  ok('at 落库长度 ≤ 40（与 BACKUP_LIMITS.reminderStampLen 同口径）',
    String(added[1].at).length <= 40, 'len=' + String(added[1].at).length + ' raw=' + localText.length)

  ok('at 非法 → 400 且不入库',
    (await postReminder(handlers, { text: '坏时间', at: '不是时间' })).code === 400 && added.length === 2)
  ok('at 非字符串（数字时间戳）→ 400', (await postReminder(handlers, { text: '数字时间', at: Date.now() })).code === 400)
  ok('text 非字符串 → 400', (await postReminder(handlers, { text: 123, at: new Date().toISOString() })).code === 400)
}

// ===========================================================================
// C. 提醒：repeat 边界
// ===========================================================================
console.log('\n[C] 提醒 · repeat 边界（60 秒 ~ 7 天，其余按一次性）')
{
  const { handlers, added } = await makeReminderRoute()
  const at = new Date(Date.now() + 3600000).toISOString()
  const cases = [
    [60, 60], [604800, 604800], [59, 0], [604801, 0], ['abc', 0], [null, 0],
    [-60, 0], [90.4, 90], [90.6, 91], ['3600', 3600],
  ]
  for (const [input, want] of cases) {
    await postReminder(handlers, { text: 'r', at, repeat: input })
    const got = added[added.length - 1].repeat
    ok('repeat ' + JSON.stringify(input) + ' → ' + want, got === want, 'got=' + got)
  }
  // JSON.stringify 会把 Infinity 变成 null，这里用原始 JSON 文本送 1e309（JSON.parse 得到 Infinity）
  await postReminder(handlers, '{"text":"r","at":"' + at + '","repeat":1e309}')
  ok('repeat Infinity（1e309）→ 0（不落成 Infinity）', added[added.length - 1].repeat === 0, 'got=' + added[added.length - 1].repeat)
}

// ===========================================================================
// D. 提醒：方法与回包形状
// ===========================================================================
console.log('\n[D] 提醒 · 方法与回包形状（与简报一致）')
{
  const { handlers, removed } = await makeReminderRoute()

  let r = await call(handlers.handleReminders, mkReq(null, 'GET'))
  ok('GET 清单 → {ok:true, reminders:[…]}（无 due 字段）',
    r.json.ok === true && Array.isArray(r.json.reminders) && r.json.reminders.length === 1 && !('due' in r.json))

  r = await call(handlers.handleReminders, mkReq(null, 'GET', '/api/chubby-whale/reminders?action=due'))
  ok('GET action=due → {ok:true, due:[…]}（无 reminders 字段）',
    r.json.ok === true && Array.isArray(r.json.due) && r.json.due.length === 1 && !('reminders' in r.json))

  r = await call(handlers.handleReminders, mkReq(null, 'PUT'))
  ok('PUT → 405 + METHOD_NOT_ALLOWED（与简报同码）',
    r.code === 405 && r.json.ok === false && r.json.error === 'METHOD_NOT_ALLOWED', JSON.stringify(r.json))

  r = await postReminder(handlers, {})
  ok('POST 空 body → 400 业务失败（不 500）',
    r.code === 400 && r.json.ok === false && typeof r.json.error === 'string', JSON.stringify(r.json))

  r = await call(handlers.handleReminders, mkReq(null, 'DELETE', '/api/chubby-whale/reminders?id=r1'))
  ok('DELETE 带 id → 交给端口删除', r.code === 200 && r.json.ok === true && removed[0] === 'r1')

  r = await call(handlers.handleReminders, mkReq(null, 'DELETE'))
  ok('DELETE 不带 id → ok:true 且不误删（既有契约）', r.json.ok === true && removed.length === 1)

  // 413：声明 40KB，readBody 在读之前就拒，不把大包收进内存
  const realError = console.error
  const logs = []
  console.error = (...a) => logs.push(a.join(' '))
  r = await postReminder(handlers, '{}', { headers: { 'content-length': '40000' } })
  console.error = realError
  ok('请求体 > 32KB → 413 + too large（不读进内存）',
    r.code === 413 && r.json.ok === false && r.json.error === 'too large', JSON.stringify(r.json))
  ok('超限请求留一条 BODY-TOO-LARGE 日志（可诊断）', logs.some((l) => l.includes('BODY-TOO-LARGE')))
}

// ===========================================================================
// E. 提醒 × 真实仓储联调（临时目录）
// ===========================================================================
console.log('\n[E] 提醒 × 真实仓储联调（到点/重复/删除，临时目录）')
{
  const { createReminderRepo } = await imp('src/host/repos/reminders.ts')
  const dir = mkdtempSync(join(tmpdir(), 'chubby-b100-rem-'))
  try {
    const repo = createReminderRepo(dir)

    // E1 过去时间：下一次轮询立刻到期，且只响一次
    repo.addReminder('过去的提醒', new Date(Date.now() - 60000).toISOString())
    const due1 = repo.dueReminders()
    ok('过去时间 → 下一次轮询立刻到期（一次）', due1.length === 1 && due1[0].text === '过去的提醒')
    ok('同一轮之后不再重复到期（fired/done 落盘）', repo.dueReminders().length === 0)
    ok('一次性提醒触发后 done:true 且持久化', repo.loadReminders()[0].done === true)

    // E2 重复提醒：逾期 5 分钟也不连响，nextAt 严格晚于现在
    const item = repo.addReminder('重复提醒', new Date(Date.now() - 300000).toISOString(), 60)
    const dueRep = repo.dueReminders()
    ok('repeat=60 逾期 5 分钟：只到期一次', dueRep.length === 1 && dueRep[0].id === item.id)
    const persisted = repo.loadReminders().find((x) => x.id === item.id)
    const next = new Date(persisted && persisted.nextAt).getTime()
    ok('下一次时间严格晚于现在（不会连响）', Number.isFinite(next) && next > Date.now(), new Date(next).toISOString())
    ok('重复提醒不标 done、fired 已复位', persisted.done === false && persisted.fired === false)
    ok('同一轮之后不重复到期', repo.dueReminders().length === 0)

    // E3 删除后不触发
    const toDelete = repo.addReminder('待删', new Date(Date.now() - 60000).toISOString())
    repo.removeReminder(toDelete.id)
    ok('删除后不再触发、清单里也没有',
      repo.dueReminders().length === 0 && !repo.loadReminders().some((x) => x.id === toDelete.id))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  // E4 路由 → 仓储 → 到点列表（独立临时目录，避免前一组残留干扰计数）
  const dir2 = mkdtempSync(join(tmpdir(), 'chubby-b100-rem2-'))
  try {
    const repo = createReminderRepo(dir2)
    const { createReminderHandlers } = await imp('src/host/routes/reminders.ts')
    const h = createReminderHandlers({
      loadReminders: repo.loadReminders,
      addReminder: repo.addReminder,
      dueReminders: repo.dueReminders,
      removeReminder: repo.removeReminder,
    })
    const at = new Date(Date.now() - 1000).toISOString()
    const r = await call(h.handleReminders, mkReq({ text: '路由落库', at }, 'POST'))
    ok('路由 POST → 仓储落库并回 {ok:true,reminder}', r.json.ok === true && r.json.reminder && r.json.reminder.text === '路由落库')

    const dueA = await call(h.handleReminders, mkReq(null, 'GET', '/api/chubby-whale/reminders?action=due'))
    ok('紧接着的 action=due 只回一次该条', dueA.json.due.length === 1 && dueA.json.due[0].text === '路由落库')
    const dueB = await call(h.handleReminders, mkReq(null, 'GET', '/api/chubby-whale/reminders?action=due'))
    ok('再次轮询不再触发（无重复播报）', dueB.json.due.length === 0)

    const list = await call(h.handleReminders, mkReq(null, 'GET'))
    ok('GET 清单与仓储一致（已触发的一次性提醒仍在，done:true）',
      list.json.reminders.length === 1 && list.json.reminders[0].done === true)
    ok('清单里 at 是标准 ISO（可被客户端直接格式化）',
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(list.json.reminders[0].at), String(list.json.reminders[0].at))
  } finally {
    rmSync(dir2, { recursive: true, force: true })
  }
}

// ===========================================================================
// F. 简报：可注入时钟（跨天 / 跨年 / 坏时钟）
// ===========================================================================
console.log('\n[F] 简报 · 可注入时钟（跨天/跨年/坏时钟）')
{
  const { createBriefingHandlers } = await imp('src/host/routes/briefing.ts')
  const realFetch = globalThis.fetch
  let fetched = 0
  globalThis.fetch = async () => {
    fetched++
    return { ok: true, status: 200, text: async () => '晴 +18°C' }
  }
  const mk = (now) => createBriefingHandlers({
    loadGrowth: () => ({ exp: 200 }),
    loadReminders: () => [],
    now,
  })
  const BRIEF = '/api/chubby-whale/briefing'
  const firstLine = async (when) => {
    const r = await call(mk(() => new Date(when)).handleBriefing, mkReq(null, 'GET', BRIEF))
    return String(r.json.text || '').split('\n')[0]
  }
  const cases = [
    [new Date(2026, 11, 31, 23, 30), '2026年12月31日 星期四'],
    [new Date(2027, 0, 1, 0, 10), '2027年1月1日 星期五'],
    [new Date(2026, 10, 7, 23, 59, 59), '2026年11月7日 星期六'],
    [new Date(2026, 10, 8, 0, 0, 1), '2026年11月8日 星期日'],
  ]
  for (const [when, want] of cases) {
    const got = await firstLine(when)
    ok('注入时钟 ' + when.getFullYear() + '-' + (when.getMonth() + 1) + '-' + when.getDate() + ' → ' + want,
      got === want, got)
  }

  const badClock = await call(mk(() => new Date('bad')).handleBriefing, mkReq(null, 'GET', BRIEF))
  ok('注入非法 Date → 回落真实时钟，仍 ok 且有日期行',
    badClock.json.ok === true && /年\d+月\d+日 星期[日一二三四五六]/.test(String(badClock.json.text).split('\n')[0]))

  const boomClock = await call(mk(() => { throw new Error('clock down') }).handleBriefing, mkReq(null, 'GET', BRIEF))
  ok('时钟抛错 → 简报不陪葬（日期/天气照出）',
    boomClock.json.ok === true && /星期[日一二三四五六]/.test(String(boomClock.json.text)))

  ok('跨天前后日期行不同（不会一直停在同一天）',
    (await firstLine(new Date(2026, 10, 7, 23, 0, 0))) !==
    (await firstLine(new Date(2026, 10, 8, 1, 0, 0))))
  globalThis.fetch = realFetch
}

// ===========================================================================
// G. 简报：天气段清洗
// ===========================================================================
console.log('\n[G] 简报 · 天气段清洗（单行 / 无关键词 / 截断 / 控制字符）')
{
  const { createBriefingHandlers } = await imp('src/host/routes/briefing.ts')
  const realFetch = globalThis.fetch
  let body = '晴 +18°C'
  let mode = 'ok'
  globalThis.fetch = async () => {
    if (mode === 'throw') throw new Error('weather down')
    return { ok: mode !== 'fail', status: mode === 'fail' ? 500 : 200, text: async () => body }
  }
  const BRIEF = '/api/chubby-whale/briefing'
  const h = createBriefingHandlers({ loadGrowth: () => ({ exp: 200 }), loadReminders: () => [] })
  const text = async () => String((await call(h.handleBriefing, mkReq(null, 'GET', BRIEF))).json.text || '')
  const weatherLine = (t) => t.split('\n').find((l) => l.startsWith('北海天气：')) || ''

  ok('正常天气：单行原样保留（既有文案不变）', (await text()).includes('北海天气：晴 +18°C'))

  body = '晴 +18°C\n提醒你带伞'
  const t2 = await text()
  const fakeSeg = (t) => t.split('\n').filter((l) => /提醒|待办/.test(l) && !l.startsWith('待办提醒：'))
  ok('多行天气压成一行（不凭空造出「待办」段）',
    fakeSeg(t2).length === 0, JSON.stringify(t2.split('\n')))

  body = '晴 提醒带伞 待办多多 +18°C'
  const t3 = await text()
  ok('天气里出现「提醒/待办」字样 → 从天气段剥掉（保护客户端按行切两段）',
    fakeSeg(t3).length === 0, JSON.stringify(t3.split('\n')))

  body = 'x'.repeat(5000)
  const t4 = await text()
  const w4 = weatherLine(t4).replace('北海天气：', '')
  ok('超长天气 → 截到 40 字以内（不让错误页撑爆气泡/朗读）', cpLen(w4) <= 40 && cpLen(w4) > 0, '码点=' + cpLen(w4))
  ok('整份简报文本保持短小（< 400 字）', cpLen(t4) < 400, '码点=' + cpLen(t4))

  body = '\u0000\t\r\n  晴\t+18°C\u0007  '
  const t5 = await text()
  ok('控制字符/多余空白 → 单行清洗后与正常天气一致',
    weatherLine(t5) === '北海天气：晴 +18°C', JSON.stringify(t5.split('\n')))

  mode = 'fail'
  body = 'skip'
  const t6 = await text()
  ok('天气 HTTP 失败 → 不出天气段（不陪葬）', !t6.includes('北海天气') && t6.includes('星期'))
  mode = 'throw'
  const t7 = await text()
  ok('天气抛错 → 不出天气段（不陪葬）', !t7.includes('北海天气') && t7.includes('星期'))

  globalThis.fetch = realFetch
}

// ===========================================================================
// H. 简报：首次运行无数据 / 坏数据
// ===========================================================================
console.log('\n[H] 简报 · 首次运行无数据 / 坏读取器 / 经验口径')
{
  const { createBriefingHandlers } = await imp('src/host/routes/briefing.ts')
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '晴 +18°C' })
  const BRIEF = '/api/chubby-whale/briefing'
  const NOW = () => new Date(2026, 10, 7, 9, 0, 0)

  const r1 = await call(createBriefingHandlers({
    loadGrowth: () => { throw new Error('no growth file') },
    loadReminders: () => { throw new Error('no reminders file') },
    now: NOW,
  }).handleBriefing, mkReq(null, 'GET', BRIEF))
  const t1 = String(r1.json.text)
  ok('首次运行（两个读取器都抛错）→ ok:true，仍有日期 + 天气',
    r1.json.ok === true && t1.includes('2026年11月7日 星期六') && t1.includes('北海天气'))
  ok('读不到成长/提醒 → 不编「0 条」也不编阶段',
    !t1.includes('待办提醒') && !t1.includes('肥鲸成长'), JSON.stringify(t1.split('\n')))

  const r2 = await call(createBriefingHandlers({ loadGrowth: () => ({ exp: '200abc' }), loadReminders: () => null, now: NOW }).handleBriefing,
    mkReq(null, 'GET', BRIEF))
  ok('坏经验值（200abc）→ 归 0（与 /growth 同口径）', String(r2.json.text).includes('肥鲸成长：初识（0）'))

  const r3 = await call(createBriefingHandlers({
    loadGrowth: () => ({ exp: 1.9 }),
    loadReminders: () => [null, { done: false }, { done: true }],
    now: NOW,
  }).handleBriefing, mkReq(null, 'GET', BRIEF))
  ok('经验 1.9 → 取整 1；坏项丢弃、只数未完成',
    String(r3.json.text).includes('肥鲸成长：初识（1）') && String(r3.json.text).includes('待办提醒：1 条'))

  const r4 = await call(createBriefingHandlers({ loadGrowth: () => ({ exp: Infinity }), loadReminders: () => [], now: NOW }).handleBriefing,
    mkReq(null, 'GET', BRIEF))
  ok('经验 Infinity → 0（不把 Infinity 写进简报）',
    String(r4.json.text).includes('肥鲸成长：初识（0）') && !String(r4.json.text).includes('Infinity'))

  // 非 GET/HEAD：405 且不外呼天气
  let fetchCount = 0
  globalThis.fetch = async () => { fetchCount++; return { ok: true, status: 200, text: async () => '晴' } }
  const r5 = await call(createBriefingHandlers({ loadGrowth: () => ({}), loadReminders: () => [], now: NOW }).handleBriefing,
    mkReq(null, 'POST', BRIEF))
  ok('POST → 405 + METHOD_NOT_ALLOWED 且不外呼天气',
    r5.code === 405 && r5.json.error === 'METHOD_NOT_ALLOWED' && fetchCount === 0, JSON.stringify(r5.json))
  globalThis.fetch = realFetch
}

// ===========================================================================
// I. 封装治理静态检查
// ===========================================================================
console.log('\n[I] 封装治理静态检查（只经注入端口 / 请求体与外部调用设上限）')
{
  const forbidden = ['node:fs', 'node:child_process', '../repos/', '../store.js', '../cache.js', '../data/', '../prefs.js']
  for (const f of ['src/host/routes/briefing.ts', 'src/host/routes/reminders.ts']) {
    const src = readSrc(f)
    const hits = forbidden.filter((s) => src.includes("from '" + s))
    ok(f + ' 不直连存储 / 文件实现（与 check-boundaries B6 同口径）', hits.length === 0, hits.join(','))
  }
  const b = readSrc('src/host/routes/briefing.ts')
  ok('简报外呼带超时（AbortSignal.timeout）', b.includes('AbortSignal.timeout'))
  ok('简报时钟可注入（now 端口，缺省本地时钟，坏值回落）',
    b.includes('now?: () => Date') && b.includes('safeNow'))
  ok('简报天气段经 cleanWeather 清洗后才拼进 text', b.includes('cleanWeather(await w.text())'))
  ok('简报时钟/天气外呼都收敛在 handler 内，不向 store 伸手', !b.includes('store'))
  const rm = readSrc('src/host/routes/reminders.ts')
  ok('提醒请求体走 readJsonBody + 显式上限（不裸读 req）',
    rm.includes('readJsonBody') && rm.includes('REMINDER_MAX_BODY'))
  ok('提醒的 text 截断按码点（Array.from，不切代理对）', rm.includes('Array.from(text)'))
  ok('提醒的 at 落库前转 UTC ISO（不原样存外部时间串）',
    rm.includes('canonicalAt') && rm.includes('toISOString'))
  ok('提醒的非 GET/POST/DELETE → 405 + METHOD_NOT_ALLOWED',
    rm.includes("error: 'METHOD_NOT_ALLOWED' }, 405"))
}

// ===========================================================================

// ===========================================================================
// [J] 提醒仓储三修（B101）：写盘失败不刷屏 / 坏文件不误清空 / 数量上限
console.log('\n[J] 提醒仓储三修（写盘失败/坏文件/上限）')
try {
  const os = await import('node:os')
  const nodePath = await import('node:path')
  const { createReminderRepo } = await imp('src/host/repos/reminders.ts')

  // J1 写盘失败：同一条提醒不应每 20s 反复返回
  {
    const dir = mkdtempSync(nodePath.join(os.tmpdir(), 'rem-fail-'))
    try {
      const repo = createReminderRepo(dir)
      const r = repo.addReminder('喝水', new Date(Date.now() - 1000).toISOString())
      ok('J1 提醒已创建', !!r && typeof r.id === 'string')
      // 用 chmod 444 模拟「读得到、写不进」（磁盘满/只读目录的等价形状）
      const f = nodePath.join(dir, 'reminders.json')
      const raw = readFileSync(f, 'utf8')
      chmodSync(f, 0o444)
      const first = repo.dueReminders()
      ok('J1 写盘失败仍返回本次到点（用户不能漏提醒）', first.length === 1, 'n=' + first.length)
      const second = repo.dueReminders()
      ok('J1 写盘失败后不再重复返回同一条（本进程内存兜底）', second.length === 0, 'n=' + second.length)
      const third = repo.dueReminders()
      ok('J1 继续调用也不刷屏', third.length === 0, 'n=' + third.length)
      // 恢复可写后：内存标记被清空（写盘成功后磁盘为准）
      chmodSync(f, 0o666)
      writeFileSync(f, raw, 'utf8')
      repo.saveReminders([])
      ok('J1 恢复写盘后内存标记被清空（不残留）', repo.dueReminders().length === 0 && repo.loadReminders().length === 0)
    } finally {
      try { rmSync(dir, { recursive: true, force: true }) } catch { }
    }
  }

  // J2 坏文件：删除/新增都不能把整份列表覆盖成空表
  {
    const dir = mkdtempSync(nodePath.join(os.tmpdir(), 'rem-bad-'))
    try {
      const repo = createReminderRepo(dir)
      const f = nodePath.join(dir, 'reminders.json')
      writeFileSync(f, '[{"id":"a"', 'utf8')   // 坏 JSON
      const before = readFileSync(f, 'utf8')
      repo.removeReminder('a')
      const bad = readdirSync(dir).filter((n) => n.indexOf('.bad-') >= 0)
      ok('J2 坏文件已隔离备份（.bad-* 出现）', bad.length === 1, JSON.stringify(readdirSync(dir)))
      ok('J2 备份内容与原文逐字一致', bad.length === 1 && readFileSync(nodePath.join(dir, bad[0]), 'utf8') === before)
      ok('J2 删除没有把列表写成空表（reminders.json 不存在或被保留原样）', !existsSync(f) || readFileSync(f, 'utf8') === before)
      const added = repo.addReminder('别覆盖我', new Date().toISOString())
      ok('J2 坏文件时新增被拒绝（返回 null）', added === null)
      ok('J2 新增没有写出空表/单条表', !existsSync(f) || readFileSync(f, 'utf8') === before)
      // 再次读取：按空表降级（坏文件已隔离）
      const fresh = createReminderRepo(dir)
      ok('J2 坏文件时读取按空表降级（不抛）', Array.isArray(fresh.loadReminders()) && fresh.loadReminders().length === 0)
    } finally {
      try { rmSync(dir, { recursive: true, force: true }) } catch { }
    }
  }

  // J3 数量上限：第 201 条被拒绝，前 200 条保留
  {
    const dir = mkdtempSync(nodePath.join(os.tmpdir(), 'rem-max-'))
    try {
      const repo = createReminderRepo(dir)
      const at = new Date(Date.now() + 3600_000).toISOString()
      let last = null
      for (let i = 0; i < 200; i++) last = repo.addReminder('第' + i + '条', at)
      ok('J3 前 200 条都能加', !!last && repo.loadReminders().length === 200)
      ok('J3 第 201 条被拒绝（返回 null）', repo.addReminder('溢出', at) === null)
      ok('J3 上限没有被写坏（仍 200 条）', repo.loadReminders().length === 200)
    } finally {
      try { rmSync(dir, { recursive: true, force: true }) } catch { }
    }
  }
  // J4 仓储拒绝写入（文件损坏/超上限）→ 路由必须回 507，不能回 ok:true + reminder:null
  {
    const { createReminderHandlers } = await imp('src/host/routes/reminders.ts')
    const deps = {
      listReminders: () => [],
      dueReminders: () => [],
      addReminder: () => null,          // 仓储拒绝
      removeReminder: () => { },
    }
    const h = createReminderHandlers(deps)
    const body = Buffer.from(JSON.stringify({ text: '测试提醒', at: new Date(Date.now() + 60000).toISOString() }))
    const req = {
      method: 'POST',
      url: '/api/chubby-whale/reminders',
      headers: { 'content-length': String(body.length) },
      destroy() { }, on() { }, resume() { },
      async *[Symbol.asyncIterator]() { yield body },
    }
    const res = { code: 0, chunks: [] }
    res.writeHead = (c) => { res.code = c }
    res.setHeader = () => { }
    res.write = (c) => { res.chunks.push(Buffer.from(String(c))); return true }
    res.end = (c) => { if (c !== undefined) res.chunks.push(Buffer.from(String(c))) }
    res.on = () => { }
    await h.handleReminders(req, res)
    const payload = JSON.parse(Buffer.concat(res.chunks).toString('utf8') || '{}')
    ok('J4 仓储拒绝写入时路由回 507', res.code === 507, 'code=' + res.code)
    ok('J4 且不带成功语义（ok:false + reminder 缺失）', payload.ok === false && !payload.reminder, JSON.stringify(payload))
  }

} catch (e) {
  ok('J 段执行', false, String(e && e.message))
}


// 简报待办段：条数 + 最近 3 条的任务正文（2026-11-07 主人反馈「简报里也没有这条」）
console.log('\n[K] 简报待办段带任务正文')
{
  const { createBriefingHandlers } = await imp('src/host/routes/briefing.ts')
  const nowMs = new Date(2026, 10, 7, 10, 0, 0).getTime()
  const mk = (reminders) => createBriefingHandlers({
    loadGrowth: () => ({ exp: 3 }),
    loadReminders: () => reminders,
    now: () => new Date(nowMs),
  })
  const run = async (h) => {
    const res = { code: 0, chunks: [] }
    res.writeHead = (c) => { res.code = c }
    res.setHeader = () => { }
    res.write = (c) => { res.chunks.push(Buffer.from(String(c))); return true }
    res.end = (c) => { if (c !== undefined) res.chunks.push(Buffer.from(String(c))) }
    res.on = () => { }
    await h.handleBriefing({ method: 'GET', url: '/api/chubby-whale/briefing', headers: {}, on() { }, async *[Symbol.asyncIterator]() { } }, res)
    return JSON.parse(Buffer.concat(res.chunks).toString('utf8') || '{}')
  }

  const two = [
    { id: 'a', text: '吃早餐', at: new Date(nowMs + 10 * 60_000).toISOString(), done: false },
    { id: 'b', text: '明天开会', at: new Date(nowMs + 20 * 3600_000).toISOString(), done: false },
    { id: 'c', text: '已完成', at: new Date(nowMs + 5 * 60_000).toISOString(), done: true },
  ]
  const d1 = await run(mk(two))
  ok('K1 待办条数不计已完成', /待办提醒：2 条/.test(d1.text), String(d1.text).split('\n').join(' | '))
  ok('K2 正文按到点时间列出最近一条（今天 10:10 吃早餐）', /待办：今天10:10 吃早餐/.test(d1.text), String(d1.text))
  ok('K3 明天的提醒标「明天」而不是今天的时刻', /明天06:00 明天开会/.test(d1.text), String(d1.text))
  ok('K4 已完成的提醒不出现在正文里', !/已完成/.test(d1.text))

  const none = await run(mk([]))
  ok('K5 没有提醒时只有 0 条、没有「待办：」行', /待办提醒：0 条/.test(none.text) && !/待办：/.test(none.text), String(none.text))

  const bad = await run(mk([{ id: 'x', text: '   ', at: 'bad', done: false }]))
  ok('K6 空正文/坏时间的条目不进正文（不编造）', !/待办：/.test(bad.text), String(bad.text))
}

console.log('\n────────────────────')
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项')
if (fail > 0) {
  console.error('❌ 存在失败项')
  process.exit(1)
}
console.log('✅ 简报/提醒专项全绿')
