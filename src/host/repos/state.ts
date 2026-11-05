/**
 * host/repos/state.ts —— 亲密度状态仓储（state.json）
 * 从 host/store.ts 拆出；写盘走 host/atomic.ts，读坏文件按 [store] 前缀留痕并备份。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic, isMissingFileError, quarantineFile } from '../atomic.js'

export interface StateRepo {
  loadState(): any
  saveState(obj: any): void
}

export function createStateRepo(dataDir: string): StateRepo {
  const STATE = join(dataDir, 'state.json')

  function loadState(): any {
    try {
      const obj = JSON.parse(readFileSync(STATE, 'utf8'))
      if (obj && typeof obj === 'object') return obj
    } catch (err: any) {
      if (!isMissingFileError(err)) quarantineFile(STATE, err, '[store]')
    }
    return { intimacy: 0 }
  }
  function saveState(obj: any): void {
    try { writeJsonAtomic(STATE, obj) } catch { }
  }

  return { loadState, saveState }
}
