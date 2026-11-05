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
 * 保持旧实现的读体方式（不设上限的字符串收集 + 失败静默），避免改变既有客户端行为。
 */
export function createCacheToggleHandler(prefs: PrefsRepo): (req: any, res: any) => void {
  return (req: any, res: any): void => {
    let body = ''
    req.on('data', (c: any) => { body += String(c) })
    req.on('end', () => {
      try {
        if (body) { const j = JSON.parse(body); if (typeof j.enabled === 'boolean') prefs.setChatCache(j.enabled) }
      } catch { }
      sendJson(res, { ok: true, enabled: prefs.chatCacheEnabled() })
    })
  }
}
