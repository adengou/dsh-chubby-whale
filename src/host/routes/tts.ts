/**
 * host/routes/tts.ts —— 语音合成路由（可复用模块，带缓存）
 * HTTP/缓存/参数校验在本文件；「怎么合成」交给**装配层注入**的 TtsEngine（host/tts-engine.ts 的 edge-tts）。
 * 缓存：文本+音色+语速+音调 hash → 复用 mp3（省时间、省调用）
 * 语速由请求体 rate 决定（说书 -15%，普通聊天 +0%），服务端不再写死。
 * 音色：先过 `^[a-zA-Z0-9-]+$` 字符集，再用 shared/voices.ts 的白名单（与客户端菜单同一份）；
 *       白名单外一律回落默认音色（不 400，避免破坏旧调用方），响应头 x-tts-voice: fallback 便于排障。
 * 断连（2026-11-07 B94）：客户端走了（切页面 / 30s 硬超时 / 断网重发）立刻中止正在跑的合成 ——
 *       被中止的那次**不记失败、不进缓存、不进降级闸、不回包**，只留一行 TTS-CLIENT-ABORT 诊断。
 */
import { hashKey } from '../../shared/hash.js'
import { sendTooLarge } from '../http.js'
import { readJsonBody } from '../body.js'
import { sendJson, sendBuffer } from '../respond.js'
import { normalizeRate, TTS_UNAVAILABLE } from '../../shared/tts.js'
import { DEFAULT_VOICE, normalizeVoiceName } from '../../shared/voices.js'
import type { TtsRouteDeps } from '../ports.js'

/** 单次合成的安全上限：客户端已按 80 字分段，这里只防整本大 JSON 被一次送进来 */
const MAX_TEXT = 6000
/** 请求体上限：80 字一段的 JSON 只有几百字节，64KB 足够；超了多半是误发了整本数据 */
const TTS_MAX_BODY = 64 * 1024

/**
 * 连败闸门（纯进程内状态，不依赖任何平台能力）
 *
 * 背景（2026-11-06 实测）：edge-tts 偶发 NoAudioReceived / 超时；客户端每段会重试并回退 spawn，
 * 一次失败能刷出三行 traceback，分段朗读几十段就成了刷屏。
 * 收口方式：连续失败 DEGRADE_AFTER 次（或解释器/依赖确定不可用）→ 静默 DEGRADE_MS，
 * 期间直接回 501 让客户端改走浏览器朗读，不再调引擎、不再打堆栈；任意一次成功立即清零。
 * 阈值可用环境变量覆盖（测试与排障用），默认值即正式行为。
 */
const DEGRADE_AFTER = Math.max(1, Number(process.env.CHUBBY_TTS_DEGRADE_AFTER) || 2)
const DEGRADE_MS = Math.max(1, Number(process.env.CHUBBY_TTS_DEGRADE_MS) || 60 * 1000)

/** 错误文本压成一行：python 的 traceback 是多行的，逐段打全栈正是刷屏本体 */
function oneLine(err: any, max = 220): string {
  return String((err && err.message) || err || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

/**
 * 客户端已经走了的日志标签：与真正的合成失败/超时分开，排障时一眼能分清。
 * 分两条是因为时机差一步：合成发出后断开（中止合成）/ 请求体还没读完就断开（根本没发起合成）。
 */
const LOG_CLIENT_ABORT_SYNTH = '[tts] TTS-CLIENT-ABORT 客户端已断开，合成已中止（不计入失败，不进降级闸）'
const LOG_CLIENT_ABORT_REQUEST = '[tts] TTS-CLIENT-ABORT 客户端已断开，请求中止（未发起合成）'

/** 断连观察器：signal 只在中止时 abort；gone() 供 handler 区分「客户端走了」与「合成真失败」 */
type ClientWatch = { signal: AbortSignal; gone: () => boolean; dispose: () => void }

/**
 * 盯住「客户端是不是走了」。思路与 routes/asr.ts 的 watchClientGone 一致（B93 那条），返回的
 * signal 一路传给 TtsEngine / cloudTts —— 客户端一走，还在等 python worker / 云端的合成立刻放弃。
 *
 * 为什么不能只听 req 的 close（Node 24 本机实测，时间线取证见 scripts/test-asr-abort.mjs）：
 * 请求体读完时 req 就会发 close（此时 req.complete=true、响应还没写）——只看 close 会把
 * **每个正常请求**都误判成断连。真正的断连有三种形状：
 *   ① req 'aborted'：请求体还没收完客户端就断了；
 *   ② req 'close' 且 req.complete === false：①的兜底（老版本/某些客户端不发 aborted）；
 *   ③ res 'close' 且响应没写完（writableEnded 与 writableFinished 都为 false）：客户端发完了
 *      body、等不到音频先走了 —— 客户端 30s 硬超时就是这个形状。
 * 正常结束的 res 'close' 里 writableFinished=true，不会命中 ③，所以不会误中止正常请求。
 *
 * 为什么不与 asr.ts 抽成公共模块：路由的依赖白名单（check-imports 规则 A / check-boundaries B6）
 * 只允许依赖 respond/body/http/ports/shared，抽出去就要新开一个 host/ 层模块，超出 B94 的改动范围。
 */
function watchClientGone(req: any, res: any): ClientWatch {
  const ctl = new AbortController()
  let gone = false
  const mark = (): void => {
    if (gone) return
    gone = true
    try { ctl.abort() } catch { }
  }
  const onReqAborted = (): void => mark()
  const onReqClose = (): void => { if (!req || req.complete === false) mark() }
  const onResClose = (): void => { if (!res || !(res.writableEnded || res.writableFinished)) mark() }
  const on = (target: any, ev: string, fn: () => void): void => {
    // 测试里的假 req/res 未必是 EventEmitter：没有 on 就静默跳过（既有用例都是这种形状）
    if (!target || typeof target.on !== 'function') return
    try { target.on(ev, fn) } catch { }
  }
  const off = (target: any, ev: string, fn: () => void): void => {
    if (!target || typeof target.removeListener !== 'function') return
    try { target.removeListener(ev, fn) } catch { }
  }
  on(req, 'aborted', onReqAborted)
  on(req, 'close', onReqClose)
  on(res, 'close', onResClose)
  return {
    signal: ctl.signal,
    gone: () => gone,
    dispose(): void {
      off(req, 'aborted', onReqAborted)
      off(req, 'close', onReqClose)
      off(res, 'close', onResClose)
    },
  }
}

export function createTtsHandler(opts: TtsRouteDeps) {
  // 引擎必须由装配层构造并注入（src/index.ts），路由内**不再**自建：
  // createEdgeTtsEngine 持有常驻 python 子进程，而路由工厂只交出 handler 函数，
  // 自建的实例句柄谁也拿不到 → 插件卸载/热重载时没有对象可以 dispose()（B92 封装债，B93 去兜底）。
  // 运行时也显式挡一道：JS 调用方漏传时构造即失败，而不是等到合成那一步才 500。
  if (!opts || !opts.engine) throw new Error('createTtsHandler: engine 必传（由装配层构造并注入，测试注入桩）')
  const cache = opts.cache
  const engine = opts.engine
  // 每个 handler 一份闸门状态：测试里多次 createTtsHandler 互不串味
  const failGuard = { streak: 0, until: 0 }
  // 预热常驻 worker（只解析解释器、导入依赖，不合成）：首句不必再等 python 启动。
  // warm 自身保证不抛；这里再兜一层，防止自定义引擎的异步 rejection 变成未处理异常。
  try {
    const w: any = engine as any
    if (typeof w.warm === 'function') {
      const p = w.warm.call(engine)
      if (p && typeof p.catch === 'function') void p.catch(() => { })
    }
  } catch { }

  return async function handleTts(req: any, res: any): Promise<void> {
    // 先挂断连观察器：从读 body 到合成返回的整段都在它的看护下，结束时必须 dispose（finally）
    const client = watchClientGone(req, res)
    // 诊断用：断连时区分「还没开始合成」与「合成跑到一半被中止」（两种浪费规模不一样）
    let phase: 'request' | 'synth' = 'request'
    try {
      const parsed = await readJsonBody(req, TTS_MAX_BODY)
      if (!parsed.ok) {
        console.error('[tts] BODY-TOO-LARGE > ' + TTS_MAX_BODY + ' bytes')
        sendTooLarge(res)
        return
      }
      const body = parsed.body
      const rawText = typeof body?.text === 'string' ? body.text.trim() : ''
      // 超长不再静默截断（2026-11-07 B92 审计）：原来 slice(0, MAX_TEXT) 会回 200，
      // 但引擎只收到前 6000 字 —— 调用方听到的是半句话、却没有任何信号。
      // 客户端本来就按句切分后再请求，这里超限基本只可能是外部直调：明确回 413 更诚实。
      if (rawText.length > MAX_TEXT) {
        sendJson(res, { ok: false, error: 'text too large', limit: MAX_TEXT }, 413)
        return
      }
      const msg = rawText
      const voiceIn = typeof body?.voice === 'string' ? body.voice.trim() : ''
      const isZh = /[\u4e00-\u9fa5]/.test(msg)
      // 默认按文本语言选（中文晓伊 / 英文 Ana）：'auto' 与「显式传这两个默认音色」都走这条，保持旧行为
      const langDefault = isZh ? DEFAULT_VOICE : 'en-US-AnaNeural'
      // 第一道：字符集（历史行为，先于白名单）—— 防 CRLF/引号/shell 元字符进日志与参数
      const charsetOk = !!voiceIn && /^[a-zA-Z0-9-]+$/.test(voiceIn)
      // 第二道：白名单，与客户端菜单共用 shared/voices.ts；大小写脏值归一成白名单里的规范写法
      // fallback 传 '' 表示「没命中就交回给我」，便于下面区分「没传音色」与「传了但不在名单」
      const known = charsetOk ? normalizeVoiceName(voiceIn, '') : ''
      // 白名单外（含字符合法但不认识的音色，如 ja-JP-NanamiNeural）→ 回落默认，**不回 400**：
      // 旧调用方传坏值仍要能出声（B92 的「HTTP 直调绕过白名单」在此收口，成本/策略缺口关闭）。
      const voiceFallback = voiceIn !== '' && !known
      const voice = (!known || known === 'auto' || known === DEFAULT_VOICE || known === 'en-US-AnaNeural')
        ? langDefault
        : known
      // 音频响应头：排障用；只在请求的音色确实被替换时带 x-tts-voice: fallback（正常请求与 auto 不带）
      const audioHeaders: Record<string, string> = { 'cache-control': 'no-store' }
      if (voiceFallback) audioHeaders['x-tts-voice'] = 'fallback'
      // 请求体里带了合法 rate 就用它（说书 -15%），没带默认 +0%
      const rate = normalizeRate(body?.rate, '+0%')
      // 音高：允许请求体指定（带情绪的语气），非法值回落到默认
      const pitchIn = typeof body?.pitch === 'string' ? body.pitch.trim() : ''
      const pitch = /^[+-]\d{1,3}Hz$/.test(pitchIn) ? pitchIn : (isZh ? '+10Hz' : '+15Hz')
      if (!msg) {
        sendJson(res, { ok: false, error: 'empty text' }, 400)
        return
      }
      // 缓存命中（rate/pitch 必须进 key，否则慢速说书和普通聊天会串味）
      const ck = hashKey(voice + '|' + rate + '|' + pitch + '|' + msg)
      if (cache) {
        const hit = await cache.getJson(ck, 'mp3')
        if (hit) {
          sendBuffer(res, hit, 'audio/mpeg', audioHeaders)
          return
        }
      }
      // 降级窗口内：不调引擎、不打堆栈（进入窗口时已打过一行），回 501 让客户端改走浏览器朗读
      if (Date.now() < failGuard.until) {
        sendJson(res, { ok: false, code: TTS_UNAVAILABLE, error: 'tts degraded' }, 501)
        return
      }
      // 客户端可能在读 body / 查缓存这段时间就走了（切页面、硬超时）：一帧都别合成。
      // 这里必须早于下面的合成调用 —— 否则就是 B94 要治的「人走了还在跑付费合成」。
      if (client.gone()) {
        console.error(LOG_CLIENT_ABORT_REQUEST)
        return
      }
      phase = 'synth'
      // 云端优先（火山豆包语音 2.0）：有 Key 且启用时先走云端；任何失败都回退 edge-tts（免费兜底）
      let buf: Buffer
      const cloud = opts.cloudTts
      if (cloud && cloud.enabled()) {
        try {
          // signal 传进云端：实现侧和自己的 15s 超时用 AbortSignal.any 合并，客户端一走了就断开
          buf = await cloud.synthesize(msg, client.signal)
          // 云端不接收 voice（用配置里的 speaker），所以「音色被替换」在云端路径上不成立：
          // 成功出云端时把 fallback 头摘掉，别让排障的人以为客户端音色真的生效了（2026-11-07 B93）。
          if (voiceFallback) delete audioHeaders['x-tts-voice']
        } catch (ce: any) {
          // 客户端已经走了：这次云端失败是**我们自己**中止的（signal），不是云端故障。
          // 绝不能再回退 edge-tts 重跑一遍 —— 那样等于「客户端断了，宿主还把两套合成各跑一次」。
          if (client.gone()) {
            console.error(LOG_CLIENT_ABORT_SYNTH)
            return
          }
          console.warn('[tts] CLOUD-FAIL 回退 edge-tts：' + String(ce?.message || ce).slice(0, 200))
          buf = await engine.synthesize({ text: msg, voice, rate, pitch, signal: client.signal })
        }
      } else {
        buf = await engine.synthesize({ text: msg, voice, rate, pitch, signal: client.signal })
      }
      // 合成期间客户端走了：这次结果**作废** —— 不写缓存、不记成功、不回包。
      // 为什么不「顺手缓存」：abort 语义下引擎只保证「不再等」，产物可能是半截的（见
      // host/tts-engine.ts 的取舍说明）；缓存半截音频比丢一次合成更糟，而且断连请求不该在
      // 缓存里留下「看起来合成成功」的痕迹。代价是极端情况下丢掉一次本来可复用的结果。
      if (client.gone()) {
        console.error(LOG_CLIENT_ABORT_SYNTH)
        return
      }
      // 任意一次成功即视为恢复：清零连败计数与降级窗口
      failGuard.streak = 0
      failGuard.until = 0
      if (cache) { try { await cache.setJson(ck, buf, 'mp3') } catch { } }
      sendBuffer(res, buf, 'audio/mpeg', audioHeaders)
    } catch (err: any) {
      try {
        // 客户端已经走了（请求体没收完就断 / 合成被我们自己中止）：这次不算合成失败。
        // 口径与 routes/asr.ts 一致：不记失败（不动连败计数与降级窗口）、不回包（连接已断，
        // 写了也只是往死 socket 上叠一次写），只留一行专用诊断。否则断连几次就会把降级闸
        // 推到 501，让还在线的主人改走浏览器朗读 —— 这是 B94 明确要防的误伤。
        if (client.gone()) {
          console.error(phase === 'synth' ? LOG_CLIENT_ABORT_SYNTH : LOG_CLIENT_ABORT_REQUEST)
          return
        }
        // 合成不可用（没装 python/edge-tts）→ 501，客户端据此改用浏览器 speechSynthesis；其余 → 500。
        // 连败闸门：连续失败到阈值（或依赖确定不可用）就进入静默窗口，期间不再逐段打堆栈。
        const wasUnavailable = Boolean(err && err.code === TTS_UNAVAILABLE)
        failGuard.streak++
        const degraded = wasUnavailable || failGuard.streak >= DEGRADE_AFTER
        const entering = degraded && Date.now() >= failGuard.until
        if (degraded) failGuard.until = Date.now() + DEGRADE_MS
        const detail = oneLine(err)
        if (entering) {
          console.error('[tts] ' + (wasUnavailable ? '语音合成不可用' : '连续 ' + failGuard.streak + ' 次合成失败')
            + '，' + Math.round(DEGRADE_MS / 1000) + 's 内改走浏览器朗读（不再逐段重试）：' + detail)
        } else if (!degraded) {
          // 只记录失败摘要（引擎侧已把 python stderr 截到前 500 字），不打印请求文本；压成一行
          console.error('[tts] 语音合成失败（' + failGuard.streak + '/' + DEGRADE_AFTER + '，回 500）：' + detail)
        }
        sendJson(res, {
          ok: false,
          code: degraded ? TTS_UNAVAILABLE : 'TTS_FAILED',
          error: detail,
        }, degraded ? 501 : 500)
      } catch { }
    } finally {
      // 结束就摘监听：req/res 是每请求对象，不摘也不会串到下一个请求，但已经结束的 handler
      // 没必要继续响应 'close'/'aborted'（多一次无意义的 abort，排障时也容易看花眼）
      client.dispose()
    }
  }
}
