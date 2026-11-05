/**
 * host/data/story-source.ts —— 把 DataPort 投影成说书播放器需要的窄接口
 *
 * player.ts 只认 StoryRepo（listBooks/loadBook），不关心数据来自本地还是云端；
 * 这里做一层两行的适配，故事选段/进度/连播逻辑完全不用改。
 */
import type { DataPort } from '../ports.js'
import type { StoryRepo } from '../story/repo.js'

export function createStorySource(port: DataPort): StoryRepo {
  return {
    listBooks: async (): Promise<string[]> => {
      const books = await port.readStoryIndex()
      return books.map((b: any) => String(b && b.book || '')).filter(Boolean)
    },
    loadBook: (book: string) => port.readStoryBook(book),
  }
}
