/**
 * scripts/test-persona-cloud.mjs —— B90「人格与云端语音」四模块专项（离线，不联网、不碰用户目录）
 *
 * 覆盖：
 *   src/host/persona.ts             人设数据门面 / 阶段语气查表（含原型链键边界）
 *   src/host/personality-learn.ts   L2 触发条件 / 重复灌注 / 失败静默 / 输入截断 / 单飞
 *   src/host/personality-write.ts   L3 24h 窗口 / 限域验收 / 失败静默 / 同句不重写
 *   src/host/voice/cloud-tts.ts     配置读取 / 日字数熔断（持久化 + 记账兜底）/ 行流解析 /
 *                                   体积上限 / 超时 abort / Key 不外泄
 *
 * 外加一节「读改写竞态」：L2 学习与 L3 自写同时打同一份 personality.json，两边都不能丢。
 *
 * 负向验证（默认开启，--no-mutate 可关）：用 esbuild 打一份包，只把实现里的关键一行改坏
 * （变异体），同一套断言必须**报失败**。断言全绿不能证明测试有牙，变异体被抓出来才算数。
 *
 * 用法：node scripts/test-persona-cloud.mjs [--no-mutate]
 * 退出码：0 = 全过；1 = 有失败
 */
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { register } from 'node:module'
import esbuild from 'esbuild'

// 直接加载 .ts：把找不到的 .js 回退到同名 .ts（与 scripts/test.mjs 同口径）
register(new URL('./ts-resolve.mjs', import.meta.url))

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 打包用的临时目录（与 scripts/test-net-client.mjs 同一套路：跑完就删） */
const TMP = path.join(ROOT, '.b90-persona-cloud-tmp')
const ENTRY = path.join(TMP, 'entry.ts')
const WITH_MUTATE = !process.argv.includes('--no-mutate')

const HOUR = 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 7, 0, 0, 0)
const CLOUD_NOW = Date.UTC(2026, 10, 7, 3, 0, 0)
const dayOf = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
const TODAY = dayOf(new Date(CLOUD_NOW))
const YESTERDAY = dayOf(new Date(CLOUD_NOW - 24 * HOUR))

const tmpDirs = []
function tmpDir(tag) {
  const d = mkdtempSync(path.join(os.tmpdir(), 'b90-' + tag + '-'))
  tmpDirs.push(d)
  return d
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const enc = new TextEncoder()

function makeRec(quiet) {
  return {
    quiet: !!quiet,
    pass: 0,
    fail: 0,
    failures: [],
    ok(name, cond, detail = '') {
      if (cond) {
        this.pass++
        if (!this.quiet) console.log('  ✅ ' + name + (detail ? '  ' + detail : ''))
      } else {
        this.fail++
        this.failures.push(name + (detail ? '  ' + detail : ''))
        // 变异体跑的是同一套断言：只计数不刷屏（否则一个变异体打几十行 ❌ 盖住重点）
        if (!this.quiet) console.log('  ❌ ' + name + (detail ? '  ' + detail : ''))
      }
    },
    eq(name, actual, expected) {
      this.ok(name, JSON.stringify(actual) === JSON.stringify(expected),
        '期望 ' + JSON.stringify(expected) + ' / 实际 ' + JSON.stringify(actual))
    },
  }
}

// ---------- 假响应 / 假 fetch ----------
function headersOf(map) {
  return {
    get(k) {
      const v = map[String(k).toLowerCase()]
      return v === undefined ? null : String(v)
    },
  }
}

/** 只有 text() 的响应（旧式假响应 / 真实 Node 以外的最简形态） */
function textRes(body, opts = {}) {
  return { ok: opts.ok !== false, status: opts.status || 200, headers: headersOf(opts.headers || {}), text: async () => body, body: null }
}

/**
 * 按需 pull 的响应流：能数出「读了几块」「有没有被 cancel」。
 * chunks 只在被消费时一块块给，用来证明超限时提前停手、没有把整包收进内存。
 */
function pullRes(chunks, opts = {}) {
  let pulls = 0
  let cancelled = 0
  const stream = new ReadableStream({
    pull(c) {
      if (pulls >= chunks.length) { c.close(); return }
      c.enqueue(enc.encode(chunks[pulls++]))
    },
    cancel() { cancelled++ },
  })
  return {
    ok: opts.ok !== false,
    status: opts.status || 200,
    headers: headersOf(opts.headers || {}),
    text: async () => { throw new Error('不该走 text()（有 body 流时走流式读）') },
    body: stream,
    stats: () => ({ pulls, cancelled }),
  }
}

/** 记录每次 fetch：断言「发没发请求」「请求头有没有 Key」「发的正文对不对」 */
function stubFetch(impl) {
  const orig = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init: init || {} })
    return impl(url, init || {})
  }
  return { calls, restore: () => { globalThis.fetch = orig } }
}

const okLine = (text) => JSON.stringify({ code: 0, data: Buffer.from(text).toString('base64') }) + '\n'
const endLine = JSON.stringify({ code: 20000000 }) + '\n'

function seedUsage(dir, day, chars) {
  writeFileSync(path.join(dir, 'cloud-usage.json'), JSON.stringify({ day, chars }), 'utf8')
}
function readUsageFile(dir) {
  return JSON.parse(readFileSync(path.join(dir, 'cloud-usage.json'), 'utf8'))
}
function makeCfg(over = {}) {
  return { enabled: true, apiKey: 'k-test', speaker: 'sp-test', resourceId: 'rid-test', dailyChars: 1e9, ...over }
}
function makeTts(cloud, dir, cfg, extra = {}) {
  const logs = []
  const tts = cloud.createCloudTts({ config: () => cfg, runtimeDir: dir, log: (m) => logs.push(m), now: () => new Date(CLOUD_NOW), ...extra })
  return { tts, logs }
}
async function catchErr(fn) {
  try { await fn(); return null } catch (e) { return e }
}

// ---------- 主套件 ----------
async function suite(mods, rec, isMain) {
  const P = mods.persona
  const L = mods.learn
  const W = mods.write
  const PER = mods.pers
  const C = mods.cloud

  // ========== [1] host/persona.ts ==========
  rec.ok('[1] SYSTEM_PROMPT 是字符串且包含核心锁定设定',
    typeof P.SYSTEM_PROMPT === 'string' && P.SYSTEM_PROMPT.length > 200 &&
    ['肥鲸', '光光', '丽丽', '2026年11月4日', '广西北海', '语言规则'].every((k) => P.SYSTEM_PROMPT.includes(k)))
  {
    const stages = ['初识', '熟悉', '亲密', '知心', '家人']
    const tails = stages.map((s) => P.buildSystemPrompt(s).slice(P.SYSTEM_PROMPT.length))
    rec.ok('[1] 五个成长阶段都追加了语气段', tails.every((t) => t.length > 0 && t.startsWith('\n语气：')), JSON.stringify(tails.map((t) => t.length)))
    rec.ok('[1] 各阶段语气互不相同（查表没串味）', new Set(tails).size === stages.length)
    rec.eq('[1] 未知阶段回落空串（行为不变）', P.buildSystemPrompt('不存在的阶段'), P.SYSTEM_PROMPT)
    for (const v of ['', null, undefined, 0, false]) rec.ok('[1] 空/非字符串阶段名回落空串：' + JSON.stringify(v), P.buildSystemPrompt(v) === P.SYSTEM_PROMPT)
    // 原型链键：普通对象查表会命中原型，把函数源码/"[object Object]"拼进系统提示词
    const protoKeys = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']
    const leaks = protoKeys.map((k) => [k, P.buildSystemPrompt(k).slice(P.SYSTEM_PROMPT.length)]).filter(([, t]) => t !== '')
    rec.ok('[1] 原型链键不泄漏进提示词（constructor/__proto__/toString…）', leaks.length === 0, JSON.stringify(leaks))
    rec.ok('[1] 提示词里不出现函数源码/对象字符串', !/\[native code\]|\[object Object\]/.test(P.buildSystemPrompt('constructor') + P.buildSystemPrompt('__proto__')))
    rec.ok('[1] 已有阶段名不受影响（初识仍然有语气）', P.buildSystemPrompt('初识').indexOf('语气：刚认识不久') > 0)
  }

  // ========== [2] personality-learn.ts ==========
  {
    rec.eq('[2] 常量契约', [L.LEARN_EVERY, L.LEARN_MESSAGE_COUNT, L.LEARN_MIN_INTERVAL_MS], [20, 16, 6 * HOUR])

    const edge = '字'.repeat(299) + '🙂' + '尾巴'
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    const ex = L.buildExtractionUser([{ role: 'user', content: edge }])
    rec.ok('[2] 300 码点截断不切坏 emoji（无孤立代理）', !loneSurrogate.test(ex.split('\n').pop()))
    rec.ok('[2] 单行超过 300 码点被截断', Array.from(ex.slice(ex.indexOf('：') + 1)).length === 300)
    rec.ok('[2] 非 user/assistant、非字符串内容被跳过',
      L.buildExtractionUser([{ role: 'system', content: 'x' }, { role: 'user', content: 42 }, { role: 'user', content: '   ' }]) === '')
    const many = Array.from({ length: 41 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '第' + i + '句' }))
    const lines = L.buildExtractionUser(many).split('\n')
    rec.eq('[2] 只喂最近 16 条（首行是最近 16 条的第一条）', [lines.length, lines[0].slice(0, 6)], [16, '肥鲸：第25'])
    rec.ok('[2] 同一句反复灌 16 次：输入不去重（靠落盘合并去重，不靠模型自觉）',
      L.buildExtractionUser(Array.from({ length: 16 }, () => ({ role: 'user', content: '我爱白饭' }))).split('\n').length === 16)
    rec.eq('[2] 解析只认三个白名单字段',
      L.parseExtraction('{"name":"小白","birthday":"1-1","catchphrases":["哼"],"notes":5}'),
      { catchphrases: ['哼'], preferences: [], notes: '' })
    rec.ok('[2] 非 JSON / 空串 → null', L.parseExtraction('不是JSON') === null && L.parseExtraction('') === null && L.parseExtraction('[1]') === null)
    rec.ok('[2] 代码块/前后废话可解', L.parseExtraction('好的：```json\n{"notes":"怕吵"}\n``` 完毕').notes === '怕吵')

    // shouldLearn 边界（F9 口径的回归锚点）
    rec.ok('[2] shouldLearn：19 次不够 / 20 次够', L.shouldLearn({ successes: 19, lastAttemptAt: 0 }, NOW) === false && L.shouldLearn({ successes: 20, lastAttemptAt: 0 }, NOW) === true)
    rec.ok('[2] shouldLearn：6h 内不重复、刚好 6h 放行',
      L.shouldLearn({ successes: 20, lastAttemptAt: NOW - HOUR }, NOW) === false && L.shouldLearn({ successes: 20, lastAttemptAt: NOW - 6 * HOUR }, NOW) === true)
    rec.ok('[2] shouldLearn：时钟回拨（lastAttemptAt 在将来）不开闸', L.shouldLearn({ successes: 20, lastAttemptAt: NOW + HOUR }, NOW) === false)
    rec.ok('[2] shouldLearn：explicit 0 / 负值 / NaN 口径不变',
      L.shouldLearn({ successes: 1, lastAttemptAt: NOW - 1 }, NOW, { every: 0, minIntervalMs: 0 }) === true &&
      L.shouldLearn({ successes: 19, lastAttemptAt: NOW - 1 }, NOW, { every: NaN }) === false)

    // 真 repo：反复灌同一句不污染、不升版本
    const dir = tmpDir('learn')
    const repo = PER.createPersonalityRepo(dir)
    const hist = Array.from({ length: 16 }, () => ({ role: 'user', content: '我最喜欢吃白饭了' }))
    let calls = 0
    const reply = { ok: true, status: 200, data: { choices: [{ message: { content: '{"preferences":["喜欢吃白饭"]}' } }] }, text: '' }
    const learner = L.createPersonalityLearner({
      repo, getKey: () => 'k', loadHistory: () => hist, now: () => NOW,
      fetchJson: async () => { calls++; return reply },
    })
    const r1 = await learner.learnNow()
    const fileA = readFileSync(path.join(dir, 'personality.json'), 'utf8')
    const r2 = await learner.learnNow()
    const r3 = await learner.learnNow()
    const fileB = readFileSync(path.join(dir, 'personality.json'), 'utf8')
    rec.eq('[2] 首次提取写入首选', [r1.ok, r1.changed], [true, ['preferences']])
    rec.eq('[2] 同一句再灌两次：无变化、不重复写', [r2.changed, r3.changed], [[], []])
    rec.ok('[2] 同一句再灌两次：文件字节不变、版本不涨', fileA === fileB && JSON.parse(fileB).version === 1, 'version=' + JSON.parse(fileB).version)
    rec.ok('[2] 同一句再灌两次：偏好只有一条', JSON.parse(fileB).preferences.length === 1)

    // 失败静默：抛错 / HTTP / 解析 / 无 Key / 空历史
    const bad = L.createPersonalityLearner({ repo, getKey: () => 'k', loadHistory: () => hist, now: () => NOW, fetchJson: async () => { throw new Error('boom') } })
    const rb = await catchErr(() => bad.learnNow())
    rec.ok('[2] 请求抛错：不抛给调用方、返回 error', rb === null && (await bad.learnNow()).reason === 'error')
    const http = L.createPersonalityLearner({ repo, getKey: () => 'k', loadHistory: () => hist, now: () => NOW, fetchJson: async () => ({ ok: false, status: 500, data: null, text: 'boom' }) })
    rec.eq('[2] HTTP 非 2xx：reason 带状态码、不写盘', (await http.learnNow()).reason, 'HTTP 500')
    const parse = L.createPersonalityLearner({ repo, getKey: () => 'k', loadHistory: () => hist, now: () => NOW, fetchJson: async () => ({ ok: true, status: 200, data: { choices: [{ message: { content: '不是 JSON' } }] }, text: '' }) })
    rec.eq('[2] 解析失败：放弃本次、不写盘', (await parse.learnNow()).reason, 'parse')
    let noKeyCalls = 0
    const noKey = L.createPersonalityLearner({ repo, getKey: () => '', loadHistory: () => hist, now: () => NOW, fetchJson: async () => { noKeyCalls++; return reply } })
    rec.eq('[2] 无 Key：不发请求直接放弃', [(await noKey.learnNow()).reason, noKeyCalls], ['NO_KEY', 0])
    let emptyCalls = 0
    const empty = L.createPersonalityLearner({ repo, getKey: () => 'k', loadHistory: () => [], now: () => NOW, fetchJson: async () => { emptyCalls++; return reply } })
    rec.eq('[2] 空历史：不发请求直接放弃', [(await empty.learnNow()).reason, emptyCalls], ['EMPTY', 0])
    rec.ok('[2] 失败后人格文件仍是原来那一版', JSON.parse(readFileSync(path.join(dir, 'personality.json'), 'utf8')).version === 1)

    // 单飞：同一时刻只允许一次提取
    const dir2 = tmpDir('learn-single')
    const repo2 = PER.createPersonalityRepo(dir2)
    let gate
    let concurrentCalls = 0
    const gatePromise = new Promise((r) => { gate = r })
    const single = L.createPersonalityLearner({
      repo: repo2, getKey: () => 'k', loadHistory: () => hist, now: () => NOW,
      fetchJson: () => { concurrentCalls++; return gatePromise },
    })
    const p1 = single.learnNow()
    const p2 = single.learnNow()
    // 先给第二次一个「立刻返回」的机会，再放闸；否则变异体（去掉 running 闸）会把两条都挂住 → 进程静默等待
    const second = await Promise.race([p2, delay(30).then(() => null)])
    rec.eq('[2] 并发第二次：running，不发第二个请求', [second && second.reason, concurrentCalls], ['running', 1])
    gate(reply)
    const sfA = await p1
    const sfB = await p2
    rec.ok('[2] 第一次照常完成', sfA.ok === true)
    rec.eq('[2] 两次调用最终都收口（不悬挂）', [sfA.ok, sfB.reason], [true, 'running'])

    // noteSuccess：攒够 20 次才触发，触发后 6h 内不再触发
    const dir3 = tmpDir('learn-note')
    const repo3 = PER.createPersonalityRepo(dir3)
    let successes = 0
    let noteCalls = 0
    let noteNow = NOW
    const noteLearner = L.createPersonalityLearner({
      repo: repo3, getKey: () => 'k', loadHistory: () => hist, now: () => noteNow,
      fetchJson: async () => { noteCalls++; return reply },
    })
    const flags = []
    for (let i = 0; i < 20; i++) flags.push(noteLearner.noteSuccess())
    rec.ok('[2] noteSuccess：前 19 次不触发、第 20 次触发', flags.slice(0, 19).every((f) => f === false) && flags[19] === true)
    await delay(20)
    rec.eq('[2] noteSuccess：触发后后台只发 1 个提取请求', noteCalls, 1)
    rec.eq('[2] noteSuccess：状态里计数已清零', noteLearner.status().successes, 0)
    const flags2 = []
    for (let i = 0; i < 20; i++) flags2.push(noteLearner.noteSuccess())
    await delay(20)
    rec.ok('[2] noteSuccess：6h 窗口内再次攒满 20 次仍返回 false', flags2.every((f) => f === false))
    rec.eq('[2] noteSuccess：6h 窗口内再攒 20 次也不重复烧 token', noteCalls, 1)
    rec.ok('[2] noteSuccess：学习关闭时不计次', (() => {
      const off = L.createPersonalityLearner({ repo: repo3, getKey: () => 'k', loadHistory: () => hist, now: () => noteNow, enabled: () => false, fetchJson: async () => { throw new Error('不该发') } })
      return off.noteSuccess() === false && off.status().successes === 0
    })())
  }

  // ========== [3] personality-write.ts ==========
  {
    rec.eq('[3] 常量契约', [W.WRITE_EVERY, W.WRITE_MESSAGE_COUNT, W.WRITE_MIN_INTERVAL_MS], [20, 16, 24 * HOUR])

    const edge = '字'.repeat(299) + '🙂' + '尾巴'
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    const narr = W.buildNarrativeUser('核心人设', [{ role: 'user', content: edge }])
    rec.ok('[3] 300 码点截断不切坏 emoji（无孤立代理）', !loneSurrogate.test(narr.split('\n').pop()))
    rec.eq('[3] 没有可用对话时不拼提示词（不发请求）', W.buildNarrativeUser('核心人设', []), '')
    rec.ok('[3] 核心设定只读地排在最前', W.buildNarrativeUser('核心人设', [{ role: 'user', content: '你好' }]).indexOf('核心设定（只读参考，禁止复述或改写）') === 0)
    const narr16 = W.buildNarrativeUser('c', Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '第' + i + '句' }))).split('\n')
    rec.eq('[3] 只喂最近 16 条（对话段 16 行）', [narr16.length - 4, narr16.slice(-1)[0].slice(0, 6)], [16, '肥鲸：第39'])

    rec.ok('[3] shouldWrite：19 次不够 / 20 次够', W.shouldWrite({ successes: 19, lastAttemptAt: 0 }, NOW) === false && W.shouldWrite({ successes: 20, lastAttemptAt: 0 }, NOW) === true)
    rec.ok('[3] shouldWrite：24h 内不重复 / 刚好 24h 放行',
      W.shouldWrite({ successes: 20, lastAttemptAt: NOW - HOUR }, NOW) === false && W.shouldWrite({ successes: 20, lastAttemptAt: NOW - 24 * HOUR }, NOW) === true)
    rec.ok('[3] shouldWrite：磁盘上的 selfNarrativeAt 也参与窗口',
      W.shouldWrite({ successes: 20, lastAttemptAt: 0 }, NOW, { lastWrittenAt: NOW - HOUR }) === false &&
      W.shouldWrite({ successes: 20, lastAttemptAt: 0 }, NOW, { lastWrittenAt: NOW - 25 * HOUR }) === true)
    rec.ok('[3] shouldWrite：lastWrittenAt 脏值（NaN/字符串）按「没写过」处理',
      W.shouldWrite({ successes: 20, lastAttemptAt: 0 }, NOW, { lastWrittenAt: NaN }) === true &&
      W.shouldWrite({ successes: 20, lastAttemptAt: 0 }, NOW, { lastWrittenAt: 'abc' }) === true)

    // 真 repo：正常写入 / 同句不重写 / 身份词拦截 / 失败静默
    const dir = tmpDir('write')
    const repo = PER.createPersonalityRepo(dir)
    const hist = [{ role: 'user', content: '今天有点累' }, { role: 'assistant', content: '那早点睡' }]
    let calls = 0
    let content = '最近有点困，话比平时少一点'
    const writer = W.createSelfNarrativeWriter({
      repo, getKey: () => 'k', loadHistory: () => hist, corePrompt: () => 'core-prompt', now: () => NOW,
      fetchJson: async () => { calls++; return { ok: true, status: 200, data: { choices: [{ message: { content } }] }, text: '' } },
    })
    const w1 = await writer.writeNow()
    rec.ok('[3] 正常路径：写入一句心境', w1.ok === true && typeof w1.text === 'string', JSON.stringify(w1))
    const parsed1 = JSON.parse(readFileSync(path.join(dir, 'personality.json'), 'utf8'))
    rec.ok('[3] 落盘：只动 selfNarrative 一个字段且记时间', parsed1.selfNarrative === content && parsed1.selfNarrativeAt.length > 0 && parsed1.version === 1)
    const w2 = await writer.writeNow()
    rec.eq('[3] 同句不重写：ok+same、版本不涨', [w2.ok, w2.reason, JSON.parse(readFileSync(path.join(dir, 'personality.json'), 'utf8')).version], [true, 'same', 1])

    content = '我是一个人工智能助手'
    const w3 = await writer.writeNow()
    rec.eq('[3] 身份词整句丢弃，不写盘', [w3.ok, w3.reason, JSON.parse(readFileSync(path.join(dir, 'personality.json'), 'utf8')).selfNarrative], [false, 'IDENTITY', '最近有点困，话比平时少一点'])
    content = '一二三'
    rec.eq('[3] 过短丢弃', (await writer.writeNow()).reason, 'TOO_SHORT')
    content = '啊'.repeat(81)
    rec.eq('[3] 过长整句丢弃（不截半句）', (await writer.writeNow()).reason, 'TOO_LONG')
    content = '最近想了想'

    const http = W.createSelfNarrativeWriter({ repo, getKey: () => 'k', loadHistory: () => hist, corePrompt: () => 'core', now: () => NOW, fetchJson: async () => ({ ok: false, status: 500, data: null, text: 'x' }) })
    rec.eq('[3] HTTP 非 2xx：不写盘', (await http.writeNow()).reason, 'HTTP 500')
    let noKeyCalls = 0
    const noKey = W.createSelfNarrativeWriter({ repo, getKey: () => '', loadHistory: () => hist, corePrompt: () => 'core', now: () => NOW, fetchJson: async () => { noKeyCalls++; return { ok: true, status: 200, data: {} } } })
    rec.eq('[3] 无 Key：不发请求', [(await noKey.writeNow()).reason, noKeyCalls], ['NO_KEY', 0])
    let emptyCalls = 0
    const empty = W.createSelfNarrativeWriter({ repo, getKey: () => 'k', loadHistory: () => [], corePrompt: () => 'core', now: () => NOW, fetchJson: async () => { emptyCalls++; return { ok: true, status: 200, data: {} } } })
    rec.eq('[3] 空历史：不发请求', [(await empty.writeNow()).reason, emptyCalls], ['EMPTY', 0])

    // 注入式失败：写盘失败不抛、返回 SAVE_FAILED（走注入 repo，不依赖磁盘权限）
    const failRepo = {
      load: () => ({ catchphrases: [], preferences: [], notes: '', selfNarrative: '', selfNarrativeAt: '', version: 9, updatedAt: '', history: [] }),
      save: () => false,
      learn: () => ({ data: { version: 10 }, changed: [{ at: '', field: 'preferences', old: [], new: ['x'] }], saved: false }),
      writeNarrative: () => ({ data: { version: 10 }, changed: true, saved: false }),
      revert: () => null,
      segment: () => '',
    }
    const failWriter = W.createSelfNarrativeWriter({ repo: failRepo, getKey: () => 'k', loadHistory: () => hist, corePrompt: () => 'core', now: () => NOW, fetchJson: async () => ({ ok: true, status: 200, data: { choices: [{ message: { content: '最近有点困，话少' } }] }, text: '' }) })
    rec.eq('[3] 写盘失败：SAVE_FAILED、不抛异常', (await failWriter.writeNow()).reason, 'SAVE_FAILED')
    const failLearner = L.createPersonalityLearner({ repo: failRepo, getKey: () => 'k', loadHistory: () => hist, now: () => NOW, fetchJson: async () => ({ ok: true, status: 200, data: { choices: [{ message: { content: '{"preferences":["白饭"]}' } }] }, text: '' }) })
    const fl = await failLearner.learnNow()
    rec.eq('[3] 学习写盘失败：SAVE_FAILED 且带上变化的字段', [fl.ok, fl.reason, fl.changed], [false, 'SAVE_FAILED', ['preferences']])

    // noteSuccess：24h 内不重复生成；磁盘上刚写过就别再生成
    const dir2 = tmpDir('write-note')
    writeFileSync(path.join(dir2, 'personality.json'), JSON.stringify({ selfNarrative: '刚写过的一句心境', selfNarrativeAt: new Date(NOW - HOUR).toISOString() }), 'utf8')
    const repo2 = PER.createPersonalityRepo(dir2)
    let noteCalls = 0
    const noteWriter = W.createSelfNarrativeWriter({ repo: repo2, getKey: () => 'k', loadHistory: () => hist, corePrompt: () => 'core', now: () => NOW, fetchJson: async () => { noteCalls++; return { ok: true, status: 200, data: {} } } })
    const nFlags = []
    for (let i = 0; i < 40; i++) nFlags.push(noteWriter.noteSuccess())
    rec.eq('[3] noteSuccess：磁盘上 1 小时前刚写过 → 再攒 40 次也不重写', [nFlags.some(Boolean), noteCalls], [false, 0])
    const dir3 = tmpDir('write-note2')
    const repo3 = PER.createPersonalityRepo(dir3)
    let noteCalls3 = 0
    const noteWriter3 = W.createSelfNarrativeWriter({ repo: repo3, getKey: () => 'k', loadHistory: () => hist, corePrompt: () => 'core', now: () => NOW, fetchJson: async () => { noteCalls3++; return { ok: true, status: 200, data: { choices: [{ message: { content: '最近想多吃一碗白饭' } }] }, text: '' } } })
    const nFlags3 = []
    for (let i = 0; i < 20; i++) nFlags3.push(noteWriter3.noteSuccess())
    await delay(20)
    rec.eq('[3] noteSuccess：从没写过时第 20 次触发一次', [nFlags3.slice(0, 19).every((f) => f === false), nFlags3[19], noteCalls3], [true, true, 1])
    rec.ok('[3] noteSuccess：触发后落盘一句心境', JSON.parse(readFileSync(path.join(dir3, 'personality.json'), 'utf8')).selfNarrative === '最近想多吃一碗白饭')
  }

  // ========== [4] L2 学习 × L3 自写：同一份 personality.json 的读改写竞态 ==========
  {
    const dir = tmpDir('race')
    const repo = PER.createPersonalityRepo(dir)
    const hist = [{ role: 'user', content: '我喜欢吃白饭' }]
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body)
      const sys = String(body.messages && body.messages[0] && body.messages[0].content || '')
      const content = sys.indexOf('近期心境') >= 0 ? '最近话少，想安静一会儿' : '{"preferences":["喜欢吃白饭"]}'
      return { ok: true, status: 200, data: { choices: [{ message: { content } }] }, text: '' }
    }
    const learner = L.createPersonalityLearner({ repo, getKey: () => 'k', loadHistory: () => hist, now: () => NOW, fetchJson: fetchImpl })
    const writer = W.createSelfNarrativeWriter({ repo, getKey: () => 'k', loadHistory: () => hist, corePrompt: () => 'core', now: () => NOW, fetchJson: fetchImpl })
    const [lr, wr] = await Promise.all([learner.learnNow(), writer.writeNow()])
    const data = JSON.parse(readFileSync(path.join(dir, 'personality.json'), 'utf8'))
    rec.ok('[4] 两边都成功', lr.ok === true && wr.ok === true, JSON.stringify([lr, wr]))
    rec.eq('[4] 两份变更都在（没有后写覆盖先写）', [data.preferences, data.selfNarrative], [['喜欢吃白饭'], '最近话少，想安静一会儿'])
    rec.eq('[4] 版本与历史按两次变更累加', [data.version, data.history.length], [2, 2])
  }

  // ========== [5] cloud-tts：readCloudVoice ==========
  {
    const empty = C.readCloudVoice(tmpDir('cv-empty'))
    rec.eq('[5] 没有 config.json → 不启用 + 默认值',
      [empty.enabled, empty.apiKey, empty.dailyChars, empty.speaker === C.CLOUD_TTS_DEFAULT_SPEAKER, empty.resourceId === C.CLOUD_TTS_RESOURCE_ID],
      [false, '', 5000, true, true])

    const dir = tmpDir('cv')
    const writeCfg = (obj, opts = {}) => writeFileSync(path.join(dir, 'config.json'), (opts.bom ? '\uFEFF' : '') + JSON.stringify(obj), 'utf8')
    writeCfg({ cloudVoice: { apiKey: '  sk-test  ', speaker: '', resourceId: '', dailyChars: '3000', enabled: true } })
    const c1 = C.readCloudVoice(dir)
    rec.eq('[5] 正常配置：Key 去空白 / 空音色回落默认 / 字符串额度转数字',
      [c1.enabled, c1.apiKey, c1.speaker === C.CLOUD_TTS_DEFAULT_SPEAKER, c1.resourceId === C.CLOUD_TTS_RESOURCE_ID, c1.dailyChars],
      [true, 'sk-test', true, true, 3000])
    writeCfg({ cloudVoice: { apiKey: 'k', dailyChars: 12.9 } })
    rec.eq('[5] 额度小数向下取整', C.readCloudVoice(dir).dailyChars, 12)
    for (const v of [0, -5, 'abc', null]) {
      writeCfg({ cloudVoice: { apiKey: 'k', dailyChars: v } })
      rec.eq('[5] 非法额度回落 5000：' + JSON.stringify(v), C.readCloudVoice(dir).dailyChars, 5000)
    }
    writeCfg({ cloudVoice: { apiKey: 'k', enabled: false } })
    rec.eq('[5] enabled:false → 不启用', C.readCloudVoice(dir).enabled, false)
    writeCfg({ cloudVoice: { apiKey: 'k' } }, { bom: true })
    rec.eq('[5] 带 BOM 的 config.json 照样能读', C.readCloudVoice(dir).apiKey, 'k')
    writeFileSync(path.join(dir, 'config.json'), '{ 坏 JSON', 'utf8')
    rec.ok('[5] 坏 JSON：不抛、按未配置处理', (() => { const c = C.readCloudVoice(dir); return c.enabled === false && c.apiKey === '' })())
    writeCfg({ cloudVoice: { apiKey: '' } })
    rec.eq('[5] 没有 Key → 不启用', [C.readCloudVoice(dir).enabled, C.readCloudVoice(dir).apiKey], [false, ''])
    writeCfg({ cloudVoice: 'not-an-object' })
    rec.eq('[5] cloudVoice 非对象 → 不启用', C.readCloudVoice(dir).enabled, false)

    // 配置每次现读（改完不用重建实例）
    writeCfg({ cloudVoice: { apiKey: 'k' } })
    const liveLogs = []
    const liveTts = C.createCloudTts({
      config: () => C.readCloudVoice(dir),
      runtimeDir: tmpDir('cv-live'),
      log: (m) => liveLogs.push(m),
      now: () => new Date(CLOUD_NOW),
    })
    rec.ok('[5] enabled() 现读配置', liveTts.enabled() === true)
    writeCfg({ cloudVoice: { apiKey: '' } })
    rec.ok('[5] 改完配置文件，同一实例立刻看到关闭', liveTts.enabled() === false)
  }

  // ========== [6] cloud-tts：合成 ==========
  {
    // (a) 未启用 / 空文本：不发请求
    const dirA = tmpDir('ctts-off')
    const stubA = stubFetch(async () => textRes(okLine('x') + endLine))
    try {
      const { tts } = makeTts(C, dirA, makeCfg({ enabled: false }))
      rec.eq('[6] 未启用 → 抛错且不发请求', [(await catchErr(() => tts.synthesize('你好'))).message, stubA.calls.length], ['cloud-tts 未启用', 0])
      const { tts: tts2 } = makeTts(C, dirA, makeCfg({ apiKey: '' }))
      rec.eq('[6] 没 Key → 抛错且不发请求', [(await catchErr(() => tts2.synthesize('你好'))).message, stubA.calls.length], ['cloud-tts 未启用', 0])
      const { tts: tts3 } = makeTts(C, dirA, makeCfg())
      rec.eq('[6] 空文本 → 抛错且不发请求', [(await catchErr(() => tts3.synthesize('   '))).message, stubA.calls.length], ['cloud-tts 空文本', 0])
    } finally { stubA.restore() }

    // (b) 正常行流：多段 base64 拼接、结束码之后不再收、请求头/正文正确、记账
    const dirB = tmpDir('ctts-ok')
    const head = Buffer.from('ID3-head-bytes')
    const tail = Buffer.from('tail-bytes')
    const bodyB = JSON.stringify({ code: 0, data: head.toString('base64') }) + '\n' +
      JSON.stringify({ code: 0, data: tail.toString('base64') }) + '\n' +
      endLine +
      JSON.stringify({ code: 0, data: Buffer.from('AFTER-END').toString('base64') }) + '\n'
    const stubB = stubFetch(async () => textRes(bodyB))
    try {
      const cfg = makeCfg()
      const { tts, logs } = makeTts(C, dirB, cfg)
      const buf = await tts.synthesize('  你好，主人  ')
      rec.ok('[6] 多段音频按顺序拼接', buf.equals(Buffer.concat([head, tail])), buf.toString('utf8'))
      rec.eq('[6] 请求带 Key/资源头 + 正文是 trim 后的文本', (() => {
        const init = stubB.calls[0].init
        const sent = JSON.parse(init.body).req_params
        return [stubB.calls[0].url, init.headers['X-Api-Key'], init.headers['X-Api-Resource-Id'], sent.text, sent.speaker, sent.audio_params.format]
      })(), [C.CLOUD_TTS_URL, 'k-test', 'rid-test', '你好，主人', 'sp-test', 'mp3'])
      rec.eq('[6] 成功才记账：日用量文件 {day, chars}', readUsageFile(dirB), { day: TODAY, chars: Array.from('你好，主人').length })
      rec.eq('[6] usage() 快照与熔断同口径', tts.usage(), { day: TODAY, chars: 5, limit: 1e9 })
      rec.eq('[6] 成功路径不记告警日志', logs, [])
      rec.ok('[6] 用量文件里没有 Key 的痕迹', !readFileSync(path.join(dirB, 'cloud-usage.json'), 'utf8').includes('k-test'))
      rec.eq('[6] 请求头里确有 Key（只放内存、只发请求头）', stubB.calls[0].init.headers['X-Api-Key'], 'k-test')
    } finally { stubB.restore() }

    // (c) 流中错误码 / HTTP 500：都抛错且不记账
    const dirC = tmpDir('ctts-err')
    const stubC = stubFetch(async () => textRes(okLine('part') + JSON.stringify({ code: 30000001, message: 'bad' }) + '\n'))
    try {
      const { tts } = makeTts(C, dirC, makeCfg())
      const e = await catchErr(() => tts.synthesize('你好'))
      rec.ok('[6] 流中错误码 → 抛错、带上上游 message', /code=30000001 bad/.test(String(e && e.message)))
      rec.ok('[6] 流中错误码 → 不记账（文件都没建）', !existsSync(path.join(dirC, 'cloud-usage.json')))
    } finally { stubC.restore() }
    const stubC2 = stubFetch(async () => textRes('<html>gateway error</html>', { ok: false, status: 500 }))
    try {
      const { tts } = makeTts(C, dirC, makeCfg())
      const e = await catchErr(() => tts.synthesize('你好'))
      rec.ok('[6] HTTP 500 → 抛错、带状态码与响应摘要', /cloud-tts HTTP 500/.test(String(e && e.message)) && String(e.message).includes('gateway error'))
      rec.ok('[6] HTTP 500 → 不记账', !existsSync(path.join(dirC, 'cloud-usage.json')))
    } finally { stubC2.restore() }

    // (d) 日字数熔断：磁盘计数 + 正好到线 + 昨天的不算今天
    const dirD = tmpDir('ctts-budget')
    seedUsage(dirD, TODAY, 4990)
    const stubD = stubFetch(async () => textRes(okLine('x') + endLine))
    try {
      const { tts, logs } = makeTts(C, dirD, makeCfg({ dailyChars: 5000 }))
      const e = await catchErr(() => tts.synthesize('多'.repeat(20)))
      rec.eq('[6] 超预算 → 抛「预算用尽」且不发请求', [e && e.message, stubD.calls.length], ['cloud-tts 日预算用尽', 0])
      rec.ok('[6] 超预算 → 留 CLOUD-BUDGET 日志', logs.some((m) => m.indexOf('CLOUD-BUDGET') >= 0))
      const buf = await tts.synthesize('正'.repeat(10))
      rec.ok('[6] 正好到线（剩 10 字、发 10 字）放行', buf.length > 0)
      rec.eq('[6] 放行后计数到线', readUsageFile(dirD).chars, 5000)
      rec.ok('[6] 到线后下一次立刻拦', (await catchErr(() => tts.synthesize('再多一个字'))) !== null)
    } finally { stubD.restore() }

    const dirE = tmpDir('ctts-yesterday')
    seedUsage(dirE, YESTERDAY, 4990)
    const stubE = stubFetch(async () => textRes(okLine('y') + endLine))
    try {
      const { tts } = makeTts(C, dirE, makeCfg({ dailyChars: 5000 }))
      rec.ok('[6] 昨天的用量不占今天额度', (await tts.synthesize('今'.repeat(100))).length > 0)
      rec.eq('[6] 隔天记账从 0 重新起算', readUsageFile(dirE), { day: TODAY, chars: 100 })
    } finally { stubE.restore() }

    // (e) 并发判定：判定与记账之间的 await 期间，别的请求不能再用同一份额度
    //     （2026-11-07 B93：原来并发 N 个请求可同时通过判定，最多超额 (N-1)×单次字数）
    {
      const dirF = tmpDir('ctts-concurrent')
      seedUsage(dirF, TODAY, 4990)   // 只剩 10 字
      let release = null
      const gate = new Promise((r) => { release = r })
      const stubF = stubFetch(async () => { await gate; return textRes(okLine('x') + endLine) })
      try {
        const { tts } = makeTts(C, dirF, makeCfg({ dailyChars: 5000 }))
        // 两个请求各 10 字：预算只够一个
        const p1 = catchErr(() => tts.synthesize('甲'.repeat(10)))
        const p2 = catchErr(() => tts.synthesize('乙'.repeat(10)))
        release()
        const [e1, e2] = await Promise.all([p1, p2])
        const failed = [e1, e2].filter(Boolean).length
        rec.eq('[6] 并发两请求只放行一个（预占生效）', failed, 1)
        rec.eq('[6] 并发下不会把额度超发（文件里最多到线）', Math.min(readUsageFile(dirF).chars, 5000), 5000)
        rec.eq('[6] 预占不影响 usage() 口径（报告已用量，不含预占）', tts.usage().chars, 5000)
      } finally { stubF.restore() }
    }

    // (e) 记账写盘失败：进程内兜底计数必须继续生效（否则熔断彻底失效）
    const dirF = tmpDir('ctts-usagefail')
    mkdirSync(path.join(dirF, 'cloud-usage.json'))   // 目录占位 → writeJsonAtomic 必然写不进去
    const stubF = stubFetch(async () => textRes(okLine('z') + endLine))
    try {
      const { tts, logs } = makeTts(C, dirF, makeCfg({ dailyChars: 150 }))
      const first = await catchErr(() => tts.synthesize('字'.repeat(100)))
      rec.ok('[6] 记账写失败：本次照样出音频（不把听感赔给成本统计）', first === null)
      rec.ok('[6] 记账写失败：留 CLOUD-USAGE-FAIL 警示', logs.some((m) => m.indexOf('CLOUD-USAGE-FAIL') >= 0), JSON.stringify(logs))
      rec.eq('[6] 记账写失败：usage() 仍反映进程内真实用量', tts.usage().chars, 100)
      const second = await catchErr(() => tts.synthesize('字'.repeat(100)))
      rec.eq('[6] 记账写失败：第二次必须被拦（熔断不瞎）', second && second.message, 'cloud-tts 日预算用尽')
    } finally { stubF.restore() }

    // (f) 计数持久化：新实例（相当于重启/跨进程）读同一份文件
    const dirG = tmpDir('ctts-persist')
    const stubG = stubFetch(async () => textRes(okLine('p') + endLine))
    try {
      const { tts: t1 } = makeTts(C, dirG, makeCfg({ dailyChars: 30 }))
      await t1.synthesize('一'.repeat(20))
      const { tts: t2 } = makeTts(C, dirG, makeCfg({ dailyChars: 30 }))
      rec.eq('[6] 新实例读到同一份日用量（持久化）', t2.usage().chars, 20)
      rec.eq('[6] 新实例接着按剩余额度拦', (await catchErr(() => t2.synthesize('二'.repeat(20)))) !== null, true)
    } finally { stubG.restore() }

    // (g) 响应体积上限：声明超限不读流 / 流式超限提前停手并 cancel / 无流时按字节补判
    //     上限取 16MB（CLOUD_TTS_MAX_BYTES）：够装下 6000 字的合法请求，又给坏响应硬天花板。
    const dirH = tmpDir('ctts-big')
    const stubH = stubFetch(async () => pullRes(['A'.repeat(1024 * 1024)], { headers: { 'content-length': String(20 * 1024 * 1024) } }))
    try {
      const { tts } = makeTts(C, dirH, makeCfg())
      const e = await catchErr(() => tts.synthesize('你好'))
      rec.ok('[6] 声明超限（content-length）→ 直接判超限', /响应超限/.test(String(e && e.message)))
    } finally { stubH.restore() }

    let bigRes = null
    const stubH2 = stubFetch(async () => { bigRes = pullRes(Array.from({ length: 20 }, () => 'A'.repeat(1024 * 1024))); return bigRes })
    try {
      const { tts } = makeTts(C, dirH, makeCfg())
      const e = await catchErr(() => tts.synthesize('你好'))
      const stats = bigRes.stats()
      rec.ok('[6] 流式超限 → 抛「响应超限」', /响应超限/.test(String(e && e.message)))
      rec.ok('[6] 流式超限 → 没把 20MB 全收进内存（读的块数被上限截住）', stats.pulls < 20 && stats.pulls <= 19, JSON.stringify(stats))
      rec.ok('[6] 流式超限 → 主动 cancel 掉流（不挂连接）', stats.cancelled >= 1, JSON.stringify(stats))
      rec.ok('[6] 流式超限 → 不记账', !existsSync(path.join(dirH, 'cloud-usage.json')) || readUsageFile(dirH).chars === 0)
    } finally { stubH2.restore() }

    const stubH3 = stubFetch(async () => textRes('A'.repeat(16 * 1024 * 1024 + 1)))
    try {
      const { tts } = makeTts(C, dirH, makeCfg())
      const e = await catchErr(() => tts.synthesize('你好'))
      rec.ok('[6] 无 body 流的假响应也按 UTF-8 字节判上限', /响应超限/.test(String(e && e.message)))
    } finally { stubH3.restore() }

    // (h) 超时：到点 abort → 读取被 reject → 回退信号上抛（路由据此走 edge-tts）
    const dirI = tmpDir('ctts-timeout')
    let cancelledByAbort = 0
    const stubI = stubFetch(async (url, init) => {
      const signal = init.signal
      return {
        ok: true, status: 200, headers: headersOf({}), text: async () => '',
        body: {
          getReader: () => ({
            read: () => new Promise((_, reject) => {
              signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e) })
            }),
            cancel: async () => { cancelledByAbort++ },
            releaseLock() { },
          }),
        },
      }
    })
    try {
      const { tts } = makeTts(C, dirI, makeCfg(), { timeoutMs: 20 })
      const began = Date.now()
      const e = await catchErr(() => tts.synthesize('你好'))
      const spent = Date.now() - began
      rec.ok('[6] 超时到点 → AbortError 上抛（调用方可回退）', e && e.name === 'AbortError', String(e && e.message))
      rec.ok('[6] 超时在注入的阈值附近触发（不是 15s 硬等）', spent < 2000, spent + 'ms')
      rec.ok('[6] 超时后释放流（cancel 被调用）', cancelledByAbort >= 1)
      rec.ok('[6] 超时不记账', !existsSync(path.join(dirI, 'cloud-usage.json')))
    } finally { stubI.restore() }

    // (i) 外部 abort：fetch 直接抛 AbortError，原样上抛
    const dirJ = tmpDir('ctts-abort')
    const stubJ = stubFetch(async () => { const e = new Error('external abort'); e.name = 'AbortError'; throw e })
    try {
      const { tts } = makeTts(C, dirJ, makeCfg())
      const e = await catchErr(() => tts.synthesize('你好'))
      rec.ok('[6] fetch 抛 AbortError → 原样上抛', e && e.name === 'AbortError')
      rec.ok('[6] 外部 abort 不记账', !existsSync(path.join(dirJ, 'cloud-usage.json')))
      rec.ok('[6] 每次合成都会传一个可 abort 的 signal', stubJ.calls[0].init.signal && typeof stubJ.calls[0].init.signal.addEventListener === 'function')
    } finally { stubJ.restore() }
  }

  // ========== [7] 封装治理（只看源码，不打桩） ==========
  if (isMain) {
    const srcOf = (rel) => readFileSync(path.join(ROOT, 'src/host', rel), 'utf8')
    const importsOf = (code) => Array.from(code.matchAll(/from\s+'([^']+)'/g), (m) => m[1])
    const allowed = (list, set) => list.every((s) => set.has(s))

    const personaSrc = srcOf('persona.ts')
    rec.ok('[7] persona.ts 只依赖共享冻结工具（人设数据门面，不碰 IO/人格仓储）',
      allowed(importsOf(personaSrc), new Set(['../shared/immutable.js'])) && !/node:fs|personality/.test(personaSrc))
    rec.eq('[7] persona.ts 对外只暴露「人设常量 + 组装纯函数」',
      Array.from(personaSrc.matchAll(/^export\s+(?:function|const)\s+([A-Za-z_$][\w$]*)/gm), (m) => m[1]).sort(),
      ['SYSTEM_PROMPT', 'buildSystemPrompt'])
    rec.ok('[7] persona.ts 没有把阶段语气表导出去（外部改不了人设）', !/export\s+(?:const\s+)?STAGE_TONE/.test(personaSrc))

    const learnSrc = srcOf('personality-learn.ts')
    const learnSet = new Set(['./http.js', '../shared/immutable.js', './chat-core.js', './config.js', './personality.js'])
    rec.ok('[7] personality-learn.ts 只走门面与注入依赖（无 node:fs / 无深引用 / 不直接 fetch）',
      allowed(importsOf(learnSrc), learnSet) && !/node:fs/.test(learnSrc) && !/\.\/personality\//.test(learnSrc) && !/(^|[^A-Za-z.])fetch\(/.test(learnSrc))
    rec.ok('[7] personality-learn.ts 的 Key/历史/仓库都来自注入',
      /deps\.getKey\(\)/.test(learnSrc) && /deps\.loadHistory\(\)/.test(learnSrc) && /deps\.repo\./.test(learnSrc))

    const writeSrc = srcOf('personality-write.ts')
    const writeSet = new Set(['./http.js', '../shared/immutable.js', './chat-core.js', './config.js', './personality.js'])
    rec.ok('[7] personality-write.ts 只走门面与注入依赖（无 node:fs / 无深引用 / 不直接 fetch）',
      allowed(importsOf(writeSrc), writeSet) && !/node:fs/.test(writeSrc) && !/\.\/personality\//.test(writeSrc) && !/(^|[^A-Za-z.])fetch\(/.test(writeSrc))
    rec.ok('[7] personality-write.ts 的验收从门面进（validateSelfNarrative）', /validateSelfNarrative/.test(writeSrc) && /from\s+'\.\/personality\.js'/.test(writeSrc))

    const cloudSrc = srcOf('voice/cloud-tts.ts')
    const cloudSet = new Set(['node:fs', 'node:path', '../atomic.js'])
    rec.ok('[7] cloud-tts.ts 只依赖 fs/path/原子写（不 import host 其他模块的实现）',
      allowed(importsOf(cloudSrc), cloudSet))
    rec.ok('[7] cloud-tts.ts 的 Key 只来自 config.json / 注入配置（不读环境变量、不打印 Key）',
      !/process\.env/.test(cloudSrc) && !/(log|console\.[a-z]+)\([^)]*apiKey/.test(cloudSrc))
    rec.ok('[7] 四个模块都没有反向依赖（不 import index.ts / client/）',
      [personaSrc, learnSrc, writeSrc, cloudSrc].every((s) => !/from\s+'(?:\.\.\/)*\.?\.?\/?index\.js'|from\s+'.*\/client\//.test(s)))
  }
}

// ---------- 负向验证：esbuild 变异体 ----------
async function buildBundle(tag, rules = []) {
  const outfile = path.join(TMP, 'bundle-' + tag + '.mjs')
  const plugin = {
    name: 'mutate-b90-persona-cloud',
    setup(b) {
      b.onLoad({ filter: /\.ts$/ }, (args) => {
        if (!/src[\\/](host|shared)[\\/]/.test(args.path)) return null
        let src = readFileSync(args.path, 'utf8')
        for (const [file, from, to] of rules) {
          if (path.basename(args.path) !== file) continue
          if (src.indexOf(from) < 0) throw new Error('变异目标不存在（源码已变？）：' + from.slice(0, 80))
          src = src.split(from).join(to)
        }
        return { contents: src, loader: 'ts' }
      })
    },
  }
  await esbuild.build({
    entryPoints: [ENTRY],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
    plugins: [plugin],
  })
  return import(pathToFileURL(outfile).href + '?tag=' + encodeURIComponent(tag))
}

async function main() {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  writeFileSync(ENTRY, [
    "export * as persona from '../src/host/persona.ts'",
    "export * as learn from '../src/host/personality-learn.ts'",
    "export * as write from '../src/host/personality-write.ts'",
    "export * as pers from '../src/host/personality.ts'",
    "export * as cloud from '../src/host/voice/cloud-tts.ts'",
    '',
  ].join('\n'), 'utf8')

  let pass = 0
  let fail = 0
  const failures = []

  const mods = {
    persona: await import(pathToFileURL(path.join(ROOT, 'src/host/persona.ts')).href),
    learn: await import(pathToFileURL(path.join(ROOT, 'src/host/personality-learn.ts')).href),
    write: await import(pathToFileURL(path.join(ROOT, 'src/host/personality-write.ts')).href),
    pers: await import(pathToFileURL(path.join(ROOT, 'src/host/personality.ts')).href),
    cloud: await import(pathToFileURL(path.join(ROOT, 'src/host/voice/cloud-tts.ts')).href),
  }

  try {
    console.log('[persona-cloud] 主套件（直接加载 .ts，离线）')
    const rec = makeRec(false)
    await suite(mods, rec, true)
    pass = rec.pass
    fail = rec.fail
    failures.push(...rec.failures)

    if (WITH_MUTATE) {
      console.log('\n[8] 负向验证：变异体必须被同一套断言抓出来')
      const mutants = [
        ['persona/原型链查表', 'persona.ts', 'Object.prototype.hasOwnProperty.call(STAGE_TONE, key)', 'key in STAGE_TONE'],
        ['learn/单飞闸门', 'personality-learn.ts', "if (running) return { ok: false, reason: 'running' }", "if (false) return { ok: false, reason: 'running' }"],
        ['cloud/响应体积上限', 'cloud-tts.ts', "if (total > maxBytes) throw new Error('cloud-tts 响应超限 >' + maxBytes + ' 字节')", "if (false) throw new Error('cloud-tts 响应超限 >' + maxBytes + ' 字节')"],
        ['cloud/记账内存兜底', 'cloud-tts.ts', 'return Math.max(fromDisk, fromMem)', 'return fromDisk'],
      ]
      const mrec = makeRec(false)
      let caught = 0
      for (let i = 0; i < mutants.length; i++) {
        const [label, file, from, to] = mutants[i]
        try {
          const m = await buildBundle('mut' + i, [[file, from, to]])
          const r = makeRec(true)
          await suite(m, r, false)
          const hit = r.fail > 0
          if (hit) caught++
          mrec.ok('变异体「' + label + '」被抓出（' + file + '）', hit, hit ? '触发 ' + r.fail + ' 项失败' : '居然全绿 = 断言没牙')
        } catch (e) {
          mrec.ok('变异体「' + label + '」可构建（' + file + '）', false, String((e && e.message) || e))
        }
      }
      mrec.ok('四个变异体全部被抓出', caught === mutants.length, caught + '/' + mutants.length)
      pass += mrec.pass
      fail += mrec.fail
      failures.push(...mrec.failures)
    } else {
      console.log('\n[8] 负向验证：已按 --no-mutate 跳过')
    }
  } finally {
    for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }) } catch { } }
    rmSync(TMP, { recursive: true, force: true })
  }

  console.log('\n────────────────────')
  if (fail === 0) {
    console.log('✅ persona/cloud 专项通过 ' + pass + ' 项，失败 0 项')
    process.exit(0)
  }
  console.log('❌ persona/cloud 专项通过 ' + pass + ' 项，失败 ' + fail + ' 项')
  for (const f of failures) console.log('   · ' + f)
  process.exit(1)
}

main().catch((e) => {
  console.error('[persona-cloud] 崩溃：' + ((e && e.stack) || e))
  try { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }) } catch { }
  try { rmSync(TMP, { recursive: true, force: true }) } catch { }
  process.exit(1)
})

// 看门狗：断言里一处 await 永远不 resolve 时，事件循环会空、Node 以 0 退出（假绿）。
// 这个 ref'd 计时器保证「卡住」一定以非 0 结束并说清原因。
setTimeout(() => {
  console.error('[persona-cloud] 看门狗超时：套件里有 await 永远没回来（假绿保护）')
  try { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }) } catch { }
  try { rmSync(TMP, { recursive: true, force: true }) } catch { }
  process.exit(1)
}, 120000)
