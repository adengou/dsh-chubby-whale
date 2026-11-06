/**
 * scripts/test-prefs-config.mjs —— B74 配置/备份/迁移模块专项回归（仅本批）
 *
 * 覆盖 src/host/config.ts、prefs.ts、migrate.ts、auto-backup.ts 的
 * 「配置优先级与类型归一 / 坏文件降级 / 键不外泄 / 迁移半途失败 / 备份裁剪与定时器」。
 *
 * 用法：node scripts/test-prefs-config.mjs
 *   （单独运行，不改 package.json 与 scripts/test.mjs；只读源码 + 临时目录，不联网、不碰真实运行数据）
 */

import { register } from 'node:module'
import {
  mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
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
const B = await import('../src/host/auto-backup.ts')
const CV = await import('../src/host/routes/config.ts')

const dirs = []
const tmp = (tag) => {
  const d = mkdtempSync(join(tmpdir(), 'chubby-' + tag + '-'))
  dirs.push(d)
  return d
}
const cleanup = () => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }) } catch { } } }

/** 捕获 console.warn / console.error（预期告警不污染输出，同时数次数） */
function captureConsole() {
  const origWarn = console.warn
  const origError = console.error
  const logs = []
  console.warn = (...a) => logs.push('warn ' + a.map(String).join(' '))
  console.error = (...a) => logs.push('error ' + a.map(String).join(' '))
  return {
    logs,
    count: (kind) => logs.filter((l) => l.startsWith(kind + ' ')).length,
    restore: () => { console.warn = origWarn; console.error = origError },
  }
}

/** 假响应：收集 status 与 JSON */
function mkRes() {
  const out = { code: 0, chunks: [], headers: null }
  out.writeHead = (c, h) => { out.code = c; out.headers = h || null }
  out.setHeader = () => { }
  out.end = (b) => { if (b) out.chunks.push(Buffer.from(String(b))) }
  out.json = () => { try { return JSON.parse(Buffer.concat(out.chunks).toString('utf8')) } catch { return null } }
  return out
}

/** 假请求：body 可以是字符串或 Buffer；headers 可指定 content-length */
function mkReq(body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body == null ? '' : String(body))
  return {
    method: 'POST',
    headers,
    on() { },
    destroy() { },
    async *[Symbol.asyncIterator]() { if (buf.length) yield buf },
  }
}

const envKeys = ['CHUBBY_WHALE_DEEPSEEK_KEY', 'DEEPSEEK_API_KEY', 'CHUBBY_WHALE_SILICONFLOW_KEY', 'SILICONFLOW_API_KEY', 'CHUBBY_WHALE_DATA_SOURCE', 'CHUBBY_WHALE_MODEL']
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

try {
  // ================= 1. config.ts：优先级与类型归一 =================
  console.log('\n[1] config.json / 环境变量 / 默认值 的优先级与归一')
  {
    const dir = tmp('cfg')
    const file = join(dir, 'config.json')
    setEnv({})

    ok('没有 config.json + 没有环境变量 → Key 空', C.readApiKey(dir) === '' && C.readSiliconFlowKey(dir) === '')
    ok('缺 Key 时 keyStatus 只给布尔', JSON.stringify(C.keyStatus(dir)) === '{"deepseek":false,"siliconflow":false}')

    // BOM + 前后空白
    writeFileSync(file, '\uFEFF' + JSON.stringify({ deepseekKey: '  sk-bom  ', siliconflowKey: ' sf ' }), 'utf8')
    ok('config.json 带 BOM 仍可读（Key 去空白）', C.readApiKey(dir) === 'sk-bom' && C.readSiliconFlowKey(dir) === 'sf')
    ok('keyStatus 只回布尔（不回 Key 内容）', JSON.stringify(C.keyStatus(dir)) === '{"deepseek":true,"siliconflow":true}')

    // 优先级：config.json > 专属 env > 通用 env
    setEnv({ CHUBBY_WHALE_DEEPSEEK_KEY: 'env-own', DEEPSEEK_API_KEY: 'env-generic' })
    ok('Key 优先级：config.json 胜出', C.readApiKey(dir) === 'sk-bom')
    writeFileSync(file, JSON.stringify({ deepseekKey: '   ' }), 'utf8')
    ok('config.json 里空白值不算配置，落回专属环境变量', C.readApiKey(dir) === 'env-own')
    setEnv({ CHUBBY_WHALE_DEEPSEEK_KEY: '   ', DEEPSEEK_API_KEY: 'env-generic' })
    ok('专属环境变量空白 → 落回通用环境变量', C.readApiKey(dir) === 'env-generic')
    setEnv({})

    // 坏 JSON / 非对象形状：按未配置降级，且只提示一次（不能每次聊天刷日志）
    const cap = captureConsole()
    writeFileSync(file, '{"deepseekKey": "sk-half', 'utf8')
    setEnv({ DEEPSEEK_API_KEY: 'env-generic' })
    const r1 = C.readApiKey(dir)
    C.readApiKey(dir)
    C.readSiliconFlowKey(dir)
    const badWarn = cap.logs.filter((l) => l.indexOf('config.json 不是合法 JSON') >= 0).length
    cap.restore()
    ok('坏 JSON 降级到环境变量（不抛、不挡插件）', r1 === 'env-generic')
    ok('坏 JSON 只提示一次（重复读不刷日志）', badWarn === 1, 'warn=' + badWarn)

    const cap2 = captureConsole()
    writeFileSync(file, '[]', 'utf8')
    const r2 = C.readApiKey(dir)
    C.readApiKey(dir)
    const shapeWarn = cap2.logs.filter((l) => l.indexOf('config.json 应为对象') >= 0).length
    cap2.restore()
    ok('config.json 是数组 → 按未配置处理（不把数组当配置对象）', r2 === 'env-generic')
    ok('非对象形状只提示一次', shapeWarn === 1, 'warn=' + shapeWarn)

    // ---- dataSource：cordis → config.json → env → local ----
    setEnv({})
    writeFileSync(file, JSON.stringify({ dataSource: ' Cloud ' }), 'utf8')
    ok('dataSource：config.json 归一为小写', C.readDataSource(dir) === 'cloud')
    ok('dataSource：cordis 配置优先于 config.json', C.readDataSource(dir, { dataSource: ' LOCAL ' }) === 'local')
    ok('dataSource：cordis 没配时用 config.json', C.readDataSource(dir, { dataSource: '   ' }) === 'cloud')
    rmSync(file, { force: true })
    setEnv({ CHUBBY_WHALE_DATA_SOURCE: 'cloud' })
    ok('dataSource：没有文件时用环境变量', C.readDataSource(dir) === 'cloud')
    setEnv({ CHUBBY_WHALE_DATA_SOURCE: 's3' })
    ok('dataSource：环境变量非法 → local', C.readDataSource(dir) === 'local')
    setEnv({ CHUBBY_WHALE_DATA_SOURCE: 'cloud' })
    writeFileSync(file, JSON.stringify({ dataSource: 's3' }), 'utf8')
    ok('dataSource：config.json 非法 → local（不再看环境变量）', C.readDataSource(dir) === 'local')
    ok('dataSource：cordis 非法 → local（告警一次）', C.readDataSource(dir, { dataSource: 'S3' }) === 'local')

    // ---- parseSwitchValue：数字串 / 布尔串 / 空串 ----
    ok('开关：真值写法', ['true', 'TRUE', ' on ', '1', 1, 'yes', 'enabled'].every((v) => C.parseSwitchValue(v) === true))
    ok('开关：假值写法', ['false', 'OFF', '0', 0, 'no', 'disabled', false].every((v) => C.parseSwitchValue(v) === false))
    ok('开关：空/未知 → null（按未配置）',
      ['', '   ', null, undefined, 'eh', '2', 1.5, NaN].every((v) => C.parseSwitchValue(v) === null))

    // ---- readPersonalityLearning / Writing ----
    rmSync(file, { force: true })
    ok('人格开关缺省开', C.readPersonalityLearning(dir) === true && C.readPersonalityWriting(dir) === true)
    writeFileSync(file, JSON.stringify({ personalityLearning: 'off', personalityWriting: 'ON' }), 'utf8')
    ok('人格开关认字符串并归一', C.readPersonalityLearning(dir) === false && C.readPersonalityWriting(dir) === true)
    ok('cordis 配置优先于 config.json', C.readPersonalityLearning(dir, { personalityLearning: true }) === true)
    writeFileSync(file, JSON.stringify({ personalityLearning: 'eh' }), 'utf8')
    ok('人格开关值认不出 → 按未配置（默认开）', C.readPersonalityLearning(dir) === true)

    // ---- 模型名：cordis → config.json → env → 默认 ----
    rmSync(file, { force: true })
    setEnv({})
    ok('模型名缺省值', C.readChatModel(dir) === C.DEFAULT_CHAT_MODEL)
    setEnv({ CHUBBY_WHALE_MODEL: ' deepseek-v4-pro ' })
    ok('模型名：环境变量去空白', C.readChatModel(dir) === 'deepseek-v4-pro')
    writeFileSync(file, JSON.stringify({ model: 'deepseek-flash' }), 'utf8')
    ok('模型名：config.json 优先于环境变量', C.readChatModel(dir) === 'deepseek-flash')
    ok('模型名：cordis 配置优先', C.readChatModel(dir, { model: '  deepseek-v4-pro  ' }) === 'deepseek-v4-pro')
    writeFileSync(file, JSON.stringify({ model: '整段文本粘进来 带空格' }), 'utf8')
    setEnv({ CHUBBY_WHALE_MODEL: 'bad model' })
    ok('模型名非法（空白/中文）→ 逐层回落到默认', C.readChatModel(dir) === C.DEFAULT_CHAT_MODEL)

    // ---- ASR 语言 ----
    rmSync(file, { force: true })
    ok('ASR 语言缺省 zh', C.readAsrLanguage(dir) === 'zh')
    writeFileSync(file, JSON.stringify({ asrLanguage: ' EN ' }), 'utf8')
    ok('ASR 语言归一（EN → en）', C.readAsrLanguage(dir) === 'en')
    writeFileSync(file, JSON.stringify({ asrLanguage: 'AUTO' }), 'utf8')
    ok('ASR 语言认 auto', C.readAsrLanguage(dir) === 'auto')
    writeFileSync(file, JSON.stringify({ asrLanguage: 'fr' }), 'utf8')
    ok('ASR 语言非法 → zh', C.readAsrLanguage(dir) === 'zh')

    // ---- sanitizePluginConfig：归一 / 未知键 / 原型链 ----
    ok('非对象配置 → 空配置', [null, 'nope', [1], 3].every((v) => JSON.stringify(C.sanitizePluginConfig(v)) === '{}'))
    const san = C.sanitizePluginConfig({ enabled: true, dataSource: ' CLOUD ', personalityLearning: 'off', model: ' deepseek-v4-pro ', custom: 1 })
    ok('清洗归一（小写/布尔/去空白）',
      san.dataSource === 'cloud' && san.personalityLearning === false && san.enabled === true && san.model === 'deepseek-v4-pro')
    ok('未知键保留', san.custom === 1)
    const sanBad = C.sanitizePluginConfig({ enabled: 'yes', dataSource: 's3', model: 'a b' })
    ok('非法值丢弃（不挡插件加载）', !('enabled' in sanBad) && !('dataSource' in sanBad) && !('model' in sanBad))

    // 原型链保留字：旧实现 out['__proto__']=value 会改掉 out 的原型 → config.dataSource 被“继承”出来
    const polluted = C.sanitizePluginConfig(JSON.parse('{"__proto__":{"dataSource":"cloud","enabled":false},"model":"m"}'))
    ok('__proto__ 键不会污染配置对象原型',
      Object.getPrototypeOf(polluted) === Object.prototype && polluted.dataSource === undefined && !('enabled' in polluted))
    ok('__proto__ 之外的合法键照常保留', polluted.model === 'm')
    ok('constructor / prototype 键也拒收',
      !Object.prototype.hasOwnProperty.call(C.sanitizePluginConfig({ constructor: 1 }), 'constructor') &&
      !('prototype' in C.sanitizePluginConfig({ prototype: 1 })))

    // ---- 只读配置视图：绝不回显 Key ----
    const view = CV.createConfigViewHandler({
      enabled: () => true,
      dataSource: () => 'local',
      model: () => 'm',
      hasDeepseekKey: () => 'sk-secret-should-not-leak',   // 故意误接成“读 Key”
    })
    const vres = mkRes()
    await view.handleConfig({ method: 'GET' }, vres)
    const viewText = Buffer.concat(vres.chunks).toString('utf8')
    ok('配置视图把误接的 Key getter 布尔化', vres.json().hasDeepseekKey === true)
    ok('配置视图响应不含 Key 原文', viewText.indexOf('sk-secret') < 0)
  }

  // ================= 2. prefs.ts：读坏降级 + 不泄漏内部对象 =================
  console.log('\n[2] prefs.json 的读取、归一与 /cache-toggle')
  {
    const dir = tmp('prefs')
    const file = join(dir, 'prefs.json')
    const prefs = P.createPrefs(dir)

    ok('首次运行没有 prefs.json → 缓存默认开', prefs.chatCacheEnabled() === true && JSON.stringify(prefs.load()) === '{}')
    prefs.setChatCache(false)
    ok('setChatCache 落盘为对象', JSON.stringify(JSON.parse(readFileSync(file, 'utf8'))) === '{"chatCache":false}')
    ok('关掉后读回来是 false', prefs.chatCacheEnabled() === false)
    prefs.setChatCache(true)
    ok('再开回来是 true', prefs.chatCacheEnabled() === true)

    // 带 BOM
    writeFileSync(file, '\uFEFF' + JSON.stringify({ chatCache: false }), 'utf8')
    ok('prefs.json 带 BOM 仍可读', prefs.chatCacheEnabled() === false)

    // 坏 JSON：按默认值（true）+ 只提示一次
    writeFileSync(file, '{"chatCache":', 'utf8')
    const cap = captureConsole()
    const bad = [prefs.chatCacheEnabled(), prefs.chatCacheEnabled(), prefs.chatCacheEnabled()]
    const errCount = cap.count('error')
    cap.restore()
    ok('坏 JSON → 默认开（不抛）', bad.every((v) => v === true))
    ok('坏 JSON 只提示一次', errCount === 1, 'error=' + errCount)

    // 数组 / 标量：旧实现会把数组原样返回，setChatCache 静默写不进去
    for (const badShape of ['[]', '[1,2]', '"x"', '3', 'null']) {
      writeFileSync(file, badShape, 'utf8')
      const cap2 = captureConsole()
      const before = prefs.chatCacheEnabled()
      prefs.setChatCache(false)
      const after = prefs.chatCacheEnabled()
      cap2.restore()
      const saved = (() => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } })()
      ok('非对象形状（' + badShape + '）→ 默认开且开关能写进去',
        before === true && after === false && saved && saved.chatCache === false && !Array.isArray(saved))
    }

    // 不泄漏内部对象：每次 load 都是新对象，改一份不影响下一份
    writeFileSync(file, JSON.stringify({ chatCache: true, extra: 'keep' }), 'utf8')
    const a = prefs.load()
    const b = prefs.load()
    a.chatCache = false
    a.extra = 'mutated'
    ok('load 每次返回独立对象（不泄漏内部状态）', b.chatCache === true && b.extra === 'keep' && prefs.load().extra === 'keep')

    // /cache-toggle
    const cap3 = captureConsole()
    const res1 = mkRes()
    await P.createCacheToggleHandler(prefs)(mkReq('{"enabled":false}'), res1)
    ok('POST /cache-toggle 返回 ok + 当前状态', res1.code === 200 && res1.json().ok === true && res1.json().enabled === false)
    const res2 = mkRes()
    await P.createCacheToggleHandler(prefs)(mkReq(''), res2)
    ok('GET /cache-toggle 读当前状态', res2.json().enabled === false)
    const res3 = mkRes()
    await P.createCacheToggleHandler(prefs)(mkReq('{"enabled":"false"}'), res3)
    ok('非布尔 enabled 被忽略（不回显伪造值）', res3.json().ok === true && res3.json().enabled === false)
    const res4 = mkRes()
    await P.createCacheToggleHandler(prefs)(mkReq('不是 JSON'), res4)
    ok('坏请求体不挂请求（仍回当前状态）', res4.json() && res4.json().ok === true)
    const res5 = mkRes()
    await P.createCacheToggleHandler(prefs)(mkReq('', { 'content-length': String(64 * 1024) }), res5)
    ok('超过 16KB → 413', res5.code === 413)
    cap3.restore()
  }

  // ================= 3. migrate.ts：只搬缺的、半途失败不留坏状态 =================
  console.log('\n[3] 运行数据迁移：幂等 / 不覆盖 / 失败可回滚')
  {
    const data = tmp('mig-data')
    const run = tmp('mig-run')
    writeFileSync(join(data, 'memory.json'), '{"from":"package"}', 'utf8')
    writeFileSync(join(data, 'state.json'), '{"intimacy":1}', 'utf8')
    mkdirSync(join(data, 'cache', 'tts'), { recursive: true })
    writeFileSync(join(data, 'cache', 'tts', 'a.bin'), 'tts-cache', 'utf8')

    const cap = captureConsole()
    M.migrateRuntimeData(data, run)
    cap.restore()
    ok('首次迁移：文件与缓存目录都到位',
      readFileSync(join(run, 'memory.json'), 'utf8') === '{"from":"package"}' &&
      readFileSync(join(run, 'state.json'), 'utf8') === '{"intimacy":1}' &&
      readFileSync(join(run, 'cache', 'tts', 'a.bin'), 'utf8') === 'tts-cache')

    const leftovers = () => {
      const bad = []
      const walk = (d) => {
        for (const name of readdirSync(d)) {
          const p = join(d, name)
          if (statSync(p).isDirectory()) { if (name.indexOf('.migrating-') === 0) bad.push(p); walk(p) }
          else if (name.indexOf('.migrating-') >= 0) bad.push(p)
        }
      }
      try { walk(run) } catch { }
      return bad
    }
    ok('迁移后不留临时文件/临时目录', leftovers().length === 0, leftovers().join(','))

    writeFileSync(join(run, 'memory.json'), '{"from":"user"}', 'utf8')
    const cap2 = captureConsole()
    M.migrateRuntimeData(data, run)
    cap2.restore()
    ok('第二次迁移是幂等的：绝不覆盖用户现有数据', readFileSync(join(run, 'memory.json'), 'utf8') === '{"from":"user"}')

    // 半途失败：copyFile 写半截后抛错 → 目标位置不能出现半截文件，临时文件要清掉
    const data2 = tmp('mig-data2')
    const run2 = tmp('mig-run2')
    writeFileSync(join(data2, 'memory.json'), '{"from":"package"}', 'utf8')
    const cap3 = captureConsole()
    M.migrateRuntimeData(data2, run2, {
      copyFile: (src, dst) => { writeFileSync(dst, '{"half', 'utf8'); throw new Error('disk full') },
    })
    cap3.restore()
    const run2List = (() => { try { return readdirSync(run2) } catch { return [] } })()
    ok('拷贝失败不留半截目标文件（不会把坏 JSON 当成已迁移）', run2List.indexOf('memory.json') < 0, run2List.join(','))
    ok('拷贝失败清掉临时文件', run2List.every((n) => n.indexOf('.migrating-') < 0), run2List.join(','))

    // 缓存目录半途失败：临时目录必须清掉，cache/ 不能出现
    const data3 = tmp('mig-data3')
    const run3 = tmp('mig-run3')
    mkdirSync(join(data3, 'cache'), { recursive: true })
    writeFileSync(join(data3, 'cache', 'x.txt'), 'x', 'utf8')
    const cap4 = captureConsole()
    M.migrateRuntimeData(data3, run3, {
      copyDir: (src, dst) => { mkdirSync(dst, { recursive: true }); writeFileSync(join(dst, 'x.txt'), 'x', 'utf8'); throw new Error('boom') },
    })
    cap4.restore()
    const run3List = (() => { try { return readdirSync(run3) } catch { return [] } })()
    ok('缓存目录拷贝失败不留半成品', run3List.indexOf('cache') < 0, run3List.join(','))
    ok('缓存目录失败清掉临时目录', run3List.every((n) => n.indexOf('.migrating-') < 0), run3List.join(','))
  }

  // ================= 4. auto-backup.ts：快照、裁剪、定时器 =================
  console.log('\n[4] 自动备份：快照 / 保留份数 / 定时器 unref 与去重')
  {
    const run = tmp('bak')
    writeFileSync(join(run, 'memory.json'), '{"m":1}', 'utf8')
    writeFileSync(join(run, 'prefs.json'), '{"chatCache":true}', 'utf8')

    const localStamp = (ms) => {
      const d = new Date(ms)
      const p = (n) => (n < 10 ? '0' + n : String(n))
      return 'auto-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.json'
    }
    const at = new Date(2026, 10, 7, 11, 4, 5).getTime()
    const backupDir = join(run, B.AUTO_BACKUP_DIR)

    ok('backupOnce 写成功', B.backupOnce({ runtimeDir: run, now: () => at }) === true)
    const written = JSON.parse(readFileSync(join(backupDir, localStamp(at)), 'utf8'))
    ok('快照内容含 at 与数据文件', written.at === at && written.files['memory.json'] === '{"m":1}' && written.files['prefs.json'] === '{"chatCache":true}')
    ok('备份目录不留原子写临时文件', readdirSync(backupDir).every((n) => n.indexOf('.tmp') < 0), readdirSync(backupDir).join(','))
    ok('autoBackupInfo 份数/最近时间（与文件名同口径）', (() => { const i = B.autoBackupInfo(run); return i.count === 1 && i.lastAt === at })())
    ok('同一秒重复备份幂等（不多出文件）', B.backupOnce({ runtimeDir: run, now: () => at }) === true && readdirSync(backupDir).filter((n) => /^auto-.*\.json$/.test(n)).length === 1)

    const empty = tmp('bak-empty')
    ok('没有任何数据文件时不产出空备份', B.backupOnce({ runtimeDir: empty }) === false)

    // 裁剪：不同秒各备一份 → 只留最近 keep 份
    const run2 = tmp('bak-keep')
    writeFileSync(join(run2, 'state.json'), '{"x":1}', 'utf8')
    const stamps = []
    for (let i = 0; i < 5; i++) {
      const t = new Date(2026, 0, 1, 0, 0, i * 10).getTime()
      stamps.push(localStamp(t))
      B.backupOnce({ runtimeDir: run2, keep: 3, now: () => t })
    }
    const left2 = readdirSync(join(run2, B.AUTO_BACKUP_DIR)).filter((n) => /^auto-.*\.json$/.test(n)).sort()
    ok('保留份数裁剪正确（按文件名时间，留最近 3 份）',
      left2.length === 3 && left2[0] === stamps[2] && left2[2] === stamps[4], left2.join(','))

    // autoBackupInfo.lastAt 取文件名时间（与裁剪同一真源），不取可能被拷贝/恢复改过的 mtime
    const run3 = tmp('bak-info')
    const bd3 = join(run3, B.AUTO_BACKUP_DIR)
    mkdirSync(bd3, { recursive: true })
    writeFileSync(join(bd3, 'auto-20260101-000000.json'), '{}', 'utf8')
    writeFileSync(join(bd3, 'auto-20240101-000000.json'), '{}', 'utf8')
    utimesSync(join(bd3, 'auto-20260101-000000.json'), new Date(2020, 0, 1), new Date(2020, 0, 1))
    utimesSync(join(bd3, 'auto-20240101-000000.json'), new Date(2030, 0, 1), new Date(2030, 0, 1))
    const info3 = B.autoBackupInfo(run3)
    ok('autoBackupInfo.lastAt 取文件名时间（拷贝/恢复改过 mtime 也不漂）',
      info3.lastAt === new Date(2026, 0, 1, 0, 0, 0).getTime() && info3.count === 2, JSON.stringify(info3))
    ok('目录不存在时 autoBackupInfo 归零', JSON.stringify(B.autoBackupInfo(join(run3, 'nope'))) === '{"lastAt":0,"count":0}')

    // 定时器：unref + 同目录去重 + 停止函数幂等 + 超长间隔夹紧
    const origSetInterval = globalThis.setInterval
    const origClearInterval = globalThis.clearInterval
    const created = []
    const cleared = new Set()
    globalThis.setInterval = (fn, ms) => { const t = origSetInterval(fn, ms); created.push({ t, ms }); return t }
    globalThis.clearInterval = (t) => { cleared.add(t); return origClearInterval(t) }
    try {
      const runT = tmp('bak-timer')
      writeFileSync(join(runT, 'state.json'), '{"x":1}', 'utf8')
      const stop1 = B.startAutoBackup({ runtimeDir: runT, intervalMs: 1000 })
      ok('间隔下限夹紧到 60s，且定时器 unref（不拖住宿主退出）',
        created.length === 1 && created[0].ms === 60000 && created[0].t.hasRef() === false)

      const stop2 = B.startAutoBackup({ runtimeDir: runT, intervalMs: 1000 })
      ok('同一运行目录重复启动会先停掉旧定时器（不叠加）', created.length === 2 && cleared.has(created[0].t) && created[1].t.hasRef() === false)
      stop1()
      ok('旧停止函数不会误停新定时器', !cleared.has(created[1].t))
      stop2()
      ok('停止函数被调用后定时器清掉', cleared.has(created[1].t))
      let threw = false
      try { stop2() } catch { threw = true }
      ok('停止函数可重复调用', threw === false)

      const runT2 = tmp('bak-timer2')
      writeFileSync(join(runT2, 'state.json'), '{"x":1}', 'utf8')
      const stopA = B.startAutoBackup({ runtimeDir: runT2, intervalMs: 60000 })
      const beforeB = created.length
      const stopB = B.startAutoBackup({ runtimeDir: tmp('bak-timer3'), intervalMs: 60000 })
      ok('不同运行目录各用各的定时器', created.length === beforeB + 1)
      const stopC = B.startAutoBackup({ runtimeDir: runT2, intervalMs: Infinity })
      ok('超长间隔夹紧到 setInterval 上限（不会退化成 1ms 疯狂写盘）',
        created[created.length - 1].ms === 2147483647, String(created[created.length - 1].ms))
      stopA(); stopB(); stopC()
    } finally {
      globalThis.setInterval = origSetInterval
      globalThis.clearInterval = origClearInterval
    }
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
