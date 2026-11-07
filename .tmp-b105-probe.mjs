/**
 * 临时取证探针（B105，跑完即删，不属于交付物）
 * 证明：改造前 client/http.ts 的 getJson 没有超时预算；打桩 fetch 永不回包时，
 *       getJson 与 chat-route 的 /culture 点播都会一直挂着（界面无失败文案）。
 */
import path from 'node:path'
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import esbuild from 'esbuild'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const TMP = path.join(ROOT, '.tmp-b105-probe-out')
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
const entry = path.join(TMP, 'entry.ts')
writeFileSync(entry, [
  "export * as http from '" + path.join(ROOT, 'src/client/http.ts').replace(/\\/g, '/') + "'",
  "export * as route from '" + path.join(ROOT, 'src/client/chat-route.ts').replace(/\\/g, '/') + "'",
].join('\n'))

const outfile = path.join(TMP, 'bundle.mjs')
await esbuild.build({
  entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node',
  target: 'node22', logLevel: 'silent',
})
const mods = await import(pathToFileURL(outfile).href)

// ---- 打桩：fetch 永不 settle，记录收到什么 init ----
const calls = []
globalThis.fetch = (url, init) => {
  calls.push({ url: String(url), init: init || {} })
  return new Promise(() => { })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const WATCH_MS = 16000

const httpSettled = { state: 'pending' }
const t0 = Date.now()
mods.http.getJson('/culture?type=minsu').then(
  () => { httpSettled.state = 'resolved' },
  (e) => { httpSettled.state = 'rejected:' + String(e && e.name) },
)

const bubbles = []
const host = {
  persona: {}, narrationRate: () => '+0%',
  bubble: (t) => bubbles.push(String(t)),
  say() { }, speak() { }, narrate() { }, clearNarrate() { }, talkFor() { },
  story: { start() { }, next() { }, reset() { }, abort() { }, playPiece() { } },
  storyState: {
    busy: { current: false }, narrating: { current: false },
    auto: { current: false }, book: { current: '' },
  },
}
const router = mods.route.createLocalRouter(host)
const routed = router.route('讲个典故')

await sleep(WATCH_MS)

const elapsed = Date.now() - t0
const failureBubbles = bubbles.filter((b) => /没读到|没取到|失败|稍后/.test(b))
const routeCall = calls.find((c) => c.url.indexOf('/culture') >= 0)
console.log(JSON.stringify({
  watchMs: elapsed,
  now: new Date().toISOString(),
  getJson: {
    settled: httpSettled.state,
    pendingAfterMs: httpSettled.state === 'pending' ? elapsed : 0,
    fetchInit: calls[0] ? { hasSignal: !!calls[0].init.signal, method: calls[0].init.method } : null,
  },
  chatRoute: {
    routed,
    callUrl: routeCall ? routeCall.url : null,
    routeFetchHasSignal: routeCall ? !!routeCall.init.signal : null,
    bubbles,
    failureBubbleCount: failureBubbles.length,
  },
}, null, 2))
rmSync(TMP, { recursive: true, force: true })
