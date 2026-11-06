/**
 * client/poem-titles.ts —— 诗名索引按需加载（「点诗」意图识别用）
 *
 * 为什么不再内联：634 个标题约 11 KB，只服务「点诗」这一种意图，原先随 intent.ts
 * 一起打进 client bundle，每个打开页面的人都要下载。现在改成向 host 要一次：
 *   GET /api/chubby-whale/poem-titles → { ok, titles: [...] }
 *
 * 三条硬约束（detectIntent 是同步函数，调用链不能改成异步）：
 *   ① 只读缓存、绝不等待网络：未就绪时 poemTitles() 返回空数组，调用方跳过诗名匹配，
 *      泛化意图（背首诗/念首诗）照常识别；预热在后台跑，下次调用即可用。
 *   ② 只拉一次：内存就绪或已发起过（成功/失败都算）就不再请求；
 *      失败 = 本页不识别具体诗名，不影响其他意图，也不弹错。
 *   ③ 命中 localStorage 时同步就绪（刷新页面后第一次识别就能点名诗）；
 *      键带 chubby- 前缀与版本号，缓存读坏/写不进都只当没命中。
 *
 * 单测说明：test.mjs 直接加载 src/*.ts（没有 host 可请求），在项目根 cwd 下
 * 从 data/poem-titles.json 同步读一次，让既有断言无需 mock 网络即可验证诗名识别。
 * 浏览器 bundle 里没有 process，这段分支不会执行（真实浏览器只走 fetch）。
 */
import { str } from './util.js'
import { deepFreeze } from '../shared/immutable.js'
import { getJson, timeoutSignal } from './http.js'

/** 相对 http.ts 的 API_BASE 的路径 */
const API_PATH = '/poem-titles'
/** localStorage 键（check-boundaries B4：必须 chubby- 前缀；键里的 v1 与 CACHE_VERSION 同步升） */
const CACHE_KEY = 'chubby-poem-titles-v1'
const CACHE_VERSION = 1
/** 拉取超时：超时就当失败降级，绝不悬挂 */
const FETCH_TIMEOUT_MS = 8000

/** 标题缓存（长度降序；空数组 = 尚未就绪） */
let cache: readonly string[] = deepFreeze<string[]>([])
/** 已发起过加载（成功/失败都算）：失败后本页不再重试，避免每次识别都打网络 */
let started = false
/**
 * 失败后的重试节流（2026-11-07 分身审计）：原来 `started` 只置一次，本页就**永不再试**，
 * 而宿主是「文件后来补上就能恢复」——两边恢复能力不对等。
 * 这里有界重试：最多 3 次、每次间隔 60s，避免空库时无限轮询。
 */
const RETRY_DELAY_MS = 60 * 1000
const MAX_ATTEMPTS = 3
let attempts = 0
let nextTryAt = 0
/** 在途闸：同一时刻只有一个请求（detectIntent 可能在同步循环里连调多次） */
let inflight = false

/** 归一化：只留非空字符串，按长度降序（与内联时代一致：「雨霖铃」先于「雨」这类短名） */
function normalize(list: unknown): string[] {
  const out: string[] = []
  if (!Array.isArray(list)) return out
  for (const item of list) {
    const s = str(item)
    if (s) out.push(s)
  }
  return out.sort((a, b) => b.length - a.length)
}

/** 写入内存缓存；persist=true 时同时写 localStorage（只在网络拿到新数据时写） */
function apply(list: unknown, persist: boolean): void {
  const titles = normalize(list)
  if (titles.length === 0) return
  cache = deepFreeze(titles)
  if (persist) writeCache(titles)
}

function readCache(): string[] {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return []
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return []
    const data = JSON.parse(raw)
    if (!data || data.v !== CACHE_VERSION || !Array.isArray(data.titles)) return []
    return data.titles
  } catch {
    // 隐私模式/坏 JSON/配额异常：一律当没缓存
    return []
  }
}

function writeCache(titles: string[]): void {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return
    localStorage.setItem(CACHE_KEY, JSON.stringify({ v: CACHE_VERSION, titles }))
  } catch {
    // 写不进去不影响本次使用，下次刷新再重新拉一次
  }
}

/**
 * 单测兜底：Node 环境从项目根 data/poem-titles.json 同步读一次。
 * 用 process.getBuiltinModule 取内置模块（不走 import，不额外打依赖、不污染浏览器打包）；
 * 浏览器里没有 process，整段直接跳过。
 */
function seedFromDisk(): string[] {
  try {
    const proc: any = typeof process !== 'undefined' ? process : null
    if (!proc || typeof proc.getBuiltinModule !== 'function' || typeof proc.cwd !== 'function') return []
    const fs = proc.getBuiltinModule('node:fs')
    const nodePath = proc.getBuiltinModule('node:path')
    if (!fs || !nodePath) return []
    // 单测可能从任意 cwd 启动：从 cwd 逐级向上找 data/poem-titles.json（最多 4 层，找到即用）
    let dir = proc.cwd()
    for (let i = 0; i < 4; i++) {
      const candidate = nodePath.join(dir, 'data', 'poem-titles.json')
      try {
        const raw = fs.readFileSync(candidate, 'utf8')
        const data = JSON.parse(String(raw).replace(/^\uFEFF/, ''))
        return Array.isArray(data && data.titles) ? data.titles : []
      } catch { /* 这一层没有，继续向上 */ }
      const parent = nodePath.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return []
  } catch {
    return []
  }
}
/** 同步读缓存：空数组 = 尚未就绪（调用方应跳过诗名匹配，不要在这里等网络） */
export function poemTitles(): readonly string[] {
  return cache
}

/** 后台预热（幂等）：就绪/尝试上限/退避窗口内都直接返回；从不抛错、从不阻塞调用方 */
export function ensurePoemTitles(): void {
  if (cache.length > 0) return
  if (inflight) return
  if (attempts >= MAX_ATTEMPTS) return
  if (Date.now() < nextTryAt) return
  started = true
  attempts++
  inflight = true
  // 失败：退出在途闸并设置退避窗口
  const failed = (): void => {
    inflight = false
    nextTryAt = Date.now() + RETRY_DELAY_MS
  }
  getJson(API_PATH, { signal: timeoutSignal(FETCH_TIMEOUT_MS) })
    .then((data: any) => {
      // host 失败时返回 {ok:false, titles:[]}：按「没拿到」处理，保持降级
      if (data && data.ok === true && Array.isArray(data.titles) && data.titles.length > 0) {
        inflight = false
        apply(data.titles, true)
        return
      }
      failed()
    })
    .catch(() => {
      // 网络/解析失败：本页不识别具体诗名；「泛化意图」不受影响
      failed()
    })
}

/** 注入标题（调用方自备数据时用；不写缓存、不发请求） */
export function primePoemTitles(list: unknown): void {
  apply(list, false)
}

// 模块加载时先看本地缓存（同步就绪），没有再看单测兜底；
// 两者都没有才等 detectIntent 首次走到诗名匹配时按需拉取（见 ensurePoemTitles）。
{
  const cached = readCache()
  if (cached.length > 0) apply(cached, false)
  else {
    const seed = seedFromDisk()
    if (seed.length > 0) apply(seed, false)
  }
}
