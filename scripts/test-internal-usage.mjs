/**
 * scripts/test-internal-usage.mjs —— B97「内部模型用量进鱼账本」专项回归（离线，不联网、不碰用户目录）
 *
 * 背景：鱼账本原先只记聊天（routes/chat.ts）与说书（routes/story.ts）两条链路；
 * 后台长期记忆摘要（chat-core.summarizeMemory）、人格 L2 学习（personality-learn）、
 * 人格 L3 自写（personality-write）这三次内部模型调用**没有记账**，账本金额低于真实账单。
 *
 * 覆盖：
 *   [1] 契约：summarizeMemory 的第 6 个可选记账形参、chat-core 导出面没被扩大
 *       （扩大就会让 scripts/gen-module-index.mjs --check 判定 docs/模块接口清单 过期）、
 *       人格两模块不静态 import 计价模块（那条封闭白名单见 test-persona-cloud 第 [7] 节）；
 *   [2] chat-core.summarizeMemory：拿到 usage 记账（带拆分与金额）、拿不到不记、脏 usage 不记、
 *       注入缺失不抛、HTTP 非 2xx / 抛错 / 记录器自己抛错 → 主链路照常（失败仍静默、返回不变）；
 *   [3] personality-learn：同上，另含「解析失败仍记账（token 已经花了）」与注入口只给一半时不抛；
 *   [4] personality-write：同上，另含「SELF-SKIP / SELF-SAME 仍记账」；
 *   [5] 总量口径：真仓储（repos/fishfood.ts）跑一遍，证明 kind='summary'/'personality'
 *       与 kind='chat' 的 chatTokens/dayTokens/monthTokens/totalTokens **逐个字段相等**
 *       （该仓储只把 'story' 单独计，其余 kind 一律并进 chatTokens）；
 *   [6] 接线现状（只打印，不断言）：仓库里三个调用点目前都还没被装配层注入记账端口。
 *
 * 说明：本批次（B97）只允许改 chat-core / personality-learn / personality-write / ports，
 * 不允许改 package.json 与 scripts/test.mjs，所以本文件**不在 npm test 清单里**，需手动跑：
 *   node scripts/test-internal-usage.mjs
 *
 * 用法：node scripts/test-internal-usage.mjs
 * 退出码：0 = 全过；1 = 有失败
 */
import path from 'node:path'
import os from 'node:os'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'

// 直接加载 .ts：把找不到的 .js 回退到同名 .ts（与 scripts/test.mjs 同口径）
register(new URL('./ts-resolve.mjs', import.meta.url))

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; failures.push(name); console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), '期望 ' + JSON.stringify(b) + ' / 实际 ' + JSON.stringify(a)) }
const near = (a, b, tol = 1e-9) => Math.abs(Number(a) - Number(b)) <= tol

const tmpDirs = []
function tmpDir(tag) {
  const d = mkdtempSync(path.join(os.tmpdir(), 'b97-usage-' + tag + '-'))
  tmpDirs.push(d)
  return d
}

/** 北京某日某时的绝对时刻（北京 = UTC+8）。2026-11-09 周一、2026-11-07 周六 */
const bj = (y, m, d, hh, mm = 0) => new Date(Date.UTC(y, m - 1, d, hh - 8, mm, 0))
const PEAK_AT = bj(2026, 11, 9, 10)   // 工作日 10:00 → 高峰
const OFF_AT = bj(2026, 11, 7, 3)     // 周六凌晨 → 空闲

/** 金额只可能落在两档之一（真实调用拿当前时间判高峰/空闲，测试不锁死时钟，按候选集断言） */
function costCandidates(split, model) {
  const peak = P.estimateCostCny(split, model, PEAK_AT)
  const off = P.estimateCostCny(split, model, OFF_AT)
  return [peak && peak.cny, off && off.cny]
}

/** 收集 console.error / console.warn，保持测试输出干净，同时可断言「失败仍只记日志」 */
function quietConsole() {
  const logs = []
  const orig = { error: console.error, warn: console.warn }
  console.error = (...a) => { logs.push(a.join(' ')) }
  console.warn = (...a) => { logs.push(a.join(' ')) }
  return { logs, restore() { console.error = orig.error; console.warn = orig.warn } }
}

const P = await load('src/shared/pricing.ts')
const CORE = await load('src/host/chat-core.ts')
const L = await load('src/host/personality-learn.ts')
const W = await load('src/host/personality-write.ts')
const PER = await load('src/host/personality.ts')
const FISH = await load('src/host/repos/fishfood.ts')

const MODEL = 'deepseek-flash'
/** 一次内部调用典型 usage：输入 900（其中 300 命中缓存）+ 输出 120 = 1020 */
const USAGE = { total_tokens: 1020, prompt_tokens: 900, completion_tokens: 120, prompt_cache_hit_tokens: 300 }
const SPLIT = { promptTokens: 900, completionTokens: 120, cacheHitTokens: 300 }
const [COST_PEAK, COST_OFF] = costCandidates(SPLIT, MODEL)

/**
 * 人格模块的鱼账本端口：装配层将来要注入的就是这个形状。
 * addTokens 用真 store（或测试收集器），两个计价函数用 shared/pricing 的真实现——
 * 模块自己**不** import 计价模块（test-persona-cloud 第 [7] 节的封闭白名单）。
 */
const mkLedger = (addTokens, opt = {}) => ({
  addTokens,
  readUsageSplit: opt.readUsageSplit === undefined ? P.readUsageSplit : opt.readUsageSplit,
  estimateCostCny: opt.estimateCostCny === undefined ? P.estimateCostCny : opt.estimateCostCny,
})

try {
  // ========== [1] 契约与接线缝 ==========
  console.log('\n[1] 契约与接线缝')
  {
    eq('summarizeMemory 有第 6 个可选形参（记账端口的位置）', CORE.summarizeMemory.length, 6)
    // 为什么不抽公共记账函数：抽成 chat-core 的导出会让 scripts/gen-module-index.mjs --check
    // 判定 docs/模块接口清单.md 过期，而本批次不许改 docs。这里钉住「导出面不得被扩」。
    const banned = ['recordUsageTokens', 'UsageTokenRecorder', 'UsageTokenDetail', 'USAGE_SOURCE_SUMMARY', 'USAGE_SOURCE_PERSONALITY']
    eq('chat-core 没有新增导出（否则 docs/模块接口清单 会过期、npm test 会红）', banned.filter((k) => k in CORE), [])
    eq('personality-learn 没有新增导出', banned.filter((k) => k in L), [])
    eq('personality-write 没有新增导出', banned.filter((k) => k in W), [])

    const src = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')
    const learnSrc = src('src/host/personality-learn.ts')
    const writeSrc = src('src/host/personality-write.ts')
    ok('personality-learn 不静态 import 计价模块（走注入，守住 test-persona-cloud [7] 的白名单）',
      !/from\s+'[^']*pricing/.test(learnSrc))
    ok('personality-write 不静态 import 计价模块（同上）',
      !/from\s+'[^']*pricing/.test(writeSrc))
    ok('两模块的记账端口都是可选依赖（ledger?:，缺省跳过）',
      /ledger\?:/.test(learnSrc) && /ledger\?:/.test(writeSrc))
    ok('两模块都不直接调 fetch（只走注入的 fetchJson）',
      !/(^|[^A-Za-z.])fetch\(/.test(learnSrc) && !/(^|[^A-Za-z.])fetch\(/.test(writeSrc))
  }

  // ========== [2] chat-core.summarizeMemory ==========
  console.log('\n[2] 后台长期记忆摘要 summarizeMemory')
  {
    const origFetch = globalThis.fetch
    /** 把 fetch 换成「返回指定 payload」的桩；payload=null 表示抛错 */
    const stubFetch = (payload) => {
      globalThis.fetch = async () => {
        if (payload === null) throw new Error('boom')
        return {
          ok: payload.status ? payload.status < 300 : true,
          status: payload.status || 200,
          async text() { return JSON.stringify(payload.body || {}) },
          async json() { return payload.body || {} },
        }
      }
    }
    const SUMMARY_BODY = {
      choices: [{ message: { content: '主人爱吃白饭，叫李智梅' } }],
      usage: USAGE,
    }
    const NO_USAGE_BODY = { choices: [{ message: { content: '主人爱吃白饭' } }] }

    // ① 拿到 usage：记账带拆分与金额
    {
      const calls = []
      const saved = []
      stubFetch({ body: SUMMARY_BODY })
      await CORE.summarizeMemory('k', '主人：我爱吃白饭', '（无）', (s) => saved.push(s), MODEL, (...a) => { calls.push(a) })
      eq('记账一次', calls.length, 1)
      eq('kind = summary（新值，来源可辨）', calls[0] && calls[0][0], 'summary')
      eq('总量 = usage.total_tokens 原值', calls[0] && calls[0][1], 1020)
      const det = calls[0] && calls[0][2]
      eq('detail 字段名与聊天同口径（promptTokens/completionTokens/cacheHitTokens）',
        det && [det.promptTokens, det.completionTokens, det.cacheHitTokens], [900, 120, 300])
      ok('detail 带人民币估算（= 高峰档或空闲档之一）',
        det && (near(det.costCny, COST_PEAK) || near(det.costCny, COST_OFF)),
        JSON.stringify({ got: det && det.costCny, peak: COST_PEAK, off: COST_OFF }))
      ok('detail 带 source 留痕', det && det.source === 'summary', JSON.stringify(det && det.source))
      eq('摘要正文照常写回（记账不改变返回）', saved, ['主人爱吃白饭，叫李智梅'])
    }

    // ② 拿不到 usage：不记、不猜
    {
      const calls = []
      const saved = []
      stubFetch({ body: NO_USAGE_BODY })
      await CORE.summarizeMemory('k', '主人：我爱吃白饭', '（无）', (s) => saved.push(s), MODEL, (...a) => { calls.push(a) })
      eq('没有 usage → 一次都不记', calls.length, 0)
      eq('没有 usage 也照常写回摘要', saved, ['主人爱吃白饭'])
    }

    // ③ 有总量但拿不到输入/输出拆分：只记总量，不猜金额（照抄聊天口径）
    {
      const calls = []
      stubFetch({ body: { choices: [{ message: { content: '嗯' } }], usage: { total_tokens: 777 } } })
      await CORE.summarizeMemory('k', 'x', '（无）', () => { }, MODEL, (...a) => { calls.push(a) })
      eq('只有总量 → 记总量、不传 detail（不猜金额）',
        calls.length === 1 ? [calls[0][0], calls[0][1], calls[0][2]] : null, ['summary', 777, undefined])
    }

    // ③′ 脏 usage：都不是「可信总量」，一律不记（与聊天 typeof === 'number' 同口径）
    //     注意 NaN 例外：typeof NaN === 'number'，聊天链路也会照样把 NaN 交给 addTokens，
    //     由仓储的 cleanToken 清洗掉——那一条在 [5] 用真仓储验证（这里不重复断言）。
    {
      const bad = [
        ['usage 为 null', null],
        ['usage 是字符串', 'x'],
        ['usage 是数组', []],
        ['只有拆分没有总量', { prompt_tokens: 9, completion_tokens: 3 }],
        ['total_tokens 是字符串', { total_tokens: '1020' }],
      ]
      for (const [label, usage] of bad) {
        const calls = []
        stubFetch({ body: { choices: [{ message: { content: '嗯' } }], usage } })
        await CORE.summarizeMemory('k', 'x', '（无）', () => { }, MODEL, (...a) => { calls.push(a) })
        eq('脏 usage 不记：' + label, calls.length, 0)
      }
    }

    // ④ 注入缺失：不抛、不改变返回
    {
      const saved = []
      stubFetch({ body: SUMMARY_BODY })
      let threw = false
      try { await CORE.summarizeMemory('k', 'convo', '（无）', (s) => saved.push(s), MODEL) } catch { threw = true }
      eq('未注入记账端口：不抛错', threw, false)
      eq('未注入记账端口：摘要照常写回', saved, ['主人爱吃白饭，叫李智梅'])
    }

    // ⑤ 失败口径：HTTP 非 2xx / 网络抛错 → 不记、不抛、只记日志（既有静默不变）
    {
      const q = quietConsole()
      const calls = []
      let threw = false
      try {
        stubFetch({ status: 500, body: { error: 'boom' } })
        await CORE.summarizeMemory('k', 'convo', '（无）', () => { }, MODEL, (...a) => { calls.push(a) })
        stubFetch(null)
        await CORE.summarizeMemory('k', 'convo', '（无）', () => { }, MODEL, (...a) => { calls.push(a) })
      } catch { threw = true }
      q.restore()
      eq('HTTP 500 与网络抛错都不记账', calls.length, 0)
      eq('两种失败都不抛给调用方', threw, false)
      ok('两种失败仍各记一行 [chat] 日志（排障口径不变）',
        q.logs.some((l) => l.includes('[chat] SUMMARY-HTTP 500')) && q.logs.some((l) => l.includes('[chat] SUMMARY-ERR')),
        JSON.stringify(q.logs))
    }

    // ⑥ 记账端口自己抛错：吞掉，不影响摘要写回
    {
      const q = quietConsole()
      const saved = []
      stubFetch({ body: SUMMARY_BODY })
      let threw = false
      try {
        await CORE.summarizeMemory('k', 'convo', '（无）', (s) => saved.push(s), MODEL, () => { throw new Error('账本写盘失败') })
      } catch { threw = true }
      q.restore()
      eq('记账抛错不冒出去', threw, false)
      eq('记账抛错后摘要仍写回', saved, ['主人爱吃白饭，叫李智梅'])
    }

    globalThis.fetch = origFetch
  }

  // ========== [3] personality-learn ==========
  console.log('\n[3] 人格 L2 学习 personality-learn')
  {
    const hist = Array.from({ length: 16 }, () => ({ role: 'user', content: '我最喜欢吃白饭了' }))
    const okReply = (usage) => ({ ok: true, status: 200, data: { choices: [{ message: { content: '{"preferences":["喜欢吃白饭"]}' } }], usage }, text: '' })
    const repoFor = (tag) => PER.createPersonalityRepo(tmpDir(tag))

    // ① 拿到 usage：记账
    {
      const calls = []
      const learner = L.createPersonalityLearner({
        repo: repoFor('learn-ok'), getKey: () => 'k', loadHistory: () => hist, model: MODEL,
        fetchJson: async () => okReply(USAGE),
        ledger: mkLedger((...a) => { calls.push(a) }),
      })
      const r = await learner.learnNow()
      eq('学习照常成功（记账不改变返回）', [r.ok, r.changed], [true, ['preferences']])
      eq('记账一次', calls.length, 1)
      eq('kind = personality', calls[0] && calls[0][0], 'personality')
      eq('总量 = usage.total_tokens', calls[0] && calls[0][1], 1020)
      const det = calls[0] && calls[0][2]
      eq('detail 拆分与聊天同口径', det && [det.promptTokens, det.completionTokens, det.cacheHitTokens], [900, 120, 300])
      ok('detail 带人民币估算', det && (near(det.costCny, COST_PEAK) || near(det.costCny, COST_OFF)), JSON.stringify(det && det.costCny))
      ok('detail 带 source 留痕', det && det.source === 'personality', JSON.stringify(det && det.source))
    }

    // ② 解析失败：tokens 已经花了，仍要记
    {
      const calls = []
      const learner = L.createPersonalityLearner({
        repo: repoFor('learn-parse'), getKey: () => 'k', loadHistory: () => hist, model: MODEL,
        fetchJson: async () => ({ ok: true, status: 200, data: { choices: [{ message: { content: '不是 JSON' } }], usage: USAGE }, text: '' }),
        ledger: mkLedger((...a) => { calls.push(a) }),
      })
      const q = quietConsole()
      const r = await learner.learnNow()
      q.restore()
      eq('解析失败仍不写盘（既有行为不变）', r.reason, 'parse')
      eq('解析失败仍记账（这次外呼确实花了 token）', [calls.length, calls[0] && calls[0][0], calls[0] && calls[0][1]], [1, 'personality', 1020])
      ok('解析失败仍只记一行 [personality] 日志', q.logs.some((l) => l.includes('[personality] LEARN-PARSE')), JSON.stringify(q.logs))
    }

    // ③ 拿不到 usage / HTTP 非 2xx / 无 Key / 空历史 → 不记
    {
      const noUsageCalls = []
      const noUsage = L.createPersonalityLearner({
        repo: repoFor('learn-nousage'), getKey: () => 'k', loadHistory: () => hist, model: MODEL,
        fetchJson: async () => okReply(undefined),
        ledger: mkLedger((...a) => { noUsageCalls.push(a) }),
      })
      eq('没有 usage → 不记（也不影响成功）', [noUsageCalls.length, (await noUsage.learnNow()).ok], [0, true])

      const httpCalls = []
      const http = L.createPersonalityLearner({
        repo: repoFor('learn-http'), getKey: () => 'k', loadHistory: () => hist, model: MODEL,
        fetchJson: async () => ({ ok: false, status: 500, data: null, text: 'boom' }),
        ledger: mkLedger((...a) => { httpCalls.push(a) }),
      })
      const q = quietConsole()
      const rHttp = await http.learnNow()
      q.restore()
      eq('HTTP 500 → 不记、返回不变', [httpCalls.length, rHttp.reason], [0, 'HTTP 500'])

      let keyMark = 0
      const noKey = L.createPersonalityLearner({
        repo: repoFor('learn-nokey'), getKey: () => '', loadHistory: () => hist, model: MODEL,
        fetchJson: async () => { keyMark += 1; return okReply(USAGE) },
        ledger: mkLedger(() => { keyMark += 100 }),
      })
      eq('无 Key → 不发请求也不记账', [(await noKey.learnNow()).reason, keyMark], ['NO_KEY', 0])

      let emptyMark = 0
      const empty = L.createPersonalityLearner({
        repo: repoFor('learn-empty'), getKey: () => 'k', loadHistory: () => [], model: MODEL,
        fetchJson: async () => { emptyMark += 1; return okReply(USAGE) },
        ledger: mkLedger(() => { emptyMark += 100 }),
      })
      eq('空历史 → 不发请求也不记账', [(await empty.learnNow()).reason, emptyMark], ['EMPTY', 0])
    }

    // ④ 注入缺失 / 注入口只给一半 / 记录器抛错 → 都不抛、返回不变
    {
      const learner = L.createPersonalityLearner({
        repo: repoFor('learn-noinject'), getKey: () => 'k', loadHistory: () => hist, model: MODEL,
        fetchJson: async () => okReply(USAGE),
      })
      let threw = false
      let r = null
      try { r = await learner.learnNow() } catch { threw = true }
      eq('未注入记账端口：不抛错、学习照常成功', [threw, r && r.ok], [false, true])

      // 只给 addTokens、缺两个计价函数：必须整段跳过，不能抛也不能记半笔
      const halfCalls = []
      const half = L.createPersonalityLearner({
        repo: repoFor('learn-half'), getKey: () => 'k', loadHistory: () => hist, model: MODEL,
        fetchJson: async () => okReply(USAGE),
        ledger: { addTokens: (...a) => { halfCalls.push(a) } },
      })
      let threwHalf = false
      let rHalf = null
      try { rHalf = await half.learnNow() } catch { threwHalf = true }
      eq('注入口只给一半：不抛错、不记半笔、学习照常成功', [threwHalf, halfCalls.length, rHalf && rHalf.ok], [false, 0, true])

      const boom = L.createPersonalityLearner({
        repo: repoFor('learn-boom'), getKey: () => 'k', loadHistory: () => hist, model: MODEL,
        fetchJson: async () => okReply(USAGE),
        ledger: mkLedger(() => { throw new Error('账本写盘失败') }),
      })
      let threw2 = false
      let r2 = null
      try { r2 = await boom.learnNow() } catch { threw2 = true }
      eq('记账端口抛错：不冒出去、学习照常成功', [threw2, r2 && r2.ok], [false, true])
    }

    // ⑤ noteSuccess 路径（后台触发）也走同一记账
    {
      const calls = []
      const now = Date.UTC(2026, 10, 7, 0, 0, 0)
      const learner = L.createPersonalityLearner({
        repo: repoFor('learn-note'), getKey: () => 'k', loadHistory: () => hist, model: MODEL, now: () => now,
        fetchJson: async () => okReply(USAGE),
        ledger: mkLedger((...a) => { calls.push(a) }),
      })
      for (let i = 0; i < 20; i++) learner.noteSuccess()
      await new Promise((res) => setTimeout(res, 30))
      eq('noteSuccess 触发的后台学习同样记账（kind=personality）', [calls.length, calls[0] && calls[0][0]], [1, 'personality'])
    }
  }

  // ========== [4] personality-write ==========
  console.log('\n[4] 人格 L3 自写 personality-write')
  {
    const hist = Array.from({ length: 16 }, () => ({ role: 'user', content: '今天有点累' }))
    const okReply = (usage, content) => ({
      ok: true, status: 200,
      data: { choices: [{ message: { content: content === undefined ? '最近有点困，话少一点' : content } }], usage },
      text: '',
    })
    const repoFor = (tag) => PER.createPersonalityRepo(tmpDir(tag))
    const depsOf = (tag, fetchJson, ledger) => ({
      repo: repoFor(tag), getKey: () => 'k', loadHistory: () => hist,
      corePrompt: () => '核心人设', model: MODEL, fetchJson, ledger,
    })

    // ① 拿到 usage：记账
    {
      const calls = []
      const writer = W.createSelfNarrativeWriter(depsOf('write-ok', async () => okReply(USAGE), mkLedger((...a) => { calls.push(a) })))
      const r = await writer.writeNow()
      eq('自写照常成功（记账不改变返回）', [r.ok, r.text], [true, '最近有点困，话少一点'])
      eq('记账一次、kind = personality', [calls.length, calls[0] && calls[0][0]], [1, 'personality'])
      eq('总量 = usage.total_tokens', calls[0] && calls[0][1], 1020)
      const det = calls[0] && calls[0][2]
      eq('detail 拆分与聊天同口径', det && [det.promptTokens, det.completionTokens, det.cacheHitTokens], [900, 120, 300])
      ok('detail 带人民币估算', det && (near(det.costCny, COST_PEAK) || near(det.costCny, COST_OFF)), JSON.stringify(det && det.costCny))
      ok('detail 带 source 留痕', det && det.source === 'personality', JSON.stringify(det && det.source))
    }

    // ② 限域验收失败（含身份词）：整句丢弃不写盘，但 token 已花 → 仍记账
    {
      const calls = []
      const writer = W.createSelfNarrativeWriter(depsOf('write-identity', async () => okReply(USAGE, '我是肥鲸，最近有点困'), mkLedger((...a) => { calls.push(a) })))
      const q = quietConsole()
      const r = await writer.writeNow()
      q.restore()
      eq('身份词整句丢弃（既有行为不变）', r.reason, 'IDENTITY')
      eq('SELF-SKIP 仍记账', [calls.length, calls[0] && calls[0][0]], [1, 'personality'])
      ok('SELF-SKIP 仍只记一行 [personality] 日志', q.logs.some((l) => l.includes('[personality] SELF-SKIP')), JSON.stringify(q.logs))
    }

    // ③ 与现有心境一字不差（same）：不写盘仍记账
    {
      const calls = []
      const writer = W.createSelfNarrativeWriter(depsOf('write-same', async () => okReply(USAGE), mkLedger((...a) => { calls.push(a) })))
      await writer.writeNow()
      const q = quietConsole()
      const again = await writer.writeNow()
      q.restore()
      eq('第二次与现有心境相同：不写盘（既有行为不变）', again.reason, 'same')
      eq('SELF-SAME 仍记账（两次都算）', [calls.length, calls.map((c) => c[1])], [2, [1020, 1020]])
    }

    // ④ 拿不到 usage / HTTP 非 2xx → 不记
    {
      const noUsageCalls = []
      const noUsage = W.createSelfNarrativeWriter(depsOf('write-nousage', async () => okReply(undefined), mkLedger((...a) => { noUsageCalls.push(a) })))
      eq('没有 usage → 不记（也不影响成功）', [noUsageCalls.length, (await noUsage.writeNow()).ok], [0, true])

      const httpCalls = []
      const http = W.createSelfNarrativeWriter(depsOf('write-http', async () => ({ ok: false, status: 500, data: null, text: 'boom' }), mkLedger((...a) => { httpCalls.push(a) })))
      const q = quietConsole()
      const rHttp = await http.writeNow()
      q.restore()
      eq('HTTP 500 → 不记、返回不变', [httpCalls.length, rHttp.reason], [0, 'HTTP 500'])
    }

    // ⑤ 注入缺失 / 记录器抛错 → 都不抛、返回不变
    {
      const writer = W.createSelfNarrativeWriter(depsOf('write-noinject', async () => okReply(USAGE), undefined))
      let threw = false
      let r = null
      try { r = await writer.writeNow() } catch { threw = true }
      eq('未注入记账端口：不抛错、自写照常成功', [threw, r && r.ok], [false, true])

      const boom = W.createSelfNarrativeWriter(depsOf('write-boom', async () => okReply(USAGE), mkLedger(() => { throw new Error('账本写盘失败') })))
      let threw2 = false
      let r2 = null
      try { r2 = await boom.writeNow() } catch { threw2 = true }
      eq('记账端口抛错：不冒出去、自写照常成功', [threw2, r2 && r2.ok], [false, true])
    }
  }

  // ========== [5] 总量口径：新 kind 不破坏账本总量 ==========
  console.log('\n[5] 总量口径（真仓储 fishfood.ts）')
  {
    const hist = Array.from({ length: 16 }, () => ({ role: 'user', content: '我最喜欢吃白饭了' }))
    const total1 = 1020   // 摘要
    const total2 = 640    // 人格学习
    const usage1 = { total_tokens: total1, prompt_tokens: 900, completion_tokens: 120, prompt_cache_hit_tokens: 300 }
    const usage2 = { total_tokens: total2, prompt_tokens: 600, completion_tokens: 40, prompt_cache_hit_tokens: 0 }

    // 真账本 + 两条内部链路各跑一次（addTokens 用真 store，计价用真 pricing）
    const store = FISH.createTokenRepo(tmpDir('ledger-internal'))
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      async text() { return JSON.stringify({ choices: [{ message: { content: '摘要正文' } }], usage: usage1 }) },
      async json() { return {} },
    })
    await CORE.summarizeMemory('k', 'convo', '（无）', () => { }, MODEL, store.addTokens)
    globalThis.fetch = origFetch
    const learner = L.createPersonalityLearner({
      repo: PER.createPersonalityRepo(tmpDir('ledger-internal-personality')), getKey: () => 'k', loadHistory: () => hist, model: MODEL,
      fetchJson: async () => ({ ok: true, status: 200, data: { choices: [{ message: { content: '{"preferences":["白饭"]}' } }], usage: usage2 }, text: '' }),
      ledger: mkLedger(store.addTokens),
    })
    await learner.learnNow()

    const f = store.loadFishfood()
    const expectTotal = total1 + total2
    eq('总量 = 两次内部调用之和', f.totalTokens, expectTotal)
    eq('全部并进 chatTokens（仓储只有 story 单独计）', f.chatTokens, expectTotal)
    eq('storyTokens 不受影响', f.storyTokens, 0)
    eq('当日/当月总量同步累加', [f.dayTokens, f.monthTokens], [expectTotal, expectTotal])
    eq('拆分累计 = 两次 usage 的 prompt/completion/cacheHit 之和',
      [f.promptTokens, f.completionTokens, f.cacheHitTokens], [900 + 600, 120 + 40, 300 + 0])
    const c1 = P.estimateCostCny({ promptTokens: 900, completionTokens: 120, cacheHitTokens: 300 }, MODEL)
    const c2 = P.estimateCostCny({ promptTokens: 600, completionTokens: 40, cacheHitTokens: 0 }, MODEL)
    ok('金额累计 = 两笔估算之和',
      near(f.costCny, c1.cny + c2.cny) && near(f.dayCostCny, c1.cny + c2.cny) && near(f.monthCostCny, c1.cny + c2.cny),
      JSON.stringify({ got: [f.costCny, f.dayCostCny, f.monthCostCny], want: c1.cny + c2.cny }))

    // 对照：同样的总量若按老口径传 'chat'（不带明细），四个总量必须完全相等
    const storeChat = FISH.createTokenRepo(tmpDir('ledger-chat'))
    storeChat.addTokens('chat', total1)
    storeChat.addTokens('chat', total2)
    const g = storeChat.loadFishfood()
    eq("kind 换成 'summary'/'personality' 与传 'chat' 的四个总量逐个相等",
      [f.chatTokens, f.dayTokens, f.monthTokens, f.totalTokens],
      [g.chatTokens, g.dayTokens, g.monthTokens, g.totalTokens])
    ok('既不丢量也不重复计（总量恰好等于 chat 口径）', f.totalTokens === g.totalTokens && f.chatTokens === g.chatTokens)

    // 反过来：新 kind 不会被误记成 story
    const storeStory = FISH.createTokenRepo(tmpDir('ledger-story'))
    storeStory.addTokens('summary', 100)
    storeStory.addTokens('personality', 100)
    const s = storeStory.loadFishfood()
    eq('summary/personality 都不进 storyTokens', [s.storyTokens, s.chatTokens, s.totalTokens], [0, 200, 200])

    // NaN 总量：与聊天链路同口径——照样交给 addTokens，由仓储 cleanToken 清洗，账本一个字段都不变
    const before = store.loadFishfood()
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      async text() {
        return JSON.stringify({ choices: [{ message: { content: '摘要' } }], usage: { total_tokens: Number.NaN, prompt_tokens: 10, completion_tokens: 5 } })
      },
      async json() { return {} },
    })
    await CORE.summarizeMemory('k', 'convo', '（无）', () => { }, MODEL, store.addTokens)
    globalThis.fetch = origFetch
    const after = store.loadFishfood()
    eq('total_tokens=NaN：不写坏账本（总量/拆分/金额全不变）',
      [after.totalTokens, after.chatTokens, after.promptTokens, after.costCny],
      [before.totalTokens, before.chatTokens, before.promptTokens, before.costCny])
  }

  // ========== [6] 接线现状（只打印，不断言） ==========
  console.log('\n[6] 接线现状（信息，不计入断言）')
  {
    // 只截「这一次调用」的实参文本：按括号配对扫，别用宽松正则——宽松写法会把
    // index.ts 里聊天路由的 addTokens 误当成人格链路的注入（假绿）。
    const argText = (src, name) => {
      const i = src.indexOf(name + '(')
      if (i < 0) return null
      let depth = 0
      let started = false
      for (let k = i + name.length; k < src.length; k++) {
        const ch = src[k]
        if (ch === '(') { depth++; started = true }
        else if (ch === ')') { depth--; if (started && depth === 0) return src.slice(i + name.length + 1, k) }
      }
      return null
    }
    for (const rel of ['src/host/routes/chat.ts', 'src/host/routes/chat-stream.ts']) {
      const args = argText(readFileSync(path.join(ROOT, rel), 'utf8'), 'summarizeMemory')
      if (args === null) { console.log('  · ' + rel + '：没找到 summarizeMemory 调用点（文件结构变了，需人工核对）'); continue }
      const wired = /\baddTokens\b/.test(args)
      console.log('  · ' + rel + '：' + (wired ? '已把记账端口传给 summarizeMemory' : '仍只传 5 个实参 → 该链路仍漏账，属已知缺口'))
    }
    const idx = readFileSync(path.join(ROOT, 'src/index.ts'), 'utf8')
    for (const [label, call] of [
      ['L2 学习 createPersonalityLearner', 'createPersonalityLearner'],
      ['L3 自写 createSelfNarrativeWriter', 'createSelfNarrativeWriter'],
    ]) {
      const args = argText(idx, call)
      if (args === null) { console.log('  · src/index.ts：没找到 ' + call + ' 装配（需人工核对）'); continue }
      const wired = /\bledger\b/.test(args)
      console.log('  · src/index.ts：' + label + '：' + (wired ? '已注入 ledger' : '未注入 ledger → 该链路仍漏账，属已知缺口'))
    }
  }
} finally {
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }) } catch { } }
}

console.log('\n' + '='.repeat(48))
console.log(`通过 ${pass} 项 / 失败 ${fail} 项`)
if (fail > 0) {
  for (const f of failures) console.log('   · ' + f)
  process.exit(1)
}
console.log('✅ B97 内部模型用量记账专项全部通过')
