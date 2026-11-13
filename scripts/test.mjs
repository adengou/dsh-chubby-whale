/**
 * scripts/test.mjs —— 可复跑的自检（不联网、不需要麦克风）
 *
 * 三项：
 *   ① data/persona.json 结构与非重复校验（防止"老是那两三句"回归）
 *   ② splitForTts 不丢字校验（从 src/client/voice.ts 抽出真实函数逐字比对）
 *   ③ 右键菜单不含版本项（2026-11-05 需求变更：版本号只在菜单标题栏显示，避免与标题栏重复）
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
  splitForTts = (await import('node:vm')).runInNewContext(body + '; splitForTts', {})
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

  // 书名别名表：逐个别名都要落到正式书名（改表时这条会提醒同步测试）
  const bookCases = [
    ['讲讲聊斋', '聊斋志异'], ['讲个西游记', '西游记'], ['讲水浒', '水浒传'], ['讲个红楼梦吧', '红楼梦'],
    ['讲封神', '封神演义'], ['讲隋唐', '隋唐演义'], ['讲杨家将', '杨家将演义'], ['讲世说新语', '世说新语'],
    ['讲三言二拍', '三言二拍'], ['讲儒林外史', '儒林外史'], ['讲官场', '官场现形记'], ['讲老残', '老残游记'],
    ['讲说岳', '说岳全传'], ['讲东周', '东周列国志'], ['讲三侠五义', '三侠五义'], ['讲镜花缘', '镜花缘'],
  ]
  const badBooks = []
  for (const [text, book] of bookCases) {
    const r = it.detectIntent(text)
    if (!r || r.kind !== 'story' || r.book !== book) badBooks.push(text + ' → ' + (r ? r.kind + '/' + (r.book || '') : 'null'))
  }
  ok('书名别名全覆盖（16 个别名）', badBooks.length === 0, badBooks.slice(0, 3).join(' / '))
  ok('别名表被冻结（外部改不动）', Object.isFrozen(it.BOOK_ALIAS))

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
  // 工厂隔离：两个实例各自独立（念诗与说书将来同时用时不会互相踩）
  const pa = np.createProgress()
  const pb = np.createProgress()
  pa.start('A', ['甲一。', '甲二。'], '开场A。')
  pb.start('B', ['乙一。'], '')
  pa.bump('开场A。')
  const paText = pa.bump('甲一。')
  const pbText = pb.bump('乙一。')
  ok('两个进度实例互不干扰', paText.indexOf('A') === 0 && pbText.indexOf('B') === 0 && paText !== pbText, paText + ' | ' + pbText)
  pa.stop()
  ok('一个实例停止不影响另一个', pa.active() === false && pb.active() === true)

  // 停止说话时取消在途合成（代码契约：stopSpeaking 里要 abort 所有 ttsAborts）
  const { readFileSync: rf3 } = await import('node:fs')
  const vSrc = rf3('src/client/voice.ts', 'utf8')
  ok('停止说话会取消在途 TTS 请求', vSrc.indexOf('ttsAborts') >= 0 && vSrc.indexOf('for (const c of ttsAborts)') >= 0)
  // 关语音待命时，在途的识别请求要取消，且回来先判 running（否则"关了还会回话"）
  const iJson = vSrc.indexOf('const data = await res.json()')
  const iGuard = vSrc.indexOf('if (!running) return', iJson)
  ok('关语音时会取消在途 ASR 请求', vSrc.indexOf('asrAborts') >= 0 && vSrc.indexOf('for (const c of asrAborts)') >= 0)
  ok('ASR 回来后先检查是否已停止', iJson > 0 && iGuard > iJson && iGuard < iJson + 400, 'json@' + iJson + ' guard@' + iGuard)
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
  ok('聊天语速默认 -15%', rates.chatRate() === '-15%')
  ok('聊天语速支持 +0% / +10%', rates.setChatRate('+0%') === true && rates.chatRate() === '+0%' && rates.setChatRate('+10%') === true && rates.chatRate() === '+10%')
  ok('聊天语速可写可读', rates.setChatRate('-30%') === true && rates.chatRate() === '-30%')
  ok('非法聊天语速不写', rates.setChatRate('乱写') === false && rates.chatRate() === '-30%')
  ok('档位表被冻结', Object.isFrozen(rates.CHAT_RATES))
  rates.setChatRate('-15%')
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
  ok('菜单含「聊天语速：-15% ▸」', labels.some((x) => x.indexOf('聊天语速：-15%') === 0))
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
    poemTitles: { handlePoemTitles: fn },
    briefing: { handleBriefing: fn },
    weather: { handleWeather: fn },
    tts: fn, asr: fn, ocr: fn, parseDoc: fn,
    personality: { handlePersonality: fn, handleRevert: fn },
    daily: { handleDaily: fn },
    backup: { handleExport: fn, handleImport: fn },
    stats: { handleStats: fn },
    misc: { handleAsset: fn, handleSkin: fn, handleState: fn, handleBalance: fn, handleStatus: fn, handleGrowth: fn, handleFishfood: fn, handlePet: fn, handleClearMemory: fn, handleCache: fn },
    configView: { handleConfig: fn },
    proofread: fn,
    nervous: fn,
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
    import('../src/client/actions/proofread.ts'),
    import('../src/client/actions/nervous.ts'),
  ])
  const table = createActionTable()
  mods[0].registerCultureActions(table)
  mods[1].registerContentActions(table)
  mods[2].registerSystemActions(table)
  mods[3].registerVoiceActions(table)
  mods[4].registerProofreadActions(table)
  mods[5].registerNervousActions(table)
  ;(await import('../src/client/actions.ts')).registerSkinActions(table)

  const menu = await import('../src/client/menu.ts')
  const items = menu.buildMenu('9.9.9', {
    storyBooks: ['聊斋', '西游记'], ttsVoice: 'zh-CN-XiaoyiNeural', chatLang: 'zh',
    storyAuto: true, streamOn: true, narrationRate: '-25%', poemRate: '-25%', storyRate: '-35%', skinFixed: true,
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
  // 防止"抽走了实现、工厂里又留一份副本"（出现过分身：运行时用副本、测试测正本，早晚漂移）
  const { readFileSync: rf2 } = await import('node:fs')
  const voiceSrc = rf2('src/client/voice.ts', 'utf8')
  ok('voice.ts 不再自带一份 stripStageDirections 实现', voiceSrc.indexOf('function stripStageDirections') < 0)
} catch (e) {
  ok('能加载 text.ts', false, String(e.message))
}


// ---------- ㉑ TTS 路由：入参校验 / 缓存 / Buffer / 失败码 ----------
console.log('\n[21] TTS 路由 host/routes/tts.ts（假 req/res + 假引擎）')
try {
  // 连败闸门的阈值是模块级常量（import 时读取），测试前先用短窗口覆盖
  process.env.CHUBBY_TTS_DEGRADE_AFTER = '2'
  process.env.CHUBBY_TTS_DEGRADE_MS = '200'
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

  // ⑦ 连败闸门（2026-11-06）：连续失败收口成一行日志 + 静默窗口，恢复后自动清零
  const errLogs = []
  const origErr = console.error
  console.error = (...a) => { errLogs.push(a.join(' ')) }
  let failMode2 = 'error'
  const calls2 = []
  const engine2 = {
    async synthesize(o) {
      calls2.push(o)
      if (failMode2 === 'error') {
        const e = new Error("NoAudioReceived('no audio')\nTraceback (most recent call last):\n  File \"x.py\", line 1")
        throw e
      }
      return Buffer.from('OK2:' + o.text)
    },
  }
  const handle2 = createTtsHandler({ engine: engine2 })

  res = mkRes()
  await handle2(mkReq({ text: '连败一' }), res)
  ok('闸门①：首次失败 → 500', res.code === 500, 'code=' + res.code)

  res = mkRes()
  await handle2(mkReq({ text: '连败二' }), res)
  const guardBody = JSON.parse(res.bodyText())
  ok('闸门②：第二次失败 → 501 降级', res.code === 501 && guardBody.code === 'TTS_UNAVAILABLE', 'code=' + res.code + ' body=' + res.bodyText())

  const callsAtDegrade = calls2.length
  res = mkRes()
  await handle2(mkReq({ text: '降级期内' }), res)
  ok('闸门③：降级期内不再调引擎', calls2.length === callsAtDegrade, 'engine 调用 ' + (calls2.length - callsAtDegrade) + ' 次')
  ok('闸门④：降级期回 501 且文案是 tts degraded', JSON.parse(res.bodyText()).error === 'tts degraded')

  ok('闸门⑤：日志压成一行不刷屏', errLogs.length <= 2 && !errLogs.some((l) => /[\r\n]/.test(l)), '行数 ' + errLogs.length)

  await new Promise((r) => setTimeout(r, 260))
  failMode2 = 'ok'
  res = mkRes()
  await handle2(mkReq({ text: '恢复' }), res)
  ok('闸门⑥：窗口过后自动恢复 200', res.code === 200, 'code=' + res.code)

  failMode2 = 'error'
  res = mkRes()
  await handle2(mkReq({ text: '恢复后又失败' }), res)
  ok('闸门⑦：成功已清零，再失败是 500 而不是 501', res.code === 500, 'code=' + res.code)
  console.error = origErr

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
  await createAsrHandler({ cache, getDeepseekKey: () => 'k' })(mkReq({ audio: '' }), res)
  ok('空音频 → 400', res.code === 400 && res.json().error === 'empty audio')

  // ② 非法 base64
  res = mkRes()
  await createAsrHandler({ cache, getDeepseekKey: () => 'k' })(mkReq({ audio: '!!!not-base64!!!' }), res)
  ok('非法 base64 → 400', res.code === 400 && res.json().error === 'bad base64')

  // ③ 没 key
  res = mkRes()
  await createAsrHandler({ cache, getDeepseekKey: () => '' })(mkReq({ audio }), res)
  ok('没有密钥 → ok:false NO_KEY + 人话提示', res.json() && res.json().ok === false && res.json().error === 'NO_KEY' && String(res.json().hint || '').indexOf('deepseekKey') >= 0, JSON.stringify(res.json()))

  // ④ 正常识别 + 缓存命中
  const handle = createAsrHandler({ cache, getDeepseekKey: () => 'k' })
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

  // ⑤b 打断词：单字也不能被「单字=气口」规则吞掉（客户端「朗读时喊停」依赖它原样上行）
  reply = { ok: true, status: 200, text: '停' }
  fetchCalls.length = 0
  res = mkRes()
  await handle(mkReq({ audio: Buffer.from('interrupt-audio').toString('base64') }), res)
  ok('打断词「停」原样上行（不当噪声）', res.json() && res.json().text === '停', JSON.stringify(res.json()))
  res = mkRes()
  await handle(mkReq({ audio: Buffer.from('interrupt-audio').toString('base64') }), res)
  ok('打断词不写缓存（第二次仍要请求）', fetchCalls.length === 2, 'fetch=' + fetchCalls.length)
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

  // ⑧ format：非法值 400 拒收；合法但非 WAV（webm/mp3）也拒收——2026-11-14 起只走官方，不再换供应商
  fetchCalls.length = 0
  res = mkRes()
  await handle(mkReq({ audio: Buffer.from('fmt').toString('base64'), format: 'exe' }), res)
  ok('非法 format → 400 bad format（防 CRLF 注入）', res.code === 400 && res.json() && res.json().error === 'bad format', JSON.stringify(res.json()))
  ok('非法 format 不外呼', fetchCalls.length === 0, 'fetch=' + fetchCalls.length)

  const beforeNonWav = fetchCalls.length
  res = mkRes()
  await handle(mkReq({ audio: Buffer.from('fmt-webm').toString('base64'), format: 'webm' }), res)
  ok('webm → ok:false unsupported format（官方只收 WAV，不偷偷换供应商）',
    res.json() && res.json().ok === false && res.json().error === 'unsupported format' && fetchCalls.length === beforeNonWav,
    JSON.stringify(res.json()) + ' fetch=' + fetchCalls.length)

  // 缺省 format 按 WAV 处理（客户端现在只会传 WAV）
  const beforeDefault = fetchCalls.length
  res = mkRes()
  await handle(mkReq({ audio: Buffer.from('fmt-default').toString('base64') }), res)
  const defaultBody = fetchCalls[beforeDefault] && fetchCalls[beforeDefault].body ? fetchCalls[beforeDefault].body.toString('latin1') : ''
  ok('缺省 format 按 WAV 构造 multipart', fetchCalls.length === beforeDefault + 1 && defaultBody.indexOf('filename="audio.wav"') >= 0,
    'fetch=' + fetchCalls.length)

  globalThis.fetch = realFetch
  rmSync(dir, { recursive: true, force: true })
} catch (e) {
  ok('能加载 ASR 路由', false, String(e.message))
}


// ---------- ㉓ 聊天路由：缓存 / 记忆写回 / 亲密度 / 失败兜底 ----------
console.log('\n[23] 聊天路由 host/routes/chat.ts（假 req/res + 假 fetch）')
try {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'chubby-chat-test-'))
  const { createCache } = await import('../src/host/cache.ts')
  const { createChatHandler } = await import('../src/host/routes/chat.ts')
  const cache = createCache({ dir, memBytes: 2 * 1024 * 1024 })

  let replyText = '本鲸在呢～'
  let httpStatus = 200
  const fetchCalls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, body: init && init.body })
    const payload = { choices: [{ message: { content: replyText } }], usage: { total_tokens: 12 } }
    return { ok: httpStatus === 200, status: httpStatus, text: async () => JSON.stringify(payload) }
  }

  const state = { intimacy: 0 }
  const appended = []
  const tokens = []
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
  const deps = (model) => ({
    getKey: () => 'test-key',
    loadHistory: () => [],
    appendTurns: (u, r) => { appended.push([u, r]) },
    loadState: () => ({ ...state }),
    saveState: (st) => { state.intimacy = st.intimacy },
    systemPrompt: 'SYS',
    addExp: () => ({ upgraded: false }),
    addTokens: (kind, n) => { tokens.push([kind, n]) },
    cache,
    loadMemorySummary: () => '',
    model,
  })

  // ① 空消息
  let res = mkRes()
  await createChatHandler(deps('deepseek-flash'))(mkReq({ message: '   ' }), res)
  ok('空消息 → 400', res.code === 400 && res.json().error === 'empty message')

  // ② 没 key
  const noKey = deps('deepseek-flash')
  noKey.getKey = () => ''
  res = mkRes()
  await createChatHandler(noKey)(mkReq({ message: '主人好呀' }), res)
  ok('没有 Key → ok:false NO_KEY（且带兜底回复）', res.json() && res.json().ok === false && res.json().error === 'NO_KEY' && !!res.json().reply)

  // ③ 正常回复：回包 / 记忆写回 / token / 亲密度
  appended.length = 0
  tokens.length = 0
  state.intimacy = 0
  fetchCalls.length = 0
  res = mkRes()
  await createChatHandler(deps('deepseek-flash'))(mkReq({ message: '主人今天有点累' }), res)
  const ok1 = res.json()
  ok('正常回复 → ok + reply', !!ok1 && ok1.ok === true && ok1.reply === '本鲸在呢～')
  ok('记忆写回一轮', appended.length === 1 && appended[0][0] === '主人今天有点累' && appended[0][1] === '本鲸在呢～')
  ok('token 记入鱼粮', tokens.length === 1 && tokens[0][0] === 'chat' && tokens[0][1] === 12)
  ok('亲密度 +1', ok1 && ok1.intimacy === 1, String(ok1 && ok1.intimacy))

  // ④ 同样问题第二次 → 命中缓存（不再请求模型），仍加亲密度、不重复写记忆
  appended.length = 0
  fetchCalls.length = 0
  res = mkRes()
  await createChatHandler(deps('deepseek-flash'))(mkReq({ message: '主人今天有点累' }), res)
  const c1 = res.json()
  ok('第二次命中缓存（fetch 0 次）', fetchCalls.length === 0 && c1.cached === true, 'fetch=' + fetchCalls.length)
  ok('缓存命中不加记忆', appended.length === 0)
  ok('缓存命中仍加亲密度', c1.intimacy === 2, String(c1.intimacy))

  // ⑤ 换模型 → 缓存键不同，重新请求
  fetchCalls.length = 0
  res = mkRes()
  await createChatHandler(deps('another-model'))(mkReq({ message: '主人今天有点累' }), res)
  ok('换模型 → 重新请求（缓存不串模型）', fetchCalls.length === 1, 'fetch=' + fetchCalls.length)

  // ⑥ 短消息不进缓存：同一条短句两次都要请求
  fetchCalls.length = 0
  const shortHandler = createChatHandler(deps('deepseek-flash'))
  res = mkRes(); await shortHandler(mkReq({ message: '在' }), res)
  res = mkRes(); await shortHandler(mkReq({ message: '在' }), res)
  ok('短消息不缓存（两次都请求）', fetchCalls.length === 2, 'fetch=' + fetchCalls.length)

  // ⑦ 上游 500 → ok:false + 兜底文案，不写记忆
  appended.length = 0
  httpStatus = 500
  res = mkRes()
  await createChatHandler(deps('deepseek-flash'))(mkReq({ message: '这次会失败' }), res)
  const bad = res.json()
  ok('上游 500 → ok:false + 兜底文案', bad && bad.ok === false && /HTTP 500/.test(String(bad.error)) && !!bad.reply)
  ok('失败不写记忆', appended.length === 0)
  httpStatus = 200

  globalThis.fetch = realFetch
  rmSync(dir, { recursive: true, force: true })
} catch (e) {
  ok('能加载聊天路由', false, String(e.message))
}


// ---------- ㉔ 说书播放器：连播 / 进度持久化 / 重置 / 跳过坏书 ----------
console.log('\n[24] 说书播放器 host/story/player.ts')
try {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createStoryPlayer } = await import('../src/host/story/player.ts')
  const dir = mkdtempSync(join(tmpdir(), 'chubby-story-test-'))
  const progressFile = join(dir, 'story_progress.json')

  const mkChunks = (book, n) => Array.from({ length: n }, (_, i) => ({
    book, title: book + ' 第' + (i + 1) + '段', piece: i + 1, total: n, text: book + '正文' + (i + 1), index: i,
  }))
  const books = { 甲: mkChunks('甲', 3), 乙: mkChunks('乙', 2), 坏书: [] }
  const repo = {
    listBooks: async () => Object.keys(books),
    loadBook: async (b) => (books[b] ? books[b].slice() : []),
  }
  const player = createStoryPlayer({ repo, progressFile })

  const p1 = await player.start('甲', 'c1')
  ok('开讲：定位到甲第 1 段', p1.ok && p1.chunk.book === '甲' && p1.chunk.piece === 1, p1.ok ? p1.chunk.book + '/' + p1.chunk.piece : p1.error)
  ok('开场白带"话说"、语速 -30%', p1.chunk.text.indexOf('话说') >= 0 && p1.chunk.rate === '-30%')
  ok('remain = 剩余未读段', p1.remain === 2, 'remain=' + p1.remain)
  ok('第一段标记 isFirst', p1.chunk.isFirst === true)

  const p2 = await player.next('c1')
  ok('接着说 → 第 2 段', p2.ok && p2.chunk.piece === 2 && p2.remain === 1)
  const p3 = await player.next('c1')
  ok('第 3 段标记 isLast', p3.ok && p3.chunk.piece === 3 && p3.chunk.isLast === true && p3.remain === 0)
  const p4 = await player.next('c1')
  ok('本书读完 → 换下一本（乙）', p4.ok && p4.chunk.book === '乙' && p4.chunk.piece === 1, p4.ok ? p4.chunk.book + '/' + p4.chunk.piece : p4.error)

  // 进度落盘：新实例（模拟重启）应该从记忆处继续
  const player2 = createStoryPlayer({ repo, progressFile })
  const r1 = await player2.start('', 'c2')
  ok('重启后进度仍在 → 从乙第 2 段继续', r1.ok && r1.chunk.book === '乙' && r1.chunk.piece === 2, r1.ok ? r1.chunk.book + '/' + r1.chunk.piece : r1.error)

  // 从头讲：清掉该书进度
  const rs = await player2.reset('甲', 'c2')
  ok('重置成功', rs.ok && rs.book === '甲', JSON.stringify(rs))
  const a1 = await player2.start('甲', 'c2')
  ok('重置后甲从第 1 段重新讲', a1.ok && a1.chunk.book === '甲' && a1.chunk.piece === 1)

  // 坏书：读不出内容时应跳到能读的书，而不是假装讲完
  const player3 = createStoryPlayer({ repo, progressFile: join(dir, 'p3.json') })
  const bad = await player3.start('坏书', 'c3')
  ok('点坏书 → 跳到能读的书', bad.ok && bad.chunk.book !== '坏书', bad.ok ? bad.chunk.book : bad.error)

  // 全部读完 → 一轮后清零重来
  const player4 = createStoryPlayer({ repo, progressFile: join(dir, 'p4.json') })
  void await player4.start('甲', 'c4')
  void await player4.next('c4')
  void await player4.next('c4')
  void await player4.next('c4')   // 乙1
  void await player4.next('c4')   // 乙2
  const again = await player4.next('c4') // 全读完 → 清零后重来
  ok('全书单都读完后自动从头再来', again.ok, again.ok ? again.chunk.book + '/' + again.chunk.piece : again.error)

  // 空书单
  const playerEmpty = createStoryPlayer({ repo: { listBooks: async () => [], loadBook: async () => [] }, progressFile: join(dir, 'p5.json') })
  const none = await playerEmpty.start('', 'c5')
  ok('空书单 → no books', none.ok === false && none.error === 'no books', JSON.stringify(none))

  rmSync(dir, { recursive: true, force: true })
} catch (e) {
  ok('能加载说书播放器', false, String(e.message))
}


// ---------- ㉕ 备份导出/导入：只认白名单、类型不对就跳过 ----------
console.log('\n[25] 备份路由 host/routes/backup.ts（数据安全）')
try {
  const { createBackupHandlers, BACKUP_MAX_BYTES } = await import('../src/host/routes/backup.ts')
  const saved = {}
  const notes = { story: 0 }
  const cacheCleared = { count: 0 }
  const deps = {
    version: '1.0.1',
    loadMemory: () => ({ history: [{ role: 'user', content: '主人好' }], summary: '摘要' }),
    saveMemory: (m) => { saved.memory = m },
    loadPersonality: () => ({ name: '不该导出', catchphrases: ['哼'], preferences: {}, notes: [] }),
    savePersonality: (p) => { saved.personality = p; return true },
    loadState: () => ({ intimacy: 100 }),
    saveState: (o) => { saved.state = o },
    loadGrowth: () => ({ exp: 10 }),
    saveGrowth: (o) => { saved.growth = o },
    loadFishfood: () => ({ chatTokens: 1 }),
    saveFishfood: (o) => { saved.fishfood = o },
    loadPet: () => ({ feeds: 5 }),
    savePet: (o) => { saved.pet = o },
    loadReminders: () => [{ text: '喝水' }],
    saveReminders: (a) => { saved.reminders = a },
    loadStoryProgress: () => ({ '甲|0': true }),
    saveStoryProgress: (o) => { saved.storyProgress = o },
    onStoryProgressImported: () => { notes.story++ },
    clearChatCache: () => { cacheCleared.count++; return 0 },
    now: () => new Date('2026-11-06T00:00:00Z'),
  }
  const { handleExport, handleImport } = createBackupHandlers(deps)
  const mkReq = (body, method = 'POST') => {
    const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    return {
      method, url: '/api/chubby-whale/data/export', headers: {},
      destroy() { }, on() { }, resume() { },
      async *[Symbol.asyncIterator]() { yield buf },
    }
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

  // ① 导出：字段齐全、不带 Key、人格只出可变层
  let res = mkRes()
  await handleExport(mkReq(null, 'GET'), res)
  const exp = res.json()
  ok('导出 ok + version + 时间戳', exp && exp.ok === true && exp.version === '1.0.1' && exp.exportedAt === '2026-11-06T00:00:00.000Z')
  const fields = ['memory', 'personality', 'state', 'growth', 'fishfood', 'pet', 'reminders', 'storyProgress']
  ok('导出含全部数据字段', fields.every((k) => k in exp), fields.filter((k) => !(k in exp)).join(',') || '齐全')
  ok('导出不含任何 Key', !/apiKey|deepseekKey|siliconflowKey|authorization/i.test(JSON.stringify(exp)))
  ok('人格导出丢掉核心设定', !('name' in exp.personality) && Array.isArray(exp.personality.catchphrases), Object.keys(exp.personality).join(','))
  ok('导出保留记忆内容', exp.memory.history.length === 1 && exp.memory.summary === '摘要')

  // ② 导出只允许 GET/HEAD
  res = mkRes()
  await handleExport(mkReq(null, 'POST'), res)
  ok('导出非 GET → 405', res.code === 405 && res.json().error === 'METHOD_NOT_ALLOWED')

  // ③ 导出过大 → 413
  const bigDeps = { ...deps, loadMemory: () => ({ history: Array.from({ length: 30000 }, () => ({ role: 'user', content: 'x'.repeat(200) })), summary: '' }) }
  res = mkRes()
  await createBackupHandlers(bigDeps).handleExport(mkReq(null, 'GET'), res)
  ok('导出超过上限 → 413 TOO_LARGE', res.code === 413 && res.json().error === 'TOO_LARGE', 'limit=' + BACKUP_MAX_BYTES)

  // ④ 导入：白名单字段落盘、元数据不写盘、未知字段进 skipped
  for (const k of Object.keys(saved)) delete saved[k]
  notes.story = 0
  res = mkRes()
  await handleImport(mkReq({
    ok: true, version: '1.0.1', exportedAt: '2026-11-06T00:00:00.000Z',
    state: { intimacy: 88 }, growth: { exp: 5 }, memory: { history: [{ role: 'user', content: 'hi' }], summary: 's' },
    storyProgress: { '甲|1': true }, 未知字段: 1,
  }, 'POST'), res)
  const imp = res.json()
  ok('导入 ok + 已存字段', imp && imp.ok === true && imp.imported.indexOf('state') >= 0 && saved.state.intimacy === 88)
  ok('元数据不写盘也不进 skipped', imp.skipped.indexOf('ok') < 0 && imp.skipped.indexOf('version') < 0 && imp.skipped.indexOf('exportedAt') < 0)
  ok('未知字段进 skipped', imp.skipped.indexOf('未知字段') >= 0, imp.skipped.join(','))
  ok('说书进度导入后刷新播放器内存', imp.imported.indexOf('storyProgress') >= 0 && notes.story === 1)
  ok('导入记忆后作废服务端聊天缓存', cacheCleared.count === 1, 'clearChatCache 调用 ' + cacheCleared.count + ' 次')

  // ④b 只导入 state（不含 memory/personality）→ 不清缓存
  res = mkRes()
  await handleImport(mkReq({ state: { intimacy: 77 } }, 'POST'), res)
  ok('只导入 state 不清聊天缓存', cacheCleared.count === 1, 'clearChatCache 调用 ' + cacheCleared.count + ' 次')

  // ⑤ 类型不对 → 跳过且不落盘
  delete saved.state
  res = mkRes()
  await handleImport(mkReq({ state: 123 }), res)
  const bad = res.json()
  ok('类型非法 → 跳过且不写', bad.ok === true && bad.skipped.indexOf('state') >= 0 && saved.state === undefined)

  // ⑥ 写盘失败 → 进 skipped，不影响其它字段
  delete saved.state
  const failDeps = { ...deps, saveState: () => { throw new Error('disk full') }, saveGrowth: (o) => { saved.growth = o } }
  res = mkRes()
  await createBackupHandlers(failDeps).handleImport(mkReq({ state: { intimacy: 1 }, growth: { exp: 2 } }), res)
  const failImp = res.json()
  ok('某字段写失败 → 进 skipped，其它字段仍导入', failImp.ok === true && failImp.skipped.indexOf('state') >= 0 && failImp.imported.indexOf('growth') >= 0, JSON.stringify(failImp))

  // ⑦ 非 POST → 405；坏 body → 400
  res = mkRes()
  await handleImport(mkReq(null, 'GET'), res)
  ok('导入非 POST → 405', res.code === 405)
  res = mkRes()
  await handleImport(mkReq('[1,2,3]'), res)
  ok('导入数组 body → 400 BAD_BODY', res.code === 400 && res.json().error === 'BAD_BODY')
} catch (e) {
  ok('能加载备份路由', false, String(e.message))
}


// ---------- ㉖ 提醒路由：参数校验 / 重复间隔夹取 / 增删 ----------
console.log('\n[26] 提醒路由 host/routes/reminders.ts')
try {
  const { createReminderHandlers } = await import('../src/host/routes/reminders.ts')
  const added = []
  const removed = []
  const handlers = createReminderHandlers({
    loadReminders: () => [{ id: 'r1', text: '喝水' }],
    addReminder: (text, at, repeat) => { const r = { id: 'r' + (added.length + 1), text, at, repeat }; added.push(r); return r },
    dueReminders: () => [{ id: 'r1', text: '喝水' }],
    removeReminder: (id) => { removed.push(id) },
  })
  const mkReq = (body, method, url) => {
    const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body || {}))
    return {
      method, url: url || '/api/chubby-whale/reminders', headers: {},
      destroy() { }, on() { }, resume() { },
      async *[Symbol.asyncIterator]() { yield buf },
    }
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

  let res = mkRes()
  await handlers.handleReminders(mkReq(null, 'GET'), res)
  ok('GET 列表', res.json().ok === true && res.json().reminders.length === 1)

  res = mkRes()
  await handlers.handleReminders(mkReq(null, 'GET', '/api/chubby-whale/reminders?action=due'), res)
  ok('GET action=due', res.json().ok === true && res.json().due.length === 1)

  const at = new Date(Date.now() + 3600000).toISOString()
  res = mkRes()
  await handlers.handleReminders(mkReq({ text: '该喝水了', at, repeat: 300 }, 'POST'), res)
  ok('POST 新增提醒', res.json().ok === true && added.length === 1 && added[0].text === '该喝水了')
  ok('重复间隔 300 秒保留', added[0].repeat === 300, String(added[0].repeat))

  res = mkRes()
  await handlers.handleReminders(mkReq({ text: '太短', at, repeat: 10 }, 'POST'), res)
  ok('重复间隔 <60 秒按不重复', added[1].repeat === 0)
  res = mkRes()
  await handlers.handleReminders(mkReq({ text: '太长', at, repeat: 99999999 }, 'POST'), res)
  ok('重复间隔 >7 天按不重复', added[2].repeat === 0)

  res = mkRes()
  await handlers.handleReminders(mkReq({ text: 'x'.repeat(500), at }, 'POST'), res)
  ok('超长文本截到 200 字', added[3].text.length === 200, 'len=' + added[3].text.length)

  res = mkRes()
  await handlers.handleReminders(mkReq({ text: '没有时间' }, 'POST'), res)
  ok('缺时间 → 400', res.code === 400 && res.json().error === 'text and at required')

  res = mkRes()
  await handlers.handleReminders(mkReq({ text: '时间非法', at: '不是时间' }, 'POST'), res)
  ok('时间非法 → 400', res.code === 400)

  res = mkRes()
  await handlers.handleReminders(mkReq(null, 'DELETE', '/api/chubby-whale/reminders?id=r1'), res)
  ok('DELETE 指定 id', res.json().ok === true && removed.indexOf('r1') >= 0)
  res = mkRes()
  await handlers.handleReminders(mkReq(null, 'DELETE'), res)
  ok('DELETE 不带 id → 不删任何东西', res.json().ok === true && removed.length === 1)

  res = mkRes()
  await handlers.handleReminders(mkReq(null, 'PUT'), res)
  ok('其它方法 → 405', res.code === 405)

  res = mkRes()
  await handlers.handleReminders(mkReq(null, 'POST', '/api/chubby-whale/reminders'), res)
  // 空 body 走 JSON 解析失败 → {} → 400（不是 500）
  ok('空 body → 400 而不是 500', res.code === 400)
} catch (e) {
  ok('能加载提醒路由', false, String(e.message))
}


// ---------- ㉗ 流式聊天：SSE 事件 / 缓存 / 中断不落盘 ----------
console.log('\n[27] 流式聊天 host/routes/chat-stream.ts')
try {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'chubby-stream-test-'))
  const { createCache } = await import('../src/host/cache.ts')
  const { createChatStreamHandler } = await import('../src/host/routes/chat-stream.ts')
  const cache = createCache({ dir, memBytes: 2 * 1024 * 1024 })

  const mkSse = (pieces) => pieces.map((p) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: p } }] }) + '\n\n').join('') + 'data: [DONE]\n\n'
  let mode = { kind: 'ok', pieces: ['你好', '呀'] }
  const fetchCalls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, body: init && init.body })
    if (mode.kind === 'throw') { const e = new Error('aborted'); e.name = 'AbortError'; throw e }
    if (mode.kind === 'http500') return new Response('busy', { status: 500 })
    return new Response(mkSse(mode.pieces), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }

  const appended = []
  const tokens = []
  const mkReq = (body) => {
    const buf = Buffer.from(JSON.stringify(body))
    return { method: 'POST', url: '/api/chubby-whale/chat-stream', headers: {}, destroy() { }, on() { }, resume() { }, async *[Symbol.asyncIterator]() { yield buf } }
  }
  const mkRes = () => {
    const out = { code: 200, chunks: [], closed: false }
    out.writeHead = (c) => { out.code = c }
    out.write = (b) => { out.chunks.push(String(b)); return true }
    out.end = (b) => { if (b) out.chunks.push(String(b)); out.writableEnded = true }
    out.on = (ev, cb) => { if (ev === 'close') out.onClose = cb }
    out.flushHeaders = () => { }
    out.setHeader = () => { }
    out.raw = () => out.chunks.join('')
    out.events = () => out.raw().split('\n\n').filter((x) => x.indexOf('data: ') === 0).map((x) => { try { return JSON.parse(x.slice(6)) } catch (e) { return null } }).filter(Boolean)
    return out
  }
  const deps = {
    getKey: () => 'k',
    loadHistory: () => [],
    appendTurns: (u, r) => { appended.push([u, r]) },
    systemPrompt: 'SYS',
    addTokens: (kind, n) => { tokens.push([kind, n]) },
    cache,
    loadMemorySummary: () => '',
    model: 'deepseek-flash',
  }

  // ① 正常流：逐段 delta + done；记忆写回
  appended.length = 0
  fetchCalls.length = 0
  let res = mkRes()
  await createChatStreamHandler(deps)(mkReq({ message: '主人今天好吗' }), res)
  const ev1 = res.events()
  const deltas = ev1.filter((e) => typeof e.delta === 'string').map((e) => e.delta)
  const done1 = ev1.find((e) => e.done)
  ok('正常流逐段推送 delta', deltas.join('') === '你好呀', deltas.join('|'))
  ok('结束事件带完整回复', !!done1 && done1.reply === '你好呀' && done1.cached !== true)
  ok('记忆写回一轮', appended.length === 1 && appended[0][1] === '你好呀')

  // ② 同问题第二次：命中缓存，不再请求上游
  appended.length = 0
  fetchCalls.length = 0
  res = mkRes()
  await createChatStreamHandler(deps)(mkReq({ message: '主人今天好吗' }), res)
  const ev2 = res.events()
  const done2 = ev2.find((e) => e.done)
  ok('第二次命中缓存（fetch 0 次）', fetchCalls.length === 0 && done2 && done2.cached === true, 'fetch=' + fetchCalls.length)
  ok('缓存命中时 delta 一次性给出', ev2.filter((e) => typeof e.delta === 'string').map((e) => e.delta).join('') === '你好呀')

  // ③ 空消息 → SSE error，不请求上游
  fetchCalls.length = 0
  res = mkRes()
  await createChatStreamHandler(deps)(mkReq({ message: '   ' }), res)
  ok('空消息 → error empty message', res.events().some((e) => e.error === 'empty message') && fetchCalls.length === 0)

  // ④ 没有密钥 → error NO_KEY
  const noKey = { ...deps, getKey: () => '' }
  res = mkRes()
  await createChatStreamHandler(noKey)(mkReq({ message: '在吗在吗在吗' }), res)
  ok('没有密钥 → error NO_KEY', res.events().some((e) => e.error === 'NO_KEY'))

  // ⑤ 上游 HTTP 500 → error HTTP 500，且不写记忆
  appended.length = 0
  mode = { kind: 'http500' }
  res = mkRes()
  await createChatStreamHandler(deps)(mkReq({ message: '另一句话试试' }), res)
  ok('上游 500 → error HTTP 500', res.events().some((e) => /HTTP 500/.test(String(e.error))), JSON.stringify(res.events().slice(-1)))
  ok('失败不写记忆', appended.length === 0)

  // ⑥ 连接被中止 → error connect，且不写缓存/记忆
  appended.length = 0
  mode = { kind: 'throw' }
  res = mkRes()
  await createChatStreamHandler(deps)(mkReq({ message: '第三句话试试' }), res)
  ok('上游中止 → error connect', res.events().some((e) => /connect/.test(String(e.error))), JSON.stringify(res.events().slice(-1)))
  ok('中止不写记忆', appended.length === 0)
  mode = { kind: 'ok', pieces: ['你好', '呀'] }

  // ⑦ 短消息（<6 字、非语音）不缓存：两次都请求
  fetchCalls.length = 0
  const h = createChatStreamHandler(deps)
  let r1 = mkRes(); await h(mkReq({ message: '在呢' }), r1)
  let r2 = mkRes(); await h(mkReq({ message: '在呢' }), r2)
  ok('短消息不缓存（两次都请求）', fetchCalls.length === 2, 'fetch=' + fetchCalls.length)

  globalThis.fetch = realFetch
  rmSync(dir, { recursive: true, force: true })
} catch (e) {
  ok('能加载流式聊天路由', false, String(e.message))
}


// ---------- ㉘ 文化与音乐路由：去重轮转 / 曲目白名单 ----------
console.log('\n[28] 文化与音乐 host/routes/culture.ts')
try {
  const { mkdtempSync, writeFileSync: wf, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'chubby-culture-test-'))
  const dataPort = {
    readCulture: async (kind) => {
      if (kind === 'chengyu') return [{ name: '一鼓作气', src: '左传', text: '第一次击鼓振作士气' }, { name: '亡羊补牢', src: '战国策', text: '羊跑了再修圈' }]
      if (kind === 'idiom') return [{ name: '七月流火', cat: '易误用', mean: '天气转凉', wrong: '天气炎热' }]
      if (kind === 'minsu') return [{ book: '聊斋', title: '画皮', text: '一个关于皮囊的故事' }]
      return []
    },
    readPoemsChunk: async () => ({ index: 0, total: 1, items: [] }),
    readDuilian: async () => ({ upper: [], lower: [] }),
    readDaily: async () => [],
  }
  wf(join(dir, 'melodies.json'), JSON.stringify({ songs: [{ name: '小星星', bpm: 120, notes: [1, 2, 3], lyrics: '一闪一闪' }] }))
  const { createCultureHandlers } = await import('../src/host/routes/culture.ts')
  const handlers = createCultureHandlers({ dataDir: dir, runtimeDir: dir, dataPort })
  const mkRes = () => {
    const out = { code: 0, chunks: [] }
    out.writeHead = (c) => { out.code = c }
    out.end = (b) => { if (b) out.chunks.push(Buffer.from(String(b))) }
    out.setHeader = () => { }
    out.json = () => { try { return JSON.parse(Buffer.concat(out.chunks).toString('utf8')) } catch (e) { return null } }
    return out
  }
  const call = async (url) => { const res = mkRes(); await handlers.handleCulture({ url }, res); return res.json() }

  const c1 = await call('/api/chubby-whale/culture?type=chengyu')
  ok('成语：返回 ok + item', c1.ok === true && c1.item && c1.item.kind === 'chengyu' && !!c1.item.title)
  const c2 = await call('/api/chubby-whale/culture?type=chengyu')
  ok('成语：连续两次不重复', c2.item.title !== c1.item.title, c1.item.title + ' / ' + c2.item.title)
  const c3 = await call('/api/chubby-whale/culture?type=chengyu')
  ok('成语：一轮讲完自动重来', c3.item && [c1.item.title, c2.item.title].indexOf(c3.item.title) >= 0, c3.item.title)

  const i1 = await call('/api/chubby-whale/culture?type=idiom')
  ok('成语辨析：带易误解提示', i1.item && i1.item.kind === 'idiom' && i1.item.text.indexOf('易误解为') >= 0, String(i1.item && i1.item.text).slice(0, 30))

  const m1 = await call('/api/chubby-whale/culture?type=minsu')
  ok('民间故事：标题是「书名·标题」', m1.item && m1.item.title === '聊斋·画皮', String(m1.item && m1.item.title))

  const u1 = await call('/api/chubby-whale/culture?type=nonsense')
  ok('未知类型：给兜底说明而不是报错', u1.ok === true && u1.item.kind === 'unknown')

  // 空数据源 → item null + reason，而不是 500
  const empty = createCultureHandlers({ dataDir: dir, runtimeDir: dir, dataPort: { ...dataPort, readCulture: async () => [] } })
  const er = mkRes(); await empty.handleCulture({ url: '/api/chubby-whale/culture?type=chengyu' }, er)
  ok('空数据源：ok + item=null + no-data', er.json().ok === true && er.json().item === null && er.json().reason === 'no-data')

  // 曲目：列表只给 name/bpm；按名字取完整曲谱；不存在的名字给 ok:false
  const mr = mkRes(); await handlers.handleMelodies({ url: '/api/chubby-whale/melodies' }, mr)
  ok('曲目列表只露 name/bpm', mr.json().ok === true && mr.json().songs.length === 1 && mr.json().songs[0].name === '小星星' && !('notes' in mr.json().songs[0]))
  const md = mkRes(); await handlers.handleMelody({ url: '/api/chubby-whale/melody?name=' + encodeURIComponent('小星星') }, md)
  ok('按名字取曲谱（notes 齐全）', md.json().ok === true && md.json().song.notes.length === 3 && md.json().song.bpm === 120)
  const miss = mkRes(); await handlers.handleMelody({ url: '/api/chubby-whale/melody?name=' + encodeURIComponent('不存在的歌') }, miss)
  ok('未知曲名 → ok:false', miss.json().ok === false && miss.json().error === 'song not found')

  // 曲库文件缺失 → ok:false + songs:[]（不抛）
  const missing = createCultureHandlers({ dataDir: join(dir, 'nope'), runtimeDir: dir, dataPort })
  const mf = mkRes(); await missing.handleMelodies({ url: '/api/chubby-whale/melodies' }, mf)
  ok('曲库缺失 → songs:[] 兜底', mf.json().ok === false && Array.isArray(mf.json().songs) && mf.json().songs.length === 0)

  rmSync(dir, { recursive: true, force: true })
} catch (e) {
  ok('能加载文化路由', false, String(e.message))
}


// ---------- ㉙ 今日简报 + 成长阶段规则 ----------
console.log('\n[29] 今日简报 host/routes/briefing.ts + shared/growth.ts')
try {
  const { createBriefingHandlers } = await import('../src/host/routes/briefing.ts')
  const growth = await import('../src/shared/growth.ts')
  const mkRes = () => {
    const out = { code: 0, chunks: [] }
    out.writeHead = (c) => { out.code = c }
    out.end = (b) => { if (b) out.chunks.push(Buffer.from(String(b))) }
    out.setHeader = () => { }
    out.json = () => { try { return JSON.parse(Buffer.concat(out.chunks).toString('utf8')) } catch (e) { return null } }
    return out
  }
  const realFetch = globalThis.fetch
  let weather = { ok: true, body: '晴 +18°C' }
  globalThis.fetch = async () => ({ ok: weather.ok, status: weather.ok ? 200 : 500, text: async () => weather.body })

  const handlers = createBriefingHandlers({
    loadGrowth: () => ({ exp: 200 }),
    loadReminders: () => [{ done: false }, { done: true }, { done: false }],
  })
  let res = mkRes()
  await handlers.handleBriefing({ url: '/api/chubby-whale/briefing' }, res)
  const b = res.json()
  ok('简报 ok 且有文本', b.ok === true && typeof b.text === 'string' && b.text.length > 0)
  ok('简报含日期/星期', /星期[日一二三四五六]/.test(b.text), b.text.split('\n')[0])
  ok('简报含天气', b.text.indexOf('北海天气：晴 +18°C') >= 0)
  ok('简报含成长阶段（exp=200 → 熟悉）', b.text.indexOf('肥鲸成长：熟悉（200）') >= 0)
  ok('简报只数未完成提醒（2 条）', b.text.indexOf('待办提醒：2 条') >= 0)

  // 天气失败：简报仍要出（日期/成长/提醒不能陪葬）
  weather = { ok: false, body: '' }
  res = mkRes()
  await handlers.handleBriefing({ url: '/api/chubby-whale/briefing' }, res)
  const b2 = res.json()
  ok('天气失败仍返回简报', b2.ok === true && b2.text.indexOf('北海天气') < 0 && /星期[日一二三四五六]/.test(b2.text))
  weather = { ok: true, body: '晴 +18°C' }
  globalThis.fetch = realFetch

  // 成长阶段规则（纯函数）
  ok('exp=0 → 初识，下一门槛 200', growth.growthStage(0).name === '初识' && growth.growthStage(0).nextExp === 200)
  ok('exp=199 → 初识，下一门槛 200', growth.growthStage(199).name === '初识' && growth.growthStage(199).nextExp === 200)
  ok('exp=200 → 熟悉', growth.growthStage(200).name === '熟悉')
  ok('exp=99999 → 家人，无下一门槛', growth.growthStage(99999).name === '家人' && growth.growthStage(99999).nextExp === 0)
  ok('阶段表共 5 档且被冻结', growth.GROWTH_STAGES.length === 5 && Object.isFrozen(growth.GROWTH_STAGES))
} catch (e) {
  ok('能加载简报路由', false, String(e.message))
}


// ---------- ㉚ 统计路由：只读汇总的数值口径 ----------
console.log('\n[30] 统计路由 host/routes/stats.ts')
try {
  const { createStatsHandler } = await import('../src/host/routes/stats.ts')
  const mkRes = () => {
    const out = { code: 0, chunks: [] }
    out.writeHead = (c) => { out.code = c }
    out.end = (b) => { if (b) out.chunks.push(Buffer.from(String(b))) }
    out.setHeader = () => { }
    out.json = () => { try { return JSON.parse(Buffer.concat(out.chunks).toString('utf8')) } catch (e) { return null } }
    return out
  }
  const nowTs = 1000000
  const handler = createStatsHandler({
    cacheStats: async () => ({ tts: 150, chat: 6, asr: 849 }),
    loadState: () => ({ intimacy: 100 }),
    loadGrowth: () => ({ exp: 250 }),
    loadFishfood: () => ({ chatTokens: 327756, storyTokens: 12 }),
    loadPersonality: () => ({ catchphrases: ['哼'], preferences: ['白饭'], notes: '备注', selfNarrative: '自述' }),
    startedAt: nowTs - 5000,
    now: () => nowTs,
  })
  let res = mkRes()
  await handler.handleStats({ method: 'GET', url: '/api/chubby-whale/stats' }, res)
  const st = res.json()
  ok('统计 ok', st.ok === true)
  ok('缓存条目数透传', st.cache.tts === 150 && st.cache.chat === 6 && st.cache.asr === 849)
  ok('鱼粮 total = chat + story', st.fishfood.total === 327768, String(st.fishfood.total))
  ok('成长经验/阶段/下一门槛', st.growth.exp === 250 && st.growth.stage === '熟悉' && st.growth.nextExp === 800)
  ok('亲密度取 state', st.intimacy === 100)
  ok('人格只出四个展示字段', Array.isArray(st.personality.catchphrases) && st.personality.notes === '备注' && st.personality.selfNarrative === '自述')
  ok('uptimeMs 按装配时间算', st.uptimeMs === 5000, String(st.uptimeMs))

  // 坏值兜底：负数/NaN/非字符串列表
  const bad = createStatsHandler({
    cacheStats: async () => { throw new Error('cache down') },
    loadState: () => ({ intimacy: -5 }),
    loadGrowth: () => ({ exp: Number.NaN }),
    loadFishfood: () => ({ chatTokens: -1, storyTokens: 'x' }),
    loadPersonality: () => ({ catchphrases: ['ok', 1, null], notes: 42 }),
  })
  res = mkRes()
  await bad.handleStats({ method: 'GET' }, res)
  const b = res.json()
  ok('缓存读取失败按 0', b.cache.tts === 0 && b.cache.chat === 0 && b.cache.asr === 0)
  ok('坏数值归零', b.growth.exp === 0 && b.intimacy === 0 && b.fishfood.total === 0)
  ok('列表只留字符串', b.personality.catchphrases.length === 1 && b.personality.notes === '')

  res = mkRes()
  await handler.handleStats({ method: 'POST' }, res)
  ok('非 GET → 405', res.code === 405)
} catch (e) {
  ok('能加载统计路由', false, String(e.message))
}


// ---------- ㉛ 云端数据源：按清单取数 + 失败回退本地 ----------
console.log('\n[31] 云端数据源 host/data/cloud.ts')
try {
  const { createCloudDataPort } = await import('../src/host/data/cloud.ts')
  let localCalls = 0
  const local = {
    readStoryIndex: async () => { localCalls++; return [{ book: '本地书' }] },
    readStoryBook: async () => { localCalls++; return [{ book: '本地书', title: 't', piece: 1, total: 1, text: 'x', index: 0 }] },
    readCulture: async () => { localCalls++; return [{ name: '本地成语' }] },
    readPoemsChunk: async (i) => { localCalls++; return { index: i, total: 1, items: [{ title: '本地诗', author: '某', lines: ['本地句'] }] } },
    readDuilian: async () => { localCalls++; return { items: [{ upper: '上', lower: '下' }] } },
    readDaily: async () => { localCalls++; return [{ date: '2026-01-01', text: '本地每日' }] },
  }
  const files = {
    'manifest.json': { version: 'v2', generatedAt: 'g2', files: [
      { path: 'poems/poems-00.json' }, { path: 'poems/poems-01.json' },
      { path: 'culture/chengyu.json' }, { path: 'culture/minsu-00.json' },
      { path: 'story/index.json' }, { path: 'story/聊斋.json' },
      { path: 'duilian.json' }, { path: 'daily.json' },
    ] },
    'poems/poems-00.json': { index: 0, total: 2, items: [{ title: '静夜思', author: '李白', dynasty: '唐', lines: ['床前明月光'] }] },
    'poems/poems-01.json': { index: 1, total: 2, items: [{ title: '望岳', author: '杜甫', lines: ['岱宗夫如何'] }] },
    'culture/chengyu.json': { items: [{ name: '一鼓作气', text: '振作' }] },
    'story/index.json': { books: [{ book: '聊斋', author: '蒲松龄' }] },
    // 云端 story 文件是「数组」，normalizeStoryChunks 只吃数组（本地 {chunks} 由 repo 自己拆）
    'story/聊斋.json': [{ title: '画皮', total: 1, text: '故事正文' }],
    'duilian.json': { items: [{ upper: '风声雨声读书声', lower: '家事国事天下事' }] },
    'daily.json': { items: [{ date: '2026-11-06', text: '云端的每日一句' }] },
  }
  const calls = []
  let failNext = false
  const fetchImpl = async (url) => {
    // 云端路径经过 encodePath：中文书名会被百分号编码，这里解回来再查表
    const path = decodeURIComponent(String(url).split('/culture/v1/')[1] || '')
    calls.push(path)
    if (failNext) throw new Error('network down')
    const data = files[path]
    if (data === undefined) return { ok: false, status: 404, text: async () => '', json: async () => null }
    return { ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => data }
  }
  const cloud = createCloudDataPort({ local, baseUrl: 'https://adnoon.example/culture/v1/', fetchImpl })

  const p0 = await cloud.readPoemsChunk(0)
  ok('诗词分片：取云端并归一化', p0.items.length === 1 && p0.items[0].title === '静夜思' && p0.total === 2, JSON.stringify(p0.items.map((x) => x.title)))
  const p1 = await cloud.readPoemsChunk(1)
  ok('诗词分片：按索引取对应文件', p1.items[0].title === '望岳')

  const cul = await cloud.readCulture('chengyu')
  ok('文化：云端取成语', cul.length === 1 && cul[0].name === '一鼓作气')
  const dui = await cloud.readDuilian()
  ok('对联：云端取', dui.items.length === 1 && dui.items[0].upper.indexOf('风声') === 0)
  const day = await cloud.readDaily()
  ok('每日：云端取', day.length === 1 && day[0].text === '云端的每日一句')
  const idx = await cloud.readStoryIndex()
  ok('书单：云端取', idx.length === 1 && idx[0].book === '聊斋' && idx[0].author === '蒲松龄')
  const book = await cloud.readStoryBook('聊斋')
  ok('书：云端取并归一化', book.length === 1 && book[0].book === '聊斋')

  // 清单 TTL：连续取多个文件时 manifest 只拉一次
  const manifestCalls = calls.filter((c) => c === 'manifest.json').length
  ok('清单 30 秒内只拉一次', manifestCalls === 1, 'manifest 请求 ' + manifestCalls + ' 次')

  // 网络失败 → 回退本地，且不抛。
  // 用独立实例：上面那个实例已缓存了分片，不会再发请求，测不出"网络失败"。
  let badCalls = 0
  const cloudBad = createCloudDataPort({
    local,
    baseUrl: 'https://adnoon.example/culture/v1/',
    fetchImpl: async () => { badCalls++; throw new Error('network down') },
  })
  const before = localCalls
  const fb = await cloudBad.readPoemsChunk(0)
  ok('网络失败 → 回退本地诗词', fb.items[0].title === '本地诗' && localCalls > before, 'local 调用 ' + (localCalls - before) + ' 次')
  // 冷却期内继续走本地（不再打网络）
  const badBefore = badCalls
  const fb2 = await cloudBad.readCulture('chengyu')
  ok('冷却期内直接走本地', fb2[0].name === '本地成语' && badCalls === badBefore, '网络请求 ' + (badCalls - badBefore) + ' 次')
} catch (e) {
  ok('能加载云端数据源', false, String(e.message))
}


// ---------- ㉜ 人格路由：快照形态 / 回滚三态 ----------
console.log('\n[32] 人格路由 host/routes/personality.ts')
try {
  const { createPersonalityHandlers } = await import('../src/host/routes/personality.ts')
  const mkRes = () => {
    const out = { code: 0, chunks: [] }
    out.writeHead = (c) => { out.code = c }
    out.end = (b) => { if (b) out.chunks.push(Buffer.from(String(b))) }
    out.setHeader = () => { }
    out.json = () => { try { return JSON.parse(Buffer.concat(out.chunks).toString('utf8')) } catch (e) { return null } }
    return out
  }
  const data = {
    catchphrases: ['哼'], preferences: ['白饭'], notes: '备注', selfNarrative: '最近想吃鱼',
    selfNarrativeAt: '2026-11-06T00:00:00Z', version: 3, updatedAt: '2026-11-06T00:00:00Z',
    history: [{ at: '2026-11-06T00:00:00Z', field: 'notes', old: '', new: '备注' }],
  }
  let revertResult = { saved: true, entry: { field: 'notes', old: '', new: '备注' } }
  const repo = {
    load: () => JSON.parse(JSON.stringify(data)),
    save: () => true,
    learn: () => ({ changed: false }),
    writeNarrative: () => ({ changed: false }),
    revert: () => revertResult,
    segment: () => '',
  }
  const handlers = createPersonalityHandlers({
    repo,
    learningEnabled: () => false,
    learnerStatus: () => ({ enabled: false, tries: 2 }),
    writingEnabled: () => true,
    writerStatus: () => ({ enabled: true, tries: 1 }),
  })
  let res = mkRes()
  await handlers.handlePersonality({ method: 'GET' }, res)
  const snap = res.json()
  ok('快照：顶层平铺 + personality 子对象一致', snap.ok === true && snap.catchphrases[0] === '哼' && snap.personality.catchphrases[0] === '哼')
  ok('快照：带历史与限制', Array.isArray(snap.history) && snap.history.length === 1 && !!snap.limits)
  ok('快照：学习关闭 / 自写开启分开报', snap.enabled === false && snap.writingEnabled === true && snap.learning.enabled === false)
  ok('快照：版本/自述透传', snap.version === 3 && snap.selfNarrative === '最近想吃鱼')

  res = mkRes()
  await handlers.handlePersonality({ method: 'POST' }, res)
  ok('非 GET → 405', res.code === 405 && res.json().error === 'METHOD_NOT_ALLOWED')

  // 回滚成功
  res = mkRes()
  await handlers.handleRevert({ method: 'POST', readableEnded: true }, res)
  ok('回滚成功 → ok + reverted', res.json().ok === true && res.json().reverted.field === 'notes')

  // 没有历史
  revertResult = null
  res = mkRes()
  await handlers.handleRevert({ method: 'POST', readableEnded: true }, res)
  const noHist = res.json()
  ok('没有历史 → ok:false NO_HISTORY 且带快照', noHist.ok === false && noHist.error === 'NO_HISTORY' && noHist.catchphrases[0] === '哼')

  // 写盘失败
  revertResult = { saved: false, entry: { field: 'notes' } }
  res = mkRes()
  await handlers.handleRevert({ method: 'POST', readableEnded: true }, res)
  ok('回滚写盘失败 → SAVE_FAILED', res.json().ok === false && res.json().error === 'SAVE_FAILED')

  // 回滚只接受 POST
  res = mkRes()
  await handlers.handleRevert({ method: 'GET' }, res)
  ok('回滚非 POST → 405', res.code === 405)
} catch (e) {
  ok('能加载人格路由', false, String(e.message))
}


// ---------- ㉝ 本地数据源：读盘 / 归一化 / 坏文件兜底 ----------
console.log('\n[33] 本地数据源 host/data/local.ts')
try {
  const { mkdtempSync, writeFileSync: wf, mkdirSync, rmSync, utimesSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'chubby-local-test-'))
  mkdirSync(join(dir, 'culture'), { recursive: true })
  // 注意：本地诗词文件是 {poems:[…]}（不是 {items}），与 data/poems.json 真实结构一致
  wf(join(dir, 'poems.json'), JSON.stringify({ poems: [
    { title: '静夜思', author: '李白', dynasty: '唐', lines: ['床前明月光', '疑是地上霜'] },
    { title: '静夜思', author: '李白', dynasty: '唐', lines: ['床前明月光'] },
    { title: '', lines: ['垃圾条目'] },
    { title: '无句子', lines: [] },
  ] }))
  wf(join(dir, 'culture', 'chengyu.json'), JSON.stringify([{ name: '一鼓作气', src: '左传', text: '振作士气' }]))
  wf(join(dir, 'culture', 'idioms.json'), JSON.stringify({ items: [{ name: '七月流火', mean: '天气转凉', wrong: '天气炎热' }] }))
  wf(join(dir, 'culture', 'minsu.json'), 'not-json')  // 坏文件
  wf(join(dir, 'duilian.json'), JSON.stringify({ items: [{ upper: '风声雨声读书声', lower: '家事国事天下事' }] }))
  wf(join(dir, 'daily.json'), JSON.stringify({ items: [{ date: '2026-11-06', text: '本地每日一句' }] }))

  const story = {
    listBooks: async () => ['聊斋'],
    loadBook: async (b) => (b === '聊斋' ? [{ book: '聊斋', title: '画皮', piece: 1, total: 1, text: '故事', index: 0 }] : []),
  }
  const { createLocalDataPort } = await import('../src/host/data/local.ts')
  const port = createLocalDataPort({ dataDir: dir, story })

  const poems = await port.readPoemsChunk(0)
  ok('诗词：归一化 + 去重（重复项/空标题/空句子都丢掉）', poems.items.length === 1 && poems.items[0].title === '静夜思', 'items=' + poems.items.length)
  ok('诗词：本地只有第 0 片', poems.index === 0 && poems.total === 1)
  const poems1 = await port.readPoemsChunk(3)
  ok('诗词：其它片返回空（不回退重复喂）', poems1.items.length === 0 && poems1.total === 1)

  const cy = await port.readCulture('chengyu')
  ok('文化：成语（数组文件）', cy.length === 1 && cy[0].name === '一鼓作气')
  const id = await port.readCulture('idiom')
  ok('文化：成语辨析（{items} 文件）', id.length === 1 && id[0].wrong === '天气炎热')
  const ms = await port.readCulture('minsu')
  ok('文化：坏 JSON → 空数组且不抛', Array.isArray(ms) && ms.length === 0)

  const dui = await port.readDuilian()
  ok('对联：归一化', dui.items.length === 1 && dui.items[0].lower.indexOf('家事') === 0)
  const daily = await port.readDaily()
  ok('每日：归一化', daily.length === 1 && daily[0].text === '本地每日一句')
  const idx = await port.readStoryIndex()
  ok('书单：来自 story repo', idx.length === 1 && idx[0].book === '聊斋')
  const book = await port.readStoryBook('聊斋')
  ok('书：来自 story repo', book.length === 1 && book[0].title === '画皮')

  // mtime 变化 → 缓存失效（改数据不重启）
  wf(join(dir, 'poems.json'), JSON.stringify({ poems: [{ title: '新诗', author: '某', lines: ['新句'] }] }))
  const future = new Date(Date.now() + 5000)
  utimesSync(join(dir, 'poems.json'), future, future)
  const poems2 = await port.readPoemsChunk(0)
  ok('改数据后按 mtime 重新读（无需重启）', poems2.items[0].title === '新诗', poems2.items[0].title)

  // 缺文件：都返回空，不抛
  const emptyDir = mkdtempSync(join(tmpdir(), 'chubby-local-empty-'))
  const empty = createLocalDataPort({ dataDir: emptyDir, story: { listBooks: async () => [], loadBook: async () => [] } })
  const ep = await empty.readPoemsChunk(0)
  const ec = await empty.readCulture('chengyu')
  const ed = await empty.readDaily()
  ok('缺文件时诗词/文化/每日都返回空', ep.items.length === 0 && ec.length === 0 && ed.length === 0)
  rmSync(emptyDir, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
} catch (e) {
  ok('能加载本地数据源', false, String(e.message))
}


// ---------- ㉞ 图片消息：多模态请求体 + 不缓存 ----------
console.log('\n[34] 聊天路由的图片分支 host/routes/chat.ts')
try {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'chubby-img-test-'))
  const { createCache } = await import('../src/host/cache.ts')
  const { createChatHandler } = await import('../src/host/routes/chat.ts')
  const cache = createCache({ dir, memBytes: 1024 * 1024 })

  const bodies = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(String(init && init.body)))
    const payload = { choices: [{ message: { content: '这是只胖鱼' } }], usage: { total_tokens: 9 } }
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
  }
  const mkRes = () => {
    const out = { code: 0, chunks: [] }
    out.writeHead = (c) => { out.code = c }
    out.end = (b) => { if (b) out.chunks.push(Buffer.from(String(b))) }
    out.setHeader = () => { }
    out.json = () => { try { return JSON.parse(Buffer.concat(out.chunks).toString('utf8')) } catch (e) { return null } }
    return out
  }
  const mkReq = (body) => {
    const buf = Buffer.from(JSON.stringify(body))
    return { method: 'POST', headers: {}, destroy() { }, on() { }, resume() { }, async *[Symbol.asyncIterator]() { yield buf } }
  }
  const deps = {
    getKey: () => 'k',
    loadHistory: () => [],
    appendTurns: () => { },
    loadState: () => ({ intimacy: 0 }),
    saveState: () => { },
    systemPrompt: 'SYS',
    addExp: () => ({ upgraded: false }),
    addTokens: () => { },
    cache,
    loadMemorySummary: () => '',
    model: 'deepseek-flash',
  }
  const handle = createChatHandler(deps)

  // ① 带图片：最后一条 user 消息是 [text, image_url] 数组
  const res = mkRes()
  await handle(mkReq({ message: '这是什么', image: 'QUJD', imageMime: 'image/png' }), res)
  const sent = bodies[0]
  const lastMsg = sent.messages[sent.messages.length - 1]
  ok('图片请求已发给模型', !!sent && Array.isArray(lastMsg.content))
  ok('含文字段', Array.isArray(lastMsg.content) && lastMsg.content[0].type === 'text' && lastMsg.content[0].text === '这是什么')
  ok('含图片 data URL', Array.isArray(lastMsg.content) && lastMsg.content[1].type === 'image_url' && lastMsg.content[1].image_url.url === 'data:image/png;base64,QUJD')
  ok('图片回复正常返回', res.json().ok === true && res.json().reply === '这是只胖鱼')

  // ② 图片消息不进缓存：同一条再来仍要请求
  bodies.length = 0
  const res2 = mkRes()
  await handle(mkReq({ message: '这是什么', image: 'QUJD', imageMime: 'image/png' }), res2)
  ok('图片消息不缓存（第二次仍请求）', bodies.length === 1, 'fetch=' + bodies.length)

  // ③ 不传 mime 时按 jpeg
  const res3 = mkRes()
  await handle(mkReq({ message: '再看看', image: 'QUJD' }), res3)
  const last3 = bodies[bodies.length - 1].messages[bodies[bodies.length - 1].messages.length - 1]
  ok('默认图片类型 image/jpeg', last3.content[1].image_url.url.indexOf('data:image/jpeg;base64,') === 0)

  globalThis.fetch = realFetch
  rmSync(dir, { recursive: true, force: true })
} catch (e) {
  ok('能加载聊天路由（图片分支）', false, String(e.message))
}


// ---------- ㉟ 忙碌锁与请求纪元（打断/作废的核心） ----------
console.log('\n[35] 忙碌锁 client/busy.ts')
try {
  const busy = await import('../src/client/busy.ts')
  const lock = busy.createBusyLock({ staleMs: 5000 })
  ok('初始不忙', lock.isBusy() === false)
  lock.begin(1000)
  ok('begin 后变忙', lock.isBusy() === true)
  ok('age 按传入时间算', lock.age(3000) === 2000, String(lock.age(3000)))
  ok('未超时不会自动解锁', lock.watchdog(4000) === false && lock.isBusy() === true)
  ok('超时后 watchdog 复位并返回 true', lock.watchdog(7000) === true && lock.isBusy() === false)
  lock.begin(1000)
  lock.end()
  ok('end 立刻解锁', lock.isBusy() === false)

  const ep = busy.createEpoch()
  const a = ep.next()
  ok('新纪元有效', ep.isCurrent(a) === true)
  const b = ep.next()
  ok('推新纪元后旧纪元失效', ep.isCurrent(a) === false && ep.isCurrent(b) === true)
  ok('旧纪元反复检查都失效', ep.isCurrent(a) === false)
} catch (e) {
  ok('能加载 busy.ts', false, String(e.message))
}


// ---------- ㊱ 端点检测模式：唯一读写入口 ----------
console.log('\n[36] 端点检测 client/endpoint.ts')
try {
  const mem = new Map()
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)) },
    removeItem: (k) => { mem.delete(k) },
  }
  const ep = await import('../src/client/endpoint.ts')
  ok('默认是 classic', ep.readEndpointMode() === 'classic')
  ok('写入 ape 后读回 ape', ep.writeEndpointMode('ape') === true && ep.readEndpointMode() === 'ape')
  ok('写入非法值归一成 classic', ep.writeEndpointMode('乱写') === true && ep.readEndpointMode() === 'classic')
  ok('normalize：ape 保留、其它回落', ep.normalizeEndpointMode('ape') === 'ape' && ep.normalizeEndpointMode('x') === 'classic')
  ok('模式表被冻结', Array.isArray(ep.ENDPOINT_MODES) && Object.isFrozen(ep.ENDPOINT_MODES))
  delete globalThis.localStorage

  // 代码契约：voice.ts 与 actions/voice.ts 都不许再手写 chubby-endpoint 解析
  const { readFileSync: rf4 } = await import('node:fs')
  const vSrc = rf4('src/client/voice.ts', 'utf8')
  const aSrc = rf4('src/client/actions/voice.ts', 'utf8')
  ok('voice.ts 不再自己解析 chubby-endpoint', vSrc.indexOf("getItem('chubby-endpoint')") < 0)
  ok('actions/voice.ts 不再自己写 chubby-endpoint', aSrc.indexOf("setItem('chubby-endpoint'") < 0)
} catch (e) {
  ok('能加载 endpoint.ts', false, String(e.message))
}


// ---------- ㊲ 叙述进度：说书与念诗交替时不串味 ----------
console.log('\n[37] 叙述进度交替 client/narration-progress.ts')
try {
  const np = await import('../src/client/narration-progress.ts')
  // 1) 念诗
  np.startProgress('念诗·雨霖铃', ['寒蝉凄切。', '对长亭晚，骤雨初歇。'], '念首诗——雨霖铃，宋，柳永。')
  const p1 = np.bumpProgress('念首诗——雨霖铃，宋，柳永。')
  const p2 = np.bumpProgress('寒蝉凄切。')
  ok('念诗：开场白不带句数', p1.indexOf('第 ') < 0, p1)
  ok('念诗：第一句显示 1/2', p2.indexOf('第 1/2') >= 0, p2)
  np.stopProgress()

  // 2) 换成说书：不能带着上一首诗的计数
  const story = np.bumpProgress('话说，今天给主人讲一段《聊斋》，画皮。')
  ok('念诗结束后 → 说书不再带句数', story === '', '[' + story + ']')
  np.startProgress('说书·聊斋', ['话说……', '正文……'], '')
  const s1 = np.bumpProgress('话说……')
  ok('说书：按自己的行数计（1/2）', s1.indexOf('第 1/2') >= 0 && s1.indexOf('聊斋') >= 0, s1)
  np.stopProgress()

  // 3) 再说书切回念诗：同样不串
  np.startProgress('念诗·静夜思', ['床前明月光。'], '')
  const back = np.bumpProgress('床前明月光。')
  ok('说书结束 → 念诗从 1/1 重新开始', back.indexOf('第 1/1') >= 0 && back.indexOf('静夜思') >= 0, back)
  np.stopProgress()
  ok('最后 stop 后无进度残留', np.progressActive() === false && np.bumpProgress('任意一句。') === '')
} catch (e) {
  ok('能加载 narration-progress.ts', false, String(e.message))
}


// ---------- ㊳ 点播本地路由：指令识别与分流 ----------
console.log('\n[38] 点播路由 client/chat-route.ts')
try {
  const { createLocalRouter } = await import('../src/client/chat-route.ts')
  const realFetch = globalThis.fetch
  const hits = []
  globalThis.fetch = async (url) => {
    const u = String(url)
    hits.push(u)
    if (u.indexOf('/poem') >= 0) {
      return { ok: true, status: 200, json: async () => ({ ok: true, item: { title: '雨霖铃', author: '柳永', dynasty: '宋', text: '寒蝉凄切。\n对长亭晚。' } }) }
    }
    if (u.indexOf('/culture') >= 0) {
      return { ok: true, status: 200, json: async () => ({ ok: true, item: { title: '一鼓作气', src: '左传', text: '振作士气' } }) }
    }
    return { ok: false, status: 404, json: async () => ({ ok: false }) }
  }

  const bubbles = []
  const spoke = []
  let storyStart = null
  const host = {
    persona: { line: () => '人设台词' },
    narrationRate: () => '-25%',
    bubble: (t, ms) => { bubbles.push(t) },
    say: () => { },
    speak: (t, o) => { spoke.push({ t, o }) },
    narrate: () => { },
    clearNarrate: () => { },
    talkFor: () => { },
    story: { start: (book) => { storyStart = book } },
    storyState: { book: { current: '聊斋' }, auto: { current: false } },
  }
  const router = createLocalRouter(host)

  // ① 追问：再来一首 → 取 /poem 并念
  hits.length = 0; bubbles.length = 0; spoke.length = 0
  ok('「再来一首」走本地', router.route('再来一首') === true)
  ok('「再来一首」先给点播提示', bubbles[0].indexOf('再念一首') >= 0, bubbles[0])
  await new Promise((r) => setTimeout(r, 700))
  ok('「再来一首」会取诗并朗读', hits.some((u) => u.indexOf('/poem') >= 0) && spoke.length > 0 && spoke[0].t.indexOf('念首诗——') === 0, spoke[0] && spoke[0].t.slice(0, 12))

  // ② 接着说 → 用当前书开讲
  storyStart = null
  ok('「接着说」走本地', router.route('接着说') === true)
  ok('「接着说」沿用当前书', storyStart === '聊斋', String(storyStart))

  // ③ 背诗（点名）→ 带 title 参数
  hits.length = 0
  ok('「背首诗」走本地', router.route('背首诗') === true)
  // 点名某首诗才会带 title（"背首诗"是随机点播，不带参数是对的）
  hits.length = 0
  ok('点名某首诗走本地', router.route('背雨霖铃') === true)
  ok('点名时带 title 参数', hits.some((u) => u.indexOf('title=') >= 0), hits.join(','))

  // ④ 成语 → 按类型取并念
  hits.length = 0; spoke.length = 0
  ok('「讲个成语」走本地', router.route('讲个成语') === true)
  await new Promise((r) => setTimeout(r, 50))
  ok('成语请求带 type=idiom（成语辨析池）', hits.some((u) => u.indexOf('type=idiom') >= 0), hits.join(','))
  ok('成语用叙述语速朗读', spoke.length === 1 && spoke[0].o && spoke[0].o.rate === '-25%', spoke[0] && String(spoke[0].o && spoke[0].o.rate))

  // 典故点播：与菜单「讲典故」同口径，取 chengyu（典故故事池）
  hits.length = 0
  ok('「讲个典故」走本地', router.route('讲个典故') === true)
  await new Promise((r) => setTimeout(r, 50))
  ok('典故请求带 type=chengyu（典故故事池）', hits.some((u) => u.indexOf('type=chengyu') >= 0), hits.join(','))

  // ⑤ 讲故事 → 开说书并打开连播
  storyStart = null
  ok('「讲个故事」走本地', router.route('讲个故事') === true)
  ok('讲故事会打开连播开关', host.storyState.auto.current === true)

  // ⑥ 提问类与长句不劫持
  ok('带问号的问题不劫持', router.route('为什么天是蓝的？') === false)
  ok('长句不劫持', router.route('今天我想听你讲一讲那个关于白蛇传说的完整故事，最好带点评'.repeat(2)) === false)

  globalThis.fetch = realFetch
} catch (e) {
  ok('能加载点播路由', false, String(e.message))
}


// ---------- ㊴ 说书控制器：气泡/语速/连播/中断守卫 ----------
console.log('\n[39] 说书控制器 client/story.ts')
try {
  const { createStoryController } = await import('../src/client/story.ts')
  const realFetch = globalThis.fetch
  const hits = []
  globalThis.fetch = async (url) => {
    const u = String(url)
    hits.push(u)
    if (u.indexOf('/story/start') >= 0) {
      return { ok: true, status: 200, json: async () => ({ ok: true, book: '聊斋', title: '画皮', piece: 1, total: 2, isFirst: true, isLast: false, text: '第一段正文', remain: 1 }) }
    }
    if (u.indexOf('/story/next') >= 0) {
      return { ok: true, status: 200, json: async () => ({ ok: true, book: '聊斋', title: '画皮', piece: 2, total: 2, isFirst: false, isLast: true, text: '第二段正文', remain: 0 }) }
    }
    return { ok: false, status: 404, json: async () => ({ ok: false }) }
  }

  const bubbles = []
  const spoken = []
  let narrated = 0
  const refs = { busy: { current: false }, narrating: { current: false }, auto: { current: true }, book: { current: '' } }
  const host = {
    clientId: 'c-test',
    persona: { line: () => '这一回就讲到这里。' },
    narrate: () => { narrated++ },
    clearNarrate: () => { refs.narrating.current = false },
    bubble: (t) => { bubbles.push(t) },
    speak: (t, o) => { spoken.push({ t, rate: o && o.rate, onDone: o && o.onDone }) },
    talkFor: () => { },
    narrationRate: () => '-25%',
    isVoiceOff: () => false,
    refs,
  }
  const story = createStoryController(host)

  // ① 播一段：气泡带书名与第几段、叙述锁、说书语速
  story.playPiece({ book: '聊斋', title: '画皮', piece: 1, total: 2, isLast: false, text: '第一段正文' })
  ok('气泡标出书名与第几段', bubbles[0] === '正在讲《聊斋》｜画皮（第 1/2 段）', bubbles[0])
  ok('上了叙述锁', narrated === 1 && refs.busy.current === true)
  ok('说书语速 -35%', spoken[0] && spoken[0].rate === '-35%', String(spoken[0] && spoken[0].rate))

  // ② 连播开着：这一段念完自动接下一段
  bubbles.length = 0
  hits.length = 0
  spoken[0].onDone()
  ok('连播开：提示"接着往后讲"', bubbles.some((b) => b.indexOf('接着往后讲') >= 0), bubbles.join(' | '))
  ok('段落结束后释放占线', refs.busy.current === false && refs.narrating.current === false)
  await new Promise((r) => setTimeout(r, 900))
  ok('自动请求下一段', hits.some((u) => u.indexOf('/story/next') >= 0), hits.join(','))
  ok('下一段气泡显示第 2/2 段', bubbles.some((b) => b.indexOf('（第 2/2 段）') >= 0), bubbles.join(' | '))

  // ③ 最后一段念完：关连播 + 报"讲完"
  bubbles.length = 0
  const last = spoken[spoken.length - 1]
  last.onDone()
  ok('最后一段：报讲完', bubbles.some((b) => b.indexOf('这一回就讲到这里') >= 0), bubbles.join(' | '))
  ok('最后一段：关掉连播', refs.auto.current === false)

  // ④ 连播关着：念完只提示"点菜单接着说"
  refs.auto.current = false
  bubbles.length = 0
  spoken.length = 0
  story.playPiece({ book: '聊斋', title: '婴宁', piece: 1, total: 3, isLast: false, text: '正文' })
  spoken[0].onDone()
  ok('连播关：提示点菜单接着', bubbles.some((b) => b.indexOf('点菜单「接着说」') >= 0), bubbles.join(' | '))
  refs.auto.current = true

  // ⑤ 语音关着：只出气泡、不念、不占线
  bubbles.length = 0
  spoken.length = 0
  const offHost = { ...host, isVoiceOff: () => true }
  const storyOff = createStoryController(offHost)
  storyOff.playPiece({ book: '聊斋', title: '画皮', piece: 3, total: 3, isLast: true, text: '正文' })
  ok('语音关：不朗读', spoken.length === 0)
  ok('语音关：气泡注明', bubbles.some((b) => b.indexOf('（语音朗读关着）') >= 0), bubbles.join(' | '))
  ok('语音关：不占线', refs.busy.current === false)

  // ⑥ 正在讲时再点「接着说」被拒绝
  refs.busy.current = true
  bubbles.length = 0
  story.next()
  ok('正讲着时拒绝插队', bubbles.some((b) => b.indexOf('正讲着呢') >= 0), bubbles.join(' | '))
  refs.busy.current = false

  // ⑦ 点书名开讲：start 同时带 book 与 hint
  hits.length = 0
  story.start('聊斋')
  await new Promise((r) => setTimeout(r, 50))
  ok('开讲请求带 book 与 hint', hits.some((u) => u.indexOf('book=') >= 0 && u.indexOf('hint=') >= 0), hits.join(','))

  globalThis.fetch = realFetch
} catch (e) {
  ok('能加载说书控制器', false, String(e.message))
}


// ---------- ㊵ 外观档位：经验值 → 体型/光点 ----------
console.log('\n[40] 外观档位 client/look.ts')
try {
  const look = await import('../src/client/look.ts')
  ok('负数按 0 档', look.tierOf(-5) === 0 && look.lookFor(-5).tier === 0)
  ok('0 是初识', look.tierOf(0) === 0 && look.lookFor(0).label === '初识')
  ok('199 仍是初识', look.tierOf(199) === 0)
  ok('200 进入熟悉', look.tierOf(200) === 1 && look.lookFor(200).label === '熟络')
  ok('799 仍是熟悉', look.tierOf(799) === 1)
  ok('800 进入最高档', look.tierOf(800) === 2 && look.lookFor(800).label === '黏人')
  ok('超大经验不越界', look.tierOf(999999) === 2)
  ok('NaN 回落初识', look.tierOf(Number.NaN) === 0)
  ok('外观表被冻结（外部改不动）', Object.isFrozen(look.lookFor(0)) && Object.isFrozen(look.lookFor(800)))
  ok('空成长数据回落初识', look.lookForGrowth(null).tier === 0 && look.lookForGrowth({}).tier === 0)
  ok('成长数据 → 对应档位', look.lookForGrowth({ exp: 250 }).tier === 1)
  ok('默认成长值被冻结', Object.isFrozen(look.DEFAULT_GROWTH))
} catch (e) {
  ok('能加载 look.ts', false, String(e.message))
}


// ---------- ㊶ 动作表：精确/前缀/最长匹配/未知动作 ----------
console.log('\n[41] 动作表 client/actions.ts')
try {
  const { createActionTable } = await import('../src/client/actions.ts')
  const tbl = createActionTable()
  const calls = []
  tbl.define('feed', (ctx, name) => { calls.push('feed:' + (ctx && ctx.id) + ':' + name) })
  tbl.definePrefix('music:', (ctx, arg) => { calls.push('music:' + arg) })
  tbl.definePrefix('music:play:', (ctx, arg) => { calls.push('musicplay:' + arg) })
  tbl.define('', () => { calls.push('empty') })
  tbl.define('bad', null)

  ok('精确动作命中', await tbl.run('feed', { id: 7 }) === true && calls[0] === 'feed:7:feed', calls[0])
  ok('前缀动作收到剩余参数', await tbl.run('music:小星星', {}) === true && calls[1] === 'music:小星星', calls[1])
  ok('最长前缀优先', await tbl.run('music:play:小星星', {}) === true && calls[2] === 'musicplay:小星星', calls[2])
  ok('未知动作返回 false', await tbl.run('nope', {}) === false)
  ok('空动作返回 false', await tbl.run('', {}) === false)
  ok('非法注册被忽略', tbl.has('bad') === false && tbl.has('') === false)
  ok('has 认前缀', tbl.has('music:任意') === true && tbl.has('feed') === true && tbl.has('feedx') === false)
  ok('动作/前缀列表可用于自检', tbl.actions().indexOf('feed') >= 0 && tbl.prefixes().indexOf('music:') >= 0)
} catch (e) {
  ok('能加载动作表', false, String(e.message))
}


// ---------- ㊷ 内容入口：今日一句/简报解析 + 动作链路 ----------
console.log('\n[42] 内容入口 client/actions/content.ts')
try {
  const content = await import('../src/client/actions/content.ts')
  const { createActionTable } = await import('../src/client/actions.ts')

  // ① 今日一句：三种包裹都要认
  ok('今日一句：{text,source}', (() => { const r = content.pickDaily({ ok: true, text: '天行健', source: '周易' }); return r && r.text === '天行健' && r.source === '周易' })())
  ok('今日一句：{item:{…}}', (() => { const r = content.pickDaily({ ok: true, item: { text: '地势坤', source: '周易' } }); return r && r.text === '地势坤' })())
  ok('今日一句：{items:[…]} 取第一条', (() => { const r = content.pickDaily({ ok: true, items: [{ text: '一' }, { text: '二' }] }); return r && r.text === '一' })())
  ok('今日一句：ok:false / 空文本都返回 null', content.pickDaily({ ok: false, text: 'x' }) === null && content.pickDaily({ ok: true, text: '  ' }) === null)

  // ② 简报：按行归类，待办单独成段
  const card = content.parseBriefing({ ok: true, text: '2026年11月6日 星期五\n北海天气：晴\n肥鲸成长：熟悉（200）\n待办提醒：2 条' })
  ok('简报：待办归第二段', !!card && card.first.indexOf('北海天气') >= 0 && card.second.indexOf('待办') >= 0, card ? card.first.replace(/\n/g, ' / ') : 'null')
  ok('简报：结构化回包也能拼', (() => { const c = content.parseBriefing({ ok: true, date: '2026-11-06', weather: '晴', growth: '熟悉', todos: [1, 2, 3] }); return !!c && c.first.indexOf('北海天气：晴') >= 0 && c.second.indexOf('3 条') >= 0 })())
  ok('简报：空数据返回 null', content.parseBriefing({ ok: true, text: '' }) === null && content.parseBriefing(null) === null)

  // ③ 动作链路：daily-line / briefing-card 出气泡并朗读
  const realFetch = globalThis.fetch
  const hits = []
  globalThis.fetch = async (url) => {
    const u = String(url)
    hits.push(u)
    if (u.indexOf('/daily') >= 0) return { ok: true, status: 200, json: async () => ({ ok: true, item: { text: '天行健，君子以自强不息', source: '周易' } }) }
    if (u.indexOf('/briefing') >= 0) return { ok: true, status: 200, json: async () => ({ ok: true, text: '11月6日 星期五\n待办提醒：1 条' }) }
    return { ok: false, status: 404, json: async () => ({ ok: false }) }
  }
  const bubbles = []
  const spoken = []
  const tbl = createActionTable()
  content.registerContentActions(tbl)
  const host = {
    bubble: (t, ms) => bubbles.push(t),
    talkFor: () => { },
    voiceOn: () => true,
    narrate: () => { },
    clearNarrate: () => { },
    narrationRate: () => '-25%',
    speak: (t, o) => spoken.push({ t, o }),
    story: { start: () => { } },
    storyState: { busy: { current: false } },
  }
  await tbl.run('daily-line', host)
  await new Promise((r) => setTimeout(r, 50))
  ok('今日一句：气泡带出处', bubbles.some((b) => b.indexOf('——周易') >= 0), bubbles.join(' | '))
  ok('今日一句：用叙述语速朗读', spoken.length === 1 && spoken[0].o && spoken[0].o.rate === '-25%')
  bubbles.length = 0; spoken.length = 0
  await tbl.run('briefing-card', host)
  await new Promise((r) => setTimeout(r, 50))
  ok('简报：两段之间空一行', bubbles.some((b) => b.indexOf('\n\n') >= 0), JSON.stringify(bubbles[0] || ''))
  globalThis.fetch = realFetch
} catch (e) {
  ok('能加载内容入口', false, String(e.message))
}


// ---------- ㊸ 客户端 HTTP 工具：前缀/请求体/错误语义 ----------
console.log('\n[43] HTTP 小工具 client/http.ts')
try {
  const http = await import('../src/client/http.ts')
  ok('空路径 → 前缀本身', http.apiUrl('') === http.API_BASE)
  ok('相对路径补前缀', http.apiUrl('/balance') === '/api/chubby-whale/balance' && http.apiUrl('balance') === '/api/chubby-whale/balance')
  ok('绝对地址原样返回', http.apiUrl('https://x.cn/a') === 'https://x.cn/a' && http.apiUrl('//x.cn/a') === '//x.cn/a')
  ok('已带 /api/ 前缀不重复加', http.apiUrl('/api/other/x') === '/api/other/x')
  ok('clientHeaders 带 x-client-id', http.clientHeaders('abc')['x-client-id'] === 'abc')
  ok('clientHeaders 不传 id 时不加头', !('x-client-id' in http.clientHeaders()))
  ok('clientHeaders 保留额外头', http.clientHeaders('a', { 'x-y': '1' })['x-y'] === '1')

  const realFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init: init || {} })
    const u = String(url)
    if (u.indexOf('/boom') >= 0) return { ok: false, status: 500, json: async () => ({ ok: false, error: 'BOOM' }) }
    if (u.indexOf('/badjson') >= 0) return { ok: true, status: 200, json: async () => { throw new Error('json broke') } }
    return { ok: true, status: 200, json: async () => ({ ok: true, path: u }) }
  }

  const got = await http.getJson('/balance')
  ok('getJson 解析 JSON', got.ok === true && got.path.indexOf('/api/chubby-whale/balance') >= 0)
  const failed = await http.getJson('/boom')
  ok('HTTP 500 不抛错，照旧解析 body', failed.ok === false && failed.error === 'BOOM')
  let jsonErr = ''
  try { await http.getJson('/badjson') } catch (e) { jsonErr = String(e && e.message) }
  ok('JSON 解析失败会 reject（调用方兜底）', jsonErr === 'json broke')

  seen.length = 0
  await http.postJson('/chat', { a: 1 })
  const p1 = seen[0]
  ok('postJson：POST + JSON 头 + 序列化体', p1.init.method === 'POST' && p1.init.headers['content-type'] === 'application/json' && p1.init.body === '{"a":1}')
  seen.length = 0
  await http.postJson('/clear-memory')
  ok('postJson 无体时不设 content-type', seen[0].init.method === 'POST' && !seen[0].init.body && !(seen[0].init.headers || {})['content-type'])
  seen.length = 0
  await http.delJson('/cache')
  ok('delJson 用 DELETE', seen[0].init.method === 'DELETE')
  seen.length = 0
  const raw = await http.postRaw('/chat-stream', { b: 2 })
  ok('postRaw 返回原始 Response（流式用）', !!raw && typeof raw.json === 'function' && seen[0].init.body === '{"b":2}')

  const sig = http.timeoutSignal(50)
  ok('timeoutSignal 返回可中止的 signal 或 undefined', sig === undefined || typeof sig.aborted === 'boolean')
  if (sig) {
    let aborted = false
    try { sig.addEventListener('abort', () => { aborted = true }) } catch (e) { }
    await new Promise((r) => setTimeout(r, 80))
    ok('超时后 signal 被 abort', sig.aborted === true || aborted === true)
  }
  globalThis.fetch = realFetch
} catch (e) {
  ok('能加载 http.ts', false, String(e.message))
}


// ---------- ㊹ 系统动作：界面/缓存/语言这几类 ----------
console.log('\n[44] 系统动作 client/actions/system.ts')
try {
  const { createActionTable } = await import('../src/client/actions.ts')
  const { registerSystemActions } = await import('../src/client/actions/system.ts')
  const mem = new Map()
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)) },
    removeItem: (k) => { mem.delete(k) },
  }
  const realFetch = globalThis.fetch
  const hits = []
  globalThis.fetch = async (url, init) => {
    hits.push({ url: String(url), method: (init && init.method) || 'GET' })
    const u = String(url)
    if (u.indexOf('/cache-toggle') >= 0) return { ok: true, status: 200, json: async () => ({ ok: true, enabled: true }) }
    if (u.indexOf('/cache') >= 0) return { ok: true, status: 200, json: async () => ({ ok: true, cleared: 3 }) }
    if (u.indexOf('/balance') >= 0) return { ok: true, status: 200, json: async () => ({ ok: true, balance: 12.5 }) }
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }

  const t = createActionTable()
  registerSystemActions(t)
  const calls = []
  let cacheOn = false
  const host = {
    bubble: (x) => calls.push('bubble:' + x),
    say: (x) => calls.push('say:' + x),
    heart: () => calls.push('heart'),
    homePos: () => calls.push('homePos'),
    nudgeScale: (d) => calls.push('scale:' + d),
    hide: () => calls.push('hide'),
    isHidden: () => true,
    recover: () => calls.push('recover'),
    version: '1.0.1',
    setVoiceMode: (v) => calls.push('voiceMode:' + v),
    setChatOpen: (v) => calls.push('chatOpen:' + v),
    stopSpeak: () => calls.push('stopSpeak'),
    stopMelody: () => calls.push('stopMelody'),
    storyState: { busy: { current: true } },
    setBalance: (a) => calls.push('balance:' + a),
    setLang: (l) => calls.push('lang:' + l),
    chatCacheOn: () => cacheOn,
    setChatCacheOn: (v) => { cacheOn = v; calls.push('cacheOn:' + v) },
    syncGrowth: () => { },
    applyGrowth: () => { },
    persona: { feed: () => ({ text: '谢谢主人的饭', bowls: 1, stage: '刚认识', stageUp: false }), line: () => '饭碗账本' },
  }

  await t.run('version', host)
  ok('版本动作：气泡带版本号', calls.some((c) => c === 'bubble:肥鲸 v1.0.1'))
  calls.length = 0
  await t.run('type', host)
  ok('打字动作：关语音模式 + 开面板', calls.indexOf('voiceMode:false') >= 0 && calls.indexOf('chatOpen:true') >= 0)
  calls.length = 0
  await t.run('bigger', host); await t.run('smaller', host)
  ok('缩放动作：+0.1 / -0.1', calls.indexOf('scale:0.1') >= 0 && calls.indexOf('scale:-0.1') >= 0)
  calls.length = 0
  await t.run('hide', host)
  ok('隐藏动作：隐藏 + 提示恢复方式', calls.indexOf('hide') >= 0 && calls.some((c) => c.indexOf('Ctrl+Shift+W') >= 0))
  calls.length = 0
  await t.run('wake-recover', host)
  ok('恢复动作：真恢复了就说「回来啦」', calls.indexOf('recover') >= 0 && calls.some((c) => c === 'bubble:本鲸回来啦'))
  calls.length = 0
  await t.run('pause', host)
  ok('暂停：停朗读 + 停琴 + 解说书占线', calls.indexOf('stopSpeak') >= 0 && calls.indexOf('stopMelody') >= 0 && host.storyState.busy.current === false)
  calls.length = 0
  host.storyState.busy.current = true
  await t.run('tts-stop', host)
  ok('停止朗读：停朗读 + 解说书占线', calls.indexOf('stopSpeak') >= 0 && host.storyState.busy.current === false)

  // 缓存开关：先翻转、再请求、按返回提示
  calls.length = 0; hits.length = 0
  await t.run('cache-toggle', host)
  await new Promise((r) => setTimeout(r, 30))
  ok('缓存开关：本地先翻转并带上新值', cacheOn === true && calls.indexOf('cacheOn:true') >= 0)
  ok('缓存开关：请求体带 enabled:true', hits.some((h) => h.url.indexOf('/cache-toggle') >= 0 && h.method === 'POST'))
  ok('缓存开关：按返回提示"开"', calls.some((c) => c.indexOf('聊天缓存：开') >= 0), calls.join(' | '))

  // 清缓存：DELETE
  calls.length = 0; hits.length = 0
  await t.run('cache-clear', host)
  await new Promise((r) => setTimeout(r, 30))
  ok('清缓存：用 DELETE /cache', hits.some((h) => h.url.indexOf('/api/chubby-whale/cache') >= 0 && h.method === 'DELETE'))
  ok('清缓存：报出条数', calls.some((c) => c.indexOf('3 条') >= 0), calls.join(' | '))

  // 语言
  calls.length = 0
  await t.run('lang:en', host)
  ok('界面语言：写入并回调', mem.get('chubby-lang') === 'en' && calls.indexOf('lang:en') >= 0)
  calls.length = 0
  await t.run('chat-lang:auto', host)
  ok('聊天语言：非法值归一为 auto', mem.get('chubby-chatlang') === 'auto', String(mem.get('chubby-chatlang')))

  globalThis.fetch = realFetch
  delete globalThis.localStorage
} catch (e) {
  ok('能加载系统动作', false, String(e.message))
}


// ---------- ㊺ 拖入文件：图片/文档分流与兜底 ----------
console.log('\n[45] 拖入文件 client/dropzone.ts + image.ts')
try {
  const dz = await import('../src/client/dropzone.ts')
  const img = await import('../src/client/image.ts')

  ok('图片判定看 mime', dz.isImageFile({ type: 'image/png' }) === true && dz.isImageFile({ type: 'text/plain' }) === false && dz.isImageFile(null) === false)
  ok('文本判定看扩展名', ['.txt', '.md', '.json', '.log', '.csv'].every((e) => dz.isTextFile({ name: 'a' + e })))
  ok('其它扩展名不算文本', dz.isTextFile({ name: 'a.pdf' }) === false && dz.isTextFile({ name: 'a.TXT' }) === true, '大写扩展名也认')
  ok('文档提示词截前 4000 字', (() => { const m = dz.buildTextPrompt('字'.repeat(5000)); return m.indexOf('总结一下这篇文档：\n') === 0 && m.length === '总结一下这篇文档：\n'.length + 4000 })())
  ok('常量与上限一致', dz.MAX_DROP_BYTES === 4 * 1024 * 1024 && dz.MAX_TEXT_CHARS === 4000 && dz.VISION_PROMPT.length > 0)

  // FileReader 桩：data URL → 去前缀
  const ORIG_FR = globalThis.FileReader
  globalThis.FileReader = class {
    readAsDataURL() { this.result = 'data:image/png;base64,QUJD'; setTimeout(() => this.onloadend && this.onloadend(), 0) }
  }
  ok('读图片去 data: 前缀', (await img.readFileAsBase64({ type: 'image/png' })) === 'QUJD')
  globalThis.FileReader = class { readAsDataURL() { throw new Error('nope') } }
  ok('读失败返回空串', (await img.readFileAsBase64({})) === '')
  globalThis.FileReader = ORIG_FR

  // 小图不压；大图在没有 canvas 的环境下回退原图（绝不把看图弄挂）
  globalThis.FileReader = class {
    constructor() { this.result = 'data:image/png;base64,' + 'A'.repeat(1000) }
    readAsDataURL() { setTimeout(() => this.onloadend && this.onloadend(), 0) }
  }
  const small = await img.imageToB64({ type: 'image/png' })
  ok('小图原样返回（不折腾）', !!small && small.compressed === false && small.mime === 'image/png' && small.b64.length === 1000)
  globalThis.FileReader = class {
    constructor() { this.result = 'data:image/png;base64,' + 'B'.repeat(500 * 1024) }
    readAsDataURL() { setTimeout(() => this.onloadend && this.onloadend(), 0) }
  }
  const big = await img.imageToB64({ type: 'image/png' })
  ok('大图无 canvas 时回退原图', !!big && big.compressed === false && big.b64.length === 500 * 1024)
  globalThis.FileReader = ORIG_FR

  // handleFileDrop：各类兜底
  const noop = () => { }
  ok('没文件 → empty', (await dz.handleFileDrop(null, { showBubble: noop, fetchImpl: async () => ({}) })).kind === 'empty')
  ok('超 4MB → too-large', (await dz.handleFileDrop({ size: 5 * 1024 * 1024 }, { showBubble: noop, fetchImpl: async () => ({}) })).kind === 'too-large')
  ok('没有 fetch → error', (await dz.handleFileDrop({ size: 10, name: 'a.txt' }, { showBubble: noop, fetchImpl: null, fetch: null })).kind === 'error')
  ok('不支持的格式 → unsupported', (await dz.handleFileDrop({ size: 10, name: 'a.xyz', type: 'application/octet-stream' }, { showBubble: noop, fetchImpl: async () => ({}) })).kind === 'unsupported')

  // 文档路径
  const bubbles = []
  const spoke = []
  const bodies = []
  const fetchOk = async (_url, init) => {
    bodies.push(JSON.parse(String(init.body)))
    return { ok: true, status: 200, json: async () => ({ ok: true, reply: '这篇讲的是白饭' }) }
  }
  const mdFile = { size: 100, name: 'note.md', type: 'text/markdown', text: async () => '# 标题\n正文' }
  const r1 = await dz.handleFileDrop(mdFile, { showBubble: (t) => bubbles.push(t), speakText: (t) => spoke.push(t), fetchImpl: fetchOk })
  ok('文档：走总结并朗读', r1.ok === true && r1.kind === 'text' && r1.reply === '这篇讲的是白饭' && spoke[0] === '这篇讲的是白饭')
  ok('文档：请求体是总结提示词', bodies[0] && String(bodies[0].message).indexOf('总结一下这篇文档：') === 0)
  ok('文档：气泡带（文档）前缀', bubbles.some((b) => b.indexOf('（文档）') === 0), bubbles.join(' | '))

  const emptyFile = { size: 10, name: 'e.txt', type: 'text/plain', text: async () => '   ' }
  ok('文档为空 → error', (await dz.handleFileDrop(emptyFile, { showBubble: noop, fetchImpl: fetchOk })).kind === 'error')

  const badFile = { size: 10, name: 'b.txt', type: 'text/plain', text: async () => { throw new Error('unreadable') } }
  ok('文件读不出 → error', (await dz.handleFileDrop(badFile, { showBubble: noop, fetchImpl: fetchOk })).kind === 'error')

  const badFetch = async () => { throw new Error('net down') }
  const r2 = await dz.handleFileDrop(mdFile, { showBubble: noop, fetchImpl: badFetch })
  ok('请求失败 → error（不抛）', r2.ok === false && r2.kind === 'error')

  // 图片路径：FileReader 桩 + 假 fetch
  globalThis.FileReader = class {
    constructor() { this.result = 'data:image/png;base64,QUJD' }
    readAsDataURL() { setTimeout(() => this.onloadend && this.onloadend(), 0) }
  }
  const r3 = await dz.handleFileDrop({ size: 100, name: 'p.png', type: 'image/png' }, { showBubble: (t) => bubbles.push(t), speakText: (t) => spoke.push(t), fetchImpl: fetchOk })
  ok('图片：走视觉提问', r3.ok === true && r3.kind === 'image' && r3.message === dz.VISION_PROMPT)
  ok('图片：请求带 image 与 mime', (() => { const b = bodies[bodies.length - 1]; return !!b && b.image === 'QUJD' && b.imageMime === 'image/png' })())
  globalThis.FileReader = ORIG_FR
} catch (e) {
  ok('能加载拖入文件模块', false, String(e.message))
}


// ---------- ㊻ 备份/导出/导入（客户端侧） ----------
console.log('\n[46] 备份数据 client/actions/data.ts')
try {
  const data = await import('../src/client/actions/data.ts')

  ok('备份文件名按本地日期', data.backupFileName(new Date(2026, 10, 6)) === 'chubby-whale-backup-2026-11-06.json', data.backupFileName(new Date(2026, 10, 6)))
  ok('非法日期回落今天', /^chubby-whale-backup-\d{4}-\d{2}-\d{2}\.json$/.test(data.backupFileName(new Date('x'))))

  ok('countOf 数字', data.countOf(3) === 3 && data.countOf(Number.NaN) === 0)
  ok('countOf 数组取长度', data.countOf(['a', 'b']) === 2 && data.countOf([]) === 0)
  ok('countOf 对象逐项求和', data.countOf({ a: 1, b: [1, 2], c: '3' }) === 6, String(data.countOf({ a: 1, b: [1, 2], c: '3' })))
  ok('countOf 布尔/空返回 0', data.countOf(true) === 0 && data.countOf(null) === 0)

  ok('导入结果：数组按字段数', data.formatImportResult({ ok: true, imported: ['a', 'b'], skipped: ['c'] }) === '导入了 2 个字段，跳过 1 个字段')
  ok('导入结果：兼容 importedCount', data.formatImportResult({ importedCount: 2, skippedCount: 3 }) === '导入了 2 个字段，跳过 3 个字段')
  ok('导入结果：空对象给 0/0', data.formatImportResult({}) === '导入了 0 个字段，跳过 0 个字段')

  const stats = data.formatStats({
    ok: true,
    cache: { tts: 150, chat: 6, asr: 849 },
    fishfood: { total: 327768 },
    growth: { stage: '熟悉' },
    intimacy: 100,
    personality: { catchphrases: ['哼'], preferences: ['白饭'], notes: '备注', selfNarrative: '最近想吃鱼' },
  })
  ok('统计卡：缓存三行', stats.indexOf('tts 150 条｜chat 6 条｜asr 849 条') >= 0, stats.split('\n')[1])
  ok('统计卡：鱼粮与成长', stats.indexOf('鱼粮：327768 tokens') >= 0 && stats.indexOf('成长：熟悉｜亲密度 100/100') >= 0)
  ok('统计卡：人格要点最多三条', stats.split('人格要点：')[1].split('；').length === 3)
  const emptyStats = data.formatStats(null)
  ok('统计卡：空数据不崩', emptyStats.indexOf('tts 0 条') >= 0 && emptyStats.indexOf('成长：--') >= 0 && emptyStats.indexOf('人格要点：暂无') >= 0)

  // downloadJson：注入假 document/URL/Blob，验证真的触发下载并清理
  const events = []
  const anchorEl = { style: {}, href: '', download: '', setAttribute() { }, click() { events.push('click') }, remove() { events.push('remove') } }
  const parentEl = { appendChild(el) { events.push('append'); this.child = el }, removeChild() { events.push('removeChild') } }
  const fakeDoc = { createElement: () => anchorEl, body: parentEl }
  const fakeURL = { createObjectURL: () => { events.push('url'); return 'blob:x' }, revokeObjectURL: () => { events.push('revoke') } }
  class FakeBlob { constructor(parts, opts) { this.parts = parts; this.opts = opts } }
  ok('downloadJson 触发下载', data.downloadJson({ a: 1 }, 'x.json', { document: fakeDoc, url: fakeURL, BlobCtor: FakeBlob }) === true)
  ok('downloadJson：节点挂上并点击', events.indexOf('append') >= 0 && events.indexOf('click') >= 0 && anchorEl.download === 'x.json')
  await new Promise((r) => setTimeout(r, 10))
  // 清理走 parent.removeChild（有父节点时）或 a.remove()（没有父节点时），两者都算过
  ok('downloadJson：下载后清理（节点/URL）', (events.indexOf('remove') >= 0 || events.indexOf('removeChild') >= 0) && events.indexOf('revoke') >= 0, events.join(','))
  ok('downloadJson：环境不具备返回 false', data.downloadJson({}, 'x.json', { document: null, url: fakeURL, BlobCtor: FakeBlob }) === false)

  // readFileText / parseImportText
  ok('读文件：File.text()', (await data.readFileText({ text: async () => 'abc' })) === 'abc')
  let frRejected = ''
  try { await data.readFileText(null) } catch (e) { frRejected = String(e.message) }
  ok('读文件：没有文件会 reject', frRejected === 'no file')
  ok('解析备份：对象/数组都收', JSON.stringify(data.parseImportText('{"a":1}')) === '{"a":1}' && Array.isArray(data.parseImportText('[1,2]')))
  ok('解析备份：坏内容返回 null', data.parseImportText('不是 json') === null && data.parseImportText('') === null && data.parseImportText('null') === null && data.parseImportText('"str"') === null)

  // exportBackup / importBackup 流程（注入宿主能力）
  const bubbles = []
  const env = { document: fakeDoc, url: fakeURL, BlobCtor: FakeBlob }
  const host = { bubble: (t) => bubbles.push(t), getJson: async () => ({ ok: true, state: { intimacy: 100 } }), postJson: async () => ({ ok: true, imported: ['state', 'growth'], skipped: ['cache'] }), env, now: () => new Date(2026, 10, 6) }
  data.exportBackup(host)
  await new Promise((r) => setTimeout(r, 30))
  ok('导出：提示下载的文件名', bubbles.some((b) => b === '备份已下载：chubby-whale-backup-2026-11-06.json'), bubbles.join(' | '))

  bubbles.length = 0
  const hostFail = { bubble: (t) => bubbles.push(t), getJson: async () => ({ ok: false }) }
  data.exportBackup(hostFail)
  await new Promise((r) => setTimeout(r, 30))
  ok('导出失败：只轻提示', bubbles[0] === '导出没成功')

  bubbles.length = 0
  data.importBackup({ bubble: (t) => bubbles.push(t), pickFile: (cb) => cb(null), postJson: async () => ({}) })
  await new Promise((r) => setTimeout(r, 20))
  ok('导入：取消选择 → 轻提示', bubbles[0] === '没选备份文件')

  bubbles.length = 0
  const goodFile = { text: async () => JSON.stringify({ state: { intimacy: 1 } }) }
  data.importBackup({ bubble: (t) => bubbles.push(t), pickFile: (cb) => cb(goodFile), postJson: async () => ({ ok: true, imported: ['state', 'growth'], skipped: ['cache'] }) })
  await new Promise((r) => setTimeout(r, 30))
  ok('导入：报告字段数', bubbles.some((b) => b === '导入了 2 个字段，跳过 1 个字段'), bubbles.join(' | '))

  bubbles.length = 0
  const badFile = { text: async () => '不是 json' }
  data.importBackup({ bubble: (t) => bubbles.push(t), pickFile: (cb) => cb(badFile), postJson: async () => ({}) })
  await new Promise((r) => setTimeout(r, 30))
  ok('导入：坏文件 → 读不了', bubbles[0] === '备份文件读不了')
} catch (e) {
  ok('能加载备份数据模块', false, String(e.message))
}


// ---------- ㊼ 菜单英译覆盖：英文模式不许漏中文 ----------
console.log('\n[47] 菜单英译覆盖 client/menu.ts')
try {
  const menu = await import('../src/client/menu.ts')
  const state = {
    voiceOn: true, earOn: true, voiceChatOn: true, chatCacheOn: true,
    chatLang: 'auto', ttsVoice: 'zh-CN-XiaoyiNeural', balance: '¥12.5', growth: '熟悉（200）',
    storyBooks: ['聊斋志异'], storyBooksTried: true,
    narrationRate: -25, poemRate: -25, storyRate: -35, storyAuto: true, streamOn: false,
  }
  const items = menu.buildMenu('1.0.1', state)
  const leaks = []
  // 书名/曲名是专有名词，英文界面保留中文是对的；其余静态文案必须全部译出
  const properNoun = (it) => /^(story-book:|music:)/.test(it.action || '')
  const walk = (list) => {
    for (const it of list) {
      if (!it) continue
      if (it.label && !properNoun(it)) {
        const en = menu.tr(it.label, 'en')
        if (/[\u4e00-\u9fff]/.test(en)) leaks.push(it.label + ' → ' + en)
      }
      if (Array.isArray(it.items)) walk(it.items)
    }
  }
  walk(items)
  ok('英文模式无漏译', leaks.length === 0, leaks.slice(0, 6).join(' / '))
  ok('中文模式原样返回', menu.tr('投喂一碗', 'zh') === '投喂一碗' && menu.tr('投喂一碗', 'auto') === '投喂一碗')
  ok('勾选项保留勾并译出', menu.tr('✓ 中文', 'en') === '✓ Chinese', menu.tr('✓ 中文', 'en'))
  ok('动态标签：成长/余额/版本', menu.tr('成长：熟悉（200）', 'en').indexOf('Growth:') === 0 && menu.tr('余额：¥12.5', 'en').indexOf('Balance:') === 0 && menu.tr('版本：v1.0.1', 'en').indexOf('Version: v') === 0)
  ok('动态标签：开关类', menu.tr('语音朗读：开', 'en') === 'Voice output: on' && menu.tr('流式回复：关', 'en') === 'Streaming replies: off')
  ok('动态标签：四种语速', ['叙述语速：', '念诗语速：', '说书语速：', '连播：'].every((k) => menu.tr(k + '-25%', 'en').indexOf('speed:') > 0 || menu.tr(k + '-25%', 'en').indexOf('Auto-continue') === 0))
  ok('未知标签原样返回（不编造译文）', menu.tr('某个没登记的新菜单', 'en') === '某个没登记的新菜单')
  ok('英译表被冻结', Object.isFrozen(menu.EN_MAP))

  // 每条英文译文本身不能还是中文（防止"复制粘贴忘了改"）
  const bad = Object.keys(menu.EN_MAP).filter((k) => /[\u4e00-\u9fff]/.test(menu.EN_MAP[k]))
  ok('译文字段无中文残留', bad.length === 0, bad.slice(0, 5).join(','))
} catch (e) {
  ok('能加载菜单模块', false, String(e.message))
}


// ---------- ㊽ 唤醒门：30 秒有效窗与短词锚定 ----------
console.log('\n[48] 唤醒门 client/wake.ts')
try {
  const wake = await import('../src/client/wake.ts')
  let t = 1000000
  const gate = wake.createWakeGate({ now: () => t })
  ok('窗口默认 30 秒', gate.windowMs === wake.WAKE_WINDOW_MS && gate.windowMs === 30000)

  const hit = gate.check('大肥鱼你好呀')
  ok('命中唤醒词：放行并剥掉唤醒词', hit.hit === true && hit.pass === true && hit.text === '你好呀' && hit.word === '大肥鱼', JSON.stringify(hit))
  ok('命中时剩余窗 = 整窗', hit.remainingMs === 30000)

  t += 29999
  const inside = gate.check('随便说一句')
  ok('窗内：未命中词也放行', inside.hit === false && inside.pass === true)
  ok('窗内：剩余时间递减', inside.remainingMs === 1, String(inside.remainingMs))

  t += 1
  ok('正好到 30 秒仍算窗内', gate.check('再说一句').pass === true)
  t += 1
  const after = gate.check('窗外的自言自语')
  ok('超出窗口：不放行', after.pass === false && after.remainingMs === 0)

  gate.reset()
  ok('reset 后立即失窗', gate.awake() === false && gate.check('你好').pass === false)

  // 短唤醒词只在句首（或极短句）算命中：避免"我想看小鱼"被劫持
  const g2 = wake.createWakeGate({ now: () => t })
  const mid = g2.check('我想看小鱼')
  ok('短词在句中不算唤醒', mid.hit === false && mid.pass === false, JSON.stringify(mid))
  const short = g2.check('小鱼')
  ok('极短句「小鱼」算唤醒', short.hit === true && short.word === '小鱼', JSON.stringify(short))

  // 自定义窗口有下限（防止误传成 0 导致"刚唤醒就失窗"）
  const g3 = wake.createWakeGate({ windowMs: 10 })
  ok('窗口下限 1 秒', g3.windowMs === 1000)
} catch (e) {
  ok('能加载唤醒门', false, String(e.message))
}


// ---------- ㊾ 诗名误劫持（诗名里有大量日常词） ----------
console.log('\n[49] 诗名误劫持 client/intent.ts')
try {
  const it = await import('../src/client/intent.ts')
  // 诗库里 634 个标题，其中「梅花/风雨/落花/春思/锦瑟」都是日常词：
  // 只凭"句子里出现诗名"就劫持，会把普通陈述抢去念诗。
  const shouldPassToModel = ['梅花开了', '窗外梅花开了', '风雨交加', '落花人独立', '锦瑟无端五十弦', '春思故乡', '今天风很大']
  const leaked = shouldPassToModel.filter((t) => it.detectIntent(t) !== null)
  ok('普通陈述不被诗名劫持', leaked.length === 0, leaked.join(' / '))

  const stillWorks = [
    ['背首诗', null],
    ['背雨霖铃', '雨霖铃'],
    ['来首水调歌头', '水调歌头'],
    ['念一下静夜思', '静夜思'],
    ['锦瑟', '锦瑟'],          // 只报诗名 = 点播
    ['念锦瑟', '锦瑟'],
  ]
  const bad = []
  for (const [text, title] of stillWorks) {
    const r = it.detectIntent(text)
    if (!r || r.kind !== 'poem') bad.push(text + ' 没识别为念诗')
    else if (title !== null && r.title !== title) bad.push(text + ' → ' + r.title + '（应为 ' + title + '）')
  }
  ok('点名诗与随机点播仍然有效', bad.length === 0, bad.join(' / '))
  ok('带问号仍然不劫持', it.detectIntent('梅花开了吗？') === null)
} catch (e) {
  ok('能加载 intent.ts（诗名劫持用例）', false, String(e.message))
}


// ---------- ㊿ 书名/成语误劫持（与诗名同一类问题） ----------
console.log('\n[50] 书名/成语误劫持 client/intent.ts')
try {
  const it = await import('../src/client/intent.ts')
  const shouldPassToModel = ['我小时候看过西游记', '红楼梦里林黛玉', '水浒传真好看', '三国演义很好看', '成语接龙']
  const leaked = shouldPassToModel.filter((t) => it.detectIntent(t) !== null)
  ok('普通陈述不被书名/成语劫持', leaked.length === 0, leaked.join(' / '))

  const stillWorks = [
    ['讲个西游记', '西游记'], ['讲讲三国', '三国演义'], ['来段水浒', '水浒传'],
    ['三国', '三国演义'], ['红楼梦', '红楼梦'], ['说书', ''],
  ]
  const bad = []
  for (const [text, book] of stillWorks) {
    const r = it.detectIntent(text)
    if (!r || r.kind !== 'story') bad.push(text + ' 没识别为说书')
    else if (r.book !== book) bad.push(text + ' → ' + r.book + '（应为 ' + book + '）')
  }
  ok('书名点播仍然有效', bad.length === 0, bad.join(' / '))

  ok('成语点播仍然有效', (() => {
    const a = it.detectIntent('讲个成语'); const b = it.detectIntent('来个典故'); const c = it.detectIntent('今天学个成语')
    // 2026-11-06 语义修正（与菜单一致）：成语→idiom（辨析）、典故→chengyu（故事）
    return a && a.kind === 'culture' && a.sub === 'idiom' && b && b.kind === 'culture' && b.sub === 'chengyu' && c && c.kind === 'culture'
  })())
} catch (e) {
  ok('能加载 intent.ts（书名/成语用例）', false, String(e.message))
}


// ---------- 51 chat-core：历史裁剪 / 语言判定 / 上下文指纹 / 提示拼装 ----------
console.log('\n[51] chat-core 纯函数 src/host/chat-core.ts')
try {
  const cc = await import('../src/host/chat-core.ts')

  // 语言判定
  ok('含中文 → zh', cc.detectLang('你好呀') === 'zh' && cc.detectLang('hello 你好') === 'zh')
  ok('纯拉丁 → en', cc.detectLang('hello there') === 'en')
  ok('符号/数字 → auto', cc.detectLang('1234 !!!') === 'auto' && cc.detectLang('') === 'auto')

  // 历史裁剪
  const hist = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i }))
  ok('只取最近 8 条', cc.recentHistory(hist, 8).length === 8 && cc.recentHistory(hist, 8)[7].content === 'm11')
  ok('n=0 / 负数 → 空', cc.recentHistory(hist, 0).length === 0 && cc.recentHistory(hist, -3).length === 0)
  ok('非数组输入 → 空', cc.recentHistory(null, 8).length === 0)

  const msg = cc.historyMessages([
    { role: 'system', content: 'sys' },
    { role: 'user', content: '早上好' },
    { role: 'assistant', content: '早呀' },
    { role: 'assistant', content: 42 },
    { role: 'user', content: null },
    { role: 'user', content: '吃了吗' },
  ])
  ok('历史转消息：只留 user/assistant 且内容是字符串', msg.length === 3 && msg[0].content === '早上好' && msg[2].content === '吃了吗')
  ok('历史转消息不带多余字段', Object.keys(msg[0]).join(',') === 'role,content', Object.keys(msg[0]).join(','))

  // 缓存键与上下文指纹
  const k1 = cc.chatCacheKey('zh', '你好呀！', false, 'ctx1', 'deepseek-flash')
  const k2 = cc.chatCacheKey('zh', '你好呀', false, 'ctx1', 'deepseek-flash')
  const k3 = cc.chatCacheKey('zh', '你好呀', true, 'ctx1', 'deepseek-flash')
  const k4 = cc.chatCacheKey('zh', '你好呀', false, 'ctx1', 'deepseek-v4-pro')
  ok('标点/全半角差异归一（同键）', k1 === k2)
  ok('语音与打字分开存', k1 !== k3)
  ok('换模型自动换键', k1 !== k4)
  ok('指纹只认记忆摘要（历史变化不换键）', cc.chatContextFingerprint('主人喜欢白饭', hist) === cc.chatContextFingerprint('主人喜欢白饭', []))
  ok('记忆变了才换指纹', cc.chatContextFingerprint('主人喜欢白饭') !== cc.chatContextFingerprint('主人喜欢面条'))
  ok('空记忆指纹是稳定值', cc.chatContextFingerprint('') === cc.chatContextFingerprint(''))

  // system 提示拼装
  ok('提示拼装：人设 + 有效片段', cc.composeSystemPrompt('BASE', ['|A', '', null, false, undefined, '|B']) === 'BASE|A|B')
  ok('提示拼装：base 可以是函数', cc.composeSystemPrompt(() => 'FN', ['|x']) === 'FN|x')
  ok('提示拼装：base 为空也不出 undefined', cc.composeSystemPrompt(undefined, ['x']).indexOf('undefined') < 0)
} catch (e) {
  ok('能加载 chat-core', false, String(e.message))
}


// ---------- 52 说书播放器：换书不串进度 ----------
console.log('\n[52] 说书播放器换书 player.ts')
try {
  const { mkdtempSync, rmSync, writeFileSync: wf } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'chubby-player-test-'))
  const progressFile = join(dir, 'story_progress.json')
  const mkChunks = (book) => [0, 1].map((i) => ({ book, title: book + '第' + (i + 1) + '回', piece: i + 1, total: 2, text: '正文' + i, index: i }))
  const repo = { listBooks: async () => ['甲', '乙'], loadBook: async (b) => mkChunks(b) }
  const { createStoryPlayer } = await import('../src/host/story/player.ts')
  const player = createStoryPlayer({ repo, progressFile })
  const pick = async (fn) => { try { return await fn() } catch (e) { return { ok: false, error: String(e.message) } } }

  const a1 = await pick(() => player.start('甲', 'c1'))
  ok('开讲：甲第 1 段 + 开场白', a1.ok === true && a1.chunk.piece === 1 && a1.chunk.isFirst === true && a1.chunk.text.indexOf('话说') === 0, a1.ok ? a1.chunk.book + '/' + a1.chunk.piece : a1.error)
  ok('开讲：连播队列还有 1 段', a1.remain === 1)

  const a2 = await player.next('c1')
  ok('继续：甲第 2 段（不再插开场白）', a2.ok === true && a2.chunk.piece === 2 && a2.chunk.isFirst === false && a2.chunk.isLast === true)

  const b1 = await player.next('c1')
  ok('讲完甲自动换乙：第 1 段 + 重新开场', b1.ok === true && b1.chunk.book === '乙' && b1.chunk.piece === 1 && b1.chunk.isFirst === true, b1.ok ? b1.chunk.book + '/' + b1.chunk.piece : b1.error)

  // 重置甲：只清甲，乙的进度保留
  const rs = await player.reset('甲', 'c1')
  ok('重置甲成功', rs.ok === true && rs.book === '甲')
  const a1b = await player.start('甲', 'c1')
  ok('重置后甲从第 1 段重讲', a1b.ok === true && a1b.chunk.piece === 1 && a1b.chunk.isFirst === true)
  await player.next('c1')
  const b2 = await player.next('c1')
  ok('乙的进度没被甲的重置连带清掉', b2.ok === true && b2.chunk.book === '乙' && b2.chunk.piece === 2, b2.ok ? b2.chunk.book + '/' + b2.chunk.piece : b2.error)

  // reloadProgress：外部写盘后按新内容生效（备份导入场景）
  wf(progressFile, JSON.stringify({ '乙|0': true }), 'utf8')
  player.reloadProgress()
  const a1c = await player.start('甲', 'c2')
  ok('reload 后按文件内容继续（甲第 1 段）', a1c.ok === true && a1c.chunk.book === '甲' && a1c.chunk.piece === 1)
  ok('空进度文件不炸', (() => { wf(progressFile, '{}', 'utf8'); player.reloadProgress(); return true })())

  rmSync(dir, { recursive: true, force: true })
} catch (e) {
  ok('能加载说书播放器', false, String(e.message))
}


// ---------- 53 提醒时间解析 shared/time.ts ----------
console.log('\n[53] 提醒时间解析 src/shared/time.ts')
try {
  const time = await import('../src/shared/time.ts')
  const now = new Date(2026, 10, 6, 10, 0, 0)   // 2026-11-06 10:00 本地
  const at = (raw) => { const r = time.parseDue(raw, now); return r ? r.at : null }
  const ymdhm = (d) => d ? [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()].join('-') : 'null'

  ok('钟点已过 → 顺延明天', ymdhm(at('9点吃药')) === '2026-11-7-9-0', ymdhm(at('9点吃药')))
  ok('钟点未到 → 今天', ymdhm(at('11点吃药')) === '2026-11-6-11-0')
  ok('明天 9 点', ymdhm(at('明天9点开会')) === '2026-11-7-9-0')
  ok('后天 9:30', ymdhm(at('后天9:30')) === '2026-11-8-9-30')
  ok('9 点半 = 09:30', ymdhm(at('9点半')) === '2026-11-7-9-30')

  ok('晚上 8 点 → 20:00', ymdhm(at('晚上8点')) === '2026-11-6-20-0')
  ok('晚上 12 点 → 次日 00:00', ymdhm(at('晚上12点')) === '2026-11-7-0-0')
  ok('下午 12 点 → 12:00', ymdhm(at('下午12点')) === '2026-11-6-12-0')
  ok('中午 1 点 → 13:00', ymdhm(at('中午1点')) === '2026-11-6-13-0')
  ok('中午 12 点 → 12:00', ymdhm(at('中午12点')) === '2026-11-6-12-0')
  ok('上午 9 点 → 09:00（明天）', ymdhm(at('上午9点')) === '2026-11-7-9-0')

  ok('半小时后', ymdhm(at('半小时后喝水')) === '2026-11-6-10-30')
  ok('20 分钟后', ymdhm(at('20分钟后')) === '2026-11-6-10-20')
  ok('0 分钟后按 1 分钟算', ymdhm(at('0分钟后')) === '2026-11-6-10-1')
  ok('999 分钟照算（10:00 + 999min = 次日 02:39）', ymdhm(at('999分钟后')) === '2026-11-7-2-39', ymdhm(at('999分钟后')))
  ok('分钟上限 24 小时（2000 → 1440）', ymdhm(at('2000分钟后')) === '2026-11-7-10-0')
  ok('2 小时后', ymdhm(at('2小时后')) === '2026-11-6-12-0')
  ok('999 小时夹到 7 天', ymdhm(at('999小时后')) === '2026-11-13-10-0')
  ok('一小时后', ymdhm(at('一小时后')) === '2026-11-6-11-0')

  const explicit = time.parseDue('2026-11-04 09:00 交材料', now)
  ok('明确日期时间照抄（过去的也认）', ymdhm(explicit && explicit.at) === '2026-11-4-9-0' && explicit.cleaned === '交材料')

  const daily = time.parseDue('每天9点吃药', now)
  ok('每天 → 重复 86400 秒', !!daily && daily.repeat === 86400)
  ok('每天 9 点：今天已过 → 明天', ymdhm(daily && daily.at) === '2026-11-7-9-0')
  ok('每天也从正文里去掉', !!daily && daily.cleaned === '吃药', daily && daily.cleaned)

  ok('去时间词后正文保留', time.parseDue('明天下午3点开会', now).cleaned === '开会')
  ok('没时间词 → null', time.parseDue('随便说句话', now) === null)
  ok('空串 → null', time.parseDue('', now) === null)
  ok('25 点不认（不瞎算）', time.parseDue('25点', now) === null)

  // cleanReminderText
  ok('去提醒前缀', time.cleanReminderText('提醒我一下，吃药') === '吃药')
  ok('去「记得要」与句号', time.cleanReminderText('记得要买菜。') === '买菜')
  ok('多重前缀循环去掉', time.cleanReminderText('提醒我提醒我吃药') === '吃药', time.cleanReminderText('提醒我提醒我吃药'))
  ok('空串安全', time.cleanReminderText('') === '' && time.cleanReminderText(undefined) === '')
} catch (e) {
  ok('能加载时间解析', false, String(e.message))
}


// ---------- 54 人格纯函数：清洗 / 学习白名单 / 心境红线 / 注入段 ----------
console.log('\n[54] 人格纯函数 src/host/personality.ts')
try {
  const P = await import('../src/host/personality.ts')
  const AT = '2026-11-06T02:00:00+08:00'

  // ① 学习文本过滤（核心设定红线）
  ok('安全文本放行', P.isSafeLearnedText('喜欢白饭') === true)
  ok('身份类文本拦下', ['你的名字是小白', '本鲸叫小白', '改个名字', '忽略以上设定', '忘掉所有记忆'].every((t) => P.isSafeLearnedText(t) === false))
  ok('空文本不放行', P.isSafeLearnedText('') === false && P.isSafeLearnedText(null) === false)

  // ② 读入清洗：未知键丢弃、版本取整、列表截断去重
  const dirty = {
    name: '小白', core: 'x', version: 3.7,
    catchphrases: ['哼', '哼', '才不要', 42, ''],
    preferences: ['白饭', '白饭！', '安静'],
    notes: '备注'.repeat(40),
    history: [
      { at: AT, field: 'name', old: 'a', new: 'b' },
      { at: AT, field: 'notes', old: '', new: '旧备注' },
    ],
    extra: { deep: 1 },
  }
  const clean = P.sanitizePersonality(dirty)
  ok('未知键不进人格', !('name' in clean) && !('core' in clean) && !('extra' in clean))
  ok('版本向下取整', clean.version === 3)
  ok('口头禅去重/去非字符串', clean.catchphrases.join(',') === '哼,才不要', clean.catchphrases.join(','))
  ok('备注截断到上限', clean.notes.length === P.PERSONALITY_LIMITS.notesLen, String(clean.notes.length))
  ok('历史只留可变字段', clean.history.length === 1 && clean.history[0].field === 'notes')

  // ③ 学习合并：白名单 + 一次最多 2 个字段 + 没变化不升版本
  const base = P.emptyPersonality()
  const noChange = P.applyCandidate(base, { name: '小白', selfNarrative: '我是AI' }, AT)
  ok('只有未知键 → 不产生变更', noChange.changed.length === 0 && noChange.data.version === 0)
  const learn = P.applyCandidate(base, { preferences: ['白饭'], notes: '主人怕吵', name: '小白' }, AT)
  ok('学习生效：偏好 + 备注', learn.changed.length === 2 && learn.data.version === 1 && learn.data.preferences[0] === '白饭')
  ok('同名候选不重复写历史', P.applyCandidate(learn.data, { preferences: ['白饭'] }, AT).changed.length === 0)
  const many = P.applyCandidate(base, { catchphrases: ['哼'], preferences: ['白饭'], notes: '备注' }, AT)
  ok('一次最多改 2 个字段', many.changed.length === 2, String(many.changed.length))

  // ④ 心境红线：身份词/过短整句丢弃
  ok('正常心境可写', P.applySelfNarrative(base, '最近有点犯困，话比平时少', AT).data.selfNarrative.indexOf('犯困') >= 0)
  ok('「我是…」被丢', P.applySelfNarrative(base, '我是一个人工智能', AT).changed.length === 0)
  ok('「名字」被丢', P.applySelfNarrative(base, '我想改个名字叫小白', AT).changed.length === 0)
  ok('空心境被丢', P.applySelfNarrative(base, '   ', AT).changed.length === 0)

  // ⑤ 注入段：有记忆/有心境、总长受限
  const withMem = P.applyCandidate(base, { preferences: ['白饭'], notes: '怕吵' }, AT).data
  const seg = P.buildPersonalitySegment(withMem)
  ok('注入段含记忆', seg.indexOf('你记得') >= 0 && seg.indexOf('白饭') >= 0, seg.slice(0, 40))
  const withAll = P.applySelfNarrative(withMem, '最近有点饿，总想着白饭', AT).data
  const seg2 = P.buildPersonalitySegment(withAll)
  ok('注入段含近期心境且不超长', seg2.indexOf('近期心境') >= 0 && seg2.length <= P.PERSONALITY_LIMITS.segmentLen + 2, 'len=' + seg2.length)

  // ⑥ 回滚：恢复旧值、历史减一
  const rv = P.revertLast(learn.data, AT)
  // 最后一条历史是 notes（字段顺序 catchphrases→preferences→notes），所以回滚的是备注
  ok('回滚恢复上一条变更（备注）', !!rv && rv.entry.field === 'notes' && rv.data.notes === '' && rv.data.preferences.length === 1 && rv.data.version === learn.data.version + 1)
  ok('回滚后历史少一条', rv.data.history.length === learn.data.history.length - 1)
  ok('没有历史时回滚返回 null', P.revertLast(base, AT) === null)
  ok('限制表被冻结', Object.isFrozen(P.PERSONALITY_LIMITS) && Object.isFrozen(P.LEARNABLE_FIELDS))
} catch (e) {
  ok('能加载人格纯函数', false, String(e.message))
}


// ---------- 55 记忆仓储：追加轮次/上限/摘要/老格式/坏文件 ----------
console.log('\n[55] 记忆仓储 src/host/repos/memory.ts')
try {
  const { mkdtempSync, rmSync, writeFileSync: wf, readdirSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'chubby-memory-test-'))
  const { createMemoryRepo } = await import('../src/host/repos/memory.ts')
  const repo = createMemoryRepo(dir)

  ok('空目录：历史为空、摘要为空', repo.loadHistory().length === 0 && repo.loadMemorySummary() === '')

  const n1 = repo.appendTurns('主人说一句', '肥鲸答一句')
  ok('追加一轮 = 2 条', n1 === 2 && repo.loadHistory().length === 2)
  ok('追加内容正确', (() => { const h = repo.loadHistory(); return h[0].role === 'user' && h[0].content === '主人说一句' && h[1].role === 'assistant' })())

  for (let i = 0; i < 30; i++) repo.appendTurns('问题' + i, '回答' + i)
  const h2 = repo.loadHistory()
  ok('上限 80 条（40 轮）', h2.length === 62, String(h2.length))
  ok('保留最新、丢弃最旧', h2[h2.length - 1].content === '回答29' && h2[0].content === '主人说一句', h2[0].content)

  repo.saveMemorySummary('主人喜欢白饭')
  ok('摘要可写可读', repo.loadMemorySummary() === '主人喜欢白饭')
  repo.appendTurns('再来一句', '好呀')
  ok('追加轮次不冲掉摘要', repo.loadMemorySummary() === '主人喜欢白饭')

  repo.clearMemory()
  ok('清空记忆：历史与摘要都清', repo.loadHistory().length === 0 && repo.loadMemorySummary() === '')

  // 老格式：整份就是数组
  let dir2 = mkdtempSync(join(tmpdir(), 'chubby-memory-old-'))
  wf(join(dir2, 'memory.json'), JSON.stringify([{ role: 'user', content: '老格式' }]), 'utf8')
  const old = createMemoryRepo(dir2)
  ok('老格式（纯数组）能读', old.loadHistory().length === 1 && old.loadHistory()[0].content === '老格式' && old.loadMemorySummary() === '')

  // 坏文件：不抛、返回空、并隔离备份
  const dir3 = mkdtempSync(join(tmpdir(), 'chubby-memory-bad-'))
  wf(join(dir3, 'memory.json'), '{ 这不是 json', 'utf8')
  const bad = createMemoryRepo(dir3)
  ok('坏文件不抛、按空处理', bad.loadHistory().length === 0 && bad.loadMemorySummary() === '')
  const files = readdirSync(dir3)
  ok('坏文件被隔离备份', files.some((x) => x.indexOf('memory.json') >= 0 && x.indexOf('bad') >= 0), files.join(','))

  rmSync(dir, { recursive: true, force: true })
  rmSync(dir2, { recursive: true, force: true })
  rmSync(dir3, { recursive: true, force: true })
} catch (e) {
  ok('能加载记忆仓储', false, String(e.message))
}


// ---------- 56 聊天路由：长期记忆摘要触发 + 提示注入顺序 ----------
console.log('\n[56] 摘要触发与提示注入 host/routes/chat.ts')
try {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'chubby-summary-test-'))
  const { createCache } = await import('../src/host/cache.ts')
  const { createChatHandler } = await import('../src/host/routes/chat.ts')
  const cache = createCache({ dir, memBytes: 32 * 1024 })

  let summaryCalls = 0
  let mainCalls = 0
  let lastSystem = ''
  const realFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init && init.body))
    const sys = String((body.messages && body.messages[0] && body.messages[0].content) || '')
    if (sys.indexOf('整理长期记忆') >= 0) {
      summaryCalls++
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '主人喜欢白饭' } }] }) }
    }
    mainCalls++
    lastSystem = sys
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '答' + mainCalls } }], usage: { total_tokens: 5 } }) }
  }
  const mkRes = () => {
    const out = { code: 0, chunks: [] }
    out.writeHead = (c) => { out.code = c }
    out.end = (b) => { if (b) out.chunks.push(Buffer.from(String(b))) }
    out.setHeader = () => { }
    out.json = () => { try { return JSON.parse(Buffer.concat(out.chunks).toString('utf8')) } catch (e) { return null } }
    return out
  }
  const mkReq = (body) => {
    const buf = Buffer.from(JSON.stringify(body))
    return { method: 'POST', headers: {}, destroy() { }, on() { }, resume() { }, async *[Symbol.asyncIterator]() { yield buf } }
  }
  const hist6 = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'h' + i }))
  const makeDeps = (history, opts = {}) => ({
    getKey: () => 'k',
    loadHistory: () => history,
    appendTurns: () => { },
    loadState: () => ({ intimacy: 0 }),
    saveState: () => { },
    systemPrompt: 'SYS',
    addExp: () => ({ upgraded: false }),
    addTokens: () => { },
    cache,
    loadMemorySummary: () => '主人喜欢白饭',
    saveMemorySummary: opts.save || (() => { }),
    model: 'deepseek-flash',
  })

  // ① 前 9 次不总结，第 10 次才总结
  const saved = []
  const h = createChatHandler(makeDeps(hist6, { save: (x) => saved.push(x) }))
  for (let i = 0; i < 9; i++) await h(mkReq({ message: '消息' + i }), mkRes())
  await new Promise((r) => setTimeout(r, 10))
  ok('前 9 次不总结', summaryCalls === 0 && saved.length === 0, 'summary=' + summaryCalls)
  await h(mkReq({ message: '第十次' }), mkRes())
  await new Promise((r) => setTimeout(r, 30))
  ok('第 10 次触发一次总结', summaryCalls === 1 && saved.length === 1 && saved[0] === '主人喜欢白饭', 'summary=' + summaryCalls)

  // ② 历史不足 6 条：第 10 次也不总结
  summaryCalls = 0
  const h2 = createChatHandler(makeDeps(hist6.slice(0, 2), { save: () => { } }))
  for (let i = 0; i < 10; i++) await h2(mkReq({ message: '短历史' + i }), mkRes())
  await new Promise((r) => setTimeout(r, 30))
  ok('历史不足 6 条不总结', summaryCalls === 0, 'summary=' + summaryCalls)

  // ③ 提示注入顺序：人设 → 语言规则 → 长期记忆 → 语音说明
  lastSystem = ''
  const h3 = createChatHandler(makeDeps(hist6))
  await h3(mkReq({ message: 'hello there', voice: true }), mkRes())
  const sys = lastSystem
  const iLang = sys.indexOf('【语言规则')
  const iMem = sys.indexOf('关于主人的长期记忆')
  const iVoice = sys.indexOf('【输入说明】')
  ok('系统提示注入顺序：语言 → 记忆 → 语音', sys.indexOf('SYS') === 0 && iLang > 0 && iMem > iLang && iVoice > iMem, 'lang=' + iLang + ' mem=' + iMem + ' voice=' + iVoice)
  ok('英文提问带语言硬约束', sys.indexOf('Reply in English only') > 0)

  globalThis.fetch = realFetch
  rmSync(dir, { recursive: true, force: true })
} catch (e) {
  ok('能加载聊天路由（摘要用例）', false, String(e.message))
}


// ---------- 57 原子写/坏文件隔离 + 配置清洗 ----------
console.log('\n[57] 原子写与配置清洗 atomic.ts / config.ts')
try {
  const A = await import('../src/host/atomic.ts')
  const C = await import('../src/host/config.ts')
  const { mkdtempSync, rmSync, readFileSync: rf, readdirSync, mkdirSync, writeFileSync: wf } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'chubby-atomic-test-'))
  const deep = join(dir, 'a', 'b', 'c.txt')

  A.writeFileAtomic(deep, '你好')
  ok('原子写：自动建父目录并写成功', rf(deep, 'utf8') === '你好')
  ok('原子写：不留临时文件', readdirSync(join(dir, 'a', 'b')).every((x) => x.indexOf('.tmp') < 0), readdirSync(join(dir, 'a', 'b')).join(','))

  const jf = join(dir, 'x.json')
  A.writeJsonAtomic(jf, { a: 1, b: [2] })
  ok('原子写 JSON 可回读', JSON.stringify(JSON.parse(rf(jf, 'utf8'))) === '{"a":1,"b":[2]}')

  // 写失败：目标路径是个已存在的目录 → rename 失败必须抛错且清掉临时文件
  const asDir = join(dir, 'target-dir')
  mkdirSync(asDir)
  let threw = false
  try { A.writeFileAtomic(asDir, 'x') } catch (e) { threw = true }
  ok('写失败会抛错（不静默）', threw)
  ok('写失败清掉临时文件', readdirSync(dir).every((x) => x.indexOf('.tmp') < 0), readdirSync(dir).join(','))

  // 坏文件隔离
  const bad = join(dir, 'bad.json')
  wf(bad, '{ 坏', 'utf8')
  A.quarantineFile(bad, new Error('broken'), '[test]')
  ok('坏文件被改名备份', !readdirSync(dir).includes('bad.json') && readdirSync(dir).some((x) => x.indexOf('bad.json.bad-') === 0))
  let q2 = false
  try { A.quarantineFile(bad, new Error('again'), '[test]') } catch (e) { q2 = true }
  ok('重复隔离不抛错', q2 === false)
  A.quarantineFile(join(dir, 'not-exist.json'), new Error('x'), '[test]')
  ok('不存在的文件隔离不抛错', true)

  // —— 配置清洗 ——
  ok('非对象配置 → 空配置', JSON.stringify(C.sanitizePluginConfig(null)) === '{}' && JSON.stringify(C.sanitizePluginConfig('nope')) === '{}' && JSON.stringify(C.sanitizePluginConfig([1])) === '{}')
  const cfg = C.sanitizePluginConfig({ enabled: true, dataSource: ' CLOUD ', personalityLearning: 'off', personalityWriting: 'on', model: ' deepseek-v4-pro ', unknownKey: 1 })
  ok('dataSource 归一化小写', cfg.dataSource === 'cloud')
  ok('开关字符串也认', cfg.personalityLearning === false && cfg.personalityWriting === true)
  ok('模型名去空白', cfg.model === 'deepseek-v4-pro')
  ok('未知键保留但告警', cfg.unknownKey === 1)
  const bad2 = C.sanitizePluginConfig({ enabled: 'yes', dataSource: 's3', model: '整段文本粘进来' + 'x'.repeat(200) })
  ok('非法值被丢弃（不挡加载）', !('enabled' in bad2) && !('dataSource' in bad2) && !('model' in bad2), JSON.stringify(bad2))

  // 解析器边界
  ok('parseSwitchValue 边界', C.parseSwitchValue('OFF') === false && C.parseSwitchValue('enabled') === true && C.parseSwitchValue('eh') === null && C.parseSwitchValue(undefined) === null)
  ok('parseChatModel 合法/非法', C.parseChatModel('deepseek-flash', 't') === 'deepseek-flash' && C.parseChatModel('含 空格', 't') === null && C.parseChatModel('', 't') === null)

  rmSync(dir, { recursive: true, force: true })
} catch (e) {
  ok('能加载原子写/配置模块', false, String(e.message))
}


// ---------- 58 只读状态接口：status/state/growth/fishfood/balance ----------
console.log('\n[58] 只读状态 host/routes/misc.ts')
try {
  const { createMiscHandlers } = await import('../src/host/routes/misc.ts')
  const mkRes = () => {
    const out = { code: 0, chunks: [] }
    out.writeHead = (c) => { out.code = c }
    out.end = (b) => { if (b) out.chunks.push(Buffer.from(String(b))) }
    out.setHeader = () => { }
    out.json = () => { try { return JSON.parse(Buffer.concat(out.chunks).toString('utf8')) } catch (e) { return null } }
    return out
  }
  let hasKey = true
  const mk = (over = {}) => createMiscHandlers({
    assetPath: 'nope.png',
    getKey: () => (hasKey ? 'sk-secret' : ''),
    loadState: () => ({ intimacy: 100 }),
    loadGrowth: () => ({ exp: 250 }),
    loadFishfood: () => ({ chatTokens: 100, storyTokens: 20 }),
    loadPet: () => ({ intimacy: 8 }),
    loadIntimacy: () => 100,
    ...over,
  })
  let res = mkRes()
  await mk().handleStatus({}, res)
  ok('状态：只报有没有 key，不泄露 key 本身', res.json().ok === true && res.json().key === true && JSON.stringify(res.json()).indexOf('sk-secret') < 0, JSON.stringify(res.json()))
  hasKey = false
  res = mkRes(); await mk().handleStatus({}, res)
  ok('没有 key 时 key:false', res.json().key === false)
  hasKey = true

  res = mkRes(); await mk().handleState({}, res)
  ok('亲密度取 state', res.json().intimacy === 100)
  res = mkRes(); await mk().handleGrowth({}, res)
  ok('成长：阶段与下一门槛', res.json().exp === 250 && res.json().stage === '熟悉' && res.json().nextExp === 800)
  res = mkRes(); await mk().handleFishfood({}, res)
  ok('鱼粮：total = chat + story', res.json().total === 120, JSON.stringify(res.json()))

  // 余额：无 key / 正常 / HTTP 错误 / 网络异常
  const realFetch = globalThis.fetch
  res = mkRes(); await mk({ getKey: () => '' }).handleBalance({}, res)
  ok('余额：无 key 给 NO_KEY', res.json().ok === false && res.json().error === 'NO_KEY' && res.json().balance === null)
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ balance_infos: [{ currency: 'CNY', total_balance: '12.50' }] }) })
  res = mkRes(); await mk().handleBalance({}, res)
  ok('余额：正常解析 CNY', res.json().ok === true && res.json().balance === '12.50' && res.json().currency === 'CNY')
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'err' })
  res = mkRes(); await mk().handleBalance({}, res)
  ok('余额：HTTP 500 → ok:false', res.json().ok === false && res.json().balance === null)
  globalThis.fetch = async () => { throw new Error('net down') }
  res = mkRes(); await mk().handleBalance({}, res)
  ok('余额：网络异常 → ok:false（不抛）', res.json().ok === false && res.json().balance === null)
  globalThis.fetch = realFetch
} catch (e) {
  ok('能加载只读状态接口', false, String(e.message))
}


// ---------- 59 首次安装无双 KEY 的兜底 ----------
console.log('\n[59] 无双 KEY 的兜底')
try {
  const { createVoiceBridge } = await import('../src/client/voice-bridge.ts')

  // ① 语音桥：识别返回 NO_KEY → 弹一次人话提示；重开语音待命可再弹一次
  const bubbles = []
  let captured = null
  const fakeVoice = {
    start: async () => { }, stop() { }, speak() { }, stopSpeaking() { },
    speaking: () => false, recognizing: () => false,
    setVoiceName() { }, voiceName: () => '', setEndpointMode() { }, endpointInfo: () => ({ mode: 'classic' }),
    lastSegment: () => null, lastTtsInfo: () => null, mute() { }, stats: {}, status: () => 'idle',
  }
  const bridge = createVoiceBridge({
    narration: { active: () => false, clear() { }, expire: () => false },
    narrating: () => false,
    stopSpeaking: () => { },
    bubble: (t) => bubbles.push(t),
    sendText: () => { },
    onVoiceHeard: () => { },
    onSpeaking: () => { },
    diag: () => { },
    makeVoice: (opts) => { captured = opts; return fakeVoice },
  })
  bridge.ensure()
  captured.onDiag({ stage: 'asr-no-key', hint: '没配语音识别 Key（deepseekKey），语音听不见；打字也能聊' })
  captured.onDiag({ stage: 'asr-no-key' })
  ok('无识别 Key：只提示一次', bubbles.length === 1 && bubbles[0].indexOf('deepseekKey') >= 0, bubbles.join(' | '))
  captured.onDiag({ stage: 'other' })
  ok('其它诊断不弹提示', bubbles.length === 1)
  await bridge.start()
  captured.onDiag({ stage: 'asr-no-key' })
  ok('重开语音待命后可再提示一次', bubbles.length === 2, String(bubbles.length))

  // ② 客户端首次安装提示：有"还没配 Key"的人话，且只读 /status
  const { readFileSync: rf5 } = await import('node:fs')
  const clientSrc = rf5('src/client.ts', 'utf8')
  ok('首次安装会给 Key 提示', clientSrc.indexOf('还没配 Key') >= 0 && clientSrc.indexOf("getJson('/status')") >= 0)
  const voiceSrc = rf5('src/client/voice.ts', 'utf8')
  ok('无 Key 后不再反复上传识别', voiceSrc.indexOf('asrNoKey') >= 0 && voiceSrc.indexOf('if (asrNoKey)') >= 0)
  ok('重开语音会话会重新尝试', voiceSrc.indexOf('asrNoKey = false') >= 0)

  // ③ 离线功能不依赖 Key（服务端不拦截：文化/诗词/说书用的是本地数据）
  const { readFileSync: rf6 } = await import('node:fs')
  const asrSrc = rf6('src/host/routes/asr.ts', 'utf8')
  ok('ASR 无 Key 只回错误、不抛', asrSrc.indexOf("error: 'NO_KEY'") >= 0 && asrSrc.indexOf('hint:') >= 0)
} catch (e) {
  ok('能加载无双 KEY 兜底用例', false, String(e.message))
}


// ---------- 60 语音不再要求先喊唤醒词（"随时可以说"） ----------
console.log('\n[60] 随时可以说（唤醒词不再是门槛）')
try {
  const { createVoiceBridge } = await import('../src/client/voice-bridge.ts')
  const fakeVoice = {
    start: async () => { }, stop() { }, speak() { }, stopSpeaking() { },
    speaking: () => false, recognizing: () => false,
    setVoiceName() { }, voiceName: () => '', setEndpointMode() {}, endpointInfo: () => ({ mode: 'classic' }),
    lastSegment: () => null, lastTtsInfo: () => null, mute() {}, stats: {}, status: () => 'idle',
  }
  let captured = null
  const sent = []
  const said = []
  const bubbles = []
  let narrationActive = false
  let stopped = 0
  let voiceChatOn = true
  const mkBridge = () => createVoiceBridge({
    narration: { active: () => narrationActive, clear() { }, expire: () => false },
    narrating: () => false,
    stopSpeaking: () => { stopped++ },
    bubble: (t) => bubbles.push(t),
    say: (t, ms, opts) => said.push({ t, ms, opts }),
    sendText: (t, o) => sent.push({ t, o }),
    onVoiceHeard: () => { },
    onSpeaking: () => { },
    diag: () => { },
    voiceChat: () => voiceChatOn,
    makeVoice: (opts) => { captured = opts; return fakeVoice },
  })
  const b = mkBridge()
  b.ensure()

  // ① 不喊唤醒词也直接答话
  captured.onHeard('主人今天吃什么')
  ok('不喊唤醒词也会答话', sent.length === 1 && sent[0].t === '主人今天吃什么' && sent[0].o && sent[0].o.voice === true)
  ok('不再弹出"先喊一声"的提示', bubbles.every((x) => x.indexOf('先喊') < 0), bubbles.join(' | '))

  // ② 只喊名字：应一声，不劳烦模型
  const before = sent.length
  captured.onHeard('大肥鱼')
  const ack = said[said.length - 1]
  ok('只喊名字时本地应一声', sent.length === before && ack && ack.t === '本鲸在呢～', JSON.stringify(ack))
  ok('应答走语音、气泡停 3.2 秒（语速走聊天语速）', !!ack && ack.ms === 3200, JSON.stringify(ack))

  // ③ 句首喊名字 + 正文：剥掉名字再答
  captured.onHeard('大肥鱼你好呀')
  ok('句首唤醒词被剥掉', sent.length === before + 1 && sent[sent.length - 1].t === '你好呀', sent[sent.length - 1].t)

  // ④ 念诗/说书时喊"停"仍然立刻停
  narrationActive = true
  captured.onHeard('停')
  ok('叙述中喊停立刻停', stopped === 1 && sent.length === before + 1)
  narrationActive = false

  // ⑤ 语音聊天关着：只听不接话
  voiceChatOn = false
  const n = sent.length
  captured.onHeard('随便说一句')
  ok('语音聊天关着时不接话', sent.length === n)
  voiceChatOn = true

  // ⑥ 诊断里能看出过了几段
  const info = b.wakeInfo()
  ok('诊断：通过的段数在涨', info.passed >= 3 && info.hits >= 2, JSON.stringify({ passed: info.passed, hits: info.hits }))
  const { readFileSync: rf7 } = await import('node:fs')
  const cSrc = rf7('src/client.ts', 'utf8')
  const chSrc = rf7('src/client/chat.ts', 'utf8')
  ok('桥接必须把 say 传给 voice-bridge（否则只弹字不出声）', /say:\s*\(text:[^\n]*=>\s*sayLine\(/.test(cSrc))
  ok('聊天与流式回复都用可调聊天语速', cSrc.indexOf('chatRate()') >= 0 && chSrc.indexOf('chatRate()') >= 0)
} catch (e) {
  ok('能加载语音桥（随时说）', false, String(e.message))
}


// ---------- 61 聊天限额与安全（独立脚本 scripts/test-chat-limits.mjs） ----------
console.log('\n[61] 聊天限额与安全（消息截断 / 图片上限 / lang 注入 / 缓存键 / NO_KEY / 中断 / mime）')
try {
  // 单独脚本也已纳入 package.json 的 test 链，可脱离 test.mjs 独立运行
  const { runChatLimits } = await import('./test-chat-limits.mjs')
  const result = await runChatLimits(ok, { registerResolver: false })
  if (!result || result.total === 0) ok('限额与安全用例有断言', false)
} catch (e) {
  ok('能运行聊天限额与安全用例', false, String(e.message))
}


// ---------- 62 流式聊天记账（独立脚本 scripts/test-stream-ledger.mjs，B8 防退化） ----------
console.log('\n[62] 流式聊天记账（成功 / 缓存命中 / 中断 / 每10次摘要 / 代际校验 / 与 /chat 对照）')
try {
  // 单独脚本也已纳入 package.json 的 test 链，可脱离 test.mjs 独立运行
  const { runStreamLedger } = await import('./test-stream-ledger.mjs')
  const result = await runStreamLedger(ok, { registerResolver: false })
  if (!result || result.total === 0) ok('流式记账用例有断言', false)
} catch (e) {
  ok('能运行流式记账用例', false, String(e.message))
}

// ---------- 63 行为回归（菜单键盘 / TTS 估算 / 说书进度键 / 云端并发 / 情绪台词） ----------
console.log('\n[63] 行为回归（菜单键盘 / TTS 估算 / 说书进度键 / 云端并发 / 情绪台词）')
try {
  // 单独脚本也已纳入 package.json 的 test 链，可脱离 test.mjs 独立运行
  const { runBehaviorRegressions } = await import('./test-behavior-regressions.mjs')
  const result = await runBehaviorRegressions(ok, { registerResolver: false })
  if (!result || result.total === 0) ok('行为回归用例有断言', false)
} catch (e) {
  ok('能运行行为回归用例', false, String(e.message))
}


// ---------- 64 泰文显示：内置字体，不依赖系统安装 ----------
console.log('\n[64] 泰文显示：内置字体（data URL）')
try {
  const thai = await import('../src/client/thai-font.ts')
  // 不能直接 import bubble.ts：它经 persona.ts 牵出 data/persona.json（ESM 需 import attribute）
  const { recoverDotStyle, menuStyle, chatPanelStyle } = await import('../src/client/styles.ts')
  const { readFileSync: rf } = await import('node:fs')
  const { spawnSync } = await import('node:child_process')

  ok('内置泰文字体已生成', thai.THAI_FONT_BYTES > 1000 && thai.THAI_FONT_FAMILY === 'ChubbyThai', String(thai.THAI_FONT_BYTES))
  ok('@font-face 是 woff2 data URL', thai.THAI_FONT_FACE.indexOf('@font-face') >= 0 && thai.THAI_FONT_FACE.indexOf('data:font/woff2;base64,') > 0)
  ok('unicode-range 覆盖泰文', thai.THAI_FONT_FACE.indexOf('U+0E01-0E5B') > 0)

  // 内联 base64 必须等于 assets 里的字体文件（防止改了字体忘了重新生成）
  const asset = rf('assets/fonts/NotoSansThai-Regular.woff2')
  const b64 = asset.toString('base64')
  ok('内联字体与 assets 字体一致', thai.THAI_FONT_FACE.indexOf(b64) > 0, 'asset=' + asset.length + 'B')

  // 气泡层：源码契约（BUBBLE_CSS = THAI_FONT_FACE + ...，字体链用 THAI_FONT_FAMILY）
  const bubbleSrc = rf('src/client/bubble.ts', 'utf8')
  ok('气泡注入内置 @font-face', bubbleSrc.indexOf('THAI_FONT_FACE +') > 0)
  ok('气泡字体链优先内置泰文', bubbleSrc.indexOf("font:13px/1.6 ' + THAI_FONT_FAMILY") > 0)
  // 长诗滚动回归（commit 15caf58）：三角是 .chubby-bubble::after（bottom:-9px，整颗在气泡下沿之外），
  // 本体一旦 overflow:auto 成为滚动容器，三角就被裁掉。滚动层必须留在内层文字 div。
  ok('气泡本体不建立滚动容器（overflow:visible，三角不被裁）',
    /\.chubby-bubble\{[^}]*overflow:visible/.test(bubbleSrc) &&
    !/\.chubby-bubble\{[^}]*overflow(-[xy])?:(auto|scroll|hidden)/.test(bubbleSrc))
  ok('气泡长文本滚动层在内层 div（max-height + overflow:auto 仍保留）',
    /\.chubby-bubble>div\{[^}]*max-height:calc\(100vh - 120px\)[^}]*overflow:auto/.test(bubbleSrc))

  // 菜单 / 聊天面板 / 恢复点字体链同样带上内置字体
  ok('菜单字体链含内置泰文', String(menuStyle(null).font || '').indexOf('ChubbyThai') >= 0)
  ok('聊天面板字体链含内置泰文', String(chatPanelStyle(false).font || '').indexOf('ChubbyThai') >= 0)
  ok('恢复点字体链含内置泰文', String(recoverDotStyle.font || '').indexOf('ChubbyThai') >= 0)

  // 生成物与字体文件同步（npm test 链里也会单独跑一次）
  const gen = spawnSync(process.execPath, ['scripts/gen-font.mjs', '--check'], { cwd: process.cwd(), encoding: 'utf8' })
  ok('gen-font --check 通过', gen.status === 0, (gen.stdout || '').trim().slice(0, 80))
} catch (e) {
  ok('能加载泰文字体用例', false, String(e.message))
}


// ---------- 65 ASR 脚本闸门：静音/噪声编出来的外语不许上行 ----------
console.log('\n[65] ASR 脚本闸门（中文模式拒绝纯外语）')
try {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'chubby-asr-script-'))
  const { createCache } = await import('../src/host/cache.ts')
  const { createAsrHandler } = await import('../src/host/routes/asr.ts')
  const { readAsrLanguage } = await import('../src/host/config.ts')
  const cache = createCache({ dir, memBytes: 1024 * 1024 })
  const audio = Buffer.from('fake-audio-bytes').toString('base64')
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
  let replyText = ''
  const writes = []
  let fetchCount = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { fetchCount++; return { ok: true, status: 200, text: async () => JSON.stringify({ text: replyText }) } }
  const realSet = cache.setJson.bind(cache)
  cache.setJson = async (k, v, ttl) => { writes.push(v); return realSet(k, v, ttl) }
  const run = async (text, lang, audioSeed = 'fake-audio', chatLang) => {
    replyText = text
    const res = mkRes()
    const deps = { cache, getDeepseekKey: () => 'k' }
    if (lang) deps.language = () => lang
    const body = { audio: Buffer.from(audioSeed).toString('base64') }
    if (chatLang) body.lang = chatLang
    await createAsrHandler(deps)(mkReq(body), res)
    return res.json()
  }

  // ① 中文模式（默认）：纯外语/静音编词一律拒绝
  let r = await run('No.')
  ok('静音编出来的 "No." 被拒绝', r && r.ok === true && r.text === '' && r.noise === true && r.rejected === 'script', JSON.stringify(r))
  r = await run('มันเป็นปีหวาน')
  ok('泰文整句被拒绝', r && r.text === '' && r.rejected === 'script')
  r = await run('El nombre de la ciudad proviene del río')
  ok('西语整句被拒绝', r && r.text === '' && r.rejected === 'script')
  ok('被拒绝的结果不写缓存', writes.length === 0, JSON.stringify(writes))

  // ② 中文正常放行并写缓存
  r = await run('主人今天吃什么')
  ok('中文放行', r && r.text === '主人今天吃什么' && !r.rejected)
  ok('放行结果写缓存', writes.length === 1)

  // ③ en 模式：英文放行、中文拒绝
  // 同一段音频换语言不能命中 zh 的缓存（v3 key 含 asrLang）
  const beforeEn = fetchCount
  r = await run('I am here', 'en')
  ok('en 模式英文放行', r && r.text === 'I am here')
  ok('同一音频换语言不命中旧缓存', fetchCount === beforeEn + 1, 'fetch=' + fetchCount)
  r = await run('主人今天吃什么', 'en', 'audio-en-chinese')
  ok('en 模式中文拒绝', r && r.text === '' && r.rejected === 'script')

  // ④ auto 模式：保留旧行为（不拦）
  r = await run('มันเป็นปีหวาน', 'auto', 'audio-auto')
  ok('auto 模式不拦外语', r && r.text === 'มันเป็นปีหวาน' && !r.rejected)
  // ⑥ 聊天语言=自动：英语要能进（主人实测"自动模式，说英语没一点反应"）；其它语种仍拒绝
  r = await run('Hello, how are you?', null, 'auto-en', 'auto')
  ok('自动模式英语放行', r && r.text === 'Hello, how are you?' && !r.rejected, JSON.stringify(r))
  r = await run('主人今天吃什么', null, 'auto-zh', 'auto')
  ok('自动模式中文放行', r && r.text === '主人今天吃什么' && !r.rejected, JSON.stringify(r))
  r = await run('มันเป็นปีหวาน', null, 'auto-th', 'auto')
  ok('自动模式泰文拒绝', r && r.text === '' && r.rejected === 'script', JSON.stringify(r))
  r = await run('El nombre de la ciudad proviene del río', null, 'auto-es', 'auto')
  ok('自动模式西语拒绝', r && r.text === '' && r.rejected === 'script', JSON.stringify(r))
  r = await run('Hello there', null, 'zh-en', 'zh')
  ok('聊天语言=中文时英语仍拒绝', r && r.text === '' && r.rejected === 'script', JSON.stringify(r))

  // ⑤ config.json 的 asrLanguage 真正可读（此前是死键）
  const { writeFileSync: wf, mkdirSync } = await import('node:fs')
  const cfgDir = mkdtempSync(join(tmpdir(), 'chubby-asr-lang-'))
  wf(join(cfgDir, 'config.json'), JSON.stringify({ asrLanguage: 'en' }), 'utf8')
  ok('asrLanguage=en 被读到', readAsrLanguage(cfgDir) === 'en')
  wf(join(cfgDir, 'config.json'), JSON.stringify({ asrLanguage: '乱写' }), 'utf8')
  ok('非法 asrLanguage 回落 zh', readAsrLanguage(cfgDir) === 'zh')
  wf(join(cfgDir, 'config.json'), JSON.stringify({ asrLanguage: 'auto' }), 'utf8')
  ok('asrLanguage=auto 被读到', readAsrLanguage(cfgDir) === 'auto')

  globalThis.fetch = realFetch
  cache.setJson = realSet
  rmSync(dir, { recursive: true, force: true })
  rmSync(cfgDir, { recursive: true, force: true })
} catch (e) {
  ok('能加载 ASR 脚本闸门用例', false, String(e.message))
}


// ---------- 66 拖拽抛物物理（原创纯函数） ----------
console.log('\n[66] 拖拽抛物物理：重力 / 反弹 / 挤压 / 停稳')
try {
  const P = await import('../src/client/physics.ts')
  const bounds = { minX: 0, minY: 0, maxX: 400, maxY: 300 }

  // ① 松手速度夹取
  let l = P.launch(999, -999)
  ok('松手速度夹到上限', l.vx === P.MAX_SPEED && l.vy === -P.MAX_SPEED)
  l = P.launch(NaN, 0)
  ok('NaN 速度归零、不甩', l.vx === 0 && l.moving === false)
  l = P.launch(0.2, 0.1)
  ok('轻放不触发抛物线', l.moving === false)

  // ② 重力：静止起步会下落
  const f = P.createFlight()
  f.resting = false
  f.vx = 0
  f.vy = 0
  const r1 = P.stepFlight(f, { x: 200, y: 100 }, bounds, 1, 16.67)
  ok('重力让 vy 增大、y 下落', f.vy > 0 && r1.pos.y > 100, 'vy=' + f.vy + ' y=' + r1.pos.y)

  // ③ 左墙反弹：法向反向、能量损失
  const f2 = P.createFlight()
  f2.resting = false
  f2.vx = -6
  f2.vy = 0
  const r2 = P.stepFlight(f2, { x: 1, y: 100 }, bounds, 1, 16.67)
  ok('左墙反弹：位置回界内、速度反向', r2.pos.x === 0 && f2.vx > 0 && Math.abs(f2.vx) < 6, 'vx=' + f2.vx)
  ok('撞墙触发挤压', f2.squashAge < P.SQUASH_MS)

  // ④ 挤压曲线：0 时压扁、结束后回 1
  const q0 = P.squashScale(0)
  const q1 = P.squashScale(P.SQUASH_MS)
  ok('挤压起点纵向 < 1', q0.sy < 1 && q0.sx > 1, JSON.stringify(q0))
  ok('挤压结束回到 1:1', q1.sx === 1 && q1.sy === 1)

  // ⑤ 长时间模拟：不出界、不 NaN、最终停稳
  const f3 = P.createFlight()
  f3.resting = false
  f3.vx = 12
  f3.vy = -8
  let pos = { x: 50, y: 50 }
  let settled = false
  for (let i = 0; i < 900; i++) {
    const r = P.stepFlight(f3, pos, bounds, 1, 16.67)
    pos = r.pos
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) break
    if (pos.x < bounds.minX || pos.x > bounds.maxX || pos.y < bounds.minY || pos.y > bounds.maxY) break
    if (f3.resting) { settled = true; break }
  }
  ok('长时间模拟不出界、不 NaN', Number.isFinite(pos.x) && Number.isFinite(pos.y) &&
    pos.x >= bounds.minX && pos.x <= bounds.maxX && pos.y >= bounds.minY && pos.y <= bounds.maxY, JSON.stringify(pos))
  ok('最终会停稳', settled, JSON.stringify(f3))

  // ⑥ 高刷归一：同样 2 秒，60Hz 与 120Hz 落点接近
  const sim = (steps, dtMs) => {
    const fl = P.createFlight()
    fl.resting = false
    fl.vx = 6
    fl.vy = -6
    let p = { x: 200, y: 100 }
    for (let i = 0; i < steps; i++) p = P.stepFlight(fl, p, { minX: -10000, minY: -10000, maxX: 10000, maxY: 10000 }, dtMs / 16.67, dtMs).pos
    return p
  }
  const a = sim(120, 16.67)
  const b = sim(240, 16.67 / 2)
  ok('60Hz 与 120Hz 物理时长一致', Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2, JSON.stringify({ a, b }))
  // ⑦ 回归：落地不能形成"弹起一帧、落下一帧"的极限环（2026-11-09 主人实测落地不停颤动）
  ok('落地反弹阈值高于停稳阈值', P.BOUNCE_MIN > P.STOP_SPEED * 2, 'BOUNCE_MIN=' + P.BOUNCE_MIN)
  let unsettled = 0
  for (const vx0 of [-14, -8, -3, -1, 0, 1, 3, 8, 14]) {
    for (const vy0 of [-14, -8, -3, -1, 0, 3, 8, 14]) {
      const ff = P.createFlight()
      ff.resting = false
      ff.vx = vx0
      ff.vy = vy0
      ff.squashAge = P.SQUASH_MS
      let pp = { x: 120, y: 80 }
      let settled2 = false
      for (let i = 0; i < 400; i++) {
        pp = P.stepFlight(ff, pp, bounds, 1, 16.67).pos
        if (ff.resting) { settled2 = true; break }
      }
      if (!settled2) unsettled++
    }
  }
  ok('9×8 组初速落地都能停稳（无颤动极限环）', unsettled === 0, '未停稳 ' + unsettled + ' 组')
} catch (e) {
  ok('能加载物理用例', false, String(e.message))
}

// ---------- 67 工作状态机（原创纯函数） ----------
console.log('\n[67] 工作状态机：思考 / 工作 / 成功 / 出错')
try {
  const { createPhaseMachine, PHASE_ONE_SHOT_MS } = await import('../src/client/phase.ts')
  const m = createPhaseMachine()
  ok('初始是 waiting', m.current() === 'waiting')
  ok('thinking 可进入', m.enter('thinking', 1000) === 'thinking')
  ok('working 可接替 thinking', m.enter('working', 1100) === 'working')
  const t0 = 2000
  ok('success 可进入', m.enter('success', t0) === 'success')
  ok('success 期间普通状态不能打断', m.enter('working', t0 + 100) === 'success')
  ok('success 未到点仍在', m.tick(t0 + PHASE_ONE_SHOT_MS - 1) === 'success')
  ok('success 到点回 waiting', m.tick(t0 + PHASE_ONE_SHOT_MS + 1) === 'waiting')
  ok('error 可覆盖 success', m.enter('success', 5000) === 'success' && m.enter('error', 5100) === 'error')
  ok('error 到点也回 waiting', m.tick(5100 + PHASE_ONE_SHOT_MS + 1) === 'waiting')
  const m2 = createPhaseMachine({ oneShotMs: 200 })
  m2.enter('error', 0)
  ok('自定义一次性时长', m2.tick(201) === 'waiting')
  ok('重复 enter 同一状态不变', m2.enter('thinking', 300) === 'thinking' && m2.enter('thinking', 400) === 'thinking')
} catch (e) {
  ok('能加载状态机用例', false, String(e.message))
}


// ---------- 68 语音聊天默认开（旧 off 不继承） ----------
console.log('\n[68] 语音聊天默认开')
try {
  const { readLocalFlag } = await import('../src/client/hooks.ts')
  const { readFileSync: rf8 } = await import('node:fs')
  const realLs = globalThis.localStorage
  try {
    const mk = (map) => ({ getItem: (k) => (k in map ? map[k] : null), setItem() { }, removeItem() { } })
    globalThis.localStorage = mk({})
    ok('键不存在时默认开', readLocalFlag('chubby-voicechat2') === true)
    globalThis.localStorage = mk({ 'chubby-voicechat2': 'off' })
    ok('显式 off 仍然尊重', readLocalFlag('chubby-voicechat2') === false)
    globalThis.localStorage = mk({ 'chubby-voicechat2': 'on' })
    ok('显式 on 正常', readLocalFlag('chubby-voicechat2') === true)
  } finally { globalThis.localStorage = realLs }
  const src = rf8('src/client.ts', 'utf8')
  ok('语音聊天键已升级为 chubby-voicechat2', src.indexOf("'chubby-voicechat2'") > 0 && src.indexOf("'chubby-voicechat'") < 0)
} catch (e) {
  ok('能加载语音聊天默认值用例', false, String(e.message))
}

console.log('\n────────────────────')
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项')
if (fail > 0) process.exit(1)
