/**
 * host/routes.ts —— 路由表（exact path → handler）
 *
 * 入口只把各能力 handler 组装进来，按这张表统一注册；路径不再散落在 index.ts 里。
 * 新增一个能力路由：
 *   ① 新建 host/routes/xxx.ts（导出 createXxxHandler）
 *   ② 本表加一行 { path, handler }
 *   ③ index.ts 里构造 handler 并放进 routes 对象（一行接线）
 *
 * 两条只有这张表才知道的约束：
 *   · **全部是 exact 路径**（index.ts 注册时 kind: 'exact'）。dsh-host-webserver 只按
 *     (kind, path) 精确查表，不做前缀/正则匹配，所以表内顺序不参与匹配，也不存在
 *     `/story` 遮蔽 `/story/books` 这类问题；代价是每条路径必须一字不差地写对。
 *   · **路径必须唯一**：重复注册会被 webserver 的 duplicate 检查直接抛错，
 *     入口会把已注册的摘掉再抛出（不留半套路由）。唯一性由 scripts/test-assembly.mjs 兜。
 *
 * 类型：HandlerSet 的字段一律用工厂函数的 ReturnType，而不是 any —— 表和实现之间因此有
 * **编译期**契约，表里把 handleState 写成 handleStats 会直接 tsc 报错；此前全是 any，
 * 只有真点到那条路由、拿到 404 才会发现。
 *
 * 这里只 import type（编译后整段消失）：既不让路由表在运行期把全部能力模块拽进来，
 * 也不改变「谁调用谁」的装配方向。
 */
import type { createMiscHandlers } from './routes/misc.js'
import type { createChatHandler } from './routes/chat.js'
import type { createChatStreamHandler } from './routes/chat-stream.js'
import type { createStoryHandlers } from './routes/story.js'
import type { createReminderHandlers } from './routes/reminders.js'
import type { createCultureHandlers } from './routes/culture.js'
import type { createPoemHandler } from './routes/poem.js'
import type { createPoemTitlesHandler } from './routes/poem-titles.js'
import type { createBriefingHandlers } from './routes/briefing.js'
import type { createTtsHandler } from './routes/tts.js'
import type { createAsrHandler } from './routes/asr.js'
import type { createPersonalityHandlers } from './routes/personality.js'
import type { createDailyHandler } from './routes/daily.js'
import type { createBackupHandlers } from './routes/backup.js'
import type { createStatsHandler } from './routes/stats.js'
import type { createConfigViewHandler } from './routes/config.js'
import type { createProofreadHandler } from './routes/proofread.js'
import type { createNervousHandler } from './routes/nervous.js'

/**
 * HTTP handler 的统一形状（req/res 由 dsh webserver 传入，与各路由工厂的产出兼容）。
 * 故意**不 export**：它不是新接口，只是本表内部用的形状标注（模块接口清单不该为它多一行）。
 */
type RouteHandler = (req: any, res: any) => any

export interface HttpRoute {
  path: string
  handler: RouteHandler
}

export interface HandlerSet {
  misc: ReturnType<typeof createMiscHandlers>
  chat: ReturnType<typeof createChatHandler>
  chatStream: ReturnType<typeof createChatStreamHandler>
  /** /cache-toggle：host/prefs.ts 直接产出的处理函数（没有 handler 对象，故用统一形状） */
  cacheToggle: RouteHandler
  story: ReturnType<typeof createStoryHandlers>
  reminders: ReturnType<typeof createReminderHandlers>
  culture: ReturnType<typeof createCultureHandlers>
  poem: ReturnType<typeof createPoemHandler>
  /** 诗名索引：{ handlePoemTitles }（客户端点诗识别按需拉取） */
  poemTitles: ReturnType<typeof createPoemTitlesHandler>
  briefing: ReturnType<typeof createBriefingHandlers>
  tts: ReturnType<typeof createTtsHandler>
  asr: ReturnType<typeof createAsrHandler>
  /** L2 可变人格：{ handlePersonality, handleRevert } */
  personality: ReturnType<typeof createPersonalityHandlers>
  /** 每日一句：{ handleDaily } */
  daily: ReturnType<typeof createDailyHandler>
  /** 一键备份 / 导入：{ handleExport, handleImport } */
  backup: ReturnType<typeof createBackupHandlers>
  /** 可视化汇总：{ handleStats } */
  stats: ReturnType<typeof createStatsHandler>
  /** 只读配置视图：{ handleConfig }（不含 Key 内容） */
  configView: ReturnType<typeof createConfigViewHandler>
  /** 公文校对：一次性外呼，不写聊天记忆 */
  proofread: ReturnType<typeof createProofreadHandler>
  /** 神经感知第三层：宿主事件只读快照（客户端 3s 轮询一次） */
  nervous: ReturnType<typeof createNervousHandler>
}

export function createRouteTable(h: HandlerSet): HttpRoute[] {
  return [
    { path: '/api/chubby-whale/asset', handler: h.misc.handleAsset },
    { path: '/api/chubby-whale/skin', handler: h.misc.handleSkin },
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
    // 诗名索引：客户端点诗识别按需拉取（不再内联进 client bundle）
    { path: '/api/chubby-whale/poem-titles', handler: h.poemTitles.handlePoemTitles },
    { path: '/api/chubby-whale/briefing', handler: h.briefing.handleBriefing },
    { path: '/api/chubby-whale/tts', handler: h.tts },
    { path: '/api/chubby-whale/asr', handler: h.asr },
    // L2 可变人格：读当前 + 历史 / 回滚上一条变更
    { path: '/api/chubby-whale/personality', handler: h.personality.handlePersonality },
    { path: '/api/chubby-whale/personality/revert', handler: h.personality.handleRevert },
    // 每日一句（daily.json 优先，缺文件时按日期从真实诗库取）
    { path: '/api/chubby-whale/daily', handler: h.daily.handleDaily },
    // 一键备份 / 导入（不含、也不写任何 API Key）
    { path: '/api/chubby-whale/data/export', handler: h.backup.handleExport },
    { path: '/api/chubby-whale/data/import', handler: h.backup.handleImport },
    // 可视化汇总（只读现有 store/cache）
    { path: '/api/chubby-whale/stats', handler: h.stats.handleStats },
    { path: '/api/chubby-whale/config', handler: h.configView.handleConfig },
    { path: '/api/chubby-whale/proofread', handler: h.proofread },
    // 神经感知第三层：宿主事件只读快照（客户端按 at 去重后逐条喂给情绪模型）
    { path: '/api/chubby-whale/nervous', handler: h.nervous },
  ]
}
