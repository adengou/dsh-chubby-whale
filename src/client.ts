/**
 * dsh-chubby-whale —— 浏览器端入口（模块化组装）
 * 依赖模块：client/styles.ts（样式）、client/menu.ts（菜单）、client/anim.ts（动画）
 */
import { W, H, CW, CH, SX, SY, VERSION, stageStyle, canvasStyle, menuStyle, chatPanelStyle, headStyle, bodyStyle, inputRowStyle, inputStyle, sendStyle, msgStyle } from './client/styles.js'
import { buildMenu, tr } from './client/menu.js'
import { handleFileDrop, VISION_PROMPT } from './client/dropzone.js'
import { createAnimator } from './client/anim.js'
import { createVoice } from './client/voice.js'
import { createPersona } from './client/persona.js'
import { detectIntent } from './client/intent.js'
import { parseSseBuffer } from './shared/sse.js'
import { splitTtsSegments, normalizeRate, cleanTtsText } from './shared/tts.js'
import { parseDue, cleanReminderText } from './shared/time.js'
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
    let chatEpoch = 0
    let asrBusy = false
    let asrBusyAt = 0   // 识别位占用的起始时刻（用于僵尸复位与状态显示）
    // 叙述语速（与 voice.ts 同源，localStorage 可调，默认 -25%）
    const NARRATION_RATE = (() => { try { const s = localStorage.getItem('chubby-narration-rate'); return (s && /^[+-]\\d{1,2}%$/.test(s)) ? s : '-25%' } catch (e) { return '-25%' } })()
    const storyNarratingRef = { current: false }
    const persona = createPersona()
    let lastLineNorm = ''   // 人设台词去重：上一句台词的规范化文本
    let lastLineAt = 0
    let greetedOnce = false   // 打招呼只打一次（防挂载重复）
    let lastReplyText = ''   // 输出侧去重：上一句回复（30 秒窗口）
    let lastReplyAt = 0   // 饭团人设：情绪状态机 + 台词库（data/persona.json）
    const latDiag: any = { asrMs: 0, chatMs: 0, firstAudioMs: 0, totalMs: 0, updates: 0 }
    // 音符表：覆盖 C3–E6（含升降号），与 data/melodies.json 实际用到的音名对齐
    /** 民间故事标题在 culture 路由里是「书名·标题」拼一起的：拆开还原 C# TaleBubble 的拼法 */
    function taleParts(rawTitle: string): { title: string; book: string } {
      const t = String(rawTitle || '').trim()
      const i = t.indexOf('·')
      if (i > 0 && i < t.length - 1) return { book: t.slice(0, i), title: t.slice(i + 1) }
      return { title: t, book: '' }
    }
    /** 正文换行/连续空白压成单空格（照 C# Culture.Collapse） */
    function collapseText(raw: any): string {
      return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim()
    }
    const NOTE_FREQ: any = {
      'C3': 130.81, 'C#3': 138.59, 'D3': 146.83, 'D#3': 155.56, 'E3': 164.81, 'F3': 174.61,
      'F#3': 185.00, 'G3': 196.00, 'G#3': 207.65, 'A3': 220.00, 'A#3': 233.08, 'B3': 246.94,
      'C4': 261.63, 'C#4': 277.18, 'D4': 293.66, 'D#4': 311.13, 'E4': 329.63, 'F4': 349.23,
      'F#4': 369.99, 'G4': 392.00, 'G#4': 415.30, 'A4': 440.00, 'A#4': 466.16, 'B4': 493.88,
      'C5': 523.25, 'C#5': 554.37, 'D5': 587.33, 'D#5': 622.25, 'E5': 659.25, 'F5': 698.46,
      'F#5': 739.99, 'G5': 783.99, 'G#5': 830.61, 'A5': 880.00, 'A#5': 932.33, 'B5': 987.77,
      'C6': 1046.50, 'C#6': 1108.73, 'D6': 1174.66, 'D#6': 1244.51, 'E6': 1318.51,
    }
    let melodyCtx: any = null
    let melodyOscs: any[] = []
    function stopMelody(): void {
      try { for (const o of melodyOscs) { try { o.stop() } catch (e) { } } } catch (e) { }
      melodyOscs = []
      try { if (melodyCtx) { melodyCtx.close() } } catch (e) { }
      melodyCtx = null
      }

      function playMelody(notes: any[], bpm: number, onDone?: () => void): void {
      try {
        stopMelody()
        const AC = (window as any).AudioContext || (window as any).webkitAudioContext
        if (!AC) return
        const ctx = new AC()
        melodyCtx = ctx
        try { ctx.resume() } catch (e) { }
      // 显式等上下文真正跑起来：suspended 状态下排程的音符会被吞，听感就是"开头没弹"
      try { if (ctx.state === 'suspended') ctx.resume() } catch (e) { }
        const beat = 60 / Math.max(60, bpm || 100)
        let t = ctx.currentTime + 0.05
        for (const pair of notes) {
          const nm = String(pair[0])
          const dur = Number(pair[1]) || 1
          const f = NOTE_FREQ[nm]
          if (!f) { t += dur * beat; continue }
          const o = ctx.createOscillator()
          const g = ctx.createGain()
          o.frequency.value = f
          o.type = 'sine'
          g.gain.setValueAtTime(0.3, t)
          g.gain.exponentialRampToValueAtTime(0.001, t + dur * beat * 0.95)
          o.connect(g)
          g.connect(ctx.destination)
          o.start(t)
          o.stop(t + dur * beat)
          melodyOscs.push(o)
          t += dur * beat
        }
        // 全部音符播完的时刻 = 当前累计时间 t（AudioContext 时间轴）
        const totalMs = Math.max(0, (t - ctx.currentTime) * 1000) + 300
        if (onDone) setTimeout(() => { try { onDone() } catch (e) { } }, totalMs)
      } catch (e) { }
    }

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
        fetch('/api/chubby-whale/cache-toggle').then((r: any) => r.json()).then((d: any) => {
          if (d && typeof d.enabled === 'boolean') { chatCacheOnRef.current = d.enabled; setChatCacheOn(d.enabled) }
        }).catch(() => { })
      }, [])
      const [growthLabel, setGrowthLabel] = R.useState('--')
      const WAKE_WORDS = ['大肥鱼', '肥鲸', '肥鱼', '小鱼', '蓝鱼', '小蓝鱼', '鱼鱼', '肥肥']
      const dragRef = R.useRef({ dragging: false, lastX: 0, lastY: 0, vx: 0, vy: 0, moved: 0 })
      const scaleRef = R.useRef(1)
      const animRef = R.useRef(null as any)
      const storyBusyRef = R.useRef(false)
      // 最近一次说书的书名（「从头讲这本书」要按它重置进度）
      const storyBookRef = R.useRef('')
    const storyAutoRef = R.useRef(false)   // 点播讲故事：自动连播到"这一回讲完"
      const dueQueueRef = R.useRef([] as any[])
      const dueTimerRef = R.useRef(null as any)

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
      const busyRef = R.useRef(false)
      const busyAtRef = R.useRef(0)
      busyRef.current = busy   // 供定时器读取最新值（闭包里的 busy 会是旧值）
      const bodyRef = R.useRef(null)
      const bubbleRef = R.useRef(null)
      const bubbleTextRef = R.useRef(null)

      // 样式注入（气泡三角）
      R.useEffect(() => {
        try {
          if (!(document as any).getElementById('chubby-whale-style')) {
            const st = (document as any).createElement('style')
            st.id = 'chubby-whale-style'
            st.textContent = '.chubby-bubble{position:fixed;z-index:10002;max-width:320px;white-space:pre-wrap;opacity:0;background:#fff;color:#17325a;border-radius:14px;padding:10px 14px;font:13px/1.6 "Microsoft YaHei",sans-serif;box-shadow:0 8px 20px rgba(0,0,0,0.35);transition:opacity .2s;pointer-events:none;}' +
              '.chubby-bubble::after{content:"";position:absolute;left:50%;margin-left:-9px;bottom:-9px;border-left:9px solid transparent;border-right:9px solid transparent;border-top:10px solid #fff;}' +
              '.chubby-bubble.show{opacity:1;}'
            ;(document as any).head.appendChild(st)
          }
        } catch { }
      }, [])

      // 位置
      R.useEffect(() => {
        let saved: any = null
        try {
          const raw = localStorage.getItem('chubby-whale-pos')
          if (raw) saved = JSON.parse(raw)
        } catch { }
        const init = saved && typeof saved.x === 'number' ? saved : { x: Math.max(0, window.innerWidth - 24 - W), y: Math.max(0, window.innerHeight - 150 - H) }
        posRef.current = init
        applyPos(init.x, init.y)
      }, [])

      function applyPos(x: number, y: number): void {
        const el = stageRef.current
        if (!el) return
        // 缩放后实际占位是 W*scale / H*scale：窗口缩小时也要把整只鱼留在可视区里
        const s = scaleRef.current || 1
        const w = W * s
        const h = H * s
        x = Math.max(0, Math.min(window.innerWidth - w, x))
        y = Math.max(0, Math.min(window.innerHeight - h, y))
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
        applyPos(window.innerWidth - 24 - W, window.innerHeight - 150 - H)
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
          try {
            if (dueTimerRef.current) { clearTimeout(dueTimerRef.current); dueTimerRef.current = null }
          } catch { }
          dueQueueRef.current = []
          stopTts()
          stopMelody()
          try {
            const el = bubbleRef.current
            if (el && el._t) { clearTimeout(el._t); el._t = null }
          } catch { }
        }
      }, [])

      // 气泡
      function showBubble(text: string, ms = 2400): void {
        const el = bubbleRef.current
        if (!el) return
        const p = posRef.current
        el.style.left = (p.x + W / 2) + 'px'
        el.style.transform = 'translateX(-50%)'
        el.style.top = 'auto'
        el.style.right = 'auto'
        el.style.bottom = Math.max(70, window.innerHeight - p.y + 12) + 'px'
        if (bubbleTextRef.current) bubbleTextRef.current.textContent = text
        el.classList.add('show')
        clearTimeout(el._t)
        el._t = setTimeout(() => { el.classList.remove('show'); try { restoreIdleStatus() } catch (e) { } }, ms)
      }
      // ===== 状态提示（已按主人要求去掉）=====
      // 原来闲时一直挂「在听…」，还出现过"讲着话却显示在听"的矛盾。
      // 现在不主动显示任何状态字：只听/只在真正有内容时冒气泡（听到、回复、念完…）。
      function setStatus(): void {
        try {
          const el = bubbleRef.current
          if (!el) return
          const txt = bubbleTextRef.current ? String(bubbleTextRef.current.textContent || "") : ""
          // 只有气泡里现在是纯状态字时才收起，别把正常消息一起抹掉
          if (txt === "在听…" || txt === "在想…" || txt === "识别中…" || txt === "在说…") {
            el.classList.remove("show")
            clearTimeout(el._t)
            el._t = null
          }
        } catch (e) { }
      }
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
        const d = dragRef.current
        d.dragging = true
        d.lastX = e.clientX; d.lastY = e.clientY
        d.vx = 0; d.vy = 0; d.moved = 0
        d.baseX = posRef.current.x; d.baseY = posRef.current.y
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
        const dx = e.clientX - d.lastX, dy = e.clientY - d.lastY
        d.vx = dx; d.vy = dy
        d.moved += Math.abs(dx) + Math.abs(dy)
        d.lastX = e.clientX; d.lastY = e.clientY
        applyPos(posRef.current.x + dx, posRef.current.y + dy)
      }
      function onPointerUp(): void {
        const d = dragRef.current
        if (!d.dragging) return
        d.dragging = false
        // 恢复滤镜，并把 transform 位移提交成 left/top（否则鱼停在原位）
        try { const el = stageRef.current; if (el && el.style) { el.style.filter = ""; el.style.willChange = "" } } catch (e2) { }
        applyPos(posRef.current.x, posRef.current.y)
        savePos()
        let vx = Math.max(-14, Math.min(14, d.vx))
        let vy = Math.max(-14, Math.min(14, d.vy))
        const step = () => {
          if (dragRef.current.dragging) return
          vx *= 0.9; vy *= 0.9
          applyPos(posRef.current.x + vx, posRef.current.y + vy)
          if (Math.abs(vx) < 0.2 && Math.abs(vy) < 0.2) { savePos(); return }
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
            if (busyRef.current && Date.now() - busyAtRef.current > 35000) {
              busyAtRef.current = Date.now(); setBusy(false); busyRef.current = false
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
        fetch('/api/chubby-whale/growth').then((r: any) => r.json()).then((d: any) => {
          if (d && d.ok) setGrowthLabel(d.stage + '（' + d.exp + '）')
        }).catch(() => { })
      }

      /** 拉实时余额，并把菜单标题与「余额：…」一起更新；没配 Key 时明确说出来 */
      function refreshBalance(): void {
        fetch('/api/chubby-whale/balance', { cache: 'no-store' })
          .then((r: any) => r.json())
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

      // ===== 说书（连载）=====
      function playStoryPiece(d: any): void {
        const text = String(d.text || '')
        if (d && d.book) storyBookRef.current = String(d.book)
        const head = '说书·《' + String(d.book || '') + '》' + (d.title ? '｜' + d.title : '')
        let voiceOff = false
        try { voiceOff = localStorage.getItem('chubby-voice') === 'off' } catch (e) { }
        // 头顶只显示状态：不把整段古文糊上来
        showBubble('正在讲《' + String(d.book || '') + '》' + (d.title ? '｜' + d.title : ''), 12000)
        animRef.current?.talkFor(8000)
        if (voiceOff) {
          storyBusyRef.current = false
            storyNarratingRef.current = false
          showBubble('正在讲《' + String(d.book || '') + '》' + (d.title ? '｜' + d.title : '') + '（语音朗读关着）', 12000)
          return
        }
        storyBusyRef.current = true
        storyNarratingRef.current = true
        speakText(text, {
          rate: normalizeRate(d.rate, NARRATION_RATE),
          onDone: () => {
            storyBusyRef.current = false
            storyNarratingRef.current = false
            if (storyAutoRef.current && d.isLast === false) { setTimeout(() => { try { nextStory() } catch (e) { } }, 800) } else { storyAutoRef.current = false; showBubble(d.isLast ? persona.line('poemDone') : '这段讲完啦～点菜单「接着说」听下一段', 6000) }
          },
        })
      }
      function startStory(hint: string): void {
        if (storyBusyRef.current) { showBubble('正讲着呢，听完这段再说～', 3000); return }
        const headers: any = CLIENT_ID ? { 'x-client-id': CLIENT_ID } : {}
        fetch('/api/chubby-whale/story/start' + (hint ? '?hint=' + encodeURIComponent(hint) : ''), { headers })
          .then((r: any) => r.json())
          .then((d: any) => {
            if (!d || !d.ok) { showBubble('说书没开成：' + ((d && d.error) || '没读到书'), 5000); return }
            playStoryPiece(d)
          })
          .catch(() => showBubble('说书连不上'))
      }
      function nextStory(): void {
        if (storyBusyRef.current) { showBubble('正讲着呢，听完这段再说～', 3000); return }
        const headers: any = CLIENT_ID ? { 'x-client-id': CLIENT_ID } : {}
        fetch('/api/chubby-whale/story/next', { headers })
          .then((r: any) => r.json())
          .then((d: any) => {
            if (!d || !d.ok) { showBubble('说书卡住了', 4000); return }
            if (d.done) { showBubble('一轮都讲完啦，本鱼从头再讲～', 5000); startStory(''); return }
            playStoryPiece(d)
          })
          .catch(() => showBubble('说书连不上'))
      }

      // ===== 到点提醒：多条排队，逐条显示 + 朗读，间隔 3 秒 =====
      function pumpDueReminders(): void {
        if (dueTimerRef.current) return
        if (dueQueueRef.current.length === 0) return
        // 提醒是低优先级：本鱼正在说/在想/在说书时排队等，绝不插队抢话筒
        if (ttsPlaying || storyNarratingRef.current || busy) {
          dueTimerRef.current = setTimeout(() => {
            dueTimerRef.current = null
            pumpDueReminders()
          }, 2000)
          return
        }
        const item = dueQueueRef.current.shift()
        // 照 C# FishForm：气泡与朗读都用「主人，提醒你：」+ 正文；正文为空兜底「时间到了」
        const body = String(item.text || '').trim() || '时间到了'
        const line = '主人，提醒你：' + body
        showBubble(line, 8000)
        animRef.current?.talkFor(3000)
        try { speakText(line) } catch (e) { }
        dueTimerRef.current = setTimeout(() => {
          dueTimerRef.current = null
          pumpDueReminders()
        }, 3000)
      }

      // 菜单动作（async：里面要用 await，比如剪贴板；onClick 直接调用即可）

      async function runAction(action: string): Promise<void> {
        setMenu(null)
        if (action === 'feed') { const r = persona.feed(); if (r.bowls % 8 === 0) { sayLine(persona.line('riceAccount'), 5000); try { fetch('/api/chubby-whale/pet?action=feed') } catch (e) { } ; return } sayLine(r.text + (r.stageUp ? '（' + r.stage + '）' : ''), r.stageUp ? 6000 : 3500); animRef.current?.pushHeart(); try { fetch('/api/chubby-whale/pet?action=feed') } catch (e) { } ; return }
        if (action === 'home') { homePos(); showBubble('回到角落啦'); return }
        if (action === 'bigger') { const s = Math.min(1.4, scale + 0.1); setScale(s); scaleRef.current = s; return }
        if (action === 'smaller') { const s = Math.max(0.7, scale - 0.1); setScale(s); scaleRef.current = s; return }
        if (action === 'hide') { setHidden(true); return }
        if (action === 'version') { showBubble('肥鲸 v' + VERSION); return }
        if (action === 'type') { voiceModeRef.current = false; setChatOpen(true); return }
        if (action === 'pause') { stopTts(); stopMelody(); showBubble('歇会儿…'); return }
        if (action === 'music-stop') { stopMelody(); showBubble('停下啦'); return }
        if (action === 'tts-stop') { stopTts(); showBubble('好，不说了'); return }
        if (action === 'fishfood') { fetch('/api/chubby-whale/fishfood').then((r: any) => r.json()).then((d: any) => { if (d && d.ok) { showBubble('鱼粮账本：聊天 ' + d.chatTokens + ' tokens，说书 ' + d.storyTokens + ' tokens，共 ' + d.total, 5000) } else showBubble('鱼粮查不到') }).catch(() => showBubble('鱼粮查不到')); return }
        if (action === 'growth') { Promise.all([fetch('/api/chubby-whale/growth').then((r: any) => r.json()), fetch('/api/chubby-whale/state').then((r: any) => r.json())]).then(([g, s]) => { if (g && g.ok) { const nx = g.nextExp > 0 ? ('（经验 ' + g.exp + '/' + g.nextExp + '）') : '（满级）'; const it = (s && s.intimacy) || 0; showBubble('成长：' + g.stage + nx + ' · 亲密度 ' + it + '/100', 5000) } else showBubble('成长查不到') }).catch(() => showBubble('成长查不到')); return }
        if (action === 'intimacy') {
          fetch('/api/chubby-whale/state').then((r: any) => r.json()).then((d: any) => { showBubble('亲密度：' + ((d && d.intimacy) || 0) + ' / 100') }).catch(() => showBubble('亲密度查不到'))
          return
        }
        if (action === 'culture-story') {
          startStory('')
          return
        }
        if (action === 'culture-story-next') {
          nextStory()
          return
        }
        if (action === 'story-reset') {
          // 「从头讲这本书」：按最近一次说过的书名清进度（后端会清该书全部 book|index）
          const book = storyBookRef.current
          if (!book) { showBubble('还没讲书呢', 3000); return }
          const headers: any = CLIENT_ID ? { 'x-client-id': CLIENT_ID } : {}
          fetch('/api/chubby-whale/story/reset?book=' + encodeURIComponent(book), { method: 'POST', headers })
            .then((r: any) => r.json())
            .then((d: any) => {
              if (!d || !d.ok) { showBubble('没重置成：' + ((d && d.error) || '接口没应'), 4000); return }
              storyBookRef.current = String(d.book || book)
              showBubble('这本书从头讲～', 3000)
            })
            .catch(() => showBubble('说书连不上'))
          return
        }
        if (action === 'poem') {
          fetch('/api/chubby-whale/poem').then((r: any) => r.json()).then((d: any) => {
            const p = (d && d.ok && d.item) ? d.item : null
            if (p) {
              const body = String(p.text || '')
              const author = String(p.author || '佚名')
              showBubble('念诗·' + p.title + '（' + author + '）', 15000)
              animRef.current?.talkFor(6000)
              const speech = '念首诗——' + p.title + '，' + (p.dynasty ? p.dynasty + '，' : '') + author + '。' + body.replace(/\n/g, '，')
            sayLine(persona.line('poemStart'), 4000); setTimeout(() => { try { speakText(speech, { rate: NARRATION_RATE, onDone: () => sayLine(persona.line('poemDone'), 6000) }) } catch (e) { } }, 600)
            } else showBubble('诗册没读到')
          }).catch(() => showBubble('诗册没读到'))
          return
        }
        if (action === 'culture-tale') {
          fetch('/api/chubby-whale/culture?type=minsu').then((r: any) => r.json()).then((d: any) => {
            if (d && d.ok && d.item) {
              // 照 C# Culture.TaleBubble：民间故事·标题（出自《书》）：前 120 字，只有真超长才加「…」
              const tp = taleParts(d.item.title)
              const body = collapseText(d.item.text)
              const cut = body.length > 120
              const shown = cut ? body.slice(0, 120) + '…' : body
              showBubble('讲民间故事·' + tp.title + (tp.book ? '（出自《' + tp.book + '》）' : ''), 9000)
              animRef.current?.talkFor(5000)
              // 照 C# Culture.TaleSpeech：标题 + 出处 + 整篇（超 6000 字才截），叙述一律 -15%
              speakText('讲个民间故事——' + tp.title + (tp.book ? '，出自《' + tp.book + '》' : '') + '。' + body.slice(0, 6000), { rate: NARRATION_RATE, onDone: () => { showBubble('故事讲完啦～', 5000); try { speakText('讲完啦～') } catch (e) { } } })
            } else showBubble('故事没讲成')
          }).catch(() => showBubble('故事没讲成'))
          return
        }
        if (action === 'culture-allusion') {
          fetch('/api/chubby-whale/culture?type=chengyu').then((r: any) => r.json()).then((d: any) => {
            if (d && d.ok && d.item) {
              // 气泡：《标题》（出处）：讲解 —— 不超长就不加省略号
              const body = collapseText(d.item.text)
              const cut = body.length > 100
              showBubble('讲典故·' + d.item.title + '（' + (d.item.src || '') + '）', 9000)
              animRef.current?.talkFor(5000)
              speakText('讲个典故——' + String(d.item.title || '') + '，出自' + String(d.item.src || '') + '。' + body, { rate: NARRATION_RATE, onDone: () => { showBubble('典故讲完啦～', 5000); try { speakText('讲完啦～') } catch (e) { } } })
            } else showBubble('典故没讲成')
          }).catch(() => showBubble('典故没讲成'))
          return
        }
        if (action === 'culture-idiom') {
          fetch('/api/chubby-whale/culture?type=idiom').then((r: any) => r.json()).then((d: any) => {
            if (d && d.ok && d.item) {
              showBubble('成语辨析·' + d.item.title, 8000)
              const sp = String(d.item.title || '') + '：' + String(d.item.text || '')
              // 成语辨析属叙述：一律 -15%，不再按长度改语速
              speakText(sp, { rate: NARRATION_RATE, onDone: () => { showBubble('这个成语讲完啦～', 5000); try { speakText('讲完啦～') } catch (e) { } } })
            } else showBubble('没查到')
          }).catch(() => showBubble('没查到'))
          return
        }
        if (action === 'culture-couplet') {
          showBubble('对联小鲸还在整理，回头给你出一对～')
          return
        }
        if (action.startsWith('music:')) {
          const name = action.slice(6)
          // 弹琴前先停朗读（C#：if (Speech.IsSpeaking) Speech.Stop()）
          stopTts()
          fetch('/api/chubby-whale/melody?name=' + encodeURIComponent(name)).then((r: any) => r.json()).then((d: any) => {
            if (d && d.ok && d.song) {
              const songName = String(d.song.name || '这首曲子')
              const bpm = Number(d.song.bpm) || 100
              const notes = d.song.notes || []
              // 预估时长：所有时值之和 × 拍长，用来在开始时就告诉主人大概多久
              let beats = 0
              for (const pair of notes) beats += Number(pair[1]) || 1
              const estSec = Math.round(beats * (60 / Math.max(60, bpm)) * 10) / 10
              showBubble('弹《' + songName + '》♪（约 ' + estSec + ' 秒）', 6000)
              playMelody(notes, bpm, () => {
                showBubble('弹完啦～《' + songName + '》', 6000)
                animRef.current?.talkFor(1500)
                try {
                  (window as any).__chubbyWhale.melodyVoice = { at: Date.now(), requested: true, ok: false, err: '' }
                  speakText('弹完啦～')
                  // 300ms 后还没进入播放就记一笔（供主人用 __chubbyWhale.melodyVoice 自查）
                  setTimeout(() => {
                    try {
                      const d = (window as any).__chubbyWhale.melodyVoice
              if (d && !ttsPlaying) d.err = 'TTS 未开始（可能被浏览器拦或合成失败）'
                    } catch (e) { }
                  }, 1200)
                } catch (e: any) { try { (window as any).__chubbyWhale.melodyVoice = { requested: false, err: String(e) } } catch (e2) { } }
              })
            } else showBubble('这首曲子没找到')
          }).catch(() => showBubble('弹琴失败'))
          return
        }
        if (action === 'endpoint') {
          // 端点检测模式切换：经典（默认）/ 自适应（APE）
          try {
            const cur = (() => { try { return localStorage.getItem('chubby-endpoint') === 'ape' ? 'ape' : 'classic' } catch (e) { return 'classic' } })()
            const next = cur === 'ape' ? 'classic' : 'ape'
            localStorage.setItem('chubby-endpoint', next)
            if (voiceRef.current && voiceRef.current.setEndpointMode) voiceRef.current.setEndpointMode(next)
            showBubble(next === 'ape' ? '端点检测：自适应（试用）' : '端点检测：经典（稳定）', 4000)
          } catch (e) { showBubble('切换失败', 3000) }
          return
        }
        if (action === 'ear-check') {
          // 语音自检：直接读新语音模块（client/voice.ts）的统计，不用开控制台
          try {
            const v: any = (window as any).__chubbyWhale && (window as any).__chubbyWhale.voice
            const st: any = v ? v.stats : null
            if (!st) { showBubble('语音模块还没起来（语音待命可能是关的）', 6000); return }
            const line = '语音自检（新模块）：' + String(v.status())
              + '\n录音段 ' + st.windows + '｜上传 ' + st.uploaded + '｜识别出字 ' + st.asrTexts + '｜交给对话 ' + st.heard
              + '\n丢：太安静 ' + st.skippedSilent + '｜回声/重复 ' + st.echoDropped + '｜识别失败 ' + st.asrFail
              + '\n去重：重复丢弃 ' + (st.dupDropped || 0) + ' 次（同一句话被切成两段时用）'
              + '\n端点检测：' + ((voiceRef.current && voiceRef.current.endpointInfo) ? (voiceRef.current.endpointInfo().mode === 'ape' ? '自适应' : '经典') : '?')
              + (function () { try { const t = voiceRef.current && voiceRef.current.lastTtsInfo ? voiceRef.current.lastTtsInfo() : null; if (!t) return ''; return '\n朗读：最后一段 ' + (t.failed ? '失败' : '已开播') + '｜文本开头「' + t.text + '」' } catch (e) { return '' } })()
              + (function () { try { const s = voiceRef.current && voiceRef.current.lastSegment ? voiceRef.current.lastSegment() : null; if (!s) return ''; return '\n上一段：' + s.mode + '｜窗口 ' + s.winMs + 'ms｜说话 ' + s.peMs + 'ms｜静音 ' + s.quMs + 'ms' + (s.floor !== null ? '｜底噪 ' + s.floor + 'dB' : '') + (s.target ? '｜目标 ' + s.target + 'ms' : '') + '\n识别结果：' + s.text } catch (e) { return '' } })()
              + '\n朗读：请求 ' + st.ttsRequests + '｜开播 ' + st.ttsPlayed + '｜失败 ' + st.ttsFail + '｜僵尸复位 ' + st.ttsZombie
              + (st.lastError ? '\n最近错误：' + st.lastError : '')
            showBubble(line, 15000)
            try { navigator.clipboard.writeText(JSON.stringify(st)) } catch (e) { }
          } catch (e: any) { showBubble('自检失败：' + String(e && e.message), 5000) }
          return
        }
        if (action === 'chatmode') {
          // 语音聊天：只决定识别到的话要不要送给模型
          const nowOn = !voiceChatOnRef.current
          voiceChatOnRef.current = nowOn
          setVoiceChatOn(nowOn)
          try { localStorage.setItem('chubby-voicechat', nowOn ? 'on' : 'off') } catch (e) { }
          showBubble(nowOn ? '语音聊天：开，本鲸会接话' : '语音聊天：关，只听不接话')
          return
        }
        if (action === 'voice') {
          const nowOn = !voiceOnRef.current
          voiceOnRef.current = nowOn
          setVoiceOn(nowOn)
          try { localStorage.setItem('chubby-voice', nowOn ? 'on' : 'off') } catch (e) { }
          if (!nowOn) stopTts()
          showBubble(nowOn ? '语音朗读：开' : '语音朗读：关（省着点用）')
          return
        }        if (action === 'cache-clear') {
          fetch('/api/chubby-whale/cache', { method: 'DELETE' })
            .then((r: any) => r.json())
            .then((d: any) => showBubble(d && d.ok ? ('聊天缓存清空啦（' + (d.cleared || 0) + ' 条）') : '缓存清空失败', 5000))
            .catch(() => showBubble('缓存清空失败', 4000))
          return
        }
        if (action === 'cache-toggle') {
          const nowOn = !chatCacheOnRef.current
          chatCacheOnRef.current = nowOn
          setChatCacheOn(nowOn)
          fetch('/api/chubby-whale/cache-toggle', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: nowOn }),
          }).then((r: any) => r.json()).then((d: any) => {
            showBubble(d && d.ok ? ('聊天缓存：' + (d.enabled ? '开（省 token）' : '关（每次重新回答）')) : '切换失败', 5000)
          }).catch(() => showBubble('切换失败', 4000))
          return
        }        if (action === 'clear-memory') {
          try {
            if (!(window as any).confirm('清除肥鲸对主人的聊天记忆？（成长/鱼粮/说书记录不受影响）')) return
            fetch('/api/chubby-whale/clear-memory', { method: 'POST' }).then((r: any) => r.json()).then((d: any) => {
              if (d && d.ok) { setMessages([]); showBubble('记忆清空啦，我们重新认识吧～', 4000) }
              else showBubble('清除失败')
            }).catch(() => showBubble('清除失败'))
          } catch (e) { }
          return
        }        if (action === 'balance') {
          fetch('/api/chubby-whale/balance').then((r: any) => r.json()).then((d: any) => {
            if (d && d.ok && d.balance != null) {
              setBalanceText('余额 ¥' + d.balance)
              setBalanceLabel('¥' + d.balance)
              showBubble('余额还有 ' + d.balance + ' 元', 5000)
            } else showBubble('余额查不到')
          }).catch(() => showBubble('余额查不到'))
          return
        }
        if (action === 'chat-lang:auto' || action === 'chat-lang:zh' || action === 'chat-lang:en') {
          const cl = action === 'chat-lang:en' ? 'en' : (action === 'chat-lang:zh' ? 'zh' : 'auto')
          try { localStorage.setItem('chubby-chatlang', cl) } catch { }
          showBubble(cl === 'en' ? '聊天语言：English' : '聊天语言：中文')
          return
        }        if (action === 'lang:zh' || action === 'lang:en') {
          const l = action === 'lang:en' ? 'en' : 'zh'
          try { localStorage.setItem('chubby-lang', l) } catch { }
          setLang(l)
          showBubble(l === 'en' ? 'Language: English' : '界面语言：中文')
          return
        }        if (action === 'vision') {
          try {
            const input = (document as any).createElement('input')
            input.type = 'file'
            input.accept = 'image/*'
            input.onchange = async () => {
              try {
                const file = input.files && input.files[0]
                if (!file) return
                if (file.size > 4 * 1024 * 1024) { showBubble('图片太大（超过 4MB）', 4000); return }
                const b64 = await new Promise<string>((resolve) => {
                  const fr = new FileReader()
                  fr.onloadend = () => { const s = String(fr.result || ''); resolve(s.indexOf(',') >= 0 ? s.slice(s.indexOf(',') + 1) : s) }
                  fr.readAsDataURL(file)
                })
                showBubble('本鲸看看这张图…', 3000)
                setChatOpen(false)
                const hdr = file.type || 'image/jpeg'
                const tChat = performance.now()
          const res = await fetch('/api/chubby-whale/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: VISION_PROMPT, image: b64, imageMime: hdr }) })
                const d = await res.json()
                const reply = (d && d.reply) || '这条鱼看不懂这张图……'
                showBubble('（看图）' + reply, 10000)
                // 聊天回复：长回复（≥80 字）按叙述 -15%，短句正常语速
                speakReply(reply)
              } catch (e) { showBubble('图片处理失败', 4000) }
            }
            input.click()
          } catch (e) { showBubble('打不开文件选择', 4000) }
          return
        }        if (action === 'test-tts') {
          showBubble('测试语音：主人听得到吗？', 4000)
          speakText('测试语音，主人听得到吗？')
          return
        }        if (action.startsWith('voice:')) {
          const v = action.slice(6)
          try { localStorage.setItem('chubby-tts-voice', v) } catch { }
          // 「自动」没有第三段音色名，别把 undefined 冒给主人看
          const shown = v === 'auto' ? '自动' : (v.split('-')[2] || v)
          showBubble('音色换好啦：' + shown)
          try { const u = new (window as any).SpeechSynthesisUtterance('主人，这个声音好听吗？'); (window as any).speechSynthesis.cancel(); (window as any).speechSynthesis.speak(u) } catch (e) { }
          return
        }        if (action === 'remind-add') {
          // 照 C# Reminders.cs 的 ParseDue：一句话里就能带时间（明天9点 / 半小时后 / 每天9点…）
          const msg = (window as any).prompt('提醒什么？（可以一起说时间，如「明天9点提醒我开会」）')
          if (!msg) return
          let parsed = parseDue(msg)
          if (!parsed) {
            const ans = (window as any).prompt('什么时候提醒？（如 9点 / 明天9点 / 半小时后 / 20分钟后 / 每天9点）', '5分钟后')
            if (!ans) return
            parsed = parseDue(ans)
            if (!parsed) { showBubble('这个时间本鱼没听懂……试试「9点」「明天9点」「半小时后」', 5000); return }
          }
          const text = String(parsed.cleaned || cleanReminderText(msg) || msg).slice(0, 200)
          const dueAt = parsed.at
          const repeat = parsed.repeat || 0
          fetch('/api/chubby-whale/reminders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, at: dueAt.toISOString(), repeat }) })
            .then((r: any) => r.json()).then((d: any) => {
              if (d && d.ok) {
                const hh = String(dueAt.getHours()).padStart(2, '0')
                const mm = String(dueAt.getMinutes()).padStart(2, '0')
                const whenText = repeat > 0 ? ('每天 ' + hh + ':' + mm) : ((dueAt.getMonth() + 1) + '月' + dueAt.getDate() + '日 ' + hh + ':' + mm)
                showBubble('好，' + whenText + ' 提醒你：' + text, 6000)
              } else showBubble('提醒没加上')
            })
            .catch(() => showBubble('提醒没加上'))
          return
        }
        if (action === 'remind-list') {
          fetch('/api/chubby-whale/reminders').then((r: any) => r.json()).then((d: any) => {
            const arr = (d && d.reminders) || []
            if (!arr.length) { showBubble('还没有提醒～'); return }
            const txt = arr.map((x: any) => {
              const when = new Date(x.nextAt || x.at)
              const stamp = isNaN(when.getTime()) ? String(x.at) : when.toLocaleString('zh-CN')
              const rep = Number(x.repeat) > 0 ? '（每天）' : ''
              return '· ' + x.text + '（' + stamp + '）' + rep
            }).join('\n')
            showBubble(txt, 8000)
          }).catch(() => showBubble('提醒清单查不到'))
          return
        }        showBubble('这个功能小鲸还在学，稍后加上～')
      }

      // 聊天
      function scrollBody(): void {
        setTimeout(() => {
          const el = bodyRef.current
          if (el) el.scrollTop = el.scrollHeight
        }, 0)
      }
      // ===== 点播本地路由：讲故事 / 背诗 / 讲典故 直接读本地素材，不调模型（省 token、内容完整）=====
      // 点播路由：关键词与书名别名表已抽到 client/intent.ts（纯函数，npm test 覆盖）
      function tryLocalRoute(text: string): boolean {
        const hit = detectIntent(text)
        if (!hit) return false
        if (hit.kind === 'poem') {
          showBubble('（点播）好，念一首', 3000)
          fetch('/api/chubby-whale/poem').then((r: any) => r.json()).then((d: any) => {
            const p = (d && d.ok && d.item) ? d.item : null
            if (!p) { showBubble('诗册没读到', 4000); return }
            const body = String(p.text || '')
            showBubble('念诗·' + p.title + '（' + String(p.author || '佚名') + '）', 15000)
            const speech = '念首诗——' + p.title + '，' + (p.dynasty ? p.dynasty + '，' : '') + String(p.author || '佚名') + '。' + body.replace(/\n/g, '，')
            sayLine(persona.line('poemStart'), 4000)
            setTimeout(() => { try { speakText(speech, { rate: NARRATION_RATE, onDone: () => sayLine(persona.line('poemDone'), 6000) }) } catch (e) { } }, 600)
          }).catch(() => showBubble('诗册没读到', 4000))
          return true
        }
        if (hit.kind === 'culture') {
          const type = hit.sub
          showBubble(type === 'chengyu' ? '（点播）讲个成语' : '（点播）讲个典故', 3000)
          fetch('/api/chubby-whale/culture?type=' + type).then((r: any) => r.json()).then((d: any) => {
            const it = (d && d.ok && d.item) ? d.item : null
            if (!it) { showBubble('这个没读到', 4000); return }
            const body = collapseText(String(it.text || ''))
            showBubble((type === 'chengyu' ? '成语·' : '典故·') + String(it.title || ''), 15000)
            speakText((type === 'chengyu' ? '讲个成语——' : '讲个典故——') + String(it.title || '') + (it.src ? '，出自' + String(it.src) : '') + '。' + body, { rate: NARRATION_RATE })
          }).catch(() => showBubble('这个没读到', 4000))
          return true
        }
        const book = hit.book || ''
        showBubble('（点播）' + (book ? '讲《' + book + '》' : '讲一段书'), 4000)
        storyAutoRef.current = true
        startStory(book)
        return true
      }


      // ===== 流式对话：边生成边开口 =====
      // 传统路径要等整段生成完才合成语音；这里把模型吐出的文字按句切开立刻送朗读，
      // 首字延迟从「整段生成 + 首段合成」降到「首句生成 + 首段合成」。
      // 任何异常都在 4 秒内回退到普通 /chat，不影响可用性。
      async function tryStreamChat(text: string, opts?: { voice?: boolean }): Promise<boolean> {
        try { if (localStorage.getItem('chubby-stream') === 'off') return false } catch (e) { }
        let spokeAny = false
        let full = ''
        let tail = ''
        let ctl: any = null
        try { ctl = typeof AbortController !== 'undefined' ? new AbortController() : null } catch (e) { ctl = null }
        const firstTimer = setTimeout(() => { try { if (!spokeAny && ctl) ctl.abort() } catch (e) { } }, 4000)
        const startedAt = Date.now()
        let bubbleAt = 0

        const flush = (force: boolean): void => {
          if (!tail) return
          // 句末标点处先念；没标点就攒到 40 字（避免等太长）
          const m = tail.match(/[\s\S]*?[。！？!?；;\n]/)
          if (m && m[0].length >= 2) {
            const seg = m[0].trim()
            tail = tail.slice(m[0].length)
            if (seg) { try { speakText(seg, { rate: '+0%' }) } catch (e) { } ; spokeAny = true }
            return flush(false)
          }
          if (force || tail.length >= 40) {
            const seg = tail.trim()
            tail = ''
            if (seg) { try { speakText(seg, { rate: '+0%' }) } catch (e) { } ; spokeAny = true }
          }
        }

        try {
          const res = await fetch('/api/chubby-whale/chat-stream', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message: text, lang: 'zh', voice: !!(opts && opts.voice) }),
            signal: ctl ? ctl.signal : undefined,
          })
          if (!res.ok || !res.body) { clearTimeout(firstTimer); return false }
          const reader = res.body.getReader()
          const dec = new TextDecoder()
          let buf = ''
          setBusy(true)
          busyAtRef.current = Date.now()
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buf += dec.decode(value, { stream: true })
            const parsed = parseSseBuffer(buf)
            buf = parsed.rest
            for (const obj of parsed.events) {
              if (obj.error) { throw new Error(String(obj.error)) }
              if (typeof obj.delta === 'string' && obj.delta) {
                full += obj.delta
                tail += obj.delta
                clearTimeout(firstTimer)
                flush(false)
                const nowT = Date.now()
                if (nowT - bubbleAt > 400) { bubbleAt = nowT; showBubble(full.slice(-60), 3000) }
              }
              if (obj.done) {
                const reply = String(obj.reply || full || '').trim()
                full = reply || full
                if (reply) {
                  const rpPlain = reply.replace(/[\s。，！？,.!?、…~～]/g, '')
                  const now2 = Date.now()
                  const dup = lastReplyText && lastReplyAt && now2 - lastReplyAt < 30000 && rpPlain === lastReplyText
                  if (!dup) {
                    lastReplyText = rpPlain
                    lastReplyAt = now2
                    flush(true)
                    setBusy(false)
                    setMessages((m: any[]) => [...m, { who: 'fish', text: reply }])
                    showBubble(reply, 6000)
                    animRef.current?.talkFor(1500)
                    scrollBody()
                    try { (window as any).__chubbyWhale.lastChat = { stage: 'stream-done', firstDeltaMs: obj.firstDeltaMs || 0, ms: obj.ms || 0, cached: !!obj.cached, reply: reply.slice(0, 40) } } catch (e) { }
                  }
                }
                clearTimeout(firstTimer)
                return true
              }
            }
          }
          clearTimeout(firstTimer)
          // 流正常结束但没收到 done（少见）：把已攒的文字念完并展示
          flush(true)
          setBusy(false)
          if (full) { setMessages((m: any[]) => [...m, { who: 'fish', text: full }]); showBubble(full, 6000); scrollBody() }
          return true
        } catch (e: any) {
          clearTimeout(firstTimer)
          setBusy(false)
          if (spokeAny) {
            flush(true)
            try { (window as any).__chubbyWhale.streamFallback = String(e && e.message || e) } catch (e2) { }
            return true
          }
          return false
        }
      }


      async function sendText(rawText: string, opts?: { voice?: boolean }): Promise<void> {
        const text = String(rawText || '').trim()
        if (!text) return
        try { (window as any).__chubbyWhale.ttsSkip = 'empty-text' } catch (e) { }
        // 占线保护：上一条还在想就拒绝（不排队），避免两条回复抢同一个话筒
        try { (window as any).__chubbyWhale.lastChat = { stage: 'entry', busy: !!busy, tts: !!ttsPlaying, at: Date.now() } } catch (e) { }
        if (busy) { try { (window as any).__chubbyWhale.lastChat.stage = 'blocked-busy' } catch (e) { } }
        if (busy && Date.now() - busyAtRef.current < 35000) { if (opts && opts.voice) showBubble('本鲸还在想上一句呢，稍等～', 2500); return }
        // 用户提问永远优先：先打断正在播的旁白（说书/念诗）再回答
        if (storyNarratingRef.current || ttsPlaying) {
          try { stopTts() } catch (e) { }
          storyNarratingRef.current = false
          try { storyBusyRef.current = false } catch (e) { }
        }
        if (tryLocalRoute(text)) { setInput(''); return }
        // 流式优先：边生成边念；失败会自动回退到下面的普通 /chat
        try { if (await tryStreamChat(text, opts)) { setInput(''); return } } catch (e) { }
        const myEpoch = ++chatEpoch
        try { const hit = persona.reactTo(text); if (hit) { sayLine(hit.text, 4000); if (hit.event === 'praise') animRef.current?.pushHeart() } } catch (e) { }
        setInput('')
        setMessages((m: any[]) => [...m, { who: 'me', text }])
        // 等待提示（人设 waiting）：只在语音提问时偶尔冒一句，概率 25%，不刷屏
        try { if (opts && opts.voice && !ttsPlaying && Math.random() < 0.25) sayLine(persona.line('waiting'), 3000) } catch (e) { }
        setBusy(true)
        busyAtRef.current = Date.now()
        animRef.current?.talkFor(1200)
        scrollBody()
        let data: any = null
        try {
          const tChat = performance.now()
          const res = await fetch('/api/chubby-whale/chat', {
            // 30 秒上限：请求卡住时别让状态永远停在「在想…」
            signal: (typeof AbortSignal !== 'undefined' && (AbortSignal as any).timeout) ? (AbortSignal as any).timeout(30000) : undefined,
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message: text, voice: true, lang: (() => { try { return localStorage.getItem('chubby-chatlang') || 'auto' } catch (e) { return 'auto' } })() }),
          })
          data = await res.json()
          try { latDiag.chatMs = Math.round(performance.now() - tChat); latDiag.updates++ } catch (e) { }
          if (myEpoch !== chatEpoch) return   // 主人已经问了新问题：这条旧回复作废（防串线）
          const reply = data?.reply || '主人……本鲸走神了。'
          try { (window as any).__chubbyWhale.lastChat = { stage: 'fetched', reply: String(reply).slice(0, 40), at: Date.now() } } catch (e) { }
          setMessages((m: any[]) => [...m, { who: 'fish', text: reply }])
          if (voiceModeRef.current) { showBubble('（说）' + reply, 8000) }
          if (data && data.upgraded) showBubble('本鲸又长大一点啦！', 4000)
        } catch {
          setMessages((m: any[]) => [...m, { who: 'fish', text: persona.line('error') }])
        } finally {
          setBusy(false)
          animRef.current?.talkFor(1500)
          // 聊天回复：长回复（≥80 字）按 C# 自动切叙述语调 -15%，短句 +0%
          try {
            if (data && data.reply && myEpoch === chatEpoch) {
              const rp = String(data.reply)
              try { (window as any).__chubbyWhale.lastChat = { stage: 'speak', reply: rp.slice(0, 40), at: Date.now() } } catch (e) { }
              speakReply(rp)
            }
          } catch { }
          scrollBody()
        }
      }

      // 提醒轮询（每 20 秒检查一次，与 C# 一致）——到点的全部排队，逐条播报
      // 调试口：控制台输入 __chubbyWhale.say("你好呀") 可直接测「对话 + 朗读」链路（不经过麦克风）
      R.useEffect(() => {
        try {
          const w: any = (window as any).__chubbyWhale || ((window as any).__chubbyWhale = {})
          w.say = (t: string) => { try { sendText(String(t || ""), { voice: true }) } catch (e) { } }
          w.sayStop = () => { try { stopTts() } catch (e) { } }
          w.busyNow = () => ({ busy: busyRef.current, age: Date.now() - busyAtRef.current, tts: ttsPlaying })
        } catch (e) { }
      }, [])
      // 提醒轮询（每 20 秒检查一次，与 C# 一致）——到点的全部排队，逐条播报
      R.useEffect(() => {
        const timer = setInterval(() => {
          fetch('/api/chubby-whale/reminders?action=due').then((r: any) => r.json()).then((d: any) => {
            const due = (d && d.due) || []
            for (const it of due) {
              if (it && it.text) dueQueueRef.current.push(it)
            }
            pumpDueReminders()
          }).catch(() => { })
        }, 20000)
        return () => clearInterval(timer)
      }, [])
      // ===== 语音模块（client/voice.ts，2026-11 从零重写）=====
      // 旧实现（自研 VAD + WebSpeech + 三通道 + 朗读队列）已整体删除。
      // 新模块只有一个状态机：idle → listening → recognizing → thinking → speaking。
      const voiceRef = R.useRef<any>(null)
      R.useEffect(() => {
        if (!earOnRef.current) return
        const v = createVoice({
          onHeard: (text: string) => {
            try { voiceModeRef.current = true } catch (e) { }
            try { showBubble('（听到）' + text + '｜本鱼在想…', 3000) } catch (e) { }
            try { sendText(text, { voice: true }) } catch (e) { }
          },
          onStatus: (st: any) => {
            ttsPlaying = st === 'speaking'
          },
          onDiag: (d: any) => { try { (window as any).__chubbyWhale.voiceDiag = d } catch (e) { } },
        })
        voiceRef.current = v
        try {
          const w: any = (window as any).__chubbyWhale || ((window as any).__chubbyWhale = {})
          w.voice = v
        } catch (e) { }
        void v.start()
        return () => { try { v.stop() } catch (e) { } ; voiceRef.current = null }
      }, [])

      // ---- 旧调用点兼容层：全部转到新模块 ----
      function speakText(text: string, o?: { rate?: string; narration?: boolean; onDone?: () => void }): void {
        try { if (localStorage.getItem('chubby-voice') === 'off') { try { (window as any).__chubbyWhale.ttsSkip = 'voice-off' } catch (e) { } ; return } } catch (e) { }
        try { if (voiceRef.current) voiceRef.current.speak(text, o) } catch (e) { }
      }
      function stopTts(): void { try { if (voiceRef.current) voiceRef.current.stopSpeaking() } catch (e) { } }
      function muteMic(): void { try { if (voiceRef.current) voiceRef.current.mute(true) } catch (e) { } }
      function unmuteMic(): void { try { if (voiceRef.current) voiceRef.current.mute(false) } catch (e) { } }
      function prefetchFiller(): void { }
      function prefetchNextTts(): void { }

      /** 人设台词：气泡 + 语音一起出（语音朗读关着时只出气泡；正在说别的话时不打断） */
      function sayLine(text: string, ms = 3500): void {
        // 同一句台词 25 秒内只说一次：挂载重复/事件连发时不会连着说两遍
        const norm = String(text || '').replace(/[\\s。，！？,.!?、…~～]/g, '')
        const nowL = Date.now()
        if (norm && norm === lastLineNorm && nowL - lastLineAt < 25000) { try { (window as any).__chubbyWhale.dupLine = ((window as any).__chubbyWhale.dupLine || 0) + 1 } catch (e) { } ; return }
        lastLineNorm = norm
        lastLineAt = nowL
        if (!text) return
        try { showBubble(text, ms) } catch (e) { }
        try {
          if (localStorage.getItem('chubby-voice') === 'off') return
          const v: any = voiceRef.current
          if (v && v.speak && !v.speaking()) v.speak(text, { rate: '+0%' })
        } catch (e) { }
      }
      /** 统一的回复朗读入口：长回复走叙述语速，同一句回复 30 秒内不重复念 */
      function speakReply(text: string): void {
        const rp = String(text || '')
        if (!rp.trim()) return
        const rpPlain = rp.replace(/[\s。，！？,.!?、…~～]/g, '')
        const now = Date.now()
        if (lastReplyText && lastReplyAt && now - lastReplyAt < 30000 && rpPlain === lastReplyText) {
          try { (window as any).__chubbyWhale.dupReply = ((window as any).__chubbyWhale.dupReply || 0) + 1 } catch (e) { }
          return
        }
        lastReplyText = rpPlain
        lastReplyAt = now
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
