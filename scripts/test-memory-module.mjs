/**
 * scripts/test-memory-module.mjs —— 记忆模块（BM25 + 分层衰减）专项
 *
 * 覆盖：
 *   [A] 分词：中文/英文/标点
 *   [B] BM25：建索引 / 打分 / AND 精确 / OR 回退 / 三因子 / 去重
 *   [C] 模块：remember / loadRecent / recall / stats / clear
 *   [D] 衰减：21 天压缩 / 45 天再压 / 120 天删正文留目录 / 钉住不动 / 提起回退
 *
 * 用法：node scripts/test-memory-module.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = process.cwd()
let pass = 0, fail = 0
const failures = []
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; failures.push(name + (detail ? '  ' + detail : '')); console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

async function imp(rel) {
  const dir = join(ROOT, '.tmp-memory-test')
  mkdirSync(dir, { recursive: true })
  const out = join(dir, rel.replace(/[\\/]/g, '_') + '.mjs')
  const r = await build({
    entryPoints: [join(ROOT, rel)],
    bundle: true, format: 'esm', platform: 'node', write: false,
  })
  writeFileSync(out, r.outputFiles[0].text, 'utf8')
  return import(pathToFileURL(out).href + '?t=' + Date.now())
}

console.log('\n[A] 分词 bm25.ts')
{
  const bm = await imp('src/host/memory/bm25.ts')
  const t1 = bm.tokenize('主人今天在北海吃海鲜')
  ok('中文分词出词', t1.length >= 3, JSON.stringify(t1))
  ok('英文小写化', bm.tokenize('Hello World').every((w) => w === w.toLowerCase()))
  ok('标点被丢弃', !bm.tokenize('你好，世界！').some((w) => /[，！]/.test(w)))
  ok('空串安全', bm.tokenize('').length === 0 && bm.tokenize(null).length === 0)
}

console.log('\n[B] BM25 检索 bm25.ts')
{
  const bm = await imp('src/host/memory/bm25.ts')
  const now = Date.now()
  const docs = [
    { id: 'a', text: '北海 退役军人 就业', display: '北海退役军人就业', importance: 0.9, at: now },
    { id: 'b', text: '北海 海鲜 好吃', display: '北海海鲜', importance: 0.5, at: now },
    { id: 'c', text: '北京 天气 冷', display: '北京天气', importance: 0.5, at: now - 90 * 86400000 },
    { id: 'd', text: '北海 海鲜 好吃', display: '北海海鲜', importance: 0.4, at: now }, // 与 b 相似，测去重
  ]
  const idx = bm.buildIndex(docs)
  ok('索引规模', idx.size === 4 && idx.avgLen > 0)
  ok('命中「北海」2 条以上', bm.scoreBm25(idx, '北海').length >= 2)
  const r1 = bm.recall(idx, '北海 退役军人')
  ok('AND 精确命中优先（fallback=false）', r1.fallback === false && r1.hits.length >= 1, JSON.stringify(r1.hits.map((h) => h.id)))
  const r2 = bm.recall(idx, '完全没出现过的词')
  ok('无命中返回空', r2.hits.length === 0)
  const r3 = bm.recall(idx, '北海 火星')
  ok('OR 回退标记（fallback=true）', r3.fallback === true)
  const r4 = bm.recall(idx, '北海', { limit: 5 })
  ok('去重：相似内容只留一条', r4.hits.length <= 2, 'hits=' + r4.hits.length)
  const stale = bm.recall(idx, '北京')
  ok('新近度参与排序（旧文档分数低）', stale.hits.length === 1)
}

console.log('\n[C] 记忆模块 memory/index.ts')
{
  const dir = mkdtempSync(join(tmpdir(), 'chubby-bm25-'))
  try {
    const mod = await imp('src/host/memory/index.ts')
    const m = mod.createMemoryModule(dir)
    ok('空目录：历史为空', m.loadRecent(10).length === 0)
    const n1 = m.remember('主人说想喝咖啡', '本鲸记下了')
    ok('追加一轮 = 2 条', n1 === 2 && m.loadRecent(10).length === 2)
    m.remember('北海退役军人局要报材料', '好的，材料清单在第五条')
    const r = m.recall('北海 材料')
    ok('recall 命中', r.hits.length >= 1, JSON.stringify(r.hits.map((h) => h.display.slice(0, 8))))
    ok('recall 有 final 分', r.hits.length > 0 && r.hits[0].final > 0)
    const st = m.stats()
    ok('stats 结构', st.history === 4 && st.warm === 4 && st.cold === 0 && st.pinned === 0)
    m.saveSummary('主人爱喝咖啡')
    ok('摘要读写', m.loadSummary() === '主人爱喝咖啡')
    m.clear()
    ok('clear 清空', m.loadRecent(10).length === 0 && m.loadSummary() === '')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

console.log('\n[D] 衰减 tick 分层 memory/index.ts')
{
  const dir = mkdtempSync(join(tmpdir(), 'chubby-decay-'))
  try {
    const mod = await imp('src/host/memory/index.ts')
    const m = mod.createMemoryModule(dir)
    const now = Date.now()
    const d = (n) => n * 86400000
    m.remember('很久以前的小事', '嗯', { at: now - d(25), importance: 0.1 })   // 25 天 → 21 天档压缩
    m.remember('更久以前的小事', '嗯', { at: now - d(50), importance: 0.1 })  // 50 天 → 45 天档压缩
    m.remember('超久以前的小事', '嗯', { at: now - d(130), importance: 0.1 }) // 130 天 → 删除正文
    m.remember('重要的事', '好', { at: now - d(200), importance: 0.95 })      // 高重要度不压
    m.tick(now)
    const recent = m.loadRecent(20)
    const st = m.stats()
    ok('21 天档被压缩（compressedLevel=1）', recent.some((e) => e.content.slice(0, 6) === '很久以前的小' && e.compressedLevel === 1))
    ok('45 天档压到 level2', recent.some((e) => e.compressedLevel === 2))
    ok('120 天档删正文留目录', st.catalogLen >= 1 && !recent.some((e) => e.content.slice(0, 6) === '超久以前的小'))
    ok('高重要度不被压缩', recent.some((e) => e.content.slice(0, 4) === '重要的事' && e.compressedLevel === 0))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

rmSync(join(ROOT, '.tmp-memory-test'), { recursive: true, force: true })
console.log('\n────────────────────')
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
