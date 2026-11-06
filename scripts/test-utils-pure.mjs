/**
 * scripts/test-utils-pure.mjs —— 纯函数工具层体检（B89）
 *
 * 覆盖 8 个「纯函数 / 半纯」模块的边界，全部离线跑（esbuild 现打包，不碰 dist、不联网）：
 *   client/text.ts                切句 / 朗读时长估算 / 文案归一 / 去重 / 动作描写剥离
 *   client/util.ts                防御式小工具
 *   client/intent.ts              点播意图正则（误判、超长、注入式输入）
 *   client/rates.ts               语速偏好解析（NaN / 负数 / 超上限 / 脏 fallback）
 *   client/duilian.ts             对联库完整性与随机抽取边界
 *   client/narration.ts           叙述锁（0 = 无锁 / 到期界线 / clear 幂等）
 *   client/narration-progress.ts  按字数推进的进度（除零 / 越界）
 *   client/look.ts                成长档位映射边界
 *
 * 为什么另开一个脚本：npm test 里的 test.mjs 是「直接加载 src/*.ts」，只能覆盖主路径；
 * 这里用 esbuild 把 8 个模块打成一个 ESM 包，**先不装 DOM/localStorage 直接调用**，
 * 顺便验证「纯函数模块真的不依赖浏览器环境」；只有 rates.ts 的存储读改写走桩。
 *
 * 用法：node scripts/test-utils-pure.mjs               正常跑（全绿=退出码 0）
 *       node scripts/test-utils-pure.mjs --src <目录>   负向验证：把基线 src 副本丢进去，本脚本必须变红
 */

import { build } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const srcFlag = argv.indexOf('--src')
const SRC = srcFlag >= 0 ? resolve(argv[srcFlag + 1] || '') : join(ROOT, 'src')

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.error('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}
/** 便于打印 null / 空串这类"假值也算结果"的比较 */
const show = (v) => (v === null ? 'null' : v === undefined ? 'undefined' : JSON.stringify(v))

const TMP = mkdtempSync(join(tmpdir(), 'chubby-utils-pure-'))
const BUNDLE = join(TMP, 'utils-pure.mjs')

// ---------- esbuild：离线打包 8 个模块；只有 intent.ts 的诗名索引换成桩 ----------
// 桩的理由：真 poem-titles.ts 在模块加载时读 localStorage、Node 下还会摸 data/poem-titles.json，
// 并且 detectIntent 首次走到诗名匹配时会发一次后台 GET。这里要测的是 intent 的判定逻辑，
// 不该被网络/磁盘牵进来（诗名索引的加载与缓存另有 test.mjs 覆盖）。
const stubPoemTitles = {
  name: 'b89-stub-poem-titles',
  setup(b) {
    b.onResolve({ filter: /^\.\/poem-titles\.js$/ }, (args) => {
      const importer = String(args.importer || '').replace(/\\/g, '/')
      if (!/client[\\/]intent\.ts$/.test(importer)) return null
      return { path: 'poem-titles', namespace: 'b89-stub-poem-titles' }
    })
    b.onLoad({ filter: /.*/, namespace: 'b89-stub-poem-titles' }, () => ({
      contents: [
        'export function poemTitles() { return globalThis.__pureTitles || [] }',
        'export function ensurePoemTitles() { globalThis.__pureEnsure = (globalThis.__pureEnsure || 0) + 1 }',
        'export function primePoemTitles() {}',
      ].join('\n'),
      loader: 'js',
    }))
  },
}

try {
  await build({
    stdin: {
      contents: [
        "export * as text from './client/text.js'",
        "export * as util from './client/util.js'",
        "export * as intent from './client/intent.js'",
        "export * as rates from './client/rates.js'",
        "export * as duilian from './client/duilian.js'",
        "export * as narration from './client/narration.js'",
        "export * as progress from './client/narration-progress.js'",
        "export * as look from './client/look.js'",
        "export * as growth from './shared/growth.js'",
      ].join('\n'),
      resolveDir: SRC,
      sourcefile: 'b89-utils-pure-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    charset: 'utf8',
    logLevel: 'silent',
    outfile: BUNDLE,
    plugins: [stubPoemTitles],
  })
  ok('esbuild 打包 8 个纯函数模块（离线 / 不碰 dist）', true, SRC)
} catch (e) {
  ok('esbuild 打包 8 个纯函数模块（离线 / 不碰 dist）', false, String((e && e.message) || e))
  console.error(String((e && e.stack) || e))
  rmSync(TMP, { recursive: true, force: true })
  process.exit(1)
}

// ======================================================================
console.log('\n[1] 无浏览器环境直接装载（纯函数层不得依赖 DOM / localStorage）')
let mod
try {
  // 注意：这一次 import 发生在**任何** window/localStorage 桩之前
  mod = await import(pathToFileURL(BUNDLE).href + '?k=' + Date.now())
  ok('8 个模块顶层导入不抛错（Node 里没有 window/localStorage）', !!(mod.text && mod.intent && mod.rates && mod.duilian))
} catch (e) {
  ok('8 个模块顶层导入不抛错（Node 里没有 window/localStorage）', false, String((e && e.message) || e))
  console.error(String((e && e.stack) || e))
  rmSync(TMP, { recursive: true, force: true })
  process.exit(1)
}
const { text, util, intent, rates, duilian, narration, progress, look, growth } = mod
ok('装载过程没有创建 DOM 全局', typeof globalThis.window === 'undefined' && typeof globalThis.document === 'undefined')
ok('装载过程没有创建 localStorage 全局', typeof globalThis.localStorage === 'undefined')

// ======================================================================
console.log('\n[2] text.ts 流式切句 createSentenceBuffer')
try {
  const run = (chunks, maxLen) => {
    const b = text.createSentenceBuffer(maxLen)
    const out = []
    for (const c of chunks) out.push(...b.push(c))
    out.push(...b.flush())
    return out
  }
  ok('句末标点处切开', show(run(['第一句。第二句。'])) === show(['第一句。', '第二句。']), show(run(['第一句。第二句。'])))
  ok('增量分片与整批结果相同', show(run(['第', '一句。', '第二', '句。'])) === show(['第一句。', '第二句。']))
  ok('换行开头不会把整段卡到 maxLen', show(run(['\n你好。', '再见。'])) === show(['你好。', '再见。']))

  // 句首孤立标点（旧实现会在这里原地打转：正则每次只匹配到那个标点本身）
  const lone = run(['。你好。世界。'])
  ok('句首孤立标点不卡切句（仍按句切开，字符不丢）',
    lone.length === 2 && lone[0] === '。你好。' && lone[1] === '世界。', show(lone))
  ok('句首孤立标点分两批到达也不卡', show(run(['。', '你好。'])) === show(['。你好。']), show(run(['。', '你好。'])))

  // 代理对：切点只落在标点之后 / 整段吐出，绝不切在 emoji 中间
  const emoji = run(['你好😀。这是🍚。', '尾巴🐟'])
  ok('emoji 段落正常切开', show(emoji) === show(['你好😀。', '这是🍚。', '尾巴🐟']), show(emoji))
  ok('所有段落都是完整字形（无孤立代理项）', emoji.every((s) => s.isWellFormed()), emoji.map((s) => s.length).join(','))
  const dense = run(['😀'.repeat(40) + '。'], 8)
  ok('超密 emoji + 小 maxLen 也不劈代理对', dense.every((s) => s.isWellFormed()) && dense.join('').split('😀').length - 1 === 40)

  // 超长无标点：limit 是触发阈值，同时也是**硬上限**（2026-11-07 改）
  // 为什么改：一次 delta 若 500 字，原来整段吐给 TTS，一次念几分钟、打断也晚；
  // 现在按阈值切段，但保证不丢字、不劈代理对。
  const long = run(['啊'.repeat(500)])
  ok('超长无标点按阈值切段（不丢字）', long.length === Math.ceil(500 / 40) && long.join('') === '啊'.repeat(500), '段数=' + long.length + ' 长度=' + (long[0] || '').length)
  ok('切段后每段不超过阈值', long.every((s) => s.length <= 40), long.map((s) => s.length).join(','))

  const tiny = text.createSentenceBuffer(2)
  ok('maxLen 下限生效（2 字才吐）', tiny.push('啊').length === 0 && tiny.push('啊').length === 1)
  const badLimit = text.createSentenceBuffer(Number.NaN)
  ok('非法 maxLen 回落 40：39 字不吐、40 字才吐',
    badLimit.push('啊'.repeat(39)).length === 0 && badLimit.push('啊').length === 1)

  const blanks = text.createSentenceBuffer(40)
  ok('纯空白既不出段也不吐出空串',
    blanks.push('   \n\t').length === 0 && blanks.flush().length === 0)
  ok('flush 吐出未成句的尾巴', show(run(['还没说完'])) === show(['还没说完']))
  ok('中文分号/问号/叹号都是切点', show(run(['a；b？c!d?e\nf'])) === show(['a；', 'b？', 'c!', 'd?', 'e', 'f']))
} catch (e) {
  ok('createSentenceBuffer 可验证', false, String((e && e.message) || e))
}

// ======================================================================
console.log('\n[3] text.ts 朗读估算与文案工具')
try {
  ok('纯中文估算与旧公式一致（4 字 → 3000 + 4×260）', text.estimateSpeakMs('你好世界') === 4040, String(text.estimateSpeakMs('你好世界')))
  ok('英文按词计（hello world → 600 + 2×300）', text.estimateSpeakMs('hello world') === 1200, String(text.estimateSpeakMs('hello world')))
  ok('数字按位计（1324 → 600 + 4×200）', text.estimateSpeakMs('1324') === 1400, String(text.estimateSpeakMs('1324')))
  ok('撇号/连字符不拆词', text.estimateSpeakMs("don't") === text.estimateSpeakMs('dont') && text.estimateSpeakMs('hello-world') === text.estimateSpeakMs('helloworld'))
  ok('空文本估 0（叙述锁不上锁的前提）', text.estimateSpeakMs('') === 0 && text.estimateSpeakMs('   ') === 0)
  ok('全角标点算中文单价（！→ 3000 + 260）', text.estimateSpeakMs('！') === 3260, String(text.estimateSpeakMs('！')))
  ok('半角句读按 100ms 计（.→600+100）', text.estimateSpeakMs('.') === 700, String(text.estimateSpeakMs('.')))

  const sample = '今日白饭一碗，hello 1324 😀 你好——还有 don\'t 结束。'
  let mono = true
  let prev = 0
  for (let i = 1; i <= sample.length; i++) {
    const v = text.estimateSpeakMs(sample.slice(0, i))
    if (v < prev) mono = false
    prev = v
  }
  ok('单调性：文本变长估算不会变小（逐个前缀验证）', mono)
  ok('结果有限且不超安全整数', Number.isSafeInteger(text.estimateSpeakMs('啊'.repeat(2000))) && text.estimateSpeakMs('😀'.repeat(100)) < 1e7)
  ok('emoji 本身不计时（文档口径：其余字符不计时）', text.estimateSpeakMs('😀😀😀') === 600, String(text.estimateSpeakMs('😀😀😀')))

  ok('collapseText：换行与全角空格压成单空格', text.collapseText('甲\u3000\u3000乙\n丙') === '甲 乙 丙')
  ok('collapsePoemBody：换行→逗号', text.collapsePoemBody('第一行\r\n第二行\n\n第三行') === '第一行，第二行，第三行')
  ok('collapsePoemBody：抹掉重复标点（。，/，，/，。）', text.collapsePoemBody('甲。，乙，，丙，。丁！，戊') === '甲。乙，丙。丁！戊',
    text.collapsePoemBody('甲。，乙，，丙，。丁！，戊'))

  const parts = (t) => { const p = text.taleParts(t); return [p.title, p.book].join('|') }
  ok('taleParts：书名·标题拆开', parts('聊斋志异·画皮') === '画皮|聊斋志异', parts('聊斋志异·画皮'))
  ok('taleParts：没有分隔符时整句当标题', parts('画皮') === '画皮|')
  ok('taleParts：空书名/空标题都不会留孤零零的点', parts('·画皮') === '画皮|' && parts('聊斋志异·') === '聊斋志异|')
  ok('taleParts：空值不抛错', parts(null) === '|')

  ok('normalizePlain 去标点空白', text.normalizePlain('你好，世界！\n') === '你好世界')
  ok('echoKey：星号动作描写被剥掉', text.echoKey('星号甩甩尾巴星号你好') === '你好')
  ok('stripStageDirections：半角/全角星号都剥', text.stripStageDirections('*甩甩尾巴*你好') === '你好' && text.stripStageDirections('＊甩尾＊你好') === '你好')
  ok('stripStageDirections：未闭合星号也清干净', text.stripStageDirections('*你好') === '你好')
  ok('stripStageDirections：不吞正文', text.stripStageDirections('*笑*真好吃') === '真好吃', text.stripStageDirections('*笑*真好吃'))

  ok('短回声碎片：刚念过时才拦 1~2 字碎片', text.isShortEchoFragment('的歪', true) === true && text.isShortEchoFragment('的歪', false) === false)
  ok('短回声碎片：命令词与常见回应一律放行',
    ['停', '好', '好的', '晚安', '讲吧', '继续'].every((w) => text.isShortEchoFragment(w, true) === false))
  ok('短回声碎片：超过 2 字不拦', text.isShortEchoFragment('停一下', true) === false)

  const deduper = text.createDeduper({ windowMs: 60000 })
  const d1 = deduper.allow('你好')
  const d2 = deduper.allow('你好！')   // 归一后同句
  const d3 = deduper.allow('再见')
  ok('时间窗去重：同句拦一次、不同句放行', d1 === true && d2 === false && d3 === true)
  const nanWin = text.createDeduper({ windowMs: Number.NaN })
  ok('去重器窗口非法值不炸（等价 0 窗口）', nanWin.allow('甲') === true && nanWin.allow('甲') === true)
} catch (e) {
  ok('text.ts 工具函数可验证', false, String((e && e.message) || e))
}

// ======================================================================
console.log('\n[4] util.ts 防御式小工具')
try {
  ok('str：null/undefined → 空串，其余按 String', util.str(null) === '' && util.str(undefined) === '' && util.str(0) === '0' && util.str('x') === 'x')
  const bad = { stopPropagation: () => { throw new Error('x') }, preventDefault: () => { throw new Error('x') } }
  let threw = false
  try { util.evStop(null); util.evStop({}); util.evStop(bad); util.evPrevent(bad); util.clearT(null); util.clearT(0); util.clearI(undefined) } catch (e) { threw = true }
  ok('evStop/evPrevent/clearT/clearI：坏句柄/坏事件一律静默', threw === false)
  ok('clearT 能清掉真定时器', await new Promise((res) => { const t = setTimeout(() => res(false), 30); util.clearT(t); setTimeout(() => res(true), 60) }))
} catch (e) {
  ok('util.ts 可验证', false, String((e && e.message) || e))
}

// ======================================================================
console.log('\n[5] intent.ts 点播意图（误判 / 超长 / 注入式输入）')
try {
  globalThis.__pureTitles = ['静夜思', '雨霖铃', '水调歌头', '锦瑟']
  globalThis.__pureEnsure = 0

  const want = (t) => {
    const r = intent.detectIntent(t)
    return r ? r.kind + (r.sub ? '/' + r.sub : '') + (r.title ? '/' + r.title : '') + (r.book ? '/' + r.book : '') : 'null'
  }
  ok('点播：故事/说书', want('讲故事') === 'story' && want('讲个故事') === 'story' && want('说书') === 'story')
  ok('点播：念诗/背诗', want('背首诗') === 'poem' && want('念首诗') === 'poem' && want('来首诗') === 'poem')
  ok('点播：点诗名（背雨霖铃 / 来首水调歌头 / 念一下静夜思）',
    want('背雨霖铃') === 'poem/雨霖铃' && want('来首水调歌头') === 'poem/水调歌头' && want('念一下静夜思') === 'poem/静夜思', want('念一下静夜思'))
  ok('点播：只报诗名也算（锦瑟）', want('锦瑟') === 'poem/锦瑟')
  ok('点播：典故→chengyu、成语→idiom（与菜单一致）',
    want('讲个典故') === 'culture/chengyu' && want('讲个成语') === 'culture/idiom' && want('今天学个成语') === 'culture/idiom')
  ok('点播：书名别名落到正式书名（三国/水浒/西游/红楼梦）',
    want('三国') === 'story/三国演义' && want('水浒传') === 'story/水浒传' && want('讲个西游记') === 'story/西游记' && want('红楼梦') === 'story/红楼梦')
  ok('点播：书名 + 一个语气词仍算点播（红楼梦吧）', want('红楼梦吧') === 'story/红楼梦', want('红楼梦吧'))

  // 误判：普通陈述不能被书名/诗名劫持（旧实现只比长度，"我在看三国" 会被拉去说书）
  const passToModel = ['我在看三国', '三国好看', '我小时候看过西游记', '红楼梦里林黛玉', '水浒传真好看', '三国演义很好看',
    '梅花开了', '窗外梅花开了', '风雨交加', '落花人独立', '春思故乡', '锦瑟无端五十弦']
  const leaked = passToModel.filter((t) => intent.detectIntent(t) !== null)
  ok('普通陈述不被书名/诗名劫持', leaked.length === 0, leaked.join(' / '))

  // 误判：否定式祈使不是点播（旧实现只认动词，"不要讲故事" 会讲一段）
  const negated = ['不要讲故事', '别讲故事了', '别背诗了', '不用念诗了', '我不想听故事', '甭说书了']
  const negLeak = negated.filter((t) => intent.detectIntent(t) !== null)
  ok('否定式祈使不劫持（不要讲故事 / 别背诗了）', negLeak.length === 0, negLeak.join(' / '))
  ok('否定守卫不误伤正常点播（讲个故事 / 背首诗 / 来段水浒）',
    want('讲个故事') === 'story' && want('背首诗') === 'poem' && want('来段水浒') === 'story/水浒传')

  // 提问/超长/空格 一律交给模型
  ok('提问不劫持（问号/为什么/怎么/吗）',
    ['讲故事吗？', '为什么天是蓝的', '今天天气怎么样', '梅花开了吗？', '来首什么诗'].every((t) => intent.detectIntent(t) === null))
  ok('句末「吗。」带句号也算提问（旧实现只认裸的句尾「吗」）',
    intent.detectIntent('讲个故事吗。') === null && intent.detectIntent('来首诗吗。') === null,
    show(intent.detectIntent('讲个故事吗。')) + ' / ' + show(intent.detectIntent('来首诗吗。')))
  ok('超长句不劫持（>30 字）', intent.detectIntent('讲故事'.repeat(20)) === null && intent.detectIntent('讲故事' + 'x'.repeat(30)) === null)
  ok('字间夹空格的伪指令不劫持（讲 故 事）', intent.detectIntent('讲 故 事') === null)
  ok('不是点播的近似说法照样交给模型（来点故事 / 换个故事）',
    intent.detectIntent('来点故事') === null && intent.detectIntent('换个故事') === null)

  // 注入式输入：正则元字符、超长、控制字符都不许抛错、不许慢
  const hostile = ['(' .repeat(60), '.*'.repeat(40), '$&$1$2', '\\\\'.repeat(40), '{{{[[[', '讲' + '\u0000\u0001', 'a'.repeat(2000), '[a-z]+'.repeat(20)]
  let hostileThrew = ''
  const t0 = Date.now()
  for (let i = 0; i < 300; i++) {
    for (const h of hostile) {
      try { intent.detectIntent(h) } catch (e) { hostileThrew = h + ' → ' + e.message }
    }
  }
  const dt = Date.now() - t0
  ok('注入式输入不抛错', hostileThrew === '', hostileThrew)
  ok('注入式输入不慢（300 轮 × 8 条 < 1 秒）', dt < 1000, dt + 'ms')
  ok('正则元字符原样当普通字符（不劫持）', hostile.every((h) => intent.detectIntent(h) === null))

  // 诗名索引未就绪：泛化意图照常识别，并只按需预热（不 await 网络）
  globalThis.__pureTitles = []
  const beforeEnsure = globalThis.__pureEnsure
  const generic = intent.detectIntent('背首诗')
  ok('标题未就绪时泛化「背首诗」仍识别、且发起预热',
    !!generic && generic.kind === 'poem' && !generic.title && globalThis.__pureEnsure > beforeEnsure)
  const noTitle = intent.detectIntent('背雨霖铃')
  ok('标题未就绪时不认具体诗名（降级为泛化或 null）', noTitle === null || (noTitle.kind === 'poem' && !noTitle.title))

  globalThis.__pureTitles = ['静夜思', '雨霖铃', '水调歌头', '锦瑟']
  const ensureAfterReady = globalThis.__pureEnsure
  ok('标题就绪后不再反复请求', (intent.detectIntent('背雨霖铃'), globalThis.__pureEnsure === ensureAfterReady))
  ok('诗名匹配取句中出现的那一个', intent.matchPoemTitle('来首静夜思吧') === '静夜思' && intent.matchPoemTitle('风雨交加') === '')

  ok('书名别名表被冻结（外部改不动）', Object.isFrozen(intent.BOOK_ALIAS) && intent.BOOK_ALIAS.every((p) => Object.isFrozen(p)))
  let blocked = false
  try { intent.BOOK_ALIAS.push([/x/, 'x']) } catch (e) { blocked = true }
  ok('冻结是真的：push 会抛错', blocked)
} catch (e) {
  ok('intent.ts 可验证', false, String((e && e.message) || e))
}

// ======================================================================
console.log('\n[6] rates.ts 语速解析与存储边界')
try {
  // 还没装存储桩：浏览器禁存储/Node 环境都要能安全回默认值
  ok('没有 localStorage 时全部回默认（禁存储不炸）',
    rates.storyRate() === rates.DEFAULT_STORY_RATE && rates.poemRate() === rates.DEFAULT_POEM_RATE &&
    rates.chatRate() === rates.DEFAULT_CHAT_RATE && rates.narrationRate() === rates.DEFAULT_NARRATION_RATE)
  ok('没有 localStorage 时写接口返回 false', rates.setChatRate('-20%') === false && rates.setNarrationRate('-25%') === false)

  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
    setItem: (k, v) => { store.set(String(k), String(v)) },
    removeItem: (k) => { store.delete(String(k)) },
    clear: () => store.clear(),
  }
  const setAll = (v) => {
    store.clear()
    for (const k of ['chubby-story-rate', 'chubby-poem-rate', 'chubby-chat-rate', 'chubby-narration-rate']) store.set(k, v)
  }

  setAll('-30%')
  ok('合法档位原样读出', rates.storyRate() === '-30%' && rates.poemRate() === '-30%')
  setAll(' -25% ')
  ok('存储里的多余空白会被 trim（读侧容忍脏格式）', rates.poemRate() === '-25%' && rates.storyRate() === '-25%')
  const badValues = ['-0%', '-00%', '-01%', '-100%', '-150%', '+10%', '-25', '-25 %', '-5.5%', 'abc', '', '- 25%']
  const badRead = badValues.filter((v) => { setAll(v); return rates.storyRate() !== rates.DEFAULT_STORY_RATE || rates.poemRate() !== rates.DEFAULT_POEM_RATE })
  ok('非法档位一律回落默认（-0/-00/-01/-100/-150/+10/夹空格/小数/空串）', badRead.length === 0, badRead.join(' / '))
  setAll('-1%')
  ok('边界内最小档 -1% 收下', rates.storyRate() === '-1%')
  setAll('-99%')
  ok('边界内最大档 -99% 收下', rates.storyRate() === '-99%')

  store.clear()
  ok('poemRate 的 fallback 也要过校验：脏 fallback 回默认 -25%', rates.poemRate('胡说') === rates.DEFAULT_POEM_RATE, rates.poemRate('胡说'))
  ok('poemRate 的 fallback 合法时照用（调用方 narrationRate 已校验）', rates.poemRate('-30%') === '-30%')
  ok('poemRate 缺省 fallback = -25%', rates.poemRate() === '-25%')

  store.clear()
  ok('setChatRate 只收菜单档位', rates.setChatRate('-25%') === true && store.get('chubby-chat-rate') === '-25%' && rates.setChatRate('-5%') === false)
  ok('setChatRate 写入前 trim', rates.setChatRate(' -30% ') === true && store.get('chubby-chat-rate') === '-30%')
  ok('setNarrationRate 只收叙述档位', rates.setNarrationRate('-15%') === true && rates.setNarrationRate('-10%') === false)
  ok('chatRate 只认菜单档位（越界值回默认）', (store.set('chubby-chat-rate', '-15%'), rates.chatRate() === rates.DEFAULT_CHAT_RATE))

  // 存储层抛错（隐私模式）：读写都不许炸
  globalThis.localStorage = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() { throw new Error('denied') } }
  ok('localStorage 抛错时读回默认、写返回 false',
    rates.storyRate() === rates.DEFAULT_STORY_RATE && rates.chatRate() === rates.DEFAULT_CHAT_RATE &&
    rates.setChatRate('-20%') === false && rates.setNarrationRate('-25%') === false)

  ok('档位表与默认值被冻结', Object.isFrozen(rates.NARRATION_RATES) && Object.isFrozen(rates.CHAT_RATES))
  let frozenBlocked = false
  try { rates.NARRATION_RATES.push('-5%') } catch (e) { frozenBlocked = true }
  ok('冻结是真的：push 会抛错', frozenBlocked)
} catch (e) {
  ok('rates.ts 可验证', false, String((e && e.message) || e))
}

// ======================================================================
console.log('\n[7] duilian.ts 对联库完整性与抽取边界')
try {
  const coupons = duilian.COUPLETS
  ok('对联库非空且每条四字段齐全',
    coupons.length > 0 && coupons.every((c) => c.upper && c.lower && c.source && c.cat), '共 ' + coupons.length + ' 副')
  ok('上联不重复', new Set(coupons.map((c) => c.upper)).size === coupons.length)
  const cats = Array.from(new Set(coupons.map((c) => c.cat)))
  ok('COUPLET_CATS 覆盖数据里出现的全部分类（防手改漏项）', cats.every((c) => duilian.COUPLET_CATS.indexOf(c) >= 0))
  ok('COUPLET_CATS 没有多余的空分类', duilian.COUPLET_CATS.every((c) => cats.indexOf(c) >= 0))
  ok('库与数据表都冻结', Object.isFrozen(coupons) && Object.isFrozen(coupons[0]) && Object.isFrozen(duilian.COUPLET_CATS))

  // 与 host 侧读的同一份数据源保持一致（文件不在就跳过，不当失败）
  try {
    const raw = readFileSync(join(ROOT, 'data', 'duilian.json'), 'utf8').replace(/^\uFEFF/, '')
    const data = JSON.parse(raw)
    const items = Array.isArray(data) ? data : (data && data.items) || []
    const key = (c) => c.upper + '||' + c.lower
    const lib = new Set(coupons.map(key))
    const src = new Set(items.map(key))
    ok('与 data/duilian.json 完全一致（条数/上下联）',
      items.length === coupons.length && items.every((x) => lib.has(key(x))) && coupons.every((c) => src.has(key(c))),
      '模块 ' + coupons.length + ' / 数据 ' + items.length)
  } catch (e) {
    ok('data/duilian.json 可读（缺文件则跳过）', true, '跳过：' + String((e && e.message) || e).slice(0, 40))
  }

  const origRandom = Math.random
  try {
    Math.random = () => 0
    ok('random=0 取第一条（索引不越界）', show(duilian.pickCouplet()) === show(coupons[0]))
    Math.random = () => 0.9999999
    ok('random→1 取最后一条（不会 undefined）', show(duilian.pickCouplet()) === show(coupons[coupons.length - 1]))

    Math.random = () => 0
    const cat = '春联'
    const inCat = coupons.filter((c) => c.cat === cat)
    const picked = duilian.pickCouplet(null, cat)
    ok('按分类抽取只落在该分类里', picked.cat === cat && inCat.some((c) => c.upper === picked.upper))
    const excluded = duilian.pickCouplet(picked.upper, cat)
    ok('排除上联后不会立刻重复（该分类有多条时）', excluded.upper !== picked.upper)
    ok('未知分类回落到全库（不返回 undefined）', !!duilian.pickCouplet(null, '不存在的分类').upper)
    ok('分类参数两边带空格也能认', duilian.pickCouplet(null, ' 春联 ').cat === '春联', duilian.pickCouplet(null, ' 春联 ').cat)

    // 单条分类：排除自己时池子为空，必须回落到原值而不是 undefined
    const single = coupons.filter((c) => c.cat === '中药')
    if (single.length === 1) {
      const only = duilian.pickCouplet(single[0].upper, '中药')
      ok('单条分类排除自己时回落该条（不崩、不返回空）', only.upper === single[0].upper)
    } else {
      ok('单条分类排除自己时回落该条（不崩、不返回空）', true, '该分类不是单条，跳过')
    }
  } finally {
    Math.random = origRandom
  }
} catch (e) {
  ok('duilian.ts 可验证', false, String((e && e.message) || e))
}

// ======================================================================
console.log('\n[8] narration.ts 叙述锁（0 = 无锁 / 到期界线 / clear 幂等）')
try {
  const lock = narration.createNarrationLock()
  ok('未上锁：active=false、remaining=0、expire=false',
    lock.active() === false && lock.remaining() === 0 && lock.expire() === false)

  lock.lock(0)
  ok('lock(0) 夹到下限 8 秒（不是旧实现的 60 秒白闭麦）',
    lock.active() === true && lock.remaining() > 7000 && lock.remaining() <= narration.NARRATE_MIN_MS + 100, 'remaining=' + lock.remaining())
  lock.lock(narration.NARRATE_MIN_MS - 1000)
  ok('过短的锁夹到下限 8 秒', lock.remaining() > 7000, String(lock.remaining()))
  lock.lock(narration.NARRATE_MAX_MS * 10)
  ok('过长的锁夹到上限 5 分钟', lock.remaining() <= narration.NARRATE_MAX_MS && lock.remaining() > narration.NARRATE_MAX_MS - 1000)
  lock.lock(Number.NaN)
  ok('NaN 按 60 秒兜底（非法值不是无锁）', Math.abs(lock.remaining() - 60000) < 100, String(lock.remaining()))
  lock.lock(Infinity)
  ok('Infinity 夹到上限', lock.remaining() <= narration.NARRATE_MAX_MS && lock.remaining() > narration.NARRATE_MAX_MS - 1000)
  lock.lock(-5000)
  ok('负数夹到下限（保守锁住，不当作无锁）', lock.remaining() > 7000 && lock.remaining() <= narration.NARRATE_MIN_MS + 100)

  lock.clear()
  lock.clear()
  ok('clear 幂等：连清两次不炸、状态是未上锁', lock.active() === false && lock.remaining() === 0)
  lock.clear()
  ok('未上锁时 clear 也不炸', lock.active() === false)

  // 到期界线：由 remaining 反推 until，验证 active 与 expire 用同一条界线
  lock.lock(9000)
  const t0 = Date.now()
  const until = t0 + lock.remaining()
  ok('到期前 1ms 仍在叙述中', lock.active(until - 1) === true)
  ok('到期那一刻 active 已经是 false', lock.active(until) === false)
  ok('到期那一刻 expire 就该清锁（旧实现要等下一轮）', lock.expire(until) === true)
  ok('清锁后 expire 幂等返回 false', lock.expire(until) === false && lock.expire(until + 10000) === false)
  ok('清锁后剩余时间不出现负数', lock.remaining(until + 999999) === 0)
  lock.lock(60000)
  ok('清锁后还能重新上锁', lock.active() === true)
  lock.clear()
} catch (e) {
  ok('narration.ts 可验证', false, String((e && e.message) || e))
}

// ======================================================================
console.log('\n[9] narration-progress.ts 叙述进度（除零 / 越界）')
try {
  const p = progress.createProgress()
  ok('未开始：active=false、index=0、bump 空串', p.active() === false && p.index() === 0 && p.bump('随便一段') === '')
  p.start('念首诗', ['第一句五个字', '第二句也是五个字', '第三句'])
  ok('开始后 index 从 1 起（无开场白）', p.index() === 1, String(p.index()))
  const b1 = p.bump('第一句五个字')
  ok('第 1 段气泡带进度', b1 === '念首诗（第 1/3 句）：第一句五个字', b1)
  ok('第 2 段气泡带进度', p.bump('第二句也是五个字') === '念首诗（第 2/3 句）：第二句也是五个字')
  ok('第 3 段气泡带进度', p.bump('第三句') === '念首诗（第 3/3 句）：第三句')
  ok('念完之后 index 不超过总句数（越界夹紧）', p.index() === 3, String(p.index()))
  ok('多出来的段仍按最后一句显示（不越界、不 NaN）', p.bump('多余的一段') === '念首诗（第 3/3 句）：多余的一段')
  p.stop()
  ok('stop 复位：此后不 active、bump 空串', p.active() === false && p.index() === 0 && p.bump('x') === '')

  // 空正文：cum 为空数组，index 必须走 0 而不是 NaN/Infinity（无除法，但要确认夹紧）
  const e1 = progress.createProgress()
  e1.start('标签', [])
  ok('空正文：index=0、气泡只有标签', e1.index() === 0 && e1.bump('开场白') === '标签：开场白')
  const e2 = progress.createProgress()
  e2.start('标签', ['   ', '', null])
  ok('全空白正文按空处理', e2.index() === 0 && e2.bump('甲') === '标签：甲')
  const e3 = progress.createProgress()
  e3.start('', ['甲', '乙'])
  ok('空 label 不产出 undefined/null 字样', e3.bump('甲').indexOf('undefined') < 0 && e3.bump('乙').indexOf('null') < 0)

  // 开场白：念开场白时 index 还是 0，念到正文第一句才是 1
  const q = progress.createProgress()
  q.start('念诗·雨霖铃', ['寒蝉凄切', '对长亭晚'], '念首诗——雨霖铃，宋，柳永。')
  const introBubble = q.bump('念首诗——雨霖铃，宋，柳永。')
  ok('开场白期间不算第 1 句', q.index() === 1 && introBubble === '念诗·雨霖铃：念首诗——雨霖铃，宋，柳永。', introBubble)
  ok('开场白之后正文照常推进', q.bump('寒蝉凄切') === '念诗·雨霖铃（第 1/2 句）：寒蝉凄切')

  // 两个实例互不干扰（默认实例之外要能独立跑）
  const a = progress.createProgress()
  const b = progress.createProgress()
  a.start('A', ['甲甲'])
  b.start('B', ['乙乙', '丙丙'])
  a.bump('甲甲')
  ok('多实例状态互不串味', a.index() === 1 && b.index() === 1 && b.bump('乙乙').indexOf('B（第 1/2 句）') === 0)
} catch (e) {
  ok('narration-progress.ts 可验证', false, String((e && e.message) || e))
}

// ======================================================================
console.log('\n[10] look.ts 成长档位映射边界')
try {
  const tier = (e) => look.tierOf(e)
  ok('边界：199 初识 / 200 熟络 / 799 熟络 / 800 黏人',
    tier(199) === 0 && tier(200) === 1 && tier(799) === 1 && tier(800) === 2)
  ok('边界前一位小数不越档', tier(199.999) === 0 && tier(799.999) === 1)
  ok('负数与 0 都是初识', tier(-1) === 0 && tier(0) === 0 && tier(-0) === 0)
  ok('NaN 按 0 处理', tier(Number.NaN) === 0)
  ok('+Infinity 落最高档（保单调，不许回落）', tier(Infinity) === 2, String(tier(Infinity)))
  ok('-Infinity 落初识', tier(-Infinity) === 0)
  ok('超大经验不越界', tier(1e15) === 2)
  ok('外观档位名与 TIER_NAMES 一致', look.TIER_NAMES.every((n, i) => look.lookFor(look.TIER_EXP[i]).label === n))
  ok('外观阈值与 shared/growth 的前两档边界对齐',
    look.TIER_EXP[0] === growth.GROWTH_STAGES[0].exp && look.TIER_EXP[1] === growth.GROWTH_STAGES[1].exp && look.TIER_EXP[2] === growth.GROWTH_STAGES[2].exp)
  ok('lookFor 返回的元素是冻结的（UI 改不动内部表）', Object.isFrozen(look.lookFor(0)) && Object.isFrozen(look.lookFor(800)))
  ok('DEFAULT_GROWTH 冻结且与初识档一致', Object.isFrozen(look.DEFAULT_GROWTH) && look.DEFAULT_GROWTH.exp === 0 && look.DEFAULT_GROWTH.tier === 0)

  ok('lookForGrowth：null/undefined/坏 exp 一律回落初识',
    look.lookForGrowth(null).tier === 0 && look.lookForGrowth(undefined).tier === 0 &&
    look.lookForGrowth({ exp: Number.NaN, stage: '', nextExp: 0, tier: 0 }).tier === 0)
  ok('lookForGrowth：正常值走档位', look.lookForGrowth({ exp: 800, stage: '亲密', nextExp: 2500, tier: 2 }).tier === 2)

  const g1 = look.parseGrowth({ ok: true, exp: 350, stage: '熟悉', nextExp: 800, tier: 99 })
  ok('parseGrowth：只认服务端 exp，不采信外部 tier', g1 && g1.exp === 350 && g1.tier === 1 && g1.nextExp === 800, show(g1))
  const g2 = look.parseGrowth({ ok: true, exp: 350 })
  ok('parseGrowth：缺 stage/nextExp 时按 host 同源规则补（熟悉/800）', g2 && g2.stage === '熟悉' && g2.nextExp === 800, show(g2))
  ok('parseGrowth：负数经验夹到 0', (() => { const g = look.parseGrowth({ ok: true, exp: -5 }); return g && g.exp === 0 && g.tier === 0 })())
  ok('parseGrowth：ok 不为 true / exp 非数 / 空值一律 null',
    look.parseGrowth({ ok: false, exp: 350 }) === null && look.parseGrowth({ ok: true, exp: 'abc' }) === null &&
    look.parseGrowth({ ok: true }) === null && look.parseGrowth(null) === null && look.parseGrowth('x') === null && look.parseGrowth([]) === null)
  ok('parseGrowth：nextExp 非法时回落 host 值', (() => { const g = look.parseGrowth({ ok: true, exp: 350, nextExp: -3 }); return g && g.nextExp === 800 })())

  const fetched = await look.fetchGrowth(async () => ({ ok: true, exp: 900 }))
  ok('fetchGrowth：正常回包解析为最高档', fetched && fetched.tier === 2 && fetched.exp === 900, show(fetched))
  ok('fetchGrowth：网络抛错 → null（绝不向上抛）', (await look.fetchGrowth(async () => { throw new Error('boom') })) === null)
  ok('fetchGrowth：同步抛错也 → null', (await look.fetchGrowth(() => { throw new Error('boom') })) === null)
  ok('fetchGrowth：回包非法 → null', (await look.fetchGrowth(async () => ({ ok: false }))) === null)
} catch (e) {
  ok('look.ts 可验证', false, String((e && e.message) || e))
}

// ---------- 汇总 ----------
try { rmSync(TMP, { recursive: true, force: true }) } catch (e) { }
console.log('\n  通过 ' + pass + ' 项 / 失败 ' + fail + ' 项')
if (fail > 0) {
  console.error('\n  ❌ 纯函数工具层体检失败')
  process.exit(1)
}
console.log('\n  ✅ 纯函数工具层体检通过')
