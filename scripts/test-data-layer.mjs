/**
 * scripts/test-data-layer.mjs —— 数据层（src/host/data/*.ts）永久回归
 *
 * 背景（2026-11-06 数据层审计）：
 *   ① 本地数据源只有「缓存命中」分支拷贝，首次读（写缓存那条路径）把缓存数组本体递给了调用方；
 *   ② 本地读盘失败不分「确定性」和「瞬时」：一次 EISDIR/EACCES/EBUSY 就会把该类数据在
 *      进程存活期内永久缓存成空（文件 mtime 不变就再也不重读）；
 *   ③ 云端把「数据缺失」（清单里没这个文件 / 规范化后为空）当成链路故障，同样进 60 秒
 *      全局冷却并刷 CLOUD-DATA-FAIL：一本云端缺书会让诗词、文化、每日一起降级到本地；
 *   ④ normalize 的文化条目直接把入参对象塞进返回值——云端缓存的是文件原始 parse 结果，
 *      等于把云端缓存本体交给路由（坑 27）；
 *   ⑤ data/*.ts 深引用说书实现 host/story/repo.ts，而 ports.ts 已经定义了 StoryChunk。
 *
 * 本脚本按源码真实语义逐条断言（纯离线：不联网、不起 HTTP、不碰 dist）。
 * 用法：node scripts/test-data-layer.mjs   # 失败退出码 1
 */
import { register } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, utimesSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
register(new URL('./ts-resolve.mjs', import.meta.url))

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.error('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

const tmpDirs = []
function mkTmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}

/** 静默执行一段预期会打日志的代码，并收集日志（避免把「预期失败」刷进测试输出） */
async function capture(fn) {
  const out = []
  const realError = console.error
  const realWarn = console.warn
  const realLog = console.log
  console.error = (...a) => out.push(a.join(' '))
  console.warn = (...a) => out.push(a.join(' '))
  console.log = (...a) => out.push(a.join(' '))
  try {
    const value = await fn()
    return { value, logs: out }
  } finally {
    console.error = realError
    console.warn = realWarn
    console.log = realLog
  }
}

const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href)

// ---------------------------------------------------------------------------
// A. 本地数据源：缓存所有权（端口交出去的必须是拷贝，不是缓存本体）
// ---------------------------------------------------------------------------
console.log('\n[A] 本地数据源：缓存所有权（坑 27）')
try {
  const { createLocalDataPort } = await imp('src/host/data/local.ts')
  const dir = mkTmp('whale-data-owner-')
  mkdirSync(join(dir, 'culture'), { recursive: true })
  writeFileSync(join(dir, 'culture', 'chengyu.json'), JSON.stringify([{ name: '一鼓作气', src: '左传', text: '振作士气' }]))
  writeFileSync(join(dir, 'poems.json'), JSON.stringify({ poems: [{ title: '静夜思', author: '李白', dynasty: '唐', lines: ['床前明月光'] }] }))
  writeFileSync(join(dir, 'duilian.json'), JSON.stringify({ items: [{ upper: '风声雨声读书声', lower: '家事国事天下事', cat: '劝学' }] }))
  writeFileSync(join(dir, 'daily.json'), JSON.stringify({ items: [{ date: '2026-11-06', text: '每日一句' }] }))
  const port = createLocalDataPort({ dataDir: dir, story: { listBooks: async () => [], loadBook: async () => [] } })

  const c1 = await port.readCulture('chengyu')
  const c2 = await port.readCulture('chengyu')
  ok('本地文化：首次读与缓存命中都返回新数组', c1 !== c2)
  ok('本地文化：条目也是拷贝（不是缓存本体）', c1[0] !== c2[0])
  c1.push({ name: '注入' })
  c1[0].name = '被改过'
  const c3 = await port.readCulture('chengyu')
  ok('本地文化：push/改字段都碰不到缓存', c3.length === 1 && c3[0].name === '一鼓作气', JSON.stringify(c3[0]))

  const p1 = await port.readPoemsChunk(0)
  const p2 = await port.readPoemsChunk(0)
  ok('本地诗歌：两次读返回不同数组与不同条目', p1.items !== p2.items && p1.items[0] !== p2.items[0])
  p1.items[0].title = '被改过'
  p1.items.push({ title: '注入' })
  const p3 = await port.readPoemsChunk(0)
  ok('本地诗歌：改返回值不影响下一次读', p3.items.length === 1 && p3.items[0].title === '静夜思')

  const d1 = await port.readDaily()
  const d2 = await port.readDaily()
  ok('本地每日：首次读与命中都返回新数组', d1 !== d2 && d1[0] !== d2[0])
  d1[0].text = '被改过'
  const d3 = await port.readDaily()
  ok('本地每日：改返回值不影响下一次读', d3[0].text === '每日一句')

  const u1 = await port.readDuilian()
  const u2 = await port.readDuilian()
  ok('本对联：items/cats/条目都不是缓存本体', u1.items !== u2.items && u1.cats !== u2.cats && u1.items[0] !== u2.items[0])
  u1.items[0].upper = '被改过'
  u1.items.push({ upper: '注入', lower: '', cat: '' })
  u1.cats['劝学'].push({ upper: '注入', lower: '', cat: '劝学' })
  const u3 = await port.readDuilian()
  ok('本地对联：改 items/cats 都碰不到缓存',
    u3.items.length === 1 && u3.items[0].upper === '风声雨声读书声' && u3.cats['劝学'].length === 1,
    'items=' + u3.items.length + ' cats[劝学]=' + u3.cats['劝学'].length)
} catch (e) {
  ok('A 组可执行', false, String(e && e.message))
}

// ---------------------------------------------------------------------------
// B. 本地数据源：确定性失败 vs 瞬时失败（别把一次占用缓存成永久空）
// ---------------------------------------------------------------------------
console.log('\n[B] 本地数据源：失败分类与缓存污染')
try {
  const { createLocalDataPort } = await imp('src/host/data/local.ts')
  const dir = mkTmp('whale-data-fail-')
  mkdirSync(join(dir, 'culture'), { recursive: true })
  const port = createLocalDataPort({ dataDir: dir, story: { listBooks: async () => [], loadBook: async () => [] } })

  // 瞬时读错误：把文件名占成目录 → readFile 抛 EISDIR（mt>0，最容易触发「缓存成空」）
  mkdirSync(join(dir, 'culture', 'minsu.json'))
  const stamp = new Date(1700000000000)          // 整秒，utimes 后 mtimeMs 完全相同
  utimesSync(join(dir, 'culture', 'minsu.json'), stamp, stamp)
  const bad = await capture(() => port.readCulture('minsu'))
  ok('瞬时读错误 → 空数组且留痕', bad.value.length === 0 && bad.logs.some((s) => s.includes('CULTURE-LOAD-FAIL')))
  // 修好文件但把 mtime 设成同一个值：缓存若被污染，这里永远读不到
  rmSync(join(dir, 'culture', 'minsu.json'), { recursive: true, force: true })
  writeFileSync(join(dir, 'culture', 'minsu.json'), JSON.stringify([{ book: '广东新语', title: '夫溪', text: '正文' }]))
  utimesSync(join(dir, 'culture', 'minsu.json'), stamp, stamp)
  ok('瞬时失败前后 mtime 相同（构造有效）', statSync(join(dir, 'culture', 'minsu.json')).mtimeMs === 1700000000000)
  const fixed = await port.readCulture('minsu')
  ok('瞬时失败不写缓存：mtime 不变也能立刻恢复', fixed.length === 1 && fixed[0].title === '夫溪', 'items=' + fixed.length)

  // 确定性失败：坏 JSON 可以记空缓存（否则每次请求都重读重刷日志）
  const badDir = mkTmp('whale-data-badjson-')
  mkdirSync(join(badDir, 'culture'), { recursive: true })
  writeFileSync(join(badDir, 'culture', 'chengyu.json'), 'not-json')
  const badPort = createLocalDataPort({ dataDir: badDir, story: { listBooks: async () => [], loadBook: async () => [] } })
  const seq = await capture(async () => [await badPort.readCulture('chengyu'), await badPort.readCulture('chengyu')])
  const badLogs = seq.logs.filter((s) => s.includes('CULTURE-LOAD-FAIL'))
  ok('坏 JSON → 空数组', seq.value[0].length === 0 && seq.value[1].length === 0)
  ok('坏 JSON 是确定性失败 → 只记一次日志（进缓存）', badLogs.length === 1, '日志 ' + badLogs.length + ' 条')

  // 缺文件：空 + 不刷日志（首次运行正常态）
  const emptyDir = mkTmp('whale-data-empty-')
  const emptyPort = createLocalDataPort({ dataDir: emptyDir, story: { listBooks: async () => [], loadBook: async () => [] } })
  const missing = await capture(async () => ({
    daily: await emptyPort.readDaily(),
    culture: await emptyPort.readCulture('chengyu'),
    poems: await emptyPort.readPoemsChunk(0),
    duilian: await emptyPort.readDuilian(),
  }))
  ok('缺文件：四个读口都返回空且不抛',
    missing.value.daily.length === 0 && missing.value.culture.length === 0
    && missing.value.poems.items.length === 0 && missing.value.duilian.items.length === 0)
  ok('缺文件：不刷失败日志', missing.logs.filter((s) => /LOAD-FAIL/.test(s)).length === 0, JSON.stringify(missing.logs))
} catch (e) {
  ok('B 组可执行', false, String(e && e.message))
}

// ---------------------------------------------------------------------------
// C. 本地数据源：BOM / 结构兜底 / mtime 失效
// ---------------------------------------------------------------------------
console.log('\n[C] 本地数据源：BOM、结构兜底、mtime 失效')
try {
  const { createLocalDataPort } = await imp('src/host/data/local.ts')
  const dir = mkTmp('whale-data-bom-')
  mkdirSync(join(dir, 'culture'), { recursive: true })
  // Windows 工具（PS 5.1 的 -Encoding UTF8）会写 BOM：整类数据不能因此失效
  writeFileSync(join(dir, 'culture', 'idioms.json'), '\uFEFF' + JSON.stringify({ items: [{ name: '七月流火', mean: '天气转凉' }] }))
  writeFileSync(join(dir, 'poems.json'), JSON.stringify({ poems: [{ title: '旧诗', author: '某', lines: ['旧句'] }] }))
  const port = createLocalDataPort({ dataDir: dir, story: { listBooks: async () => [], loadBook: async () => [] } })
  const id = await port.readCulture('idiom')
  ok('带 BOM 的 JSON 能读（{items} 结构）', id.length === 1 && id[0].name === '七月流火')
  ok('结构里没有 name 的条目被丢掉', (await port.readCulture('chengyu')).length === 0)

  const before = await port.readPoemsChunk(0)
  writeFileSync(join(dir, 'poems.json'), JSON.stringify({ poems: [{ title: '新诗', author: '某', lines: ['新句'] }] }))
  const future = new Date(Date.now() + 5000)
  utimesSync(join(dir, 'poems.json'), future, future)
  const after = await port.readPoemsChunk(0)
  ok('改数据后按 mtime 重新读（无需重启）', before.items[0].title === '旧诗' && after.items[0].title === '新诗')
} catch (e) {
  ok('C 组可执行', false, String(e && e.message))
}

// ---------------------------------------------------------------------------
// D. 云端：并发单飞 / 失败不缓存 / 冷却
// ---------------------------------------------------------------------------
/** 造一个假的 fetch：files 是「路径 → 数据」，missing 返回 404，throwOn 命中则抛网络错误 */
function mkFetch(files, opts = {}) {
  const calls = []
  const impl = async (url) => {
    const path = decodeURIComponent(String(url).split('/v1/')[1] || '')
    calls.push(path)
    if (opts.throwOn === path) throw new Error('network down')
    if (opts.failOn === path) return { ok: false, status: 503, text: async () => '' }
    const data = files[path]
    if (data === undefined) return { ok: false, status: 404, text: async () => '' }
    return { ok: true, status: 200, text: async () => JSON.stringify(data) }
  }
  return { impl, calls }
}
const mkLocal = (marker) => {
  const stats = { index: 0, book: 0, culture: 0, poem: 0, duilian: 0, daily: 0 }
  return {
    stats,
    readStoryIndex: async () => { stats.index++; return [{ book: '本地书' }] },
    readStoryBook: async () => { stats.book++; return [{ book: '本地书', title: '本地段', piece: 1, total: 1, text: marker, index: 0 }] },
    readCulture: async () => { stats.culture++; return [{ name: '本地成语' }] },
    readPoemsChunk: async (i) => { stats.poem++; return { index: i, total: 1, items: [{ title: '本地诗', author: '某', lines: ['本地句'] }] } },
    readDuilian: async () => { stats.duilian++; return { total: 0, items: [], cats: {} } },
    readDaily: async () => { stats.daily++; return [{ date: 'local', text: marker }] },
  }
}

console.log('\n[D] 云端：单飞 / 失败不缓存 / 冷却')
try {
  const { createCloudDataPort } = await imp('src/host/data/cloud.ts')
  const manifest = { version: 'v1', generatedAt: 'g1', files: [{ path: 'daily.json' }] }
  const files = { 'manifest.json': manifest, 'daily.json': [{ date: '2026-11-06', text: '云端每日' }] }

  // D1 同一 key 并发只拉一次；成功进缓存
  {
    const { impl, calls } = mkFetch(files)
    const local = mkLocal('local')
    const port = createCloudDataPort({ local, fetchImpl: impl })
    const [a, b] = await Promise.all([port.readDaily(), port.readDaily()])
    ok('并发同 key 只拉一次 manifest', calls.filter((c) => c === 'manifest.json').length === 1)
    ok('并发同 key 只拉一次数据文件', calls.filter((c) => c === 'daily.json').length === 1)
    ok('并发两个调用都拿到云端数据', a[0].text === '云端每日' && b[0].text === '云端每日')
    await port.readDaily()
    ok('成功结果进缓存（再读不再打网络）', calls.filter((c) => c === 'daily.json').length === 1 && local.stats.daily === 0)
  }

  // D2 失败：不写缓存、清 inflight、冷却后恢复
  {
    let offset = 0
    const realNow = Date.now
    Date.now = () => realNow() + offset
    const { impl, calls } = mkFetch(files, { throwOn: 'daily.json' })
    const local = mkLocal('local')
    const port = createCloudDataPort({ local, fetchImpl: impl })
    try {
      const first = await capture(() => port.readDaily())
      ok('网络失败 → 回退本地且记一次 CLOUD-DATA-FAIL',
        first.value[0].text === 'local' && first.logs.some((s) => s.includes('CLOUD-DATA-FAIL')))
      const before = calls.filter((c) => c === 'daily.json').length
      await port.readDaily()
      ok('冷却期内不再打网络', calls.filter((c) => c === 'daily.json').length === before)
      offset = 61000
      const later = await capture(() => port.readDaily())
      ok('冷却过后重新拉，且失败结果没被缓存', later.value[0].text === 'local' && calls.filter((c) => c === 'daily.json').length === before + 1)
    } finally {
      Date.now = realNow
    }
  }
} catch (e) {
  ok('D 组可执行', false, String(e && e.message))
}

// ---------------------------------------------------------------------------
// E. 云端：数据缺失 ≠ 链路故障（不能连累其它读口一起降级）
// ---------------------------------------------------------------------------
console.log('\n[E] 云端：数据缺失不触发全局冷却')
try {
  const { createCloudDataPort } = await imp('src/host/data/cloud.ts')
  const files = {
    'manifest.json': {
      version: 'v1', generatedAt: 'g1',
      // 注意：故意不列 story/index.json 与任何书
      files: [{ path: 'poems/poems-00.json' }, { path: 'culture/chengyu.json' }, { path: 'daily.json' }],
    },
    'poems/poems-00.json': { index: 0, total: 1, items: [{ title: '静夜思', author: '李白', lines: ['床前明月光'] }] },
    'culture/chengyu.json': { items: [{ name: '一鼓作气', text: '振作' }] },
    'daily.json': { items: [{ date: '2026-11-06', text: '云端每日' }] },
  }
  const { impl, calls } = mkFetch(files)
  const local = mkLocal('local')
  const port = createCloudDataPort({ local, fetchImpl: impl })

  const miss = await capture(() => port.readStoryIndex())
  ok('清单里没有的书单 → 回退本地', miss.value[0].book === '本地书' && local.stats.index === 1)
  ok('数据缺失只留一条 warn（不是 CLOUD-DATA-FAIL）',
    miss.logs.filter((s) => s.includes('cloud data unavailable')).length === 1
    && miss.logs.filter((s) => s.includes('CLOUD-DATA-FAIL')).length === 0, JSON.stringify(miss.logs))

  const bookMiss = await capture(async () => { await port.readStoryBook('缺书'); await port.readStoryBook('缺书') })
  ok('同一 op 的数据缺失只 warn 一次', bookMiss.logs.filter((s) => s.includes('cloud data unavailable')).length === 1)

  // 关键断言：一次数据缺失之后，诗词/文化/每日仍走云端（不被 60 秒冷却拖走）
  const before = calls.length
  const poem = await port.readPoemsChunk(0)
  const cul = await port.readCulture('chengyu')
  const daily = await port.readDaily()
  ok('数据缺失后诗词仍走云端', poem.items[0] && poem.items[0].title === '静夜思' && local.stats.poem === 0)
  ok('数据缺失后文化仍走云端', cul[0] && cul[0].name === '一鼓作气' && local.stats.culture === 0)
  ok('数据缺失后每日仍走云端', daily[0] && daily[0].text === '云端每日' && local.stats.daily === 0)
  ok('三次云端读口都真实打了网络', calls.length > before, '新增请求 ' + (calls.length - before))

  // 反过来：真链路故障仍然要进冷却（原有语义不能丢）
  const bad = mkFetch(files, { throwOn: 'daily.json' })
  const local2 = mkLocal('local2')
  const port2 = createCloudDataPort({ local: local2, fetchImpl: bad.impl })
  const f1 = await capture(() => port2.readDaily())
  const f2 = await capture(() => port2.readDaily())
  const netCalls = bad.calls.filter((c) => c === 'daily.json').length
  ok('链路故障仍然进冷却（第二次不再打网络）', f1.value[0].text === 'local2' && f2.value[0].text === 'local2' && netCalls === 1, '网络请求 ' + netCalls + ' 次')
} catch (e) {
  ok('E 组可执行', false, String(e && e.message))
}

// ---------------------------------------------------------------------------
// F. 云端：清单换代清缓存 / 版本没变继续用缓存 / 古籍 LRU 上限
// ---------------------------------------------------------------------------
console.log('\n[F] 云端：清单换代与缓存上限')
try {
  const { createCloudDataPort } = await imp('src/host/data/cloud.ts')
  const mkManifest = (version, gen) => ({ version, generatedAt: gen, files: [
    { path: 'daily.json' },
    { path: 'story/甲.json' }, { path: 'story/乙.json' }, { path: 'story/丙.json' },
  ] })
  const files = {
    'manifest.json': mkManifest('v1', 'g1'),
    'daily.json': [{ date: '2026-11-06', text: 'v1 每日' }],
    'story/甲.json': [{ book: '甲', title: '一', total: 1, text: '甲之一' }],
    'story/乙.json': [{ book: '乙', title: '一', total: 1, text: '乙之一' }],
    'story/丙.json': [{ book: '丙', title: '一', total: 1, text: '丙之一' }],
  }
  let offset = 0
  const realNow = Date.now
  Date.now = () => realNow() + offset
  const { impl, calls } = mkFetch(files)
  const local = mkLocal('local')
  const port = createCloudDataPort({ local, fetchImpl: impl })
  try {
    await port.readDaily()
    offset = 31000
    // 版本没变：清单重拉，但数据继续用缓存
    await port.readDaily()
    ok('清单版本没变 → 数据缓存继续用（不重下）', calls.filter((c) => c === 'daily.json').length === 1, 'daily 请求 ' + calls.filter((c) => c === 'daily.json').length + ' 次')
    ok('超过 30 秒 TTL 会重拉清单', calls.filter((c) => c === 'manifest.json').length >= 2)

    // 版本变了：清数据缓存，按新清单重拉
    files['manifest.json'] = mkManifest('v2', 'g2')
    files['daily.json'] = [{ date: '2026-11-06', text: 'v2 每日' }]
    offset = 62000
    const fresh = await port.readDaily()
    ok('清单换代 → 清缓存并重拉', fresh[0].text === 'v2 每日' && calls.filter((c) => c === 'daily.json').length === 2)

    // 古籍 LRU：最多留 2 本，第 3 本进来后最早的被丢
    await port.readStoryBook('甲')
    await port.readStoryBook('乙')
    await port.readStoryBook('丙')
    const beforeJia = calls.filter((c) => c === 'story/甲.json').length
    await port.readStoryBook('甲')
    ok('古籍缓存上限 2 本：第 3 本进来后最早的重新下载',
      beforeJia === 1 && calls.filter((c) => c === 'story/甲.json').length === 2,
      '甲 下载 ' + calls.filter((c) => c === 'story/甲.json').length + ' 次')
    const beforeYi = calls.filter((c) => c === 'story/乙.json').length
    await port.readStoryBook('乙')
    ok('仍是 2 本上限：乙 已被丢（重下）', beforeYi === 1 && calls.filter((c) => c === 'story/乙.json').length === 2)
  } finally {
    Date.now = realNow
  }
} catch (e) {
  ok('F 组可执行', false, String(e && e.message))
}

// ---------------------------------------------------------------------------
// G. normalize：去重、字段清洗、返回值不共享入参
// ---------------------------------------------------------------------------
console.log('\n[G] normalize：去重与字段清洗')
try {
  const { normalizePoemItems, normalizeCultureItems, normalizeDuilian, normalizeDaily, normalizeStoryChunks } = await imp('src/host/data/normalize.ts')
  const { poemKeyOf } = await imp('src/shared/poem.ts')
  const normalizeMod = await imp('src/host/data/normalize.ts')
  ok('normalize 再导出的 poemKeyOf 与 shared/poem.ts 同一口径', normalizeMod.poemKeyOf === poemKeyOf)

  // 诗：标题/句子为空丢弃；同题同作者不同首句并存；同键去重保留第一条
  const poemRaw = [
    { title: '静夜思', author: '李白', dynasty: '唐', lines: ['床前明月光', ' ', '疑是地上霜'], sources: 'x' },
    { title: '静夜思', author: '李白', lines: ['床前明月光'] },                       // 同键 → 丢
    { title: '蝶恋花', author: '欧阳修', lines: ['庭院深深深几许'] },
    { title: '蝶恋花', author: '欧阳修', lines: ['谁道闲情抛弃久'] },                 // 同题不同首句 → 留
    { title: '', lines: ['垃圾'] },
    { title: '无句子', lines: [] },
    'not-an-object',
  ]
  const poems = normalizePoemItems(poemRaw)
  ok('诗：空标题/空句子/非对象被丢弃', poems.length === 3, 'items=' + poems.length)
  ok('诗：同题不同首句不当重复',
    poems.filter((p) => p.title === '蝶恋花').length === 2)
  ok('诗：同键重复只留第一条', poems[0].lines.length === 2)
  ok('诗：行内首尾空白被清掉', poems[0].lines[1] === '疑是地上霜')
  ok('诗：只留路由用到的字段', !('sources' in poems[0]) && poems[0].dynasty === '唐')
  ok('诗：返回的是新对象', poems[0] !== poemRaw[0])

  // 文化：按 kind 取键；保留第一条；空键丢弃；条目是拷贝
  const cyRaw = [{ name: '一鼓作气', text: 'A' }, { name: '一鼓作气', text: 'B' }, { name: '', text: 'C' }]
  const cy = normalizeCultureItems('chengyu', cyRaw)
  ok('文化：名称去重保留第一条', cy.length === 1 && cy[0].text === 'A')
  ok('文化：空键丢弃', normalizeCultureItems('chengyu', [{ text: '无名字' }]).length === 0)
  ok('文化：返回条目是拷贝（云端 parse 缓存不外泄）', cy[0] !== cyRaw[0])
  const ms = normalizeCultureItems('minsu', [
    { book: '广东新语', title: '夫溪', text: 'A' },
    { book: '广东新语', title: '夫溪', text: 'B' },
    { book: '广东新语', title: '夫号', text: 'C' },
  ])
  ok('民间故事：按「书名|标题」去重（同书不同篇保留）', ms.length === 2 && ms[1].title === '夫号')

  // 对联：云端 {cats} 拍平 + 分类桶；本地 {items}；按上下联去重；note 透传
  const dui = normalizeDuilian({ total: 9, note: '公版', cats: {
    '劝学': [{ upper: '风声雨声', lower: '家事国事' }, { upper: '风声雨声', lower: '家事国事' }],
    '山水': [{ upper: '水', lower: '山' }],
  } })
  ok('对联：cats 拍平成 items 且去重', dui.items.length === 2 && dui.total === 9)
  ok('对联：分类桶按 cat 归位', dui.cats['劝学'].length === 1 && dui.cats['山水'].length === 1)
  ok('对联：note 透传', dui.note === '公版')
  const duiLocal = normalizeDuilian({ items: [{ upper: '上', lower: '下', cat: '甲' }, { upper: '上', lower: '下' }] })
  ok('对联：本地 items 结构 + 上下联去重 + cat 保留', duiLocal.items.length === 1 && duiLocal.items[0].cat === '甲')
  ok('对联：total 缺省取 items 长度', duiLocal.total === 1)
  ok('对联：数组入参也认', normalizeDuilian([{ upper: 'a', lower: 'b' }]).items.length === 1)

  // 每日：缺 date/text 丢弃；{items} 与数组都认
  const daily = normalizeDaily({ items: [
    { date: '2026-11-06', text: '甲', type: 'poem', source: '某' },
    { date: '2026-11-06', text: '' },
    { date: '', text: '乙' },
  ] })
  ok('每日：缺 date/text 的条目被丢弃', daily.length === 1 && daily[0].source === '某')
  ok('每日：数组入参也认', normalizeDaily([{ date: '2026-11-06', text: '丙' }]).length === 1)

  // 说书：非数组 → 空；空正文丢弃；index 是原数组序号（进度键）；返回新对象
  const storyRaw = [{ title: '一', text: '正文一' }, { title: '二', text: '   ' }, { title: '三', text: '正文三' }]
  const chunks = normalizeStoryChunks('某书', storyRaw)
  ok('说书：非数组返回空', normalizeStoryChunks('某书', { chunks: [] }).length === 0)
  ok('说书：空正文丢弃', chunks.length === 2)
  ok('说书：index 用原数组序号（不是过滤后的下标）', chunks[0].index === 0 && chunks[1].index === 2)
  ok('说书：缺 book 时回落到传入书名', chunks[0].book === '某书' && chunks[0].piece === 1 && chunks[0].total === 1)
  ok('说书：返回的是新对象', chunks[0] !== storyRaw[0])
} catch (e) {
  ok('G 组可执行', false, String(e && e.message))
}

// ---------------------------------------------------------------------------
// H. story-source：书单清洗 / 段内书名投影 / 异常兜底
// ---------------------------------------------------------------------------
console.log('\n[H] story-source：选源与书名清洗')
try {
  const { createStorySource } = await imp('src/host/data/story-source.ts')
  const calls = []
  const chunks = [
    { book: '喻世明言', title: '一', piece: 1, total: 3, text: '甲', index: 0 },
    { book: '警世通言', title: '二', piece: 2, total: 3, text: '乙', index: 1 },
  ]
  const port = {
    readStoryIndex: async () => [
      { book: ' 三言二拍 ' }, { book: '三言二拍' }, { book: '' }, { book: '../逃逸' },
      { book: 'a/b' }, { book: 'x'.repeat(65) }, { book: '红楼梦' },
    ],
    readStoryBook: async (book) => { calls.push(book); return chunks },
  }
  const src = createStorySource(port)
  const books = await src.listBooks()
  ok('书单：trim + 去重 + 挡路径字符/超长', books.length === 2 && books[0] === '三言二拍' && books[1] === '红楼梦', JSON.stringify(books))

  const got = await src.loadBook('三言二拍')
  ok('正文：段内书名投影成书单名', got.length === 2 && got.every((c) => c.book === '三言二拍'))
  ok('正文：不改 DataPort 返回的段对象（缓存不被污染）', chunks[0].book === '喻世明言')
  ok('正文：返回新数组', got !== chunks)

  const before = calls.length
  const rejected = await capture(() => src.loadBook('../逃逸'))
  ok('正文：非法书名直接回空且不落到 DataPort', rejected.value.length === 0 && calls.length === before)
  ok('正文：非法书名留痕', rejected.logs.some((s) => s.includes('STORY-LOAD-FAIL')))

  const badPort = createStorySource({
    readStoryIndex: async () => { throw new Error('boom') },
    readStoryBook: async () => { throw new Error('boom') },
  })
  const boom = await capture(async () => ({
    index: await badPort.listBooks(),
    book: await badPort.loadBook('某书'),
  }))
  ok('书单：DataPort 抛错 → 空表不 reject', boom.value.index.length === 0)
  ok('正文：DataPort 抛错 → 空数组不 reject', boom.value.book.length === 0)
  ok('两条失败都留痕', boom.logs.filter((s) => /STORY-(INDEX|LOAD)-FAIL/.test(s)).length === 2, JSON.stringify(boom.logs))
  const weird = createStorySource({ readStoryIndex: async () => [], readStoryBook: async () => ({ nope: true }) })
  ok('正文：DataPort 违约（非数组）→ 空数组', (await weird.loadBook('某书')).length === 0)
} catch (e) {
  ok('H 组可执行', false, String(e && e.message))
}

// ---------------------------------------------------------------------------
// I. 封装：端口只暴露 DataPort 方法；数据层不深引用说书实现
// ---------------------------------------------------------------------------
console.log('\n[I] 封装：端口面与模块边界')
try {
  const { createLocalDataPort } = await imp('src/host/data/local.ts')
  const { createCloudDataPort } = await imp('src/host/data/cloud.ts')
  // 2026-11-07 B86：poem-titles / melodies 从「路由直读 data/」收口到端口，端口面由 6 项变 8 项
  const want = ['readCulture', 'readDaily', 'readDuilian', 'readMelodies', 'readPoemTitles', 'readPoemsChunk', 'readStoryBook', 'readStoryIndex']
  const dir = mkTmp('whale-data-face-')
  const local = createLocalDataPort({ dataDir: dir, story: { listBooks: async () => [], loadBook: async () => [] } })
  const cloud = createCloudDataPort({ local, fetchImpl: async () => ({ ok: false, status: 500, text: async () => '' }) })
  ok('本地端口只暴露 DataPort 的 6 个方法（不泄漏缓存/inflight/路径）', Object.keys(local).sort().join(',') === want.join(','), Object.keys(local).join(','))
  ok('云端端口只暴露 DataPort 的 6 个方法', Object.keys(cloud).sort().join(',') === want.join(','))

  // 数据层不该 import 说书实现：StoryChunk 由 ports.ts 定义；
  // 只有「本地实现注入仓储」「适配层产出仓储」这两处需要 StoryRepo 这个接口类型。
  for (const f of ['cloud.ts', 'local.ts', 'normalize.ts', 'story-source.ts']) {
    const src = readFileSync(join(ROOT, 'src/host/data', f), 'utf8')
    const hits = src.match(/from '\.\.\/story\/[^']*'/g) || []
    if (f === 'local.ts' || f === 'story-source.ts') {
      // 只允许「光引一个 StoryRepo 接口类型」；再顺手引 StoryChunk 就说明还在依赖说书实现
      ok(f + ' 只从 story/repo 取 StoryRepo 接口类型',
        hits.length === 1 && /import type \{ *StoryRepo *\} from '\.\.\/story\/repo\.js'/.test(src), hits.join(' '))
    } else {
      ok(f + ' 不再深引用说书实现', hits.length === 0, hits.join(' '))
    }
  }
} catch (e) {
  ok('I 组可执行', false, String(e && e.message))
}

// ---------------------------------------------------------------------------
for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }) } catch { } }
console.log('\n────────────────────')
console.log((fail === 0 ? '✅ ' : '❌ ') + '数据层通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
