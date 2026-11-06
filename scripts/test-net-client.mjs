/**
 * scripts/test-net-client.mjs —— 客户端网络层回归（离线；esbuild 打包 + 全局打桩）
 *
 * 覆盖这一层五个模块的「契约 + 边界」：
 *   src/client/http.ts      URL 前缀 / 方法强制 / JSON 语义 / timeoutSignal 口径
 *   src/client/busy.ts      占线锁边界（staleMs 边界、NaN/Infinity、看门狗）
 *   src/client/endpoint.ts  归一化 / 持久化键 / 存储不可用时的降级
 *   src/client/recover.ts   快捷键判定（含 keyCode 兜底不越权）/ 恢复点 / 解绑
 *   src/shared/sse.ts       帧切分 / 跨 chunk 半行 / 跨 chunk 多字节 / [DONE] / 未知字段 / 非对象帧
 *
 * 为什么用 esbuild 打包：这五个模块在生产里是 client.ts 的打包产物，直接 import .ts
 * 会走 Node 类型剥离，和浏览器里的模块实例化语义不完全一样；打包后再打桩全局，
 * 验证的是「真正会被 bundle 进去的那份代码」。
 *
 * 负向验证（默认开启，--no-mutate 可关）：用 esbuild 插件在打包时把源码里某一行
 * 改坏（变异体），同一套断言必须**报失败**。断言全绿并不能证明测试有牙，
 * 变异体能被抓出来才行。
 *
 * 用法：node scripts/test-net-client.mjs [--no-mutate]
 * 退出码：0 = 全过；1 = 有失败
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import esbuild from 'esbuild'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = path.join(ROOT, '.net-client-tmp')
const ENTRY = path.join(TMP, 'entry.ts')
const WITH_MUTATE = !process.argv.includes('--no-mutate')

let pass = 0
let fail = 0
const failures = []

function makeRec(quiet) {
  return {
    quiet: !!quiet,
    pass: 0,
    fail: 0,
    failures: [],
    ok(name, cond, detail = '') {
      if (cond) {
        this.pass++
        if (!this.quiet) console.log('  ✅ ' + name + (detail ? '  ' + detail : ''))
      } else {
        this.fail++
        this.failures.push(name + (detail ? '  ' + detail : ''))
        console.log('  ❌ ' + name + (detail ? '  ' + detail : ''))
      }
    },
    eq(name, actual, expected) {
      this.ok(name, JSON.stringify(actual) === JSON.stringify(expected),
        '期望 ' + JSON.stringify(expected) + ' / 实际 ' + JSON.stringify(actual))
    },
  }
}

async function group(rec, title, fn) {
  if (!rec.quiet) console.log('\n[' + title + ']')
  try {
    await fn()
  } catch (e) {
    rec.ok(title + '：未抛异常', false, String((e && e.stack) || e))
  }
}

// ---------- 打包 ----------
/**
 * 打一个包含五个模块命名空间的 ESM 包。
 * rules: [[文件名, 原文, 替换]]，只作用于指定文件（变异自检用）。
 */
async function buildBundle(tag, rules = []) {
  const outfile = path.join(TMP, 'bundle-' + tag + '.mjs')
  const plugin = {
    name: 'mutate-net-client',
    setup(b) {
      b.onLoad({ filter: /\.ts$/ }, (args) => {
        if (!/src[\\/](client|shared)[\\/]/.test(args.path)) return null
        let src = readFileSync(args.path, 'utf8')
        for (const [file, from, to] of rules) {
          if (path.basename(args.path) !== file) continue
          if (src.indexOf(from) < 0) throw new Error('变异目标不存在（源码已变？）：' + from.slice(0, 60))
          src = src.split(from).join(to)
        }
        return { contents: src, loader: 'ts' }
      })
    },
  }
  await esbuild.build({
    entryPoints: [ENTRY],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
    plugins: [plugin],
  })
  return import(pathToFileURL(outfile).href + '?tag=' + encodeURIComponent(tag))
}

// ---------- 全局打桩 ----------
function stubLocalStorage(opts = {}) {
  const store = new Map()
  globalThis.localStorage = {
    getItem(k) { if (opts.throwRead) throw new Error('storage denied'); return store.has(k) ? store.get(k) : null },
    setItem(k, v) { if (opts.throwWrite) throw new Error('quota'); store.set(k, String(v)) },
    removeItem(k) { store.delete(k) },
    clear() { store.clear() },
    key(i) { return Array.from(store.keys())[i] === undefined ? null : Array.from(store.keys())[i] },
    get length() { return store.size },
  }
  return store
}

function stubFetch(handler) {
  const log = []
  globalThis.fetch = (url, init) => {
    log.push({ url: String(url), init: init || {} })
    return handler(String(url), init || {}, log.length)
  }
  return log
}

function fakeEvent(over) {
  return Object.assign({
    ctrlKey: false, shiftKey: false, metaKey: false, altKey: false,
    key: '', keyCode: 0, preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true },
  }, over || {})
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 断言套件 ----------
async function suite(mods, rec) {
  const { http, busy, endpoint, recover, sse } = mods

  await group(rec, '1. http.ts：URL 前缀与方法/JSON 契约', async () => {
    rec.eq('API_BASE 唯一前缀', http.API_BASE, '/api/chubby-whale')
    rec.eq('空路径 → 前缀本身', http.apiUrl(''), '/api/chubby-whale')
    rec.eq('/balance → 带前缀', http.apiUrl('/balance'), '/api/chubby-whale/balance')
    rec.eq('无斜杠也带前缀', http.apiUrl('balance'), '/api/chubby-whale/balance')
    rec.eq('带查询串', http.apiUrl('/culture?type=minsu'), '/api/chubby-whale/culture?type=minsu')
    rec.eq('绝对地址原样', http.apiUrl('https://example.com/x'), 'https://example.com/x')
    rec.eq('协议相对地址原样', http.apiUrl('//cdn.example.com/x'), '//cdn.example.com/x')
    rec.eq('已带前缀原样', http.apiUrl('/api/chubby-whale/x'), '/api/chubby-whale/x')

    const log = stubFetch(() => Promise.resolve({
      ok: true, status: 200,
      json: async () => ({ ok: true, value: 7 }),
    }))
    rec.eq('getJson 解析 JSON', await http.getJson('/state'), { ok: true, value: 7 })
    rec.eq('getJson 走统一前缀', log[0].url, '/api/chubby-whale/state')
    rec.eq('getJson 默认 GET（不写 method）', log[0].init.method, undefined)

    log.length = 0
    const data = await http.postJson('/reminders', { text: '喝水' })
    rec.eq('postJson 解析 JSON', data, { ok: true, value: 7 })
    rec.eq('postJson 强制 POST', log[0].init.method, 'POST')
    rec.eq('postJson 带 content-type', log[0].init.headers['content-type'], 'application/json')
    rec.eq('postJson 序列化 body', JSON.parse(log[0].init.body), { text: '喝水' })

    log.length = 0
    await http.postJson('/clear-memory')
    rec.eq('空 body 不写 content-type', log[0].init.headers, undefined)
    rec.eq('空 body 不带 body', log[0].init.body, undefined)

    log.length = 0
    await http.postRaw('/chat-stream', { a: 1 }, { method: 'GET', headers: { 'x-client-id': 't1' } })
    rec.eq('postRaw 不允许 init 改 method', log[0].init.method, 'POST')
    rec.eq('postRaw 保留调用方头 + content-type', log[0].init.headers, { 'content-type': 'application/json', 'x-client-id': 't1' })

    log.length = 0
    await http.delJson('/cache', { method: 'POST' })
    rec.eq('delJson 强制 DELETE', log[0].init.method, 'DELETE')

    // 头注释承诺：4xx/5xx 不抛错，照旧解析 body（调用方 .catch 兜底网络/解析错误）
    stubFetch(() => Promise.resolve({ ok: false, status: 500, json: async () => ({ ok: false, error: 'boom' }) }))
    rec.eq('HTTP 500 不抛错、body 照常解析', await http.postJson('/chat', {}), { ok: false, error: 'boom' })

    rec.eq('timeoutSignal(0) → undefined（按「没有超时」处理）', http.timeoutSignal(0), undefined)
    rec.eq('timeoutSignal(-1) → undefined', http.timeoutSignal(-1), undefined)
    rec.eq('timeoutSignal(NaN) → undefined', http.timeoutSignal(NaN), undefined)
    rec.eq('timeoutSignal(Infinity) → undefined', http.timeoutSignal(Infinity), undefined)
    rec.eq('timeoutSignal(非数字) → undefined', http.timeoutSignal('abc'), undefined)
    rec.eq('timeoutSignal(undefined) → undefined', http.timeoutSignal(undefined), undefined)
    const sig = http.timeoutSignal(40)
    rec.ok('timeoutSignal(40) 返回 signal', !!sig && typeof sig.aborted === 'boolean')
    let waited = 0
    while (sig && !sig.aborted && waited < 1000) { await sleep(10); waited += 10 }
    rec.ok('到点会 abort（超时真的中止上游请求）', !!sig && sig.aborted === true)
    rec.ok('拒绝原因是 TimeoutError（story.ts 依赖这个区分）',
      !!sig && sig.reason && sig.reason.name === 'TimeoutError',
      '获得 ' + String(sig && sig.reason && sig.reason.name))
    globalThis.fetch = undefined
  })

  await group(rec, '2. busy.ts：占线锁边界与纪元哨兵', async () => {
    const lock = busy.createBusyLock({ staleMs: 5000 })
    rec.eq('初始不忙', lock.isBusy(), false)
    rec.eq('不忙时 age=0', lock.age(99999), 0)
    lock.begin(1000)
    rec.eq('begin 后忙', lock.isBusy(), true)
    rec.eq('age 按 begin 时刻算', lock.age(5999), 4999)
    rec.eq('时间倒退时 age 不为负', lock.age(0), 0)
    rec.eq('刚好到 staleMs 不判定超时（严格大于）', lock.watchdog(6000), false)
    rec.eq('超过 1ms 才复位', lock.watchdog(6001), true)
    rec.eq('复位后解锁', lock.isBusy(), false)
    rec.eq('复位后再 watchdog 返回 false', lock.watchdog(99999), false)

    lock.begin(1000)
    lock.end()
    rec.eq('end 立刻解锁', lock.isBusy(), false)
    rec.eq('解锁后 watchdog 不重复计数', lock.watchdog(99999), false)

    const dflt = busy.createBusyLock()
    dflt.begin(0)
    rec.eq('默认阈值 35s：34s 不解锁', dflt.watchdog(34000), false)
    rec.eq('默认阈值 35s：正好 35s 不解锁', dflt.watchdog(35000), false)
    rec.eq('默认阈值 35s：35.001s 解锁', dflt.watchdog(35001), true)
    rec.eq('BUSY_STALE_MS 与默认行为一致', busy.BUSY_STALE_MS, 35000)

    // 时间参数脏值不能把锁卡死（toTime 兜底）
    const inf = busy.createBusyLock({ staleMs: 5000 })
    inf.begin(Infinity)
    rec.ok('begin(Infinity) 不产生非有限 age', Number.isFinite(inf.age(Date.now())))
    rec.ok('begin(Infinity) 仍能被看门狗解开', inf.watchdog(Date.now() + 60000) === true)
    const nan = busy.createBusyLock({ staleMs: 5000 })
    nan.begin(NaN)
    rec.ok('begin(NaN) 不产生 NaN age', !Number.isNaN(nan.age(Date.now())))
    rec.ok('begin(NaN) 仍能被看门狗解开', nan.watchdog(Date.now() + 60000) === true)

    const ep = busy.createEpoch()
    rec.eq('纪元初值 0', ep.current(), 0)
    rec.eq('0 是哨兵、不算有效令牌', ep.isCurrent(0), false)
    const a = ep.next()
    rec.eq('next 返回 1', a, 1)
    rec.eq('当前纪元匹配', ep.isCurrent(a), true)
    rec.eq('旧纪元作废', ep.isCurrent(a - 1), false)
    const b = ep.next()
    rec.eq('进程内单调递增', b, 2)
    rec.eq('开新纪元后旧令牌失效', ep.isCurrent(a), false)
  })

  await group(rec, '3. endpoint.ts：归一化 / 持久化键 / 降级', async () => {
    rec.eq('模式表只有两项', endpoint.ENDPOINT_MODES, ['ape', 'classic'])
    rec.ok('模式表被冻结（外部改不动）', Object.isFrozen(endpoint.ENDPOINT_MODES))
    rec.eq('默认 classic', endpoint.DEFAULT_ENDPOINT_MODE, 'classic')

    rec.eq('undefined → classic', endpoint.normalizeEndpointMode(undefined), 'classic')
    rec.eq('null → classic', endpoint.normalizeEndpointMode(null), 'classic')
    rec.eq('空串 → classic', endpoint.normalizeEndpointMode(''), 'classic')
    rec.eq("'ape' → ape", endpoint.normalizeEndpointMode('ape'), 'ape')
    rec.eq("' ape ' → ape（前后空白不敏感）", endpoint.normalizeEndpointMode(' ape '), 'ape')
    rec.eq("'APE' → classic（大小写不敏感不是承诺，只认小写）", endpoint.normalizeEndpointMode('APE'), 'classic')
    rec.eq('乱写 → classic', endpoint.normalizeEndpointMode('乱写'), 'classic')

    let store = stubLocalStorage()
    rec.eq('没存过 → classic', endpoint.readEndpointMode(), 'classic')
    rec.eq('写 ape 成功', endpoint.writeEndpointMode('ape'), true)
    rec.eq('读回 ape', endpoint.readEndpointMode(), 'ape')
    rec.eq('持久化键只有 chubby-endpoint（读写一致）', Array.from(store.keys()), ['chubby-endpoint'])
    rec.eq('落盘值是归一化后的词', store.get('chubby-endpoint'), 'ape')
    rec.eq('写非法值也归一化后落盘', endpoint.writeEndpointMode('乱写'), true)
    rec.eq('非法值读回 classic', endpoint.readEndpointMode(), 'classic')
    rec.eq('落盘值是 classic', store.get('chubby-endpoint'), 'classic')

    // localStorage 被禁用（隐私模式/quota）时不能抛、不能卡住调用方
    stubLocalStorage({ throwRead: true, throwWrite: true })
    rec.eq('读失败回落默认', endpoint.readEndpointMode(), 'classic')
    rec.eq('写失败返回 false 而不抛', endpoint.writeEndpointMode('ape'), false)
    void store
  })

  await group(rec, '4. recover.ts：快捷键判定 / 恢复点 / 解绑', async () => {
    rec.eq('文案常量', recover.RECOVER_HOTKEY_LABEL, 'Ctrl+Shift+W')
    const hot = (o) => recover.isRecoverHotkey(fakeEvent(o))
    rec.eq('Ctrl+Shift+W 命中', hot({ ctrlKey: true, shiftKey: true, key: 'w' }), true)
    rec.eq('大写 W 也命中', hot({ ctrlKey: true, shiftKey: true, key: 'W' }), true)
    rec.eq('Meta+Shift+W（macOS）命中', hot({ metaKey: true, shiftKey: true, key: 'w' }), true)
    rec.eq('旧环境只有 keyCode=87 命中（key 缺失）', hot({ ctrlKey: true, shiftKey: true, keyCode: 87 }), true)
    rec.eq("key='Unidentified' 时仍走 keyCode 兜底", hot({ ctrlKey: true, shiftKey: true, key: 'Unidentified', keyCode: 87 }), true)
    rec.eq("key 明确是别的键时 keyCode=87 不越权（Ctrl+Shift+Z）", hot({ ctrlKey: true, shiftKey: true, key: 'z', keyCode: 87 }), false)
    rec.eq('只有 Ctrl 不算', hot({ ctrlKey: true, key: 'w' }), false)
    rec.eq('只有 Shift 不算', hot({ shiftKey: true, key: 'w' }), false)
    rec.eq('别的键不算', hot({ ctrlKey: true, shiftKey: true, key: 'q', keyCode: 81 }), false)
    rec.eq('空事件不算', recover.isRecoverHotkey(null), false)

    rec.eq('显示时不出现恢复点', recover.createRecover({ recover() { } }).dot(false), null)
    const calls = []
    const R = recover.createRecover({ recover: () => calls.push('recover') })
    const props = R.dot(true)
    rec.ok('隐藏时恢复点带标记', !!props && props['data-chubby-recover'] === '1')
    rec.ok('hidden 提示里写明快捷键', !!props && String(props.title).indexOf(recover.RECOVER_HOTKEY_LABEL) >= 0)
    const ev = fakeEvent()
    props.onClick(ev)
    rec.eq('点恢复点 → 真的恢复', calls.length, 1)
    rec.ok('点恢复点顺手拦住事件（不穿透宿主页面）', ev.stopped === true && ev.prevented === true)

    const target = {
      listeners: [],
      addEventListener(type, fn, capture) { this.listeners.push({ type, fn, capture }) },
      removeEventListener(type, fn, capture) {
        this.listeners = this.listeners.filter((x) => !(x.type === type && x.fn === fn && x.capture === capture))
      },
    }
    const unbind = R.bindHotkey(target)
    rec.eq('只登记一个 keydown 监听', target.listeners.length, 1)
    rec.eq('捕获阶段登记（抢在宿主前面）', target.listeners[0].capture, true)
    calls.length = 0
    target.listeners[0].fn(fakeEvent({ ctrlKey: true, shiftKey: true, key: 'w' }))
    target.listeners[0].fn(fakeEvent({ ctrlKey: true, key: 'w' }))
    rec.eq('只有快捷键会触发恢复', calls.length, 1)
    unbind()
    rec.eq('解绑摘掉同一个监听', target.listeners.length, 0)
    unbind()
    rec.eq('重复解绑不抛、也不误删别的监听', target.listeners.length, 0)

    const boom = recover.createRecover({ recover() { throw new Error('host down') } })
    let threw = false
    try { boom.trigger() } catch (e) { threw = true }
    rec.eq('宿主恢复抛错不外泄（幂等触发）', threw, false)
  })

  await group(rec, '5. sse.ts：帧切分 / 跨 chunk / 未知字段 / 非对象帧', async () => {
    const p = (s) => sse.parseSseBuffer(s)
    let r = p('data: {"delta":"你"}\n\n')
    rec.eq('单帧', r.events, [{ delta: '你' }])
    rec.eq('完整帧不留尾巴', r.rest, '')

    r = p('data:{"a":1}\n')
    rec.eq('冒号后无空格也能解析', r.events, [{ a: 1 }])

    r = p('data: {"a":1}\r\ndata: {"b":2}\r\n')
    rec.eq('CRLF 两帧', r.events, [{ a: 1 }, { b: 2 }])

    r = p('data: {"a":1}\rdata: {"b":2}\r')
    rec.eq('只有 CR 的旧格式也认', r.events, [{ a: 1 }, { b: 2 }])

    r = p('data: {"a":1}\r')
    rec.eq('CR 结尾的帧已收下', r.events, [{ a: 1 }])
    rec.eq('不会把同一帧再解析一遍', p(r.rest + '\n').events, [])

    r = p('data: {"a":1}\ndata: [DONE]\n')
    rec.eq('[DONE] 被跳过、不算坏帧', r.events, [{ a: 1 }])
    rec.eq('[DONE] 不污染 invalid', r.invalid, 0)

    r = p('data: {坏JSON}\ndata: {"ok":1}\n')
    rec.eq('坏行计数', r.invalid, 1)
    rec.eq('坏行不挡后面的好帧', r.events, [{ ok: 1 }])

    r = p(': ping\nevent: message\nid: 7\nretry: 1000\ndata: {"ok":1}\n')
    rec.eq('注释/event/id/retry 等未知字段被忽略', r.events, [{ ok: 1 }])
    rec.eq('未知字段不算坏帧', r.invalid, 0)

    r = p('\uFEFFdata: {"a":1}\n')
    rec.eq('BOM 不影响首帧', r.events, [{ a: 1 }])

    r = p('data:\n')
    rec.eq('空 data 行跳过', r.events, [])

    r = p('data: null\ndata: 42\ndata: "文本"\n')
    rec.eq('非对象帧一律不收（chat.ts 直接读 obj.error，null 会抛）', r.events, [])
    rec.eq('非对象帧计入 invalid', r.invalid, 3)

    // 半行：分两次到达，拼起来才算完
    const half = p('data: {"delta":"鱼')
    rec.eq('半行先留在 rest', half.events, [])
    rec.ok('半行确实在 rest 里', half.rest.indexOf('鱼') >= 0)
    rec.eq('拼回后解析', p(half.rest + '"}\n').events, [{ delta: '鱼' }])

    // 跨 chunk：按字节逐块喂（模拟 fetch reader），多字节字符与换行都会被切开
    const text = 'data: {"delta":"鱼"}\n\ndata: {"done":true,"reply":"好了"}\n\n'
    const bytes = new TextEncoder().encode(text)
    const dec = new TextDecoder()
    let buf = ''
    const events = []
    for (let i = 0; i < bytes.length; i++) {
      buf += dec.decode(bytes.subarray(i, i + 1), { stream: true })
      const q = p(buf)
      buf = q.rest
      for (const e of q.events) events.push(e)
    }
    buf += dec.decode()
    rec.eq('逐字节到达也能拼出完整两帧', events, [{ delta: '鱼' }, { done: true, reply: '好了' }])
    rec.eq('逐字节收完后没有残尾', buf, '')

    // 测试有牙：只按「空行分帧」的朴素实现会漏掉「有换行、没空行」的帧
    const naive = (s) => {
      const parts = s.split('\n\n')
      parts.pop() // 最后一段视为未收完的尾巴（真实实现在这里就是 rest）
      return parts.filter((x) => x.indexOf('data: ') === 0)
    }
    rec.eq('朴素 split 实现会漏帧（证明上面覆盖的是真边界）', naive('data: {"a":1}\n').length, 0)
    rec.eq('本实现不漏', p('data: {"a":1}\n').events.length, 1)
  })
}

// ---------- 主流程 ----------
async function main() {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  writeFileSync(ENTRY, [
    "export * as http from '../src/client/http.ts'",
    "export * as busy from '../src/client/busy.ts'",
    "export * as endpoint from '../src/client/endpoint.ts'",
    "export * as recover from '../src/client/recover.ts'",
    "export * as sse from '../src/shared/sse.ts'",
    '',
  ].join('\n'), 'utf8')

  try {
    console.log('[net-client] 打包五个模块（esbuild，离线）')
    const mods = await buildBundle('main')
    const rec = makeRec(false)
    await suite(mods, rec)
    pass = rec.pass
    fail = rec.fail
    failures.push(...rec.failures)

    if (WITH_MUTATE) {
      console.log('\n[6] 负向验证：变异体必须被同一套断言抓出来')
      /**
       * 每个变异体只改一行「实现」：
       *   ① sse   去掉「只收对象」→ data:null 会混进 events
       *   ② http  timeoutSignal 不再拦 0 → 「0 表示没有超时」翻车
       *   ③ busy  边界从 <= 改成 < → 正好 staleMs 就提前解锁
       *   ④ recover keyCode 兜底不再看 key → 抢 Ctrl+Shift+Z
       */
      const mutants = [
        ['sse/非对象帧', 'sse.ts', "if (v && typeof v === 'object') events.push(v)", 'if (true) events.push(v)'],
        ['http/超时口径', 'http.ts', 'if (!Number.isFinite(n) || n <= 0) return undefined', 'if (!Number.isFinite(n)) return undefined'],
        ['busy/看门狗边界', 'busy.ts', 'if (t - beganAt <= staleMs) return false', 'if (t - beganAt < staleMs) return false'],
        ['recover/keyCode 越权', 'recover.ts', "if (key && key !== 'unidentified') return false", 'if (false) return false'],
      ]
      const mrec = makeRec(false)
      let caught = 0
      for (let i = 0; i < mutants.length; i++) {
        const [label, file, from, to] = mutants[i]
        try {
          const m = await buildBundle('mut' + i, [[file, from, to]])
          const r = makeRec(true)   // 变异体内部断言只报失败，免得刷屏
          await suite(m, r)
          const hit = r.fail > 0
          if (hit) caught++
          mrec.ok('变异体「' + label + '」被抓出（' + file + '）', hit, hit ? '触发 ' + r.fail + ' 项失败' : '居然全绿 = 断言没牙')
        } catch (e) {
          mrec.ok('变异体「' + label + '」可构建（' + file + '）', false, String((e && e.message) || e))
        }
      }
      mrec.ok('四个变异体全部被抓出', caught === mutants.length, caught + '/' + mutants.length)
      pass += mrec.pass
      fail += mrec.fail
      failures.push(...mrec.failures)
    } else {
      console.log('\n[6] 负向验证：已按 --no-mutate 跳过')
    }
  } finally {
    rmSync(TMP, { recursive: true, force: true })
    globalThis.fetch = undefined
  }

  console.log('\n[net-client] 通过 ' + pass + ' 项 / 失败 ' + fail + ' 项')
  if (fail > 0) {
    console.log('失败清单：')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
  console.log('[net-client] ✅ 全部通过')
}

main().catch((e) => {
  try { rmSync(TMP, { recursive: true, force: true }) } catch { }
  console.error('[net-client] 未捕获异常：', e)
  process.exit(1)
})
