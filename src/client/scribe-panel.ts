/**
 * client/scribe-panel.ts —— 「小鲸代笔」浮动面板（DOM，不依赖 React）
 *
 * 2026-11-14 主人 7 条改版后的样子：
 *   · 面板主体是一张**可编辑的正文**（textarea，纸张观感）：主人可以随意改字、删字、
 *     改标点、回车分段；
 *   · 语音识别到的整句由 client.ts 的 session.push 直接接进正文当前段落末尾
 *     （不换行、不编号、不列表；中文直接接，英文按需一个空格）——面板只负责显示；
 *   · 只有一个话筒按钮：🎤 = 开始听写，听写中变 ● 绿色，再点 = 暂停；
 *   · 工具栏有「保存类型」下拉（TXT 文档 / DOCX 文档，默认 DOCX）；
 *     只有一个「保存」按钮，点一下直接按当前类型保存（不再弹二次选择气泡）；
 *   · 「清空」清正文；「×」关闭面板（关闭/卸载时 client.ts 会释放临时麦克风）；
 *   · 没有「停止」按钮，也没有 stopped 语义。
 *
 * 设计约束（与 cabinet-panel.ts 同一套纪律）：
 *   · 不 import React；只操作调用方传入的 document；没有 doc（Node/测试）时整体 no-op；
 *   · 不写浏览器存储、不往 window 挂全局、不调用 fetch、不保存文件本体
 *     （保存动作由 client.ts 注入的 onSave(kind, text) 完成，面板只管回调与提示）；
 *   · 打开时不 focus 任何元素（不抢主人正在打的字）；可拖动：按住标题栏移动。
 *
 * 面板只认 `update(state)` 这一份数据：正文/状态/错误提示全由 client.ts 传入；
 * 用户在 textarea 里的编辑通过 onTextChange 交回 client.ts（session.setText）。
 */

/** 面板层级：高于菜单(10001)、聊天面板(10000)与推演室(2147483200) */
export const SCRIBE_PANEL_Z_INDEX = 2147483300

/** update() 收的面板状态（client.ts 直接传 scribe-session 的 getState()，字段结构兼容） */
export type ScribePanelState = {
  /** idle / active / paused（其它值按 idle 显示；没有 stopped） */
  status?: string
  /** 正文全文（textarea 的内容） */
  text?: string
  /** 已接进正文的句数（用于状态行提示） */
  count?: number
  /** 最近一次被忽略/拒绝的原因（空串不显示） */
  lastError?: string
}

/** 保存回调的返回：false 或 {ok:false} 视为失败；其余视为成功（可带 filename） */
export type ScribePanelSaveResult = boolean | void | { ok?: boolean; name?: string; error?: string } | null
/**
 * 保存回调：kind = 当前「保存类型」下拉值（'txt' | 'docx'）；
 * text = 当前正文全文（client.ts 保存时还会以 session.getText() 为准）。
 */
export type ScribePanelSaveHandler = (kind: 'txt' | 'docx', text: string) => ScribePanelSaveResult | Promise<ScribePanelSaveResult>

export interface ScribePanelOptions {
  /** 文档对象；缺省用全局 document（Node/测试没有 doc 时整体 no-op） */
  doc?: Document
  /** 点话筒：开始/暂停听写（按当前状态由 client.ts 决定 start 还是 pause） */
  onMic?: () => void | Promise<void>
  /** 正文被用户编辑：把 textarea 的新全文交回（client.ts → session.setText） */
  onTextChange?: (text: string) => void
  /** 点「清空」：正文清空由调用方在回调里完成并回传 update */
  onClear?: () => void | Promise<void>
  /** 点「保存」：kind = 当前保存类型（默认 DOCX），text = 正文全文；返回值决定成功/失败提示 */
  onSave?: ScribePanelSaveHandler
  /** 点关闭（面板会先隐藏，再回调） */
  onClose?: () => void
}

export interface ScribePanel {
  /** 打开面板（首次调用时创建 DOM）；没有 document 时安全 no-op */
  open: () => void
  /** 隐藏面板（不销毁 DOM；正文由调用方状态决定，下次打开仍在） */
  close: () => void
  /** 关闭并移除全部 DOM / document 级监听；之后 open 不再生效 */
  destroy: () => void
  isOpen: () => boolean
  /** 用会话状态刷新面板（正文、状态、话筒图标、错误提示） */
  update: (state: ScribePanelState) => void
  /** 覆盖一行提示（例如「已保存：文件名」）；不传则清掉提示 */
  notice: (text?: string, isError?: boolean) => void
}

const FONT_FAMILY = '"Microsoft YaHei","Leelawadee UI",Tahoma,"Noto Sans Thai",sans-serif'
const CARD_FG = '#17324a'
const CARD_BG = 'linear-gradient(165deg,#fdfcf7 0%,#f5f9ff 60%,#eef5fc 100%)'
const FIELD_BORDER = '1px solid rgba(86,122,154,0.38)'
const BTN_FONT = '13px ' + FONT_FAMILY
const PAPER_BG = 'repeating-linear-gradient(180deg, rgba(255,255,255,0) 0px, rgba(255,255,255,0) 27px, rgba(86,122,154,0.10) 28px), linear-gradient(180deg,#fffefb,#fffdf6)'

/** 状态文案与圆点颜色：目标恒为「本面板」（不做第三方窗口注入） */
const STATUS_VIEW: { [key: string]: { dot: string; color: string; text: string } } = {
  idle: { dot: '#8aa0b4', color: '#5b7288', text: '待开始 · 本面板' },
  active: { dot: '#1F9D55', color: '#166534', text: '正在听写 · 本面板' },
  paused: { dot: '#d99a1f', color: '#8a5a06', text: '已暂停 · 本面板' },
}

/** 逐个属性写 style：不用 cssText，测试里的假元素只要 style 是普通对象就能跑 */
function css(el: any, props: { [key: string]: string | number }): void {
  try {
    if (!el || !el.style) return
    for (const key of Object.keys(props)) el.style[key] = props[key]
  } catch (e) { }
}

function attr(el: any, name: string, value: string): void {
  try { if (el && typeof el.setAttribute === 'function') el.setAttribute(name, value) } catch (e) { }
}

function text(el: any, value: string): void {
  try { if (el) el.textContent = value } catch (e) { }
}

/** 建一个带内联样式与 data-role 的元素（createElement 不可用时返回 null） */
function make(doc: any, tag: string, role: string, props: { [key: string]: string | number }): any {
  try {
    const el: any = doc.createElement(tag)
    if (role) attr(el, 'data-role', role)
    css(el, props)
    return el
  } catch (e) {
    return null
  }
}

/** 取异常的可读文案（提示行不能显示 [object Object]） */
function errorMessage(err: any): string {
  try {
    const msg = err && err.message ? String(err.message) : ''
    if (msg) return msg.length > 120 ? msg.slice(0, 120) + '…' : msg
  } catch (e) { }
  return '请稍后再试'
}

/** 保存结果归一：false / {ok:false} 失败，其余成功；提取可选文件名 */
function normalizeSaveResult(res: any): { ok: boolean; name: string; error: string } {
  if (res === false) return { ok: false, name: '', error: '' }
  if (res && typeof res === 'object' && res.ok === false) {
    return { ok: false, name: '', error: String(res.error || '') }
  }
  const name = (res && typeof res === 'object' && res.name) ? String(res.name) : ''
  return { ok: true, name, error: '' }
}

/**
 * 建一块代笔面板。
 * @param options.doc 可注入 document（测试用假 document）；不传则用全局 document
 */
export function createScribePanel(options: ScribePanelOptions = {}): ScribePanel {
  const doc: any = options.doc || (typeof document !== 'undefined' ? document : null)

  // 回调：缺省全部安全 no-op，不因为少接一根线就崩
  const onMic = typeof options.onMic === 'function' ? options.onMic : () => { }
  const onTextChange = typeof options.onTextChange === 'function' ? options.onTextChange : () => { }
  const onClear = typeof options.onClear === 'function' ? options.onClear : () => { }
  const onSave = typeof options.onSave === 'function' ? options.onSave : () => true
  const onClose = typeof options.onClose === 'function' ? options.onClose : () => { }

  let root: any = null
  let card: any = null
  let header: any = null
  let statusText: any = null
  let statusDot: any = null
  let countText: any = null
  let textarea: any = null
  let noticeEl: any = null
  let micBtn: any = null
  let saveBtn: any = null
  let clearBtn: any = null
  let closeBtn: any = null
  let saveTypeSelect: any = null

  /** 当前保存类型：面板本地 UI 状态，默认 DOCX（不进 session，不写存储） */
  let saveKind: 'txt' | 'docx' = 'docx'

  let opened = false
  let destroyed = false
  let saving = false
  let escBound = false
  let dragBound = false
  let dragging: { x: number; y: number } | null = null
  let posLeft: number | null = null
  let posTop: number | null = null

  const lastState: Required<ScribePanelState> = { status: 'idle', text: '', count: 0, lastError: '' }

  // ==================================================================
  // 小工具：状态/提示/按钮外观
  // ==================================================================

  function statusView(status: string): { dot: string; color: string; text: string } {
    return STATUS_VIEW[status] || STATUS_VIEW.idle
  }

  function notice(msg?: string, isError = false): void {
    if (!noticeEl) return
    const line = String(msg == null ? '' : msg).trim()
    try {
      noticeEl.textContent = line
      if (noticeEl.style) {
        noticeEl.style.display = line ? 'block' : 'none'
        noticeEl.style.color = isError ? '#b42318' : '#17653b'
        noticeEl.style.background = isError ? '#fef3f2' : '#eefaf1'
        noticeEl.style.borderColor = isError ? 'rgba(180,35,24,0.3)' : 'rgba(21,87,36,0.2)'
      }
    } catch (e) { }
  }

  /** 话筒按钮：🎤 = 可开始；● 绿色 = 正在听写（点击暂停） */
  function renderMic(): void {
    if (!micBtn) return
    const active = lastState.status === 'active'
    text(micBtn, active ? '●' : '🎤')
    attr(micBtn, 'aria-label', active ? '暂停听写' : '开始听写')
    try { micBtn.title = active ? '正在听写，点一下暂停' : '开始听写（说的话直接接进正文）' } catch (e) { }
    css(micBtn, active ? {
      background: '#1F9D55', color: '#ffffff', borderColor: '#1F9D55',
      boxShadow: '0 0 0 4px rgba(31,157,85,0.18), 0 4px 10px rgba(22,101,52,0.28)',
    } : {
      background: '#e8f3ff', color: '#1f5f9e', borderColor: 'rgba(46,107,184,0.35)',
      boxShadow: '0 1px 2px rgba(20,48,80,0.10)',
    })
  }

  function renderStatus(): void {
    const view = statusView(lastState.status)
    try { if (statusDot && statusDot.style) statusDot.style.background = view.dot } catch (e) { }
    try { if (statusText && statusText.style) statusText.style.color = view.color } catch (e) { }
    text(statusText, view.text)
    // 句数只作提示：0 句不显示，免得多一行噪音
    text(countText, lastState.count > 0 ? '已接 ' + lastState.count + ' 句' : '')
    renderMic()
  }

  /** 正文同步：值与面板一致就不动（避免用户打字时光标被重置）；不一致时尽量保住选区 */
  function syncText(next: string, force = false): void {
    if (!textarea) return
    const value = String(next == null ? '' : next)
    if (!force && textarea.value === value) return
    const focused = !!(doc && doc.activeElement === textarea)
    let start = 0
    let end = 0
    if (focused) {
      try {
        start = Number(textarea.selectionStart) || 0
        end = Number(textarea.selectionEnd) || 0
      } catch (e) { }
    }
    try { textarea.value = value } catch (e) { return }
    if (focused) {
      try {
        if (typeof textarea.setSelectionRange === 'function') {
          const len = value.length
          textarea.setSelectionRange(Math.min(start, len), Math.min(end, len))
        }
      } catch (e) { }
    }
  }

  // ==================================================================
  // 保存：工具栏「保存类型」下拉决定存成 TXT 还是 DOCX；点「保存」直接存
  // ==================================================================

  function currentText(): string {
    try {
      if (textarea && typeof textarea.value === 'string') return textarea.value
    } catch (e) { }
    return lastState.text
  }

  async function runSave(): Promise<void> {
    if (destroyed || saving) return
    const kind: 'txt' | 'docx' = saveKind
    const body = currentText()
    const label = kind === 'docx' ? 'DOCX' : 'TXT'
    saving = true
    let res: any = null
    try {
      res = await Promise.resolve(onSave(kind, body))
    } catch (err) {
      res = { ok: false, error: errorMessage(err) }
    }
    saving = false
    const norm = normalizeSaveResult(res)
    if (!norm.ok) {
      notice('保存 ' + label + ' 失败：' + (norm.error || '请稍后再试'), true)
      return
    }
    // 保存成功：正文原样保留，只给一行提示
    notice('已保存 ' + label + (norm.name ? '：' + norm.name : ''), false)
  }

  // ==================================================================
  // 拖动：标题栏按下后把卡片位置改成 left/top，move 时钳制在视口内
  // ==================================================================

  function viewportSize(): { w: number; h: number } {
    try {
      const win: any = doc && doc.defaultView ? doc.defaultView : (typeof window !== 'undefined' ? window : null)
      const w = Number(win && win.innerWidth) || Number(doc && doc.documentElement && doc.documentElement.clientWidth) || 1024
      const h = Number(win && win.innerHeight) || Number(doc && doc.documentElement && doc.documentElement.clientHeight) || 768
      return { w: Math.max(320, w), h: Math.max(240, h) }
    } catch (e) { return { w: 1024, h: 768 } }
  }

  /** 卡片尺寸：优先 getBoundingClientRect，退化为样式/默认值（假元素也能跑） */
  function cardSize(): { w: number; h: number } {
    const view = viewportSize()
    const fallbackW = Math.min(430, view.w * 0.92)
    const fallbackH = Math.min(560, view.h * 0.82)
    try {
      if (card && typeof card.getBoundingClientRect === 'function') {
        const r = card.getBoundingClientRect()
        if (r && Number(r.width) > 0 && Number(r.height) > 0) return { w: Number(r.width), h: Number(r.height) }
      }
      const w = Number(card && card.offsetWidth) || fallbackW
      const h = Number(card && card.offsetHeight) || fallbackH
      return { w, h }
    } catch (e) { return { w: fallbackW, h: fallbackH } }
  }

  function applyPosition(): void {
    if (!card || !card.style) return
    const view = viewportSize()
    const size = cardSize()
    const maxLeft = Math.max(8, view.w - size.w - 8)
    const maxTop = Math.max(8, view.h - size.h - 8)
    // 第一次打开默认靠右上（不挡聊天输入框）；拖动后记住位置
    if (posLeft === null) posLeft = Math.max(8, view.w - size.w - 24)
    if (posTop === null) posTop = 88
    posLeft = Math.min(Math.max(8, posLeft), maxLeft)
    posTop = Math.min(Math.max(8, posTop), maxTop)
    card.style.left = Math.round(posLeft) + 'px'
    card.style.top = Math.round(posTop) + 'px'
    card.style.right = 'auto'
  }

  function onDocMove(ev: any): void {
    if (!dragging) return
    try {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault()
      posLeft = Number(ev && ev.clientX) - dragging.x
      posTop = Number(ev && ev.clientY) - dragging.y
      applyPosition()
    } catch (e) { }
  }

  function onDocUp(): void {
    dragging = null
    unbindDrag()
  }

  function bindDrag(): void {
    if (dragBound || !doc || typeof doc.addEventListener !== 'function') return
    try {
      doc.addEventListener('mousemove', onDocMove)
      doc.addEventListener('mouseup', onDocUp)
      dragBound = true
    } catch (e) { }
  }

  function unbindDrag(): void {
    if (!dragBound || !doc || typeof doc.removeEventListener !== 'function') return
    try {
      doc.removeEventListener('mousemove', onDocMove)
      doc.removeEventListener('mouseup', onDocUp)
      dragBound = false
    } catch (e) { }
  }

  function startDrag(ev: any): void {
    if (!opened || !card || !ev) return
    try {
      if (Number(ev.button) !== 0) return
      if (ev.target && ev.target !== ev.currentTarget) {
        const role = ev.target.getAttribute && ev.target.getAttribute('data-role')
        if (role === 'scribe-close') return
        if (ev.target.tagName === 'BUTTON') return
      }
      const r = card.getBoundingClientRect ? card.getBoundingClientRect() : null
      const left = r ? Number(r.left) : Number(String(card.style.left || '').replace('px', '')) || posLeft || 0
      const top = r ? Number(r.top) : Number(String(card.style.top || '').replace('px', '')) || posTop || 0
      dragging = { x: Number(ev.clientX) - left, y: Number(ev.clientY) - top }
      if (typeof ev.preventDefault === 'function') ev.preventDefault()
      bindDrag()
    } catch (e) { }
  }

  /** document 级 Esc：只在面板打开时响应，关闭/销毁后不再占用按键 */
  function onKeyDown(ev: any): void {
    if (!opened) return
    try {
      if (!ev || ev.key !== 'Escape') return
      if (typeof ev.preventDefault === 'function') ev.preventDefault()
      close()
    } catch (e) { }
  }

  function bindEsc(): void {
    if (escBound || !doc || typeof doc.addEventListener !== 'function') return
    try { doc.addEventListener('keydown', onKeyDown); escBound = true } catch (e) { }
  }

  function unbindEsc(): void {
    if (!escBound || !doc || typeof doc.removeEventListener !== 'function') return
    try { doc.removeEventListener('keydown', onKeyDown); escBound = false } catch (e) { }
  }

  // ==================================================================
  // DOM
  // ==================================================================

  /** 按钮工厂：统一外观；kind=primary 用深蓝渐变，否则奶白底 */
  function makeButton(role: string, label: string, onClick: () => void, opts: { primary?: boolean; round?: boolean } = {}): any {
    const primary = !!opts.primary
    const round = !!opts.round
    const btn = make(doc, 'button', role, {
      padding: round ? '0' : '7px 14px',
      width: round ? '42px' : 'auto', height: round ? '42px' : 'auto',
      borderRadius: round ? '50%' : '11px',
      border: primary ? '0' : FIELD_BORDER,
      background: primary ? 'linear-gradient(135deg,#2E6BB8,#4A8FD6)' : '#fffdf8',
      color: primary ? '#fff' : CARD_FG,
      cursor: 'pointer', font: BTN_FONT,
      fontWeight: primary ? '600' : '500',
      boxShadow: primary ? '0 3px 10px rgba(46,107,184,0.28)' : '0 1px 2px rgba(20,48,80,0.08)',
      fontSize: round ? '18px' : BTN_FONT,
      lineHeight: round ? '1' : 'normal',
    })
    if (!btn) return null
    try { btn.type = 'button' } catch (e) { }
    text(btn, label)
    attr(btn, 'aria-label', label)
    if (typeof btn.addEventListener === 'function') {
      btn.addEventListener('click', (ev: any) => {
        try { if (ev && typeof ev.preventDefault === 'function') ev.preventDefault() } catch (e) { }
        try { void onClick() } catch (e) { }
      })
    }
    return btn
  }

  /** 懒建 DOM：首次 open 时才创建；没有 doc / 建失败返回 false（调用方按 no-op 继续） */
  function ensureDom(): boolean {
    if (destroyed) return false
    if (root) return true
    if (!doc || typeof doc.createElement !== 'function') return false
    if (!doc.body || typeof doc.body.appendChild !== 'function') return false
    try {
      root = make(doc, 'div', 'scribe-panel', {
        position: 'fixed', inset: '0', zIndex: String(SCRIBE_PANEL_Z_INDEX),
        display: 'block', background: 'transparent', pointerEvents: 'none', userSelect: 'none',
      })
      if (!root) return false
      attr(root, 'role', 'dialog')
      attr(root, 'aria-modal', 'false')
      attr(root, 'aria-label', '小鲸代笔')

      // —— 卡片：奶白纸感 + 深蓝标题 + 柔和阴影 ——
      card = make(doc, 'div', 'scribe-card', {
        position: 'fixed', width: 'min(430px,92vw)', maxHeight: '82vh',
        display: 'flex', flexDirection: 'column', boxSizing: 'border-box',
        background: CARD_BG, color: CARD_FG, border: '1px solid rgba(80,120,160,0.38)',
        borderRadius: '20px', boxShadow: '0 26px 70px rgba(8,24,42,0.30), 0 2px 0 rgba(255,255,255,0.85) inset',
        overflow: 'visible', pointerEvents: 'auto', font: '13.5px/1.6 ' + FONT_FAMILY,
      })
      if (!card) return false

      // —— 标题栏（拖动把手）——
      header = make(doc, 'div', 'scribe-drag', {
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px',
        cursor: 'move', padding: '14px 16px 12px',
        background: 'linear-gradient(135deg,#12283c 0%,#1f4a76 55%,#2E6BB8 100%)',
        color: '#ffffff', borderRadius: '20px 20px 0 0',
        boxShadow: '0 10px 24px rgba(16,40,70,0.22)',
      })
      const titleBox = make(doc, 'div', 'scribe-title-box', { flex: '1 1 auto', minWidth: '0' })
      const title = make(doc, 'div', 'scribe-title', {
        fontWeight: '700', fontSize: '15.5px', letterSpacing: '0.2px', marginBottom: '2px', color: '#ffffff',
      })
      text(title, '小鲸代笔')
      const subtitle = make(doc, 'div', 'scribe-subtitle', { color: 'rgba(235,246,255,0.84)', fontSize: '11.5px' })
      text(subtitle, '说一句、落一句，直接接在正文段落里；回车＝新起一段。')
      closeBtn = makeButton('scribe-close', '×', () => { try { close() } catch (e) { } })
      if (closeBtn) {
        css(closeBtn, {
          flex: '0 0 auto', width: '26px', height: '26px', borderRadius: '8px',
          background: 'rgba(255,255,255,0.14)', color: '#ffffff', border: FIELD_BORDER,
          fontSize: '16px', lineHeight: '1', padding: '0', boxShadow: 'none',
        })
        text(closeBtn, '×')
        attr(closeBtn, 'aria-label', '关闭代笔面板')
      }

      // —— 状态行：圆点 + 状态 + 已接句数 ——
      const statusRow = make(doc, 'div', 'scribe-status-row', {
        display: 'flex', alignItems: 'center', gap: '7px',
        padding: '10px 16px 0', fontSize: '12.5px',
      })
      statusDot = make(doc, 'span', 'scribe-status-dot', {
        width: '8px', height: '8px', borderRadius: '50%', background: '#8aa0b4', flex: '0 0 auto',
      })
      statusText = make(doc, 'span', 'scribe-status', { color: '#5b7288', fontWeight: '600' })
      text(statusText, '待开始 · 本面板')
      countText = make(doc, 'span', 'scribe-count', { color: '#7b93a8', fontSize: '11.5px', marginLeft: 'auto' })
      text(countText, '')
      if (statusRow) { statusRow.appendChild(statusDot); statusRow.appendChild(statusText); statusRow.appendChild(countText) }

      // —— 正文：可编辑 textarea（纸张观感；用户随意改字、回车分段）——
      textarea = make(doc, 'textarea', 'scribe-textarea', {
        margin: '8px 16px 0', padding: '10px 12px',
        minHeight: '220px', maxHeight: '46vh', height: '260px',
        boxSizing: 'border-box', resize: 'vertical', outline: 'none',
        background: PAPER_BG, color: CARD_FG,
        border: FIELD_BORDER, borderRadius: '12px',
        font: '14px/28px ' + FONT_FAMILY,
        boxShadow: '0 1px 2px rgba(20,48,80,0.06) inset',
      })
      if (textarea) {
        try { textarea.placeholder = '在这里写正文。点话筒说话，整句会直接接在正文当前段落末尾；回车＝新起一段。' } catch (e) { }
        attr(textarea, 'aria-label', '代笔正文（可编辑）')
        attr(textarea, 'spellcheck', 'false')
        try { textarea.value = '' } catch (e) { }
        if (typeof textarea.addEventListener === 'function') {
          textarea.addEventListener('input', () => {
            let value = ''
            try { value = String(textarea.value == null ? '' : textarea.value) } catch (e) { }
            try { onTextChange(value) } catch (e) { }
          })
        }
      }

      // —— 提示行（保存结果/错误）——
      noticeEl = make(doc, 'div', 'scribe-notice', {
        display: 'none', margin: '8px 16px 0', padding: '6px 9px', borderRadius: '9px',
        fontSize: '12px', border: '1px solid rgba(21,87,36,0.2)', background: '#eefaf1', color: '#17653b',
      })
      attr(noticeEl, 'role', 'status')
      text(noticeEl, '')

      // —— 底栏：话筒 / 保存类型下拉 / 清空 / 保存（点一下直接按当前类型存）——
      const bar = make(doc, 'div', 'scribe-actions', {
        position: 'relative', display: 'flex', alignItems: 'center', gap: '10px',
        padding: '12px 16px 16px',
      })
      micBtn = makeButton('scribe-mic', '🎤', () => { onMic() }, { round: true })
      saveBtn = makeButton('scribe-save', '保存', () => { void runSave() }, { primary: true })
      clearBtn = makeButton('scribe-clear', '清空', () => { onClear() })
      const spacer = make(doc, 'div', 'scribe-spacer', { flex: '1 1 auto' })
      if (!bar) return false

      // 保存类型下拉：默认 DOCX；选择记在面板本地（不写存储），点「保存」直接生效
      const saveTypeWrap = make(doc, 'div', 'scribe-save-type-wrap', {
        display: 'flex', alignItems: 'center', gap: '6px', flex: '0 0 auto',
      })
      const saveTypeLabel = make(doc, 'span', 'scribe-save-type-label', {
        color: '#5b7288', fontSize: '12px', whiteSpace: 'nowrap',
      })
      text(saveTypeLabel, '保存类型')
      saveTypeSelect = make(doc, 'select', 'scribe-save-type', {
        padding: '6px 8px', borderRadius: '9px', border: FIELD_BORDER,
        background: '#fffdf8', color: CARD_FG, cursor: 'pointer',
        font: '12.5px ' + FONT_FAMILY, outline: 'none', maxWidth: '130px',
      })
      if (!saveTypeWrap || !saveTypeLabel || !saveTypeSelect) return false
      attr(saveTypeSelect, 'aria-label', '保存类型')
      for (const pair of [['docx', 'DOCX 文档'], ['txt', 'TXT 文档']]) {
        const opt = make(doc, 'option', 'scribe-save-type-option', {})
        if (!opt) return false
        try { opt.value = pair[0] } catch (e) { }
        text(opt, pair[1])
        saveTypeSelect.appendChild(opt)
      }
      try { saveTypeSelect.value = 'docx' } catch (e) { }
      try { saveBtn.title = '保存为 DOCX 文档' } catch (e) { }
      if (typeof saveTypeSelect.addEventListener === 'function') {
        saveTypeSelect.addEventListener('change', () => {
          let value = ''
          try { value = String(saveTypeSelect.value || '') } catch (e) { }
          saveKind = value === 'txt' ? 'txt' : 'docx'
          try { if (saveBtn) saveBtn.title = '保存为 ' + (saveKind === 'docx' ? 'DOCX' : 'TXT') + ' 文档' } catch (e) { }
        })
      }
      saveTypeWrap.appendChild(saveTypeLabel)
      saveTypeWrap.appendChild(saveTypeSelect)

      for (const node of [micBtn, saveTypeWrap, spacer, clearBtn, saveBtn]) {
        if (!node) return false
        bar.appendChild(node)
      }

      // —— 组装 ——
      header.appendChild(titleBox)
      titleBox.appendChild(title)
      titleBox.appendChild(subtitle)
      header.appendChild(closeBtn)
      card.appendChild(header)
      card.appendChild(statusRow)
      card.appendChild(textarea)
      card.appendChild(noticeEl)
      card.appendChild(bar)
      root.appendChild(card)

      // —— 事件：拖动 ——
      if (header && typeof header.addEventListener === 'function') {
        header.addEventListener('mousedown', (ev: any) => { startDrag(ev) })
      }
      return true
    } catch (e) {
      root = null
      card = null
      return false
    }
  }

  function open(): void {
    if (destroyed) return
    if (!ensureDom()) return
    bindEsc()
    try {
      if (doc && doc.body && root.parentNode !== doc.body) doc.body.appendChild(root)
    } catch (e) {
      return
    }
    opened = true
    try { if (root && root.style) root.style.display = 'block' } catch (e) { }
    applyPosition()
    // 打开时用最近一次状态刷新（不 focus 任何元素，不抢主人正在打的字）
    renderStatus()
    syncText(lastState.text)
  }

  function close(): void {
    if (!opened && !root) return
    opened = false
    dragging = null
    unbindDrag()
    unbindEsc()
    if (root) {
      try { if (root.style) root.style.display = 'none' } catch (e) { }
      try {
        if (root.parentNode && typeof root.parentNode.removeChild === 'function') root.parentNode.removeChild(root)
        else if (typeof root.remove === 'function') root.remove()
      } catch (e) { }
    }
    try { onClose() } catch (e) { }
  }

  function destroy(): void {
    if (destroyed) return
    opened = false
    destroyed = true
    dragging = null
    unbindDrag()
    unbindEsc()
    const node = root
    root = null
    card = null
    header = null
    statusText = null
    statusDot = null
    countText = null
    textarea = null
    noticeEl = null
    micBtn = null
    saveBtn = null
    clearBtn = null
    closeBtn = null
    saveTypeSelect = null
    if (!node) return
    try {
      if (typeof node.remove === 'function') node.remove()
      else if (node.parentNode && typeof node.parentNode.removeChild === 'function') node.parentNode.removeChild(node)
    } catch (e) { }
    // destroy 不走 onClose（卸载收尾，不再触发业务动作）
  }

  function update(state: ScribePanelState = {}): void {
    if (destroyed) return
    const status = String(state.status || 'idle')
    lastState.status = STATUS_VIEW[status] ? status : 'idle'
    lastState.text = String(state.text == null ? '' : state.text)
    lastState.count = Math.max(0, Math.floor(Number(state.count) || 0))
    lastState.lastError = String(state.lastError == null ? '' : state.lastError)
    if (!root) return
    renderStatus()
    syncText(lastState.text)
    // 会话被拒的原因（例如暂停时还有语音进来）只在面板打开时提示，不覆盖保存提示
    if (lastState.lastError) notice(lastState.lastError, true)
  }

  return { open, close, destroy, isOpen: () => opened, update, notice }
}
