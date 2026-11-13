/**
 * scripts/test-assembly.mjs —— 装配层 / 路由表专项（B78 分身·装配层）
 *
 * 这份脚本只看「组装」本身，不碰业务：
 *   A. 路由表 ↔ 真实 handler 工厂：一一对应（无漏注册、无重复注册）
 *   B. 路径形状：唯一、统一前缀、无空段/尾斜杠/大写
 *   C. src/index.ts 静态装配契约：
 *      · 清理器一律经 ctx.effect 托管（cordis 没有 dispose 事件）
 *      · 自动备份 / 路由 / TTS 常驻 worker 三处都有清理器
 *      · 云端 TTS 真的接进了 /tts（三层降级不是两层）
 *      · /stats 的四项自检传的是 getter（新鲜值），且 ttsStatOf 适配函数仍在
 *      · /data/import 的 clearChatCache 仍在
 *   D. 具名导入全部有使用（防死导入回流）
 *   E. src/host/routes/ 下的每个 handler 工厂都在 index.ts 里接线了
 *
 * 纯离线：不联网、不写运行数据、不起子进程（TTS 路由注入假引擎，不做 warm 探测）。
 * 用法：node scripts/test-assembly.mjs
 * 退出码：0=通过；1=有失败
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SRC = join(ROOT, 'src')
// 源码里跨模块导入写的是编译后的 `.js`；测试直接加载 `.ts`，用仓库既有钩子把 .js 回退到同名 .ts
register(new URL('./ts-resolve.mjs', import.meta.url))

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.error('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

/** 直接 import 源码（Node ≥22.6 的类型擦除；与 scripts/test.mjs 同一手法） */
function load(rel) {
  return import(pathToFileURL(join(SRC, rel)).href)
}

const indexRaw = readFileSync(join(SRC, 'index.ts'), 'utf8')
/**
 * 去注释后的代码视图：注释里会解释「为什么不用 ctx.on('dispose')」，
 * 直接扫原文会把这段说明误判成实际用法（静态扫描必须只看代码）。
 * `//` 前若是 `:` 则保留（不碰 URL 里的 `//`）。
 */
const indexSrc = indexRaw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

// ---------- A. 路由表 ↔ 真实 handler 工厂：一一对应 ----------
console.log('\n[A] 路由表 ↔ handler 工厂（一一对应）')
const tmp = mkdtempSync(join(tmpdir(), 'whale-assembly-'))
try {
  const { createRouteTable } = await load('host/routes.ts')

  const dataPort = {
    readStoryIndex: async () => [],
    readStoryBook: async () => [],
    readCulture: async () => [],
    readPoemsChunk: async (i) => ({ index: Number(i) || 0, total: 1, items: [] }),
    readDuilian: async () => ({ total: 0, items: [], cats: {} }),
    readDaily: async () => [],
  }
  const player = {
    books: async () => [],
    start: async () => ({ error: 'no book' }),
    next: async () => ({ error: 'no book' }),
    reset: async () => ({ error: 'no book' }),
    reloadProgress: () => undefined,
  }

  // 每个工厂都用最小的假依赖构造：只验证「产出了哪些 handler」，不调用它们
  const misc = (await load('host/routes/misc.ts')).createMiscHandlers({
    assetPath: join(tmp, 'none.png'),
    getKey: () => '',
    loadState: () => ({}),
    loadGrowth: () => ({}),
    loadFishfood: () => ({}),
  })
  const chat = (await load('host/routes/chat.ts')).createChatHandler({
    getKey: () => '',
    loadHistory: () => [],
    appendTurns: () => undefined,
    loadState: () => ({}),
    saveState: () => undefined,
    systemPrompt: '',
  })
  const chatStream = (await load('host/routes/chat-stream.ts')).createChatStreamHandler({
    getKey: () => '',
    loadHistory: () => [],
    systemPrompt: '',
  })
  const prefs = (await load('host/prefs.ts')).createPrefs(tmp)
  const cacheToggle = (await load('host/prefs.ts')).createCacheToggleHandler(prefs)
  const story = (await load('host/routes/story.ts')).createStoryHandlers({ player })
  const reminders = (await load('host/routes/reminders.ts')).createReminderHandlers({
    loadReminders: () => [],
    addReminder: () => ({}),
    dueReminders: () => [],
    removeReminder: () => undefined,
  })
  const culture = (await load('host/routes/culture.ts')).createCultureHandlers({ dataDir: tmp, runtimeDir: tmp, dataPort })
  const poem = (await load('host/routes/poem.ts')).createPoemHandler({ runtimeDir: tmp, dataPort })
  const poemTitles = (await load('host/routes/poem-titles.ts')).createPoemTitlesHandler({ dataDir: tmp })
  const briefing = (await load('host/routes/briefing.ts')).createBriefingHandlers({
    loadGrowth: () => ({}),
    loadReminders: () => [],
  })
  // 假引擎没有 warm()：createTtsHandler 不会去探测 python（测试必须离线、不起子进程）
  const tts = (await load('host/routes/tts.ts')).createTtsHandler({ engine: { synthesize: async () => Buffer.alloc(0) } })
  const asr = (await load('host/routes/asr.ts')).createAsrHandler({ getKey: () => '' })
  const personality = (await load('host/routes/personality.ts')).createPersonalityHandlers({
    repo: { load: () => ({}), revert: () => null },
  })
  const daily = (await load('host/routes/daily.ts')).createDailyHandler({ dataPort })
  const backup = (await load('host/routes/backup.ts')).createBackupHandlers({
    loadMemory: () => ({ history: [], summary: '' }),
    loadPersonality: () => ({}),
    loadState: () => ({}),
    loadGrowth: () => ({}),
    loadFishfood: () => ({}),
    loadPet: () => ({}),
    loadReminders: () => [],
    loadStoryProgress: () => ({}),
  })
  const stats = (await load('host/routes/stats.ts')).createStatsHandler({
    loadState: () => ({}),
    loadGrowth: () => ({}),
    loadFishfood: () => ({}),
  })
  const configView = (await load('host/routes/config.ts')).createConfigViewHandler({})
  const proofread = (await load('host/routes/proofread.ts')).createProofreadHandler({ key: () => '', model: 'stub' })
  const nervous = (await load('host/routes/nervous.ts')).createNervousHandler({
    collector: {
      start: () => [],
      stop: () => { },
      recent: () => [],
      status: () => ({ subscribed: [], count: 0, cap: 200, lastAt: 0 }),
    },
  })

  // 记忆摘要只读（鲸落/记忆胶囊用）：stub 只回空摘要
  const memory = (await load('host/routes/memory.ts')).createMemoryHandlers({ loadMemorySummary: () => '' })

  const sets = {
    misc, chat, chatStream, cacheToggle, story, reminders, culture, poem, poemTitles,
    briefing, tts, asr, personality, daily, backup, stats, configView, proofread, nervous, memory,
  }

  let produced = 0
  const items = []
  for (const [key, value] of Object.entries(sets)) {
    if (typeof value === 'function') {
      produced++
      items.push({ name: key, fn: value })
      continue
    }
    for (const [name, fn] of Object.entries(value || {})) {
      if (typeof fn !== 'function') { ok(key + '.' + name + ' 不是函数', false); continue }
      produced++
      items.push({ name: key + '.' + name, fn })
    }
  }

  const table = createRouteTable(sets)
  ok('路由条数 = 工厂产出的 handler 数', table.length === produced,
    '表 ' + table.length + ' 条 / 产出 ' + produced + ' 个')

  const registered = new Map()
  for (const route of table) {
    if (typeof route.handler !== 'function') { ok('路径 ' + route.path + ' 的 handler 不是函数', false); continue }
    registered.set(route.handler, (registered.get(route.handler) || 0) + 1)
  }
  const missing = items.filter((it) => !registered.has(it.fn)).map((it) => it.name)
  const duplicated = items.filter((it) => (registered.get(it.fn) || 0) > 1).map((it) => it.name)
  ok('没有漏注册的 handler', missing.length === 0, missing.join(', '))
  ok('没有重复注册的 handler', duplicated.length === 0, duplicated.join(', '))

  // ---------- B. 路径形状 ----------
  console.log('\n[B] 路径形状（唯一 / 前缀 / 无空段）')
  const paths = table.map((r) => r.path)
  const dups = paths.filter((p, i) => paths.indexOf(p) !== i)
  ok('路径唯一', dups.length === 0, dups.join(', '))
  ok('全部挂在 /api/chubby-whale/', paths.every((p) => p.indexOf('/api/chubby-whale/') === 0))
  const PATH_RE = /^\/api\/chubby-whale\/[a-z0-9-]+(\/[a-z0-9-]+)*$/
  const badShape = paths.filter((p) => !PATH_RE.test(p))
  ok('路径只含小写/数字/连字符，无空段与尾斜杠', badShape.length === 0, badShape.join(', '))
  const mustHave = [
    '/api/chubby-whale/chat', '/api/chubby-whale/chat-stream',
    '/api/chubby-whale/story/books', '/api/chubby-whale/story/start',
    '/api/chubby-whale/story/next', '/api/chubby-whale/story/reset',
    '/api/chubby-whale/tts', '/api/chubby-whale/asr',
    '/api/chubby-whale/stats', '/api/chubby-whale/config',
    '/api/chubby-whale/data/export', '/api/chubby-whale/data/import',
  ]
  const lost = mustHave.filter((p) => paths.indexOf(p) < 0)
  ok('关键路由没有被删', lost.length === 0, lost.join(', '))
} catch (err) {
  ok('路由表可用真实工厂构造', false, String((err && err.message) || err))
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch { }
}

// ---------- C. index.ts 静态装配契约 ----------
console.log('\n[C] src/index.ts 静态装配契约')
ok("不用 ctx.on('dispose')（cordis 没有该事件）", !/ctx\.on\(\s*['"]dispose['"]/.test(indexSrc))
ok('自动备份清理器经 ctx.effect 托管', /startAutoBackup\(/.test(indexSrc) && indexSrc.includes("'chubby-whale: auto-backup'"))
ok('路由注册清理器经 ctx.effect 托管', /ctx\.effect\(registerRoutes/.test(indexSrc) && indexSrc.includes("'chubby-whale: routes'"))
ok('TTS 引擎清理器经 ctx.effect 托管（常驻 python worker 是子进程）',
  /ctx\.effect\(/.test(indexSrc) && indexSrc.includes("'chubby-whale: tts-engine'") && /ttsEngine\.dispose\(\)/.test(indexSrc))
ok('TTS 引擎显式创建，句柄留在装配层',
  /const ttsEngine = createEdgeTtsEngine\(\)/.test(indexSrc))
const ttsCallAt = indexSrc.indexOf('createTtsHandler(')
const ttsCall = ttsCallAt < 0 ? '' : indexSrc.slice(ttsCallAt, ttsCallAt + 240)
ok('云端 TTS 真接进 /tts（否则三层降级只有两层）', /\bcloudTts\b/.test(ttsCall), ttsCall.replace(/\s+/g, ' ').slice(0, 90))
ok('TTS 引擎注入 /tts', /engine:\s*ttsEngine/.test(ttsCall))

const statsAt = indexSrc.indexOf('createStatsHandler(')
const statsCall = statsAt < 0 ? '' : indexSrc.slice(statsAt, statsAt + 700)
ok('/stats 四项自检传 getter（dataSource/model/tts/backup）',
  /dataSource:\s*\(\)\s*=>/.test(statsCall) && /model:\s*\(\)\s*=>/.test(statsCall)
  && /tts:\s*\(\)\s*=>/.test(statsCall) && /backup:\s*\(\)\s*=>/.test(statsCall))
ok('/stats 的 ttsStatOf 适配函数仍在（窄形状转换）', /function ttsStatOf\(\)/.test(indexSrc) && /ttsStatOf\(\)/.test(statsCall))

const backupAt = indexSrc.indexOf('createBackupHandlers(')
const backupCall = backupAt < 0 ? '' : indexSrc.slice(backupAt, backupAt + 1600)
ok('/data/import 仍注入 clearChatCache（导入后作废旧聊天缓存）', /clearChatCache:\s*\(\)\s*=>/.test(backupCall))
ok('路由注册走 kind: exact（exact 匹配，表顺序不参与匹配）', /kind:\s*'exact'/.test(indexSrc))

// ---------- D. 死导入 ----------
console.log('\n[D] 死导入（每个具名导入都必须有使用）')
const dead = []
const importRe = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g
for (const m of indexSrc.matchAll(importRe)) {
  for (const raw of m[1].split(',')) {
    const spec = raw.trim()
    if (!spec) continue
    const name = spec.split(/\s+as\s+/).pop().trim()
    const escape = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const count = (indexSrc.match(new RegExp('\\b' + escape + '\\b', 'g')) || []).length
    if (count < 2) dead.push(name + ' ← ' + m[2])
  }
}
ok('没有只导入不使用（死导入）', dead.length === 0, dead.join('; '))

// ---------- E. 每个 handler 工厂都接线了 ----------
console.log('\n[E] 路由工厂接线（src/host/routes/*.ts 都必须被 index.ts 用到）')
const routeDir = join(SRC, 'host/routes')
const unWired = []
try {
  for (const file of readdirSync(routeDir).filter((f) => f.endsWith('.ts'))) {
    const mod = await load('host/routes/' + file)
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== 'function' || !/^create[A-Za-z]+Handlers?$/.test(name)) continue
      const used = new RegExp('import\\s*(?:type\\s*)?\\{[^}]*\\b' + name + '\\b[^}]*\\}').test(indexSrc)
      if (!used) unWired.push(file + ':' + name)
    }
  }
} catch (err) {
  ok('路由工厂模块可加载', false, String((err && err.message) || err))
}
ok('每个 handler 工厂都在 index.ts 里接线', unWired.length === 0, unWired.join(', '))

console.log('\n  通过 ' + pass + ' 项，失败 ' + fail + ' 项')
if (fail > 0) process.exit(1)
