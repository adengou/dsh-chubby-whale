// @ts-nocheck
/**
 * HTTP 路由（http/router.js）
 *
 * 只依赖三个模块**暴露的接口**，不读取任何模块内部状态。
 * 所有业务逻辑都在模块里，这里只做：鉴权、解析、转发、序列化。
 */

const MAX_BODY = 256 * 1024

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sseHead(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(': whale-mobile\n\n')
}

function sseSend(res, payload) {
  if (res.writableEnded) return
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

export function createRouter({ basePath, token, modules, staticServer, version, dependencies, logger = console }) {
  const prefix = String(basePath || '/whale-mobile').replace(/\/+$/, '')
  /** @type {Set<import('node:http').ServerResponse>} */
  const eventClients = new Set()

  // 提醒到点 → 广播给所有 SSE 订阅者
  const offDue = modules.reminder.onDue((reminder) => {
    for (const client of eventClients) {
      sseSend(client, { type: 'reminder', id: reminder.id, text: reminder.text, dueAt: reminder.dueAt })
    }
  })

  function authorized(req, url) {
    if (!token) return true
    const header = req.headers.authorization || ''
    if (header === `Bearer ${token}`) return true
    const fromQuery = url.searchParams.get('token')
    return fromQuery === token
  }

  async function handleApi(req, res, url, rest) {
    const method = (req.method || 'GET').toUpperCase()
    const path = rest.replace(/^\/api/, '') || '/'

    if (method === 'GET' && path === '/health') {
      const [chat, story, reminder] = [modules.chat, modules.story, modules.reminder]
      sendJson(res, 200, {
        ok: true,
        version,
        basePath: prefix,
        // 依赖说明：dshWeb 是硬依赖（本插件是宿主插件）；chubbyWhale 是可选伴生
        dependencies: dependencies || {
          dshWeb: { ok: true, role: 'hard', note: '硬依赖：电脑端 dsh web 常驻' },
          chubbyWhale: { installed: false, version: null, role: 'companion', note: '伴生桌宠（可选）' },
        },
        modules: {
          chat: await chat.health(),
          story: await story.health(),
          reminder: await reminder.health(),
        },
      })
      return
    }

    // ---------- 聊天 ----------
    if (method === 'POST' && path === '/chat/stream') {
      const body = await readBody(req)
      sseHead(res)
      const controller = new AbortController()
      res.on('close', () => controller.abort())
      try {
        for await (const event of modules.chat.stream({
          // 兼容两种字段名：text（约定）/ message（早期前端写法）
          text: body.text ?? body.message,
          conversationId: body.conversationId,
          signal: controller.signal,
        })) {
          sseSend(res, event)
          if (event.type === 'done' || event.type === 'error') break
        }
      } catch (err) {
        sseSend(res, { type: 'error', message: err.message || '服务异常' })
      }
      res.end()
      return
    }

    if (method === 'POST' && path === '/chat') {
      const body = await readBody(req)
      const reply = await modules.chat.send({ text: body.text ?? body.message, conversationId: body.conversationId })
      sendJson(res, 200, reply)
      return
    }

    if (method === 'GET' && path === '/chat/conversations') {
      sendJson(res, 200, { items: await modules.chat.conversations() })
      return
    }

    const historyMatch = /^\/chat\/([\w-]+)\/history$/.exec(path)
    if (method === 'GET' && historyMatch) {
      sendJson(res, 200, { items: await modules.chat.history(historyMatch[1]) })
      return
    }

    // ---------- 说书 ----------
    if (method === 'POST' && path === '/story') {
      const body = await readBody(req)
      const story = await modules.story.tell({
        topic: body.topic,
        words: body.words,
        style: body.style,
      })
      sendJson(res, 200, story)
      return
    }

    if (method === 'GET' && path === '/stories') {
      sendJson(res, 200, { items: await modules.story.list() })
      return
    }

    const storyMatch = /^\/stories\/([\w-]+)$/.exec(path)
    if (method === 'GET' && storyMatch) {
      const story = await modules.story.get(storyMatch[1])
      if (!story) {
        sendJson(res, 404, { error: '没有这个故事的' })
        return
      }
      sendJson(res, 200, story)
      return
    }

    if (method === 'DELETE' && storyMatch) {
      sendJson(res, 200, { removed: await modules.story.remove(storyMatch[1]) })
      return
    }

    // ---------- 提醒 ----------
    if (method === 'POST' && path === '/reminders') {
      const body = await readBody(req)
      const reminder = await modules.reminder.add({
        text: body.text,
        at: body.at,
        inSeconds: body.inSeconds,
      })
      sendJson(res, 201, reminder)
      return
    }

    if (method === 'GET' && path === '/reminders') {
      sendJson(res, 200, { items: await modules.reminder.list() })
      return
    }

    const reminderMatch = /^\/reminders\/([\w-]+)$/.exec(path)
    if (method === 'DELETE' && reminderMatch) {
      sendJson(res, 200, { cancelled: await modules.reminder.cancel(reminderMatch[1]) })
      return
    }

    // ---------- 事件流 ----------
    if (method === 'GET' && path === '/events') {
      sseHead(res)
      eventClients.add(res)
      const heartbeat = setInterval(() => {
        if (res.writableEnded) return
        res.write(': ping\n\n')
      }, 20000)
      res.on('close', () => {
        clearInterval(heartbeat)
        eventClients.delete(res)
      })
      return
    }

    sendJson(res, 404, { error: '没有这个接口的' })
  }

  async function handler(req, res) {
    let url
    try {
      url = new URL(req.url || '/', 'http://localhost')
    } catch {
      sendJson(res, 400, { error: '请求地址不合法' })
      return
    }

    const pathname = url.pathname
    if (pathname !== prefix && !pathname.startsWith(prefix + '/')) {
      sendJson(res, 404, { error: 'Not Found' })
      return
    }
    const rest = pathname.slice(prefix.length) || '/'

    try {
      if (rest === '/' || rest === '') {
        const served = await staticServer.serve(res, '/', { index: true })
        if (!served) sendJson(res, 500, { error: 'mobile/index.html 不存在' })
        return
      }

      if (rest.startsWith('/api')) {
        if (!authorized(req, url)) {
          sendJson(res, 401, { error: '需要访问令牌' })
          return
        }
        await handleApi(req, res, url, rest)
        return
      }

      if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: '方法不允许' })
        return
      }
      const served = await staticServer.serve(res, rest)
      if (!served) sendJson(res, 404, { error: 'Not Found' })
    } catch (err) {
      logger.warn?.(`[whale-mobile] 请求处理失败 ${req.method} ${pathname}: ${err.message}`)
      if (!res.headersSent) sendJson(res, 500, { error: err.message || '服务异常' })
      else res.end()
    }
  }

  return Object.freeze({
    handler,
    dispose: () => {
      offDue()
      for (const client of eventClients) {
        try {
          client.end()
        } catch {
          /* 忽略 */
        }
      }
      eventClients.clear()
    },
    prefix: () => prefix,
  })
}
