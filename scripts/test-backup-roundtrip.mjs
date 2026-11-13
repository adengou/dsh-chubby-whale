/**
 * scripts/test-backup-roundtrip.mjs —— 备份「导出 → 导入 → 再导出」与导入边界专项（B99）
 *
 * 为什么不塞进 scripts/test.mjs：本轮只允许新建一个脚本，且 test.mjs 已 5600+ 行；
 * 这个脚本独立可跑（`node scripts/test-backup-roundtrip.mjs`，失败退出码 1），
 * 覆盖的是「真实仓储 + 真实路由」的 round-trip，而不是再抄一遍 test.mjs [25] 的假 deps。
 *
 * 覆盖：
 *   A. 端到端 round-trip：用真实的 store/personality 落盘 → GET /data/export → POST /data/import
 *      → 再导出，两次导出必须等价（含本轮新增的鱼账本 byKind / 金额 / 输入输出拆分）；
 *      并二次导入验证幂等（导入后的包再导入不会继续漂移）。
 *   B. 导出面：不含 API Key / 本机路径 / config 字段；人格只出可变层；聊天原文按备份语义保留。
 *   C. 导入结构校验：非对象 / 空体 / 坏 JSON / 超深嵌套 / 超大数组 / 超长字符串 /
 *      prototype 污染键（顶层 + byKind + src + storyProgress）都不会抛错、不会写坏盘。
 *   D. 清洗函数边界：负数 / NaN / Infinity / 数字字符串 / boolean / 超长数组 / 坏时间戳，
 *      一律「不抛错」，且不把 NaN/Infinity/负 token/负数亲密度写进结果；token 按仓储口径封顶。
 *   E. 部分覆盖语义：只有一半键的 memory、没有任何可变层字段的 personality → 整字段跳过
 *      （不拿「缺失」去覆盖已有数据）；只导入 state 时其它数据文件字节不变。
 *   F. 自动备份：保留份数、磁盘失败、同一秒重复写、时钟异常（NaN / 越界毫秒）。
 *   G. 封装取证：backup/*.ts 不碰文件系统、不 import config；清洗器表是 null 原型且冻结。
 *
 * 纯离线：不联网、不起 HTTP、不碰 dist；临时目录建在 os.tmpdir()，结束删干净。
 */
import { register } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
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

/** 假 res：与 host/respond.ts 的用法一致（writeHead + end，sendTooLarge 还会挂 error 监听） */
function mkRes() {
  const out = { code: 0, headers: null, body: '', headerMap: {} }
  out.writeHead = (code, headers) => { out.code = code; out.headers = headers || null }
  out.setHeader = (k, v) => { out.headerMap[k] = v }
  out.on = () => { }
  out.end = (body) => { out.body = body ? String(body) : '' }
  out.json = () => { try { return JSON.parse(out.body) } catch { return null } }
  return out
}

/** 假 req：body 可以是字符串或对象；GET 时不带流 */
function mkReq(body, method = 'POST', headers = {}) {
  const text = body === undefined || body === null ? '' : (typeof body === 'string' ? body : JSON.stringify(body))
  return {
    method, url: '/api/chubby-whale/data/' + (method === 'GET' ? 'export' : 'import'), headers,
    destroy() { }, on() { }, resume() { },
    async *[Symbol.asyncIterator]() { if (text) yield Buffer.from(text, 'utf8') },
  }
}

async function call(handler, req) {
  const res = mkRes()
  try { await handler(req || mkReq(null, 'GET'), res) } catch (e) {
    return { code: res.code, json: res.json(), body: res.body, threw: e }
  }
  return { code: res.code, json: res.json(), body: res.body, threw: null }
}

/** 顺序无关的深比较键：对象键排序后序列化（导出包里 `day/month`、`mood` 的键序会变，值不变） */
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
  }
  return JSON.stringify(v)
}

/** 结果里是否混进 NaN / Infinity（JSON 里它们会变成 null，属于「坏值写盘」） */
function hasBadNumber(v) {
  if (typeof v === 'number') return !Number.isFinite(v)
  if (Array.isArray(v)) return v.some(hasBadNumber)
  if (v && typeof v === 'object') return Object.keys(v).some((k) => hasBadNumber(v[k]))
  return false
}

/** 静默执行一段预期会打日志的代码，返回 {value, threw} */
function quiet(fn) {
  const realError = console.error
  console.error = () => { }
  try { return { value: fn(), threw: null } } catch (e) { return { value: undefined, threw: e } } finally { console.error = realError }
}

const dirs = []
function tmp(label) {
  const d = mkdtempSync(join(tmpdir(), 'b99-rt-' + label + '-'))
  dirs.push(d)
  return d
}

try {
  const store0 = await imp('src/host/store.ts')
  const personalityMod = await imp('src/host/personality.ts')
  const backupRoute = await imp('src/host/routes/backup.ts')
  const fields = await imp('src/host/backup/fields.ts')
  const autoBackup = await imp('src/host/auto-backup.ts')
  const { createStore } = store0
  const { createPersonalityRepo } = personalityMod
  const { createBackupHandlers, BACKUP_MAX_BYTES } = backupRoute
  const { backupOnce, autoBackupInfo, AUTO_BACKUP_DIR } = autoBackup

  /** 与 src/index.ts 的接线同构：注入端口，不碰 config / Key */
  function depsFor(store, personality, extra = {}) {
    return {
      version: '1.1.71',
      loadMemory: () => ({ history: store.loadHistory(), summary: store.loadMemorySummary() }),
      saveMemory: (m) => { store.saveHistory(m.history); store.saveMemorySummary(m.summary) },
      loadPersonality: () => personality.load(),
      savePersonality: (p) => personality.save(p),
      loadState: store.loadState, saveState: store.saveState,
      loadGrowth: store.loadGrowth, saveGrowth: store.saveGrowth,
      loadFishfood: store.loadFishfood, saveFishfood: store.saveFishfood,
      loadPet: store.loadPet, savePet: store.savePet,
      loadReminders: store.loadReminders, saveReminders: store.saveReminders,
      loadStoryProgress: store.loadStoryProgress, saveStoryProgress: store.saveStoryProgress,
      onStoryProgressImported: () => { },
      clearChatCache: () => 0,
      now: () => new Date('2026-11-07T00:00:00.000Z'),
      ...extra,
    }
  }

  // ===========================================================================
  // A. 端到端 round-trip（真实仓储落盘）
  // ===========================================================================
  console.log('\n[A] 导出 → 导入 → 再导出：真实仓储 round-trip')
  {
    const dir = tmp('e2e')
    const store = createStore(dir)
    const personality = createPersonalityRepo(dir)
    const h = createBackupHandlers(depsFor(store, personality))

    // 记忆：3 轮 + 摘要
    store.appendTurns('主人好', '哼，才不是特意回你的')
    store.appendTurns('今天吃白饭', '本鱼要吃三碗')
    store.appendTurns('再多一碗', '嘿嘿，那本鱼就不客气了')
    store.saveMemorySummary('主人爱吃白饭')
    // 亲密度 / 成长
    store.saveState({ intimacy: 42 })
    store.addExp(3, 'chat')
    store.addExp(2, 'praise')
    // 鱼账本：顶层拆分/金额 + 四个分桶（本轮 B98 新增字段）
    store.addTokens('chat', 1234, { promptTokens: 1000, completionTokens: 234, cacheHitTokens: 300, costCny: 0.012345 })
    store.addTokens('story', 500, { promptTokens: 400, completionTokens: 100, costCny: 0.005 })
    store.addTokens('summary', 77, { promptTokens: 60, completionTokens: 17, costCny: 0.0007 })
    store.addTokens('personality', 33, { promptTokens: 20, completionTokens: 13, costCny: 0.0003 })
    // 宠物（hunger 是连续量：tickPet 会写小数）
    store.savePet({ feeds: 3, hunger: 21.5, mood: 'happy', lastSeen: 1762400000000, lastFeedAt: 1762400000000, intimacy: 7 })
    // 提醒：一条普通 + 一条已触发过的重复提醒（nextAt / remindCount 都要原样回来）
    store.saveReminders([
      { id: 'r1', text: '喝水', at: '2026-11-08T01:00:00.000Z', repeat: null, nextAt: null, fired: false, done: false, remindCount: 0, createdAt: '2026-11-07T00:00:00.000Z' },
      { id: 'r2', text: '睡觉', at: '2026-11-08T14:00:00.000Z', repeat: 86400, nextAt: '2026-11-09T14:00:00.000Z', fired: false, done: false, remindCount: 2, createdAt: '2026-11-07T00:00:00.000Z' },
    ])
    store.saveStoryProgress({ 'local:甲|0': true, 'local:甲|1': true, _current: '甲' })
    // 人格：一次 learn 最多改 2 个字段（MAX_FIELDS_PER_LEARN），所以要两次
    personality.learn({ catchphrases: ['哼'] })
    personality.learn({ preferences: ['白饭'], notes: '喜欢被摸头' })
    personality.writeNarrative('今天也想偷吃一点主人的 token 呢')

    const r1 = await call(h.handleExport, mkReq(null, 'GET'))
    const first = r1.json
    ok('A1 导出 200 且 8 个数据字段齐全',
      r1.code === 200 && first && ['memory', 'personality', 'state', 'growth', 'fishfood', 'pet', 'reminders', 'storyProgress'].every((k) => k in first),
      'code=' + r1.code)
    ok('A2 导出带版本与时间戳', first.version === '1.1.71' && first.exportedAt === '2026-11-07T00:00:00.000Z')

    const r2 = await call(createBackupHandlers(depsFor(store, personality)).handleImport, mkReq(first))
    const imp1 = r2.json
    ok('A3 导入整包 8 个字段全部落盘、0 跳过',
      r2.code === 200 && imp1 && imp1.imported.length === 8 && imp1.skipped.length === 0, JSON.stringify(imp1))

    const r3 = await call(h.handleExport, mkReq(null, 'GET'))
    const second = r3.json
    const a = { ...first, exportedAt: '' }
    const b = { ...second, exportedAt: '' }
    ok('A4 导出 → 导入 → 再导出 完全等价（含鱼账本/金额/分桶）', canon(a) === canon(b),
      canon(a) === canon(b) ? '' : '首个不等价字段：' + Object.keys(a).filter((k) => canon(a[k]) !== canon(b[k])).join(','))

    // 逐项确认「本轮 B98 的鱼账本」没有在导入时丢
    const ff = second.fishfood || {}
    ok('A5 鱼账本顶层：token 总量/当日/当月与输入输出缓存拆分都在',
      ff.chatTokens === 1344 && ff.storyTokens === 500 && ff.totalTokens === 1844 &&
      ff.dayTokens === 1844 && ff.monthTokens === 1844 &&
      ff.promptTokens === 1480 && ff.completionTokens === 364 && ff.cacheHitTokens === 300,
      JSON.stringify({ c: ff.chatTokens, d: ff.dayTokens, p: ff.promptTokens, ch: ff.cacheHitTokens }))
    ok('A6 鱼账本金额：总额/当日/当月（6 位精度）',
      ff.costCny === 0.018345 && ff.dayCostCny === 0.018345 && ff.monthCostCny === 0.018345, JSON.stringify([ff.costCny, ff.dayCostCny, ff.monthCostCny]))
    const bk = ff.byKind || {}
    const bucketOk = (k) => Boolean(bk[k] && typeof bk[k].tokens === 'number' && typeof bk[k].costCny === 'number')
    ok('A7 鱼账本四个分桶齐全，桶内 tokens 与金额都在',
      ['chat', 'story', 'summary', 'personality'].every(bucketOk) &&
      (bk.chat || {}).tokens === 1234 && (bk.chat || {}).costCny === 0.012345 &&
      (bk.story || {}).tokens === 500 && (bk.summary || {}).tokens === 77 && (bk.personality || {}).tokens === 33,
      JSON.stringify(Object.keys(bk)))

    // 落盘证据：不是只在内存里对，fishfood.json 里必须有金额与分桶
    const onDisk = JSON.parse(readFileSync(join(dir, 'fishfood.json'), 'utf8'))
    const onDiskBk = onDisk.byKind || {}
    ok('A8 金额/分桶真的写进了 fishfood.json', onDisk.costCny === 0.018345 && (onDiskBk.chat || {}).costCny === 0.012345, JSON.stringify({ c: onDisk.costCny }))

    ok('A9 记忆原文与摘要原样回来', (second.memory.history || []).length === 6 && second.memory.summary === '主人爱吃白饭' &&
      second.memory.history[1].content === '哼，才不是特意回你的')
    ok('A10 人格四字段与心境原样回来（含历史）',
      second.personality.selfNarrative === '今天也想偷吃一点主人的 token 呢' &&
      second.personality.catchphrases[0] === '哼' && second.personality.preferences[0] === '白饭' &&
      second.personality.notes === '喜欢被摸头' && second.personality.version === 3 && second.personality.history.length === 4,
      JSON.stringify({ v: second.personality.version, h: second.personality.history.length, n: second.personality.notes }))
    ok('A11 宠物小数饥饿不被取整（tickPet 会写 21.5 这类值）', second.pet.hunger === 21.5, String(second.pet.hunger))
    ok('A12 提醒的重复间隔/下一次时间/已触发次数原样回来',
      second.reminders.length === 2 && second.reminders[1].repeat === 86400 &&
      second.reminders[1].nextAt === '2026-11-09T14:00:00.000Z' && second.reminders[1].remindCount === 2)
    ok('A13 说书进度与当前书目原样回来', second.storyProgress['local:甲|1'] === true && second.storyProgress._current === '甲')

    // 幂等：把同一份包再导一遍，导出结果不该继续漂移
    await call(createBackupHandlers(depsFor(store, personality)).handleImport, mkReq(first))
    const third = (await call(h.handleExport, mkReq(null, 'GET'))).json
    ok('A14 二次导入幂等（再导出仍与第一份等价）', canon({ ...third, exportedAt: '' }) === canon(a))

    // 记忆条数上限口径一致：文件里本来就只有 40 条，导出不额外截
    const mem = JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8'))
    ok('A15 memory.json 落盘形状仍是 {history, summary}', Array.isArray(mem.history) && typeof mem.summary === 'string')
  }

  // ===========================================================================
  // B. 导出面：敏感信息与人格边界
  // ===========================================================================
  console.log('\n[B] 导出包不含 Key / 路径 / config；聊天原文按备份语义保留')
  {
    const dir = tmp('export')
    const store = createStore(dir)
    // 故意让「人格」读取器带核心设定与 Key：导出必须只留可变层
    const h = createBackupHandlers({
      version: '1.1.71',
      loadMemory: () => ({ history: [{ role: 'user', content: '主人好' }], summary: '摘要' }),
      loadPersonality: () => ({ name: '旺财', birthday: '1月1日', family: ['爸爸'], language: 'zh', apiKey: 'sk-live-SECRET', catchphrases: ['哼'], preferences: ['白饭'], notes: '备注' }),
      loadState: () => ({ intimacy: 10 }),
      loadGrowth: () => ({ exp: 1 }),
      loadFishfood: () => ({ chatTokens: 1 }),
      loadPet: () => ({ feeds: 1 }),
      loadReminders: () => [],
      loadStoryProgress: () => ({}),
      now: () => new Date('2026-11-07T00:00:00.000Z'),
    })
    const r = await call(h.handleExport, mkReq(null, 'GET'))
    const pack = r.json
    const body = r.body
    ok('B1 导出包不含 Key 名与 Key 原文', !/apiKey|deepseekKey|authorization|sk-live/i.test(body))
    ok('B2 导出包不含本机路径写法', !/[A-Za-z]:\\\\|\/home\/|\.dsh-chubby-whale|AppData/i.test(body), body.slice(0, 0))
    ok('B3 导出包没有 config 字段', !/"config"\s*:/.test(body) && !('config' in pack))
    ok('B4 人格只出可变层（名字/生日/家人/语言规则都不在）',
      !('name' in pack.personality) && !('birthday' in pack.personality) && !('family' in pack.personality) && !('language' in pack.personality) &&
      Array.isArray(pack.personality.catchphrases))
    ok('B5 聊天原文按备份语义保留（只导摘要会让恢复变成半份数据）', pack.memory.history.length === 1 && pack.memory.summary === '摘要')
    ok('B6 导出包可被 JSON 往返（无循环引用/无函数）', (() => { try { JSON.parse(body); return true } catch { return false } })())
  }

  // ===========================================================================
  // C. 导入结构校验：坏包不抛错、不写盘
  // ===========================================================================
  console.log('\n[C] 导入结构校验：非对象 / 坏 JSON / 超深嵌套 / 超大数组 / prototype 污染')
  {
    const dir = tmp('badbody')
    const store = createStore(dir)
    const h = createBackupHandlers(depsFor(store, createPersonalityRepo(dir)))
    const before = () => readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => f + ':' + readFileSync(join(dir, f), 'utf8')).join('|')

    const snap = before()
    for (const text of ['', 'null', '[]', '123', '"str"', 'not-json', 'true']) {
      const r = await call(h.handleImport, mkReq(text))
      ok('C1 坏 body ' + JSON.stringify(text) + ' → 400 BAD_BODY', r.code === 400 && r.json && r.json.error === 'BAD_BODY', 'code=' + r.code)
    }
    ok('C2 坏 body 一个字段都没写', before() === snap)

    // 合法空对象：可解析但没有可导入字段 → 200 + 空报告，且不写盘
    const empty = await call(h.handleImport, mkReq('{}'))
    ok('C3 空对象包 → 200 且 imported/skipped 都为空', empty.code === 200 && empty.json.imported.length === 0 && empty.json.skipped.length === 0, JSON.stringify(empty.json))
    ok('C4 空对象包不写盘', before() === snap)

    // 超深嵌套：整包是深数组 → 400；字段内深数组 → 该字段 skipped
    const deepWhole = '['.repeat(200000) + ']'.repeat(200000)
    const deepField = '{"state":' + '['.repeat(200000) + ']'.repeat(200000) + '}'
    const rDeep1 = await call(h.handleImport, mkReq(deepWhole))
    ok('C5 20 万层嵌套的整包 → 400 BAD_BODY（不崩、不抛）', rDeep1.threw === null && rDeep1.code === 400 && rDeep1.json.error === 'BAD_BODY', 'code=' + rDeep1.code)
    const rDeep2 = await call(h.handleImport, mkReq(deepField))
    ok('C6 20 万层嵌套的字段 → skipped，不抛错', rDeep2.threw === null && rDeep2.code === 200 && rDeep2.json.skipped.indexOf('state') >= 0, JSON.stringify(rDeep2.json))
    ok('C7 深嵌套坏包没有写盘', before() === snap)

    // 超大数组：5000 条提醒（约 300KB，未触 2MB 上限）只留最新 200 条
    const many = Array.from({ length: 5000 }, (_, i) => ({ text: 'r' + i, at: '2026-11-08T00:00:00.000Z' }))
    const rMany = await call(h.handleImport, mkReq({ reminders: many }))
    const kept = JSON.parse(readFileSync(join(dir, 'reminders.json'), 'utf8'))
    ok('C8 5000 条提醒导入后只留最新 200 条', rMany.code === 200 && kept.length === 200 && kept[199].text === 'r4999', 'kept=' + kept.length)

    // 超长字符串：content 100k → 8000，summary 100k → 2000
    const rLong = await call(h.handleImport, mkReq({ memory: { history: [{ role: 'user', content: 'x'.repeat(100000) }], summary: 'y'.repeat(100000) } }))
    const mem = JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8'))
    ok('C9 超长聊天内容截到 8000 字、摘要截到 2000 字', rLong.code === 200 && mem.history[0].content.length === 8000 && mem.summary.length === 2000,
      JSON.stringify([mem.history[0].content.length, mem.summary.length]))

    // prototype 污染：顶层 + byKind + src + storyProgress 全塞进去
    const raw = '{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}},"prototype":{"polluted":1},'
      + '"growth":{"exp":5,"src":{"__proto__":9,"constructor":8,"chat":3}},'
      + '"storyProgress":{"local:甲|0":true,"_current":"甲","__proto__":true,"constructor":true,"prototype":true},'
      + '"fishfood":{"chatTokens":5,"byKind":{"chat":{"tokens":5},"__proto__":{"tokens":999}}},'
      + '"apiKey":"sk-live-SECRET","config":{"enabled":false},"../../evil":"x"}'
    const rProto = await call(h.handleImport, mkReq(raw))
    ok('C10 原型/路径/Key 键全部进 skipped，白名单字段照常导入',
      rProto.code === 200 && ['__proto__', 'constructor', 'prototype', 'apiKey', 'config', '../../evil'].every((k) => rProto.json.skipped.indexOf(k) >= 0) &&
      ['growth', 'storyProgress', 'fishfood'].every((k) => rProto.json.imported.indexOf(k) >= 0), JSON.stringify(rProto.json))
    ok('C11 Object.prototype 未被污染', ({}).polluted === undefined && Object.prototype.polluted === undefined)
    const growth = JSON.parse(readFileSync(join(dir, 'growth.json'), 'utf8'))
    const story = JSON.parse(readFileSync(join(dir, 'story_progress.json'), 'utf8'))
    const ff = JSON.parse(readFileSync(join(dir, 'fishfood.json'), 'utf8'))
    ok('C12 src 里的 __proto__/constructor 没被写成键', Object.keys(growth.src || {}).sort().join(',') === 'chat', JSON.stringify(Object.keys(growth.src || {})))
    ok('C13 storyProgress 只留合法键', Object.keys(story).sort().join(',') === '_current,local:甲|0', JSON.stringify(Object.keys(story)))
    ok('C14 byKind 只留四个固定桶（未知桶丢弃）', Object.keys(ff.byKind || {}).join(',') === 'chat', JSON.stringify(Object.keys(ff.byKind || {})))
  }

  // ===========================================================================
  // D. 清洗函数边界：不抛错、不写坏值
  // ===========================================================================
  console.log('\n[D] 清洗函数边界：负数 / NaN / Infinity / 数字字符串 / boolean / 超长')
  {
    const cleaners = Object.keys(fields.BACKUP_CLEANERS)
    ok('D1 清洗器表恰好 8 个、与字段白名单一一对应',
      cleaners.length === 8 && fields.BACKUP_DATA_FIELDS.every((f) => typeof fields.BACKUP_CLEANERS[f] === 'function'))

    // 任意脏输入都不许抛错，且结果里不许出现 NaN/Infinity
    const dirtyInputs = [
      undefined, null, 0, 1, -1, NaN, Infinity, -Infinity, '', '12', 'true', true, false,
      [], [1], [null], {}, { a: 1 }, () => 0, Symbol('x'), 10n,
    ]
    let threw = []
    let badNum = []
    for (const name of cleaners) {
      for (const input of dirtyInputs) {
        const r = quiet(() => fields.BACKUP_CLEANERS[name](input))
        if (r.threw) threw.push(name + '(' + String(input) + ')')
        if (r.value !== null && r.value !== undefined && !Array.isArray(r.value) && typeof r.value === 'object' && hasBadNumber(r.value)) badNum.push(name)
        if (Array.isArray(r.value) && hasBadNumber(r.value)) badNum.push(name)
      }
    }
    ok('D2 10 类脏输入 × 8 个清洗器，一个都不抛错', threw.length === 0, threw.slice(0, 5).join(','))
    ok('D3 清洗结果里没有 NaN / Infinity', badNum.length === 0, badNum.join(','))

    // state：严格数字，负数夹 0，字符串数字/boolean 不认
    ok('D4 cleanState 负数→0、数字字符串→null、boolean→null',
      fields.cleanState({ intimacy: -3 }).intimacy === 0 && fields.cleanState({ intimacy: '88' }) === null && fields.cleanState({ intimacy: true }) === null &&
      fields.cleanState({ intimacy: 50.9 }).intimacy === 50)

    // growth：exp 必须有限数字；src 跳危险键、非数字丢弃、负数夹 0、上限 50 个来源
    const g = fields.cleanGrowth({ exp: 7.9, dayKey: '2026-11-07', dayExp: -2, src: JSON.parse('{"__proto__":5,"constructor":6,"chat":3,"praise":-1,"x":"y"}') })
    ok('D5 cleanGrowth 归一 exp/dayExp/src（负数夹 0、非数字丢弃、危险键跳过）',
      g.exp === 7 && g.dayExp === 0 && Object.keys(g.src).sort().join(',') === 'chat,praise' && g.src.praise === 0,
      JSON.stringify(g))
    ok('D6 cleanGrowth 字符串数字/boolean exp → null', fields.cleanGrowth({ exp: '7' }) === null && fields.cleanGrowth({ exp: true }) === null)
    const manySrc = {}; for (let i = 0; i < 80; i++) manySrc['s' + i] = i
    ok('D7 growth.src 最多 50 个来源', Object.keys(fields.cleanGrowth({ exp: 1, src: manySrc }).src).length === 50)

    // fishfood：token 封顶到 MAX_SAFE_INTEGER（与仓储 MAX_TOKEN 同口径），金额非负 6 位小数
    const huge = fields.cleanFishfood({ chatTokens: 1e308, totalTokens: 1e308, byKind: { chat: { tokens: 1e308 } } })
    const hugeBk = (huge && huge.byKind) || {}
    ok('D8 超大 token 按仓储口径封顶（不再写 1e308）',
      huge.chatTokens === Number.MAX_SAFE_INTEGER && huge.totalTokens === Number.MAX_SAFE_INTEGER && (hugeBk.chat || {}).tokens === Number.MAX_SAFE_INTEGER,
      JSON.stringify([huge.chatTokens]))
    const dirtyFF = fields.cleanFishfood({
      chatTokens: '80', storyTokens: true, costCny: -1, dayCostCny: NaN, promptTokens: '1',
      byKind: { chat: { tokens: -3, costCny: 'x', dayCostCny: -0.5 }, evil: { tokens: 9 } },
    })
    ok('D9 脏 token/金额/分桶清洗后不出现字符串/负数/NaN',
      !dirtyFF || (dirtyFF.chatTokens === undefined && dirtyFF.storyTokens === undefined && dirtyFF.costCny === undefined &&
        dirtyFF.promptTokens === undefined && (!dirtyFF.byKind || !dirtyFF.byKind.evil)), JSON.stringify(dirtyFF))

    // pet：hunger 是连续量（不取整）、夹到 [0,100]；计数类非负整数
    ok('D10 cleanPet 小数饥饿保留、越界夹紧、负数计数夹 0',
      fields.cleanPet({ hunger: 21.5 }).hunger === 21.5 &&
      fields.cleanPet({ hunger: 150 }).hunger === 100 && fields.cleanPet({ hunger: -4 }).hunger === 0 &&
      fields.cleanPet({ feeds: -2 }).feeds === 0 && fields.cleanPet({ feeds: 3.9 }).feeds === 3)

    // reminders：坏时间戳/坏 nextAt/超大 repeat 不能落成「永远不会响」的提醒
    ok('D11 cleanReminders 丢弃 at 解析不了的项（与 routes/reminders.ts 同一道校验）',
      fields.cleanReminders([{ text: '喝水', at: 'not-a-date' }]) === null)
    ok('D12 cleanReminders 解析不了的 nextAt 归 null（否则会挡死合法的 at）',
      fields.cleanReminders([{ text: '喝水', at: '2026-11-08T00:00:00.000Z', nextAt: 'garbage' }])[0].nextAt === null)
    const rep = fields.cleanReminders([
      { text: 'a', at: '2026-11-08T00:00:00.000Z', repeat: 60 },
      { text: 'b', at: '2026-11-08T00:00:00.000Z', repeat: 604800 },
      { text: 'c', at: '2026-11-08T00:00:00.000Z', repeat: 59 },
      { text: 'd', at: '2026-11-08T00:00:00.000Z', repeat: 604801 },
      { text: 'e', at: '2026-11-08T00:00:00.000Z', repeat: 1e15 },
    ])
    ok('D13 repeat 只收 60s~7 天，其余归 null', rep[0].repeat === 60 && rep[1].repeat === 604800 && rep[2].repeat === null && rep[3].repeat === null && rep[4].repeat === null)
    const clip = fields.cleanReminders([{ text: 'x'.repeat(300), at: '2026-11-08T00:00:00.000Z', remindCount: -2, createdAt: 123 }])
    ok('D14 提醒 text 截 200、remindCount 负数夹 0、坏 createdAt 补现在', clip[0].text.length === 200 && clip[0].remindCount === 0 && typeof clip[0].createdAt === 'string')
    ok('D15 提醒空数组合法（清空提醒是有意义的备份语义）', Array.isArray(fields.cleanReminders([])) && fields.cleanReminders([]).length === 0)

    // memory：一半键的包不再覆盖另一半；老格式（整份数组）仍认
    ok('D16 cleanMemory 只有 summary → null（不拿缺失覆盖 history）', fields.cleanMemory({ summary: 'x' }) === null)
    ok('D17 cleanMemory 只有 history → null（不拿缺失覆盖 summary）', fields.cleanMemory({ history: [] }) === null)
    const legacy = fields.cleanMemory([{ role: 'user', content: 'hi' }])
    ok('D18 cleanMemory 老格式（整份数组）仍认', legacy && legacy.history.length === 1 && legacy.summary === '')
    const junkMem = fields.cleanMemory({ history: [{ role: 'system', content: 'x' }, { role: 'user', content: 5 }], summary: 's' })
    ok('D19 非空 history 全是坏项 → null（与 reminders 的「全坏不误清空」同口径）', junkMem === null, JSON.stringify(junkMem))
    const bigMem = fields.cleanMemory({ history: Array.from({ length: 100 }, (_, i) => ({ role: 'user', content: '#' + i })), summary: 's' })
    ok('D20 记忆只留最新 40 条', bigMem.history.length === 40 && bigMem.history[39].content === '#99')

    // personality：没有可变层字段的包不写盘；核心设定进不来
    ok('D21 cleanPersonality({}) → null（不再清空整份人格）', fields.cleanPersonality({}) === null)
    ok('D22 cleanPersonality 只有核心设定键 → null', fields.cleanPersonality({ name: '旺财', birthday: '1月1日' }) === null)
    ok('D23 cleanPersonality 只有元数据（version）→ null', fields.cleanPersonality({ version: 3 }) === null)
    const fullEmpty = fields.cleanPersonality({ catchphrases: [], preferences: [], notes: '', selfNarrative: '', selfNarrativeAt: '', version: 0, updatedAt: '', history: [] })
    ok('D24 真备份里的「空人格」仍可导入（四键齐全）', fullEmpty && fullEmpty.catchphrases.length === 0 && fullEmpty.version === 0)
    const hostile = fields.cleanPersonality({ name: '旺财', apiKey: 'sk-x', catchphrases: ['哼'], selfNarrative: '本鲸叫小黑今天很乖呀' })
    ok('D25 导入写不进核心设定，CORE_GUARD 心境被清空', !('name' in hostile) && !('apiKey' in hostile) && hostile.selfNarrative === '' && hostile.catchphrases[0] === '哼')

    // storyProgress：危险键跳过；全是危险键 → null；_current 单独可存
    ok('D26 cleanStoryProgress 危险键跳过、_current 单独可存',
      fields.cleanStoryProgress(JSON.parse('{"__proto__":true,"constructor":true,"prototype":true}')) === null &&
      fields.cleanStoryProgress({ _current: '甲' })._current === '甲')
    const sp = {}; for (let i = 0; i < 3000; i++) sp['book' + i + '|0'] = true
    ok('D27 说书进度最多 2000 条', Object.keys(fields.cleanStoryProgress(sp)).length === 2000)
    ok('D28 超长书键截到 400 字', Object.keys(fields.cleanStoryProgress({ ['k'.repeat(500)]: true }))[0].length === 400)
  }

  // ===========================================================================
  // E. 部分覆盖语义（经 handler，断言真实文件字节）
  // ===========================================================================
  console.log('\n[E] 部分覆盖：缺失的键不覆盖已有数据；只导一个字段不动其它文件')
  {
    const dir = tmp('partial')
    const store = createStore(dir)
    const personality = createPersonalityRepo(dir)
    // 先落一份「主人的数据」
    store.appendTurns('旧问题', '旧回答')
    store.saveMemorySummary('旧摘要')
    store.saveState({ intimacy: 66 })
    store.saveGrowth({ exp: 300, dayKey: '2026-11-07', dayExp: 4, src: { chat: 4 } })
    store.saveFishfood({ chatTokens: 100, storyTokens: 20, totalTokens: 120, costCny: 0.5, byKind: { chat: { tokens: 100, costCny: 0.5 } } })
    store.savePet({ feeds: 5, hunger: 30, mood: 'idle', lastSeen: 1, lastFeedAt: 0, intimacy: 3 })
    personality.learn({ catchphrases: ['哼'], preferences: ['白饭'], notes: '旧备注' })
    const h = createBackupHandlers(depsFor(store, personality))
    const readFile = (name) => readFileSync(join(dir, name), 'utf8')
    const snapOther = () => [readFile('memory.json'), readFile('growth.json'), readFile('fishfood.json'), readFile('pet_state.json'), readFile('personality.json')].join('|')

    // E1：只导 state → 其它文件字节不变
    const otherBefore = snapOther()
    const rState = await call(h.handleImport, mkReq({ state: { intimacy: 9 } }))
    ok('E1 只导入 state：state 落盘、其它数据文件字节不变',
      rState.json.imported.join(',') === 'state' && JSON.parse(readFile('state.json')).intimacy === 9 && snapOther() === otherBefore)
    const memBefore = readFile('memory.json')

    // E2：只有 summary 的记忆包 → skipped（不能把 history 清空）
    const rMem1 = await call(h.handleImport, mkReq({ memory: { summary: '新摘要' } }))
    ok('E2 只有 summary 的记忆包 → skipped，memory.json 不变',
      rMem1.json.skipped.indexOf('memory') >= 0 && readFile('memory.json') === memBefore, JSON.stringify(rMem1.json))

    // E3：只有 history 的记忆包 → skipped（不能把摘要清空）
    const rMem2 = await call(h.handleImport, mkReq({ memory: { history: [{ role: 'user', content: '新' }] } }))
    ok('E3 只有 history 的记忆包 → skipped，memory.json 不变',
      rMem2.json.skipped.indexOf('memory') >= 0 && readFile('memory.json') === memBefore, JSON.stringify(rMem2.json))

    // E4：空人格 / 只有核心设定键的包 → skipped（不能把整份人格清空）
    const pBefore = readFile('personality.json')
    const rP1 = await call(h.handleImport, mkReq({ personality: {} }))
    ok('E4 personality:{} → skipped，personality.json 不变',
      rP1.json.skipped.indexOf('personality') >= 0 && readFile('personality.json') === pBefore, JSON.stringify(rP1.json))
    const rP2 = await call(h.handleImport, mkReq({ personality: { name: '旺财' } }))
    ok('E5 只有核心设定键的人格包 → skipped，personality.json 不变',
      rP2.json.skipped.indexOf('personality') >= 0 && readFile('personality.json') === pBefore)

    // E6：四键齐全的人格包（真备份形状）→ 整字段替换
    const rP3 = await call(h.handleImport, mkReq({ personality: { catchphrases: ['呜'], preferences: [], notes: '', selfNarrative: '', selfNarrativeAt: '', version: 1, updatedAt: '', history: [] } }))
    ok('E6 四键齐全的人格包 → 整字段替换（c 变成「呜」）',
      rP3.json.imported.indexOf('personality') >= 0 && JSON.parse(readFile('personality.json')).catchphrases[0] === '呜')

    // E7：记录现状——导入是「整字段覆盖」（客户端确认文案同口径）：
    // 只给 chatTokens 的鱼粮包会把整份 fishfood 替换成它（缺的 totalTokens/byKind 不会由本机补回）。
    // 这是已记录的语义，不是本轮要改的 bug：真备份永远带全字段，缺字段只可能来自手改包。
    const rFF = await call(h.handleImport, mkReq({ fishfood: { chatTokens: 5 } }))
    const ffAfter = JSON.parse(readFile('fishfood.json'))
    ok('E7 鱼粮按「整字段覆盖」落盘（手改半份包会丢掉未给的计数，已记录）',
      rFF.json.imported.indexOf('fishfood') >= 0 && ffAfter.chatTokens === 5 && ffAfter.totalTokens === undefined && ffAfter.byKind === undefined,
      JSON.stringify(ffAfter))

    // E8：写盘失败只影响该字段
    const rFail = await call(createBackupHandlers(depsFor(store, personality, { saveState: () => { throw new Error('disk full') } })).handleImport,
      mkReq({ state: { intimacy: 1 }, growth: { exp: 10 } }))
    ok('E8 单字段写失败 → skipped，其它字段照导入', rFail.json.skipped.indexOf('state') >= 0 && rFail.json.imported.indexOf('growth') >= 0)
  }

  // ===========================================================================
  // F. 自动备份：保留份数 / 磁盘失败 / 同秒重复 / 时钟异常
  // ===========================================================================
  console.log('\n[F] 自动备份边界：保留份数 / 磁盘失败 / 同秒重复 / 时钟异常')
  {
    const dir = tmp('auto')
    writeFileSync(join(dir, 'state.json'), '{"intimacy":1}', 'utf8')
    writeFileSync(join(dir, 'memory.json'), '{"history":[]}', 'utf8')

    // 保留份数
    const keepDir = tmp('auto-keep')
    writeFileSync(join(keepDir, 'state.json'), '{"x":1}', 'utf8')
    for (let i = 0; i < 6; i++) backupOnce({ runtimeDir: keepDir, keep: 2, now: () => new Date(2026, 0, 1, 0, 0, i * 10).getTime() })
    const left = readdirSync(join(keepDir, AUTO_BACKUP_DIR)).filter((f) => /^auto-.*\.json$/.test(f)).sort()
    ok('F1 keep=2 只留最近 2 份（按文件名时间）', left.length === 2 && left[1] === 'auto-20260101-000050.json', left.join(','))

    // 同一秒重复备份：幂等覆盖、不留 .tmp、内容完整
    const t0 = new Date(2026, 10, 7, 11, 4, 5).getTime()
    ok('F2 同一秒重复备份幂等', backupOnce({ runtimeDir: dir, now: () => t0 }) === true && backupOnce({ runtimeDir: dir, now: () => t0 }) === true)
    const files = readdirSync(join(dir, AUTO_BACKUP_DIR))
    const snap = JSON.parse(readFileSync(join(dir, AUTO_BACKUP_DIR, 'auto-20261107-110405.json'), 'utf8'))
    ok('F3 同秒只留一个文件、无临时文件残留', files.filter((f) => /^auto-.*\.json$/.test(f)).length === 1 && files.every((f) => f.indexOf('.tmp') < 0), files.join(','))
    ok('F4 快照含 at 与数据文件原文', snap.at === t0 && JSON.parse(snap.files['state.json']).intimacy === 1 && snap.files['memory.json'] !== undefined)

    // 磁盘失败：备份目录的位置被一个同名文件占住 → 返回 false 且不抛
    const broken = tmp('auto-broken')
    writeFileSync(join(broken, 'state.json'), '{"x":1}', 'utf8')
    writeFileSync(join(broken, AUTO_BACKUP_DIR), 'not-a-dir', 'utf8')
    const rBroken = quiet(() => backupOnce({ runtimeDir: broken }))
    ok('F5 磁盘/目录失败 → 返回 false 且不抛错', rBroken.threw === null && rBroken.value === false)
    ok('F6 没有数据文件时不产出空备份', backupOnce({ runtimeDir: tmp('auto-empty') }) === false)

    // 时钟异常：now() 给 NaN / 越界毫秒 → 文件名仍合法、at 仍是有限数、诊断时间可用
    const clockNaN = tmp('auto-nan')
    writeFileSync(join(clockNaN, 'state.json'), '{"x":1}', 'utf8')
    ok('F7 时钟 NaN 也写成功', backupOnce({ runtimeDir: clockNaN, now: () => NaN }) === true)
    const nanFiles = readdirSync(join(clockNaN, AUTO_BACKUP_DIR)).filter((f) => /^auto-.*\.json$/.test(f))
    const nanSnap = JSON.parse(readFileSync(join(clockNaN, AUTO_BACKUP_DIR, nanFiles[0]), 'utf8'))
    const info = autoBackupInfo(clockNaN)
    ok('F8 时钟 NaN 不产出 auto-NaN 文件名（否则排序会顶掉真备份）',
      /^auto-\d{8}-\d{6}\.json$/.test(nanFiles[0]), nanFiles.join(','))
    ok('F9 时钟 NaN 时快照 at 仍是有限数、诊断 lastAt 可用',
      Number.isFinite(nanSnap.at) && Number.isFinite(info.lastAt) && info.lastAt > 0 && info.count === 1, JSON.stringify({ at: nanSnap.at, info }))

    const clockHuge = tmp('auto-huge')
    writeFileSync(join(clockHuge, 'state.json'), '{"x":1}', 'utf8')
    backupOnce({ runtimeDir: clockHuge, now: () => 1e20 })
    const hugeFiles = readdirSync(join(clockHuge, AUTO_BACKUP_DIR)).filter((f) => /^auto-.*\.json$/.test(f))
    ok('F10 越界毫秒（1e20）同样落成合法文件名', hugeFiles.length === 1 && /^auto-\d{8}-\d{6}\.json$/.test(hugeFiles[0]), hugeFiles.join(','))
  }

  // ===========================================================================
  // G. 封装取证：备份模块只经注入端口工作
  // ===========================================================================
  console.log('\n[G] 封装取证：备份模块不碰文件系统 / 不读 config')
  {
    const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    const code = (rel) => stripComments(readFileSync(join(ROOT, rel), 'utf8'))
    for (const rel of ['src/host/backup/fields.ts', 'src/host/backup/export.ts', 'src/host/backup/import.ts']) {
      const src = code(rel)
      ok('G1 不碰文件系统：' + rel.split('/').pop(), !/from 'node:fs'|from 'node:path'|writeFile|mkdir/.test(src))
      ok('G2 不读配置/Key：' + rel.split('/').pop(), !/from '\.\.\/config\.js'|config\.json|readApiKey|process\.env/.test(src))
    }
    const fieldsMod = await imp('src/host/backup/fields.ts')
    ok('G3 清洗器表是 null 原型（查表不会命中原型链）', Object.getPrototypeOf(fieldsMod.BACKUP_CLEANERS) === null)
    ok('G4 清洗器表已冻结', Object.isFrozen(fieldsMod.BACKUP_CLEANERS))
    ok('G5 导出上限是 2MB', BACKUP_MAX_BYTES === 2 * 1024 * 1024)
  }
} catch (err) {
  fail++
  console.error('\n  ❌ 未捕获异常：' + String((err && err.stack) || err))
} finally {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }) } catch { } }
}

console.log('\n通过 ' + pass + ' 项 / 失败 ' + fail + ' 项')
if (fail > 0) {
  console.error('❌ 备份 round-trip 专项未通过')
  process.exit(1)
}
console.log('✅ 备份 round-trip 专项全部通过')
