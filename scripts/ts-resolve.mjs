/**
 * scripts/ts-resolve.mjs —— 测试用模块解析钩子：.js 找不到时回退到同名 .ts
 *
 * 为什么需要：源码里跨模块导入写的是编译后的 `.js`（build 产物要求），
 * 但测试直接加载 `.ts` 源码；Node 的类型剥离不会把 `.js` 自动换成 `.ts`，
 * 于是 `import '../shared/immutable.js'` 在测试里就报 MODULE_NOT_FOUND。
 *
 * 这个钩子只在测试进程里注册，不改构建产物、不影响运行时。
 */

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    if (specifier.endsWith('.js')) {
      try {
        return await nextResolve(specifier.slice(0, -3) + '.ts', context)
      } catch { /* 原样抛出下面的错误 */ }
    }
    throw err
  }
}
