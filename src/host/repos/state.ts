/**
 * host/repos/state.ts —— 亲密度状态仓储（state.json）
 * 从 host/store.ts 拆出；写盘走 host/atomic.ts，读坏文件按 [store] 前缀留痕并备份。
 * 读入容错 UTF-8 BOM，写出统一 UTF-8 无 BOM。
 */
import { join } from 'node:path'
import { writeJsonAtomic, isMissingFileError, quarantineFile, readTextNoBom } from '../atomic.js'

export interface StateRepo {
  loadState(): any
  saveState(obj: any): void
}

export function createStateRepo(dataDir: string): StateRepo {
  const STATE = join(dataDir, 'state.json')

  function loadState(): any {
    try {
      const obj = JSON.parse(readTextNoBom(STATE))
      if (obj && typeof obj === 'object') return obj
    } catch (err: any) {
      if (!isMissingFileError(err)) quarantineFile(STATE, err, '[store]')
    }
    return { intimacy: 0 }
  }
  function saveState(obj: any): void {
    try { writeJsonAtomic(STATE, obj) } catch (err: any) { console.error('[store] WRITE-FAIL ' + String(STATE) + ' err=' + String(err?.message || err)) }
  }

  return { loadState, saveState }
}
