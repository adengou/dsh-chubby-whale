/**
 * scripts/test-web-search.mjs —— 联网搜索/阅读链接专项回归（2026-11-14 审计）
 *
 * 离线、不联网：fetch 全部用桩。只钉联网这条线：
 *   A. /chat 的 web 开关、工具声明、非 flash 忽略、缓存隔离
 *   B. 来源整理：URL 归一/去重、标题补全/截断、来源段不重复、网页正文不进回复
 *   C. usage 计费：tool_search / tool_fetch / tool_image_search；展示字段不算钱
 *   D. 失败路径：200+error、content_filter、联网空回复；不写记忆、不编来源、usage 照记
 *   E. 网页内容隔离：memory 只拿模型正文，snippet/page.content/signature 不落盘
 *   F. 客户端：联网回合不走流式、请求带 web:true、超时预算更长、模型忽略联网时明确提示
 *
 * 用法：node scripts/test-web-search.mjs
 */
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

register(new URL('./ts-resolve.mjs', import.meta.url))
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; failures.push(name + (detail ? '  ' + detail : '')); console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}
function group(t) { console.log('\n' + t) }

const realFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('测试不许真联网') }

function mkReq(body, opts = {}) {
  const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  return {
    method: opts.method || 'POST',
    url: opts.url || '/api/chubby-whale/chat',
    headers: Object.assign({ 'content-length': String(buf.length) }, opts.headers || {}),
    destroy() { }, on() { }, resume() { },
    async *[Symbol.asyncIterator]() { yield buf },
  }
}
function mkRes() {
  const out = { code: 0, chunks: [], headers: {} }
  out.writeHead = (c, h) => { out.code = c; out.headers = h || {} }
  out.setHeader = (k, v) => { out.headers[k] = v }
  out.end = (b) => { if (b) out.chunks.push(Buffer.from(String(b))) }
  out.bodyText = () => Buffer.concat(out.chunks).toString('utf8')
  out.json = () => { try { return JSON.parse(out.bodyText()) } catch { return null } }
  return out
}
function jsonResp(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(obj),
  }
}

function makeChatDeps(overrides = {}) {
  const log = { adds: [], turns: [], cacheReads: 0, cacheWrites: 0, exp: [] }
  const deps = {
    getKey: () => 'sk-test',
    loadHistory: () => [],
    appendTurns: (u, r) => { log.turns.push([u, r]) },
    loadState: () => ({ intimacy: 0 }),
    saveState: () => { },
    systemPrompt: 'SYS',
    addExp: (n, kind) => { log.exp.push([n, kind]); return { upgraded: false } },
    addTokens: (kind, n, detail) => { log.adds.push({ kind, n, detail }) },
    loadMemorySummary: () => '',
    saveMemorySummary: () => { },
    cacheEnabled: () => true,
    cache: {
      getJson: async () => { log.cacheReads++; return null },
      setJson: async () => { log.cacheWrites++ },
    },
    model: 'deepseek-flash',
    noteUserChat: () => { },
    ...overrides,
  }
  return { deps, log }
}

async function runChat(deps, body, upstream) {
  const captured = []
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), body: init && init.body ? JSON.parse(String(init.body)) : null })
    return upstream
  }
  const handler = (await import('../src/host/routes/chat.ts')).createChatHandler(deps)
  const res = mkRes()
  await handler(mkReq(body), res)
  return { res, json: res.json(), captured }
}

try {
  const CIT = await import('../src/shared/citations.ts')
  const PRICE = await import('../src/shared/pricing.ts')
  const CLIENT = await import('../src/client/chat.ts')
  const BUSY = await import('../src/client/busy.ts')
  const TEXT = await import('../src/client/text.ts')

  // ==================================================================
  group('[A] /chat：web 开关 / 工具声明 / 非 flash / 缓存')
  {
    const { deps, log } = makeChatDeps()
    const success = jsonResp({
      choices: [{ message: { content: '普通回答' } }],
      usage: { total_tokens: 10, prompt_tokens: 6, completion_tokens: 4 },
    })
    let r = await runChat(deps, { message: '你好' }, success)
    ok('web 缺省（默认关）→ 请求不带 tools', r.captured[0].body.tools === undefined, JSON.stringify(r.captured[0].body.tools))
    ok('web 缺省 → 响应不带 web 元信息', r.json.web === undefined)

    const webSuccess = jsonResp({
      choices: [{ message: { content: '联网答复', annotations: [{ type: 'url_citation', url_citation: { url: 'https://a.com/x', title: '甲文' } }] } }],
      usage: { total_tokens: 20, prompt_tokens: 12, completion_tokens: 8, server_tool_use: { tool_search: 1 } },
    })
    r = await runChat(deps, { message: '最近有什么新闻', web: true }, webSuccess)
    const sent = r.captured[0].body
    ok('web=true → 声明两个官方服务端工具', Array.isArray(sent.tools) && sent.tools.length === 2
      && sent.tools[0].type === 'deepseek_web_search' && sent.tools[1].type === 'deepseek_read_url',
    JSON.stringify(sent.tools))
    ok('联网搜索关闭思考（普通搜索口径）', sent.thinking && sent.thinking.type === 'disabled', JSON.stringify(sent.thinking))
    ok('web 只作为开关，不进上游请求体', sent.web === undefined)
    ok('联网回合不读聊天缓存', log.cacheReads === 0, 'reads=' + log.cacheReads)
    ok('响应带 web 元信息（enabled/sources）', r.json.web && r.json.web.enabled === true && r.json.web.sources === 1,
      JSON.stringify(r.json.web))
    ok('来源仍拼进 reply（兼容旧客户端）', String(r.json.reply).indexOf('来源：') > 0 && String(r.json.reply).indexOf('https://a.com/x') > 0,
      JSON.stringify(r.json.reply))

    // 非 flash：忽略联网，但要如实返回 web.enabled=false
    const { deps: proDeps, log: proLog } = makeChatDeps({ model: 'deepseek-v4-pro' })
    r = await runChat(proDeps, { message: '查一下最近的新闻', web: true }, success)
    ok('非 deepseek-flash → 不声明工具', r.captured[0].body.tools === undefined, JSON.stringify(r.captured[0].body.tools))
    ok('非 deepseek-flash → 响应明确 web.enabled=false（不冒充联网）',
      r.json.web && r.json.web.requested === true && r.json.web.enabled === false && r.json.web.reason === 'model',
      JSON.stringify(r.json.web))
    ok('非 flash 的 web:true 也不读缓存（不能拿旧答案冒充联网）', proLog.cacheReads === 0, 'reads=' + proLog.cacheReads)
  }

  // ==================================================================
  group('[B] 来源整理：归一 / 去重 / 标题 / 截断 / 不拼网页正文')
  {
    const cites = CIT.collectCitations({
      annotations: [
        // 主机大小写、默认端口、尾斜杠、#片段 都应归一到同一条
        { url_citation: { url: 'https://A.COM:443/x/#frag', title: '甲' } },
        { url_citation: { url: 'https://a.com/x', title: '' } },
        // 标题未知时官方会回 URL 本身
        { url_citation: { url: 'https://b.com/y', title: 'https://b.com/y' } },
        { url_citation: { url: 'javascript:alert(1)', title: '坏' } },
        { url_citation: { url: 'https://', title: '坏' } },
      ],
      server_tool_calls: [{
        calls: [{
          sources: [
            // 同一 URL 后到、带标题：应补标题而不是再出现一条
            { url: 'https://a.com/x', title: '甲文' },
            { url: 'https://c.com/z', title: '丙文', snippet: 'SENTINEL_SNIPPET' },
          ],
          page: { url: 'https://d.com/p', title: '丁文', content: { type: 'document', data: 'SENTINEL_PAGE' } },
        }],
      }],
    })
    ok('URL 归一后去重（#片段/尾斜杠/默认端口/主机大小写）', cites.length === 4, JSON.stringify(cites))
    ok('标题未知时保留条目、后到标题补全', cites[0].url === 'https://A.COM:443/x/#frag' && cites[0].title === '甲',
      JSON.stringify(cites[0]))
    ok('标题等于 URL 时清空', cites[1].url === 'https://b.com/y' && cites[1].title === '', JSON.stringify(cites[1]))
    ok('非 http(s)/坏 URL 丢弃', !cites.some((c) => /javascript|^https:\/$/.test(c.url)), JSON.stringify(cites))
    ok('page 与 sources 都收', cites.some((c) => c.url === 'https://d.com/p') && cites.some((c) => c.url === 'https://c.com/z'))
    ok('snippet/page.content 不进入来源对象', JSON.stringify(cites).indexOf('SENTINEL') < 0, JSON.stringify(cites))

    const filled = CIT.collectCitations({
      annotations: [{ url_citation: { url: 'https://e.com/q', title: '' } }],
      server_tool_calls: [{ calls: [{ sources: [{ url: 'https://e.com/q', title: '补全标题' }] }] }],
    })
    ok('先到的空标题由后到的同 URL 来源补全', filled.length === 1 && filled[0].title === '补全标题', JSON.stringify(filled))

    const failed = CIT.collectCitations({
      server_tool_calls: [{
        calls: [
          { status: 'failed', error: { code: 'url_not_accessible' }, page: { url: 'https://failed.com', title: '失败页' } },
          { status: 'completed', sources: [{ url: 'https://ok.com', title: '成功来源' }] },
        ],
      }],
    })
    ok('status=failed 的调用不当作来源', failed.length === 1 && failed[0].url === 'https://ok.com', JSON.stringify(failed))

    ok('最多保留 5 条', CIT.collectCitations({
      annotations: Array.from({ length: 8 }, (_, i) => ({ url_citation: { url: 'https://m.com/' + i } })),
    }).length === 5)

    const longTitle = CIT.collectCitations({ annotations: [{ url_citation: { url: 'https://t.com/a', title: '字'.repeat(120) } }] })
    ok('超长标题按码点截断并加省略号', longTitle[0].title.length === 81 && /…$/.test(longTitle[0].title), String(longTitle[0].title.length))

    const longUrl = 'https://u.com/' + 'x'.repeat(400)
    const longCite = CIT.collectCitations({ annotations: [{ url_citation: { url: longUrl, title: '长' } }] })
    const longLine = CIT.appendCitations('正文', longCite)
    ok('超长 URL 只在展示行截断（保留原始 URL 供回包）', longCite[0].url === longUrl && longLine.indexOf('…') > 0 && longLine.length < 400,
      'cite=' + longCite[0].url.length + ' line=' + longLine.length)

    ok('appendCitations 拼成编号列表', CIT.appendCitations('正文', [{ url: 'https://a.com', title: 'A' }]) === '正文\n\n来源：\n1. A — https://a.com')
    ok('无标题时只显示 URL', CIT.appendCitations('正文', [{ url: 'https://a.com', title: '' }]) === '正文\n\n来源：\n1. https://a.com')
    ok('正文里已有「来源：」不重复拼', CIT.appendCitations('正文\n\n来源：\n1. x', [{ url: 'https://a.com' }]) === '正文\n\n来源：\n1. x')
    ok('空「来源：」标题仍补结构化来源', CIT.appendCitations('正文\n\n来源：', [{ url: 'https://a.com' }]) === '正文\n\n来源：\n1. https://a.com')
    ok('正文里已有「参考来源：」不重复拼', CIT.appendCitations('正文\n参考来源：\n1. x', [{ url: 'https://a.com' }]) === '正文\n参考来源：\n1. x')
    ok('正文里已有「Sources:」不重复拼', CIT.appendCitations('正文\nSources:\n1. x', [{ url: 'https://a.com' }]) === '正文\nSources:\n1. x')
    ok('空回复不硬拼来源', CIT.appendCitations('   ', [{ url: 'https://a.com' }]) === '   ')
    ok('appendCitations 也会去重', CIT.appendCitations('正文', [{ url: 'https://a.com' }, { url: 'https://a.com/' }]) === '正文\n\n来源：\n1. https://a.com')
    ok('坏来源在拼接时再次被拒', CIT.appendCitations('正文', [{ url: 'javascript:x' }, { url: 'https://ok.com' }]) === '正文\n\n来源：\n1. https://ok.com')
  }

  // ==================================================================
  group('[C] 计费：只认 usage.server_tool_use 的计费字段')
  {
    ok('2 搜 + 1 抓 + 1 图搜 = 0.02 元', PRICE.estimateWebToolCostCny({ server_tool_use: { tool_search: 2, tool_fetch: 1, tool_image_search: 1 } }) === 0.02)
    ok('只有图片搜索也计费（5 元/1000 次）', PRICE.estimateWebToolCostCny({ server_tool_use: { tool_image_search: 2 } }) === 0.01)
    ok('web_search_requests / web_fetch_requests 只是展示字段 → null（不算钱）',
      PRICE.estimateWebToolCostCny({ server_tool_use: { web_search_requests: 9, web_fetch_requests: 9 } }) === null)
    ok('没有 server_tool_use → null（不猜 0）', PRICE.estimateWebToolCostCny({ total_tokens: 10 }) === null)
    const uses = PRICE.readWebToolUses({ server_tool_use: { tool_search: '2', tool_fetch: '1', tool_image_search: '3' } })
    ok('计费字段兼容字符串数字', uses && uses.search === 2 && uses.fetch === 1 && uses.imageSearch === 3, JSON.stringify(uses))
  }

  // ==================================================================
  group('[D] 失败路径：200+error / content_filter / 联网空回复')
  {
    const { deps, log } = makeChatDeps()
    let r = await runChat(deps, { message: '查新闻', web: true }, jsonResp({
      error: { code: 'server_error', message: 'model failed' },
      usage: { total_tokens: 42, prompt_tokens: 30, completion_tokens: 12, server_tool_use: { tool_search: 1 } },
    }))
    ok('200 + error → ok:false，不冒充成功', r.json.ok === false && r.json.error === 'server_error', JSON.stringify(r.json))
    ok('200 + error → 联网失败文案，不带 sources', /联网/.test(String(r.json.reply)) && r.json.sources === undefined, JSON.stringify(r.json.reply))
    ok('200 + error → 不写记忆、不加经验', log.turns.length === 0 && log.exp.length === 0, 'turns=' + log.turns.length)
    ok('200 + error → usage 照记（已发生的搜索会计费）', log.adds.length === 1 && log.adds[0].n === 42
      && log.adds[0].detail && log.adds[0].detail.costCny >= 0.005, JSON.stringify(log.adds))

    const { deps: d2, log: l2 } = makeChatDeps()
    r = await runChat(d2, { message: '查新闻', web: true }, jsonResp({
      choices: [{
        finish_reason: 'content_filter',
        message: {
          content: '',
          server_tool_calls: [{ calls: [{ sources: [{ url: 'https://bad.com', title: '不该出现' }] }] }],
        },
      }],
      usage: { total_tokens: 30, prompt_tokens: 20, completion_tokens: 10, server_tool_use: { tool_search: 1 } },
    }))
    ok('content_filter → ok:false + CONTENT_FILTER', r.json.ok === false && r.json.error === 'CONTENT_FILTER', JSON.stringify(r.json))
    ok('content_filter → 拒答文案，不附来源/不写记忆', /没法回答/.test(String(r.json.reply)) && r.json.sources === undefined && l2.turns.length === 0,
      JSON.stringify(r.json))
    ok('content_filter → usage 照记', l2.adds.length === 1 && l2.adds[0].n === 30, JSON.stringify(l2.adds))

    const { deps: d3, log: l3 } = makeChatDeps()
    r = await runChat(d3, { message: '查新闻', web: true }, jsonResp({
      choices: [{ finish_reason: 'stop', message: { content: '', reasoning_content: 'REASONING_SENTINEL' } }],
      usage: { total_tokens: 18, prompt_tokens: 12, completion_tokens: 6 },
    }))
    ok('联网空回复 → ok:false + EMPTY_WEB_REPLY', r.json.ok === false && r.json.error === 'EMPTY_WEB_REPLY', JSON.stringify(r.json))
    ok('联网空回复 → 不把 reasoning 写进回复/记忆', JSON.stringify(r.json).indexOf('REASONING_SENTINEL') < 0 && l3.turns.length === 0,
      JSON.stringify(r.json))
    ok('联网空回复 → usage 照记', l3.adds.length === 1 && l3.adds[0].n === 18)
  }

  // ==================================================================
  group('[E] 网页内容隔离：memory 只有正文，来源/正文块不落盘')
  {
    const { deps, log } = makeChatDeps()
    const r = await runChat(deps, { message: '总结一下这篇报道', web: true }, jsonResp({
      choices: [{
        message: {
          content: '这是模型写的摘要。',
          annotations: [{ type: 'url_citation', url_citation: { url: 'https://news.example/a', title: '报道标题' } }],
          server_tool_calls: [{
            reasoning_content: 'STEP_REASONING_SENTINEL',
            calls: [{
              type: 'deepseek_read_url',
              kind: 'read_link',
              page: { url: 'https://news.example/a', title: '报道标题', content: { data: 'PAGE_DATA_SENTINEL' } },
              signature: 'SIGNATURE_SENTINEL',
              sources: [{ url: 'https://news.example/b', title: '另一个来源', snippet: 'SNIPPET_SENTINEL' }],
            }],
          }],
        },
      }],
      usage: { total_tokens: 100, prompt_tokens: 70, completion_tokens: 30, server_tool_use: { tool_fetch: 1, tool_search: 1 } },
    }))
    const reply = String(r.json.reply)
    ok('回复附来源（可读、编号）', /来源：\n1\. 报道标题 — https:\/\/news\.example\/a/.test(reply), JSON.stringify(reply))
    ok('回复里没有网页正文/签名/reasoning', !/PAGE_DATA_SENTINEL|SNIPPET_SENTINEL|SIGNATURE_SENTINEL|STEP_REASONING_SENTINEL/.test(reply), JSON.stringify(reply))
    const mem = log.turns[0] ? log.turns[0][1] : ''
    ok('memory 只写模型正文（不含来源块/URL）', mem === '这是模型写的摘要。', JSON.stringify(mem))
    ok('memory 不含网页正文/片段/签名/reasoning', !/PAGE_DATA_SENTINEL|SNIPPET_SENTINEL|SIGNATURE_SENTINEL|STEP_REASONING_SENTINEL|https:\/\//.test(mem), JSON.stringify(mem))
    ok('结构化 sources 只含 url/title', Array.isArray(r.json.sources) && r.json.sources.length === 2
      && Object.keys(r.json.sources[0]).sort().join(',') === 'title,url'
      && JSON.stringify(r.json.sources).indexOf('SENTINEL') < 0, JSON.stringify(r.json.sources))
    ok('记账含 2 次工具费（0.01 起）', log.adds.length === 1 && log.adds[0].detail && log.adds[0].detail.costCny >= 0.01,
      JSON.stringify(log.adds[0] && log.adds[0].detail))
  }

  // ==================================================================
  group('[F] 客户端：联网非流式 / 请求体 / 超时 / 模型忽略提示')
  {
    const ls = new Map()
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k) => (ls.has(k) ? ls.get(k) : null),
        setItem: (k, v) => { ls.set(String(k), String(v)) },
        removeItem: (k) => { ls.delete(k) },
      },
    })
    globalThis.window = { __chubbyWhale: {} }

    function mkHost() {
      const st = { messages: [], bubbles: [], replies: [], phases: [] }
      const host = {
        persona: { line: (k) => 'LINE:' + k, reactTo: () => null },
        bubble: (t) => { st.bubbles.push(String(t)) },
        say: () => { },
        speak: () => { },
        speakReply: (t) => { st.replies.push(String(t)) },
        stopSpeak: () => { },
        talkFor: () => { },
        heart: () => { },
        setInput: () => { },
        setMessages: (u) => { st.messages = typeof u === 'function' ? u(st.messages) : u },
        setBusy: () => { },
        scrollBody: () => { },
        busy: BUSY.createBusyLock(),
        epoch: BUSY.createEpoch(),
        narrating: { current: false },
        storyBusy: { current: false },
        voiceMode: { current: false },
        ttsPlaying: () => false,
        narrationRate: () => '-25%',
        route: () => false,
        replyDeduper: TEXT.createDeduper({ windowMs: 30000 }),
        recordChatLatency: () => { },
        onPhase: (p) => { st.phases.push(p) },
      }
      return { host, st }
    }

    ls.clear()
    ls.set('chubby-stream', 'on')
    ok('联网开关默认关', CLIENT.resolveWebSearchOn() === false)
    ls.set('chubby-web-search', 'on')
    ok('localStorage=on 时开启', CLIENT.resolveWebSearchOn() === true)

    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: init && init.body ? JSON.parse(String(init.body)) : null })
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          reply: '联网答复\n\n来源：\n1. 甲文 — https://a.com/x',
          sources: [{ url: 'https://a.com/x', title: '甲文' }],
          web: { requested: true, enabled: true, sources: 1 },
        }),
      }
    }
    const { host, st } = mkHost()
    const chat = CLIENT.createChatSender(host)
    await chat.send('查一下最近的新闻')
    ok('联网回合只发 /chat，不走 /chat-stream', calls.length === 1 && /\/chat$/.test(calls[0].url), JSON.stringify(calls.map((c) => c.url)))
    ok('客户端请求体带 web:true', calls[0].body && calls[0].body.web === true, JSON.stringify(calls[0].body))
    ok('回复进消息列表（含来源）', st.messages.some((m) => m.who === 'fish' && m.text.indexOf('来源：') > 0)
      && st.messages.some((m) => m.who === 'fish' && m.text.indexOf('https://a.com/x') > 0), JSON.stringify(st.messages))
    ok('朗读只念正文、不念来源 URL', st.replies.length === 1 && st.replies[0] === '联网答复', JSON.stringify(st.replies))
    ok('联网回合结束释放占线', host.busy.isBusy() === false)

    // 宿主回报 web.enabled=false（模型不支持）：要有明确提示，不能默默当普通回答
    calls.length = 0
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: init && init.body ? JSON.parse(String(init.body)) : null })
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          reply: '普通回答',
          web: { requested: true, enabled: false, reason: 'model' },
        }),
      }
    }
    await chat.send('再查一下')
    ok('模型忽略联网 → 气泡明确提示', st.bubbles.some((b) => /不支持联网/.test(b)), JSON.stringify(st.bubbles))

    // 超时预算：源码口径钉住（行为测试等 90/100 秒不现实）
    const hostSrc = readFileSync(path.join(ROOT, 'src/host/routes/chat.ts'), 'utf8')
    const clientSrc = readFileSync(path.join(ROOT, 'src/client/chat.ts'), 'utf8')
    ok('宿主联网超时 90 秒，普通聊天仍 30 秒', /WEB_CHAT_TIMEOUT\s*=\s*90\s*\*\s*1000/.test(hostSrc) && /CHAT_TIMEOUT\s*=\s*30\s*\*\s*1000/.test(hostSrc))
    ok('宿主按联网开关选择超时', /const timeoutMs = webEnabled \? WEB_CHAT_TIMEOUT : CHAT_TIMEOUT/.test(hostSrc)
      && /fetchJson\(CHAT_URL[\s\S]*?timeoutMs, client\.signal\)/.test(hostSrc))
    ok('客户端联网超时 100 秒（比宿主长 10 秒）', /WEB_CHAT_TIMEOUT_MS\s*=\s*100000/.test(clientSrc))
    ok('客户端联网回合使用更长超时', /web \? WEB_CHAT_TIMEOUT_MS : CHAT_TIMEOUT_MS/.test(clientSrc))
  }
} catch (e) {
  ok('用例未抛异常', false, String((e && e.stack) || e))
} finally {
  globalThis.fetch = realFetch
}

console.log('\n' + '='.repeat(52))
console.log('通过 ' + pass + ' 项 / 失败 ' + fail + ' 项')
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('✅ 联网搜索专项回归全部通过')
process.exit(0)
