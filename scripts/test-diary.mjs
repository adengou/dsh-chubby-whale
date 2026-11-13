/**
 * scripts/test-diary.mjs —— 离线日记（src/client/diary.ts）离线回归
 *
 * 覆盖任务要求的八条硬断言，另加边界与语气档：
 *   ① 离线 1 小时 → null；2 小时整 → 开始写「今天的碎片」
 *   ② 离线 3 小时 → 非空、含「本鲸」、2–4 句短句
 *   ③ 离线 20 小时 → 非空且与 3 小时版本不同（昨晚的梦）
 *   ④ 同一输入两次结果完全相同（确定性；没有随机、没有读时钟）
 *   ⑤ summary 关键词能被织进文本（材料 / 代码 / 音乐 / 猫 多组验证，最多 2 个）
 *   ⑥ summary 为空不抛且文本非空
 *   ⑦ 文本不包含无法从输入得到的编造事实（无数字、无「第 N」、无具体操作，不回显原词）
 *   ⑧ 非法输入（NaN / 缺字段 / null / 时间倒流）返回 null 或安全文本，不抛
 *
 * 做法与 test-whale-speak.mjs 同口径：esbuild 把 src/client/diary.ts 打成自包含
 * ESM（项目内 .tmp-tests 临时目录，跑完即删），再从文件 URL 导入——测的是构建后的
 * 同一份代码；不碰 dist、不联网、不启动服务。
 *
 * 用法：node scripts/test-diary.mjs（全绿退出码 0；有失败退出码 1）
 */

import { build } from 'esbuild'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SRC = join(ROOT, 'src')
const SRC_FILE = join(SRC, 'client', 'diary.ts')
/** 项目内临时目录：esbuild 子进程写系统临时目录会被 Windows ACL 拒（与 verify-voice 同口径） */
const TMP = join(ROOT, '.tmp-tests', 'diary-' + process.pid + '-' + Date.now().toString(36))
const BUNDLE = join(TMP, 'diary.mjs')

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.error('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

// ---------- esbuild：只打这一个模块，产物落项目内临时目录 ----------
try {
  mkdirSync(TMP, { recursive: true })
  await build({
    stdin: {
      contents: "export * from './client/diary.js'\n",
      resolveDir: SRC,
      sourcefile: 'diary-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    charset: 'utf8',
    logLevel: 'silent',
    outfile: BUNDLE,
  })
} catch (e) {
  console.error('  ❌ esbuild 打包失败：' + String((e && e.message) || e))
  process.exit(1)
}

const mod = await import(pathToFileURL(BUNDLE).href)
try { rmSync(TMP, { recursive: true, force: true }) } catch { /* 临时目录删不掉不影响结论 */ }

const buildDiary = mod.buildDiary

// ---------- 固定基准（模块不读时钟，测试也不依赖运行时刻） ----------
const HOUR = 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 13, 12, 0, 0)
const ago = (h) => NOW - h * HOUR
const input = (h, extra = {}) => ({ now: NOW, lastSeenAt: ago(h), ...extra })

const sentences = (s) => (typeof s === 'string' ? s.match(/[^。！？]+[。！？]/g) || [] : [])
const isShortDiary = (s) => {
  const list = sentences(s)
  return list.length >= 2 && list.length <= 4 && list.every((one) => Array.from(one).length <= 40)
}
const run = (fn) => {
  try { return { value: fn(), error: null } } catch (e) { return { value: null, error: e } }
}
const show = (v) => (v === null ? 'null' : v === undefined ? 'undefined' : JSON.stringify(v))

// ======================================================================
console.log('\n[0] 装载与源码约束')
ok('esbuild 打包 src/client/diary.ts 并成功导入', typeof buildDiary === 'function', SRC_FILE)
ok('运行时只导出 buildDiary（类型在构建时擦除）', Object.keys(mod).join(',') === 'buildDiary', Object.keys(mod).join(','))

const raw = readFileSync(SRC_FILE, 'utf8')
// 去掉注释再扫，避免把「不读系统时钟」这类说明文字当成真调用
const codeOnly = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
ok('源码零 import / require', !/^\s*import\b/m.test(codeOnly) && !/\brequire\s*\(/.test(codeOnly))
ok('源码不读系统时钟', !/Date\.now/.test(codeOnly) && !/new Date\b/.test(codeOnly) && !/\bperformance\.now/.test(codeOnly))
ok('源码不用 Math.random（同一输入必然同一文本）', !/Math\.random/.test(codeOnly))
ok('源码不碰存储 / DOM / 网络', !/localStorage|sessionStorage|document\.|window\.|fetch\(/.test(codeOnly))

// ======================================================================
console.log('\n[1] 离线时长分档：<2h 不写，2–12h 碎片，>=12h 梦')
ok('离线 0 小时 → null', buildDiary(input(0)) === null)
ok('离线 1 小时 → null', buildDiary(input(1)) === null)
ok('离线 1.999 小时 → null', buildDiary(input(1.999)) === null)

const t2 = buildDiary(input(2))
ok('恰好 2 小时 → 写「今天见到你之前」', typeof t2 === 'string' && t2.includes('今天'), show(t2))
ok('2 小时文本 2–4 句、每句 ≤40 字', isShortDiary(t2), JSON.stringify(sentences(t2)))

const t3 = buildDiary(input(3))
ok('离线 3 小时 → 非空且含「本鲸」', typeof t3 === 'string' && t3.includes('本鲸'), show(t3))
ok('3 小时文本 2–4 句、每句 ≤40 字', isShortDiary(t3), JSON.stringify(sentences(t3)))

const t1199 = buildDiary(input(11.99))
ok('11.99 小时仍是当天碎片（未到 12 小时）', typeof t1199 === 'string' && t1199.includes('今天') && !t1199.includes('昨晚'))

const t12 = buildDiary(input(12))
ok('恰好 12 小时 → 切到「昨晚的梦」', typeof t12 === 'string' && t12.includes('昨晚'), show(t12))

const t20 = buildDiary(input(20))
ok('离线 20 小时 → 非空且含「本鲸」', typeof t20 === 'string' && t20.includes('本鲸'), show(t20))
ok('20 小时文本 2–4 句、每句 ≤40 字', isShortDiary(t20), JSON.stringify(sentences(t20)))
ok('20 小时与 3 小时文本不同', t20 !== t3)
ok('20 小时是梦、3 小时是当天碎片', t20.includes('昨晚') && t3.includes('今天') && !t3.includes('昨晚'))

// ======================================================================
console.log('\n[2] 确定性：同一输入反复调用完全一致')
{
  const cases = [
    ['3 小时', input(3)],
    ['20 小时', input(20)],
    ['带 summary / 事件 / 亲密度', input(20, { summary: '今天整理材料，改代码到很晚。', recentEvent: 'long-work', intimacy: 62 })],
    ['空 summary', input(20, { summary: '' })],
    ['低亲密度', input(20, { intimacy: 10 })],
  ]
  for (const [name, data] of cases) {
    const a = buildDiary(data)
    const b = buildDiary(data)
    const c = buildDiary(data)
    const copy = buildDiary(JSON.parse(JSON.stringify(data)))
    ok(name + '：连调 3 次一字不差', typeof a === 'string' && a === b && b === c)
    ok(name + '：同值不同对象结果一致', typeof a === 'string' && a === copy)
  }
}

// ======================================================================
console.log('\n[3] summary 关键词 → 抽象意象（最多 2 个，按出现顺序）')
{
  const paper = buildDiary(input(20, { summary: '今天整理材料。' }))
  ok('「材料」→「一叠纸」被织进梦里', typeof paper === 'string' && paper.includes('一叠纸'), show(paper))
  ok('只做抽象转述：不回显「材料」原词', typeof paper === 'string' && !paper.includes('材料'))

  const code = buildDiary(input(3, { summary: '改了一天代码。' }))
  ok('「代码」→「发光的小格子」被织进碎片', typeof code === 'string' && code.includes('发光的小格子'), show(code))
  ok('只做抽象转述：不回显「代码」原词', typeof code === 'string' && !code.includes('代码'))

  const both = buildDiary(input(20, { summary: '先整理材料，再改代码。' }))
  ok('两个不同关键词都进同一篇', typeof both === 'string' && both.includes('一叠纸') && both.includes('发光的小格子'), show(both))
  ok('两个关键词时仍是 2–4 句', isShortDiary(both), JSON.stringify(sentences(both)))

  const music = buildDiary(input(3, { summary: '夜里听音乐，还摸了摸猫。' }))
  ok('另一组关键词：音乐→音符、猫→小影子', typeof music === 'string' && music.includes('会游的音符') && music.includes('会摆尾的小影子'), show(music))
  ok('不同关键词产出不同文本', both !== paper && music !== code && music !== both)

  const order = buildDiary(input(20, { summary: '先改代码，再整理材料。' }))
  ok('关键词顺序按 summary 出现顺序（代码在材料前）',
    typeof order === 'string' && order.indexOf('发光的小格子') >= 0 && order.indexOf('一叠纸') >= 0 &&
    order.indexOf('发光的小格子') < order.indexOf('一叠纸'))

  const cap = buildDiary(input(20, { summary: '材料。代码。咖啡。猫。' }))
  ok('最多只织 2 个关键词（后两个不进入）',
    typeof cap === 'string' && cap.includes('一叠纸') && cap.includes('发光的小格子') &&
    !cap.includes('暖暖的涟漪') && !cap.includes('会摆尾的小影子'))
}

// ======================================================================
console.log('\n[4] summary 为空 / 缺省 / 非法类型：不抛且文本非空')
{
  const empty = buildDiary(input(20, { summary: '' }))
  const blank = buildDiary(input(3, { summary: '   \n\t ' }))
  const missing = buildDiary(input(20))
  ok('summary 空串 → 安全文本', typeof empty === 'string' && empty.length > 0, show(empty))
  ok('summary 纯空白 → 安全文本', typeof blank === 'string' && blank.length > 0, show(blank))
  ok('summary 缺省 → 安全文本', typeof missing === 'string' && missing.length > 0, show(missing))
  ok('空 summary 的梦与碎片仍是 2–4 句', isShortDiary(empty) && isShortDiary(blank))
  ok('空 summary 时纯环境描写也含「本鲸」', empty.includes('本鲸') && blank.includes('本鲸'))

  for (const bad of [null, 42, {}, [], true]) {
    const r = run(() => buildDiary(input(20, { summary: bad })))
    ok('summary=' + show(bad) + ' 不抛且安全',
      r.error === null && (r.value === null || (typeof r.value === 'string' && r.value.length > 0)))
  }
}

// ======================================================================
console.log('\n[5] 不编造无法从输入得到的具体事实')
{
  const corpus = [t2, t3, t12, t20]
  for (const s of ['今天整理材料。', '改了一天代码。', '夜里听音乐，还摸了摸猫。', '先整理材料，再改代码。']) {
    corpus.push(buildDiary(input(20, { summary: s })))
    corpus.push(buildDiary(input(3, { summary: s })))
  }
  corpus.push(buildDiary(input(20, { recentEvent: 'long-work', intimacy: 80 })))
  corpus.push(buildDiary(input(20, { recentEvent: 'late-night', intimacy: 10 })))

  ok('文本不含阿拉伯数字（不编数量 / 行号 / 时刻）', corpus.every((s) => typeof s === 'string' && !/[0-9０-９]/.test(s)))
  ok('文本不含「第 + 数字/序数」这类具体坐标', corpus.every((s) => !/第\s*[0-9０-９一二三四五六七八九十百千万两]/.test(s)))
  ok('文本不含编造的具体操作（删 / 提交 / 发送 / 打开…）', corpus.every((s) => !/删|提交|发送|购买|打开|修改了|写了/.test(s)))
  ok('不回显 summary 原词（材料 / 代码 / 音乐 / 猫）', corpus.every((s) => !/材料|代码|音乐|猫/.test(s)))
  ok('文本是单段、无换行', corpus.every((s) => !/[\r\n]/.test(s)))
}

// ======================================================================
console.log('\n[6] 非法输入：返回 null 或安全文本，不抛')
{
  const tolerate = [
    null, undefined, 42, 'diary', [], true, () => {},
    {}, { now: NOW }, { lastSeenAt: ago(3) },
    { now: NaN, lastSeenAt: ago(3) },
    { now: NOW, lastSeenAt: NaN },
    { now: Infinity, lastSeenAt: ago(3) },
    { now: NOW, lastSeenAt: -Infinity },
    { now: 'not-a-time', lastSeenAt: ago(3) },
    { now: NOW, lastSeenAt: 'not-a-time' },
    { now: Symbol('now'), lastSeenAt: ago(3) },
    { now: NOW, lastSeenAt: Symbol('seen') },
  ]
  let threw = null
  let allSafe = true
  for (const bad of tolerate) {
    const r = run(() => buildDiary(bad))
    if (r.error) threw = r.error
    if (!(r.value === null || (typeof r.value === 'string' && r.value.length > 0))) allSafe = false
  }
  ok('非法输入全部不抛错', threw === null, threw ? String(threw.message) : '')
  ok('非法输入返回 null 或非空安全文本', allSafe)

  const mustNull = [
    null, undefined, {}, { now: NOW }, { lastSeenAt: ago(3) },
    { now: NaN, lastSeenAt: ago(3) }, { now: NOW, lastSeenAt: NaN },
    { now: NOW, lastSeenAt: NOW + 5 * HOUR },
  ]
  ok('NaN / 缺字段 / 时间倒流 → 明确返回 null', mustNull.every((x) => buildDiary(x) === null))

  const nanIntimacy = run(() => buildDiary(input(20, { intimacy: NaN })))
  ok('亲密度 NaN → 仍给安全文本（按中间档）', nanIntimacy.error === null && typeof nanIntimacy.value === 'string' && nanIntimacy.value.length > 0)

  const symIntimacy = run(() => buildDiary(input(20, { intimacy: Symbol('i') })))
  ok('亲密度 Symbol → 不抛且按中间档给文本',
    symIntimacy.error === null && symIntimacy.value === buildDiary(input(20)))

  const protoEvent = run(() => buildDiary(input(20, { recentEvent: 'toString' })))
  ok('recentEvent 撞原型键（toString）→ 不抛且回落默认环境句',
    protoEvent.error === null && protoEvent.value === buildDiary(input(20)))
}

// ======================================================================
console.log('\n[7] 亲密度分档：低疏离、高黏人、缺省按中间档')
{
  const low = buildDiary(input(20, { intimacy: 10 }))
  const midDefault = buildDiary(input(20))
  const mid50 = buildDiary(input(20, { intimacy: 50 }))
  const high = buildDiary(input(20, { intimacy: 80 }))
  ok('低亲密度（10）更疏离：含「深一点的水里」', typeof low === 'string' && low.includes('深一点的水里'), show(low))
  ok('高亲密度（80）更黏人：含「梦见你回来了」', typeof high === 'string' && high.includes('梦见你回来了'), show(high))
  ok('低 / 中 / 高三档文本互不相同', low !== mid50 && mid50 !== high && low !== high)
  ok('缺省亲密度按中间档（与 50 完全一致）', midDefault === mid50)
  ok('低亲密度碎片也写「深一点的水里」', String(buildDiary(input(3, { intimacy: 10 }))).includes('深一点的水里'))
  ok('高亲密度碎片更黏人（含「数着泡泡等你」）', String(buildDiary(input(3, { intimacy: 90 }))).includes('数着泡泡等你'))
}

// ======================================================================
console.log('\n[8] 最近事件：只影响一句环境描写，不编具体时刻')
{
  const events = {
    'long-work': '主人忙的时候',
    'late-night': '夜里的海',
    'idle': '数泡泡数到发呆',
    'welcome-back': '把尾巴摆正了',
  }
  for (const [ev, marker] of Object.entries(events)) {
    const text = buildDiary(input(20, { recentEvent: ev }))
    ok(ev + '：环境句命中且仍是 2–4 句', typeof text === 'string' && text.includes(marker) && isShortDiary(text), show(text))
    ok(ev + '：没有编造数字', typeof text === 'string' && !/[0-9０-９]/.test(text))
  }
  ok('未知事件回落到默认环境句', buildDiary(input(20, { recentEvent: 'dance' })) === buildDiary(input(20)))
}

// ======================================================================
// 三组示例（同时供人工核对语气）
console.log('\n三组示例输出：')
console.log('  离线 3h  ：' + t3)
console.log('  离线 20h ：' + t20)
console.log('  带 summary：' + buildDiary(input(20, { summary: '先整理材料，再改代码。' })))

if (fail) {
  console.error('\n❌ 失败 ' + fail + ' 项（通过 ' + pass + ' 项）')
  process.exit(1)
}
console.log('\n✅ 全部通过：' + pass + ' 项断言（dsh-chubby-whale 离线日记 diary）')
