/**
 * host/routes.ts —— 路由表（exact path → handler）
 *
 * 入口只把各能力 handler 组装进来，按这张表统一注册；路径不再散落在 index.ts 里。
 * 新增一个能力路由：
 *   ① 新建 host/routes/xxx.ts（导出 createXxxHandler）
 *   ② 本表加一行 { path, handler }
 *   ③ index.ts 里构造 handler 并放进 routes 对象（一行接线）
 */
export interface HttpRoute {
  path: string
  handler: any
}

export interface HandlerSet {
  misc: any
  chat: any
  chatStream: any
  cacheToggle: any
  story: any
  reminders: any
  culture: any
  poem: any
  briefing: any
  tts: any
  asr: any
}

export function createRouteTable(h: HandlerSet): HttpRoute[] {
  return [
    { path: '/api/chubby-whale/asset', handler: h.misc.handleAsset },
    { path: '/api/chubby-whale/chat', handler: h.chat },
    { path: '/api/chubby-whale/chat-stream', handler: h.chatStream },
    { path: '/api/chubby-whale/status', handler: h.misc.handleStatus },
    { path: '/api/chubby-whale/state', handler: h.misc.handleState },
    { path: '/api/chubby-whale/balance', handler: h.misc.handleBalance },
    { path: '/api/chubby-whale/growth', handler: h.misc.handleGrowth },
    { path: '/api/chubby-whale/fishfood', handler: h.misc.handleFishfood },
    { path: '/api/chubby-whale/pet', handler: h.misc.handlePet },
    { path: '/api/chubby-whale/clear-memory', handler: h.misc.handleClearMemory },
    { path: '/api/chubby-whale/cache', handler: h.misc.handleCache },
    { path: '/api/chubby-whale/cache-toggle', handler: h.cacheToggle },
    { path: '/api/chubby-whale/story/books', handler: h.story.handleBooks },
    { path: '/api/chubby-whale/story/start', handler: h.story.handleStoryStart },
    { path: '/api/chubby-whale/story/next', handler: h.story.handleStoryNext },
    { path: '/api/chubby-whale/story/reset', handler: h.story.handleStoryReset },
    { path: '/api/chubby-whale/reminders', handler: h.reminders.handleReminders },
    { path: '/api/chubby-whale/culture', handler: h.culture.handleCulture },
    { path: '/api/chubby-whale/melodies', handler: h.culture.handleMelodies },
    { path: '/api/chubby-whale/melody', handler: h.culture.handleMelody },
    { path: '/api/chubby-whale/poem', handler: h.poem.handlePoem },
    { path: '/api/chubby-whale/briefing', handler: h.briefing.handleBriefing },
    { path: '/api/chubby-whale/tts', handler: h.tts },
    { path: '/api/chubby-whale/asr', handler: h.asr },
  ]
}
