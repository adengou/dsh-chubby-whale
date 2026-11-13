/**
 * scripts/test-nervous-events.mjs —— 神经事件源（src/client/nervous/events.ts）的离线回归
 *
 * 覆盖：首调不报 long-work、2 小时门槛、四条规则各自的触发边界与冷却、
 * 四条规则互不干扰、非法输入不抛错、以及「纯函数」约束（不改 prev / 不读 Date.now）。
 *
 * 做法：esbuild 把 events.ts 打成一份 ESM（不碰 dist/、不联网），落到项目内临时目录
 * 再 import —— 跑的是「构建后同一份代码」。临时目录用 `.tmp-` 前缀（仓库 .gitignore
 * 已忽略），跑完即删；用项目内而不是系统临时目录，是因为 esbuild 子进程写系统临时
 * 目录在 Windows 上可能被 ACL 拒（与 verify-voice / test-story-client 同口径）。
 *
 * 用法：node scripts/test-nervous-events.mjs（全绿退出码 0，任何断言失败退出码 1）
 */

import { build } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TMP = join(ROOT, '.tmp-nervous-events')
const BUNDLE = join(TMP, 'nervous-events.mjs')

const MIN = 60 * 1000
const HOUR = 60 * MIN
/** 固定基准时刻（2026-01-15 10:00 UTC）：测试不依赖真实时钟 */
const T0 = Date.UTC(2026, 0, 15, 10, 0, 0)
/** 同日凌晨 3 点（hour 仍由 input 单独给，这里只是让时间戳看起来合理） */
const NIGHT = T0 - 7 * HOUR

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.error('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}
const show = (v) => JSON.stringify(v)
const kindsOf = (r) => (r && Array.isArray(r.events) ? r.events.map((e) => e.kind) : [])
const sameKinds = (r, expect) => JSON.stringify(kindsOf(r)) === JSON.stringify(expect)

async function main() {
  mkdirSync(TMP, { recursive: true })
  try {
    // ---------- esbuild 打包（源码直打，产物只落在临时目录） ----------
    try {
      await build({
        stdin: {
          contents: "export * as events from './client/nervous/events.js'\n",
          resolveDir: join(ROOT, 'src'),
          sourcefile: 'nervous-events-entry.ts',
          loader: 'ts',
        },
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node22',
        charset: 'utf8',
        logLevel: 'silent',
        outfile: BUNDLE,
      })
      ok('esbuild 打包 src/client/nervous/events.ts（离线 / 不碰 dist）', true)
    } catch (e) {
      ok('esbuild 打包 src/client/nervous/events.ts（离线 / 不碰 dist）', false, String((e && e.message) || e))
      console.error(String((e && e.stack) || e))
      return
    }

    let E
    try {
      const mod = await import(pathToFileURL(BUNDLE).href)
      E = mod.events
      ok('装载模块并拿到 senseEvents', !!(E && typeof E.senseEvents === 'function'))
    } catch (e) {
      ok('装载模块并拿到 senseEvents', false, String((e && e.message) || e))
      console.error(String((e && e.stack) || e))
      return
    }

    // ==================================================================
    console.log('\n[1] 首次调用：只立会话起点，不报 long-work')
    {
      const r = E.senseEvents({ now: T0, lastActivityAt: T0 - MIN, hour: 10 }, null)
      ok('① 首次调用不触发 long-work', !kindsOf(r).includes('long-work'), show(kindsOf(r)))
      ok('① 首次调用不产生任何事件（1 分钟前刚活动，不在其它窗口）', r.events.length === 0, show(r.events))
      ok('① seenAt 初始化为 now', r.next.seenAt === T0, show(r.next.seenAt))
      ok('① 首次调用没有历史触发记录', Object.keys(r.next.lastTriggerAt).length === 0, show(r.next.lastTriggerAt))
    }

    // ==================================================================
    console.log('\n[2] 连续工作：≥2 小时且 10 分钟内有活动')
    {
      const prev = { lastTriggerAt: {}, seenAt: T0 }
      const now = T0 + 2 * HOUR
      const r = E.senseEvents({ now, lastActivityAt: now - MIN, hour: 10 }, prev)
      ok('② 满 2 小时且刚有活动 → long-work', sameKinds(r, ['long-work']), show(kindsOf(r)))
      ok('② 事件时刻 = now', r.events.length === 1 && r.events[0].at === now, show(r.events))
      ok('② 记入 lastTriggerAt', r.next.lastTriggerAt['long-work'] === now, show(r.next.lastTriggerAt))
      ok('② 会话起点保持不变', r.next.seenAt === T0, show(r.next.seenAt))

      const justBefore = E.senseEvents({ now: T0 + 2 * HOUR - 1, lastActivityAt: T0 + 2 * HOUR - 1 - MIN, hour: 10 }, prev)
      ok('② 差 1 毫秒不满 2 小时 → 不报', !kindsOf(justBefore).includes('long-work'), show(kindsOf(justBefore)))

      const noActivity = E.senseEvents({ now: T0 + 3 * HOUR, lastActivityAt: T0 + 3 * HOUR - 40 * MIN, hour: 10 }, prev)
      ok('② 3 小时但 40 分钟没活动 → 不报 long-work', !kindsOf(noActivity).includes('long-work'), show(kindsOf(noActivity)))
      ok('② 40 分钟没活动改报 idle', sameKinds(noActivity, ['idle']), show(kindsOf(noActivity)))
    }

    // ==================================================================
    console.log('\n[3] long-work 的 30 分钟冷却')
    {
      const prev = { lastTriggerAt: {}, seenAt: T0 }
      const first = T0 + 2 * HOUR
      const a = E.senseEvents({ now: first, lastActivityAt: first - MIN, hour: 10 }, prev)
      ok('③ 第一次触发 long-work', sameKinds(a, ['long-work']), show(kindsOf(a)))

      const t29 = first + 29 * MIN
      const b = E.senseEvents({ now: t29, lastActivityAt: t29 - MIN, hour: 10 }, a.next)
      ok('③ 冷却 29 分钟内不重复', !kindsOf(b).includes('long-work'), show(kindsOf(b)))
      ok('③ 冷却期内没有任何新事件', b.events.length === 0, show(b.events))

      const t30 = first + 30 * MIN
      const c = E.senseEvents({ now: t30, lastActivityAt: t30 - MIN, hour: 10 }, b.next)
      ok('③ 满 30 分钟再次触发', sameKinds(c, ['long-work']), show(kindsOf(c)))
      ok('③ 触发时间刷新', c.next.lastTriggerAt['long-work'] === t30, show(c.next.lastTriggerAt))
    }

    // ==================================================================
    console.log('\n[4] 深夜：0-5 点且 10 分钟内有活动，冷却 2 小时')
    {
      const r = E.senseEvents({ now: NIGHT, lastActivityAt: NIGHT - 2 * MIN, hour: 3 }, null)
      ok('④ 凌晨 3 点 → late-night', sameKinds(r, ['late-night']), show(kindsOf(r)))

      for (const h of [0, 5]) {
        const x = E.senseEvents({ now: NIGHT, lastActivityAt: NIGHT - 2 * MIN, hour: h }, null)
        ok('④ ' + h + ' 点仍在深夜窗口', kindsOf(x).includes('late-night'), show(kindsOf(x)))
      }
      for (const h of [6, 10, 23]) {
        const x = E.senseEvents({ now: T0, lastActivityAt: T0 - 2 * MIN, hour: h }, null)
        ok('④ ' + h + ' 点不报 late-night', !kindsOf(x).includes('late-night'), show(kindsOf(x)))
      }
      const morning = E.senseEvents({ now: T0, lastActivityAt: T0 - 2 * MIN, hour: 10 }, null)
      ok('④ 上午 10 点整次判定为空', morning.events.length === 0, show(morning.events))

      const t1 = NIGHT + (2 * HOUR - 1)
      const b = E.senseEvents({ now: t1, lastActivityAt: t1 - MIN, hour: 4 }, r.next)
      ok('④ 差 1 毫秒不满 2 小时 → 冷却中', !kindsOf(b).includes('late-night'), show(kindsOf(b)))

      const t2 = NIGHT + 2 * HOUR
      const c = E.senseEvents({ now: t2, lastActivityAt: t2 - MIN, hour: 5 }, b.next)
      ok('④ 满 2 小时后再次触发 late-night', kindsOf(c).includes('late-night'), show(kindsOf(c)))
      ok('④ 此刻 long-work 也到点（各自独立）', sameKinds(c, ['long-work', 'late-night']), show(kindsOf(c)))
    }

    // ==================================================================
    console.log('\n[5] 久未活动：≥30 分钟，冷却 1 小时')
    {
      const prev = { lastTriggerAt: {}, seenAt: T0 }
      const now = T0 + 3 * HOUR
      const r = E.senseEvents({ now, lastActivityAt: now - 30 * MIN, hour: 10 }, prev)
      ok('⑤ 正好 30 分钟没活动 → idle', sameKinds(r, ['idle']), show(kindsOf(r)))
      ok('⑤ idle 时刻 = now', r.events[0] && r.events[0].at === now, show(r.events))

      const justBefore = E.senseEvents({ now, lastActivityAt: now - (30 * MIN - 1), hour: 10 }, prev)
      ok('⑤ 差 1 毫秒不满 30 分钟 → 不报 idle', !kindsOf(justBefore).includes('idle'), show(kindsOf(justBefore)))
      ok('⑤ 29 分 59 秒归 welcome-back', sameKinds(justBefore, ['welcome-back']), show(kindsOf(justBefore)))

      const t59 = now + 59 * MIN
      const b = E.senseEvents({ now: t59, lastActivityAt: now - 30 * MIN, hour: 10 }, r.next)
      ok('⑤ 冷却 59 分钟不重复', !kindsOf(b).includes('idle'), show(kindsOf(b)))

      const t60 = now + 60 * MIN
      const c = E.senseEvents({ now: t60, lastActivityAt: now - 30 * MIN, hour: 10 }, b.next)
      ok('⑤ 满 60 分钟再次触发', sameKinds(c, ['idle']), show(kindsOf(c)))
    }

    // ==================================================================
    console.log('\n[6] 短暂离开又回来：[5, 30) 分钟，冷却 30 分钟')
    {
      const prev = { lastTriggerAt: {}, seenAt: T0 }
      const now = T0 + HOUR
      const r = E.senseEvents({ now, lastActivityAt: now - 8 * MIN, hour: 10 }, prev)
      ok('⑥ 离开 8 分钟后回来 → welcome-back', sameKinds(r, ['welcome-back']), show(kindsOf(r)))

      const tooShort = E.senseEvents({ now, lastActivityAt: now - (5 * MIN - 1), hour: 10 }, prev)
      ok('⑥ 不足 5 分钟不触发', !kindsOf(tooShort).includes('welcome-back'), show(kindsOf(tooShort)))
      ok('⑥ 不足 5 分钟也不报其它事件', tooShort.events.length === 0, show(tooShort.events))

      const exact5 = E.senseEvents({ now, lastActivityAt: now - 5 * MIN, hour: 10 }, prev)
      ok('⑥ 正好 5 分钟 → 触发', sameKinds(exact5, ['welcome-back']), show(kindsOf(exact5)))

      const at30 = E.senseEvents({ now, lastActivityAt: now - 30 * MIN, hour: 10 }, prev)
      ok('⑥ 满 30 分钟归 idle，不算 welcome-back',
        kindsOf(at30).includes('idle') && !kindsOf(at30).includes('welcome-back'), show(kindsOf(at30)))

      const t29 = now + 29 * MIN
      const b = E.senseEvents({ now: t29, lastActivityAt: t29 - 8 * MIN, hour: 10 }, r.next)
      ok('⑥ 冷却 29 分钟不重复', !kindsOf(b).includes('welcome-back'), show(kindsOf(b)))

      const t30 = now + 30 * MIN
      const c = E.senseEvents({ now: t30, lastActivityAt: t30 - 8 * MIN, hour: 10 }, b.next)
      ok('⑥ 满 30 分钟再次触发', sameKinds(c, ['welcome-back']), show(kindsOf(c)))
    }

    // ==================================================================
    console.log('\n[7] 四条事件互不干扰：各自独立冷却')
    {
      // 凌晨 3 点、已连续工作 3 小时、6 分钟前还在动 → 三条规则同拍命中
      const prev = { lastTriggerAt: {}, seenAt: NIGHT - 3 * HOUR }
      const a = E.senseEvents({ now: NIGHT, lastActivityAt: NIGHT - 6 * MIN, hour: 3 }, prev)
      ok('⑦ 同拍触发 long-work / late-night / welcome-back',
        sameKinds(a, ['long-work', 'late-night', 'welcome-back']), show(kindsOf(a)))
      ok('⑦ 三条各记各的触发时刻',
        a.next.lastTriggerAt['long-work'] === NIGHT && a.next.lastTriggerAt['late-night'] === NIGHT &&
        a.next.lastTriggerAt['welcome-back'] === NIGHT, show(a.next.lastTriggerAt))
      ok('⑦ 没触发的 idle 不留记录', a.next.lastTriggerAt['idle'] === undefined, show(a.next.lastTriggerAt))

      const t1 = NIGHT + MIN
      const b = E.senseEvents({ now: t1, lastActivityAt: t1 - MIN, hour: 3 }, a.next)
      ok('⑦ 三条都在冷却 → 空', b.events.length === 0, show(b.events))

      const t31 = NIGHT + 31 * MIN
      const c = E.senseEvents({ now: t31, lastActivityAt: t31 - MIN, hour: 3 }, b.next)
      ok('⑦ 31 分钟后只有 long-work 解冻', sameKinds(c, ['long-work']), show(kindsOf(c)))

      const t2h = NIGHT + 2 * HOUR
      const d = E.senseEvents({ now: t2h, lastActivityAt: t2h - MIN, hour: 3 }, c.next)
      ok('⑦ 2 小时后 late-night 独立解冻', sameKinds(d, ['long-work', 'late-night']), show(kindsOf(d)))
      ok('⑦ 早先的 welcome-back 记录仍在', d.next.lastTriggerAt['welcome-back'] === NIGHT, show(d.next.lastTriggerAt))
      ok('⑦ 触发表只含触过的三种', Object.keys(d.next.lastTriggerAt).sort().join(',') === 'late-night,long-work,welcome-back',
        show(d.next.lastTriggerAt))

      const tIdle = NIGHT + 4 * HOUR
      const e = E.senseEvents({ now: tIdle, lastActivityAt: NIGHT + 2 * HOUR, hour: 10 }, d.next)
      ok('⑦ idle 不受前三条冷却影响', sameKinds(e, ['idle']), show(kindsOf(e)))
      ok('⑦ idle 触发后旧记录不丢',
        e.next.lastTriggerAt['long-work'] === t2h && e.next.lastTriggerAt['idle'] === tIdle, show(e.next.lastTriggerAt))
    }

    // ==================================================================
    console.log('\n[8] 非法输入：不抛错，按不触发处理')
    {
      const noThrow = (name, fn) => {
        try {
          const r = fn()
          const shapeOk = !!(r && Array.isArray(r.events) && r.next && typeof r.next === 'object' &&
            typeof r.next.seenAt === 'number' && r.next.lastTriggerAt && typeof r.next.lastTriggerAt === 'object')
          ok('⑧ ' + name + '：不抛错且形状完整', shapeOk, show(r))
          return r
        } catch (err) {
          ok('⑧ ' + name + '：不抛错且形状完整', false, String((err && err.stack) || err))
          return null
        }
      }

      const r1 = noThrow('input=null', () => E.senseEvents(null, null))
      ok('⑧ input=null 不产生事件', r1 && r1.events.length === 0, show(r1 && r1.events))
      ok('⑧ input=null 的 seenAt 仍是有限数', r1 && Number.isFinite(r1.next.seenAt), show(r1 && r1.next.seenAt))

      const r2 = noThrow('input=undefined（带合法 prev）', () => E.senseEvents(undefined, { lastTriggerAt: {}, seenAt: T0 }))
      ok('⑧ input=undefined 保留原会话起点', r2 && r2.next.seenAt === T0, show(r2 && r2.next.seenAt))

      const r3 = noThrow('now=NaN', () => E.senseEvents(
        { now: NaN, lastActivityAt: NIGHT - MIN, hour: 3 }, { lastTriggerAt: {}, seenAt: NIGHT - 3 * HOUR }))
      ok('⑧ now=NaN 不产生事件', r3 && r3.events.length === 0, show(r3 && r3.events))

      const r4 = noThrow('now 负数', () => E.senseEvents({ now: -1, lastActivityAt: NIGHT - MIN, hour: 3 }, null))
      ok('⑧ now 为负数不产生事件', r4 && r4.events.length === 0, show(r4 && r4.events))

      const r5 = noThrow('lastActivityAt=NaN', () => E.senseEvents({ now: NIGHT, lastActivityAt: NaN, hour: 3 }, null))
      ok('⑧ 活动时间非法 → 四条规则都不报', r5 && r5.events.length === 0, show(r5 && r5.events))

      const r6 = noThrow('lastActivityAt 负数', () => E.senseEvents({ now: NIGHT, lastActivityAt: -5, hour: 3 }, null))
      ok('⑧ 活动时间为负 → 不产生事件', r6 && r6.events.length === 0, show(r6 && r6.events))

      const r7 = noThrow('hour=NaN', () => E.senseEvents({ now: NIGHT, lastActivityAt: NIGHT - 2 * MIN, hour: NaN }, null))
      ok('⑧ hour 非法 → 不报 late-night', r7 && r7.events.length === 0, show(r7 && r7.events))

      for (const h of [-1, 24, '3', null]) {
        const x = noThrow('hour=' + show(h), () => E.senseEvents({ now: NIGHT, lastActivityAt: NIGHT - 2 * MIN, hour: h }, null))
        ok('⑧ hour=' + show(h) + ' 不报 late-night', x && x.events.length === 0, show(x && x.events))
      }

      const r8 = noThrow('缺字段', () => E.senseEvents({}, null))
      ok('⑧ 缺字段不产生事件', r8 && r8.events.length === 0, show(r8 && r8.events))

      const r9 = noThrow('prev 脏（lastTriggerAt=null / seenAt="x"）', () => E.senseEvents(
        { now: NIGHT, lastActivityAt: NIGHT - 2 * MIN, hour: 3 }, { lastTriggerAt: null, seenAt: 'x' }))
      ok('⑧ prev 脏 → 当首次调用，仍能判 late-night', r9 && sameKinds(r9, ['late-night']), show(r9 && kindsOf(r9)))
      ok('⑧ prev 脏 → 不沿用非法 seenAt', r9 && r9.next.seenAt === NIGHT, show(r9 && r9.next.seenAt))

      const r10 = noThrow('prev 是数组', () => E.senseEvents(
        { now: NIGHT, lastActivityAt: NIGHT - 2 * MIN, hour: 3 }, []))
      ok('⑧ prev 是数组不抛错且能判定', r10 && sameKinds(r10, ['late-night']), show(r10 && kindsOf(r10)))

      const r11 = noThrow('lastTriggerAt 里是 NaN', () => E.senseEvents(
        { now: T0 + 2 * HOUR, lastActivityAt: T0 + 2 * HOUR - MIN, hour: 10 },
        { lastTriggerAt: { 'long-work': NaN }, seenAt: T0 }))
      ok('⑧ NaN 触发记录被丢弃、不挡本轮', r11 && sameKinds(r11, ['long-work']), show(r11 && kindsOf(r11)))

      const r12 = noThrow('lastTriggerAt 里是字符串', () => E.senseEvents(
        { now: T0 + 3 * HOUR, lastActivityAt: T0 + 3 * HOUR - 31 * MIN, hour: 10 },
        { lastTriggerAt: { idle: 'soon' }, seenAt: T0 }))
      ok('⑧ 字符串触发记录被丢弃、不挡本轮', r12 && sameKinds(r12, ['idle']), show(r12 && kindsOf(r12)))
    }

    // ==================================================================
    console.log('\n[9] 纯函数：不改 prev、不读 Date.now()')
    {
      const prev = { lastTriggerAt: { idle: T0 - 5 * HOUR }, seenAt: T0 - 10 * HOUR }
      const snapshot = JSON.stringify(prev)
      const r = E.senseEvents({ now: T0, lastActivityAt: T0 - MIN, hour: 10 }, prev)
      ok('⑨ 不修改 prev', JSON.stringify(prev) === snapshot, show(prev))
      ok('⑨ next 是新对象（不与 prev 共享引用）', r.next !== prev && r.next.lastTriggerAt !== prev.lastTriggerAt)
      ok('⑨ 历史触发记录原样带入 next', r.next.lastTriggerAt['idle'] === T0 - 5 * HOUR, show(r.next.lastTriggerAt))
      ok('⑨ 本轮 long-work 触发（10 小时会话 + 1 分钟前有活动）', kindsOf(r).includes('long-work'), show(kindsOf(r)))

      const realNow = Date.now
      let touched = false
      try {
        Date.now = () => { touched = true; return realNow() }
        E.senseEvents({ now: T0 + 3 * HOUR, lastActivityAt: T0 + 3 * HOUR - 31 * MIN, hour: 10 },
          { lastTriggerAt: {}, seenAt: T0 })
      } finally {
        Date.now = realNow
      }
      ok('⑨ 判定过程不读 Date.now()', touched === false)
    }

    // ==================================================================
    console.log('\n[示例] 四个场景（两个入参 JSON → 事件数组），每个一行')
    const demo = (input, prev) => {
      const r = E.senseEvents(input, prev)
      console.log('  ' + JSON.stringify({ input, prev }) + ' → ' + JSON.stringify(r.events))
    }
    // long-work：会话已 2 小时、2 分钟前还在用
    demo({ now: T0 + 2 * HOUR, lastActivityAt: T0 + 2 * HOUR - 2 * MIN, hour: 10 },
      { lastTriggerAt: {}, seenAt: T0 })
    // late-night：凌晨 3 点、2 分钟前还在用（首调；只有 long-work 被首调抑制）
    demo({ now: NIGHT, lastActivityAt: NIGHT - 2 * MIN, hour: 3 }, null)
    // idle：31 分钟没活动
    demo({ now: T0 + 3 * HOUR, lastActivityAt: T0 + 3 * HOUR - 31 * MIN, hour: 10 }, null)
    // welcome-back：离开 8 分钟后回来
    demo({ now: T0 + HOUR, lastActivityAt: T0 + HOUR - 8 * MIN, hour: 10 }, null)
  } finally {
    rmSync(TMP, { recursive: true, force: true })
  }
}

await main()

if (fail > 0) {
  console.error('\n失败 ' + fail + ' 项（通过 ' + pass + ' 项）')
  process.exit(1)
}
console.log('\n全部通过（' + pass + ' 项断言）')
