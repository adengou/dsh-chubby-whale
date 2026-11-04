/**
 * dsh-chubby-whale —— 浏览器端入口（模块化组装）
 * 依赖模块：client/styles.ts（样式）、client/menu.ts（菜单）、client/anim.ts（动画）
 */
import { W, H, CW, CH, SX, SY, VERSION, stageStyle, canvasStyle, menuStyle, chatPanelStyle, headStyle, bodyStyle, inputRowStyle, inputStyle, sendStyle, msgStyle } from './client/styles.js'
import { buildMenu, tr } from './client/menu.js'
import { createAnimator } from './client/anim.js'
;(window as any).__ModuleLoader__.load({
  id: 'dsh-chubby-whale',
  factory: (require: any) => {
    const R = require('react')
    const h = R.createElement



    let ttsAudio: any = null
    const ttsQueue: string[] = []
    let ttsPlaying = false
    function splitTtsSegments(text: string): string[] {
      const t = String(text || '').trim()
      if (!t) return []
      if (t.length <= 140) return [t]
      const parts = t.split(/(?<=[。！？!?；;…\.\r\n])/).map((s: string) => s.trim()).filter(Boolean)
      if (parts.length <= 1) return [t]
      const first = parts[0]
      const rest = parts.slice(1).join('').trim()
      if (!rest) return [first]
      if (rest.length <= 26) return [first, rest]
      const mid = Math.floor(rest.length / 2)
      let cut = -1
      for (const ch of ['，', ',', '；', '、', ' ', '。', '.']) {
        const idx = rest.lastIndexOf(ch, mid)
        if (idx > cut) cut = idx
      }
      if (cut < 8) cut = mid
      return [first, rest.slice(0, cut + 1).trim(), rest.slice(cut + 1).trim()].filter(Boolean)
    }
    function speakText(text: string): void {
      try {
        if (!text) return
        try { if (localStorage.getItem('chubby-voice') === 'off') return } catch (e) { }
        const segs = splitTtsSegments(text)
        for (const s of segs) { ttsQueue.push(String(s).slice(0, 500)) }
        playNextTts()
      } catch (e) { }
    }
    function playNextTts(): void {
      if (ttsPlaying) return
      if (ttsQueue.length === 0) return
      try {
        ttsPlaying = true
        const text = ttsQueue.shift() as string
        fetch('/api/chubby-whale/tts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, voice: (() => { try { return localStorage.getItem('chubby-tts-voice') || 'auto' } catch (e) { return 'auto' } })() }),
        }).then((r: any) => {
          if (!r.ok) throw new Error('tts http ' + r.status)
          return r.arrayBuffer()
        }).then((buf: ArrayBuffer) => {
          const blob = new Blob([buf], { type: 'audio/mpeg' })
          const url = URL.createObjectURL(blob)
          const audio = new Audio(url)
          ttsAudio = audio
          audio.onended = () => { try { URL.revokeObjectURL(url) } catch { } ; ttsPlaying = false; playNextTts() }
          audio.onerror = () => { ttsPlaying = false }
          audio.play().catch(() => {
            try {
              const u = new (window as any).SpeechSynthesisUtterance(text.slice(0, 300))
              u.lang = /[\u4e00-\u9fa5]/.test(text) ? 'zh-CN' : 'en-US'
              ;(window as any).speechSynthesis.cancel()
              ;(window as any).speechSynthesis.speak(u)
            } catch (e) { }
            ttsPlaying = false
            playNextTts()
          })
        }).catch(() => { ttsPlaying = false; playNextTts() })
      } catch (e) { ttsPlaying = false }
    }

    let recognition: any = null
    function startVoiceChat(onText: (t: string) => void): void {
      try {
        const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
            if (!SR) { showBubble('这个浏览器不支持语音听写，换 Edge 或 Chrome 试试', 5000); return }
        if (recognition) { try { recognition.stop() } catch { } }
        recognition = new SR()
        recognition.lang = 'zh-CN'
        recognition.interimResults = false
        recognition.maxAlternatives = 1
        recognition.onresult = (e: any) => {
          try {
            const t = e.results[0][0].transcript
            if (t) onText(t)
          } catch { }
        }
        recognition.onend = () => { recognition = null }
        recognition.start()
      } catch (e) { }
    }
    const NOTE_FREQ: any = { 'C4': 261.63, 'D4': 293.66, 'E4': 329.63, 'F4': 349.23, 'G4': 392.00, 'A4': 440.00, 'B4': 493.88, 'C5': 523.25, 'D5': 587.33, 'E5': 659.25, 'F5': 698.46, 'G5': 783.99, 'A5': 880.00, 'B5': 987.77 }
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
      const [balanceLabel, setBalanceLabel] = R.useState('--')
      const [growthLabel, setGrowthLabel] = R.useState('--')
      const WAKE_WORDS = ['大肥鱼', '肥鲸', '肥鱼', '小鱼', '蓝鱼', '小蓝鱼', '鱼鱼', '肥肥']
      const dragRef = R.useRef({ dragging: false, lastX: 0, lastY: 0, vx: 0, vy: 0, moved: 0 })
      const scaleRef = R.useRef(1)
      const animRef = R.useRef(null as any)

      const [scale, setScale] = R.useState(1)
      const [hidden, setHidden] = R.useState(false)
      const [menu, setMenu] = R.useState(null as any)
      const [subOpen, setSubOpen] = R.useState('')
      const [balanceText, setBalanceText] = R.useState('')
      const [lang, setLang] = R.useState((() => { try { return localStorage.getItem('chubby-lang') || 'zh' } catch { return 'zh' } })())
      const dictateRef = R.useRef({ on: false, text: '' })
      const [dictateOn, setDictateOn] = R.useState(false)
      const [dictText, setDictText] = R.useState('')
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
        x = Math.max(0, Math.min(window.innerWidth - W, x))
        y = Math.max(0, Math.min(window.innerHeight - H, y))
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

      // 菜单动作
      function runAction(action: string): void {
        setMenu(null)
        if (action === 'feed') { showBubble('好吃！谢谢主人～'); animRef.current?.pushHeart(); try { fetch('/api/chubby-whale/pet?action=feed') } catch (e) { } ; return }
        if (action === 'home') { homePos(); showBubble('回到角落啦'); return }
        if (action === 'bigger') { const s = Math.min(1.4, scale + 0.1); setScale(s); scaleRef.current = s; return }
        if (action === 'smaller') { const s = Math.max(0.7, scale - 0.1); setScale(s); scaleRef.current = s; return }
        if (action === 'hide') { setHidden(true); return }
        if (action === 'version') { showBubble('肥鲸 v' + VERSION); return }
        if (action === 'type') { voiceModeRef.current = false; setChatOpen(true); return }
        if (action === 'pause') { showBubble('歇会儿…'); return }
        if (action === 'music-stop') { stopMelody(); showBubble('停下啦'); return }
        if (action === 'fishfood') { fetch('/api/chubby-whale/fishfood').then((r: any) => r.json()).then((d: any) => { if (d && d.ok) { showBubble('鱼粮账本：聊天 ' + d.chatTokens + ' tokens，说书 ' + d.storyTokens + ' tokens，共 ' + d.total, 5000) } else showBubble('鱼粮查不到') }).catch(() => showBubble('鱼粮查不到')); return }
        if (action === 'growth') { Promise.all([fetch('/api/chubby-whale/growth').then((r: any) => r.json()), fetch('/api/chubby-whale/state').then((r: any) => r.json())]).then(([g, s]) => { if (g && g.ok) { const nx = g.nextExp > 0 ? ('（经验 ' + g.exp + '/' + g.nextExp + '）') : '（满级）'; const it = (s && s.intimacy) || 0; showBubble('成长：' + g.stage + nx + ' · 亲密度 ' + it + '/100', 5000) } else showBubble('成长查不到') }).catch(() => showBubble('成长查不到')); return }
        if (action === 'intimacy') {
          fetch('/api/chubby-whale/state').then((r: any) => r.json()).then((d: any) => { showBubble('亲密度：' + ((d && d.intimacy) || 0) + ' / 100') }).catch(() => showBubble('亲密度查不到'))
          return
        }
        if (action === 'culture-story') {
          startStory('')
          return
        }        if (action === 'culture-tale') {
          fetch('/api/chubby-whale/culture?type=minsu').then((r: any) => r.json()).then((d: any) => {
            if (d && d.ok && d.item) { showBubble(d.item.text.slice(0, 120) + '…', 9000); animRef.current?.talkFor(5000); speakText(String(d.item.text || '').slice(0, 300)) } else showBubble('故事没讲成')
          }).catch(() => showBubble('故事没讲成'))
          return
        }
        if (action === 'culture-allusion') {
          fetch('/api/chubby-whale/culture?type=chengyu').then((r: any) => r.json()).then((d: any) => {
            if (d && d.ok && d.item) { showBubble('《' + d.item.title + '》（' + (d.item.src || '') + '）' + String(d.item.text || '').slice(0, 100) + '…', 9000); animRef.current?.talkFor(5000); speakText(String(d.item.title || '') + '。' + String(d.item.text || '').slice(0, 280)) } else showBubble('典故没讲成')
          }).catch(() => showBubble('典故没讲成'))
          return
        }
        if (action === 'culture-idiom') {
          fetch('/api/chubby-whale/culture?type=idiom').then((r: any) => r.json()).then((d: any) => {
            if (d && d.ok && d.item) { showBubble(d.item.title + '：' + String(d.item.text || '').slice(0, 100), 8000); speakText(String(d.item.title || '') + '。' + String(d.item.text || '').slice(0, 280)) } else showBubble('没查到')
          }).catch(() => showBubble('没查到'))
          return
        }
        if (action === 'culture-couplet') {
          showBubble('对联小鲸还在整理，回头给你出一对～')
          return
        }
        if (action.startsWith('music:')) {
          const name = action.slice(6)
          fetch('/api/chubby-whale/melody?name=' + encodeURIComponent(name)).then((r: any) => r.json()).then((d: any) => {
            if (d && d.ok && d.song) { playMelody(d.song.notes, d.song.bpm); showBubble('弹《' + d.song.name + '》♪') } else showBubble('这首曲子没找到')
          }).catch(() => showBubble('弹琴失败'))
          return
        }        if (action === 'briefing-now') {
          fetch('/api/chubby-whale/briefing').then((r: any) => r.json()).then((d: any) => {
            if (d && d.ok) { showBubble(d.text, 12000); animRef.current?.talkFor(6000) } else showBubble('简报没做出来')
          }).catch(() => showBubble('简报连不上'))
          return
        }
        if (action === 'briefing') {
          showBubble('简报是开着的，点「现在简报一次」就能看～')
          return
        }        if (action === 'chatmode' || action === 'wake') {
          setChatOpen(true)
          startVoiceChat((t: string) => { setInput(t) })
          showBubble('我在听，说完按发送就好～')
          return
        }
        if (action === 'voice') {
          const nowOn = !voiceOnRef.current
          voiceOnRef.current = nowOn
          setVoiceOn(nowOn)
          try { localStorage.setItem('chubby-voice', nowOn ? 'on' : 'off') } catch (e) { }
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
            if (d && d.ok && d.balance != null) showBubble('余额：¥' + d.balance, 5000)
            else showBubble('余额查不到')
          }).catch(() => showBubble('余额查不到'))
          return
        }
        if (action === 'chat-lang:zh' || action === 'chat-lang:en') {
          const cl = action === 'chat-lang:en' ? 'en' : 'zh'
          try { localStorage.setItem('chubby-chatlang', cl) } catch { }
          showBubble(cl === 'en' ? '聊天语言：English' : '聊天语言：中文')
          return
        }
        if (action === 'briefing-recent') {
          showBubble('最近简报：还没存档（简报不保存历史）', 4000)
          return
        }        if (action === 'lang:zh' || action === 'lang:en') {
          const l = action === 'lang:en' ? 'en' : 'zh'
          try { localStorage.setItem('chubby-lang', l) } catch { }
          setLang(l)
          showBubble(l === 'en' ? 'Language: English' : '界面语言：中文')
          return
        }        if (action === 'dsh') {
          try {
            const q = (window as any).prompt('要把什么问题交给 DSH 助手？（会复制到剪贴板）')
            if (!q) return
            try { await (navigator as any).clipboard.writeText(q) } catch (e) { }
            showBubble('已复制：「' + String(q).slice(0, 40) + '」— 去 DSH 会话里粘贴就行～', 5000)
          } catch (e) { }
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
                const res = await fetch('/api/chubby-whale/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '', image: b64, imageMime: hdr }) })
                const d = await res.json()
                const reply = (d && d.reply) || '这条鱼看不懂这张图……'
                showBubble('（看图）' + reply, 10000)
                speakText(reply)
              } catch (e) { showBubble('图片处理失败', 4000) }
            }
            input.click()
          } catch (e) { showBubble('打不开文件选择', 4000) }
          return
        }        if (action === 'dictate') {
          // 切换口述：开始（录音识别累积）/ 结束（导出 txt）
          if (!dictateRef.current.on) {
            dictateRef.current.on = true
            dictateRef.current.text = ''
            setDictateOn(true)
            setDictText('')
            startDictation((t: string) => {
              dictateRef.current.text += t
              setDictText(dictateRef.current.text)
              showBubble('（口述）' + t, 2500)
            })
            showBubble('口述开始，说话就会转成文字～', 3000)
          } else {
            dictateRef.current.on = false
            setDictateOn(false)
            const body = dictateRef.current.text || '（还没录到内容）'
            try {
              const blob = new Blob([body], { type: 'text/plain;charset=utf-8' })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = '口述公文-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.txt'
              document.body.appendChild(a)
              a.click()
              document.body.removeChild(a)
              URL.revokeObjectURL(url)
            } catch (e) { }
            showBubble('口述结束，已导出 txt（' + body.length + ' 字）', 4000)
          }
          return
        }        if (action === 'test-tts') {
          showBubble('测试语音：主人听得到吗？', 4000)
          speakText('测试语音，主人听得到吗？')
          return
        }        if (action.startsWith('voice:')) {
          const v = action.slice(6)
          try { localStorage.setItem('chubby-tts-voice', v) } catch { }
          showBubble('音色换好啦：' + v.split('-')[2])
          try { const u = new (window as any).SpeechSynthesisUtterance('主人，这个声音好听吗？'); (window as any).speechSynthesis.cancel(); (window as any).speechSynthesis.speak(u) } catch (e) { }
          return
        }        if (action === 'remind-add') {
          const msg = (window as any).prompt('提醒什么？')
          if (!msg) return
          const mins = (window as any).prompt('几分钟后提醒？（填数字，如 5）', '5')
          if (!mins) return
          const at = new Date(Date.now() + Number(mins) * 60000).toISOString()
          fetch('/api/chubby-whale/reminders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: msg, at }) })
            .then((r: any) => r.json()).then((d: any) => { showBubble(d && d.ok ? ('好，' + mins + ' 分钟后提醒你：' + msg) : '提醒没加上') })
            .catch(() => showBubble('提醒没加上'))
          return
        }
        if (action === 'remind-list') {
          fetch('/api/chubby-whale/reminders').then((r: any) => r.json()).then((d: any) => {
            const arr = (d && d.reminders) || []
            if (!arr.length) { showBubble('还没有提醒～'); return }
            const txt = arr.map((x: any) => '· ' + x.text + '（' + new Date(x.at).toLocaleString('zh-CN') + '）').join('\n')
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
          try { if (data && data.reply) speakText(data.reply) } catch { }
          scrollBody()
        }
      }

      // 提醒轮询（每 30 秒检查一次）
      R.useEffect(() => {
        const timer = setInterval(() => {
          fetch('/api/chubby-whale/reminders?action=due').then((r: any) => r.json()).then((d: any) => {
            const due = (d && d.due) || []
            if (due.length > 0 && due[0].text) showBubble('提醒：' + due[0].text, 8000)
          }).catch(() => { })
        }, 30000)
        return () => clearInterval(timer)
      }, [])
      // 语音待命（VAD 版，照 fish-pet）：连续录音，静音 700ms 判定说完，立即上传识别
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
        let totalMs = 0
        let peak = 0
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
        async function uploadChunk() {
          try {
            if (stopped) return
            const blob = new Blob(chunks, { type: 'audio/webm' })
            chunks = []
            if (blob.size < 2500) { startChunk(); return }
            const b64 = await blobToBase64(blob)
            if (!b64) { startChunk(); return }
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
              showBubble('（听到）' + t, 3000)
              sendText(t)
            }
          } catch (e) { }
          if (!stopped) setTimeout(startChunk, 350)
        }
        function startChunk() {
          if (stopped) return
          try {
            chunks = []
            voicedMs = 0; silenceMs = 0; totalMs = 0; peak = 0
            mr.start()
            watch()
          } catch (e) { setTimeout(startChunk, 1000) }
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
            totalMs += 100
            if (avg > SILENCE_GATE) { voicedMs += 100; silenceMs = 0 } else { silenceMs += 100 }
            const done = (voicedMs > 200 && silenceMs >= SILENCE_LIMIT) || totalMs >= VOICE_LIMIT + 2000 || peak > 90 && silenceMs >= 400
            if (done && mr.state === 'recording') {
              try { mr.stop() } catch { }
              setTimeout(uploadChunk, 100)
              return
            }
            if (!stopped) setTimeout(watch, 100)
          } catch (e) { }
        }
        async function boot() {
          try {
            stream = await (navigator as any).mediaDevices.getUserMedia({ audio: true })
            actx = new (window as any).AudioContext()
            const src = actx.createMediaStreamSource(stream)
            analyser = actx.createAnalyser()
            analyser.fftSize = 512
            src.connect(analyser)
            mr = new (window as any).MediaRecorder(stream)
            mr.ondataavailable = (e: any) => { if (e && e.data && e.data.size > 0) chunks.push(e.data) }
            mr.onstop = () => { }
            showBubble('本鲸在听（千问识别），说完就会接话～', 3000)
            startChunk()
          } catch (e) {
            showBubble('麦克风打不开：点地址栏小锁允许麦克风', 6000)
          }
        }
        function onFirstGesture() {
          if (started) return
          started = true
          try { (document as any).removeEventListener('pointerdown', onFirstGesture); (document as any).removeEventListener('keydown', onFirstGesture) } catch { }
          boot()
        }
        try {
          (document as any).addEventListener('pointerdown', onFirstGesture)
          (document as any).addEventListener('keydown', onFirstGesture)
        } catch { }
        return () => {
          stopped = true
          try { if (mr && mr.state === 'recording') mr.stop() } catch { }
          try { if (actx) actx.close() } catch { }
          try { if (stream) stream.getTracks().forEach((t: any) => t.stop()) } catch { }
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
          onDrop: (e: any) => { onFileDrop(e); },
          onClick: () => { if (dragRef.current.moved > 8) return; animRef.current?.talkFor(1200) },
        },
          h('canvas', { ref: canvasRef, width: CW, height: CH, style: canvasStyle }),
        ),
        h('div', { ref: bubbleRef, className: 'chubby-bubble' }, h('div', { ref: bubbleTextRef })),
        menu ? h('div', { style: menuStyle(menu) },
          h('div', { style: { padding: '8px 14px', borderBottom: '1px solid #1f4a85', color: '#9FD8FF', fontSize: 12, display: 'flex', justifyContent: 'space-between' } },
            h('span', null, (lang === 'en' ? 'Fat Whale · v' : '肥鲸 · v') + VERSION),
            h('span', { style: { color: '#FFD166' } }, balanceText)),
          renderItems(buildMenu(VERSION, { voiceOn: voiceOn, balance: balanceLabel, growth: growthLabel })),
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
              onKeyDown: (e: any) => { if (e.key === 'Enter' && input.trim()) { sendText(input); setInput('') } },
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
