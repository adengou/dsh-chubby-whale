/**
 * scripts/test-dataport-poem.mjs —— B86「数据端口收口」专项回归
 *
 * 背景（上一批分身取证，违反 ADR 0002「路由只经端口取数据」）：
 *   ① src/host/routes/poem-titles.ts 直接 join(dataDir,'poem-titles.json') + readFileSync，
 *      handler 根本没接 dataPort；
 *   ② src/host/routes/culture.ts 的 /melodies、/melody 直接 readFile(join(dataDir,'melodies.json'))。
 *
 * 本批给 DataPort 加了两个**可选**方法 readPoemTitles / readMelodies（local/cloud 各实现），
 * 路由改成端口优先、仅在「端口没有该能力」时回退读文件。本脚本逐条验证：
 *   A 诗名索引：端口存在 → 不再读文件；端口 null → 既有 ok:false 兜底；端口缺失 → 文件回退
 *   B 曲库：同上（/melodies 列表 + /melody 按名取谱）
 *   C 本地端口实现：坏 JSON → null 且记日志、不抛；缓存所有权；文件更新可见
 *   D 云端端口实现：清单声明 → 取云端；未声明/网络失败 → 回退本地；本地也没能力 → null
 *   E 静态契约：端口方法可选、路由确实引用端口、回退注释写明移除条件
 *
 * 纯离线：不联网（云端用 fetchImpl 假实现）、不起 HTTP、不碰 dist。
 * 用法：node scripts/test-dataport-poem.mjs   # 失败退出码 1
 */
import { register } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, utimesSync } from 'node:fs'
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

/** 静默执行一段预期会打日志的代码，并收集日志 */
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

function mkRes() {
  const out = { code: 0, chunks: [] }
  out.writeHead = (c) => { out.code = c }
  out.end = (b) => { if (b) out.chunks.push(Buffer.from(String(b))) }
  out.setHeader = () => { }
  out.json = () => { try { return JSON.parse(Buffer.concat(out.chunks).toString('utf8')) } catch (e) { return null } }
  return out
}

/** 调用 handler，返回 { json, code } */
async function call(fn, url) {
  const res = mkRes()
  await fn({ url }, res)
  return { json: res.json(), code: res.code }
}

const keys = (o) => Object.keys(o || {}).sort().join(',')

// ===========================================================================
// A. 诗名索引：端口优先 / null 降级 / 端口缺失回退
// ===========================================================================
console.log('\n[A] 诗名索引 host/routes/poem-titles.ts')
try {
  const { createPoemTitlesHandler } = await imp('src/host/routes/poem-titles.ts')

  // A1：端口存在 + data/ 放同名诱饵文件 → 响应必须是端口那份（端口存在就不读文件）
  {
    const dir = mkTmp('whale-dp-pt-a1-')
    writeFileSync(join(dir, 'poem-titles.json'), JSON.stringify({ titles: ['文件里的诗'] }))
    const h = createPoemTitlesHandler({ dataDir: dir, dataPort: { readPoemTitles: async () => ({ titles: ['端口里的诗甲', '端口里的诗乙'] }) } })
    const { json, code } = await call(h.handlePoemTitles, '/api/chubby-whale/poem-titles')
    ok('端口存在：ok:true 且 count/titles 与端口一致', !!json && json.ok === true && json.count === 2 && JSON.stringify(json.titles) === JSON.stringify(['端口里的诗甲', '端口里的诗乙']), JSON.stringify(json && json.titles))
    ok('端口存在：响应只含既有字段 ok/count/titles', keys(json) === 'count,ok,titles', keys(json))
    ok('端口存在：HTTP 200，且不是文件里的标题（没读文件）', code === 200 && json.titles.indexOf('文件里的诗') < 0)
  }

  // A2：文件是坏 JSON，端口正常 → 依然成功（端口存在时根本不碰文件）
  {
    const dir = mkTmp('whale-dp-pt-a2-')
    writeFileSync(join(dir, 'poem-titles.json'), '{ titles: [')
    const h = createPoemTitlesHandler({ dataDir: dir, dataPort: { readPoemTitles: async () => ({ titles: ['坏文件旁的诗'] }) } })
    const { json, code } = await call(h.handlePoemTitles, '/api/chubby-whale/poem-titles')
    ok('端口存在 + 文件坏 JSON：仍 ok:true（没有回读坏文件）', code === 200 && !!json && json.ok === true && json.titles[0] === '坏文件旁的诗', JSON.stringify(json))
  }

  // A3：端口返回 null（坏 JSON/缺文件的端口结论）+ 文件里有合法标题 → 走既有 ok:false，不偷读文件
  {
    const dir = mkTmp('whale-dp-pt-a3-')
    writeFileSync(join(dir, 'poem-titles.json'), JSON.stringify({ titles: ['文件里的诗'] }))
    const h = createPoemTitlesHandler({ dataDir: dir, dataPort: { readPoemTitles: async () => null } })
    const { value: r, logs } = await capture(() => call(h.handlePoemTitles, '/api/chubby-whale/poem-titles'))
    ok('端口 null：ok:false + titles:[]（HTTP 200，不 500）', !!r.json && r.json.ok === false && Array.isArray(r.json.titles) && r.json.titles.length === 0 && r.code === 200, JSON.stringify(r.json))
    ok('端口 null：error 有值 + POEM-TITLES-LOAD-FAIL 留痕', typeof r.json.error === 'string' && r.json.error.length > 0 && logs.some((s) => s.indexOf('POEM-TITLES-LOAD-FAIL') >= 0), (r.json && r.json.error) || '')
    ok('端口 null：没有回读文件里的标题', r.json.titles.indexOf('文件里的诗') < 0)
  }

  // A4：端口返回空表 → 与空文件同口径（ok:false，不返回 count=0 的「成功」）
  {
    const h = createPoemTitlesHandler({ dataPort: { readPoemTitles: async () => ({ titles: [] }) } })
    const { value: r } = await capture(() => call(h.handlePoemTitles, '/api/chubby-whale/poem-titles'))
    ok('端口空表：ok:false + titles:[]', !!r.json && r.json.ok === false && r.json.titles.length === 0)
  }

  // A5：端口违约（抛错）→ 仍走既有失败语义，不把异常抛给 HTTP 层
  {
    const h = createPoemTitlesHandler({ dataPort: { readPoemTitles: async () => { throw new Error('port boom') } } })
    const { value: r } = await capture(() => call(h.handlePoemTitles, '/api/chubby-whale/poem-titles'))
    ok('端口抛错：ok:false（HTTP 200，不 500）', !!r.json && r.json.ok === false && r.code === 200 && r.json.error === 'port boom', JSON.stringify(r.json))
  }

  // A6：端口缺失该能力（旧装配/离线单测）→ 回退读文件，行为与改造前一致
  {
    const dir = mkTmp('whale-dp-pt-a6-')
    writeFileSync(join(dir, 'poem-titles.json'), JSON.stringify({ titles: ['静夜思', '', '望岳', 42, null] }))
    const h = createPoemTitlesHandler({ dataDir: dir })
    const { json } = await call(h.handlePoemTitles, '/api/chubby-whale/poem-titles')
    ok('端口缺失：回退读文件，过滤空串/非字符串', !!json && json.ok === true && JSON.stringify(json.titles) === JSON.stringify(['静夜思', '望岳']), JSON.stringify(json && json.titles))

    const missing = createPoemTitlesHandler({ dataDir: join(dir, 'nope') })
    const { value: r, logs } = await capture(() => call(missing.handlePoemTitles, '/api/chubby-whale/poem-titles'))
    ok('端口缺失 + 文件缺失：ok:false + 留痕（既有语义）', !!r.json && r.json.ok === false && r.json.titles.length === 0 && logs.some((s) => s.indexOf('POEM-TITLES-LOAD-FAIL') >= 0))
  }
} catch (e) {
  ok('A 组可执行', false, String(e && e.stack || e))
}

// ===========================================================================
// B. 曲库：端口优先 / null 降级 / 端口缺失回退
// ===========================================================================
console.log('\n[B] 曲库 culture.ts 的 /melodies、/melody')
try {
  const { createCultureHandlers } = await imp('src/host/routes/culture.ts')
  const mkPort = (over) => Object.assign({ readCulture: async () => [] }, over || {})

  // B1：端口存在 + 同名诱饵文件 → 只认端口；按名取谱也走端口
  {
    const dir = mkTmp('whale-dp-mel-b1-')
    writeFileSync(join(dir, 'melodies.json'), JSON.stringify({ songs: [{ name: '文件里的歌', bpm: 60, notes: [['C3', 1]] }] }))
    const rt = mkTmp('whale-dp-mel-b1-rt-')
    const h = createCultureHandlers({
      dataDir: dir, runtimeDir: rt,
      dataPort: mkPort({ readMelodies: async () => ({ songs: [{ name: '端口里的歌', bpm: 111, notes: [['C4', 1], ['D4', 2]], lyrics: '端口词' }] }) }),
    })
    const { json: list, code } = await call(h.handleMelodies, '/api/chubby-whale/melodies')
    ok('端口存在：列表只露 name/bpm，取端口数据', code === 200 && !!list && list.ok === true && list.songs.length === 1 && list.songs[0].name === '端口里的歌' && list.songs[0].bpm === 111 && !('notes' in list.songs[0]), JSON.stringify(list && list.songs))
    ok('端口存在：/melodies 响应只含既有字段 ok/songs', keys(list) === 'ok,songs', keys(list))
    const { json: song } = await call(h.handleMelody, '/api/chubby-whale/melody?name=' + encodeURIComponent('端口里的歌'))
    ok('端口存在：按名取谱 notes/lyrics 齐全', !!song && song.ok === true && song.song.notes.length === 2 && song.song.bpm === 111 && song.song.lyrics === '端口词', JSON.stringify(song && song.song))
    const { json: miss } = await call(h.handleMelody, '/api/chubby-whale/melody?name=' + encodeURIComponent('文件里的歌'))
    ok('端口存在：文件里的歌查不到（证明没读文件）', !!miss && miss.ok === false && miss.error === 'song not found', JSON.stringify(miss))
  }

  // B2：端口返回 null + 文件里有合法曲库 → 既有失败兜底，不偷读文件
  {
    const dir = mkTmp('whale-dp-mel-b2-')
    writeFileSync(join(dir, 'melodies.json'), JSON.stringify({ songs: [{ name: '文件里的歌', bpm: 60 }] }))
    const h = createCultureHandlers({ dataDir: dir, runtimeDir: mkTmp('whale-dp-mel-b2-rt-'), dataPort: mkPort({ readMelodies: async () => null }) })
    const { json: list, code } = await call(h.handleMelodies, '/api/chubby-whale/melodies')
    ok('端口 null：/melodies ok:false + songs:[]（HTTP 200）', code === 200 && !!list && list.ok === false && Array.isArray(list.songs) && list.songs.length === 0, JSON.stringify(list))
    ok('端口 null：/melodies 仍是既有失败形状（ok/error/songs）', keys(list) === 'error,ok,songs', keys(list))
    const { json: one } = await call(h.handleMelody, '/api/chubby-whale/melody?name=' + encodeURIComponent('文件里的歌'))
    ok('端口 null：/melody 为 ok:false（不返回文件里的歌）', !!one && one.ok === false && !one.song, JSON.stringify(one))
  }

  // B3：端口违约（抛错）→ 既有失败兜底；B5：文件坏 JSON + 端口正常 → 端口数据照常
  {
    const bad = createCultureHandlers({ dataDir: mkTmp('whale-dp-mel-b3-'), runtimeDir: mkTmp('whale-dp-mel-b3-rt-'), dataPort: mkPort({ readMelodies: async () => { throw new Error('melodies boom') } }) })
    const { value: b } = await capture(() => call(bad.handleMelodies, '/api/chubby-whale/melodies'))
    ok('端口抛错：/melodies ok:false + songs:[]（HTTP 200）', !!b.json && b.json.ok === false && b.json.songs.length === 0 && b.code === 200)

    const dir = mkTmp('whale-dp-mel-b5-')
    writeFileSync(join(dir, 'melodies.json'), '{ songs: [')
    const h = createCultureHandlers({ dataDir: dir, runtimeDir: mkTmp('whale-dp-mel-b5-rt-'), dataPort: mkPort({ readMelodies: async () => ({ songs: [{ name: '坏文件旁的口哨', bpm: 90 }] }) }) })
    const { json } = await call(h.handleMelodies, '/api/chubby-whale/melodies')
    ok('端口存在 + 文件坏 JSON：仍 ok:true（没有回读坏文件）', !!json && json.ok === true && json.songs[0].name === '坏文件旁的口哨', JSON.stringify(json))
  }

  // B4：端口缺失该能力 → 回退读文件（旧装配可用）
  {
    const dir = mkTmp('whale-dp-mel-b4-')
    writeFileSync(join(dir, 'melodies.json'), JSON.stringify({ songs: [{ name: '小星星', bpm: 120, notes: [1, 2, 3], lyrics: '一闪一闪' }] }))
    const h = createCultureHandlers({ dataDir: dir, runtimeDir: mkTmp('whale-dp-mel-b4-rt-'), dataPort: mkPort() })
    const { json } = await call(h.handleMelodies, '/api/chubby-whale/melodies')
    ok('端口缺失：回退读文件（列表只露 name/bpm）', !!json && json.ok === true && json.songs.length === 1 && json.songs[0].name === '小星星' && !('notes' in json.songs[0]))
    const { json: song } = await call(h.handleMelody, '/api/chubby-whale/melody?name=' + encodeURIComponent('小星星'))
    ok('端口缺失：按名取谱回退读文件', !!song && song.ok === true && song.song.notes.length === 3)

    const gone = createCultureHandlers({ dataDir: join(dir, 'nope'), runtimeDir: mkTmp('whale-dp-mel-b4b-rt-'), dataPort: mkPort() })
    const { json: mf } = await call(gone.handleMelodies, '/api/chubby-whale/melodies')
    ok('端口缺失 + 文件缺失：ok:false + songs:[]（既有语义）', !!mf && mf.ok === false && mf.songs.length === 0)
  }
} catch (e) {
  ok('B 组可执行', false, String(e && e.stack || e))
}

// ===========================================================================
// C. 本地端口实现（local.ts）
// ===========================================================================
console.log('\n[C] 本地 DataPort：readPoemTitles / readMelodies')
try {
  const { createLocalDataPort } = await imp('src/host/data/local.ts')
  const mkLocal = (dir) => createLocalDataPort({ dataDir: dir, story: { listBooks: async () => [], loadBook: async () => [] } })

  // C1：正常数据 + 过滤口径
  {
    const dir = mkTmp('whale-dp-local-c1-')
    writeFileSync(join(dir, 'poem-titles.json'), JSON.stringify({ count: 5, titles: ['静夜思', '', '望岳', 42, null] }))
    writeFileSync(join(dir, 'melodies.json'), JSON.stringify({ version: 1, songs: [{ name: '小星星', bpm: 120, notes: [['C4', 1]] }] }))
    const port = mkLocal(dir)
    const t = await port.readPoemTitles()
    ok('本地诗名：返回 {titles}，过滤空串/非字符串', !!t && JSON.stringify(t.titles) === JSON.stringify(['静夜思', '望岳']), JSON.stringify(t))
    const m = await port.readMelodies()
    ok('本地曲库：返回 songs 数组与条目字段', !!m && Array.isArray(m.songs) && m.songs.length === 1 && m.songs[0].bpm === 120, JSON.stringify(m && m.songs))
  }

  // C2：坏 JSON → null 且记日志、不抛
  {
    const dir = mkTmp('whale-dp-local-c2-')
    writeFileSync(join(dir, 'poem-titles.json'), '{ titles: [')
    writeFileSync(join(dir, 'melodies.json'), '{ songs: [')
    const port = mkLocal(dir)
    const { value: t, logs: tl } = await capture(() => port.readPoemTitles())
    ok('本地诗名坏 JSON：返回 null（不抛）', t === null)
    ok('本地诗名坏 JSON：POEM-TITLES-LOAD-FAIL 留痕', tl.some((s) => s.indexOf('POEM-TITLES-LOAD-FAIL') >= 0), tl.join(' | ').slice(0, 120))
    const { value: m, logs: ml } = await capture(() => port.readMelodies())
    ok('本地曲库坏 JSON：返回 null（不抛）', m === null)
    ok('本地曲库坏 JSON：MELODIES-LOAD-FAIL 留痕', ml.some((s) => s.indexOf('MELODIES-LOAD-FAIL') >= 0), ml.join(' | ').slice(0, 120))
  }

  // C3：缺文件 / 空表 / 坏结构 → null，不抛
  {
    const dir = mkTmp('whale-dp-local-c3-')
    const port = mkLocal(dir)
    const { value: t } = await capture(() => port.readPoemTitles())
    const { value: m } = await capture(() => port.readMelodies())
    ok('本地缺文件：两个读口都返回 null（不抛）', t === null && m === null)
    writeFileSync(join(dir, 'poem-titles.json'), JSON.stringify({ titles: [] }))
    writeFileSync(join(dir, 'melodies.json'), 'null')
    const { value: t2, logs: l2 } = await capture(() => port.readPoemTitles())
    ok('本地诗名空表：null + 留痕', t2 === null && l2.some((s) => s.indexOf('POEM-TITLES-LOAD-FAIL') >= 0))
    const { value: m2 } = await capture(() => port.readMelodies())
    ok('本地曲库非对象（null）：null', m2 === null)
  }

  // C4：缓存所有权（返回值副本，改不到缓存）
  {
    const dir = mkTmp('whale-dp-local-c4-')
    writeFileSync(join(dir, 'poem-titles.json'), JSON.stringify({ titles: ['甲', '乙'] }))
    writeFileSync(join(dir, 'melodies.json'), JSON.stringify({ songs: [{ name: '甲歌', bpm: 100 }] }))
    const port = mkLocal(dir)
    const t1 = await port.readPoemTitles()
    const t2 = await port.readPoemTitles()
    ok('本地诗名：两次读返回不同对象/数组', !!t1 && !!t2 && t1 !== t2 && t1.titles !== t2.titles)
    t1.titles.push('注入')
    t1.titles[0] = '被改过'
    const t3 = await port.readPoemTitles()
    ok('本地诗名：改返回值碰不到缓存', t3.titles.length === 2 && t3.titles[0] === '甲', JSON.stringify(t3.titles))
    const m1 = await port.readMelodies()
    const m2 = await port.readMelodies()
    ok('本地曲库：两次读返回不同对象/数组/条目', !!m1 && !!m2 && m1 !== m2 && m1.songs !== m2.songs && m1.songs[0] !== m2.songs[0])
    m1.songs[0].name = '被改过'
    m1.songs.push({ name: '注入' })
    const m3 = await port.readMelodies()
    ok('本地曲库：改返回值碰不到缓存', m3.songs.length === 1 && m3.songs[0].name === '甲歌', JSON.stringify(m3.songs))
  }

  // C5：文件更新可见（按 mtime 失效，不粘死旧值）
  {
    const dir = mkTmp('whale-dp-local-c5-')
    writeFileSync(join(dir, 'poem-titles.json'), JSON.stringify({ titles: ['旧诗'] }))
    writeFileSync(join(dir, 'melodies.json'), JSON.stringify({ songs: [{ name: '旧歌', bpm: 1 }] }))
    const port = mkLocal(dir)
    await port.readPoemTitles(); await port.readMelodies()
    writeFileSync(join(dir, 'poem-titles.json'), JSON.stringify({ titles: ['新诗'] }))
    writeFileSync(join(dir, 'melodies.json'), JSON.stringify({ songs: [{ name: '新歌', bpm: 2 }] }))
    const stamp = new Date(Date.now() + 2000)
    utimesSync(join(dir, 'poem-titles.json'), stamp, stamp)
    utimesSync(join(dir, 'melodies.json'), stamp, stamp)
    const t = await port.readPoemTitles()
    const m = await port.readMelodies()
    ok('本地诗名：文件更新后读到新内容', !!t && t.titles[0] === '新诗', JSON.stringify(t && t.titles))
    ok('本地曲库：文件更新后读到新内容', !!m && m.songs[0].name === '新歌', JSON.stringify(m && m.songs))
  }
} catch (e) {
  ok('C 组可执行', false, String(e && e.stack || e))
}

// ===========================================================================
// D. 云端端口实现（cloud.ts）
// ===========================================================================
console.log('\n[D] 云端 DataPort：云端优先 / 未声明与失败回退本地')
try {
  const { createLocalDataPort } = await imp('src/host/data/local.ts')
  const { createCloudDataPort } = await imp('src/host/data/cloud.ts')
  const BASE = 'https://cloud.test/'
  const mkFetch = (files, calls) => async (url) => {
    const path = String(url).replace(BASE, '')
    if (calls) calls.push(path)
    if (!Object.prototype.hasOwnProperty.call(files, path)) return { ok: false, status: 404, text: async () => '' }
    return { ok: true, status: 200, text: async () => JSON.stringify(files[path]) }
  }
  const mkLocal = (dir) => createLocalDataPort({ dataDir: dir, story: { listBooks: async () => [], loadBook: async () => [] } })

  // D1：清单声明 → 取云端；本地放另一份数据做对照
  {
    const dir = mkTmp('whale-dp-cloud-d1-')
    writeFileSync(join(dir, 'poem-titles.json'), JSON.stringify({ titles: ['本地诗'] }))
    writeFileSync(join(dir, 'melodies.json'), JSON.stringify({ songs: [{ name: '本地歌', bpm: 1 }] }))
    const local = mkLocal(dir)
    const manifest = { version: 'v9', generatedAt: 'g9', files: [{ path: 'poem-titles.json' }, { path: 'melodies.json' }] }
    const files = {
      'manifest.json': manifest,
      'poem-titles.json': { titles: ['云端诗甲', '云端诗乙'] },
      'melodies.json': { songs: [{ name: '云端歌', bpm: 222, notes: [['E4', 1]], lyrics: '云' }] },
    }
    const cloud = createCloudDataPort({ local, baseUrl: BASE, fetchImpl: mkFetch(files) })
    const t = await cloud.readPoemTitles()
    ok('云端清单声明诗名：取云端数据', !!t && JSON.stringify(t.titles) === JSON.stringify(['云端诗甲', '云端诗乙']), JSON.stringify(t))
    const m = await cloud.readMelodies()
    ok('云端清单声明曲库：取云端数据', !!m && m.songs[0].name === '云端歌' && m.songs[0].bpm === 222, JSON.stringify(m && m.songs))
  }

  // D2：清单未声明 → 静默回退本地（数据缺失不算链路故障）
  {
    const dir = mkTmp('whale-dp-cloud-d2-')
    writeFileSync(join(dir, 'poem-titles.json'), JSON.stringify({ titles: ['本地兜底诗'] }))
    writeFileSync(join(dir, 'melodies.json'), JSON.stringify({ songs: [{ name: '本地兜底歌', bpm: 3 }] }))
    const cloud = createCloudDataPort({
      local: mkLocal(dir), baseUrl: BASE,
      fetchImpl: mkFetch({ 'manifest.json': { version: 'v1', generatedAt: 'g1', files: [] } }),
    })
    const { value: t, logs } = await capture(() => cloud.readPoemTitles())
    ok('云端未声明诗名：回退本地数据', !!t && t.titles[0] === '本地兜底诗', JSON.stringify(t))
    ok('云端未声明诗名：留 cloud data unavailable 提示', logs.some((s) => s.indexOf('cloud data unavailable') >= 0), logs.join(' | ').slice(0, 120))
    const { value: m } = await capture(() => cloud.readMelodies())
    ok('云端未声明曲库：回退本地数据', !!m && m.songs[0].name === '本地兜底歌', JSON.stringify(m && m.songs))
  }

  // D3：网络失败 → 回退本地、不抛（同一故障周期只记一次）
  {
    const dir = mkTmp('whale-dp-cloud-d3-')
    writeFileSync(join(dir, 'poem-titles.json'), JSON.stringify({ titles: ['离线诗'] }))
    writeFileSync(join(dir, 'melodies.json'), JSON.stringify({ songs: [{ name: '离线歌', bpm: 4 }] }))
    const cloud = createCloudDataPort({
      local: mkLocal(dir), baseUrl: BASE,
      fetchImpl: async () => ({ ok: false, status: 500, text: async () => '' }),
    })
    const { value: m, logs } = await capture(() => cloud.readMelodies())
    ok('云端网络失败：曲库回退本地且不抛', !!m && m.songs[0].name === '离线歌', JSON.stringify(m && m.songs))
    ok('云端网络失败：CLOUD-DATA-FAIL 留痕', logs.some((s) => s.indexOf('CLOUD-DATA-FAIL') >= 0), logs.join(' | ').slice(0, 120))
    const { value: t } = await capture(() => cloud.readPoemTitles())
    ok('云端网络失败：诗名同样回退本地（冷却期内不打网络）', !!t && t.titles[0] === '离线诗', JSON.stringify(t))
  }

  // D4：本地实现也没有这两个可选方法 → 返回 null，绝不抛
  {
    const cloud = createCloudDataPort({
      local: {}, baseUrl: BASE,
      fetchImpl: mkFetch({ 'manifest.json': { version: 'v1', generatedAt: 'g1', files: [] } }),
    })
    const { value: t, logs } = await capture(() => cloud.readPoemTitles())
    const { value: m } = await capture(() => cloud.readMelodies())
    ok('云端 + 本地无该能力：诗名返回 null（不抛）', t === null && logs.some((s) => s.indexOf('cloud data unavailable') >= 0), JSON.stringify(t))
    ok('云端 + 本地无该能力：曲库返回 null（不抛）', m === null)
  }
} catch (e) {
  ok('D 组可执行', false, String(e && e.stack || e))
}

// ===========================================================================
// E. 静态契约（端口可选 + 路由确实走端口 + 回退有移除条件）
// ===========================================================================
console.log('\n[E] 静态契约（源码层）')
try {
  const portsSrc = readFileSync(join(ROOT, 'src/host/ports.ts'), 'utf8')
  ok('ports.ts：readPoemTitles 是可选方法', /readPoemTitles\?\(\)\s*:\s*Promise<\{ titles: string\[\] \} \| null>/.test(portsSrc))
  ok('ports.ts：readMelodies 是可选方法', /readMelodies\?\(\)\s*:\s*Promise<any \| null>/.test(portsSrc))

  const ptSrc = readFileSync(join(ROOT, 'src/host/routes/poem-titles.ts'), 'utf8')
  ok('poem-titles.ts：引用 dataPort.readPoemTitles 并按能力判断', /dataPort\??\.readPoemTitles/.test(ptSrc) && /fromPort/.test(ptSrc))
  ok('poem-titles.ts：回退分支注释写明移除条件', /移除条件/.test(ptSrc) && /readPoemTitles/.test(ptSrc))

  const culSrc = readFileSync(join(ROOT, 'src/host/routes/culture.ts'), 'utf8')
  ok('culture.ts：/melodies 与 /melody 共用 loadMelodies 走端口', /readMelodies/.test(culSrc) && (culSrc.match(/loadMelodies\(/g) || []).length >= 3)
  ok('culture.ts：回退分支注释写明移除条件', /移除条件/.test(culSrc))

  // 装配层：两处端口都必须注入，否则端口优先不生效（B86 收口后半段）
  const indexSrc = readFileSync(join(ROOT, 'src/index.ts'), 'utf8')
  const cultureWired = /createCultureHandlers\(\{[^}]*dataPort/.test(indexSrc)
  const poemTitlesWired = /createPoemTitlesHandler\(\{[^}]*dataPort/.test(indexSrc)
  ok('index.ts 装配：culture 已注入 dataPort（曲库端口改动即时生效）', cultureWired)
  ok('index.ts 装配：poem-titles 已注入 dataPort（诗名索引端口优先生效）', poemTitlesWired)
} catch (e) {
  ok('E 组可执行', false, String(e && e.stack || e))
}

// ---------------------------------------------------------------------------
for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }) } catch { } }
console.log('\n────────────────────')
console.log((fail === 0 ? '✅ ' : '❌ ') + '数据端口收口通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
