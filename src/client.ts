/**
 * dsh-chubby-whale —— 浏览器端入口（模块化组装）
 * 依赖模块：client/styles.ts（样式）、client/menu.ts（菜单）、client/anim.ts（动画）
 */
import { W, H, CW, CH, SX, SY, VERSION, stageStyle, canvasStyle, menuStyle, chatPanelStyle, headStyle, bodyStyle, inputRowStyle, inputStyle, sendStyle, msgStyle } from './client/styles.js'
import { buildMenu, tr } from './client/menu.js'
import { handleFileDrop } from './client/dropzone.js'
import { createAnimator } from './client/anim.js'
import { createVoiceBridge } from './client/voice-bridge.js'
import { createActionTable, type ActionHost } from './client/actions.js'
import { registerCultureActions } from './client/actions/culture.js'
import { registerSystemActions } from './client/actions/system.js'
import { registerVoiceActions } from './client/actions/voice.js'
import { createPersona } from './client/persona.js'
import { createDeduper } from './client/text.js'
import { getJson } from './client/http.js'
import { createMelodyPlayer } from './client/melody.js'
import { createBubble, ensureBubbleStyle } from './client/bubble.js'
import { createNarrationLock } from './client/narration.js'
import { createBusyLock, createEpoch } from './client/busy.js'
import { clampPos, homePos as calcHomePos, createDragState, beginDrag, moveDrag, endDrag, decayVelocity } from './client/stage.js'
import { createStoryController } from './client/story.js'
import { createLocalRouter } from './client/chat-route.js'
import { createChatSender } from './client/chat.js'
import { createReminderPoller } from './client/reminders.js'
;(window as any).__ModuleLoader__.load({
  id: 'dsh-chubby-whale',
  factory: (require: any) => {
    const R = require('react')
    // 早期错误记录器：抓住宿主插槽渲染我们组件时抛的异常（模块加载即安装）
    try {
      (window as any).__chubbyErrors = []
      const origErr = console.error
      console.error = function (...a: any[]) {
        try { (window as any).__chubbyErrors.push(a.map((x: any) => (x && x.stack) ? x.stack : String(x)).join(' ').slice(0, 800)) } catch (e) { }
        return (origErr as any).apply(console, a as any)
      } as any
      window.addEventListener('error', (e: any) => { try { (window as any).__chubbyErrors.push('window.error: ' + (e.message || '') + ' | ' + ((e.error && e.error.stack) || '')) } catch (e2) { } })
    } catch (e) { }
    const h = R.createElement

    // 动作表：菜单动作 → 处理器（新增动作只改 client/actions/*.ts 与菜单数据，不动本文件）
    const actions = createActionTable<ActionHost>()
    registerCultureActions(actions)
    registerSystemActions(actions)
    registerVoiceActions(actions)



    // 客户端标识：多标签页说书队列互不抢段（取不到就退化成单队列）
    const CLIENT_ID = (() => {
      try {
        let v = localStorage.getItem('chubby-client-id')
        if (!v) { v = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); localStorage.setItem('chubby-client-id', v) }
        return v
      } catch (e) { return '' }
    })()

    let ttsPlaying = false   // UI 用：是否正在说（由新语音模块状态回调更新）
    const channels: any = { mic: { stats: {} }, asr: { stats: {} }, speak: { stats: {} } }
    // 请求纪元：主人一问新问题，旧的异步回复自动作废（client/busy.ts）
    const epoch = createEpoch()
    let asrBusy = false
    let asrBusyAt = 0   // 识别位占用的起始时刻（用于僵尸复位与状态显示）
    // 叙述语速（与 voice.ts 同源，localStorage 可调，默认 -25%）
    const NARRATION_RATE = (() => { try { const s = localStorage.getItem('chubby-narration-rate'); return (s && /^[+-]\d{1,2}%$/.test(s)) ? s : '-25%' } catch (e) { return '-25%' } })()
    const storyNarratingRef = { current: false }
    const persona = createPersona()
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
      const voiceOnRef = R.useRef((() => { try { return localStorage.getItem('chubby-voice') !== 'off' } catch (e) { return true } })())
      const [voiceOn, setVoiceOn] = R.useState((() => { try { return localStorage.getItem('chubby-voice') !== 'off' } catch (e) { return true } })())
      // 语音待命 / 语音聊天：真开关（默认都开，持久化在 chubby-ear / chubby-voicechat）
      const earOnRef = R.useRef((() => { try { return localStorage.getItem('chubby-ear') !== 'off' } catch (e) { return true } })())
      const [earOn, setEarOn] = R.useState(earOnRef.current)
      const voiceChatOnRef = R.useRef((() => { try { return localStorage.getItem('chubby-voicechat') !== 'off' } catch (e) { return true } })())
      const [voiceChatOn, setVoiceChatOn] = R.useState(voiceChatOnRef.current)
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
      const WAKE_WORDS = ['大肥鱼', '肥鲸', '肥鱼', '小鱼', '蓝鱼', '小蓝鱼', '鱼鱼', '肥肥']
      const dragRef = R.useRef(createDragState())
      const scaleRef = R.useRef(1)
      const animRef = R.useRef(null as any)
      const storyBusyRef = R.useRef(false)
      // 最近一次说书的书名（「从头讲这本书」要按它重置进度）
      const storyBookRef = R.useRef('')
    const storyAutoRef = R.useRef(false)   // 点播讲故事：自动连播到"这一回讲完"
      // 到点提醒：轮询 + 播报队列在 client/reminders.ts；ref 缓存保证跨渲染只建一个实例
      const reminderPollerRef = R.useRef(null as any)

      const [scale, setScale] = R.useState(1)
      const [hidden, setHidden] = R.useState(false)
      const [menu, setMenu] = R.useState(null as any)
      const [subOpen, setSubOpen] = R.useState('')
      const [balanceText, setBalanceText] = R.useState('')
      const [lang, setLang] = R.useState((() => { try { return localStorage.getItem('chubby-lang') || 'zh' } catch { return 'zh' } })())
      const [chatOpen, setChatOpen] = R.useState(false)
      const [messages, setMessages] = R.useState([] as any[])
      const [input, setInput] = R.useState('')
      const [busy, setBusy] = R.useState(false)
      // 忙碌锁：权威状态在 client/busy.ts（React 的 busy 只负责按钮文案）
      const busyLockRef = R.useRef(null as any)
      if (!busyLockRef.current) busyLockRef.current = createBusyLock()
      const busyLock = busyLockRef.current
      const bodyRef = R.useRef(null)
      const bubbleRef = R.useRef(null)
      const bubbleTextRef = R.useRef(null)

      // 语音桥：回调只在 voice-bridge 里建一份（待命 effect 与菜单「唤醒」共用）。
      // 必须放在所有 effect 之前：卸载 effect 会调 stopTts() → bridge.stopSpeak()。
      const bridgeRef = R.useRef(null as any)
      if (!bridgeRef.current) {
        bridgeRef.current = createVoiceBridge({
          narration,
          narrating: () => storyNarratingRef.current,
          stopSpeaking: () => stopTts(),
          bubble: showBubble,
          sendText: (text: string, opts?: { voice?: boolean }) => sendText(text, opts),
          onVoiceHeard: () => { try { voiceModeRef.current = true } catch (e) { } },
          onSpeaking: (playing: boolean) => {
            ttsPlaying = playing
            if (playing) { try { lastSpeakingAt = Date.now() } catch (e) { } }
          },
          diag: (patch: any) => { try { Object.assign(((window as any).__chubbyWhale || ((window as any).__chubbyWhale = {})), patch) } catch (e) { } },
        })
      }
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
        const onResize = (): void => {
          applyPos(posRef.current.x, posRef.current.y)
          savePos()
        }
        window.addEventListener('resize', onResize)
        return () => {
          try { window.removeEventListener('resize', onResize) } catch { }
        }
      }, [])

      // 卸载收尾：提醒链 / 朗读音频 / 琴声 AudioContext / 气泡定时器都别留着
      // （SpeechRecognition 当前没用到；VAD 的 MediaRecorder 由下面语音待命的 effect 自己 stopEar）
      R.useEffect(() => {
        return () => {
          // 提醒链卸载顺序：撤到点定时器 → 清队列 → 停轮询（由 dispose 内部固定），再停朗读
          try { if (reminderPollerRef.current) reminderPollerRef.current.dispose() } catch { }
          stopTts()
          melody.stop()
          try {
            const el = bubbleRef.current
            if (el && el._t) { clearTimeout(el._t); el._t = null }
          } catch { }
        }
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
      // ===== 状态提示（已按主人要求去掉）=====
      // 原来闲时一直挂「在听…」，还出现过"讲着话却显示在听"的矛盾。
      // 现在不主动显示任何状态字：只听/只在真正有内容时冒气泡（听到、回复、念完…）。
      function setStatus(): void { bubble.dismissStatus() }
      function restoreIdleStatus(): void { }

      // ===== 拖放：必须在【捕获阶段】抢在 HARNESS 自己的拖放处理之前 =====
      // React 的 onDrop 走冒泡阶段，宿主的 drop 处理器会先接走文件，鱼永远收不到。
      // 这里用 window 捕获监听 + 命中判定：落点在鱼身上才归鱼，其它位置仍交给宿主。
      R.useEffect(() => {
        const insideFish = (x: number, y: number): boolean => {
          try {
            const el = stageRef.current
            if (!el) return false
            const r = el.getBoundingClientRect()
            const pad = 12   // 手抖一点也算命中
            return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad
          } catch (e) { return false }
        }
        const onDragOverCapture = (e: any): void => {
          if (!insideFish(e.clientX, e.clientY)) return
          e.preventDefault()
          e.stopPropagation()
        }
        const onDropCapture = (e: any): void => {
          if (!insideFish(e.clientX, e.clientY)) return
          e.preventDefault()
          e.stopPropagation()
          const dt = e.dataTransfer
          const file = dt && dt.files && dt.files[0]
          try { handleFileDrop(file, { showBubble, speakText }).catch(() => { }) } catch (e2) { }
        }
        window.addEventListener('dragover', onDragOverCapture, true)
        window.addEventListener('drop', onDropCapture, true)
        return () => {
          try { window.removeEventListener('dragover', onDragOverCapture, true) } catch (e) { }
          try { window.removeEventListener('drop', onDropCapture, true) } catch (e) { }
        }
      }, [])

      // 拖动
      function onPointerDown(e: any): void {
        if (e.button !== 0) return
        beginDrag(dragRef.current, e.clientX, e.clientY, posRef.current.x, posRef.current.y)
        try {
          const el = stageRef.current
          // 拖动期间关掉投影滤镜：大滤镜每帧重算是拖拽卡死/闪退的主因之一
          if (el && el.style) { el.style.filter = 'none'; el.style.willChange = 'transform' }
        } catch (e2) { }
        try { e.currentTarget.setPointerCapture(e.pointerId) } catch { }
      }
      function onPointerMove(e: any): void {
        const d = dragRef.current
        if (!d.dragging) return
        const m = moveDrag(d, e.clientX, e.clientY)
        applyPos(posRef.current.x + m.x, posRef.current.y + m.y)
      }
      function onPointerUp(): void {
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

      // 启动后拉一次余额，菜单还没打开时标题也能显示真实金额
      R.useEffect(() => {
        const t0 = setTimeout(() => { try { refreshBalance() } catch (e) { } }, 2000)
        // 饭团：进门先打个招呼（按当前时段挑台词），3 秒后出现，不抢首屏
        const tGreet = setTimeout(() => { try { if (greetedOnce) return; greetedOnce = true; const g = persona.greeting(); if (g) sayLine(g, 5000) } catch (e) { } }, 3000)
            // 打了招呼再看是不是饿了：饿着就补一句（对应人设的 hungry 场景）
            try { const st: any = (persona as any).state; if (st && st.lastFeedAt && Date.now() - st.lastFeedAt > 6 * 3600 * 1000) setTimeout(() => { try { sayLine(persona.line('hungry'), 4000) } catch (e) { } }, 6000) } catch (e) { }
        try { const w: any = (window as any).__chubbyWhale || ((window as any).__chubbyWhale = {}); w.persona = persona; w.sayLine = sayLine } catch (e) { }
        // 状态行 2 秒周期刷新：常驻气泡只会在被调用时更新，靠事件驱动容易漏（就曾卡在「识别中…」）
        const tStatus = setInterval(() => {
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
        }, 2000)
        const clearStatus = () => { try { clearInterval(tStatus) } catch (e) { } }
        const tF = setTimeout(() => { try { prefetchFiller() } catch (e) { } }, 3000)
        return () => {
          clearTimeout(t0)
          try { clearTimeout(tGreet) } catch (e) { }
          try { clearTimeout(tF) } catch (e) { }
          clearStatus()
          try { const el = bubbleRef.current; if (el) el.classList.remove('show') } catch (e) { }
        }
      }, [])
      // 右键菜单
      function onContextMenu(e: any): void {
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
        setSubOpen('')
        // 每次开菜单都拉一次实时余额：菜单上的「余额：…」要显示当前金额，不能停在 --
        refreshBalance()
        getJson('/growth').then((d: any) => {
          if (d && d.ok) setGrowthLabel(d.stage + '（' + d.exp + '）')
        }).catch(() => { })
      }

      /** 拉实时余额，并把菜单标题与「余额：…」一起更新；没配 Key 时明确说出来 */
      function refreshBalance(): void {
        getJson('/balance', { cache: 'no-store' })
          .then((d: any) => {
            if (d && d.ok && d.balance != null) {
              const v = String(d.balance)
              setBalanceText('余额 ¥' + v)
              setBalanceLabel('¥' + v)
            } else if (d && (d.error === 'NO_KEY' || d.error === 'no key')) {
              setBalanceText('余额（未配置密钥）')
              setBalanceLabel('未配置密钥')
            } else {
              setBalanceText('余额（查询失败）')
              setBalanceLabel('查询失败')
            }
          })
          .catch(() => {
            setBalanceText('余额（查询失败）')
            setBalanceLabel('查询失败')
          })
      }

      // 点菜单外面就关掉（菜单根节点带 data-menu-root 标记，closest 判断）
      R.useEffect(() => {
        if (!menu) return
        const onDocDown = (e: any): void => {
          try {
            const t = e && e.target
            if (t && t.closest && t.closest('[data-menu-root]')) return
            setMenu(null)
            setSubOpen('')
          } catch { }
        }
        (document as any).addEventListener('pointerdown', onDocDown, true)
        return () => {
          try { (document as any).removeEventListener('pointerdown', onDocDown, true) } catch { }
        }
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
        narrationRate: NARRATION_RATE,
        isVoiceOff: () => { try { return localStorage.getItem('chubby-voice') === 'off' } catch (e) { return false } },
        refs: { busy: storyBusyRef, narrating: storyNarratingRef, auto: storyAutoRef, book: storyBookRef },
      })

      // ===== 到点提醒：轮询 + 队列播报在 client/reminders.ts，这里只注入宿主能力 =====
      if (!reminderPollerRef.current) {
        reminderPollerRef.current = createReminderPoller({
          getJson: (path, init) => getJson(path, init),
          bubble: (text, ms) => showBubble(text, ms),
          talkFor: (ms) => { try { animRef.current?.talkFor(ms) } catch (e) { } },
          speak: (text) => { try { speakText(text) } catch (e) { } },
          isSpeaking: () => ttsPlaying,
          isNarrating: () => storyNarratingRef.current,
          isBusy: () => busyLock.isBusy(),
        })
      }
      const reminderPoller = reminderPollerRef.current

      // 菜单动作：动作表 + 处理器注册（client/actions/*.ts），客户端只留组装与分发
      const actionHost: ActionHost = {
        bubble: (text, ms) => showBubble(text, ms),
        say: (text, ms, opts) => sayLine(text, ms, opts),
        speak: (text, opts) => speakText(text, opts),
        speakReply: (text) => speakReply(text),
        narrate: setNarrating,
        clearNarrate: clearNarrating,
        stopSpeak: () => stopTts(),
        stopMelody: () => melody.stop(),
        playMelody: (notes, bpm, onDone) => melody.play(notes, bpm, onDone),
        talkFor: (ms) => { try { animRef.current?.talkFor(ms) } catch (e) { } },
        heart: () => { try { animRef.current?.pushHeart() } catch (e) { } },
        persona,
        clientId: CLIENT_ID,
        narrationRate: NARRATION_RATE,
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
        setChatOpen: (v) => setChatOpen(v),
        setVoiceMode: (v) => { voiceModeRef.current = v },
        setMessages: (v) => setMessages(v),
        setBalance: (text, label) => { setBalanceText(text); setBalanceLabel(label) },
        refreshBalance: () => refreshBalance(),
        setGrowthLabel: (v) => setGrowthLabel(v),
        setLang: (l) => setLang(l),
        voice: () => bridge.get(),
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
                else showBubble('语音待命：开（本鲸听着呢）', 2500)
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

      // 动作分发：先关菜单，再交给动作表；未注册的动作给一句兜底提示
      async function runAction(action: string): Promise<void> {
        setMenu(null)
        const ok = await actions.run(action, actionHost)
        if (!ok) showBubble('这个功能小鲸还在学，稍后加上～')
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
        narrationRate: NARRATION_RATE,
        bubble: (text, ms) => showBubble(text, ms),
        say: (text, ms, opts) => sayLine(text, ms, opts),
        speak: (text, opts) => speakText(text, opts),
        narrate: setNarrating,
        clearNarrate: clearNarrating,
        talkFor: (ms) => { try { animRef.current?.talkFor(ms) } catch (e) { } },
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
        bubble: (text, ms) => showBubble(text, ms),
        say: (text, ms, voiceOpts) => sayLine(text, ms, voiceOpts),
        speak: (text, opts) => speakText(text, opts),
        speakReply: (text) => speakReply(text),
        stopSpeak: () => stopTts(),
        talkFor: (ms) => { try { animRef.current?.talkFor(ms) } catch (e) { } },
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
        narrationRate: NARRATION_RATE,
        route: (text) => localRouter.route(text),
        replyDeduper,
        recordChatLatency: (ms) => { try { latDiag.chatMs = ms; latDiag.updates++ } catch (e) { } },
      })
      // 旧调用点名称保留（拖放 / 语音 / 调试口都调 sendText）
      function sendText(rawText: string, opts?: { voice?: boolean }): Promise<void> {
        return chat.send(rawText, opts)
      }

      // 调试口：控制台输入 __chubbyWhale.say("你好呀") 可直接测「对话 + 朗读」链路（不经过麦克风）
      R.useEffect(() => {
        try {
          const w: any = (window as any).__chubbyWhale || ((window as any).__chubbyWhale = {})
          w.say = (t: string) => { try { sendText(String(t || ""), { voice: true }) } catch (e) { } }
          w.sayStop = () => { try { stopTts() } catch (e) { } }
          w.busyNow = () => ({ busy: busyLock.isBusy(), age: busyLock.age(), tts: ttsPlaying })
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
          if (v && v.speak && !v.speaking()) v.speak(text, { rate: (voiceOpts && voiceOpts.rate) || '+0%', pitch: (voiceOpts && voiceOpts.pitch) || '' })
        } catch (e) { }
      }
      /** 统一的回复朗读入口：长回复走叙述语速，同一句回复 30 秒内不重复念 */
      function speakReply(text: string): void {
        const rp = String(text || '')
        if (!rp.trim()) return
        // 同一句回复 30 秒内不重复念（client/text.ts 的 deduper，重复时计数 dupReply）
        if (!replyDeduper.allow(rp)) return
        speakText(rp, { rate: rp.length >= 80 ? NARRATION_RATE : '+0%' })
      }

      // Canvas 动画
      R.useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        animRef.current = createAnimator({ canvas, imgSrc: '/api/chubby-whale/asset', cw: CW, ch: CH, sx: SX, sy: SY, state: talkRef.current })
        animRef.current.start()
        return () => animRef.current?.stop()
      }, [])

      // ===== 渲染 =====
      function renderItems(items: any[]): any[] {
        const out: any[] = []
        for (let i = 0; i < items.length; i++) {
          const it = items[i]
          if (it.type === 'sep') {
            out.push(h('div', { key: 'sep' + i, style: { height: 1, background: '#1f4a85', margin: '4px 0' } }))
            continue
          }
          if (it.type === 'sub') {
            const open = subOpen === it.label
            out.push(h('div', {
              key: 'sub' + i,
              style: { padding: '6px 14px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', color: '#cfe9ff', fontSize: 13 },
              onClick: () => setSubOpen(open ? '' : it.label),
            }, h('span', null, tr(it.label, lang)), h('span', null, open ? '▾' : '▸')))
            if (open) out.push(h('div', { key: 'subitems' + i, style: { paddingLeft: 14, borderLeft: '1px solid #1f4a85', marginLeft: 8 } }, renderItems(it.items)))
            continue
          }
          out.push(h('div', {
            key: 'item' + i,
            style: { padding: '6px 14px', cursor: 'pointer', color: '#cfe9ff', fontSize: 13, whiteSpace: 'nowrap' },
            onClick: () => runAction(it.action),
          }, tr(it.label, lang)))
        }
        return out
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
        menu ? h('div', { style: menuStyle(menu), 'data-menu-root': '1' },
          h('div', { style: { padding: '8px 14px', borderBottom: '1px solid #1f4a85', color: '#9FD8FF', fontSize: 12, display: 'flex', justifyContent: 'space-between' } },
            // 标题栏：左边「名字 · 版本号」，右边余额（点一下刷新）；菜单最下面仍按规矩显示版本号
            h('span', null, (lang === 'en' ? 'Fat Whale · v' : '肥鲸 · v') + VERSION),
            h('span', {
              style: { color: '#FFD166', cursor: 'pointer' },
              title: lang === 'en' ? 'Click to refresh balance' : '点一下刷新余额',
              onClick: () => { try { refreshBalance() } catch (e) { } },
            }, balanceText || '--'),
          ),
          renderItems(buildMenu(VERSION, { voiceOn: voiceOn, earOn: earOn, voiceChatOn: voiceChatOn, chatCacheOn: chatCacheOn, ttsVoice: (() => { try { return localStorage.getItem('chubby-tts-voice') || 'zh-CN-XiaoyiNeural' } catch (e) { return 'zh-CN-XiaoyiNeural' } })(), chatLang: (() => { try { return localStorage.getItem('chubby-chatlang') || 'auto' } catch (e) { return 'auto' } })(), balance: balanceLabel, growth: growthLabel })),
        ) : null,
        h('div', { style: chatPanelStyle(chatOpen) },
          h('div', { style: headStyle },
            h('span', null, lang === 'en' ? 'Fat Whale · Chat' : '肥鲸 · 聊天'),
            h('span', { style: { cursor: 'pointer', color: '#9FD8FF', padding: '0 4px' }, onClick: () => setChatOpen(false) }, '✕'),
          ),
          h('div', { ref: bodyRef, style: bodyStyle },
            messages.length === 0
              ? h('div', { style: msgStyle('fish') }, '主人，点我说话，本鲸在右下角待着～')
              : messages.map((m: any, i: number) => h('div', { key: i, style: msgStyle(m.who) }, m.text)),
          ),
          h('div', { style: inputRowStyle },
            h('input', {
              style: inputStyle, placeholder: lang === 'en' ? 'Say something…' : '跟肥鲸说两句…', value: input,
              onChange: (e: any) => setInput(e.target.value),
              onKeyDown: (e: any) => {
                // 中文输入法选词时按回车不算发送（isComposing 期间放行给输入法）
                if (e.nativeEvent && e.nativeEvent.isComposing) return
                if (e.key === 'Enter' && input.trim()) { sendText(input); setInput('') }
              },
            }),
            h('button', { style: sendStyle, onClick: () => { if (input.trim()) sendText(input); setInput('') } }, busy ? '…' : (lang === 'en' ? 'Send' : '发送')),
          ),
        ),
      )
    }

    return {
      name: 'dsh-chubby-whale-client',
      inject: ['slots'],
      apply(ctx: any) {
        // 诊断对象：出问题时在浏览器控制台输入 __chubbyWhale 就能看到卡在哪一步
        const diag: any = (window as any).__chubbyWhale = {
          version: VERSION, applied: true, hasCtx: !!ctx, hasSlots: !!(ctx && ctx.slots), lat: latDiag,
          ch: { mic: channels.mic.stats, asr: channels.asr.stats, speak: channels.speak.stats },
          registered: false, error: null,
        }
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
