/**
 * scripts/test-store-cache.mjs —— host/cache.ts + host/atomic.ts + host/store.ts 的永久回归
 *
 * 背景（B63 缓存/存储分身审计）：
 *   缓存与存储坏了都不会当场报错，只会「悄悄给旧值 / 悄悄漏文件 / 悄悄吃掉容量」。
 *   本脚本按源码真实语义逐条钉住：拷贝隔离、LRU、TTL、并发、原子写、坏文件隔离、门面形状。
 *
 * 覆盖：
 *   [A] cache 端口契约：get/set/memGet/memSet 一律拷贝隔离；Buffer 不被降级
 *   [B] 内存 LRU 与双上限（条目数 / 字节数），正常写入不提前驱逐（字节计数不漂移）
 *   [C] TTL / maxAge：内存命中也按磁盘 mtime 复核；memSet 的 ttl 生效
 *   [D] 并发：旧读请求不得把刚写入的新值顶回去（回归）；并发写同一 key 文件始终合法
 *   [E] 坏条目：坏 JSON 不抛、能自愈；带 BOM 的缓存文件仍可解析
 *   [F] 写失败留痕且不留半截临时文件（改名失败路径）
 *   [G] key 归一化取证：调用方 key 一律纯 hex（文件名安全）
 *   [H] atomic：成功/覆盖/失败回滚/重试/坏文件隔离/BOM（含「写失败不留 .tmp」回归）
 *   [I] cache 磁盘 prune：超上限按 mtime 删最旧的一半，新写入必须幸存
 *   [J] store 门面：只做组合、load* 每次给新对象（不泄漏内部 json）、各仓储往返
 *
 * 纯离线（不联网、不起 HTTP、不碰 dist），直接加载 src/*.ts。
 * 用法：node scripts/test-store-cache.mjs      # 失败退出码 1
 */
import { register } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, utimesSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
register(new URL('./ts-resolve.mjs', import.meta.url))
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href)

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
process.on('exit', () => {
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }) } catch { } }
})

/** 静默执行一段预期会打日志的代码，返回日志行（用于断言「失败必须留痕」） */
async function withLogs(fn) {
  const lines = []
  const real = console.error
  console.error = (...a) => { lines.push(a.join(' ')) }
  try { await fn() } finally { console.error = real }
  return lines
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmpLeft = (dir) => readdirSync(dir).filter((f) => f.endsWith('.tmp'))
const hex40 = /^[0-9a-f]{40}$/

const { createCache, hashKey, shortHash, hashBytes } = await imp('src/host/cache.ts')
const atomic = await imp('src/host/atomic.ts')
const { createStore } = await imp('src/host/store.ts')

// ---------- [A] cache 端口契约：拷贝隔离 ----------
console.log('\n[A] cache 端口契约（拷贝隔离 / Buffer）')
{
  const dir = mkTmp('b63-cache-clone-')
  const cache = createCache({ dir })

  const obj = { text: '你好', n: 1 }
  await cache.setJson('k1', obj)
  obj.text = '调用方改了'
  const got = await cache.getJson('k1', 'json')
  ok('setJson 写入时拷贝：改调用方对象不影响缓存', got && got.text === '你好')

  got.text = '读取方改了'
  const got2 = await cache.getJson('k1', 'json')
  ok('getJson 读取时拷贝：改返回值不影响缓存', got2 && got2.text === '你好')

  const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x64])
  await cache.setJson('b1', mp3, 'mp3')
  const back = await cache.getJson('b1', 'mp3')
  ok('二进制仍是 Buffer（structuredClone 会降级成 Uint8Array）', Buffer.isBuffer(back))
  ok('二进制内容一致', Buffer.isBuffer(back) && back.equals(mp3))

  const live = { n: 1 }
  cache.memSet('m1', live)
  live.n = 2
  ok('memSet 写入时拷贝（坑 27 同类：不把调用方对象存进内部）', cache.memGet('m1').n === 1, 'n=' + cache.memGet('m1').n)

  const read1 = cache.memGet('m1')
  read1.n = 99
  ok('memGet 读取时拷贝：改返回值不影响缓存', cache.memGet('m1').n === 1)
  rmSync(dir, { recursive: true, force: true })
}

// ---------- [B] 内存 LRU 与双上限 ----------
console.log('\n[B] 内存 LRU 与容量上限')
{
  const dir = mkTmp('b63-cache-lru-')
  const c1 = createCache({ dir, memLimit: 2 })
  c1.memSet('a', 1); c1.memSet('b', 2); c1.memSet('c', 3)
  ok('条目上限 2：第 3 条写入淘汰最旧 a', c1.memGet('a') === undefined)
  ok('条目上限 2：b / c 仍在', c1.memGet('b') === 2 && c1.memGet('c') === 3)

  const dir2 = mkTmp('b63-cache-lru2-')
  const c2 = createCache({ dir: dir2, memLimit: 2 })
  c2.memSet('a', 1); c2.memSet('b', 2)
  c2.memGet('a')                       // 命中刷新 LRU
  c2.memSet('c', 3)
  ok('命中刷新 LRU：淘汰的是 b 不是 a', c2.memGet('a') === 1 && c2.memGet('b') === undefined && c2.memGet('c') === 3)

  const dir3 = mkTmp('b63-cache-big-')
  const c3 = createCache({ dir: dir3, memBytes: 100 })
  const big = 'x'.repeat(1000)
  await c3.setJson('big', big, 'json')
  ok('单值超字节上限：不驻留内存', c3.memGet('big') === undefined)
  const fromDisk = await c3.getJson('big', 'json')
  ok('单值超上限仍落盘并读得回（只是不进内存）', typeof fromDisk === 'string' && fromDisk.length === 1000)

  const dir4 = mkTmp('b63-cache-bytes-')
  const c4 = createCache({ dir: dir4, memBytes: 300 })
  const v = 'x'.repeat(100)
  await c4.setJson('a', v); await c4.setJson('b', v); await c4.setJson('c', v)
  ok('字节上限 300 / 3×100：三条全在（不提前驱逐）',
    c4.memGet('a') !== undefined && c4.memGet('b') !== undefined && c4.memGet('c') !== undefined)
  await c4.setJson('d', v)
  ok('第 4 条只淘汰最旧的一条（字节计数不漂移）',
    c4.memGet('a') === undefined && c4.memGet('b') !== undefined && c4.memGet('d') !== undefined)

  for (const d of [dir, dir2, dir3, dir4]) rmSync(d, { recursive: true, force: true })
}

// ---------- [C] TTL / maxAge ----------
console.log('\n[C] TTL / maxAge（内存命中也复核磁盘 mtime）')
{
  const dir = mkTmp('b63-cache-ttl-')
  const cache = createCache({ dir })
  await cache.setJson('t1', { v: 1 }, 'json', 60000)
  const hit = await cache.getJson('t1', 'json', 60000)
  ok('maxAge 内命中', hit && hit.v === 1)

  const past = Date.now() / 1000 - 3600
  utimesSync(join(dir, 't1.json'), past, past)
  const stale = await cache.getJson('t1', 'json', 1000)
  ok('磁盘 mtime 老化 → 内存命中也不给旧值', stale === null)
  ok('老化同时清掉内存条目', cache.memGet('t1') === undefined)

  await cache.setJson('t2', { v: 2 }, 'json', 60000)
  const reader = createCache({ dir })                     // 新实例：只走磁盘，内存为空
  ok('新实例读新鲜文件命中', (await reader.getJson('t2', 'json', 60000)).v === 2)
  const past2 = Date.now() / 1000 - 3600
  utimesSync(join(dir, 't2.json'), past2, past2)
  ok('新实例读老化文件不命中', (await reader.getJson('t2', 'json', 1000)) === null)

  cache.memSet('tk', 'v', 1)
  await sleep(15)
  ok('memSet(ttl) 到期后 memGet 拿不到', cache.memGet('tk') === undefined)
  cache.memSet('tk2', 'v', 1)
  await sleep(15)
  ok('memSet(ttl) 到期后 getJson 也拿不到（无磁盘文件 → null）', (await cache.getJson('tk2', 'json', 0)) === null)

  rmSync(dir, { recursive: true, force: true })
}

// ---------- [D] 并发 ----------
console.log('\n[D] 并发（旧读不得顶掉新写入 / 并发写同一 key）')
{
  const dir = mkTmp('b63-cache-race-')
  const cache = createCache({ dir })
  await cache.setJson('race', { v: 1 }, 'json', 60000)
  const pending = cache.getJson('race', 'json', 60000)     // 内存命中后卡在 await stat
  await cache.setJson('race', { v: 2 }, 'json', 60000)     // 并发写入新值（先写内存再落盘）
  const got = await pending
  ok('并发期间发起的读返回新值（回归：旧值不得复辟）', got && got.v === 2, 'v=' + (got && got.v))
  const after = await cache.getJson('race', 'json', 60000)
  ok('之后正常读仍是新值', after && after.v === 2, 'v=' + (after && after.v))

  const dir2 = mkTmp('b63-cache-conc-')
  const c2 = createCache({ dir: dir2 })
  await withLogs(() => Promise.all([0, 1, 2, 3, 4, 5].map((i) => c2.setJson('conc', { i }, 'json', 60000))))
  let parsed = null
  try { parsed = JSON.parse(readFileSync(join(dir2, 'conc.json'), 'utf8')) } catch { }
  ok('并发写同一 key：落盘文件始终是合法 JSON', parsed && Number.isInteger(parsed.i) && parsed.i >= 0 && parsed.i < 6,
    String(parsed && parsed.i))
  ok('并发写同一 key：不残留 .tmp', tmpLeft(dir2).length === 0, JSON.stringify(tmpLeft(dir2)))

  for (const d of [dir, dir2]) rmSync(d, { recursive: true, force: true })
}

// ---------- [E] 坏条目 / BOM ----------
console.log('\n[E] 坏条目与 BOM')
{
  const dir = mkTmp('b63-cache-bad-')
  const cache = createCache({ dir })
  writeFileSync(join(dir, 'bad.json'), '{不是 JSON', 'utf8')
  let threw = null
  let miss = 'unset'
  try { miss = await cache.getJson('bad', 'json') } catch (e) { threw = e }
  ok('坏 JSON：不抛异常，按未命中处理', !threw && miss === null, threw ? String(threw.message) : String(miss))

  await cache.setJson('bad', { ok: 1 }, 'json')
  const healed = await cache.getJson('bad', 'json')
  ok('坏条目自愈：重新写入后读到新值', healed && healed.ok === 1)

  writeFileSync(join(dir, 'bom.json'), '\uFEFF' + JSON.stringify({ bom: true }), 'utf8')
  const bomHit = await cache.getJson('bom', 'json')
  ok('带 BOM 的缓存文件仍能解析（不静默失效）', bomHit && bomHit.bom === true)
  rmSync(dir, { recursive: true, force: true })
}

// ---------- [F] 写失败留痕且不留 .tmp ----------
console.log('\n[F] 写失败：留痕 + 清理半截临时文件')
{
  const dir = mkTmp('b63-cache-fail-')
  const cache = createCache({ dir })
  await cache.setJson('ok1', { a: 1 })
  ok('正常写入后不残留 .tmp', tmpLeft(dir).length === 0)

  mkdirSync(join(dir, 'isdir.json'))                      // 目标位置是目录 → rename 必失败
  const logs = await withLogs(() => cache.setJson('isdir', { a: 1 }))
  ok('改名失败：留 WRITE-FAIL 日志（不静默）', logs.some((l) => l.indexOf('WRITE-FAIL') >= 0), JSON.stringify(logs.slice(0, 1)))
  ok('改名失败：不残留 .tmp', tmpLeft(dir).length === 0, JSON.stringify(tmpLeft(dir)))
  rmSync(dir, { recursive: true, force: true })
}

// ---------- [G] key 归一化取证 ----------
console.log('\n[G] key 归一化（调用方契约）')
{
  const h1 = hashKey('任意外容')
  const h2 = shortHash('任意外容')
  const h3 = hashBytes(Buffer.from('音频字节'))
  ok('hashKey → 40 位 hex', hex40.test(h1), h1)
  ok('shortHash → 8 位 hex', /^[0-9a-f]{8}$/.test(h2), h2)
  ok('hashBytes → 40 位 hex', hex40.test(h3), h3)
  ok('三者都文件名安全（无 / \\ : ..）', [h1, h2, h3].every((h) => !/[/\\:]|\.\./.test(h)))
  ok('同输入同 key（可命中）', hashKey('x') === hashKey('x') && hashKey('x') !== hashKey('y'))
}

// ---------- [H] atomic 原子写 ----------
console.log('\n[H] atomic 原子写 / 重试 / 坏文件隔离')
{
  const dir = mkTmp('b63-atomic-')
  const f = join(dir, 'a.json')
  atomic.writeFileAtomic(f, 'first')
  ok('文本往返', readFileSync(f, 'utf8') === 'first')
  atomic.writeFileAtomic(f, 'second')
  ok('rename 覆盖已存在文件', readFileSync(f, 'utf8') === 'second')
  ok('成功后不残留 .tmp', tmpLeft(dir).length === 0)

  const nested = join(dir, 'x', 'y', 'n.json')
  atomic.writeFileAtomic(nested, 'n')
  ok('父目录自动创建', existsSync(nested) && readFileSync(nested, 'utf8') === 'n')

  const buf = Buffer.from([1, 2, 3])
  atomic.writeFileAtomic(join(dir, 'b.bin'), buf)
  const back = readFileSync(join(dir, 'b.bin'))
  ok('Buffer 往返', Buffer.isBuffer(back) && back.equals(buf))

  const jsonf = join(dir, 'j.json')
  atomic.writeJsonAtomic(jsonf, { k: 1 })
  ok('writeJsonAtomic 序列化正确', readFileSync(jsonf, 'utf8') === '{"k":1}')

  const beforeLen = readdirSync(dir).length
  let wrote = null
  await withLogs(async () => { try { atomic.writeJsonAtomic(jsonf, undefined) } catch (e) { wrote = e } })
  ok('写失败（data 非法）会抛且不吞错', wrote instanceof Error, wrote ? wrote.message.slice(0, 48) : 'no throw')
  ok('写失败不留 .tmp（回归：半截临时文件不能进目录）', tmpLeft(dir).length === 0, JSON.stringify(tmpLeft(dir)))
  ok('写失败不动原文件（旧值完好）', readFileSync(jsonf, 'utf8') === '{"k":1}')
  ok('写失败不动目录其它文件', readdirSync(dir).length === beforeLen)

  atomic.writeJsonAtomic(jsonf, { k: 2 })
  ok('失败后仍能正常写', readFileSync(jsonf, 'utf8') === '{"k":2}')

  let calls = 0
  let busyLeft = 2
  atomic.renameWithRetry(() => {
    calls++
    if (busyLeft-- > 0) { const e = new Error('busy'); e.code = 'EBUSY'; throw e }
  })
  ok('rename 重试：EBUSY×2 后成功（共 3 次调用）', calls === 3, 'calls=' + calls)

  let permCalls = 0
  let permErr = null
  try {
    atomic.renameWithRetry(() => { permCalls++; const e = new Error('perm'); e.code = 'EPERM'; throw e })
  } catch (e) { permErr = e }
  ok('rename 重试：EPERM 持续失败 → 抛错且共 4 次（1+3）', permErr && permCalls === 4, 'calls=' + permCalls)

  let enospcCalls = 0
  let enospcErr = null
  try {
    atomic.renameWithRetry(() => { enospcCalls++; const e = new Error('full'); e.code = 'ENOSPC'; throw e })
  } catch (e) { enospcErr = e }
  ok('rename 重试：ENOSPC 不值得重试 → 立即失败（1 次）', enospcErr && enospcCalls === 1, 'calls=' + enospcCalls)

  ok('isRetriableRenameError 真值表',
    atomic.isRetriableRenameError({ code: 'EPERM' }) === true
    && atomic.isRetriableRenameError({ code: 'EACCES' }) === true
    && atomic.isRetriableRenameError({ code: 'EBUSY' }) === true
    && atomic.isRetriableRenameError({ code: 'ENOENT' }) === false
    && atomic.isRetriableRenameError({ code: 'ENOSPC' }) === false
    && atomic.isRetriableRenameError({}) === false
    && atomic.isRetriableRenameError(null) === false)

  ok('isPosixModePlatform 分支', atomic.isPosixModePlatform('win32') === false
    && atomic.isPosixModePlatform('linux') === true && atomic.isPosixModePlatform('darwin') === true)

  const bom = join(dir, 'bom.txt')
  writeFileSync(bom, '\uFEFF{}', 'utf8')
  ok('stripBom 剥 U+FEFF', atomic.stripBom('\uFEFF{}') === '{}' && atomic.stripBom('{}') === '{}')
  ok('readTextNoBom 读带 BOM 文件', atomic.readTextNoBom(bom) === '{}')

  const bad = join(dir, 'bad.txt')
  writeFileSync(bad, 'not json', 'utf8')
  const badLogs = await withLogs(async () => atomic.quarantineFile(bad, new Error('parse'), '[test]'))
  const badFiles = readdirSync(dir).filter((x) => x.indexOf('bad.txt.bad-') === 0)
  ok('坏文件隔离：改成 .bad-<时间戳> 备份', !existsSync(bad) && badFiles.length === 1, JSON.stringify(badFiles))
  ok('坏文件备份名跨平台合法（无冒号）', badFiles.length === 1 && !/[:*?"<>|]/.test(badFiles[0]), badFiles[0])
  ok('隔离会留日志', badLogs.some((l) => l.indexOf('坏文件已备份') >= 0))
  let quarantineThrew = false
  await withLogs(async () => {
    try { atomic.quarantineFile(join(dir, 'nope.txt'), new Error('x')) } catch { quarantineThrew = true }
  })
  ok('隔离不存在的文件不抛', quarantineThrew === false)

  const seqDir = mkTmp('b63-atomic-seq-')
  const seqFile = join(seqDir, 'seq.json')
  for (let i = 0; i < 20; i++) atomic.writeFileAtomic(seqFile, 'v' + i)
  ok('连续 20 次覆盖：只留一个文件、内容为最后一版、无 .tmp',
    readdirSync(seqDir).length === 1 && readFileSync(seqFile, 'utf8') === 'v19' && tmpLeft(seqDir).length === 0,
    readdirSync(seqDir).join(','))
  rmSync(seqDir, { recursive: true, force: true })

  for (const d of [dir]) rmSync(d, { recursive: true, force: true })
}

// ---------- [I] 磁盘 prune ----------
console.log('\n[I] 磁盘 prune（超上限删最旧的一半，新写入幸存）')
{
  const dir = mkTmp('b63-cache-prune-')
  const nowSec = Date.now() / 1000
  for (let i = 0; i < 6; i++) {
    const p = join(dir, 'p' + i + '.json')
    writeFileSync(p, JSON.stringify({ i }), 'utf8')
    utimesSync(p, nowSec - 1000 + i, nowSec - 1000 + i)   // p0 最旧 … p5 最新
  }
  const cache = createCache({ dir, maxFiles: 2 })        // 新实例：prune 节流窗口未生效
  await cache.setJson('new', { ok: 1 }, 'json')
  const left = readdirSync(dir).sort()
  ok('超过 maxFiles → 删掉最旧一半（3 个）', left.length === 4, left.join(','))
  ok('最旧的 p0/p1/p2 被删', !existsSync(join(dir, 'p0.json')) && !existsSync(join(dir, 'p1.json')) && !existsSync(join(dir, 'p2.json')))
  ok('较新的 p3/p4/p5 保留', ['p3.json', 'p4.json', 'p5.json'].every((f) => existsSync(join(dir, f))))
  ok('刚写入的 new.json 幸存', existsSync(join(dir, 'new.json')))
  ok('count() 与目录一致', (await cache.count()) === 4)
  ok('prune 不误删内存里的新条目', cache.memGet('new') !== undefined)
  rmSync(dir, { recursive: true, force: true })
}

// ---------- [J] store 门面 ----------
console.log('\n[J] store 门面（只组合仓储 / 不泄漏内部 json）')
{
  const dir = mkTmp('b63-store-')
  const store = createStore(dir)
  const need = ['loadHistory', 'saveHistory', 'appendTurns', 'clearMemory', 'loadMemorySummary', 'saveMemorySummary',
    'loadState', 'saveState', 'loadStoryProgress', 'saveStoryProgress', 'loadGrowth', 'saveGrowth', 'addExp',
    'loadFishfood', 'saveFishfood', 'addTokens', 'loadReminders', 'saveReminders', 'addReminder', 'dueReminders',
    'removeReminder', 'loadPet', 'savePet', 'tickPet', 'feedPet', 'setMood']
  ok('门面方法齐全', need.every((m) => typeof store[m] === 'function'), need.filter((m) => typeof store[m] !== 'function').join(','))
  ok('门面只返回函数（没有顺手把内部对象挂在返回值上）', Object.values(store).every((v) => typeof v === 'function'))

  ok('loadState 每次给新对象', store.loadState() !== store.loadState())
  ok('loadHistory 每次给新数组', store.loadHistory() !== store.loadHistory() && Array.isArray(store.loadHistory()))
  ok('loadStoryProgress 每次给新对象', store.loadStoryProgress() !== store.loadStoryProgress())

  const st = store.loadState()
  st.intimacy = 42                                         // 只改返回值、不写盘
  ok('改写返回值不污染真源（没有内存缓存可污染）', store.loadState().intimacy === 0)

  store.saveState({ intimacy: 250 })
  ok('state 上界清洗：250 → 100', store.loadState().intimacy === 100)
  store.saveState({ intimacy: -5 })
  ok('state 下界清洗：-5 → 0', store.loadState().intimacy === 0)

  for (let i = 0; i < 25; i++) store.appendTurns('u' + i, 'a' + i)
  const h = store.loadHistory()
  ok('appendTurns 成对追加并截到 50 条（80 上限）', h.length === 50 && h[0].content === 'u0' && h[49].content === 'a24',
    h.length + ' 条，首条 ' + (h[0] && h[0].content))

  const arr = [{ role: 'user', content: 'x' }]
  store.saveHistory(arr)
  arr.push({ role: 'user', content: 'y' })
  ok('saveHistory 写的是快照（事后改 caller 数组不落盘）', store.loadHistory().length === 1)

  store.saveMemorySummary('S1')
  store.saveHistory([{ role: 'user', content: 'z' }])
  ok('saveHistory 不冲掉摘要', store.loadMemorySummary() === 'S1')

  store.saveStoryProgress({ _current: '甲', 'local:甲|0': true })
  const prog = store.loadStoryProgress()
  ok('说书进度原样往返', prog._current === '甲' && prog['local:甲|0'] === true)

  const f1 = store.addTokens('chat', 7)
  ok('鱼粮：首次记账当日累加', f1.dayTokens === 7 && f1.totalTokens === 7)
  const f2 = store.addTokens('story', 3)
  ok('鱼粮：分类与当日/总量同时累加', f2.chatTokens === 7 && f2.storyTokens === 3 && f2.dayTokens === 10 && f2.totalTokens === 10)

  const r = store.addReminder('喝水', new Date(Date.now() + 60000).toISOString(), 0)
  ok('提醒：新增 + 未到期不触发', r && r.id && store.loadReminders().length === 1 && store.dueReminders().length === 0)
  store.removeReminder(r.id)
  ok('提醒：删除后清空', store.loadReminders().length === 0)

  const pet = store.loadPet()
  ok('宠物：读默认状态', pet && typeof pet.hunger === 'number' && typeof pet.mood === 'string')
  const ticked = store.tickPet()
  ok('宠物：tick 结算后回写', ticked && typeof ticked.lastSeen === 'number' && ticked.lastSeen > 0)
  ok('成长：缺文件按 0 兜底', Number(store.loadGrowth().exp) === 0)

  // 坏文件隔离与 BOM 容错（各用独立目录，避免互相污染）
  const badDir = mkTmp('b63-store-bad-')
  const badStore = createStore(badDir)
  writeFileSync(join(badDir, 'state.json'), '{oops', 'utf8')
  let badState = null
  await withLogs(async () => { badState = badStore.loadState() })
  ok('坏 state.json → 默认值不抛', badState && badState.intimacy === 0)
  ok('坏 state.json → 隔离成 .bad- 备份', readdirSync(badDir).some((f) => f.indexOf('state.json.bad-') === 0),
    readdirSync(badDir).join(','))

  const bomDir = mkTmp('b63-store-bom-')
  writeFileSync(join(bomDir, 'memory.json'),
    '\uFEFF' + JSON.stringify({ history: [{ role: 'user', content: '嗨' }], summary: 'S' }), 'utf8')
  const bomStore = createStore(bomDir)
  ok('带 BOM 的 memory.json 可读（升级不丢记忆）',
    bomStore.loadHistory().length === 1 && bomStore.loadMemorySummary() === 'S')

  for (const d of [dir, badDir, bomDir]) rmSync(d, { recursive: true, force: true })
}

console.log('\n通过 ' + pass + ' 项 / 失败 ' + fail + ' 项')
if (fail > 0) process.exitCode = 1
