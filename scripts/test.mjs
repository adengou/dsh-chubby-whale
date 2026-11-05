/**
 * scripts/test.mjs —— 可复跑的自检（不联网、不需要麦克风）
 *
 * 三项：
 *   ① data/persona.json 结构与非重复校验（防止"老是那两三句"回归）
 *   ② splitForTts 不丢字校验（从 src/client/voice.ts 抽出真实函数逐字比对）
 *   ③ 右键菜单底部必须是版本号（主人定的规矩）
 *
 * 用法：npm test
 */

import { readFileSync } from 'node:fs'

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

// ---------- ① persona.json ----------
console.log('\n[1] data/persona.json')
let persona = null
try {
  persona = JSON.parse(readFileSync('data/persona.json', 'utf8'))
  ok('JSON 可解析', true)
} catch (e) {
  ok('JSON 可解析', false, String(e.message))
}
if (persona) {
  const events = Object.keys(persona.lines || {})
  ok('场景数量 ≥ 20', events.length >= 20, '实际 ' + events.length)

  // 每个场景至少 2 句：只有 1 句必然重复
  const thin = events.filter((k) => !Array.isArray(persona.lines[k]) || persona.lines[k].length < 2)
  ok('每个场景 ≥2 句（不会一开口就重复）', thin.length === 0, thin.length ? '偏少: ' + thin.join(',') : '')

  // 全局重复台词（同句出现在多处，会让不同场景听起来一样）
  const seen = new Map()
  const dups = []
  for (const k of events) {
    for (const line of persona.lines[k]) {
      const t = String(line).trim()
      if (seen.has(t)) dups.push(t + ' (' + seen.get(t) + ' & ' + k + ')')
      else seen.set(t, k)
    }
  }
  ok('台词无跨场景重复', dups.length === 0, dups.slice(0, 3).join(' / '))

  // 气泡友好：单句不超过 40 字，语音一口气念得完
  const tooLong = []
  for (const k of events) for (const line of persona.lines[k]) if (String(line).length > 40) tooLong.push(k + ':' + line)
  ok('单句 ≤40 字', tooLong.length === 0, tooLong.slice(0, 2).join(' / '))

  // 乱码检测：出现 ? 或 � 说明写文件时编码错了
  const bad = []
  for (const k of events) for (const line of persona.lines[k]) if (/[�]/.test(String(line))) bad.push(k)
  ok('无乱码字符', bad.length === 0, bad.join(','))

  ok('有成长阶段表', Array.isArray(persona.stages) && persona.stages.length >= 3)
  ok('有菜单文案映射', !!persona.menus && Object.keys(persona.menus).length >= 5)
}

// ---------- ② splitForTts 不丢字 ----------
console.log('\n[2] splitForTts（朗读切分不丢字）')
let splitForTts = null
try {
  const src = readFileSync('src/client/voice.ts', 'utf8')
  const start = src.indexOf('function splitForTts')
  if (start < 0) throw new Error('voice.ts 里找不到 splitForTts')
  let depth = 0, seenBrace = false, end = -1
  for (let i = start; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') { depth++; seenBrace = true }
    else if (ch === '}') { depth-- }
    if (seenBrace && depth === 0) { end = i + 1; break }
  }
  if (end < 0) throw new Error('splitForTts 括号不闭合')
  let body = src.slice(start, end)
  body = body.replace(/\(text: string, maxLen = 56\): string\[\]/, '(text, maxLen = 56)').replace(/: string\[\]/g, '')
  splitForTts = new Function(body + '; return splitForTts')()
  ok('能从源码抽出函数', typeof splitForTts === 'function')
} catch (e) {
  ok('能从源码抽出函数', false, String(e.message))
}

if (splitForTts) {
  const cases = [
    '静夜思。床前明月光，疑是地上霜。举头望明月，低头思故乡。',
    '寒蝉凄切，对长亭晚，骤雨初歇。都门帐饮无绪，留恋处，兰舟催发。执手相看泪眼，竟无语凝噎。念去去，千里烟波，暮霭沉沉楚天阔。',
    '短',
    '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十',
    '第1句，第2句；第3句！第4句？第5句。',
  ]
  let allLossless = true
  let firstMaxOk = true
  for (const c of cases) {
    const segs = splitForTts(c, 56)
    const joined = segs.join('')
    if (joined !== c) { allLossless = false; console.log('    丢失: ' + c.slice(0, 12) + '… → ' + joined.slice(0, 12) + '…') }
    if (segs[0] && segs[0].length > 14) firstMaxOk = false
  }
  ok('拼接后与原文逐字一致', allLossless, '(' + cases.length + ' 组文本)')
  ok('首段 ≤14 字（照参考实现）', firstMaxOk)
}

// ---------- ③ 右键菜单底部是版本号 ----------
console.log('\n[3] 右键菜单')
try {
  const menu = readFileSync('src/client/menu.ts', 'utf8')
  const idxVersion = menu.lastIndexOf("action: 'version'")
  const idxLastItem = menu.lastIndexOf("type: 'item'")
  // 需求变更（2026-11-05）：版本号只在菜单标题栏显示，菜单项里不再重复出现
  const idxVersion = menu.lastIndexOf("action: 'version'")
  ok('菜单不含版本项（版本只在标题栏）', idxVersion < 0)
} catch (e) {
  ok('菜单可读', false, String(e.message))
}


// ---------- ④ 相似度算法（回声 / 重复发言） ----------
console.log('\n[4] 相似度算法 client/sim.ts')
try {
  const sim = await import('../src/client/sim.ts')
  const cases = [
    // [说明, a, b, 期望相似度区间]
    ['同一句只差标点', '你好呀。', '你好呀', 1],
    ['同一句被切成两段', '今天天气不错你给我讲个笑话吧', '不错你给我讲个笑话吧', null],
    ['完全不同的问句', '今天天气怎么样', '讲个聊斋故事', null],
    ['短词回声', 'master', 'master', 1],
  ]
  const s1 = sim.similarity('你好呀。', '你好呀')
  ok('标点差异 → 相似度 1', s1 > 0.99, 'v=' + s1.toFixed(2))
  const s2 = sim.similarity('今天天气不错你给我讲个笑话吧', '不错你给我讲个笑话吧')
  ok('句中截断 → 相似度 > 0.6', s2 > 0.6, 'v=' + s2.toFixed(2))
  const s3 = sim.similarity('今天天气怎么样', '讲个聊斋故事')
  ok('不同问句 → 相似度 < 0.2', s3 < 0.2, 'v=' + s3.toFixed(2))

  const now = Date.now()
  const recent = [{ text: '今天天气不错你给我讲个笑话吧', at: now - 1000 }]
  ok('8 秒内同一句判为重复', sim.isRepeat('不错你给我讲个笑话吧', { recent, windowMs: 8000, threshold: 0.9, minLen: 4, now }) === true)
  ok('隔了 30 秒不再当重复', sim.isRepeat('不错你给我讲个笑话吧', { recent, windowMs: 8000, threshold: 0.9, minLen: 4, now: now + 30000 }) === false)
  ok('不同问句不误判', sim.isRepeat('讲个聊斋故事', { recent, windowMs: 8000, threshold: 0.9, minLen: 4, now }) === false)
  ok('master 回声判为重复', sim.isRepeat('master', { recent: [{ text: 'master', at: now - 500 }], windowMs: 8000, threshold: 0.9, minLen: 4, now }) === true)
} catch (e) {
  ok('能加载 sim.ts', false, String(e.message))
}


// ---------- ⑤ 点播意图（本地路由关键词） ----------
console.log('\n[5] 点播意图 client/intent.ts')
try {
  const it = await import('../src/client/intent.ts')
  const cases = [
    ['讲个聊斋', 'story', '聊斋志异'],
    ['讲聊斋', 'story', '聊斋志异'],
    ['讲三国', 'story', '三国演义'],
    ['讲个故事', 'story', ''],
    ['说书', 'story', ''],
    ['背首诗', 'poem', ''],
    ['念首诗', 'poem', ''],
    ['讲个典故', 'culture', ''],
    ['来个成语', 'culture', ''],
    ['为什么天是蓝的', null, ''],
    ['讲个故事吗？', null, ''],
    ['今天天气怎么样', null, ''],
  ]
  let bad = []
  for (const [text, kind, book] of cases) {
    const r = it.detectIntent(text)
    const gotKind = r ? r.kind : null
    const gotBook = r && r.kind === 'story' ? r.book : ''
    if (gotKind !== kind) bad.push(text + ' → ' + gotKind + '（应为 ' + kind + '）')
    else if (kind === 'story' && book && gotBook !== book) bad.push(text + ' 书名 ' + gotBook + '（应为 ' + book + '）')
  }
  ok('12 条关键词用例', bad.length === 0, bad.slice(0, 3).join(' / '))
  ok('提问不劫持', it.detectIntent('讲个故事吗？') === null && it.detectIntent('为什么天是蓝的') === null)
  ok('超长句不劫持', it.detectIntent('讲故事'.repeat(20)) === null)
  // 诗名识别（634 个标题索引）
  const t1 = it.detectIntent('背雨霖铃')
  ok('「背雨霖铃」→ 指定诗名', !!t1 && t1.kind === 'poem' && t1.title === '雨霖铃', t1 ? JSON.stringify(t1) : 'null')
  const t2 = it.detectIntent('来首水调歌头')
  ok('「来首水调歌头」→ 指定诗名', !!t2 && t2.kind === 'poem' && t2.title === '水调歌头', t2 ? JSON.stringify(t2) : 'null')
  const t3 = it.detectIntent('念一下静夜思')
  ok('「念一下静夜思」→ 指定诗名', !!t3 && t3.kind === 'poem' && t3.title === '静夜思', t3 ? JSON.stringify(t3) : 'null')
  ok('泛化「背首诗」仍走随机', (() => { const r = it.detectIntent('背首诗'); return !!r && r.kind === 'poem' && !r.title })())

} catch (e) {
  ok('能加载 intent.ts', false, String(e.message))
}


// ---------- ⑥ SSE 解析（流式对话） ----------
console.log('\n[6] SSE 解析 src/shared/sse.ts')
try {
  const sse = await import('../src/shared/sse.ts')
  const one = sse.parseSseBuffer('data: {"delta":"你"}\n\n')
  ok('单条事件', one.events.length === 1 && one.events[0].delta === '你', 'rest=[' + one.rest + ']')

  const split = sse.parseSseBuffer('data: {"delta":"你')
  ok('半条事件留在 rest', split.events.length === 0 && split.rest.indexOf('你') >= 0)
  const joined = sse.parseSseBuffer(split.rest + '"}\n')
  ok('拼回后续可解析', joined.events.length === 1 && joined.events[0].delta === '你')

  const crlf = sse.parseSseBuffer('data: {"a":1}\r\ndata: {"b":2}\r\n')
  ok('CRLF 换行', crlf.events.length === 2, 'got=' + crlf.events.length)

  const done = sse.parseSseBuffer('data: {"delta":"x"}\ndata: [DONE]\n')
  ok('[DONE] 被忽略', done.events.length === 1)

  const bad = sse.parseSseBuffer('data: {坏JSON}\ndata: {"ok":1}\n')
  ok('坏行计数且不影响好行', bad.invalid === 1 && bad.events.length === 1, 'invalid=' + bad.invalid)

  const noise = sse.parseSseBuffer(': keep-alive\nevent: ping\ndata: {"ok":1}\n')
  ok('注释/事件名行被跳过', noise.events.length === 1)
} catch (e) {
  ok('能加载 sse.ts', false, String(e.message))
}


// ---------- ⑦ 朗读看门狗（合成中不该被判死） ----------
console.log('\n[7] 朗读看门狗 client/playback.ts')
try {
  const pb = await import('../src/client/playback.ts')
  const base = { hasAudio: false, audioPlaying: false, busy: true, busySince: 1000, synthAt: 0, now: 4000 }
  ok('合成 3 秒（还没音频）不是僵尸', pb.isPlaybackZombie({ ...base, synthAt: 1000, now: 4000 }) === false)
  ok('合成 4.5 秒仍在允许内', pb.isPlaybackZombie({ ...base, synthAt: 1000, now: 5500 }) === false)
  ok('合成超过 20 秒才算异常', pb.isPlaybackZombie({ ...base, synthAt: 1000, now: 22000 }) === true)
  ok('有音频在播 → 健康', pb.isPlaybackZombie({ ...base, hasAudio: true, audioPlaying: true, now: 9000 }) === false)
  ok('有音频却停滞 3 秒 → 僵尸', pb.isPlaybackZombie({ ...base, hasAudio: true, audioPlaying: false, now: 5000 }) === true)
  ok('空闲（不 busy）永远不是僵尸', pb.isPlaybackZombie({ ...base, busy: false, now: 99999 }) === false)
} catch (e) {
  ok('能加载 playback.ts', false, String(e.message))
}

console.log('\n────────────────────')
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项')
if (fail > 0) process.exit(1)
