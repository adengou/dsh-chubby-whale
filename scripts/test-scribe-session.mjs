/**
 * scripts/test-scribe-session.mjs —— 「小鲸代笔」会话状态机回归（纯离线）
 *
 * 2026-11-14 主人 7 条改版后的模型：整篇正文 text 是唯一文档状态，
 * 覆盖：
 *   · 状态只有 idle/active/paused（没有 stopped、没有 stop() 方法）；
 *   · setText 用户编辑原样保存（CRLF 归一成 \n），getText 返回全文；
 *   · push 把整句直接接在当前段落末尾：不换行、不编号、不列表；
 *     中文句间直接接、英文/数字相邻补一个空格、用户回车后的空段落直接接；
 *   · 同句 1.5 秒去重（窗口外照收）；空句忽略；2000 句上限可注入；
 *   · 断句纠偏（2026-11-14）：push 带语音收尾 meta 时，没等够静音就被切开的半句
 *     把句号降级成逗号/补逗号；完整句、！？、已是逗号的原样；meta 缺失保持旧行为；
 *   · 暂停后 push 被拒、正文保留；恢复后接着接；
 *   · clear 清正文/计数、不改状态；
 *   · 不调用 sendText / fetch / 浏览器存储 / DOM（源码级检查）+ 客户端接线静态检查
 *     （含 onHeard → voice-bridge → client → session.push 的 meta 透传），
 *
 * 用法：node scripts/test-scribe-session.mjs   （全过退出码 0）
 */

import { register } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

register(new URL('./ts-resolve.mjs', import.meta.url))

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.error('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}
const show = (v) => (v === null || typeof v === 'undefined' ? String(v) : JSON.stringify(v))

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { createScribeSession } = await import('../src/client/scribe-session.ts')

// ======================================================================
console.log('\n[A] 状态：idle → active → paused → active（没有 stopped）')
{
  const s = createScribeSession({})
  const st0 = s.getState()
  ok('初始 idle（不自动开始）', st0.status === 'idle' && st0.active === false && st0.paused === false)
  ok('没有 stopped 字段（用户语义已移除）', !('stopped' in st0))
  ok('没有 stop 方法（保存随时可点，不存在"停止"）', typeof s.stop === 'undefined')
  s.start()
  ok('start → active，正文为空', s.getState().status === 'active' && s.getState().active === true && s.getState().text === '')
  s.pause()
  ok('pause → paused（只暂停听写，正文保留）', s.getState().status === 'paused' && s.getState().paused === true)
  s.resume()
  ok('resume → active', s.getState().status === 'active')
  s.start()
  ok('start 幂等（已 active 仍是 active）', s.getState().status === 'active')
}

// ======================================================================
console.log('\n[B] setText：用户可编辑正文（原样保存、换行归一、getText 全文）')
{
  const s = createScribeSession({})
  s.start()
  s.setText('  用户自己打的第一段，有空格和标点！ ')
  ok('setText 原样保存（不 trim、不吞空格）', s.getState().text === '  用户自己打的第一段，有空格和标点！ ', show(s.getState().text))
  ok('getText 返回全文', s.getText() === s.getState().text)
  s.setText('第一段\r\n第二段\r第三段')
  ok('CRLF / CR 归一成 \\n', s.getText() === '第一段\n第二段\n第三段', show(s.getText()))
  s.setText('第一段\n\n第三段')
  ok('用户回车产生的空段落保留', s.getText() === '第一段\n\n第三段')
  s.setText('')
  ok('setText("") 清空正文', s.getText() === '')
  ok('setText 不改变状态（仍 active）', s.getState().status === 'active')
}

// ======================================================================
console.log('\n[C] push：整句直接接在当前段落末尾（不换行/不编号/不列表）')
{
  const s = createScribeSession({})
  s.start()
  ok('第一句接进空正文', s.push('第一句，').ok === true && s.getText() === '第一句，', show(s.getText()))
  s.push('第二句，')
  s.push('第三句，')
  ok('中文句间直接接，不换行', s.getText() === '第一句，第二句，第三句，', show(s.getText()))
  ok('正文没有换行（不把每句写成一行）', s.getText().indexOf('\n') < 0)
  ok('正文没有编号/列表前缀', !/^\s*\d+[.、)]/.test(s.getText()) && s.getText().indexOf('\n1.') < 0)
  s.push('  首尾空白的句子，  ')
  ok('句子 trim 后接上', s.getText().endsWith('首尾空白的句子，'), show(s.getText()))
  ok('count 按句累加', s.getState().count === 4, String(s.getState().count))
  ok('lastSentence 是刚接的那句', s.getState().lastSentence === '首尾空白的句子，')
  ok('空句/纯空白被忽略且不接', (() => {
    const before = s.getText()
    const a = s.push('')
    const b = s.push('   \n\t  ')
    return a.ok === false && a.code === 'empty' && b.ok === false && b.code === 'empty' && s.getText() === before
  })())

  // 英文/数字相邻：补一个空格；中文边界直接接
  const en = createScribeSession({})
  en.start()
  en.push('Hello')
  en.push('world')
  ok('英文句间补一个空格', en.getText() === 'Hello，world，', show(en.getText()))
  en.push('123')
  ok('英文/数字相邻也补空格', en.getText() === 'Hello，world，123，', show(en.getText()))
  en.push('中文')
  ok('数字后接中文直接接（无空格）', en.getText() === 'Hello，world，123，中文，', show(en.getText()))

  // 用户在正文里回车 = 新起一段；下一句接到新段落里
  const para = createScribeSession({})
  para.start()
  para.setText('第一段，\n')
  para.push('新段落第一句，')
  ok('回车后的空段落：下一句直接接在新段落', para.getText() === '第一段，\n新段落第一句，', show(para.getText()))
  para.push('新段落第二句，')
  ok('同一段落里继续接（不再加换行）', para.getText() === '第一段，\n新段落第一句，新段落第二句，')
  para.setText('A\n\n')
  para.push('B')
  ok('连续回车（空行）后再接也正常', para.getText() === 'A\n\nB，', show(para.getText()))
}

// ======================================================================
console.log('\n[D] 同句去重：1.5 秒内只接一次，窗口外照收')
{
  let clock = 5000
  const s = createScribeSession({ now: () => clock })
  s.start()
  ok('t=5000 第一次「同样的话」成功', s.push('同样的话').ok === true)
  clock = 5001
  const dup = s.push('同样的话')
  ok('+1ms 重复 → 去重（duplicate=true、不接）', dup.ok === false && dup.duplicate === true && dup.code === 'duplicate')
  ok('去重后正文只有一句', s.getText() === '同样的话，', show(s.getText()))
  clock = 6499
  ok('+1499ms 仍在窗口内 → 去重', s.push('同样的话').duplicate === true)
  clock = 6501
  ok('+1501ms 窗口外 → 同句照收（主人真的又说了一遍）', s.push('同样的话').ok === true)
  ok('窗口外同句接成两句（中文直接接）', s.getText() === '同样的话，同样的话，', show(s.getText()))
  ok('不同句子即使时间挨着也照收', (() => { clock = 6502; return s.push('换一句').ok === true })())
}

// ======================================================================
console.log('\n[E] 暂停/继续、正文保留、句数上限')
{
  const s = createScribeSession({})
  s.start()
  s.push('暂停前的句子，')
  s.setText('暂停前的句子，')
  s.pause()
  const blocked = s.push('暂停时说的话')
  ok('暂停时 push 被拒（code=not-active，不接）', blocked.ok === false && blocked.code === 'not-active' && s.getText() === '暂停前的句子，')
  ok('暂停提示指向话筒（可操作）', blocked.reason.indexOf('话筒') >= 0, blocked.reason)
  s.resume()
  ok('resume 后接着接', s.push('恢复后的话，').ok === true && s.getText() === '暂停前的句子，恢复后的话，')

  const cap = createScribeSession({ maxSentences: 2 })
  cap.start()
  ok('上限内正常接句', cap.push('一，').ok && cap.push('二，').ok && cap.getState().count === 2)
  const over = cap.push('三，')
  ok('超上限被拒（code=limit，不接）', over.ok === false && over.code === 'limit' && cap.getText() === '一，二，')
  ok('用户删字不回退句数计数', (() => { cap.setText('删光了'); return cap.getState().count === 2 })())
}

// ======================================================================
console.log('\n[F] clear：清正文与计数、不改状态')
{
  const s = createScribeSession({})
  s.start()
  s.push('甲，'); s.push('乙，')
  s.clear()
  ok('clear 清空正文与计数', s.getText() === '' && s.getState().count === 0 && s.getState().lastSentence === '')
  ok('clear 不改变听写状态（仍 active）', s.getState().status === 'active')
  ok('clear 后可以重新接句', s.push('丙，').ok === true && s.getText() === '丙，')
  s.pause(); s.clear()
  ok('暂停时 clear 仍是 paused', s.getState().status === 'paused')
}

// ======================================================================
console.log('\n[G] 源码纪律：不自动发送、不碰网络/存储/DOM、没有 stopped')
{
  const src = readFileSync(join(ROOT, 'src/client/scribe-session.ts'), 'utf8')
  ok('没有 sendText 调用', !/sendText\s*\(/.test(src))
  ok('没有 fetch / XMLHttpRequest', !/\bfetch\s*\(/.test(src) && !/XMLHttpRequest/.test(src))
  ok('没有 localStorage / sessionStorage', !/localStorage|sessionStorage/.test(src))
  ok('没有 DOM 操作（document/window）', !/\bdocument\b|\bwindow\b/.test(src))
  // 2026-11-14：断句纠偏要引用纯共享模块；除它之外仍然零依赖（无网络/存储/DOM 模块）
  const imports = [...src.matchAll(/^\s*import\s+[^'\n]*from\s+'([^']+)'/gm)].map((m) => m[1])
  ok('唯一 import 是纯共享断句模块（shared/sentence-boundary.js）',
    imports.length === 1 && imports[0] === '../shared/sentence-boundary.js', show(imports))
  ok('push 用 normalizeSegment 做标点纠偏', /normalizeSegment\(trimmed,\s*meta\)/.test(src))
  ok('没有 stopped 状态 / stop 方法', !/'stopped'/.test(src) && !/\bstop\s*:/.test(src))
}

// ======================================================================
console.log('\n[H] 客户端接线静态检查：voice-bridge → 正文，meta 透传，不进聊天发送链路')
{
  const clientSrc = readFileSync(join(ROOT, 'src/client.ts'), 'utf8')
  const bridgeSrc = readFileSync(join(ROOT, 'src/client/voice-bridge.ts'), 'utf8')
  const voiceSrc = readFileSync(join(ROOT, 'src/client/voice.ts'), 'utf8')
  const actionsSrc = readFileSync(join(ROOT, 'src/client/actions.ts'), 'utf8')
  const voiceActionSrc = readFileSync(join(ROOT, 'src/client/actions/voice.ts'), 'utf8')
  const menuSrc = readFileSync(join(ROOT, 'src/client/menu.ts'), 'utf8')

  ok('voice-bridge 暴露 scribe / onScribe 回调（带 meta）',
    /scribe\?:\s*\(\)\s*=>\s*boolean/.test(bridgeSrc) && /onScribe\?:\s*\(text:\s*string,\s*meta\?:\s*SegmentMeta\)/.test(bridgeSrc))
  const bridgeBlock = bridgeSrc.slice(bridgeSrc.indexOf('host.scribe'), bridgeSrc.indexOf('打断词直通唤醒门'))
  ok('voice-bridge 代笔分流透传 meta、只交 onScribe，不调 sendText',
    bridgeBlock.indexOf('onScribe(scribeText, meta)') >= 0 && bridgeBlock.indexOf('sendText') < 0)
  ok('voice-bridge 从 createVoice 拿到 meta（onHeard 第二参数）',
    /onHeard:\s*\(text:\s*string,\s*meta\?:\s*SegmentMeta\)/.test(bridgeSrc))
  ok('client.ts 把 scribe/onScribe 接到会话（带 meta）',
    /scribe:\s*\(\)\s*=>/.test(clientSrc) && /onScribe:\s*\(text:\s*string,\s*meta\?:\s*SegmentMeta\)/.test(clientSrc))
  ok('client.ts 把 meta 交给 handleScribeText',
    /handleScribeText\(text,\s*meta\)/.test(clientSrc))
  ok('client.ts handleScribeText 把 meta 交给 session.push',
    /session\.push\(text,\s*meta\)/.test(clientSrc))
  ok('client.ts 面板输入 → session.setText', /onTextChange:\s*\(text:\s*string\)\s*=>/.test(clientSrc) && /\.setText\(text\)/.test(clientSrc))
  ok('client.ts 保存用 session.getText()', /function scribeSaveText[\s\S]{0,220}getText\(\)/.test(clientSrc))
  const scribeBlock = clientSrc.slice(clientSrc.indexOf('function handleScribeText'), clientSrc.indexOf('function sendText'))
  ok('client 代笔段不调用 sendText、不写输入框（setInput）', scribeBlock.indexOf('sendText(') < 0 && scribeBlock.indexOf('setInput(') < 0)
  ok('voice.ts：onHeard 声明带可选 meta', /onHeard:\s*\(text:\s*string,\s*meta\?:\s*SegmentMeta\)/.test(voiceSrc))
  ok('voice.ts：收尾快照的 pauseMs/speechMs/winMs 交给 onHeard',
    /pauseMs:\s*snap\.ape \? snap\.ape\.quietMs : snap\.quietMs/.test(voiceSrc)
    && /speechMs:\s*snap\.ape \? snap\.ape\.speechMs : snap\.speechMs/.test(voiceSrc)
    && /winMs:\s*snap\.winMs/.test(voiceSrc)
    && /opts\.onHeard\(text, meta\)/.test(voiceSrc))
  ok('ActionHost 只有 startScribe（没有 stopScribe 用户入口）', /startScribe:\s*\(\)\s*=>\s*void/.test(actionsSrc) && !/stopScribe\s*:/.test(actionsSrc) && !/host\.stopScribe\b/.test(voiceActionSrc))
  ok('voice 动作只注册 scribe-start（没有 scribe-stop）', /table\.define\('scribe-start'/.test(voiceActionSrc) && !/scribe-stop/.test(voiceActionSrc))
  ok('菜单「代笔 ▸」只有打开代笔面板、没有停止代笔项', /sub\('代笔 ▸', \[[\s\S]{0,220}?item\('打开代笔面板', 'scribe-start'\)[\s\S]{0,80}?\]\)/.test(menuSrc) && !/item\('停止代笔'/.test(menuSrc) && !/'scribe-stop'/.test(menuSrc))
}

// ======================================================================
console.log('\n[I] 断句纠偏：push 带 meta 时把"没说完"的句号改逗号/补逗号')
{
  const s = createScribeSession({})
  s.start()
  s.push('第一句，', { pauseMs: 300, speechMs: 1000 })   // 需 731ms，没等够
  ok('没等够静音 → 句号降级成逗号', s.getText() === '第一句，', show(s.getText()))
  ok('lastSentence 记的是纠偏后的文本', s.getState().lastSentence === '第一句，', show(s.getState().lastSentence))

  s.push('第二句，', { pauseMs: 900, speechMs: 1000 })   // 等够了
  ok('等够静音 → 句号保留（完整句）', s.getText() === '第一句，第二句，', show(s.getText()))

  s.push('真的吗？', { pauseMs: 100, speechMs: 500 })
  ok('问号也落逗号（主人要求全程逗号）', s.getText().endsWith('真的吗，'), show(s.getText()))
  s.push('太好了！', { pauseMs: 100, speechMs: 500 })
  ok('感叹号也落逗号（主人要求全程逗号）', s.getText().endsWith('太好了，'))
  s.push('继续，', { pauseMs: 100, speechMs: 500 })
  ok('已以逗号结尾 → 原样（不重复补）', s.getText().endsWith('继续，'))

  s.push('没有句号', { pauseMs: 100, speechMs: 1000 })
  ok('没有句末标点 + 没说完 → 末尾补逗号', s.getText().endsWith('没有句号，'), show(s.getText()))

  s.push('无元数据，')
  ok('meta 缺失 → 保持旧行为（句号原样）', s.getText().endsWith('无元数据，'))
  ok('整段仍然不换行（不是一句一行）', s.getText().indexOf('\n') < 0)
  ok('count 按句累加（7 句）', s.getState().count === 7, String(s.getState().count))

  // 去重在纠偏后的文本上进行：同句同 meta 1.5 秒内二次推送被挡，也不能补两个逗号
  const d = createScribeSession({ now: () => 1000 })
  d.start()
  ok('第一次接句成功', d.push('重复的一句话', { pauseMs: 100, speechMs: 1000 }).ok === true)
  const dup = d.push('重复的一句话', { pauseMs: 100, speechMs: 1000 })
  ok('纠偏后同句仍被去重', dup.ok === false && dup.duplicate === true, JSON.stringify(dup))
  ok('去重没有把逗号追加两次', d.getText() === '重复的一句话，', show(d.getText()))

  // 用户回车分段语义不变：纠偏只动最后字符，不碰换行/正文其它内容
  const p = createScribeSession({})
  p.start()
  p.setText('第一段，\n')
  p.push('新段落半句，', { pauseMs: 100, speechMs: 500 })
  ok('回车段落语义不变 + 新段落末尾纠偏成逗号', p.getText() === '第一段，\n新段落半句，', show(p.getText()))

  // 只动最后一个字符：正文中间标点不被改写
  const mid = createScribeSession({})
  mid.start()
  mid.setText('A，B，')
  mid.push('半句，', { pauseMs: 100, speechMs: 1000 })
  ok('正文中间标点原样，只改最后一句的句号', mid.getText() === 'A，B，半句，', show(mid.getText()))
}

// ======================================================================
console.log('\n────────────────────')
if (fail === 0) console.log('✅ 通过 ' + pass + ' 项，失败 0 项')
else console.log('❌ 通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
