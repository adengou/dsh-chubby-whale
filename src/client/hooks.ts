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
  /** 惰性单例 ref：首次渲染调用 factory，之后始终返回同一个对象 */
  function useLazyRef<T>(factory: () => T): LazyRef<T> {
    const ref = R.useRef(null as any)
    if (!ref.current) ref.current = factory()
    return ref as LazyRef<T>
  }

  /** ref + state 双写的持久化布尔开关；初值在首次渲染时读一次 localStorage */
  function usePersistentBool(key: string, fallback = true): PersistentBool {
    const initial = readLocalFlag(key, fallback)
    const ref = R.useRef(initial)
    const [value, setValue] = R.useState(initial)
    const set = (v: boolean): void => {
      ref.current = v
      setValue(v)
    }
    return { value, set, ref }
  }

  return { useLazyRef, usePersistentBool }
}

export type Hooks = ReturnType<typeof createHooks>
