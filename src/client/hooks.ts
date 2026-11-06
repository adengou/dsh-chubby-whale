/**
 * client/hooks.ts —— 组件入口里可复用的 React hooks
 *
 * 从 client.ts 拆出来的两类通用逻辑：
 *   ① useLazyRef：组件里"只建一次"的惰性单例（忙碌锁、语音桥、提醒轮询），
 *      原来每处都写 `useRef(null); if (!ref.current) ref.current = factory()`；
 *   ② usePersistentBool：ref + state 双写的 localStorage 开关（语音朗读、
 *      语音待命、语音聊天三项），ref 给事件回调同步读，state 驱动菜单渲染。
 *
 * 这里不 import react：客户端包把 react 标为 external，由 __ModuleLoader__ 注入。
 * 裸 import 会在浏览器端变成不存在的 require('react')，所以由 createHooks(R) 接收。
 */

export type LazyRef<T> = { current: T }

/** 持久化布尔开关：同时保留 ref（回调同步读）与 state（驱动渲染） */
export type PersistentBool = {
  /** 当前值（state，渲染用） */
  value: boolean
  /** 改值：ref 与 state 一起改 */
  set: (v: boolean) => void
  /** 当前值（ref，回调里同步读，不依赖渲染时机） */
  ref: LazyRef<boolean>
}

/**
 * 读 localStorage 布尔开关：
 *   缺省（键不存在）取 fallback；存 'off' 才是关，其余都算开。
 *   现有实现就是 `getItem(key) !== 'off'`，fallback 只是把"键不存在"的
 *   默认值显式化，调用点行为不变。
 */
export function readLocalFlag(key: string, fallback = true): boolean {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : raw !== 'off'
  } catch (e) { return fallback }
}

export function createHooks(R: any) {
  /**
   * 惰性单例 ref：首次渲染调用 factory，之后始终返回同一个对象。
   * 用独有哨兵而不是 `!ref.current` 判"还没建"：工厂返回 0 / '' / false / null 这类
   * 假值也是合法结果，用真假值判断会每次渲染都重建（契约是"只建一次"）。
   * 注意：React StrictMode 的开发期双渲染会重建 hook 槽，factory 可能被调用两次
   * （第一次实例被丢弃）。三处调用点都是纯构造、不申请监听器/定时器，可安全丢弃；
   * 若将来工厂里申请了资源，需把创建挪进 effect 或自带幂等保护。
   */
  function useLazyRef<T>(factory: () => T): LazyRef<T> {
    const UNSET = {}
    const ref = R.useRef(UNSET)
    if (ref.current === UNSET) ref.current = factory()
    return ref as LazyRef<T>
  }

  /**
   * ref + state 双写的持久化布尔开关：
   *   初值只在挂载时读一次 localStorage（useState 惰性初始化器），后续渲染沿用 state；
   *   set 同时改 ref（回调同步读）、state（渲染）并落盘；
   *   写失败（隐私模式 / 配额满）不回滚，降级为本次会话内生效（读侧同样有兜底）。
   */
  function usePersistentBool(key: string, fallback = true): PersistentBool {
    const ref = R.useRef(null as any)
    const [value, setValue] = R.useState(() => readLocalFlag(key, fallback))
    // 首帧把初值灌进 ref；之后每次渲染保留最新值（set 已同步双写）
    if (ref.current === null) ref.current = value
    const set = (v: boolean): void => {
      const next = !!v
      ref.current = next
      setValue(next)
      // 回滚只会让菜单显示"点了没反应"，反而更难排障：持久化失败时仅本次会话生效
      try { localStorage.setItem(key, next ? 'on' : 'off') } catch (e) { }
    }
    return { value, set, ref }
  }

  return { useLazyRef, usePersistentBool }
}

export type Hooks = ReturnType<typeof createHooks>
