/**
 * scripts/test-content-routes.mjs —— 内容路由永久回归（文化 / 念诗 / 诗名索引 / 每日一句）
 *
 * 背景（2026-11-07 B63 内容批次审计，四个文件：routes/culture.ts、routes/poem.ts、
 * routes/poem-titles.ts、routes/daily.ts）：
 *   ① 念诗分片：total 来自数据文件（外部输入），修前直接当 `for (i = 1; i < total; i++)`
 *      的循环上界——坏数据里的 1e9 / Infinity 会让每次念诗空转上亿次、请求永不返回；
 *   ② 念诗 `?title=` 没命中回落随机时，注释承诺的 `matched:false` 实际没有下发；
 *   ③ 文化与念诗同一套「一轮不重复」：念诗早就排除上一首，文化池子清空重来时没有，
 *      小池子下会出现「刚讲完又立刻同一则」。
 *
 * 覆盖：
 *   A. 念诗分片边界：total 上限、越界不读、空片/非数组 items/坏 total、只读 0..total-1；
 *   B. 念诗随机池：一轮内不重复、重来不立刻重复上一首、?title= 精确/包含/未命中/缺省，
 *      空库与端口抛错都降级成 ok:true+no-data（HTTP 200，不 500）；
 *   C. 文化：三类随机池、重来不立刻重复、类别进度互相隔离、type 只认三个字面量（注入不值入）、
 *      空池/端口抛错降级、曲库缺失 ok:false、曲谱字段；
 *   D. 每日一句：日序号（闰日/非补零/非法日期）、同日稳定、跨天变化、坏条目跳过、
 *      无 daily 回落诗库、诗库也没有 → ok:false no-data、非 GET → 405；
 *   E. 诗名索引：成功过滤非字符串、成功结果进程内缓存、失败不缓存、缺文件/坏 JSON/空表 → ok:false；
 *   F. 封装取证：三个路由只从注入的 DataPort 取数（data/ 里放同名诱饵文件也不会被读）。
 *
 * 纯离线：不联网、不起 HTTP、不碰 dist。临时目录用完即删。
 * 用法：node scripts/test-content-routes.mjs   # 失败退出码 1
 */
import { register } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
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

/** 假 res：与 host/respond.ts 的用法（writeHead + end）一致 */
function mkRes() {
  const out = { code: 0, headers: null, body: '' }
  out.writeHead = (code, headers) => { out.code = code; out.headers = headers || null }
  out.setHeader = () => { }
  out.end = (body) => { out.body = body ? String(body) : '' }
  out.json = () => { try { return JSON.parse(out.body) } catch { return null } }
  return out
}

/** 调一个 handler，返回 {code, json, res} */
async function call(handler, url, req = {}) {
  const res = mkRes()
  await handler(Object.assign({ url, method: 'GET', headers: {} }, req), res)
  return { code: res.code, json: res.json(), res }
}

/** 静默执行一段预期会打日志的代码（避免「预期失败」刷进测试输出），返回 {value, logs} */
async function capture(fn) {
  const logs = []
  const realError = console.error
  const realWarn = console.warn
  const realLog = console.log
  console.error = (...a) => logs.push(a.join(' '))
  console.warn = (...a) => logs.push(a.join(' '))
  console.log = (...a) => logs.push(a.join(' '))
  try {
    return { value: await fn(), logs }
  } finally {
    console.error = realError
    console.warn = realWarn
    console.log = realLog
  }
}

const POEM_A = { title: '静夜思', author: '李白', dynasty: '唐', lines: ['床前明月光', '疑是地上霜'] }
const POEM_B = { title: '望岳', author: '杜甫', dynasty: '唐', lines: ['岱宗夫如何'] }
const POEM_C = { title: '春晓', author: '孟浩然', dynasty: '唐', lines: ['春眠不觉晓'] }
const TITLES = [POEM_A.title, POEM_B.title, POEM_C.title]

// ===========================================================================
// A. 念诗分片边界
// ===========================================================================
console.log('\n[A] 念诗分片边界 host/routes/poem.ts')
try {
  const { createPoemHandler } = await imp('src/host/routes/poem.ts')

  // A1：total=1e9。修前会把 1e9 次空片读取跑完（请求永不返回）；
  // 这里让端口在第 501 次调用抛错，把「没有上限」暴露成失败断言，而不是把测试挂死。
  {
    const calls = []
    const port = {
      readPoemsChunk: async (i) => {
        calls.push(i)
        if (calls.length > 500) throw new Error('runaway chunk loop')
        return { index: i, total: 1e9, items: i === 0 ? [POEM_A] : [] }
      },
    }
    const h = createPoemHandler({ runtimeDir: mkTmp('whale-poem-a1-'), dataPort: port })
    const { value: r, logs } = await capture(() => call(h.handlePoem, '/api/chubby-whale/poem'))
    ok('total=1e9：分片数被限制（≤64 片，不空转）', calls.length <= 64, '实际 ' + calls.length + ' 片')
    ok('total=1e9：仍能念出第 0 片的诗', !!r.json && r.json.ok === true && !!r.json.item && r.json.item.title === POEM_A.title)
    ok('total=1e9：留痕 POEM-TOTAL-CAP', logs.some((s) => s.indexOf('POEM-TOTAL-CAP') >= 0))
  }

  // A2：total=Infinity（JSON 里不可能，但端口/坏实现可能给）
  {
    const calls = []
    const port = {
      readPoemsChunk: async (i) => {
        calls.push(i)
        if (calls.length > 500) throw new Error('runaway chunk loop')
        return { index: i, total: Infinity, items: i === 0 ? [POEM_B] : [] }
      },
    }
    const h = createPoemHandler({ runtimeDir: mkTmp('whale-poem-a2-'), dataPort: port })
    const { value: r } = await capture(() => call(h.handlePoem, '/api/chubby-whale/poem'))
    ok('total=Infinity：只读 1 片', calls.length === 1, '实际 ' + calls.length)
    ok('total=Infinity：仍能念出诗', !!r.json && r.json.ok === true && r.json.item.title === POEM_B.title)
  }

  // A3：坏 total（非数字 / 0 / 负数 / 小数）都退化成 1 片，不抛
  for (const bad of ['abc', 0, -3, null, undefined, 2.9]) {
    const calls = []
    const port = {
      readPoemsChunk: async (i) => { calls.push(i); return { index: i, total: bad, items: i === 0 ? [POEM_C] : [] } },
    }
    const h = createPoemHandler({ runtimeDir: mkTmp('whale-poem-a3-'), dataPort: port })
    const { value: r } = await capture(() => call(h.handlePoem, '/api/chubby-whale/poem'))
    const want = String(bad) === '2.9' ? 2 : 1
    ok('total=' + String(bad) + '：按有限片读取，不 throw', !!r.json && r.json.ok === true && !!r.json.item && calls.length === want, '实际 ' + calls.length + ' 片')
  }

  // A4：空片 + 非数组 items + 只读 0..total-1
  {
    const calls = []
    const port = {
      readPoemsChunk: async (i) => {
        calls.push(i)
        if (i === 0) return { index: 0, total: 3, items: [POEM_A] }
        if (i === 1) return { index: 1, total: 3, items: [] }            // 空片
        if (i === 2) return { index: 2, total: 3, items: [POEM_C] }
        throw new Error('越界读取 chunk ' + i)                             // 读越界就该失败
      },
    }
    const h = createPoemHandler({ runtimeDir: mkTmp('whale-poem-a4-'), dataPort: port })
    const seen = []
    for (let n = 0; n < 6; n++) {
      const { value: r } = await capture(() => call(h.handlePoem, '/api/chubby-whale/poem'))
      if (r.json && r.json.item) seen.push(r.json.item.title)
    }
    ok('3 片（中片为空）：只读 0,1,2 三个下标', calls.slice(0, 3).join(',') === '0,1,2' && calls.every((i) => i >= 0 && i <= 2), calls.slice(0, 6).join(','))
    ok('空片不参与池子：只会念出第 0/2 片的诗', seen.length === 6 && seen.every((t) => t === POEM_A.title || t === POEM_C.title), seen.join(' / '))
    ok('空片不参与池子：两片的诗都能轮到', seen.indexOf(POEM_A.title) >= 0 && seen.indexOf(POEM_C.title) >= 0, seen.join(' / '))
  }

  // A5：chunk.items 非数组 → 忽略该片，不抛
  {
    const port = {
      readPoemsChunk: async (i) => ({ index: i, total: 2, items: i === 0 ? [POEM_A] : 'not-an-array' }),
    }
    const h = createPoemHandler({ runtimeDir: mkTmp('whale-poem-a5-'), dataPort: port })
    const { value: r } = await capture(() => call(h.handlePoem, '/api/chubby-whale/poem'))
    ok('非数组 items：忽略该片、第 0 片照常', !!r.json && r.json.ok === true && r.json.item.title === POEM_A.title)
  }
} catch (e) {
  ok('A 组可执行', false, String(e && e.stack || e))
}

// ===========================================================================
// B. 念诗随机池 + ?title=
// ===========================================================================
console.log('\n[B] 念诗随机池 / ?title= host/routes/poem.ts')
try {
  const { createPoemHandler } = await imp('src/host/routes/poem.ts')
  const lib = [POEM_A, POEM_B, POEM_C]
  const mkPort = (items, total = 1) => ({ readPoemsChunk: async (i) => ({ index: i, total, items: i === 0 ? items : [] }) })
  const dir = mkTmp('whale-poem-b-')
  const h = createPoemHandler({ runtimeDir: dir, dataPort: mkPort(lib) })

  // B1：一轮内不重复；一轮念完重来时不立刻重复上一首
  const titles = []
  for (let n = 0; n < 3; n++) {
    const { value: r } = await capture(() => call(h.handlePoem, '/api/chubby-whale/poem'))
    titles.push(r.json && r.json.item ? r.json.item.title : '')
  }
  ok('一轮 3 首：三首各不相同', new Set(titles).size === 3, titles.join(' / '))
  const { value: r4 } = await capture(() => call(h.handlePoem, '/api/chubby-whale/poem'))
  const t4 = r4.json && r4.json.item ? r4.json.item.title : ''
  ok('一轮念完重来：不立刻重复上一首', !!t4 && t4 !== titles[2], titles[2] + ' → ' + t4)
  ok('重来的仍是库里的诗', TITLES.indexOf(t4) >= 0, t4)

  // B2：?title= 精确命中
  {
    const { value: r } = await capture(() => call(h.handlePoem, '/api/chubby-whale/poem?title=' + encodeURIComponent('望岳')))
    ok('?title= 精确命中：matched:true + 对应诗', !!r.json && r.json.ok === true && r.json.matched === true && r.json.item.title === '望岳')
    ok('?title= 命中：text 按行拼接、元信息齐全', r.json.item.text === '岱宗夫如何' && r.json.item.author === '杜甫' && r.json.item.dynasty === '唐')
  }

  // B3：?title= 包含命中
  {
    const { value: r } = await capture(() => call(h.handlePoem, '/api/chubby-whale/poem?title=' + encodeURIComponent('夜思')))
    ok('?title= 包含命中：matched:true', !!r.json && r.json.matched === true && r.json.item.title === '静夜思')
  }

  // B4：?title= 没命中 → 回落随机，并明确 matched:false
  {
    const { value: r } = await capture(() => call(h.handlePoem, '/api/chubby-whale/poem?title=' + encodeURIComponent('不存在的诗')))
    ok('?title= 未命中：回落随机但仍 ok', !!r.json && r.json.ok === true && !!r.json.item && TITLES.indexOf(r.json.item.title) >= 0)
    ok('?title= 未命中：下发 matched:false', !!r.json && r.json.matched === false)
  }

  // B5：不带 ?title= → 不多出 matched 字段（保持原协议）
  {
    const { value: r } = await capture(() => call(h.handlePoem, '/api/chubby-whale/poem'))
    ok('不带 ?title=：响应不含 matched 字段', !!r.json && r.json.ok === true && !('matched' in r.json))
  }

  // B6：去重进度落盘（poem-seen.json 是字符串数组）
  {
    const arr = JSON.parse(readFileSync(join(dir, 'poem-seen.json'), 'utf8'))
    ok('去重进度落盘：字符串数组', Array.isArray(arr) && arr.length > 0 && arr.every((x) => typeof x === 'string'), JSON.stringify(arr).slice(0, 80))
  }

  // B7：空诗库 → ok:true + item:null + no-data（不是 500）
  {
    const empty = createPoemHandler({ runtimeDir: mkTmp('whale-poem-b7-'), dataPort: mkPort([]) })
    const { value: r } = await capture(() => call(empty.handlePoem, '/api/chubby-whale/poem'))
    ok('空诗库：ok:true + item:null + no-data', !!r.json && r.json.ok === true && r.json.item === null && r.json.reason === 'no-data')
    ok('空诗库：HTTP 200', r.code === 200, String(r.code))
  }

  // B8：端口抛错（数据源缺文件/坏 JSON 的等价表现）→ 降级 no-data + 留痕，不 500
  {
    const boom = createPoemHandler({ runtimeDir: mkTmp('whale-poem-b8-'), dataPort: { readPoemsChunk: async () => { throw new Error('boom') } } })
    const { value: r, logs } = await capture(() => call(boom.handlePoem, '/api/chubby-whale/poem'))
    ok('端口抛错：ok:true + item:null + no-data', !!r.json && r.json.ok === true && r.json.item === null && r.json.reason === 'no-data')
    ok('端口抛错：HTTP 200（不 500 崩）', r.code === 200, String(r.code))
    ok('端口抛错：POEM-LOAD-FAIL 留痕', logs.some((s) => s.indexOf('POEM-LOAD-FAIL') >= 0))
  }
} catch (e) {
  ok('B 组可执行', false, String(e && e.stack || e))
}

// ===========================================================================
// C. 文化三类 + 曲库
// ===========================================================================
console.log('\n[C] 文化 host/routes/culture.ts')
try {
  const { createCultureHandlers } = await imp('src/host/routes/culture.ts')
  const chengyu2 = [{ name: '一鼓作气', src: '《左传》', text: '第一次击鼓振作士气' }, { name: '亡羊补牢', src: '《战国策》', text: '羊跑了再修圈' }]
  const chengyu3 = chengyu2.concat([{ name: '守株待兔', src: '《韩非子》', text: '守着树桩等兔子' }])
  const idiom2 = [{ name: '七月流火', cat: '望文生义类', mean: '天气转凉', wrong: '易误解为：天气炎热' }, { name: '差强人意', cat: '望文生义类', mean: '大体令人满意', wrong: '易误解为：不满意' }]
  const minsu1 = [{ book: '聊斋', title: '画皮', text: '一个关于皮囊的故事' }]
  const mkPort = (over) => Object.assign({
    readCulture: async (kind) => {
      if (kind === 'chengyu') return chengyu3
      if (kind === 'idiom') return idiom2
      if (kind === 'minsu') return minsu1
      return []
    },
  }, over || {})

  // C1：小池子（2 条）连续 8 次：重来后不立刻重复上一则
  {
    const h = createCultureHandlers({ dataDir: mkTmp('whale-culture-c1-'), runtimeDir: mkTmp('whale-culture-c1-rt-'), dataPort: mkPort({ readCulture: async () => chengyu2 }) })
    const got = []
    for (let n = 0; n < 8; n++) {
      const { value: r } = await capture(() => call(h.handleCulture, '/api/chubby-whale/culture?type=chengyu'))
      got.push(r.json && r.json.item ? r.json.item.title : '')
    }
    let bad = ''
    for (let i = 1; i < got.length; i++) if (got[i] === got[i - 1]) bad = '第 ' + (i + 1) + ' 次=' + got[i]
    ok('池空重来：不立刻重复上一则（8 次无相邻重复）', !bad && got.length === 8, bad || got.join(' / '))
    ok('池空重来：两条都能轮到', new Set(got).size === 2, got.join(' / '))
  }

  // C2：一轮内不重复
  {
    const h = createCultureHandlers({ dataDir: mkTmp('whale-culture-c2-'), runtimeDir: mkTmp('whale-culture-c2-rt-'), dataPort: mkPort() })
    const got = []
    for (let n = 0; n < 3; n++) {
      const { value: r } = await capture(() => call(h.handleCulture, '/api/chubby-whale/culture?type=chengyu'))
      got.push(r.json.item.title)
    }
    ok('一轮 3 条：三条各不相同', new Set(got).size === 3, got.join(' / '))
  }

  // C3：一轮重来只清同一类别，别的类别进度保留
  {
    const runtime = mkTmp('whale-culture-c3-rt-')
    const h = createCultureHandlers({ dataDir: mkTmp('whale-culture-c3-'), runtimeDir: runtime, dataPort: mkPort({ readCulture: async (k) => (k === 'chengyu' ? chengyu2 : k === 'idiom' ? idiom2 : []) }) })
    await capture(() => call(h.handleCulture, '/api/chubby-whale/culture?type=chengyu'))
    await capture(() => call(h.handleCulture, '/api/chubby-whale/culture?type=chengyu'))
    const { value: idiomRes } = await capture(() => call(h.handleCulture, '/api/chubby-whale/culture?type=idiom'))
    const idiomName = idiomRes.json.item.title
    // 第三次成语 → 池空重来，只清 chengyu 前缀
    await capture(() => call(h.handleCulture, '/api/chubby-whale/culture?type=chengyu'))
    const seen = JSON.parse(readFileSync(join(runtime, 'culture-seen.json'), 'utf8'))
    ok('类别隔离：典故进度在成语重来后仍在', Array.isArray(seen.idioms) && seen.idioms.indexOf(idiomName) >= 0, JSON.stringify(seen.idioms))
    ok('类别隔离：成语重来后只记刚讲的一条', Array.isArray(seen.allusions) && seen.allusions.length === 1, JSON.stringify(seen.allusions))
    ok('落盘结构与 C# 版兼容（四个字段）', ['allusions', 'tales', 'idioms', 'minsu'].every((k) => Array.isArray(seen[k])), Object.keys(seen).join(','))
  }

  // C4：type 参数不是白名单 → 兜底说明；用户串绝不落进 DataPort（更不拼路径）
  {
    const kinds = []
    const h = createCultureHandlers({ dataDir: mkTmp('whale-culture-c4-'), runtimeDir: mkTmp('whale-culture-c4-rt-'), dataPort: mkPort({ readCulture: async (k) => { kinds.push(k); return chengyu2 } }) })
    const weird = ['__proto__', '../../etc/passwd', 'chengyu\u0000', 'CHENGYU', 'constructor', 'chengyu?x=1']
    let allUnknown = true
    for (const t of weird) {
      const { value: r } = await capture(() => call(h.handleCulture, '/api/chubby-whale/culture?type=' + encodeURIComponent(t)))
      if (!(r.json && r.json.ok === true && r.json.item && r.json.item.kind === 'unknown')) allUnknown = false
    }
    ok('未知/注入型 type：一律 ok:true + kind:unknown', allUnknown, weird.join(' | '))
    ok('type 只认三个字面量（用户串不进 DataPort）', kinds.every((k) => k === 'chengyu' || k === 'idiom' || k === 'minsu'), kinds.join(','))
    // 空 type 走默认成语（既有约定）
    const { value: rEmpty } = await capture(() => call(h.handleCulture, '/api/chubby-whale/culture?type='))
    ok('?type= 空值：按默认成语处理', !!rEmpty.json && rEmpty.json.item && rEmpty.json.item.kind === 'chengyu', rEmpty.json && rEmpty.json.item && rEmpty.json.item.kind)
  }

  // C5：空池 / 端口抛错 / 非数组 → ok:true item:null no-data，不 500
  {
    const empty = createCultureHandlers({ dataDir: mkTmp('whale-culture-c5-'), runtimeDir: mkTmp('whale-culture-c5-rt-'), dataPort: mkPort({ readCulture: async () => [] }) })
    const { value: e } = await capture(() => call(empty.handleCulture, '/api/chubby-whale/culture?type=chengyu'))
    ok('空池：ok:true + item:null + no-data', !!e.json && e.json.ok === true && e.json.item === null && e.json.reason === 'no-data')

    const boom = createCultureHandlers({ dataDir: mkTmp('whale-culture-c5b-'), runtimeDir: mkTmp('whale-culture-c5b-rt-'), dataPort: mkPort({ readCulture: async () => { throw new Error('boom') } }) })
    const { value: b, logs } = await capture(() => call(boom.handleCulture, '/api/chubby-whale/culture?type=idiom'))
    ok('端口抛错：ok:true + item:null + no-data（HTTP 200）', !!b.json && b.json.ok === true && b.json.item === null && b.code === 200)
    ok('端口抛错：CULTURE-LOAD-FAIL 留痕', logs.some((s) => s.indexOf('CULTURE-LOAD-FAIL') >= 0))

    const weird = createCultureHandlers({ dataDir: mkTmp('whale-culture-c5c-'), runtimeDir: mkTmp('whale-culture-c5c-rt-'), dataPort: mkPort({ readCulture: async () => ({ not: 'array' }) }) })
    const { value: w } = await capture(() => call(weird.handleCulture, '/api/chubby-whale/culture?type=minsu'))
    ok('端口违约（非数组）：按空池降级', !!w.json && w.json.ok === true && w.json.item === null && w.json.reason === 'no-data')
  }

  // C6：条目字段映射（民间故事「书名·标题」、典故「易误解为」不重复前缀）
  {
    const h = createCultureHandlers({ dataDir: mkTmp('whale-culture-c6-'), runtimeDir: mkTmp('whale-culture-c6-rt-'), dataPort: mkPort() })
    const { value: m } = await capture(() => call(h.handleCulture, '/api/chubby-whale/culture?type=minsu'))
    ok('民间故事：标题「书名·标题」+ 正文', !!m.json && m.json.item.title === '聊斋·画皮' && m.json.item.text === '一个关于皮囊的故事')
    const { value: i1 } = await capture(() => call(h.handleCulture, '/api/chubby-whale/culture?type=idiom'))
    const it = i1.json && i1.json.item && i1.json.item.text
    ok('典故：mean + 易误解（前缀只出现一次、不叠加）',
      typeof it === 'string' && /^(天气转凉|大体令人满意)；易误解为：(天气炎热|不满意)$/.test(it) && it.split('易误解为：').length === 2,
      String(it))
  }

  // C7：曲库（melodies.json 是路由直接读的只读数据文件，既有实现，未改）
  {
    const dataDir = mkTmp('whale-culture-c7-')
    writeFileSync(join(dataDir, 'melodies.json'), JSON.stringify({ songs: [{ name: '小星星', bpm: 120, notes: [1, 2, 3], lyrics: '一闪一闪' }] }))
    const h = createCultureHandlers({ dataDir, runtimeDir: mkTmp('whale-culture-c7-rt-'), dataPort: mkPort() })
    const { value: list } = await capture(() => call(h.handleMelodies, '/api/chubby-whale/melodies'))
    ok('曲目列表：只露 name/bpm', !!list.json && list.json.ok === true && list.json.songs.length === 1 && !('notes' in list.json.songs[0]))
    const { value: song } = await capture(() => call(h.handleMelody, '/api/chubby-whale/melody?name=' + encodeURIComponent('小星星')))
    ok('按名字取曲谱：notes 齐全', !!song.json && song.json.ok === true && song.json.song.notes.length === 3 && song.json.song.bpm === 120)
    const { value: miss } = await capture(() => call(h.handleMelody, '/api/chubby-whale/melody?name=' + encodeURIComponent('不存在的歌')))
    ok('未知曲名：ok:false（HTTP 200）', !!miss.json && miss.json.ok === false && miss.json.error === 'song not found' && miss.code === 200)
    const gone = createCultureHandlers({ dataDir: join(dataDir, 'nope'), runtimeDir: mkTmp('whale-culture-c7b-rt-'), dataPort: mkPort() })
    const { value: mf } = await capture(() => call(gone.handleMelodies, '/api/chubby-whale/melodies'))
    ok('曲库缺失：ok:false + songs:[]', !!mf.json && mf.json.ok === false && Array.isArray(mf.json.songs) && mf.json.songs.length === 0)
  }
} catch (e) {
  ok('C 组可执行', false, String(e && e.stack || e))
}

// ===========================================================================
// D. 每日一句
// ===========================================================================
console.log('\n[D] 每日一句 host/routes/daily.ts')
try {
  const dailyMod = await imp('src/host/routes/daily.ts')
  const { createDailyHandler, todayKey, dayIndexOf, pickDailyItem, pickPoemForDay } = dailyMod

  // D1：todayKey / dayIndexOf
  ok('todayKey：本地日期补零', todayKey(new Date(2026, 0, 5, 23, 0, 0)) === '2026-01-05', todayKey(new Date(2026, 0, 5)))
  ok('dayIndexOf：闰日 2024-02-29 合法', Number.isFinite(dayIndexOf('2024-02-29')))
  ok('dayIndexOf：闰日前后差 1 天', dayIndexOf('2024-03-01') - dayIndexOf('2024-02-29') === 1)
  ok('dayIndexOf：平年 2023-02-29 非法', Number.isNaN(dayIndexOf('2023-02-29')))
  ok('dayIndexOf：2019-02-30 非法（Date.UTC 会进位）', Number.isNaN(dayIndexOf('2019-02-30')))
  ok('dayIndexOf：非补零日期等价于补零', dayIndexOf('2026-9-1') === dayIndexOf('2026-09-01'))
  ok('dayIndexOf：非法输入一律 NaN', ['', 'abc', '2026-13-01', '2026-00-10', '2026-01-32', null, undefined].every((s) => Number.isNaN(dayIndexOf(s))))

  // D2：pickDailyItem（精确 → 不晚于今天最近一条 → 全是未来取最早）
  {
    const items = [
      { date: '2026-9-30', text: '九月三十' },
      { date: '2026-10-01', text: '十月一日' },
      { date: '2019-02-30', text: '非法日期应丢弃' },
      { date: '2026-11-07', text: '今天' },
      { date: '2026-12-31', text: '未来的' },
      { date: '', text: '空日期' },
      { date: '2026-11-06', text: '' },
      null,
      'not-an-item',
    ]
    const exact = pickDailyItem(items, '2026-11-07')
    ok('pickDailyItem：日期完全匹配优先', !!exact && exact.text === '今天')
    const past = pickDailyItem(items, '2026-11-20')
    ok('pickDailyItem：不晚于今天的最近一条（非补零日期按日序号比较）', !!past && past.text === '今天', past && past.text)
    const past2 = pickDailyItem(items, '2026-10-15')
    ok('pickDailyItem：2026-9-30 早于 2026-10-01（不按字符串比）', !!past2 && past2.text === '十月一日', past2 && past2.text)
    const future = pickDailyItem([{ date: '2026-12-31', text: '晚的' }, { date: '2026-12-01', text: '早的' }], '2026-11-07')
    ok('pickDailyItem：全是未来日期 → 取最早一条', !!future && future.text === '早的', future && future.text)
    ok('pickDailyItem：空表 / 全非法 → null', pickDailyItem([], '2026-11-07') === null && pickDailyItem([null, { date: 'x', text: 'y' }], '2026-11-07') === null)
  }

  // D3：pickPoemForDay（下标 = 日序号 mod 诗库长度；坏条目环形跳过）
  {
    const poems = [
      { title: '坏', lines: [] },                                     // 坏：缺行
      { title: '乙', dynasty: '唐', author: '某人', lines: ['乙一', '乙二'] },
      { title: '丙', dynasty: '宋', author: '另一人', lines: ['丙一'] },
    ]
    ok('pickPoemForDay：空库 / 非法日期 → null', pickPoemForDay([], '2026-11-07') === null && pickPoemForDay(poems, '2026-13-01') === null)
    const s1 = pickPoemForDay(poems, '2026-11-07')
    const s2 = pickPoemForDay(poems, '2026-11-07')
    ok('pickPoemForDay：同一天必然同一首（下标 = 日序号 mod 长度）', !!s1 && !!s2 && s1.index === 1 && s1.index === s2.index, s1 && String(s1.index))
    const n1 = pickPoemForDay(poems, '2026-11-08')
    ok('pickPoemForDay：相邻两天不同（长度>1）', !!n1 && n1.index === 2 && n1.index !== s1.index, (s1 && s1.index) + ' → ' + (n1 && n1.index))
    const ring = pickPoemForDay(poems, '1970-01-01')                // 第 0 天下标 0 = 坏条目 → 环形到 1
    ok('pickPoemForDay：挑到坏条目时向后环形找第一首可读的', !!ring && ring.index === 1, ring && String(ring.index))
    ok('pickPoemForDay：正文按行直连、source 为《题》 朝代·作者', !!ring && ring.text === '乙一乙二' && ring.source === '《乙》 唐·某人', ring && ring.source)
    const neg = pickPoemForDay(poems, '1969-12-31')
    ok('pickPoemForDay：负日序号不越界', !!neg && neg.index >= 0 && neg.index < poems.length, neg && String(neg.index))
  }

  // D4：处理器：有 daily 用 daily
  {
    const mkPort = (over) => Object.assign({ readDaily: async () => [], readPoemsChunk: async () => ({ index: 0, total: 1, items: [POEM_A] }) }, over || {})
    const h = createDailyHandler({ dataPort: mkPort({ readDaily: async () => [{ date: '2026-11-07', type: 'poem', text: '今日一句', source: '某书' }] }), now: () => new Date(2026, 10, 7, 9, 0, 0) })
    const { value: r } = await capture(() => call(h.handleDaily, '/api/chubby-whale/daily'))
    ok('daily 命中：ok:true + 原文 + source + from=daily', !!r.json && r.json.ok === true && r.json.date === '2026-11-07' && r.json.text === '今日一句' && r.json.source === '某书' && r.json.from === 'daily')
  }

  // D5：daily 缺条目 → 诗库兜底（不编造）
  {
    const mkPort = (over) => Object.assign({
      readDaily: async () => [{ date: '2020-01-01', text: '' }],
      readPoemsChunk: async () => ({ index: 0, total: 1, items: [POEM_A, POEM_B] }),
    }, over || {})
    const h = createDailyHandler({ dataPort: mkPort(), now: () => new Date(2026, 10, 7, 9, 0, 0) })
    const { value: r } = await capture(() => call(h.handleDaily, '/api/chubby-whale/daily'))
    ok('无可用 daily：回落诗库（from=poem）', !!r.json && r.json.ok === true && r.json.from === 'poem')
    ok('回落诗库：正文与 source 来自真实诗', !!r.json && (r.json.text === '床前明月光疑是地上霜' || r.json.text === '岱宗夫如何') && /^《(静夜思|望岳)》 唐·/.test(r.json.source), r.json && r.json.source)
  }

  // D6：daily 抛错 + 诗库为空 → ok:false no-data（不是 500）
  {
    const h = createDailyHandler({ dataPort: { readDaily: async () => { throw new Error('daily boom') }, readPoemsChunk: async () => ({ index: 0, total: 1, items: [] }) }, now: () => new Date(2026, 10, 7) })
    const { value: r } = await capture(() => call(h.handleDaily, '/api/chubby-whale/daily'))
    ok('daily 抛错 + 空诗库：ok:false no-data（HTTP 200）', !!r.json && r.json.ok === false && r.json.error === 'no-data' && r.code === 200 && r.json.date === '2026-11-07')
    const h2 = createDailyHandler({ dataPort: { readDaily: async () => { throw new Error('x') }, readPoemsChunk: async () => { throw new Error('y') } }, now: () => new Date(2026, 10, 7) })
    const { value: r2 } = await capture(() => call(h2.handleDaily, '/api/chubby-whale/daily'))
    ok('两条数据源都抛错：仍 ok:false no-data（不 reject）', !!r2.json && r2.json.ok === false && r2.json.error === 'no-data')
  }

  // D7：方法限制
  {
    const h = createDailyHandler({ dataPort: { readDaily: async () => [] }, now: () => new Date(2026, 10, 7) })
    const { value: post } = await capture(() => call(h.handleDaily, '/api/chubby-whale/daily', { method: 'POST' }))
    ok('非 GET/HEAD → 405', post.code === 405 && !!post.json && post.json.ok === false && post.json.error === 'METHOD_NOT_ALLOWED')
    const { value: head } = await capture(() => call(h.handleDaily, '/api/chubby-whale/daily', { method: 'HEAD' }))
    ok('HEAD 放行（Node 自身不带 body）', head.code === 200)
  }
} catch (e) {
  ok('D 组可执行', false, String(e && e.stack || e))
}

// ===========================================================================
// E. 诗名索引
// ===========================================================================
console.log('\n[E] 诗名索引 host/routes/poem-titles.ts')
try {
  const { createPoemTitlesHandler } = await imp('src/host/routes/poem-titles.ts')

  // E1：成功 + 过滤非字符串
  {
    const dir = mkTmp('whale-ptitles-e1-')
    writeFileSync(join(dir, 'poem-titles.json'), JSON.stringify({ titles: ['静夜思', '', '望岳', 42, null] }))
    const h = createPoemTitlesHandler({ dataDir: dir })
    const { value: r } = await capture(() => call(h.handlePoemTitles, '/api/chubby-whale/poem-titles'))
    ok('成功：ok:true + count 与 titles 一致', !!r.json && r.json.ok === true && r.json.count === r.json.titles.length)
    ok('成功：过滤空串/非字符串', JSON.stringify(r.json.titles) === JSON.stringify(['静夜思', '望岳']), JSON.stringify(r.json.titles))

    // E2：成功结果进程内缓存（删掉文件仍 ok）
    rmSync(join(dir, 'poem-titles.json'))
    const { value: r2 } = await capture(() => call(h.handlePoemTitles, '/api/chubby-whale/poem-titles'))
    ok('成功结果缓存：文件删掉后仍 ok（只缓存成功）', !!r2.json && r2.json.ok === true && r2.json.titles.length === 2)
  }

  // E3：缺文件 → ok:false + titles:[]，HTTP 200
  {
    const dir = mkTmp('whale-ptitles-e3-')
    const h = createPoemTitlesHandler({ dataDir: dir })
    const { value: r, logs } = await capture(() => call(h.handlePoemTitles, '/api/chubby-whale/poem-titles'))
    ok('缺文件：ok:false + titles:[]（HTTP 200）', !!r.json && r.json.ok === false && Array.isArray(r.json.titles) && r.json.titles.length === 0 && r.code === 200)
    ok('缺文件：error 有值 + POEM-TITLES-LOAD-FAIL 留痕', typeof r.json.error === 'string' && r.json.error.length > 0 && logs.some((s) => s.indexOf('POEM-TITLES-LOAD-FAIL') >= 0))

    // E4：失败不缓存（补回文件即恢复）
    writeFileSync(join(dir, 'poem-titles.json'), JSON.stringify({ titles: ['春晓'] }))
    const { value: r2 } = await capture(() => call(h.handlePoemTitles, '/api/chubby-whale/poem-titles'))
    ok('失败不缓存：补回文件后立即恢复', !!r2.json && r2.json.ok === true && r2.json.titles[0] === '春晓')
  }

  // E5：坏 JSON / 空表 → ok:false
  {
    const dir = mkTmp('whale-ptitles-e5-')
    writeFileSync(join(dir, 'poem-titles.json'), '{ titles: [')
    const h = createPoemTitlesHandler({ dataDir: dir })
    const { value: r } = await capture(() => call(h.handlePoemTitles, '/api/chubby-whale/poem-titles'))
    ok('坏 JSON：ok:false（不抛）', !!r.json && r.json.ok === false && r.code === 200)
    const dir2 = mkTmp('whale-ptitles-e5b-')
    writeFileSync(join(dir2, 'poem-titles.json'), JSON.stringify({ titles: [] }))
    const h2 = createPoemTitlesHandler({ dataDir: dir2 })
    const { value: r2 } = await capture(() => call(h2.handlePoemTitles, '/api/chubby-whale/poem-titles'))
    ok('空表：ok:false（不返回 count=0 的「成功」）', !!r2.json && r2.json.ok === false && Array.isArray(r2.json.titles) && r2.json.titles.length === 0)
  }
} catch (e) {
  ok('E 组可执行', false, String(e && e.stack || e))
}

// ===========================================================================
// F. 封装取证：内容数据只经注入的 DataPort
// ===========================================================================
console.log('\n[F] 封装取证（路由只经 DataPort 取内容数据）')
try {
  const { createPoemHandler } = await imp('src/host/routes/poem.ts')
  const { createCultureHandlers } = await imp('src/host/routes/culture.ts')
  const { createDailyHandler } = await imp('src/host/routes/daily.ts')

  // F1：data/ 里放同名诱饵文件，端口给另一份数据 → 响应必须是端口那份
  {
    const dataDir = mkTmp('whale-wrap-f1-')
    mkdirSync(join(dataDir, 'culture'), { recursive: true })
    writeFileSync(join(dataDir, 'poems.json'), JSON.stringify({ poems: [{ title: '文件里的诗', author: '文件', dynasty: '唐', lines: ['文件句'] }] }))
    writeFileSync(join(dataDir, 'culture', 'chengyu.json'), JSON.stringify([{ name: '文件里的成语', src: '文件', text: '文件正文' }]))
    writeFileSync(join(dataDir, 'daily.json'), JSON.stringify({ items: [{ date: '2026-11-07', text: '文件里的每日' }] }))
    const runtime = mkTmp('whale-wrap-f1-rt-')

    const poem = createPoemHandler({ dataDir, runtimeDir: mkTmp('whale-wrap-f1-poem-'), dataPort: { readPoemsChunk: async () => ({ index: 0, total: 1, items: [POEM_A] }) } })
    const { value: pr } = await capture(() => call(poem.handlePoem, '/api/chubby-whale/poem'))
    ok('念诗：取端口数据，不读 data/poems.json', !!pr.json && pr.json.item && pr.json.item.title === POEM_A.title, pr.json && pr.json.item && pr.json.item.title)

    const culture = createCultureHandlers({ dataDir, runtimeDir: runtime, dataPort: { readCulture: async () => [{ name: '端口里的成语', src: '端口', text: '端口正文' }] } })
    const { value: cr } = await capture(() => call(culture.handleCulture, '/api/chubby-whale/culture?type=chengyu'))
    ok('文化：取端口数据，不读 data/culture/chengyu.json', !!cr.json && cr.json.item && cr.json.item.title === '端口里的成语', cr.json && cr.json.item && cr.json.item.title)

    const daily = createDailyHandler({ dataPort: { readDaily: async () => [{ date: '2026-11-07', text: '端口里的每日' }], readPoemsChunk: async () => ({ index: 0, total: 1, items: [POEM_A] }) }, now: () => new Date(2026, 10, 7) })
    const { value: dr } = await capture(() => call(daily.handleDaily, '/api/chubby-whale/daily'))
    ok('每日：取端口数据（daily 路由不接受 dataDir，结构上无文件入口）', !!dr.json && dr.json.text === '端口里的每日' && dr.json.from === 'daily')
  }

  // F2：静态取证（源码层）
  {
    const poemSrc = readFileSync(join(ROOT, 'src/host/routes/poem.ts'), 'utf8')
    const cultureSrc = readFileSync(join(ROOT, 'src/host/routes/culture.ts'), 'utf8')
    const dailySrc = readFileSync(join(ROOT, 'src/host/routes/daily.ts'), 'utf8')
    ok('poem.ts 不出现数据文件名 poems.json 的字面量（只碰运行目录的 poem-seen.json）', !/['"]poems\.json['"]/.test(poemSrc) && /dataPort\.readPoemsChunk/.test(poemSrc))
    ok('culture.ts 内容数据走 dataPort.readCulture', /dataPort\.readCulture/.test(cultureSrc))
    ok('daily.ts 不 import node:fs（内容数据只走 DataPort）', !/from 'node:fs'/.test(dailySrc) && /dataPort\.readDaily/.test(dailySrc))
  }

  // F3：已知封装缺口（本次不修，需 DataPort 扩口；仅提示，不计失败）
  console.log('  ℹ 已知缺口（未改，需 ports.ts 增方法）：poem-titles.ts 直接 readFileSync data/poem-titles.json；' +
    'culture.ts 的 handleMelodies/handleMelody 直接 readFile data/melodies.json')
} catch (e) {
  ok('F 组可执行', false, String(e && e.stack || e))
}

// ---------------------------------------------------------------------------
for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }) } catch { } }
console.log('\n────────────────────')
console.log((fail === 0 ? '✅ ' : '❌ ') + '内容路由通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
