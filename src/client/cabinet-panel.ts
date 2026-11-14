/**
 * client/cabinet-panel.ts —— 「鲸群推演室」议题收集面板（DOM，不依赖 React）
 *
 * 用途：主人右键 → 推演 ▸ → 开始推演…，弹出这块面板填写：
 *   · 决定（必填）：这次到底要定什么事；
 *   · 背景与约束（可选）：已知事实、限制、担心；
 *   · 候选选项（可选）：A/B/C 或「还没想好」；
 *   · 期限（可选）：什么时候必须拍板。
 * 点「开始推演」后把四个字段交给调用方（client.ts 用 shared/cabinet.ts 拼简报、
 * 写剪贴板并打开聊天面板）；面板自己不拼简报、不复制、不发消息、不碰任务板。
 *
 * 设计约束：
 *   · 不 import React；只操作调用方传入的 document（Node / 测试环境没有 doc 时整体 no-op）；
 *   · 不写 localStorage，不往 window / document 上挂全局变量；
 *   · 样式与鱼 UI 同色系：奶白卡片 + 深蓝字（与鲸鱼看板一致），z-index 高于菜单/聊天面板；
 *   · Esc / 点遮罩 / 取消 都只关闭，不提交；提交失败（onSubmit 返回 false 或抛错）
 *     在面板内显示一行内联错误并保持打开，绝不让主人白填一遍。
 */

/** 面板层级：高于菜单(10001)、聊天面板(10000) 与看板(2147483000) */
export const CABINET_PANEL_Z_INDEX = 2147483200

/** onSubmit 收到的四段纯文本（已 trim；空的可选字段传空串，由简报层给占位文案） */
export interface CabinetPanelInput {
  decision: string
  context: string
  options: string
  deadline: string
}

/** 提交回调：返回 false 或抛错 = 失败（保持打开并显示内联错误）；其余都按成功关闭 */
export type CabinetPanelSubmit =
  (input: CabinetPanelInput) => boolean | void | Promise<boolean | void>

export interface CabinetPanelOptions {
  /** 文档对象；缺省时用全局 document（Node / 测试下没有则整体 no-op） */
  doc?: Document
  /** 提交回调；缺省视为总是成功（测试与降级用） */
  onSubmit?: CabinetPanelSubmit
}

export interface CabinetPanel {
  /** 打开面板（首次调用时才建 DOM）；没有 document 时安全 no-op */
  open: () => void
  /** 关闭面板（幂等；DOM 保留供下次复用） */
  close: () => void
  /** 关闭并移除全部 DOM / document 级监听；之后 open 不再生效 */
  destroy: () => void
  /** 面板当前是否打开 */
  isOpen: () => boolean
}

const FONT_FAMILY = '"Microsoft YaHei","Leelawadee UI",Tahoma,"Noto Sans Thai",sans-serif'
const CARD_BG = '#fffbf2'
const CARD_FG = '#17324a'
const BORDER = '1px solid rgba(86,122,154,0.55)'
const FIELD_BORDER = '1px solid rgba(86,122,154,0.45)'

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

/** 建一个带内联样式的元素（createElement 不可用时返回 null，由调用方整体降级） */
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

/** 从元素上读值（字段还没建 / 假元素没有 value 时当空串） */
function fieldValue(el: any): string {
  try {
    if (!el || el.value === undefined || el.value === null) return ''
    return String(el.value).trim()
  } catch (e) {
    return ''
  }
}

/** 取异常的可读文案（内联错误不能显示 [object Object]） */
function errorMessage(err: any): string {
  try {
    const msg = err && err.message ? String(err.message) : ''
    if (msg) return msg.length > 120 ? msg.slice(0, 120) + '…' : msg
  } catch (e) { }
  return '请稍后再试'
}

/**
 * 建一块推演面板。
 * @param options.doc 可注入 document（测试用假 document）；不传则用全局 document
 * @param options.onSubmit 提交回调；返回 false / 抛错 时面板保持打开并显示内联错误
 */
export function createCabinetPanel(options: CabinetPanelOptions = {}): CabinetPanel {
  const doc: any = options.doc ||
    (typeof document !== 'undefined' ? document : null)
  const onSubmit: CabinetPanelSubmit =
    typeof options.onSubmit === 'function' ? options.onSubmit : () => true

  let root: any = null
  let card: any = null
  let decisionInput: any = null
  let contextInput: any = null
  let optionsInput: any = null
  let deadlineInput: any = null
  let errorEl: any = null
  let submitBtn: any = null
  let cancelBtn: any = null
  let bodyBox: any = null
  let successEl: any = null

  let opened = false
  let destroyed = false
  let submitting = false
  let escBound = false
  let dragBound = false
  let dragging: { x: number; y: number } | null = null
  let posLeft: number | null = null
  let posTop: number | null = null

  function hideError(): void {
    try {
      if (errorEl && errorEl.style) errorEl.style.display = 'none'
      if (errorEl) errorEl.textContent = ''
    } catch (e) { }
  }

  function showError(message: string): void {
    try {
      if (!errorEl) return
      errorEl.textContent = String(message || '')
      if (errorEl.style) errorEl.style.display = 'block'
    } catch (e) { }
  }

  function hideSuccess(): void {
    try {
      if (successEl && successEl.style) successEl.style.display = 'none'
      if (successEl) successEl.textContent = ''
    } catch (e) { }
  }

  function showSuccess(): void {
    try {
      if (!successEl || !successEl.style) return
      successEl.textContent =
        '议题已复制 ✓  去对话里粘贴并发送。\n' +
        '推演会以 Agent Team 模式跑：\n' +
        '[FIN] 财务  [RISK] 风险  [CUST] 客户  [OPP] 反方  →  [MEMO] 汇总\n' +
        '结果显示在 DSH 对话里；鱼脚下会显示「推演 3/4」这类进度。'
      successEl.style.display = 'block'
    } catch (e) { }
  }

  function setSubmitting(busy: boolean): void {
    submitting = busy
    try {
      if (!submitBtn) return
      submitBtn.disabled = !!busy
      submitBtn.textContent = busy ? '正在准备…' : '开始推演'
    } catch (e) { }
  }

  function resetFields(): void {
    try {
      if (decisionInput) decisionInput.value = ''
      if (contextInput) contextInput.value = ''
      if (optionsInput) optionsInput.value = ''
      if (deadlineInput) deadlineInput.value = ''
    } catch (e) { }
  }

  function focusDecision(): void {
    try { if (decisionInput && typeof decisionInput.focus === 'function') decisionInput.focus() } catch (e) { }
  }

  /** document 级 Esc：面板打开时才响应，关闭/销毁后不再占用按键 */
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
    try {
      doc.addEventListener('keydown', onKeyDown)
      escBound = true
    } catch (e) { }
  }

  function unbindEsc(): void {
    if (!escBound || !doc || typeof doc.removeEventListener !== 'function') return
    try {
      doc.removeEventListener('keydown', onKeyDown)
      escBound = false
    } catch (e) { }
  }

  /** 浮层视口尺寸：优先 window，其次 documentElement（测试假 doc 也能用） */
  function viewportSize(): { w: number; h: number } {
    try {
      const win: any = doc && doc.defaultView ? doc.defaultView : (typeof window !== 'undefined' ? window : null)
      const w = Number(win && win.innerWidth) || Number(doc && doc.documentElement && doc.documentElement.clientWidth) || 1024
      const h = Number(win && win.innerHeight) || Number(doc && doc.documentElement && doc.documentElement.clientHeight) || 768
      return { w: Math.max(320, w), h: Math.max(240, h) }
    } catch (e) { return { w: 1024, h: 768 } }
  }

  /** 卡片实际尺寸：优先 getBoundingClientRect，退化为样式/最小值 */
  function cardSize(): { w: number; h: number } {
    const view = viewportSize()
    const fallbackW = Math.min(560, view.w * 0.92)
    const fallbackH = Math.min(520, view.h * 0.86)
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

  /** 把卡片放回视口内；第一次打开居中，之后保留主人拖到的位置 */
  function applyPosition(): void {
    if (!card || !card.style) return
    const view = viewportSize()
    const size = cardSize()
    const maxLeft = Math.max(8, view.w - size.w - 8)
    const maxTop = Math.max(8, view.h - size.h - 8)
    if (posLeft === null) posLeft = Math.max(8, (view.w - size.w) / 2)
    if (posTop === null) posTop = Math.max(8, (view.h - size.h) / 2)
    posLeft = Math.min(Math.max(8, posLeft), maxLeft)
    posTop = Math.min(Math.max(8, posTop), maxTop)
    card.style.left = Math.round(posLeft) + 'px'
    card.style.top = Math.round(posTop) + 'px'
    card.style.margin = '0'
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
        if (role === 'cabinet-close') return
        if (ev.target.tagName === 'BUTTON' || ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') return
      }
      const r = card.getBoundingClientRect ? card.getBoundingClientRect() : null
      const left = r ? Number(r.left) : Number(card.style.left.replace('px', '')) || 0
      const top = r ? Number(r.top) : Number(card.style.top.replace('px', '')) || 0
      dragging = { x: Number(ev.clientX) - left, y: Number(ev.clientY) - top }
      if (typeof ev.preventDefault === 'function') ev.preventDefault()
      bindDrag()
    } catch (e) { }
  }

  /** 懒建 DOM：首次 open 时才创建；没有 document / 建失败返回 false（调用方按 no-op 继续） */
  function ensureDom(): boolean {
    if (destroyed) return false
    if (root) return true
    if (!doc || typeof doc.createElement !== 'function') return false
    if (!doc.body || typeof doc.body.appendChild !== 'function') return false
    try {
      // —— 透明浮层：铺满只用于定位，不挡后面的页面；卡片自己接鼠标 ——
      root = make(doc, 'div', 'cabinet-panel', {
        position: 'fixed', inset: '0', zIndex: String(CABINET_PANEL_Z_INDEX),
        display: 'block', background: 'transparent',
        pointerEvents: 'none', userSelect: 'none',
      })
      if (!root) return false
      attr(root, 'role', 'dialog')
      attr(root, 'aria-modal', 'false')
      attr(root, 'aria-label', '鲸群推演室')

      // —— 奶白卡片 ——
      card = make(doc, 'div', 'cabinet-card', {
        position: 'fixed', width: 'min(560px,92vw)', maxHeight: '86vh', display: 'flex', flexDirection: 'column',
        boxSizing: 'border-box', background: 'linear-gradient(160deg,#fffdf7 0%,#f2f8ff 100%)', color: CARD_FG,
        border: '1px solid rgba(80,120,160,0.45)', borderRadius: '20px', padding: '0',
        boxShadow: '0 24px 70px rgba(8,24,42,0.38), 0 2px 0 rgba(255,255,255,0.8) inset', overflowY: 'auto',
        pointerEvents: 'auto', font: '13.5px/1.6 ' + FONT_FAMILY,
      })
      if (!card) return false

      const header = make(doc, 'div', 'cabinet-drag', {
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px',
        cursor: 'move', padding: '16px 18px 14px',
        background: 'linear-gradient(135deg,#17324a 0%,#24578a 55%,#2E6BB8 100%)',
        color: '#ffffff', borderRadius: '20px 20px 0 0',
        boxShadow: '0 10px 26px rgba(20,48,80,0.28)',
      })
      const titleBox = make(doc, 'div', 'cabinet-title-box', { flex: '1 1 auto', minWidth: '0' })
      const title = make(doc, 'div', 'cabinet-title', { fontWeight: '700', fontSize: '16px', letterSpacing: '0.2px', marginBottom: '3px', color: '#ffffff' })
      text(title, '鲸群推演室 · 开一场推演')
      const subtitle = make(doc, 'div', 'cabinet-subtitle', { color: 'rgba(235,246,255,0.86)', fontSize: '12px', lineHeight: '1.5' })
      text(subtitle, '可拖动标题栏移动。写下要决定的事；点「开始推演」会把议题复制到剪贴板，你粘贴到对话里发送后，鱼再召集四位视角。')
      const closeBtn = make(doc, 'button', 'cabinet-close', {
        flex: '0 0 auto', width: '26px', height: '26px', borderRadius: '8px', border: FIELD_BORDER,
        background: 'rgba(255,255,255,0.14)', color: '#ffffff', cursor: 'pointer', font: '18px/1 ' + FONT_FAMILY,
        padding: '0', lineHeight: '24px',
      })
      if (closeBtn) { try { closeBtn.type = 'button' } catch (e) { } attr(closeBtn, 'aria-label', '关闭'); text(closeBtn, '×') }

      const bodyBoxLocal = make(doc, 'div', 'cabinet-body', {
        padding: '14px 18px 16px', display: 'flex', flexDirection: 'column', gap: '2px',
      })
      bodyBox = bodyBoxLocal
      const rolesRow = make(doc, 'div', 'cabinet-roles', {
        display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center', margin: '0 0 8px',
      })
      const roleBadge = make(doc, 'span', 'cabinet-agent-badge', {
        fontSize: '10.5px', fontWeight: '700', letterSpacing: '0.4px', color: '#1f5f9e',
        background: '#e8f3ff', border: '1px solid rgba(46,107,184,0.28)', borderRadius: '999px',
        padding: '3px 8px', whiteSpace: 'nowrap',
      })
      text(roleBadge, 'AGENT TEAM')
      rolesRow.appendChild(roleBadge)
      for (const [role, label] of [['FIN', '财务'], ['RISK', '风险'], ['CUST', '客户'], ['OPP', '反方']]) {
        const chip = make(doc, 'span', 'cabinet-role-chip', {
          fontSize: '11px', color: '#2b4f72', background: 'rgba(255,255,255,0.72)',
          border: '1px solid rgba(86,122,154,0.25)', borderRadius: '999px', padding: '3px 8px',
        })
        text(chip, '[' + role + '] ' + label)
        rolesRow.appendChild(chip)
      }
      rolesRow.appendChild((() => {
        const memo = make(doc, 'span', 'cabinet-role-chip', {
          fontSize: '11px', color: '#7a4a12', background: '#fff4df',
          border: '1px solid rgba(185,120,20,0.28)', borderRadius: '999px', padding: '3px 8px',
        })
        text(memo, '[MEMO] 汇总')
        return memo
      })())

      const labelProps = { display: 'block', fontWeight: '600', margin: '7px 0 4px', fontSize: '12.5px', color: '#254866' }
      const fieldBase = {
        width: '100%', boxSizing: 'border-box', background: '#ffffff', color: CARD_FG,
        border: FIELD_BORDER, borderRadius: '9px', padding: '7px 9px',
        font: '13px/1.55 ' + FONT_FAMILY, outline: 'none', resize: 'vertical',
      }

      const decisionLabel = make(doc, 'div', 'cabinet-decision-label', labelProps)
      text(decisionLabel, '决定（必填）')
      decisionInput = make(doc, 'textarea', 'cabinet-decision', {
        ...fieldBase, height: '84px',
      })
      if (decisionInput) {
        try { decisionInput.placeholder = '例：要不要把插件开源？' } catch (e) { }
        attr(decisionInput, 'aria-label', '决定（必填）')
      }

      const contextLabel = make(doc, 'div', 'cabinet-context-label', labelProps)
      text(contextLabel, '背景与约束（可选）')
      contextInput = make(doc, 'textarea', 'cabinet-context', {
        ...fieldBase, height: '64px',
      })
      if (contextInput) {
        try { contextInput.placeholder = '已知事实、限制、担心，没有就留空' } catch (e) { }
        attr(contextInput, 'aria-label', '背景与约束（可选）')
      }

      const optionsLabel = make(doc, 'div', 'cabinet-options-label', labelProps)
      text(optionsLabel, '候选选项（可选）')
      optionsInput = make(doc, 'textarea', 'cabinet-options', {
        ...fieldBase, height: '56px',
      })
      if (optionsInput) {
        try { optionsInput.placeholder = '例：A 立即开源 / B 不开源 / C 半年后再说' } catch (e) { }
        attr(optionsInput, 'aria-label', '候选选项（可选）')
      }

      const deadlineLabel = make(doc, 'div', 'cabinet-deadline-label', labelProps)
      text(deadlineLabel, '期限（可选）')
      deadlineInput = make(doc, 'input', 'cabinet-deadline', {
        ...fieldBase, height: '34px', resize: 'none',
      })
      if (deadlineInput) {
        try {
          deadlineInput.type = 'text'
          deadlineInput.placeholder = '例：本月底前 / 这周内'
        } catch (e) { }
        attr(deadlineInput, 'aria-label', '期限（可选）')
      }

      errorEl = make(doc, 'div', 'cabinet-error', {
        display: 'none', color: '#b42318', background: '#fef3f2',
        border: '1px solid rgba(180,35,24,0.35)', borderRadius: '8px',
        padding: '6px 9px', marginTop: '10px', fontSize: '12.5px',
      })
      attr(errorEl, 'role', 'alert')

      successEl = make(doc, 'div', 'cabinet-success', {
        display: 'none', color: '#155724', background: '#eefaf1',
        border: '1px solid rgba(21,87,36,0.22)', borderRadius: '12px',
        padding: '10px 12px', marginTop: '10px', fontSize: '12.5px', lineHeight: '1.6',
        whiteSpace: 'pre-wrap',
      })
      attr(successEl, 'role', 'status')

      const bar = make(doc, 'div', 'cabinet-actions', {
        display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '12px',
      })
      cancelBtn = make(doc, 'button', 'cabinet-cancel', {
        padding: '7px 16px', borderRadius: '9px', border: FIELD_BORDER,
        background: 'transparent', color: CARD_FG, cursor: 'pointer',
        font: '13px ' + FONT_FAMILY,
      })
      if (cancelBtn) {
        try { cancelBtn.type = 'button' } catch (e) { }
        text(cancelBtn, '取消')
      }
      submitBtn = make(doc, 'button', 'cabinet-submit', {
        padding: '7px 18px', borderRadius: '9px', border: '0',
        background: 'linear-gradient(90deg,#2E6BB8,#4A8FD6)', color: '#fff',
        cursor: 'pointer', fontWeight: '600', font: '13px ' + FONT_FAMILY,
      })
      if (submitBtn) {
        try { submitBtn.type = 'button' } catch (e) { }
        text(submitBtn, '开始推演')
      }

      // —— 事件：取消 / 提交 / 关闭 / 拖动 ——
      if (cancelBtn && typeof cancelBtn.addEventListener === 'function') {
        cancelBtn.addEventListener('click', () => { try { close() } catch (e) { } })
      }
      if (submitBtn && typeof submitBtn.addEventListener === 'function') {
        submitBtn.addEventListener('click', () => { void submit() })
      }
      if (closeBtn && typeof closeBtn.addEventListener === 'function') {
        closeBtn.addEventListener('click', () => { try { close() } catch (e) { } })
      }
      if (header && typeof header.addEventListener === 'function') {
        header.addEventListener('mousedown', (ev: any) => { startDrag(ev) })
      }

      // —— 组装（任何一步失败都整体降级，不让半块面板挂到页面上） ——
      header.appendChild(titleBox)
      titleBox.appendChild(title)
      titleBox.appendChild(subtitle)
      header.appendChild(closeBtn)
      card.appendChild(header)
      if (!bodyBox) return false
      for (const node of [
        rolesRow,
        decisionLabel, decisionInput,
        contextLabel, contextInput,
        optionsLabel, optionsInput,
        deadlineLabel, deadlineInput,
        errorEl, successEl, bar,
      ]) {
        if (!node) return false
        bodyBox.appendChild(node)
      }
      card.appendChild(bodyBox)
      bar.appendChild(cancelBtn)
      bar.appendChild(submitBtn)
      root.appendChild(card)
      return true
    } catch (e) {
      root = null
      card = null
      return false
    }
  }

  /** 提交：必填校验 → onSubmit → 失败显示内联错误并保持打开 / 成功清空并关闭 */
  async function submit(): Promise<void> {
    if (!opened || submitting || destroyed) return
    const input: CabinetPanelInput = {
      decision: fieldValue(decisionInput),
      context: fieldValue(contextInput),
      options: fieldValue(optionsInput),
      deadline: fieldValue(deadlineInput),
    }
    if (!input.decision) {
      showError('先写下要决定的事，推演才有议题。')
      focusDecision()
      return
    }
    hideError()
    setSubmitting(true)
    let ok = true
    let failure = ''
    try {
      const result = onSubmit(input)
      const settled = await Promise.resolve(result)
      ok = settled !== false
    } catch (err) {
      ok = false
      failure = '开始推演失败：' + errorMessage(err)
    }
    setSubmitting(false)
    if (!ok) {
      hideSuccess()
      showError(failure || '没能开始推演：议题没复制成功，请稍后再试。')
      return
    }
    showSuccess()
    try { if (submitBtn) submitBtn.textContent = '已复制 ✓' } catch (e) { }
    try { if (cancelBtn) cancelBtn.textContent = '关闭' } catch (e) { }
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
    hideError()
    hideSuccess()
    try { if (submitBtn) submitBtn.textContent = '开始推演' } catch (e) { }
    try { if (cancelBtn) cancelBtn.textContent = '取消' } catch (e) { }
    try { if (root && root.style) root.style.display = 'block' } catch (e) { }
    applyPosition()
    focusDecision()
  }

  function close(): void {
    opened = false
    dragging = null
    unbindDrag()
    setSubmitting(false)
    if (!root) return
    try { if (root.style) root.style.display = 'none' } catch (e) { }
    try {
      if (root.parentNode && typeof root.parentNode.removeChild === 'function') root.parentNode.removeChild(root)
      else if (typeof root.remove === 'function') root.remove()
    } catch (e) { }
  }

  function destroy(): void {
    if (destroyed) return
    close()
    destroyed = true
    unbindEsc()
    unbindDrag()
    const node = root
    root = null
    card = null
    decisionInput = null
    contextInput = null
    optionsInput = null
    deadlineInput = null
    errorEl = null
    submitBtn = null
    cancelBtn = null
    if (!node) return
    try {
      if (typeof node.remove === 'function') node.remove()
      else if (node.parentNode && typeof node.parentNode.removeChild === 'function') {
        node.parentNode.removeChild(node)
      }
    } catch (e) { }
  }

  return { open, close, destroy, isOpen: () => opened }
}
