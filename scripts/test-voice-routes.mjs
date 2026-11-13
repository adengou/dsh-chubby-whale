/**
 * scripts/test-voice-routes.mjs —— 宿主两条语音路由（/tts、/asr）的边界回归（离线、不起子进程、不联网）
 *
 * 为什么单独建这个文件：`scripts/test.mjs` 的 [21]/[22] 只覆盖「正常合成 / 缓存 / 空体 / 坏 base64 / 闸门」，
 * 没有钉住这两条路由的**体积上限响应码**与「缓存键要不要带 format」。
 * 本批（B92-宿主语音路由）修的两处都在这里做正/负向验证；package.json 与 test.mjs 均未改，
 * 用 `node scripts/test-voice-routes.mjs` 单跑（也便于排障时只跑这一组）。
 *
 * 覆盖：
 *   A. /asr 解码后音频超 8MB → **413**（不是 200），且一个上游请求都不发
 *   A2. 边界：正好 8MB 仍放行（上限是「>」不是「>=」）
 *   B. /asr 缓存键含 format：同一份字节换个 format 必须重新识别（否则拿别的容器的文本顶包）
 *   C. /asr 请求体超 12MB（按 content-length 先拒）→ 413
 *   D. /tts 空文本 / 非字符串文本 → 400；非法音色（引号、CRLF、空格、shell 元字符）回落默认，绝不进引擎
 *   E. /tts 请求体超 64KB → 413
 *   F. 治理：两条路由不直连仓储/存储；装配层恒向 /tts 注入 engine、向 /asr 注入 getDeepseekKey；
 *      src/ 里不得再出现 SiliconFlow（2026-11-14 决定：删干净、无兜底）
 *
 * 负向验证（本批实测记录）：
 *   · 修复前跑本文件，A 失败（code=200）、B 失败（fetch=1 且 cached=true）；修复后全过。
 *   · 改动 cache key 前缀 v1→v2 是刻意的：旧缓存条目（不含 format）自然失效，不会被误命中。
 *
 * 用法：node scripts/test-voice-routes.mjs
 * 退出码：0 = 全过；1 = 有失败
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { register } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 源码里跨模块 import 写的是编译后的 `.js`，源码是 `.ts`：测试进程里注册解析钩子（与 test.mjs 同一套）
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

// ---------- 假 req / res（形状与 test.mjs [21]/[22] 一致：writeHead + end + on） ----------
function mkReq(body, headers = {}) {
  const buf = Buffer.isBuffer(body)
    ? body
    : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  return {
    // content-length 默认按真实字节给（readBody 会先看它）；需要「声明超限」时由调用方覆盖
    headers: Object.assign({ 'content-length': String(buf.length) }, headers),
    destroy() { }, on() { }, resume() { },
    async *[Symbol.asyncIterator]() { yield buf },
  }
}
function mkRes() {
  const out = { code: 0, headers: {}, chunks: [], headersSent: false, writableEnded: false }
  out.writeHead = (c, h) => { out.code = c; out.headers = h || {}; out.headersSent = true }
  out.end = (b) => {
    if (b) out.chunks.push(Buffer.isBuffer(b) ? b : Buffer.from(String(b)))
    out.writableEnded = true
  }
  out.setHeader = (k, v) => { out.headers[k] = v }
  out.on = () => { }
  out.body = () => Buffer.concat(out.chunks)
  out.text = () => out.body().toString('utf8')
  out.json = () => { try { return JSON.parse(out.text()) } catch { return null } }
  return out
}

// ---------- 端口假实现：内存缓存（按 key 存，能真实复现「撞 key」） ----------
function createMemCache() {
  const map = new Map()
  return {
    map,
    async getJson(key) { return map.has(key) ? map.get(key) : null },
    async setJson(key, value) { map.set(key, value) },
    memGet() { return undefined },
    memSet() { },
    async clear() { map.clear(); return 0 },
    async count() { return map.size },
  }
}

// ---------- /asr 的上游桩：只记录调用，按队列回文本 ----------
const FETCH = { calls: [], replies: [] }
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const call = { url: String(url), body: init && init.body }
  FETCH.calls.push(call)
  const text = FETCH.replies.length ? FETCH.replies.shift() : '主人好'
  return { ok: true, status: 200, text: async () => JSON.stringify({ text }) }
}

const ASR = await import('../src/host/routes/asr.ts')
const TTS = await import('../src/host/routes/tts.ts')

function asrRun(handler, req) {
  const res = mkRes()
  return handler(req, res).then(() => res)
}

try {
  // ---------- A / A2 解码后音频上限 ----------
  group('[A] /asr 解码后音频上限（8MB）：超限必须 413，且不调上游')
  {
    const cache = createMemCache()
    const handle = ASR.createAsrHandler({ cache, getDeepseekKey: () => 'k' })
    FETCH.calls.length = 0
    // 8MB + 1 字节：base64 约 11.18MB < 12MB 请求体上限，所以能走到「解码后再判」这一关
    const over = Buffer.alloc(8 * 1024 * 1024 + 1, 7).toString('base64')
    const res = await asrRun(handle, mkReq({ audio: over }))
    const j = res.json()
    ok('超 8MB → HTTP 413（不是 200）', res.code === 413, 'code=' + res.code)
    ok('413 仍带机器可读的 ok:false + error=audio too large',
      !!j && j.ok === false && j.error === 'audio too large', JSON.stringify(j))
    ok('超限不调上游（不白烧识别额度）', FETCH.calls.length === 0, 'fetch=' + FETCH.calls.length)

    // 边界：正好 8MB 要放行（证明上限是 >，不是 >=）
    FETCH.calls.length = 0
    FETCH.replies.length = 0
    const edge = Buffer.alloc(8 * 1024 * 1024, 9).toString('base64')
    const res2 = await asrRun(handle, mkReq({ audio: edge }))
    ok('正好 8MB 放行（> 才拒）', res2.code === 200 && FETCH.calls.length === 1,
      'code=' + res2.code + ' fetch=' + FETCH.calls.length)
  }

  // ---------- B 非 WAV 不再换供应商 ----------
  group('[B] /asr 只走官方：非 WAV 直接报清楚，不偷偷换供应商')
  {
    const cache = createMemCache()
    const handle = ASR.createAsrHandler({ cache, getDeepseekKey: () => 'k' })
    const audio = Buffer.from('same-bytes-different-container').toString('base64')

    FETCH.calls.length = 0
    FETCH.replies.length = 0
    const r1 = await asrRun(handle, mkReq({ audio, format: 'webm' }))
    const j1 = r1.json()
    ok('webm（转码失败的原字节）→ ok:false unsupported format，且不调上游',
      !!j1 && j1.ok === false && j1.error === 'unsupported format' && FETCH.calls.length === 0,
      'fetch=' + FETCH.calls.length + ' body=' + JSON.stringify(j1))
    ok('非 WAV 也给一句人话（不让主人对着麦克风干等）', !!j1 && /WAV/.test(String(j1.hint || '')), JSON.stringify(j1))

    const r2 = await asrRun(handle, mkReq({ audio, format: 'wav' }))
    ok('同一份字节以 WAV 上传：正常识别', r2.json() && r2.json().ok === true && r2.json().text === '主人好', JSON.stringify(r2.json()))
    const r3 = await asrRun(handle, mkReq({ audio, format: 'wav' }))
    ok('同字节同 format 再问一次 → 正常命中缓存',
      FETCH.calls.length === 1 && r3.json() && r3.json().cached === true,
      'fetch=' + FETCH.calls.length + ' body=' + JSON.stringify(r3.json()))

    const asrSrc = readFileSync(path.join(ROOT, 'src/host/routes/asr.ts'), 'utf8')
    ok('缓存键里仍带 format（同一字节换容器不会串结果）', /\+ format \+/.test(asrSrc))
    ok('缓存键版本升到 v6（旧供应商的结果自然失效）', asrSrc.indexOf("'v6|official|official-asr|'") >= 0)
  }

  // ---------- C 请求体上限 ----------
  group('[C] /asr 请求体超 12MB：按 content-length 先拒 → 413')
  {
    FETCH.calls.length = 0
    const handle = ASR.createAsrHandler({ cache: createMemCache(), getDeepseekKey: () => 'k' })
    const res = await asrRun(handle, mkReq(Buffer.from('{}'), { 'content-length': String(13 * 1024 * 1024) }))
    ok('13MB 声明 → 413 too large', res.code === 413 && res.json() && res.json().error === 'too large',
      'code=' + res.code + ' body=' + res.text().slice(0, 60))
    ok('请求体超限不调上游', FETCH.calls.length === 0, 'fetch=' + FETCH.calls.length)
  }

  // ---------- D /tts 入参校验 ----------
  group('[D] /tts 入参：空/非字符串 400；非法音色绝不进引擎')
  {
    const calls = []
    const engine = {
      async synthesize(o) { calls.push(o); return Buffer.from('MP3:' + o.text) },
    }
    const handle = TTS.createTtsHandler({ cache: createMemCache(), engine })

    let res = mkRes(); calls.length = 0
    await handle(mkReq({ text: '   ' }), res)
    ok('空白文本 → 400 empty text', res.code === 400 && res.json() && res.json().error === 'empty text',
      'code=' + res.code)
    ok('空白文本不调引擎', calls.length === 0)

    res = mkRes(); calls.length = 0
    await handle(mkReq({ text: 12345 }), res)
    ok('非字符串 text → 400（不当作文本送进引擎）',
      res.code === 400 && calls.length === 0, 'code=' + res.code)

    // 2026-11-07：超长不再静默截断（原来 6001 字回 200，引擎只收到 6000 字、听到半句）
    res = mkRes(); calls.length = 0
    await handle(mkReq({ text: '字'.repeat(6001) }), res)
    const tooLong = res.json() || {}
    ok('超长文本 → 413 text too large（不静默截断）',
      res.code === 413 && tooLong.ok === false && tooLong.limit === 6000 && calls.length === 0,
      'code=' + res.code + ' body=' + JSON.stringify(tooLong))

    res = mkRes(); calls.length = 0
    await handle(mkReq({ text: '字'.repeat(6000) }), res)
    ok('正好 6000 字仍正常合成', res.code === 200 && calls.length === 1, 'code=' + res.code)

    res = mkRes(); calls.length = 0
    // 每条用不同文本：缓存键 = voice|rate|pitch|text，同文本会命中上一条（那是缓存正确行为，不是音色没生效）
    await handle(mkReq({ text: 'hello crlf', voice: 'zh-CN-XiaoyiNeural\r\nX-Injected: 1' }), res)
    ok('音色里夹 CRLF/冒号 → 回落默认（英文走 en-US-AnaNeural）',
      res.code === 200 && calls.length === 1 && calls[0].voice === 'en-US-AnaNeural',
      'voice=' + (calls[0] && calls[0].voice))

    res = mkRes(); calls.length = 0
    await handle(mkReq({ text: 'hello shell', voice: "'; rm -rf /tmp/x" }), res)
    ok('音色里夹 shell 元字符 → 回落默认',
      res.code === 200 && calls.length === 1 && calls[0].voice === 'en-US-AnaNeural',
      'voice=' + (calls[0] && calls[0].voice))

    // 云端路径不接收 voice（用配置里的 speaker）：成功出云端时不该报 x-tts-voice: fallback
    {
      const cloudCalls = []
      const cloudStub = { enabled: () => true, synthesize: async (t) => { cloudCalls.push(t); return Buffer.from('CLOUD:' + t) } }
      const h2 = TTS.createTtsHandler({ cache: createMemCache(), engine, cloudTts: cloudStub })
      const r2 = mkRes()
      await h2(mkReq({ text: 'hello cloud', voice: 'ja-JP-NanamiNeural' }), r2)
      ok('云端成功时引擎不被调用（音频来自云端）', r2.code === 200 && cloudCalls.length === 1 && calls.length === 1,
        'code=' + r2.code + ' cloud=' + cloudCalls.length)
      ok('云端成功时不谎报 x-tts-voice: fallback', r2.headers['x-tts-voice'] === undefined,
        'header=' + String(r2.headers['x-tts-voice']))
    }

    // B93 收口：白名单已提到 shared/voices.ts 并在服务端校验，「HTTP 直调可绕过白名单」的缺口关闭。
    // 语义仍是「不 400、回落默认」，并带 x-tts-voice: fallback 供排障（细则见 scripts/test-voices-shared.mjs）。
    res = mkRes(); calls.length = 0
    await handle(mkReq({ text: 'hello japanese', voice: 'ja-JP-NanamiNeural' }), res)
    ok('白名单外但字符合法 → 200 且回落默认（不再原样传给引擎）',
      res.code === 200 && calls.length === 1 && calls[0].voice === 'en-US-AnaNeural'
      && res.headers['x-tts-voice'] === 'fallback',
      'voice=' + (calls[0] && calls[0].voice) + ' header=' + (res.headers && res.headers['x-tts-voice']))
  }

  // ---------- E /tts 请求体上限 ----------
  group('[E] /tts 请求体超 64KB：413')
  {
    const handle = TTS.createTtsHandler({
      cache: createMemCache(),
      engine: { async synthesize() { return Buffer.from('x') } },
    })
    const res = mkRes()
    await handle(mkReq(Buffer.from('{"text":"x"}'), { 'content-length': String(65 * 1024) }), res)
    ok('65KB 声明 → 413 too large', res.code === 413 && res.json() && res.json().error === 'too large',
      'code=' + res.code)
  }

  // ---------- F 治理（静态） ----------
  group('[F] 封装治理：路由只经端口；装配层恒注入')
  {
    const asrSrc = readFileSync(path.join(ROOT, 'src/host/routes/asr.ts'), 'utf8')
    const ttsSrc = readFileSync(path.join(ROOT, 'src/host/routes/tts.ts'), 'utf8')
    const idxSrc = readFileSync(path.join(ROOT, 'src/index.ts'), 'utf8')
    const banned = /\bfrom\s+'\.\.\/(repos|store\.js|cache\.js|chat-core\.js|prefs\.js)/
    ok('asr.ts 不直连仓储/存储/缓存（ADR 0002 规则 A）', !banned.test(asrSrc))
    ok('tts.ts 不直连仓储/存储/缓存（ADR 0002 规则 A）', !banned.test(ttsSrc))
    ok('asr.ts 不直连具体实现（不 import tts-engine / cloud-tts）',
      !/from\s+'\.\.\/tts-engine|from\s+'\.\.\/voice\/cloud-tts/.test(asrSrc))
    ok('/tts 装配层恒注入 engine（B93 起路由不自建，engine 必传）',
      /createTtsHandler\(\{[^)]*engine:\s*ttsEngine/.test(idxSrc))
    ok('/asr 装配层恒注入 getDeepseekKey（路由不自己读 config/环境变量）',
      /createAsrHandler\(\{[^)]*getDeepseekKey:/.test(idxSrc))

    // 2026-11-14 主人决定：SiliconFlow 依赖全部删除、无兜底。src/ 里再出现它的
    // 读取器 / Key 名 / 接口地址就算回归（注释里写「已下线」的历史说明不算）。
    const srcFiles = []
    const walkSrc = (d) => {
      for (const name of readdirSync(d)) {
        const p = path.join(d, name)
        const st = statSync(p)
        if (st.isDirectory()) walkSrc(p)
        else if (/\.ts$/.test(name)) srcFiles.push(p)
      }
    }
    walkSrc(path.join(ROOT, 'src'))
    const sfDepRe = /readSiliconFlowKey|SILICONFLOW_API_KEY|CHUBBY_WHALE_SILICONFLOW_KEY|api\.siliconflow\.cn|siliconflowKey/
    const sfHits = srcFiles.filter((f) => sfDepRe.test(readFileSync(f, 'utf8')))
    ok('src/ 里没有任何 SiliconFlow 依赖（删干净、无兜底的硬约束）',
      sfHits.length === 0, sfHits.map((f) => path.relative(ROOT, f)).join(','))
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
console.log('✅ 宿主语音路由边界回归全部通过')
process.exit(0)
