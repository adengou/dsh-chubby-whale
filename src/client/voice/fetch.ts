/**
 * client/voice/fetch.ts —— 带硬超时的 fetch（从 voice.ts 外提）
 *
 * 设计原则④：所有网络请求都有硬超时（ASR 30s / TTS 20s）。
 * 审计补丁（2026-11-06）：原来 AbortSignal.any 不可用时直接 sig = outer，
 * 超时用的 ctl.abort() 根本没接到 fetch 上 —— 老 Safari（无 AbortSignal.any）上
 * 15s/20s 的硬超时形同虚设。现在降级为“把 outer 的 abort 转发给 ctl”，
 * 两条中断路径（外部停止 / 超时）都保留。
 *
 * 审计补丁（2026-11-07）：上面两条只覆盖到「响应头回来」为止 —— fetch() 一 resolve
 * 就 clearTimeout / 摘监听，而调用方随后才 `res.json()` / `res.arrayBuffer()`
 * （voice.ts 的 ASR 与 TTS 都是这个顺序）。服务端发完头就卡住时，响应体读取
 * **没有任何超时**，`stopSpeaking()` 也打断不了它。现在的做法：
 *   · 定时器活到 ms 到点，不再在 finally 里清掉（到点 abort 对已结束的请求是空操作）；
 *   · 降级路径的 outer→ctl 转发监听同样保留（{once:true}，只会响一次），
 *     这样 body 阶段点「停止说话」仍能打断；
 *   · 请求本身失败（超时/中断/网络错）时立刻收尾，不留无用的定时器与监听；
 *   · 成功返回后给定时器 unref：body 读取自己有句柄，别让这个兜底定时器把 Node 进程拴住。
 * 刻意不做的事：不读/不包装响应体，原样返回 fetch 的 Response
 * （调用方要的是 Response 本身，verify-voice 的桩 fetch 返回的还是普通对象）。
 */

/**
 * 带超时的 fetch。outer（外部 AbortSignal，如“停止说话”）与超时任一触发都会中断请求。
 * 超时从发起请求算起，**包含响应体读取**（见文件头 2026-11-07）。
 * @param ms 硬超时毫秒数
 */
export async function fetchWithTimeout(url: string, init: RequestInit, ms: number, outer?: AbortSignal): Promise<Response> {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null
  const forwardOuter = (): void => { try { if (ctl) ctl.abort() } catch (e) { } }
  let hooked = false
  /** 摘掉降级路径挂在外部的转发监听（只挂过一次；Any 路径没有这个监听） */
  const unhook = (): void => {
    if (!hooked) return
    hooked = false
    try { if (outer) outer.removeEventListener('abort', forwardOuter) } catch (e) { }
  }
  // 定时器一直活到 ms 到点（不在 fetch resolve 时清）：超时要能盖住响应体读取
  const timer = ctl ? setTimeout(() => { unhook(); try { ctl.abort() } catch (e) { } }, ms) : null
  let sig: AbortSignal | undefined = ctl ? ctl.signal : undefined
  if (outer && ctl) {
    const AnySig: any = (AbortSignal as any)
    if (typeof AnySig.any === 'function') {
      try { sig = AnySig.any([ctl.signal, outer]) } catch (e) { sig = ctl.signal }
    } else {
      try {
        if (outer.aborted) forwardOuter()
        else { outer.addEventListener('abort', forwardOuter, { once: true }); hooked = true }
      } catch (e) { }
      sig = ctl.signal
    }
  } else if (!ctl && outer) {
    sig = outer
  }
  try {
    const resp = await fetch(url, sig ? { ...init, signal: sig } : init)
    // 进入响应体阶段：定时器继续守着，但别再拴住 Node 的事件循环（浏览器里 unref 不存在）
    try { if (timer && typeof (timer as any).unref === 'function') (timer as any).unref() } catch (e) { }
    return resp
  } catch (e) {
    // 请求本身失败：没有响应体要守了，立刻收掉定时器与转发监听
    unhook()
    if (timer) { try { clearTimeout(timer) } catch (e2) { } }
    throw e
  }
}
