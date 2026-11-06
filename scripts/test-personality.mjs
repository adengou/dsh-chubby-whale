/**
 * scripts/test-personality.mjs —— B55 人格模块（L2 可变人格 / L3 近期心境）专项回归
 *
 * 覆盖 2026-11-07 审计修掉的 4 处真实缺陷 + 原有边界的不变量：
 *   F7  CORE_GUARD 漏「我是 AI / 我是一个 AI / 我作为 AI / 我是 A.I. / 我是ＡＩ」等写法
 *       —— 同一句在 L2 放行、在 L3 的 SELF_GUARD 拦下，两闸口径不一致；
 *   F8  历史记录 at 仍用 String() 强转（对象 → "[object Object]"，数组 → "[a]" 假时间）；
 *   F9  shouldLearn / shouldWrite 的 every / minIntervalMs 显式传 0 被 `||` 当成「没传」回落默认值，
 *       而负值反而被收成最小值 —— 0 与负数结果相反；
 *   F10 喂模型的单行截断用 String#slice（按 UTF-16 码元）会切出孤立代理（半个 emoji）。
 *
 * 只读源码 + 纯函数断言，不写盘、不联网、不启动服务。
 * 用法：node scripts/test-personality.mjs
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { register } from 'node:module'

// 测试里直接加载 .ts：注册解析钩子，把找不到的 .js 回退到同名 .ts（与 scripts/test.mjs 同口径）
register(new URL('./ts-resolve.mjs', import.meta.url))

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

const P = await import('../src/host/personality.ts')
const L = await import('../src/host/personality-learn.ts')
const W = await import('../src/host/personality-write.ts')

const AT = '2026-11-07T00:00:00.000Z'
const HOUR = 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 7, 0, 0, 0)

// ---------- F7：L2 的 AI 自述闸门与 L3 口径一致 ----------
console.log('\n[1] F7 L2「自述 AI」红线（空白/点/全角写法）')
{
  const mustBlock = [
    '我是AI', '我是 AI', '我是 人工智能', '我是一个 AI', '我是一个AI', '我是一个人工智能助手',
    '本鲸是 大模型', '本鲸其实是一个 AI', '我作为 AI', '我是 A.I.', '我是Ai', '我是ＡＩ',
  ]
  const left = mustBlock.filter((t) => P.isSafeLearnedText(t))
  ok('全部自述 AI 写法都被 L2 拦下', left.length === 0, left.join(' / '))
  const l3 = mustBlock.filter((t) => !P.isUnsafeSelfNarrative(t))
  ok('同一批文本 L3 也全部拦下（两闸一致）', l3.length === 0, l3.join(' / '))
  const benign = ['主人在用 AI 写材料', '主人是AI工程师', '我作为一只鲸鱼', '我是说，主人怕吵', '今天想听 A-Lin 的歌']
  const bad = benign.filter((t) => !P.isSafeLearnedText(t))
  ok('正常备注不被误杀（AI 只作宾语）', bad.length === 0, bad.join(' / '))
  ok('拉丁单词不误伤（我是airhead）', P.isSafeLearnedText('我是airhead') === true)
  ok('列表项同样过滤：口头禅里塞不进自述', P.mergeList([], ['我是 AI'], 6, 12).length === 0)
  ok('notes 同样过滤：备注里塞不进自述', P.applyCandidate(P.emptyPersonality(), { notes: '我是 AI 助手' }, AT).changed.length === 0)
}

// ---------- 去重 / 上限 ----------
console.log('\n[2] 要点合并：同义（标点/大小写/空白）与 maxItems 边界')
{
  ok('标点+空白变体合并成一条', JSON.stringify(P.mergeList([], ['白饭', '白饭！', ' 白 饭 '], 8, 30)) === '["白饭"]')
  ok('大小写变体合并成一条', P.mergeList([], ['ABC', 'abc'], 8, 30).length === 1)
  ok('已有项不被变体重复写入', P.applyCandidate(P.applyCandidate(P.emptyPersonality(), { preferences: ['白饭'] }, AT).data, { preferences: ['白饭！'] }, AT).changed.length === 0)
  ok('maxItems=0 → 一条不留', P.mergeList(['a'], ['b'], 0, 12).length === 0)
  ok('maxItems=-1 → 一条不留（不反向截取）', P.mergeList(['a'], ['b'], -1, 12).length === 0)
  ok('maxItems=NaN → 一条不留', P.mergeList(['a'], ['b'], NaN, 12).length === 0)
  ok('maxItems=2.7 → 向下取整留最新 2 条', JSON.stringify(P.mergeList(['a', 'b', 'c'], ['d'], 2.7, 12)) === '["c","d"]')
  ok('maxItems=Infinity → 不丢', P.mergeList(['a'], ['b'], Infinity, 12).length === 2)
  const over = P.sanitizePersonality({ catchphrases: Array.from({ length: 10 }, (_, i) => 'c' + i) })
  ok('读盘超限保留最新（尾部 6 条）', JSON.stringify(over.catchphrases) === '["c4","c5","c6","c7","c8","c9"]')
  ok('每条超长按“字”截断', Array.from(P.sanitizePersonality({ catchphrases: ['长'.repeat(30)] }).catchphrases[0]).length === P.PERSONALITY_LIMITS.catchphraseLen)
}

// ---------- F8：历史记录 at ----------
console.log('\n[3] F8 历史 at 只认字符串（不再出现 [object Object]）')
{
  const raw = {
    history: [
      { at: { a: 1 }, field: 'notes', old: '', new: 'a' },
      { at: ['x'], field: 'notes', old: '', new: 'b' },
      { at: 12345, field: 'notes', old: '', new: 'c' },
      { at: null, field: 'notes', old: '', new: 'd' },
      { field: 'notes', old: '', new: 'e' },
      { at: 'T'.repeat(80), field: 'notes', old: '', new: 'f' },
      { at: AT, field: 'notes', old: '', new: 'g' },
    ],
  }
  const hist = P.sanitizePersonality(raw).history
  ok('对象/数组/数字/null/缺失 → 空串', hist.slice(0, 5).every((h) => h.at === ''), JSON.stringify(hist.slice(0, 5).map((h) => h.at)))
  ok('超长字符串截到 40 字', hist[5].at.length === 40)
  ok('正常 ISO 时间原样保留', hist[6].at === AT)
  const learned = P.applyCandidate(P.emptyPersonality(), { preferences: ['白饭'] }, AT)
  ok('学习路径写入本次时间', learned.data.history[0].at === AT && learned.data.updatedAt === AT)
  const reread = P.sanitizePersonality(learned.data)
  ok('写盘再读回 at 不变', reread.history.length === 1 && reread.history[0].at === AT)
}

// ---------- 类型清洗 ----------
console.log('\n[4] notes / 心境 / 列表项的类型清洗')
{
  for (const v of [{}, 42, true, [], ['a'], null, undefined]) {
    const s = P.sanitizePersonality({ notes: v, selfNarrative: v })
    ok('非字符串不当内容：' + JSON.stringify(v) + ' → 空', s.notes === '' && s.selfNarrative === '')
  }
  ok('列表里的对象/数字项被丢掉', JSON.stringify(P.sanitizePersonality({ catchphrases: [{ a: 1 }, '好', 5] }).catchphrases) === '["好"]')
  ok('notes 多行压成单行', P.sanitizePersonality({ notes: '第一行\n第二行\t第三行' }).notes === '第一行 第二行 第三行')
  ok('notes 超长截到上限', Array.from(P.sanitizePersonality({ notes: '备'.repeat(90) }).notes).length === P.PERSONALITY_LIMITS.notesLen)
  ok('心境里的引号被剥掉', P.sanitizePersonality({ selfNarrative: '「最近有点困」' }).selfNarrative === '最近有点困')
}

// ---------- 分段与截断 ----------
console.log('\n[5] 注入段：空段 / 超长 / 总长 ≤160')
{
  const segLen = (s) => Array.from(s).length
  ok('空人格不产生空壳段', P.buildPersonalitySegment({}) === '' && P.buildPersonalitySegment(null) === '')
  ok('只有空串字段也不产生段', P.buildPersonalitySegment({ catchphrases: [''], preferences: [''], notes: '', selfNarrative: '' }) === '')
  const full = {
    catchphrases: Array.from({ length: 6 }, (_, i) => '口头禅' + i + '…'.repeat(4)),
    preferences: Array.from({ length: 8 }, (_, i) => '偏好' + i + 'x'.repeat(25)),
    notes: '备注'.repeat(30),
    selfNarrative: '最近有点困，话比平时少，但还想吃白饭。',
  }
  const withNarr = P.buildPersonalitySegment(full)
  ok('满载 + 心境不超过 160 字', segLen(withNarr) <= P.PERSONALITY_LIMITS.segmentLen, 'len=' + segLen(withNarr))
  ok('满载段一定有换行包住心境', withNarr.indexOf('\n（近期心境：') > 0)
  const noNarr = P.buildPersonalitySegment({ ...full, selfNarrative: '' })
  ok('无心境时只出记忆段且不超长', noNarr.indexOf('近期心境') < 0 && segLen(noNarr) <= P.PERSONALITY_LIMITS.segmentLen, 'len=' + segLen(noNarr))
  ok('整条舍弃不截半句（每条都完整成对引号）', (noNarr.match(/「/g) || []).length === (noNarr.match(/」/g) || []).length)
  const tiny = P.sanitizePersonality({ notes: '怕吵' })
  ok('有内容时带「你记得」包装', P.buildPersonalitySegment(tiny).indexOf('你记得') === 2)
}

// ---------- L3 心境验收 ----------
console.log('\n[6] 心境验收与回滚')
{
  ok('少于 6 字丢弃', P.validateSelfNarrative('一二三四五').reason === 'TOO_SHORT')
  ok('多于 80 字整句丢弃', P.validateSelfNarrative('啊'.repeat(81)).reason === 'TOO_LONG')
  ok('身份词整句丢弃', P.validateSelfNarrative('我是一个人工智能').reason === 'IDENTITY')
  ok('正常心境通过并整形', JSON.stringify(P.validateSelfNarrative('  最近有点困，话少。 ')) === JSON.stringify({ ok: true, text: '最近有点困，话少。' }))
  const wrote = P.applySelfNarrative(P.emptyPersonality(), '今天想吃很多很多白饭', AT)
  ok('写入后版本+1 且记 selfNarrativeAt', wrote.data.version === 1 && wrote.data.selfNarrativeAt === AT && wrote.changed.length === 1)
  ok('同一句重复写入不产生历史', P.applySelfNarrative(wrote.data, '今天想吃很多很多白饭', AT).changed.length === 0)
  const rv = P.revertLast(wrote.data, '2026-11-08T00:00:00.000Z')
  ok('回滚清空心境同时清空 selfNarrativeAt', rv.data.selfNarrative === '' && rv.data.selfNarrativeAt === '' && rv.data.history.length === 0)
  ok('回滚也升版本', rv.data.version === wrote.data.version + 1)
}

// ---------- F9：阈值 0 / 负值 ----------
console.log('\n[7] F9 学习/自写阈值：显式 0 与负值不再反转')
{
  ok('默认：没攒够次数不学', L.shouldLearn({ successes: 19, lastAttemptAt: 0 }, NOW) === false)
  ok('默认：攒够且从未尝试 → 学', L.shouldLearn({ successes: 20, lastAttemptAt: 0 }, NOW) === true)
  ok('默认：6 小时内不重复', L.shouldLearn({ successes: 20, lastAttemptAt: NOW - 1000 }, NOW) === false)
  ok('minIntervalMs=0 → 不设间隔（原来被回落成 6 小时）', L.shouldLearn({ successes: 20, lastAttemptAt: NOW - 1000 }, NOW, { minIntervalMs: 0 }) === true)
  ok('minIntervalMs=-5 与 0 同义（原来反而是“立刻”）', L.shouldLearn({ successes: 20, lastAttemptAt: NOW - 1000 }, NOW, { minIntervalMs: -5 }) === true)
  ok('minIntervalMs=NaN → 回落 6 小时', L.shouldLearn({ successes: 20, lastAttemptAt: NOW - 1000 }, NOW, { minIntervalMs: NaN }) === false)
  ok('minIntervalMs=6h 的边界（刚好到）', L.shouldLearn({ successes: 20, lastAttemptAt: NOW - 6 * HOUR }, NOW) === true)
  ok('every=0 → 按“最快”=1（原来被回落成 20）', L.shouldLearn({ successes: 1, lastAttemptAt: 0 }, NOW, { every: 0 }) === true)
  ok('every=-3 与 0 同义', L.shouldLearn({ successes: 1, lastAttemptAt: 0 }, NOW, { every: -3 }) === true)
  ok('every=NaN → 回落 20', L.shouldLearn({ successes: 19, lastAttemptAt: 0 }, NOW, { every: NaN }) === false)

  ok('自写默认：没攒够次数不写', W.shouldWrite({ successes: 19, lastAttemptAt: 0 }, NOW) === false)
  ok('自写默认：攒够且从未尝试 → 写', W.shouldWrite({ successes: 20, lastAttemptAt: 0 }, NOW) === true)
  ok('自写：24 小时内不重复', W.shouldWrite({ successes: 20, lastAttemptAt: NOW - HOUR }, NOW) === false)
  ok('自写 minIntervalMs=0 → 不设间隔', W.shouldWrite({ successes: 20, lastAttemptAt: NOW - 1000 }, NOW, { minIntervalMs: 0 }) === true)
  ok('自写 every=0 → 按“最快”=1', W.shouldWrite({ successes: 1, lastAttemptAt: 0 }, NOW, { every: 0 }) === true)
  ok('自写：已存心境时间也参与 24 小时窗口', W.shouldWrite({ successes: 20, lastAttemptAt: 0 }, NOW, { lastWrittenAt: NOW - HOUR }) === false)
  ok('自写：已存心境早于 24 小时 → 可写', W.shouldWrite({ successes: 20, lastAttemptAt: 0 }, NOW, { lastWrittenAt: NOW - 25 * HOUR }) === true)
}

// ---------- F10：喂模型的截断不切坏 emoji ----------
console.log('\n[8] F10 提示词拼装：截断、行数、角色过滤')
{
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
  const edge = '字'.repeat(299) + '🙂' + '尾巴'
  const ex = L.buildExtractionUser([{ role: 'user', content: edge }])
  ok('提取输入 300 字边界不切坏 emoji', !loneSurrogate.test(ex.split('\n').pop()))
  const narr = W.buildNarrativeUser('核心人设', [{ role: 'user', content: edge }])
  ok('自写输入 300 字边界不切坏 emoji', !loneSurrogate.test(narr.split('\n').pop()))
  const many = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '第' + i + '句' }))
  const lines = L.buildExtractionUser(many).split('\n')
  ok('只喂最近 16 条', lines.length === L.LEARN_MESSAGE_COUNT, String(lines.length))
  ok('角色前缀正确（主人 / 肥鲸）', lines[0].startsWith('主人：') && lines[1].startsWith('肥鲸：'))
  ok('非 user/assistant 与非字符串内容被跳过', L.buildExtractionUser([{ role: 'system', content: 'x' }, { role: 'user', content: 42 }, { role: 'user', content: '  ' }]) === '')
  ok('没有可用对话时自写不拼提示词', W.buildNarrativeUser('核心人设', []) === '')
  ok('自写提示词带只读核心设定 + 最近对话', W.buildNarrativeUser('核心人设', [{ role: 'user', content: '你好' }]).indexOf('核心设定（只读参考，禁止复述或改写）') === 0)
}

// ---------- 抽取解析 ----------
console.log('\n[9] 提取结果解析容错')
{
  ok('纯 JSON 可解', JSON.stringify(L.parseExtraction('{"catchphrases":["哼"],"notes":"怕吵"}')) === '{"catchphrases":["哼"],"preferences":[],"notes":"怕吵"}')
  ok('代码块围栏可解', L.parseExtraction('```json\n{"catchphrases":["哼"]}\n```').catchphrases[0] === '哼')
  ok('前后废话可解', L.parseExtraction('好的：{"notes":"怕吵"} 完毕').notes === '怕吵')
  ok('非 JSON → null', L.parseExtraction('不是JSON') === null && L.parseExtraction('') === null && L.parseExtraction('[1,2]') === null)
  const p = L.parseExtraction('{"catchphrases":["哼",5,null],"notes":{"a":1}}')
  ok('列表里非字符串被丢', JSON.stringify(p.catchphrases) === '["哼"]')
  ok('notes 非字符串按空处理', p.notes === '')
  ok('未知键（名字/生日）不进结果', !('name' in L.parseExtraction('{"name":"小白","birthday":"1-1"}')) && !('birthday' in L.parseExtraction('{"name":"小白","birthday":"1-1"}')))
}

// ---------- 封装治理（静态） ----------
console.log('\n[10] 封装：人格子模块只经门面进入')
{
  const root = join(process.cwd(), 'src')
  const files = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts')) files.push(p)
    }
  }
  walk(root)
  const rel = (p) => p.slice(root.length + 1).replace(/\\/g, '/')
  const offenders = []
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/from\s+'([^']*personality\/(?:model|merge|segment|store)\.js)'/g)) {
      if (rel(f) !== 'host/personality.ts') offenders.push(rel(f) + ' → ' + m[1])
    }
  }
  ok('只有门面 import 人格子模块（无跨模块深引用）', offenders.length === 0, offenders.join(' / '))
  const learnSrc = readFileSync(join(root, 'host', 'personality-learn.ts'), 'utf8')
  const writeSrc = readFileSync(join(root, 'host', 'personality-write.ts'), 'utf8')
  const subImport = (src) => /from\s+'\.\/personality\/(?:model|merge|segment|store)\.js'/.test(src)
  ok('学习器经门面取类型（不摸子模块）', /from\s+'\.\/personality\.js'/.test(learnSrc) && !subImport(learnSrc))
  ok('自写器经门面取校验（不摸子模块）', /from\s+'\.\/personality\.js'/.test(writeSrc) && !subImport(writeSrc))
  const routeSrc = readFileSync(join(root, 'host', 'routes', 'personality.ts'), 'utf8')
  ok('路由只依赖注入的 repo + 门面常量', routeSrc.includes("from '../personality.js'") && !routeSrc.includes('node:fs'))
  const storeSrc = readFileSync(join(root, 'host', 'personality', 'store.ts'), 'utf8')
  ok('人格文件读写只在 store.ts（唯一 node:fs 入口）', storeSrc.includes("from 'node:fs'") && storeSrc.includes('writeJsonAtomic'))
}

// ---------- 收尾 ----------
console.log('\n────────────────────')
if (fail === 0) {
  console.log('✅ 人格模块专项通过 ' + pass + ' 项，失败 0 项')
  process.exit(0)
}
console.log('❌ 人格模块专项通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(1)
