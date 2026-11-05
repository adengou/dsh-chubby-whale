/**
 * tools/tts-bench.mjs —— TTS 合成耗时实测（对运行中的实例，只合成、不占用 ASR/聊天额度）
 *
 * 用途：改完 TTS 相关代码后，重启前后各跑一次，用同一组文本对比：
 *   · 冷启动第一次（能否命中常驻 worker）
 *   · 相同文本第二次（应命中缓存，毫秒级）
 *   · 不同文本三次（模拟一段连续朗读的分段合成）
 *
 * 用法：
 *   node tools/tts-bench.mjs                 # 默认 http://127.0.0.1:3080
 *   node tools/tts-bench.mjs --port 3150     # 指定端口（临时实例）
 *   node tools/tts-bench.mjs --voice zh-CN-XiaoxiaoNeural
 *   node tools/tts-bench.mjs --fresh   # 每段加唯一后缀，绕开缓存测真合成
 *
 * 说明：只调用 /api/chubby-whale/tts，不写任何数据文件；音频不落盘。
 */

const args = process.argv.slice(2)
const getArg = (name, def) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const PORT = Number(getArg('port', '3080'))
const HOST = getArg('host', '127.0.0.1')
const VOICE = getArg('voice', '')
const URL_TTS = 'http://' + HOST + ':' + PORT + '/api/chubby-whale/tts'
// --fresh：给每段加一个唯一后缀，绕开缓存，测"真合成"耗时（默认测到的多半是缓存命中）
const FRESH = args.indexOf('--fresh') >= 0
const NONCE = FRESH ? '，第' + Date.now().toString().slice(-4) + '次' : ''

const SEGMENTS = [
  '寒蝉凄切，对长亭晚，骤雨初歇。',
  '都门帐饮无绪，留恋处、兰舟催发。',
  '执手相看泪眼，竟无语凝噎。',
]

async function synth(text, extra = {}) {
  const started = Date.now()
  try {
    const r = await fetch(URL_TTS, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ text, rate: '-25%' }, VOICE ? { voice: VOICE } : {}, extra)),
    })
    const ms = Date.now() - started
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      return { ok: false, ms, status: r.status, detail: body.slice(0, 120) }
    }
    const buf = Buffer.from(await r.arrayBuffer())
    // MP3 判定：ID3 头，或 MPEG 帧同步（0xFF 后高 3 位全 1，edge-tts 常见 fff3/fffb）
    const head = buf.subarray(0, 2)
    const mp3 = (buf.length >= 3 && buf.subarray(0, 3).toString('latin1') === 'ID3') || (head.length === 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0)
    return { ok: true, ms, bytes: buf.length, mp3 }
  } catch (err) {
    return { ok: false, ms: Date.now() - started, status: 0, detail: String((err && err.message) || err) }
  }
}

function line(name, r) {
  const head = name.padEnd(18)
  if (!r.ok) return head + String(r.ms).padStart(6) + 'ms  ❌ ' + (r.status ? 'HTTP ' + r.status + ' ' : '') + (r.detail || '')
  return head + String(r.ms).padStart(6) + 'ms  ' + String(r.bytes).padStart(6) + 'B' + (r.mp3 ? '  mp3✓' : '  ⚠️不是mp3')
}

console.log('  TTS 实测：' + URL_TTS + (VOICE ? '  voice=' + VOICE : ''))
const results = []
for (let i = 0; i < SEGMENTS.length; i++) {
  const r = await synth(SEGMENTS[i] + NONCE)
  results.push(r)
  console.log('  ' + line('第 ' + (i + 1) + ' 段', r))
}
const again = await synth(SEGMENTS[0])
console.log('  ' + line('第 1 段(再合成)', again) + '   ← 同文本第二次应命中缓存')
const okList = results.filter((r) => r.ok)
if (okList.length === 0) {
  console.error('\n  ❌ 全部失败：检查 dsh 是否在跑、edge-tts 是否可用')
  process.exit(1)
}
const first = results[0].ms
const rest = okList.slice(1).map((r) => r.ms)
const avgRest = rest.length ? Math.round(rest.reduce((a, b) => a + b, 0) / rest.length) : 0
console.log('\n  首次 ' + first + 'ms ｜ 后续均值 ' + avgRest + 'ms ｜ 缓存命中 ' + again.ms + 'ms')
if (FRESH) {
  const gap = first - avgRest
  console.log('  判读（--fresh 绕缓存）：真合成耗时 ' + first + '~' + avgRest + 'ms，首段比后续多 ' + gap + 'ms' + (gap > 1000 ? '（首次明显更慢，冷启动成本高）' : '（差距 <1s）'))
} else {
  console.log('  判读（默认）：数字偏小说明命中了缓存；要测真合成请加 --fresh')
}
