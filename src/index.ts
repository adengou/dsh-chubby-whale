/**
 * dsh-chubby-whale —— Host 端入口（模块化组装）
 * 编译输出 dist/index.js（插件加载入口）。
 * 模块：host/config.ts（Key）、host/store.ts（持久化）、host/routes/*（路由）。
 */
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, existsSync, copyFileSync, cpSync } from 'node:fs'
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
/** 内容数据（17 本古籍 / 诗词 / 文化 / 曲库）——随插件包发布，只读 */
const DATA_DIR = join(PLUGIN_DIR, 'data')
/**
 * 运行数据（记忆 / 成长 / 提醒 / 进度 / 缓存）——放在插件包**之外**的独立目录：
 * 插件升级/重装不会抹掉，也不会与任何其他插件共享。
 */
const RUNTIME_DIR = join(homedir(), '.dsh-chubby-whale')

/** 老的运行数据写在包内 data/ 里，首次启动搬到 RUNTIME_DIR（不删原件，保守迁移） */
function migrateRuntimeData(): void {
  const files = [
    'memory.json', 'state.json', 'growth.json', 'fishfood.json', 'reminders.json',
    'story_progress.json', 'culture-seen.json', 'poem-seen.json', 'pet_state.json',
  ]
  try { mkdirSync(RUNTIME_DIR, { recursive: true }) } catch { }
  for (const f of files) {
    const src = join(DATA_DIR, f)
    const dst = join(RUNTIME_DIR, f)
    try {
      if (existsSync(src) && !existsSync(dst)) {
        copyFileSync(src, dst)
        console.log('[chubby-whale] 迁移运行数据 ' + f + ' → ' + RUNTIME_DIR)
      }
    } catch { }
  }
  // 缓存目录整目录搬迁（只在目标不存在时）
  try {
    const src = join(DATA_DIR, 'cache')
    const dst = join(RUNTIME_DIR, 'cache')
    if (existsSync(src) && !existsSync(dst)) {
      cpSync(src, dst, { recursive: true })
      console.log('[chubby-whale] 迁移缓存 → ' + dst)
    }
  } catch { }
}

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

/**
 * 插件入口。config 来自 cordis.patch.yml 的 config 段（DSH 按 apply(ctx, config) 传入）。
 * 总开关：config.enabled === false 时整个宿主端不注册任何路由。
 */
export function apply(ctx: any, config?: any): void {
  if (config && config.enabled === false) {
    console.log('[chubby-whale] disabled by config')
    return
  }

  migrateRuntimeData()

  const store = createStore(RUNTIME_DIR)
  const ttsCache = createCache({ dir: join(RUNTIME_DIR, 'cache', 'tts') })
  const chatCache = createCache({ dir: join(RUNTIME_DIR, 'cache', 'chat') })
  const asrCache = createCache({ dir: join(RUNTIME_DIR, 'cache', 'asr') })
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

  const reminders = createReminderHandlers({
    loadReminders: store.loadReminders,
    addReminder: store.addReminder,
    dueReminders: store.dueReminders,
    removeReminder: store.removeReminder,
  })
  const culture = createCultureHandlers({ dataDir: DATA_DIR, runtimeDir: RUNTIME_DIR })
  const poem = createPoemHandler({ dataDir: DATA_DIR, runtimeDir: RUNTIME_DIR })
  const briefing = createBriefingHandlers({
    loadGrowth: store.loadGrowth,
    loadReminders: store.loadReminders,
  })
  const tts = createTtsHandler({ cache: ttsCache })
  const asr = createAsrHandler({ pluginDir: PLUGIN_DIR, cache: asrCache })

  // 21 条路由统一交给 ctx.effect 托管：插件热重载/禁用时先跑返回的清理器把旧路由摘掉，
  // 第二次 apply 才不会撞 dsh-host-webserver 的 duplicate 检查，旧 store/cache 闭包也不会留在路由表里。
  const registerRoutes = (): (() => void) => {
    const disposers: Array<() => void> = []
    const reg = (path: string, handler: any): void => {
      const dispose = ctx.webServer.register({ kind: 'exact', path, handler })
      if (typeof dispose === 'function') disposers.push(dispose)
    }
    try {
      reg('/api/chubby-whale/asset', misc.handleAsset)
      reg('/api/chubby-whale/chat', chat)
      reg('/api/chubby-whale/status', misc.handleStatus)
      reg('/api/chubby-whale/state', misc.handleState)
      reg('/api/chubby-whale/balance', misc.handleBalance)
      reg('/api/chubby-whale/growth', misc.handleGrowth)
      reg('/api/chubby-whale/fishfood', misc.handleFishfood)
      reg('/api/chubby-whale/pet', misc.handlePet)
      reg('/api/chubby-whale/clear-memory', misc.handleClearMemory)
      reg('/api/chubby-whale/story/books', story.handleBooks)
      reg('/api/chubby-whale/story/start', story.handleStoryStart)
      reg('/api/chubby-whale/story/next', story.handleStoryNext)
      reg('/api/chubby-whale/story/reset', story.handleStoryReset)
      reg('/api/chubby-whale/reminders', reminders.handleReminders)
      reg('/api/chubby-whale/culture', culture.handleCulture)
      reg('/api/chubby-whale/melodies', culture.handleMelodies)
      reg('/api/chubby-whale/melody', culture.handleMelody)
      reg('/api/chubby-whale/poem', poem.handlePoem)
      reg('/api/chubby-whale/briefing', briefing.handleBriefing)
      reg('/api/chubby-whale/tts', tts)
      reg('/api/chubby-whale/asr', asr)
      return () => {
        for (const dispose of disposers) {
          try { dispose() } catch { }
        }
        disposers.length = 0
      }
    } catch (err) {
      // 中途抛错（比如撞上别的 owner）时先摘掉已注册的，别留半套路由
      for (const dispose of disposers) {
        try { dispose() } catch { }
      }
      disposers.length = 0
      throw err
    }
  }
  // cordis 的 ctx.effect(setup) 会把 setup 返回的清理函数挂到当前 fiber，卸载时自动执行
  if (typeof ctx.effect === 'function') ctx.effect(registerRoutes, 'chubby-whale: routes')
  else registerRoutes()
}
