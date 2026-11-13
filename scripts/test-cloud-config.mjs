/**
 * scripts/test-cloud-config.mjs —— B101「config.json 读取口径收敛」专项（离线、不联网、只碰临时目录）
 *
 * 背景（B100 取证）：src/host/voice/cloud-tts.ts 曾自带**第二份** config.json 解析器——
 * 坏 JSON 静默、BOM 另写一条正则、Key 字段类型宽松；而 host/config.ts 的单一读取器是
 * 「去敏日志 + 只报形状 + 坏 JSON 只告警一次 + BOM 走 readTextNoBom」。两套口径必然漂移，
 * 且 config.ts 刚加固的「日志里不能出现 Key 值」这份旁路根本没有。
 *
 * B101 收敛后的形态（本文件就是这条边界的守卫）：
 *   · cloud-tts 内部只剩一条读盘路径 readRawConfig -> readCloudVoice（原来是 try/catch 一把抓）；
 *   · 降级/去敏口径逐条对齐 config.ts：缺文件静默、坏 JSON 只告警一次、只报形状与
 *     `SyntaxError @ position N`、绝不拼 err.message、BOM 走 readTextNoBom；
 *   · 两边日志正文必须**逐字一致**（云端多一个 [cloudVoice] 来源前缀，日志里能分清是谁在报）。
 * 为什么还不合并成同一个函数：cloud-tts 的 import 白名单（test-persona-cloud.mjs 的 [7]）
 * 与 gen-module-index --check 要用的 docs/模块接口清单.md 都在本批禁改范围，见 cloud-tts.ts 注释。
 * 在那之前，本文件用「同三份配置喂两套读取器 + 逐字比对」把两条口径钉死。
 *
 * 负向验证（默认开启，--no-mutate 可关）：esbuild 打包后把 cloud-tts 的实现改坏三处
 * （去敏 / BOM / 去重），同一套断言必须**报失败**——全绿不能证明断言有牙。
 *
 * 用法：node scripts/test-cloud-config.mjs [--no-mutate]
 * 退出码：0 = 全过；1 = 有失败
 */
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { register } from 'node:module'
import esbuild from 'esbuild'

// 直接把 .ts 当模块加载（.js 找不到时回退同名 .ts，与 scripts/test.mjs 同口径）
register(new URL('./ts-resolve.mjs', import.meta.url))

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 打包变异体的临时目录（跑完就删） */
const TMP = path.join(ROOT, '.b101-cloud-config-tmp')
const ENTRY = path.join(TMP, 'entry.ts')
const WITH_MUTATE = !process.argv.includes('--no-mutate')

/** 取证用的「Key 原文」标记：故意选短，好让 Node 的报错片段把它带出来（见 [2]） */
const LEAK = 'sk-LEAK-TOKEN'
const LEAK_FRAG = 'sk-LEAK'
/** 坏 JSON 样本：Key 本身没加引号、直接撞上 JSON 语法错误（Node 会把它的前几个字符带进报错） */
const BAD_JSON_TEXT = '{"deepseekKey": ' + LEAK + ', "cloudVoice": {"apiKey": ' + LEAK + '}}'

const tmpDirs = []
function tmpDir(tag) {
  const d = mkdtempSync(path.join(os.tmpdir(), 'b101-' + tag + '-'))
  tmpDirs.push(d)
  return d
}

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
        if (!this.quiet) console.log('  ❌ ' + name + (detail ? '  ' + detail : ''))
      }
    },
    eq(name, actual, expected) {
      this.ok(name, JSON.stringify(actual) === JSON.stringify(expected),
        '期望 ' + JSON.stringify(expected) + ' / 实际 ' + JSON.stringify(actual))
    },
  }
}

/** 抓 console.warn / console.error（两套读取器都只走这两个出口） */
function captureConsole() {
  const logs = []
  const origWarn = console.warn
  const origError = console.error
  console.warn = (...a) => logs.push(a.map((x) => String(x)).join(' '))
  console.error = (...a) => logs.push(a.map((x) => String(x)).join(' '))
  return {
    logs,
    restore() { console.warn = origWarn; console.error = origError },
  }
}

/** Key 环境变量是读取器的第二来源：比对口径时必须清空，否则宿主侧会读到环境变量 */
const ENV_KEYS = ['CHUBBY_WHALE_DEEPSEEK_KEY', 'DEEPSEEK_API_KEY']
const savedEnv = {}
function clearKeyEnv() {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
}
function restoreKeyEnv() {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
}

/** 去掉来源前缀：[chubby-whale] / [chubby-whale][cloudVoice] */
const stripTag = (line) => String(line).replace(/^\[chubby-whale\](?:\[cloudVoice\])? /, '')
/** 字段名归一：两边告警的字段本来就不同（cloudVoice.apiKey vs deepseekKey），比的是文案模板 */
const normField = (line) => line.replace(/config\.json 的 \S+ 应为字符串/, 'config.json 的 <字段> 应为字符串')
const normMsg = (line) => normField(stripTag(line))

/** 造一个插件目录；text === null 表示不建 config.json，asDir 表示用同名目录占位 */
function pluginDir(tag, text, asDir = false) {
  const dir = tmpDir(tag)
  if (asDir) mkdirSync(path.join(dir, 'config.json'))
  else if (text !== null) writeFileSync(path.join(dir, 'config.json'), text, 'utf8')
  return dir
}

/**
 * 同一份 config.json 分别喂两套读取器。返回两边的返回值与日志（日志已归一）。
 * 每个 fixture 用独立目录：告警消息里带文件路径 -> 天然区分、不会跨 fixture 命中缓存。
 */
function probe(mods, dir) {
  const { host, cloud } = mods
  const cap1 = captureConsole()
  const cv = cloud.readCloudVoice(dir)
  cloud.readCloudVoice(dir) // 第二次读：去重生效则不应再多出日志
  cap1.restore()

  const cap2 = captureConsole()
  const deepseek = host.readApiKey(dir)
  host.readApiKey(dir) // 第二次读：同上
  cap2.restore()

  return {
    cloud: { cfg: cv, logs: cap1.logs },
    host: { deepseek, logs: cap2.logs },
  }
}

const FIXTURES = [
  {
    tag: 'bad-json',
    name: '坏 JSON（截断 + 里面就是 Key）',
    text: BAD_JSON_TEXT,
    cloudWarns: 1,
    hostWarns: 1,
    cloudExpect: { enabled: false, apiKey: '', dailyChars: 5000 },
    hostKey: '',
  },
  {
    tag: 'bom',
    name: '带 BOM',
    text: '\uFEFF' + JSON.stringify({ deepseekKey: 'sk-bom', cloudVoice: { apiKey: ' sk-bom ', dailyChars: 3000 } }),
    cloudWarns: 0,
    hostWarns: 0,
    cloudExpect: { enabled: true, apiKey: 'sk-bom', dailyChars: 3000 },
    hostKey: 'sk-bom',
  },
  {
    tag: 'key-num',
    name: 'apiKey 写成 number',
    text: JSON.stringify({ deepseekKey: 42, cloudVoice: { apiKey: 42, dailyChars: 100 } }),
    cloudWarns: 1,
    hostWarns: 1,
    cloudExpect: { enabled: false, apiKey: '', dailyChars: 5000 },
    hostKey: '',
  },
  {
    tag: 'root-array',
    name: '根是数组',
    text: '[]',
    cloudWarns: 1,
    hostWarns: 1,
    cloudExpect: { enabled: false, apiKey: '', dailyChars: 5000 },
    hostKey: '',
  },
  {
    tag: 'missing',
    name: '没有 config.json',
    text: null,
    cloudWarns: 0,
    hostWarns: 0,
    cloudExpect: { enabled: false, apiKey: '', dailyChars: 5000 },
    hostKey: '',
  },
  {
    tag: 'dir',
    name: 'config.json 被目录占住（读不出来）',
    text: null,
    asDir: true,
    cloudWarns: 1,
    hostWarns: 1,
    cloudExpect: { enabled: false, apiKey: '', dailyChars: 5000 },
    hostKey: '',
  },
]

/** 主套件：传入的两套模块可以是直载源码，也可以是变异后的打包体 */
function suite(mods, rec) {
  const { host, cloud } = mods

  // ========== [1] 六种配置样本（B100 的三种 + 三种边界）× 两套读取器：返回值 + 日志口径 ==========
  const fixed = {}
  for (const f of FIXTURES) {
    const dir = pluginDir(f.tag, f.text, f.asDir)
    const r = probe(mods, dir)
    fixed[f.tag] = r

    rec.eq('[1] ' + f.name + '：cloudVoice 返回值（语义/默认值不变）',
      [r.cloud.cfg.enabled, r.cloud.cfg.apiKey, r.cloud.cfg.dailyChars, r.cloud.cfg.speaker === cloud.CLOUD_TTS_DEFAULT_SPEAKER, r.cloud.cfg.resourceId === cloud.CLOUD_TTS_RESOURCE_ID],
      [f.cloudExpect.enabled, f.cloudExpect.apiKey, f.cloudExpect.dailyChars, true, true])
    rec.eq('[1] ' + f.name + '：宿主读取器读到同一份文件的 Key', r.host.deepseek, f.hostKey)
    rec.eq('[1] ' + f.name + '：云端告警次数（只提示一次）', r.cloud.logs.length, f.cloudWarns)
    rec.eq('[1] ' + f.name + '：宿主告警次数（只提示一次）', r.host.logs.length, f.hostWarns)
    rec.eq('[1] ' + f.name + '：两边告警正文逐字一致（口径同源）',
      r.cloud.logs.map(normMsg), r.host.logs.map(normMsg))
    rec.ok('[1] ' + f.name + '：云端日志带来源前缀（与宿主行不重样）',
      r.cloud.logs.every((l) => !r.host.logs.includes(l)) && r.cloud.logs.every((l) => l.indexOf('[chubby-whale]') === 0),
      JSON.stringify([r.cloud.logs, r.host.logs]))
  }

  // ========== [2] 去敏：坏 JSON 的告警里不能出现 Key 原文 ==========
  {
    let rawMsg = ''
    try { JSON.parse(BAD_JSON_TEXT) } catch (e) { rawMsg = String((e && e.message) || e) }
    rec.ok('[2] 对照：Node 的 JSON 报错本身会带出源文本片段（所以绝不能拼 err.message）',
      rawMsg.indexOf(LEAK_FRAG) >= 0, rawMsg)
    const cloudText = fixed['bad-json'].cloud.logs.join('\n')
    const hostText = fixed['bad-json'].host.logs.join('\n')
    rec.ok('[2] 云端告警不含 Key 原文（连片段也不许）', cloudText.indexOf(LEAK_FRAG) < 0, cloudText)
    rec.ok('[2] 宿主告警不含 Key 原文（连片段也不许）', hostText.indexOf(LEAK_FRAG) < 0, hostText)
    rec.ok('[2] 云端告警只报「错误类型（+位置）」，不带 JSON 原文',
      /SyntaxError( @ position \d+)?/.test(cloudText) && cloudText.indexOf('deepseekKey') < 0, cloudText)
    rec.ok('[2] 告警里没有把整个值回显（只有类型/长度/位置）',
      !/sk-/.test(cloudText) && !/sk-/.test(hostText))
  }

  // ========== [3] 去重：反复读同一份坏配置只提示一次 ==========
  {
    const dir = pluginDir('dedupe', '{"cloudVoice": {')
    const cap = captureConsole()
    for (let i = 0; i < 5; i++) cloud.readCloudVoice(dir)
    cap.restore()
    rec.eq('[3] 云端连读 5 次：只报警 1 次（每次合成都会现读，不能刷屏）', cap.logs.length, 1)
    rec.ok('[3] 保留诊断价值：能报出 at position（V8 给了就带，没给就只有错误类型）',
      /SyntaxError @ position \d+/.test(cap.logs[0] || ''), JSON.stringify(cap.logs))

    const cap2 = captureConsole()
    for (let i = 0; i < 5; i++) host.readApiKey(dir)
    cap2.restore()
    rec.eq('[3] 宿主连读 5 次：只报警 1 次（与 config.ts 的 warnConfig 同口径）', cap2.logs.length, 1)
    rec.eq('[3] 两边报的是同一句话（只差来源前缀）',
      cap.logs.map(normMsg), cap2.logs.map(normMsg))
  }

  // ========== [4] cloudVoice 段语义与默认值不回退 ==========
  {
    const write = (dir, obj, opts = {}) =>
      writeFileSync(path.join(dir, 'config.json'), (opts.bom ? '\uFEFF' : '') + JSON.stringify(obj), 'utf8')

    const empty = cloud.readCloudVoice(tmpDir('cv-empty'))
    rec.eq('[4] 没有 config.json → 不启用 + 默认值',
      [empty.enabled, empty.apiKey, empty.dailyChars, empty.speaker, empty.resourceId],
      [false, '', 5000, cloud.CLOUD_TTS_DEFAULT_SPEAKER, cloud.CLOUD_TTS_RESOURCE_ID])

    const dir = tmpDir('cv')
    write(dir, { cloudVoice: { apiKey: '  sk-test  ', speaker: '', resourceId: '', dailyChars: '3000', enabled: true } })
    const c1 = cloud.readCloudVoice(dir)
    rec.eq('[4] Key 去空白 / 空音色与资源 ID 回落 / 字符串额度转数字',
      [c1.enabled, c1.apiKey, c1.speaker === cloud.CLOUD_TTS_DEFAULT_SPEAKER, c1.resourceId === cloud.CLOUD_TTS_RESOURCE_ID, c1.dailyChars],
      [true, 'sk-test', true, true, 3000])

    write(dir, { cloudVoice: { apiKey: 'k', dailyChars: 12.9 } })
    rec.eq('[4] 额度小数向下取整', cloud.readCloudVoice(dir).dailyChars, 12)
    for (const v of [0, -5, 'abc', null]) {
      write(dir, { cloudVoice: { apiKey: 'k', dailyChars: v } })
      rec.eq('[4] 非法额度回落 5000：' + JSON.stringify(v), cloud.readCloudVoice(dir).dailyChars, 5000)
    }
    write(dir, { cloudVoice: { apiKey: 'k', enabled: false } })
    rec.eq('[4] enabled:false → 不启用', cloud.readCloudVoice(dir).enabled, false)

    const dirBlank = tmpDir('cv-blank')
    write(dirBlank, { cloudVoice: { apiKey: '   ' } })
    const capBlank = captureConsole()
    const blankCfg = cloud.readCloudVoice(dirBlank)
    capBlank.restore()
    rec.ok('[4] 空白 Key → 不启用且静默（空白不算类型错，与 config.ts 同口径）',
      blankCfg.enabled === false && blankCfg.apiKey === '' && capBlank.logs.length === 0, JSON.stringify(capBlank.logs))

    write(dir, { cloudVoice: { apiKey: 'k' } }, { bom: true })
    rec.eq('[4] 带 BOM 的 config.json 照样能读', cloud.readCloudVoice(dir).apiKey, 'k')

    // 形状告警：只报类型/长度，绝不回显内容
    const dirShape = tmpDir('cv-shape')
    write(dirShape, { cloudVoice: 'not-an-object' })
    let cap = captureConsole()
    const shapeCfg = cloud.readCloudVoice(dirShape)
    cap.restore()
    rec.eq('[4] cloudVoice 非对象 → 不启用', shapeCfg.enabled, false)
    rec.ok('[4] cloudVoice 非对象 → 告警一次且只报形状',
      cap.logs.length === 1 && /应为对象（实际 string）/.test(cap.logs[0]), JSON.stringify(cap.logs))

    write(dirShape, { cloudVoice: null })
    cap = captureConsole()
    const nullCfg = cloud.readCloudVoice(dirShape)
    cap.restore()
    rec.ok('[4] cloudVoice:null → 按未配置、静默（不吵）', nullCfg.enabled === false && cap.logs.length === 0)

    write(dirShape, { cloudVoice: { apiKey: { nested: true } } })
    cap = captureConsole()
    const objCfg = cloud.readCloudVoice(dirShape)
    cap.restore()
    rec.ok('[4] Key 写成对象 → 不启用 + 告警只报形状（不回显对象内容）',
      objCfg.enabled === false &&
      /config\.json 的 cloudVoice\.apiKey 应为字符串（实际 对象（1 个键）），已忽略/.test(cap.logs.join('\n')), JSON.stringify(cap.logs))

    // createCloudTts 对外行为：仍是「有 Key 且没显式关」才启用，额度取 dailyChars
    const dirLive = tmpDir('cv-live')
    write(dirLive, { cloudVoice: { apiKey: 'k', dailyChars: '700' } })
    const tts = cloud.createCloudTts({ config: () => cloud.readCloudVoice(dirLive), runtimeDir: tmpDir('cv-run'), now: () => new Date(Date.UTC(2026, 10, 7, 3, 0, 0)) })
    rec.eq('[4] createCloudTts.enabled() 仍由同一份读盘结果驱动', [tts.enabled(), tts.usage().limit], [true, 700])
    writeFileSync(path.join(dirLive, 'config.json'), '{ 坏 JSON', 'utf8')
    const ttsOff = cloud.createCloudTts({ config: () => cloud.readCloudVoice(dirLive), runtimeDir: tmpDir('cv-run2') })
    const capBad = captureConsole()
    const offState = [ttsOff.enabled(), ttsOff.usage().limit]
    capBad.restore()
    rec.eq('[4] 配置读坏时 createCloudTts 不启用、额度回落 5000（不抛）', offState, [false, 5000])
    rec.ok('[4] 这里也只告警一次，且告警不带 JSON 原文',
      capBad.logs.length === 1 && capBad.logs[0].indexOf('deepseekKey') < 0, JSON.stringify(capBad.logs))
  }
}

// ---------- 负向验证：esbuild 变异体 ----------
async function buildBundle(tag, rules = []) {
  const outfile = path.join(TMP, 'bundle-' + tag + '.mjs')
  const plugin = {
    name: 'mutate-b101-cloud-config',
    setup(b) {
      b.onLoad({ filter: /\.ts$/ }, (args) => {
        if (!/src[\\/]host[\\/]/.test(args.path)) return null
        let src = readFileSync(args.path, 'utf8')
        for (const [file, from, to] of rules) {
          if (path.basename(args.path) !== file) continue
          if (src.indexOf(from) < 0) throw new Error('变异目标不存在（源码已变？）：' + from.slice(0, 80))
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

async function main() {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  writeFileSync(ENTRY, [
    "export * as host from '../src/host/config.ts'",
    "export * as cloud from '../src/host/voice/cloud-tts.ts'",
    '',
  ].join('\n'), 'utf8')

  const mods = {
    host: await import(pathToFileURL(path.join(ROOT, 'src/host/config.ts')).href),
    cloud: await import(pathToFileURL(path.join(ROOT, 'src/host/voice/cloud-tts.ts')).href),
  }

  let pass = 0
  let fail = 0
  const failures = []
  clearKeyEnv()
  try {
    console.log('[cloud-config] 主套件（直载 .ts，离线）')
    const rec = makeRec(false)
    suite(mods, rec)
    pass = rec.pass
    fail = rec.fail
    failures.push(...rec.failures)

    if (WITH_MUTATE) {
      console.log('\n[5] 负向验证：变异体必须被同一套断言抓出来')
      const mutants = [
        // B102 起读取器已合并到 host/config.ts：三个变异体打在**真实的单一读取器**上，
        // 这样「谁把去敏/BOM/去重改坏」都会被同一套断言抓住（打在 cloud-tts 上的旧变异体已失效）。
        // 去敏失效：告警直接拼 JSON.parse 的 err.message（Node ≥20 会带出源文本片段 -> 泄 Key）
        ['host/去敏告警', 'config.ts', 'jsonErrorBrief(err)', 'String((err && err.message) || err)'],
        // BOM 容错失效：不再剥 BOM
        ['host/BOM 容错', 'config.ts', 'JSON.parse(stripBom(text))', 'JSON.parse(text)'],
        // 去重失效：同一条告警每次都打（主机侧 warnConfig 的去重表）
        ['host/告警去重', 'config.ts', 'if (warnedConfig.has(msg)) return', 'if (false) return'],
      ]
      const mrec = makeRec(false)
      let caught = 0
      for (let i = 0; i < mutants.length; i++) {
        const [label, file, from, to] = mutants[i]
        try {
          const m = await buildBundle('mut' + i, [[file, from, to]])
          const r = makeRec(true)
          suite(m, r)
          const hit = r.fail > 0
          if (hit) caught++
          mrec.ok('变异体「' + label + '」被抓出（' + file + '）', hit, hit ? '触发 ' + r.fail + ' 项失败' : '居然全绿 = 断言没牙')
        } catch (e) {
          mrec.ok('变异体「' + label + '」可构建（' + file + '）', false, String((e && e.message) || e))
        }
      }
      mrec.ok('三个变异体全部被抓出', caught === mutants.length, caught + '/' + mutants.length)
      pass += mrec.pass
      fail += mrec.fail
      failures.push(...mrec.failures)
    } else {
      console.log('\n[5] 负向验证：已按 --no-mutate 跳过')
    }
  } finally {
    for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }) } catch { } }
    rmSync(TMP, { recursive: true, force: true })
    restoreKeyEnv()
  }

  console.log('\n────────────────────')
  if (fail === 0) {
    console.log('✅ cloud-config 专项通过 ' + pass + ' 项，失败 0 项')
    process.exit(0)
  }
  console.log('❌ cloud-config 专项通过 ' + pass + ' 项，失败 ' + fail + ' 项')
  for (const f of failures) console.log('   · ' + f)
  process.exit(1)
}

main().catch((e) => {
  console.error('[cloud-config] 崩溃：' + ((e && e.stack) || e))
  try { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }) } catch { }
  try { rmSync(TMP, { recursive: true, force: true }) } catch { }
  process.exit(1)
})

// 看门狗：断言里一处 await 永远不 resolve 时事件循环会空、Node 以 0 退出（假绿）
setTimeout(() => {
  console.error('[cloud-config] 看门狗超时：套件里有 await 永远没回来（假绿保护）')
  try { rmSync(TMP, { recursive: true, force: true }) } catch { }
  process.exit(1)
}, 120000)
