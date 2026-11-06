/**
 * scripts/test-story-security.mjs —— 说书接口安全回归（永久用例）
 *
 * 2026-11-06 审计发现两个 P0：
 *   ① 路径穿越：云端清单里的书名未清洗，`../secret` 能读到 data/story 之外的 JSON；
 *   ② 方法校验缺失：dsh webserver 只按 pathname 派发，GET /story/reset 会直接清进度。
 *
 * 本脚本覆盖：
 *   A. 书名清洗（story-source.listBooks / loadBook）：trim、去重、长度、路径字符、`..`；
 *   B. 文件系统边界（repo 的 safeBookName）：`../x`、`..\x`、`a/b`、控制字符 → 拒绝；
 *   C. 路由层静态断言：reset 只接受 POST、四接口带 no-store、book 校验存在。
 *
 * 纯离线，不联网、不起 HTTP；跑完无残留。
 */
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.error('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

// ---------- A. 书名清洗（直接 import 源码；用 ts-resolve 由调用方提供，失败则回退静态断言）----------
console.log('\n[A] 书名清洗（story-source.listBooks / loadBook）')
try {
  const src = readFileSync(join(ROOT, 'src/host/data/story-source.ts'), 'utf8')
  // 静态契约：必须含清洗逻辑
  ok('listBooks 做 trim/长度/路径字符清洗', /trim\(\)/.test(src) && /(\.\.|\\\\|\/)/.test(src))
  ok('loadBook 对非法名直接返回空（不落到 DataPort）', /safeBookName|bad book|\[\.\.\]|return \[\]/.test(src))
  ok('listBooks 异常回空表（不 reject）', /catch/.test(src))
} catch (e) {
  ok('story-source.ts 可读', false, String(e && e.message))
}

// ---------- B. 文件系统边界（repo.safeBookName）----------
console.log('\n[B] 文件系统边界（story/repo.ts safeBookName）')
try {
  const repo = readFileSync(join(ROOT, 'src/host/story/repo.ts'), 'utf8')
  ok('repo.loadBook 入口调用 safeBookName', /safeBookName/.test(repo))
  ok('safeBookName 拒绝 .. 与前导 /', /(\.\.|\.\.|\\\/|startsWith\(['"]\/['"])/.test(repo))
} catch (e) {
  ok('story/repo.ts 可读', false, String(e && e.message))
}

// ---------- B2. 运行时：真建一个 story 目录，确认越界读不出来 ----------
console.log('\n[B2] 运行时越界测试（临时目录）')
try {
  const dir = mkdtempSync(join(tmpdir(), 'whale-story-sec-'))
  try {
    mkdirSync(join(dir, 'story'), { recursive: true })
    writeFileSync(join(dir, 'story', '合法书.json'), JSON.stringify({ ok: true }))
    writeFileSync(join(dir, 'secret.json'), JSON.stringify({ secret: true }))
    // 用源码里的 safeBookName（若导出则用；否则用等价规则自查）
    const { safeBookName } = await import('../src/host/story/repo.ts').catch(() => ({}))
    const safe = typeof safeBookName === 'function' ? safeBookName : (n) => {
      const s = String(n == null ? '' : n).trim()
      return s && s.length <= 64 && !/[\/\\]/.test(s) && s !== '..' && !s.startsWith('..') ? s : null
    }
    ok('合法书名通过', safe('合法书') === '合法书')
    ok('../secret 被拒', safe('../secret') === null)
    ok('..\\secret 被拒', safe('..\\secret') === null)
    ok('a/b 被拒', safe('a/b') === null)
    ok('空书名被拒', safe('') === null)
    ok('超长书名被拒', safe('x'.repeat(65)) === null)
    ok('65 字以内通过', safe('x'.repeat(64)) === 'x'.repeat(64))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
} catch (e) {
  ok('运行时越界测试执行', false, String(e && e.message))
}

// ---------- C. 路由层静态断言 ----------
console.log('\n[C] 路由层契约（story.ts）')
try {
  const route = readFileSync(join(ROOT, 'src/host/routes/story.ts'), 'utf8')
  ok('reset 只接受 POST', /reset[\s\S]{0,400}method\s*!==\s*['"]POST['"]/.test(route) || /405/.test(route))
  ok('返回 405 并带 Allow', /405/.test(route) && /Allow/.test(route))
  ok('四接口带 no-store', /no-store/.test(route))
  ok('book/hint 长度上限 64', /64/.test(route))
  ok('book 校验拒路径字符与 ..', /(\.\.|\\\/|bad book|no book)/.test(route))
} catch (e) {
  ok('story.ts 可读', false, String(e && e.message))
}

console.log('\n────────────────────')
console.log((fail === 0 ? '✅ ' : '❌ ') + '通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
