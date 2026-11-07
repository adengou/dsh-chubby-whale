/**
 * host/config.ts —— 本插件自己的配置与 Key（与任何其他插件/宿主数据互相独立）
 *
 * Key 来源（只认本插件）：
 *   1) 本插件 config.json 的对应字段（推荐）
 *   2) 本插件专属环境变量：CHUBBY_WHALE_DEEPSEEK_KEY / CHUBBY_WHALE_SILICONFLOW_KEY
 *   3) 兼容回退：DEEPSEEK_API_KEY / SILICONFLOW_API_KEY（通用名，仅兜底）
 *
 * 刻意**不读** ~/.dsh/.credentials.yaml：那是 DSH 与其他插件共用的凭据库，
 * 读了就与其他插件耦合，别人换 Key 也会牵连本插件。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isMissingFileError, stripBom } from './atomic.js'
import type { DataSourceKind } from './ports.js'

/**
 * 日志用的有界文本：控制字符（含换行/制表）折成单个空格，超长截断加省略号。
 * 为什么：配置值可能是手滑粘进来的一整段文本；原样拼进日志会把一行告警撕成几十 KB，
 * 既不便于排错，也容易顺带把不该出现的内容写进日志。
 */
function clip(raw: any, max: number): string {
  let s = ''
  try { s = raw == null ? '' : String(raw) } catch { return '(无法转成文本)' }
  s = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

/**
 * 值形状描述（只报类型/长度，**绝不回显内容**）。
 * config.json 里就放着 deepseekKey / siliconflowKey，任何“把原始值打进日志”的写法
 * 都是一条 Key 外泄通路；形状信息足够定位“写错类型”，不需要看到值本身。
 */
function shapeOf(raw: any): string {
  try {
    if (raw === undefined) return 'undefined'
    if (raw === null) return 'null'
    if (Array.isArray(raw)) return '数组（长度 ' + raw.length + '）'
    const t = typeof raw
    if (t === 'object') {
      let keys = 0
      try { keys = Object.keys(raw).length } catch { }
      return '对象（' + keys + ' 个键）'
    }
    return t
  } catch { return '无法识别的值' }
}

/** 配置值摘要：标量给有界文本（方便排错），数组/对象只报形状（不回显内容） */
function briefValue(raw: any): string {
  if (raw === null) return 'null'
  if (typeof raw === 'string') return '"' + clip(raw, 40) + '"'
  if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'undefined') return String(raw)
  return shapeOf(raw)
}

/**
 * JSON.parse 报错摘要：只取错误类型与 `at position N` 里的数字。
 * 原因见 readConfigJson 的调用点：Node ≥20 的报错消息本身带源文本片段，直接拼消息会泄 Key。
 */
function jsonErrorBrief(err: any): string {
  const name = clip(String((err && err.name) || 'Error'), 40)
  let position = ''
  try {
    const m = /at position (\d+)/.exec(String((err && err.message) || ''))
    if (m) position = ' @ position ' + m[1]
  } catch { }
  return name + position
}

/**
 * 读 config.json 里的 Key 字段：类型不对时告警一次（只报字段名与形状，不回显值）。
 * 旧实现是 `typeof cfg.deepseekKey === 'string'` 静默判否——用户把 Key 写成数字/对象时
 * 只会看到“Key 没了、语音没反应”，没有任何线索（坑 35 的失败模式）。
 */
function readKeyField(cfg: any, field: string): string {
  if (!cfg) return ''
  const raw = cfg[field]
  if (raw === undefined || raw === null) return ''
  if (typeof raw === 'string') return raw.trim()
  warnConfig('config.json 的 ' + field + ' 应为字符串（实际 ' + shapeOf(raw) + '），已忽略')
  return ''
}

/**
 * 读本插件 config.json。
 *
 * 降级口径（2026-11-07 B74 加固）：
 *   · 没有文件（ENOENT/ENOTDIR）是常态（Key 全走环境变量），静默按“未配置”处理；
 *   · 坏 JSON / 数组 / 标量 / null 一律按“未配置”处理，且**只提示一次**（readApiKey 在每次聊天都会被调用，
 *     不能让坏文件把日志刷满）；旧实现是全静默，用户只会看到“Key 没了、语音没反应”，
 *     照坑 35 的教训，“没反应”比“报错”更糟；
 *   · 配置对象必须是普通对象：数组/字符串没有对应字段，照原样返回只会让 cfg.deepseekKey 取到原型链上的怪值。
 *
 * 单一读取器（B102 起）：src/host/voice/cloud-tts.ts 的 readCloudVoice **复用本函数**，
 * 传自己的告警出口（日志前缀 [cloudVoice]）与去重集合。全仓只有这一条读 config.json 的路径，
 * 口径（坏 JSON 只报位置、只报形状、绝不拼 err.message、BOM 走 readTextNoBom）不可能再漂移。
 */
/** 告警出口：默认 warnConfig；云端传自己的（带 [cloudVoice] 前缀、独立去重） */
export type ConfigWarn = (msg: string) => void

/**
 * 读 pluginDir/config.json 的原始对象（全仓唯一入口）。
 * @param onWarn 告警出口；缺省用本模块的 warnConfig（前缀 [chubby-whale]）
 * @returns null = 没有文件 / 读不出来 / 坏 JSON / 根不是对象（调用方一律按默认值处理）
 */
export function readConfigJson(pluginDir: string, onWarn?: ConfigWarn): any {
  const warn = onWarn || warnConfig
  const file = join(pluginDir, 'config.json')
  let text: string
  try {
    text = String(readFileSync(file, 'utf8'))
  } catch (err: any) {
    if (!isMissingFileError(err)) warn('config.json 读取失败（' + file + '）：' + clip((err && err.message) || err, 200))
    return null
  }
  let parsed: any
  try {
    parsed = JSON.parse(stripBom(text))
  } catch (err: any) {
    // 只报错误类型与位置，**绝不拼 err.message**：Node ≥20 的 JSON 报错会带源文本片段
    //（实测 `Unexpected token 's', ..."pseekKey":sk-live-SE"...`）——config.json 里就放着 Key，
    // 拼进去等于把 Key 写进日志。
    warn('config.json 不是合法 JSON（' + file + '），已按未配置处理（' + jsonErrorBrief(err) + '）')
    return null
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // 只报形状（类型/长度），不回显内容：旧实现 shortValue(parsed) 会把文件前 60 字符原样打出来
    warn('config.json 应为对象（实际 ' + shapeOf(parsed) + '），已按未配置处理')
    return null
  }
  return parsed
}

function fromEnv(own: string, legacy: string): string {
  try {
    const v = process.env[own]
    if (v && v.trim()) return v.trim()
  } catch { }
  try {
    const v = process.env[legacy]
    if (v && v.trim()) return v.trim()
  } catch { }
  return ''
}

/** DeepSeek Key（聊天 / 文档总结 / 对联） */
export function readApiKey(pluginDir: string): string {
  const cfg = readConfigJson(pluginDir)
  const fromFileKey = readKeyField(cfg, 'deepseekKey')
  if (fromFileKey) return fromFileKey
  return fromEnv('CHUBBY_WHALE_DEEPSEEK_KEY', 'DEEPSEEK_API_KEY')
}

/** 硅基流动 Key（语音识别） */
export function readSiliconFlowKey(pluginDir: string): string {
  const cfg = readConfigJson(pluginDir)
  const fromFileKey = readKeyField(cfg, 'siliconflowKey')
  if (fromFileKey) return fromFileKey
  return fromEnv('CHUBBY_WHALE_SILICONFLOW_KEY', 'SILICONFLOW_API_KEY')
}

/**
 * 语音识别语言（硅基流动 Qwen3-ASR 的 language 参数）：默认 zh。
 * 为什么默认 zh：不传该参数时模型自动检测，短句/带噪声的音频常被识别成英文（"No, no"），
 * 主人的语音几乎都是中文，显式指定能显著减少误识别。
 * config.json 可改：asrLanguage（zh / en / auto）
 */
export function readAsrLanguage(pluginDir: string): string {
  const cfg = readConfigJson(pluginDir)
  const v = cfg && typeof cfg.asrLanguage === 'string' ? cfg.asrLanguage.trim().toLowerCase() : ''
  if (v === 'en' || v === 'auto') return v
  return 'zh'
}

/** Key 就绪情况（给 /status 与启动日志用） */
export function keyStatus(pluginDir: string): { deepseek: boolean; siliconflow: boolean } {
  return {
    deepseek: Boolean(readApiKey(pluginDir)),
    siliconflow: Boolean(readSiliconFlowKey(pluginDir)),
  }
}

const warnedSources = new Set<string>()

/** 接受 'local' | 'cloud'（大小写/空白不敏感）；未配置返回 null，非法值告警后按 local */
function parseDataSource(raw: any, from: string): DataSourceKind | null {
  if (raw == null || String(raw).trim() === '') return null
  const s = String(raw).trim().toLowerCase()
  if (s === 'local' || s === 'cloud') return s
  const msg = '[chubby-whale] 无效的数据源配置（' + from + '=' + clip(raw, 40) + '），按 local 处理'
  if (!warnedSources.has(msg)) {
    warnedSources.add(msg)
    console.warn(msg)
  }
  return 'local'
}

/**
 * 数据源：默认 local（读插件包内 data/）。
 * 优先级：cordis config.dataSource → 本插件 config.json 的 dataSource → 环境变量 CHUBBY_WHALE_DATA_SOURCE → local。
 * 只认 'local' / 'cloud'，其它值告警并回退 local（绝不因为配置笔误把内容功能弄挂）。
 */
export function readDataSource(pluginDir: string, runtimeConfig?: any): DataSourceKind {
  const fromRuntime = parseDataSource(runtimeConfig && runtimeConfig.dataSource, 'cordis config')
  if (fromRuntime) return fromRuntime
  const cfg = readConfigJson(pluginDir)
  const fromFile = parseDataSource(cfg && cfg.dataSource, 'config.json')
  if (fromFile) return fromFile
  const fromEnv = parseDataSource(process.env.CHUBBY_WHALE_DATA_SOURCE, 'CHUBBY_WHALE_DATA_SOURCE')
  if (fromEnv) return fromEnv
  return 'local'
}

/**
 * 布尔开关解析：只认明确的布尔值或 true/false/on/off/1/0/yes/no（大小写、空白不敏感）。
 * 认不出的值返回 null（按“未配置”处理，继续看下一层），绝不因配置笔误把功能弄成意外状态。
 */
export function parseSwitchValue(raw: any): boolean | null {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw === 'boolean') return raw
  const s = String(raw).trim().toLowerCase()
  if (s === 'false' || s === 'off' || s === '0' || s === 'no' || s === 'disabled') return false
  if (s === 'true' || s === 'on' || s === '1' || s === 'yes' || s === 'enabled') return true
  return null
}

/**
 * 开关读取顺序：cordis config → 本插件 config.json → （调用方默认值）。
 * 返回 null 表示两层都没配置。
 */
function readSwitch(pluginDir: string, runtimeConfig: any, key: string): boolean | null {
  const fromRuntime = parseSwitchValue(runtimeConfig && runtimeConfig[key])
  if (fromRuntime !== null) return fromRuntime
  const cfg = readConfigJson(pluginDir)
  return parseSwitchValue(cfg && cfg[key])
}

/**
 * L2 可变人格学习开关：默认开启。
 * 优先级：cordis config.personalityLearning → 本插件 config.json 的 personalityLearning → true。
 */
export function readPersonalityLearning(pluginDir: string, runtimeConfig?: any): boolean {
  const value = readSwitch(pluginDir, runtimeConfig, 'personalityLearning')
  return value === null ? true : value
}

/**
 * L3 近期心境自写开关：默认开启。
 * 优先级：cordis config.personalityWriting → 本插件 config.json 的 personalityWriting → true。
 * 与 personalityLearning 分开：关掉 L2 学习不影响心境生成，关掉自写也不影响已存心境的注入。
 */
export function readPersonalityWriting(pluginDir: string, runtimeConfig?: any): boolean {
  const value = readSwitch(pluginDir, runtimeConfig, 'personalityWriting')
  return value === null ? true : value
}

/**
 * 默认聊天模型：只在三层配置都没给时使用。
 * 模型名不写死在各个外呼点——官方目录改名、接入新模型时改配置即可，不用动代码。
 */
export const DEFAULT_CHAT_MODEL = 'deepseek-flash'

/** 模型名合法字符（与 DeepSeek 目录里的 id 一致）：防止配置里粘进整段文本被原样发给接口 */
const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/

const warnedModels = new Set<string>()

/** 解析模型名：非法值告警后返回 null（调用方继续看下一层/默认值） */
export function parseChatModel(raw: any, from: string): string | null {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s) return null
  if (MODEL_NAME_RE.test(s)) return s
  const msg = '[chubby-whale] 无效的模型配置（' + from + '=' + clip(s, 80) + '），已忽略'
  if (!warnedModels.has(msg)) {
    warnedModels.add(msg)
    console.warn(msg)
  }
  return null
}

/**
 * 聊天模型（聊天 / 流式 / L2 学习 / L3 自写四个外呼点共用）：
 *   cordis config.model → 本插件 config.json 的 model → 环境变量 CHUBBY_WHALE_MODEL → deepseek-flash。
 * 由 index.ts 在装配时算一次注入各 handler，运行中不再读盘。
 */
export function readChatModel(pluginDir: string, runtimeConfig?: any): string {
  const fromRuntime = parseChatModel(runtimeConfig && runtimeConfig.model, 'cordis config')
  if (fromRuntime) return fromRuntime
  const cfg = readConfigJson(pluginDir)
  const fromFile = parseChatModel(cfg && cfg.model, 'config.json')
  if (fromFile) return fromFile
  const fromEnv = parseChatModel(process.env.CHUBBY_WHALE_MODEL, 'CHUBBY_WHALE_MODEL')
  if (fromEnv) return fromEnv
  return DEFAULT_CHAT_MODEL
}

/** 本插件认识的配置键（未知键只告警、不丢弃，给以后的版本留余地） */
const KNOWN_CONFIG_KEYS = new Set(['enabled', 'dataSource', 'personalityLearning', 'personalityWriting', 'model'])

const warnedConfig = new Set<string>()

function warnConfig(msg: string): void {
  if (warnedConfig.has(msg)) return
  warnedConfig.add(msg)
  console.warn('[chubby-whale] ' + msg)
}

/**
 * 配置清洗（cordis Config schema 与 apply 共用同一份规则）：
 *   · 合法值归一化（dataSource 小写、开关转布尔、model 去空白）；
 *   · 非法值丢弃并 console.warn，绝不抛错——配置笔误不能把插件挡在加载之外；
 *   · 未知键保留但告警，不做静默吞掉。
 * 返回值可直接当作 apply 的 config 使用。
 */
export function sanitizePluginConfig(raw: any): any {
  if (raw == null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnConfig('配置应为对象，已按空配置处理（实际 ' + shapeOf(raw) + '）')
    return {}
  }
  const out: any = {}
  for (const [key, value] of Object.entries(raw)) {
    // 原型链保留字一律拒收（2026-11-07 B74）：`out[key] = value` 对 `__proto__` 会**改掉 out 的原型**，
    // 于是 {"__proto__":{"dataSource":"cloud"}} 这种“未知键”会通过原型链让 config.dataSource 读到 cloud，
    // 甚至让 config.enabled 读到 false —— 配置笔误/恶意键都能把插件静默改状态，与导入侧拒收 __proto__ 同一口径。
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      warnConfig('配置键 ' + key + ' 已忽略（原型链保留字，不允许写入配置对象）')
      continue
    }
    if (key === 'enabled') {
      if (typeof value === 'boolean') out.enabled = value
      else warnConfig('config.enabled 应为布尔值（实际 ' + briefValue(value) + '），已忽略')
      continue
    }
    if (key === 'dataSource') {
      const s = String(value == null ? '' : value).trim().toLowerCase()
      if (s === 'local' || s === 'cloud') out.dataSource = s
      else warnConfig('config.dataSource 只认 local / cloud（实际 ' + briefValue(value) + '），已忽略')
      continue
    }
    if (key === 'personalityLearning' || key === 'personalityWriting') {
      const b = parseSwitchValue(value)
      if (b === null) warnConfig('config.' + key + ' 应为布尔值（实际 ' + briefValue(value) + '），已忽略')
      else out[key] = b
      continue
    }
    if (key === 'model') {
      const m = parseChatModel(value, 'cordis config')
      if (m) out.model = m
      continue
    }
    out[key] = value
    if (!KNOWN_CONFIG_KEYS.has(key)) warnConfig('未知配置键 ' + key + '（已保留，但本版本不读取）')
  }
  return out
}
