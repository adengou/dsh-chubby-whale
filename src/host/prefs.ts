/**
 * host/prefs.ts —— 插件偏好（prefs.json）与聊天缓存开关路由
 *
 * 偏好存运行目录（~/.dsh-chubby-whale/prefs.json），不进仓库、不与其他插件共享。
 * 原先这两件事都内联在 index.ts 的组装代码里（组装层写业务），现在独立成能力模块：
 * 新增一个偏好只改本文件；/cache-toggle 路由由工厂直接产出，index 只接线。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic } from './atomic.js'
import { sendJson } from './respond.js'
import { isBodyTooLarge, readBody, sendTooLarge } from './http.js'

/** /cache-toggle 请求体上限：只需一个 {"enabled":true}，16KB 足够，超限回 413 */
const CACHE_TOGGLE_MAX_BODY = 16 * 1024

interface PrefsData {
  /** 聊天缓存总开关；缺省 true（与旧实现 loadPrefs().chatCache !== false 一致） */
  chatCache?: boolean
  [key: string]: any
}

export interface PrefsRepo {
  load(): PrefsData
  save(p: PrefsData): void
  chatCacheEnabled(): boolean
  setChatCache(on: boolean): void
}

export function createPrefs(runtimeDir: string): PrefsRepo {
  const PREFS_FILE = join(runtimeDir, 'prefs.json')

  function load(): PrefsData {
    try { return JSON.parse(readFileSync(PREFS_FILE, 'utf8')) } catch { return {} }
  }
  function save(p: PrefsData): void {
    // 原子写：写坏一次就整份偏好丢失（与 store 同一套工具）
    try { writeJsonAtomic(PREFS_FILE, p) } catch { }
  }
  const chatCacheEnabled = (): boolean => {
    try { return load().chatCache !== false } catch { return true }
  }
  const setChatCache = (on: boolean): void => {
    const p = load(); p.chatCache = on; save(p)
  }

  return { load, save, chatCacheEnabled, setChatCache }
}

/**
 * /cache-toggle：POST {enabled:boolean} 切换聊天缓存开关；GET 读当前状态。
 * 2026-11 起请求体走 host/http.ts 的 readBody 并设 16KB 上限：原先手动 'data' 累加没有上限，
 * 一个超大 body 就能把整段字符串攒进内存。超限按项目既有约定回 413。
 */
export function createCacheToggleHandler(prefs: PrefsRepo): (req: any, res: any) => Promise<void> {
  return async (req: any, res: any): Promise<void> => {
    let text = ''
    try {
      text = (await readBody(req, CACHE_TOGGLE_MAX_BODY)).toString('utf8')
    } catch (err: any) {
      if (isBodyTooLarge(err)) {
        console.error('[prefs] CACHE-TOGGLE-BODY-TOO-LARGE > ' + CACHE_TOGGLE_MAX_BODY + ' bytes')
        sendTooLarge(res)
        return
      }
      // 连接中断等读流错误：不再尝试写响应（对端大概率已断开），留一行日志
      console.error('[prefs] CACHE-TOGGLE-BODY ' + String((err && err.message) || err))
      return
    }
    try {
      if (text) {
        const j = JSON.parse(text)
        if (typeof j.enabled === 'boolean') prefs.setChatCache(j.enabled)
      }
    } catch { }
    sendJson(res, { ok: true, enabled: prefs.chatCacheEnabled() })
  }
}
