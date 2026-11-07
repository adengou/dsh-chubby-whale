#!/usr/bin/env node
/**
 * 局域网透传（通用版）：把 dsh 的回环端口映射到本机的局域网地址，
 * 让手机等其它设备能访问 /whale-mobile/，同时电脑端继续用 127.0.0.1（安全上下文、麦克风可用）。
 *
 * 为什么需要：dsh web 只能绑一个地址；绑局域网 IP 会让电脑上的 http 页面变成
 * “非安全上下文”，浏览器随即禁用麦克风（桌宠语音待命/喊名字失效）。
 *
 * 用法：
 *   node scripts/lan-proxy.mjs
 *   LAN_PROXY_LISTEN_HOST=192.168.1.6 LAN_PROXY_LISTEN_PORT=3080 node scripts/lan-proxy.mjs
 *
 * 环境变量：
 *   LAN_PROXY_LISTEN_HOST  监听的局域网地址（默认自动取第一块非回环 IPv4）
 *   LAN_PROXY_LISTEN_PORT  监听端口（默认 3080）
 *   LAN_PROXY_TARGET_HOST  目标地址（默认 127.0.0.1）
 *   LAN_PROXY_TARGET_PORT  目标端口（默认 3080）
 *
 * 只搬运 TCP 字节，不解析、不记录内容。它把内网里的 dsh 暴露给同一网段的设备，
 * 请只在可信网络里运行；需要鉴权时给插件配 token。
 */
import net from 'node:net'
import os from 'node:os'

function firstLanIPv4() {
  const ifaces = os.networkInterfaces()
  for (const list of Object.values(ifaces)) {
    for (const info of list || []) {
      if (info && info.family === 'IPv4' && !info.internal) return info.address
    }
  }
  return '127.0.0.1'
}

const LISTEN_HOST = process.env.LAN_PROXY_LISTEN_HOST || firstLanIPv4()
const LISTEN_PORT = Number(process.env.LAN_PROXY_LISTEN_PORT || 3080)
const TARGET_HOST = process.env.LAN_PROXY_TARGET_HOST || '127.0.0.1'
const TARGET_PORT = Number(process.env.LAN_PROXY_TARGET_PORT || 3080)

if (LISTEN_HOST === '127.0.0.1') {
  console.warn('[lan-proxy] 没找到局域网地址，监听到回环；手机将无法访问')
}

const server = net.createServer((client) => {
  const upstream = net.connect(TARGET_PORT, TARGET_HOST)
  const closeBoth = () => {
    client.destroy()
    upstream.destroy()
  }
  client.on('error', closeBoth)
  upstream.on('error', closeBoth)
  client.pipe(upstream)
  upstream.pipe(client)
})

server.on('error', (err) => {
  console.error('[lan-proxy] 监听失败：' + err.message)
  if (err.code === 'EADDRINUSE') {
    console.error('[lan-proxy] 端口被占用：先确认 dsh 只监听 127.0.0.1，或换 LAN_PROXY_LISTEN_PORT')
  }
  process.exit(1)
})

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`[lan-proxy] http://${LISTEN_HOST}:${LISTEN_PORT}/ → http://${TARGET_HOST}:${TARGET_PORT}/`)
  console.log('[lan-proxy] 电脑端继续用 http://127.0.0.1:' + TARGET_PORT + '（保麦克风）；Ctrl+C 退出')
})
