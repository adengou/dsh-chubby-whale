/**
 * client/voice/fetch.ts —— 带硬超时的 fetch（从 voice.ts 外提）
 *
 * 设计原则④：所有网络请求都有硬超时（ASR 30s / TTS 20s）。
 * 审计补丁（2026-11-06）：原来 AbortSignal.any 不可用时直接 sig = outer，
 * 超时用的 ctl.abort() 根本没接到 fetch 上 —— 老 Safari（无 AbortSignal.any）上
 * 15s/20s 的硬超时形同虚设。现在降级为“把 outer 的 abort 转发给 ctl”，
 * 两条中断路径（外部停止 / 超时）都保留。
 */

/**
 * 带超时的 fetch。outer（外部 AbortSignal，如“停止说话”）与超时任一触发都会中断请求。
 * @param ms 硬超时毫秒数
 */
export async function fetchWithTimeout(url: string, init: RequestInit, ms: number, outer?: AbortSignal): Promise<Response> {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = ctl ? setTimeout(() => { try { ctl.abort() } catch (e) { } }, ms) : null
  let sig: AbortSignal | undefined = ctl ? ctl.signal : undefined
  const forwardOuter = (): void => { try { if (ctl) ctl.abort() } catch (e) { } }
  let hooked = false
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
    return await fetch(url, sig ? { ...init, signal: sig } : init)
  } finally {
    if (timer) clearTimeout(timer)
    if (hooked) { try { outer.removeEventListener('abort', forwardOuter) } catch (e) { } }
  }
}
