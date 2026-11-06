/**
 * scripts/test-story-player.mjs —— 说书播放器离线回归（选段 / 进度键 / 连播 / 分段推导 / 路径边界）
 *
 * 2026-11-07 审计发现三处真实缺陷（本脚本锁死修复后的行为）：
 *   ① 分段位置（piece/total）从来没算过：数据里的段落只有 book/title/section/total/text，
 *      没有 piece 字段，旧代码 `Number(c.piece) || 1` 让 piece 恒为 1；
 *   ② 于是 `isLast = piece >= total` 只在 total===1 的段为真 —— 而实测 6 本书共 18 段 total===1
 *      且多数在书中间（儒林外史第 0 段就是），客户端把 isLast===true 当「整轮讲完」（关连播 + 报完），
 *      一本书刚开口就自动停了（修法：isLast 还要同时是「本书最后一段」，只收紧不放松）；
 *   ③ repo 的并发去重把同一个数组实例交给所有等待者，与「返回浅拷贝、调用方可随意排序切分」的契约不符。
 *
 * 覆盖：
 *   A. 真实数据前提（无 piece 字段、total 两种语义、书中间的 total===1 段确实存在）；
 *   B. 分段推导（回内 x/y 与全书累计 x/N 两种口径、结尾句只在「回/篇」末尾出现）；
 *   C. isLast 不再中途置真（客户端的连播开关不会被误关）；
 *   D. 进度键：旧键迁移、迁移幂等、跨数据源隔离、reset 只清本数据源；
 *   E. 跨书连播：一本讲完自动换下一本、remain 递减、换书才重开放场白；
 *   F. 坏书/缺书的降级（跳坏书、全坏回 no readable book、空书单回 no books）；
 *   G. 文件系统边界与缓存隔离（真实 repo + 临时目录 + Worker）。
 *   H. 进度次序（B97）：defer 只预约不落盘、confirm 才记、discard 撤销、reset 清预约、旧调用兼容。
 *
 * 纯离线：不联网、不起 HTTP、不碰运行目录（全部走临时目录），跑完清理。
 * 用法：node scripts/test-story-player.mjs（不在 npm test 的脚本表里，单独跑）
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { register } from 'node:module'

// 源码里跨模块导入写的是 .js（构建产物口径），测试直接加载 .ts，需要同一个解析钩子
register(new URL('./ts-resolve.mjs', import.meta.url))

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.error('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

const { createStoryPlayer } = await import('../src/host/story/player.ts')
const { createStoryRepo } = await import('../src/host/story/repo.ts')
const { normalizeStoryChunks } = await import('../src/host/data/normalize.ts')

const TMP = mkdtempSync(join(tmpdir(), 'whale-story-player-'))
let seq = 0
/** 新建一个空的进度文件（每个用例各用各的，互不干扰） */
function progressFile(seed) {
  seq++
  const p = join(TMP, 'progress-' + seq + '.json')
  if (seed !== undefined) writeFileSync(p, JSON.stringify(seed))
  return p
}
const readProgress = (p) => JSON.parse(readFileSync(p, 'utf8'))

/** 假 repo：与真实实现同样返回浅拷贝数组（元素对象共享） */
function repoOf(map) {
  return {
    listBooks: async () => Object.keys(map),
    loadBook: async (book) => (map[book] || []).slice(),
  }
}
/** 造段：与 normalizeStoryChunks 的产物同形（piece 恒 1，total 由数据给） */
function mkChunks(book, rows) {
  return rows.map((r, i) => ({ book, title: r[0], piece: 1, total: r[1], text: r[2], index: i }))
}
const readBookJson = (name) => JSON.parse(readFileSync(join(ROOT, 'data', 'story', name + '.json'), 'utf8'))
const chunksOf = (name) => normalizeStoryChunks(name, readBookJson(name))


// ---------- A. 真实数据前提 ----------
console.log('\n[A] 真实数据前提（data/story）')
try {
  const xyRaw = readBookJson('西游记')
  ok('段落里没有 piece 字段（旧代码 piece 恒为 1 的根源）',
    xyRaw.every((c) => c.piece === undefined),
    '字段=' + Object.keys(xyRaw[0]).join(','))
  ok('西游记 total = 回内段数（同回 4 段）',
    xyRaw[0].total === 4 && xyRaw[3].total === 4 && String(xyRaw[0].title) === String(xyRaw[3].title) &&
    xyRaw[4].total === 4 && String(xyRaw[4].title) !== String(xyRaw[0].title),
    '首段 total=' + xyRaw[0].total)

  const lzRaw = readBookJson('聊斋志异')
  ok('聊斋 total = 全书段数（另一套语义）',
    lzRaw.length === 495 && lzRaw.every((c) => c.total === lzRaw.length),
    'n=495, total=495')

  const rlRaw = readBookJson('儒林外史')
  ok('书中间确实存在 total===1 的段（旧 isLast 会在此处误判「整轮讲完」）',
    rlRaw[0].total === 1 && rlRaw[8].total === 1,
    '第0段 total=1 / 第8段 total=1')
  ok('旧口径 piece>=total 在这些段上恒真（缺陷可复现）',
    (Number(rlRaw[0].piece) || 1) >= (Number(rlRaw[0].total) || 1))
} catch (e) {
  ok('能读真实数据', false, String(e && e.message))
}


// ---------- B. 分段推导 ----------
console.log('\n[B] 分段推导（回内 x/y 与全书累计 x/N）')
try {
  const xy = chunksOf('西游记')
  const player = createStoryPlayer({ repo: repoOf({ '西游记': xy }), progressFile: progressFile(), source: 'local' })
  const seen = []
  let r = await player.start('西游记', 'c1')
  ok('开讲成功', r.ok === true && !!r.chunk, r.ok ? '' : String(r.error))
  if (r.ok) {
    seen.push(r.chunk)
    ok('首段 piece/total = 1/4（回内序号，不再恒为 1/4 以外的假值）',
      r.chunk.piece === 1 && r.chunk.total === 4, r.chunk.piece + '/' + r.chunk.total)
    ok('开场白只在首段', r.chunk.isFirst === true && r.chunk.text.indexOf('话说，今天给主人讲一段《西游记》，吴承恩著') === 0)
    ok('回内第 1 段不带结尾句', r.chunk.text.indexOf('这一回，就讲到这里。') < 0)
    ok('remain = 本书剩余未读段（连播队列长度，跨书不计）', r.remain === 377, 'remain=' + r.remain + ' / 全书 378')
    for (let i = 0; i < 3; i++) {
      const nx = await player.next('c1')
      if (!nx.ok) { ok('连播第 ' + (i + 2) + ' 段', false, String(nx.error)); break }
      seen.push(nx.chunk)
    }
    ok('连播四段的 piece 依次 1,2,3,4',
      seen.map((c) => c.piece).join(',') === '1,2,3,4', seen.map((c) => c.piece).join(','))
    ok('total 一直是 4', seen.every((c) => c.total === 4))
    ok('只有本回最后一段带结尾句', seen[3].text.indexOf('这一回，就讲到这里。') > 0 &&
      seen.slice(0, 3).every((c) => c.text.indexOf('这一回，就讲到这里。') < 0))
    ok('第 2~4 段不再重复开场白', seen.slice(1).every((c) => c.isFirst === false))
    // 第 5 段是第二回：piece 重新从 1 开始
    const fifth = await player.next('c1')
    ok('第二回首段 piece 重新从 1 起算', fifth.ok && fifth.chunk.piece === 1, fifth.ok ? fifth.chunk.piece + '/' + fifth.chunk.total : String(fifth.error))
  }
} catch (e) {
  ok('分段推导（西游记）执行', false, String(e && e.message))
}

try {
  const lz = chunksOf('聊斋志异')
  const player = createStoryPlayer({ repo: repoOf({ '聊斋志异': lz }), progressFile: progressFile(), source: 'local' })
  const r = await player.start('聊斋志异', 'c2')
  ok('聊斋首段 = 1/495（total 是全字段数，按全书累计口径）',
    r.ok && r.chunk.piece === 1 && r.chunk.total === 495, r.ok ? r.chunk.piece + '/' + r.chunk.total : String(r.error))
  // 一路讲到末段（495 段只在内存里走，不读盘）
  let last = r
  for (let i = 1; i < 495 && last.ok; i++) last = await player.next('c2')
  ok('末段 = 495/495 且带结尾句', last.ok && last.chunk.piece === 495 && last.chunk.total === 495 &&
    last.chunk.text.indexOf('这一回，就讲到这里。') > 0,
    last.ok ? last.chunk.piece + '/' + last.chunk.total : String(last.error))
  ok('每段都按「一篇讲完」收尾（聊斋一篇一段）',
    r.ok && r.chunk.text.indexOf('这一回，就讲到这里。') > 0)
} catch (e) {
  ok('分段推导（聊斋志异）执行', false, String(e && e.message))
}


// ---------- C. isLast 不再中途置真 ----------
console.log('\n[C] isLast 与客户端连播开关')
try {
  const rl = chunksOf('儒林外史')
  const player = createStoryPlayer({ repo: repoOf({ '儒林外史': rl }), progressFile: progressFile(), source: 'local' })
  const r = await player.start('儒林外史', 'c3')
  ok('儒林外史第 0 段（total=1）不再回 isLast=true',
    r.ok && r.chunk.isLast === false, r.ok ? 'isLast=' + r.chunk.isLast : String(r.error))
  ok('该段仍是合法分段（piece/total 由分组推出）',
    r.ok && r.chunk.piece === 1 && r.chunk.total === 1, r.ok ? r.chunk.piece + '/' + r.chunk.total : '')

  // 综合断言：一本 5 段的书（中间两段 total=1）从头连播到底
  const book = mkChunks('测试书', [['第一回', 2, '甲一'], ['第一回', 2, '甲二'], ['第二回', 1, '乙一'], ['第三回', 1, '丙一'], ['第四回', 1, '丁一']])
  const p2 = createStoryPlayer({ repo: repoOf({ '测试书': book }), progressFile: progressFile(), source: 'local' })
  const flags = []
  let cur = await p2.start('测试书', 'c4')
  if (cur.ok) flags.push(cur.chunk.isLast)
  for (let i = 0; i < 4; i++) {
    cur = await p2.next('c4')
    if (cur.ok) flags.push(cur.chunk.isLast)
  }
  ok('书中间的 total=1 段不再回 isLast=true（旧实现里 4 段全中）',
    flags.length === 5 && flags.slice(0, 4).every((v) => v === false), JSON.stringify(flags))
  ok('本书最后一段（数据编号也到本单元末尾）才置 isLast', flags[4] === true, JSON.stringify(flags))

  // 只收不放：数据没把末段标成「本单元末尾」时，最后一段也不置真（跨书连播依赖这一点）
  const whole = mkChunks('整回书', [['第一回', 3, '一一'], ['第一回', 3, '一二'], ['第一回', 3, '一三']])
  const p3 = createStoryPlayer({ repo: repoOf({ '整回书': whole }), progressFile: progressFile(), source: 'local' })
  const c1 = await p3.start('整回书', 'c7')
  void await p3.next('c7')
  const c3 = await p3.next('c7')
  ok('数据按回内编号时，全书最后一段 isLast 仍为 false（一本接一本不会被拦住）',
    c1.ok && c3.ok && c3.chunk.isLast === false, c3.ok ? 'piece=' + c3.chunk.piece + '/' + c3.chunk.total : String(c3.error))
} catch (e) {
  ok('isLast 断言执行', false, String(e && e.message))
}


// ---------- D. 进度键：迁移 / 幂等 / 跨数据源隔离 / reset ----------
console.log('\n[D] 进度键命名空间与迁移')
try {
  // D1 旧键迁移 + 幂等
  const pf = progressFile({ '聊斋志异|3': true, '三国演义|7': true, _current: '三国演义' })
  createStoryPlayer({ repo: repoOf({}), progressFile: pf, source: 'local' })
  const p1 = readProgress(pf)
  ok('旧键复制成 local: 前缀', p1['local:聊斋志异|3'] === true && p1['local:三国演义|7'] === true)
  ok('旧键（无前缀）已删除', !('聊斋志异|3' in p1) && !('三国演义|7' in p1))
  ok('_current 不参与迁移、原样保留', p1._current === '三国演义')
  const after1 = readFileSync(pf, 'utf8')
  createStoryPlayer({ repo: repoOf({}), progressFile: pf, source: 'local' })
  ok('迁移幂等：二次构造文件字节不变', readFileSync(pf, 'utf8') === after1)

  // D2 云端装配：迁到 cloud: 前缀，不写 local:
  const pf2 = progressFile({ '聊斋志异|3': true })
  createStoryPlayer({ repo: repoOf({}), progressFile: pf2, source: 'cloud' })
  const p2 = readProgress(pf2)
  ok('cloud 装配把旧键迁到 cloud: 前缀', p2['cloud:聊斋志异|3'] === true && !('local:聊斋志异|3' in p2))

  // D3 跨数据源隔离：local 装配既不读也不清 cloud 的键
  const book = mkChunks('聊斋志异', [['考城隍', 2, '一'], ['耳中人', 1, '二']])
  const pf3 = progressFile({ 'local:聊斋志异|0': true, 'cloud:聊斋志异|0': true })
  const p3 = createStoryPlayer({ repo: repoOf({ '聊斋志异': book }), progressFile: pf3, source: 'local' })
  const first = await p3.start('聊斋志异', 'c5')
  ok('local 装配跳过本数据源已读的第 0 段', first.ok && first.chunk.text.indexOf('二') >= 0,
    first.ok ? first.chunk.text.slice(0, 6) : String(first.error))
  await p3.reset('聊斋志异', 'c5')
  const p3after = readProgress(pf3)
  ok('reset 只清本数据源该书的键', !('local:聊斋志异|0' in p3after) && !('local:聊斋志异|1' in p3after))
  ok('reset 不动别的数据源的键', p3after['cloud:聊斋志异|0'] === true)
  ok('reset 把「当前书」指过去', p3after._current === '聊斋志异')

  // D4 reset 不接受书单里没有的书（防「当前书」被污染成不存在的书）
  const pf4 = progressFile({ _current: '聊斋志异' })
  const p4 = createStoryPlayer({ repo: repoOf({ '聊斋志异': book }), progressFile: pf4, source: 'local' })
  const bad = await p4.reset('不存在的书', 'c6')
  ok('reset 未知书 → unknown book', bad.ok === false && bad.error === 'unknown book')
  ok('reset 失败不写坏 _current', readProgress(pf4)._current === '聊斋志异')
  const empty = await p4.reset('  ', 'c6')
  ok('reset 空书名 → no book', empty.ok === false && empty.error === 'no book')
} catch (e) {
  ok('进度键断言执行', false, String(e && e.message))
}


// ---------- E. 跨书连播 ----------
console.log('\n[E] 跨书连播（remain / 换书重开放场白）')
try {
  const books = {
    '甲书': mkChunks('甲书', [['甲一', 2, '甲一正文'], ['甲一', 2, '甲二正文']]),
    '乙书': mkChunks('乙书', [['乙一', 2, '乙一正文'], ['乙一', 2, '乙二正文']]),
  }
  const player = createStoryPlayer({ repo: repoOf(books), progressFile: progressFile(), source: 'local' })
  const got = []
  let r = await player.start('甲书', 'e1')
  if (r.ok) got.push(r)
  for (let i = 0; i < 3; i++) {
    const nx = await player.next('e1')
    if (!nx.ok) { ok('跨书第 ' + (i + 2) + ' 段', false, String(nx.error)); break }
    got.push(nx)
  }
  ok('四段都拿到', got.length === 4, 'got=' + got.length)
  if (got.length === 4) {
    const texts = got.map((x) => (x.chunk.text.indexOf('甲一') >= 0 ? '甲一' : x.chunk.text.indexOf('甲二') >= 0 ? '甲二'
      : x.chunk.text.indexOf('乙一') >= 0 ? '乙一' : '乙二'))
    ok('讲完甲书自动接乙书', texts.join(',') === '甲一,甲二,乙一,乙二', texts.join(','))
    ok('remain 在本书内递减，并在换书后重置（只算当前书）', got.map((x) => x.remain).join(',') === '1,0,1,0',
      got.map((x) => x.remain).join(','))
    ok('只有第一段和换书后的第一段带开场白',
      got.map((x) => x.chunk.isFirst).join(',') === 'true,false,true,false',
      got.map((x) => x.chunk.isFirst).join(','))
    ok('换书后开场白报的是新书名', got[2].chunk.text.indexOf('《乙书》') >= 0)
    ok('书名跟着换（响应 book 字段）', got[3].chunk.book === '乙书', got[3].chunk.book)
  }

  // 全部讲完 → 一轮回卷（_current 回到第一本，重新开场白）
  const wrap = await player.next('e1')
  ok('一轮讲完自动回卷并要求开场白', wrap.ok && wrap.chunk.isFirst === true, wrap.ok ? '' : String(wrap.error))
  ok('回卷后从头开始（甲书第 1 段）', wrap.ok && wrap.chunk.text.indexOf('甲一') >= 0)
} catch (e) {
  ok('跨书连播断言执行', false, String(e && e.message))
}


// ---------- F. 坏书 / 缺书降级 ----------
console.log('\n[F] 坏书与缺书降级')
try {
  const good = mkChunks('好书', [['好一', 1, '好正文']])
  const mixed = createStoryPlayer({
    repo: repoOf({ '坏书': [], '好书': good }),
    progressFile: progressFile(),
    source: 'local',
  })
  const r1 = await mixed.start('', 'f1')
  ok('书单第一本是坏书时自动跳到下一本', r1.ok && r1.chunk.book === '好书', r1.ok ? r1.chunk.book : String(r1.error))

  const allBad = createStoryPlayer({
    repo: repoOf({ '坏书': [], '也坏': [] }),
    progressFile: progressFile(),
    source: 'local',
  })
  const r2 = await allBad.start('', 'f2')
  ok('全是坏书 → no readable book（不假装讲完了）', r2.ok === false && r2.error === 'no readable book')

  const noBooks = createStoryPlayer({ repo: repoOf({}), progressFile: progressFile(), source: 'local' })
  ok('空书单 → no books', (await noBooks.start('', 'f3')).ok === false && (await noBooks.next('f3')).error === 'no books')

  // 坏书不影响「接着讲」
  const r3 = await mixed.next('f1')
  ok('坏书之后仍能接着讲', r3.ok === true, r3.ok ? r3.chunk.book : String(r3.error))
} catch (e) {
  ok('降级断言执行', false, String(e && e.message))
}


// ---------- G. 文件系统边界与缓存隔离（真实 repo） ----------
console.log('\n[G] 文件系统边界与缓存隔离（真实 repo + Worker）')
try {
  const dataDir = join(TMP, 'g')
  mkdirSync(join(dataDir, 'story'), { recursive: true })
  writeFileSync(join(dataDir, 'story', '合法书.json'), JSON.stringify([
    { book: '合法书', title: '第一回', total: 2, text: '甲甲甲' },
    { book: '合法书', title: '第一回', total: 2, text: '乙乙乙' },
  ]))
  writeFileSync(join(dataDir, 'secret.json'), JSON.stringify({ secret: true }))
  const workerPath = join(ROOT, 'dist', 'story-worker.js')
  if (!existsSync(workerPath)) {
    console.log('  · 跳过：dist/story-worker.js 不存在（先跑一次 tsc / npm run build）')
  } else {
    const repo = createStoryRepo({ dataDir, workerPath })
    ok('书单只列 story/*.json 的书名', (await repo.listBooks()).join(',') === '合法书')
    ok('../secret 读不出来', (await repo.loadBook('../secret')).length === 0)
    ok('..\\secret 读不出来', (await repo.loadBook('..\\secret')).length === 0)
    ok('a/b 读不出来', (await repo.loadBook('a/b')).length === 0)

    // 冷读并发去重：两个等待者必须各拿一份数组（同一实例会被彼此的 sort 互改）
    const [c1, c2] = await Promise.all([repo.loadBook('合法书'), repo.loadBook('合法书')])
    ok('冷读成功解析两段', c1.length === 2 && c2.length === 2, 'c1=' + c1.length + ' c2=' + c2.length)
    ok('并发两个等待者拿到不同数组实例', c1 !== c2)

    // 缓存命中：同样要各拿一份，且原地排序不影响后续读取
    const m1 = await repo.loadBook('合法书')
    const m2 = await repo.loadBook('合法书')
    ok('缓存命中返回不同数组实例', m1 !== m2)
    ok('缓存命中内容一致', m1.length === 2 && m1[0].text === '甲甲甲')
    m1.reverse()
    const m3 = await repo.loadBook('合法书')
    ok('调用方原地排序不影响缓存里的顺序', m3[0].text === '甲甲甲' && m3[1].text === '乙乙乙', m3.map((x) => x.text).join(','))
    ok('段序号保持原数组位置（进度键依赖 index）', m3.map((x) => x.index).join(',') === '0,1')
  }
} catch (e) {
  ok('文件系统边界断言执行', false, String(e && e.message))
}


// ---------- H. 进度次序：先预约、确认后才记账（B97） ----------
console.log('\n[H] 进度次序：defer 只预约、confirm 才落盘')
try {
  const book = mkChunks('甲书', [['甲一', 2, '一正文'], ['甲一', 2, '二正文'], ['甲二', 2, '三正文'], ['甲二', 2, '四正文']])
  const makePlayer = (pf) => createStoryPlayer({ repo: repoOf({ '甲书': book }), progressFile: pf, source: 'local' })
  // 旧实现没有 confirm/discard：返回 null 让断言直接红，而不是整段抛异常（保证后续用例还能跑）
  const confirmOf = (p, b, i) => (typeof p.confirm === 'function' ? p.confirm(b, i) : null)
  const discardOf = (p, b, i) => (typeof p.discard === 'function' ? p.discard(b, i) : null)
  const servedIndex = (r) => (r && r.ok && r.served ? Number(r.served.index) : -1)
  const keysOf = (pf) => (existsSync(pf) ? readProgress(pf) : {})

  // H1 defer：start 只预约不落盘；confirm 之后才记，文件格式不变
  {
    const pf = progressFile()
    const p = makePlayer(pf)
    const r = await p.start('甲书', 'h1', { defer: true })
    const before = existsSync(pf)
    const c = confirmOf(p, '甲书', 0)
    const saved = keysOf(pf)
    ok('defer：start 返回时一段都没落盘；confirm 之后才记成已讲并写 _current（格式不变：除 _current 外全是 true）',
      r.ok === true && !before && c === true && saved['local:甲书|0'] === true && saved._current === '甲书' &&
      Object.keys(saved).every((k) => k === '_current' || saved[k] === true),
      'before=' + before + ' confirm=' + String(c) + ' file=' + JSON.stringify(saved))
    ok('defer：响应里带着「要确认的那一段」served（路由据此 confirm）',
      r.ok === true && !!r.served && r.served.book === '甲书' && r.served.index === 0,
      r.ok ? JSON.stringify(r.served) : String(r.error))
  }

  // H2 defer 下并发/连点：仍不重复选段（在途预约占位），但确认前一条都不落盘
  {
    const pf = progressFile()
    const p = makePlayer(pf)
    const [a, b] = await Promise.all([p.start('甲书', 'h2', { defer: true }), p.start('甲书', 'h2', { defer: true })])
    const idx = [servedIndex(a), servedIndex(b)].sort((x, y) => x - y)
    const beforeKeys = Object.keys(keysOf(pf)).filter((k) => k !== '_current')
    ok('defer 并发 start：两段不重复（在途预约占位），且确认前一条都不落盘',
      a.ok && b.ok && idx.join(',') === '0,1' && beforeKeys.length === 0,
      'idx=' + idx.join(',') + ' keys=' + beforeKeys.join(','))
    const c1 = confirmOf(p, '甲书', 0)
    const c2 = confirmOf(p, '甲书', 1)
    const saved = keysOf(pf)
    ok('defer 并发 start：两段都确认后进度里两条都在',
      c1 === true && c2 === true && saved['local:甲书|0'] === true && saved['local:甲书|1'] === true,
      JSON.stringify(saved))
  }

  // H3 discard（客户端断开）：这一段回到未讲，下一次 start 还是它
  {
    const pf = progressFile()
    const p = makePlayer(pf)
    const a = await p.start('甲书', 'h3', { defer: true })
    const d = discardOf(p, '甲书', 0)
    const b = await p.start('甲书', 'h3', { defer: true })
    ok('discard：断开撤销后这一段仍是未讲，下一次 start 还是它，且不写盘',
      a.ok && d === true && b.ok && servedIndex(b) === 0 && !existsSync(pf),
      'discard=' + String(d) + ' next=' + servedIndex(b) + ' file=' + existsSync(pf))
  }

  // H4 reset：在途预约一起清；迟到的 confirm 不许把刚重置的书写回已讲
  {
    const pf = progressFile()
    const p = makePlayer(pf)
    const first = await p.start('甲书', 'h4', { defer: true })
    await p.reset('甲书', 'h4')
    const late = confirmOf(p, '甲书', 0)
    const after = await p.start('甲书', 'h4', { defer: true })
    const saved = keysOf(pf)
    ok('reset：迟到的 confirm 不记账，重讲还是第 1 段（预约已随 reset 清掉）',
      first.ok && late === false && after.ok && servedIndex(after) === 0 &&
      saved['local:甲书|0'] !== true && saved._current === '甲书',
      'late=' + String(late) + ' next=' + servedIndex(after) + ' file=' + JSON.stringify(saved))
  }

  // H5 兼容：不带 opts 的旧调用仍当场落盘（离线脚本/旧调用方靠它续讲），defer 的不落盘
  {
    const pfA = progressFile()
    const old = await makePlayer(pfA).start('甲书', 'h5')
    const oldWrote = existsSync(pfA) && readProgress(pfA)['local:甲书|0'] === true
    const pfB = progressFile()
    await makePlayer(pfB).start('甲书', 'h5', { defer: true })
    const deferWrote = existsSync(pfB)
    ok('两种模式并存：旧调用当场落盘、defer 调用不落盘',
      old.ok === true && oldWrote && deferWrote === false, 'old=' + oldWrote + ' defer=' + deferWrote)
  }

  // H6 格式兼容：旧键与 _current 不丢，confirm 之后新旧键并存
  {
    const pf = progressFile({ 'local:甲书|0': true, _current: '甲书' })
    const p = makePlayer(pf)
    const r = await p.start('甲书', 'h6', { defer: true })   // 第 0 段已讲 → 第 1 段
    const before = keysOf(pf)
    const c = confirmOf(p, '甲书', 1)
    const saved = keysOf(pf)
    ok('旧键/_current 不丢：选到第 2 段，confirm 之后新旧键并存且格式不变',
      r.ok && servedIndex(r) === 1 && before['local:甲书|0'] === true && c === true &&
      saved['local:甲书|0'] === true && saved['local:甲书|1'] === true && saved._current === '甲书' &&
      Object.keys(saved).every((k) => k === '_current' || saved[k] === true),
      JSON.stringify(saved))
  }

  // H7 next 出队的那一段：响应没送出（discard）要归队，不能顺着队列跳过去
  {
    const pf = progressFile()
    const p = makePlayer(pf)
    const a = await p.start('甲书', 'h7', { defer: true })   // 第 0 段
    confirmOf(p, '甲书', 0)                                   // 第 1 段确实听到了，队列从第 1 段起
    const n1 = await p.next('h7', { defer: true })
    const d = discardOf(p, '甲书', 1)                         // 模拟 next 的响应没送出去
    const n2 = await p.next('h7', { defer: true })
    ok('next：响应没送出 → discard 把这一段塞回队首，下一次 next 还是它（不跳过）',
      a.ok && servedIndex(n1) === 1 && d === true && servedIndex(n2) === 1,
      'n1=' + servedIndex(n1) + ' discard=' + String(d) + ' n2=' + servedIndex(n2))
  }
} catch (e) {
  ok('进度次序断言执行', false, String(e && e.message))
}


// ---------- 汇总 ----------
try { rmSync(TMP, { recursive: true, force: true }) } catch (e) { }
console.log('\n────────────────────')
console.log((fail === 0 ? '✅ ' : '❌ ') + '通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
