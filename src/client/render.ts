/**
 * client/render.ts —— 纯渲染辅助（数据 → React 元素）
 *
 * 这些片段原来是 WhaleBody 里的闭包函数与 JSX 内联 IIFE：
 *   · renderMenuItems：递归渲染右键菜单（分隔线 / 子菜单 / 菜单项）；
 *   · readMenuRuntime：菜单打开时现读的本地状态（自动连播、流式、语速、音色、语言）；
 *   · renderMenuHeader：菜单标题栏（名字 + 版本号、可点刷新余额）。
 *
 * 三者都只依赖传入参数与 localStorage，不持有 React 状态、不产生副作用；
 * 调用点仍在原处（每次渲染调用一次），所以外提不改变 hooks 顺序与闭包语义。
 */
import { isStoryAutoOn } from './story-auto.js'
import { storyRate, poemRate } from './rates.js'
import { VERSION } from './version.js'
import { chatPanelStyle, headStyle, bodyStyle, inputRowStyle, inputStyle, sendStyle, msgStyle, menuItemStyle, menuSubStyle, menuStyle } from './styles.js'

/** 与 R.createElement 同形（由组件入口注入，模块内不 import react） */
export type HFunction = (type: any, props?: any, ...children: any[]) => any

export type MenuItemRenderCtx = {
  h: HFunction
  tr: (label: string, lang: string) => string
  lang: string
  /** 当前展开的子菜单路径（空串表示都收起；父级标签用 NUL 拼成路径） */
  subOpen: string
  /** 切换子菜单：展开传完整路径，收起传父路径（空串表示全部收起） */
  onToggleSub: (next: string) => void
  /** 点菜单项：交给组件入口的动作分发 */
  onAction: (action: string) => void
  /** 键盘高亮序号（-1 = 没有高亮）；序号口径与 listMenuEntries 完全一致 */
  focusIndex?: number
}

/**
 * 可见菜单项（键盘导航用）：按渲染顺序把「菜单项 / 子菜单父项」摊平，
 * 分隔线与收起的子菜单子项不出现 —— 展开的子菜单子项紧跟父项，收起时不越级。
 */
export type MenuEntry = {
  kind: 'item' | 'sub'
  /** 菜单项动作（子菜单为空串） */
  action: string
  /** 子菜单完整路径（菜单项为空串） */
  path: string
  /** 子菜单所属父路径（收起时回到这一层；菜单项为空串） */
  parentPath: string
  /** 已按 lang 翻译的显示文案 */
  label: string
  /** 子菜单当前是否展开 */
  open: boolean
  /** 在可见项里的序号（与渲染顺序一致） */
  index: number
}

/** listMenuEntries 只需要翻译与展开状态，不强求渲染上下文里的回调 */
export type MenuListCtx = {
  tr: (label: string, lang: string) => string
  lang: string
  /** 当前展开的子菜单路径（空串表示都收起） */
  subOpen: string
}

/** 计算「当前可见的全部菜单项」（键盘高亮顺序的唯一真源） */
/**
 * 可见菜单项（键盘导航用）：按渲染顺序把「菜单项 / 子菜单父项」摊平。
 * 子菜单展开时子项紧跟父项；分隔线与收起的子项不出现。
 * **index 在返回前统一重编号**——旧实现递归时子项 index 从 0 重计，
 * 导致展开子菜单后高亮错项/多项同亮（49 个可见项只有 36 个不同 index）。
 */
export function listMenuEntries(items: any[], ctx: MenuListCtx, parentPath = ''): MenuEntry[] {
  const out: MenuEntry[] = []
  collectMenuEntries(items, ctx, parentPath, out)
  // 全部摊平后统一重编号：各层递归不再各自从 0 起算
  for (let i = 0; i < out.length; i++) out[i].index = i
  return out
}

/** 递归收集（内部用；index 先占位，由 listMenuEntries 统一重编号） */
function collectMenuEntries(items: any[], ctx: MenuListCtx, parentPath: string, out: MenuEntry[]): void {
  if (!Array.isArray(items)) return
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    if (it.type === 'sub') {
      if (typeof it.label !== 'string') continue
      const path = parentPath ? parentPath + SUB_PATH_SEP + it.label : it.label
      const open = ctx.subOpen === path || ctx.subOpen.indexOf(path + SUB_PATH_SEP) === 0
      out.push({ kind: 'sub', action: '', path, parentPath, label: ctx.tr(it.label, ctx.lang), open, index: 0 })
      if (open) collectMenuEntries(it.items, ctx, path, out)
      continue
    }
    if (it.type !== 'item' || typeof it.label !== 'string') continue
    out.push({ kind: 'item', action: String(it.action || ''), path: '', parentPath, label: ctx.tr(it.label, ctx.lang), open: false, index: 0 })
  }
}

/**
 * 渲染菜单根节点属性（菜单容器）：role/aria-label 供读屏识别；
 * tabIndex=-1 只允许程序化聚焦，**不抢焦点**（键盘导航走全局 keydown）。
 */
export function menuRootProps(ctx: { menu: any; lang: string }): any {
  return {
    style: menuStyle(ctx.menu),
    'data-menu-root': '1',
    role: 'menu',
    tabIndex: -1,
    'aria-label': ctx.lang === 'en' ? 'Fat Whale menu' : '肥鲸菜单',
  }
}

/**
 * 子菜单路径分隔符。subOpen 原来只存单个 label，导致「文化气 ▸」里的二级菜单
 * （说书语速 / 出个对联等）一点就把父级收起，二级内容永远打不开。改成路径后，
 * 父级与二级可同时展开；顶层路径就是 label，行为与原来完全一致。
 */
const SUB_PATH_SEP = '\u0000'

/**
 * 递归渲染菜单项；items 非数组返回空数组，空项 / 未知类型 / 缺 label 的项跳过。
 * parentPath 是当前层所属父菜单的路径（顶层为空串），只用于拼接子菜单路径。
 *
 * 键盘高亮：先由 listMenuEntries 算出可见项清单（唯一真源），渲染时按同一遍历顺序
 * 取下一条 entry，保证「高亮序号 ↔ 屏幕上的项」永远对齐（子菜单展开/收起也不越级）。
 */
export function renderMenuItems(items: any[], ctx: MenuItemRenderCtx, parentPath = ''): any[] {
  const entries = listMenuEntries(items, ctx, parentPath)
  return renderMenuList(items, ctx, parentPath, entries, { i: 0 })
}

/** 内部递归：entries 与 cursor 由顶层传入，DFS 顺序与 listMenuEntries 完全一致 */
function renderMenuList(items: any[], ctx: MenuItemRenderCtx, parentPath: string, entries: MenuEntry[], cursor: { i: number }): any[] {
  const out: any[] = []
  if (!Array.isArray(items)) return out
  const focus = typeof ctx.focusIndex === 'number' ? ctx.focusIndex : -1
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (!it || typeof it !== 'object') continue
    if (it.type === 'sep') {
      out.push(ctx.h('div', { key: 'sep' + i, role: 'separator', style: { height: 1, background: '#1f4a85', margin: '4px 0' } }))
      continue
    }
    if (it.type === 'sub') {
      if (typeof it.label !== 'string') continue
      const entry = entries[cursor.i++]
      const path = entry ? entry.path : (parentPath ? parentPath + SUB_PATH_SEP + it.label : it.label)
      const open = entry ? entry.open : false
      const label = entry ? entry.label : ctx.tr(it.label, ctx.lang)
      out.push(ctx.h('div', {
        key: 'sub' + i,
        role: 'menuitem',
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-label': label,
        tabIndex: -1,
        style: menuSubStyle(!!entry && entry.index === focus),
        onClick: () => ctx.onToggleSub(open ? (entry ? entry.parentPath : parentPath) : path),
      }, ctx.h('span', null, label), ctx.h('span', null, open ? '▾' : '▸')))
      if (open) out.push(ctx.h('div', { key: 'subitems' + i, role: 'group', style: { paddingLeft: 14, borderLeft: '1px solid #1f4a85', marginLeft: 8 } }, renderMenuList(it.items, ctx, path, entries, cursor)))
      continue
    }
    if (it.type !== 'item' || typeof it.label !== 'string') continue
    const entry = entries[cursor.i++]
    out.push(ctx.h('div', {
      key: 'item' + i,
      role: 'menuitem',
      'aria-label': entry ? entry.label : ctx.tr(it.label, ctx.lang),
      tabIndex: -1,
      style: menuItemStyle(!!entry && entry.index === focus),
      onClick: () => ctx.onAction(entry ? entry.action : String(it.action || '')),
    }, entry ? entry.label : ctx.tr(it.label, ctx.lang)))
  }
  return out
}

/** 菜单里要显示的本地运行状态（与旧 JSX 内联 IIFE 的读取口径逐项一致） */
export type MenuRuntime = {
  storyAuto: boolean
  streamOn: boolean
  storyRate: string
  poemRate: string
  ttsVoice: string
  chatLang: string
}

export function readMenuRuntime(): MenuRuntime {
  // 先摆默认值，再一次性读；Storage 被禁 / 读取抛错时保持默认（口径与旧逐键 try 一致）。
  // storyRate / poemRate 仍走 rates.ts 的校验读取（非法值回落默认）。
  let storyAuto = true
  let streamOn = true
  let ttsVoice = 'zh-CN-XiaoyiNeural'
  let chatLang = 'auto'
  try {
    storyAuto = isStoryAutoOn()
    streamOn = localStorage.getItem('chubby-stream') === 'on'
    ttsVoice = localStorage.getItem('chubby-tts-voice') || 'zh-CN-XiaoyiNeural'
    chatLang = localStorage.getItem('chubby-chatlang') || 'auto'
  } catch (e) { }
  return {
    storyAuto,
    streamOn,
    storyRate: storyRate(),
    poemRate: poemRate(),
    ttsVoice,
    chatLang,
  }
}

/** 菜单标题栏：左边「名字 · 版本号」，右边余额（点一下刷新） */
export function renderMenuHeader(ctx: {
  h: HFunction
  lang: string
  balanceText: string
  onRefresh: () => void
}): any {
  const { h, lang } = ctx
  return h('div', { style: { padding: '8px 14px', borderBottom: '1px solid #1f4a85', color: '#9FD8FF', fontSize: 12, display: 'flex', justifyContent: 'space-between' } },
    h('span', null, (lang === 'en' ? 'Fat Whale · v' : '肥鲸 · v') + VERSION),
    h('span', {
      style: { color: '#FFD166', cursor: 'pointer' },
      title: lang === 'en' ? 'Click to refresh balance' : '点一下刷新余额',
      onClick: ctx.onRefresh,
    }, ctx.balanceText || '--'),
  )
}

/** 聊天面板渲染上下文：事件回调由组件入口提供（发送/输入/关闭的逻辑留在闭包里） */
export type ChatPanelCtx = {
  h: HFunction
  lang: string
  open: boolean
  messages: any[]
  input: string
  busy: boolean
  /** 聊天记录容器（滚到底用） */
  bodyRef: any
  /** 输入框 ref（面板打开时自动聚焦用） */
  inputRef?: any
  /** 面板根节点 ref（有入场动画时按 animationend 决定聚焦时机） */
  panelRef?: any
  /** 拖动后的面板左上角；null = 默认右下角 */
  panelPos?: { x: number; y: number } | null
  /** 标题栏按下：开始拖动 */
  onPanelDragStart?: (e: any) => void
  onClose: () => void
  onInputChange: (v: string) => void
  onKeyDown: (e: any) => void
  onSend: () => void
}

/** 聊天面板：标题栏 + 消息列表 + 输入行（结构与旧 JSX 逐项一致） */
export function renderChatPanel(ctx: ChatPanelCtx): any {
  const { h, lang } = ctx
  return h('div', { ref: ctx.panelRef, style: chatPanelStyle(ctx.open, ctx.panelPos || null) },
    h('div', { style: { ...headStyle, cursor: 'move', userSelect: 'none' }, onPointerDown: ctx.onPanelDragStart },
      h('span', null, lang === 'en' ? 'Fat Whale · Chat' : '肥鲸 · 聊天'),
      h('span', {
        style: { cursor: 'pointer', color: '#9FD8FF', padding: '0 4px' },
        onPointerDown: (e: any) => { try { e.stopPropagation() } catch (err) { } },
        onClick: ctx.onClose,
      }, '✕'),
    ),
    h('div', { ref: ctx.bodyRef, style: bodyStyle },
      ctx.messages.length === 0
        ? h('div', { style: msgStyle('fish') }, lang === 'en'
          ? 'Click me to talk — I am right in the bottom-right corner.'
          : '主人，点我说话，本鲸在右下角待着～')
        : ctx.messages.map((m: any, i: number) => h('div', { key: i, style: msgStyle(m.who) }, m.text)),
    ),
    h('div', { style: inputRowStyle },
      h('input', {
        ref: ctx.inputRef,
        style: inputStyle,
        placeholder: lang === 'en' ? 'Say something…' : '跟肥鲸说两句…',
        'aria-label': lang === 'en' ? 'Chat input' : '聊天输入框',
        value: ctx.input,
        onChange: (e: any) => ctx.onInputChange(e.target.value),
        onKeyDown: (e: any) => ctx.onKeyDown(e),
      }),
      h('button', { style: sendStyle, onClick: () => ctx.onSend() }, ctx.busy ? '…' : (lang === 'en' ? 'Send' : '发送')),
    ),
  )
}
