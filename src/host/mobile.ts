/**
 * 手机简版（/whale-mobile）：聊天 / 说书 / 提醒
 *
 * 从独立的 dsh-whale-mobile 插件并入 chubby-whale：
 *   - 复用本插件已经拿到的 webServer（`inject: ['webServer']`）
 *   - 复用宿主的 ctx.llm（模型、Key 都不另管）
 *   - 数据仍落在 $DSH_HOME/whale-mobile/state.json
 *   - 静态页在包根目录 mobile/，挂一条 prefix 路由
 *
 * 依赖说明：这是 chubby-whale 的手机端简版，必须由电脑端 dsh web 常驻；
 * 离开宿主，页面上什么都点不动。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDeepSeek } from '../mobile/core/deepseek.js'
import { createStore } from '../mobile/core/store.js'
import { createStatic } from '../mobile/http/static.js'
import { createRouter } from '../mobile/http/router.js'
import { createChatModule } from '../mobile/modules/chat/index.js'
import { createStoryModule } from '../mobile/modules/story/index.js'
import { createReminderModule } from '../mobile/modules/reminder/index.js'
import { readApiKey, readChatModel } from './config.js'
import { buildSystemPrompt } from './persona.js'

const MOBILE_VERSION = '0.1.0'

function readPackageVersion(): string {  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    return String(pkg.version || 'unknown')
  } catch {
    return 'unknown'
  }
}

function makeLogger(): any {
  const prefix = '[whale-mobile]'
  return {
    info: (...args: any[]) => console.log(prefix, ...args),
    warn: (...args: any[]) => console.warn(prefix, ...args),
    error: (...args: any[]) => console.error(prefix, ...args),
  }
}

/**
 * 用户级 Key 回退：插件以 profile 包方式安装时，桌宠的 Key 往往还留在
 * $DSH_HOME/plugins/dsh-chubby-whale/config.json（README 里的手动安装路径）。
 * 这里只读 deepseekKey 一个字段，读不到就返回空串。
 */
function readUserLevelDeepSeekKey(): string {
  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    const file = join(dshHome, 'plugins', 'dsh-chubby-whale', 'config.json')
    const cfg = JSON.parse(readFileSync(file, 'utf8'))
    const key = cfg && typeof cfg.deepseekKey === 'string' ? cfg.deepseekKey.trim() : ''
    return key
  } catch {
    return ''
  }
}

/**
 * 挂载手机简版，返回清理函数（由 ctx.effect 托管）。
 * @param ctx cordis 上下文（需要 webServer 与 llm）
 * @param options { basePath?, token?, dataDir?, provider?, model?, chat?, story?, reminder? }
 */
export function mountWhaleMobile(ctx: any, options: any = {}): () => Promise<void> {
  const logger = makeLogger()
  const basePath = String(options.basePath || '/whale-mobile').replace(/\/+$/, '')
  const dataRoot = options.dataDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'whale-mobile')
  const stateFile = join(dataRoot, 'state.json')
  // dist/host/mobile.js → ../../ = 包根目录；Key 与模型都复用桌宠自己的配置
  const pluginDir = fileURLToPath(new URL('../../', import.meta.url))
  const mobileRoot = fileURLToPath(new URL('../../mobile/', import.meta.url))
  const clock = { now: () => Date.now() }

  const apiKey = options.apiKey || readApiKey(pluginDir) || readUserLevelDeepSeekKey()
  const chatModel = options.model || readChatModel(pluginDir, {})
  const llm = createDeepSeek({ apiKey, model: chatModel })
  logger.info(`模型：${chatModel}${apiKey ? '（复用桌宠的 Key）' : '（尚未配置 Key）'}`)
  const store = createStore({ filePath: stateFile, logger })
  const modules = {
    chat: createChatModule({ llm, store, clock, logger, config: Object.assign({ systemPrompt: buildSystemPrompt('') }, options.chat || {}) }),
    story: createStoryModule({ llm, store, clock, logger, config: options.story || {} }),
    reminder: createReminderModule({ store, clock, logger, config: options.reminder || {} }),
  }

  const staticServer = createStatic({ root: mobileRoot, logger })
  const dependencies = {
    dshWeb: {
      ok: true,
      role: 'hard',
      note: '硬依赖：电脑端 dsh web 常驻（本插件就跑在它里面）；它关了，这个页面只剩空壳。',
    },
    chubbyWhale: {
      installed: true,
      version: readPackageVersion(),
      role: 'host',
      note: '本插件就是桌宠本体；手机端是它的简版，桌宠仍显示在电脑网页右下角。',
    },
  }

  const router = createRouter({
    basePath,
    token: options.token || '',
    modules,
    staticServer,
    version: MOBILE_VERSION,
    dependencies,
    logger,
  })

  const disposeRoute = ctx.webServer.register({
    kind: 'prefix',
    path: router.prefix(),
    handler: router.handler,
  })
  logger.info(`手机简版已挂载 ${basePath}/（数据目录 ${dataRoot}）`)

  return async () => {
    try {
      disposeRoute()
      router.dispose()
    } finally {
      for (const module of Object.values(modules) as any[]) {
        try {
          await module.dispose?.()
        } catch (err: any) {
          logger.warn(`模块 ${module.name} 关闭失败：${err && err.message}`)
        }
      }
      await store.flush?.()
    }
  }
}
