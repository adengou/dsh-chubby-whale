/**
 * scripts/test-config-migrate.mjs —— B100 配置与迁移分身专项回归
 *
 * 覆盖 src/host/config.ts、prefs.ts、migrate.ts 的：
 *   · 日志安全：坏 JSON 的 V8 报错会带原文片段（Node ≥20），非对象形状会按内容回显——
 *     config.json 里放着 deepseekKey，这条读取路径可能把 Key 写进日志；
 *   · 类型错误的键：值被当默认值时要留一条告警（不回显值），不挡插件加载；
 *   · 超长 / 含控制字符的配置值不刷屏、不把日志行撕碎；
 *   · prefs 坏文件：写前先备份原文（不静默丢偏好），写入失败留痕但不抛；
 *   · 迁移：幂等、绝不覆盖用户数据、源文件保留（旧字段天然保留）、半途失败可重试；
 *   · 三者对「运行时目录不存在」的处理口径。
 *
 * 用法：node scripts/test-config-migrate.mjs
 *   （单独运行，不改 package.json / scripts/test.mjs；只读源码 + 临时目录，不联网、不碰真实运行数据）
 */

import { register } from 'node:module'
import {
  mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

register(new URL('./ts-resolve.mjs', import.meta.url))

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

const C = await import('../src/host/config.ts')
const P = await import('../src/host/prefs.ts')
const M = await import('../src/host/migrate.ts')

const dirs = []
const tmp = (tag) => {
  const d = mkdtempSync(join(tmpdir(), 'chubby-b100-' + tag + '-'))
  dirs.push(d)
  return d
}
const cleanup = () => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }) } catch { } } }

/** 捕获 console.warn / console.error / console.log（预期告警不污染输出，同时可断言其中有没有泄漏） */
function captureConsole() {
  const origWarn = console.warn
  const origError = console.error
  const origLog = console.log
  const logs = []
  const push = (kind) => (...a) => { logs.push(kind + ' ' + a.map(String).join(' ')) }
  console.warn = push('warn')
  console.error = push('error')
  console.log = push('log')
  return {
    logs,
    text: () => logs.join('\n'),
    count: (kind) => logs.filter((l) => l.startsWith(kind + ' ')).length,
    has: (sub) => logs.some((l) => l.indexOf(sub) >= 0),
    restore: () => { console.warn = origWarn; console.error = origError; console.log = origLog },
  }
}

/** 日志里是否出现任何敏感片段（模拟“Key 进了日志”） */
const leaks = (text, secrets) => secrets.some((s) => text.indexOf(s) >= 0)

/** 单行日志的最大长度（判断是否被超长配置值撕碎） */
const longestLine = (text) => text.split('\n').reduce((m, l) => Math.max(m, l.length), 0)

/** 有没有某条日志内部带换行（控制字符没折行） */
const hasNewlineInside = (logs) => logs.some((l) => l.indexOf('\n') >= 0)

/** 假响应 */
function mkRes() {
  const out = { code: 0, chunks: [] }
  out.writeHead = (c) => { out.code = c }
  out.setHeader = () => { }
  out.end = (b) => { if (b) out.chunks.push(Buffer.from(String(b))) }
  out.json = () => { try { return JSON.parse(Buffer.concat(out.chunks).toString('utf8')) } catch { return null } }
  return out
}

/** 假请求（只有 body） */
function mkReq(body) {
  const buf = Buffer.from(body == null ? '' : String(body))
  return {
    method: 'POST',
    headers: {},
    on() { },
    destroy() { },
    async *[Symbol.asyncIterator]() { if (buf.length) yield buf },
  }
}

const envKeys = [
  'CHUBBY_WHALE_DEEPSEEK_KEY', 'DEEPSEEK_API_KEY',
  'CHUBBY_WHALE_DATA_SOURCE', 'CHUBBY_WHALE_MODEL',
]
const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]))
const setEnv = (obj) => {
  for (const k of envKeys) delete process.env[k]
  for (const [k, v] of Object.entries(obj || {})) process.env[k] = v
}
const restoreEnv = () => {
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
}

/** 递归收集目录里的临时迁移残留名 */
function migratingLeftovers(root) {
  const bad = []
  const walk = (d) => {
    let names = []
    try { names = readdirSync(d) } catch { return }
    for (const name of names) {
      const p = join(d, name)
      let st = null
      try { st = statSync(p) } catch { }
      if (name.indexOf('.migrating-') >= 0) bad.push(p)
      if (st && st.isDirectory()) walk(p)
    }
  }
  walk(root)
  return bad
}

try {
  // ================= 1. 日志安全：坏 config.json 不得把文件内容/Key 写进日志 =================
  console.log('\n[1] config.json 读取失败/坏 JSON/非对象：日志不回显内容')
  {
    const dir = tmp('cfg-leak')
    const file = join(dir, 'config.json')
    setEnv({ DEEPSEEK_API_KEY: 'env-fallback-key' })

    // 1.0 目录/文件都不存在：ENOENT 是常态，必须静默（与 prefs/migrate 的“目录缺失不算错误”同口径）
    const cap0 = captureConsole()
    const k0 = C.readApiKey(join(dir, 'no-such-dir'))
    cap0.restore()
    ok('没有 config.json / 目录不存在：静默按未配置（ENOENT 不算错误，只剩环境变量兜底）',
      k0 === 'env-fallback-key' && cap0.logs.length === 0, k0 + ' / ' + cap0.text().slice(0, 120))

    // 1.1 坏 JSON：Node ≥20 的 JSON.parse 报错会带原文片段（实测 "…pseekKey":sk-live-SE"…）
    writeFileSync(file, '{"deepseekKey":sk-live-SECRET123456}', 'utf8')
    const cap1 = captureConsole()
    const k1 = C.readApiKey(dir)
    C.readApiKey(dir)
    C.readApiKey(dir)
    cap1.restore()
    ok('坏 JSON：降级到环境变量（不挡加载）', k1 === 'env-fallback-key', String(k1))
    ok('坏 JSON：日志不含 Key 原文', !leaks(cap1.text(), ['sk-live', 'SECRET123456']), cap1.text().slice(0, 160))
    ok('坏 JSON：仍提示「不是合法 JSON」且只提示一次',
      cap1.logs.filter((l) => l.indexOf('config.json 不是合法 JSON') >= 0).length === 1)

    // 1.2 非对象（数组里装着 Key）：旧实现 shortValue(parsed) 会把前 60 字符原样打出来
    writeFileSync(file, '["sk-live-SECRET123456"]', 'utf8')
    const cap2 = captureConsole()
    const k2 = C.readApiKey(dir)
    cap2.restore()
    ok('数组形状：按未配置处理', k2 === 'env-fallback-key')
    ok('数组形状：日志不含数组内容', !leaks(cap2.text(), ['sk-live', 'SECRET123456']), cap2.text().slice(0, 160))
    ok('数组形状：仍提示「应为对象」', cap2.has('config.json 应为对象'))

    // 1.3 标量形状（整个文件就是一个 Key 字符串）
    writeFileSync(file, '"sk-live-SECRET123456"', 'utf8')
    const cap3 = captureConsole()
    const k3 = C.readApiKey(dir)
    cap3.restore()
    ok('标量形状：按未配置处理', k3 === 'env-fallback-key')
    ok('标量形状：日志不含文件内容', !leaks(cap3.text(), ['sk-live', 'SECRET123456']), cap3.text().slice(0, 160))

    // 1.4 null 形状 / UTF-16LE（PowerShell 常见）坏文件：不抛、降级、提示
    writeFileSync(file, 'null', 'utf8')
    const cap4 = captureConsole()
    const k4 = C.readApiKey(dir)
    cap4.restore()
    ok('null 形状：按未配置处理且不抛', k4 === 'env-fallback-key')
    ok('null 形状：仍提示「应为对象」', cap4.has('config.json 应为对象'))

    writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"deepseekKey":"sk-live-SECRET"}', 'utf16le')]))
    const cap5 = captureConsole()
    const k5 = C.readApiKey(dir)
    cap5.restore()
    ok('UTF-16LE 文件：降级不抛', k5 === 'env-fallback-key')
    ok('UTF-16LE 文件：日志不含 Key', !leaks(cap5.text(), ['sk-live', 'SECRET']))

    // 1.5 config.json 是目录（读失败路径）：提示一次、降级、不抛
    rmSync(file, { force: true })
    mkdirSync(file)
    const cap6 = captureConsole()
    const k6 = C.readApiKey(dir)
    C.readApiKey(dir)
    cap6.restore()
    ok('config.json 是目录：降级不抛', k6 === 'env-fallback-key')
    ok('config.json 是目录：读取失败只提示一次',
      cap6.logs.filter((l) => l.indexOf('config.json 读取失败') >= 0).length === 1)

    setEnv({})
  }

  // ================= 2. 类型错误的键：告警一次、不回显值、不挡加载 =================
  console.log('\n[2] 类型错误的配置键：按未配置 + 告警（不回显值）')
  {
    const dir = tmp('cfg-type')
    const file = join(dir, 'config.json')
    setEnv({})

    // 2.1 Key 字段类型错误（旧实现：静默当未配置，用户只看到“Key 没了”）
    writeFileSync(file, '{"deepseekKey":1234567890}', 'utf8')
    const cap1 = captureConsole()
    const v1 = C.readApiKey(dir)
    C.readApiKey(dir)
    cap1.restore()
    ok('deepseekKey 是数字：按未配置处理', v1 === '')
    ok('deepseekKey 是数字：有告警且点名该字段',
      cap1.logs.filter((l) => l.indexOf('deepseekKey') >= 0).length >= 1, cap1.text().slice(0, 160))
    ok('deepseekKey 是数字：告警只发一次',
      cap1.logs.filter((l) => l.indexOf('deepseekKey') >= 0).length === 1)
    ok('deepseekKey 是数字：日志不回显数字', !leaks(cap1.text(), ['1234567890']), cap1.text().slice(0, 160))

    // 2.2 Key 字段是对象（里面藏着真 Key）：只报形状，不回显
    writeFileSync(file, '{"deepseekKey":{"v":"sk-live-NESTED"}}', 'utf8')
    const cap2 = captureConsole()
    const v2 = C.readApiKey(dir)
    cap2.restore()
    ok('deepseekKey 是对象：按未配置处理', v2 === '')
    ok('deepseekKey 是对象：告警只报形状', cap2.has('deepseekKey') && cap2.has('对象'), cap2.text().slice(0, 160))
    ok('deepseekKey 是对象：日志不含嵌套值', !leaks(cap2.text(), ['sk-live', 'NESTED']))

    // 2.3 旧配置里的 siliconflowKey 字段：2026-11-14 起不再读取，也不该出现在日志里
    writeFileSync(file, '{"siliconflowKey":true}', 'utf8')
    const cap3 = captureConsole()
    const v3 = C.readApiKey(dir)
    cap3.restore()
    ok('残留的 siliconflowKey 字段被忽略（不再读取）', v3 === '')
    ok('残留的 siliconflowKey 字段不产生日志（不打扰主人）', cap3.logs.length === 0, cap3.text().slice(0, 160))

    // 2.4 空值/空白是「没配」，不该告警（保持旧行为）
    writeFileSync(file, '{"deepseekKey":"","siliconflowKey":"   "}', 'utf8')
    const cap4 = captureConsole()
    const v4 = C.readApiKey(dir)
    cap4.restore()
    ok('Key 为空串/空白：按未配置且不告警', v4 === '' && cap4.logs.length === 0, cap4.text().slice(0, 120))

    // 2.5 其余键的类型口径（锁现状，供报告逐条列出）
    const capSan = captureConsole()
    const san = C.sanitizePluginConfig({
      enabled: 'false', dataSource: 123, personalityLearning: '0', personalityWriting: 'eh', model: 42,
    })
    const sanEnabled = C.sanitizePluginConfig({ enabled: false })
    const sanModelBad = C.sanitizePluginConfig({ model: { name: 'x' } })
    const sanUnknown = C.sanitizePluginConfig({ deepseekKey: 'sk-x', keep: 1 })
    const capUnknown = captureConsole()
    C.sanitizePluginConfig({ apiKey: 'sk-live-UNKNOWN-KEY' })
    capUnknown.restore()
    capSan.restore()
    ok('enabled 非布尔（字符串 "false"）→ 丢弃，按未配置（布尔 false 才生效）',
      !('enabled' in san) && sanEnabled.enabled === false)
    ok('dataSource 数字 → 丢弃', !('dataSource' in san))
    ok('开关认字符串 0 / 认不出的丢弃', san.personalityLearning === false && !('personalityWriting' in san))
    ok('model 纯数字 42 → 按字符串接受（模型 id 允许纯数字，与 enabled 口径不同）', san.model === '42')
    ok('model 对象 → 丢弃（回落默认）', !('model' in sanModelBad))
    ok('未知键保留（不丢用户设置）', sanUnknown.keep === 1 && sanUnknown.deepseekKey === 'sk-x')
    ok('未知键里的 Key 值不进日志（只点键名）',
      capUnknown.has('apiKey') && !leaks(capUnknown.text(), ['sk-live-UNKNOWN-KEY']))

    // 2.6 asrLanguage 类型错误 → 默认 zh
    writeFileSync(file, JSON.stringify({ asrLanguage: 123 }), 'utf8')
    ok('asrLanguage 数字 → zh', C.readAsrLanguage(dir) === 'zh')
    writeFileSync(file, JSON.stringify({ asrLanguage: ['en'] }), 'utf8')
    ok('asrLanguage 数组 → zh', C.readAsrLanguage(dir) === 'zh')
    writeFileSync(file, JSON.stringify({ asrLanguage: true }), 'utf8')
    ok('asrLanguage 布尔 → zh', C.readAsrLanguage(dir) === 'zh')
  }

  // ================= 3. 超长 / 控制字符：日志不刷屏 =================
  console.log('\n[3] 超长与含换行的配置值：告警有界、单行')
  {
    const dir = tmp('cfg-long')
    const file = join(dir, 'config.json')
    setEnv({})

    const huge = 's3\nsk-live-SECRET-LONG-' + 'x'.repeat(100 * 1024)
    writeFileSync(file, JSON.stringify({ dataSource: huge }), 'utf8')
    const cap1 = captureConsole()
    const ds = C.readDataSource(dir, { dataSource: huge })
    cap1.restore()
    ok('超长 dataSource：按 local 处理（不因笔误弄挂）', ds === 'local')
    ok('超长 dataSource：告警不含换行（日志不被撕碎）', !hasNewlineInside(cap1.logs), 'len=' + longestLine(cap1.text()))
    ok('超长 dataSource：告警长度有界', longestLine(cap1.text()) <= 300, 'max=' + longestLine(cap1.text()))
    ok('超长 dataSource：日志不含超长原文', !cap1.has('x'.repeat(1000)))

    writeFileSync(file, JSON.stringify({ dataSource: 'not-a-source' }), 'utf8')
    const cap2 = captureConsole()
    const ds2 = C.readDataSource(dir)
    cap2.restore()
    ok('普通非法 dataSource：告警保留原值（有界单行，便于排错）',
      ds2 === 'local' && cap2.has('not-a-source') && !hasNewlineInside(cap2.logs), cap2.text().slice(0, 120))

    const badModel = 'bad\nmodel-' + 'y'.repeat(5000)
    writeFileSync(file, JSON.stringify({ model: badModel }), 'utf8')
    const cap3 = captureConsole()
    const m = C.readChatModel(dir)
    cap3.restore()
    ok('超长 model：回落默认', m === C.DEFAULT_CHAT_MODEL)
    ok('超长 model：告警单行且长度有界', !hasNewlineInside(cap3.logs) && longestLine(cap3.text()) <= 300,
      'max=' + longestLine(cap3.text()))

    // 超长但无害的未知键：不挡读取
    writeFileSync(file, JSON.stringify({ huge: 'z'.repeat(200 * 1024), model: 'deepseek-flash' }), 'utf8')
    const cap4 = captureConsole()
    const m2 = C.readChatModel(dir)
    cap4.restore()
    ok('200KB 的未知键不影响已知键读取', m2 === 'deepseek-flash')
  }

  // ================= 4. prefs：坏文件先备份再重写、写入失败留痕 =================
  console.log('\n[4] prefs.json：坏文件不静默丢弃 / 写入失败不静默吞')
  {
    const dir = tmp('prefs-bad')
    const file = join(dir, 'prefs.json')
    const prefs = P.createPrefs(dir)

    // 4.1 坏 JSON：写开关前应把原文另存 .bad-*（store.ts 对坏数据文件就是这套口径）
    const bad = '{"chatCache":false,'
    writeFileSync(file, bad, 'utf8')
    const cap1 = captureConsole()
    prefs.setChatCache(true)
    cap1.restore()
    const saved1 = JSON.parse(readFileSync(file, 'utf8'))
    const bads1 = readdirSync(dir).filter((n) => n.indexOf('prefs.json.bad-') === 0)
    ok('坏 JSON：开关照样能写进去', saved1.chatCache === true)
    ok('坏 JSON：原文先备份成 prefs.json.bad-*', bads1.length === 1, readdirSync(dir).join(','))
    ok('坏 JSON：备份内容与原文逐字节一致', bads1.length === 1 && readFileSync(join(dir, bads1[0]), 'utf8') === bad)

    // 4.2 再写一次不该重复备份（坏文件已经被换掉）
    const cap2 = captureConsole()
    prefs.setChatCache(false)
    cap2.restore()
    ok('坏文件换掉后不再重复备份',
      readdirSync(dir).filter((n) => n.indexOf('prefs.json.bad-') === 0).length === 1)
    ok('第二次写入生效', prefs.chatCacheEnabled() === false)

    // 4.3 数组/标量坏形状：同样先备份
    const dir3 = tmp('prefs-shape')
    const file3 = join(dir3, 'prefs.json')
    const prefs3 = P.createPrefs(dir3)
    writeFileSync(file3, '[1,2,3]', 'utf8')
    const cap3 = captureConsole()
    prefs3.setChatCache(false)
    cap3.restore()
    const saved3 = JSON.parse(readFileSync(file3, 'utf8'))
    const bads3 = readdirSync(dir3).filter((n) => n.indexOf('prefs.json.bad-') === 0)
    ok('数组形状：重写成对象并生效', saved3.chatCache === false && !Array.isArray(saved3))
    ok('数组形状：原文也备份', bads3.length === 1 && readFileSync(join(dir3, bads3[0]), 'utf8') === '[1,2,3]')

    // 4.4 合法文件里的未知键必须保留（避免丢用户设置）
    const dir4 = tmp('prefs-keep')
    const file4 = join(dir4, 'prefs.json')
    const prefs4 = P.createPrefs(dir4)
    writeFileSync(file4, JSON.stringify({ chatCache: true, voiceName: 'zh-CN-XiaoxiaoNeural', extra: { a: 1 } }), 'utf8')
    prefs4.setChatCache(false)
    const kept = JSON.parse(readFileSync(file4, 'utf8'))
    ok('合法文件：未知键与嵌套值原样保留',
      kept.chatCache === false && kept.voiceName === 'zh-CN-XiaoxiaoNeural' && kept.extra && kept.extra.a === 1)

    // 4.5 写入失败（路径被占成目录）：不抛、留 WRITE-FAIL、不改状态
    const dir5 = tmp('prefs-fail')
    const file5 = join(dir5, 'prefs.json')
    mkdirSync(file5)
    const prefs5 = P.createPrefs(dir5)
    const cap5 = captureConsole()
    let threw = false
    try { prefs5.setChatCache(false) } catch { threw = true }
    cap5.restore()
    ok('写入失败：不抛给调用方', threw === false)
    ok('写入失败：日志留 WRITE-FAIL（不静默）', cap5.has('WRITE-FAIL'), cap5.text().slice(-160))
    ok('写入失败：不留原子写临时文件',
      readdirSync(dir5).every((n) => n.indexOf('.tmp') < 0), readdirSync(dir5).join(','))
    ok('写入失败：读不出时按默认开（与旧行为一致）', prefs5.chatCacheEnabled() === true)

    // 4.6 /cache-toggle 在写失败时仍回当前真实状态、不挂请求
    const res = mkRes()
    const cap6 = captureConsole()
    await P.createCacheToggleHandler(prefs5)(mkReq('{"enabled":false}'), res)
    cap6.restore()
    ok('写失败时 /cache-toggle 不挂请求', res.code === 200 && res.json() && res.json().ok === true)
    ok('写失败时 /cache-toggle 回报的是磁盘上的真实状态', res.json().enabled === true)

    // 4.7 运行时目录不存在：save 自建（与 migrate 同一套“目录缺失不算错误”）
    const dir7 = tmp('prefs-mkdir')
    const nested = join(dir7, 'a', 'b')
    const prefs7 = P.createPrefs(nested)
    const cap7 = captureConsole()
    prefs7.setChatCache(false)
    cap7.restore()
    ok('运行时目录不存在：save 自建目录并落盘',
      prefs7.chatCacheEnabled() === false && readFileSync(join(nested, 'prefs.json'), 'utf8').indexOf('false') >= 0)

    // 4.8 两个实例（主实例 + 临时实例共用同一运行目录）对同一键：后写者生效（无锁，口径记录）
    const dir8 = tmp('prefs-race')
    const a = P.createPrefs(dir8)
    const b = P.createPrefs(dir8)
    a.setChatCache(false)
    b.setChatCache(true)
    ok('两实例同键：后写者生效（无锁口径）', a.chatCacheEnabled() === true)
  }

  // ================= 5. migrate：幂等 / 不覆盖 / 源保留 / 失败可重试 =================
  console.log('\n[5] 运行数据迁移：幂等、源保留、失败可重试')
  {
    const KNOWN = [
      'memory.json', 'state.json', 'growth.json', 'fishfood.json', 'reminders.json',
      'story_progress.json', 'culture-seen.json', 'poem-seen.json', 'pet_state.json',
    ]

    const data = tmp('mig-data')
    const run = tmp('mig-run')
    const LEGACY = '{"oldField":1,"chatHistory":[{"role":"user"}],"intimacy":7}'
    for (const f of KNOWN) writeFileSync(join(data, f), LEGACY, 'utf8')
    writeFileSync(join(data, 'not-a-known-file.json'), '{"x":1}', 'utf8')
    mkdirSync(join(data, 'cache', 'tts'), { recursive: true })
    writeFileSync(join(data, 'cache', 'tts', 'a.bin'), 'tts-cache', 'utf8')

    const cap1 = captureConsole()
    M.migrateRuntimeData(data, join(run, 'nested', 'runtime'))
    cap1.restore()
    const runtime = join(run, 'nested', 'runtime')
    ok('迁移：运行时目录不存在时自动建（含多级）', readdirSync(runtime).length >= KNOWN.length)
    ok('迁移：9 个已知文件全部到位', KNOWN.every((f) => readFileSync(join(runtime, f), 'utf8') === LEGACY))
    ok('迁移：旧字段/未知字段整份保留（不改写内容）',
      JSON.parse(readFileSync(join(runtime, 'memory.json'), 'utf8')).oldField === 1)
    ok('迁移：缓存目录也到位', readFileSync(join(runtime, 'cache', 'tts', 'a.bin'), 'utf8') === 'tts-cache')
    ok('迁移：不在白名单里的文件不搬（只搬运行数据）', !readdirSync(runtime).includes('not-a-known-file.json'))
    ok('迁移：源文件保留、（旧实现/包内副本）字节不变',
      KNOWN.every((f) => readFileSync(join(data, f), 'utf8') === LEGACY))
    ok('迁移：不留 .migrating-* 残留', migratingLeftovers(runtime).length === 0)

    // 幂等：用户改了数据后再次迁移，绝不覆盖
    writeFileSync(join(runtime, 'memory.json'), '{"user":"new"}', 'utf8')
    const cap2 = captureConsole()
    M.migrateRuntimeData(data, runtime)
    cap2.restore()
    ok('迁移幂等：第二次不覆盖用户现有数据', readFileSync(join(runtime, 'memory.json'), 'utf8') === '{"user":"new"}')
    ok('迁移幂等：其余文件内容不变', KNOWN.filter((f) => f !== 'memory.json').every((f) => readFileSync(join(runtime, f), 'utf8') === LEGACY))

    // 运行目录已有 cache/：只在目标不存在时搬，绝不合并/覆盖
    const data2 = tmp('mig-data2')
    const run2 = tmp('mig-run2')
    mkdirSync(join(data2, 'cache', 'tts'), { recursive: true })
    writeFileSync(join(data2, 'cache', 'tts', 'pkg.bin'), 'pkg', 'utf8')
    mkdirSync(join(run2, 'cache', 'tts'), { recursive: true })
    writeFileSync(join(run2, 'cache', 'tts', 'user.bin'), 'user', 'utf8')
    const cap3 = captureConsole()
    M.migrateRuntimeData(data2, run2)
    cap3.restore()
    ok('缓存目录已存在：不覆盖、不合并（用户缓存原样）',
      readFileSync(join(run2, 'cache', 'tts', 'user.bin'), 'utf8') === 'user' &&
      !readdirSync(join(run2, 'cache', 'tts')).includes('pkg.bin'))

    // 半途失败：目标位置不能出现半截文件，临时文件要清掉，而且下次能重试
    const data3 = tmp('mig-data3')
    const run3 = tmp('mig-run3')
    writeFileSync(join(data3, 'memory.json'), LEGACY, 'utf8')
    const cap4 = captureConsole()
    M.migrateRuntimeData(data3, run3, {
      copyFile: (src, dst) => { writeFileSync(dst, '{"half', 'utf8'); throw new Error('disk full') },
    })
    cap4.restore()
    ok('半途失败：目标位置没有半截文件', !readdirSync(run3).includes('memory.json'))
    ok('半途失败：临时文件清掉', migratingLeftovers(run3).length === 0)
    const cap5 = captureConsole()
    M.migrateRuntimeData(data3, run3)
    cap5.restore()
    ok('半途失败后可重试（下次启动补上）', readFileSync(join(run3, 'memory.json'), 'utf8') === LEGACY)

    // 运行目录位置被文件占住：静默不抛（环境差异，不挡插件加载）
    const data4 = tmp('mig-data4')
    const run4 = tmp('mig-run4')
    const blocker = join(run4, 'blocked')
    writeFileSync(blocker, 'x', 'utf8')
    writeFileSync(join(data4, 'memory.json'), LEGACY, 'utf8')
    const cap6 = captureConsole()
    let threw = false
    try { M.migrateRuntimeData(data4, blocker) } catch { threw = true }
    cap6.restore()
    ok('运行目录被文件占住：迁移静默跳过、不抛', threw === false && readFileSync(blocker, 'utf8') === 'x')
  }

  // ================= 6. 源码级：三个模块的 console 调用不得拼 Key / 原文 =================
  console.log('\n[6] 源码核对：console 调用不拼敏感字段/原文')
  {
    const readSrc = (rel) => readFileSync(join(process.cwd(), 'src', 'host', rel), 'utf8')
    const SECRET_WORDS = ['deepseekKey', 'apiKey', 'DEEPSEEK_API_KEY', 'process.env']
    const consoleLines = (src) => src.split(/\r?\n/).filter((l) => /console\.(log|warn|error)\(/.test(l))

    for (const rel of ['config.ts', 'prefs.ts', 'migrate.ts']) {
      const lines = consoleLines(readSrc(rel))
      const offending = lines.filter((l) => SECRET_WORDS.some((w) => l.indexOf(w) >= 0))
      ok('源码：' + rel + ' 的 console 行不拼敏感字段/环境变量', offending.length === 0, offending.join(' | ').slice(0, 160))
    }

    const cfgSrc = readSrc('config.ts')
    ok('源码：坏 JSON 分支不直接拼 err.message（Node ≥20 的报错带原文片段）',
      !/不是合法 JSON[\s\S]{0,80}\.message/.test(cfgSrc))
    const prefsSrc = readSrc('prefs.ts')
    ok('源码：prefs 坏 JSON 分支不直接拼 err.message',
      !/坏 JSON[\s\S]{0,120}\.message/.test(prefsSrc))

    const migLines = consoleLines(readSrc('migrate.ts'))
    ok('源码：migrate 的 console 只上报路径/标签（不拼文件内容）',
      migLines.length > 0 && migLines.every((l) => !/readFileSync|JSON\.parse|err\.message/.test(l)))
  }
} catch (err) {
  fail++
  console.log('\n  ❌ 未捕获异常：' + String((err && err.stack) || err))
} finally {
  restoreEnv()
  cleanup()
}

console.log('\n通过 ' + pass + ' 项 / 失败 ' + fail + ' 项')
if (fail > 0) {
  console.log('❌ 有断言失败')
  process.exit(1)
}
console.log('✅ 全部通过')
