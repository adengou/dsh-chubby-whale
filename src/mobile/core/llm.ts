// @ts-nocheck
/**
 * 模型适配层（core/llm.js）
 *
 * 架构约束：全插件**只有这里**允许接触 `ctx.llm`。模块拿到的是本文件导出的
 * 窄接口 `{ stream, generate }`，看不到 provider 细节、路由缓存或原始 chunk。
 */

const DEFAULT_MAX_TOKENS = 1200

/** 把 {role, text} 简化消息转成模型层要求的 content block 结构。 */
function toBlocks(messages = []) {
  return messages.map((m) => ({
    role: m && m.role === 'assistant' ? 'assistant' : 'user',
    content: [{ type: 'text', text: String((m && m.text) ?? '') }],
  }))
}

function messageOf(err) {
  if (!err) return '未知错误'
  if (typeof err === 'string') return err
  return err.message || String(err)
}

export function createLlm({ ctx, config = {}, logger = console }) {
  const fixedMaxTokens = Number(config.maxTokens) > 0 ? Number(config.maxTokens) : undefined
  /** @type {{provider: string, model: string} | null} */
  let route =
    config.provider && config.model
      ? { provider: String(config.provider), model: String(config.model) }
      : null

  async function ensureRoute() {
    if (route) return route
    // 回退：取第一个 provider 的第一个已公布模型
    try {
      const providers = (await ctx.llm.listProviders?.()) ?? []
      for (const provider of providers) {
        const models = (await ctx.llm.listModels?.(provider)) ?? []
        const model = models.find((m) => m && m.id)?.id
        if (model) {
          route = { provider: String(provider), model: String(model) }
          logger.info?.(`[whale-mobile] 自动选择模型路由 ${route.provider}/${route.model}`)
          return route
        }
      }
    } catch (err) {
      logger.warn?.(`[whale-mobile] 模型路由探测失败：${messageOf(err)}`)
    }
    throw new Error('没有可用的模型：请在插件 config 里设置 provider 与 model')
  }

  function buildOptions({ system, messages, maxTokens, temperature, signal } = {}) {
    const options = {
      messages: toBlocks(messages),
      maxTokens: Number(maxTokens) > 0 ? Number(maxTokens) : fixedMaxTokens,
    }
    if (system) options.system = String(system)
    if (temperature !== undefined && temperature !== null) options.temperature = Number(temperature)
    if (signal) options.signal = signal
    return options
  }

  /**
   * 流式生成：统一产出 { type:'delta', text } 与终态 { type:'done', text } /
   * { type:'error', message }。**不会向外抛错**，调用方无需 try/catch。
   */
  async function* stream(request = {}) {
    let resolved
    try {
      resolved = await ensureRoute()
    } catch (err) {
      yield { type: 'error', message: messageOf(err) }
      return
    }

    let text = ''
    try {
      const iterable = ctx.llm.stream({
        provider: resolved.provider,
        model: resolved.model,
        ...buildOptions(request),
      })
      for await (const chunk of iterable) {
        if (!chunk || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
          text += chunk.text
          yield { type: 'delta', text: chunk.text }
        }
        // 其余 chunk（reasoning / tool / usage / block）对移动端没价值，直接丢弃
      }
    } catch (err) {
      yield { type: 'error', message: messageOf(err) }
      return
    }

    if (request.signal && request.signal.aborted) {
      yield { type: 'error', message: '已取消' }
      return
    }
    if (text.length === 0) {
      yield { type: 'error', message: '模型没有返回内容' }
      return
    }
    yield { type: 'done', text }
  }

  /** 非流式：收齐整段文本后返回。 */
  async function generate(request = {}) {
    let text = ''
    for await (const event of stream(request)) {
      if (event.type === 'delta') text += event.text
      else if (event.type === 'error') throw new Error(event.message)
      else if (event.type === 'done') text = event.text
    }
    return text
  }

  return Object.freeze({
    stream,
    generate,
    /** 只读诊断信息，供 /api/health 使用。 */
    route: () => (route ? { ...route } : null),
  })
}
