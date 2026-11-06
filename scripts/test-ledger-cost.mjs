/**
 * scripts/test-ledger-cost.mjs —— 鱼账本（token 明细 + 人民币估算）回归
 *
 * 覆盖：
 *   ① 价目表：deepseek-flash / deepseek-v4-pro 的高峰与空闲单价、未知模型回落；
 *   ② 时段判定：北京时间工作日 9–12 / 14–18 为高峰，周末与边界外为空闲；
 *   ③ 计费：缓存命中/未命中/输出三段分别计价；缺输入输出拆分时返回 null（不猜）；
 *   ④ 仓储：addTokens 带明细时累加拆分与金额，跨天清当日金额、跨月清当月；
 *   ⑤ 路由：/fishfood 与 /stats 输出字段；老文件（无明细）按 0 且不报错；
 *   ⑥ 聊天链路：/chat 拿到 usage 拆分时把明细与金额一起交给 addTokens。
 *
 * 价格出处：https://api-docs.deepseek.com/zh-cn/quick_start/pricing（2026-11-07 实抓，见 shared/pricing.ts）
 */
import { register } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
register(new URL('./ts-resolve.mjs', import.meta.url))

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), '期望 ' + JSON.stringify(b) + ' / 实际 ' + JSON.stringify(a)) }
const near = (a, b, tol = 1e-9) => Math.abs(Number(a) - Number(b)) <= tol

const P = await import(pathToFileURL(join(ROOT, 'src/shared/pricing.ts')).href)

// 北京时间构造：用 UTC 时间算出「北京某日某时」的绝对时刻（北京 = UTC+8）
function bj(y, m, d, hh, mm = 0) {
  return new Date(Date.UTC(y, m - 1, d, hh - 8, mm, 0))
}

console.log('\n[1] 价目表与时段')
{
  eq('价格核对日期固定可追溯', P.PRICING_CHECKED_AT, '2026-11-07')
  ok('价格来源指向官方页', String(P.PRICING_SOURCE).includes('api-docs.deepseek.com/zh-cn/quick_start/pricing'))
  eq('flash 三档单价（峰/闲）',
    [P.MODEL_PRICES['deepseek-flash'].cacheHit.peak, P.MODEL_PRICES['deepseek-flash'].cacheHit.off,
      P.MODEL_PRICES['deepseek-flash'].cacheMiss.peak, P.MODEL_PRICES['deepseek-flash'].cacheMiss.off,
      P.MODEL_PRICES['deepseek-flash'].output.peak, P.MODEL_PRICES['deepseek-flash'].output.off],
    [0.04, 0.02, 2, 1, 8, 4])
  eq('pro 三档单价（峰/闲）',
    [P.MODEL_PRICES['deepseek-v4-pro'].cacheHit.peak, P.MODEL_PRICES['deepseek-v4-pro'].output.off],
    [0.3, 13.5])
  ok('价目表冻结（外部改不动）', Object.isFrozen(P.MODEL_PRICES) && Object.isFrozen(P.MODEL_PRICES['deepseek-flash']))

  // 2026-11-09 是周一；11-07 是周六（用 UTC 构造避免本机时区影响）
  eq('工作日 10:00 → 高峰', P.isPeakHour(bj(2026, 11, 9, 10)), true)
  eq('工作日 12:00 整 → 空闲（区间左闭右开）', P.isPeakHour(bj(2026, 11, 9, 12)), false)
  eq('工作日 13:59 → 空闲', P.isPeakHour(bj(2026, 11, 9, 13, 59)), false)
  eq('工作日 14:00 → 高峰', P.isPeakHour(bj(2026, 11, 9, 14)), true)
  eq('工作日 18:00 整 → 空闲', P.isPeakHour(bj(2026, 11, 9, 18)), false)
  eq('工作日 08:59 → 空闲', P.isPeakHour(bj(2026, 11, 9, 8, 59)), false)
  eq('周六 10:00 → 空闲', P.isPeakHour(bj(2026, 11, 7, 10)), false)
  eq('周日 15:00 → 空闲', P.isPeakHour(bj(2026, 11, 8, 15)), false)
  eq('非法时间按高峰（保守，只多估）', P.isPeakHour(Number.NaN), true)
}

console.log('\n[2] 计费公式')
{
  const peakAt = bj(2026, 11, 9, 10)      // 高峰
  const offAt = bj(2026, 11, 7, 3)        // 周六凌晨 → 空闲
  // 1M 输入(未命中) + 1M 输出，flash 高峰 = 2 + 8 = 10 元
  const r1 = P.estimateCostCny({ promptTokens: 1e6, completionTokens: 1e6 }, 'deepseek-flash', peakAt)
  ok('100 万输入 + 100 万输出（高峰 flash）= 10 元', r1 && near(r1.cny, 10), JSON.stringify(r1))
  const r2 = P.estimateCostCny({ promptTokens: 1e6, completionTokens: 1e6 }, 'deepseek-flash', offAt)
  ok('同一用量空闲 = 5 元（半价）', r2 && near(r2.cny, 5), JSON.stringify(r2))
  // 缓存命中：1M 命中 + 0 输出，flash 高峰 = 0.04
  const r3 = P.estimateCostCny({ promptTokens: 1e6, cacheHitTokens: 1e6, completionTokens: 0 }, 'deepseek-flash', peakAt)
  ok('全部命中缓存只按 0.04 元/百万计', r3 && near(r3.cny, 0.04), JSON.stringify(r3))
  // 混合：1M 里 40 万命中、60 万未命中 → 0.4*0.04 + 0.6*2 = 1.216
  const r4 = P.estimateCostCny({ promptTokens: 1e6, cacheHitTokens: 4e5, completionTokens: 0 }, 'deepseek-flash', peakAt)
  ok('命中与未命中分别计价', r4 && near(r4.cny, 1.216), JSON.stringify(r4))
  // 命中数超过输入数：夹到输入总数（不出现负的未命中）
  const r5 = P.estimateCostCny({ promptTokens: 100, cacheHitTokens: 9999, completionTokens: 0 }, 'deepseek-flash', peakAt)
  ok('命中数超过输入时夹住（不出负数）', r5 && r5.cny >= 0 && near(r5.cny, 100 * 0.04 / 1e6), JSON.stringify(r5))
  // pro 档
  const r6 = P.estimateCostCny({ promptTokens: 1e6, completionTokens: 0 }, 'deepseek-v4-pro', peakAt)
  ok('pro 高峰未命中输入 = 9 元', r6 && near(r6.cny, 9), JSON.stringify(r6))
  // 未知模型回落 flash 并标注
  const r7 = P.estimateCostCny({ promptTokens: 1e6 }, 'some-unknown-model', peakAt)
  ok('未知模型回落 flash 并标 model', r7 && r7.model === 'deepseek-flash' && near(r7.cny, 2), JSON.stringify(r7))
  // 没有拆分 → null（不猜）
  eq('只有 total 时返回 null（不猜金额）', P.estimateCostCny({}, 'deepseek-flash', peakAt), null)
  eq('null usage 返回 null', P.estimateCostCny(null, 'deepseek-flash', peakAt), null)
  eq('全零拆分返回 null', P.estimateCostCny({ promptTokens: 0, completionTokens: 0 }, 'deepseek-flash', peakAt), null)
  // 脏值
  const r8 = P.estimateCostCny({ promptTokens: -5, completionTokens: Number.NaN }, 'deepseek-flash', peakAt)
  eq('负数/NaN 拆分按无拆分处理', r8, null)
  // 精度：1 token 输出 = 8e-6 元
  const r9 = P.estimateCostCny({ promptTokens: 0, completionTokens: 1 }, 'deepseek-flash', peakAt)
  ok('1 token 输出 = 0.000008 元（6 位小数保精度）', r9 && near(r9.cny, 8e-6, 1e-12), JSON.stringify(r9))
}

console.log('\n[3] usage 归一')
{
  eq('openai 风格字段', P.readUsageSplit({ prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 3 }),
    { promptTokens: 10, completionTokens: 5, cacheHitTokens: 3 })
  eq('驼峰字段也认', P.readUsageSplit({ promptTokens: 7, completionTokens: 2 }), { promptTokens: 7, completionTokens: 2, cacheHitTokens: 0 })
  eq('只有 total_tokens → null（不硬凑拆分）', P.readUsageSplit({ total_tokens: 99 }), null)
  eq('非对象 → null', P.readUsageSplit('x'), null)
}

console.log('\n[4] 仓储：明细累加与跨天/跨月滚动')
{
  const dir = mkdtempSync(join(tmpdir(), 'chubby-ledger-'))
  const repo = await import(pathToFileURL(join(ROOT, 'src/host/repos/fishfood.ts')).href)
  const r = repo.createTokenRepo(dir)

  r.addTokens('chat', 1000, { promptTokens: 800, completionTokens: 200, cacheHitTokens: 300, costCny: 0.0123 })
  const f1 = r.loadFishfood()
  eq('token 总量与拆分同时累加', [f1.totalTokens, f1.promptTokens, f1.completionTokens, f1.cacheHitTokens], [1000, 800, 200, 300])
  ok('金额落盘（total/day/month 三处）', near(f1.costCny, 0.0123) && near(f1.dayCostCny, 0.0123) && near(f1.monthCostCny, 0.0123), JSON.stringify([f1.costCny, f1.dayCostCny, f1.monthCostCny]))

  // 老调用方只传两个参数：行为不变，拆分/金额不变
  r.addTokens('story', 500)
  const f2 = r.loadFishfood()
  eq('只传总量时不改动拆分与金额', [f2.totalTokens, f2.promptTokens, f2.costCny], [1500, 800, 0.0123])

  // 脏明细：NaN/负数不写坏
  r.addTokens('chat', 10, { promptTokens: Number.NaN, completionTokens: -3, costCny: Number.NaN })
  const f3 = r.loadFishfood()
  eq('脏明细被清洗（拆分/金额不变）', [f3.promptTokens, f3.completionTokens, f3.costCny], [800, 200, 0.0123])

  // 跨天：改 day 后读一次 → 当日清零，总额不变
  const raw = JSON.parse(readFileSync(join(dir, 'fishfood.json'), 'utf8'))
  raw.day = '2000-01-01'
  writeFileSync(join(dir, 'fishfood.json'), JSON.stringify(raw), 'utf8')
  const f4 = r.loadFishfood()
  eq('跨天：当日 token 与当日金额清零、总额保留', [f4.dayTokens, f4.dayCostCny, f4.totalTokens], [0, 0, 1510])

  // 跨月：改 month 后读一次 → 当月清零
  const raw2 = JSON.parse(readFileSync(join(dir, 'fishfood.json'), 'utf8'))
  raw2.month = '2000-01'
  writeFileSync(join(dir, 'fishfood.json'), JSON.stringify(raw2), 'utf8')
  const f5 = r.loadFishfood()
  eq('跨月：当月 token 与当月金额清零、总额保留', [f5.monthTokens, f5.monthCostCny, f5.totalTokens], [0, 0, 1510])

  rmSync(dir, { recursive: true, force: true })
}

console.log('\n[5] 路由输出')
{
  const dir = mkdtempSync(join(tmpdir(), 'chubby-ledger-route-'))
  const misc = await import(pathToFileURL(join(ROOT, 'src/host/routes/misc.ts')).href)
  const loadFishfood = () => ({
    chatTokens: 120, storyTokens: 30, totalTokens: 150, dayTokens: 20, monthTokens: 150,
    promptTokens: 90, completionTokens: 30, cacheHitTokens: 10,
    costCny: 0.0042, dayCostCny: 0.0011, monthCostCny: 0.0042,
  })
  const handler = misc.createMiscHandlers({ loadFishfood })
  const res = mkRes()
  await handler.handleFishfood({ url: '/api/chubby-whale/fishfood' }, res)
  const body = res.json()
  ok('/fishfood 返回 200 与明细金额', res.code === 200 && body.ok === true, 'code=' + res.code)
  eq('chat/story/total 口径不变', [body.chatTokens, body.storyTokens, body.total, body.dayTokens], [120, 30, 150, 20])
  eq('明细与金额', [body.promptTokens, body.completionTokens, body.cacheHitTokens, body.costCny, body.dayCostCny, body.monthCostCny],
    [90, 30, 10, 0.0042, 0.0011, 0.0042])
  ok('带估算说明与价格溯源', body.costIsEstimate === true && String(body.priceSource).includes('api-docs') && body.priceCheckedAt === '2026-11-07', JSON.stringify({ s: body.priceSource, d: body.priceCheckedAt }))

  // 老文件（无明细字段）不报错、按 0
  const h2 = misc.createMiscHandlers({ loadFishfood: () => ({ chatTokens: 1, storyTokens: 2 }) })
  const r2 = mkRes()
  await h2.handleFishfood({ url: '/api/chubby-whale/fishfood' }, r2)
  const b2 = r2.json()
  eq('老文件缺字段 → 0（不返回 null/NaN）', [b2.promptTokens, b2.costCny, b2.total], [0, 0, 3])

  rmSync(dir, { recursive: true, force: true })
}

console.log('\n[6] 聊天链路把明细交给 addTokens')
{
  const chat = await import(pathToFileURL(join(ROOT, 'src/host/routes/chat.ts')).href)
  const calls = []
  const handler = chat.createChatHandler({
    getKey: () => 'k',
    loadHistory: () => [],
    appendTurns: () => { },
    loadState: () => ({ intimacy: 0 }),
    saveState: () => { },
    systemPrompt: 'SYS',
    addExp: () => ({ upgraded: false }),
    addTokens: (...args) => { calls.push(args) },
    model: 'deepseek-flash',
    cacheEnabled: () => false,
  })
  const CHAT_PAYLOAD = {
    choices: [{ message: { content: '好的' } }],
    usage: { total_tokens: 100, prompt_tokens: 80, completion_tokens: 20, prompt_cache_hit_tokens: 0 },
  }
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    // chat.ts 读的是 resp.text() 再 JSON.parse（不是 resp.json()），桩必须给同一个字符串
    async text() { return JSON.stringify(CHAT_PAYLOAD) },
    async json() { return CHAT_PAYLOAD },
  })
  const res = mkRes()
  await handler(mkReq({ message: '今天吃什么' }), res)
  ok('/chat 200', res.code === 200, 'code=' + res.code)
  ok('addTokens 收到 (kind, total, detail)', calls.length === 1 && calls[0][0] === 'chat' && calls[0][1] === 100, JSON.stringify(calls[0] && calls[0].slice(0, 2)))
  const det = calls[0] && calls[0][2]
  ok('detail 带输入/输出拆分', det && det.promptTokens === 80 && det.completionTokens === 20, JSON.stringify(det))
  ok('detail 带人民币估算（>0）', det && Number(det.costCny) > 0, JSON.stringify(det && det.costCny))
}

// ---------- 小工具 ----------
function mkReq(body) {
  const buf = Buffer.from(JSON.stringify(body))
  return {
    method: 'POST',
    url: '/api/chubby-whale/chat',
    headers: { 'content-length': String(buf.length) },
    destroy() { },
    on() { },
    resume() { },
    async *[Symbol.asyncIterator]() { yield buf },
  }
}
function mkRes() {
  const res = { code: 0, headers: {}, chunks: [] }
  res.writeHead = (c, h) => { res.code = c; res.headers = h || {} }
  res.setHeader = () => { }
  res.write = (c) => { res.chunks.push(Buffer.from(String(c))); return true }
  res.end = (c) => { if (c !== undefined) res.chunks.push(Buffer.from(String(c))) }
  res.on = () => { }
  res.raw = () => Buffer.concat(res.chunks).toString('utf8')
  res.json = () => { try { return JSON.parse(res.raw()) } catch { return null } }
  return res
}

console.log('\n' + '='.repeat(48))
console.log(`通过 ${pass} 项 / 失败 ${fail} 项`)
if (fail > 0) process.exit(1)
console.log('✅ 鱼账本（token 明细 + 人民币估算）回归全部通过')
