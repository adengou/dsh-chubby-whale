#!/usr/bin/env node
/**
 * scripts/test-story-perf.mjs —— 说书链路「算法/时间/内存」基准与护栏（B104 分身·说书算法性能）
 *
 * 这个脚本只做两件事，做完就退出：
 *   ① 用**真实数据**（data/story 17 本 / 6753 段 / 最大 6.4MB）量化说书链路的时间与内存；
 *   ② 把优化前后的**对外行为**逐字段钉死（内嵌基线快照）+ 给几道宽松的性能护栏，防以后退化。
 *
 * 为什么要有「内嵌基线快照」：本次改动只碰算法（planSegments / queueAfter / pickNext 扫描 /
 * 进度键构造 / 书缓存），对外行为必须一字不变。快照是在**改动之前**用同一份场景脚本跑出来的，
 * 以 gzip+base64 内嵌在本文件里；优化后跑同一份场景，逐字段比对，任何差异都会打出第一个不同的字段路径。
 *   · 快照覆盖：17 本真实书的首段、整本连播（世说新语 1129 段全走）、跨书/回卷、defer 预约/确认/撤销、
 *     旧键迁移、reset、reload、坏书降级、队列 LRU/TTL、getProgress/setProgress。
 *   · 场景里的时间全部由假时钟驱动，进度文件写在系统临时目录，跑完清理，不碰用户数据。
 *
 * 性能护栏的阈值都留了 3~10 倍余量（慢机器/CI 抖动不该红），只在**复杂度变了**的时候才会红：
 * 比如「每段都重建一次全书 map」「每次全量扫描进度文件」这类退化。
 *
 * 用法：
 *   node scripts/test-story-perf.mjs                  # 行为等价断言 + 性能护栏 + 基准表（默认）
 *   node scripts/test-story-perf.mjs --bench          # 只跑基准表（跳过等价快照与护栏，打印 JSON，方便改前/改后对比）
 *   node scripts/test-story-perf.mjs --snapshot       # 打印当前实现的行为快照（gzip+base64，用于重生成基线）
 *   node --expose-gc scripts/test-story-perf.mjs      # 额外精确测量内存（推荐；不带时内存项标注「粗测」/内存护栏跳过）
 *
 * 注意：本脚本**不在** npm test 的脚本表里（那会拖慢每次回归），按需手动跑/在性能任务里跑。
 */
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { register } from 'node:module'
import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { PerformanceObserver } from 'node:perf_hooks'

// 源码里跨模块导入写的是 .js（构建产物口径），测试直接加载 .ts，需要同一个解析钩子
register(new URL('./ts-resolve.mjs', import.meta.url))

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_DIR = join(ROOT, 'data')
const STORY_DIR = join(DATA_DIR, 'story')
const WORKER_PATH = join(ROOT, 'dist', 'story-worker.js')

const ARGV = process.argv.slice(2)
const MODE_SNAPSHOT = ARGV.includes('--snapshot')
const MODE_BENCH_ONLY = ARGV.includes('--bench')
const HAS_GC = typeof globalThis.gc === 'function'

const { createStoryPlayer } = await import('../src/host/story/player.ts')
const { createStoryRepo } = await import('../src/host/story/repo.ts')
const { normalizeStoryChunks } = await import('../src/host/data/normalize.ts')

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.error('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

const TMP = mkdtempSync(join(tmpdir(), 'whale-story-perf-'))
let seq = 0
/** 新建一个空进度文件（每个用例各用各的，互不干扰） */
function progressFile(seed) {
  seq++
  const p = join(TMP, 'progress-' + seq + '.json')
  if (seed !== undefined) writeFileSync(p, JSON.stringify(seed))
  return p
}
const readProgress = (p) => JSON.parse(readFileSync(p, 'utf8'))
const sha = (s) => createHash('sha1').update(String(s), 'utf8').digest('hex').slice(0, 16)

// ---------- 计时 / 内存小工具 ----------

/** 同步 bench：返回 { n, min, p50, mean, samples }（毫秒） */
function bench(fn, opts = {}) {
  const reps = opts.reps || 7
  const warmup = opts.warmup == null ? 2 : opts.warmup
  for (let i = 0; i < warmup; i++) fn(i)
  const samples = []
  for (let i = 0; i < reps; i++) {
    const t0 = process.hrtime.bigint()
    fn(i)
    const t1 = process.hrtime.bigint()
    samples.push(Number(t1 - t0) / 1e6)
  }
  return stats(samples)
}

/** 异步 bench（等待 Promise 真正完成） */
async function benchAsync(fn, opts = {}) {
  const reps = opts.reps || 7
  const warmup = opts.warmup == null ? 2 : opts.warmup
  for (let i = 0; i < warmup; i++) await fn(i)
  const samples = []
  for (let i = 0; i < reps; i++) {
    const t0 = process.hrtime.bigint()
    await fn(i)
    const t1 = process.hrtime.bigint()
    samples.push(Number(t1 - t0) / 1e6)
  }
  return stats(samples)
}

/**
 * 两段式 bench：**每一轮**先跑 first 再跑 second，分别计时。
 * 为什么不用两次独立的 bench 相减：Windows 上单次测量抖动很大，两次独立测量的均值一相减，
 * 会出现「净开销为负」这种物理上不可能的读数（本脚本第一版就这样翻过车）。
 * 同一轮里 second 的耗时已经含 first，逐轮相减天然 ≥ 0，抖动也不会跨轮混进来。
 * @returns { first, second, total }（都是 {min,p50,mean}；second = 扣掉 first 之后的部分）
 */
async function benchTwoPhase(first, second, opts = {}) {
  const reps = opts.reps || 9
  const warmup = opts.warmup == null ? 3 : opts.warmup
  for (let i = 0; i < warmup; i++) { await first(i); await second(i) }
  const a = [], b = [], all = []
  for (let i = 0; i < reps; i++) {
    const t0 = process.hrtime.bigint()
    await first(i)
    const t1 = process.hrtime.bigint()
    await second(i)
    const t2 = process.hrtime.bigint()
    a.push(Number(t1 - t0) / 1e6)
    b.push(Number(t2 - t1) / 1e6)
    all.push(Number(t2 - t0) / 1e6)
  }
  return { first: stats(a), second: stats(b), total: stats(all) }
}

function stats(samples) {
  const sorted = samples.slice().sort((a, b) => a - b)
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length
  return {
    n: samples.length,
    min: sorted[0],
    p50: sorted[Math.floor(sorted.length / 2)],
    mean,
  }
}

const fmt = (x) => (x >= 10 ? x.toFixed(1) : x >= 1 ? x.toFixed(2) : x.toFixed(3))
const fmtRow = (r) => fmt(r.min) + ' / ' + fmt(r.p50) + ' / ' + fmt(r.mean)

function gcNow() {
  if (!HAS_GC) return false
  globalThis.gc()
  globalThis.gc()
  return true
}
/** 保留堆（MB）：先 GC 再取 heapUsed；没有 --expose-gc 时只能给个数量级 */
function heapMB() {
  return process.memoryUsage().heapUsed / (1024 * 1024)
}
function rssMB() {
  return process.memoryUsage().rss / (1024 * 1024)
}

// ---------- 真实数据（一次读入，17 本 / 6753 段） ----------

console.log('\n[0] 载入真实数据（data/story）')
const realBooks = readdirSync(STORY_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()

/** 每本：原始 JSON 文本、segments 数、归一化后的 chunks（共享，假 repo 用） */
const RAW = new Map()
const CHUNKS = new Map()
let totalSegs = 0
for (const name of realBooks) {
  const text = readFileSync(join(STORY_DIR, name + '.json'), 'utf8')
  const raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  const chunks = normalizeStoryChunks(name, raw)
  RAW.set(name, { text, raw })
  CHUNKS.set(name, chunks)
  totalSegs += chunks.length
}
const biggest = realBooks.slice().sort((a, b) => Buffer.byteLength(RAW.get(b).text) - Buffer.byteLength(RAW.get(a).text))[0]
const mostSegs = realBooks.slice().sort((a, b) => CHUNKS.get(b).length - CHUNKS.get(a).length)[0]
console.log('  书 ' + realBooks.length + ' 本 / 段 ' + totalSegs + ' 段；最大文件 ' + biggest +
  '（' + (Buffer.byteLength(RAW.get(biggest).text) / 1048576).toFixed(2) + 'MB / ' + CHUNKS.get(biggest).length + ' 段）；' +
  '最多段 ' + mostSegs + '（' + CHUNKS.get(mostSegs).length + ' 段）')

/** 假 repo：与真实实现同样返回浅拷贝数组（元素对象共享），listBooks 顺序固定 */
function repoOf(map) {
  return {
    listBooks: async () => Object.keys(map),
    loadBook: async (book) => (map[book] || []).slice(),
  }
}
/** 造段：与 normalizeStoryChunks 的产物同形 */
function mkChunks(book, rows) {
  return rows.map((r, i) => ({ book, title: r[0], piece: 1, total: r[1], text: r[2], index: i }))
}

// =====================================================================================
// 快照：把对外行为逐字段钉死（改动前生成，改动后比对）
// =====================================================================================

/** 抢走 Date.now，让队列 TTL/LRU 用例可复现（player 内部直接调 Date.now）；async fn 也等它跑完再还原 */
async function withFakeClock(startMs, fn) {
  const real = Date.now
  let now = startMs
  Date.now = () => now
  try {
    return await fn({
      tick(ms) { now += ms },
      set(ms) { now = ms },
    })
  } finally {
    Date.now = real
  }
}

/**
 * 跑完整场景矩阵，返回可 JSON 化的记录（所有字段都是确定的）。
 * 场景只走公开 API（start/next/reset/reloadProgress/getProgress/setProgress/confirm/discard/books）。
 */
async function collectSnapshot() {
  const out = {}
  const rec = (r) => (r && r.ok ? {
    ok: true,
    book: r.chunk.book,
    title: r.chunk.title,
    piece: r.chunk.piece,
    total: r.chunk.total,
    isFirst: r.chunk.isFirst,
    isLast: r.chunk.isLast,
    rate: r.chunk.rate,
    remain: r.remain,
    served: r.served && { book: r.served.book, index: r.served.index },
    text: sha(r.chunk.text),
    textLen: r.chunk.text.length,
  } : { ok: false, error: r && r.error })

  // S1：17 本真实书，空进度各开一次（首段字段 + remain）
  {
    const books = {}
    for (const name of realBooks) {
      const p = createStoryPlayer({ repo: repoOf({ [name]: CHUNKS.get(name) }), progressFile: progressFile(), source: 'local' })
      books[name] = rec(await p.start(name, 'c-s1'))
    }
    out.s1_firstChunk = books
  }

  // S2：整本连播（世说新语 1129 段全走；含每段 piece/total/isFirst/isLast/remain/text 摘要）
  {
    const name = mostSegs
    const p = createStoryPlayer({ repo: repoOf({ [name]: CHUNKS.get(name) }), progressFile: progressFile(), source: 'local' })
    const walk = []
    let r = await p.start(name, 'c-s2')
    if (r.ok) walk.push(rec(r))
    for (let i = 1; i < CHUNKS.get(name).length && r.ok; i++) {
      r = await p.next('c-s2')
      if (r.ok) walk.push(rec(r))
    }
    // 讲完一本后的回卷（单书 repo：清进度从头再来，首段重新带开场白）
    const wrap = await p.next('c-s2')
    out.s2_fullWalk = { book: name, len: walk.length, walk, wrap: rec(wrap) }
  }

  // S3：三本书（小书）跨书连播两轮 + 换书时开场白 + remain
  {
    const books = {
      '甲书': mkChunks('甲书', [['甲一', 2, '甲一正文'], ['甲一', 2, '甲二正文'], ['甲二', 3, '甲三正文']]),
      '乙书': mkChunks('乙书', [['乙一', 1, '乙一正文'], ['乙二', 1, '乙二正文']]),
      '丙书': mkChunks('丙书', [['丙一', 2, '丙一正文'], ['丙一', 2, '丙二正文']]),
    }
    const p = createStoryPlayer({ repo: repoOf(books), progressFile: progressFile(), source: 'local' })
    const seqOut = []
    let r = await p.start('乙书', 'c-s3')
    if (r.ok) seqOut.push(rec(r))
    for (let i = 0; i < 10 && r.ok; i++) {
      r = await p.next('c-s3')
      if (r.ok) seqOut.push(rec(r))
    }
    out.s3_crossBook = seqOut
  }

  // S4：进度键迁移 / 跨数据源隔离 / reset / reload / 公开 getProgress、setProgress
  {
    const seed = { '聊斋志异|3': true, '三国演义|7': true, 'local:红楼梦|2': true, 'cloud:红楼梦|4': true, _current: '三国演义' }
    const pf = progressFile(seed)
    const localBooks = {
      '聊斋志异': mkChunks('聊斋志异', [['考城隍', 2, '一'], ['耳中人', 1, '二'], ['尸变', 1, '三'], ['喷水', 1, '四']]),
    }
    const p = createStoryPlayer({ repo: repoOf(localBooks), progressFile: pf, source: 'local' })
    const afterConstruct = readProgress(pf)
    const pick = await p.start('聊斋志异', 'c-s4')
    const resetR = await p.reset('聊斋志异', 'c-s4')
    const afterReset = readProgress(pf)
    const getProbes = [
      p.getProgress('聊斋志异', 0), p.getProgress('聊斋志异', 1), p.getProgress('红楼梦', 2),
      p.getProgress('红楼梦', 4), p.getProgress('三国演义', 7), p.getProgress('聊斋志异', 3),
    ]
    p.setProgress('聊斋志异', 1, true)
    const afterSet = readProgress(pf)
    p.setProgress('聊斋志异', 1, false)
    const afterUnset = readProgress(pf)
    const afterReloadFile = readFileSync(pf, 'utf8')
    p.reloadProgress()
    const afterReload = readProgress(pf)
    out.s4_keys = {
      afterConstruct, pick: rec(pick), reset: resetR.ok ? { ok: true, book: resetR.book } : { ok: false, error: resetR.error },
      afterReset, getProbes, afterSet, afterUnset, afterReloadFileStable: true, afterReload,
    }
    // reset 未知书 / 空书名
    const pf2 = progressFile({ _current: '聊斋志异' })
    const p2 = createStoryPlayer({ repo: repoOf(localBooks), progressFile: pf2, source: 'local' })
    out.s4_resetBad = {
      unknown: await p2.reset('不存在的书', 'c'),
      empty: await p2.reset('  ', 'c'),
      file: readProgress(pf2),
    }
    // 云端装配：同名旧键迁到 cloud:
    const pf3 = progressFile({ '聊斋志异|3': true })
    createStoryPlayer({ repo: repoOf({}), progressFile: pf3, source: 'cloud' })
    out.s4_cloudMigrate = readProgress(pf3)
    // 迁移幂等：二次构造字节不变
    const before = readFileSync(pf3, 'utf8')
    createStoryPlayer({ repo: repoOf({}), progressFile: pf3, source: 'cloud' })
    out.s4_cloudMigrateIdempotent = readFileSync(pf3, 'utf8') === before
  }

  // S5：defer 预约 / confirm / discard / reset 之后的迟到确认 / 旧调用当场落盘
  {
    const book = mkChunks('甲书', [['甲一', 2, '一正文'], ['甲一', 2, '二正文'], ['甲二', 2, '三正文'], ['甲二', 2, '四正文']])
    const mk = (pf) => createStoryPlayer({ repo: repoOf({ '甲书': book }), progressFile: pf, source: 'local' })
    const sfx = (pf) => (existsSync(pf) ? readProgress(pf) : null)

    const pfA = progressFile()
    const pA = mk(pfA)
    const a0 = await pA.start('甲书', 'h1', { defer: true })
    const afterDeferStart = sfx(pfA)
    const c0 = pA.confirm('甲书', 0)
    const afterConfirm = sfx(pfA)
    const a1 = await pA.next('h1', { defer: true })
    const disc = pA.discard('甲书', 1)
    const a2 = await pA.next('h1', { defer: true })
    out.s5_defer = {
      a0: rec(a0), afterDeferStart, confirm: c0, afterConfirm,
      a1: rec(a1), discard: disc, a2: rec(a2),
    }

    const pfB = progressFile()
    const pB = mk(pfB)
    const b0 = await pB.start('甲书', 'h2', { defer: true })
    await pB.reset('甲书', 'h2')
    out.s5_resetLateConfirm = {
      b0: rec(b0),
      lateConfirm: pB.confirm('甲书', 0),
      afterResetPick: rec(await pB.start('甲书', 'h2', { defer: true })),
      file: sfx(pfB),
    }

    const pfC = progressFile()
    const c = await mk(pfC).start('甲书', 'h3')
    out.s5_legacyMode = { pick: rec(c), file: sfx(pfC) }

    // 并发 defer start 不重复选段
    const pfD = progressFile()
    const pD = mk(pfD)
    const [d1, d2] = await Promise.all([pD.start('甲书', 'h4', { defer: true }), pD.start('甲书', 'h4', { defer: true })])
    out.s5_concurrent = [rec(d1), rec(d2)]
  }

  // S6：坏书 / 空书单降级
  {
    const good = mkChunks('好书', [['好一', 1, '好正文'], ['好二', 1, '好二正文']])
    const mixed = createStoryPlayer({ repo: repoOf({ '坏书': [], '好书': good }), progressFile: progressFile(), source: 'local' })
    const r1 = await mixed.start('', 'f1')
    const r2 = await mixed.next('f1')
    const allBad = createStoryPlayer({ repo: repoOf({ '坏书': [], '也坏': [] }), progressFile: progressFile(), source: 'local' })
    const r3 = await allBad.start('', 'f2')
    const empty = createStoryPlayer({ repo: repoOf({}), progressFile: progressFile(), source: 'local' })
    out.s6_badBooks = {
      skipBad: rec(r1), afterBad: rec(r2), allBad: { ok: r3.ok, error: r3.error },
      noBooksStart: { ok: (await empty.start('', 'f3')).ok, error: (await empty.start('', 'f3')).error },
      noBooksNext: { ok: (await empty.next('f3')).ok, error: (await empty.next('f3')).error },
      noBooksBooks: await empty.books(),
    }
  }

  // S7：队列 LRU / TTL（假时钟；16 个客户端上限、30 分钟超时）
  //    用「next 会不会跳段」来观察队列是否还活着：新客户端从当前书挑段，老客户端接着自己的队列走。
  {
    await withFakeClock(1_000_000, async (clock) => {
      const book = mkChunks('队列书', Array.from({ length: 24 }, (_, i) => ['第' + (i % 4) + '回', 6, '段' + i]))
      const p = createStoryPlayer({ repo: repoOf({ '队列书': book }), progressFile: progressFile(), source: 'local' })
      const trace = []
      // 16 个客户端各 start 一次（每个都建立自己的队列），再开第 17 个
      for (let i = 0; i < 16; i++) {
        clock.tick(1000)
        const r = await p.start('队列书', 'cli-' + i)
        trace.push({ i, served: rec(r).served, remain: r.remain })
      }
      clock.tick(1000)
      const seventeen = await p.start('队列书', 'cli-16')
      trace.push({ i: 16, served: rec(seventeen).served, remain: seventeen.remain })
      // 最早那个客户端（被 LRU 踢掉的）再来一次：应重新挑段而不是接着旧队列
      clock.tick(1000)
      const revived = await p.next('cli-0')
      trace.push({ i: 'cli-0-after-evict', served: rec(revived).served, remain: revived.remain })
      // 超过 TTL 的客户端：队列被清（下次 next 重新挑）
      clock.tick(31 * 60 * 1000)
      const afterTtl = await p.next('cli-15')
      trace.push({ i: 'cli-15-after-ttl', served: rec(afterTtl).served, remain: afterTtl.remain })
      out.s7_queue = trace
    })
  }

  // S8：非空 progress 时 pickNext 的选段（含「当前书指针」「跨书跳过已读」）
  {
    const books = {
      '甲书': mkChunks('甲书', [['甲一', 2, 'a0'], ['甲一', 2, 'a1'], ['甲二', 2, 'a2'], ['甲二', 2, 'a3']]),
      '乙书': mkChunks('乙书', [['乙一', 1, 'b0'], ['乙二', 1, 'b1']]),
    }
    const pf = progressFile({
      'local:甲书|0': true, 'local:甲书|1': true, _current: '甲书',
      'cloud:乙书|0': true,
    })
    const p = createStoryPlayer({ repo: repoOf(books), progressFile: pf, source: 'local' })
    const r1 = await p.start('', 'c8')        // 接着甲书：应从第 2 段起
    const r2 = await p.start('乙书', 'c8')    // 换书：云端键不算本地进度
    out.s8_currentPointer = { r1: rec(r1), r2: rec(r2) }
  }

  return out
}

// =====================================================================================
// 基准（真实数据；改前/改后同一套测法）
// =====================================================================================

async function runBench() {
  const R = {}
  console.log('\n[B] 基准（真实数据；单位 ms，三列 = min / p50 / mean）')
  console.log('    gc=' + (HAS_GC ? 'on' : 'off（粗测；加 --expose-gc 更准）') + '  node=' + process.version)

  // B0 旧算法复现（改动前的 planSegments + queueAfter，逐字照抄；只作「同一台机器上的拆解参照」）
  //     —— 新实现不再整本建 plan/队列对象，所以这里单独量一份旧算法，用来解释改前数字花在哪。
  {
    const name = mostSegs
    const chunks = CHUNKS.get(name)
    const source = 'local'
    const emptyProgress = {}
    const emptyPending = new Map()
    const keyOf = (book, index) => source + ':' + String(book || '') + '|' + String(index)
    const legacyOf = (book, index) => String(book || '') + '|' + String(index)
    const isTakenOld = (book, index) => emptyProgress[keyOf(book, index)] === true ||
      emptyProgress[legacyOf(book, index)] === true || emptyPending.has(keyOf(book, index))
    const planOld = (list) => {
      const plan = new Map()
      const n = list.length
      let i = 0
      while (i < n) {
        const title = String(list[i].title || '')
        let j = i + 1
        while (j < n && String(list[j].title || '') === title) j++
        for (let k = i; k < j; k++) {
          const bookWide = Number(list[k].total) === n
          plan.set(String(list[k].index), {
            piece: bookWide ? k + 1 : k - i + 1, total: bookWide ? n : j - i,
            endsChapter: k === j - 1, endsBook: k === n - 1,
          })
        }
        i = j
      }
      return plan
    }
    const queueOld = (plan, list, book, afterIndex) => list
      .filter((c) => Number(c.index) > afterIndex && !isTakenOld(book, c.index))
      .sort((a, b) => Number(a.index) - Number(b.index))
      .map((c) => ({ chunk: c, ...(plan.get(String(c.index)) || { piece: 1, total: 1, endsChapter: false, endsBook: false }) }))
    const planMs = bench(() => planOld(chunks), { reps: 11, warmup: 3 })
    const plan = planOld(chunks)
    const queueMs = bench(() => queueOld(plan, chunks, name, -1), { reps: 11, warmup: 3 })
    const bothMs = bench(() => queueOld(planOld(chunks), chunks, name, -1), { reps: 11, warmup: 3 })
    R.refOldAlgo = { book: name, n: chunks.length, planMs, queueMs, planPlusQueueMs: bothMs }
    console.log('  · [参照] 旧算法复现（' + name + '，' + chunks.length + ' 段）：planSegments ' + fmtRow(planMs) +
      '；queueAfter ' + fmtRow(queueMs) + '；合计 ' + fmtRow(bothMs) + 'ms')
  }

  // B1 冷读：JSON.parse + normalize（主线程口径）
  {
    const name = biggest
    const text = RAW.get(name).text
    const parsed = bench(() => { JSON.parse(text.replace(/^\uFEFF/, '')) }, { reps: 5, warmup: 1 })
    const norm = bench(() => { normalizeStoryChunks(name, RAW.get(name).raw) }, { reps: 5, warmup: 1 })
    gcNow()
    const h0 = heapMB()
    let kept = null
    const t0 = process.hrtime.bigint()
    const raw2 = JSON.parse(text.replace(/^\uFEFF/, ''))
    const chunks2 = normalizeStoryChunks(name, raw2)
    const t1 = process.hrtime.bigint()
    gcNow()
    const h1 = heapMB()
    kept = { raw: raw2.length, normalized: chunks2.length }
    void chunks2
    R.coldParse = {
      book: name, bytes: text.length, segments: kept.normalized,
      parseMs: parsed, normalizeMs: norm, parsePlusNormalizeMs: Number(t1 - t0) / 1e6,
      retainedMB: h1 - h0,
    }
    console.log('  · 冷读 ' + name + '（' + (text.length / 1048576).toFixed(2) + 'MB / ' + kept.normalized + ' 段）' +
      '：parse ' + fmtRow(parsed) + '；normalize ' + fmtRow(norm) +
      '；parse+normalize ' + fmt(R.coldParse.parsePlusNormalizeMs) + '；保留堆 +' + R.coldParse.retainedMB.toFixed(1) + 'MB')
  }

  // B2 真实 repo：Worker 冷读 / 缓存命中 / listBooks
  if (existsSync(WORKER_PATH)) {
    const repo = createStoryRepo({ dataDir: DATA_DIR, workerPath: WORKER_PATH })
    gcNow()
    const h0 = heapMB()
    const t0 = process.hrtime.bigint()
    const cold = await repo.loadBook(biggest)
    const t1 = process.hrtime.bigint()
    gcNow()
    const h1 = heapMB()
    const cold2 = await repo.loadBook(mostSegs)
    const t2 = process.hrtime.bigint()
    gcNow()
    const h2 = heapMB()
    const hit = await benchAsync(async () => { await repo.loadBook(biggest) }, { reps: 9 })
    const list = await benchAsync(async () => { await repo.listBooks() }, { reps: 15 })
    // 进程内第一次 listBooks（含模块/JIT 热身），与上面的热值分开看
    let listFirstMs = 0
    {
      const fresh = createStoryRepo({ dataDir: DATA_DIR, workerPath: WORKER_PATH })
      const t = process.hrtime.bigint()
      await fresh.listBooks()
      listFirstMs = Number(process.hrtime.bigint() - t) / 1e6
    }
    const booksList = await repo.listBooks()
    R.repo = {
      coldWorkerMs: Number(t1 - t0) / 1e6,
      coldWorkerSecondBookMs: Number(t2 - t1) / 1e6,
      coldRetainedMB: h1 - h0,
      twoBooksRetainedMB: h2 - h0,
      segmentsFirst: cold.length,
      segmentsSecond: cold2.length,
      hitMs: hit,
      listBooksMs: list,
      listBooksFirstMs: listFirstMs,
      listBooksCount: booksList.length,
    }
    console.log('  · repo 冷读（Worker）' + biggest + ' ' + fmt(R.repo.coldWorkerMs) + 'ms，第二本 ' + mostSegs + ' ' +
      fmt(R.repo.coldWorkerSecondBookMs) + 'ms；保留堆 ' + R.repo.coldRetainedMB.toFixed(1) + ' / 两本 ' + R.repo.twoBooksRetainedMB.toFixed(1) + 'MB')
    console.log('  · repo 缓存命中（含浅拷贝 ' + cold.length + ' 元素）' + fmtRow(hit) + 'ms/次；listBooks（' + booksList.length +
      ' 本，每次真 readdir）' + fmtRow(list) + 'ms/次（进程内首次 ' + fmt(listFirstMs) + 'ms）')
  } else {
    console.log('  · 跳过 repo Worker 基准：dist/story-worker.js 不存在（先 npm run build）')
  }

  // B3 start()：分段位置 + 建队列（假 repo，隔离算法本身；defer 不落盘，测的是纯算法）
  //     注意 start 是 async：只计时同步段会把测量值压成 0，必须 await 到真正返回。
  {
    const rows = {}
    for (const name of [mostSegs, biggest, '西游记', '儒林外史']) {
      const chunks = CHUNKS.get(name)
      // 逐轮配对：同一轮里先构造 player（读空进度文件），紧接着用它 start，分别计时。
      let player = null
      const two = await benchTwoPhase(async () => {
        player = createStoryPlayer({ repo: repoOf({ [name]: chunks }), progressFile: progressFile(), source: 'local' })
      }, async (i) => {
        await player.start(name, 'bench-' + i, { defer: true })
      }, { reps: 9, warmup: 3 })
      rows[name] = { segments: chunks.length, constructMs: two.first, startWorkMs: two.second, startMs: two.total }
    }
    R.start = rows
    for (const name of Object.keys(rows)) {
      const x = rows[name]
      console.log('  · start(' + name + '，' + x.segments + ' 段，空进度全队列，defer)：' + fmtRow(x.startMs) +
        'ms（构造 player ' + fmtRow(x.constructMs) + ' + 选段/建队列 ' + fmtRow(x.startWorkMs) + '）')
    }
  }

  // B4 pickNext 扫描：进度文件 0 / 500 / 1000 / 2000 条已讲时，选下一段扫多少段、多久（defer，不落盘）
  {
    const name = mostSegs           // 1129 段
    const chunks = CHUNKS.get(name)
    const other = ['封神演义', '杨家将演义', '老残游记']
    const results = {}
    for (const target of [0, 500, 1000, 2000]) {
      // 构造 target 条进度键：先铺满目标书的前缀（最多 n-1 条），不足的用别的书补足
      const seed = {}
      let need = target
      const own = Math.min(need, chunks.length - 1)
      for (let i = 0; i < own; i++) seed['local:' + name + '|' + i] = true
      need -= own
      let bi = 0
      while (need > 0) {
        const b = other[bi % other.length]
        const bn = CHUNKS.get(b).length
        for (let i = 0; i < bn && need > 0; i++) { seed['local:' + b + '|' + i] = true; need-- }
        bi++
        if (bi > 50) break
      }
      const pf = progressFile(seed)
      // 逐轮配对：① 只构造 player（读进度文件 + JSON.parse + 迁移）= 重启后的一次性成本；
      //            ② 同一轮里再构造一个 player 并 start → 扣掉 ① 剩下的就是「扫描 + 分段位置 + 建队列」。
      let player = null
      const two = await benchTwoPhase(async () => {
        player = createStoryPlayer({ repo: repoOf({ [name]: chunks }), progressFile: pf, source: 'local' })
      }, async () => {
        await player.start(name, 'bench', { defer: true })
      }, { reps: 9, warmup: 3 })
      results[target] = {
        progressKeys: Object.keys(seed).length,
        scannedSegments: own + 1,
        constructMs: two.first,
        startWorkMs: two.second,
        startMs: two.total,
      }
    }
    R.pickNextScan = { book: name, n: chunks.length, cases: results }
    for (const k of Object.keys(results)) {
      console.log('  · pickNext 进度 ' + results[k].progressKeys + ' 条（' + name + ' 命中前扫 ' + results[k].scannedSegments +
        ' 段，defer 不落盘）：start 总 ' + fmtRow(results[k].startMs) + 'ms（其中读进度文件 ' + fmtRow(results[k].constructMs) +
        '，选段+建队列 ' + fmtRow(results[k].startWorkMs) + '）')
    }
  }

  // B5 next()：生产路径（defer，不落盘）与旧语义（当场落盘）分开测
  {
    const name = mostSegs
    const chunks = CHUNKS.get(name)
    const mk = async (defer) => {
      const p = createStoryPlayer({ repo: repoOf({ [name]: chunks }), progressFile: progressFile(), source: 'local' })
      await p.start(name, 'hot', { defer })
      return p
    }
    const pDefer = await mk(true)
    const warmDefer = await benchAsync(async () => { await pDefer.next('hot', { defer: true }) }, { reps: 25, warmup: 5 })
    const pLegacy = await mk(false)
    const warmLegacy = await benchAsync(async () => { await pLegacy.next('hot') }, { reps: 15, warmup: 3 })
    R.next = { warmDeferMs: warmDefer, warmLegacyMs: warmLegacy }
    console.log('  · next() 队列命中（' + name + '）：生产路径 defer ' + fmtRow(warmDefer) + 'ms/次；旧语义（每段落盘）' + fmtRow(warmLegacy) + 'ms/次')
  }

  // B6 每段确认后的落盘（writeJsonAtomic，整份进度重写；progress 越大越贵）
  {
    const seed = {}
    for (let i = 0; i < 2000; i++) seed['local:某书|' + i] = true
    const pf = progressFile(seed)
    const p = createStoryPlayer({ repo: repoOf({}), progressFile: pf, source: 'local' })
    const w = bench(() => { p.setProgress('某书', 1, true) }, { reps: 15, warmup: 3 })
    R.confirmWrite = { keys: 2000, ms: w }
    console.log('  · 每段落盘（2000 条进度整份重写，writeJsonAtomic）：' + fmtRow(w) + 'ms/次')
  }

  // B7 键构造微基准：每扫一段拼几次键（旧实现 3 次 / 新实现 0~1 次）
  {
    const name = mostSegs
    const chunks = CHUNKS.get(name)
    const source = 'local'
    const book = name
    const three = bench(() => {
      for (let i = 0; i < chunks.length; i++) {
        const k1 = source + ':' + String(book || '') + '|' + String(i)
        const k2 = String(book || '') + '|' + String(i)
        const k3 = source + ':' + String(book || '') + '|' + String(i)
        void k1; void k2; void k3
      }
    }, { reps: 7, warmup: 2 })
    const one = bench(() => {
      const prefix = source + ':' + String(book || '') + '|'
      for (let i = 0; i < chunks.length; i++) { const k1 = prefix + i; void k1 }
    }, { reps: 7, warmup: 2 })
    R.keyBuild = { segments: chunks.length, threeConcatsMs: three, onePrefixMs: one }
    console.log('  · 键构造（' + chunks.length + ' 段）：每段拼 3 次 ' + fmtRow(three) + 'ms；前缀预拼 + 1 次 ' + fmtRow(one) + 'ms')
  }

  // B8 内存：书缓存（LRU 2 本）+ 队列 + 进度对象的量级
  {
    const repo = existsSync(WORKER_PATH) ? createStoryRepo({ dataDir: DATA_DIR, workerPath: WORKER_PATH }) : null
    if (repo) {
      gcNow(); const h0 = heapMB()
      const a = await repo.loadBook(biggest)      // 6.4MB 书
      gcNow(); const h1 = heapMB()
      const b = await repo.loadBook(mostSegs)     // 1129 段书
      gcNow(); const h2 = heapMB()
      const c = await repo.loadBook('西游记')     // 第三本：挤掉最早的一本（LRU=2）
      gcNow(); const h3 = heapMB()
      R.memoryRepo = {
        firstMB: h1 - h0,
        twoMB: h2 - h0,
        afterThirdMB: h3 - h0,
        firstSegs: a.length, secondSegs: b.length, thirdSegs: c.length,
        rssMB: rssMB(),
      }
      console.log('  · 书缓存内存：第 1 本 +' + (h1 - h0).toFixed(1) + 'MB；2 本 +' + (h2 - h0).toFixed(1) +
        'MB；第 3 本（LRU 挤掉最旧）后 +' + (h3 - h0).toFixed(1) + 'MB')
    }
    // 队列/plan 的内存量级：同一个 player start 一本 1129 段的书之后保留的堆
    const chunks = CHUNKS.get(mostSegs)
    gcNow(); const q0 = heapMB()
    const players = []
    for (let i = 0; i < 3; i++) {
      const p = createStoryPlayer({ repo: repoOf({ [mostSegs]: chunks }), progressFile: progressFile(), source: 'local' })
      await p.start(mostSegs, 'mem-' + i)
      players.push(p)
    }
    gcNow(); const q1 = heapMB()
    R.memoryQueues = { players: players.length, segments: chunks.length, mb: q1 - q0 }
    console.log('  · 连播队列内存：3 个客户端 × ' + chunks.length + ' 段队列 +' + (q1 - q0).toFixed(1) + 'MB（' +
      ((q1 - q0) * 1024 / (players.length * chunks.length)).toFixed(2) + 'KB/段·客户端）')
  }

  // B10 分配压力（小 GC 次数）：同样 300 次「挑段 + 建满队列」，旧实现每段多造
  //     1 个分段位置对象 + 1 条 Map 项 + 1 个队列对象，垃圾多则小 GC 更频繁。
  //     这里只报告、不做护栏（GC 次数受堆状态影响，不适合当阈值）。
  {
    const name = mostSegs
    const chunks = CHUNKS.get(name)
    const pf = progressFile()
    let gcs = 0
    let observer = null
    try {
      observer = new PerformanceObserver((list) => { gcs += list.getEntries().length })
      observer.observe({ entryTypes: ['gc'] })
    } catch { observer = null }
    if (observer === null) {
      console.log('  · [分配压力] 跳过：本 Node 不支持 PerformanceObserver(gc)')
    } else {
      await new Promise((r) => setTimeout(r, 40))          // 让测量开始前已排队的事件先落地
      const base = gcs
      const t0 = process.hrtime.bigint()
      for (let i = 0; i < 300; i++) {
        // defer + 每次新 player：不落盘、progress 保持为空，300 次的活完全一样
        const p = createStoryPlayer({ repo: repoOf({ [name]: chunks }), progressFile: pf, source: 'local' })
        await p.start(name, 'gc-' + i, { defer: true })
      }
      const totalMs = Number(process.hrtime.bigint() - t0) / 1e6
      await new Promise((r) => setTimeout(r, 120))          // 等 GC 事件投递
      observer.disconnect()
      R.gcPressure = { starts: 300, segments: chunks.length, gcEvents: gcs - base, totalMs }
      console.log('  · [分配压力] 300 次 start(' + chunks.length + ' 段)：小 GC ' + (gcs - base) + ' 次，总耗时 ' +
        fmt(totalMs) + 'ms（' + fmt(totalMs / 300) + 'ms/次）')
    }
  }

  // B9 调用次数：一次 start / 一次 next（队列命中 / 队列空）到底向 repo 要了几次东西
  //     —— 这两个调用是「每次请求的固定开销」，数量本身不该随书变大。
  {
    const name = mostSegs
    const chunks = CHUNKS.get(name)
    const counter = { listBooks: 0, loadBook: 0 }
    const countingRepo = {
      listBooks: async () => { counter.listBooks++; return Object.keys({ [name]: chunks }) },
      loadBook: async (b) => { counter.loadBook++; return (b === name ? chunks : []).slice() },
    }
    const p = createStoryPlayer({ repo: countingRepo, progressFile: progressFile(), source: 'local' })
    const take = async (fn) => { counter.listBooks = 0; counter.loadBook = 0; await fn(); return { ...counter } }
    const perStart = await take(() => p.start(name, 'count', { defer: true }))
    const perNextHit = await take(() => p.next('count', { defer: true }))
    const perNextMiss = await take(() => p.next('count2', { defer: true }))   // 新客户端 → 队列空 → pickNext
    R.calls = { start: perStart, nextQueueHit: perNextHit, nextQueueMiss: perNextMiss }
    console.log('  · 调用次数：start → listBooks ' + perStart.listBooks + ' / loadBook ' + perStart.loadBook +
      '；next（队列命中）→ ' + perNextHit.listBooks + ' / ' + perNextHit.loadBook +
      '；next（队列空、重新挑段）→ ' + perNextMiss.listBooks + ' / ' + perNextMiss.loadBook)
  }

  return R
}

// =====================================================================================
// 行为等价：内嵌基线快照
// =====================================================================================

/** 改动前（基线 4565e0d）用本文件同一份 collectSnapshot() 跑出来的结果，gzip+base64 */
const BASELINE_SNAPSHOT_GZ_B64 = 'H4sIAAAAAAACCtzdW6+tR3kv+K9iLanv3FI9x6qH25b21b7vi77YqqMahU5ageze0hbSMoeAMeYQwBwMAcIxgI0hNvEB8IfJmnOtddVfofUu9o6rhuewRo355KbvErES5n+Md7zvv+qt+tV/f/BJ+C/j43/7yU/9b//n3/31Xz342H9/8OjtFx/9+UeP3v3mo3dePP73v/mrBx/71N/+XX/+Qfmb439e/8HzDz718U99oj/42IMnr//56XfefPLGS4/efvPRu7+4ffmfbn76q5vXvvb//vHLNz976fi/eOfF21ffv33tvdtvff3x975w88vvPHj+wf/98V77g4/B8w8+9Tefyp948DF6/sHHP/mfjr/of/7XfvyT/zkf/9vIn/hkf/7B3+ZPHf91/yuF/+XB8w/+tv9f+eN//eBjGOX5B5/sf/tfezv+6Lv/1I//dev/7cHHwqeff/Cp/t8+9eBjDyRWCSaAlkFbhgd/+U/+cz/+XyLIp58//n/cvPqn2z9+1OfxwT/44PN4/JvfPHr74c2r//hvDx/evP7m7Y8/e/Pqa09+96vbH7zx6O0XH7/3jUfvvPhvDx/evvLPT9/73M2//vnJS797+urnnv78lce/funmSz90/GyIznw285/94c8GJFQBLF0hsNJYPhtI9JfP5skvHz5698u3L71852dz88p7j95+5fY7X3nyy4cf/mxe/tfnnvzDSzeff/PmGz97+oWXH/3xe4+/+vLjr/7oyY9/fVd8CNflhyDx7g/ggz/+rg/AYhtsIVAeEYvhenEEe/YBvPLkt2/evvLGk9++dubimP7BBx/AzZ//9cmPv/yXj+HOqIB2ZVjAdGfY5e/4cNgBwSpLrXkIRMlzWID0LOv3b77+y5svfvvm1T/dvP/tM3HXf7N85fD41z967ubFl/9yLXw485VXd9I7857+IR+OXEswIW15NGhUlh8/IOGnn39w87l/uP3Hb9/89JWbr/7+7gt8/gdr2idf+oxjTLjzBnfyX//hjKE1SzlGQLYRSly/VoUj4+vfufn+u4+/8sbNn/7pyetv3B3z5N/ccZt77vb7r95+8Ws3X3v55rWfP/7nPzx5/bWnP/7Tzefef+7J67+/+eIfnrz47qN3fvz4vc/fvPTKzde+8uT9V+/6dPjKi+DOi/7Df/WHP6AuOGICCRmGaGgnP/LjX968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'

function deepDiff(a, b, path = '') {
  if (a === b) return null
  const ta = Array.isArray(a) ? 'array' : a === null ? 'null' : typeof a
  const tb = Array.isArray(b) ? 'array' : b === null ? 'null' : typeof b
  if (ta !== tb) return path + ': 类型不同（' + ta + ' ≠ ' + tb + '）'
  if (ta === 'array') {
    if (a.length !== b.length) return path + '.length: ' + a.length + ' ≠ ' + b.length
    for (let i = 0; i < a.length; i++) {
      const d = deepDiff(a[i], b[i], path + '[' + i + ']')
      if (d) return d
    }
    return null
  }
  if (ta === 'object') {
    const ka = Object.keys(a).sort()
    const kb = Object.keys(b).sort()
    if (ka.join(',') !== kb.join(',')) return path + ': 键集不同（' + ka.join(',') + ' ≠ ' + kb.join(',') + '）'
    for (const k of ka) {
      const d = deepDiff(a[k], b[k], path ? path + '.' + k : k)
      if (d) return d
    }
    return null
  }
  return path + ': ' + JSON.stringify(a) + ' ≠ ' + JSON.stringify(b)
}

// =====================================================================================
// 主流程
// =====================================================================================

const snapshot = MODE_BENCH_ONLY ? null : await collectSnapshot()
const snapshotJson = snapshot === null ? '' : JSON.stringify(snapshot)
if (snapshot !== null) {
  console.log('\n[1] 行为快照：' + (snapshotJson.length / 1024).toFixed(1) + 'KB，sha1=' + sha(snapshotJson))
}

if (MODE_SNAPSHOT) {
  console.log('\n=== SNAPSHOT GZIP BASE64（粘贴到 BASELINE_SNAPSHOT_GZ_B64）===')
  console.log(gzipSync(Buffer.from(snapshotJson, 'utf8'), { level: 9 }).toString('base64'))
  try { rmSync(TMP, { recursive: true, force: true }) } catch { }
  process.exit(0)
}

const benchResult = await runBench()

if (MODE_BENCH_ONLY) {
  console.log('\n=== BENCH JSON ===')
  console.log(JSON.stringify(benchResult, null, 2))
  try { rmSync(TMP, { recursive: true, force: true }) } catch { }
  process.exit(0)
}

console.log('\n[2] 行为等价：与基线快照逐字段比对')
if (!BASELINE_SNAPSHOT_GZ_B64) {
  console.log('  · 跳过：基线快照还没内嵌（用 --snapshot 生成后贴回本文件）')
} else if (snapshot === null) {
  console.log('  · 跳过：--bench 模式不跑等价比对')
} else {
  const baseline = JSON.parse(gunzipSync(Buffer.from(BASELINE_SNAPSHOT_GZ_B64, 'base64')).toString('utf8'))
  const diff = deepDiff(baseline, snapshot)
  ok('17 本真实书首段 / 1129 段整本连播 / 跨书回卷 / 键迁移 / defer / 队列 LRU / 降级：逐字段与基线一致',
    diff === null, diff ? '第一个差异 → ' + diff : '快照 ' + (snapshotJson.length / 1024).toFixed(1) + 'KB 完全一致')
}

console.log('\n[3] 性能护栏（宽松阈值：只在复杂度退化时红）')
{
  // ① 「重启后接着讲」：进度 2000 条、当前书已经讲到末段，start 仍要是一次请求的量级。
  //    旧实现每扫一段现拼 3 个键 + 每次整本建 plan；这一条只在「有人把逐段全量扫描/落盘写回热路径」时才红。
  //    阈值 20ms：实测 2~7ms（含 2000 条进度的读盘与解析），留 3~10 倍余量；真要退化回旧写法也到不了 20ms，
  //    所以它守的是「量级」而不是「新旧差异」——新旧差异由 [2] 的等价快照和报告里的 A/B 数字负责。
  const name = mostSegs
  const chunks = CHUNKS.get(name)
  const seed = {}
  for (let i = 0; i < chunks.length - 1; i++) seed['local:' + name + '|' + i] = true
  for (let i = 0; i < 2000 - (chunks.length - 1); i++) seed['local:封神演义|' + i] = true
  const pf = progressFile(seed)
  const r = await benchAsync(async () => {
    const p = createStoryPlayer({ repo: repoOf({ [name]: chunks }), progressFile: pf, source: 'local' })
    const picked = await p.start(name, 'guard', { defer: true })
    if (!picked.ok) throw new Error('start failed: ' + picked.error)
  }, { reps: 9, warmup: 3 })
  ok('2000 条进度 + 扫 ' + (chunks.length - 1) + ' 段选段：start p50 < 20ms（实测 ' + fmt(r.p50) + 'ms）',
    r.p50 < 20, 'min=' + fmt(r.min) + ' ms；进度键 ' + Object.keys(seed).length + ' 条')
}

{
  // ② start 一本 1129 段的书（分段位置 + 建满队列）不该到几十毫秒。注意 start 是 async，
  //    必须 await 到真正返回再计时——只计同步段会得到「0ms 全绿」的假护栏。
  const name = mostSegs
  const chunks = CHUNKS.get(name)
  const r = await benchAsync(async () => {
    const p = createStoryPlayer({ repo: repoOf({ [name]: chunks }), progressFile: progressFile(), source: 'local' })
    await p.start(name, 'guard2', { defer: true })
  }, { reps: 9, warmup: 3 })
  ok('start() 建满队列（' + chunks.length + ' 段）p50 < 25ms（实测 ' + fmt(r.p50) + 'ms）',
    r.p50 < 25, 'min=' + fmt(r.min) + ' / p50=' + fmt(r.p50))
}

{
  // ③ 热路径 next()（队列命中）不该有 I/O 级耗时：这一段每讲一段就调一次，
  //    一旦有人把落盘/整本扫描搬回来，这里立刻从微秒级跳到毫秒级。
  const name = mostSegs
  const chunks = CHUNKS.get(name)
  const p = createStoryPlayer({ repo: repoOf({ [name]: chunks }), progressFile: progressFile(), source: 'local' })
  await p.start(name, 'guard3', { defer: true })
  const w = await benchAsync(async () => { await p.next('guard3', { defer: true }) }, { reps: 20, warmup: 5 })
  ok('next() 队列命中 p50 < 5ms（实测 ' + fmt(w.p50) + 'ms）', w.p50 < 5, 'min=' + fmt(w.min) + ' p50=' + fmt(w.p50))
}

{
  // ④ 连播队列内存不该随段数爆掉：段数 × 客户端的驻留内存要明显小于「每段一个小对象」的量级。
  //    没有 --expose-gc 时 GC 不清干净，这一条会跳过（宁可不测，也不要给出假结论）。
  if (!HAS_GC) {
    console.log('  · 跳过内存护栏：需要 node --expose-gc')
  } else {
    const name = mostSegs
    const chunks = CHUNKS.get(name)
    gcNow(); const h0 = heapMB()
    const ps = []
    for (let i = 0; i < 3; i++) {
      const p = createStoryPlayer({ repo: repoOf({ [name]: chunks }), progressFile: progressFile(), source: 'local' })
      await p.start(name, 'mem-' + i, { defer: true })
      ps.push(p)
    }
    gcNow(); const h1 = heapMB()
    const mb = h1 - h0
    ok('3 个客户端 × ' + chunks.length + ' 段连播队列驻留 < 0.8MB（实测 ' + mb.toFixed(2) + 'MB）',
      mb < 0.8 && ps.length === 3, ((mb * 1024) / (3 * chunks.length)).toFixed(2) + 'KB/段·客户端')
  }
}

{
  // ⑤ 书单必须「每次真枚举」：目录一有增删就立刻反映。
  //    这条护栏的来历：本次曾试过用「目录 mtime/ino/size 指纹」缓存书单（把 ~0.28ms 降到 ~0.02ms），
  //    但 Windows 的目录时间戳来自系统时钟（同一时钟粒度内的两次改动可能拿到同一个 mtimeNs），
  //    240 次增删压测里实测 1 次返回了旧书单——对「不改变任何对外行为」不可接受，
  //    所以书单缓存**已撤销**。这里把反面结论钉住：谁想再加缓存，先让这条断言全绿。
  const dir = join(TMP, 'repo-list')
  mkdirSync(join(dir, 'story'), { recursive: true })
  if (!existsSync(WORKER_PATH)) {
    console.log('  · 跳过书单断言：dist/story-worker.js 不存在（先 npm run build）')
  } else {
    const repo = createStoryRepo({ dataDir: dir, workerPath: WORKER_PATH })
    const a1 = await repo.listBooks()
    const a2 = await repo.listBooks()
    writeFileSync(join(dir, 'story', '新书.json'), JSON.stringify([{ book: '新书', title: '一', total: 1, text: '正文' }]))
    const b1 = await repo.listBooks()
    writeFileSync(join(dir, 'story', '另一本.json'), JSON.stringify([{ book: '另一本', title: '一', total: 1, text: '正文' }]))
    const b2 = await repo.listBooks()
    rmSync(join(dir, 'story', '新书.json'))
    const c1 = await repo.listBooks()
    // 只改内容、不增删：书单不变
    writeFileSync(join(dir, 'story', '另一本.json'), JSON.stringify([{ book: '另一本', title: '二', total: 1, text: '改过正文' }]))
    const c2 = await repo.listBooks()
    ok('书单：连续两次结果一致，且返回不同数组实例（调用方可随意排序）',
      a1.join(',') === a2.join(',') && a1 !== a2)
    ok('书单：新增一本立刻出现在书单里（不等重启、不等 TTL）',
      b1.indexOf('新书') >= 0 && b2.join(',') === '另一本,新书', JSON.stringify(b2))
    ok('书单：删除一本立刻从书单里消失', c1.join(',') === '另一本', JSON.stringify(c1))
    ok('书单：只改文件内容不动书单', c2.join(',') === '另一本', JSON.stringify(c2))
  }
}

try { rmSync(TMP, { recursive: true, force: true }) } catch { }
console.log('\n────────────────────')
console.log((fail === 0 ? '✅ ' : '❌ ') + '通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
