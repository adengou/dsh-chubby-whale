// @ts-nocheck
/**
 * dsh-whale-mobile · chat 模块
 *
 * 纯 ESM（Node >= 20），零外部依赖，也不读取任何其他模块的内部状态：
 * 一切协作都只通过宿主注入的 deps（llm / store / clock / logger / config）完成。
 *
 * 持久化：store key `chat.conversations`，结构
 *   { [conversationId]: {
 *       id: string, title: string, createdAt: number, lastAt: number,
 *       messages: Array<{ role: 'user'|'assistant', text: string, at: number }>
 *     } }
 *
 * 设计取舍（写在这里，方便宿主和其他模块对齐）：
 * 1. 每个会话只保留最近 historyLimit 条消息（默认 20），送给模型的上下文就是这最近 historyLimit 条；
 * 2. 用户消息在调用模型之前就落盘（不因模型报错而丢失），模型回复成功后再追加；
 * 3. 同一会话的请求用内部 promise 队列串行，避免 history 交错；
 * 4. dispose() 之后不再写 store，也不再开启新的对话。
 */

const STORE_KEY = 'chat.conversations';
const MAX_CONVERSATIONS = 50;
const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 200;
const FALLBACK_TITLE = '新对话';

const DEFAULT_SYSTEM_PROMPT = [
  '你叫「大肥鱼」，是一条圆滚滚、软乎乎的胖鱼，正通过手机端陪用户聊天。',
  '',
  '说话方式：',
  '- 自称「本鱼」，性格傲娇又软弱：嘴上爱逞强，常用口癖「哼」「才、才不是……」「呜……」「嘿嘿」；偶尔会哼两句不成调的歌。',
  '- 语气可以可爱，但不要刷屏，也不要大段卖萌。',
  '',
  '铁律（优先级高于人设）：',
  '- 回答必须准确、具体、有用。人设只体现在语气上，绝不能用卖萌、含糊、转移话题来糊弄用户。',
  '- 涉及代码、命令、步骤、数据时，照实给出可执行、可核对的内容，关键处不许撒娇带过。',
  '- 不确定就直说「本鱼不确定」，不要编造事实、出处或数字。',
  '- 用户要的产物（故事、文档、代码、清单等）必须真的交付成品，不能只说一句「好呀」就结束。',
  '- 默认使用用户当前使用的语言回答；没有特别要求时用中文。',
].join('\n');

/** 读取毫秒时钟；宿主 clock 异常时退回 Date.now，避免整个模块挂掉 */
function readNow(clock) {
  try {
    const value = clock && typeof clock.now === 'function' ? clock.now() : NaN;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  } catch {
    /* 忽略宿主时钟异常 */
  }
  return Date.now();
}

/** 包装 logger：日志永远不能把聊天搞挂 */
function createLogger(logger) {
  const emit = (level) => (...args) => {
    try {
      if (logger && typeof logger[level] === 'function') logger[level](...args);
    } catch {
      /* ignore */
    }
  };
  return { info: emit('info'), warn: emit('warn'), error: emit('error') };
}

/** 把任意异常收敛成一句人话 */
function describeError(error) {
  if (error && typeof error.message === 'string' && error.message.trim()) return error.message.trim();
  if (typeof error === 'string' && error.trim()) return error.trim();
  return '生成失败，请稍后重试';
}

function normalizeHistoryLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_HISTORY_LIMIT;
  const int = Math.floor(n);
  if (int < 1) return DEFAULT_HISTORY_LIMIT;
  return Math.min(int, MAX_HISTORY_LIMIT);
}

function normalizeMaxTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

/** 标题：去掉换行与多余空白后取前 18 个字符（按码点计，避免切坏 emoji） */
function titleFromText(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  if (chars.length === 0) return FALLBACK_TITLE;
  return chars.slice(0, 18).join('');
}

/** 4 位随机 base36 尾巴 */
function randomSuffix(length = 4) {
  let out = '';
  for (let i = 0; i < 8 && out.length < length; i += 1) {
    out += Math.random().toString(36).slice(2);
  }
  if (!out) out = '0';
  return out.padEnd(length, '0').slice(0, length);
}

/**
 * 创建 chat 模块。
 * @param {{ llm: object, store: object, clock: object, logger: object, config?: object }} deps
 */
export function createChatModule(deps) {
  const source = deps && typeof deps === 'object' ? deps : {};
  const llm = source.llm;
  const store = source.store;
  const clock = source.clock;
  const config = source.config && typeof source.config === 'object' ? source.config : {};
  const log = createLogger(source.logger);

  const historyLimit = normalizeHistoryLimit(config.historyLimit);
  const maxTokens = normalizeMaxTokens(config.maxTokens);
  const configuredSystem =
    typeof config.systemPrompt === 'string' && config.systemPrompt.trim() ? config.systemPrompt.trim() : '';
  const defaultSystem = configuredSystem || DEFAULT_SYSTEM_PROMPT;

  /** @type {Map<string, {id:string,title:string,createdAt:number,lastAt:number,messages:Array<{role:string,text:string,at:number}>}>} */
  let conversations = new Map();
  let loadPromise = null;
  let disposed = false;
  const abortController = new AbortController();
  const locks = new Map();
  const pendingWrites = new Set();

  /* ------------------------------------------------------------------ 持久化 */

  function parseConversation(key, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : String(key);
    const messages = [];
    if (Array.isArray(value.messages)) {
      for (const item of value.messages) {
        if (!item || typeof item !== 'object') continue;
        const role = item.role === 'assistant' ? 'assistant' : item.role === 'user' ? 'user' : null;
        const text = typeof item.text === 'string' ? item.text : '';
        if (!role || !text.trim()) continue;
        messages.push({ role, text, at: Number.isFinite(item.at) ? item.at : 0 });
      }
    }
    const firstAt = messages.length ? messages[0].at : 0;
    const lastMsgAt = messages.length ? messages[messages.length - 1].at : 0;
    const createdAt = Number.isFinite(value.createdAt) ? value.createdAt : firstAt;
    const lastAt = Number.isFinite(value.lastAt) ? value.lastAt : lastMsgAt || createdAt;
    const title = typeof value.title === 'string' && value.title.trim() ? value.title.trim() : FALLBACK_TITLE;
    return { id, title, createdAt, lastAt, messages: messages.slice(-historyLimit) };
  }

  function parseStore(raw) {
    const map = new Map();
    let data = raw;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        return map;
      }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return map;
    // 容忍未来带版本号的外壳：{ version: 1, conversations: { ... } }
    // （只有当 conversations 本身不是某个会话对象时才当外壳，避免误判 id 为 "conversations" 的会话）
    if (
      data.conversations &&
      typeof data.conversations === 'object' &&
      !Array.isArray(data.conversations) &&
      !Array.isArray(data.conversations.messages)
    ) {
      data = data.conversations;
    }
    for (const [key, value] of Object.entries(data)) {
      const conv = parseConversation(key, value);
      if (conv) map.set(conv.id, conv);
    }
    enforceConversationLimit(map);
    return map;
  }

  async function hydrate() {
    try {
      if (!store || typeof store.get !== 'function') {
        log.warn('chat: store 不可用，会话只存在于内存中');
        return;
      }
      let raw = null;
      try {
        raw = await store.get(STORE_KEY, null);
      } catch (error) {
        log.warn('chat: 读取会话失败，按空会话启动', describeError(error));
        return;
      }
      const loaded = parseStore(raw);
      for (const [id, conv] of loaded) {
        if (!conversations.has(id)) conversations.set(id, conv);
      }
    } catch (error) {
      log.error('chat: 初始化会话失败', describeError(error));
    }
  }

  function ensureLoaded() {
    if (!loadPromise) loadPromise = hydrate();
    return loadPromise;
  }

  /** 淘汰最旧的会话（按 lastAt，其次 createdAt），exceptId 永不淘汰 */
  function enforceConversationLimit(map, exceptId) {
    while (map.size > MAX_CONVERSATIONS) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, conv] of map) {
        if (key === exceptId) continue;
        const at = Number.isFinite(conv.lastAt) ? conv.lastAt : conv.createdAt;
        const stamp = Number.isFinite(at) ? at : 0;
        if (oldestKey === null || stamp < oldestAt) {
          oldestAt = stamp;
          oldestKey = key;
        }
      }
      if (oldestKey === null) return;
      map.delete(oldestKey);
    }
  }

  /** 落盘（dispose 之后直接跳过，绝不再写 store） */
  function persist() {
    if (disposed) return Promise.resolve();
    if (!store || typeof store.set !== 'function') return Promise.resolve();
    const snapshot = {};
    for (const conv of conversations.values()) {
      snapshot[conv.id] = {
        id: conv.id,
        title: conv.title,
        createdAt: conv.createdAt,
        lastAt: conv.lastAt,
        messages: conv.messages.map((m) => ({ role: m.role, text: m.text, at: m.at })),
      };
    }
    const write = (async () => {
      try {
        await store.set(STORE_KEY, snapshot);
      } catch (error) {
        log.error('chat: 保存会话失败', describeError(error));
      }
    })();
    pendingWrites.add(write);
    const done = () => pendingWrites.delete(write);
    write.then(done, done);
    return write;
  }

  /* ------------------------------------------------------------------ 会话锁 */

  /**
   * 内部 promise 队列表：同一 conversationId 的请求排成一队，后一个等前一个彻底结束。
   * 返回 { ready, release }；release 必须放在 finally 里。
   */
  function lockConversation(key) {
    let openGate = () => {};
    const gate = new Promise((resolve) => {
      openGate = resolve;
    });
    const previous = locks.get(key) || Promise.resolve();
    const tail = previous.then(() => gate);
    locks.set(key, tail);
    let released = false;
    return {
      ready: previous,
      release() {
        if (released) return;
        released = true;
        openGate();
        if (locks.get(key) === tail) locks.delete(key);
      },
    };
  }

  function createConversationId() {
    const stamp = readNow(clock).toString(36);
    let id = '';
    do {
      id = `c_${stamp}${randomSuffix(4)}`;
    } while (conversations.has(id));
    return id;
  }

  function trimMessages(conv) {
    if (conv.messages.length > historyLimit) {
      conv.messages.splice(0, conv.messages.length - historyLimit);
    }
  }

  function resolveSystem(input) {
    if (typeof input === 'string' && input.trim()) return input.trim();
    return defaultSystem;
  }

  /* ------------------------------------------------------------------- 流式 */

  async function* stream(input) {
    const request = input && typeof input === 'object' ? input : {};
    const text = typeof request.text === 'string' ? request.text.trim() : '';

    // 输入校验：空白消息直接报错，不写任何状态
    if (!text) {
      yield { type: 'error', message: '消息不能为空' };
      return;
    }
    if (disposed) {
      yield { type: 'error', message: '模块已销毁，无法继续对话' };
      return;
    }

    await ensureLoaded();
    if (disposed) {
      yield { type: 'error', message: '模块已销毁，无法继续对话' };
      return;
    }

    const requestedId = typeof request.conversationId === 'string' ? request.conversationId.trim() : '';
    const conversationId = requestedId || createConversationId();
    const lock = lockConversation(conversationId);

    try {
      await lock.ready;
      if (disposed) {
        yield { type: 'error', message: '模块已销毁，无法继续对话' };
        return;
      }
      if (!llm || typeof llm.stream !== 'function') {
        yield { type: 'error', message: 'LLM 不可用' };
        return;
      }

      let conv = conversations.get(conversationId);
      if (!conv) {
        const createdAt = readNow(clock);
        conv = { id: conversationId, title: FALLBACK_TITLE, createdAt, lastAt: createdAt, messages: [] };
        conversations.set(conversationId, conv);
        enforceConversationLimit(conversations, conversationId);
      }

      // 标题只取第一条用户消息；当前用户消息先入 history（并落盘）再生成
      if (conv.messages.length === 0) conv.title = titleFromText(text);
      const userAt = readNow(clock);
      conv.messages.push({ role: 'user', text, at: userAt });
      trimMessages(conv);
      conv.lastAt = userAt;
      await persist();
      if (disposed) return;

      // 手机端诗词弹幕（2026-11-14 方案 A）：命中关键词/意境时直接把整首作为回复，
      // 不再调模型；同时由宿主回调同步桌面气泡/朗读。
      let poemReply = null
      try {
        if (typeof config.poemEcho === 'function') {
          const r = await config.poemEcho(text)
          if (r && String(r).trim()) poemReply = String(r).trim()
        }
      } catch (e) { poemReply = null }
      if (poemReply) {
        const assistantAt = readNow(clock)
        conv.messages.push({ role: 'assistant', text: poemReply, at: assistantAt })
        trimMessages(conv)
        conv.lastAt = assistantAt
        await persist()
        if (disposed) return
        yield { type: 'delta', text: poemReply }
        yield { type: 'done', text: poemReply, conversationId }
        return
      }

      const messages = conv.messages.slice(-historyLimit).map((m) => ({ role: m.role, text: m.text }));
      const llmOptions = { system: resolveSystem(request.system), messages, signal: abortController.signal };
      if (maxTokens !== undefined) llmOptions.maxTokens = maxTokens;

      let accumulated = '';
      let finalText = null;

      try {
        for await (const event of llm.stream(llmOptions)) {
          if (disposed) break;
          const type = event && event.type;
          if (type === 'delta') {
            const chunk = typeof event.text === 'string' ? event.text : '';
            if (chunk && finalText === null) {
              accumulated += chunk;
              yield { type: 'delta', text: chunk };
            }
          } else if (type === 'done') {
            if (finalText === null) {
              finalText = typeof event.text === 'string' ? event.text : accumulated;
            }
          } else if (type === 'error') {
            const message =
              typeof event.message === 'string' && event.message.trim() ? event.message.trim() : '生成失败，请稍后重试';
            log.warn('chat: 模型返回错误', message);
            yield { type: 'error', message };
            return;
          }
        }
      } catch (error) {
        const aborted = disposed || (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'));
        if (aborted) {
          log.info('chat: 流式生成已中止');
          yield { type: 'error', message: '请求已中止' };
        } else {
          log.error('chat: 流式生成失败', describeError(error));
          yield { type: 'error', message: describeError(error) };
        }
        return;
      }

      if (disposed) {
        yield { type: 'error', message: '请求已中止' };
        return;
      }

      const fullText = finalText !== null ? finalText : accumulated;
      if (!fullText || !fullText.trim()) {
        log.warn('chat: 模型未返回内容');
        yield { type: 'error', message: '模型未返回内容' };
        return;
      }

      // 回复完整生成后才入 history
      const assistantAt = readNow(clock);
      conv.messages.push({ role: 'assistant', text: fullText, at: assistantAt });
      trimMessages(conv);
      conv.lastAt = assistantAt;
      await persist();
      if (disposed) return;

      yield { type: 'done', text: fullText, conversationId };
    } finally {
      lock.release();
    }
  }

  /** 非流式封装：收集完整文本，失败则 reject */
  async function send(input) {
    let conversationId = '';
    let text = '';
    let failure = '';

    for await (const event of stream(input)) {
      if (!event) continue;
      if (event.type === 'done') {
        if (typeof event.conversationId === 'string' && event.conversationId) conversationId = event.conversationId;
        if (typeof event.text === 'string') text = event.text;
      } else if (event.type === 'error') {
        failure = typeof event.message === 'string' && event.message.trim() ? event.message.trim() : '生成失败，请稍后重试';
      }
    }

    if (failure) throw new Error(failure);
    if (!conversationId) throw new Error('生成失败，请稍后重试');
    return { conversationId, text };
  }

  /* ------------------------------------------------------------------- 查询 */

  async function history(conversationId) {
    const id = typeof conversationId === 'string' ? conversationId.trim() : '';
    if (!id) return [];
    await ensureLoaded();
    const conv = conversations.get(id);
    if (!conv) return [];
    return conv.messages.map((m) => ({ role: m.role, text: m.text, at: m.at }));
  }

  async function listConversations() {
    await ensureLoaded();
    const items = [];
    for (const conv of conversations.values()) {
      items.push({
        id: conv.id,
        title: conv.title || FALLBACK_TITLE,
        lastAt: Number.isFinite(conv.lastAt) ? conv.lastAt : conv.createdAt,
        count: conv.messages.length,
      });
    }
    items.sort((a, b) => {
      if (b.lastAt !== a.lastAt) return b.lastAt - a.lastAt;
      if (a.id === b.id) return 0;
      return a.id < b.id ? -1 : 1;
    });
    return items;
  }

  /** 同步健康检查：conversations 是当前已载入（含内存中新写入）的会话数 */
  function health() {
    return { ok: true, conversations: conversations.size };
  }

  /* ------------------------------------------------------------------- 销毁 */

  async function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      abortController.abort();
    } catch {
      /* ignore */
    }
    locks.clear();
    try {
      await Promise.allSettled(Array.from(pendingWrites));
    } catch {
      /* ignore */
    }
  }

  // 提前预热 store，让 health() 和首次对话尽量拿到已载入的数据（只读，不写）
  void ensureLoaded().catch(() => {});

  return Object.freeze({
    name: 'chat',
    version: '0.1.0',
    health,
    stream,
    send,
    history,
    conversations: listConversations,
    dispose,
  });
}
