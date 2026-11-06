/**
 * scripts/test-voices-shared.mjs —— B93「音色白名单同源」回归（离线、不起子进程、不联网）
 *
 * 背景（B92 取证）：客户端白名单原先只在 src/client/voice/voices.ts，服务端 /tts 只做
 * `^[a-zA-Z0-9-]+$` 字符集校验——HTTP 直调 `ja-JP-NanamiNeural` 会被原样接受（策略/成本缺口）。
 * B93 把白名单提到 src/shared/voices.ts，宿主与客户端共用一份，并在 /tts 上加第二道校验。
 *
 * 本文件盯三件事：
 *   [A] shared/voices.ts 是单一真源：归一化语义不变、数组冻结、客户端旧路径 re-export 同一份引用；
 *   [B] /tts 白名单收口：白名单外**回落默认音色**（不是 400），响应头 x-tts-voice: fallback 只在
 *       「请求给的音色被替换」时出现；engine 必传（去掉了 opts.engine || createEdgeTtsEngine() 兜底）；
 *   [C] 静态复核：不再自建引擎、ports.ts 死字段已删、客户端不再保留第二份白名单。
 *
 * 负向验证（本批实测记录，不是宣称）：临时把 shared/voices.ts 的 `return hit || fallback` 改成
 * `return n`（白名单形同虚设）、并删掉 tts.ts 的 engine 必传守卫，跑本文件 → 19 项失败 / exit 1
 * （[A] 的归一化断言与 [B] 的「白名单外回落」「engine 必传」被抓出）；恢复两处后 60 项全过。
 *
 * 用法：node scripts/test-voices-shared.mjs
 * 退出码：0 = 全过；1 = 有失败
 */
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 源码里跨模块 import 写的是编译后的 `.js`，源码是 `.ts`：注册解析钩子（与 test.mjs / test-voice-routes.mjs 同一套）
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
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
    '期望 ' + JSON.stringify(expected) + ' / 实际 ' + JSON.stringify(actual))
}
function group(title) { console.log('\n' + title) }

// ---------- 浏览器 localStorage stub（readStoredVoiceName 用） ----------
const LS = new Map()
globalThis.localStorage = {
  getItem: (k) => (LS.has(k) ? LS.get(k) : null),
  setItem: (k, v) => { LS.set(k, String(v)) },
  removeItem: (k) => { LS.delete(k) },
  clear: () => { LS.clear() },
}

// ---------- 假 req / res（形状与 test.mjs [21] / test-voice-routes.mjs 一致） ----------
function mkReq(body, headers = {}) {
  const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  return {
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
// 内存缓存：能真实复现「同 key 命中」，用来验证缓存命中路径也带排障头
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

const SHARED = await import('../src/shared/voices.ts')
const CLIENT = await import('../src/client/voice/voices.ts')
const TTS = await import('../src/host/routes/tts.ts')

try {
  // ================= [A] shared/voices.ts 单一真源 =================
  group('[A] shared/voices.ts：白名单单一真源 + 归一化语义不变')
  {
    eq('白名单 9 项（8 个音色 + auto）', SHARED.TTS_VOICES.length, 9)
    eq('auto 在名单里', SHARED.TTS_VOICES.indexOf('auto') >= 0, true)
    eq('8 个真音色（不含 auto）', SHARED.TTS_VOICES.filter((v) => v !== 'auto').length, 8)
    eq('默认音色 = 晓伊', SHARED.DEFAULT_VOICE, 'zh-CN-XiaoyiNeural')
    ok('白名单数组被冻结（外部改不动）', Object.isFrozen(SHARED.TTS_VOICES))
    let pushThrew = false
    try { SHARED.TTS_VOICES.push('ja-JP-NanamiNeural') } catch { pushThrew = true }
    ok('冻结后 push 抛错（不会悄悄扩名单）', pushThrew)

    eq('白名单内原样返回', SHARED.normalizeVoiceName('en-US-AnaNeural'), 'en-US-AnaNeural')
    eq('前后空格不影响命中', SHARED.normalizeVoiceName('  en-US-AnaNeural  '), 'en-US-AnaNeural')
    eq('大小写脏值归一成规范写法', SHARED.normalizeVoiceName('EN-US-ANANEURAL'), 'en-US-AnaNeural')
    eq('大小写 + 空格一起脏', SHARED.normalizeVoiceName(' Zh-Cn-XiaoxiaoNeural '), 'zh-CN-XiaoxiaoNeural')
    eq('auto 大小写归一', SHARED.normalizeVoiceName('AUTO'), 'auto')
    eq('白名单外（ja-JP）回退默认', SHARED.normalizeVoiceName('ja-JP-NanamiNeural'), SHARED.DEFAULT_VOICE)
    eq('null / undefined 回退默认', SHARED.normalizeVoiceName(null), SHARED.DEFAULT_VOICE)
    eq('非字符串数字回退默认', SHARED.normalizeVoiceName(42), SHARED.DEFAULT_VOICE)
    eq('空串按 fallback 返回', SHARED.normalizeVoiceName('', 'x'), 'x')
    eq('宿主用法：fallback 传空串时「没命中」可被识别', SHARED.normalizeVoiceName('ja-JP-NanamiNeural', ''), '')
    eq('无原型对象不抛错、回退默认', SHARED.normalizeVoiceName(Object.create(null)), SHARED.DEFAULT_VOICE)
    eq('toString 抛错的对象也只是回退', SHARED.normalizeVoiceName({ toString() { throw new Error('boom') } }), SHARED.DEFAULT_VOICE)
    eq('回退值本身不被二次规范化（保留既有语义）', SHARED.normalizeVoiceName('bad', 'zh-cn-xiaoyineural'), 'zh-cn-xiaoyineural')

    // 旧导入路径必须还是同一份东西（不是复制一份）
    ok('client/voice/voices.ts 的 TTS_VOICES 与 shared 是同一个数组引用', CLIENT.TTS_VOICES === SHARED.TTS_VOICES)
    ok('client/voice/voices.ts 的 normalizeVoiceName 与 shared 是同一个函数', CLIENT.normalizeVoiceName === SHARED.normalizeVoiceName)
    ok('client/voice/voices.ts 的 DEFAULT_VOICE 与 shared 相同', CLIENT.DEFAULT_VOICE === SHARED.DEFAULT_VOICE)

    LS.set('chubby-tts-voice', '  EN-GB-SONIANEURAL ')
    eq('readStoredVoiceName 仍从 localStorage 读并归一（旧路径可用）', CLIENT.readStoredVoiceName(), 'en-GB-SoniaNeural')
    LS.set('chubby-tts-voice', 'ja-JP-NanamiNeural')
    eq('localStorage 里是白名单外音色 → 默认晓伊', CLIENT.readStoredVoiceName(), SHARED.DEFAULT_VOICE)
    LS.clear()
  }

  // ================= [B] /tts 白名单收口 =================
  group('[B] /tts：白名单外回落默认（200 + x-tts-voice: fallback），不回 400')
  {
    const calls = []
    const engine = { async synthesize(o) { calls.push(o); return Buffer.from('MP3:' + o.text) } }
    const handle = TTS.createTtsHandler({ engine })
    const run = async (body) => {
      const res = mkRes()
      calls.length = 0
      await handle(mkReq(body), res)
      return res
    }

    // ① 白名单内：原样（规范写法）交给引擎，且不带排障头
    let res = await run({ text: '正常音色', voice: 'zh-CN-XiaoxiaoNeural' })
    ok('白名单内音色 → 200', res.code === 200, 'code=' + res.code)
    eq('白名单内音色原样交给引擎', calls[0] && calls[0].voice, 'zh-CN-XiaoxiaoNeural')
    ok('白名单内音色不带 x-tts-voice 头', !res.headers['x-tts-voice'], JSON.stringify(res.headers))

    // ② auto：按语言选，不算 fallback
    res = await run({ text: '自动音色', voice: 'auto' })
    eq('auto + 中文文本 → 晓伊', calls[0] && calls[0].voice, SHARED.DEFAULT_VOICE)
    ok('auto 不算 fallback（不带头）', res.code === 200 && !res.headers['x-tts-voice'], 'code=' + res.code)

    // ③ 大小写脏值：归一成规范写法，不是替换，不带头
    res = await run({ text: '大写音色', voice: 'ZH-CN-YUNXINEURAL' })
    eq('大小写脏值 → 规范写法给引擎', calls[0] && calls[0].voice, 'zh-CN-YunxiNeural')
    ok('归一不产生 fallback 头', res.code === 200 && !res.headers['x-tts-voice'], 'code=' + res.code)

    // ④ 前后空格：trim 后命中，不是替换
    res = await run({ text: '空格音色', voice: '  en-GB-SoniaNeural  ' })
    eq('前后空格 trim 后命中', calls[0] && calls[0].voice, 'en-GB-SoniaNeural')
    ok('空格脏值也不算 fallback', !res.headers['x-tts-voice'], JSON.stringify(res.headers))

    // ⑤ B92 的核心缺口：字符合法但不在白名单
    res = await run({ text: '日语直调', voice: 'ja-JP-NanamiNeural' })
    ok('白名单外但字符合法 → 仍是 200（不 400、不 500）', res.code === 200, 'code=' + res.code)
    eq('白名单外 → 引擎收到默认晓伊（不再原样放行）', calls[0] && calls[0].voice, SHARED.DEFAULT_VOICE)
    ok('白名单外 → 排障头 x-tts-voice: fallback', res.headers['x-tts-voice'] === 'fallback', JSON.stringify(res.headers))
    ok('白名单外音色没有传给引擎', !calls.some((c) => c.voice === 'ja-JP-NanamiNeural'))

    // ⑥ 第一道字符集仍在：CRLF / 引号 / shell 元字符 → 回落 + 头
    for (const bad of ['zh-CN-XiaoyiNeural\r\nX-Injected: 1', "'; rm -rf /tmp/x", 'zh-CN_XiaoyiNeural']) {
      res = await run({ text: '注入 ' + bad.length, voice: bad })
      ok('非法字符音色 → 回落且 200：' + JSON.stringify(bad.slice(0, 12)),
        res.code === 200 && calls[0] && calls[0].voice === SHARED.DEFAULT_VOICE && res.headers['x-tts-voice'] === 'fallback',
        'voice=' + (calls[0] && calls[0].voice))
    }

    // ⑦ 英文文本的回落目标是 Ana（保持既有「按语言选默认」的语义）
    res = await run({ text: 'hello fallback', voice: 'ja-JP-NanamiNeural' })
    eq('英文文本 + 白名单外 → Ana', calls[0] && calls[0].voice, 'en-US-AnaNeural')
    ok('英文回落同样带 fallback 头', res.headers['x-tts-voice'] === 'fallback')

    // ⑧ 不传 / 空串：正常按语言选，不带头（这不是「被替换」）
    res = await run({ text: '没传音色' })
    eq('不传 voice → 中文晓伊', calls[0] && calls[0].voice, SHARED.DEFAULT_VOICE)
    ok('不传 voice 不带头', !res.headers['x-tts-voice'], JSON.stringify(res.headers))
    res = await run({ text: '空串音色', voice: '   ' })
    ok('空白 voice → 默认且不带头', res.code === 200 && !res.headers['x-tts-voice'], 'code=' + res.code)

    // ⑨ 缓存命中路径也要带排障头（先合成一次，第二次命中）
    const cache = createMemCache()
    const calls2 = []
    const handle2 = TTS.createTtsHandler({
      cache,
      engine: { async synthesize(o) { calls2.push(o); return Buffer.from('MP3:' + o.text) } },
    })
    let r = mkRes()
    await handle2(mkReq({ text: '缓存排障', voice: 'ja-JP-NanamiNeural' }), r)
    ok('第一次（未命中缓存）带 fallback 头', r.headers['x-tts-voice'] === 'fallback')
    const afterFirst = calls2.length
    r = mkRes()
    await handle2(mkReq({ text: '缓存排障', voice: 'ja-JP-NanamiNeural' }), r)
    ok('第二次命中缓存（引擎不再调用）', calls2.length === afterFirst, 'engine=' + calls2.length)
    ok('缓存命中路径同样带 fallback 头（排障不因缓存失明）', r.headers['x-tts-voice'] === 'fallback', JSON.stringify(r.headers))

    // ⑩ engine 必传：去掉 opts.engine || createEdgeTtsEngine() 兜底
    let noEngineThrew = ''
    try { TTS.createTtsHandler({}) } catch (e) { noEngineThrew = String((e && e.message) || e) }
    ok('createTtsHandler({}) 构造即抛错（engine 必传）', noEngineThrew.indexOf('engine 必传') >= 0, noEngineThrew)
    let cacheOnlyThrew = false
    try { TTS.createTtsHandler({ cache: createMemCache() }) } catch { cacheOnlyThrew = true }
    ok('只给 cache 不给 engine 也抛错（不偷偷自建）', cacheOnlyThrew)
  }

  // ================= [C] 静态复核 =================
  group('[C] 静态复核：去兜底 / 删死字段 / 客户端无第二份白名单')
  {
    const ttsSrc = readFileSync(path.join(ROOT, 'src/host/routes/tts.ts'), 'utf8')
    const portsSrc = readFileSync(path.join(ROOT, 'src/host/ports.ts'), 'utf8')
    const clientSrc = readFileSync(path.join(ROOT, 'src/client/voice/voices.ts'), 'utf8')

    ok('tts.ts 不再 import tts-engine（路由不自建引擎）', !/from\s+'\.\.\/tts-engine\.js'/.test(ttsSrc))
    ok('tts.ts 不再有 opts.engine || 兜底', !/opts\.engine\s*\|\|/.test(ttsSrc))
    ok('tts.ts 保留第一道字符集过滤', /\/\^\[a-zA-Z0-9-\]\+\$\//.test(ttsSrc))
    ok('tts.ts 从 shared/voices.ts 取白名单（同一份）', /from '\.\.\/\.\.\/shared\/voices\.js'/.test(ttsSrc))

    const deps = portsSrc.match(/export interface TtsRouteDeps \{([\s\S]*?)\n\}/)
    const block = deps ? deps[1] : ''
    ok('能定位 TtsRouteDeps 定义', !!block, block ? '' : '正则没匹配到')
    ok('死字段 voice?: 已删', !/\bvoice\s*\?:/.test(block), block.replace(/\s+/g, ' ').slice(0, 120))
    ok('engine 必传（非可选）', /\bengine:\s*TtsEngine\b/.test(block) && !/\bengine\s*\?:/.test(block))

    ok('客户端不再自带第二份白名单（无音色字面量）', clientSrc.indexOf("'zh-CN-XiaoyiNeural'") < 0)
    ok('客户端从 shared re-export', /export \{[^}]*TTS_VOICES[^}]*\} from '\.\.\/\.\.\/shared\/voices\.js'/.test(clientSrc))
    ok('客户端仍保留 readStoredVoiceName（旧导出不丢）', /export function readStoredVoiceName/.test(clientSrc))
  }
} catch (e) {
  ok('用例未抛异常', false, String((e && e.stack) || e))
}

console.log('\n' + '='.repeat(52))
console.log('通过 ' + pass + ' 项 / 失败 ' + fail + ' 项')
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('✅ 音色白名单同源回归全部通过')
process.exit(0)
