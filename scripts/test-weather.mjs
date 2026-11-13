/**
 * scripts/test-weather.mjs —— 天气 A 方案（本地 wttr.in）专项回归（离线、不联网）
 *
 * 覆盖：
 *   A. 客户端意图 parseWeatherAsk：认得出「上海今天天气怎么样」，不劫持「天气晚来秋」
 *   B. 宿主取数 fetchWeatherNow：字段归一 / 中文描述 / 各类失败 / 非法城市不外呼
 *   C. /weather 路由：GET 形状、10 分钟缓存、失败不缓存、405、默认城市
 *   D. chat-route 接线：命中即气泡 + 朗读；失败说「没查到」；未命中原样交给模型
 *   E. 简报共用 cleanWeather：控制字符/「待办」污染被清洗
 *
 * 用法：node scripts/test-weather.mjs
 * 退出码：0 = 全过；1 = 有失败
 */
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

register(new URL('./ts-resolve.mjs', import.meta.url))

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else {
    fail++
    failures.push(name + (detail ? '  ' + detail : ''))
    console.log('  ❌ ' + name + (detail ? '  ' + detail : ''))
  }
}
function group(title) { console.log('\n' + title) }
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

const realFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('测试不许真联网') }

/** 假响应：JSON 体 */
function jsonRes(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}
/** 假 wttr j1 回包（字段形状照 2026-11-14 实测） */
function j1(over = {}) {
  return {
    current_condition: [Object.assign({
      temp_C: '19',
      FeelsLikeC: '20',
      humidity: '94',
      windspeedKmph: '13',
      'lang_zh-cn': [{ value: '多云' }],
      weatherDesc: [{ value: 'Cloudy' }],
    }, over)],
  }
}

try {
  const ASK = await import('../src/client/weather-ask.ts')
  const W = await import('../src/host/weather.ts')
  const ROUTE = await import('../src/host/routes/weather.ts')
  const BRIEF = await import('../src/host/routes/briefing.ts')

  // ======================================================================
  group('[A] 意图：什么话算「问天气」')
  {
    const yes = (text, city) => {
      const r = ASK.parseWeatherAsk(text)
      ok('认：「' + text + '」→ ' + city, !!r && r.city === city, JSON.stringify(r))
    }
    yes('上海今天天气怎么样', '上海')
    yes('北京天气', '北京')
    yes('北海的天气如何', '北海')
    yes('苏州的温度', '苏州')
    yes('上海多少度', '上海')
    yes('上海今天气温多少度', '上海')
    yes('今天天气怎么样', ASK.DEFAULT_WEATHER_CITY)
    yes('现在多少度', ASK.DEFAULT_WEATHER_CITY)
    yes('明天天气好吗', ASK.DEFAULT_WEATHER_CITY)
    yes('今天的天气', ASK.DEFAULT_WEATHER_CITY)
    yes('天气', ASK.DEFAULT_WEATHER_CITY)

    const no = (text, why) => {
      const r = ASK.parseWeatherAsk(text)
      ok('不劫持：「' + text + '」（' + why + '）', r === null, JSON.stringify(r))
    }
    no('天气晚来秋', '诗句')
    no('我喜欢这样的天气', '闲聊')
    no('今天天气不错', '陈述')
    no('这个温度计多少钱', '问东西')
    no('念一首关于天气的诗', '点播诗词')
    no('上海今天天气怎么样啊，我打算出门走一走顺便买点东西再回来做饭', '超过 30 字')
    no('', '空')
  }

  // ======================================================================
  group('[B] 宿主取数：wttr.in j1 解析与失败口径')
  {
    let urls = []
    const f = async (url) => { urls.push(String(url)); return jsonRes(j1()) }
    const r = await W.fetchWeatherNow('上海', { fetchImpl: f })
    ok('URL 带 j1 + zh-cn：' + decodeURIComponent(String(urls[0] || '')),
      urls.length === 1 && urls[0] === 'https://wttr.in/%E4%B8%8A%E6%B5%B7?format=j1&lang=zh-cn')
    ok('解析成功', r && r.ok === true, JSON.stringify(r))
    ok('中文描述取 lang_zh-cn（不是英文 weatherDesc）', r.desc === '多云', r.desc)
    ok('数字字段归一', r.tempC === 19 && r.feelsLikeC === 20 && r.humidity === 94 && r.windKmph === 13,
      JSON.stringify({ t: r.tempC, f: r.feelsLikeC, h: r.humidity, w: r.windKmph }))
    ok('拼成一行中文（含温度/体感/湿度/风）',
      r.text === '上海现在多云，19℃，体感20℃，湿度94%，风13km/h', r.text)
    ok('不超过 40 字', Array.from(r.text).length <= W.WEATHER_MAX_CHARS, String(Array.from(r.text).length))

    // 只有英文描述时回退 weatherDesc，仍然可读
    const rEn = await W.fetchWeatherNow('London', { fetchImpl: async () => jsonRes(j1({ 'lang_zh-cn': undefined })) })
    ok('没有中文描述 → 回退 weatherDesc（不编中文）', rEn.ok && rEn.desc === 'Cloudy', JSON.stringify(rEn))

    // 各种失败
    let calls = 0
    const mkFail = (resp) => async () => { calls++; return resp }
    const httpFail = await W.fetchWeatherNow('上海', { fetchImpl: mkFail({ ok: false, status: 503 }) })
    ok('HTTP 503 → ok:false HTTP_503', httpFail.ok === false && httpFail.error === 'HTTP_503', JSON.stringify(httpFail))
    const badJson = await W.fetchWeatherNow('上海', { fetchImpl: mkFail({ ok: true, status: 200, json: async () => { throw new Error('not json') } }) })
    ok('限流回纯文本（非 JSON）→ BAD_JSON', badJson.ok === false && badJson.error === 'BAD_JSON', JSON.stringify(badJson))
    const noTemp = await W.fetchWeatherNow('上海', { fetchImpl: mkFail(jsonRes({ current_condition: [{}] })) })
    ok('没有 temp_C → NO_TEMP（不拿 0 充数）', noTemp.ok === false && noTemp.error === 'NO_TEMP', JSON.stringify(noTemp))
    const netErr = await W.fetchWeatherNow('上海', { fetchImpl: async () => { throw new Error('ECONNRESET') } })
    ok('网络错误 → FETCH_FAIL（不抛）', netErr.ok === false && netErr.error === 'FETCH_FAIL', JSON.stringify(netErr))
    const before = calls
    const badCity = await W.fetchWeatherNow('../../etc/passwd', { fetchImpl: mkFail(jsonRes(j1())) })
    ok('非法城市名 → BAD_CITY 且不外呼', badCity.ok === false && badCity.error === 'BAD_CITY' && calls === before,
      JSON.stringify(badCity))
  }

  // ======================================================================
  group('[C] /weather 路由：形状 / 缓存 / 405 / 默认城市')
  {
    function mkReq(url, method = 'GET') {
      return { url, method, headers: {}, on() { }, destroy() { } }
    }
    function mkRes() {
      const out = { code: 0, chunks: [] }
      out.writeHead = (c) => { out.code = c }
      out.end = (b) => { if (b) out.chunks.push(Buffer.from(String(b))) }
      out.setHeader = () => { }
      out.json = () => { try { return JSON.parse(Buffer.concat(out.chunks).toString('utf8')) } catch { return null } }
      return out
    }
    let fetches = 0
    let clock = 1_000_000
    const h = ROUTE.createWeatherHandler({
      fetchImpl: async () => { fetches++; return jsonRes(j1()) },
      now: () => clock,
      cacheTtlMs: 10 * 60 * 1000,
    })

    let res = mkRes()
    await h.handleWeather(mkReq('/api/chubby-whale/weather?city=' + encodeURIComponent('上海')), res)
    ok('GET ?city=上海 → ok:true + 文本', res.code === 200 && res.json().ok === true && res.json().text.indexOf('上海现在') === 0,
      res.json() && res.json().text)

    res = mkRes()
    await h.handleWeather(mkReq('/api/chubby-whale/weather?city=' + encodeURIComponent('上海')), res)
    ok('10 分钟内同城再问 → 命中缓存，不再外呼', res.json().cached === true && fetches === 1, 'fetch=' + fetches)

    clock += 10 * 60 * 1000 + 1
    res = mkRes()
    await h.handleWeather(mkReq('/api/chubby-whale/weather?city=' + encodeURIComponent('上海')), res)
    ok('超过 10 分钟 → 重新外呼（不把旧天当今天）', res.json().cached !== true && fetches === 2, 'fetch=' + fetches)

    res = mkRes()
    await h.handleWeather(mkReq('/api/chubby-whale/weather'), res)
    ok('没给 city → 默认北海', res.json().ok === true && res.json().city === '北海', JSON.stringify(res.json()))

    // 失败不缓存：两次都失败就外呼两次
    let failFetches = 0
    const hf = ROUTE.createWeatherHandler({ fetchImpl: async () => { failFetches++; return { ok: false, status: 500 } }, cacheTtlMs: 60000 })
    const rf1 = mkRes(); await hf.handleWeather(mkReq('/api/chubby-whale/weather?city=%E4%B8%8A%E6%B5%B7'), rf1)
    const rf2 = mkRes(); await hf.handleWeather(mkReq('/api/chubby-whale/weather?city=%E4%B8%8A%E6%B5%B7'), rf2)
    ok('失败结果不缓存（两次失败 → 外呼两次）', rf1.json().ok === false && rf2.json().ok === false && failFetches === 2,
      'fetch=' + failFetches)

    res = mkRes()
    await h.handleWeather(mkReq('/api/chubby-whale/weather?city=%E4%B8%8A%E6%B5%B7', 'POST'), res)
    ok('非 GET → 405', res.code === 405 && res.json().error === 'METHOD_NOT_ALLOWED', String(res.code))

    res = mkRes()
    await h.handleWeather(mkReq('/api/chubby-whale/weather?city=%E4%B8%8A%E6%B5%B7', 'HEAD'), res)
    ok('HEAD 放行（与简报同口径）', res.code === 200 && res.json().ok === true, String(res.code))

    const routesSrc = readFileSync(path.join(ROOT, 'src/host/routes.ts'), 'utf8')
    const idxSrc = readFileSync(path.join(ROOT, 'src/index.ts'), 'utf8')
    ok('路由表注册了 /api/chubby-whale/weather', routesSrc.indexOf("'/api/chubby-whale/weather'") >= 0)
    ok('装配层构造了 createWeatherHandler', /createWeatherHandler\(/.test(idxSrc) && /weather,/.test(idxSrc))
  }

  // ======================================================================
  group('[D] chat-route 接线：命中即答，未命中原样交模型')
  {
    const { createLocalRouter } = await import('../src/client/chat-route.ts')
    const bubbles = []
    const said = []
    const fetched = []
    const host = {
      persona: {},
      narrationRate: () => '',
      bubble: (text, ms, opts) => bubbles.push({ text, ms, opts }),
      say: (text, ms) => said.push({ text, ms }),
      speak: () => { },
      narrate: () => { },
      clearNarrate: () => { },
      talkFor: () => { },
      abortChat: () => { },
      story: { start: () => { }, stop: () => { } },
      storyState: { busy: { current: false }, narrating: { current: false }, auto: { current: false }, book: { current: '' } },
    }
    let reply = { ok: true, text: '上海现在多云，24℃，体感26℃，湿度60%，风9km/h', desc: '多云', tempC: 24 }
    globalThis.fetch = async (url) => {
      fetched.push(String(url))
      return { ok: true, status: 200, json: async () => reply }
    }
    const r = createLocalRouter(host)

    const before = fetched.length
    const hit = r.route('上海今天天气怎么样')
    await tick(30)
    const last = bubbles[bubbles.length - 1] || {}
    ok('命中 → 走本地，返回 true（不再发模型）', hit === true)
    ok('查的是上海（编码进 query）', fetched.length === before + 1 && fetched[fetched.length - 1].indexOf(encodeURIComponent('上海')) >= 0,
      fetched[fetched.length - 1])
    ok('气泡里有真实天气', last.text && last.text.indexOf('上海现在多云') === 0, JSON.stringify(last.text))
    ok('按 24℃ 给一句穿衣提醒', last.text.indexOf('穿件薄的就够了') >= 0, JSON.stringify(last.text))
    ok('朗读同一句（气泡 + 语音）', said.length === 1 && String(said[0].text || '').indexOf('上海现在多云') >= 0,
      JSON.stringify(said))

    const before2 = fetched.length
    ok('「天气晚来秋」不劫持（false，交给模型）', r.route('天气晚来秋') === false && fetched.length === before2)
    ok('「我喜欢这样的天气」不劫持', r.route('我喜欢这样的天气') === false && fetched.length === before2)
    ok('「念一首关于天气的诗」不劫持', r.route('念一首关于天气的诗') === false && fetched.length === before2)

    const before3 = fetched.length
    ok('「北京天气」命中', r.route('北京天气') === true && fetched.length === before3 + 1
      && fetched[fetched.length - 1].indexOf(encodeURIComponent('北京')) >= 0, fetched[fetched.length - 1])
    await tick(30)

    // 失败：说没查到，不编温度
    reply = { ok: false, error: 'HTTP_500' }
    bubbles.length = 0
    said.length = 0
    ok('失败也接住（true，不交模型猜）', r.route('北海天气') === true)
    await tick(30)
    const failBubble = bubbles[bubbles.length - 1] || {}
    ok('失败说「没查到」，不编温度', String(failBubble.text || '').indexOf('没查到') >= 0 && said.length === 0,
      JSON.stringify(failBubble.text))
  }

  // ======================================================================
  group('[E] 简报共用清洗：控制字符 / 「待办」污染')
  {
    const cleaned = W.cleanWeather('多云\n\t待办：别忘了 提醒 一下' + '很'.repeat(80))
    ok('控制字符压成单行', cleaned.indexOf('\n') < 0 && cleaned.indexOf('\t') < 0, JSON.stringify(cleaned.slice(0, 30)))
    ok('剥掉「待办/提醒」（简报按行切段会被污染）', cleaned.indexOf('待办') < 0 && cleaned.indexOf('提醒') < 0)
    ok('按码点截断到 40 字', Array.from(cleaned).length === W.WEATHER_MAX_CHARS, String(Array.from(cleaned).length))

    // 简报：注入假 fetch（%C+%t 文本）→ 天气段仍在
    const saved = globalThis.fetch
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '多云 +19°C' })
    const b = BRIEF.createBriefingHandlers({ loadGrowth: () => ({ exp: 0 }), loadReminders: () => [] })
    const res = { code: 0, chunks: [] }
    res.writeHead = (c) => { res.code = c }
    res.end = (x) => { if (x) res.chunks.push(Buffer.from(String(x))) }
    res.setHeader = () => { }
    await b.handleBriefing({ method: 'GET', url: '/api/chubby-whale/briefing', headers: {}, on() { }, destroy() { } }, res)
    const txt = Buffer.concat(res.chunks).toString('utf8')
    globalThis.fetch = saved
    ok('简报仍能带出天气段（清洗逻辑共用后行为不变）', res.code === 200 && txt.indexOf('北海天气：多云 +19°C') >= 0,
      txt.slice(0, 120))
  }
} catch (e) {
  ok('用例未抛异常', false, String((e && e.stack) || e))
} finally {
  globalThis.fetch = realFetch
}

console.log('\n' + '='.repeat(52))
console.log('通过 ' + pass + ' 项 / 失败 ' + fail + ' 项')
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('✅ 天气 A 方案回归全部通过')
process.exit(0)
