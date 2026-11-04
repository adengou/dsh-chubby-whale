/**
 * dsh-chubby-whale —— 浏览器端入口（模块化组装）
 * 依赖模块：client/styles.ts（样式）、client/menu.ts（菜单）、client/anim.ts（动画）
 */
import { W, H, CW, CH, SX, SY, VERSION, stageStyle, canvasStyle, menuStyle, chatPanelStyle, headStyle, bodyStyle, inputRowStyle, inputStyle, sendStyle, msgStyle } from './client/styles.js'
import { buildMenu, tr } from './client/menu.js'
import { handleFileDrop, VISION_PROMPT } from './client/dropzone.js'
import { createAnimator } from './client/anim.js'
import { splitTtsSegments, normalizeRate, cleanTtsText } from './shared/tts.js'
import { parseDue, cleanReminderText } from './shared/time.js'
;(window as any).__ModuleLoader__.load({
  id: 'dsh-chubby-whale',
  factory: (require: any) => {
    const R = require('react')
    const h = R.createElement



    // 客户端标识：多标签页说书队列互不抢段（取不到就退化成单队列）
    const CLIENT_ID = (() => {
      try {
        let v = localStorage.getItem('chubby-client-id')
        if (!v) { v = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); localStorage.setItem('chubby-client-id', v) }
        return v
      } catch (e) { return '' }
    })()

    // ===== TTS：首段更短 + 边播边预取下一段（照 C# Speech.cs 的流水线）=====
    interface TtsJob {
      id: number
      /** 同一次 speakText 的段共享一个组号：组内叙述段之间才留换气停顿 */
      group: number
      text: string
      rate: string
      narration: boolean
      onDone?: () => void
    }
    let ttsAudioRef: any = null
    let ttsUrl = ''
    let ttsEpoch = 0
    let ttsJobSeq = 0
    let ttsGroupSeq = 0
    const ttsQueue: TtsJob[] = []
    /** 预取缓存：段 id → 已发出的合成请求（当前段开播时就把下一段压上去） */
    const ttsPrefetch = new Map<number, Promise<ArrayBuffer | null>>()
    let ttsPlaying = false
    let ttsCurrentJob: TtsJob | null = null
    /** 叙述段间的换气停顿截止时刻（C# NarrationPauseMs = 260） */
    let ttsPauseUntil = 0
    let ttsPauseTimer: any = null
    function currentVoice(): string {
      try { return localStorage.getItem('chubby-tts-voice') || 'auto' } catch (e) { return 'auto' }
    }
    function finishTtsJob(job: TtsJob): void {
      if (!job || !job.onDone) return
      const cb = job.onDone
      job.onDone = undefined
      try { cb() } catch (e) { }
    }
    /**
     * 纯前端兜底朗读：本机没装 python/edge-tts（服务端 501）时用浏览器内置语音，
     * 保证"没有外部依赖也听得到声音"。resolve(null) 表示这段已经用浏览器念完了。
     */
    function speakWithBrowserTts(job: TtsJob): Promise<null> {
      try {
        const ss = (window as any).speechSynthesis
        const Us = (window as any).SpeechSynthesisUtterance
        if (!ss || !Us) return Promise.resolve(null)
        const u = new Us(String(job.text || '').slice(0, 300))
        u.lang = /[\u4e00-\u9fa5]/.test(job.text) ? 'zh-CN' : 'en-US'
        return new Promise<null>((resolve) => {
          let done = false
          const finish = () => { if (!done) { done = true; resolve(null) } }
          u.onend = finish
          u.onerror = finish
          try { ss.cancel(); ss.speak(u) } catch (e) { finish() }
          setTimeout(finish, 12000)
        })
      } catch (e) { return Promise.resolve(null) }
    }
    /** 合成一段音频；失败返回 null（播放端跳过这一段，绝不把整条队列卡死） */
    function fetchTts(job: TtsJob): Promise<ArrayBuffer | null> {
      try {
        return fetch('/api/chubby-whale/tts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: job.text, voice: currentVoice(), rate: job.rate }),
        }).then((r: any) => {
          const ct = String((r.headers && r.headers.get && r.headers.get('content-type')) || '')
          // 服务端 501 / JSON 错误 = 没有 edge-tts，改走浏览器朗读
          if (r.status === 501 || ct.indexOf('application/json') >= 0) throw new Error('TTS_UNAVAILABLE')
          if (!r.ok) throw new Error('tts http ' + r.status)
          return r.arrayBuffer()
        }).catch((err: any) => {
          if (String((err && err.message) || err).indexOf('TTS_UNAVAILABLE') >= 0) return speakWithBrowserTts(job)
          return null
        })
      } catch (e) { return Promise.resolve(null) }
    }
    /** 把队首那段的合成先压上去（已在预取里就不重复发） */
    function prefetchNextTts(): void {
      const next = ttsQueue[0]
      if (!next) return
      if (!ttsPrefetch.has(next.id)) ttsPrefetch.set(next.id, fetchTts(next))
    }
    // 停止说话：真的把当前音频停掉、清空队列、回收 URL（照 C# Speech.Stop）
    function stopTts(): void {
      try {
        ttsEpoch++
        ttsPauseUntil = 0
        if (ttsPauseTimer) { try { clearTimeout(ttsPauseTimer) } catch (e) { } ; ttsPauseTimer = null }
        while (ttsQueue.length > 0) finishTtsJob(ttsQueue.shift() as TtsJob)
        // 正在播的那一段已经从队列里摘走了：这里补一次收尾，别让 onDone 永远不触发
        if (ttsCurrentJob) { finishTtsJob(ttsCurrentJob); ttsCurrentJob = null }
        ttsPrefetch.clear()
        const a = ttsAudioRef
        ttsAudioRef = null
        if (a) {
          try { a.onended = null; a.onerror = null } catch (e) { }
          try { a.pause() } catch (e) { }
          try { a.currentTime = 0 } catch (e) { }
        }
        if (ttsUrl) { try { URL.revokeObjectURL(ttsUrl) } catch (e) { } ; ttsUrl = '' }
        ttsPlaying = false
        try { const ss = (window as any).speechSynthesis; if (ss && ss.speaking) ss.cancel() } catch (e) { }
      } catch (e) { ttsPlaying = false }
    }
    function speakText(text: string, opts?: { rate?: string; narration?: boolean; onDone?: () => void }): void {
      try {
        if (!text) return
        try { if (localStorage.getItem('chubby-voice') === 'off') return } catch (e) { }
        // 模型回复里的 markdown/emoji 念出来很怪：入队前先清洗（照 C# TextTools.Clean）
        const clean = cleanTtsText(text)
        if (!clean) return
        const rate = normalizeRate(opts && opts.rate, '+0%')
        // 叙述（-15%）段与段之间留 260ms 换气停顿（C# NarrationPauseMs）
        const narration = (opts && typeof opts.narration === 'boolean') ? opts.narration : rate === '-15%'
        // 说书一段 2000+ 字：首段 14 字内先开口，其余按标点切 80 字内逐段请求
        const segs = splitTtsSegments(clean, 80)
        const group = ++ttsGroupSeq
        for (let i = 0; i < segs.length; i++) {
          ttsQueue.push({
            id: ++ttsJobSeq,
            group,
            text: segs[i],
            rate,
            narration,
            onDone: (i === segs.length - 1) ? (opts && opts.onDone) : undefined,
          })
        }
        // 队列本来是空的：先把第一段合成压上去，第一声更快
        prefetchNextTts()
        playNextTts()
      } catch (e) { }
    }
    function playNextTts(): void {
      if (ttsPlaying) return
      if (ttsQueue.length === 0) return
      // 叙述段间的换气停顿：到点再起下一段（期间新来的句子排在后面一起等）
      const wait = ttsPauseUntil - Date.now()
      if (wait > 0) {
        if (!ttsPauseTimer) {
          ttsPauseTimer = setTimeout(() => { ttsPauseTimer = null; playNextTts() }, wait)
        }
        return
      }
      const epoch = ttsEpoch
      const job = ttsQueue.shift() as TtsJob
      ttsPlaying = true
      ttsCurrentJob = job
      try {
        const pending = ttsPrefetch.get(job.id) || fetchTts(job)
        ttsPrefetch.delete(job.id)
        // 关键：当前段刚开始取，就把下一段的合成压上去 —— 边播边合成，段间没有空档
        prefetchNextTts()
        pending.then((buf: ArrayBuffer | null) => {
          // 取音频期间被「停止说话」了：这一段就别再响了（收尾已在 stopTts 里做过）
          if (epoch !== ttsEpoch) { finishTtsJob(job); return }
          if (!buf) {
            // 合成失败：跳过这一段，接着播后面的
            if (ttsCurrentJob === job) ttsCurrentJob = null
            finishTtsJob(job)
            ttsPlaying = false
            playNextTts()
            return
          }
          let settled = false
          const settle = () => {
            if (settled) return
            settled = true
            if (ttsCurrentJob === job) ttsCurrentJob = null
            try { URL.revokeObjectURL(url) } catch { }
            if (ttsUrl === url) ttsUrl = ''
            finishTtsJob(job)
            ttsPlaying = false
            // 叙述：同一组还有下一段时留 260ms 换气，别一口气念到底
            const next = ttsQueue[0]
            if (job.narration && next && next.group === job.group) ttsPauseUntil = Date.now() + 260
            playNextTts()
          }
          const blob = new Blob([buf], { type: 'audio/mpeg' })
          const url = URL.createObjectURL(blob)
          ttsUrl = url
          const audio = new Audio(url)
          ttsAudioRef = audio
          audio.onended = settle
          audio.onerror = settle
          audio.play().catch(() => {
            try {
              const u = new (window as any).SpeechSynthesisUtterance(job.text.slice(0, 300))
              u.lang = /[\u4e00-\u9fa5]/.test(job.text) ? 'zh-CN' : 'en-US'
              u.onend = settle
              u.onerror = settle
              ;(window as any).speechSynthesis.cancel()
              ;(window as any).speechSynthesis.speak(u)
            } catch (e) { settle() }
          })
        }).catch(() => {
          if (ttsCurrentJob === job) ttsCurrentJob = null
          finishTtsJob(job)
          ttsPlaying = false
          playNextTts()
        })
      } catch (e) {
        if (ttsCurrentJob === job) ttsCurrentJob = null
        ttsPlaying = false
        finishTtsJob(job)
        playNextTts()
      }
    }

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
    }    function playMelody(notes: any[], bpm: number): void {
      try {
        stopMelody()
        const AC = (window as any).AudioContext || (window as any).webkitAudioContext
        if (!AC) return
        const ctx = new AC()
        melodyCtx = ctx
        try { ctx.resume() } catch (e) { }
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
      } catch (e) { }
    }

    function WhaleOverlay() {
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
      const [growthLabel, setGrowthLabel] = R.useState('--')
      const WAKE_WORDS = ['大肥鱼', '肥鲸', '肥鱼', '小鱼', '蓝鱼', '小蓝鱼', '鱼鱼', '肥肥']
      const dragRef = R.useRef({ dragging: false, lastX: 0, lastY: 0, vx: 0, vy: 0, moved: 0 })
      const scaleRef = R.useRef(1)
      const animRef = R.useRef(null as any)
      const storyBusyRef = R.useRef(false)
      // 最近一次说书的书名（「从头讲这本书」要按它重置进度）
      const storyBookRef = R.useRef('')
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
      const bodyRef = R.useRef(null)
      const bubbleRef = R.useRef(null)
      const bubbleTextRef = R.useRef(null)

      // 样式注入（气泡三角）
      R.useEffect(() => {
        try {
          if (!(document as any).getElementById('chubby-whale-style')) {
            const st = (document as any).createElement('style')
            st.id = 'chubby-whale-style'
            st.textContent = '.chubby-bubble{position:fixed;z-index:10002;max-width:250px;opacity:0;background:#fff;color:#17325a;border-radius:14px;padding:10px 14px;font:13px/1.6 "Microsoft YaHei",sans-serif;box-shadow:0 8px 20px rgba(0,0,0,0.35);transition:opacity .2s;pointer-events:none;}' +
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
        el.style.left = x + 'px'
        el.style.top = y + 'px'
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
        el._t = setTimeout(() => { el.classList.remove('show') }, ms)
      }

      // 拖动
      function onPointerDown(e: any): void {
        if (e.button !== 0) return
        const d = dragRef.current
        d.dragging = true
        d.lastX = e.clientX; d.lastY = e.clientY
        d.vx = 0; d.vy = 0; d.moved = 0
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

      // 右键菜单
      function onContextMenu(e: any): void {
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
        setSubOpen('')
        fetch('/api/chubby-whale/balance').then((r: any) => r.json()).then((d: any) => {
          if (d && d.ok && d.balance != null) { setBalanceText('余额 ¥' + d.balance); setBalanceLabel('¥' + d.balance) }
          else setBalanceText('余额 --')
        }).catch(() => setBalanceText('余额 --'))
        fetch('/api/chubby-whale/growth').then((r: any) => r.json()).then((d: any) => {
          if (d && d.ok) setGrowthLabel(d.stage + '（' + d.exp + '）')
        }).catch(() => { })
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
        showBubble(head + '：' + text.slice(0, 100) + (text.length > 100 ? '…' : ''), 12000)
        animRef.current?.talkFor(8000)
        if (voiceOff) {
          storyBusyRef.current = false
          showBubble(head + '：' + text.slice(0, 300) + '…', 20000)
          return
        }
        storyBusyRef.current = true
        speakText(text, {
          rate: normalizeRate(d.rate, '-15%'),
          onDone: () => {
            storyBusyRef.current = false
            showBubble('这段讲完啦～点菜单「接着说」听下一段', 6000)
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
        if (action === 'feed') { showBubble('好吃！谢谢主人～'); animRef.current?.pushHeart(); try { fetch('/api/chubby-whale/pet?action=feed') } catch (e) { } ; return }
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
              showBubble('念诗·' + p.title + '（' + author + '）\n' + body, 15000)
              animRef.current?.talkFor(6000)
              const speech = '念首诗——' + p.title + '，' + (p.dynasty ? p.dynasty + '，' : '') + author + '。' + body.replace(/\n/g, '，')
              speakText(speech, { rate: '-15%' })
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
              showBubble('民间故事·' + tp.title + (tp.book ? '（出自《' + tp.book + '》）：' : '：') + shown, 9000)
              animRef.current?.talkFor(5000)
              // 照 C# Culture.TaleSpeech：标题 + 出处 + 整篇（超 6000 字才截），叙述一律 -15%
              speakText('讲个民间故事——' + tp.title + (tp.book ? '，出自《' + tp.book + '》' : '') + '。' + body.slice(0, 6000), { rate: '-15%' })
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
              showBubble('《' + d.item.title + '》（' + (d.item.src || '') + '）：' + (cut ? body.slice(0, 100) + '…' : body), 9000)
              animRef.current?.talkFor(5000)
              speakText('讲个典故——' + String(d.item.title || '') + '，出自' + String(d.item.src || '') + '。' + body, { rate: '-15%' })
            } else showBubble('典故没讲成')
          }).catch(() => showBubble('典故没讲成'))
          return
        }
        if (action === 'culture-idiom') {
          fetch('/api/chubby-whale/culture?type=idiom').then((r: any) => r.json()).then((d: any) => {
            if (d && d.ok && d.item) {
              showBubble(d.item.title + '：' + String(d.item.text || '').slice(0, 100), 8000)
              const sp = String(d.item.title || '') + '：' + String(d.item.text || '')
              // 成语辨析属叙述：一律 -15%，不再按长度改语速
              speakText(sp, { rate: '-15%' })
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
            if (d && d.ok && d.song) { playMelody(d.song.notes, d.song.bpm); showBubble('弹《' + d.song.name + '》♪') } else showBubble('这首曲子没找到')
          }).catch(() => showBubble('弹琴失败'))
          return
        }
        if (action === 'wake') {
          // 语音待命：控制 VAD 录音循环（关掉就真停麦克风，打开重新 boot）
          const nowOn = !earOnRef.current
          earOnRef.current = nowOn
          setEarOn(nowOn)
          try { localStorage.setItem('chubby-ear', nowOn ? 'on' : 'off') } catch (e) { }
          if (nowOn) { try { earCtlRef.current.boot() } catch (e) { } ; showBubble('语音待命：开，本鲸又听着啦') }
          else { try { earCtlRef.current.stop() } catch (e) { } ; showBubble('语音待命：关，麦克风停啦') }
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
        if (action === 'chat-lang:zh' || action === 'chat-lang:en') {
          const cl = action === 'chat-lang:en' ? 'en' : 'zh'
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
                if (!b64) return
                showBubble('本鲸看看这张图…', 3000)
                setChatOpen(false)
                const hdr = file.type || 'image/jpeg'
                const res = await fetch('/api/chubby-whale/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: VISION_PROMPT, image: b64, imageMime: hdr }) })
                const d = await res.json()
                const reply = (d && d.reply) || '这条鱼看不懂这张图……'
                showBubble('（看图）' + reply, 10000)
                // 聊天回复：长回复（≥80 字）按叙述 -15%，短句正常语速
                speakText(reply, { rate: reply.length >= 80 ? '-15%' : '+0%' })
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
      async function sendText(rawText: string): Promise<void> {
        const text = String(rawText || '').trim()
        if (!text || busy) return
        if (/乖|可爱|好鱼|棒|喜欢你|真聪明/.test(text)) animRef.current?.pushHeart()
        if (/闭嘴|烦|滚|讨厌|笨蛋|丑/.test(text)) showBubble('哼…本鲸生气了')
        if (/胖|肥猪|肥嘟嘟/.test(text)) { showBubble('人家不胖！是鲸鱼天生圆！'); const s0 = Math.min(1.4, scale + 0.12); setScale(s0); setTimeout(function () { setScale(Math.max(0.7, s0 - 0.12)) }, 600) }
        setInput('')
        setMessages((m: any[]) => [...m, { who: 'me', text }])
        setBusy(true)
        animRef.current?.talkFor(1200)
        scrollBody()
        let data: any = null
        try {
          const res = await fetch('/api/chubby-whale/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message: text, lang: (() => { try { return localStorage.getItem('chubby-chatlang') || 'auto' } catch (e) { return 'auto' } })() }),
          })
          data = await res.json()
          const reply = data?.reply || '主人……本鲸走神了。'
          setMessages((m: any[]) => [...m, { who: 'fish', text: reply }])
          if (voiceModeRef.current) { showBubble('（说）' + reply, 8000) }
          if (data && data.upgraded) showBubble('本鲸又长大一点啦！', 4000)
        } catch {
          setMessages((m: any[]) => [...m, { who: 'fish', text: '主人，本鲸连不上服务器……' }])
        } finally {
          setBusy(false)
          animRef.current?.talkFor(1500)
          // 聊天回复：长回复（≥80 字）按 C# 自动切叙述语调 -15%，短句 +0%
          try {
            if (data && data.reply) {
              const rp = String(data.reply)
              speakText(rp, { rate: rp.length >= 80 ? '-15%' : '+0%' })
            }
          } catch { }
          scrollBody()
        }
      }

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
      // 语音待命（VAD 版，照 C# 版）：连续录音，静音 700ms 判定说完，立即上传识别
      R.useEffect(() => {
        let stopped = false
        let lastHeardText = ''
        let lastHeardAt = 0
        let stream: any = null
        let mr: any = null
        let actx: any = null
        let analyser: any = null
        let chunks: any[] = []
        let raf = 0
        let started = false
        let voicedMs = 0
        let silenceMs = 0
        let peak = 0
        let chunkStartedAt = 0
        let lastTickAt = 0
        let watchTimer: any = null
        let startTimer: any = null
        const SILENCE_GATE = 8
        const SILENCE_LIMIT = 700
        const VOICE_LIMIT = 6000
        function blobToBase64(blob: any): Promise<string> {
          return new Promise((resolve) => {
            try {
              const fr = new FileReader()
              fr.onloadend = () => { const s = String(fr.result || ''); resolve(s.indexOf(',') >= 0 ? s.slice(s.indexOf(',') + 1) : s) }
              fr.readAsDataURL(blob)
            } catch (e) { resolve('') }
          })
        }
        function scheduleStart(delay: number): void {
          if (stopped) return
          if (startTimer) clearTimeout(startTimer)
          startTimer = setTimeout(() => { startTimer = null; startChunk() }, delay)
        }
        async function uploadChunk() {
          // 所有 return 都走 finally → 录音循环一定会重启（不再因为「没叫唤醒词」装死）
          try {
            if (stopped) return
            const blob = new Blob(chunks, { type: 'audio/webm' })
            chunks = []
            if (blob.size < 2500) return
            const b64 = await blobToBase64(blob)
            if (!b64) return
            const r = await fetch('/api/chubby-whale/asr', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ audio: b64, format: 'webm' }),
            })
            const d = await r.json()
            if (d && d.ok && d.text && d.text.trim().length >= 2) {
              if (ttsPlaying) return
              let t = String(d.text).trim()
              if (t === lastHeardText && Date.now() - lastHeardAt < 20000) return
              lastHeardText = t
              lastHeardAt = Date.now()
              if (/[。，！？,.!?]{3,}/.test(t) || t.length > 60) return
              const hasWake = WAKE_WORDS.some(function (w) { return t.indexOf(w) >= 0 })
              if (hasWake) {
                wokeRef.current.at = Date.now()
                try { t = t.replace(/大肥鱼|肥鲸|肥鱼|小鱼|蓝鱼|小蓝鱼|鱼鱼|肥肥/g, '').trim() } catch (e) { }
                if (!t) { showBubble('我在～主人说～', 3000); return }
              } else {
                const wokeRecent = Date.now() - wokeRef.current.at < 30000
                if (!wokeRecent) return
              }
              voiceModeRef.current = true
              setChatOpen(false)
              if (!voiceChatOnRef.current) {
                // 语音聊天关着：只听不接话，冒个气泡就好
                showBubble('（听到）' + t + '｜语音聊天关着，先不接话', 4000)
                return
              }
              showBubble('（听到）' + t, 3000)
              sendText(t)
            }
          } catch (e) { } finally {
            if (!stopped) scheduleStart(350)
          }
        }
        function watch() {
          try {
            if (stopped || !analyser) return
            const buf = new Uint8Array(analyser.fftSize)
            analyser.getByteFrequencyData(buf)
            let sum = 0
            for (let i = 0; i < buf.length; i++) sum += buf[i]
            const avg = sum / buf.length
            if (avg > peak) peak = avg
            // 用真实时间戳算，后台标签页被节流时也不会低估（旧版 totalMs += 100 会漂移）
            const now = performance.now()
            const dt = Math.min(250, Math.max(0, now - lastTickAt))
            lastTickAt = now
            if (avg > SILENCE_GATE) { voicedMs += dt; silenceMs = 0 } else { silenceMs += dt }
            const elapsed = now - chunkStartedAt
            const done = (voicedMs > 200 && silenceMs >= SILENCE_LIMIT) || elapsed >= VOICE_LIMIT + 2000 || (peak > 90 && silenceMs >= 400)
            if (done && mr.state === 'recording') {
              try { mr.stop() } catch { }
              setTimeout(uploadChunk, 100)
              return
            }
            if (!stopped) scheduleWatch(100)
          } catch (e) { if (!stopped) scheduleWatch(100) }
        }
        function scheduleWatch(delay: number): void {
          if (stopped) return
          if (watchTimer) clearTimeout(watchTimer)
          watchTimer = setTimeout(() => { watchTimer = null; watch() }, delay)
        }
        function startChunk() {
          if (stopped || !mr) return
          try {
            // 上一段还没 stop 时不能直接 start()（会抛异常并无限重试），先停，稍后再起
            if (mr.state !== 'inactive') {
              try { mr.stop() } catch (e) { }
              scheduleStart(200)
              return
            }
            chunks = []
            voicedMs = 0; silenceMs = 0; peak = 0
            chunkStartedAt = performance.now()
            lastTickAt = chunkStartedAt
            mr.start()
            scheduleWatch(100)
          } catch (e) { scheduleStart(1000) }
        }
        // 首次手势监听：两个分开摘，一个抛错不能把另一个漏在页面上
        function detachGesture(): void {
          try { (document as any).removeEventListener('pointerdown', onFirstGesture) } catch { }
          try { (document as any).removeEventListener('keydown', onFirstGesture) } catch { }
        }
        function attachGesture(): void {
          try { (document as any).addEventListener('pointerdown', onFirstGesture) } catch { }
          try { (document as any).addEventListener('keydown', onFirstGesture) } catch { }
        }
        async function boot() {
          if (stopped) return
          try {
            const s = await (navigator as any).mediaDevices.getUserMedia({ audio: true })
            // 拿麦期间被「语音待命：关」了：别再把麦克风挂着
            if (stopped) { try { s.getTracks().forEach((t: any) => t.stop()) } catch (e) { } ; return }
            stream = s
            actx = new (window as any).AudioContext()
            const src = actx.createMediaStreamSource(stream)
            analyser = actx.createAnalyser()
            analyser.fftSize = 512
            src.connect(analyser)
            mr = new (window as any).MediaRecorder(stream)
            mr.ondataavailable = (e: any) => { if (e && e.data && e.data.size > 0) chunks.push(e.data) }
            mr.onstop = () => { }
            detachGesture()                 // 麦克风真拿到了才摘监听
            showBubble('本鲸在听（千问识别），说完就会接话～', 3000)
            startChunk()
          } catch (e) {
            // 拿麦失败（没授权/没有设备）：允许下一次手势再试，别把开始标志焊死
            started = false
            if (stopped) return             // 卸载/关待命期间失败：监听不能再加回去
            attachGesture()
            showBubble('麦克风打不开：点地址栏小锁允许麦克风', 6000)
          }
        }
        function onFirstGesture() {
          if (started || stopped) return
          started = true
          detachGesture()
          if (!earOnRef.current) return
          boot()
        }
        // 关掉「语音待命」：真的把录音链停掉（定时器 + MediaRecorder + 音轨 + AudioContext）
        function stopEar(): void {
          stopped = true
          if (watchTimer) { try { clearTimeout(watchTimer) } catch { } watchTimer = null }
          if (startTimer) { try { clearTimeout(startTimer) } catch { } startTimer = null }
          try { if (mr && mr.state !== 'inactive') mr.stop() } catch { }
          try { if (actx) actx.close() } catch { }
          try { if (stream) stream.getTracks().forEach((t: any) => t.stop()) } catch { }
          mr = null; actx = null; stream = null; analyser = null
        }
        // 再打开：重新拿麦克风并起循环
        function bootEar(): void {
          stopped = false
          lastHeardText = ''
          lastHeardAt = 0
          started = true
          detachGesture()
          boot()
        }
        earCtlRef.current.stop = stopEar
        earCtlRef.current.boot = bootEar
        attachGesture()
        return () => {
          // 卸载必须无条件摘监听：否则页面里点一下还会去开麦
          detachGesture()
          stopEar()
          earCtlRef.current.stop = () => { }
          earCtlRef.current.boot = () => { }
        }
      }, [])
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
            h('span', null, (lang === 'en' ? 'Fat Whale · v' : '肥鲸 · v') + VERSION),
            h('span', { style: { color: '#FFD166' } }, balanceText)),
          renderItems(buildMenu(VERSION, { voiceOn: voiceOn, earOn: earOn, voiceChatOn: voiceChatOn, balance: balanceLabel, growth: growthLabel })),
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
      inject: ['slots'],
      apply(ctx: any) {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'chubby-whale',
          order: 100,
        }, WhaleOverlay))
      },
    }
  },
})
