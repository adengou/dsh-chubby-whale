// @ts-nocheck
/**
 * 静态资源托管（http/static.js）
 *
 * 只服务插件自带的 mobile/ 目录：按请求路径解析后必须仍在根目录内（防目录穿越），
 * 未知扩展一律按 application/octet-stream 返回。
 */
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

export function createStatic({ root, logger = console }) {
  const rootDir = resolve(root)

  function insideRoot(target) {
    return target === rootDir || target.startsWith(rootDir + sep)
  }

  /** @returns {Promise<boolean>} 是否已经把响应写出去 */
  async function serve(res, urlPath, { index = false } = {}) {
    const clean = decodeURIComponent(urlPath.split('?')[0] || '/')
    const relative = index ? 'index.html' : clean.replace(/^\/+/, '')
    if (!relative || relative.includes('\0')) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
      return true
    }
    const target = resolve(rootDir, relative)
    if (!insideRoot(target) || target === rootDir) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Forbidden')
      return true
    }

    let info
    try {
      info = await stat(target)
    } catch {
      return false
    }
    if (!info.isFile()) return false

    try {
      const body = await readFile(target)
      const type = MIME[extname(target).toLowerCase()] || 'application/octet-stream'
      res.writeHead(200, {
        'content-type': type,
        'content-length': String(body.length),
        'cache-control': type.startsWith('text/html') ? 'no-store' : 'public, max-age=60',
        'x-content-type-options': 'nosniff',
      })
      res.end(body)
      return true
    } catch (err) {
      logger.warn?.(`[whale-mobile] 静态文件读取失败 ${relative}: ${err.message}`)
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Internal Error')
      return true
    }
  }

  return Object.freeze({ serve, root: () => rootDir })
}
