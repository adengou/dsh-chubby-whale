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

console.log('\n────────────────────')
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项')
if (fail > 0) process.exit(1)
