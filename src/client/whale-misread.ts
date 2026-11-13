/**
 * client/whale-misread.ts —— 鲸鱼式误读（文件拖给肥鲸时，她只用鲸鱼生态说一句）
 *
 * 目的不是提供技术帮助，而是换掉人和问题之间的情绪关系：
 * 代码是绕晕的鱼、JSON 是珊瑚礁、日志是一锅海带汤……她本来也不需要看懂。
 *
 * 契约：
 *   ① 只按扩展名分 6 类（code / data / doc / log / image / other），扩展名大小写不敏感；
 *   ② 每类 3–5 条固定文案（纯数据），用**文件名哈希**选一条——同一文件永远同一句，
 *      不用 Math.random、不看时间、不看目录；
 *   ③ head（正文开头）只当极轻的线索：出现 error / 失败 / 错误 时补一句「焦味」，
 *      出现 TODO 时补一句「没铺好的沙」。它不是总结，绝不提行号，也绝不写「你写了……」；
 *   ④ 非法输入（hint 为 null、name 缺失 / 空 / 非字符串）返回 null，不抛错；
 *   ⑤ 纯函数、零 import：不碰 document / window / localStorage / 网络，也不读文件内容。
 *
 * sizeBytes 有意不参与选句：文件大小不该改变她说话的分寸，也不该变成一句评价。
 */

export type FileHint = { name: string; sizeBytes?: number; head?: string }

export type Misread = {
  text: string
  kind: 'code' | 'data' | 'doc' | 'log' | 'image' | 'other'
}

/** 分类别名：只在模块内部用，不作为对外接口 */
type Kind = Misread['kind']

/** 扩展名（小写、含点）→ 分类；没列出来的都落到 other */
const KIND_BY_EXT: Readonly<Record<string, Kind>> = Object.freeze({
  '.ts': 'code',
  '.tsx': 'code',
  '.js': 'code',
  '.jsx': 'code',
  '.mjs': 'code',
  '.cjs': 'code',
  '.py': 'code',
  '.java': 'code',
  '.go': 'code',
  '.rs': 'code',
  '.json': 'data',
  '.yaml': 'data',
  '.yml': 'data',
  '.toml': 'data',
  '.csv': 'data',
  '.md': 'doc',
  '.txt': 'doc',
  '.docx': 'doc',
  '.log': 'log',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.svg': 'image',
})

/**
 * 文案池：纯数据，每类 4 条（规格上限 5、下限 3）。
 * 每条 1 句、短，只描述「像什么」，不描述文件里有什么。
 */
const POOLS: Readonly<Record<Kind, readonly string[]>> = Object.freeze({
  code: Object.freeze([
    '像一条把自己绕晕的鱼，咕噜咕噜吐着泡泡。',
    '像一片缠在一起的海藻，理不清哪根是哪根。',
    '像一群小鱼在珊瑚缝里钻来钻去，热闹得没个队形。',
    '像海沟深处绕来绕去的暗流，本鲸只敢远远看。',
  ]),
  data: Object.freeze([
    '像一整片珊瑚礁，密密麻麻，本鲸只认得颜色。',
    '像退潮后留在沙滩上的贝壳，一颗一颗数不完。',
    '像鲸群迁徙的路线，本鲸只敢顺着泡泡走。',
    '像渔市清晨的账本，热闹、密实，本鲸看着就饱了。',
  ]),
  doc: Object.freeze([
    '像一片很安静的浅滩，字句都泡在潮水里，慢慢晃。',
    '像鲸歌拖长的尾音，本鲸听着听着就走神了。',
    '像晒在礁石上的鱼干，一页一页摊开，海风翻得慢。',
    '像一封被海水泡软的信，本鲸只摸到气泡。',
  ]),
  log: Object.freeze([
    '像一锅熬了很久的海带汤，咕噜咕噜，稠得搅不动。',
    '像鲸群一路留下的气泡，一串接一串，前头的早散了。',
    '像潮汐退去后的滩涂，密密麻麻都是小洞，本鲸懒得数。',
    '像海底火山在远处冒烟，本鲸只听见咕噜声。',
  ]),
  image: Object.freeze([
    '像一尾停在珊瑚上的小鱼，本鲸想凑近看看，又怕惊着它。',
    '像海面上碎掉的一片月光，亮晶晶的，捞不起来。',
    '像鲸眼里的那口深蓝，本鲸先眯起眼感受一下。',
    '像一张被浪打湿的明信片，颜色还在，边缘软了。',
  ]),
  other: Object.freeze([
    '像从别的海域漂来的漂流瓶，本鲸不认得上面的字。',
    '像一块没见过的贝壳，本鲸拿尾巴拨了两下，先放着。',
    '这格式本鲸没见过，像深海里没名字的小东西，先吐个泡泡。',
    '像一枚沉在沙里的旧硬币，本鲸不知道它从哪片海来。',
  ]),
})

/** 取文件名最后一段：调用方传完整路径也认（Windows 反斜杠 / POSIX 斜杠） */
function baseName(name: string): string {
  const cut = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  return cut >= 0 ? name.slice(cut + 1) : name
}

/** 扩展名（含点、转小写）；点开头的 .gitignore 和没有点的 README 都算无扩展名 */
function extOf(base: string): string {
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot).toLowerCase() : ''
}

/**
 * FNV-1a 32 位哈希：确定性、零依赖，不用 Math.random。
 * 只用**文件名**（不含目录、忽略大小写），所以同一个文件从不同入口拖进来会得到同一句。
 */
function hashName(name: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * head 里只认这两个很轻的信号，命中才补一句；不做总结、不推断内容。
 * 错误优先于 TODO：一团焦味盖过几处没铺好的沙。
 */
function headCue(head: string): string {
  const h = head.slice(0, 400).toLowerCase()
  if (/error|失败|错误/.test(h)) return '本鲸闻到一点焦味。'
  if (/todo/.test(h)) return '还有几处没铺好的沙。'
  return ''
}

/**
 * 误读一个文件。
 *
 * @param hint 文件名（必填，可带路径）；可选 sizeBytes（本函数不用）与 head（正文开头）。
 *             非法输入返回 null，绝不抛错。
 * @returns { text, kind }：text 是一句鲸鱼比喻，kind 是 6 类之一；同一文件结果确定。
 */
export function misreadFile(hint: FileHint): Misread | null {
  if (!hint || typeof hint !== 'object') return null
  const rawName = (hint as { name?: unknown }).name
  if (typeof rawName !== 'string') return null
  const name = rawName.trim()
  if (!name) return null
  const base = baseName(name)
  // 只剩路径分隔符（如 "/" 或 "\\"）不算有文件名
  if (!base) return null

  const kind: Kind = KIND_BY_EXT[extOf(base)] || 'other'
  const pool = POOLS[kind]
  const text = pool[hashName(base.toLowerCase()) % pool.length]

  const rawHead = (hint as { head?: unknown }).head
  const cue = typeof rawHead === 'string' ? headCue(rawHead) : ''
  return { text: cue ? text + cue : text, kind }
}
