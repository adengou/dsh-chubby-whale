/**
 * scripts/test-remind-nl.mjs —— 「说一句就建提醒」专项（B106）
 *
 * 背景（用户实测）：对鱼说「十分钟后提醒我吃早餐」，鱼答应了，
 * 但 ~/.dsh-chubby-whale/reminders.json 根本不存在 —— 没有任何排程。
 *
 * 覆盖：
 *   A. 解析器 parseReminderIntent：相对/绝对/重复/半小时/一个半小时；转述不建；没时间不建；任务为空不建
 *   B. maybeCreateReminder：端口缺省不建、命中即建、60 秒内同一条去重、去重表有上限
 *   C. 路由接线（源码形状）：/chat 与 /chat-stream 都必须调用 maybeCreateReminder（漏接线 → 白做）
 *   D. 与仓储联动：建出来后 loadReminders 能读到、dueReminders 到点能返回
 *
 * 纯离线：不联网、不起 HTTP、只写系统临时目录。
 */
import { register } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

register(new URL('./ts-resolve.mjs', import.meta.url))

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href)

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; failures.push(name + (detail ? '  ' + detail : '')); console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

const { parseReminderIntent } = await imp('src/shared/remind-nl.ts')
const { maybeCreateReminder } = await imp('src/host/chat-core.ts')

// 固定基准时间：2026-11-07 10:53:00 本地（周六）
const NOW = new Date(2026, 10, 7, 10, 53, 0).getTime()
const localize = (iso) => new Date(iso).toLocaleString('zh-CN')

console.log('\n[A] 解析器：说得出的时间都要认')
{
  const r1 = parseReminderIntent('十分钟后提醒我吃早餐。', NOW)
  ok('A1 十分钟后 → 任务=吃早餐、时刻=+10 分钟',
    !!r1 && r1.task === '吃早餐' && new Date(r1.at).getTime() === NOW + 10 * 60_000 && r1.repeat === 0,
    r1 ? r1.task + ' @ ' + localize(r1.at) : 'null')

  const r2 = parseReminderIntent('半小时后提醒我喝水', NOW)
  ok('A2 半小时后 = +30 分钟', !!r2 && new Date(r2.at).getTime() === NOW + 30 * 60_000, r2 && localize(r2.at))

  const r3 = parseReminderIntent('一个半小时后提醒我收衣服', NOW)
  ok('A3 一个半小时后 = +90 分钟，且正文不留「一个」',
    !!r3 && new Date(r3.at).getTime() === NOW + 90 * 60_000 && r3.task === '收衣服', r3 && r3.task + ' @ ' + localize(r3.at))

  const r4 = parseReminderIntent('明天早上7点提醒我吃药', NOW)
  ok('A4 明天早上7点 → 次日 07:00',
    !!r4 && r4.at === '2026-11-07T23:00:00.000Z' && r4.task === '吃药', r4 && r4.at)

  const r5 = parseReminderIntent('今晚9点提醒我关灯', NOW)
  ok('A5 今晚9点 → 当日 21:00', !!r5 && r5.at === '2026-11-07T13:00:00.000Z', r5 && r5.at)

  const r6 = parseReminderIntent('每天9点提醒我喝水', NOW)
  ok('A6 「每天」→ repeat=86400 且首响在将来',
    !!r6 && r6.repeat === 86400 && new Date(r6.at).getTime() > NOW, r6 && r6.at + ' repeat=' + r6.repeat)

  const r7 = parseReminderIntent('20秒后提醒我看锅', NOW)
  ok('A7 秒级：20秒后 = +20 秒', !!r7 && new Date(r7.at).getTime() === NOW + 20_000, r7 && r7.at)
}

console.log('\n[A2] 不该建的一定不建')
{
  ok('A8 转述「他提醒我…」不建', parseReminderIntent('他提醒我十分钟后开会', NOW) === null)
  ok('A9 没有时间不建', parseReminderIntent('提醒我一下', NOW) === null)
  ok('A10 普通聊天不建', parseReminderIntent('你好呀，今天好冷', NOW) === null)
  ok('A11 空/非字符串不建', parseReminderIntent('', NOW) === null && parseReminderIntent(null, NOW) === null)
  ok('A12 「注意」不是提醒祈使', parseReminderIntent('注意十分钟后要下雨', NOW) === null)
}

console.log('\n[B] maybeCreateReminder：落库 + 去重')
{
  ok('B1 端口缺省（老调用方）→ 不建', maybeCreateReminder(undefined, '十分钟后提醒我吃早餐', NOW) === null)

  const calls = []
  const port = (text, at, repeat) => { calls.push({ text, at, repeat }); return { id: 'r1', text, at, repeat } }
  const made = maybeCreateReminder(port, '十分钟后提醒我吃早餐', NOW + 1000)
  ok('B2 命中即建（端口收到任务与时刻）',
    !!made && calls.length === 1 && calls[0].text === '吃早餐' && calls[0].at === new Date(NOW + 1000 + 10 * 60_000).toISOString(),
    JSON.stringify(calls[0]))

  const again = maybeCreateReminder(port, '十分钟后提醒我吃早餐', NOW + 2000)
  ok('B3 同一条消息 60 秒内重发 → 去重（不重复建）', again === null && calls.length === 1, 'calls=' + calls.length)

  const later = maybeCreateReminder(port, '十分钟后提醒我吃早餐', NOW + 10 * 60_000)
  ok('B4 过了 60 秒窗口仍按新时刻建（不复用旧键）', !!later && calls.length === 2, 'calls=' + calls.length)

  const other = maybeCreateReminder(port, '半小时后提醒我喝水', NOW + 3000)
  ok('B5 不同任务照常建', !!other && calls.length === 3, 'calls=' + calls.length)

  const before = calls.length
  maybeCreateReminder(port, '你好呀', NOW + 4000)
  ok('B6 非提醒语句不建', calls.length === before)
}

console.log('\n[C] 路由接线（源码形状：漏接线 = 白做）')
{
  for (const rel of ['src/host/routes/chat.ts', 'src/host/routes/chat-stream.ts']) {
    const src = readFileSync(join(ROOT, rel), 'utf8')
    ok('C ' + rel.split('/').pop() + ' 调用了 maybeCreateReminder', /maybeCreateReminder\(opts\.addReminder/.test(src))
    ok('C ' + rel.split('/').pop() + ' 失败时不陪葬整条聊天（有 catch）', /REMINDER-CREATE-FAIL/.test(src))
  }
  const idx = readFileSync(join(ROOT, 'src/index.ts'), 'utf8')
  // 只数「两条聊天路由」里的注入：提醒路由自己也有一处 addReminder，不能把它算进来
  const chatBlock = idx.slice(idx.indexOf('const chat = createChatHandler({'), idx.indexOf('const chatStream = createChatStreamHandler({'))
  const streamBlock = idx.slice(idx.indexOf('const chatStream = createChatStreamHandler({'), idx.indexOf('const reminders = createReminderHandlers({'))
  ok('C /chat 装配注入 addReminder', /addReminder: store\.addReminder/.test(chatBlock))
  ok('C /chat-stream 装配注入 addReminder', /addReminder: store\.addReminder/.test(streamBlock))
}

console.log('\n[D] 与真实仓储联动：建出来就能被清单/到点看到')
{
  const { createReminderRepo } = await imp('src/host/repos/reminders.ts')
  const dir = mkdtempSync(join(tmpdir(), 'remind-nl-'))
  try {
    const repo = createReminderRepo(dir)
    const created = maybeCreateReminder(
      (text, at, repeat) => repo.addReminder(text, at, repeat),
      '十分钟后提醒我吃早餐',
      Date.now(),
    )
    ok('D1 建成功', !!created && typeof created.id === 'string')
    const listed = repo.loadReminders()
    ok('D2 提醒清单能读到这条', listed.length === 1 && listed[0].text === '吃早餐', JSON.stringify(listed.map((x) => x.text)))
    ok('D3 到点判定：还没到点时不返回', repo.dueReminders().length === 0)
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { }
  }
}


console.log('\n[E] 走一遍真实 /chat handler（不是只测函数）')
{
  const { createChatHandler } = await imp('src/host/routes/chat.ts')
  const made = []
  const handler = createChatHandler({
    getKey: () => '',                       // 没配 Key：聊天会回 NO_KEY，但提醒必须已经建好
    loadHistory: () => [],
    appendTurns: () => { },
    loadState: () => ({}),
    saveState: () => { },
    systemPrompt: 'test',
    addReminder: (text, at, repeat) => { made.push({ text, at, repeat }); return { id: 'x' } },
  })
  const body = Buffer.from(JSON.stringify({ message: '十分钟后提醒我吃药' }))
  const req = {
    method: 'POST',
    url: '/api/chubby-whale/chat',
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
  await handler(req, res)
  ok('E1 真实路由会建提醒（不是只有函数能跑）', made.length === 1 && made[0].text === '吃药', JSON.stringify(made))
  const payload = JSON.parse(Buffer.concat(res.chunks).toString('utf8') || '{}')
  ok('E2 没配 Key 时仍先把提醒建好，再回 NO_KEY', made.length === 1 && payload.error === 'NO_KEY', JSON.stringify({ made: made.length, error: payload.error }))

  // 同一条消息重发一次：去重，不重复建
  const req2 = { ...req, async *[Symbol.asyncIterator]() { yield body } }
  const res2 = { code: 0, chunks: [] }
  res2.writeHead = (c) => { res2.code = c }
  res2.setHeader = () => { }
  res2.write = (c) => { res2.chunks.push(Buffer.from(String(c))); return true }
  res2.end = (c) => { if (c !== undefined) res2.chunks.push(Buffer.from(String(c))) }
  res2.on = () => { }
  await handler(req2, res2)
  ok('E3 同一条消息重发不重复建提醒', made.length === 1, 'made=' + made.length)
}

console.log('\n────────────────────')
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项')
if (fail > 0) {
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
console.log('✅ 提醒自然语言解析专项全绿')
