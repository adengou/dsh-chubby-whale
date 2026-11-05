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
import type { DataSourceKind } from './ports.js'

function readConfigJson(pluginDir: string): any {
  try { return JSON.parse(readFileSync(join(pluginDir, 'config.json'), 'utf8')) } catch { return null }
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
  if (cfg && typeof cfg.deepseekKey === 'string' && cfg.deepseekKey.trim()) return cfg.deepseekKey.trim()
  return fromEnv('CHUBBY_WHALE_DEEPSEEK_KEY', 'DEEPSEEK_API_KEY')
}

/** 硅基流动 Key（语音识别） */
export function readSiliconFlowKey(pluginDir: string): string {
  const cfg = readConfigJson(pluginDir)
  if (cfg && typeof cfg.siliconflowKey === 'string' && cfg.siliconflowKey.trim()) return cfg.siliconflowKey.trim()
  return fromEnv('CHUBBY_WHALE_SILICONFLOW_KEY', 'SILICONFLOW_API_KEY')
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
  const msg = '[chubby-whale] 无效的数据源配置（' + from + '=' + String(raw) + '），按 local 处理'
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
 * L2 可变人格学习开关：默认开启。
 * 优先级：cordis config.personalityLearning → 本插件 config.json 的 personalityLearning → true。
 * 只认明确的布尔值或 true/false/on/off/1/0/yes/no（大小写、空白不敏感）；
 * 认不出的值按“未配置”处理（继续看下一层），绝不因为配置笔误把学习弄成意外状态。
 */
export function readPersonalityLearning(pluginDir: string, runtimeConfig?: any): boolean {
  const parse = (raw: any): boolean | null => {
    if (raw === undefined || raw === null || raw === '') return null
    if (typeof raw === 'boolean') return raw
    const s = String(raw).trim().toLowerCase()
    if (s === 'false' || s === 'off' || s === '0' || s === 'no' || s === 'disabled') return false
    if (s === 'true' || s === 'on' || s === '1' || s === 'yes' || s === 'enabled') return true
    return null
  }
  const fromRuntime = parse(runtimeConfig && runtimeConfig.personalityLearning)
  if (fromRuntime !== null) return fromRuntime
  const cfg = readConfigJson(pluginDir)
  const fromFile = parse(cfg && cfg.personalityLearning)
  if (fromFile !== null) return fromFile
  return true
}
