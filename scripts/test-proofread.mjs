/**
 * scripts/test-proofread.mjs —— /proofread 路由回归（离线）
 *
 * 覆盖入口校验与一次成功/一次上游失败：不联网、不落盘，fetchJson 依赖的
 * 全局 fetch 在用例里换成桩，测完立刻换回。
 *
 * 用法：node scripts/test-proofread.mjs（失败退出码 1）
 */

import { register } from 'node:module'

register(new URL('./ts-resolve.mjs', import.meta.url))

const { createProofreadHandler } = await import('../src/host/routes/proofread.ts')

function mkReq(body) {
  const buf = Buffer.from(JSON.stringify(body))
  return {
    method: 'POST',
    url: '/api/chubby-whale/proofread',
    headers: {},
    destroy() { },
    on() { },
    resume() { },
    async *[Symbol.asyncIterator]() { yield buf },
  }
}

function mkJsonRes() {
  const res = { code: 0, chunks: [] }
  res.writeHead = (code) => { res.code = code }
  res.write = (chunk) => { res.chunks.push(Buffer.from(String(chunk))); return true }
  res.end = (chunk) => { if (chunk !== undefined) res.chunks.push(Buffer.from(String(chunk))) }
  res.body = () => Buffer.concat(res.chunks).toString('utf8')
  res.json = () => JSON.parse(res.body())
  return res
}

let failed = 0
function check(name, cond, extra = '') {
  if (cond) console.log('ok   ' + name)
  else { failed++; console.error('FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

const KEYED = { key: () => 'sk-test', model: 'deepseek-flash' }

// 1) 空文本 → 400
{
  const h = createProofreadHandler(KEYED)
  const res = mkJsonRes()
  await h(mkReq({ text: '   ' }), res)
  check('空文本回 400', res.code === 400, res.body())
}

// 2) 超长 → 413
{
  const h = createProofreadHandler(KEYED)
  const res = mkJsonRes()
  await h(mkReq({ text: '字'.repeat(8001) }), res)
  check('超长回 413', res.code === 413, res.body())
}

// 3) 没配 Key → 503
{
  const h = createProofreadHandler({ key: () => '', model: 'deepseek-flash' })
  const res = mkJsonRes()
  await h(mkReq({ text: '这是一段要校对的文字。' }), res)
  check('没 Key 回 503', res.code === 503, res.body())
}

// 4) 正常外呼（桩 fetch）→ ok + result
{
  const realFetch = globalThis.fetch
  let called = 0
  globalThis.fetch = async () => {
    called++
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: '- [标点] 示例 → 句末应为句号。' } }] }),
    }
  }
  try {
    const h = createProofreadHandler(KEYED)
    const res = mkJsonRes()
    await h(mkReq({ text: '这是一段要校对的文字。' }), res)
    const j = res.json()
    check('正常外呼回 200 + ok', res.code === 200 && j.ok === true, res.body())
    check('结果原样带回', typeof j.result === 'string' && j.result.indexOf('标点') >= 0, res.body())
    check('只外呼一次', called === 1, 'called=' + called)
  } finally {
    globalThis.fetch = realFetch
  }
}

// 5) 上游非 2xx → 502
{
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' })
  try {
    const h = createProofreadHandler(KEYED)
    const res = mkJsonRes()
    await h(mkReq({ text: '这是一段要校对的文字。' }), res)
    check('上游 5xx 回 502', res.code === 502, res.body())
  } finally {
    globalThis.fetch = realFetch
  }
}

if (failed) {
  console.error('失败 ' + failed + ' 项')
  process.exit(1)
}
console.log('全部通过')
