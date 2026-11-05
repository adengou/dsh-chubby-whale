/**
 * host/atomic.ts —— 文件原子写与坏文件隔离（可复用）
 *
 * 用途：store / 说书进度 / 文化去重 / 念诗去重都曾各自手写一份「唯一临时名 + rename」，
 * 这里是唯一实现：写 .tmp → fsync → rename 覆盖，失败清掉临时文件。
 * 读坏文件统一「改名成 .bad-<时间戳> 备份 + 记日志」，调用方随后走默认值。
 */
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

/** 原子写文本/Buffer：先建父目录，写唯一临时文件，fsync 后 rename 覆盖 */
export function writeFileAtomic(file: string, data: string | Buffer): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp'
  const fd = openSync(tmp, 'w')
  try {
    if (typeof data === 'string') writeFileSync(fd, data, 'utf8')
    else writeFileSync(fd, data)
    try { fsyncSync(fd) } catch { }        // 个别文件系统不支持 fsync，失败不当错误
  } finally {
    try { closeSync(fd) } catch { }
  }
  try {
    renameSync(tmp, file)
  } catch (err: any) {
    try { unlinkSync(tmp) } catch { }      // 改名失败别留垃圾
    throw err
  }
}

/** 原子写 JSON（序列化后走字符串版本） */
export function writeJsonAtomic(file: string, obj: unknown): void {
  writeFileAtomic(file, JSON.stringify(obj))
}

/** 文件不存在（首次运行）不算坏文件 */
export function isMissingFileError(err: any): boolean {
  return Boolean(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'))
}

/**
 * 读坏了：记日志 + 把坏文件改名成 file.bad-<时间戳> 备份，然后调用方走默认值。
 * 只备份一次——改完名下次读就是 ENOENT，不会再重复备份。
 * tag 只用于日志前缀（与各模块原有日志保持一致）。
 */
export function quarantineFile(file: string, err: any, tag = '[file]'): void {
  console.error(tag + ' 读取失败 file=' + file + ' err=' + String((err && err.message) || err))
  try {
    if (!existsSync(file)) return
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const bad = file + '.bad-' + stamp
    renameSync(file, bad)
    console.error(tag + ' 坏文件已备份 ' + file + ' → ' + bad)
  } catch (err2: any) {
    console.error(tag + ' 坏文件备份失败 file=' + file + ' err=' + String((err2 && err2.message) || err2))
  }
}
