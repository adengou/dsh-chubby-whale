/**
 * scripts/midi-to-melody.mjs —— 把公有领域 MIDI 转成插件用的旋律 JSON
 *
 * 为什么要脚本而不是手抄：手抄会错音（"宁可少不可错"）。
 * 这里只做机械转换，每一步都能复核：
 *   ① 解析 MIDI 头与轨道（format 1，division=每拍 tick 数）
 *   ② 收集 note-on / note-off，算出每个音的起始 tick 与时长
 *   ③ 取「旋律声部」：右手里音高最高的一路（本曲右手旋律，左手是伴奏）
 *   ④ 量化到 0.25 拍，音名映射 C3..B6（插件 NOTE_FREQ 覆盖 C3–E6）
 *   ⑤ 输出 [{name, bpm, notes:[[音名, 拍数], ...]}]，休止写 "R"
 *
 * 用法：node scripts/midi-to-melody.mjs <in.mid> [--track=1] [--max-seconds=60] [--json]
 */
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
if (!file) { console.error('用法: node midi-to-melody.mjs <in.mid> [--track=1] [--max-seconds=60]'); process.exit(1) }
const opt = (name, dflt) => {
  const hit = args.find((a) => a.startsWith('--' + name + '='))
  return hit ? hit.split('=')[1] : dflt
}
const trackFilter = opt('track', '')
const maxSeconds = Number(opt('max-seconds', '0'))
const asJson = args.includes('--json')

const buf = readFileSync(file)
if (buf.toString('ascii', 0, 4) !== 'MThd') { console.error('不是 MIDI 文件'); process.exit(1) }
const headerLen = buf.readUInt32BE(4)
const division = buf.readUInt16BE(12)

/** 读变长数（VLQ） */
function readVLQ(b, i) {
  let v = 0
  for (let n = 0; n < 4; n++) {
    const byte = b[i++]
    v = (v << 7) | (byte & 0x7f)
    if (!(byte & 0x80)) break
  }
  return [v, i]
}

/** 解析一条轨道，返回 [{tick, pitch, durTick, vel}] */
function parseTrack(b, start, end) {
  const notes = []
  const active = new Map()   // pitch -> [{tick, vel}]
  let i = start
  let tick = 0
  let running = 0
  while (i < end) {
    const [delta, ni] = readVLQ(b, i)
    i = ni
    tick += delta
    let status = b[i]
    if (status & 0x80) { i++; if (status < 0xf0) running = status }
    else { status = running }
    const type = status & 0xf0
    const ch = status & 0x0f
    if (status === 0xff) {          // meta
      const metaType = b[i++]
      const [len, li] = readVLQ(b, i)
      i = li + len
      if (metaType === 0x2f) break  // end of track
      continue
    }
    if (status === 0xf0 || status === 0xf7) { const [len, li] = readVLQ(b, i); i = li + len; continue }
    if (type === 0x90 && b[i + 1] > 0) {
      const pitch = b[i]; const vel = b[i + 1]; i += 2
      if (!active.has(pitch)) active.set(pitch, [])
      active.get(pitch).push({ tick, vel })
      continue
    }
    if (type === 0x80 || (type === 0x90 && b[i + 1] === 0)) {
      const pitch = b[i]; i += 2
      const q = active.get(pitch)
      if (q && q.length) { const on = q.shift(); notes.push({ tick: on.tick, pitch, durTick: tick - on.tick, vel: on.vel }) }
      continue
    }
    if (type === 0xc0 || type === 0xd0) { i += 1; continue }
    if (type === 0x80 || type === 0x90) { i += 2; continue }
    i += 2   // 其它通道消息默认 2 字节
  }
  return notes
}

const tracks = []
let p = 8 + headerLen
while (p < buf.length - 8) {
  if (buf.toString('ascii', p, p + 4) !== 'MTrk') break
  const len = buf.readUInt32BE(p + 4)
  tracks.push(parseTrack(buf, p + 8, p + 8 + len))
  p += 8 + len
}
if (!asJson) console.error(`[midi] 轨道数 ${tracks.length}，division=${division}`)

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
function midiToName(m) {
  const oct = Math.floor(m / 12) - 1
  return NOTE_NAMES[m % 12] + oct
}

/** 取旋律：合并所有轨道，按 tick 分组，每组取最高音（右手旋律），同 tick 只留一个 */
const all = []
tracks.forEach((notes, idx) => { if (trackFilter === '' || Number(trackFilter) === idx) all.push(...notes) })
all.sort((a, b) => a.tick - b.tick || b.pitch - a.pitch)

// 同一起点（容差 12 tick）只留最高音：右手柱式和弦/碎和弦里取旋律线
const TOL = 12
const sorted = [...all].sort((a, b) => a.tick - b.tick || b.pitch - a.pitch)
const melody = []
for (const n of sorted) {
  const last = melody[melody.length - 1]
  if (last && n.tick - last.tick <= TOL) {
    if (n.pitch > last.pitch) melody[melody.length - 1] = n   // 同一位置取更高音
    continue
  }
  melody.push(n)
}

/** 量化到 0.25 拍；音名范围过滤；休止补齐 */
const beatTicks = division
const QUANT = 0.25
const out = []
let prevEnd = 0
for (const n of melody) {
  const startBeat = n.tick / beatTicks
  const durBeat = Math.max(0.25, n.durTick / beatTicks)
  const startQ = Math.round(startBeat / QUANT) * QUANT
  const durQ = Math.max(QUANT, Math.round(durBeat / QUANT) * QUANT)
  const gap = Math.round((startQ - prevEnd) / QUANT) * QUANT
  if (gap > 0) out.push(['R', Math.min(4, gap)])
  const name = midiToName(n.pitch)
  const m = /^([A-G]#?)(-?\d)$/.exec(name)
  const oct = m ? Number(m[2]) : 0
  if (!m || oct < 3 || oct > 6) { prevEnd = startQ + durQ; continue }
  out.push([name, Math.min(4, durQ)])
  prevEnd = startQ + durQ
}

const totalBeats = out.reduce((a, x) => a + x[1], 0)

// 按 --max-seconds 截断（保留整句：落到最近的小节线附近不强行切，只按时间硬截，避免改动音符）
let finalNotes = out
if (maxSeconds > 0) {
  const bpm = 60
  const limitBeats = (maxSeconds / 60) * bpm
  let acc = 0
  const cut = []
  for (const x of out) { if (acc + x[1] > limitBeats) break; cut.push(x); acc += x[1] }
  finalNotes = cut
}

const result = {
  name: '致爱丽丝',
  bpm: 60,
  source: 'Mutopia Project, Für Elise WoO 59 (Breitkopf & Härtel 1888), Public Domain',
  notes: finalNotes,
}
console.error(`[midi] 旋律音数 ${melody.length} → 输出音符 ${finalNotes.length}，总拍 ${finalNotes.reduce((a, x) => a + x[1], 0)}（≈${Math.round(finalNotes.reduce((a, x) => a + x[1], 0))} 秒 @60bpm）`)
// 按音数截断（配合 --max-notes 精确停在乐句边界）
const maxNotes = Number(opt('max-notes', '0'))
if (maxNotes > 0 && result.notes.length > maxNotes) result.notes = result.notes.slice(0, maxNotes)

const replaceName = opt('replace', '')
if (replaceName) {
  const path = opt('file', 'data/melodies.json')
  const db = JSON.parse(readFileSync(path, 'utf8'))
  const idx = db.songs.findIndex((s) => String(s.name).indexOf(replaceName) >= 0)
  if (idx < 0) { console.error('[midi] melodies.json 里没有 "' + replaceName + '"'); process.exit(1) }
  const before = db.songs[idx].notes ? db.songs[idx].notes.length : 0
  db.songs[idx] = {
    name: db.songs[idx].name,
    bpm: result.bpm,
    source: result.source,
    notes: result.notes,
  }
  writeFileSync(path, JSON.stringify(db, null, 1), 'utf8')
  const beats2 = result.notes.reduce((a, x) => a + x[1], 0)
  console.error('[midi] 已替换《' + db.songs[idx].name + '》：' + before + ' 音 → ' + result.notes.length + ' 音，' + beats2 + ' 拍（≈' + Math.round(beats2 * (60 / Math.max(60, result.bpm))) + ' 秒）')
  process.exit(0)
}

if (asJson) console.log(JSON.stringify(result.notes))
else {
  const outFile = opt('out', '')
  if (outFile) { writeFileSync(outFile, JSON.stringify(result), 'utf8'); console.error('[midi] 已写入 ' + outFile) }
  else console.log(JSON.stringify(result, null, 1))
}
