/**
 * scripts/test-misc-routes.mjs —— 杂项路由专项回归（B68：misc / stats / briefing / config / backup）
 *
 * 覆盖（只断言"应然"，不改 package.json / scripts/test.mjs）：
 *   A. 封装取证：五条路由不直连 store/repos/cache/prefs/data/config 实现，不读内部 json、不写盘；
 *   B. config：绝不回显 Key 内容——即使注入方把 Key 原文当布尔返回，也只出布尔；
 *   C. stats：空数据/坏数据（NaN / Infinity / 负数 / 非数字 / 字符串）不参与运算或参与后归一，
 *      亲密度与 /state、repos/state.ts 同口径 0..100，TTS/备份自检字段形状稳定；
 *   D. briefing：只认 GET/HEAD；经验展示与 /growth 同口径（非负整数）；读取器抛错/返回怪值不陪葬；
 *   E. misc：余额字段恒有值（null 而非整个键消失）、坏回包给可诊断 ok:false；状态/成长/鱼粮/宠物/
 *      缓存/清记忆的坏数据与失败分支都是 ok:false 而不是抛；
 *   F. backup：原型污染键 / 路径键 / 未知字段 / Key 字段一律进 skipped 且不写盘，体积上限 413、
 *      坏 body 400、单字段失败进 skipped、导入后说书进度刷新、导出不含 Key、序列化失败按超限处理。
 *
 * 纯离线：不联网、不起 HTTP、不碰 dist。
 * 用法：node scripts/test-misc-routes.mjs   # 失败退出码 1
 */
import { register } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

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

/** 假 res：与 host/respond.ts 的用法（writeHead + end，sendTooLarge 还会挂 error 监听）一致 */
function mkRes() {
  const out = { code: 0, headers: null, body: '', headerMap: {} }
  out.writeHead = (code, headers) => { out.code = code; out.headers = headers || null }
  out.setHeader = (k, v) => { out.headerMap[k] = v }
  out.on = () => { }
  out.end = (body) => { out.body = body ? String(body) : '' }
  out.json = () => { try { return JSON.parse(out.body) } catch { return null } }
  return out
}

/** 调一个 handler；req 缺省 GET */
async function call(handler, opts = {}) {
  const res = mkRes()
  const req = Object.assign({ url: '/api/chubby-whale/x', method: 'GET', headers: {} }, opts)
  await handler(req, res)
  return { code: res.code, json: res.json(), body: res.body, res }
}

/** 静默执行一段预期会打日志的代码（避免"预期失败"刷屏），返回 {value, logs} */
async function capture(fn) {
  const logs = []
  const realError = console.error
  const realWarn = console.warn
  const realLog = console.log
  console.error = (...a) => logs.push(a.join(' '))
  console.warn = (...a) => logs.push(a.join(' '))
  console.log = (...a) => logs.push(a.join(' '))
  try {
    return { value: await fn(), logs }
  } finally {
    console.error = realError
    console.warn = realWarn
    console.log = realLog
  }
}

/** 导入请求：body 可以是对象（序列化）或原始字符串 */
function mkImportReq(body, over = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const buf = Buffer.from(text, 'utf8')
  return Object.assign({
    method: 'POST',
    url: '/api/chubby-whale/data/import',
    headers: {},
    destroy() { },
    on() { },
    resume() { },
    async *[Symbol.asyncIterator]() { yield buf },
  }, over)
}

const isNonNegInt = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v

// ===========================================================================
// A. 封装取证：五条路由只经注入端口取状态
// ===========================================================================
console.log('\n[A] 封装边界：五条路由不直连实现 host/routes/{misc,stats,briefing,config,backup}.ts')
try {
  const FIVE = [
    'src/host/routes/misc.ts',
    'src/host/routes/stats.ts',
    'src/host/routes/briefing.ts',
    'src/host/routes/config.ts',
    'src/host/routes/backup.ts',
  ]
  /** 静态取证只看代码，不看注释（否则「不读 config.json」这类说明会被自己误报） */
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const readCode = (rel) => stripComments(readFileSync(join(ROOT, rel), 'utf8'))
  // 与 scripts/check-imports.mjs 规则 A / check-boundaries B6 同一份清单（这里做路由侧取证）
  const forbidden = [
    ["../store.js", /from '\.\.\/store\.js'/],
    ["../cache.js", /from '\.\.\/cache\.js'/],
    ["../prefs.js", /from '\.\.\/prefs\.js'/],
    ["../chat-core.js", /from '\.\.\/chat-core\.js'/],
    ['../repos/', /from '\.\.\/repos\//],
    ['../data/', /from '\.\.\/data\//],
    ['../config.js', /from '\.\.\/config\.js'/],
  ]
  for (const rel of FIVE) {
    const src = readCode(rel)
    const hit = forbidden.filter(([, re]) => re.test(src)).map(([spec]) => spec)
    ok('路由不直连实现：' + rel.split('/').pop(), hit.length === 0, hit.join(',') || '仅注入端口')
  }

  // 只读 config.json / 环境变量 / Key 读取器的路由，等于把「配置」这条线也变成隐式依赖
  for (const rel of FIVE) {
    const src = readCode(rel)
    const bad = []
    if (src.indexOf('config.json') >= 0) bad.push('config.json')
    if (/readApiKey\s*\(/.test(src)) bad.push('readApiKey()')
    if (/from 'node:fs'/.test(src) && rel.indexOf('routes/misc.ts') < 0) bad.push('node:fs')
    ok('不读内部配置/Key：' + rel.split('/').pop(), bad.length === 0, bad.join(',') || '无')
  }

  // 路由不得直接写盘（数据落盘只经注入的 save*；misc 的 readFile 只读固定 assetPath）
  for (const rel of FIVE) {
    const src = readCode(rel)
    ok('路由不自己写盘：' + rel.split('/').pop(), !/writeFile|writeFileSync|createWriteStream|mkdir|rmSync/.test(src))
  }

  // backup 的实现层（fields/export/import）同样不碰文件系统：没有路径参数 → 没有路径穿越面
  for (const rel of ['src/host/backup/fields.ts', 'src/host/backup/export.ts', 'src/host/backup/import.ts']) {
    const src = readCode(rel)
    ok('备份实现层不碰文件系统：' + rel.split('/').pop(), !/from 'node:fs'|from 'node:path'/.test(src))
  }
} catch (e) {
  ok('能完成封装边界取证', false, String(e.message))
}

// ===========================================================================
// B. config：绝不回显 Key 内容
// ===========================================================================
console.log('\n[B] 只读配置 host/routes/config.ts（只报有没有 Key，绝不回显）')
try {
  const { createConfigViewHandler } = await imp('src/host/routes/config.ts')

  // B1：注入方误把「Key 原文」当布尔返回（例如直接把 readApiKey 传进来）——响应里也只许出现布尔
  {
    const h = createConfigViewHandler({
      hasDeepseekKey: () => 'sk-live-DS-SECRET-123456',
    })
    const r = await call(h.handleConfig)
    ok('Key 读取器误返回原文 → 只出布尔', r.json && r.json.ok === true && r.json.hasDeepseekKey === true, JSON.stringify(r.json))
    ok('响应体不含任何 Key 内容', r.body.indexOf('sk-live') < 0)
    ok('布尔字段类型是 boolean', typeof r.json.hasDeepseekKey === 'boolean')
  }

  // B2：getter 全部抛错 → 不 500、逐字段兜底，ok 仍为 true
  {
    const boom = () => { throw new Error('config reader down') }
    const h = createConfigViewHandler({
      enabled: boom, dataSource: boom, model: boom,
      personalityLearning: boom, personalityWriting: boom, cacheEnabled: boom,
      hasDeepseekKey: boom,
    })
    const r = await capture(() => call(h.handleConfig))
    const j = r.value.json
    ok('getter 抛错 → 各字段兜底且 ok:true', j && j.ok === true && j.enabled === true && j.dataSource === 'local' && j.model === '', JSON.stringify(j))
    ok('getter 抛错 → Key 字段回落 false（不是异常文本）', j.hasDeepseekKey === false)
  }

  // B3：非 GET/HEAD → 405（与 stats/backup 的同口径）
  {
    const h = createConfigViewHandler({})
    const r = await call(h.handleConfig, { method: 'POST' })
    ok('配置非 GET → 405', r.code === 405 && r.json && r.json.error === 'METHOD_NOT_ALLOWED')
  }
} catch (e) {
  ok('能加载配置视图', false, String(e.message))
}

// ===========================================================================
// C. stats：空数据 / 坏数据 / 口径
// ===========================================================================
console.log('\n[C] 统计路由 host/routes/stats.ts（空数据、坏数据、与 /state 同口径）')
try {
  const { createStatsHandler } = await imp('src/host/routes/stats.ts')

  // C1：全部空数据 → 全零、阶段初识、不出现 null/NaN
  {
    const h = createStatsHandler({
      cacheStats: async () => ({}),
      loadState: () => ({}),
      loadGrowth: () => ({}),
      loadFishfood: () => ({}),
    })
    const r = await call(h.handleStats)
    const j = r.json
    ok('空数据 → ok 且各块齐全', j && j.ok === true && j.cache && j.fishfood && j.growth && j.personality)
    ok('空数据 → 缓存/鱼粮/亲密度全 0', j.cache.tts === 0 && j.cache.chat === 0 && j.cache.asr === 0 &&
      j.fishfood.total === 0 && j.intimacy === 0, JSON.stringify(j))
    ok('空数据 → 初识（下一门槛 200）', j.growth.exp === 0 && j.growth.stage === '初识' && j.growth.nextExp === 200)
    ok('空数据 → uptimeMs 是 0 不是 null', j.uptimeMs === 0 && isNonNegInt(j.uptimeMs))
    ok('空数据 → 人格四字段为空且类型稳定', Array.isArray(j.personality.catchphrases) && j.personality.notes === '' && j.personality.selfNarrative === '')
  }

  // C2：坏数据参与运算的每一种形态
  {
    const h = createStatsHandler({
      cacheStats: async () => ({ tts: Number.NaN, chat: -3, asr: '42' }),
      loadState: () => ({ intimacy: 250 }),
      loadGrowth: () => ({ exp: Number.POSITIVE_INFINITY }),
      loadFishfood: () => ({ chatTokens: undefined, storyTokens: -7 }),
      loadPersonality: () => ({ catchphrases: [1, '哼', null], preferences: {}, notes: 42, selfNarrative: null }),
      startedAt: 1000,
      now: () => Number.NaN,
    })
    const r = await call(h.handleStats)
    const j = r.json
    ok('缓存坏值 → NaN/负归 0、数字串照算', j.cache.tts === 0 && j.cache.chat === 0 && j.cache.asr === 42, JSON.stringify(j.cache))
    ok('鱼粮坏值 → undefined/负归 0', j.fishfood.chatTokens === 0 && j.fishfood.storyTokens === 0 && j.fishfood.total === 0)
    ok('成长 Infinity → 0 且阶段初识', j.growth.exp === 0 && j.growth.stage === '初识')
    ok('亲密度与 /state 同口径：超 100 截到 100', j.intimacy === 100, String(j.intimacy))
    ok('uptimeMs 参与运算后仍是数字（NaN 时钟 → 0）', j.uptimeMs === 0 && isNonNegInt(j.uptimeMs), String(j.uptimeMs))
    ok('人格列表只留字符串、非字符串 notes 归空', j.personality.catchphrases.length === 1 && j.personality.catchphrases[0] === '哼' && j.personality.notes === '')
    ok('序列化后没有 NaN/null 漏进数值字段', !/"(intimacy|uptimeMs|total|exp|nextExp)":null/.test(r.body), r.body.slice(0, 120))
  }

  // C3：自检字段（TTS / 备份）形状必须稳定：外部给怪值也不能把 null/字符串漏出去
  {
    const h = createStatsHandler({
      cacheStats: async () => ({}),
      loadState: () => ({}),
      loadGrowth: () => ({}),
      loadFishfood: () => ({}),
      tts: { available: 'yes', interpreter: 42, cooling: 0 },
      backup: { lastAt: Number.NaN, count: -2 },
    })
    const r = await call(h.handleStats)
    const j = r.json
    ok('TTS 自检字段：非布尔不猜测（按 false）、解释器归空串',
      j.tts.available === false && j.tts.interpreter === '' && j.tts.cooling === false, JSON.stringify(j.tts))
    ok('备份自检字段：NaN/负数归 0（不会变成 null / 负数份数）',
      j.backup.lastAt === 0 && j.backup.count === 0, JSON.stringify(j.backup))
  }

  // C4：失败分支是可诊断的 ok:false（不抛、不 500）
  {
    const h = createStatsHandler({
      cacheStats: async () => ({}),
      loadState: () => ({}),
      loadGrowth: () => { throw new Error('growth down') },
      loadFishfood: () => ({}),
    })
    const r = await capture(() => call(h.handleStats))
    ok('读取器抛错 → ok:false + 可读 error（不抛）', r.value.json && r.value.json.ok === false && /growth down/.test(String(r.value.json.error)), JSON.stringify(r.value.json))
    ok('读取器抛错 → 仍然是 HTTP 200 的业务失败', r.value.code === 200)
  }

  // C5：非 GET → 405
  {
    const h = createStatsHandler({ cacheStats: async () => ({}), loadState: () => ({}), loadGrowth: () => ({}), loadFishfood: () => ({}) })
    const r = await call(h.handleStats, { method: 'POST' })
    ok('统计非 GET → 405', r.code === 405 && r.json && r.json.error === 'METHOD_NOT_ALLOWED')
  }
} catch (e) {
  ok('能加载统计路由', false, String(e.message))
}

// ===========================================================================
// D. briefing：方法校验 / 坏数据 / 与 /growth 同口径
// ===========================================================================
console.log('\n[D] 今日简报 host/routes/briefing.ts')
try {
  const { createBriefingHandlers } = await imp('src/host/routes/briefing.ts')
  const realFetch = globalThis.fetch
  let fetched = 0
  globalThis.fetch = async () => {
    fetched++
    return { ok: true, status: 200, text: async () => '晴 +18°C' }
  }

  // D1：正常路径（日期 / 天气 / 成长 / 待办四段）
  {
    const h = createBriefingHandlers({ loadGrowth: () => ({ exp: 200 }), loadReminders: () => [{ done: false }, { done: true }] })
    const r = await call(h.handleBriefing)
    const t = String(r.json && r.json.text)
    ok('简报：ok + 四段内容', r.json.ok === true && /星期[日一二三四五六]/.test(t) && t.indexOf('北海天气：晴 +18°C') >= 0 && t.indexOf('肥鲸成长：熟悉（200）') >= 0 && t.indexOf('待办提醒：1 条') >= 0, t.replace(/\n/g, ' | '))
  }

  // D2：只认 GET/HEAD，非 GET 不许外呼天气
  {
    const h = createBriefingHandlers({ loadGrowth: () => ({ exp: 0 }), loadReminders: () => [] })
    const before = fetched
    const r = await call(h.handleBriefing, { method: 'POST' })
    ok('简报 POST → 405 METHOD_NOT_ALLOWED', r.code === 405 && r.json && r.json.error === 'METHOD_NOT_ALLOWED', JSON.stringify(r.json))
    ok('简报非 GET 不外呼天气', fetched === before, 'fetch ' + fetched)
  }

  // D3：经验值与 /growth 同口径（非负整数）——负数不能直接写进简报
  {
    const h = createBriefingHandlers({ loadGrowth: () => ({ exp: -5 }), loadReminders: () => [] })
    const r = await call(h.handleBriefing)
    const t = String(r.json && r.json.text)
    ok('简报负数经验归 0（与 /growth 同口径）', t.indexOf('肥鲸成长：初识（0）') >= 0 && t.indexOf('-5') < 0, t.split('\n').join(' | '))
  }

  // D4：读取器抛错 / 返回怪值 → 其它段不能陪葬
  {
    const h = createBriefingHandlers({
      loadGrowth: () => { throw new Error('growth down') },
      loadReminders: () => ({}),   // 非数组：拿不到条数，就别编一个 0 条出来
    })
    const r = await capture(() => call(h.handleBriefing))
    const j = r.value.json
    ok('成长读取器抛错 → 简报仍出（有日期，无成长段）', j && j.ok === true && /星期[日一二三四五六]/.test(j.text) && j.text.indexOf('肥鲸成长') < 0)
    ok('提醒读取器返回非数组 → 无待办段且不抛', j && j.text.indexOf('待办提醒') < 0, j && j.text.split('\n').join(' | '))
    const h2 = createBriefingHandlers({ loadGrowth: () => ({}), loadReminders: () => null })
    const r2 = await capture(() => call(h2.handleBriefing))
    const t2 = String(r2.value.json && r2.value.json.text)
    ok('提醒读取器返回 null → 同样不出待办段（不编 0 条）', r2.value.json.ok === true && t2.indexOf('待办提醒') < 0, t2.split('\n').join(' | '))
  }

  // D5：提醒数组里混入坏项：坏项丢弃，好项照数（此前 null 项会把整段打没）
  {
    const h = createBriefingHandlers({ loadGrowth: () => ({}), loadReminders: () => [null, { done: false }, undefined, { done: true }] })
    const r = await call(h.handleBriefing)
    const t = String(r.json && r.json.text)
    ok('提醒含坏项 → 只数未完成的好项', t.indexOf('待办提醒：1 条') >= 0, t.split('\n').join(' | '))
  }

  // D6：天气失败不连带
  {
    globalThis.fetch = async () => { throw new Error('weather down') }
    const h = createBriefingHandlers({ loadGrowth: () => ({ exp: 0 }), loadReminders: () => [] })
    const r = await capture(() => call(h.handleBriefing))
    ok('天气失败 → 仍 ok:true 且无天气段', r.value.json && r.value.json.ok === true && r.value.json.text.indexOf('北海天气') < 0)
  }
  globalThis.fetch = realFetch
} catch (e) {
  ok('能加载简报路由', false, String(e.message))
}

// ===========================================================================
// E. misc：余额 / 状态 / 成长 / 鱼粮 / 宠物 / 缓存 / 清记忆
// ===========================================================================
console.log('\n[E] 只读状态 host/routes/misc.ts')
try {
  const { createMiscHandlers } = await imp('src/host/routes/misc.ts')
  const realFetch = globalThis.fetch
  const mk = (over = {}) => createMiscHandlers({
    assetPath: join(ROOT, 'assets', 'nope.png'),
    getKey: () => 'sk-secret',
    loadState: () => ({ intimacy: 100 }),
    loadGrowth: () => ({ exp: 250 }),
    loadFishfood: () => ({ chatTokens: 100, storyTokens: 20 }),
    loadPet: () => ({ feeds: 5, hunger: 0, mood: 'happy', intimacy: 8 }),
    feedPet: () => ({ feeds: 6, hunger: 0, mood: 'happy' }),
    loadIntimacy: () => 100,
    bumpIntimacy: () => 100,
    ...over,
  })

  // E1：余额回包缺 total_balance —— 字段必须还在（null），不能整个键消失
  {
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ balance_infos: [{}] }) })
    const r = await call(mk().handleBalance)
    ok('余额缺字段 → balance:null 仍在（不是缺键）', r.json.ok === true && 'balance' in r.json && r.json.balance === null, r.body)
    ok('余额缺字段 → currency 兜底 CNY', r.json.currency === 'CNY', r.body)
  }

  // E2：余额回包形状坏（balance_infos 不是数组）→ 可诊断 ok:false，不抛
  {
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ balance_infos: 'oops' }) })
    const r = await capture(() => call(mk().handleBalance))
    ok('余额坏回包 → ok:false（BAD_RESPONSE）不抛', r.value.json && r.value.json.ok === false && r.value.json.error === 'BAD_RESPONSE' && r.value.json.balance === null, JSON.stringify(r.value.json))
  }

  // E3：余额正常值原样透传（regression）
  {
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ balance_infos: [{ currency: 'CNY', total_balance: '12.50' }, { currency: 'USD', total_balance: '1.00' }] }) })
    const r = await call(mk().handleBalance)
    ok('余额优先取 CNY 且原样透传', r.json.ok === true && r.json.balance === '12.50' && r.json.currency === 'CNY')
  }

  // E4：无 Key → NO_KEY（不联网）
  {
    let asked = 0
    globalThis.fetch = async () => { asked++; return { ok: true, status: 200, text: async () => '{}' } }
    const r = await call(mk({ getKey: () => '' }).handleBalance)
    ok('无 Key → NO_KEY 且不联网', r.json.ok === false && r.json.error === 'NO_KEY' && r.json.balance === null && asked === 0)
  }
  globalThis.fetch = realFetch

  // E5：状态/成长/鱼粮的坏值归零（与/state 0..100 同口径）
  {
    const h = mk({ loadState: () => ({ intimacy: 250 }), loadGrowth: () => ({ exp: Number.NaN }), loadFishfood: () => ({ chatTokens: -1, storyTokens: 'x' }) })
    ok('/state 超上限截到 100', (await call(h.handleState)).json.intimacy === 100)
    const r1 = await call(mk({ loadState: () => ({ intimacy: -5 }) }).handleState)
    ok('/state 负数归 0', r1.json.intimacy === 0)
    const r2 = await call(mk({ loadState: () => ({ intimacy: 'abc' }) }).handleState)
    ok('/state 非数字归 0', r2.json.intimacy === 0)
    const g = (await call(h.handleGrowth)).json
    ok('/growth NaN → 0 初识', g.ok === true && g.exp === 0 && g.stage === '初识')
    const f = (await call(h.handleFishfood)).json
    ok('/fishfood 坏值 → 0 且 total 为 0', f.ok === true && f.chatTokens === 0 && f.storyTokens === 0 && f.total === 0)
  }

  // E6：宠物喂食的亲密度以 state 为准并被夹到 100
  {
    const h = mk({ bumpIntimacy: () => 250 })
    const r = await call(h.handlePet, { url: '/api/chubby-whale/pet?action=feed' })
    ok('喂食返回 state 亲密度并夹到 100', r.json.ok === true && r.json.pet.intimacy === 100 && r.json.pet.feeds === 6, JSON.stringify(r.json.pet))
  }
  {
    const h = mk({ bumpIntimacy: () => { throw new Error('bump failed') }, loadIntimacy: () => 42 })
    const r = await capture(() => call(h.handlePet, { url: '/api/chubby-whale/pet?action=feed' }))
    ok('加分失败 → 回落到 injected loadIntimacy', r.value.json.ok === true && r.value.json.pet.intimacy === 42)
  }

  // E7：缓存路由的方法与 action 校验
  {
    let cleared = -1
    const h = mk({ clearChatCache: async () => { cleared = 3; return 3 } })
    const bad = await call(h.handleCache, { url: '/api/chubby-whale/cache?action=bogus' })
    ok('/cache 非法 action → 400 BAD_ACTION', bad.code === 400 && bad.json.error === 'BAD_ACTION')
    const del = await call(h.handleCache, { url: '/api/chubby-whale/cache', method: 'DELETE' })
    ok('/cache DELETE → 清空并报数', del.json.ok === true && del.json.cleared === 3 && cleared === 3)
    const stat = await call(mk({ chatCacheCount: async () => 4 }).handleCache)
    ok('/cache GET（无分类统计）→ count = 聊天缓存条数', stat.json.ok === true && stat.json.count === 4 && Object.keys(stat.json.byType).length === 0)
    const by = await call(mk({ cacheStats: async () => ({ tts: 7, chat: 4, asr: 3 }) }).handleCache)
    ok('/cache GET（有分类统计）→ byType + 汇总数', by.json.ok === true && by.json.count === 14 && by.json.byType.tts === 7)
    const down = await capture(() => call(mk({ cacheStats: async () => { throw new Error('cache down') }, chatCacheCount: async () => 2 }).handleCache))
    ok('缓存统计读取失败 → 不许整页失败', down.value.json.ok === true && down.value.json.count === 2)
  }

  // E8：清记忆：记忆失败也要清缓存并给可诊断 ok:false
  {
    let cleared = 0
    const h = mk({ clearMemory: () => { throw new Error('memory down') }, clearChatCache: async () => { cleared = 2; return 2 } })
    const r = await capture(() => call(h.handleClearMemory))
    ok('清记忆失败 → ok:false + 仍清缓存并报数', r.value.json.ok === false && /memory down/.test(String(r.value.json.error)) && r.value.json.cacheCleared === 2 && cleared === 2, JSON.stringify(r.value.json))
    const okRes = await call(mk({ clearMemory: () => { }, clearChatCache: async () => 0 }).handleClearMemory)
    ok('清记忆成功 → ok:true 且 cacheCleared 是数字', okRes.json.ok === true && isNonNegInt(okRes.json.cacheCleared))
  }

  // E9：状态：只报有没有 Key
  {
    const r = await call(mk().handleStatus)
    ok('/status 只出布尔 key，不含 Key 内容', r.json.ok === true && r.json.key === true && r.body.indexOf('sk-secret') < 0)
    const r2 = await call(mk({ getKey: () => { throw new Error('key reader down') } }).handleStatus)
    ok('/status Key 读取器抛错 → ok:false 且 key:false', r2.json.ok === false && r2.json.key === false)
  }

  // E10：资源缺失 → 404 纯文本（不是 JSON 500）
  {
    const r = await call(mk().handleAsset)
    ok('/asset 缺失 → 404', r.code === 404 && r.body.indexOf('asset not found') >= 0)
  }
} catch (e) {
  ok('能加载只读状态路由', false, String(e.message))
}

// ===========================================================================
// F. backup：白名单 / 原型污染 / 体积 / 错误页 / 导入上限
// ===========================================================================
console.log('\n[F] 备份导出/导入 host/routes/backup.ts')
try {
  const { createBackupHandlers, BACKUP_MAX_BYTES } = await imp('src/host/routes/backup.ts')
  const saved = {}
  const notes = { story: 0 }
  const deps = {
    version: '1.1.53',
    loadMemory: () => ({ history: [{ role: 'user', content: '主人好' }], summary: '摘要' }),
    saveMemory: (m) => { saved.memory = m },
    loadPersonality: () => ({ name: '不该导出', apiKey: 'sk-live-DS-SECRET', catchphrases: ['哼'], preferences: ['白饭'], notes: '备注', selfNarrative: '自述' }),
    savePersonality: (p) => { saved.personality = p; return true },
    loadState: () => ({ intimacy: 100 }),
    saveState: (o) => { saved.state = o },
    loadGrowth: () => ({ exp: 10 }),
    saveGrowth: (o) => { saved.growth = o },
    loadFishfood: () => ({ chatTokens: 1 }),
    saveFishfood: (o) => { saved.fishfood = o },
    loadPet: () => ({ feeds: 5 }),
    savePet: (o) => { saved.pet = o },
    loadReminders: () => [{ text: '喝水', at: '2026-11-07T00:00:00.000Z' }],
    saveReminders: (a) => { saved.reminders = a },
    loadStoryProgress: () => ({ 'local:甲|0': true }),
    saveStoryProgress: (o) => { saved.storyProgress = o },
    onStoryProgressImported: () => { notes.story++ },
    now: () => new Date('2026-11-07T00:00:00.000Z'),
  }
  const mk = (over = {}) => createBackupHandlers({ ...deps, ...over })
  const reset = () => { for (const k of Object.keys(saved)) delete saved[k]; notes.story = 0 }

  // F1：导出：8 个数据字段 + 元数据；人格核心设定与 Key 字段都不出现
  {
    const r = await call(mk().handleExport)
    const exp = r.json
    const fields = ['memory', 'personality', 'state', 'growth', 'fishfood', 'pet', 'reminders', 'storyProgress']
    ok('导出：8 个字段齐全 + 元数据', exp.ok === true && fields.every((k) => k in exp) && exp.version === '1.1.53' && exp.exportedAt === '2026-11-07T00:00:00.000Z')
    ok('导出：人格只出可变层（name/apiKey 被剥掉）', !('name' in exp.personality) && !('apiKey' in exp.personality) && Array.isArray(exp.personality.catchphrases))
    ok('导出：响应体不含 Key 原文', r.body.indexOf('sk-live') < 0)
  }

  // F2：导出序列化失败（循环引用）→ 413 TOO_LARGE（不是 500/半包）
  {
    const circular = {}
    circular.self = circular
    const r = await capture(() => call(mk({ loadState: () => circular }).handleExport))
    ok('导出序列化失败 → 413 TOO_LARGE', r.value.code === 413 && r.value.json && r.value.json.error === 'TOO_LARGE' && r.value.json.limit === BACKUP_MAX_BYTES)
  }

  // F3：导出非 GET/HEAD → 405
  {
    const r = await call(mk().handleExport, { method: 'POST' })
    ok('导出非 GET → 405', r.code === 405 && r.json.error === 'METHOD_NOT_ALLOWED')
  }

  // F4：导入原型污染键 / 路径键 / Key 字段 / 未知字段 → 全部 skipped，不写盘、不污染
  {
    reset()
    // 必须用原始 JSON 文本：对象字面量里的 __proto__ 会改原型而不是造自有键
    const raw = '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":{"polluted":true},'
      + '"apiKey":"sk-live-DS-SECRET","deepseekKey":"x","config":{"enabled":false},"../../evil":"x",'
      + '"state":{"intimacy":7}}'
    const r = await capture(() => call(mk().handleImport, {
      method: 'POST', url: '/api/chubby-whale/data/import', headers: {},
      destroy() { }, on() { }, resume() { },
      async *[Symbol.asyncIterator]() { yield Buffer.from(raw, 'utf8') },
    }))
    const j = r.value.json
    const mustSkip = ['__proto__', 'constructor', 'prototype', 'apiKey', 'deepseekKey', 'config', '../../evil']
    ok('导入：原型/路径/Key/未知键全部进 skipped', j && j.ok === true && mustSkip.every((k) => j.skipped.indexOf(k) >= 0), j && j.skipped.join(','))
    ok('导入：白名单字段照常落盘', j && j.imported.length === 1 && j.imported[0] === 'state' && saved.state.intimacy === 7, j && j.imported.join(','))
    ok('导入：Object.prototype 未被污染', ({}).polluted === undefined && Object.prototype.polluted === undefined, String(({}).polluted))
  }

  // F5：坏 body：空体 / null / 数组 / 标量 → 400 BAD_BODY（不是"导入成功 0 项"）
  {
    reset()
    const cases = ['', 'null', '[]', '123', 'not-json']
    for (const text of cases) {
      const r = await capture(() => call(mk().handleImport, {
        method: 'POST', url: '/api/chubby-whale/data/import', headers: {},
        destroy() { }, on() { }, resume() { },
        async *[Symbol.asyncIterator]() { yield Buffer.from(text, 'utf8') },
      }))
      ok('导入坏 body(' + JSON.stringify(text) + ') → 400 BAD_BODY', r.value.code === 400 && r.value.json.error === 'BAD_BODY', JSON.stringify(r.value.json))
    }
    ok('坏 body 不落任何字段', Object.keys(saved).length === 0)
  }

  // F6：体积上限（读取阶段按 content-length 先拒）→ 413，且一个字段都没写
  {
    reset()
    let pulled = false
    const req = {
      method: 'POST', url: '/api/chubby-whale/data/import',
      headers: { 'content-length': String(BACKUP_MAX_BYTES + 1) },
      destroy() { }, on() { }, resume() { },
      async *[Symbol.asyncIterator]() { pulled = true; yield Buffer.from('{}', 'utf8') },
    }
    const r = await capture(() => call(mk().handleImport, req))
    ok('导入超 2MB → 413 TOO_LARGE', r.value.code === 413 && r.value.json.error === 'too large', r.value.body)
    ok('导入超限 → 不读流、不落盘', pulled === false && Object.keys(saved).length === 0)
  }

  // F7：导入非 POST → 405
  {
    const r = await call(mk().handleImport, { method: 'GET' })
    ok('导入非 POST → 405', r.code === 405 && r.json.error === 'METHOD_NOT_ALLOWED')
  }

  // F8：单字段写失败 → 进 skipped，其它字段仍导入
  {
    reset()
    const r = await capture(() => call(mk({ saveState: () => { throw new Error('disk full') } }).handleImport, mkImportReq({ state: { intimacy: 1 }, growth: { exp: 2 } })))
    const j = r.value.json
    ok('单字段写失败 → skipped，其它字段照导入', j && j.ok === true && j.skipped.indexOf('state') >= 0 && j.imported.indexOf('growth') >= 0 && saved.growth.exp === 2, JSON.stringify(j))
  }

  // F9：说书进度导入后刷新内存；保存失败则不刷新
  {
    reset()
    const r = await call(mk().handleImport, mkImportReq({ storyProgress: { 'local:甲|1': true } }))
    ok('说书进度导入 → 刷新播放器内存 1 次', r.json.ok === true && r.json.imported.indexOf('storyProgress') >= 0 && notes.story === 1)
    reset()
    const bad = await capture(() => call(mk({ saveStoryProgress: () => { throw new Error('nope') } }).handleImport, mkImportReq({ storyProgress: { 'local:甲|1': true } })))
    ok('说书进度写失败 → skipped 且不刷新', bad.value.json.ok === true && bad.value.json.skipped.indexOf('storyProgress') >= 0 && notes.story === 0)
  }

  // F10：字段级上限（内存 40 条 / 单条 8000 字 / 提醒 200 条）在导入链路上真的生效
  {
    reset()
    // 序号放前缀：截断到 8000 字时仍能看出「保留的是最新 40 条」
    const history = Array.from({ length: 100 }, (_, i) => ({ role: 'user', content: '#' + i + 'x'.repeat(9000) }))
    await call(mk().handleImport, mkImportReq({ memory: { history, summary: 's' } }))
    const got = saved.memory
    ok('记忆导入只保留最新 40 条', got && got.history.length === 40, got && String(got.history.length))
    ok('记忆导入单条截到 8000 字且保留最新', got && got.history[0].content.length === 8000 &&
      got.history[0].content.startsWith('#60') && got.history[39].content.startsWith('#99'),
      got && (got.history[0].content.slice(0, 4) + '…' + got.history[39].content.slice(0, 4)))

    reset()
    const reminders = Array.from({ length: 300 }, (_, i) => ({ text: '提醒' + i, at: '2026-11-07T00:00:00.000Z' }))
    await call(mk().handleImport, mkImportReq({ reminders }))
    ok('提醒导入只保留最新 200 条', saved.reminders && saved.reminders.length === 200, saved.reminders && String(saved.reminders.length))
  }

  // F11：严格类型（字符串数字不算数字）→ skipped，不写盘
  {
    reset()
    const r = await call(mk().handleImport, mkImportReq({ state: { intimacy: '88' } }))
    ok('导入严格类型：intimacy 是字符串 → skipped', r.json.ok === true && r.json.skipped.indexOf('state') >= 0 && saved.state === undefined)
  }

  // F12：元数据认识但不写盘，也不进 skipped
  {
    reset()
    const r = await call(mk().handleImport, mkImportReq({ ok: true, version: '1.1.53', exportedAt: '2026-11-07T00:00:00.000Z' }))
    ok('导入元数据不写盘也不进 skipped', r.json.ok === true && r.json.imported.length === 0 && r.json.skipped.length === 0 && Object.keys(saved).length === 0)
  }
} catch (e) {
  ok('能加载备份路由', false, String(e.message))
}

console.log('\n[C2] 统计路由支持 getter（值要反映「现在」，getter 抛错按缺省）')
try {
  const { createStatsHandler } = await imp('src/host/routes/stats.ts')
  let ds = 'local'
  let bk = { lastAt: 1, count: 2 }
  let mode = 0
  const h = createStatsHandler({
    cacheStats: async () => ({}),
    loadState: () => ({}),
    loadGrowth: () => ({ exp: 0 }),
    loadFishfood: () => ({}),
    loadPersonality: () => ({}),
    startedAt: Date.now(),
    dataSource: () => ds,
    model: () => 'm-' + mode,
    backup: () => bk,
    tts: () => {
      if (mode === 2) throw new Error('boom')
      return { available: mode === 0, interpreter: 'python', cooling: false }
    },
  })
  const r1 = (await call(h.handleStats)).json
  ok('getter：首次取值', r1.ok === true && r1.dataSource === 'local' && r1.model === 'm-0' && r1.backup.count === 2 && r1.backup.lastAt === 1 && r1.tts.available === true && r1.tts.interpreter === 'python', JSON.stringify({ d: r1.dataSource, m: r1.model, b: r1.backup, t: r1.tts }))
  ds = 'cloud'
  bk = { lastAt: 9, count: 7 }
  mode = 1
  const r2 = (await call(h.handleStats)).json
  ok('getter：第二次取到新值（不是加载时快照）', r2.dataSource === 'cloud' && r2.model === 'm-1' && r2.backup.count === 7 && r2.backup.lastAt === 9, JSON.stringify({ d: r2.dataSource, m: r2.model, b: r2.backup }))
  ok('getter：返回「未确认可用」时 tts.available=false', r2.tts.available === false && r2.tts.interpreter === 'python')
  mode = 2
  const r3 = await capture(() => call(h.handleStats))
  const j3 = r3.value.json
  ok('getter 抛错 → 回落缺省且 ok:true（不把异常抛给 /stats）', j3.ok === true && j3.tts.available === false && j3.tts.interpreter === '', JSON.stringify(j3.tts))
} catch (e) {
  ok('能加载统计路由（getter 用例）', false, String(e.message))
}

// ===========================================================================
console.log('\n结果：通过 ' + pass + ' 项 / 失败 ' + fail + ' 项')
if (fail > 0) {
  console.error('❌ 杂项路由专项回归未通过')
  process.exit(1)
}
console.log('✅ 杂项路由专项回归全部通过')
