/**
 * dsh-chubby-whale —— 浏览器端入口（组件骨架 + 组装 + JSX）
 * 工具模块：client/hooks.ts（通用 hooks）、client/effects.ts（监听器/定时器/清理工厂）、
 *           client/render.ts（菜单与聊天面板的纯渲染）
 * 其余能力：client/styles.ts（样式）、client/menu.ts（菜单数据）、client/anim.ts（动画）等
 */
import { W, H, CW, CH, SX, SY, VERSION, stageStyle, canvasStyle, menuStyle, recoverDotStyle } from './client/styles.js'
import { buildMenu, tr } from './client/menu.js'
import { stopProgress } from './client/narration-progress.js'
import { narrationRate, chatRate } from './client/rates.js'
import { handleFileDrop } from './client/dropzone.js'
import { createAnimator } from './client/anim.js'
import { DEFAULT_GROWTH, fetchGrowth, lookFor, lookForGrowth, parseGrowth, type GrowthInfo } from './client/look.js'
import { createVoiceBridge } from './client/voice-bridge.js'
import { createActionTable, type ActionHost } from './client/actions.js'
import { registerCultureActions } from './client/actions/culture.js'
import { registerContentActions } from './client/actions/content.js'
import { registerSystemActions } from './client/actions/system.js'
import { registerVoiceActions } from './client/actions/voice.js'
import { createPersona, applyServerMood } from './client/persona.js'
import { createDeduper } from './client/text.js'
import { getJson } from './client/http.js'
import { createMelodyPlayer } from './client/melody.js'
import { createBubble, ensureBubbleStyle } from './client/bubble.js'
import { createNarrationLock } from './client/narration.js'
import { createBusyLock, createEpoch } from './client/busy.js'
import { clampPos, homePos as calcHomePos, createDragState, beginDrag, moveDrag, endDrag, decayVelocity, bindDragInput } from './client/stage.js'
import { createStoryController } from './client/story.js'
import { createLocalRouter } from './client/chat-route.js'
import { createChatSender } from './client/chat.js'
import { createReminderPoller } from './client/reminders.js'
import { createReminderManager } from './client/reminder-manage.js'
import { createRecover } from './client/recover.js'
import { createHooks } from './client/hooks.js'
import { bindFileDropCapture, bindOutsideClose, bindResize, createUnmountCleanup, startGreeting, startWatchdog } from './client/effects.js'
import { renderMenuItems, renderMenuHeader, renderChatPanel, readMenuRuntime } from './client/render.js'
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
    let asrBusy = false
    let asrBusyAt = 0   // 识别位占用的起始时刻（用于僵尸复位与状态显示）
    // 叙述语速（与 voice.ts 同源，localStorage 可调，默认 -25%）
    
    const storyNarratingRef = { current: false }
    const persona = createPersona()
  // 诊断对象上尽早挂出人设：原来只在 useEffect 里挂，效果是"组件没跑完副作用就查不到"，
  // 冒烟测试/排障都会误以为人设没初始化。这里创建完立刻挂，effect 里那份保留（幂等）。
  try {
    const w: any = (window as any).__chubbyWhale || ((window as any).__chubbyWhale = {})
    w.persona = persona
  } catch (e) { }
    let lastPoemSpeech = ''
    // 叙述锁带时间上限：念诗/说书期间不理麦克风，但绝不能"忘了解锁"把耳朵永久关掉
    // （状态机与自愈在 client/narration.ts）
    const narration = createNarrationLock()
    let lastSpeakingAt = 0   // 最近一次真正在朗读的时刻（用于锁的自愈）
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
    let greetedOnce = false   // 打招呼只打一次（防挂载重复）
    // 台词/回复去重：原来是两段手写的时间窗判断，统一用 client/text.ts 的 deduper
    const lineDeduper = createDeduper({ windowMs: 25000, onDuplicate: () => { try { (window as any).__chubbyWhale.dupLine = ((window as any).__chubbyWhale.dupLine || 0) + 1 } catch (e) { } } })
    const replyDeduper = createDeduper({ windowMs: 30000, onDuplicate: () => { try { (window as any).__chubbyWhale.dupReply = ((window as any).__chubbyWhale.dupReply || 0) + 1 } catch (e) { } } })
    const latDiag: any = { asrMs: 0, chatMs: 0, firstAudioMs: 0, totalMs: 0, updates: 0 }
    // 琴声播放器：音符表、振荡器排程、停止/关闭 AudioContext 都在 client/melody.ts
    const melody = createMelodyPlayer()

    /** 安全外壳：把内层组件的渲染异常就地拦下并记录，绝不让整个 slot 变成错误占位 */
    function WhaleOverlay(props: any) {
      try {
        return WhaleBody(props || {})
      } catch (e: any) {
        try { (window as any).__chubbyWhale.renderError = String((e && e.stack) || e) } catch (e2) { }
        try { console.error('[chubby-whale] 渲染异常已被就地拦下：', e) } catch (e2) { }
        return null
      }
    }

    function WhaleBody(props: any) {
      const stageRef = R.useRef(null)
      const canvasRef = R.useRef(null)
      const posRef = R.useRef({ x: 0, y: 0 })
      const talkRef = R.useRef({ talkUntil: 0, hearts: [] as any[] })
      const voiceModeRef = R.useRef(false)
      const wokeRef = R.useRef({ at: 0 })
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
      const voiceChatOnState = hookApi.usePersistentBool('chubby-voicechat')
      const voiceChatOnRef = voiceChatOnState.ref
      const voiceChatOn = voiceChatOnState.value
      const setVoiceChatOn = voiceChatOnState.set
      // 录音循环的启停句柄（由 VAD 的 effect 注入：关掉语音待命时真停麦克风）
      const earCtlRef = R.useRef({ stop: () => { }, boot: () => { } })
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
      // 原来这里定义了一份却从没被读过，属于"接线缺口"，已移除。
      const dragRef = R.useRef(createDragState())
      const scaleRef = R.useRef(1)
      const animRef = R.useRef(null as any)
      /** 动画口型：动画器还没建好时静默（宿主回调里多处共用这一份，别各写一遍 try/catch） */
      const talkFor = (ms: number): void => { try { animRef.current?.talkFor(ms) } catch (e) { } }
      const storyBusyRef = R.useRef(false)
      // 最近一次说书的书名（「从头讲这本书」要按它重置进度）
      const storyBookRef = R.useRef('')
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
      const [menu, setMenu] = R.useState(null as any)
      const [subOpen, setSubOpen] = R.useState('')
      // 说书书单（菜单「选本书 ▸」用）：tried 区分「还没拉」与「拉过但为空/失败」
      const [storyBooks, setStoryBooks] = R.useState([] as string[])
      const [storyBooksTried, setStoryBooksTried] = R.useState(false)
      const [balanceText, setBalanceText] = R.useState('')
      const [lang, setLang] = R.useState((() => { try { return localStorage.getItem('chubby-lang') || 'zh' } catch { return 'zh' } })())
      const [chatOpen, setChatOpen] = R.useState(false)
      const [messages, setMessages] = R.useState([] as any[])
      const [input, setInput] = R.useState('')
      const [busy, setBusy] = R.useState(false)
      // 忙碌锁：权威状态在 client/busy.ts（React 的 busy 只负责按钮文案）
      const busyLockRef = hookApi.useLazyRef(createBusyLock)
      const busyLock = busyLockRef.current
      const bodyRef = R.useRef(null)
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
          if (playing) { try { lastSpeakingAt = Date.now() } catch (e) { } }
        },
        // 语音聊天关着时"只听不接话"（由唤醒门之前先拦一道）
        voiceChat: () => voiceChatOnRef.current,
        // 正在朗读时，语音"停"要能直接打断（不受唤醒门限制）
        speaking: () => ttsPlaying,
        diag: (patch: any) => { try { Object.assign(((window as any).__chubbyWhale || ((window as any).__chubbyWhale = {})), patch) } catch (e) { } },
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
        // 缩放后实际占位是 W*scale / H*scale：窗口缩小时也要把整只鱼留在可视区里
        const s = scaleRef.current || 1
        const p = clampPos(x, y, W * s, H * s, window.innerWidth, window.innerHeight)
        x = p.x
        y = p.y
        const d = dragRef.current
        if (d && d.dragging) {
          // 拖动中走 transform：合成层位移，不触发布局与整树重绘
          const bx = typeof d.baseX === 'number' ? d.baseX : x
          const by = typeof d.baseY === 'number' ? d.baseY : y
          el.style.transform = 'translate3d(' + (x - bx) + 'px,' + (y - by) + 'px,0)'
        } else {
          el.style.left = x + 'px'
          el.style.top = y + 'px'
          el.style.transform = ''
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

      // 窗口尺寸变化：按当前缩放重新钳制位置，别让鱼停在可视区外
      R.useEffect(() => {
        return bindResize(window, () => {
          applyPos(posRef.current.x, posRef.current.y)
          savePos()
        })
      }, [])

      // 卸载收尾：提醒链 / 朗读音频 / 琴声 AudioContext / 气泡定时器都别留着
      // （SpeechRecognition 当前没用到；VAD 的 MediaRecorder 由下面语音待命的 effect 自己 stopEar）
      R.useEffect(() => {
        return createUnmountCleanup({
          reminderPoller: () => reminderPollerRef.current,
          stopTts: () => stopTts(),
          stopMelody: () => melody.stop(),
          bubbleEl: () => bubbleRef.current,
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
      function setStatus(): void { bubble.dismissStatus() }
      function restoreIdleStatus(): void { }

      // 提醒管理面板：清单 + 「下一条输入」（数字=删 / d=顺延）共用同一个实例；
      // 聊天框与语音最终都走 sendText，所以拦截只接一处（逻辑在 client/reminder-manage.ts）。
      const reminderManager = createReminderManager({ bubble: showBubble })
      // 「让它游走」可逆：隐藏时右下角留「○」恢复点，Ctrl+Shift+W 也走同一条恢复路径（不刷新页面）
      const recover = createRecover({ recover: () => setHidden(false) })
      // 全局快捷键：捕获阶段登记，避免被宿主页面的 keydown 先吃掉
      R.useEffect(() => {
        const unbind = recover.bindHotkey(window)
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
        })
      }, [])

      // 拖动
      function dragBeginAt(x: number, y: number): void {
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
      }
      function dragFinish(): void {
        const d = dragRef.current
        if (!d.dragging) return
        const v = endDrag(d)
        // 恢复滤镜，并把 transform 位移提交成 left/top（否则鱼停在原位）
        try { const el = stageRef.current; if (el && el.style) { el.style.filter = ""; el.style.willChange = "" } } catch (e2) { }
        applyPos(posRef.current.x, posRef.current.y)
        savePos()
        let vx = v.x
        let vy = v.y
        const step = () => {
          if (dragRef.current.dragging) return
          const dv = decayVelocity(vx, vy)
          vx = dv.vx; vy = dv.vy
          applyPos(posRef.current.x + vx, posRef.current.y + vy)
          if (dv.done) { savePos(); return }
          requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      }
      function onPointerDown(e: any): void {
        // 触摸事件的 button 是 0；右键是 2。没有 button 字段的合成事件按左键处理
        if (typeof e.button === 'number' && e.button !== 0) return
        dragBeginAt(e.clientX, e.clientY)
        try { e.currentTarget.setPointerCapture(e.pointerId) } catch { }
      }
      function onPointerMove(e: any): void {
        try { e.__chubbyDragHandled = true } catch (e2) { }
        dragMoveTo(e.clientX, e.clientY)
      }
      function onPointerUp(e?: any): void {
        try { if (e) e.__chubbyDragHandled = true } catch (e2) { }
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
        try { (window as any).__chubbyWhale.dragInput = binding.mode } catch (e) { }
        return () => { try { binding.dispose() } catch (e) { } }
      }, [])

      // 余额/成长只在「菜单打开」时拉（见 refreshMenuStats），开机不预请求
      R.useEffect(() => {
        // 饭团：进门先打个招呼（按当前时段挑台词），3 秒后出现，不抢首屏
        const stopGreet = startGreeting({
          greet: () => { try { if (greetedOnce) return; greetedOnce = true; const g = persona.greeting(); if (g) sayLine(g, 5000) } catch (e) { } },
          hungry: () => { try { sayLine(persona.line('hungry'), 4000) } catch (e) { } },
          // 打了招呼再看是不是饿了：饿着就补一句（对应人设的 hungry 场景）
          hungryNow: (() => { try { const st: any = (persona as any).state; return !!(st && st.lastFeedAt && Date.now() - st.lastFeedAt > 6 * 3600 * 1000) } catch (e) { return false } })(),
        })
        try { const w: any = (window as any).__chubbyWhale || ((window as any).__chubbyWhale = {}); w.persona = persona; w.sayLine = sayLine } catch (e) { }
        // 状态行 2 秒周期刷新：常驻气泡只会在被调用时更新，靠事件驱动容易漏（就曾卡在「识别中…」）
        const stopWatch = startWatchdog(() => {
          // 占线自愈：一次请求异常不能让后续提问永远被「还在想上一句」挡住
          try {
            // 叙述锁自愈：过了时限还锁着就强制解除（防止"鱼听不到"）
            try {
              if (narration.expire()) {
                clearNarrating()
                try { (window as any).__chubbyWhale.narrReset = ((window as any).__chubbyWhale.narrReset || 0) + 1 } catch (e3) { }
              }
            } catch (e3) { }
            if (busyLock.watchdog()) {
              setBusy(false)
              try { (window as any).__chubbyWhale.busyReset = ((window as any).__chubbyWhale.busyReset || 0) + 1 } catch (e2) { }
            }
          } catch (e) { }
        })
        const tF = setTimeout(() => { try { prefetchFiller() } catch (e) { } }, 3000)
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
          .then((d: any) => {
            const list = (d && d.ok && Array.isArray(d.books))
              ? d.books.map((b: any) => String(b || '').trim()).filter(Boolean)
              : []
            setStoryBooks(list)
            setStoryBooksTried(true)
          })
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
        setGrowthLabel(info.stage + '（' + info.exp + (info.nextExp ? '/' + info.nextExp : '') + '）')
        setGrowth(info)
      }

      /** 重新拉一次 /growth 并刷新外观（喂食后调用）；失败静默回落初识 */
      function syncGrowth(): void {
        fetchGrowth((p, init) => getJson(p, init)).then((info) => {
          if (info) {
            setGrowthLabel(info.stage + '（' + info.exp + (info.nextExp ? '/' + info.nextExp : '') + '）')
            setGrowth(info)
          } else {
            setGrowth(DEFAULT_GROWTH)
          }
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

      // ===== 说书（连载）：拉段、气泡、朗读、自动连播全在 client/story.ts =====
      const story = createStoryController({
        clientId: CLIENT_ID,
        persona,
        narrate: setNarrating,
        clearNarrate: clearNarrating,
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
        narrate: setNarrating,
        clearNarrate: clearNarrating,
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
                // 唤醒了才接话：先把规则说清楚，免得主人以为坏了
                else showBubble('语音待命：开（先喊「大肥鱼」，本鲸才答话）', 3500)
              } catch (e) { }
            }).catch((e: any) => showBubble('麦克风没打开：' + String((e && e.message) || e), 5000))
          } catch (e: any) {
            showBubble('语音待命没开成：' + String((e && e.message) || e), 5000)
          }
        },
        chatCacheOn: () => chatCacheOnRef.current,
        setChatCacheOn: (v) => { chatCacheOnRef.current = v; setChatCacheOn(v) },
        diag: (patch) => { try { Object.assign(((window as any).__chubbyWhale || ((window as any).__chubbyWhale = {})), patch) } catch (e) { } },
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
      // ===== 点播本地路由：关键词识别与念诗/讲典故的本地处理在 client/chat-route.ts =====
      const localRouter = createLocalRouter({
        persona,
        narrationRate: narrationRate,
        bubble: showBubble,
        say: sayLine,
        speak: speakText,
        narrate: setNarrating,
        clearNarrate: clearNarrating,
        talkFor,
        story,
        storyState: { busy: storyBusyRef, narrating: storyNarratingRef, auto: storyAutoRef, book: storyBookRef },
      })


      // ===== 流式对话：边生成边开口 =====
      // 传统路径要等整段生成完才合成语音；这里把模型吐出的文字按句切开立刻送朗读，
      // 首字延迟从「整段生成 + 首段合成」降到「首句生成 + 首段合成」。
      // 任何异常都在 4 秒内回退到普通 /chat，不影响可用性。
      // ===== 聊天/流式：发送器在 client/chat.ts，这里只做组装与转发 =====
      const chat = createChatSender({
        persona,
        bubble: showBubble,
        say: sayLine,
        speak: speakText,
        speakReply: (text) => speakReply(text),
        stopSpeak: () => stopTts(),
        talkFor,
        heart: () => { try { animRef.current?.pushHeart() } catch (e) { } },
        setInput: (v) => setInput(v),
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
      })
      // 旧调用点名称保留（拖放 / 语音 / 调试口都调 sendText）
      function sendText(rawText: string, opts?: { voice?: boolean }): Promise<boolean> {
        // 提醒管理面板最近打开 60 秒内：数字=删、d=顺延先接住；
        // 其余输入（正常对话）原样放行，绝不误吞（判断都在 client/reminder-manage.ts）
        try {
          if (reminderManager.intercept(String(rawText == null ? '' : rawText))) return Promise.resolve(true) // 被提醒面板消费：算已处理
        } catch (e) { }
        // chat.send 内部返回 boolean（是否已发出），这里透传出去让调用方决定要不要清空输入
  return chat.send(rawText, opts).then((ok: any) => ok !== false)
      }

      // 启动时把服务端 pet.mood 同步给客户端（服务端只发 normal/happy/hungry；失败静默，不阻塞渲染）
  // SYNC-PET-MOOD
  R.useEffect(() => {
    try { getJson('/pet').then((d: any) => { if (d && d.pet && d.pet.mood) applyServerMood(String(d.pet.mood)) }).catch(() => { }) } catch (e) { }
  }, [])

  // 调试口：控制台输入 __chubbyWhale.say("你好呀") 可直接测「对话 + 朗读」链路（不经过麦克风）
      R.useEffect(() => {
        try {
          const w: any = (window as any).__chubbyWhale || ((window as any).__chubbyWhale = {})
          w.say = (t: string) => { try { sendText(String(t || ""), { voice: true }) } catch (e) { } }
          w.sayStop = () => { try { stopTts() } catch (e) { } }
          w.busyNow = () => ({ busy: busyLock.isBusy(), age: busyLock.age(), tts: ttsPlaying })
          // 外观诊断：控制台 __chubbyWhale.look() 可看当前档位/体型/光点数/光晕
          w.look = () => lookRef.current
        } catch (e) { }
      }, [])
      // 提醒轮询（每 20 秒检查一次，与 C# 一致）——到点的全部排队，逐条播报
      // 轮询与队列细节在 client/reminders.ts；卸载收尾由上面的 effect 调 dispose
      R.useEffect(() => {
        return reminderPoller.start()
      }, [])
      // ===== 语音模块（client/voice.ts + client/voice-bridge.ts）=====
      // 回调与生命周期只在 voice-bridge 里建一份（见组件顶部），这里只负责启动/收尾。
      R.useEffect(() => {
        if (!earOnRef.current) return
        void bridge.start()
        return () => { bridge.dispose() }
      }, [])

      // ---- 旧调用点兼容层：全部转到新模块 ----
      function speakText(text: string, o?: { rate?: string; narration?: boolean; onDone?: () => void }): void {
        try { if (localStorage.getItem('chubby-voice') === 'off') { try { (window as any).__chubbyWhale.ttsSkip = 'voice-off' } catch (e) { } ; return } } catch (e) { }
        bridge.speak(text, o)
      }
      function stopTts(): void {
        // 停止说话时如果流式还在跑：abort 旧流，别让它继续吐 delta/念后面的句子
        try { chat.abortStream() } catch (e) { }
        clearNarrating()   // 停止朗读 = 解除叙述锁
        bridge.stopSpeak()
        // 说书锁也一起放：stopSpeaking 作废了当前段，它原本的 onDone 不会再来，
        // storyBusy 卡在 true 的话「接着说 / 说书」会永远回"正讲着呢"。
        try { storyBusyRef.current = false } catch (e) { }
        try { storyNarratingRef.current = false } catch (e) { }
      }
      function muteMic(): void { bridge.mute(true) }
      function unmuteMic(): void { bridge.mute(false) }
      function prefetchFiller(): void { }

      /** 人设台词：气泡 + 语音一起出（语音朗读关着时只出气泡；正在说别的话时不打断） */
      function sayLine(text: string, ms = 3500, voiceOpts?: { rate?: string; pitch?: string }): void {
        // 同一句台词 25 秒内只说一次：挂载重复/事件连发时不会连着说两遍（client/text.ts 的 deduper）
        if (!lineDeduper.allow(text)) return
        if (!text) return
        try { showBubble(text, ms) } catch (e) { }
        try {
          if (localStorage.getItem('chubby-voice') === 'off') return
          const v: any = bridge.get()
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
        animRef.current = createAnimator({ canvas, imgSrc: '/api/chubby-whale/asset', cw: CW, ch: CH, sx: SX, sy: SY, state: talkRef.current, look: lookRef.current })
        animRef.current.start()
        return () => animRef.current?.stop()
      }, [])

      // ===== 渲染 =====
      // 隐藏时右下角留一个极小的「○」恢复点（点一下回来，不刷新页面）
      const recoverProps = recover.dot(hidden)
      // 菜单项递归渲染在 client/render.ts；这里只把闭包能力传进去
      function renderItems(items: any[]): any[] {
        return renderMenuItems(items, {
          h, tr, lang, subOpen,
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
          h('canvas', { ref: canvasRef, width: CW, height: CH, style: canvasStyle }),
        ),
        h('div', { ref: bubbleRef, className: 'chubby-bubble' }, h('div', { ref: bubbleTextRef })),
        recoverProps ? h('div', Object.assign({}, recoverProps, { style: recoverDotStyle }), '○') : null,
        menu ? h('div', { style: menuStyle(menu), 'data-menu-root': '1' },
          // 标题栏：左边「名字 · 版本号」，右边余额（点一下刷新）；菜单最下面仍按规矩显示版本号
          renderMenuHeader({ h, lang, balanceText, onRefresh: () => { try { refreshMenuStats(true) } catch (e) { } } }),
          renderItems(buildMenu(VERSION, Object.assign({ voiceOn, earOn, voiceChatOn, chatCacheOn, narrationRate: narrationRate(), chatRate: chatRate(), balance: balanceLabel, growth: growthLabel, storyBooks, storyBooksTried }, readMenuRuntime()))),
        ) : null,
        // 聊天面板：结构与事件接线都在 client/render.ts，发送/输入法判断留在闭包里
        renderChatPanel({
          h, lang, open: chatOpen, messages, input, busy, bodyRef,
          onClose: () => setChatOpen(false),
          onInputChange: (v: string) => setInput(v),
          onKeyDown: (e: any) => {
            // 中文输入法选词时按回车不算发送（isComposing 期间放行给输入法）
            if (e.nativeEvent && e.nativeEvent.isComposing) return
            if (e.key === 'Enter' && input.trim()) { const v = input; void sendText(v).then((ok) => { if (ok) setInput('') }) }
          },
          onSend: () => { const v = input; if (!v.trim()) return; void sendText(v).then((ok) => { if (ok) setInput('') }) },
        }),
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
