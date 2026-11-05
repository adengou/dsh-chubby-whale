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
import { register } from 'node:module'

// 测试里直接加载 .ts：注册解析钩子，把找不到的 .js 回退到同名 .ts
register(new URL('./ts-resolve.mjs', import.meta.url))

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


// ---------- ⑧ 模块封装（导出冻结 / 进度状态） ----------
console.log('\n[8] 模块封装与叙述进度')
try {
  const im = await import('../src/shared/immutable.ts')
  const frozenArr = im.deepFreeze([1, 2, 3])
  let threw = false
  try { frozenArr.push(4) } catch (e) { threw = true }
  ok('deepFreeze 冻结数组（push 抛错）', threw)
  const frozenObj = im.deepFreeze({ a: { b: 1 } })
  let threw2 = false
  try { frozenObj.a.b = 2 } catch (e) { threw2 = true }
  ok('deepFreeze 递归冻结嵌套对象', threw2 && frozenObj.a.b === 1)
  ok('deepFreeze 对原始值不报错', im.deepFreeze(5) === 5 && im.deepFreeze(null) === null)

  const np = await import('../src/client/narration-progress.ts')
  const lines = ['寒蝉凄切。', '对长亭晚，骤雨初歇。', '念去去、千里烟波，暮霭沉沉楚天阔。']
  np.startProgress('念诗·雨霖铃', lines, '念首诗——雨霖铃，宋，柳永。')
  ok('开场白不占句数', np.bumpProgress('念首诗——雨霖铃，宋，柳永。') === '念诗·雨霖铃：念首诗——雨霖铃，宋，柳永。')
  ok('第一句显示 1/N', np.bumpProgress('寒蝉凄切。').includes('（第 1/3 句）'))
  ok('第二句显示 2/N', np.bumpProgress('对长亭晚，骤雨初歇。').includes('（第 2/3 句）'))
  ok('末句封顶 3/3', np.bumpProgress('念去去、千里烟波，暮霭沉沉楚天阔。').includes('（第 3/3 句）'))
  np.stopProgress()
  ok('stopProgress 后不再出进度', np.bumpProgress('多情自古伤离别。') === '')

  const wk = await import('../src/client/wake.ts')
  const gate = wk.createWakeGate({ windowMs: 30000 })
  ok('谐音容错：大粉鱼', gate.check('大粉鱼。').hit === true)
  ok('谐音容错：大飞鱼', gate.check('大飞鱼。').hit === true)
  ok('繁体折算：大肥魚', gate.check('大肥魚。').hit === true)
  ok('正常词不误唤醒：大鲤鱼', gate.check('大鲤鱼').hit === false)
  ok('长句不误唤醒：大时代…', gate.check('在《大时代》中，丁蟹的丁字是大谐音。').hit === false)
} catch (e) {
  ok('能加载封装/进度/唤醒模块', false, String(e.message))
}


// ---------- ⑨ 回归：唤醒锚定 / APE 兜底 / 回声归一化 ----------
console.log('\n[9] 回归：唤醒锚定 / APE 兜底 / 回声归一化')
try {
  const wk = await import('../src/client/wake.ts')
  const gate = wk.createWakeGate({ windowMs: 30000 })
  ok('短词不再句中误唤醒：我想看小鱼', gate.check('我想看小鱼').hit === false)
  ok('短词句首仍能唤醒：小鱼你好', gate.check('小鱼你好').hit === true)
  ok('三字觉醒词句中仍认：我想看大肥鱼', gate.check('我想看大肥鱼').hit === true)
  ok('剥唤醒词后剩正文', wk.stripWakeWords('大肥鱼讲个故事').text.includes('讲个故事'))

  const ape = await import('../src/client/ape.ts')
  // 说话 780ms 后进入"中间带"噪声（-60dB）：既不算说话也不算安静，旧逻辑要等满 6 秒
  const F = 60
  const seq = []
  for (let i = 0; i < 600 / F; i++) seq.push(-67)
  for (let i = 0; i < 780 / F; i++) seq.push(-45)
  for (let i = 0; i < 3000 / F; i++) seq.push(-60)
  const r = ape.simulateSegment(seq, {})
  ok('中间带噪声时按"说完话"提前收尾', r.step.commit === true && r.step.commitReason === 'quiet', 'frames=' + r.frames + ' reason=' + r.step.commitReason)
  ok('收尾发生在 3 秒内（不再等满 6 秒）', r.frames * F <= 3000, (r.frames * F) + 'ms')
  ok('空序列不死机', ape.simulateSegment([], {}).frames === 0)

  const txt = await import('../src/client/text.ts')
  ok('回声归一化：星号动作被剥掉', txt.echoKey('星号甩甩尾巴星号 主人说话') === '主人说话')
  ok('回声归一化：标准动作描写同步剥掉', txt.echoKey('*蹭一下* 本鲸在呢。') === '本鲸在呢')
  ok('回声归一化：普通句子不受影响', txt.echoKey('今天天气不错') === '今天天气不错')
} catch (e) {
  ok('能加载回归模块', false, String(e.message))
}


// ---------- ⑩ 噪声判定（客户端与宿主共用） ----------
console.log('\n[10] 噪声判定 shared/noise.ts')
try {
  const nz = await import('../src/shared/noise.ts')
  ok('气口「嗯。」判为噪声', nz.isNoiseText('嗯。') === true)
  ok('重复「嗯嗯嗯」判为噪声', nz.isNoiseText('嗯嗯嗯') === true)
  ok('片头词「谢谢观看」判为噪声', nz.isNoiseText('谢谢观看') === true)
  ok('空文本判为噪声', nz.isNoiseText('') === true && nz.isNoiseText(null) === true)
  ok('正常短句不是噪声', nz.isNoiseText('大肥鱼') === false)
  ok('正常长句不是噪声', nz.isNoiseText('今天天气不错，讲个聊斋吧') === false)
  ok('带标点的正常句不被误杀', nz.isNoiseText('你好，我是肥鲸。') === false)
} catch (e) {
  ok('能加载 noise.ts', false, String(e.message))
}


// ---------- ⑪ 缓存：拷贝隔离 + Buffer 不被降级 ----------
console.log('\n[11] 缓存 cache.ts（拷贝隔离 / Buffer）')
try {
  const { createCache } = await import('../src/host/cache.ts')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'chubby-cache-test-'))
  const cache = createCache({ dir, memBytes: 4 * 1024 * 1024 })

  const obj = { text: '你好', n: 1 }
  await cache.setJson('k1', obj)
  obj.text = '被调用方改了'
  const got = await cache.getJson('k1', 'json')
  ok('写入时拷贝：调用方改自己那份不影响缓存', got && got.text === '你好')

  got.text = '读取方改了'
  const got2 = await cache.getJson('k1', 'json')
  ok('读取时拷贝：改返回值不影响缓存', got2 && got2.text === '你好')

  const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x64])
  await cache.setJson('b1', mp3, 'mp3')
  const back = await cache.getJson('b1', 'mp3')
  ok('二进制仍是 Buffer（structuredClone 会把 Buffer 变 Uint8Array）', Buffer.isBuffer(back))
  ok('二进制内容一致', Buffer.isBuffer(back) && back.equals(mp3))

  rmSync(dir, { recursive: true, force: true })
} catch (e) {
  ok('能加载/使用 cache.ts', false, String(e.message))
}


// ---------- ⑫ 朗读语速 rates.ts ----------
console.log('\n[12] 朗读语速 client/rates.ts')
try {
  // Node 里没有 localStorage：先装一个内存桩，测的就是 rates 的逻辑而不是浏览器 API
  const mem = new Map()
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)) },
    removeItem: (k) => { mem.delete(k) },
  }
  const rates = await import('../src/client/rates.ts')
  ok('默认叙述语速 -25%', rates.narrationRate() === '-25%')
  ok('非法值不写入', rates.setNarrationRate('-99%') === false && rates.narrationRate() === '-25%')
  ok('合法值写入成功', rates.setNarrationRate('-15%') === true)
  ok('写入后读到新值', rates.narrationRate() === '-15%')
  ok('档位表被冻结', Array.isArray(rates.NARRATION_RATES) && Object.isFrozen(rates.NARRATION_RATES))
  delete globalThis.localStorage
} catch (e) {
  ok('能加载 rates.ts', false, String(e.message))
}


// ---------- ⑬ 菜单：新增开关与语速项 ----------
console.log('\n[13] 菜单 buildMenu / tr')
try {
  const menu = await import('../src/client/menu.ts')
  const items = menu.buildMenu('9.9.9', { streamOn: false, narrationRate: '-15%', poemRate: '-20%', storyRate: '-30%' })
  const flat = JSON.stringify(items)
  const labels = []
  const walk = (arr) => { for (const it of arr) { if (it.label) labels.push(it.label); if (it.items) walk(it.items) } }
  walk(items)
  ok('菜单含「流式回复：关」', labels.indexOf('流式回复：关') >= 0)
  ok('菜单含「叙述语速：-15% ▸」', labels.some((x) => x.indexOf('叙述语速：-15%') === 0))
  ok('菜单含「念诗语速：-20% ▸」', labels.some((x) => x.indexOf('念诗语速：-20%') === 0))
  ok('菜单含「说书语速：-30% ▸」', labels.some((x) => x.indexOf('说书语速：-30%') === 0))
  ok('EN 流式回复', menu.tr('流式回复：关', 'en') === 'Streaming replies: off')
  ok('EN 叙述语速', menu.tr('叙述语速：-15% ▸', 'en') === 'Narration speed: -15% ▸')
  ok('EN 念诗语速', menu.tr('念诗语速：-20% ▸', 'en') === 'Poem speed: -20% ▸')
} catch (e) {
  ok('能加载 menu.ts', false, String(e.message))
}


// ---------- ⑭ 版本号唯一真源 ----------
console.log('\n[14] 版本号（package.json → client/version.ts）')
try {
  const { readFileSync: rf } = await import('node:fs')
  const pkgV = JSON.parse(rf('package.json', 'utf8')).version
  const ver = await import('../src/client/version.ts')
  ok('客户端 VERSION 与 package.json 一致', ver.VERSION === pkgV, 'client=' + ver.VERSION + ' pkg=' + pkgV)
  const styles = rf('src/client/styles.ts', 'utf8')
  ok('styles.ts 不再硬编码版本号', styles.indexOf('export const VERSION') < 0)
} catch (e) {
  ok('能加载 client/version.ts', false, String(e.message))
}


// ---------- ⑮ 路由表：客户端要的都存在、路径不重复 ----------
console.log('\n[15] 宿主路由表 host/routes.ts')
try {
  const { createRouteTable } = await import('../src/host/routes.ts')
  const fn = () => undefined
  const stub = {
    misc: { handleAsset: fn, handleStatus: fn, handleState: fn, handleBalance: fn, handleGrowth: fn, handleFishfood: fn, handlePet: fn, handleClearMemory: fn, handleCache: fn },
    chat: fn, chatStream: fn, cacheToggle: fn,
    story: { handleBooks: fn, handleStoryStart: fn, handleStoryNext: fn, handleStoryReset: fn },
    reminders: { handleReminders: fn },
    culture: { handleCulture: fn, handleMelodies: fn, handleMelody: fn },
    poem: { handlePoem: fn },
    briefing: { handleBriefing: fn },
    tts: fn, asr: fn,
    personality: { handlePersonality: fn, handleRevert: fn },
    daily: { handleDaily: fn },
    backup: { handleExport: fn, handleImport: fn },
    stats: { handleStats: fn },
  }
  const table = createRouteTable(stub)
  const paths = table.map((r) => r.path)
  ok('路由表非空', table.length >= 25, '共 ' + table.length + ' 条')
  ok('路径无重复', new Set(paths).size === paths.length)
  ok('每条路由都有函数 handler', table.every((r) => typeof r.handler === 'function'))
  ok('全部挂在 /api/chubby-whale/', paths.every((p) => p.indexOf('/api/chubby-whale/') === 0))

  // 客户端真实用到的接口：从源码里抽 getJson('...') / '/api/chubby-whale/...'
  const fsMod = await import('node:fs')
  const { readdirSync, readFileSync: rf, statSync } = fsMod
  const { join } = await import('node:path')
  const files = []
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const q = join(d, n)
      if (statSync(q).isDirectory()) walk(q)
      else if (n.endsWith('.ts')) files.push(q)
    }
  }
  walk('src/client')
  files.push('src/client.ts')
  const wanted = new Set()
  for (const file of files) {
    const src = rf(file, 'utf8')
    for (const m of src.matchAll(/getJson\(\s*'([^']+)'/g)) wanted.add(m[1])
    for (const m of src.matchAll(/'\/api\/chubby-whale\/([a-z0-9/-]+)'/g)) wanted.add('/' + m[1])
  }
  const missing = []
  for (const w of wanted) {
    const raw = w.split('?')[0].replace(/^\//, '')
    const full = '/api/chubby-whale/' + raw
    if (paths.indexOf(full) < 0) missing.push(full)
  }
  ok('客户端用到的接口都在路由表里', missing.length === 0, missing.length ? '缺：' + missing.join(', ') : '检查 ' + wanted.size + ' 个')
} catch (e) {
  ok('能加载 routes.ts', false, String(e.message))
}


// ---------- ⑯ 回声：动作描写 + 短碎片（历史数据里真实出现过的两条） ----------
console.log('\n[16] 回声过滤 text.ts')
try {
  const txt = await import('../src/client/text.ts')
  // 历史数据里真实出现的两条回声（memory.json：「星号」7 条中的两条）
  const aHeard = '星号甩甩尾巴，凑近星号主人说话，要一句一句来吗？'
  const aSpoken = '*甩甩尾巴凑近* 主人说话要一句一句来嘛。'
  const a = txt.echoKey(aHeard)
  const b = txt.echoKey(aSpoken)
  ok('完整回声：归一后可判为同一句', a === b || (b.length >= 6 && a.indexOf(b.slice(0, 6)) >= 0), '[' + a + '] vs [' + b + ']')

  const bHeard = '的星号鼓了鼓腮，凑过来蹭一，本金在呢。星号歪。'
  const bSpoken = '*鼓了鼓腮，凑过来蹭一下* 本鲸在呢。'
  const bk = txt.echoKey(bHeard)
  ok('碎片回声：归一后只剩 1~2 字', bk.length <= 2, '[' + bk + ']')
  ok('碎片回声：刚朗读过时被拦下', txt.isShortEchoFragment(bk, true) === true)
  ok('普通两字回应不被拦：好的', txt.isShortEchoFragment('好的', true) === false)
  ok('打断命令不被拦：停', txt.isShortEchoFragment('停', true) === false)
  ok('没刚朗读过时不拦两字', txt.isShortEchoFragment('随便', false) === false)
  ok('刚朗读过、两字非白名单 → 拦', txt.isShortEchoFragment('随便', true) === true)
} catch (e) {
  ok('能加载 text.ts 回声工具', false, String(e.message))
}


// ---------- ⑰ 路由处理器：用假 req/res 真调一遍 ----------
console.log('\n[17] 路由处理器 host/routes/*（假 req/res）')
try {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const mkRes = () => {
    const out = { code: 0, body: '', headers: null }
    out.writeHead = (code, headers) => { out.code = code; out.headers = headers }
    out.end = (body) => { out.body = body ? String(body) : '' }
    out.setHeader = () => { }
    out.write = () => { }
    return out
  }
  const call = async (handler, url) => {
    const res = mkRes()
    await handler({ url, method: 'GET', headers: {} }, res)
    let json = null
    try { json = JSON.parse(res.body) } catch (e) { }
    return { code: res.code, json, raw: res.body }
  }

  // 念诗：假诗库两首 → 连续点两次不重样
  const dir = mkdtempSync(join(tmpdir(), 'chubby-route-test-'))
  const poems = [
    { title: '静夜思', author: '李白', dynasty: '唐', lines: ['床前明月光', '疑是地上霜'] },
    { title: '望岳', author: '杜甫', dynasty: '唐', lines: ['岱宗夫如何'] },
  ]
  const dataPort = {
    readPoemsChunk: async (i) => ({ index: i, total: 1, items: i === 0 ? poems : [] }),
    readCulture: async () => [],
    readDuilian: async () => ({ upper: [], lower: [] }),
    readDaily: async () => [],
  }
  const { createPoemHandler } = await import('../src/host/routes/poem.ts')
  const poem = createPoemHandler({ runtimeDir: dir, dataPort })
  const p1 = await call(poem.handlePoem, '/api/chubby-whale/poem')
  ok('念诗：返回 ok + item', !!p1.json && p1.json.ok === true && !!p1.json.item, p1.json && p1.json.item ? p1.json.item.title : '')
  const p2 = await call(poem.handlePoem, '/api/chubby-whale/poem')
  const t1 = p1.json && p1.json.item && p1.json.item.title
  const t2 = p2.json && p2.json.item && p2.json.item.title
  ok('念诗：连续两次不重复', !!t1 && !!t2 && t1 !== t2, t1 + ' / ' + t2)
  const p3 = await call(poem.handlePoem, '/api/chubby-whale/poem')
  const t3 = p3.json && p3.json.item && p3.json.item.title
  ok('念诗：一轮念完自动重来', t3 === t1 || t3 === t2, String(t3))

  // 每日一句：没有 daily.json → 从诗库按日期取，不编造
  const { createDailyHandler } = await import('../src/host/routes/daily.ts')
  const daily = createDailyHandler({ dataPort, runtimeDir: dir })
  const d1 = await call(daily.handleDaily, '/api/chubby-whale/daily')
  ok('每日一句：ok 且有文本', !!d1.json && d1.json.ok === true && typeof d1.json.text === 'string' && d1.json.text.length > 0)
  ok('每日一句：文本来自诗库', !!d1.json && poems.some((x) => (x.lines.join('')).indexOf(String(d1.json.text).slice(0, 2)) >= 0), String(d1.json && d1.json.text).slice(0, 12))

  // 状态/宠物：亲密度必须取 state.json（loadIntimacy），不能被 pet_state 的旧值盖掉
  const { createMiscHandlers } = await import('../src/host/routes/misc.ts')
  const misc = createMiscHandlers({
    assetPath: join(dir, 'missing.png'),
    getKey: () => '',
    loadState: () => ({ intimacy: 100 }),
    loadGrowth: () => ({ exp: 10 }),
    loadFishfood: () => ({ chatTokens: 1, storyTokens: 0 }),
    loadPet: () => ({ feeds: 5, hunger: 0, mood: 'happy', intimacy: 8 }),
    feedPet: () => ({ feeds: 6, hunger: 0, mood: 'happy', intimacy: 8 }),
    loadIntimacy: () => 100,
    bumpIntimacy: () => 100,
  })
  const st = await call(misc.handleState, '/api/chubby-whale/state')
  ok('/state 返回 intimacy=100', !!st.json && st.json.intimacy === 100, JSON.stringify(st.json))
  const pet1 = await call(misc.handlePet, '/api/chubby-whale/pet')
  ok('/pet 的 intimacy 取 state（不是 pet_state 的 8）', !!pet1.json && pet1.json.pet && pet1.json.pet.intimacy === 100, String(pet1.json && pet1.json.pet && pet1.json.pet.intimacy))
  const pet2 = await call(misc.handlePet, '/api/chubby-whale/pet?action=feed')
  ok('喂食也返回 state 的亲密度', !!pet2.json && pet2.json.pet && pet2.json.pet.intimacy === 100, String(pet2.json && pet2.json.pet && pet2.json.pet.intimacy))
  ok('喂食不改动其它字段', !!pet2.json && pet2.json.pet.feeds === 6 && pet2.json.pet.mood === 'happy')

  rmSync(dir, { recursive: true, force: true })
} catch (e) {
  ok('能加载路由处理器', false, String(e.message))
}


// ---------- ⑱ 聊天缓存键：该分的分、该同的同 ----------
console.log('\n[18] 聊天缓存键 chat-core + 语速归一 shared/tts')
try {
  const cc = await import('../src/host/chat-core.ts')
  const base = { lang: 'zh', msg: '你好', isVoice: false, ctx: cc.chatContextFingerprint('记忆摘要A', []), model: 'deepseek-flash' }
  const k1 = cc.chatCacheKey(base.lang, base.msg, base.isVoice, base.ctx, base.model)
  const k2 = cc.chatCacheKey(base.lang, base.msg, base.isVoice, base.ctx, base.model)
  ok('相同输入 → 相同键', k1 === k2)
  ok('换一句话 → 换键', k1 !== cc.chatCacheKey('zh', '你好呀', false, base.ctx, base.model))
  ok('换模型 → 换键（防不同模型串答案）', k1 !== cc.chatCacheKey('zh', '你好', false, base.ctx, 'other-model'))
  ok('换语言 → 换键', k1 !== cc.chatCacheKey('en', '你好', false, base.ctx, base.model))
  ok('语音/打字 → 换键', k1 !== cc.chatCacheKey('zh', '你好', true, base.ctx, base.model))
  const otherCtx = cc.chatContextFingerprint('记忆摘要B', [])
  ok('换记忆摘要 → 换键', k1 !== cc.chatCacheKey('zh', '你好', false, otherCtx, base.model))
  // 同一句问题、只是历史不同 → 应当命中同一键（这是之前修过的"缓存永不命中"问题）
  const ctxHistA = cc.chatContextFingerprint('记忆摘要A', [{ role: 'user', content: '上一句' }])
  const ctxHistB = cc.chatContextFingerprint('记忆摘要A', [{ role: 'user', content: '完全不同的上一句' }])
  ok('历史不同但摘要相同 → 同键（缓存能命中）', ctxHistA === ctxHistB)
  // chatCacheKey 返回 hashKey 的摘要（不是带 v3| 前缀的明文），这里只锁"稳定摘要"这一事实
  ok('键是稳定摘要（16 进制）', /^[0-9a-f]{16,}$/.test(k1), k1.slice(0, 16))

  const t = await import('../src/shared/tts.ts')
  ok('语速归一：-35% 原样', t.normalizeRate('-35%', '+0%') === '-35%')
  ok('语速归一：非法值回落默认', t.normalizeRate('abc', '+0%') === '+0%')
  // 注意：normalizeRate 只校验格式、不做范围夹取（-99% 格式合法就保留）——既有约定
  ok('语速归一：格式合法就保留（不做范围夹取）', t.normalizeRate('-99%', '+0%') === '-99%', t.normalizeRate('-99%', '+0%'))
} catch (e) {
  ok('能加载 chat-core.ts / shared/tts.ts', false, String(e.message))
}


// ---------- ⑲ 菜单动作：每一项都有人接 ----------
console.log('\n[19] 菜单动作覆盖 client/actions*')
try {
  const { createActionTable } = await import('../src/client/actions.ts')
  const mods = await Promise.all([
    import('../src/client/actions/culture.ts'),
    import('../src/client/actions/content.ts'),
    import('../src/client/actions/system.ts'),
    import('../src/client/actions/voice.ts'),
  ])
  const table = createActionTable()
  mods[0].registerCultureActions(table)
  mods[1].registerContentActions(table)
  mods[2].registerSystemActions(table)
  mods[3].registerVoiceActions(table)

  const menu = await import('../src/client/menu.ts')
  const items = menu.buildMenu('9.9.9', {
    storyBooks: ['聊斋', '西游记'], ttsVoice: 'zh-CN-XiaoyiNeural', chatLang: 'zh',
    storyAuto: true, streamOn: true, narrationRate: '-25%', poemRate: '-25%', storyRate: '-35%',
  })
  const dead = []
  let actions = 0
  const walk = (arr) => {
    for (const it of arr) {
      if (it.items) { walk(it.items); continue }
      if (!it.action) continue
      actions++
      if (!table.has(it.action)) dead.push(it.action + ' ← ' + it.label)
    }
  }
  walk(items)
  ok('菜单里有足够多的动作项', actions >= 30, '共 ' + actions + ' 项')
  ok('每个菜单动作都有处理器（无死菜单）', dead.length === 0, dead.length ? dead.join(' | ') : '全部命中')
  ok('未知动作 run() 返回 false', (await table.run('完全不存在的动作', {})) === false)
} catch (e) {
  ok('能加载动作表', false, String(e.message))
}


// ---------- ⑳ 动作描写剥离：星号绝不进语音通道 ----------
console.log('\n[20] 动作描写剥离 text.ts')
try {
  const txt = await import('../src/client/text.ts')
  ok('半角星号动作被剥掉', txt.stripStageDirections('*甩甩尾巴* 主人好呀。') === '主人好呀。')
  ok('全角星号动作被剥掉', txt.stripStageDirections('＊鼓腮＊本鲸在呢。') === '本鲸在呢。')
  ok('多段动作都剥掉', txt.stripStageDirections('*游近*主人，*歪头*吃饭吗？') === '主人，吃饭吗？')
  ok('只有动作 → 空串（不念）', txt.stripStageDirections('*默默游走*') === '')
  ok('标点后多余空格被收掉', txt.stripStageDirections('主人， 白饭。') === '主人，白饭。')
  ok('普通句子原样返回', txt.stripStageDirections('今天天气不错') === '今天天气不错')
  ok('未闭合星号也清掉（不念出星号）', txt.stripStageDirections('主人*还没说完') === '主人 还没说完'.replace(/  /g, ' '))
} catch (e) {
  ok('能加载 text.ts', false, String(e.message))
}


// ---------- ㉑ TTS 路由：入参校验 / 缓存 / Buffer / 失败码 ----------
console.log('\n[21] TTS 路由 host/routes/tts.ts（假 req/res + 假引擎）')
try {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'chubby-tts-test-'))
  const { createCache } = await import('../src/host/cache.ts')
  const { createTtsHandler } = await import('../src/host/routes/tts.ts')
  const cache = createCache({ dir, memBytes: 2 * 1024 * 1024 })
  const calls = []
  let failMode = ''
  const engine = {
    async synthesize(o) {
      calls.push(o)
      if (failMode === 'unavailable') { const e = new Error('python 缺失'); e.code = 'TTS_UNAVAILABLE'; throw e }
      return Buffer.from('MP3DATA:' + o.text)
    },
  }
  const handle = createTtsHandler({ cache, engine })

  const mkReq = (body, headers = {}) => {
    const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    return {
      headers,
      destroy() { }, on() { }, resume() { },
      async *[Symbol.asyncIterator]() { yield buf },
    }
  }
  const mkRes = () => {
    const out = { code: 0, headers: null, chunks: [] }
    out.writeHead = (c, h) => { out.code = c; out.headers = h || {} }
    out.end = (b) => { if (b) out.chunks.push(Buffer.isBuffer(b) ? b : Buffer.from(String(b))) }
    out.setHeader = () => { }
    out.write = () => { }
    out.bodyText = () => Buffer.concat(out.chunks).toString('utf8')
    return out
  }

  // ① 空文本 → 400
  let res = mkRes()
  await handle(mkReq({ text: '   ' }), res)
  ok('空文本 → 400', res.code === 400, 'code=' + res.code + ' body=' + res.bodyText().slice(0, 40))

  // ② 正常合成 → 200 + audio/mpeg + 引擎收到归一化参数
  calls.length = 0
  res = mkRes()
  await handle(mkReq({ text: '主人好呀', rate: '-35%', voice: 'zh-CN-XiaoxiaoNeural', pitch: '+5Hz' }), res)
  ok('正常合成 → 200', res.code === 200)
  ok('响应类型 audio/mpeg', String(res.headers && res.headers['content-type']).indexOf('audio/mpeg') === 0)
  ok('返回的是音频字节', res.bodyText() === 'MP3DATA:主人好呀')
  ok('语速原样传给引擎', calls[0] && calls[0].rate === '-35%', calls[0] && calls[0].rate)
  ok('音高原样传给引擎', calls[0] && calls[0].pitch === '+5Hz', calls[0] && calls[0].pitch)
  ok('合法音色原样传给引擎', calls[0] && calls[0].voice === 'zh-CN-XiaoxiaoNeural')

  // ③ 同样文本再来一次 → 命中缓存，引擎不再被调用，且返回的仍是 Buffer 原样
  calls.length = 0
  res = mkRes()
  await handle(mkReq({ text: '主人好呀', rate: '-35%', voice: 'zh-CN-XiaoxiaoNeural', pitch: '+5Hz' }), res)
  ok('同参数第二次命中缓存（引擎只调一次）', calls.length === 0, 'engine 调用 ' + calls.length + ' 次')
  ok('缓存读回来的音频字节一致', res.bodyText() === 'MP3DATA:主人好呀')

  // ④ 换语速 → 缓存键不同，重新合成（防止慢速说书和普通聊天串味）
  calls.length = 0
  res = mkRes()
  await handle(mkReq({ text: '主人好呀', rate: '-15%' }), res)
  ok('换语速 → 换缓存键，重新合成', calls.length === 1, 'engine 调用 ' + calls.length + ' 次')

  // ⑤ 引擎不可用 → 501 + TTS_UNAVAILABLE（客户端据此改用浏览器语音）
  failMode = 'unavailable'
  res = mkRes()
  await handle(mkReq({ text: '这次会失败' }), res)
  const failBody = JSON.parse(res.bodyText())
  ok('引擎不可用 → 501', res.code === 501, 'code=' + res.code)
  ok('失败码是 TTS_UNAVAILABLE', failBody && failBody.code === 'TTS_UNAVAILABLE')
  failMode = ''

  // ⑥ 超大请求体 → 413（按 content-length 直接拒）
  res = mkRes()
  await handle(mkReq({ text: 'x' }, { 'content-length': String(10 * 1024 * 1024) }), res)
  ok('超大请求体 → 413', res.code === 413, 'code=' + res.code)

  rmSync(dir, { recursive: true, force: true })
} catch (e) {
  ok('能加载 TTS 路由', false, String(e.message))
}


// ---------- ㉒ ASR 路由：噪声不写缓存 / 白名单 / 失败码 ----------
console.log('\n[22] ASR 路由 host/routes/asr.ts（假 req/res + 假 fetch）')
try {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'chubby-asr-test-'))
  const { createCache } = await import('../src/host/cache.ts')
  const { createAsrHandler } = await import('../src/host/routes/asr.ts')
  const cache = createCache({ dir, memBytes: 2 * 1024 * 1024 })

  let reply = { ok: true, status: 200, text: '主人好' }
  let rejectWith = null
  const fetchCalls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, body: init && init.body })
    if (rejectWith) throw rejectWith
    return { ok: reply.ok, status: reply.status, text: async () => (typeof reply.text === 'string' ? JSON.stringify({ text: reply.text }) : '') }
  }

  const mkReq = (body) => {
    const buf = Buffer.from(JSON.stringify(body))
    return { headers: {}, destroy() { }, on() { }, resume() { }, async *[Symbol.asyncIterator]() { yield buf } }
  }
  const mkRes = () => {
    const out = { code: 0, chunks: [] }
    out.writeHead = (c) => { out.code = c }
    out.end = (b) => { if (b) out.chunks.push(Buffer.from(String(b))) }
    out.setHeader = () => { }
    out.bodyText = () => Buffer.concat(out.chunks).toString('utf8')
    out.json = () => { try { return JSON.parse(out.bodyText()) } catch (e) { return null } }
    return out
  }
  const audio = Buffer.from('fake-audio-bytes').toString('base64')

  // ① 空音频
  let res = mkRes()
  await createAsrHandler({ cache, getKey: () => 'k' })(mkReq({ audio: '' }), res)
  ok('空音频 → 400', res.code === 400 && res.json().error === 'empty audio')

  // ② 非法 base64
  res = mkRes()
  await createAsrHandler({ cache, getKey: () => 'k' })(mkReq({ audio: '!!!not-base64!!!' }), res)
  ok('非法 base64 → 400', res.code === 400 && res.json().error === 'bad base64')

  // ③ 没 key
  res = mkRes()
  await createAsrHandler({ cache, getKey: () => '' })(mkReq({ audio }), res)
  ok('没有密钥 → ok:false NO_KEY', res.json() && res.json().ok === false && res.json().error === 'NO_KEY')

  // ④ 正常识别 + 缓存命中
  const handle = createAsrHandler({ cache, getKey: () => 'k' })
  fetchCalls.length = 0
  res = mkRes()
  await handle(mkReq({ audio }), res)
  ok('正常识别 → 文本', res.json() && res.json().ok === true && res.json().text === '主人好', JSON.stringify(res.json()))
  res = mkRes()
  await handle(mkReq({ audio }), res)
  ok('同音频第二次命中缓存（fetch 只一次）', fetchCalls.length === 1 && res.json().cached === true, 'fetch=' + fetchCalls.length)

  // ⑤ 噪声结果：不写缓存、按空文本返回
  reply = { ok: true, status: 200, text: '嗯。' }
  fetchCalls.length = 0
  res = mkRes()
  await handle(mkReq({ audio: Buffer.from('noise-audio').toString('base64') }), res)
  ok('噪声结果 → 空文本', res.json() && res.json().text === '', JSON.stringify(res.json()))
  res = mkRes()
  await handle(mkReq({ audio: Buffer.from('noise-audio').toString('base64') }), res)
  ok('噪声结果不写缓存（第二次仍要请求）', fetchCalls.length === 2, 'fetch=' + fetchCalls.length)
  reply = { ok: true, status: 200, text: '主人好' }

  // ⑥ 上游 HTTP 错误
  reply = { ok: false, status: 503, text: 'busy' }
  res = mkRes()
  await handle(mkReq({ audio: Buffer.from('http-err').toString('base64') }), res)
  ok('上游 503 → ok:false 带状态码', res.json() && res.json().ok === false && /503/.test(String(res.json().error)), String(res.json() && res.json().error))
  reply = { ok: true, status: 200, text: '主人好' }

  // ⑦ 超时错误分类
  rejectWith = Object.assign(new Error('aborted'), { name: 'AbortError' })
  res = mkRes()
  await handle(mkReq({ audio: Buffer.from('timeout').toString('base64') }), res)
  ok('超时 → error=timeout', res.json() && res.json().error === 'timeout', String(res.json() && res.json().error))
  rejectWith = null

  // ⑧ format 白名单：非法值回落 webm（防 CRLF 注入）
  fetchCalls.length = 0
  res = mkRes()
  await handle(mkReq({ audio: Buffer.from('fmt').toString('base64'), format: 'exe' }), res)
  const bodyText = fetchCalls[0] && fetchCalls[0].body ? fetchCalls[0].body.toString('latin1') : ''
  ok('非法 format 回落 webm', bodyText.indexOf('filename="audio.webm"') >= 0)

  globalThis.fetch = realFetch
  rmSync(dir, { recursive: true, force: true })
} catch (e) {
  ok('能加载 ASR 路由', false, String(e.message))
}

console.log('\n────────────────────')
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项')
if (fail > 0) process.exit(1)
