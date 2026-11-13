#!/usr/bin/env node
/**
 * scripts/start-all.mjs —— 一键打通「桌面端 DSH（127.0.0.1:8983）→ 手机版」
 *
 * 背景（2026-11-13 实测）：主人的日常 harness 是**桌面端**，它自带 /whale-mobile/（肥鲸
 * 也装在 profiles/desktop 里），但只绑回环 127.0.0.1。手机要访问，只需在局域网地址上
 * 起一个 TCP 透传，把流量转到桌面端端口——不需要另外跑 `dsh web`。
 *
 * 特性：幂等（已在跑的代理不重复启动）、后台运行、起完打印手机访问地址并自检。
 * 用法：
 *   node scripts/start-all.mjs
 *   （或双击同目录 start-all.cmd）
 *
 * 可覆盖的环境变量：
 *   DSH_TARGET_PORT   桌面端端口（默认 8983）
 *   LAN_PROXY_PORT    手机访问端口（默认 3080）
 */
import net from 'node:net'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TARGET_PORT = Number(process.env.DSH_TARGET_PORT || 8983)
const LAN_PORT = Number(process.env.LAN_PROXY_PORT || 3080)
const PROXY = join(HERE, 'lan-proxy.mjs')

function lanIPv4() {
  const ifaces = os.networkInterfaces()
  for (const list of Object.values(ifaces)) {
    for (const info of list || []) {
      if (info && info.family === 'IPv4' && !info.internal) return info.address
    }
  }
  return '127.0.0.1'
}

/** 端口连通性探测 */
function probe(host, port, timeoutMs = 1200) {
  return new Promise((res) => {
    const sock = net.connect({ host, port, timeout: timeoutMs })
    sock.once('connect', () => { sock.destroy(); res(true) })
    sock.once('timeout', () => { sock.destroy(); res(false) })
    sock.once('error', () => res(false))
  })
}

/** 后台启动（detached，脚本退出后仍运行） */
function launch(cmd, args, env) {
  const child = spawn(cmd, args, {
    cwd: HERE,
    env: Object.assign({}, process.env, env || {}),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    shell: process.platform === 'win32',
  })
  child.unref()
  return child.pid
}

const log = (s) => console.log('[start-all] ' + s)

// ---- 1) 桌面端必须在跑 ----
const desktopUp = await probe('127.0.0.1', TARGET_PORT)
if (!desktopUp) {
  log('❌ 桌面端没在听 127.0.0.1:' + TARGET_PORT + '——请先打开 DeepSeek Harness 桌面端，再运行本脚本')
  process.exit(1)
}
log('桌面端在运行（127.0.0.1:' + TARGET_PORT + '）')

// ---- 2) LAN 代理（局域网 IP → 桌面端）----
const lan = lanIPv4()
if (lan === '127.0.0.1') {
  log('⚠️ 没找到局域网地址，手机无法访问')
  process.exit(1)
}
const lanUp = await probe(lan, LAN_PORT)
if (!lanUp) {
  log('启动 LAN 代理（' + lan + ':' + LAN_PORT + ' → 127.0.0.1:' + TARGET_PORT + '）…')
  launch(process.execPath, [PROXY], {
    LAN_PROXY_LISTEN_PORT: String(LAN_PORT),
    LAN_PROXY_TARGET_PORT: String(TARGET_PORT),
  })
  let ok = false
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500))
    if (await probe(lan, LAN_PORT)) { ok = true; break }
  }
  if (!ok) {
    log('⚠️ LAN 代理 10 秒内没起来（端口可能被占用）')
    process.exit(1)
  }
} else {
  log('LAN 代理已在运行（' + lan + ':' + LAN_PORT + '），跳过')
}

// ---- 3) 自检 ----
const url = 'http://' + lan + ':' + LAN_PORT + '/whale-mobile/'
console.log('')
console.log('── 当前状态 ──')
console.log('  桌面端   127.0.0.1:' + TARGET_PORT)
console.log('  手机入口 ' + lan + ':' + LAN_PORT + ' → 桌面端')
try {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
  const body = await r.text()
  console.log('  手机版自检：HTTP ' + r.status + '（' + body.length + ' B）')
  console.log('')
  console.log('手机浏览器打开：' + url)
} catch (e) {
  console.log('  手机版自检失败：' + String(e && e.message || e))
}
