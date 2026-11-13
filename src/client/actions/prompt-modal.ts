/**
 * client/actions/prompt-modal.ts —— 自绘文字输入框（替代 window.prompt）
 *
 * 为什么需要：DSH 桌面端是 Electron，`window.prompt` 不受支持（返回 null 或不存在），
 * 于是「把稿子念成音频」「公文校对」「自定义唤醒词」这些要贴文本的入口在桌面端里
 * 不弹框，表现就像功能丢了（只剩文件选择）。这里用 DOM 画一个轻量输入框：
 *   · 遮罩 + 卡片，Esc / 点遮罩 / 取消 都返回 null；
 *   · 多行模式（贴稿子）与单行模式（唤醒词）共用；
 *   · 不依赖 React，直接挂 body，随用随删。
 */

export type PromptOptions = {
  /** 标题（卡片顶部一句话） */
  title: string
  /** 输入框占位提示 */
  placeholder?: string
  /** 初始值 */
  defaultValue?: string
  /** 是否多行（默认 true） */
  multiline?: boolean
  /** 最大字数（只做 UI 限制，调用方仍需自己校验） */
  maxLength?: number
  /** 确认按钮文字（默认「开始」） */
  okText?: string
}

/** 测试钩子：替换输入框实现（生产环境不调用；传 null 恢复默认 DOM 输入框） */
let overrideImpl: ((opts: PromptOptions) => Promise<string | null> | string | null) | null = null

export function setPromptTextImpl(fn: ((opts: PromptOptions) => Promise<string | null> | string | null) | null): void {
  overrideImpl = fn
}

export function promptText(opts: PromptOptions): Promise<string | null> {
  if (overrideImpl) {
    try { return Promise.resolve(overrideImpl(opts)) } catch (e) { return Promise.resolve(null) }
  }
  return showPrompt(opts)
}

function showPrompt(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      try { wrap.remove() } catch (e) { }
      resolve(value)
    }
    let wrap: any = null
    try {
      const doc = document
      wrap = doc.createElement('div')
      wrap.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:2147483000',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'background:rgba(4,8,20,.55)',
        'backdrop-filter:blur(2px)',
      ].join(';')

      const box = doc.createElement('div')
      box.style.cssText = [
        'width:min(560px,92vw)',
        'max-height:86vh',
        'display:flex',
        'flex-direction:column',
        'box-sizing:border-box',
        'background:#101a33',
        'color:#eaf1ff',
        'border:1px solid rgba(120,170,255,.35)',
        'border-radius:14px',
        'padding:16px 18px',
        'box-shadow:0 18px 60px rgba(0,0,0,.5)',
        'font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif',
      ].join(';')

      const title = doc.createElement('div')
      title.textContent = opts.title
      title.style.cssText = 'font-weight:600;margin-bottom:10px'

      const input = doc.createElement(opts.multiline === false ? 'input' : 'textarea') as any
      input.value = opts.defaultValue || ''
      if (opts.placeholder) input.placeholder = opts.placeholder
      if (opts.maxLength) input.maxLength = opts.maxLength
      input.style.cssText = [
        'width:100%',
        'box-sizing:border-box',
        opts.multiline === false ? 'height:38px' : 'height:180px',
        'resize:vertical',
        'background:rgba(255,255,255,.06)',
        'color:#eaf1ff',
        'border:1px solid rgba(120,170,255,.3)',
        'border-radius:10px',
        'padding:8px 10px',
        'font:inherit',
        'outline:none',
      ].join(';')

      const bar = doc.createElement('div')
      bar.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;margin-top:12px'

      const cancel = doc.createElement('button')
      cancel.type = 'button'
      cancel.textContent = '取消'
      cancel.style.cssText = 'padding:7px 16px;border-radius:9px;border:1px solid rgba(120,170,255,.35);background:transparent;color:#cfe0ff;cursor:pointer;font:inherit'

      const ok = doc.createElement('button')
      ok.type = 'button'
      ok.textContent = opts.okText || '开始'
      ok.style.cssText = 'padding:7px 18px;border-radius:9px;border:0;background:#3b6dff;color:#fff;cursor:pointer;font:inherit'

      const onKey = (e: any): void => {
        if (e && e.key === 'Escape') { e.preventDefault?.(); finish(null); return }
        // 多行模式：Ctrl/Cmd+Enter 提交（回车留给换行，贴稿子需要）
        if (e && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault?.(); finish(String(input.value || '')) }
      }

      cancel.addEventListener('click', () => finish(null))
      ok.addEventListener('click', () => finish(String(input.value || '')))
      wrap.addEventListener('mousedown', (e: any) => { if (e && e.target === wrap) finish(null) })
      input.addEventListener('keydown', onKey)

      bar.appendChild(cancel)
      bar.appendChild(ok)
      box.appendChild(title)
      box.appendChild(input)
      box.appendChild(bar)
      wrap.appendChild(box)
      doc.body.appendChild(wrap)
      setTimeout(() => { try { input.focus() } catch (e) { } }, 0)
    } catch (e) {
      // 环境异常（无 document 等）：当作取消，调用方照旧处理 null
      try { if (wrap) wrap.remove() } catch (e2) { }
      resolve(null)
    }
  })
}
