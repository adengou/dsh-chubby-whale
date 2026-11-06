import { deepFreeze } from '../shared/immutable.js'

/**
 * client/endpoint.ts —— 端点检测模式（APE / 经典）的唯一读写入口
 *
 * 以前 voice.ts 和 actions/voice.ts 各写一份解析与写盘逻辑：
 *   · 两处都把"等于 ape 才是 ape，其它一律 classic"抄了一遍
 *   · actions 里既写 localStorage 又调实例，voice 里再写一次
 * 口径一旦不一致，"菜单显示的模式"和"实际生效的模式"就会分叉。
 * 这里收成一个模块：读、写、归一化都只此一份。
 */

export type EndpointMode = 'ape' | 'classic'

/** 允许的模式（菜单/自检共用） */
export const ENDPOINT_MODES: EndpointMode[] = ['ape', 'classic']
deepFreeze(ENDPOINT_MODES)

export const DEFAULT_ENDPOINT_MODE: EndpointMode = 'classic'

/** 任何输入 → 合法模式（非法值一律回落默认 classic） */
export function normalizeEndpointMode(v: unknown): EndpointMode {
  return String(v || '').trim() === 'ape' ? 'ape' : DEFAULT_ENDPOINT_MODE
}

/** 读当前模式（localStorage 不可用时回落默认） */
export function readEndpointMode(): EndpointMode {
  try {
    return normalizeEndpointMode(localStorage.getItem('chubby-endpoint'))
  } catch (e) {
    return DEFAULT_ENDPOINT_MODE
  }
}

/** 写当前模式；写失败返回 false（不影响调用方继续用内存里的值） */
export function writeEndpointMode(m: EndpointMode): boolean {
  try {
    localStorage.setItem('chubby-endpoint', normalizeEndpointMode(m))
    return true
  } catch (e) {
    return false
  }
}
