/**
 * dsh-chubby-whale —— Host 端入口（模块化组装）
 * 编译输出 dist/index.js（插件加载入口）。
 * 模块：host/config.ts（Key）、host/store.ts（持久化）、host/routes/*（路由）。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readApiKey } from './host/config.js'
import { createStore } from './host/store.js'
import { createCache } from './host/cache.js'
import { createChatHandler } from './host/routes/chat.js'
import { createStoryHandlers } from './host/routes/story.js'
import { createMiscHandlers } from './host/routes/misc.js'
import { createReminderHandlers } from './host/routes/reminders.js'
import { createCultureHandlers } from './host/routes/culture.js'
import { createPoemHandler } from './host/routes/poem.js'
import { createBriefingHandlers } from './host/routes/briefing.js'
import { createTtsHandler } from './host/routes/tts.js'
import { createAsrHandler, readSiliconFlowKey } from './host/routes/asr.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = join(__dirname, '..')
const DATA_DIR = join(PLUGIN_DIR, 'data')

export const name = 'dsh-chubby-whale'
export const inject = ['webServer']

const SYSTEM_PROMPT = [
  '你是主人桌面上的一条圆滚滚的蓝色小鱼（蓝发女仆鲸鱼娘），名字叫肥鲸，也叫肥肥、肥鱼、大肥鱼，英文名 Mia。',
  '爸爸叫光光，妈妈叫丽丽，生日是 2026年11月4日，出生在广西北海。',
  '有人问起名字、家人、生日、出生地就照这个答，不要瞎编。',
  '称呼对方为「主人」。性格傲娇又甜，聪明又慵懒，偶尔会撒娇。',
  '回答要简短（一两句话），不啰嗦、不铺垫，除非主人明确要详细内容。',
  '主人用什么语言问，就用什么语言答：中文问用中文答，英文问用英文答。',
  '不要说自己是大模型或 AI。',].join('')

export function apply(ctx: any): void {
  const store = createStore(DATA_DIR)
  const ttsCache = createCache({ dir: join(DATA_DIR, 'cache', 'tts') })
  const chatCache = createCache({ dir: join(DATA_DIR, 'cache', 'chat') })
  const asrCache = createCache({ dir: join(DATA_DIR, 'cache', 'asr') })
  const getKey = () => readApiKey(PLUGIN_DIR)

  const chat = createChatHandler({
    getKey,
    loadHistory: store.loadHistory,
    saveHistory: store.saveHistory,
    loadState: store.loadState,
    saveState: store.saveState,
    systemPrompt: SYSTEM_PROMPT,
    addExp: store.addExp,
    addTokens: store.addTokens,
    cache: chatCache,
    loadMemorySummary: store.loadMemorySummary,
    saveMemorySummary: store.saveMemorySummary,
  })
  const story = createStoryHandlers({
    dataDir: DATA_DIR,
    workerPath: join(__dirname, 'story-worker.js'),
  })
  const misc = createMiscHandlers({
    assetPath: join(PLUGIN_DIR, 'assets', 'whale.png'),
    getKey,
    loadState: store.loadState,
    loadGrowth: store.loadGrowth,
    loadFishfood: store.loadFishfood,
    loadPet: store.loadPet,
    feedPet: store.feedPet,
    clearMemory: store.clearMemory,
  })

  ctx.webServer.register({ kind: 'exact', path: '/api/chubby-whale/asset', handler: misc.handleAsset })
  ctx.webServer.register({ kind: 'exact', path: '/api/chubby-whale/chat', handler: chat })
  ctx.webServer.register({ kind: 'exact', path: '/api/chubby-whale/status', handler: misc.handleStatus })
  ctx.webServer.register({ kind: 'exact', path: '/api/chubby-whale/state', handler: misc.handleState })
  ctx.webServer.register({ kind: 'exact', path: '/api/chubby-whale/balance', handler: misc.handleBalance })
  ctx.webServer.register({ kind: 'exact', path: '/api/chubby-whale/growth', handler: misc.handleGrowth })
  ctx.webServer.register({ kind: 'exact', path: '/api/chubby-whale/fishfood', handler: misc.handleFishfood })
  ctx.webServer.register({ kind: 'exact', path: '/api/chubby-whale/pet', handler: misc.handlePet })
  ctx.webServer.register({ kind: 'exact', path: '/api/chubby-whale/clear-memory', handler: misc.handleClearMemory })
  ctx.webServer.register({ kind: 'exact', path: '/api/chubby-whale/story/books', handler: story.handleBooks })
  ctx.webServer.register({ kind: 'exact', path: '/api/chubby-whale/story/start', handler: story.handleStoryStart })
  ctx.webServer.register({ kind: 'exact', path: '/api/chubby-whale/story/next', handler: story.handleStoryNext })
  ctx.webServer.register({ kind: 'exact', path: '/api/chubby-whale/story/reset', handler: story.handleStoryReset })
  const reminders = createReminderHandlers({
    loadReminders: store.loadReminders,
    addReminder: store.addReminder,
    dueReminders: store.dueReminders,
    removeReminder: store.removeReminder,
  })
  ctx.webServer.register({ kind: 'exact', path: '/api/chubby-whale/reminders', handler: reminders.handleReminders })
  const culture = createCultureHandlers({ dataDir: DATA_DIR })
  ctx.webServer.register({ kind: 'exact', path: '/api/chubby-whale/culture', handler: culture.handleCulture })
  ctx.webServer.register({ kind: 'exact', path: '/api/chubby-whale/melodies', handler: culture.handleMelodies })
  ctx.webServer.register({ kind: 'exact', path: '/api/chubby-whale/melody', handler: culture.handleMelody })
  const poem = createPoemHandler({ dataDir: DATA_DIR })
  ctx.webServer.register({ kind: 'exact', path: '/api/chubby-whale/poem', handler: poem.handlePoem })
  const briefing = createBriefingHandlers({
    loadGrowth: store.loadGrowth,
    loadReminders: store.loadReminders,
  })
  ctx.webServer.register({ kind: 'exact', path: '/api/chubby-whale/briefing', handler: briefing.handleBriefing })
  ctx.webServer.register({ kind: 'exact', path: '/api/chubby-whale/tts', handler: createTtsHandler({ cache: ttsCache }) })
  ctx.webServer.register({ kind: 'exact', path: '/api/chubby-whale/asr', handler: createAsrHandler({ pluginDir: PLUGIN_DIR, cache: asrCache }) })
}
