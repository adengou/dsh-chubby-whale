/**
 * host/data/story-source.ts —— 把 DataPort 投影成说书播放器需要的窄接口
 *
 * player.ts 只认 StoryRepo（listBooks/loadBook），不关心数据来自本地还是云端；
 * 这里做一层两行的适配，故事选段/进度/连播逻辑完全不用改。
 *
 * 2026-11-06 审计补：书单是「外部数据」——云端 story/index.json 由网络下发，
 * 书名可能重复、带空格、甚至带路径片段。这里统一清洗后再交给 repo：
 *   · trim、去重、限长、挡掉路径分隔符/控制字符/`..`（否则云端书名会流到 local 的 join() 里读盘）；
 *   · listBooks 异常回空表、loadBook 异常回空数组（StoryRepo 契约：坏书绝不拖垮整轮播放）。
 */
import type { DataPort } from '../ports.js'
import type { StoryChunk, StoryRepo } from '../story/repo.js'

/** 书名上限：与路由层一致（最长书名 4 字，64 已留余量） */
const MAX_BOOK_LEN = 64
/** 书单条数上限：正常 17 本；云端清单被写坏时也不至于让播放器空转上万次 */
const MAX_BOOKS = 200
/** 书名里不允许出现：路径分隔符、控制字符、上跳片段（`..`） */
const BAD_BOOK_RE = /[\\/\u0000-\u001F\u007F]|\.\./

/** 清洗单个书名；不可用返回空串 */
function cleanBookName(raw: any): string {
  const name = String(raw == null ? '' : raw).trim()
  if (!name || name.length > MAX_BOOK_LEN) return ''
  if (BAD_BOOK_RE.test(name)) return ''
  return name
}

/** 日志里的外部输入：截断 + 去掉换行，别让一次坏请求写出几千字的日志行或伪造日志 */
function logSafe(raw: any): string {
  return String(raw == null ? '' : raw).slice(0, 80).replace(/[\r\n]/g, ' ')
}

export function createStorySource(port: DataPort): StoryRepo {
  return {
    listBooks: async (): Promise<string[]> => {
      let books: any
      try {
        books = await port.readStoryIndex()
      } catch (err: any) {
        console.error('STORY-INDEX-FAIL err=' + String(err?.message || err))
        return []
      }
      const out: string[] = []
      const seen = new Set<string>()
      for (const b of Array.isArray(books) ? books : []) {
        const name = cleanBookName(b && b.book)
        if (!name || seen.has(name)) continue
        seen.add(name)
        out.push(name)
        if (out.length >= MAX_BOOKS) break
      }
      return out
    },
    loadBook: async (book: string): Promise<StoryChunk[]> => {
      const name = cleanBookName(book)
      if (!name) {
        // 走到这里说明上游传了非法书名（正常路径由 listBooks 拦截）；留痕但不修，交给上层跳过
        console.error('STORY-LOAD-FAIL book=' + logSafe(book) + ' err=bad book name')
        return []
      }
      try {
        const chunks = await port.readStoryBook(name)
        // DataPort 承诺返回数组，但假实现/未来实现可能违约：非数组按空书处理，别让 player 的 .length 崩
        return Array.isArray(chunks) ? chunks : []
      } catch (err: any) {
        console.error('STORY-LOAD-FAIL book=' + name + ' err=' + String(err?.message || err))
        return []
      }
    },
  }
}
