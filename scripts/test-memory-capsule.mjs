/**
 * scripts/test-memory-capsule.mjs —— 记忆胶囊（client/memory-capsule.ts）离线回归
 *
 * 覆盖：
 *   ① 打包：五个字段齐全、v 恒为 1、缺省值（intimacy 0 / topics []）、JSON 往返不变；
 *   ② topics 清洗：trim、去空、去重、每项超 8 字截断、总量超 8 个截断、非数组按空、
 *      非字符串项跳过、emoji 按码点算、不修改调用方数组；
 *   ③ intimacy 夹取：-5→0、150→100、NaN→0、字符串→0、小数取整、±Infinity 落端点；
 *   ④ 确定性：同输入两次 JSON 完全相同；打包期间把 Math.random / Date.now 换成抛错函数也不受影响；
 *   ⑤ readCapsule 合法数据：与打包结果同形、不改写入参、不补字段、不带入外来字段；
 *      亲密度只夹不改写、topics 超长才截断、合规的重复主题词原样保留；
 *   ⑥ readCapsule 拒绝 12+ 类坏数据：全部返回 null 且不抛错（含 v=2、JSON 字符串、null、数组、
 *      自有 __proto__ 键、dream 超 200 字、字段类型错、缺字段、NaN/Infinity、抛错的 Proxy）；
 *   ⑦ capsuleDream：有 topics（1 个 / 2 个 / 多于 2 个只取前两个）、无 topics 通用句、
 *      非法返回 null、同一胶囊两次相同；
 *   ⑧ 源码约束：零 import、无 Math.random、不读时钟、不碰 DOM/存储/网络、代码里没有
 *      「对话」「原文」这类暗示原文的字段；注释必须写明隐私红线（只放主题词、不放原文）。
 *
 * 做法：esbuild 把 src/client/memory-capsule.ts 打成自包含 ESM，再从文件 URL 导入——
 * 测的是构建后的同一份代码；不碰 dist、不联网。
 * 临时目录放仓库内 .tmp-tests/（已 gitignore）：本机 Windows ACL 不允许 esbuild 往系统临时目录
 * 写产物（实测 Access is denied），与 scripts/test-whale-misread.mjs 同口径；跑完即删。
 *
 * 用法：node scripts/test-memory-capsule.mjs   （全绿退出码 0；有失败退出码 1）
 */

import { build } from 'esbuild'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SRC_FILE = join(ROOT, 'src', 'client', 'memory-capsule.ts')
const TMP = join(ROOT, '.tmp-tests', 'memory-capsule-' + process.pid + '-' + Date.now().toString(36))
const BUNDLE = join(TMP, 'memory-capsule.mjs')

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.error('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

// ---------- esbuild：离线打包（只打这一个模块，产物落临时目录） ----------
try {
  mkdirSync(TMP, { recursive: true })
  await build({
    stdin: {
      contents: "export * from './src/client/memory-capsule.ts'\n",
      resolveDir: ROOT,
      sourcefile: 'memory-capsule-entry.ts',
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
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* 临时目录删不掉不影响结论 */ }
  process.exit(1)
}

const mod = await import(pathToFileURL(BUNDLE).href)
try { rmSync(TMP, { recursive: true, force: true }) } catch { /* 临时目录删不掉不影响结论 */ }

const { packCapsule, readCapsule, capsuleDream } = mod
const SRC_RAW = readFileSync(SRC_FILE, 'utf8')

const show = (v) => (v === null ? 'null' : v === undefined ? 'undefined' : JSON.stringify(v))
const len = (s) => Array.from(s).length
const json = (v) => JSON.stringify(v)
const same = (a, b) => json(a) === json(b)
const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).join(',') : show(o))

const OPEN = '我好像闻到了另一片海的味道……'
const GENERIC = OPEN + '那边有另一只鲸在慢慢游。'

// ======================================================================
console.log('\n[0] 装载、导出与临时目录清理')
ok('esbuild 打包 src/client/memory-capsule.ts（离线 / 不碰 dist）', existsSync(SRC_FILE), SRC_FILE)
ok('导出 packCapsule', typeof packCapsule === 'function')
ok('导出 readCapsule', typeof readCapsule === 'function')
ok('导出 capsuleDream', typeof capsuleDream === 'function')
ok('运行时只导出这三个函数（类型在编译期擦除）',
  Object.keys(mod).sort().join(',') === 'capsuleDream,packCapsule,readCapsule', Object.keys(mod).join(','))
ok('打包用的临时目录跑完已删除', !existsSync(TMP), TMP)

// ======================================================================
console.log('\n[1] 打包：字段齐全、v 恒为 1')
const BASE = { madeAt: 1730000000000, intimacy: 66, topics: ['海', '潮汐'] }
const packed = packCapsule(BASE)
ok('v 恒为 1', packed.v === 1, String(packed.v))
ok('madeAt 原样保留', packed.madeAt === BASE.madeAt, String(packed.madeAt))
ok('intimacy 取整保留', packed.intimacy === 66, String(packed.intimacy))
ok('topics 原样保留', same(packed.topics, BASE.topics), show(packed.topics))
ok('dream 是字符串且非空', typeof packed.dream === 'string' && packed.dream.length > 0, show(packed.dream))
ok('字段顺序固定且只有五个', keys(packed) === 'v,madeAt,intimacy,topics,dream', keys(packed))
ok('JSON 往返后仍是同一颗胶囊', same(JSON.parse(JSON.stringify(packed)), packed))
const minimal = packCapsule({ madeAt: 0 })
ok('缺省 intimacy 为 0', minimal.intimacy === 0, String(minimal.intimacy))
ok('缺省 topics 为空数组', Array.isArray(minimal.topics) && minimal.topics.length === 0, show(minimal.topics))
ok('无主题词也有一句通用梦话', minimal.dream === GENERIC, show(minimal.dream))
ok('产物能被 readCapsule 读回', same(readCapsule(packed), packed))
ok('打包结果里没有任何原文类字段', keys(packed) === 'v,madeAt,intimacy,topics,dream', keys(packed))

// ======================================================================
console.log('\n[2] topics 清洗：trim / 去空 / 去重 / 截断')
const t1 = packCapsule({ madeAt: 1, topics: ['  海  ', '海', '   ', '', '潮汐', '海'] }).topics
ok('trim + 去空 + 去重（保留首次出现顺序）', same(t1, ['海', '潮汐']), show(t1))
const t2 = packCapsule({ madeAt: 1, topics: ['一二三四五六七八九十'] }).topics
ok('单个主题词超 8 字 → 截掉后面', same(t2, ['一二三四五六七八']), show(t2))
ok('截断按字符算，长度正好 8', t2.length === 1 && len(t2[0]) === 8, String(len(t2[0])))
const t3 = packCapsule({ madeAt: 1, topics: ['🐋🐋🐋🐋🐋🐋🐋🐋🐋'] }).topics
ok('emoji 按码点算：9 个鲸截到 8 个', t3.length === 1 && t3[0] === '🐋'.repeat(8), show(t3))
ok('emoji 截断后长度是 8 个字符', t3.length === 1 && len(t3[0]) === 8, String(len(t3[0])))
const many = Array.from({ length: 12 }, (_, i) => '主题' + i)
const t4 = packCapsule({ madeAt: 1, topics: many }).topics
ok('超过 8 个主题词 → 截到 8 个', t4.length === 8, '长度 ' + t4.length)
ok('保留前 8 个，顺序不变', same(t4, many.slice(0, 8)))
ok('非数组（字符串）按空数组', same(packCapsule({ madeAt: 1, topics: '海' }).topics, []))
ok('非数组（null）按空数组', same(packCapsule({ madeAt: 1, topics: null }).topics, []))
ok('非数组（对象）按空数组', same(packCapsule({ madeAt: 1, topics: { 0: '海' } }).topics, []))
const t8 = packCapsule({ madeAt: 1, topics: ['海', 42, null, { x: 1 }, '潮汐'] }).topics
ok('数组里的非字符串项跳过', same(t8, ['海', '潮汐']), show(t8))
const inputTopics = ['  海  ', '海']
const topicsBefore = json(inputTopics)
packCapsule({ madeAt: 1, topics: inputTopics })
ok('不修改调用方数组', json(inputTopics) === topicsBefore, json(inputTopics))

// ======================================================================
console.log('\n[3] intimacy 夹取到 0–100 整数')
const inti = (v) => packCapsule({ madeAt: 1, intimacy: v }).intimacy
ok('-5 → 0', inti(-5) === 0, String(inti(-5)))
ok('150 → 100', inti(150) === 100, String(inti(150)))
ok('NaN → 0', inti(NaN) === 0, String(inti(NaN)))
ok('缺省 → 0', inti(undefined) === 0, String(inti(undefined)))
ok('字符串 "80" → 0', inti('80') === 0, String(inti('80')))
ok('42.6 → 43（取整后仍在范围内）', inti(42.6) === 43 && Number.isInteger(inti(42.6)), String(inti(42.6)))
ok('Infinity → 100（沿夹取方向落端点）', inti(Infinity) === 100, String(inti(Infinity)))
ok('-Infinity → 0', inti(-Infinity) === 0, String(inti(-Infinity)))
ok('0 / 100 两个边界照收', inti(0) === 0 && inti(100) === 100)
const intiAll = [-5, 0, 42.6, 100, 150, NaN, Infinity, -Infinity, '80', undefined].map(inti)
ok('所有输出都是 0–100 的整数', intiAll.every((n) => Number.isInteger(n) && n >= 0 && n <= 100), intiAll.join(','))

// ======================================================================
console.log('\n[4] 确定性：不随机、不读系统时钟')
const inputA = { madeAt: 1730000000000, intimacy: 73.2, topics: [' 海 ', '潮汐', '海', '一二三四五六七八九十'] }
const d1 = packCapsule(inputA)
const d2 = packCapsule(inputA)
ok('同一输入两次打包 JSON 完全相同', json(d1) === json(d2), json(d1))
ok('跨调用次数结果不变', json(packCapsule({ madeAt: 1, topics: ['海'] })) === json(packCapsule({ madeAt: 1, topics: ['海'] })))
ok('madeAt 给 0 就存 0（不补当前时间）', packCapsule({ madeAt: 0 }).madeAt === 0)
const realRandom = Math.random
const realNow = Date.now
let sabotage = null
try {
  Math.random = () => { throw new Error('packCapsule 使用了 Math.random') }
  Date.now = () => { throw new Error('packCapsule 读了系统时钟') }
  packCapsule({ madeAt: 1, topics: ['海'] })
} catch (e) {
  sabotage = e
} finally {
  Math.random = realRandom
  Date.now = realNow
}
ok('打包期间 Math.random / Date.now 抛错也不受影响', sabotage === null,
  sabotage ? String(sabotage.message) : '')

// ======================================================================
console.log('\n[5] readCapsule：合法数据返回同形对象')
const good = packCapsule({ madeAt: 1730000000000, intimacy: 66, topics: ['海', '潮汐'] })
const back = readCapsule(good)
ok('合法胶囊原样读回（JSON 相同）', same(back, good), show(back))
ok('返回对象只有五个字段', keys(back) === 'v,madeAt,intimacy,topics,dream', keys(back))
ok('v 仍是数字 1', back && back.v === 1)
ok('intimacy 150 → 夹到 100', readCapsule({ ...good, intimacy: 150 }).intimacy === 100)
ok('intimacy -5 → 夹到 0', readCapsule({ ...good, intimacy: -5 }).intimacy === 0)
ok('intimacy 42.5 只夹不取整（不做隐式改写）', readCapsule({ ...good, intimacy: 42.5 }).intimacy === 42.5)
const longTopic = readCapsule({ ...good, topics: ['一二三四五六七八九十'] })
ok('单个主题词超 8 字 → 截断', longTopic && same(longTopic.topics, ['一二三四五六七八']), show(longTopic && longTopic.topics))
const manyRead = readCapsule({ ...good, topics: Array.from({ length: 10 }, (_, i) => 't' + i) })
ok('10 个主题词 → 截到前 8 个',
  manyRead && same(manyRead.topics, Array.from({ length: 8 }, (_, i) => 't' + i)), show(manyRead && manyRead.topics))
const dupRead = readCapsule({ ...good, topics: ['海', '海'] })
ok('合规但重复的主题词原样保留（不去重）', dupRead && same(dupRead.topics, ['海', '海']), show(dupRead && dupRead.topics))
const extraRead = readCapsule({ ...good, extra: '外来字段', text: '不该进来', content: '也不该' })
ok('外来字段不带进胶囊', extraRead !== null && !('extra' in extraRead) && !('text' in extraRead) && !('content' in extraRead) && same(extraRead, good), keys(extraRead))
const exactDream = readCapsule({ ...good, dream: '梦'.repeat(200) })
ok('dream 正好 200 字 → 接受', exactDream !== null && exactDream.dream.length === 200, String(exactDream && exactDream.dream.length))
ok('topics 为空数组合法', readCapsule({ ...good, topics: [] }) !== null)
ok('madeAt 为负也合法（1970 前）', readCapsule({ ...good, madeAt: -1 }) !== null)
const frozen = Object.freeze({ ...good, topics: Object.freeze(['海', '潮汐']) })
let frozenThrew = null
let frozenOut = null
try { frozenOut = readCapsule(frozen) } catch (e) { frozenThrew = e }
ok('冻结输入可读且不改写入参', frozenThrew === null && same(frozenOut, good) && frozen.topics.length === 2,
  frozenThrew ? String(frozenThrew.message) : '')

// ======================================================================
console.log('\n[6] readCapsule：12+ 类坏数据一律 null、绝不抛错')
const noDream = { ...good }
delete noDream.dream
const protoJson = JSON.parse('{"v":1,"madeAt":1,"intimacy":0,"topics":["海"],"dream":"梦","__proto__":{"polluted":true}}')
ok('构造出的确实是自有 __proto__ 键（前提成立）', Object.prototype.hasOwnProperty.call(protoJson, '__proto__'))
const BAD = [
  ['JSON 字符串', JSON.stringify(good)],
  ['null', null],
  ['undefined', undefined],
  ['数组', [good]],
  ['v = 2', { ...good, v: 2 }],
  ['v = "1"（字符串）', { ...good, v: '1' }],
  ['madeAt = "123"', { ...good, madeAt: '123' }],
  ['madeAt = NaN', { ...good, madeAt: NaN }],
  ['madeAt = Infinity', { ...good, madeAt: Infinity }],
  ['intimacy = "50"', { ...good, intimacy: '50' }],
  ['intimacy = NaN', { ...good, intimacy: NaN }],
  ['topics 不是数组', { ...good, topics: '海' }],
  ['topics 里有数字', { ...good, topics: ['海', 42] }],
  ['topics 里有 null', { ...good, topics: ['海', null] }],
  ['dream 超 200 字', { ...good, dream: '梦'.repeat(201) }],
  ['dream 不是字符串', { ...good, dream: { 梦: true } }],
  ['缺 dream 字段', noDream],
  ['自有 __proto__ 键', protoJson],
  ['数字', 42],
  ['布尔 true', true],
  ['函数', () => good],
]
let badThrew = null
const badResults = BAD.map(([name, value]) => {
  try {
    return [name, readCapsule(value)]
  } catch (e) {
    badThrew = e
    return [name, 'THREW']
  }
})
const notRejected = badResults.filter(([, r]) => r !== null)
ok('坏数据全部返回 null', badResults.length >= 12 && notRejected.length === 0,
  notRejected.map(([n, r]) => n + '=' + show(r)).join(' | '))
ok('坏数据无一抛错', badThrew === null, badThrew ? String(badThrew.message) : '')
ok('拒绝样本覆盖 ≥ 12 类', BAD.length >= 12, BAD.length + ' 类')
ok('__proto__ 坏胶囊没有污染全局原型', !('polluted' in {}), String(({}).polluted))

const bomb = new Proxy({}, {
  get() { throw new Error('boom') },
  getOwnPropertyDescriptor() { throw new Error('boom') },
  has() { throw new Error('boom') },
})
let proxyThrew = null
let proxyOut = null
try { proxyOut = readCapsule(bomb) } catch (e) { proxyThrew = e }
ok('取属性会抛错的 Proxy → null 且不抛错', proxyThrew === null && proxyOut === null,
  proxyThrew ? String(proxyThrew.message) : '')
let inheritedOut = null
try { inheritedOut = readCapsule(Object.create(good)) } catch { /* 这里只关心返回值 */ }
ok('字段只在原型上（不是自有字段）→ null', inheritedOut === null)
ok('拒绝坏胶囊之后，合法胶囊照常读回', same(readCapsule(good), good))

// ======================================================================
console.log('\n[7] capsuleDream：有 / 无 topics，以及非法输入')
const c1 = packCapsule({ madeAt: 1, topics: ['读书'] })
const dream1 = capsuleDream(c1)
ok('有 1 个主题词：以固定开头起句', typeof dream1 === 'string' && dream1.startsWith(OPEN), show(dream1))
ok('有 1 个主题词：句子里带『读书』', typeof dream1 === 'string' && dream1.indexOf('『读书』') >= 0, show(dream1))
ok('有 1 个主题词：是一句话且 ≤ 200 字',
  typeof dream1 === 'string' && dream1.endsWith('。') && len(dream1) <= 200, len(dream1) + ' 字')
ok('梦话与打包结果同源（一句生成，两处一致）', dream1 === c1.dream)

const c2 = packCapsule({ madeAt: 1, topics: ['读书', '咖啡', '远行'] })
const dream2 = capsuleDream(c2)
ok('有多个主题词：取前两个', typeof dream2 === 'string' && dream2.indexOf('『读书』') >= 0 &&
  dream2.indexOf('『咖啡』') >= 0 && dream2.indexOf('远行') < 0, show(dream2))
ok('有多个主题词：仍以固定开头、以句号收尾',
  typeof dream2 === 'string' && dream2.startsWith(OPEN) && dream2.endsWith('。'))
ok('多主题词梦话 ≤ 200 字', len(dream2) <= 200, len(dream2) + ' 字')

const emptyCapsule = packCapsule({ madeAt: 1, topics: [] })
ok('无主题词：通用句一字不差', capsuleDream(emptyCapsule) === GENERIC, show(capsuleDream(emptyCapsule)))
ok('topics 缺省：同样回落通用句', capsuleDream({ v: 1, madeAt: 1, intimacy: 0, dream: '' }) === GENERIC)
ok('空主题词数组：通用句', capsuleDream({ v: 1, topics: [] }) === GENERIC)
ok('全是空串 / 空白的主题词：通用句', capsuleDream({ v: 1, topics: ['', '   '] }) === GENERIC)
ok('同一胶囊两次梦话完全相同', capsuleDream(c2) === capsuleDream(c2))
const longDream = capsuleDream({ v: 1, topics: ['一二三四五六七八九十'] })
ok('主题词超长时梦话仍很短（≤ 200 字）', typeof longDream === 'string' && len(longDream) <= 200, show(longDream))

const BAD_CAPSULE = [
  ['null', null],
  ['undefined', undefined],
  ['字符串', '海'],
  ['数字', 42],
  ['数组', ['海']],
  ['空对象（缺 v）', {}],
  ['v = 2', { v: 2, topics: ['海'] }],
  ['缺 v', { topics: ['海'] }],
  ['topics 是字符串', { v: 1, topics: '海' }],
  ['topics 里有数字', { v: 1, topics: ['海', 42] }],
  ['函数', () => '海'],
]
let dreamThrew = null
const dreamBad = BAD_CAPSULE.map(([name, value]) => {
  try {
    return [name, capsuleDream(value)]
  } catch (e) {
    dreamThrew = e
    return [name, 'THREW']
  }
})
const dreamNotRejected = dreamBad.filter(([, r]) => r !== null)
ok('非法胶囊的梦话全部为 null', dreamNotRejected.length === 0,
  dreamNotRejected.map(([n, r]) => n + '=' + show(r)).join(' | '))
ok('非法胶囊不抛错', dreamThrew === null, dreamThrew ? String(dreamThrew.message) : '')
ok('非法样本覆盖 ≥ 10 类', BAD_CAPSULE.length >= 10, BAD_CAPSULE.length + ' 类')

// ======================================================================
console.log('\n[8] 源码约束（纯函数 / 零依赖 / 无随机 / 无私隐字段）')
{
  // 去掉注释再扫：避免把「不碰 localStorage」「不放原文」这类说明文字当成真依赖或真字段
  const codeOnly = SRC_RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  ok('零 import（含 export ... from / require）',
    !/^\s*import\s/m.test(codeOnly) && !/^\s*export\s[^\n]*\bfrom\b/m.test(codeOnly) && !/\brequire\s*\(/.test(codeOnly))
  ok('不用 Math.random', !/Math\.random/.test(codeOnly))
  ok('不读系统时钟（Date.now / new Date / performance.now）',
    !/Date\.now|new Date|performance\.now/.test(codeOnly))
  ok('不碰 DOM / localStorage / 网络',
    !/document\.|window\.|localStorage|sessionStorage|fetch\s*\(|XMLHttpRequest/.test(codeOnly))
  ok('代码里没有「对话」「原文」这类暗示原文的字段',
    !/对话|原文|transcript|conversation|dialogue/i.test(codeOnly))
  ok('注释写明了隐私红线（只放主题词、不放原文）',
    /主题词/.test(SRC_RAW) && /原文/.test(SRC_RAW) && /隐私/.test(SRC_RAW) && /对话/.test(SRC_RAW))
  ok('导出签名齐全（两个类型 + 三个函数）',
    /export type Capsule\s*=/.test(SRC_RAW) &&
    /export type CapsuleInput\s*=/.test(SRC_RAW) &&
    /export function packCapsule\b/.test(SRC_RAW) &&
    /export function readCapsule\b/.test(SRC_RAW) &&
    /export function capsuleDream\b/.test(SRC_RAW))
  ok('Capsule 类型只有五个字段（v / madeAt / intimacy / topics / dream）',
    /export type Capsule = \{[^}]*v: 1;[^}]*madeAt: number;[^}]*intimacy: number;[^}]*topics: string\[\];[^}]*dream: string[^}]*\}/.test(SRC_RAW))
}

// ======================================================================
console.log('\n三个示例（供人工过目）')
console.log('  有 topics  ' + capsuleDream(packCapsule({ madeAt: 1, topics: ['读书', '咖啡', '远行'] })))
console.log('  无 topics  ' + capsuleDream(packCapsule({ madeAt: 1 })))
const rejected = readCapsule({ v: 2, madeAt: 1, intimacy: 0, topics: ['海'], dream: '梦' })
console.log('  拒绝样例   readCapsule({v:2,...}) → ' + show(rejected))

if (fail) {
  console.error('\n❌ 失败 ' + fail + ' 项（通过 ' + pass + ' 项）')
  process.exit(1)
}
console.log('\n✅ 全部通过：' + pass + ' 项断言（dsh-chubby-whale 记忆胶囊 memory-capsule）')
