/**
 * scripts/test-client-glue.mjs ——「分身·客户端粘合层」6 个模块的离线回归（独立脚本，不进 npm test）
 *
 * 覆盖 2026-11-07 B90 审计定下来的口径（全部是纯逻辑，不需要麦克风/浏览器/网络）：
 *
 *   bubble.ts       样式注入幂等 / 无 document 与无 window 降级 / 叠加只留最后一颗计时器 /
 *                   自动收起 / 纯状态字收起（含尾随空白）/ 情绪前缀
 *   chat-route.ts   判定顺序与正则边界：追问只接「再来一首（诗）」「换一首」这类不点内容的说法，
 *                   「换个说法 / 换个故事 / 换个声音」交给模型（与 intent 的既有断言一致）；
 *                   句末句号/感叹号不影响整句指令；典故/成语的播报用词按主人原话、
 *                   不跟着数据池名走；命中后只打本地接口、不再进模型
 *   hooks.ts        useLazyRef 只建一次（工厂返回 0/''/false/null 也算）/ usePersistentBool 双写 /
 *                   localStorage 不可用（SSR / 隐私模式）时回落
 *   look.ts         档位边界 0/200/800、坏数据回落、parseGrowth 只认服务端 exp
 *   ape.ts          数值边界：NaN / ±Infinity / -160 哨兵不许污染噪声底；steadyWindowFrames 参数生效；
 *                   纯静音不提交、窗口仍按时间重置
 *   poem-titles.ts  只拉一次（失败不重试）/ 成功写 localStorage / prime 不落盘 /
 *                   刷新后命中 localStorage 时同步就绪 / 未就绪时 intent 仍认泛化意图
 *
 * 做法：esbuild 把 6 个模块离线打成 ESM（platform=node，桩掉 persona 与 actions/culture，
 * 不碰 dist、不联网），再用假 React / 假 DOM 元素 / 假 fetch 直接调用导出的纯逻辑。
 * 进程 cwd 会切到临时空目录：poem-titles 的 seedFromDisk 在 Node 下会从 cwd 找
 * data/poem-titles.json，只有 cwd 里没有才能测「未就绪 → 拉取」这条路径。
 *
 * 负向验证：--mutants 把 6 处修复逐一改回旧写法（复制一份 src 到临时目录，改完再跑同一套断言），
 * 要求对应断言必须变红 —— 证明这条断言真的咬住了这次修的边界。
 *
 * 用法：
 *   node scripts/test-client-glue.mjs                # 正向
 *   node scripts/test-client-glue.mjs --mutants      # 正向 + 5 个变异体（要求全部被抓出）
 *   node scripts/test-client-glue.mjs --src <dir>    # 指定 src 目录（手动做负向验证时用）
 *
 * 退出码：0=通过；1=有断言失败（或变异体没被抓出）。
 */

import { build } from 'esbuild'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const argValue = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? resolve(argv[i + 1]) : dflt
}
const SRC = argValue('--src', join(ROOT, 'src'))
const RUN_MUTANTS = argv.includes('--mutants')

/** 打桩：这几个模块依赖浏览器/人设/动作层，测试只关心"被调用"，不关心实现 */
const STUB_SOURCES = {
  persona: `export function moodPrefix() {
  const v = globalThis.__glueMoodValue
  return typeof v === 'string' ? v : ''
}
export function moodFace() { return '' }`,
  'actions/culture': `export function beginOnce(key, gapMs) {
  const f = globalThis.__glueBeginOnce
  return typeof f === 'function' ? f(key, gapMs) : true
}
export function recitePoem(host, poem) {
  const f = globalThis.__glueRecite
  if (typeof f === 'function') f(host, poem)
}`,
}

const stubPlugin = {
  name: 'glue-stubs',
  setup(b) {
    b.onResolve({ filter: /^(\.\/persona\.js|\.\/actions\/culture\.js)$/ }, (args) => {
      const key = args.path === './persona.js' ? 'persona' : 'actions/culture'
      return { path: key, namespace: 'glue-stub' }
    })
    b.onLoad({ filter: /.*/, namespace: 'glue-stub' }, (args) => ({
      contents: STUB_SOURCES[args.path],
      loader: 'js',
    }))
  },
}

const ENTRY = [
  "export * as bubble from './client/bubble.js'",
  "export * as chatRoute from './client/chat-route.js'",
  "export * as hooks from './client/hooks.js'",
  "export * as look from './client/look.js'",
  "export * as ape from './client/ape.js'",
  "export * as poemTitles from './client/poem-titles.js'",
  "export * as intent from './client/intent.js'",
  '',
].join('\n')

/** 把某个 src 目录打成一份 ESM（离线） */
async function bundle(srcDir, outFile) {
  await build({
    stdin: { contents: ENTRY, resolveDir: srcDir, sourcefile: 'glue-entry.ts', loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    charset: 'utf8',
    logLevel: 'silent',
    outfile: outFile,
    plugins: [stubPlugin],
  })
  return pathToFileURL(outFile).href
}

/** 假 localStorage（隐私模式/配额满由各用例单独模拟） */
function makeStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => { map.set(String(k), String(v)) },
    removeItem: (k) => { map.delete(String(k)) },
    clear: () => map.clear(),
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size },
  }
}

/** 每个用例集开始前装一遍全局桩（localStorage / fetch / 人设前缀 / 动作记录器） */
function installGlobals() {
  const storage = makeStorage()
  globalThis.localStorage = storage
  const fetches = []
  let impl = async () => ({ ok: true, status: 200, json: async () => ({ ok: false }) })
  globalThis.fetch = (url, init) => {
    fetches.push(String(url))
    return impl(String(url), init)
  }
  globalThis.__glueMoodValue = ''
  globalThis.__glueBeginOnce = null
  globalThis.__glueRecite = null
  return {
    storage,
    fetches,
    setFetch(fn) { impl = fn },
  }
}

/** 假 React：hook 槽位按顺序分配，够验证 createHooks 的语义 */
function makeReact() {
  const slots = []
  let i = 0
  return {
    reset() { i = 0 },
    R: {
      useRef(init) {
        const s = slots[i] || (slots[i] = {})
        i++
        if (!('ref' in s)) s.ref = { current: init }
        return s.ref
      },
      useState(init) {
        const s = slots[i] || (slots[i] = {})
        i++
        if (!('v' in s)) s.v = typeof init === 'function' ? init() : init
        return [s.v, (next) => { s.v = typeof next === 'function' ? next(s.v) : next }]
      },
    },
  }
}

/** 假气泡元素：只实现 bubble.ts 用到的那几样 */
function makeEl() {
  const classes = new Set()
  return {
    _t: null,
    style: {},
    textContent: '',
    classList: {
      add(c) { classes.add(c) },
      remove(c) { classes.delete(c) },
      has(c) { return classes.has(c) },
    },
    has(c) { return classes.has(c) },
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const settle = () => new Promise((r) => setTimeout(r, 0))

/** 从 URL 里取业务路径（去掉 API 前缀，保留查询串），断言/分流只认业务路径 */
function pathOf(url) {
  const p = String(url || '')
  const prefix = '/api/chubby-whale'
  const i = p.indexOf(prefix)
  return i >= 0 ? p.slice(i + prefix.length) || '/' : p
}

/**
 * 一套断言。mod 是一份独立的 bundle 实例，ctx 是 installGlobals() 的返回值。
 * 返回 [{name, pass, detail}]，调用方决定怎么打印。
 */
async function runSuite(mod, ctx) {
  const results = []
  const ok = (name, cond, detail = '') => {
    results.push({ name, pass: !!cond, detail: String(detail || '') })
  }
  const resetFetch = () => { ctx.fetches.length = 0 }
  ctx.setFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: false }) }))

  // ================= bubble.ts =================
  {
    const { createBubble, ensureBubbleStyle, BUBBLE_CSS, STATUS_TEXTS } = mod.bubble
    const nodes = []
    const fakeDoc = {
      getElementById: (id) => nodes.find((n) => n.id === id) || null,
      createElement: () => ({ id: '', textContent: '' }),
      head: { appendChild: (n) => nodes.push(n) },
    }
    ensureBubbleStyle(fakeDoc)
    ensureBubbleStyle(fakeDoc)
    ensureBubbleStyle(fakeDoc)
    ok('bubble：样式注入幂等（连续 3 次只挂 1 个 <style>）', nodes.length === 1 && nodes[0].id === 'chubby-whale-style', '样式节点=' + nodes.length)
    ok('bubble：样式内容就是 BUBBLE_CSS', nodes.length === 1 && nodes[0].textContent === BUBBLE_CSS)
    ok('bubble：STATE 表冻结', Object.isFrozen(STATUS_TEXTS) && STATUS_TEXTS.indexOf('在想…') >= 0)

    // 无 document：不抛错、也不建节点（浏览器 bundle 之外的环境）
    ok('bubble：没有 document 时 ensureBubbleStyle 静默返回', (() => {
      try { ensureBubbleStyle(); return typeof document === 'undefined' && nodes.length === 1 } catch (e) { return false }
    })())

    let hidden = 0
    const el = makeEl()
    const textEl = { textContent: '' }
    const bubble = createBubble({
      el: () => el,
      textEl: () => textEl,
      pos: () => ({ x: 100, y: 200 }),
      xOffset: 40,
      viewport: () => ({ w: 1280, h: 720 }),
      onHide: () => { hidden++ },
    })

    // 定位与显示
    bubble.show('吃白饭啦', 60)
    ok('bubble：定位（left=x+中心偏移 / bottom 抬到鱼上方 / 三角居中）',
      el.style.left === '140px' && el.style.transform === 'translateX(-50%)' && el.style.bottom === '532px',
      JSON.stringify(el.style))
    ok('bubble：show 会加 show 类', el.classList.has('show') && textEl.textContent === '吃白饭啦')
    await sleep(100)
    ok('bubble：到点自动收起并清计时器', !el.classList.has('show') && el._t === null && hidden === 1, 'hidden=' + hidden)

    // 叠加：新气泡顶掉旧的，旧计时器不许再收掉新的
    hidden = 0
    bubble.show('第一句', 30)
    bubble.show('第二句', 120)
    await sleep(60)
    ok('bubble：叠加后旧计时器不再收掉新气泡', el.classList.has('show') && textEl.textContent === '第二句', textEl.textContent)
    await sleep(110)
    ok('bubble：叠加只触发一次 onHide', !el.classList.has('show') && hidden === 1, 'hidden=' + hidden)

    // hide：立即收起并清槽位；之后还能正常 show
    bubble.show('第三句', 5000)
    bubble.hide()
    ok('bubble：hide 立即收起并清掉计时器槽位', !el.classList.has('show') && el._t === null)
    bubble.show('第四句', 20)
    await sleep(60)
    ok('bubble：hide 之后计时器槽位可复用', !el.classList.has('show') && el._t === null)

    // 纯状态字收起（与 decorateText 的 trim 判据一致）
    bubble.show('在想…', 5000)
    bubble.dismissStatus()
    ok('bubble：纯状态字（精确）可被 dismissStatus 收起', !el.classList.has('show') && el._t === null)
    bubble.show('在想… ', 5000)
    bubble.dismissStatus()
    ok('bubble：纯状态字带尾随空格也能收起（与 decorateText 判据一致）', !el.classList.has('show') && el._t === null, JSON.stringify(textEl.textContent))
    bubble.show('今天吃了三碗饭', 5000)
    bubble.dismissStatus()
    ok('bubble：正常消息不被 dismissStatus 误收', el.classList.has('show') && textEl.textContent === '今天吃了三碗饭')

    // 情绪前缀：状态字不加，已带表情的不叠
    globalThis.__glueMoodValue = '🐳 '
    bubble.show('你好', 5000)
    ok('bubble：显示时加情绪前缀', textEl.textContent === '🐳 你好', textEl.textContent)
    bubble.show('在想…', 5000)
    ok('bubble：纯状态字不加情绪前缀', textEl.textContent === '在想…', textEl.textContent)
    bubble.show('🐳 已经带表情', 5000)
    ok('bubble：已以表情开头不再叠前缀', textEl.textContent === '🐳 已经带表情', textEl.textContent)
    globalThis.__glueMoodValue = ''

    // 无 window：viewport 回落 1024×768（默认分支，不传 viewport）
    const el2 = makeEl()
    const bubble2 = createBubble({ el: () => el2, textEl: () => ({ textContent: '' }), pos: () => ({ x: 0, y: 300 }), xOffset: 10 })
    bubble2.show('无窗口', 5000)
    ok('bubble：没有 window 时视口回落 1024×768', el2.style.bottom === '480px', el2.style.bottom)
    bubble2.hide()

    // 元素还没挂上（el() 返回 null）也不能抛
    const bubble3 = createBubble({ el: () => null, textEl: () => null, pos: () => ({ x: 0, y: 0 }), xOffset: 0 })
    ok('bubble：元素未挂载时 show/hide/dismissStatus 都不抛', (() => {
      try { bubble3.show('x'); bubble3.hide(); bubble3.dismissStatus(); return true } catch (e) { return false }
    })())
  }

  // ================= hooks.ts =================
  {
    const { createHooks, readLocalFlag } = mod.hooks

    // 每类用例都用全新的 hook 槽位：避免上一条用例的 ref/state 被下一条复用

    // 工厂返回假值也只建一次（旧写法 if (!ref.current) 会每次渲染都重建）
    {
      const react = makeReact()
      const api = createHooks(react.R)
      let calls = 0
      react.reset()
      const a = api.useLazyRef(() => { calls++; return 0 })
      react.reset()
      const b = api.useLazyRef(() => { calls++; return 0 })
      ok('hooks：useLazyRef 工厂返回假值也只建一次', calls === 1 && a === b, 'calls=' + calls)
    }
    {
      const react = makeReact()
      const api = createHooks(react.R)
      let calls = 0
      react.reset()
      const a = api.useLazyRef(() => { calls++; return null })
      react.reset()
      const b = api.useLazyRef(() => { calls++; return null })
      ok('hooks：useLazyRef 工厂返回 null 也只建一次', calls === 1 && a === b, 'calls=' + calls)
    }
    {
      const react = makeReact()
      const api = createHooks(react.R)
      let calls = 0
      react.reset()
      const a = api.useLazyRef(() => { calls++; return { busy: false } })
      react.reset()
      const b = api.useLazyRef(() => { calls++; return { busy: false } })
      ok('hooks：useLazyRef 返回同一对象（对象工厂只建一次）', calls === 1 && a === b, 'calls=' + calls)
    }

    // 持久化布尔：ref + state + localStorage 三处一致
    {
      const react = makeReact()
      const api = createHooks(react.R)
      ctx.storage.removeItem('chubby-glue-flag')
      react.reset()
      const st = api.usePersistentBool('chubby-glue-flag')
      ok('hooks：usePersistentBool 缺省取 fallback=true', st.value === true && st.ref.current === true)
      st.set(false)
      ok('hooks：set 同步写 ref 与 localStorage',
        st.ref.current === false && ctx.storage.getItem('chubby-glue-flag') === 'off',
        String(ctx.storage.getItem('chubby-glue-flag')))
      // 假 React 不重渲染：再走一次 hook 拿到新的 state 快照
      react.reset()
      const st2 = api.usePersistentBool('chubby-glue-flag')
      ok('hooks：重新挂载后 state 与 localStorage 一致（off）', st2.value === false && st2.ref.current === false)
      react.reset()
      const st3 = api.usePersistentBool('chubby-glue-flag2', false)
      ok('hooks：键不存在时取显式 fallback', st3.value === false && st3.ref.current === false)
    }

    ok('hooks：readLocalFlag 只认 off 为关（其余都算开）',
      readLocalFlag('chubby-none', true) === true && readLocalFlag('chubby-none', false) === false &&
      (ctx.storage.setItem('chubby-on', 'on'), readLocalFlag('chubby-on') === true) &&
      (ctx.storage.setItem('chubby-off', 'off'), readLocalFlag('chubby-off') === false) &&
      (ctx.storage.setItem('chubby-blank', ''), readLocalFlag('chubby-blank') === true))

    // SSR / 隐私模式：localStorage 访问本身抛错
    const saved = globalThis.localStorage
    delete globalThis.localStorage
    ok('hooks：没有 localStorage 时 readLocalFlag 回落 fallback（不抛）',
      readLocalFlag('chubby-ssr', true) === true && readLocalFlag('chubby-ssr', false) === false)
    {
      const react = makeReact()
      const api = createHooks(react.R)
      react.reset()
      let ssrOk = false
      try {
        const ssr = api.usePersistentBool('chubby-ssr-flag', true)
        ssr.set(false)
        ssrOk = ssr.value === true && ssr.ref.current === false
      } catch (e) { ssrOk = false }
      ok('hooks：没有 localStorage 时 usePersistentBool 仍可用（本次会话内生效）', ssrOk)
    }
    globalThis.localStorage = saved
  }

  // ================= look.ts =================
  {
    const { tierOf, lookFor, lookForGrowth, parseGrowth, TIER_EXP, TIER_NAMES } = mod.look
    ok('look：档位边界 0/199→初识、200/799→熟络、800→黏人',
      [0, 199, 200, 799, 800].map((e) => tierOf(e)).join(',') === '0,0,1,1,2',
      [0, 199, 200, 799, 800].map((e) => tierOf(e)).join(','))
    ok('look：坏值回落最低档（NaN / 负数 / -Infinity）',
      tierOf(NaN) === 0 && tierOf(-5) === 0 && tierOf(-Infinity) === 0)
    ok('look：+Infinity 落最高档（单调，不回落）', tierOf(Infinity) === 2 && lookFor(Infinity) === lookFor(800))
    ok('look：外观参数随档位单调（体型↑ 光点↑ 甩尾间隔↓）',
      lookFor(0).scale < lookFor(200).scale && lookFor(200).scale < lookFor(800).scale &&
      lookFor(0).dots < lookFor(200).dots && lookFor(200).dots < lookFor(800).dots &&
      lookFor(0).tailEveryMs > lookFor(200).tailEveryMs && lookFor(200).tailEveryMs > lookFor(800).tailEveryMs)
    ok('look：外观表与阈值表冻结、档位名与阈值表一致',
      Object.isFrozen(lookFor(0)) && Object.isFrozen(TIER_EXP) && Object.isFrozen(TIER_NAMES) &&
      TIER_NAMES.join(',') === '初识,熟络,黏人' && lookFor(0).label === TIER_NAMES[0])
    ok('look：lookForGrowth 空值/坏值回落初识',
      lookForGrowth(null).tier === 0 && lookForGrowth(undefined).tier === 0 &&
      lookForGrowth({}).tier === 0 && lookForGrowth({ exp: NaN }).tier === 0 && lookForGrowth({ exp: '500' }).tier === 0)
    ok('look：lookForGrowth 正常值走档位', lookForGrowth({ exp: 800 }).tier === 2)

    ok('look：parseGrowth 拒绝空值/坏 ok/坏 exp',
      parseGrowth(null) === null && parseGrowth('x') === null && parseGrowth([]) === null &&
      parseGrowth({}) === null && parseGrowth({ ok: false, exp: 350 }) === null &&
      parseGrowth({ ok: true, exp: 'abc' }) === null && parseGrowth({ ok: true, exp: -Infinity }) === null)
    const g1 = parseGrowth({ ok: true, exp: 350, stage: '熟悉', nextExp: 800, tier: 99 })
    ok('look：parseGrowth 只采信服务端 exp（外部 tier 忽略）', g1 && g1.exp === 350 && g1.tier === 1 && g1.nextExp === 800, JSON.stringify(g1))
    const g2 = parseGrowth({ ok: true, exp: -5 })
    ok('look：parseGrowth 负经验夹到 0，缺字段回落 host 同源规则', g2 && g2.exp === 0 && g2.tier === 0 && g2.stage === '初识' && g2.nextExp === 200, JSON.stringify(g2))
    const g3 = parseGrowth({ ok: true, exp: 600, nextExp: -3 })
    ok('look：parseGrowth nextExp 非法时回落 host 门槛', g3 && g3.nextExp === 800, JSON.stringify(g3))
  }

  // ================= ape.ts =================
  {
    const { simulateSegment, APE_DEFAULTS } = mod.ape
    const F = APE_DEFAULTS.frameMs
    const frames = (n, db) => Array.from({ length: n }, () => db)
    const speechThenSilence = (first) => [
      ...(first === undefined ? [] : [first]),
      ...frames(10, -70), ...frames(13, -45), ...frames(50, -72),
    ]
    const base = simulateSegment(speechThenSilence())
    ok('ape：基线（静音→说话→静音）按 quiet 收尾',
      base.step.commit && base.step.commitReason === 'quiet' && base.step.speechMs === 780,
      'reason=' + base.step.commitReason + ' ms=' + base.frames * F)

    for (const bad of [NaN, Infinity, -Infinity]) {
      const r = simulateSegment(speechThenSilence(bad))
      ok('ape：首帧 ' + String(bad) + ' 不污染噪声底（照常 quiet 收尾）',
        r.step.commit && r.step.commitReason === 'quiet' && Number.isFinite(r.step.floorDb) && Number.isFinite(r.step.db) &&
        r.step.speechMs === 780,
        'reason=' + r.step.commitReason + ' floor=' + r.step.floorDb + ' speech=' + r.step.speechMs)
    }
    const nanMid = [...frames(10, -70), ...frames(20, NaN), ...frames(13, -45), ...frames(50, -72)]
    const mid = simulateSegment(nanMid)
    ok('ape：中途 NaN 帧只按安静推进，不污染噪声底',
      mid.step.commit && mid.step.commitReason === 'quiet' && Number.isFinite(mid.step.floorDb), 'floor=' + mid.step.floorDb)

    // -160 是"读不到电平"的哨兵（也是数字静音）：绝不能当第一个噪声底，否则起判阈值压到 -156，
    // 之后真实电平全算说话、噪声底永远回不来。
    const sentinelFirst = simulateSegment([-160, ...frames(20, -70), ...frames(13, -45), ...frames(50, -72)])
    ok('ape：-160 首帧不当作噪声底（后续照常按 quiet 收尾）',
      sentinelFirst.step.commit && sentinelFirst.step.commitReason === 'quiet' && sentinelFirst.step.floorDb < -60,
      'reason=' + sentinelFirst.step.commitReason + ' floor=' + sentinelFirst.step.floorDb)

    // 纯静音：不提交；窗口按时间静默重置（不能把一段空气送去 ASR）
    const silent = simulateSegment(frames(200, -160))
    ok('ape：纯 -160 静音不提交、也不无限增长', !silent.step.commit && silent.step.hadSpeech === false && silent.step.elapsedMs <= APE_DEFAULTS.maxSegmentMs,
      'elapsed=' + silent.step.elapsedMs + ' had=' + silent.step.hadSpeech)

    // 窗口参数被写死 8 时，steadyWindowFrames<8 会让"恒定噪声"永远判不平稳 → 每段等满 6 秒
    const steadySeq = [...frames(10, -70), ...frames(13, -45), ...frames(200, -52)]
    const steadyDefault = simulateSegment(steadySeq)
    const steadySmall = simulateSegment(steadySeq, { steadyWindowFrames: 5 })
    ok('ape：steadyWindowFrames=5 仍能认出恒定噪声（不被写死的 8 帧卡住）',
      steadySmall.step.commit && steadySmall.step.commitReason === 'quiet' && steadySmall.frames * F < APE_DEFAULTS.maxSegmentMs,
      'reason=' + steadySmall.step.commitReason + ' ms=' + steadySmall.frames * F)
    ok('ape：默认窗口行为不变（说话→稳态噪声仍按 quiet 提前收尾）',
      steadyDefault.step.commit && steadyDefault.step.commitReason === 'quiet' && steadyDefault.frames <= 60,
      'ms=' + steadyDefault.frames * F)

    ok('ape：空序列不死机', simulateSegment([]).frames === 0 && simulateSegment([]).step.commit === false)
  }

  // ================= chat-route.ts（点播路由）=================
  {
    const { createLocalRouter } = mod.chatRoute
    // 先注入诗名索引：未就绪时 intent 会顺手触发一次 /poem-titles 预热请求，
    // 那样"点播没命中就不该打网络"的断言会被这条预热干扰。
    mod.poemTitles.primePoemTitles(['雨霖铃', '水调歌头', '静夜思'])
    const calls = { bubbles: [], story: [], recite: [], begin: [], aborts: 0, speaks: [] }
    let beginOnceResult = true
    let poemFail = false
    let booksFail = false
    /** 点名但诗库里没有：宿主回落随机并带 matched:false（与 host/routes/poem.ts 同口径） */
    let poemMiss = false
    globalThis.__glueBeginOnce = (key) => { calls.begin.push(key); return beginOnceResult }
    globalThis.__glueRecite = (host, poem) => { calls.recite.push(poem && poem.title) }
    ctx.setFetch(async (url) => {
      const p = pathOf(url)
      if (p.indexOf('/poem') === 0) {
        if (poemFail) throw new Error('offline')
        if (poemMiss && p.indexOf('title=') >= 0) {
          return { ok: true, status: 200, json: async () => ({ ok: true, matched: false, item: { title: '雨霖铃', author: '柳永', dynasty: '宋', text: '寒蝉凄切。\n对长亭晚。' } }) }
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, item: { title: '雨霖铃', author: '柳永', dynasty: '宋', text: '寒蝉凄切。\n对长亭晚。' } }) }
      }
      if (p.indexOf('/culture') === 0) {
        return { ok: true, status: 200, json: async () => ({ ok: true, item: { title: '一鼓作气', src: '左传', text: '振作士气。' } }) }
      }
      if (p.indexOf('/story/books') === 0) {
        if (booksFail) throw new Error('offline')
        return { ok: true, status: 200, json: async () => ({ ok: true, books: ['聊斋', '三国演义'] }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: false }) }
    })

    const host = {
      persona: {},
      narrationRate: () => '-25%',
      bubble: (t) => calls.bubbles.push(t),
      say: () => { },
      speak: (t, o) => calls.speaks.push({ t, o }),
      narrate: () => { },
      clearNarrate: () => { },
      talkFor: () => { },
      story: { start: (book) => calls.story.push(book) },
      storyState: { book: { current: '聊斋' }, auto: { current: false } },
      abortChat: () => { calls.aborts++ },
    }
    const router = createLocalRouter(host)
    const run = async (text) => {
      calls.bubbles.length = 0; calls.story.length = 0; calls.recite.length = 0; calls.begin.length = 0
      calls.speaks.length = 0; calls.aborts = 0
      resetFetch()
      const hit = router.route(text)
      await settle()
      return hit
    }

    // ① 追问白名单：不点内容 / 明确点诗
    for (const t of ['再来一首', '换一首', '再来一个', '再念首', '再来一首诗', '再来一首吧', '换首诗']) {
      const hit = await run(t)
      ok('route：「' + t + '」走本地念诗', hit === true && calls.bubbles[0] === '（点播）好，再念一首' &&
        ctx.fetches.some((u) => pathOf(u).indexOf('/poem') === 0) && calls.recite[0] === '雨霖铃' &&
        calls.aborts === 1, 'hit=' + hit + ' fetches=' + ctx.fetches.map(pathOf).join(','))
      ok('route：「' + t + '」只打本地接口，不进模型', ctx.fetches.every((u) => pathOf(u).indexOf('/chat') !== 0))
    }

    // ② 不是点播的近似说法：交给模型（intent 的既有断言也把「换个故事」划给模型）
    for (const t of ['换个说法', '换个话题', '换个思路', '换个问题', '换个角度', '换个故事', '换个声音',
      '换个活法', '再来个故事', '再来个人', '换个说法吧']) {
      const hit = await run(t)
      ok('route：「' + t + '」交给模型（不劫持、不打断聊天）',
        hit === false && ctx.fetches.length === 0 && calls.bubbles.length === 0 && calls.aborts === 0 && calls.story.length === 0,
        'hit=' + hit + ' fetches=' + ctx.fetches.length + ' aborts=' + calls.aborts)
    }

    // ③ 整句指令容忍句末陈述标点；问号仍交给模型
    for (const t of ['接着说', '接着说。', '接着说！', '继续', '继续。', '往下讲。', '接着讲']) {
      const hit = await run(t)
      ok('route：「' + t + '」接着讲当前书', hit === true && calls.story[0] === '聊斋' &&
        host.storyState.auto.current === true && calls.bubbles[0] === '（点播）接着说' && calls.aborts === 1,
        'hit=' + hit + ' story=' + String(calls.story[0]))
    }
    ok('route：「接着说？」是提问，交给模型', (await run('接着说？')) === false && calls.story.length === 0)
    for (const t of ['报书名', '报书名。', '报一下书单！']) {
      const hit = await run(t)
      ok('route：「' + t + '」本地列书单', hit === true && ctx.fetches.some((u) => pathOf(u).indexOf('/story/books') === 0) &&
        calls.bubbles.some((b) => b.indexOf('书单有 2 本') >= 0 && b.indexOf('聊斋') >= 0), calls.bubbles.join(' | '))
    }

    // ④ intent 分流：诗 / 典故 / 成语 / 说书；命中后只走本地
    let hit = await run('背首诗')
    ok('route：「背首诗」随机取一首（不带 title）', hit === true && ctx.fetches.some((u) => pathOf(u).indexOf('/poem') === 0 && pathOf(u).indexOf('title=') < 0),
      ctx.fetches.map(pathOf).join(','))
    hit = await run('背雨霖铃')
    ok('route：点名诗带 title 参数（encodeURIComponent）',
      hit === true && ctx.fetches.some((u) => pathOf(u).indexOf('title=' + encodeURIComponent('雨霖铃')) >= 0),
      ctx.fetches.map(pathOf).join(','))
    // 2026-11-13：语音里说的是「背诵。」「背诵《梦》。」——必须进本地念诗线路
    hit = await run('背诵')
    ok('route：只问「背诵」也走本地念诗（不再交给模型瞎答）',
      hit === true && ctx.fetches.some((u) => pathOf(u).indexOf('/poem') === 0) && calls.recite.length === 1,
      'hit=' + hit + ' fetches=' + ctx.fetches.map(pathOf).join(','))
    hit = await run('背诵《梦》')
    ok('route：「背诵《梦》」带 title 参数（书名号标题不必先有索引）',
      hit === true && ctx.fetches.some((u) => pathOf(u).indexOf('title=' + encodeURIComponent('梦')) >= 0) && calls.recite[0] === '雨霖铃',
      ctx.fetches.map(pathOf).join(','))
    // 追问：先报诗名（带朝代/书名号），下一句只催「叫你背呀」——必须接着背刚才那首
    hit = await run('《宋·雨霖铃》。')
    ok('route：「《宋·雨霖铃》。」整句报诗名 → 本地念诗（带朝代前缀也能归一）',
      hit === true && calls.recite[0] === '雨霖铃', JSON.stringify(calls.recite))
    hit = await run('叫你背呀！')
    ok('route：追问「叫你背呀！」2 分钟内接着背刚才那首',
      hit === true && calls.recite[0] === '雨霖铃', JSON.stringify(calls.recite))
    hit = await run('别背了')
    ok('route：否定式追问不接（别背了 → 交给模型）', hit === false, 'hit=' + hit)
    hit = await run('讲个典故')
    ok('route：「讲个典故」取 chengyu 池，播报仍说「典故」（不按数据池名念成成语）',
      hit === true && ctx.fetches.some((u) => pathOf(u) === '/culture?type=chengyu') &&
      calls.speaks.length === 1 && calls.speaks[0].o && calls.speaks[0].o.rate === '-25%' &&
      calls.speaks[0].t.indexOf('讲个典故——一鼓作气') === 0 &&
      calls.bubbles.indexOf('典故·一鼓作气') >= 0,
      'bubbles=' + calls.bubbles.join('|') + ' speaks=' + JSON.stringify(calls.speaks))
    hit = await run('讲个成语')
    ok('route：「讲个成语」取 idiom 池，播报说「成语」',
      hit === true && ctx.fetches.some((u) => pathOf(u) === '/culture?type=idiom') &&
      calls.speaks.some((s) => s.t.indexOf('讲个成语——一鼓作气') === 0) &&
      calls.bubbles.indexOf('成语·一鼓作气') >= 0,
      'bubbles=' + calls.bubbles.join('|') + ' speaks=' + JSON.stringify(calls.speaks))
    host.storyState.auto.current = false
    hit = await run('讲个故事')
    ok('route：「讲个故事」开说书并打开连播', hit === true && calls.story[0] === '' && host.storyState.auto.current === true && calls.aborts === 1)

    // ⑤ 不劫持：提问 / 长句
    for (const t of ['为什么天是蓝的？', '讲故事吗？', '今天我想听你讲一讲那个关于白蛇传说的完整故事，最好带点评'.repeat(2)]) {
      const h = await run(t)
      ok('route：提问/长句不劫持（' + t.slice(0, 8) + '…）', h === false && ctx.fetches.length === 0)
    }

    // ⑥ 副作用：正在讲时再点典故 → 提示但不重复请求
    beginOnceResult = false
    hit = await run('讲个典故')
    ok('route：叙述锁占着时只提示、不重复取数',
      hit === true && calls.bubbles[0] === '正在讲呢，稍等～' && ctx.fetches.length === 0 && calls.speaks.length === 0,
      calls.bubbles.join(' | '))
    beginOnceResult = true

    // ⑦ 失败降级：诗册 / 书单取不到都要有明确提示，不抛
    poemFail = true
    hit = await run('背首诗')
    ok('route：诗册取不到 → 轻提示「诗册没读到」', hit === true && calls.bubbles.indexOf('诗册没读到') >= 0, calls.bubbles.join(' | '))
    poemFail = false
    booksFail = true
    hit = await run('报书名')
    ok('route：书单取不到 → 轻提示「书单没取到」', hit === true && calls.bubbles.indexOf('书单没取到，稍后再试') >= 0, calls.bubbles.join(' | '))
    booksFail = false

    // ⑧ 点名但诗库里没有：照实说没有，**不拿随机那首凑数**（旧实现会把回落随机当主人要的念）
    poemMiss = true
    hit = await run('背诵《梦》')
    ok('route：点名诗库外 → 明说没有、不念随机',
      hit === true && calls.recite.length === 0 && calls.bubbles.some((b) => b.indexOf('诗库里没有《梦》') >= 0),
      'recite=' + JSON.stringify(calls.recite) + ' bubbles=' + calls.bubbles.join(' | '))
    poemMiss = false
  }

  return results
}

/**
 * poem-titles 的「未就绪 → 失败降级」路径。
 * 必须用独立模块实例：同一实例里跑完点播路由后标题已被 primePoemTitles 注入，
 * 再断言"初始未就绪"就没有意义了（还会把 started 状态一起带过来）。
 */
async function runPoemTitlesDegradedSuite(mod, ctx) {
  const results = []
  const ok = (name, cond, detail = '') => results.push({ name, pass: !!cond, detail: String(detail || '') })
  const origLog = console.error
  console.error = () => { }   // ensure 失败不弹错、也不往测试输出里写日志
  try {
    ok('poem-titles：cwd 没有 data 时初始未就绪（返回空表）', mod.poemTitles.poemTitles().length === 0, String(mod.poemTitles.poemTitles().length))

    ctx.fetches.length = 0
    ctx.setFetch(async () => { throw new Error('offline') })
    mod.poemTitles.ensurePoemTitles()
    mod.poemTitles.ensurePoemTitles()
    mod.poemTitles.ensurePoemTitles()
    // 2026-11-07 起：失败后有界重试（60s 退避、最多 3 次）。同一时刻的重复 ensure 仍只发一次，
    // 但"本页永不再试"已改成"窗口内不重试、最多 3 次"。
    ok('poem-titles：同一时刻重复 ensure 只打一次网络（退避生效）', ctx.fetches.length === 1, String(ctx.fetches.length))
    await settle()
    ok('poem-titles：失败后保持降级（空表、不抛）', mod.poemTitles.poemTitles().length === 0)

    mod.intent.detectIntent('背首诗')
    mod.intent.detectIntent('背雨霖铃')
    mod.poemTitles.ensurePoemTitles()
    await settle()
    ok('poem-titles：退避窗口内不重试（多次识别仍只有 1 次请求）',
      ctx.fetches.length === 1, 'requests=' + ctx.fetches.length)
    ok('poem-titles：未就绪时泛化意图照常识别（背首诗 → poem）',
      (() => { const h = mod.intent.detectIntent('背首诗'); return !!h && h.kind === 'poem' })())
    ok('poem-titles：未就绪时不认具体诗名（matchPoemTitle 空串）', mod.intent.matchPoemTitle('背雨霖铃') === '')

    mod.poemTitles.primePoemTitles(['雨霖铃', '水调歌头', '静夜思'])
    ok('poem-titles：prime 注入后按长度降序（水调歌头先于雨霖铃）',
      mod.poemTitles.poemTitles().join(',') === '水调歌头,雨霖铃,静夜思', mod.poemTitles.poemTitles().join(','))
    ok('poem-titles：prime 不写 localStorage', ctx.storage.getItem('chubby-poem-titles-v1') === null)
    ok('poem-titles：注入后 intent 能点诗名',
      mod.intent.matchPoemTitle('背雨霖铃') === '雨霖铃' &&
      (() => { const h = mod.intent.detectIntent('背雨霖铃'); return !!h && h.kind === 'poem' && h.title === '雨霖铃' })())
    mod.poemTitles.primePoemTitles([])
    ok('poem-titles：prime 空表不清空已有缓存（apply 只接受非空表）', mod.poemTitles.poemTitles().length === 3)
  } finally {
    console.error = origLog
  }
  return results
}

/** 成功路径 + 刷新后同步就绪：需要一份干净模块状态，所以单独 import 新实例 */
async function runPoemTitlesSuccessSuite(mod, ctx) {
  const results = []
  const ok = (name, cond, detail = '') => results.push({ name, pass: !!cond, detail: String(detail || '') })
  const origLog = console.error
  console.error = () => { }
  try {
    const titles = ['静夜思', '将进酒', '水调歌头', '雨霖铃']
    ctx.setFetch(async (url) => {
      if (pathOf(url).indexOf('/poem-titles') !== 0) return { ok: true, status: 200, json: async () => ({ ok: false }) }
      return { ok: true, status: 200, json: async () => ({ ok: true, count: titles.length, titles }) }
    })
    ok('poem-titles（新实例）：初始未就绪', mod.poemTitles.poemTitles().length === 0)
    mod.poemTitles.ensurePoemTitles()
    await settle()
    await settle()
    ok('poem-titles：成功拉取后按长度降序就绪',
      mod.poemTitles.poemTitles().join(',') === '水调歌头,静夜思,将进酒,雨霖铃',
      mod.poemTitles.poemTitles().join(','))
    const raw = ctx.storage.getItem('chubby-poem-titles-v1')
    let cached = null
    try { cached = JSON.parse(raw) } catch (e) { cached = null }
    ok('poem-titles：成功后写 localStorage（v1 + 标题表）',
      !!cached && cached.v === 1 && Array.isArray(cached.titles) && cached.titles.length === 4, String(raw && raw.slice(0, 40)))
    ok('poem-titles：写入的是归一化后的表（无空串、长度降序）',
      !!cached && cached.titles.every((t) => typeof t === 'string' && t.length > 0) &&
      cached.titles.every((t, i) => i === 0 || cached.titles[i - 1].length >= t.length))
  } finally {
    console.error = origLog
  }
  return results
}

/** 刷新后命中 localStorage：模块加载期就要同步就绪（不依赖网络、不依赖 cwd 里的 data） */
async function runCacheSeedSuite(mod, ctx) {
  const results = []
  const ok = (name, cond, detail = '') => results.push({ name, pass: !!cond, detail: String(detail || '') })
  ok('poem-titles（刷新）：命中 localStorage 时加载即同步就绪（不发请求）',
    mod.poemTitles.poemTitles().length === 4 && ctx.fetches.length === 0,
    'titles=' + mod.poemTitles.poemTitles().length + ' fetches=' + ctx.fetches.length)
  ok('poem-titles（刷新）：缓存里的标题按长度降序（读缓存也走 normalize）',
    mod.poemTitles.poemTitles().join(',') === '水调歌头,静夜思,将进酒,雨霖铃', mod.poemTitles.poemTitles().join(','))
  return results
}

function report(title, results, { quiet = false } = {}) {
  const fail = results.filter((r) => !r.pass)
  if (!quiet) {
    for (const r of results) {
      if (!r.pass) console.log('  ❌ ' + r.name + (r.detail ? '  ' + r.detail : ''))
    }
  }
  console.log('  ' + (fail.length === 0 ? '✅' : '❌') + ' ' + title + '：通过 ' + (results.length - fail.length) + ' 项 / 失败 ' + fail.length + ' 项')
  return fail
}

// ---------------------------------------------------------------------------
const TMP = mkdtempSync(join(tmpdir(), 'chubby-glue-'))
const CWD = join(TMP, 'cwd', 'a', 'b', 'c')   // 空 cwd：poem-titles 的 seedFromDisk 找不到 data/
mkdirSync(CWD, { recursive: true })
process.chdir(CWD)

let bad = 0
try {
  console.log('\n[1] 正向断言（esbuild 离线打包 ' + SRC + '）')
  const url = await bundle(SRC, join(TMP, 'glue-src.mjs'))
  let ctx = installGlobals()
  const mod = await import(url + '?v=main')
  bad += report('client-glue 正向断言', await runSuite(mod, ctx)).length

  ctx = installGlobals()
  const modDegraded = await import(url + '?v=poem-degraded')
  bad += report('poem-titles 未就绪 → 失败降级', await runPoemTitlesDegradedSuite(modDegraded, ctx)).length

  ctx = installGlobals()
  const mod2 = await import(url + '?v=poem-ok')
  bad += report('poem-titles 成功路径', await runPoemTitlesSuccessSuite(mod2, ctx)).length

  ctx = installGlobals()
  ctx.storage.setItem('chubby-poem-titles-v1', JSON.stringify({ v: 1, titles: ['静夜思', '水调歌头', '将进酒', '雨霖铃'] }))
  ctx.fetches.length = 0
  const mod3 = await import(url + '?v=poem-cache')
  bad += report('poem-titles 刷新读取缓存', await runCacheSeedSuite(mod3, ctx)).length
} catch (e) {
  bad++
  console.error('  ❌ 打包/加载失败：' + String((e && e.message) || e))
  console.error(String((e && e.stack) || e))
}

// ---------------------------------------------------------------------------
// 负向验证：把每处修复改回旧写法，同一套断言必须变红
const MUTANTS = [
  {
    id: 'chat-route：追问正则不再排除「换个说法/换个故事」',
    file: 'client/chat-route.ts',
    from: "if (again && (againTail === '' || /^[吧啊呀哦嘛哈啦呗吖诗]+/.test(againTail))) {",
    to: "if (again) {",
    expect: '换个说法',
  },
  {
    id: 'chat-route：典故播报按数据池名念成「成语」',
    file: 'client/chat-route.ts',
    from: 'const saidIdiom = /成语/.test(t0)',
    to: "const saidIdiom = type === 'chengyu'",
    expect: '讲个典故',
  },
  {
    id: 'bubble：dismissStatus 不 trim（尾随空格的状态字收不起来）',
    file: 'client/bubble.ts',
    from: 'if (STATUS_TEXTS.indexOf(txt.trim()) >= 0) {',
    to: 'if (STATUS_TEXTS.indexOf(txt) >= 0) {',
    expect: '带尾随空格',
  },
  {
    id: 'hooks：useLazyRef 用真假值判断（工厂返回假值会每次重建）',
    file: 'client/hooks.ts',
    from: '    const UNSET = {}\n    const ref = R.useRef(UNSET)\n    if (ref.current === UNSET) ref.current = factory()',
    to: '    const ref = R.useRef(null as any)\n    if (!ref.current) ref.current = factory()',
    expect: '工厂返回假值',
  },
  {
    id: 'ape：取消有效电平判断（NaN / ±Infinity / -160 直接进噪声底）',
    file: 'client/ape.ts',
    from: 'const valid = Number.isFinite(rawDb) && rawDb > SENTINEL_DB',
    to: 'const valid = true',
    expect: '不污染噪声底',
  },
  {
    id: 'ape：起伏判别写死 8 帧（steadyWindowFrames 参数失效）',
    file: 'client/ape.ts',
    from: 'const minFrames = Math.max(2, Math.min(8, p.steadyWindowFrames))',
    to: 'const minFrames = 8',
    expect: 'steadyWindowFrames',
  },
]

if (RUN_MUTANTS) {
  console.log('\n[2] 负向验证（把 ' + MUTANTS.length + ' 处修复逐一改回旧写法，同一套断言必须取到对应的失败）')
  const mutSrc = join(TMP, 'src-mutant')
  try {
    cpSync(SRC, mutSrc, { recursive: true })
  } catch (e) {
    bad++
    console.error('  ❌ 复制 src 失败：' + String((e && e.message) || e))
  }
  let caught = 0
  for (let i = 0; i < MUTANTS.length; i++) {
    const m = MUTANTS[i]
    const abs = join(mutSrc, m.file)
    let applied = false
    try {
      copyFileSync(join(SRC, m.file), abs)   // 上一条变异体的改动先还原
      const src = readFileSync(abs, 'utf8')
      if (src.indexOf(m.from) >= 0) {
        writeFileSync(abs, src.replace(m.from, m.to), 'utf8')
        applied = true
      }
    } catch (e) {
      applied = false
    }
    if (!applied) {
      bad++
      console.error('  ❌ 变异体 ' + (i + 1) + ' 没能应用（修复代码已变化？）：' + m.id)
      continue
    }
    try {
      const mutUrl = await bundle(mutSrc, join(TMP, 'glue-mutant-' + i + '.mjs'))
      const ctx = installGlobals()
      const mod = await import(mutUrl + '?v=mutant-' + i)
      const results = await runSuite(mod, ctx)
      const failed = results.filter((r) => !r.pass)
      const hit = failed.some((r) => r.name.indexOf(m.expect) >= 0)
      // 复原被改的文件，避免影响后续变异体
      copyFileSync(join(SRC, m.file), abs)
      if (hit) {
        caught++
        console.log('  ✅ 抓到变异体 ' + (i + 1) + '：' + m.id + '  （' + failed.length + ' 项失败）')
      } else {
        bad++
        console.log('  ❌ 变异体 ' + (i + 1) + ' 没被抓出：' + m.id + '  （失败项：' + failed.map((r) => r.name).join(' / ') + '）')
      }
    } catch (e) {
      bad++
      console.error('  ❌ 变异体 ' + (i + 1) + ' 运行失败：' + String((e && e.message) || e))
    }
  }
  console.log('  ' + (caught === MUTANTS.length ? '✅' : '❌') + ' 变异体被抓出 ' + caught + '/' + MUTANTS.length)
}

try { rmSync(TMP, { recursive: true, force: true }) } catch (e) { }

console.log(bad === 0 ? '\n  ✅ client-glue 全部通过' : '\n  ❌ 有 ' + bad + ' 项未通过')
process.exit(bad === 0 ? 0 : 1)
