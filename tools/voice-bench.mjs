/**
 * tools/voice-bench.mjs —— 语音链路耗时实测（对运行中的实例）
 *
 * 默认只做两件免费的事：
 *   · GET  /status            插件是否在线、模型/数据源
 *   · POST /tts（--fresh）    真合成一段（edge-tts 免费）
 * 需要测"首字耗时"时加 --chat（会消耗少量聊天额度，默认不跑）。
 *
 * 用法：
 *   node tools/voice-bench.mjs                 # 只测 /status + /tts
 *   node tools/voice-bench.mjs --chat          # 额外测 /chat-stream 首字与总耗时（花 token）
 *   node tools/voice-bench.mjs --port 3150     # 临时实例
 *
 * 说明：不调用 /asr（需要真实音频且会消耗识别额度）；不写任何数据文件。
 */

const args = process.argv.slice(2)
const has = (n) => args.indexOf('--' + n) >= 0
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d }
const PORT = Number(arg('port', '3080'))
const HOST = arg('host', '127.0.0.1')
const BASE = 'http://' + HOST + ':' + PORT + '/api/chubby-whale'
const WITH_CHAT = has('chat')

const t0 = () => Date.now()
const ms = (a) => String(a).padStart(5) + 'ms'

async function status() {
  const s = t0()
  try {
    const r = await fetch(BASE + '/status')
    const j = await r.json()
    return { ok: true, ms: t0() - s, json: j }
  } catch (err) {
    return { ok: false, ms: t0() - s, detail: String((err && err.message) || err) }
  }
}

async function tts(text) {
  const s = t0()
  const r = await fetch(BASE + '/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, rate: '-25%' }),
  })
  const buf = Buffer.from(await r.arrayBuffer())
  return { ok: r.ok, ms: t0() - s, bytes: buf.length }
}

async function chatStream(message) {
  const s = t0()
  let firstDeltaAt = 0
  let reply = ''
  const r = await fetch(BASE + '/chat-stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, voice: true }),
  })
  if (!r.ok || !r.body) return { ok: false, ms: t0() - s, detail: 'HTTP ' + r.status }
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const parts = buf.split('\n\n')
    buf = parts.pop() || ''
    for (const part of parts) {
      const line = part.trim()
      if (!line.startsWith('data:')) continue
      let ev = null
      try { ev = JSON.parse(line.slice(5).trim()) } catch (e) { continue }
      if (typeof ev.delta === 'string' && ev.delta) {
        if (!firstDeltaAt) firstDeltaAt = t0()
        reply += ev.delta
      }
      if (ev.done) {
        return { ok: true, ms: t0() - s, firstDeltaMs: firstDeltaAt ? firstDeltaAt - s : 0, reply, cached: !!ev.cached }
      }
      if (ev.error) return { ok: false, ms: t0() - s, detail: ev.error }
    }
  }
  return { ok: true, ms: t0() - s, firstDeltaMs: firstDeltaAt ? firstDeltaAt - s : 0, reply }
}

const lines = []
const st = await status()
if (!st.ok) {
  console.log('  ❌ /status 不通：' + st.detail)
  console.log('  提示：确认 dsh web 在跑、端口对（默认 3080）')
  process.exit(1)
}
console.log('  实例：' + BASE)
console.log('  状态：' + ms(st.ms) + '  插件 ' + (st.json.name || '?') + ' ｜ Key 就绪 ' + (st.json.key ? '是' : '否'))
lines.push('status ' + st.ms + 'ms')

const t1 = await tts('寒蝉凄切，对长亭晚，骤雨初歇。第' + String(Date.now()).slice(-3) + '次')
console.log('  TTS 真合成：' + ms(t1.ms) + '  ' + t1.bytes + 'B')
lines.push('tts ' + t1.ms + 'ms')

if (WITH_CHAT) {
  const c = await chatStream('你好呀，随便说一句')
  if (!c.ok) console.log('  ❌ /chat-stream：' + c.detail)
  else {
    console.log('  聊天首字：' + ms(c.firstDeltaMs) + ' ｜ 整段：' + ms(c.ms) + ' ｜ 缓存：' + (c.cached ? '是' : '否') + ' ｜ 回复：' + c.reply.slice(0, 12) + '…')
    lines.push('chat-first ' + c.firstDeltaMs + 'ms')
    if (c.firstDeltaMs > 0) {
      const est = c.firstDeltaMs + t1.ms
      console.log('  首音频粗估：' + est + 'ms（首字 + TTS 首段合成，不含播放器启动）')
      lines.push('first-audio≈' + est + 'ms')
    }
  }
} else {
  console.log('  跳过聊天首字（加 --chat 才测，会消耗少量额度）')
}

console.log('\n  测点：' + lines.join(' ｜ '))
