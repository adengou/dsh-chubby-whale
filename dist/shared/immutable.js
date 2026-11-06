/**
 * shared/immutable.ts —— 冻结工具（防外部修改内部数据）
 *
 * 用法：`export const CONFIG = {...}` 声明后紧跟 `deepFreeze(CONFIG)`。
 * 冻结后调用方 push/splice/赋值都会在严格模式下报错，等于把可变数据挡在模块外。
 *
 * 边界（2026-11-07 逐项核对，不是想当然）：
 *   · 循环引用 / 同一对象出现多次：用 WeakSet 只走一遍，不会爆栈；
 *   · 父对象已被 Object.freeze、子对象还没冻：照样递归到底
 *     —— 旧实现见"已冻结就 return"，这种父对象会把整棵子树漏掉（本次修的就是这条）；
 *   · 数组 / 普通对象 / Map / Set 的键值元素都递归；普通对象连 symbol 键也走（Reflect.ownKeys）；
 *   · Map/Set 只能"冻结容器 + 冻结里面的键值"：set()/add() 动的是内部槽，
 *     V8 没有钩子拦得住，所以**真正要锁死的容器别导出**，导出冻结的数组/记录更稳；
 *   · TypedArray（带元素）冻结会抛 TypeError，这是 JS 的限制，本函数不吞错、不假装成功。
 */
/** 递归冻结的实体（WeakSet 同时解决"循环引用"和"同一对象重复出现"） */
function freezeInto(value, seen) {
    if (value === null || typeof value !== 'object')
        return value;
    if (seen.has(value))
        return value;
    seen.add(value);
    const tag = Object.prototype.toString.call(value);
    Object.freeze(value);
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++)
            freezeInto(value[i], seen);
    }
    else if (tag === '[object Map]') {
        for (const [k, v] of value) {
            freezeInto(k, seen);
            freezeInto(v, seen);
        }
    }
    else if (tag === '[object Set]') {
        for (const v of value)
            freezeInto(v, seen);
    }
    else if (tag === '[object Object]') {
        for (const k of Reflect.ownKeys(value))
            freezeInto(value[k], seen);
    }
    return value;
}
export function deepFreeze(value) {
    return freezeInto(value, new WeakSet());
}
