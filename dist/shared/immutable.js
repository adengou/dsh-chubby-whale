/**
 * shared/immutable.ts —— 冻结工具（防外部修改内部数据）
 *
 * 用法：`export const CONFIG = {...}` 声明后紧跟 `deepFreeze(CONFIG)`。
 * 冻结后调用方 push/splice/赋值都会在严格模式下报错，等于把可变数据挡在模块外。
 */
export function deepFreeze(value) {
    if (value === null || typeof value !== 'object')
        return value;
    const obj = value;
    if (Object.isFrozen(obj))
        return value;
    Object.freeze(obj);
    // 只在还能安全枚举时递归（数组/普通对象；函数与 RegExp 直接跳过）
    if (Array.isArray(obj)) {
        for (const v of obj)
            deepFreeze(v);
    }
    else if (Object.prototype.toString.call(obj) === '[object Object]') {
        for (const k of Object.keys(obj))
            deepFreeze(obj[k]);
    }
    return value;
}
