/**
 * scripts/test-media-reminders.mjs —— B74 媒体/提醒六模块的离线断言
 *
 * 覆盖文件（本批唯一可改范围）：
 *   client/image.ts、client/dropzone.ts、client/playback.ts、client/melody.ts、
 *   client/reminders.ts、client/reminder-manage.ts
 *
 * 做法：
 *   · 每个模块用 esbuild 打成自包含 ESM，再从 data: URL 导入（不落盘、不需要 ts loader）；
 *   · 计时器换成可控假时钟（setTimeout/setInterval 全量接管），轮询/间隔/看门狗都是确定性的；
 *   · 网络、气泡、朗读、AudioContext、FileReader、window.URL/Image 全部打桩，离线可跑。
 *
 * 用法：node scripts/test-media-reminders.mjs      （退出码 0=全绿）
 * 说明：没有接进 npm test —— package.json 不在本批可改范围内（见交付说明）。
 */

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src', 'client')

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

/** 用 esbuild 把 .ts 模块打成自包含 ESM，再从 data: URL 导入 */
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

/** 可控假时钟：把全局 set/clearTimeout、set/clearInterval 全接过来 */
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
    /** 推进假时钟：按到期时间顺序同步触发（回调里新排的定时器也会被继续触发） */
    advance(ms) {
      const end = now + ms
      for (let guard = 0; guard < 20000; guard++) {
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
    async flush(turns = 8) { for (let i = 0; i < turns; i++) await Promise.resolve() },
    errors,
    restore() {
      globalThis.setTimeout = real.setTimeout
      globalThis.clearTimeout = real.clearTimeout
      globalThis.setInterval = real.setInterval
      globalThis.clearInterval = real.clearInterval
    },
  }
}

/** AudioContext 桩（melody 用）：记录排程的音符，可指定第 N 次 createOscillator 抛错 */
function installAudioStub(opts = {}) {
  const ctx = {
    state: 'running',
    currentTime: 0,
    destination: {},
    oscs: [],
    createCount: 0,
    createOscillator() {
      ctx.createCount++
      if (opts.throwOnCreate === ctx.createCount) throw new Error('osc-boom')
      const o = {
        type: '',
        frequency: { value: 0 },
        startAt: -1,
        stopAt: -1,
        stopCalls: 0,
        connect() { },
        start(t) { o.startAt = t },
        stop(t) { o.stopCalls++; if (t !== undefined) o.stopAt = t },
      }
      ctx.oscs.push(o)
      return o
    },
    createGain() {
      return {
        gain: { setValueAtTime() { }, exponentialRampToValueAtTime() { } },
        connect() { },
      }
    },
    resume() { ctx.state = 'running'; return Promise.resolve() },
    suspend() { ctx.state = 'suspended'; return Promise.resolve() },
  }
  const prev = globalThis.window
  globalThis.window = Object.assign({}, prev || {}, { AudioContext: function () { return ctx } })
  return {
    ctx,
    restore() { if (prev === undefined) delete globalThis.window; else globalThis.window = prev },
  }
}

const booleans = (o) => Object.assign({ speaking: false, narrating: false, busy: false }, o || {})

async function main() {
  const playback = await loadModule('playback.ts')
  const melody = await loadModule('melody.ts')
  const reminders = await loadModule('reminders.ts')
  const manage = await loadModule('reminder-manage.ts')
  const image = await loadModule('image.ts')
  const dropzone = await loadModule('dropzone.ts')

  // ---------- ① 封装治理（静态） ----------
  console.log('\n[1] 封装治理：只经公开接口 / 不摸别人内部状态')
  try {
    const files = ['image.ts', 'dropzone.ts', 'playback.ts', 'melody.ts', 'reminders.ts', 'reminder-manage.ts']
    // 六个模块允许依赖的只有：同目录工具、HTTP 小工具、image 的公开接口、shared 公共层
    const allow = [/^\.\/util\.js$/, /^\.\/http\.js$/, /^\.\/image\.js$/, /^\.\.\/shared\//]
    // 不许出现别的模块的闭包/状态名（说明直摸了内部实现）
    const internals = /ttsQ|ttsPlaying|storyNarratingRef|storyBusyRef|busyLock|speakToken|ttsBusy/
    for (const f of files) {
      const raw = readFileSync(join(SRC, f), 'utf8')
      // 注释里会提到别的模块的状态名（如 playback.ts 头注释解释 ttsBusy），先剥注释再扫
      const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
      const specs = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
      const badImport = specs.filter((s) => !allow.some((re) => re.test(s)))
      ok(f + '：import 全在公开依赖白名单内', badImport.length === 0, badImport.join(',') || specs.join(','))
      const hit = src.match(internals)
      ok(f + '：不引用别的模块内部状态', !hit, hit ? '发现 ' + hit[0] : '')
      ok(f + '：不 import react / 不 import 组件入口', !/from 'react'|from '\.\.\/client\.js'/.test(src))
    }
    ok('playback.ts 保持纯函数（无 import）', !/from '/.test(readFileSync(join(SRC, 'playback.ts'), 'utf8')))
  } catch (e) {
    ok('封装治理静态扫描', false, String(e && e.message))
  }

  // ---------- ② playback 看门狗边界 ----------
  console.log('\n[2] playback.ts 看门狗判定边界')
  try {
    const base = { hasAudio: false, audioPlaying: false, busy: true, busySince: 1000, synthAt: 0, now: 4000 }
    ok('busy=false 永远不是僵尸', playback.isPlaybackZombie({ ...base, busy: false }) === false)
    ok('有音频在播 → 健康（哪怕段已开了很久）', playback.isPlaybackZombie({ ...base, hasAudio: true, audioPlaying: true, now: 99000 }) === false)
    ok('合成中未超时 → 不是僵尸', playback.isPlaybackZombie({ ...base, synthAt: 3000, now: 5000 }) === false)
    ok('合成超时 → 僵尸', playback.isPlaybackZombie({ ...base, synthAt: 3000, now: 3000 + 20000 }) === true)
    ok('lastProgressAt 优先于 busySince', playback.isPlaybackZombie({ ...base, busySince: 0, lastProgressAt: 3800, now: 4000 }) === false)
    ok('lastProgressAt=0 回退 busySince', playback.isPlaybackZombie({ ...base, busySince: 0, lastProgressAt: 0, now: 4000 }) === true)
    ok('系统时钟回拨（now<since）不判僵尸', playback.isPlaybackZombie({ ...base, busySince: 9000, now: 4000 }) === false)
    ok('自定义 zombieMs 生效', playback.isPlaybackZombie({ ...base, busySince: 0, now: 900, zombieMs: 1000 }) === false
      && playback.isPlaybackZombie({ ...base, busySince: 0, now: 1000, zombieMs: 1000 }) === true)
    ok('合成超时后回到停滞判定（默认 20 秒内不算僵尸）',
      playback.isPlaybackZombie({ ...base, busySince: 0, synthAt: 1000, now: 3000 }) === false)
    ok('自定义 synthTimeoutMs 生效（500ms 后不再算“合成中”）',
      playback.isPlaybackZombie({ ...base, busySince: 0, synthAt: 1000, now: 3000, synthTimeoutMs: 500 }) === true)
    ok('有音频但不动、且合成已超时 → 按停滞判僵尸', playback.isPlaybackZombie({ ...base, hasAudio: true, audioPlaying: false, synthAt: 1, now: 9000 }) === true)
    ok('字段缺省不崩（可选字段全缺）', playback.isPlaybackZombie({ busy: true, busySince: 0, synthAt: 0, now: 5000 }) === true)
  } catch (e) {
    ok('playback 断言执行', false, String(e && e.message))
  }

  // ---------- ③ melody：音符表与时长估算 ----------
  console.log('\n[3] melody.ts 音符表 / 拍长 / 时长估算')
  try {
    ok('音符表覆盖 C3–E6 且已冻结', Object.keys(melody.NOTE_FREQ).length >= 40 && Object.isFrozen(melody.NOTE_FREQ))
    let threw = false
    try { melody.NOTE_FREQ.C4 = 1 } catch (e) { threw = true }
    ok('音符表外部改不动', threw || melody.NOTE_FREQ.C4 === 261.63)
    ok('A4 频率正确', melody.NOTE_FREQ.A4 === 440)
    ok('bpm 120 → 0.5 秒/拍', melody.beatSeconds(120) === 0.5)
    ok('bpm 低于 60 按 60 算（30 → 1 秒/拍）', melody.beatSeconds(30) === 1)
    ok('bpm 非法（NaN）落到默认 100', Math.abs(melody.beatSeconds(Number.NaN) - 0.6) < 1e-9)
    ok('bpm 字符串数字也认', melody.beatSeconds('240') === 0.25)
    ok('空谱时长 0', melody.estimateMelodySeconds([], 120) === 0)
    ok('时值求和 × 拍长', melody.estimateMelodySeconds([['C4', 1], ['D4', 2]], 120) === 1.5)
    ok('非法时值按 1 拍、不把时间轴往回拨', melody.estimateMelodySeconds([['C4', -2], ['D4', 0], ['E4', Number.NaN]], 120) === 1.5)
    ok('非数组不崩', melody.estimateMelodySeconds(null, 120) === 0)
  } catch (e) {
    ok('melody 纯函数断言执行', false, String(e && e.message))
  }

  // ---------- ④ melody 播放器：串行 / 打断 / 不泄漏 ----------
  console.log('\n[4] melody.ts 播放器（多段串行、stop 打断、异常隔离）')
  const songClock = installFakeTimers()
  const audio = installAudioStub()
  try {
    const player = melody.createMelodyPlayer()

    ok('没有 AudioContext 时静默返回', (() => {
      const prev = globalThis.window.AudioContext
      globalThis.window.AudioContext = undefined
      let threw = false
      try { player.play([['C4', 1]], 120, () => { }) } catch (e) { threw = true }
      globalThis.window.AudioContext = prev
      return threw === false
    })())

    let done1 = 0
    player.play([['C4', 1], ['E4', 1]], 120, () => { done1++ })
    await songClock.flush()
    ok('两个音各排一个振荡器', audio.ctx.oscs.length === 2, '实际 ' + audio.ctx.oscs.length)
    ok('相邻音符时间轴递进（0.5 秒/拍）',
      Math.abs(audio.ctx.oscs[1].startAt - audio.ctx.oscs[0].startAt - 0.5) < 1e-9)
    ok('每个音都在自己时值内停掉', audio.ctx.oscs.every((o) => o.stopAt > o.startAt))
    songClock.advance(1349)
    ok('onDone 按估算时长触发（未到点）', done1 === 0)
    songClock.advance(1)
    ok('onDone 到点只触发一次', done1 === 1, '实际 ' + done1)
    songClock.advance(5000)
    ok('onDone 不重复触发', done1 === 1)

    // 换曲：旧曲的音必须被停掉
    const firstOscs = audio.ctx.oscs.slice()
    const firstStopCalls = firstOscs.map((o) => o.stopCalls)
    let done2 = 0
    player.play([['G4', 2]], 120, () => { done2++ })
    await songClock.flush()
    ok('换曲先停旧曲（旧音都收到 stop）', firstOscs.every((o, i) => o.stopCalls > firstStopCalls[i]))
    ok('旧曲 onDone 被作废', done2 === 0)
    // 新曲仍在排程中（0.05 + 1.0 秒 + 300ms）
    songClock.advance(1349)
    ok('新曲 onDone 未到点不触发', done2 === 0)
    songClock.advance(1)
    ok('新曲 onDone 到点触发', done2 === 1)

    // stop 打断
    const before = audio.ctx.oscs.length
    let done3 = 0
    player.play([['C4', 4]], 120, () => { done3++ })
    await songClock.flush()
    ok('新曲排程成功', audio.ctx.oscs.length === before + 1)
    player.stop()
    ok('stop() 立刻停掉所有音', audio.ctx.oscs[audio.ctx.oscs.length - 1].stopCalls >= 1)
    ok('stop() 后 AudioContext 挂起（复用而非 close）', audio.ctx.state === 'suspended')
    songClock.advance(10000)
    ok('stop() 之后 onDone 不再触发', done3 === 0)

    // stop 之后迟到的 resume 回调必须作废
    const oscsBefore = audio.ctx.oscs.length
    player.play([['C4', 1], ['D4', 1], ['E4', 1]], 120, () => { })
    player.stop()
    await songClock.flush()
    ok('stop 后迟到的 resume 回调不排程（代次守卫）', audio.ctx.oscs.length === oscsBefore)

    // 空谱 / 非法音名
    let doneEmpty = 0
    player.play([], 120, () => { doneEmpty++ })
    await songClock.flush()
    songClock.advance(349)
    ok('空谱：先不触发 onDone', doneEmpty === 0)
    songClock.advance(1)
    ok('空谱：350ms 后触发 onDone（不卡住上层锁）', doneEmpty === 1)

    const oscsBeforeBad = audio.ctx.oscs.length
    let doneBad = 0
    player.play([['H9', 1], ['C4', 1], ['???', 1]], 120, () => { doneBad++ })
    await songClock.flush()
    ok('非法音名跳过、不为它建振荡器', audio.ctx.oscs.length === oscsBeforeBad + 1, '实际新增 ' + (audio.ctx.oscs.length - oscsBeforeBad))
    songClock.advance(900)
    ok('非法音名仍占用时值（onDone 不提前触发）', doneBad === 0)
    songClock.advance(950)
    ok('非法音名那句照常收尾（onDone 在最后一句之后触发）', doneBad === 1)

    // data/melodies.json 里实际用 'R' 表示休止符：不发音，但必须占满自己的时值
    const oscsBeforeRest = audio.ctx.oscs.length
    let doneRest = 0
    player.play([['R', 1], ['C4', 1]], 120, () => { doneRest++ })
    await songClock.flush()
    ok('休止符 R 不建振荡器（也不报错）', audio.ctx.oscs.length === oscsBeforeRest + 1, '实际新增 ' + (audio.ctx.oscs.length - oscsBeforeRest))
    songClock.advance(1349)
    ok('休止符照占一拍（onDone 不提前）', doneRest === 0)
    songClock.advance(1)
    ok('休止符之后正常收尾', doneRest === 1)

    // 单音排程抛错不连坐整首
    const broken = installAudioStub({ throwOnCreate: 2 })
    const player2 = melody.createMelodyPlayer()
    let doneBroken = 0
    player2.play([['C4', 1], ['D4', 1], ['E4', 1]], 120, () => { doneBroken++ })
    await songClock.flush()
    ok('第 2 个音排程抛错，第 1、3 个照排', broken.ctx.oscs.length === 2, '实际 ' + broken.ctx.oscs.length)
    ok('排程抛错不影响 onDone', (() => { songClock.advance(1850); return doneBroken === 1 })())
    broken.restore()

    ok('播放器全程没有未捕获的定时器异常', songClock.errors.length === 0, songClock.errors.map(String).join(' / '))
  } catch (e) {
    ok('melody 播放器断言执行', false, String(e && e.message))
  } finally {
    audio.restore()
    songClock.restore()
  }

  // ---------- ⑤ reminders 轮询：让路 / 串行 / 收尾 ----------
  console.log('\n[5] reminders.ts 到点轮询（P2 让路、串行、收尾、幂等）')
  try {
    const clock = installFakeTimers()
    const mk = (dueItems, flags = {}) => {
      const out = { speaks: [], bubbles: [], talks: [], fetches: 0 }
      const f = booleans(flags)
      const poller = reminders.createReminderPoller({
        getJson: async (path) => { out.fetches++; out.path = path; return { ok: true, due: typeof dueItems === 'function' ? dueItems() : dueItems } },
        bubble: (t, ms) => out.bubbles.push([t, ms]),
        talkFor: (ms) => out.talks.push(ms),
        speak: (t) => out.speaks.push(t),
        isSpeaking: () => f.speaking,
        isNarrating: () => f.narrating,
        isBusy: () => f.busy,
      }, { intervalMs: 20, retryMs: 10, gapMs: 30, bubbleMs: 100 })
      return { out, f, poller }
    }

    const a = mk([{ id: 'r1', text: '喝水' }, { id: 'r2', text: '吃药' }])
    const stopA = a.poller.start()
    ok('start() 先不立刻取数（等第一个周期）', a.out.fetches === 0)
    clock.advance(20)
    await clock.flush()
    ok('轮询路径是 /reminders?action=due', a.out.path === '/reminders?action=due', a.out.path)
    ok('到点条目立刻播第一条', a.out.speaks.length === 1 && a.out.speaks[0] === '主人，提醒你：喝水', a.out.speaks.join('|'))
    ok('气泡与朗读同文案、气泡时长走 bubbleMs', a.out.bubbles[0][0] === '主人，提醒你：喝水' && a.out.bubbles[0][1] === 100)
    ok('动画开口 talkFor(3000)', a.out.talks[0] === 3000)
    clock.advance(29)
    ok('两条之间隔 gapMs（未到点不抢第二条）', a.out.speaks.length === 1)
    clock.advance(1)
    ok('间隔到点播第二条（串行）', a.out.speaks.length === 2 && a.out.speaks[1] === '主人，提醒你：吃药')
    stopA()
    clock.advance(5000)
    ok('收尾后不再有播报', a.out.speaks.length === 2)

    // 三类占线各自都要让路
    for (const flag of ['speaking', 'narrating', 'busy']) {
      const b = mk([{ id: 'x', text: '该让路' }], { [flag]: true })
      const stopB = b.poller.start()
      clock.advance(20)
      await clock.flush()
      ok(flag + ' 时提醒不插队（不朗读）', b.out.speaks.length === 0)
      clock.advance(10)
      ok(flag + ' 时按 retryMs 重试而不是丢弃', b.out.speaks.length === 0)
      b.f[flag] = false
      clock.advance(10)
      ok(flag + ' 解除后自动补播', b.out.speaks.length === 1)
      stopB()
    }

    // 空正文：走「时间到了」兜底（不能被过滤掉）
    const c = mk([{ id: 'e', text: '' }, { id: 'e2', text: '   ' }, null, 'garbage'])
    const stopC = c.poller.start()
    clock.advance(20)
    await clock.flush()
    ok('空正文提醒照播（兜底「时间到了」）', c.out.speaks[0] === '主人，提醒你：时间到了', c.out.speaks.join('|'))
    clock.advance(30)
    ok('全空白正文同样兜底', c.out.speaks[1] === '主人，提醒你：时间到了', c.out.speaks.join('|'))
    clock.advance(100)
    ok('非对象条目（null/字符串）被忽略', c.out.speaks.length === 2, '实际 ' + c.out.speaks.length)
    stopC()

    // 卸载收尾：start() 的返回值必须做完整收尾（撤定时器 + 清队列 + 停轮询）
    const d = mk([{ id: 'd1', text: '第一条' }, { id: 'd2', text: '第二条' }])
    const stopD = d.poller.start()
    clock.advance(20)
    await clock.flush()
    ok('收尾前已播第一条', d.out.speaks.length === 1)
    stopD()
    clock.advance(10000)
    ok('start() 的清理函数会清掉待播队列（不止停轮询）', d.out.speaks.length === 1, '实际 ' + d.out.speaks.length)
    ok('收尾后没有残留计时器', clock.count() === 0, '残留 ' + clock.count())

    // 收尾之后迟到的轮询响应不得复活队列
    let release = null
    const outE = { speaks: [], fetches: 0 }
    const pollerE = reminders.createReminderPoller({
      getJson: () => { outE.fetches++; return new Promise((r) => { release = r }) },
      bubble: () => { }, talkFor: () => { }, speak: (t) => outE.speaks.push(t),
      isSpeaking: () => false, isNarrating: () => false, isBusy: () => false,
    }, { intervalMs: 20, retryMs: 10, gapMs: 15 })
    const stopE = pollerE.start()
    clock.advance(20)
    ok('请求已在途', outE.fetches === 1 && typeof release === 'function')
    stopE()
    release({ ok: true, due: [{ id: 'late', text: '迟到的提醒' }] })
    await clock.flush()
    clock.advance(5000)
    ok('收尾后迟到的响应不再入队/不播报', outE.speaks.length === 0, outE.speaks.join('|'))
    ok('收尾后也不再排新定时器', clock.count() === 0, '残留 ' + clock.count())

    // start 幂等：重复启动不叠加轮询
    const g = mk([{ id: 'g1', text: '只播一次' }])
    const stopG1 = g.poller.start()
    const stopG2 = g.poller.start()
    clock.advance(60)
    await clock.flush()
    ok('重复 start() 不叠加轮询（60ms 内只取数 3 次）', g.out.fetches === 3, '实际 ' + g.out.fetches)
    ok('重复 start() 不重复播报同一条', g.out.speaks.length === 1, g.out.speaks.join('|'))
    stopG1()
    stopG2()
    ok('重复收尾幂等、无残留计时器', clock.count() === 0, '残留 ' + clock.count())

    // dispose 顺序：手动 dispose 之后 pump 不再排定时器
    const h = mk([{ id: 'h1', text: 'x' }])
    h.poller.start()
    clock.advance(20)
    await clock.flush()
    h.poller.dispose()
    ok('dispose() 后无残留计时器', clock.count() === 0, '残留 ' + clock.count())
    clock.restore()
  } catch (e) {
    ok('reminders 断言执行', false, String(e && e.message))
  }

  // ---------- ⑥ reminder-manage：面板流程 ----------
  console.log('\n[6] reminder-manage.ts 面板（序号 / 删除 / 顺延 / 跨天 / 失败兜底）')
  try {
    ok('窗口 60 秒、顺延 10 分钟', manage.MANAGE_WINDOW_MS === 60000 && manage.POSTPONE_MS === 600000)
    ok('提示文案固定', manage.MANAGE_HINT === '回复数字可删除 / 回 d 顺延 10 分钟')

    ok('归一化去标点空格', manage.normalizeManageInput(' 1 。，') === '1')
    ok('d 判顺延（大小写都认）', manage.parseManageInput('D。').kind === 'postpone' && manage.parseManageInput('d').kind === 'postpone')
    ok('纯数字判删除', (() => { const r = manage.parseManageInput(' 3 '); return r && r.kind === 'delete' && r.index === 3 })())
    ok('前导零按十进制', manage.parseManageInput('007').index === 7)
    ok('对话输入放行', manage.parseManageInput('今天天气怎么样') === null && manage.parseManageInput('') === null)
    ok('四位以上数字不当序号', manage.parseManageInput('1234') === null)

    ok('坏时间显示 --:--', manage.formatClock('not-a-date') === '--:--')
    const sameDay = new Date(2026, 10, 7, 14, 30)
    ok('formatClock 本地时分补零', manage.formatClock(sameDay) === '14:30', manage.formatClock(sameDay))

    const items = [
      { id: 'a', text: '喝水', at: '2026-11-07T01:00:00.000Z' },
      { id: 'b', text: '吃药', at: '2026-11-07T00:30:00.000Z', repeat: 3600 },
      { id: 'c', text: '睡觉', at: 'bad', nextAt: '2026-11-07T00:10:00.000Z' },
    ]
    ok('清单文本带序号/时间/重复标记', (() => {
      const s = manage.boardText(items, '提醒清单（3 条）：')
      return s.indexOf('提醒清单（3 条）：\n') === 0
        && s.indexOf('1. 喝水（') > 0
        && s.indexOf('2. 吃药（') > 0
        && s.indexOf('（重复）') > 0
        && s.slice(-manage.MANAGE_HINT.length) === manage.MANAGE_HINT
    })())
    ok('空清单文案', manage.boardText([], '前缀') === '前缀\n没有提醒了', JSON.stringify(manage.boardText([], '前缀')))

    ok('坏条目/已完成条目被跳过', (() => {
      const list = manage.normalizeReminderList({ reminders: [{ id: 'a', text: 'x', done: true }, {}, { id: '', text: 'y' }, null, { id: 'b', text: 'z' }] })
      return list.length === 1 && list[0].id === 'b'
    })())
    ok('数组形态响应也认', manage.normalizeReminderList([{ id: 'q', text: 'w' }]).length === 1)
    ok('坏响应不崩', manage.normalizeReminderList(null).length === 0)
    ok('最早到期优先（nextAt 优先于 at）', manage.pickNextDue(items).id === 'c', manage.pickNextDue(items).id)
    ok('空清单没有可顺延项', manage.pickNextDue([]) === null)
    ok('时间全坏时取第一条', manage.pickNextDue([{ id: 'x', text: '', at: 'bad', nextAt: 'bad' }, { id: 'y', text: '', at: 'bad' }]).id === 'x')

    // 面板全流程：可控时钟 + 可编排响应
    let now = new Date(2026, 10, 7, 23, 58).getTime()
    const calls = []
    let server = [
      { id: 'a', text: '喝水', at: '2026-11-07T13:00:00.000Z' },
      { id: 'b', text: '吃药', at: '2026-11-07T13:30:00.000Z', repeat: 3600 },
    ]
    const bubble = []
    const mgr = manage.createReminderManager({
      bubble: (t) => bubble.push(t),
      now: () => now,
      getJson: async (p) => { calls.push('GET ' + p); return { ok: true, reminders: server.map((x) => ({ ...x })) } },
      postJson: async (p, body) => { calls.push('POST ' + p); calls.push(body); return { ok: true, reminder: { id: 'new', ...body } } },
      delJson: async (p) => { calls.push('DEL ' + p); server = server.filter((x) => !p.includes(x.id)); return { ok: true } },
    })

    ok('未打开时 isOpen=false、数字放行', mgr.isOpen() === false && mgr.intercept('1') === false)
    await mgr.open()
    ok('打开后开窗', mgr.isOpen() === true)
    ok('打开气泡含条数与提示', bubble[0].indexOf('提醒清单（2 条）：') === 0 && bubble[0].indexOf(manage.MANAGE_HINT) > 0, bubble[0].split('\n')[0])

    ok('删第 1 条：先本地重编号再删服务端', mgr.intercept('1') === true && calls.some((c) => c === 'DEL /reminders?id=a'))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    await Promise.resolve()
    ok('删除后清单刷新为 1 条', mgr.items().length === 1 && mgr.items()[0].id === 'b', JSON.stringify(mgr.items().map((x) => x.id)))
    ok('删除后有「删掉了」提示', bubble.some((t) => t.indexOf('删掉了') === 0), bubble.join(' | '))

    // 序号不存在
    const bubbleBefore = bubble.length
    ok('序号不存在也算接住（不送模型）', mgr.intercept('9') === true)
    ok('序号不存在给提示', bubble.length > bubbleBefore && bubble[bubble.length - 1].indexOf('没有第 9 条') === 0, bubble[bubble.length - 1])

    // 顺延：先加新、再删旧；跨零点要带「明天」
    calls.length = 0
    mgr.intercept('d')
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    await Promise.resolve()
    const post = calls.find((c) => c && typeof c === 'object')
    ok('顺延先 POST 新提醒', !!post && post.text === '吃药' && post.repeat === 3600, JSON.stringify(post))
    ok('顺延时间 = 原到期 + 10 分钟（跨零点）', !!post && post.at === new Date(2026, 10, 8, 0, 8).toISOString(), post && post.at)
    ok('顺延提示带「明天」', bubble.some((t) => t.indexOf('明天 00:08') > 0), bubble.join(' | '))
    ok('顺延成功后删旧条目', calls.some((c) => c === 'DEL /reminders?id=b'), calls.join(' , '))

    // 同一天顺延：提示只有时分（不画蛇添足加日期）
    const nowS = new Date(2026, 10, 7, 14, 20).getTime()
    const bubbleS = []
    const mkMgr = (items, sink) => manage.createReminderManager({
      bubble: (t) => sink.push(t),
      now: () => nowS,
      getJson: async () => ({ reminders: items }),
      postJson: async () => ({ ok: true }),
      delJson: async () => ({ ok: true }),
    })
    const mgrS = mkMgr([{ id: 's', text: '开会', at: new Date(2026, 10, 7, 14, 25).toISOString() }], bubbleS)
    await mgrS.open()
    mgrS.intercept('d')
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    ok('同一天顺延：提示只有时分', bubbleS.some((t) => t.indexOf('顺延到 14:35') === 0), bubbleS.join(' | '))

    // 多天后的提醒顺延：提示要带「M月D日」，否则看不出是哪天
    const bubbleM = []
    const mgrM = mkMgr([{ id: 'm', text: '体检', at: new Date(2026, 10, 10, 9, 0).toISOString() }], bubbleM)
    await mgrM.open()
    mgrM.intercept('d')
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    ok('多天后顺延：提示带「M月D日」', bubbleM.some((t) => t.indexOf('顺延到 11月10日 09:10') === 0), bubbleM.join(' | '))

    // 顺延失败：POST 失败时原提醒必须原样留着
    const bubbleF = []
    let delCalls = 0
    const mgrF = manage.createReminderManager({
      bubble: (t) => bubbleF.push(t),
      now: () => now,
      getJson: async () => ({ reminders: [{ id: 'z', text: '还钱', at: new Date(now - 60000).toISOString() }] }),
      postJson: async () => { throw new Error('post down') },
      delJson: async () => { delCalls++; return { ok: true } },
    })
    await mgrF.open()
    mgrF.intercept('d')
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    ok('顺延 POST 失败：提示「顺延没成，原提醒还在」', bubbleF[bubbleF.length - 1] === '顺延没成，原提醒还在', bubbleF.join(' | '))
    ok('顺延 POST 失败：绝不删旧提醒', delCalls === 0, String(delCalls))

    // 删除失败（服务端 ok:false）：提示没删掉，并按服务端清单复位
    const bubbleD = []
    const mgrD = manage.createReminderManager({
      bubble: (t) => bubbleD.push(t),
      now: () => now,
      getJson: async () => ({ reminders: [{ id: 'k', text: '交水费', at: new Date(now).toISOString() }] }),
      postJson: async () => ({ ok: true }),
      delJson: async () => ({ ok: false }),
    })
    await mgrD.open()
    mgrD.intercept('1')
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    ok('删除失败：气泡说明没删掉', bubbleD.some((t) => t.indexOf('没删掉，最新清单：') === 0), bubbleD.join(' | '))
    ok('删除失败：清单按服务端复位（条目还在）', mgrD.items().length === 1 && mgrD.items()[0].id === 'k', JSON.stringify(mgrD.items().map((x) => x.id)))

    // 窗口过期：开窗满 60 秒后数字交还聊天
    let nowW = new Date(2026, 10, 7, 12, 0).getTime()
    const mgrW = manage.createReminderManager({
      bubble: () => { },
      now: () => nowW,
      getJson: async () => ({ reminders: [{ id: 'w', text: '午睡', at: new Date(nowW + 60000).toISOString() }] }),
      postJson: async () => ({ ok: true }),
      delJson: async () => ({ ok: true }),
    })
    await mgrW.open()
    ok('窗口内：isOpen 且接住数字', mgrW.isOpen() === true && mgrW.intercept('1') === true)
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    nowW += manage.MANAGE_WINDOW_MS + 1
    ok('超过 60 秒窗口自动失效', mgrW.isOpen() === false)
    ok('窗口失效后数字交给聊天', mgrW.intercept('1') === false)

    // 失败兜底：清单取不到
    const bubble2 = []
    const bad = manage.createReminderManager({
      bubble: (t) => bubble2.push(t),
      now: () => now,
      getJson: async () => { throw new Error('net down') },
      postJson: async () => ({ ok: true }),
      delJson: async () => ({ ok: true }),
    })
    await bad.open()
    ok('取数失败：不开窗、只轻提示', bad.isOpen() === false && bubble2[bubble2.length - 1] === '提醒清单查不到')
    ok('取数失败后数字放行', bad.intercept('1') === false)

    // 并发打开：只认最后一次
    const bubble3 = []
    let pend = []
    const mgr2 = manage.createReminderManager({
      bubble: (t) => bubble3.push(t),
      now: () => now,
      getJson: () => new Promise((r) => pend.push(r)),
      postJson: async () => ({ ok: true }),
      delJson: async () => ({ ok: true }),
    })
    const p1 = mgr2.open()
    const p2 = mgr2.open()
    pend[0]({ reminders: [{ id: 'old', text: '旧清单', at: '2026-11-07T13:00:00.000Z' }] })
    await p1
    pend[1]({ reminders: [{ id: 'n1', text: '新1', at: '2026-11-07T13:00:00.000Z' }, { id: 'n2', text: '新2', at: '2026-11-07T13:10:00.000Z' }] })
    await p2
    ok('并发打开只认最后一次（旧响应不覆盖新清单）', mgr2.items().length === 2 && mgr2.items()[0].id === 'n1', JSON.stringify(mgr2.items().map((x) => x.id)))
    ok('并发打开的气泡也只出现新清单', bubble3.length === 1 && bubble3[0].indexOf('提醒清单（2 条）') === 0, bubble3.join(' | '))

    // 空清单不开窗
    const bubble4 = []
    const empty = manage.createReminderManager({
      bubble: (t) => bubble4.push(t),
      now: () => now,
      getJson: async () => ({ reminders: [] }),
    })
    await empty.open()
    ok('空清单不开窗（避免吞掉下一条输入）', empty.isOpen() === false && bubble4[0] === '还没有提醒～')
  } catch (e) {
    ok('reminder-manage 断言执行', false, String(e && e.stack || e))
  }

  // ---------- ⑦ image / dropzone：类型、体积、失败清状态、objectURL ----------
  console.log('\n[7] image.ts + dropzone.ts（类型/体积/失败清状态/内存释放）')
  const realFileReader = globalThis.FileReader
  const realFetch = globalThis.fetch
  try {
    // FileReader：正常 / 抛错 / onerror
    const dataUrlReader = (payload) => class {
      constructor() { this.result = payload }
      readAsDataURL() { setTimeout(() => this.onloadend && this.onloadend(), 0) }
    }
    globalThis.FileReader = dataUrlReader('data:image/png;base64,QUJD')
    ok('读图去 data: 前缀', (await image.readFileAsBase64({ type: 'image/png' })) === 'QUJD')
    globalThis.FileReader = class { readAsDataURL() { throw new Error('no reader') } }
    ok('FileReader 同步抛错 → 空串（不抛给调用方）', (await image.readFileAsBase64({})) === '')
    globalThis.FileReader = class { readAsDataURL() { setTimeout(() => this.onerror && this.onerror(), 0) } }
    ok('FileReader onerror → 空串', (await image.readFileAsBase64({})) === '')
    ok('读不出图 → null（调用方走失败气泡）', (await image.imageToB64({ type: 'image/png' })) === null)

    // 小图不压；无 canvas 的大图回退原图
    globalThis.FileReader = dataUrlReader('data:image/png;base64,' + 'A'.repeat(1000))
    const small = await image.imageToB64({ type: 'image/png' })
    ok('小图原样返回（不折腾 canvas）', small.compressed === false && small.mime === 'image/png' && small.b64.length === 1000)
    globalThis.FileReader = dataUrlReader('data:image/png;base64,' + 'B'.repeat(500 * 1024))
    const big = await image.imageToB64({ type: 'image/png' })
    ok('无 canvas 的大图回退原图（绝不把看图弄挂）', big.compressed === false && big.b64.length === 500 * 1024)

    // objectURL：正常加载要 revoke
    const realWindow = globalThis.window
    const urlStub = { created: 0, revoked: 0, createObjectURL() { urlStub.created++; return 'blob:fake' }, revokeObjectURL() { urlStub.revoked++ } }
    globalThis.FileReader = dataUrlReader('data:image/png;base64,' + 'C'.repeat(500 * 1024))
    globalThis.window = { URL: urlStub, Image: class { set src(_v) { setTimeout(() => this.onload && this.onload(), 0) } } }
    const viaImage = await image.imageToB64({ type: 'image/png', size: 500 * 1024 })
    ok('退化到 Image+objectURL 时确实建了 URL', urlStub.created === 1)
    ok('加载完成 / 失败都要 revoke objectURL', urlStub.revoked === 1, 'created=' + urlStub.created + ' revoked=' + urlStub.revoked)
    ok('退化路径同样回退原图（无 canvas）', viaImage.compressed === false)

    // objectURL：new Image 抛错也必须 revoke（旧实现在这条路上漏 Blob）
    urlStub.created = 0
    urlStub.revoked = 0
    globalThis.window = { URL: urlStub, Image: class { constructor() { throw new Error('image ctor boom') } } }
    const viaThrow = await image.imageToB64({ type: 'image/png', size: 500 * 1024 })
    ok('new Image() 抛错不把异常抛给调用方', viaThrow && viaThrow.compressed === false)
    ok('new Image() 抛错后 objectURL 仍被 revoke（不泄漏 Blob）', urlStub.created === 1 && urlStub.revoked === 1, 'created=' + urlStub.created + ' revoked=' + urlStub.revoked)
    if (realWindow === undefined) delete globalThis.window
    else globalThis.window = realWindow

    // dropzone：类型 / 体积 / 多分支
    ok('图片判定看 mime', dropzone.isImageFile({ type: 'image/png' }) && !dropzone.isImageFile({ type: 'text/plain' }) && !dropzone.isImageFile(null))
    ok('文本判定看扩展名（大小写都认）', dropzone.isTextFile({ name: 'a.MD' }) && !dropzone.isTextFile({ name: 'a.pdf' }))
    ok('提示词截断 4000 字', dropzone.buildTextPrompt('字'.repeat(5000)).length === '总结一下这篇文档：\n'.length + 4000)
    ok('4MB 常量与上限一致', dropzone.MAX_DROP_BYTES === 4 * 1024 * 1024)

    const noop = () => { }
    const stubFetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, reply: '看着像一碗白饭' }) })
    ok('没文件 → empty', (await dropzone.handleFileDrop(null, { showBubble: noop, fetchImpl: stubFetch })).kind === 'empty')
    ok('超 4MB → too-large（先拦，不读文件）', (await dropzone.handleFileDrop({ size: 5 * 1024 * 1024 }, { showBubble: noop, fetchImpl: stubFetch })).kind === 'too-large')
    ok('没有 fetch → error', (await dropzone.handleFileDrop({ size: 10, name: 'a.txt' }, { showBubble: noop, fetchImpl: null })).kind === 'error')
    ok('拖入非图片非文本 → unsupported', (await dropzone.handleFileDrop({ size: 10, name: 'a.pdf', type: 'application/pdf' }, { showBubble: noop, fetchImpl: stubFetch })).kind === 'unsupported')

    // 图片：base64 超上限在客户端就拦
    globalThis.FileReader = dataUrlReader('data:image/png;base64,' + 'D'.repeat(4 * 1024 * 1024 + 8))
    const bubbles = []
    const tooBig = await dropzone.handleFileDrop({ size: 100, name: 'p.png', type: 'image/png' }, { showBubble: (t) => bubbles.push(t), fetchImpl: stubFetch })
    ok('单图 base64 超 4MB 字符 → too-large（不白传一遍）', tooBig.kind === 'too-large' && bubbles.some((t) => t.indexOf('这张图太大啦') === 0))

    // 图片：正常路径
    globalThis.FileReader = dataUrlReader('data:image/png;base64,QUJD')
    const bodies = []
    const okFetch = async (_url, init) => { bodies.push(JSON.parse(String(init.body))); return { ok: true, status: 200, json: async () => ({ ok: true, reply: '一碗白饭' }) } }
    const spoke = []
    const rImg = await dropzone.handleFileDrop({ size: 100, name: 'p.png', type: 'image/png' }, { showBubble: noop, speakText: (t) => spoke.push(t), fetchImpl: okFetch })
    ok('图片：走视觉提问并朗读回复', rImg.ok === true && rImg.kind === 'image' && rImg.message === dropzone.VISION_PROMPT && spoke[0] === '一碗白饭')
    ok('图片：请求带 image 与 mime', bodies[0].image === 'QUJD' && bodies[0].imageMime === 'image/png')

    // 朗读回调抛错不能把成功变成失败
    const rSpeakBoom = await dropzone.handleFileDrop({ size: 100, name: 'p.png', type: 'image/png' }, {
      showBubble: noop,
      speakText: () => { throw new Error('tts down') },
      fetchImpl: okFetch,
    })
    ok('朗读回调抛错不改判成功（仍是 ok/看图）', rSpeakBoom.ok === true && rSpeakBoom.kind === 'image', JSON.stringify(rSpeakBoom))

    // 文本：空文件 / 读失败 / HTTP 错误
    ok('空文档 → error', (await dropzone.handleFileDrop({ size: 10, name: 'e.txt', text: async () => '   ' }, { showBubble: noop, fetchImpl: okFetch })).kind === 'error')
    ok('文档读失败 → error', (await dropzone.handleFileDrop({ size: 10, name: 'b.txt', text: async () => { throw new Error('x') } }, { showBubble: noop, fetchImpl: okFetch })).kind === 'error')
    const b413 = []
    const n413 = await dropzone.handleFileDrop({ size: 100, name: 'p.png', type: 'image/png' }, {
      showBubble: (t) => b413.push(t),
      fetchImpl: async () => ({ ok: false, status: 413, json: async () => ({ ok: false, reply: '太大' }) }),
    })
    ok('HTTP 413 → too-large 且冒服务端文案', n413.kind === 'too-large' && b413.some((t) => t === '太大'), JSON.stringify(n413))
    const rNet = await dropzone.handleFileDrop({ size: 10, name: 'n.md', type: 'text/markdown', text: async () => '正文' }, { showBubble: noop, fetchImpl: async () => { throw new Error('net down') } })
    ok('网络失败 → error（不抛）', rNet.ok === false && rNet.kind === 'error')
    const rJson = await dropzone.handleFileDrop({ size: 10, name: 'n.md', text: async () => '正文' }, { showBubble: noop, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: '模型没空' }) }) })
    ok('业务 ok:false → error 且带服务端原因', rJson.ok === false && rJson.error === '模型没空', JSON.stringify(rJson))
  } catch (e) {
    ok('image/dropzone 断言执行', false, String(e && e.stack || e))
  } finally {
    globalThis.FileReader = realFileReader
    globalThis.fetch = realFetch
  }

  console.log('\n通过 ' + pass + ' 项 / 失败 ' + fail + ' 项')
  if (fail > 0) {
    console.log('  ❌ 有断言失败')
    process.exit(1)
  }
  console.log('  ✅ 全绿')
  process.exit(0)
}

main().catch((e) => {
  console.error('测试脚本自身异常：', e)
  process.exit(1)
})
