/**
 * scripts/test-audio-sim.mjs —— B91 音频/相似度四模块的离线断言（不改 package.json、不接进 npm test）
 *
 * 覆盖本批唯一可改范围：
 *   · client/audio-codec.ts  mime 归类 / 录音编码协商 / 宿主 format 映射 / PCM→WAV / 下混 / 体积口径
 *   · client/playback.ts     朗读看门狗判定（僵尸/合成中/停滞/时钟回拨/阈值边界）
 *   · client/sim.ts          归一化 / bigram / Jaccard / isRepeat（窗口、minLen、包含、阈值）
 *   · client/melody.ts       音符表 / 拍长 / 时长估算 / 播放器（串行、换曲、stop、onDone 兜底、谱面边界）
 *
 * 做法（与 scripts/test-media-reminders.mjs 同一套路，不落盘、不联网）：
 *   · 每个模块用 esbuild 打成自包含 ESM，再从 data: URL 导入；
 *   · 计时器整体换成可控假时钟（setTimeout/setInterval 全接管），看门狗/onDone 全部确定性；
 *   · AudioContext、window 全部打桩，canResume 可指定 resolve / reject / never / late 四种行为。
 *
 * 用法：node scripts/test-audio-sim.mjs        （退出码 0=全绿，1=有失败）
 * 说明：**没有**接进 npm test —— package.json 不在本批可改范围内，需手工运行。
 */

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src', 'client')

let pass = 0
let fail = 0
const failures = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else {
    fail++
    failures.push(name + (detail ? '  ' + detail : ''))
    console.log('  ❌ ' + name + (detail ? '  ' + detail : ''))
  }
}
const eq = (name, actual, expected) => {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
    '期望 ' + JSON.stringify(expected) + ' / 实际 ' + JSON.stringify(actual))
}

/** 用 esbuild 把 .ts 模块打成自包含 ESM，再从 data: URL 导入（不落盘） */
async function loadModule(entry) {
  const r = await build({
    entryPoints: [join(SRC, entry)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2020',
    write: false,
    legalComments: 'none',
    charset: 'utf8',
  })
  const code = r.outputFiles[0].text
  return import('data:text/javascript;base64,' + Buffer.from(code, 'utf8').toString('base64'))
}

/** 可控假时钟 */
function installFakeTimers() {
  const real = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  }
  let now = 0
  let seq = 0
  const timers = new Map()
  const errors = []
  globalThis.setTimeout = (fn, ms) => {
    const id = ++seq
    timers.set(id, { at: now + Math.max(0, Math.round(Number(ms) || 0)), fn, every: 0 })
    return id
  }
  globalThis.setInterval = (fn, ms) => {
    const id = ++seq
    const period = Math.max(1, Math.round(Number(ms) || 0))
    timers.set(id, { at: now + period, fn, every: period })
    return id
  }
  globalThis.clearTimeout = (id) => { timers.delete(id) }
  globalThis.clearInterval = (id) => { timers.delete(id) }
  return {
    now: () => now,
    count: () => timers.size,
    /** 推进假时钟：按到期时间顺序同步触发（回调里新排的定时器也继续触发） */
    advance(ms) {
      const end = now + ms
      for (let guard = 0; guard < 50000; guard++) {
        let pick = null
        let pickId = 0
        for (const [id, t] of timers) {
          if (t.at <= end && (!pick || t.at < pick.at)) { pick = t; pickId = id }
        }
        if (!pick) break
        now = pick.at
        if (pick.every > 0) pick.at = now + pick.every
        else timers.delete(pickId)
        try { pick.fn() } catch (e) { errors.push(e) }
      }
      now = end
    },
    /** 让排队的 microtask（.then 链）跑完 */
    async flush(turns = 10) { for (let i = 0; i < turns; i++) await Promise.resolve() },
    errors,
    restore() {
      globalThis.setTimeout = real.setTimeout
      globalThis.clearTimeout = real.clearTimeout
      globalThis.setInterval = real.setInterval
      globalThis.clearInterval = real.clearInterval
    },
  }
}

/**
 * AudioContext 桩：记录振荡器排程；resume 行为可配
 *   resume: 'resolve'（默认）| 'reject' | 'never'（永不 settle）| 'late'（lateMs 后 resolve）
 *   throwOnCreate: 第 N 次 createOscillator 抛错（验"单音抛错不连坐整首"）
 */
function installAudioStub(opts = {}) {
  const ctxs = []
  const resumes = []
  let constructed = 0
  function makeCtx() {
    const ctx = {
      state: 'suspended',
      currentTime: 0,
      destination: { name: 'dest-' + ctxs.length },
      oscs: [],
      gains: [],
      createCount: 0,
      suspendCalls: 0,
      createOscillator() {
        ctx.createCount++
        if (opts.throwOnCreate === ctx.createCount) throw new Error('osc-boom')
        const o = {
          type: '',
          frequency: { value: 0 },
          startAt: -1,
          stopAt: -1,
          stopCalls: 0,
          connected: [],
          connect(n) { o.connected.push(n) },
          start(t) { o.startAt = t },
          stop(t) { o.stopCalls++; if (t !== undefined) o.stopAt = t },
        }
        ctx.oscs.push(o)
        return o
      },
      createGain() {
        const g = {
          gain: { events: [], setValueAtTime(v, t) { g.gain.events.push(['set', v, t]) }, exponentialRampToValueAtTime(v, t) { g.gain.events.push(['ramp', v, t]) } },
          connect() { },
        }
        ctx.gains.push(g)
        return g
      },
      resume() {
        const mode = opts.resume || 'resolve'
        resumes.push(mode)
        if (mode === 'never') return new Promise(() => { })
        if (mode === 'reject') return Promise.reject(new Error('autoplay-blocked'))
        if (mode === 'late') {
          return new Promise((res) => {
            setTimeout(() => { ctx.state = 'running'; res() }, opts.lateMs || 500)
          })
        }
        ctx.state = 'running'
        return Promise.resolve()
      },
      suspend() { ctx.suspendCalls++; ctx.state = 'suspended'; return Promise.resolve() },
    }
    ctxs.push(ctx)
    return ctx
  }
  const prev = globalThis.window
  globalThis.window = Object.assign({}, prev || {}, {
    AudioContext: function () { constructed++; return makeCtx() },
  })
  return {
    ctxs,
    resumes,
    constructed: () => constructed,
    ctx: () => ctxs[ctxs.length - 1],
    restore() { if (prev === undefined) delete globalThis.window; else globalThis.window = prev },
  }
}

const u8 = (buf) => new Uint8Array(buf)
const dv = (buf) => new DataView(buf)
const ascii = (buf, off, n) => {
  const a = u8(buf)
  let s = ''
  for (let i = 0; i < n; i++) s += String.fromCharCode(a[off + i])
  return s
}

async function main() {
  // 浏览器桩：melody.ts 只看 window.AudioContext，echo-filter 的依赖链也要求 window 存在
  if (typeof globalThis.window !== 'object') globalThis.window = {}

  // =====================================================================
  // ① 封装治理（静态）：只经注入/参数工作，不摸别的模块内部状态
  // =====================================================================
  console.log('\n[1] 封装治理：注入/参数化、无跨模块内部状态')
  try {
    const specs = {
      'audio-codec.ts': [/^\.\/util\.js$/, /^\.\.\/shared\//],
      'playback.ts': [],
      'sim.ts': [],
      'melody.ts': [/^\.\/util\.js$/, /^\.\.\/shared\//],
    }
    // 别的模块的内部状态名（出现即说明直摸实现）
    const internals = /ttsQ\b|ttsBusy|ttsAudio|ttsUrl|ttsPrefetch|speakToken|storyNarratingRef|storyBusyRef|asrEpoch|narrateOwner|micOn/
    for (const f of Object.keys(specs)) {
      const raw = readFileSync(join(SRC, f), 'utf8')
      // 注释里会提到别的模块的状态名（解释背景），先剥注释再扫
      const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
      const found = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
      const bad = found.filter((s) => !specs[f].some((re) => re.test(s)))
      ok(f + '：import 全在公开依赖白名单内', bad.length === 0, bad.join(',') || found.join(',') || '(无 import)')
      const hit = src.match(internals)
      ok(f + '：不引用别的模块内部状态', !hit, hit ? '发现 ' + hit[0] : '')
      ok(f + '：不 import react / 不 import 组件入口', !/from 'react'|from '\.\.\/client\.js'/.test(src))
      // 模块级可变状态：export let / export var 一律不允许（共享状态必须进工厂）
      ok(f + '：无 export let/var 模块级可变状态', !/^export\s+(let|var)\s/m.test(src))
    }
    ok('playback.ts 保持纯函数（无任何 import）', !/from '/.test(readFileSync(join(SRC, 'playback.ts'), 'utf8')))
    ok('sim.ts 保持纯函数（无任何 import）', !/from '/.test(readFileSync(join(SRC, 'sim.ts'), 'utf8')))
  } catch (e) {
    ok('封装治理静态扫描', false, String(e && e.message))
  }

  const codec = await loadModule('audio-codec.ts')
  const playback = await loadModule('playback.ts')
  const sim = await loadModule('sim.ts')
  const melody = await loadModule('melody.ts')

  // =====================================================================
  // ② audio-codec：WAV 头逐字节 / 量化 / 夹紧 / 体积口径 / mime / 协商 / 下混
  // =====================================================================
  console.log('\n[2] audio-codec.ts 纯函数契约')
  try {
    ok('WAV_HEADER_BYTES = 44', codec.WAV_HEADER_BYTES === 44)
    ok('录音候选顺序：webm(opus) → webm → mp4', JSON.stringify(codec.RECORDER_MIME_CANDIDATES) === JSON.stringify(['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']))
    ok('候选表已冻结（外部推不进去）', (() => {
      let threw = false
      try { codec.RECORDER_MIME_CANDIDATES.push('audio/ogg') } catch (e) { threw = true }
      return threw && codec.RECORDER_MIME_CANDIDATES.length === 3
    })())

    // --- WAV 头逐字段 ---
    const n = 4
    const buf = codec.encodeWavPcm16([0, 0.5, -0.5, 1], 44100)
    ok('RIFF size = 36 + data', dv(buf).getUint32(4, true) === 36 + n * 2, String(dv(buf).getUint32(4, true)))
    ok('文件头标识 RIFF/WAVE/fmt /data', ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 4) === 'WAVE' && ascii(buf, 12, 4) === 'fmt ' && ascii(buf, 36, 4) === 'data')
    ok('fmt 块长度 16 / PCM(1) / 单声道', dv(buf).getUint32(16, true) === 16 && dv(buf).getUint16(20, true) === 1 && dv(buf).getUint16(22, true) === 1)
    ok('采样率写入 44100', dv(buf).getUint32(24, true) === 44100)
    ok('字节率 = 采样率 × 2（byteRate）', dv(buf).getUint32(28, true) === 88200, String(dv(buf).getUint32(28, true)))
    ok('块对齐 2 / 位深 16', dv(buf).getUint16(32, true) === 2 && dv(buf).getUint16(34, true) === 16)
    ok('data 长度 = 采样数 × 2', dv(buf).getUint32(40, true) === n * 2, String(dv(buf).getUint32(40, true)))
    ok('总字节 = 44 + 采样数×2（无 padding）', u8(buf).byteLength === 44 + n * 2, String(u8(buf).byteLength))
    ok('小端：+1.0 写成 FF 7F', u8(buf)[44 + 3 * 2] === 0xff && u8(buf)[44 + 3 * 2 + 1] === 0x7f)

    // --- 量化与非法值 ---
    const q = codec.encodeWavPcm16([0, 1, -1, 0.5, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2, -2], 48000)
    const qv = (i) => dv(q).getInt16(44 + i * 2, true)
    ok('0 → 0', qv(0) === 0)
    ok('+1 → 32767（不削顶溢出）', qv(1) === 32767, String(qv(1)))
    ok('-1 → -32768', qv(2) === -32768, String(qv(2)))
    ok('+0.5 / -0.5 对称量化', qv(3) === 16384 && qv(4) === -16384, qv(3) + '/' + qv(4))
    ok('NaN → 0（不写进 WAV）', qv(5) === 0)
    ok('±Infinity → 0', qv(6) === 0 && qv(7) === 0)
    ok('越界采样夹到 ±1', qv(8) === 32767 && qv(9) === -32768)

    // --- 采样率夹紧（写入头部的值与 byteRate 必须同步）---
    const c1 = codec.encodeWavPcm16([0], 4000)
    ok('采样率 4000 → 夹到 8000（头与字节率一致）', dv(c1).getUint32(24, true) === 8000 && dv(c1).getUint32(28, true) === 16000)
    const c2 = codec.encodeWavPcm16([0], 200000)
    ok('采样率 200000 → 夹到 96000（头与字节率一致）', dv(c2).getUint32(24, true) === 96000 && dv(c2).getUint32(28, true) === 192000)
    ok('采样率 NaN / 0 → 默认 48000', dv(codec.encodeWavPcm16([0], Number.NaN)).getUint32(24, true) === 48000 && dv(codec.encodeWavPcm16([0], 0)).getUint32(24, true) === 48000)

    // --- capSampleRate：设备 192kHz 时先降采样，避免「头 96k、数据 192k」的半速音频 ---
    {
      const hi = new Float32Array([0.5, 0.5, -0.5, -0.5, 1, 1, 0, 0])
      const capped = codec.capSampleRate(hi, 192000)
      ok('192k → 96k（2 倍抽取）', capped.sampleRate === 96000 && capped.samples.length === 4, capped.sampleRate + '/' + capped.samples.length)
      ok('块内平均：成对采样取均值', Math.abs(capped.samples[0] - 0.5) < 1e-6 && Math.abs(capped.samples[1] - (-0.5)) < 1e-6 && Math.abs(capped.samples[2] - 1) < 1e-6, Array.from(capped.samples).join(','))
      const keep = codec.capSampleRate(hi, 48000)
      ok('≤96k 原样返回（不改内容）', keep.sampleRate === 48000 && keep.samples.length === 8)
      const weird = codec.capSampleRate([1, 2, NaN, 4], 192000)
      ok('非有限值按 0（不污染平均值）', Math.abs(weird.samples[1] - 2) < 1e-6, Array.from(weird.samples).join(','))
      const empty2 = codec.capSampleRate([], 192000)
      ok('空输入不炸、保持原采样率', empty2.samples.length === 0 && empty2.sampleRate === 192000)
      // 头与数据必须同采样率：cap 后的结果再写 WAV，头里的采样率应等于 cap 后的值
      const w = codec.encodeWavPcm16(capped.samples, capped.sampleRate)
      ok('cap 后写头：头采样率 = 数据采样率（不再半速）', dv(w).getUint32(24, true) === 96000)
    }

    // --- 空输入不产出坏头 ---
    const empty = codec.encodeWavPcm16([], 44100)
    ok('空采样：44 字节纯头 / data=0 / RIFF size=36',
      u8(empty).byteLength === 44 && dv(empty).getUint32(40, true) === 0 && dv(empty).getUint32(4, true) === 36)
    ok('samples=null 不抛、按空处理', u8(codec.encodeWavPcm16(null, 44100)).byteLength === 44)

    // --- wavBytes 与 encodeWavPcm16 同口径（上传体积检查不会与实际字节打架）---
    const wav1 = codec.encodeWavPcm16(new Float32Array(44100), 44100)
    ok('wavBytes(1s@44100) = 实际字节', codec.wavBytes(1, 44100) === u8(wav1).byteLength, codec.wavBytes(1, 44100) + ' vs ' + u8(wav1).byteLength)
    ok('wavBytes 采样数向上取整（0.00001s → 1 采样）', codec.wavBytes(0.00001, 44100) === 46, String(codec.wavBytes(0.00001, 44100)))
    ok('wavBytes 负数/0 秒 → 只有头', codec.wavBytes(-5, 44100) === 44 && codec.wavBytes(0, 44100) === 44)
    ok('wavBytes 采样率同口径夹紧（4000 → 8000）', codec.wavBytes(1, 4000) === 44 + 8000 * 2, String(codec.wavBytes(1, 4000)))

    // --- mime → 容器（宿主白名单只有 webm/wav/mp3）---
    const mimeCases = [
      ['audio/webm;codecs=opus', 'webm'], ['audio/webm', 'webm'], ['AUDIO/WEBM', 'webm'],
      ['audio/mp4', 'mp4'], ['audio/mp4;codecs=mp4a.40.2', 'mp4'], ['audio/x-m4a', 'mp4'], ['audio/aac', 'mp4'], ['video/mp4', 'mp4'],
      ['audio/mpeg', 'mp3'], ['audio/mp3', 'mp3'], ['audio/x-mpeg', 'mp3'],
      ['audio/wav', 'wav'], ['audio/x-wav', 'wav'], ['audio/wave', 'wav'],
      ['', 'webm'], [null, 'webm'], [undefined, 'webm'], [123, 'webm'],
    ]
    let mimeBad = []
    for (const [m, want] of mimeCases) {
      const got = codec.formatFromMime(m)
      if (got !== want) mimeBad.push(String(m) + '→' + got + '(want ' + want + ')')
    }
    ok('formatFromMime 归类（含大写/参数/null/数字）', mimeBad.length === 0, mimeBad.join(' '))

    // --- 编码协商 ---
    eq('只支持 opus → 选 opus', codec.pickRecorderMime({ isTypeSupported: (t) => t === 'audio/webm;codecs=opus' }), { mimeType: 'audio/webm;codecs=opus', format: 'webm' })
    eq('只支持 mp4 → 选 mp4 + format=mp4', codec.pickRecorderMime({ isTypeSupported: (t) => t === 'audio/mp4' }), { mimeType: 'audio/mp4', format: 'mp4' })
    eq('全不支持 → 不传 mimeType（保持老行为）', codec.pickRecorderMime({ isTypeSupported: () => false }), { mimeType: '', format: 'webm' })
    eq('没有 isTypeSupported → 不传 mimeType', codec.pickRecorderMime({}), { mimeType: '', format: 'webm' })
    eq('caps 为 null → 不传 mimeType', codec.pickRecorderMime(null), { mimeType: '', format: 'webm' })
    eq('isTypeSupported 抛错 → 跳过该候选继续试探', codec.pickRecorderMime({
      isTypeSupported: (t) => { if (t === 'audio/webm;codecs=opus') throw new Error('boom'); return t === 'audio/webm' },
    }), { mimeType: 'audio/webm', format: 'webm' })

    // --- 宿主 format 映射：请求体里永远是宿主认识的值 ---
    ok('hostAsrFormat：mp4 回落 webm（宿主白名单不含 mp4）', codec.hostAsrFormat('mp4') === 'webm')
    ok('hostAsrFormat：webm/wav/mp3 原样', codec.hostAsrFormat('webm') === 'webm' && codec.hostAsrFormat('wav') === 'wav' && codec.hostAsrFormat('mp3') === 'mp3')

    // --- 多声道下混 ---
    ok('空声道 → 长度 0', codec.downmixToMono(null).length === 0 && codec.downmixToMono([]).length === 0 && codec.downmixToMono([null]).length === 0)
    eq('单声道直通', Array.from(codec.downmixToMono([new Float32Array([1, -1, 0])])), [1, -1, 0])
    eq('双声道取平均', Array.from(codec.downmixToMono([new Float32Array([1, 0]), new Float32Array([-1, 2])])), [0, 1])
    eq('长度不等：短声道缺失采样按 0（长度取最长）', Array.from(codec.downmixToMono([new Float32Array([1, 1]), new Float32Array([1])])), [1, 0.5])
    eq('非有限采样不污染输出（NaN→0）', Array.from(codec.downmixToMono([new Float32Array([Number.NaN, 1])])), [0, 1])
  } catch (e) {
    ok('audio-codec 断言执行', false, String((e && e.stack) || e))
  }

  // =====================================================================
  // ③ playback：看门狗判定边界（补 test.mjs / test-media-reminders.mjs 没覆盖的角）
  // =====================================================================
  console.log('\n[3] playback.ts 看门狗判定边界')
  try {
    const base = { hasAudio: false, audioPlaying: false, busy: true, busySince: 1000, synthAt: 0, now: 4000 }
    ok('不 busy → 永不僵尸', playback.isPlaybackZombie({ ...base, busy: false }) === false)
    ok('有音频在播 → 健康（哪怕合成已超时）', playback.isPlaybackZombie({ ...base, hasAudio: true, audioPlaying: true, synthAt: 1, now: 99999 }) === false)
    ok('合成中（未超时）→ 健康', playback.isPlaybackZombie({ ...base, synthAt: 3000, now: 5000 }) === false)
    ok('合成超时（默认 20s）→ 僵尸', playback.isPlaybackZombie({ ...base, synthAt: 3000, now: 23000 }) === true)
    ok('合成 19999ms 仍未超时', playback.isPlaybackZombie({ ...base, synthAt: 3000, now: 22999 }) === false)
    ok('停滞阈值边界：2499ms 不算、2500ms 算', playback.isPlaybackZombie({ ...base, busySince: 1000, now: 3499 }) === false
      && playback.isPlaybackZombie({ ...base, busySince: 1000, now: 3500 }) === true)
    ok('lastProgressAt 优先（播到一半卡住不误判）', playback.isPlaybackZombie({ ...base, hasAudio: true, lastProgressAt: 3400, now: 3999 }) === false)
    ok('lastProgressAt=0 → 回退 busySince', playback.isPlaybackZombie({ ...base, lastProgressAt: 0, busySince: 1000, now: 4000 }) === true)
    ok('系统时钟回拨（now<since）不判僵尸', playback.isPlaybackZombie({ ...base, busySince: 9000, now: 4000 }) === false)
    ok('自定义 zombieMs=0 → 立刻判僵尸', playback.isPlaybackZombie({ ...base, zombieMs: 0 }) === true)
    ok('自定义 synthTimeoutMs=0 → 合成不再豁免', playback.isPlaybackZombie({ ...base, busySince: 0, synthAt: 3000, now: 3000, synthTimeoutMs: 0 }) === true)
    ok('字段几乎全缺也不崩', playback.isPlaybackZombie({ busy: true, busySince: 0, synthAt: 0, now: 5000 }) === true)
    ok('空闲（busy=false）即便字段全是 0 也不崩', playback.isPlaybackZombie({ busy: false, busySince: 0, synthAt: 0, now: 0 }) === false)
  } catch (e) {
    ok('playback 断言执行', false, String((e && e.stack) || e))
  }

  // =====================================================================
  // ④ sim：归一化 / bigram / Jaccard / isRepeat 契约
  // =====================================================================
  console.log('\n[4] sim.ts 相似度与重复判定')
  try {
    eq('归一化：空白/标点/大小写', sim.normalizeText('  Hello, 世界！。 '), 'hello世界')
    ok('归一化：null/undefined 不崩', sim.normalizeText(null) === '' && sim.normalizeText(undefined) === '')
    ok('bigrams：空串 → 空集', sim.bigrams('').size === 0)
    ok('bigrams：单字符退化', sim.bigrams('a').size === 1 && sim.bigrams('abc').size === 2)
    ok('Jaccard：同句不同标点 = 1', sim.similarity('你好呀。', '你好呀') === 1)
    ok('Jaccard：完全不同 = 0', sim.similarity('今天天气怎么样', '讲个聊斋故事') === 0)
    ok('Jaccard：包含关系介于 0–1 之间', (() => {
      const s = sim.similarity('今天天气不错你给我讲个笑话吧', '不错你给我讲个笑话吧')
      return s > 0.5 && s < 1
    })())
    ok('Jaccard：空串 → 0（不 NaN）', sim.similarity('', 'x') === 0 && sim.similarity('', '') === 0)

    const T0 = 5_000_000
    const R = (text, at) => [{ text, at }]
    const opt = (o = {}) => ({ recent: R('今天天气怎么样', T0), windowMs: 8000, threshold: 0.9, minLen: 4, now: T0 + 1000, ...o })

    ok('同一句（≥minLen）8 秒内 → 重复', sim.isRepeat('今天天气怎么样', opt()) === true)
    ok('窗口边界：正好 windowMs 仍参与比较', sim.isRepeat('今天天气怎么样', opt({ now: T0 + 8000 })) === true)
    ok('窗口边界：windowMs+1 已过期', sim.isRepeat('今天天气怎么样', opt({ now: T0 + 8001 })) === false)
    ok('空串 → 永不算重复', sim.isRepeat('', opt()) === false && sim.isRepeat('   。', opt()) === false)
    ok('recent 非数组也不崩', sim.isRepeat('今天天气怎么样', { recent: null, now: T0 }) === false)
    ok('标点/空白差异仍算同一句', sim.isRepeat('今天天气，怎么样', opt({ recent: R('今天 天气怎么样?', T0) })) === true)

    // —— 修 BUG 的核心契约：minLen 是"太短的字不参与比较"的下限，① 完全相等分支也必须遵守 ——
    // 现场证据：'停' 在 text.ts 的 SHORT_ECHO_ALLOW / echo-filter 的 interrupt 白名单里被明确要求放行，
    // 但 minLen 只挡了 ②③，① 会把 8 秒内第二声「停」判成 dup → 打断指令被吞。
    ok('短命令（<minLen）重复说不算重复：继续×2', sim.isRepeat('继续', { recent: R('继续', T0), windowMs: 8000, threshold: 0.9, minLen: 4, now: T0 + 3000 }) === false)
    ok('打断词（<minLen）重复说不算重复：停×2', sim.isRepeat('停', { recent: R('停', T0), windowMs: 8000, threshold: 0.9, minLen: 4, now: T0 + 3000 }) === false)
    ok('minLen 边界：正好 4 字仍按重复处理', sim.isRepeat('讲个故事', { recent: R('讲个故事', T0), windowMs: 8000, threshold: 0.9, minLen: 4, now: T0 + 3000 }) === true)
    ok('minLen 边界：3 字（<4）不参与', sim.isRepeat('下一个', { recent: R('下一个', T0), windowMs: 8000, threshold: 0.9, minLen: 4, now: T0 + 3000 }) === false)
    ok('minLen=0 显式放开时短句照旧按重复（行为可回退）', sim.isRepeat('继续', { recent: R('继续', T0), windowMs: 8000, threshold: 0.9, minLen: 0, now: T0 + 3000 }) === true)

    ok('包含规则：较短一方 ≥minLen 且被包含 → 重复', sim.isRepeat('讲个故事', { recent: R('快给我讲个故事吧', T0), windowMs: 8000, threshold: 0.9, minLen: 4, now: T0 + 2000 }) === true)
    ok('包含规则：较短一方 <minLen 不判重（3 字碎片不误判）', sim.isRepeat('吃白饭', { recent: R('今天你吃白饭了吗', T0), windowMs: 8000, threshold: 0.9, minLen: 4, now: T0 + 2000 }) === false)
    ok('阈值：相似度达到 threshold 才算', (() => {
      // 两句话共有 bigram 的交并比先算出来，再用它上下夹逼
      const a = '今天天气不错适合吃白饭'
      const b = '今天天气不错适合去散步'
      const s = sim.similarity(a, b)
      return sim.isRepeat(a, { recent: R(b, T0), windowMs: 8000, threshold: s, minLen: 4, now: T0 + 500 }) === true
        && sim.isRepeat(a, { recent: R(b, T0), windowMs: 8000, threshold: Math.min(1, s + 0.05), minLen: 4, now: T0 + 500 }) === false
    })())
  } catch (e) {
    ok('sim 断言执行', false, String((e && e.stack) || e))
  }

  // ---- ④b 端到端：echo-filter 是 sim.isRepeat 的唯一调用点（负向验证：回声防护没被放松）----
  console.log('\n[4b] echo-filter 端到端（sim.isRepeat 的唯调用点）')
  try {
    const echo = await loadModule('voice/echo-filter.ts')
    const T1 = 6_000_000

    const a = echo.createEchoFilter()
    eq('主人第一声「继续」放行', a.accept('继续', T1, 1), { ok: true })
    eq('3 秒后第二声「继续」仍放行（修复前被 dup 吞掉）', a.accept('继续', T1 + 3000, 2), { ok: true })

    const b = echo.createEchoFilter()
    eq('主人第一声「停」放行', b.accept('停', T1, 1), { ok: true })
    eq('3 秒后第二声「停」仍放行（打断指令不能被重复判定吞掉）', b.accept('停', T1 + 3000, 2), { ok: true })

    // 负向：本鱼自己念过的「继续」被麦克风听回来，仍然要判回声 —— 说明修复没放松防线
    const c = echo.createEchoFilter()
    c.noteSpoken('继续', T1)
    const echoVerdict = c.accept('继续', T1 + 1000, 1)
    ok('自己说过的「继续」听回来仍被拦（回声防线未放松）', echoVerdict.ok === false, JSON.stringify(echoVerdict))

    // 负向：≥minLen 的重复句照旧当 dup 吞掉 —— 说明去重没被削弱
    const d = echo.createEchoFilter()
    eq('第一遍「今天天气怎么样」放行', d.accept('今天天气怎么样', T1, 1), { ok: true })
    eq('8 秒内同一句仍判 dup', d.accept('今天天气怎么样', T1 + 2000, 2), { ok: false, reason: 'dup' })
    eq('隔 9 秒再说同一句放行', d.accept('今天天气怎么样', T1 + 9500, 3), { ok: true })
  } catch (e) {
    ok('echo-filter 端到端断言执行', false, String((e && e.stack) || e))
  }

  // =====================================================================
  // ⑤ melody：谱面解析边界（空谱/超长/非法音名/休止符/BPM 极端/非法时值）
  // =====================================================================
  console.log('\n[5] melody.ts 音符表 / 拍长 / 时长估算（谱面边界）')
  try {
    ok('音符表覆盖 C3–E6（41 键）且已冻结', Object.keys(melody.NOTE_FREQ).length === 41 && Object.isFrozen(melody.NOTE_FREQ))
    ok('A4 = 440 / C4 = 261.63', melody.NOTE_FREQ.A4 === 440 && melody.NOTE_FREQ.C4 === 261.63)
    ok('bpm 120 → 0.5 秒/拍', melody.beatSeconds(120) === 0.5)
    // 契约照源码：bpm 低于 60 夹到 60（30/负数 → 1s）；bpm 为 0 是“没填”，按默认 100 处理
    ok('bpm 低于 60 夹到 60（30 → 1s、负数 → 1s）', melody.beatSeconds(30) === 1 && melody.beatSeconds(-8) === 1)
    ok('bpm=0 视为未填 → 默认 100（0.6 秒/拍）', Math.abs(melody.beatSeconds(0) - 0.6) < 1e-9)
    ok('bpm 非法（NaN/undefined）落默认 100', Math.abs(melody.beatSeconds(Number.NaN) - 0.6) < 1e-9 && Math.abs(melody.beatSeconds(undefined) - 0.6) < 1e-9)
    ok('bpm 字符串数字也认', melody.beatSeconds('240') === 0.25)
    ok('bpm 极大值不产生负拍长', melody.beatSeconds(1e9) > 0)

    ok('空谱时长 0', melody.estimateMelodySeconds([], 120) === 0)
    ok('null 谱面 → 0（不崩）', melody.estimateMelodySeconds(null, 120) === 0)
    ok('时长 = 时值和 × 拍长（4 拍@120 = 2 秒）', melody.estimateMelodySeconds([['C4', 1], ['D4', 1], ['E4', 1], ['F4', 1]], 120) === 2)
    ok('休止符 R 照样占时值', melody.estimateMelodySeconds([['R', 2], ['C4', 1]], 120) === 1.5)
    ok('非法时值（0/负/NaN）按 1 拍', melody.estimateMelodySeconds([['C4', -2], ['D4', 0], ['E4', Number.NaN]], 120) === 1.5)
    ok('一位小数四舍五入（1.5 拍@100 ≈ 0.9 秒）', melody.estimateMelodySeconds([['C4', 1], ['D4', 0.5]], 100) === 0.9)
    ok('非法音名也占时值（不影响预估）', melody.estimateMelodySeconds([['H9', 2], ['???', 1]], 120) === 1.5)
    ok('超长谱面（2000 音）不把估算压成 0 或 NaN', melody.estimateMelodySeconds(new Array(2000).fill(['C4', 0.5]), 120) === 500)
  } catch (e) {
    ok('melody 纯函数断言执行', false, String((e && e.stack) || e))
  }

  // =====================================================================
  // ⑥ melody 播放器：串行 / 换曲 / stop / onDone 兜底 / 异常隔离
  // =====================================================================
  console.log('\n[6] melody.ts 播放器（多段串行、stop、onDone 兜底、异常隔离）')
  const clock = installFakeTimers()
  try {
    // --- 实例隔离：两个播放器不共享 AudioContext（无跨实例内部状态）---
    {
      const audioA = installAudioStub()
      const p1 = melody.createMelodyPlayer()
      p1.play([['C4', 1]], 120, () => { })
      await clock.flush()
      const first = audioA.constructed()
      audioA.restore()
      ok('每个播放器独立建 AudioContext（实例级状态，不共享）', first === 1 && audioA.ctxs.length === 1, 'constructed=' + first)
      p1.stop()
    }

    // --- 正常一段：时间轴递进 + onDone 到点只触发一次 ---
    {
      const audio = installAudioStub()
      const player = melody.createMelodyPlayer()
      let done = 0
      player.play([['C4', 1], ['E4', 2]], 120, () => done++)
      await clock.flush()
      ok('两个音各排一个振荡器', audio.ctx().oscs.length === 2, String(audio.ctx().oscs.length))
      ok('相邻音时间轴递进 = 前一个音的时值 × 拍长（1 拍 = 0.5 秒）',
        Math.abs(audio.ctx().oscs[1].startAt - audio.ctx().oscs[0].startAt - 0.5) < 1e-9,
        String(audio.ctx().oscs[1].startAt - audio.ctx().oscs[0].startAt))
      ok('每个音都在自己时值内停掉', audio.ctx().oscs.every((o) => o.stopAt > o.startAt))
      clock.advance(1849)
      ok('onDone 未到点不触发', done === 0)
      clock.advance(1)
      ok('onDone 到点只触发一次（0.05 + 1.5 秒 + 300ms = 1850ms）', done === 1, '实际 ' + done)
      clock.advance(9000)
      ok('onDone 不重复触发', done === 1)
      ok('全程无未捕获的定时器异常', clock.errors.length === 0, clock.errors.map(String).join(' / '))

      // --- 换曲：旧音必须停、旧 onDone 不再补发 ---
      const firstOscs = audio.ctx().oscs.slice()
      const before = firstOscs.map((o) => o.stopCalls)
      const done1 = done
      let done2 = 0
      player.play([['G4', 4]], 120, () => done2++)
      await clock.flush()
      ok('换曲先停旧曲', firstOscs.every((o, i) => o.stopCalls > before[i]))
      clock.advance(2349)
      ok('新曲 onDone 未到点（0.05 + 2 秒 + 300ms = 2350ms）', done2 === 0)
      clock.advance(1)
      ok('新曲 onDone 到点触发', done2 === 1)
      clock.advance(9000)
      ok('旧曲 onDone 没有被补发（作废后不重复回调）', done === done1 && done1 === 1)

      // --- stop：真的停 + 挂起上下文 + onDone 不再来 ---
      const oscsBefore = audio.ctx().oscs.length
      let done3 = 0
      player.play([['C4', 4]], 120, () => done3++)
      await clock.flush()
      ok('stop 前新曲已排程', audio.ctx().oscs.length === oscsBefore + 1)
      player.stop()
      ok('stop() 立刻停掉所有音', audio.ctx().oscs[audio.ctx().oscs.length - 1].stopCalls >= 1)
      ok('stop() 挂起 AudioContext（复用而非 close）', audio.ctx().state === 'suspended' && audio.ctx().suspendCalls === 1)
      clock.advance(20000)
      ok('stop() 之后 onDone 不再触发', done3 === 0)
      ok('stop() 之后没有残留计时器', clock.count() === 0, '残留 ' + clock.count())
      audio.restore()
    }

    // --- 谱面边界：空谱 / 全休止 / 非法音名 / 超长谱 ---
    {
      const audio = installAudioStub()
      const player = melody.createMelodyPlayer()
      const base = () => audio.ctx().oscs.length

      let doneEmpty = 0
      player.play([], 120, () => doneEmpty++)
      await clock.flush()
      clock.advance(349)
      ok('空谱：先不触发 onDone', doneEmpty === 0)
      clock.advance(1)
      ok('空谱：350ms 后触发 onDone（不卡住上层收尾）', doneEmpty === 1)

      const rest0 = base()
      let doneRest = 0
      player.play([['R', 2], ['R', 1]], 120, () => doneRest++)
      await clock.flush()
      ok('全休止谱：一个振荡器都不建', base() - rest0 === 0, '实际新建 ' + (base() - rest0))
      clock.advance(1849)
      ok('全休止谱：休止符照占时值（不提前收尾）', doneRest === 0)
      clock.advance(1)
      ok('全休止谱：到点照常 onDone（3 拍 = 1.5 秒 + 350ms）', doneRest === 1)

      const bad0 = base()
      let doneBad = 0
      player.play([['H9', 1], [null, 1], ['', 1], ['C4', 1]], 120, () => doneBad++)
      await clock.flush()
      ok('非法音名/null/空音名一律跳过、不建振荡器', base() - bad0 === 1, '实际新建 ' + (base() - bad0))
      clock.advance(2349)
      ok('非法音名仍占满时值（onDone 不提前）', doneBad === 0)
      clock.advance(1)
      ok('非法音名之后正常收尾（4 拍 = 2 秒 + 350ms）', doneBad === 1)

      let doneInf = 0
      player.play([['C4', Number.POSITIVE_INFINITY], ['D4', 1]], 120, () => doneInf++)
      await clock.flush()
      clock.advance(1349)
      ok('Infinity 时值按 1 拍（onDone 不提前）', doneInf === 0, '实际 ' + doneInf)
      clock.advance(1)
      ok('Infinity 时值按 1 拍（不把时间轴推到无穷）', doneInf === 1, '实际 ' + doneInf)

      const long0 = base()
      let doneLong = 0
      player.play(new Array(2000).fill(['C4', 0.25]), 240, () => doneLong++)
      await clock.flush()
      ok('超长谱面（2000 音）全部排程（不丢音、不抛错）', base() - long0 === 2000, '实际新建 ' + (base() - long0))
      const totalMs = 0.05 * 1000 + 2000 * 0.25 * (60 / 240) * 1000 + 300
      clock.advance(totalMs - 1)
      ok('超长谱面 onDone 未提前', doneLong === 0)
      clock.advance(1)
      ok('超长谱面 onDone 到点只触发一次', doneLong === 1, '实际 ' + doneLong)
      audio.restore()
    }

    // --- 单音排程抛错不连坐整首 ---
    {
      const broken = installAudioStub({ throwOnCreate: 2 })
      const player = melody.createMelodyPlayer()
      let doneBroken = 0
      player.play([['C4', 1], ['D4', 1], ['E4', 1]], 120, () => doneBroken++)
      await clock.flush()
      ok('第 2 个音排程抛错，第 1、3 个照排', broken.ctxs.length === 1 && broken.ctx().oscs.length === 2, '实际 ' + (broken.ctxs[0] ? broken.ctxs[0].oscs.length : 'n/a'))
      clock.advance(1850)
      ok('排程抛错不影响 onDone 收尾', doneBroken === 1)
      broken.restore()
    }

    // --- BPM 极端值 ---
    {
      const audio = installAudioStub()
      const player = melody.createMelodyPlayer()
      let doneBpm0 = 0
      player.play([['C4', 1], ['D4', 1]], 0, () => doneBpm0++)
      await clock.flush()
      ok('bpm=0 → 按默认 100bpm 排程（0.6 秒/拍）',
        Math.abs(audio.ctx().oscs[1].startAt - audio.ctx().oscs[0].startAt - 0.6) < 1e-9,
        String(audio.ctx().oscs[1].startAt - audio.ctx().oscs[0].startAt))
      clock.advance(0.05 * 1000 + 2 * 0.6 * 1000 + 300)
      ok('bpm=0 时 onDone 按默认拍长到点', doneBpm0 === 1)

      let doneInfBpm = 0
      player.play([['C4', 1], ['D4', 1]], Number.POSITIVE_INFINITY, () => doneInfBpm++)
      await clock.flush()
      clock.advance(400)
      ok('bpm=Infinity 不抛异常且 onDone 仍会来（0.05s+300ms 兜底）', doneInfBpm === 1, '实际 ' + doneInfBpm)
      audio.restore()
    }

    // --- onDone 兜底：resume() 被自动播放策略扣住时永不 settle ---
    // 修复前：p.then(schedule, schedule) 永远不落定 → 一个音都不排、onDone 永不来 → 上层收尾悬空。
    {
      const audio = installAudioStub({ resume: 'never' })
      const player = melody.createMelodyPlayer()
      let done = 0
      player.play([['C4', 1], ['D4', 1]], 120, () => done++)
      await clock.flush()
      ok('resume 未落定前暂不排程', audio.ctxs.length === 1 && audio.ctx().oscs.length === 0)
      clock.advance(1199)
      ok('1199ms 时仍在等 resume', audio.ctx().oscs.length === 0)
      clock.advance(1)
      await clock.flush()
      ok('1200ms 看门狗到点照样排程（不把上层永久卡住）', audio.ctx().oscs.length === 2, '实际 ' + audio.ctx().oscs.length)
      clock.advance(1350)
      ok('看门狗路径下 onDone 仍按估算时长触发', done === 1, '实际 ' + done)
      ok('看门狗触发后不留残余计时器', clock.count() === 0, '残留 ' + clock.count())
      audio.restore()
    }

    // --- resume() reject（Safari 自动播放被拒）：现有语义是"照样排程"，必须保住 ---
    {
      const audio = installAudioStub({ resume: 'reject' })
      const player = melody.createMelodyPlayer()
      let done = 0
      player.play([['C4', 2]], 120, () => done++)
      await clock.flush()
      ok('resume 被拒 → 仍排程（与修复前语义一致）', audio.ctx().oscs.length === 1)
      clock.advance(0.05 * 1000 + 1.0 * 1000 + 300)
      ok('resume 被拒 → onDone 照常来', done === 1)
      audio.restore()
    }

    // --- resume 迟到（late）：看门狗不能重复排程（runOnce 幂等）---
    {
      const audio = installAudioStub({ resume: 'late', lateMs: 1500 })
      const player = melody.createMelodyPlayer()
      let done = 0
      player.play([['C4', 1], ['D4', 1]], 120, () => done++)
      await clock.flush()
      clock.advance(1200)
      await clock.flush()
      ok('resume 迟到：看门狗先排了一次（2 个音）', audio.ctx().oscs.length === 2, '实际 ' + audio.ctx().oscs.length)
      clock.advance(1000)
      await clock.flush()
      ok('resume 随后落定也不会重复排程（仍 2 个音）', audio.ctx().oscs.length === 2, '实际 ' + audio.ctx().oscs.length)
      clock.advance(400)
      ok('onDone 只触发一次', done === 1, '实际 ' + done)
      audio.restore()
    }

    // --- stop 必须把 resume 看门狗一起撤掉（否则停止后还会冒出排程）---
    {
      const audio = installAudioStub({ resume: 'never' })
      const player = melody.createMelodyPlayer()
      let done = 0
      player.play([['C4', 1]], 120, () => done++)
      await clock.flush()
      player.stop()
      ok('stop 后看门狗计时器已撤（无残留）', clock.count() === 0, '残留 ' + clock.count())
      clock.advance(5000)
      await clock.flush()
      ok('stop 之后不会再有迟到排程', audio.ctx().oscs.length === 0)
      ok('stop 之后 onDone 不会被补发', done === 0)
      audio.restore()
    }

    // --- 没有 AudioContext：静默返回，不抛、不排程 ---
    {
      const prev = globalThis.window.AudioContext
      globalThis.window.AudioContext = undefined
      let threw = false
      let doneNoCtx = 0
      const player = melody.createMelodyPlayer()
      try { player.play([['C4', 1]], 120, () => doneNoCtx++) } catch (e) { threw = true }
      globalThis.window.AudioContext = prev
      ok('没有 AudioContext 时静默返回', threw === false)
      clock.advance(5000)
      ok('没有 AudioContext 时也不补发 onDone（保持原语义：静默）', doneNoCtx === 0)
    }
  } catch (e) {
    ok('melody 播放器断言执行', false, String((e && e.stack) || e))
  } finally {
    clock.restore()
  }

  console.log('\n———— 小结 ————')
  console.log('通过 ' + pass + ' 项 / 失败 ' + fail + ' 项')
  if (fail > 0) {
    console.log('失败项：')
    for (const f of failures) console.log('  · ' + f)
    process.exit(1)
  }
  console.log('✅ B91 音频/相似度四模块离线断言全绿')
}

main().catch((e) => {
  console.error('测试脚本异常：', (e && e.stack) || e)
  process.exit(1)
})
