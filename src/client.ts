/**
 * dsh-chubby-whale —— 浏览器端入口（组件骨架 + 组装 + JSX）
 * 工具模块：client/hooks.ts（通用 hooks）、client/effects.ts（监听器/定时器/清理工厂）、
 *           client/render.ts（菜单与聊天面板的纯渲染）
 * 其余能力：client/styles.ts（样式）、client/menu.ts（菜单数据）、client/anim.ts（动画）等
 */
import { W, H, CW, CH, SX, SY, VERSION, stageStyle, stageTransform, canvasStyle, recoverDotStyle } from './client/styles.js'
import { buildMenu, tr } from './client/menu.js'
import { stopProgress } from './client/narration-progress.js'
import { narrationRate, chatRate } from './client/rates.js'
import { handleFileDrop } from './client/dropzone.js'
import { createAnimator } from './client/anim.js'
import { DEFAULT_GROWTH, fetchGrowth, lookFor, lookForGrowth, parseGrowth } from './client/look.js'
import { createVoiceBridge } from './client/voice-bridge.js'
import { createActionTable, type ActionHost } from './client/actions.js'
import { registerCultureActions } from './client/actions/culture.js'
import { parseBookList, registerContentActions } from './client/actions/content.js'
import { registerSystemActions } from './client/actions/system.js'
import { registerVoiceActions } from './client/actions/voice.js'
import { createPersona, applyServerMood } from './client/persona.js'
import { createDeduper } from './client/text.js'
import { getJson } from './client/http.js'
import { createMelodyPlayer } from './client/melody.js'
import { createBubble, clearBubbleTimer, ensureBubbleStyle } from './client/bubble.js'
import { createNarrationLock } from './client/narration.js'
import { createBusyLock, createEpoch } from './client/busy.js'
import { clampPos, homePos as calcHomePos, createDragState, beginDrag, moveDrag, endDrag, bindDragInput } from './client/stage.js'
import { createFlight, launch, stepFlight, squashScale, SQUASH_MS } from './client/physics.js'
import { createPhaseMachine } from './client/phase.js'
import { createStoryController } from './client/story.js'
import { createLocalRouter } from './client/chat-route.js'
import { createChatSender } from './client/chat.js'
import { createReminderPoller } from './client/reminders.js'
import { createReminderManager } from './client/reminder-manage.js'
import { createRecover } from './client/recover.js'
import { createHooks } from './client/hooks.js'
import { bindFileDropCapture, bindOutsideClose, bindResize, bindChatFocus, bindMenuKeys, createUnmountCleanup, startGreeting, startWatchdog } from './client/effects.js'
import { renderMenuItems, renderMenuHeader, renderChatPanel, readMenuRuntime, listMenuEntries, menuRootProps } from './client/render.js'
import { evPrevent, evStop } from './client/util.js'
;(window as any).__ModuleLoader__.load({
  id: 'dsh-chubby-whale',
  factory: (require: any) => {
    const R = require('react')
    // 早期错误记录器：抓住宿主插槽渲染我们组件时抛的异常（模块加载即安装）
    // 三条硬要求：① 环形缓冲（只留最近 50 条，长时间运行不涨内存）
    //            ② 补丁幂等（模块重复加载不叠加，不会把日志打两遍）
    //            ③ 不覆盖已存在的数组（别的模块可能已经挂过）
    try {
      const wErr: any = window as any
      if (!Array.isArray(wErr.__chubbyErrors)) wErr.__chubbyErrors = []
      const pushErr = (line: string): void => {
        try {
          const arr: string[] = wErr.__chubbyErrors
          arr.push(String(line || '').slice(0, 800))
          while (arr.length > 50) arr.shift()
        } catch (e) { }
      }
      if (!wErr.__chubbyErrPatched) {
        wErr.__chubbyErrPatched = true
        const origErr = console.error
        console.error = function (...a: any[]) {
          pushErr(a.map((x: any) => (x && x.stack) ? x.stack : String(x)).join(' '))
          return (origErr as any).apply(console, a as any)
        } as any
        window.addEventListener('error', (e: any) => {
          pushErr('window.error: ' + (e.message || '') + ' | ' + ((e.error && e.error.stack) || ''))
        })
      }
    } catch (e) { }
    const h = R.createElement
    /** 调试命名空间合并写入：window 不可用时静默；已有对象复用，绝不整替换（别处挂的字段不能丢） */
    const dg = (patch: any): void => { try { Object.assign(((window as any).__chubbyWhale || ((window as any).__chubbyWhale = {})), patch) } catch (e) { } }
    /** 调试计数 +1（原来两处手写 `x = (x || 0) + 1`） */
    const bump = (key: string): void => { try { const w: any = (window as any).__chubbyWhale; w[key] = (w[key] || 0) + 1 } catch (e) { } }
    // 气泡文字断行：样式表在 client/bubble.ts（冻结的公开接口），长串（URL / base64 /
    // 没有空格的长英文）在 white-space:pre-wrap 下不换行，会撑破 320px 气泡溢出屏幕，
    // 这里用内联样式补断行。常量提到组件外，避免每次渲染都新建样式对象。
    const BUBBLE_TEXT_STYLE = { overflowWrap: 'anywhere' as const, wordBreak: 'break-word' as const }
    // 通用 hooks：惰性单例 ref / localStorage 布尔开关（client/hooks.ts）
    const hookApi = createHooks(R)

    // 动作表：菜单动作 → 处理器（新增动作只改 client/actions/*.ts 与菜单数据，不动本文件）
    const actions = createActionTable<ActionHost>()
    registerCultureActions(actions)
    registerContentActions(actions)
    registerSystemActions(actions)
    registerVoiceActions(actions)



    // 客户端标识：多标签页说书队列互不抢段（取不到就退化成单队列）
    const CLIENT_ID = (() => {
  // 会话级 id：同一标签页刷新后保持稳定（进度对得上），不同标签页各自独立——
  // 服务端按 clientId 分连播队列，用 localStorage 会让两个标签页共用一条队列互相踢掉。
  try { const v = sessionStorage.getItem('chubby-client-id'); if (v) return v } catch (e) { }
  const v = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  try { sessionStorage.setItem('chubby-client-id', v) } catch (e) { }
  return v
})()

    let ttsPlaying = false   // UI 用：是否正在说（由新语音模块状态回调更新）
    const channels: any = { mic: { stats: {} }, asr: { stats: {} }, speak: { stats: {} } }
    // 请求纪元：主人一问新问题，旧的异步回复自动作废（client/busy.ts）
    const epoch = createEpoch()
    // 叙述语速（与 voice.ts 同源，localStorage 可调，默认 -25%）
    
    const storyNarratingRef = { current: false }
    const persona = createPersona()
  // 诊断对象上尽早挂出人设：原来只在 useEffect 里挂，效果是"组件没跑完副作用就查不到"，
  // 冒烟测试/排障都会误以为人设没初始化。这里创建完立刻挂，effect 里那份保留（幂等）。
  try {
    const w: any = (window as any).__chubbyWhale || ((window as any).__chubbyWhale = {})
    w.persona = persona
  } catch (e) { }
    // 叙述锁带时间上限：念诗/说书期间不理麦克风，但绝不能"忘了解锁"把耳朵永久关掉
    // （状态机与自愈在 client/narration.ts）
    const narration = createNarrationLock()
    function setNarrating(ms: number): void {
      narration.lock(ms)
      try { storyNarratingRef.current = true } catch (e) { }
    }
    function clearNarrating(): void {
      narration.clear()
      // 念诗被打断（说"停"/新提问）时进度状态也要清，
      // 否则下一次说书的开场气泡会挂着上一首诗的「第 x/y 句」
      try { stopProgress() } catch (e) { }
      try { storyNarratingRef.current = false } catch (e) { }
    }

    // ===== 叙述锁「持有者令牌」=====
    // 念诗与说书共用一把锁（client/narration.ts 只有一份 until）。旧接法是「谁收尾都直接
    // clearNarrate()」：念诗中途点「讲段书」，说书已经接过锁，诗尾的 onDone 回来会把说书那一段
    // 的锁和叙述标记一起清掉 —— 说书从此没有叙述锁，而 voice-bridge 的 onSegment 靠 narrating
    // 才冒泡（气泡不更新），麦克风也会提前拾音（docs/并发纪律.md 规则 5）。
    // 现在每个使用方（说书 / 菜单动作 / 点播路由）各拿一个句柄：narrate 时记下持有者，
    // clearNarrate 只认「自己仍是持有者」，别人上的锁一律不碰。
    let narrateOwner = 0
    let narrateSeq = 0
    /** 长段朗读探针（ownerId → timer）：收尾或换持有者时撤掉 */
    const narrateProbes = new Map<number, any>()

    function dropNarrateProbe(owner: number): void {
      const t = narrateProbes.get(owner)
      if (t === undefined) return
      narrateProbes.delete(owner)
      try { clearTimeout(t) } catch (e) { }
    }

    /**
     * 说书长段的「只报警不放锁」探针：client/story.ts 只给估算 ≤2 分钟的段挂朗读兜底，
     * 长段（1000 字≈4 分钟）一旦丢了 onDone 就永久卡在「正讲着呢」——这时锁本身会被
     * narration.ts 的 5 分钟上限自愈，卡住的是故事 busy 与气泡。这里到点只写一次诊断
     * （__chubbyWhale.narrateOverdue / narrateOverdueInfo），绝不动锁、不弹气泡：
     * 锁语义仍由 narration.ts 的时限与各自的兜底决定，探针只负责把"疑似丢回调"记下来。
     */
    function armNarrateProbe(owner: number, label: string, ms: number, stillStuck: () => boolean): void {
      dropNarrateProbe(owner)
      const estMs = Math.max(0, Number(ms) || 0)
      // 下限 30 秒：一两句的短段光合成就要好几秒，别把正常排队误报成"卡住"
      const afterMs = Math.max(30000, Math.round(estMs * 1.5))
      const t: any = setTimeout(() => {
        narrateProbes.delete(owner)
        if (narrateOwner !== owner) return
        let stuck = false
        try { stuck = !!stillStuck() } catch (e) { stuck = false }
        if (!stuck) return
        try { bump('narrateOverdue') } catch (e) { }
        dg({
          narrateOverdueInfo: {
            label: label, estMs: estMs, afterMs: afterMs,
            lockLeftMs: narration.remaining(), at: Date.now(),
          },
        })
      }, afterMs)
      // Node（测试/自检）里别让探针把进程吊住
      try { if (t && typeof t.unref === 'function') t.unref() } catch (e) { }
      narrateProbes.set(owner, t)
    }

    /** 权威清锁：停止说话 / 叙述锁过期自愈。不认持有者（这类操作就是要立刻静音），清完连探针一起作废 */
    function resetNarration(): void {
      narrateOwner = 0
      const owners = Array.from(narrateProbes.keys())
      for (const id of owners) dropNarrateProbe(id)
      clearNarrating()
    }

    /**
     * 给一个使用方发叙述锁句柄（持有者令牌）：
     *   · narrate(ms)：成为持有者 + 上锁 + 挂长段探针；
     *   · clearNarrate()：只有「自己还是持有者」才真解；过期回调（诗尾在说书接锁之后才回来）
     *     只撤自己的探针，不动锁、不清 storyNarratingRef，气泡继续跟说书更新。
     * stillStuck 只给探针用：判断"该收尾了却还占着"。
     */
    function makeNarrateHandle(label: string, stillStuck: () => boolean): { narrate: (ms: number) => void; clearNarrate: () => void } {
      const owner = ++narrateSeq
      return {
        narrate(ms: number): void {
          narrateOwner = owner
          setNarrating(ms)
          armNarrateProbe(owner, label, ms, stillStuck)
        },
        clearNarrate(): void {
          dropNarrateProbe(owner)
          if (narrateOwner !== owner) return
          narrateOwner = 0
          clearNarrating()
        },
      }
    }
    let greetedOnce = false   // 打招呼只打一次（防挂载重复）
    // 台词/回复去重：原来是两段手写的时间窗判断，统一用 client/text.ts 的 deduper
    const lineDeduper = createDeduper({ windowMs: 25000, onDuplicate: () => bump('dupLine') })
    const replyDeduper = createDeduper({ windowMs: 30000, onDuplicate: () => bump('dupReply') })
    const latDiag: any = { asrMs: 0, chatMs: 0, firstAudioMs: 0, totalMs: 0, updates: 0 }
    // 琴声播放器：音符表、振荡器排程、停止/关闭 AudioContext 都在 client/melody.ts
    const melody = createMelodyPlayer()

    /** 最近一次渲染异常文本：只在变化时打日志，避免异常期间每次渲染都刷一条 */
    let lastRenderErr = ''
    /**
     * 安全外壳：把内层组件的渲染异常就地拦下并记录，绝不让整个 slot 变成错误占位。
     * 失败时不再返回 null（整只鱼消失、主人无从恢复）：右下角留一个可点的「⚠」，
     * 点一下重试渲染。重试计数放在 try 之前，保证所有分支的 hooks 顺序一致。
     */
    function WhaleOverlay() {
      const [retryTick, setRetryTick] = R.useState(0)
      try {
        const tree = WhaleBody()
        lastRenderErr = ''
        return tree
      } catch (e: any) {
        const msg = String((e && e.stack) || e)
        dg({ renderError: msg })
        if (msg !== lastRenderErr) {
          lastRenderErr = msg
          try { console.error('[chubby-whale] 渲染异常已被就地拦下：', e) } catch (e2) { }
        }
        return h('div', {
          key: 'chubby-render-error-' + retryTick,
          style: recoverDotStyle,
          title: '本鲸打了个喷嚏，点一下再试（还不行就刷新页面）',
          onClick: (ev: any) => {
            evStop(ev); evPrevent(ev)
            try { setRetryTick((n: number) => n + 1) } catch (e2) { }
          },
        }, '⚠')
      }
    }

    function WhaleBody() {
      const stageRef = R.useRef(null)
      const canvasRef = R.useRef(null)
      const posRef = R.useRef({ x: 0, y: 0 })
      const talkRef = R.useRef({ talkUntil: 0, hearts: [] as any[] })
      const voiceModeRef = R.useRef(false)
      // 持久化开关：朗读 / 语音待命 / 语音聊天（默认都开；ref 给回调同步读，state 驱动菜单）
      const voiceOnState = hookApi.usePersistentBool('chubby-voice')
      const voiceOnRef = voiceOnState.ref
      const voiceOn = voiceOnState.value
      const setVoiceOn = voiceOnState.set
      // 语音待命 / 语音聊天：真开关（默认都开，持久化在 chubby-ear / chubby-voicechat）
      const earOnState = hookApi.usePersistentBool('chubby-ear')
      const earOnRef = earOnState.ref
      const earOn = earOnState.value
      const setEarOn = earOnState.set
      // 2026-11-09 主人要求「默认语音聊天开」：换到新键 chubby-voicechat2，
      // 旧键里存过的 off 不再继承（老用户升级后也是开）；之后手动关仍会记住。
      const voiceChatOnState = hookApi.usePersistentBool('chubby-voicechat2')
      const voiceChatOnRef = voiceChatOnState.ref
      const voiceChatOn = voiceChatOnState.value
      const setVoiceChatOn = voiceChatOnState.set
      const [balanceLabel, setBalanceLabel] = R.useState('--')
      // 聊天缓存开关（服务端持久化；这里只用于菜单显示与即时切换）
      const chatCacheOnRef = R.useRef(true)
      const [chatCacheOn, setChatCacheOn] = R.useState(true)
      R.useEffect(() => {
        getJson('/cache-toggle').then((d: any) => {
          if (d && typeof d.enabled === 'boolean') { chatCacheOnRef.current = d.enabled; setChatCacheOn(d.enabled) }
        }).catch(() => { })
      }, [])
      const [growthLabel, setGrowthLabel] = R.useState('--')
      // 成长外观（L5）：exp 决定体型/光点/光晕/甩尾节奏；拉不到 /growth 时保持初识档
      const [growth, setGrowth] = R.useState(DEFAULT_GROWTH)
      const lookRef = R.useRef(lookFor(0))
      // 菜单数值的最近一次拉取时刻（10 秒节流；ref 跨渲染保留，普通变量每次渲染都会被重置）
      const menuStatsAtRef = R.useRef(0)
      // 唤醒词表在 client/wake.ts（WAKE_WORDS），由 voice-bridge 的唤醒门真正使用；
      // 2026-11-06 起唤醒词不再是拦话门槛（主人定的是"随时可以说"），门只负责
      // 「只喊名字时应一声」和「把句首/句中的词剥掉再送模型」。
      // 原来这里定义了一份却从没被读过，属于"接线缺口"，已移除。
      const dragRef = R.useRef(createDragState())
      const scaleRef = R.useRef(1)
      // 惯性动画帧句柄：卸载时取消，避免组件销毁后还在写位置
      const inertiaRafRef = R.useRef(0)
      // 挤压层：单独包住 canvas，避免和成长缩放（canvas.style.transform）互相覆盖
      const squashRef = R.useRef(null)
      const phaseRef = R.useRef(null as any)
      if (!phaseRef.current) phaseRef.current = createPhaseMachine()
      const animRef = R.useRef(null as any)
      /** 动画口型：动画器还没建好时静默（宿主回调里多处共用这一份，别各写一遍 try/catch） */
      const talkFor = (ms: number): void => { try { animRef.current?.talkFor(ms) } catch (e) { } }
      /** 挤压形变：把 scale 写在包裹层上，不动 canvas 自己的成长缩放 */
      function applySquash(sx: number, sy: number): void {
        try {
          const el: any = squashRef.current
          if (!el || !el.style) return
          el.style.transform = (sx === 1 && sy === 1) ? '' : 'scale(' + sx + ',' + sy + ')'
        } catch (e) { }
      }
      /** 工作状态：进状态机 + 交给动画器画头顶小图标 */
      function setPhase(p: string): void {
        try {
          const m: any = phaseRef.current
          if (!m) return
          m.enter(p, Date.now())
          animRef.current?.setPhase(m.current())
        } catch (e) { }
      }
      const storyBusyRef = R.useRef(false)
      // 最近一次说书的书名（「从头讲这本书」要按它重置进度）
      const storyBookRef = R.useRef('')
      // 叙述锁持有者句柄（定义在组件外，见 makeNarrateHandle）：说书 / 菜单动作 / 点播路由各一个。
      // 用惰性 ref 保持跨渲染稳定——同一使用方的 narrate 与 onDone 里的 clearNarrate 必须同 id，
      // 否则重渲染后自己的收尾会被判成"别人的锁"而不解。
      const storyNarration = hookApi.useLazyRef(() => makeNarrateHandle('story', () => !!storyBusyRef.current))
      const actionNarration = hookApi.useLazyRef(() => makeNarrateHandle('actions', () => narration.active()))
      const routeNarration = hookApi.useLazyRef(() => makeNarrateHandle('route', () => narration.active()))
    // 点播讲故事：自动连播到"这一回讲完"。默认开（主人要求），菜单里可关；
    // 关掉的状态记在 localStorage，刷新后保持。
    const storyAutoRef = R.useRef((() => {
      try { const s = localStorage.getItem('chubby-story-auto'); return s === null ? true : s !== '0' } catch (e) { return true }
    })())
      // 到点提醒：轮询 + 播报队列在 client/reminders.ts；惰性 ref 保证跨渲染只建一个实例
      const reminderPollerRef = hookApi.useLazyRef(() => createReminderPoller({
        getJson: (path, init) => getJson(path, init),
        bubble: showBubble,
        talkFor,
        speak: (text) => { try { speakText(text) } catch (e) { } },
        isSpeaking: () => ttsPlaying,
        isNarrating: () => storyNarratingRef.current,
        isBusy: () => busyLock.isBusy(),
      }))

      const [scale, setScale] = R.useState(1)
      const [hidden, setHidden] = R.useState(false)
      // hidden 的同步镜像：拖放捕获的 effect 只挂一次，命中判定必须能读到最新值
      const hiddenRef = R.useRef(false)
      hiddenRef.current = hidden
      // 语音回合不清输入框：语音识别结果进来时，主人可能正在聊天框里打字
      const skipInputClearRef = R.useRef(false)
      // 聊天面板根节点（判断粘贴事件是不是发生在面板内）
      const chatRootRef = R.useRef(null)
      const [menu, setMenu] = R.useState(null as any)
      const [subOpen, setSubOpen] = R.useState('')
      // 菜单键盘高亮（-1 = 没有高亮）；ref 给 window keydown 读最新值，state 驱动高亮样式
      const [menuFocus, setMenuFocus] = R.useState(-1)
      const menuFocusRef = R.useRef(-1)
      menuFocusRef.current = menuFocus
      // 当前可见菜单项（渲染时同步算好；keydown 只认这一份，口径与屏幕逐项对齐）
      const menuEntriesRef = R.useRef([] as any[])
      // 说书书单（菜单「选本书 ▸」用）：tried 区分「还没拉」与「拉过但为空/失败」
      const [storyBooks, setStoryBooks] = R.useState([] as string[])
      const [storyBooksTried, setStoryBooksTried] = R.useState(false)
      const [balanceText, setBalanceText] = R.useState('')
      const [lang, setLang] = R.useState((() => { try { return localStorage.getItem('chubby-lang') || 'zh' } catch { return 'zh' } })())
      const [chatOpen, setChatOpen] = R.useState(false)
      // 粘贴监听的 effect 只挂一次，需要同步读最新开关（聊天面板关着时不接粘贴）
      const chatOpenRef = R.useRef(false)
      chatOpenRef.current = chatOpen
      const [messages, setMessages] = R.useState([] as any[])
      const [input, setInput] = R.useState('')
      const [busy, setBusy] = R.useState(false)
      // 忙碌锁：权威状态在 client/busy.ts（React 的 busy 只负责按钮文案）
      const busyLockRef = hookApi.useLazyRef(createBusyLock)
      const busyLock = busyLockRef.current
      const bodyRef = R.useRef(null)
      // 聊天输入框与面板根节点：面板打开时自动聚焦输入框（有入场动画则等 animationend）
      const inputRef = R.useRef(null)
      const chatPanelRef = R.useRef(null)
      const bubbleRef = R.useRef(null)
      const bubbleTextRef = R.useRef(null)

      // 语音桥：回调只在 voice-bridge 里建一份（待命 effect 与菜单「唤醒」共用）。
      // 必须放在所有 effect 之前：卸载 effect 会调 stopTts() → bridge.stopSpeak()。
      const bridgeRef = hookApi.useLazyRef(() => createVoiceBridge({
        narration,
        narrating: () => storyNarratingRef.current,
        stopSpeaking: () => stopTts(),
        bubble: showBubble,
        // 喊名字的应答要"出声"，不能只弹字：桥里拿不到 say 时会退化成纯气泡
        say: (text: string, ms?: number, opts?: any) => sayLine(text, ms, opts),
        sendText: (text: string, opts?: { voice?: boolean }) => sendText(text, opts),
        onVoiceHeard: () => { try { voiceModeRef.current = true } catch (e) { } },
        onSpeaking: (playing: boolean) => {
          ttsPlaying = playing
        },
        // 语音聊天关着时"只听不接话"（在唤醒词剥除之前就拦下，不必先考虑喊没喊名字）
        voiceChat: () => voiceChatOnRef.current,
        // 正在朗读时，语音"停"要能直接打断（打断词不受唤醒词与语音聊天开关影响）
        speaking: () => ttsPlaying,
        diag: dg,
      }))
      const bridge = bridgeRef.current

      // 样式注入（气泡三角；样式常量在 client/bubble.ts）
      R.useEffect(() => {
        try { ensureBubbleStyle(document) } catch { }
      }, [])

      // 位置
      R.useEffect(() => {
        let saved: any = null
        try {
          const raw = localStorage.getItem('chubby-whale-pos')
          if (raw) saved = JSON.parse(raw)
        } catch { }
        const init = saved && typeof saved.x === 'number' ? saved : calcHomePos(W, H, window.innerWidth, window.innerHeight)
        posRef.current = init
        applyPos(init.x, init.y)
      }, [])

      function applyPos(x: number, y: number): void {
        const el = stageRef.current
        if (!el) return
        // 缩放后实际占位是 W*scale / H*scale：窗口缩小时也要把整只鱼留在可视区里。
        // 再乘成长外观最大缩放 1.08（look.scale 上限），否则升级到「家人」档时鱼身会溢出边缘约 19px
        const s = (scaleRef.current || 1) * 1.08
        const p = clampPos(x, y, W * s, H * s, window.innerWidth, window.innerHeight)
        x = p.x
        y = p.y
        // 视觉缩放用真实 scale（不是钳制用的 1.08 余量）：transform 必须与 stageStyle 同源，
        // 否则拖动时只写 translate3d 会把 scale 覆盖掉——「先缩放再拖」缩放就丢了
        const vs = scaleRef.current || 1
        const d = dragRef.current
        if (d && d.dragging) {
          // 拖动中走 transform：合成层位移，不触发布局与整树重绘
          const bx = typeof d.baseX === 'number' ? d.baseX : x
          const by = typeof d.baseY === 'number' ? d.baseY : y
          el.style.transform = stageTransform(vs, x - bx, y - by)
        } else {
          el.style.left = x + 'px'
          el.style.top = y + 'px'
          el.style.transform = stageTransform(vs)
        }
        posRef.current = { x, y }
      }
      function savePos(): void {
        try { localStorage.setItem('chubby-whale-pos', JSON.stringify(posRef.current)) } catch { }
      }
      function homePos(): void {
        const p = calcHomePos(W, H, window.innerWidth, window.innerHeight)
        applyPos(p.x, p.y)
        savePos()
      }

      // 窗口尺寸变化：按当前缩放重新钳制位置，别让鱼停在可视区外；
      // 拖窗口时 resize 会连续触发，savePos 走 200ms 节流（位置本身仍逐次钳制）
      R.useEffect(() => {
        let saveTimer: any = null
        const off = bindResize(window, () => {
          applyPos(posRef.current.x, posRef.current.y)
          if (saveTimer) return
          saveTimer = setTimeout(() => { saveTimer = null; savePos() }, 200)
        })
        // bindResize 只摘监听；200ms 的存盘定时器也要在卸载时撤掉，
        // 否则组件销毁后还会再写一次 localStorage（危害低，但属该清的没清）。
        return () => {
          try { off() } catch (e) { }
          try { if (saveTimer) clearTimeout(saveTimer) } catch (e) { }
          saveTimer = null
        }
      }, [])

      // 工作状态：一次性（成功/出错）到点自动回 waiting
      R.useEffect(() => {
        const t = setInterval(() => {
          try {
            const m: any = phaseRef.current
            if (!m) return
            animRef.current?.setPhase(m.tick(Date.now()))
          } catch (e) { }
        }, 250)
        return () => { try { clearInterval(t) } catch (e) { } }
      }, [])
      // 卸载：取消惯性动画帧（否则组件销毁后最多还会写位置 ~0.7 秒）
      R.useEffect(() => () => { try { if (inertiaRafRef.current) cancelAnimationFrame(inertiaRafRef.current) } catch (e) { } try { applySquash(1, 1) } catch (e) { } }, [])

      // 卸载收尾：提醒链 / 朗读音频 / 琴声 AudioContext / 气泡定时器都别留着
      // （SpeechRecognition 当前没用到；VAD 的 MediaRecorder 由下面语音待命的 effect 自己 stopEar）
      R.useEffect(() => {
        return createUnmountCleanup({
          reminderPoller: () => reminderPollerRef.current,
          stopTts: () => stopTts(),
          stopMelody: () => melody.stop(),
          clearBubble: () => clearBubbleTimer(bubbleRef.current),
        })
      }, [])

      // 气泡：定位、显示、自动收起、纯状态字判定都在 client/bubble.ts
      const bubble = createBubble({
        el: () => bubbleRef.current,
        textEl: () => bubbleTextRef.current,
        pos: () => posRef.current,
        xOffset: W / 2,
        onHide: () => { try { restoreIdleStatus() } catch (e) { } },
      })
      function showBubble(text: string, ms = 2400): void { bubble.show(text, ms) }
      // 首次安装兜底：没配 Key 时给一句人话（离线功能照常可用），别让主人对着麦克风干等。
      // 每次页面加载最多提示一次；只读 /status，不发模型请求。
      R.useEffect(() => {
        getJson('/status').then((d: any) => {
          if (d && d.ok && d.key === false) {
            showBubble('还没配 Key：聊天和语音要用 Key（deepseekKey / siliconflowKey），念诗、说书、典故、提醒照样能用～ 配置方法见 README', 9000)
          }
        }).catch(() => { })
      }, [])
      // ===== 状态提示（已按主人要求去掉）=====
      // 原来闲时一直挂「在听…」，还出现过"讲着话却显示在听"的矛盾。
      // 现在不主动显示任何状态字：只听/只在真正有内容时冒气泡（听到、回复、念完…）。
      function restoreIdleStatus(): void { }

      // 提醒管理面板：清单 + 「下一条输入」（数字=删 / d=顺延）共用同一个实例；
      // 聊天框与语音最终都走 sendText，所以拦截只接一处（逻辑在 client/reminder-manage.ts）。
      // 必须只建一次：实例内部记着「面板打开时刻 + 当前清单序号」，在渲染里重建的话，
      // 任何一次 setState（打开面板本身就会 setMenu）都会把 60 秒有效窗和序号一起清零。
      const reminderManagerRef = hookApi.useLazyRef(() => createReminderManager({ bubble: showBubble }))
      const reminderManager = reminderManagerRef.current
      // 「让它游走」可逆：隐藏时右下角留「○」恢复点，Ctrl+Shift+W 也走同一条恢复路径（不刷新页面）
      const recover = createRecover({ recover: () => setHidden(false) })
      /** 焦点在输入框/可编辑区域时，全局快捷键让路（不能把主人正在输入的按键抢走） */
      function isTypingTarget(t: any): boolean {
        try {
          if (!t) return false
          const tag = String(t.tagName || '').toUpperCase()
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
          return !!t.isContentEditable
        } catch (e) { return false }
      }
      // 全局快捷键：捕获阶段登记，避免被宿主页面的 keydown 先吃掉。
      // recover.bindHotkey 只认 addEventListener/removeEventListener 两个方法，
      // 这里传一层代理：输入框聚焦时把 keydown 原样放行（否则聊天框里按 Ctrl+Shift+W 会被抢键）。
      R.useEffect(() => {
        const wrapped = new Map<any, any>()
        const target = {
          addEventListener(type: string, fn: any, capture?: any): void {
            if (type !== 'keydown' || typeof fn !== 'function') {
              try { window.addEventListener(type, fn, capture) } catch (e) { }
              return
            }
            const guard = (e: any): void => { if (isTypingTarget(e && e.target)) return; fn(e) }
            wrapped.set(fn, guard)
            try { window.addEventListener(type, guard, capture) } catch (e) { }
          },
          removeEventListener(type: string, fn: any, capture?: any): void {
            const guard = wrapped.get(fn)
            if (guard) {
              wrapped.delete(fn)
              try { window.removeEventListener(type, guard, capture) } catch (e) { }
              return
            }
            try { window.removeEventListener(type, fn, capture) } catch (e) { }
          },
        }
        const unbind = recover.bindHotkey(target)
        return () => { try { unbind() } catch (e) { } }
      }, [])

      // ===== 拖放：必须在【捕获阶段】抢在 HARNESS 自己的拖放处理之前 =====
      // React 的 onDrop 走冒泡阶段，宿主的 drop 处理器会先接走文件，鱼永远收不到。
      // 这里用 window 捕获监听 + 命中判定：落点在鱼身上才归鱼，其它位置仍交给宿主。
      R.useEffect(() => {
        return bindFileDropCapture({
          win: window,
          hitTest: (x: number, y: number): boolean => {
            try {
              // 游走隐藏时 display:none 的包围盒是全 0，若不拦，屏幕左上角十几像素内的
              // 文件会被"看不见的鱼"吃掉。隐藏时一律不认。
              if (hiddenRef.current) return false
              const el = stageRef.current
              if (!el) return false
              const r = el.getBoundingClientRect()
              const pad = 12   // 手抖一点也算命中
              return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad
            } catch (e) { return false }
          },
          onFile: (file: any): void => {
            try { handleFileDrop(file, { showBubble, speakText }).catch(() => { }) } catch (e2) { }
          },
          onMany: (n: number): void => {
            // 说清「只收第一张」，否则其余文件静默消失，主人会以为都发过去了
            try { showBubble('一次先看一张哦～先看第一张（共 ' + n + ' 个）', 3200) } catch (e2) { }
          },
        })
      }, [])

      // ===== 粘贴图片：与拖入文件走同一条链路（压缩 / 4MB 上限 / 失败气泡都在 dropzone）=====
      // 只在聊天面板内粘贴时接管（target 不在面板里就原样放行，不抢宿主页面自己的粘贴）；
      // 只认剪贴板里的图片文件，粘贴文字仍由输入框自己处理。
      // 拖入（drop）与粘贴（paste）是两类事件，不会对同一个文件重复处理。
      R.useEffect(() => {
        const onPaste = (e: any): void => {
          try {
            if (!chatOpenRef.current) return
            const root = chatRootRef.current
            const t = e && e.target
            if (!root || !t || typeof root.contains !== 'function' || !root.contains(t)) return
            const dt = e.clipboardData
            let file: any = null
            const items = dt && dt.items
            if (items && typeof items.length === 'number') {
              for (let i = 0; i < items.length; i++) {
                const it = items[i]
                if (!it || it.kind !== 'file' || !/^image\//.test(String(it.type || ''))) continue
                const f = typeof it.getAsFile === 'function' ? it.getAsFile() : null
                if (f) { file = f; break }
              }
            }
            if (!file && dt && dt.files && dt.files.length) {
              const f = dt.files[0]
              if (f && /^image\//.test(String(f.type || ''))) file = f
            }
            if (!file) return
            evPrevent(e); evStop(e)
            handleFileDrop(file, { showBubble, speakText }).catch(() => {
              try { showBubble('图片没处理成，再贴一次试试', 4000) } catch (e2) { }
            })
          } catch (e2) { }
        }
        try { window.addEventListener('paste', onPaste, true) } catch (e) { }
        return () => { try { window.removeEventListener('paste', onPaste, true) } catch (e) { } }
      }, [])

      // 拖动
      function dragBeginAt(x: number, y: number): void {
        // 抓住飞行中的鱼：立刻停掉抛物线/挤压，回到普通拖拽
        try { if (inertiaRafRef.current) cancelAnimationFrame(inertiaRafRef.current) } catch (e) { }
        inertiaRafRef.current = 0
        applySquash(1, 1)
        beginDrag(dragRef.current, x, y, posRef.current.x, posRef.current.y)
        try {
          const el = stageRef.current
          // 拖动期间关掉投影滤镜：大滤镜每帧重算是拖拽卡死/闪退的主因之一
          if (el && el.style) { el.style.filter = 'none'; el.style.willChange = 'transform' }
        } catch (e2) { }
      }
      function dragMoveTo(x: number, y: number): void {
        const d = dragRef.current
        if (!d.dragging) return
        const m = moveDrag(d, x, y)
        applyPos(posRef.current.x + m.x, posRef.current.y + m.y)
        // Q 弹：拖起来时轻轻拉长，松手恢复
        try { applySquash(1.05, 0.95) } catch (e2) { }
      }
      function dragFinish(): void {
        const d = dragRef.current
        if (!d.dragging) return
        // 几乎没移动 = 点击：摸头互动（爱心 + 害羞台词）
        if (d.moved <= 8) {
          try { animRef.current?.pushHeart() } catch (e3) { }
          try { showBubble('唔…主人轻一点啦～', 2200) } catch (e3) { }
        }
        const v = endDrag(d)
        // 恢复滤镜，并把 transform 位移提交成 left/top（否则鱼停在原位）
        try { const el = stageRef.current; if (el && el.style) { el.style.filter = ""; el.style.willChange = "" } } catch (e2) { }
        applyPos(posRef.current.x, posRef.current.y)
        try { applySquash(1, 1) } catch (e3) { }
        savePos()
        const l = launch(v.x, v.y)
        // 轻放（几乎没速度）不甩：直接停在落点
        if (!l.moving) return
        const f = createFlight()
        f.resting = false
        f.vx = l.vx
        f.vy = l.vy
        f.squashAge = SQUASH_MS
        const bounds = () => {
          const s = (scaleRef.current || 1) * 1.08
          return { minX: 0, minY: 0, maxX: Math.max(0, window.innerWidth - W * s), maxY: Math.max(0, window.innerHeight - H * s) }
        }
        let lastTs = 0
        const step = (ts: number) => {
          if (dragRef.current.dragging) return
          const dtMs = lastTs ? Math.min(100, ts - lastTs) : 16.67
          lastTs = ts
          const r = stepFlight(f, posRef.current, bounds(), dtMs / 16.67, dtMs)
          applyPos(r.pos.x, r.pos.y)
          // 落地（bottom 反弹）时甩一圈水花
          if (r.bounce === 'bottom') { try { animRef.current?.wakeSplash?.() } catch (e3) { } }
          const q = squashScale(f.squashAge)
          applySquash(q.sx, q.sy)
          if (f.resting) {
            applySquash(1, 1)
            savePos()
            inertiaRafRef.current = 0
            return
          }
          inertiaRafRef.current = requestAnimationFrame(step)
        }
        inertiaRafRef.current = requestAnimationFrame(step)
      }
      function onPointerDown(e: any): void {
        // 触摸事件的 button 是 0；右键是 2。没有 button 字段的合成事件按左键处理
        if (typeof e.button === 'number' && e.button !== 0) return
        dragBeginAt(e.clientX, e.clientY)
        try { e.currentTarget.setPointerCapture(e.pointerId) } catch { }
      }
      // 注意：原来这里会写 e.__chubbyDragHandled 想给 stage 的 window 兜底去重，但 React 把标记写在
      // SyntheticEvent 上、stage 读的是原生事件（e.nativeEvent），标记永远对不上 —— 那是死代码，
      // 且会让人误以为「重复驱动已被去重」。去重改由 stage.bindDragInput 按「指针是否已在鱼身内」分流
      // （2026-11-07 B96），这里不再写任何标记。
      function onPointerMove(e: any): void {
        dragMoveTo(e.clientX, e.clientY)
      }
      function onPointerUp(): void {
        dragFinish()
      }

      // ===== 拖拽输入兼容（差异与兜底全在 client/stage.ts 的 bindDragInput 里）=====
      // ① 没有 PointerEvent（Safari 13 之前）→ 改挂 touch + mouse，否则鱼拖不动；
      // ② iOS Safari 的 capture 可能失效、指针会滑出元素 → window 上补 move/up 兜底；
      // ③ touchmove 用 passive:false 才能 preventDefault，免得拖动时页面跟着滚。
      R.useEffect(() => {
        const el: any = stageRef.current
        const win: any = typeof window !== 'undefined' ? window : null
        if (!el || !win) return
        const binding = bindDragInput(el, win, {
          onDown: (x, y) => dragBeginAt(x, y),
          onMove: (x, y) => { if (dragRef.current.dragging) dragMoveTo(x, y) },
          onEnd: () => { if (dragRef.current.dragging) dragFinish() },
        })
        dg({ dragInput: binding.mode })
        return () => { try { binding.dispose() } catch (e) { } }
      }, [])

      // 余额/成长只在「菜单打开」时拉（见 refreshMenuStats），开机不预请求
      R.useEffect(() => {
        // 饭团：进门先打个招呼（按当前时段挑台词），3 秒后出现，不抢首屏
        const stopGreet = startGreeting({
          greet: () => {
    try {
      if (greetedOnce) return
      greetedOnce = true
      const g = persona.greeting()
      if (g) sayLine(g, 5000)
      // 今日一句：开场问候之后补一句当天的诗（/daily 失败静默；chubby-daily-greet=off 可关）
      try {
        const off = (() => { try { return typeof localStorage !== 'undefined' && localStorage.getItem('chubby-daily-greet') === 'off' } catch (e) { return false } })()
        if (!off) {
          getJson('/daily', { cache: 'no-store' }).then((d: any) => {
            try {
              if (d && d.ok && d.text) sayLine('今天这句——' + String(d.text) + (d.source ? '（' + String(d.source) + '）' : ''), 9000)
            } catch (e) { }
          }).catch(() => { })
        }
      } catch (e) { }
    } catch (e) { }
  },
          hungry: () => { try { sayLine(persona.line('hungry'), 4000) } catch (e) { } },
          // 打了招呼再看是不是饿了：饿着就补一句（对应人设的 hungry 场景）
          hungryNow: (() => { try { const st: any = (persona as any).state; return !!(st && st.lastFeedAt && Date.now() - st.lastFeedAt > 6 * 3600 * 1000) } catch (e) { return false } })(),
        })
        dg({ persona, sayLine })
        // 状态行 2 秒周期刷新：常驻气泡只会在被调用时更新，靠事件驱动容易漏（就曾卡在「识别中…」）
        const stopWatch = startWatchdog(() => {
          // 占线自愈：一次请求异常不能让后续提问永远被「还在想上一句」挡住
          try {
            // 叙述锁自愈：过了时限还锁着就强制解除（防止"鱼听不到"）
            try {
              if (narration.expire()) {
                // 过期强制解锁同样走权威路径：清持有者与探针，别让旧 timer 之后再"报警"
                resetNarration()
                bump('narrReset')
              }
            } catch (e3) { }
            if (busyLock.watchdog()) {
              setBusy(false)
              bump('busyReset')
            }
          } catch (e) { }
        })
        const tF: any = 0 // 原 filler 预热已无实现，保留变量供 cleanup 兼容
        return () => {
          stopGreet()
          try { clearTimeout(tF) } catch (e) { }
          stopWatch()
          try { const el = bubbleRef.current; if (el) el.classList.remove('show') } catch (e) { }
        }
      }, [])
      // 右键菜单
      function onContextMenu(e: any): void {
        e.preventDefault()
        // 先出菜单（余额/成长用旧值或占位），数值异步回来再更新，绝不阻塞菜单显示
        setMenu({ x: e.clientX, y: e.clientY })
        setSubOpen('')
        // 每次打开菜单都从「没有高亮」开始：第一次按方向键再落到首/末项
        setMenuFocus(-1)
        // 只在「菜单打开」这个时机拉一次；10 秒节流，连点右键不会狂打接口
        refreshMenuStats()
        // 书单不进节流：本地接口、数据量小，每次打开菜单都拉一遍，书单换了立刻能看到
        refreshStoryBooks()
      }

      /**
       * 「选本书 ▸」的数据源：成功写入书名数组；失败/空列表按「取到过但为空」处理，
       * 菜单里显示「书单没取到，稍后再试」，点那一项会重试（story-books 动作）。
       */
      function refreshStoryBooks(): void {
        getJson('/story/books', { cache: 'no-store' })
          .then((d: any) => { setStoryBooks(parseBookList(d)); setStoryBooksTried(true) })
          .catch(() => { setStoryBooks([]); setStoryBooksTried(true) })
      }

      // 菜单数值的最近一次拉取时刻记在 menuStatsAtRef（见组件顶部 hooks 区）

      /**
       * 菜单打开时的余额/成长刷新：
       *   · 节流 10 秒（force=true 用于标题栏点击这种显式刷新）
       *   · 失败/未配置 Key 一律落到「--」占位，不弹错误
       */
      function refreshMenuStats(force?: boolean): void {
        const now = Date.now()
        if (!force && now - menuStatsAtRef.current < 10000) return
        menuStatsAtRef.current = now
        refreshBalance()
        getJson('/growth', { cache: 'no-store' })
          .then((d: any) => { applyGrowthPayload(d) })
          .catch(() => { setGrowthLabel('--'); setGrowth(DEFAULT_GROWTH) })
      }

      /**
       * 把 /growth 响应同时写进菜单标签与外观：
       *   · 正常数据 → 标签「阶段（exp/nextExp）」+ 按档位更新体型/光点/光晕/甩尾；
       *   · 坏数据/失败 → 标签「--」，外观回落初识（不弹错误）。
       */
      function applyGrowthPayload(d: any): void {
        const info = parseGrowth(d)
        if (!info) {
          setGrowthLabel('--')
          setGrowth(DEFAULT_GROWTH)
          return
        }
        applyGrowthInfo(info)
      }

      /** 成长标签 + 外观一起更新（菜单标题与外观刷新共用一份格式，避免两处各拼一遍） */
      function applyGrowthInfo(info: any): void {
        setGrowthLabel(info.stage + '（' + info.exp + (info.nextExp ? '/' + info.nextExp : '') + '）')
        setGrowth(info)
      }

      /** 重新拉一次 /growth 并刷新外观（喂食后调用）；失败静默回落初识 */
      function syncGrowth(): void {
        fetchGrowth((p, init) => getJson(p, init)).then((info) => {
          if (info) applyGrowthInfo(info)
          else setGrowth(DEFAULT_GROWTH)
        })
      }

      /** 拉实时余额，并把菜单标题与「余额：…」一起更新；失败/未配置 Key 显示 --，不弹错误 */
      function refreshBalance(): void {
        getJson('/balance', { cache: 'no-store' })
          .then((d: any) => {
            if (d && d.ok && d.balance != null) {
              const v = String(d.balance)
              setBalanceText('余额 ¥' + v)
              setBalanceLabel('¥' + v)
            } else {
              setBalanceText('--')
              setBalanceLabel('--')
            }
          })
          .catch(() => {
            setBalanceText('--')
            setBalanceLabel('--')
          })
      }

      // 点菜单外面就关掉（菜单根节点带 data-menu-root 标记，closest 判断；三路事件在 client/effects.ts）
      R.useEffect(() => {
        if (!menu) return
        return bindOutsideClose({
          doc: document,
          onOutside: () => { setMenu(null); setSubOpen('') },
        })
      }, [menu])

      // 菜单打开时按 Esc 关闭：原来只有「点外面 / 点菜单项」两条路，键盘没法收菜单。
      // 只在菜单存在期间挂监听，卸载/关闭由 cleanup 撤掉；捕获阶段先于宿主处理。
      R.useEffect(() => {
        if (!menu) return
        const onKeyDown = (e: any): void => {
          if (!e || (e.key !== 'Escape' && e.key !== 'Esc')) return
          evStop(e); evPrevent(e)
          setMenu(null)
          setSubOpen('')
        }
        try { window.addEventListener('keydown', onKeyDown, true) } catch (e) { }
        return () => { try { window.removeEventListener('keydown', onKeyDown, true) } catch (e) { } }
      }, [menu])

      // 菜单键盘导航（不抢焦点）：窗口捕获阶段处理方向键 / Enter / Esc，菜单容器本身不 focus。
      // 高亮顺序只认渲染时算好的 listMenuEntries（menuEntriesRef），子菜单展开/收起自动对齐。
      // Esc 与上面已有的 Esc effect 收敛到同一个关闭动作（setMenu(null)+setSubOpen('')）：
      // 两个监听重复触发也只是同一次幂等关闭，不会互相冲突。
      R.useEffect(() => {
        if (!menu) return
        return bindMenuKeys({
          win: window,
          isTyping: (t: any) => isTypingTarget(t),
          count: () => menuEntriesRef.current.length,
          index: () => menuFocusRef.current,
          setIndex: (i: number) => setMenuFocus(i),
          activate: (i: number) => {
            const entry = menuEntriesRef.current[i]
            if (!entry) return false
            if (entry.kind === 'sub') {
              // 子菜单父项：只在当前层展开/收起（收起回到 parentPath，不越级）
              setSubOpen(entry.open ? entry.parentPath : entry.path)
              return true
            }
            void runAction(entry.action)
            return true
          },
          close: () => { setMenu(null); setSubOpen(''); setMenuFocus(-1) },
        })
      }, [menu])


      // ===== 说书（连载）：拉段、气泡、朗读、自动连播全在 client/story.ts =====
      const story = createStoryController({
        clientId: CLIENT_ID,
        persona,
        // 叙述锁走持有者句柄：说书自己的 clearNarrate 只解自己上的锁，
        // 念诗那段的 onDone 晚到也不会把这一段的锁/叙述标记清掉。
        narrate: storyNarration.current.narrate,
        clearNarrate: storyNarration.current.clearNarrate,
        bubble: showBubble,
        speak: speakText,
        talkFor: (ms: number) => { try { animRef.current?.talkFor(ms) } catch (e) { } },
        narrationRate: narrationRate,
        isVoiceOff: () => { try { return localStorage.getItem('chubby-voice') === 'off' } catch (e) { return false } },
        refs: { busy: storyBusyRef, narrating: storyNarratingRef, auto: storyAutoRef, book: storyBookRef },
      })

      // ===== 到点提醒：轮询 + 队列播报在 client/reminders.ts，实例在组件顶部已注入宿主能力 =====
      const reminderPoller = reminderPollerRef.current

      // 菜单动作：动作表 + 处理器注册（client/actions/*.ts），客户端只留组装与分发
      const actionHost: ActionHost = {
        bubble: showBubble,
        say: sayLine,
        speak: speakText,
        speakReply: (text) => speakReply(text),
        // 叙述锁持有者句柄（菜单动作：念诗 / 今日一句 / 简报等共用这一个使用方）
        narrate: actionNarration.current.narrate,
        clearNarrate: actionNarration.current.clearNarrate,
        stopSpeak: () => stopTts(),
        stopMelody: () => melody.stop(),
        playMelody: (notes, bpm, onDone) => melody.play(notes, bpm, onDone),
        talkFor,
        heart: () => { try { animRef.current?.pushHeart() } catch (e) { } },
        persona,
        clientId: CLIENT_ID,
        narrationRate: narrationRate,
        version: VERSION,
        story,
        storyState: { busy: storyBusyRef, narrating: storyNarratingRef, auto: storyAutoRef, book: storyBookRef },
        homePos: () => homePos(),
        // 缩放：0.7–1.4，step 0.1；state 与 scaleRef 一起改（气泡定位读 scaleRef）
        nudgeScale: (delta) => {
          const s = Math.max(0.7, Math.min(1.4, (scaleRef.current || 1) + delta))
          scaleRef.current = s
          setScale(s)
        },
        hide: () => setHidden(true),
        // 游走可逆 + 提醒管理：都只在这里接线，处理器在 client/actions/system.ts
        isHidden: () => hidden,
        recover: () => { try { setHidden(false) } catch (e) { } },
        openReminders: () => { try { reminderManager.open() } catch (e) { } },
        setChatOpen: (v) => setChatOpen(v),
        setVoiceMode: (v) => { voiceModeRef.current = v },
        setMessages: (v) => setMessages(v),
        setBalance: (text, label) => { setBalanceText(text); setBalanceLabel(label) },
        refreshBalance: () => refreshBalance(),
        setGrowthLabel: (v) => setGrowthLabel(v),
        // 菜单「成长」拿到的响应直接复用；喂食后重新拉一次（外观随之实时更新）
        applyGrowth: (d) => applyGrowthPayload(d),
        syncGrowth: () => syncGrowth(),
        setLang: (l) => setLang(l),
        voice: () => bridge.get(),
        // 换音色：存 localStorage + 立即改实例音色（下一个 /tts 就带新 voice）
        setTtsVoice: (name) => {
          try { localStorage.setItem('chubby-tts-voice', name) } catch (e) { }
          try { bridge.setVoiceName(name) } catch (e) { }
        },
        // 试听：走宿主 /tts（strict），失败静默
        previewVoice: (text) => { try { bridge.preview(text) } catch (e) { } },
        wakeInfo: () => { try { return bridge.wakeInfo() } catch (e) { return null } },
        voicePlaying: () => ttsPlaying,
        earStandby: () => earOnRef.current,
        setEarStandby: (v) => { earOnRef.current = v; setEarOn(v) },
        voiceChat: () => voiceChatOnRef.current,
        setVoiceChat: (v) => { voiceChatOnRef.current = v; setVoiceChatOn(v) },
        voiceOn: () => voiceOnRef.current,
        setVoiceOn: (v) => { voiceOnRef.current = v; setVoiceOn(v) },
        // 语音待命总开关：关=停录音（实例留着复用）；开=建/启语音模块（回调在 voice-bridge）
        toggleStandby: () => {
          const nowOn = !earOnRef.current
          try { localStorage.setItem('chubby-ear', nowOn ? 'on' : 'off') } catch (e) { }
          earOnRef.current = nowOn
          setEarOn(nowOn)
          if (!nowOn) {
            try { bridge.stop() } catch (e) { }
            try { stopTts() } catch (e) { }
            showBubble('语音待命：关（本鲸不听啦）', 2500)
            return
          }
          try {
            bridge.start().then((v: any) => {
              try {
                if (v.status() === 'idle') showBubble('麦克风没打开：' + String((v.stats && v.stats.lastError) || '看看权限？'), 5000)
                // 语音待命开着就能直接说话：唤醒词只用来剥句子开头/叫名字应一声，
                // 不是拦话门槛（2026-11-06 主人定的"随时可以说"），别再说成"先喊才答话"。
                else showBubble('语音待命：开（随时可以说，喊不喊名字都行）', 3500)
              } catch (e) { }
            }).catch((e: any) => showBubble('麦克风没打开：' + String((e && e.message) || e), 5000))
          } catch (e: any) {
            showBubble('语音待命没开成：' + String((e && e.message) || e), 5000)
          }
        },
        chatCacheOn: () => chatCacheOnRef.current,
        setChatCacheOn: (v) => { chatCacheOnRef.current = v; setChatCacheOn(v) },
        diag: dg,
      }

      // 动作分发：先关菜单，再交给动作表；未注册的动作（或处理器抛错）给一句兜底提示
      async function runAction(action: string): Promise<void> {
        setMenu(null)
        let ok = false
        try { ok = await actions.run(action, actionHost) } catch (e) { ok = false }
        if (!ok) showBubble('这个功能还没接上')
      }

      // 聊天
      function scrollBody(): void {
        setTimeout(() => {
          const el = bodyRef.current
          if (el) el.scrollTop = el.scrollHeight
        }, 0)
      }
      // 聊天列表跟随到底部：面板关着时（display:none）scrollTop 写入会被浏览器忽略，
      // 之后打开面板也不会自动滚，最新回复永远在可视区外。打开面板 / 消息变化都补滚一次。
      R.useEffect(() => {
        if (!chatOpen) return
        scrollBody()
      }, [chatOpen, messages])
      // 聊天面板打开时自动聚焦输入框，关闭时失焦；有入场动画就等 animationend（时机判断在 client/effects.ts）
      R.useEffect(() => {
        return bindChatFocus({
          win: window,
          open: chatOpen,
          input: () => inputRef.current,
          panel: () => chatPanelRef.current,
        })
      }, [chatOpen])
      // ===== 点播本地路由：关键词识别与念诗/讲典故的本地处理在 client/chat-route.ts =====
      const localRouter = createLocalRouter({
        persona,
        narrationRate: narrationRate,
        bubble: showBubble,
        say: sayLine,
        speak: speakText,
        // 点播路由用独立句柄：主人这句"念首诗"与菜单动作互不代解对方的锁
        narrate: routeNarration.current.narrate,
        clearNarrate: routeNarration.current.clearNarrate,
        talkFor,
        story,
        storyState: { busy: storyBusyRef, narrating: storyNarratingRef, auto: storyAutoRef, book: storyBookRef },
        // 点播（念诗/讲故事/讲典故）命中时打断进行中的聊天请求：不再等旧回复，也不会回来抢话
        abortChat: () => { try { chat.abortStream() } catch (e) { } },
      })


      // ===== 流式对话：边生成边开口 =====
      // 传统路径要等整段生成完才合成语音；这里把模型吐出的文字按句切开立刻送朗读，
      // 首字延迟从「整段生成 + 首段合成」降到「首句生成 + 首段合成」。
      // 任何异常都在 4 秒内回退到普通 /chat，不影响可用性。
      // ===== 聊天/流式：发送器在 client/chat.ts，这里只做组装与转发 =====
      // 发送器必须只建一次：实例内部登记着正在跑的请求（activeStream / activeChat），
      // 在渲染函数里重建会让「停止说话」找不到请求、卸载时无法 abort，
      // 语音（经 bridge 的闭包）与菜单还会各停各的实例。
      const chatRef = hookApi.useLazyRef(() => createChatSender({
        persona,
        bubble: showBubble,
        say: sayLine,
        speak: speakText,
        speakReply: (text) => speakReply(text),
        stopSpeak: () => stopTts(),
        talkFor,
        onPhase: (p) => setPhase(p),
        heart: () => { try { animRef.current?.pushHeart() } catch (e) { } },
        // 语音回合不动输入框（主人可能正在打字）；打字/语音的来源由 sendText 填标记，用一次即复位
        setInput: (v) => {
          if (skipInputClearRef.current) { skipInputClearRef.current = false; return }
          setInput(v)
        },
        setMessages: (v) => setMessages(v),
        setBusy: (v) => setBusy(v),
        scrollBody: () => scrollBody(),
        busy: busyLock,
        epoch,
        narrating: storyNarratingRef,
        storyBusy: storyBusyRef,
        voiceMode: voiceModeRef,
        ttsPlaying: () => ttsPlaying,
        narrationRate: narrationRate,
        route: (text) => localRouter.route(text),
        replyDeduper,
        recordChatLatency: (ms) => { try { latDiag.chatMs = ms; latDiag.updates++ } catch (e) { } },
      }))
      const chat = chatRef.current
      // 旧调用点名称保留（拖放 / 语音 / 调试口都调 sendText）
      function sendText(rawText: string, opts?: { voice?: boolean }): Promise<boolean> {
        // 提醒管理面板最近打开 60 秒内：数字=删、d=顺延先接住；
        // 其余输入（正常对话）原样放行，绝不误吞（判断都在 client/reminder-manage.ts）
        try {
          if (reminderManager.intercept(String(rawText == null ? '' : rawText))) {
            // 被提醒面板消费的是操作指令，清掉输入框里的那条，免得下一条误发
            try { setInput('') } catch (e2) { }
            return Promise.resolve(true)
          }
        } catch (e) { }
        // 输入框清空交给 chat.send 在「真的发出去了」之后自己做：
        // 发送被占线挡下时不能清空（原来调用方无条件清空，主人的话会直接丢）。
        // 点播指令（背诗/念诗/讲故事/讲典故/报书名）先走本地路由，不进聊天频道。
        // 2026-11-06 修：B9 重构把 localRouter 的调用点弄丢了，导致「背首诗」被当成聊天发给模型。
        try {
          if (localRouter.route(String(rawText == null ? '' : rawText))) {
            try { setInput('') } catch (e2) { }
            return Promise.resolve(true)
          }
        } catch (e) { }
        try { skipInputClearRef.current = !!(opts && opts.voice) } catch (e) { }
        return chat.send(rawText, opts).then((ok: any) => ok !== false)
      }

      // 启动时把服务端 pet.mood 同步给客户端（服务端只发 normal/happy/hungry；失败静默，不阻塞渲染）
  // SYNC-PET-MOOD
  R.useEffect(() => {
    try { getJson('/pet').then((d: any) => { if (d && d.pet && d.pet.mood) applyServerMood(String(d.pet.mood)) }).catch(() => { }) } catch (e) { }
  }, [])

  // 调试口：控制台输入 __chubbyWhale.say("你好呀") 可直接测「对话 + 朗读」链路（不经过麦克风）
      R.useEffect(() => {
        const w: any = (window as any).__chubbyWhale || ((window as any).__chubbyWhale = {})
        try {
          w.say = (t: string) => { try { sendText(String(t || ""), { voice: true }) } catch (e) { } }
          w.sayStop = () => { try { stopTts() } catch (e) { } }
          w.busyNow = () => ({ busy: busyLock.isBusy(), age: busyLock.age(), tts: ttsPlaying })
          // 外观诊断：控制台 __chubbyWhale.look() 可看当前档位/体型/光点数/光晕
          w.look = () => lookRef.current
        } catch (e) { }
        return () => {
          // 卸载后这些调试口仍指向已销毁组件的闭包（say 会操作已 dispose 的音频、
          // 往旧树 setState）。只撤自己挂的四个键，不动别的模块挂在同一命名空间的字段。
          try {
            if (w.say) delete w.say
            if (w.sayStop) delete w.sayStop
            if (w.busyNow) delete w.busyNow
            if (w.look) delete w.look
          } catch (e) { }
        }
      }, [])
      // 提醒轮询（每 20 秒检查一次，与 C# 一致）——到点的全部排队，逐条播报
      // 轮询与队列细节在 client/reminders.ts；卸载收尾由上面的 effect 调 dispose
      R.useEffect(() => {
        return reminderPoller.start()
      }, [])
      // ===== 语音模块（client/voice.ts + client/voice-bridge.ts）=====
      // 回调与生命周期只在 voice-bridge 里建一份（见组件顶部），这里只负责启动/收尾。
      R.useEffect(() => {
        // 清理器**始终**注册：sayLine 现在走 bridge.ensure()，待命关着也会建实例（只朗读不开麦）；
        // 若只在 earOn 时注册 dispose，这类实例在 SPA 卸载时不会被回收（2026-11-07 B88 审计建议）。
        const cleanup = (): void => { try { bridge.dispose() } catch (e) { } }
        if (earOnRef.current) {
          void bridge.start()
          return cleanup
        }
        return cleanup
      }, [])

      // ---- 旧调用点兼容层：全部转到新模块 ----
      function speakText(text: string, o?: { rate?: string; narration?: boolean; onDone?: () => void }): void {
        try {
          if (localStorage.getItem('chubby-voice') === 'off') {
            dg({ ttsSkip: 'voice-off' })
            // 语音关着：不合成，但仍要通知调用方「说完了」——文化类朗读的收尾（「讲完啦」、清叙述锁）靠 onDone，
            // 原来直接 return 会让语音关闭时永远没有收尾
            try { if (o && typeof o.onDone === 'function') o.onDone() } catch (e) { }
            return
          }
        } catch (e) { }
        bridge.speak(text, o)
      }
      function stopTts(): void {
        // 停止说话时如果流式还在跑：abort 旧流，别让它继续吐 delta/念后面的句子
        try { chat.abortStream() } catch (e) { }
        // 停止朗读 = 权威清锁：不认持有者，连长段探针一起撤（卸载也会走这里，不许留悬挂 timer）
        resetNarration()
        bridge.stopSpeak()
        // 琴声也要停：扬声器同一时刻只能播一段（docs/并发纪律.md §二）。
        // 原来只有「暂停/关音乐」和卸载会停琴，于是「弹琴中来 P0 提问」会变成 TTS 与琴声同时响。
        // 反方向（弹琴前先停朗读）culture.ts 已经做了，这里补齐另一半（2026-11-07 B91 审计）。
        try { melody.stop() } catch (e) { }
        // 说书锁也一起放：stopSpeaking 作废了当前段，它原本的 onDone 不会再来，
        // storyBusy 卡在 true 的话「接着说 / 说书」会永远回"正讲着呢"。
        // 先把在途的说书请求真正掐断（B98）：只清 busy 的话，响应仍会送达，
        // 服务端按「响应送出」把这没被听到的一段记成已讲。
        try { story.abort() } catch (e) { }
        try { storyBusyRef.current = false } catch (e) { }
        try { storyNarratingRef.current = false } catch (e) { }
      }

      /** 人设台词：气泡 + 语音一起出（语音朗读关着时只出气泡；正在说别的话时不打断） */
      function sayLine(text: string, ms = 3500, voiceOpts?: { rate?: string; pitch?: string }): void {
        // 同一句台词 25 秒内只说一次：挂载重复/事件连发时不会连着说两遍（client/text.ts 的 deduper）
        if (!lineDeduper.allow(text)) return
        if (!text) return
        try { showBubble(text, ms) } catch (e) { }
        try {
          if (localStorage.getItem('chubby-voice') === 'off') return
          // 与 speakText / bridge.speak 同一条路：必须用 ensure()，不能用 get()。
          // 待命关着刷新页面时实例没建过，get() 为 null —— 开场问候/情绪台词就只剩气泡没声
          // （朗读开关仍开）；而念诗/说书/提醒走 speakText → bridge.speak → ensure() 一直有声。
          // ensure() 只建朗读对象、不开麦克风（麦克风仍由 start() 开），见 voice-bridge.ts 的
          // speak 注释与 docs/坑.md 坑 23「麦克风与朗读解耦」。
          // 取舍：最直接的行为变化是「待命关 + 刷新页面」时问候/情绪台词从无声变有声；
          // 附带侧效应是这一状态下菜单「语音自检」会看到实例（0 统计）而不是「模块还没起来」。
          // 判断依据：菜单「语音待命」= 常驻听写（关=停录音、实例留着复用），真正管出声的是「语音朗读」
          // （chubby-voice=off，上面那行照旧拦下）；且同一会话里关待命（实例还在）时本行本来就出声。
          // 若主代理判定「待命关就该全静」，把 ensure() 改回 get() 即回滚（一行）。
          const v: any = bridge.ensure()
          if (v && v.speak && !v.speaking()) v.speak(text, { rate: (voiceOpts && voiceOpts.rate) || chatRate(), pitch: (voiceOpts && voiceOpts.pitch) || '' })
        } catch (e) { }
      }
      /** 统一的回复朗读入口：长回复走叙述语速，同一句回复 30 秒内不重复念 */
      function speakReply(text: string): void {
        const rp = String(text || '')
        if (!rp.trim()) return
        // 同一句回复 30 秒内不重复念（client/text.ts 的 deduper，重复时计数 dupReply）
        if (!replyDeduper.allow(rp)) return
        speakText(rp, { rate: rp.length >= 80 ? narrationRate() : chatRate() })
      }

      // ===== 成长 → 外观（L5）：档位变化时热更新 canvas 外观，不重建动画器 =====
      R.useEffect(() => {
        const next = lookForGrowth(growth)
        lookRef.current = next
        try { if (animRef.current) animRef.current.setLook(next) } catch (e) { }
      }, [growth])
      // 挂载时拉一次 /growth；失败静默（外观保持初识档，不报错）
      R.useEffect(() => {
        let alive = true
        fetchGrowth((p, init) => getJson(p, init)).then((info) => {
          if (alive && info) setGrowth(info)
        })
        return () => { alive = false }
      }, [])

      // Canvas 动画
      R.useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        animRef.current = createAnimator({ canvas, imgSrc: '/api/chubby-whale/asset?v=' + Date.now(), cw: CW, ch: CH, sx: SX, sy: SY, state: talkRef.current, look: lookRef.current })
        animRef.current.start()

      // ===== 炫技：眼睛跟随鼠标 / 深夜打瞌睡 ===== 
      const lastActivityRef = R.useRef(Date.now())
      R.useEffect(() => {
        const win: any = typeof window !== 'undefined' ? window : null
        if (!win) return
        const onMove = (e: any) => {
          try {
            lastActivityRef.current = Date.now()
            const el: any = stageRef.current
            const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null
            if (!r || !r.width) return
            const cx = r.left + r.width / 2
            const cy = r.top + r.height * 0.3
            const gx = Math.max(-1, Math.min(1, (e.clientX - cx) / (r.width * 2)))
            const gy = Math.max(-1, Math.min(1, (e.clientY - cy) / (r.height * 2)))
            animRef.current?.setGaze?.(gx, gy)
          } catch (e2) { }
        }
        win.addEventListener('mousemove', onMove, { passive: true })
        return () => { try { win.removeEventListener('mousemove', onMove) } catch (e2) { } }
      }, [])
      // 深夜（22:00-06:00）且 10 分钟没动静 → 打瞌睡（💤）
      R.useEffect(() => {
        const timer = setInterval(() => {
          try {
            const h = new Date().getHours()
            const deepNight = h >= 22 || h < 6
            const idle = Date.now() - lastActivityRef.current
            if (deepNight && idle > 10 * 60 * 1000) {
              applyServerMood('sleepy')
              try { showBubble('呼…本鲸先眯一会儿…', 3000) } catch (e2) { }
            }
          } catch (e2) { }
        }, 60000)
        return () => clearInterval(timer)
      }, [])
        return () => animRef.current?.stop()
      }, [])

      // ===== 渲染 =====
      // 隐藏时右下角留一个极小的「○」恢复点（点一下回来，不刷新页面）
      const recoverProps = recover.dot(hidden)
      // 菜单项递归渲染在 client/render.ts；这里只把闭包能力传进去。
      // 可见项清单在渲染时同步算一次（键盘高亮与屏幕顺序共用这一份，不各算一套）。
      const menuItems = menu
        ? buildMenu(VERSION, Object.assign({ voiceOn, earOn, voiceChatOn, chatCacheOn, narrationRate: narrationRate(), chatRate: chatRate(), balance: balanceLabel, growth: growthLabel, storyBooks, storyBooksTried }, readMenuRuntime()))
        : []
      const menuEntries = menu ? listMenuEntries(menuItems, { tr, lang, subOpen }) : []
      menuEntriesRef.current = menuEntries
      function renderItems(items: any[]): any[] {
        return renderMenuItems(items, {
          h, tr, lang, subOpen, focusIndex: menuFocus,
          onToggleSub: (next: string) => setSubOpen(next),
          onAction: (action: string) => runAction(action),
        })
      }

      return h(R.Fragment, null,
        h('div', {
          ref: stageRef, style: stageStyle(scale, hidden),
          onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp,
          onContextMenu,
          onDragOver: (e: any) => { e.preventDefault(); e.stopPropagation() },
          onDrop: (e: any) => {
            // 拖进来的文件：图片识别 / 文档总结（逻辑在 client/dropzone.ts）
            e.preventDefault()
            e.stopPropagation()
            const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
            handleFileDrop(file, { showBubble, speakText }).catch(() => { })
          },
          onClick: () => { if (dragRef.current.moved > 8) return; animRef.current?.talkFor(1200) },
        },
          h('div', { ref: squashRef, style: { width: '100%', height: '100%', transformOrigin: '50% 100%', willChange: 'transform' } },
            h('canvas', { ref: canvasRef, width: CW, height: CH, style: canvasStyle }),
          ),
        ),
        h('div', { ref: bubbleRef, className: 'chubby-bubble' }, h('div', { ref: bubbleTextRef, style: BUBBLE_TEXT_STYLE })),
        recoverProps ? h('div', Object.assign({}, recoverProps, { style: recoverDotStyle }), '○') : null,
        menu ? h('div', menuRootProps({ menu, lang }),
          // 标题栏：左边「名字 · 版本号」，右边余额（点一下刷新）；菜单最下面仍按规矩显示版本号
          renderMenuHeader({ h, lang, balanceText, onRefresh: () => { try { refreshMenuStats(true) } catch (e) { } } }),
          renderItems(menuItems),
        ) : null,
        // 聊天面板：结构与事件接线都在 client/render.ts，发送/输入法判断留在闭包里。
        // 外面包一层 display:contents 的根节点：粘贴处理要靠它判断事件是否发生在面板内，
        // contents 不生成布局盒子，不影响面板自身的 fixed 定位。
        h('div', { ref: chatRootRef, style: { display: 'contents' } },
          renderChatPanel({
            h, lang, open: chatOpen, messages, input, busy, bodyRef,
            inputRef, panelRef: chatPanelRef,
            onClose: () => setChatOpen(false),
            onInputChange: (v: string) => setInput(v),
            onKeyDown: (e: any) => {
              // 中文输入法选词时按回车不算发送：isComposing 之外还要认 keyCode 229
              // （Safari / 部分安卓输入法在 composition 中只给 229，isComposing 可能为 false）
              const ne: any = e && e.nativeEvent
              if (ne && (ne.isComposing || ne.keyCode === 229)) return
              if (e.key === 'Enter' && input.trim()) { const v = input; void sendText(v) }
            },
            // 清空输入框由 chat.send 在真的发出后负责（占线被拒时保留主人的话）
            onSend: () => { const v = input; if (!v.trim()) return; void sendText(v) },
          }),
        ),
      )
    }

    return {
      name: 'dsh-chubby-whale-client',
      inject: ['slots'],
      apply(ctx: any) {
        // 诊断对象：出问题时在浏览器控制台输入 __chubbyWhale 就能看到卡在哪一步。
        // 注意：不能整对象覆盖 —— 其它模块（chat/voice/actions）已经把字段挂在同一命名空间上，
        // 整替换会让它们的字段全丢（apply 跑两次时尤明显）。改成取已存在的对象再合并。
        const diag: any = (window as any).__chubbyWhale || ((window as any).__chubbyWhale = {})
        Object.assign(diag, {
          version: VERSION, applied: true, hasCtx: !!ctx, hasSlots: !!(ctx && ctx.slots), lat: latDiag,
          ch: { mic: channels.mic.stats, asr: channels.asr.stats, speak: channels.speak.stats },
          registered: false, error: null,
        })
        try {
          const slots = ctx && ctx.slots
          if (!slots) {
            diag.error = 'ctx.slots 不存在（inject 未生效）'
            console.warn('[chubby-whale]', diag.error)
            return
          }
          // 完全照官方插件的描述符形状：name + id + locale + inject（缺字段时宿主会判为装配错误）
          const desc: any = { name: 'shell.overlay', id: 'chubby-whale-overlay', order: 999, locale: 'chubby-whale', inject: () => ({}) }
          // 第二个参数必须是「渲染函数」：直接传组件会在非渲染上下文调用，触发 Invalid hook call
          // 与官方插件一致：第二个参数传「组件」，宿主会 React.createElement(组件)
          // WhaleOverlay 内部自带 try/catch 兜底，直接用它当组件（不再依赖 PetBoundary）
          const render = WhaleOverlay
          const doRegister = () => {
            try {
              slots.register(desc, render)
              diag.registered = true
              console.log('[chubby-whale] overlay 已注册')
            } catch (e) {
              diag.error = 'register 失败: ' + String(e)
              console.error('[chubby-whale] overlay 注册失败：', e)
            }
          }
          try {
            slots.inject('shell.overlay', doRegister)
            // 有些版本 inject 只登记不立即执行：兜一次延迟注册（重复注册会被内部 try/catch 吃掉）
            setTimeout(() => { if (!diag.registered) doRegister() }, 1200)
          } catch (e) {
            diag.error = 'inject 失败: ' + String(e)
            console.error('[chubby-whale] overlay 注入失败：', e)
            doRegister()
          }
        } catch (e) {
          diag.error = 'apply 异常: ' + String(e)
          console.error('[chubby-whale] apply 异常：', e)
        }
      },
    }
  },
})
