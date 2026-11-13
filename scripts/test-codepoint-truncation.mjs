/**
 * scripts/test-codepoint-truncation.mjs —— B101 按码点截断回归（不联网、不要浏览器）
 *
 * 背景：`s.slice(0, N)` 数的是 UTF-16 码元。B100 已修了提醒路由与简报天气两处；
 * 本批把「所有对未知外部输入做长度上限」的调用点统一到 `src/shared/text.ts` 的
 * clipCodePoints，并在这里把每一处都钉住：
 *   [1] clipCodePoints 本身（max=0/1/负数/NaN、emoji 在边界、中文+emoji 混合）
 *   [2] host/chat-core.ts   readChatRequest（用户消息 → prompt / 缓存 key / memory.json）
 *   [3] host/backup/fields.ts cleanReminders / cleanMemory（备份 JSON 导入 → 落盘）
 *   [4] client/dropzone.ts  buildTextPrompt（拖进来的文件内容 → /chat 外呼）
 *   [5] client/actions/system.ts 提醒菜单（用户文本 → POST /reminders → reminders.json）
 *   [6] 落盘/回包不变量：合法 UTF-16、JSON 往返不变、UTF-8 编码不出现 U+FFFD
 *
 * 每条断言都写清了「旧实现会怎样」，把改前的红留在了测试里（见 [6] 的对照断言）。
 *
 * 用法：node scripts/test-codepoint-truncation.mjs
 * 退出码：0=全绿；1=有失败
 *
 * 说明：本批不允许改 package.json，所以没有把本脚本接进 `npm test`；需要单独跑。
 */
import { register } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
register(new URL('./ts-resolve.mjs', import.meta.url))
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href)

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}
/** 断言失败时要看差异，但 4000 字的长串不能整段糊在终端上 */
function brief(v, max = 48) {
  const s = typeof v === 'string' ? JSON.stringify(v) : String(JSON.stringify(v))
  if (s.length <= max) return s
  const head = s.slice(0, max)
  return head + '…(' + (typeof v === 'string' ? Array.from(v).length + ' 字 / ' + v.length + ' 码元' : s.length + ' 字符') + ')'
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), '期望 ' + brief(expected) + ' / 实际 ' + brief(actual))
}

/** 孤立代理项（高代理后面不跟低代理，或低代理前面没有高代理） */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const hasLone = (s) => LONE.test(String(s))
const cps = (s) => Array.from(String(s)).length
/** 合法字符串三连：无孤立代理项、JSON 往返不变、UTF-8 编码不变（不会变成 U+FFFD） */
function isCleanString(s) {
  const v = String(s)
  if (hasLone(v)) return false
  if (JSON.parse(JSON.stringify(v)) !== v) return false
  return Buffer.from(v, 'utf8').toString('utf8') === v
}

const RICE = '🍚'
const CJK = '白'

const shared = await imp('src/shared/text.ts')
const clip = shared.clipCodePoints

console.log('\n[1] clipCodePoints：上限按「字」= 码点（max=0/1/负数、emoji 在边界、中英混排）')
{
  ok('未超限的 ASCII 原样', clip('hello', 5) === 'hello')
  ok('未超限的中文原样', clip('白饭白饭', 4) === '白饭白饭')
  eq('中文按码点切', clip('白饭白饭', 2), '白饭')
  eq('max=0 → 空串', clip(RICE.repeat(3), 0), '')
  eq('max=负数 → 空串（不是"全留"）', clip('白饭', -3), '')
  eq('max=NaN → 空串', clip('白饭', NaN), '')
  eq('max=Infinity → 原样', clip('白饭', Infinity), '白饭')
  ok('null/undefined → 空串', clip(null, 10) === '' && clip(undefined, 10) === '')

  // max=1：旧 .slice(0,1) 只拿到高代理项（孤立），按码点要拿到整个 emoji
  eq('max=1 取到一个完整 emoji', clip(RICE + CJK, 1), RICE)
  ok('max=1 的结果是合法字符串（旧实现是孤立高代理项）', isCleanString(clip(RICE + CJK, 1)))

  // emoji 正好压在边界上：499 个汉字 + 1 个 emoji，第 500 个码元就是代理对前半截
  const boundary = CJK.repeat(499) + RICE
  ok('emoji 压在 500 边界上：整串原样保留', clip(boundary, 500) === boundary, '长度 ' + clip(boundary, 500).length + ' 码元')
  ok('emoji 压在 500 边界上：不切出孤立代理项', isCleanString(clip(boundary, 500)))

  // 中文 + emoji 混合，且截断点落在 emoji 上（第 200 个「字」就是那个 emoji）
  const mixed = '提'.repeat(199) + RICE + '尾巴'
  eq('中文+emoji 混合：截到 200 字且保住 emoji', clip(mixed, 200), '提'.repeat(199) + RICE)
  ok('混合截断结果合法', isCleanString(clip(mixed, 200)))

  // 计数：300 个 emoji 是 600 码元。旧 .slice(0,500) 只剩 250 个；按码点上限 500 时应当原样
  const emojis = RICE.repeat(300)
  eq('300 个 emoji 在 500 字上限内：原样 300 个', cps(clip(emojis, 500)), 300)
  eq('300 个 emoji 上限 200：按码点留 200 个', clip(emojis, 200), RICE.repeat(200))
  eq('300 个 emoji 上限 200 的码点数', cps(clip(emojis, 200)), 200)
  ok('300 个 emoji 截断结果合法', isCleanString(clip(emojis, 200)))
}

console.log('\n[2] host/chat-core.ts readChatRequest：用户消息上限 500 字')
{
  const cc = await imp('src/host/chat-core.ts')
  const at = (message) => cc.readChatRequest({ message }).message

  // 回归：ASCII / BMP 中文与旧实现逐字一致（scripts/test-chat-limits.mjs 依赖这一条）
  eq('ASCII 501 → 500（与旧行为一致）', at('a'.repeat(501)), 'a'.repeat(500))
  eq('中文 501 → 500（与旧行为一致）', at(CJK.repeat(501)), CJK.repeat(500))

  // 300 个 emoji 只有 300「字」，旧实现按 600 码元算 → 只剩 250 个
  const emojis = RICE.repeat(300)
  const gotEmojis = at(emojis)
  eq('300 个 emoji 未超 500 字：原样 300 个（旧实现只剩 250 个）', cps(gotEmojis), 300)
  ok('300 个 emoji 原样保留且合法', gotEmojis === emojis && isCleanString(gotEmojis))

  // 边界：499 汉字 + emoji = 正好 500 字（501 码元）。旧实现会切出孤立高代理项
  const boundary = CJK.repeat(499) + RICE
  eq('499 汉字 + emoji（正好 500 字）原样保留', at(boundary), boundary)
  ok('边界消息合法（旧实现是孤立代理项）', isCleanString(at(boundary)))

  // 超限：600 个 emoji → 500 个「字」，不是 500 码元
  const over = at(RICE.repeat(600))
  eq('600 个 emoji 截到 500 字', cps(over), 500)
  ok('超限截断结果合法', isCleanString(over))

  // 空/非字符串不炸
  eq('非字符串 message → 空串', at(12345), '')
}

console.log('\n[3] host/backup/fields.ts：备份 JSON 导入的字段上限（reminderTextLen / memoryContentLen）')
{
  const F = await imp('src/host/backup/fields.ts')
  const reminderText = (text) => {
    const list = F.cleanReminders([{ text, at: '2026-11-04T09:00:00.000Z' }])
    return list && list[0] ? list[0].text : null
  }

  // 提醒正文上限 200 字（与 routes/reminders.ts 同口径）
  const boundary = '提'.repeat(199) + RICE + '尾巴'
  eq('199 汉字 + emoji + 尾巴：导入截到 200 字且保住 emoji', reminderText(boundary), '提'.repeat(199) + RICE)
  ok('导入的提醒正文合法（旧实现切出孤立代理项）', isCleanString(reminderText(boundary)))
  eq('200 个 emoji 的提醒正文：留 200 个（旧实现只剩 100 个）', cps(reminderText(RICE.repeat(200))), 200)

  // 聊天记忆单条上限 8000 字：外部备份包里的原文同样不能切坏
  const content = CJK.repeat(7999) + RICE
  const mem = F.cleanMemory({ history: [{ role: 'user', content }], summary: '摘要' })
  const saved = mem && mem.history[0] ? mem.history[0].content : ''
  eq('memory content 8000 字上限：emoji 保住', saved, content)
  ok('memory content 合法', isCleanString(saved))
}

console.log('\n[4] client/dropzone.ts buildTextPrompt：拖进来的文件内容上限 4000 字')
{
  const dz = await imp('src/client/dropzone.ts')
  const PREFIX = '总结一下这篇文档：\n'

  const boundary = CJK.repeat(3999) + RICE + '尾巴'
  const prompt = dz.buildTextPrompt(boundary)
  eq('3999 汉字 + emoji + 尾巴：截到 4000 字且保住 emoji', prompt, PREFIX + CJK.repeat(3999) + RICE)
  ok('提示词合法（旧实现切出孤立代理项）', isCleanString(prompt))
  ok('提示词前缀不变', prompt.indexOf(PREFIX) === 0)

  const manyEmoji = dz.buildTextPrompt(RICE.repeat(4000))
  eq('4000 个 emoji 原样保留（旧实现只剩 2000 个）', cps(manyEmoji) - cps(PREFIX), 4000)
  ok('4000 个 emoji 的提示词合法', isCleanString(manyEmoji))

  eq('空文件内容只剩前缀', dz.buildTextPrompt(''), PREFIX)
  eq('undefined 也不炸', dz.buildTextPrompt(undefined), PREFIX)
}

console.log('\n[5] client/actions/system.ts 提醒菜单：用户文本 → POST /reminders（落 reminders.json）')
{
  const system = await imp('src/client/actions/system.ts')
  // 提醒的输入框是自绘 DOM（桌面端 window.prompt 不可用），测试通过实现注入喂输入
  const promptModal = await imp('src/client/actions/prompt-modal.ts')
  const handlers = new Map()
  const prefixes = new Map()
  const table = {
    define: (a, h) => { handlers.set(a, h) },
    definePrefix: (p, h) => { prefixes.set(p, h) },
    has: (a) => handlers.has(a) || [...prefixes.keys()].some((p) => a.indexOf(p) === 0),
    run: async () => false,
    actions: () => [...handlers.keys()],
    prefixes: () => [...prefixes.keys()],
  }
  system.registerSystemActions(table)
  ok('remind-add 已注册', handlers.has('remind-add'))

  /** 走一遍「提醒」菜单：第一次输入给正文，第二次给时间（正文里没有时间词） */
  async function remind(requestText) {
    const posts = []
    const bubbles = []
    const answers = [requestText, '20分钟后']
    const prevFetch = globalThis.fetch
    promptModal.setPromptTextImpl(async () => (answers.length ? answers.shift() : null))
    globalThis.fetch = (url, init) => {
      posts.push({ url: String(url), body: JSON.parse(String(init && init.body)) })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
    }
    try {
      await handlers.get('remind-add')({ bubble: (t) => bubbles.push(t) }, 'remind-add')
      await new Promise((resolve) => setTimeout(resolve, 10))
    } finally {
      promptModal.setPromptTextImpl(null)
      globalThis.fetch = prevFetch
    }
    return { posts, bubbles }
  }

  const boundary = '提'.repeat(199) + RICE + '尾巴'
  const a = await remind(boundary)
  eq('请求打到 /reminders', a.posts.map((p) => p.url), ['/api/chubby-whale/reminders'])
  eq('199 汉字 + emoji：正文截到 200 字且保住 emoji', a.posts[0] && a.posts[0].body.text, '提'.repeat(199) + RICE)
  ok('回传正文合法（旧实现切出孤立代理项）', isCleanString(a.posts[0] && a.posts[0].body.text))
  ok('at 仍是 UTC ISO', /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(String(a.posts[0] && a.posts[0].body.at)))

  const b = await remind(RICE.repeat(200))
  eq('200 个 emoji 的提醒：留 200 个（旧实现只剩 100 个）', b.posts[0] && b.posts[0].body.text, RICE.repeat(200))
  ok('200 个 emoji 的提醒正文合法', isCleanString(b.posts[0] && b.posts[0].body.text))
  ok('加成功后仍有气泡反馈', b.bubbles.length > 0)
}

console.log('\n[6] 落盘 / 回包不变量 + 旧实现对照（改前的红）')
{
  // 对照：旧实现在同一位置上确实会切坏 —— 这条断言记录 bug 证据，不是期望行为
  const boundary = CJK.repeat(499) + RICE
  const buggy = boundary.slice(0, 500)
  ok('对照：旧 .slice(0,500) 切出孤立代理项，且 UTF-8 落盘变 U+FFFD',
    hasLone(buggy) && Buffer.from(buggy, 'utf8').toString('utf8').indexOf('\uFFFD') >= 0,
    '尾字符 U+' + buggy.charCodeAt(499).toString(16).toUpperCase())
  ok('对照：旧 .slice(0,500) 在 JSON 里只剩 \\ud83c（另一端解析到坏字符串）',
    JSON.stringify(buggy).endsWith('\\ud83c"'), 'JSON 结尾 ' + JSON.stringify(JSON.stringify(buggy).slice(-9)))
  ok('对照：300 个 emoji 用 .slice(0,500) 只剩 250 个',
    cps(RICE.repeat(300).slice(0, 500)) === 250)

  // 新实现：上面每一处截断结果都应该同时满足三条
  const samples = [
    clip(RICE.repeat(300), 200),
    clip(CJK.repeat(499) + RICE, 500),
    clip('提'.repeat(199) + RICE + '尾巴', 200),
    clip('a'.repeat(501), 500),
  ]
  for (const s of samples) ok('截断结果是合法 UTF-16 / JSON / UTF-8 字符串', isCleanString(s), JSON.stringify(s.slice(-4)))
  ok('截断结果码点数不超过上限', samples.every((s, i) => cps(s) <= [200, 500, 200, 500][i]))
}

console.log('\n' + '='.repeat(48))
console.log(`通过 ${pass} 项 / 失败 ${fail} 项`)
if (fail > 0) process.exit(1)
console.log('✅ 按码点截断回归全部通过')
