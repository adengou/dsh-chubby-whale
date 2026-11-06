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
import { narrationRate, chatRate } from './rates.js'
import { VERSION } from './version.js'
import { chatPanelStyle, headStyle, bodyStyle, inputRowStyle, inputStyle, sendStyle, msgStyle } from './styles.js'

/** 与 R.createElement 同形（由组件入口注入，模块内不 import react） */
export type HFunction = (type: any, props?: any, ...children: any[]) => any

export type MenuItemRenderCtx = {
  h: HFunction
  tr: (label: string, lang: string) => string
  lang: string
  /** 当前展开的子菜单标签（空串表示都收起） */
  subOpen: string
  /** 切换子菜单：参数是"切换后的新值"（展开传标签，收起传空串） */
  onToggleSub: (next: string) => void
  /** 点菜单项：交给组件入口的动作分发 */
  onAction: (action: string) => void
}

/** 递归渲染菜单项；空数组/未知类型原样跳过（与旧 renderItems 一致） */
export function renderMenuItems(items: any[], ctx: MenuItemRenderCtx): any[] {
  const out: any[] = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.type === 'sep') {
      out.push(ctx.h('div', { key: 'sep' + i, style: { height: 1, background: '#1f4a85', margin: '4px 0' } }))
      continue
    }
    if (it.type === 'sub') {
      const open = ctx.subOpen === it.label
      out.push(ctx.h('div', {
        key: 'sub' + i,
        style: { padding: '6px 14px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', color: '#cfe9ff', fontSize: 13 },
        onClick: () => ctx.onToggleSub(open ? '' : it.label),
      }, ctx.h('span', null, ctx.tr(it.label, ctx.lang)), ctx.h('span', null, open ? '▾' : '▸')))
      if (open) out.push(ctx.h('div', { key: 'subitems' + i, style: { paddingLeft: 14, borderLeft: '1px solid #1f4a85', marginLeft: 8 } }, renderMenuItems(it.items, ctx)))
      continue
    }
    out.push(ctx.h('div', {
      key: 'item' + i,
      style: { padding: '6px 14px', cursor: 'pointer', color: '#cfe9ff', fontSize: 13, whiteSpace: 'nowrap' },
      onClick: () => ctx.onAction(it.action),
    }, ctx.tr(it.label, ctx.lang)))
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
  return {
    storyAuto: (() => { try { return localStorage.getItem('chubby-story-auto') !== '0' } catch (e) { return true } })(),
    streamOn: (() => { try { return localStorage.getItem('chubby-stream') !== 'off' } catch (e) { return true } })(),
    storyRate: (() => { try { const s = localStorage.getItem('chubby-story-rate') || '-35%'; return /^-\d{1,2}%$/.test(s) ? s : '-35%' } catch (e) { return '-35%' } })(),
    poemRate: (() => { try { const s = localStorage.getItem('chubby-poem-rate') || '-25%'; return /^-\d{1,2}%$/.test(s) ? s : '-25%' } catch (e) { return '-25%' } })(),
    ttsVoice: (() => { try { return localStorage.getItem('chubby-tts-voice') || 'zh-CN-XiaoyiNeural' } catch (e) { return 'zh-CN-XiaoyiNeural' } })(),
    chatLang: (() => { try { return localStorage.getItem('chubby-chatlang') || 'auto' } catch (e) { return 'auto' } })(),
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
  onClose: () => void
  onInputChange: (v: string) => void
  onKeyDown: (e: any) => void
  onSend: () => void
}

/** 聊天面板：标题栏 + 消息列表 + 输入行（结构与旧 JSX 逐项一致） */
export function renderChatPanel(ctx: ChatPanelCtx): any {
  const { h, lang } = ctx
  return h('div', { style: chatPanelStyle(ctx.open) },
    h('div', { style: headStyle },
      h('span', null, lang === 'en' ? 'Fat Whale · Chat' : '肥鲸 · 聊天'),
      h('span', { style: { cursor: 'pointer', color: '#9FD8FF', padding: '0 4px' }, onClick: ctx.onClose }, '✕'),
    ),
    h('div', { ref: ctx.bodyRef, style: bodyStyle },
      ctx.messages.length === 0
        ? h('div', { style: msgStyle('fish') }, '主人，点我说话，本鲸在右下角待着～')
        : ctx.messages.map((m: any, i: number) => h('div', { key: i, style: msgStyle(m.who) }, m.text)),
    ),
    h('div', { style: inputRowStyle },
      h('input', {
        style: inputStyle, placeholder: lang === 'en' ? 'Say something…' : '跟肥鲸说两句…', value: ctx.input,
        onChange: (e: any) => ctx.onInputChange(e.target.value),
        onKeyDown: (e: any) => ctx.onKeyDown(e),
      }),
      h('button', { style: sendStyle, onClick: () => ctx.onSend() }, ctx.busy ? '…' : (lang === 'en' ? 'Send' : '发送')),
    ),
  )
}
