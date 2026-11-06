/**
 * scripts/test-shared-voice.mjs —— shared 层与 voice/ 子模块的边界回归（离线、无麦克风、不联网）
 *
 * 为什么单独一个脚本：scripts/test.mjs 覆盖的是"正常输入"，scripts/test-voice-queue.mjs
 * 覆盖的是语音队列/电平；两边都没盯这几类**边界**——
 *   ① shared/immutable.ts：循环引用、父已冻结而子未冻结、Map/Set/symbol 键里的值；
 *   ② shared/noise.ts：半角/全角标点（U+FF61 这类）、零宽字符、同一字重复 ≥7 次；
 *   ③ shared/growth.ts：负数 / NaN / Infinity / 浮点 / 超大值；④ voice/status.ts 统计初值；
 *   ⑤ voice/voices.ts：大小写/前后空格的脏音色名；
 *   ⑥ voice/fetch.ts：**响应体阶段**（headers 已回、body 还没读完）的超时与外部中断。
 *
 * ⑥ 是 2026-11-07 查出来的真 bug：fetchWithTimeout 在 fetch() 一 resolve 就 clearTimeout，
 * 而调用方（voice.ts）随后才 res.json() / res.arrayBuffer()，响应体卡死时硬超时形同虚设。
 *
 * 用法：node scripts/test-shared-voice.mjs
 * 退出码：0 = 全过；1 = 有失败
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, rmSync } from 'node:fs'
import esbuild from 'esbuild'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = path.join(ROOT, '.shared-voice-test-tmp')

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
function group(title, fn) {
  console.log('\n[' + title + ']')
  try { fn() } catch (e) { ok(title + '：未抛异常', false, String((e && e.stack) || e)) }
}
async function agroup(title, fn) {
  console.log('\n[' + title + ']')
  try { await fn() } catch (e) { ok(title + '：未抛异常', false, String((e && e.stack) || e)) }
}

// ---------- 浏览器环境 stub（这些模块会碰的全局） ----------
globalThis.window = globalThis
const LS = new Map()
globalThis.localStorage = {
  getItem: (k) => (LS.has(k) ? LS.get(k) : null),
  setItem: (k, v) => { LS.set(k, String(v)) },
  removeItem: (k) => { LS.delete(k) },
  clear: () => { LS.clear() },
}

// ---------- 打包并加载模块（esbuild 负责 .js → .ts） ----------
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
const out = path.join(TMP, 'bundle.mjs')
const ENTRY_SRC = `
import { deepFreeze } from './src/shared/immutable.js'
import { NOISE_TEXTS, INTERRUPT_WORDS, INTERRUPT_PHRASES, normalizeNoiseKey, isNoiseText, isInterruptWord, isInterruptCommand } from './src/shared/noise.js'
import { GROWTH_STAGES, growthStage } from './src/shared/growth.js'
import { createVoiceStats, createStatusHolder, createDiagSnapshots } from './src/client/voice/status.js'
import { TTS_VOICES, DEFAULT_VOICE, normalizeVoiceName, readStoredVoiceName } from './src/client/voice/voices.js'
import { fetchWithTimeout } from './src/client/voice/fetch.js'
export {
  deepFreeze,
  NOISE_TEXTS, INTERRUPT_WORDS, INTERRUPT_PHRASES, normalizeNoiseKey, isNoiseText, isInterruptWord, isInterruptCommand,
  GROWTH_STAGES, growthStage,
  createVoiceStats, createStatusHolder, createDiagSnapshots,
  TTS_VOICES, DEFAULT_VOICE, normalizeVoiceName, readStoredVoiceName,
  fetchWithTimeout,
}
`
await esbuild.build({
  stdin: { contents: ENTRY_SRC, resolveDir: ROOT, sourcefile: 'shared-voice-entry.ts', loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: out,
  logLevel: 'silent',
})
const M = await import(pathToFileURL(out).href)

// ---------- ① immutable：循环 / 已冻结父 / Map / Set / symbol ----------
group('immutable deepFreeze 边界', () => {
  const a = { name: 'a' }
  a.self = a
  ok('循环引用不爆栈且自己已冻结', M.deepFreeze(a) === a && Object.isFrozen(a))

  eq('原始值原样返回', [M.deepFreeze(5), M.deepFreeze(null), M.deepFreeze('x'), M.deepFreeze(undefined)], [5, null, 'x', undefined])

  const arr = [{ n: 1 }, [2]]
  M.deepFreeze(arr)
  ok('数组递归到嵌套对象/数组', Object.isFrozen(arr) && Object.isFrozen(arr[0]) && Object.isFrozen(arr[1]))
  let threw = false
  try { arr.push(9) } catch (e) { threw = true }
  eq('冻结数组 push 抛错（严格模式）', threw, true)

  // 父对象在传进来之前就已被 Object.freeze（比如别的模块先冻了外层）：
  // 递归不能因为"父已经冻结"就整棵子树跳过。
  const child = { x: 1 }
  const parent = Object.freeze({ child })
  M.deepFreeze(parent)
  eq('父已冻结、子未冻结 → 子也必须冻结', Object.isFrozen(child), true)

  // Map / Set：Object.freeze 管不到内部槽（set/add 仍可用），
  // 但键/值/元素本身是可达对象，必须跟着冻结。
  const mapInner = { x: 1 }
  const m = new Map([['k', mapInner]])
  M.deepFreeze(m)
  ok('Map 自身已冻结', Object.isFrozen(m))
  eq('Map 的值被递归冻结', Object.isFrozen(mapInner), true)
  const mapKey = { k: 1 }
  M.deepFreeze(new Map([[mapKey, 1]]))
  eq('Map 的键被递归冻结', Object.isFrozen(mapKey), true)

  const setInner = { x: 1 }
  const s = new Set([setInner])
  M.deepFreeze(s)
  ok('Set 自身已冻结', Object.isFrozen(s))
  eq('Set 的元素被递归冻结', Object.isFrozen(setInner), true)

  const sym = Symbol('k')
  const symInner = { x: 1 }
  const symObj = { [sym]: symInner }
  M.deepFreeze(symObj)
  eq('symbol 键上的值也被冻结', Object.isFrozen(symInner), true)

  // TypedArray 的 internal slot 冻不了：必须显式失败，不能假装冻结成功。
  let taThrew = false
  const ta = new Uint8Array(2)
  try { M.deepFreeze(ta) } catch (e) { taThrew = true }
  ok('TypedArray 不能"静默假装冻结"（抛错或真的冻结）', taThrew || Object.isFrozen(ta))
})

// ---------- ② noise：归一化与单字/重复边界 ----------
group('noise 噪声判定边界', () => {
  ok('导出表已冻结', Object.isFrozen(M.NOISE_TEXTS) && Object.isFrozen(M.INTERRUPT_WORDS))
  eq('噪声词表含打断词之外的片头词', M.NOISE_TEXTS.indexOf('谢谢观看') >= 0, true)
  eq('打断词表稳定', M.INTERRUPT_WORDS.slice(), ['停', '别', '不', '闭嘴', '打住'])

  // 半角片假名标点/半角句号 U+FF61（ASR 常见）必须吃掉，否则「嗯｡」会被当成一句话送进模型
  eq('归一化半角句号 U+FF61', M.normalizeNoiseKey('嗯｡'), '嗯')
  eq('「嗯｡」判为噪声', M.isNoiseText('嗯｡'), true)
  eq('「啊｡」判为噪声', M.isNoiseText('啊｡'), true)
  eq('「嗯……｡」判为噪声', M.isNoiseText('嗯……｡'), true)

  // 全角字母/数字先 NFKC 再小写，否则「ＡＢＣ」永远对不上任何表项
  eq('全角字母归一成半角小写', M.normalizeNoiseKey('ＡＢＣ'), 'abc')
  eq('全角数字归一成半角', M.normalizeNoiseKey('１２３'), '123')
  eq('全角空格被去掉', M.normalizeNoiseKey('　嗯　'), '嗯')

  // 零宽字符（ASR/复制粘贴）不能把单字撑成两个字
  eq('零宽空格不影响单字判定', M.isNoiseText('嗯\u200b'), true)
  eq('BOM 不影响单字判定', M.isNoiseText('\ufeff嗯'), true)

  eq('「嗯。」判噪声（既有行为）', M.isNoiseText('嗯。'), true)
  eq('「谢谢观看。」判噪声', M.isNoiseText('谢谢观看。'), true)
  eq('「嗯嗯嗯」判噪声', M.isNoiseText('嗯嗯嗯'), true)

  // 单字重复原本卡在 length<=6：重复越多反而越"像人话"，是反直觉的边界 bug
  eq('「嗯嗯嗯嗯嗯嗯嗯」（7 次）判噪声', M.isNoiseText('嗯嗯嗯嗯嗯嗯嗯'), true)
  eq('「啊啊啊啊啊啊啊啊」（8 次）判噪声', M.isNoiseText('啊啊啊啊啊啊啊啊'), true)
  eq('「哈哈哈哈哈哈哈哈哈」（9 次）判噪声', M.isNoiseText('哈哈哈哈哈哈哈哈哈'), true)

  // 不能误杀的边界：两字及以上的真实话术
  eq('「大肥鱼」不是噪声', M.isNoiseText('大肥鱼'), false)
  eq('「你好，我是肥鲸。」不是噪声', M.isNoiseText('你好，我是肥鲸。'), false)
  eq('「不错」不是噪声（含「不」但不是打断词）', M.isNoiseText('不错'), false)
  eq('「不要」不是噪声', M.isNoiseText('不要'), false)
  eq('「停一下」不是噪声（打断词按整句精确匹配）', M.isNoiseText('停一下'), false)
  eq('空/空白文本是噪声', [M.isNoiseText(''), M.isNoiseText('   '), M.isNoiseText(null), M.isNoiseText(undefined)], [true, true, true, true])

  // 打断词：归一化后必须认得出，否则「停！」这条掐朗读路径就断了
  eq('「停」是打断词', M.isInterruptWord('停'), true)
  eq('「停！」是打断词', M.isInterruptWord('停！'), true)
  eq('「停｡」是打断词（半角句号）', M.isInterruptWord('停｡'), true)
  eq('「 闭嘴 」是打断词', M.isInterruptWord(' 闭嘴 '), true)
  eq('「不错」不是打断词', M.isInterruptWord('不错'), false)
  eq('打断词不算噪声', [M.isNoiseText('停'), M.isNoiseText('别'), M.isNoiseText('不'), M.isNoiseText('停｡')], [false, false, false, false])

  // 2026-11-07 B93：整句打断指令也收到 shared（echo-filter 与 voice-bridge 曾各抄一份）
  eq('整句打断词表已冻结', Object.isFrozen(M.INTERRUPT_PHRASES), true)
  eq('词表含两边原先各自的口语说法',
    ['停下来吧', '不要说了', '不用说了', '暂停', '算了', '别吵'].every((x) => M.INTERRUPT_PHRASES.indexOf(x) >= 0), true)
  eq('「停下来吧」是整句打断指令', M.isInterruptCommand('停下来吧'), true)
  eq('「停！」带标点也认', M.isInterruptCommand('停！'), true)
  eq('单个规范词仍认', M.isInterruptCommand('闭嘴'), true)
  eq('正文里含「别」不算指令（只认整句）', M.isInterruptCommand('别人家的孩子'), false)
  eq('空/非字符串不炸', [M.isInterruptCommand(''), M.isInterruptCommand(null), M.isInterruptCommand(undefined)], [false, false, false])
})

// ---------- ③ growth：经验→阶段边界 ----------
group('growth 经验换算边界', () => {
  eq('阶段表门槛', M.GROWTH_STAGES.map((s) => s.exp), [0, 200, 800, 2500, 5000])
  eq('阶段表已冻结（含元素）', [Object.isFrozen(M.GROWTH_STAGES), Object.isFrozen(M.GROWTH_STAGES[0])], [true, true])
  eq('exp=0 → 初识 / 200', [M.growthStage(0).name, M.growthStage(0).nextExp], ['初识', 200])
  eq('exp=199.9（浮点）→ 仍是初识', [M.growthStage(199.9).name, M.growthStage(199.9).nextExp], ['初识', 200])
  eq('exp=200 → 熟悉', M.growthStage(200).name, '熟悉')
  eq('exp=2499.9 → 亲密', M.growthStage(2499.9).name, '亲密')
  eq('exp=5000 → 家人，nextExp=0', [M.growthStage(5000).name, M.growthStage(5000).nextExp], ['家人', 0])
  eq('负数按 0 处理 → 初识', [M.growthStage(-1).name, M.growthStage(-1e9).nextExp], ['初识', 200])
  eq('NaN 不让阶段变负/越界 → 初识', M.growthStage(NaN).name, '初识')
  eq('+Infinity → 最高档（与 look.ts tierOf 口径一致）', M.growthStage(Infinity).name, '家人')
  eq('-Infinity → 初识', M.growthStage(-Infinity).name, '初识')
  eq('超大值 → 最高档且不溢出', [M.growthStage(Number.MAX_SAFE_INTEGER).name, M.growthStage(1e308).nextExp], ['家人', 0])
  const sweep = []
  for (let e = 0; e <= 6000; e += 137) sweep.push(M.growthStage(e).index)
  ok('0→6000 扫描阶段单调不降', sweep.every((v, i) => i === 0 || v >= sweep[i - 1]), sweep.join(','))

  // 与客户端外观档位（look.ts TIER_EXP=[0,200,800]）不矛盾：同 exp 的档位单调同向
  const pairs = [0, 199, 200, 799, 800, 5000].map((e) => M.growthStage(e).index)
  ok('同 exp 下阶段序与 0/200/800 门槛同向', pairs.every((v, i) => i === 0 || v >= pairs[i - 1]), pairs.join(','))
})

// ---------- ④ status：统计初值 / 状态去重 ----------
group('status 统计与状态', () => {
  const st = M.createVoiceStats()
  const keys = ['windows', 'skippedSilent', 'uploaded', 'asrFail', 'asrBusyDropped', 'asrRetry', 'asrTexts', 'heard',
    'echoDropped', 'shortDropped', 'dupDropped', 'qDropped', 'ttsRequests', 'ttsPlayed', 'ttsFail', 'ttsZombie']
  eq('每个统计字段都从 0 起（含可选字段）', keys.map((k) => st[k]), keys.map(() => 0))
  eq('lastError 初值为空串', st.lastError, '')
  const st2 = M.createVoiceStats()
  st.windows = 7
  eq('统计实例互不共享', st2.windows, 0)
  ok('每次都是新对象', M.createVoiceStats() !== M.createVoiceStats())

  const seen = []
  const h = M.createStatusHolder((s) => seen.push(s))
  h.set('listening')
  h.set('listening')
  h.set('speaking')
  eq('同值不重复回调', seen, ['listening', 'speaking'])
  eq('get 返回最后状态', h.get(), 'speaking')
  const h2 = M.createStatusHolder(() => { throw new Error('ui boom') })
  let threw = false
  try { h2.set('thinking') } catch (e) { threw = true }
  eq('回调抛错不打断状态机', [threw, h2.get()], [false, 'thinking'])

  const d = M.createDiagSnapshots()
  const ape = { hadSpeech: true }
  d.setApe(ape)
  d.setSegment({ winMs: 1 })
  eq('诊断快照往返', [d.getApe(), d.getSegment().winMs, d.getTts()], [ape, 1, null])
})

// ---------- ⑤ voices：白名单归一化 ----------
group('voices 白名单归一化', () => {
  ok('白名单已冻结且 9 项（8 音色 + auto）', Object.isFrozen(M.TTS_VOICES) && M.TTS_VOICES.length === 9)
  eq('白名单内原样返回', M.normalizeVoiceName('en-US-AnaNeural'), 'en-US-AnaNeural')
  eq('前后空格不影响命中', M.normalizeVoiceName('  en-US-AnaNeural  '), 'en-US-AnaNeural')
  eq('大小写脏值归一成白名单里的规范写法', M.normalizeVoiceName('EN-US-ANANEURAL'), 'en-US-AnaNeural')
  eq('大小写 + 空格一起脏', M.normalizeVoiceName(' Zh-Cn-XiaoxiaoNeural '), 'zh-CN-XiaoxiaoNeural')
  eq('auto 大小写归一', M.normalizeVoiceName('AUTO'), 'auto')
  eq('白名单外仍回退默认', M.normalizeVoiceName('de-DE-KatjaNeural'), M.DEFAULT_VOICE)
  eq('空值按 fallback 返回（既有契约）', M.normalizeVoiceName('', 'x'), 'x')
  eq('非字符串按 fallback 返回', M.normalizeVoiceName(42), M.DEFAULT_VOICE)
  // 脏对象不能让整条朗读链抛错（String() 会抛的两种写法）
  eq('无原型对象不抛错、回退默认', M.normalizeVoiceName(Object.create(null)), M.DEFAULT_VOICE)
  eq('toString 抛错的对象也只是回退', M.normalizeVoiceName({ toString() { throw new Error('boom') } }), M.DEFAULT_VOICE)
  eq('回退值本身不被二次规范化（保留既有语义）', M.normalizeVoiceName('bad', 'zh-cn-xiaoyineural'), 'zh-cn-xiaoyineural')

  LS.clear()
  LS.set('chubby-tts-voice', 'EN-GB-SONIANEURAL')
  eq('localStorage 大小写脏值也能读出规范音色', M.readStoredVoiceName(), 'en-GB-SoniaNeural')
  LS.set('chubby-tts-voice', 'bad-voice')
  eq('localStorage 坏值回退默认', M.readStoredVoiceName(), M.DEFAULT_VOICE)
})

// ---------- ⑥ fetch：响应体阶段的超时与外部中断 ----------
const REAL_FETCH = globalThis.fetch
const abortedError = () => Object.assign(new Error('aborted'), { name: 'AbortError' })
/** 把「resolve 成什么」整理成可比较的 JSON，顺便给挂起的 Promise 一个上限，避免测试自己卡死 */
const race = (p, ms) => Promise.race([
  Promise.resolve(p).then((v) => ({ kind: 'resolved', value: v }), (e) => ({ kind: 'rejected', name: e && e.name })),
  new Promise((r) => setTimeout(() => r({ kind: 'pending' }), ms)),
])
/** 头部阶段就挂住的桩：只有 signal abort 才 reject */
const headStallFetch = () => (url, init) => new Promise((resolve, reject) => {
  const sig = init && init.signal
  if (!sig) return
  if (sig.aborted) { reject(abortedError()); return }
  sig.addEventListener('abort', () => reject(abortedError()), { once: true })
})
/** 头部正常返回、但响应体永远读不完的桩（模拟服务端发完头就卡住） */
const bodyStallFetch = () => (url, init) => Promise.resolve({
  ok: true,
  status: 200,
  arrayBuffer: () => new Promise((resolve, reject) => {
    const sig = init && init.signal
    if (!sig) return
    if (sig.aborted) { reject(abortedError()); return }
    sig.addEventListener('abort', () => reject(abortedError()), { once: true })
  }),
})

await agroup('fetch 头部阶段的超时与外部中断（既有行为）', async () => {
  globalThis.fetch = headStallFetch()
  eq('超时 → AbortError', await race(M.fetchWithTimeout('u', {}, 40), 600), { kind: 'rejected', name: 'AbortError' })

  const outer = new AbortController()
  const p = M.fetchWithTimeout('u', {}, 3000, outer.signal)
  setTimeout(() => outer.abort(), 20)
  eq('外部中断 → AbortError', await race(p, 600), { kind: 'rejected', name: 'AbortError' })

  const outer2 = new AbortController()
  await race(M.fetchWithTimeout('u', {}, 20, outer2.signal), 600)
  eq('超时只 abort 内部控制器（不污染外部信号）', outer2.signal.aborted, false)

  const pre = new AbortController()
  pre.abort()
  eq('调用前已中断 → AbortError', await race(M.fetchWithTimeout('u', {}, 3000, pre.signal), 600), { kind: 'rejected', name: 'AbortError' })
})

await agroup('fetch 响应体阶段仍受硬超时约束（2026-11-07 修）', async () => {
  globalThis.fetch = bodyStallFetch()
  const resp = await M.fetchWithTimeout('u', {}, 60)
  eq('headers 已回、body 卡死 → 超时后读取抛 AbortError', await race(resp.arrayBuffer(), 800), { kind: 'rejected', name: 'AbortError' })

  const outer = new AbortController()
  globalThis.fetch = bodyStallFetch()
  const resp2 = await M.fetchWithTimeout('u', {}, 3000, outer.signal)
  setTimeout(() => outer.abort(), 20)
  eq('响应体阶段外部中断（AbortSignal.any 路径）→ AbortError', await race(resp2.arrayBuffer(), 800), { kind: 'rejected', name: 'AbortError' })

  // 老 Safari 没有 AbortSignal.any：降级路径下 body 阶段也必须能被外部中断打断
  const savedAny = AbortSignal.any
  let canDrop = false
  try { AbortSignal.any = undefined; canDrop = AbortSignal.any === undefined } catch (e) { }
  if (canDrop) {
    const outer3 = new AbortController()
    globalThis.fetch = bodyStallFetch()
    const resp3 = await M.fetchWithTimeout('u', {}, 3000, outer3.signal)
    setTimeout(() => outer3.abort(), 20)
    eq('响应体阶段外部中断（无 AbortSignal.any 降级路径）→ AbortError', await race(resp3.arrayBuffer(), 800), { kind: 'rejected', name: 'AbortError' })
  } else {
    ok('跳过：无法移除 AbortSignal.any（不改判为失败）', true)
  }
  try { AbortSignal.any = savedAny } catch (e) { }
})

await agroup('fetch 成功路径不改变既有契约', async () => {
  // verify-voice.mjs 的桩 fetch 返回普通对象（不是 Response）：这里绝不能包装/重建返回值
  const stub = { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4), json: async () => ({ ok: true }) }
  globalThis.fetch = async () => stub
  const resp = await M.fetchWithTimeout('u', {}, 1000)
  eq('原样返回 fetch 的结果（不包装 Response）', resp === stub, true)
  eq('ok / status 透传', [resp.ok, resp.status], [true, 200])
  eq('body 可读', new Uint8Array(await resp.arrayBuffer()).byteLength, 4)
})

await agroup('fetch 请求失败路径不残留清理', async () => {
  globalThis.fetch = async () => { throw new Error('network down') }
  eq('网络错误原样抛出（不归一成 AbortError）', await race(M.fetchWithTimeout('u', {}, 1000), 600), { kind: 'rejected', name: 'Error' })
  globalThis.fetch = REAL_FETCH
})

// ---------- 汇总 ----------
rmSync(TMP, { recursive: true, force: true })
console.log('\n' + '='.repeat(52))
console.log('通过 ' + pass + ' 项 / 失败 ' + fail + ' 项')
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('✅ shared 层与语音子模块边界回归全部通过')
process.exit(0)
