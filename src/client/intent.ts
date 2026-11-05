/**
 * client/intent.ts —— 点播意图识别（纯函数，可单测）
 *
 * 为什么单独抽出来：这套关键词原来写在 client.ts 的 tryLocalRoute 里，
 * 没法单测，也没法一眼看出"哪些话会被本地路由劫持"。
 *
 * 规则（与主人约定的一致）：
 *   · 只有明确的点播指令才走本地（讲故事 / 背诗 / 讲典故 / 报书名）
 *   · 只要句子里有问号、"为什么/怎么/如何"，一律交给模型，不劫持
 *   · 太长的一句（>30 字）也不劫持——那多半是在说话，不是在点播
 */

import poemTitleData from '../../data/poem-titles.json' with { type: 'json' }

export type Intent =
  | { kind: 'poem'; title?: string }
  | { kind: 'culture'; sub: 'idiom' | 'chengyu' }
  | { kind: 'story'; book: string }
  | null

/** 书名别名：从左到右优先匹配，先匹配到的赢 */
export const BOOK_ALIAS: Array<[RegExp, string]> = [
  [/聊斋/, '聊斋志异'],
  [/三国/, '三国演义'],
  [/西游/, '西游记'],
  [/水浒/, '水浒传'],
  [/红楼/, '红楼梦'],
  [/封神/, '封神演义'],
  [/隋唐/, '隋唐演义'],
  [/杨家将/, '杨家将演义'],
  [/世说/, '世说新语'],
  [/三言|二拍/, '三言二拍'],
  [/儒林/, '儒林外史'],
  [/官场/, '官场现形记'],
  [/老残/, '老残游记'],
  [/说岳|岳传/, '说岳全传'],
  [/东周/, '东周列国志'],
  [/三侠五义/, '三侠五义'],
  [/镜花缘/, '镜花缘'],
]

/** 诗名索引（按长度降序，保证「雨霖铃」优先于「雨」这类短名） */
const POEM_TITLES: string[] = ((poemTitleData as any).titles || []).slice().sort((a: string, b: string) => b.length - a.length)

/** 从一句话里认出诗名（认不出返回空串） */
export function matchPoemTitle(text: string): string {
  const t = String(text || '')
  if (!t) return ''
  for (const title of POEM_TITLES) {
    if (title.length >= 2 && t.indexOf(title) >= 0) return title
  }
  return ''
}

/** 真提问的标记：命中则不劫持 */
export function isQuestion(text: string): boolean {
  return /[?？]|为什么|怎么|如何|什么|谁|哪[儿里]?|多少|几点|几号|是不是|能不能|要不要|吗\s*$|呢\s*$/.test(String(text || ''))
}

/** 识别点播意图；返回 null 表示"交给模型" */
export function detectIntent(rawText: string): Intent {
  const t = String(rawText || '').trim()
  if (!t || t.length > 30) return null
  if (isQuestion(t)) return null

  // ① 点名要某首诗：直接按标题取（"背雨霖铃""来首水调歌头"）
  const byTitle = matchPoemTitle(t)
  if (byTitle) return { kind: 'poem', title: byTitle }

  // ② 念诗 / 背诗
  if (/背(一)?(首|下)?诗|念(一)?(首|下)?诗|来首诗|背诗|念诗|讲首诗/.test(t)) return { kind: 'poem' }

  // ③ 典故 / 成语
  if (/典故|成语/.test(t)) return { kind: 'culture', sub: /成语/.test(t) ? 'chengyu' : 'idiom' }

  // ④ 讲故事 / 说书（可带书名）
  let book = ''
  for (const [re, name] of BOOK_ALIAS) { if (re.test(t)) { book = name; break } }
  if (book) return { kind: 'story', book }
  if (/讲故事|讲个故事|说书|来段|讲一段/.test(t)) return { kind: 'story', book: '' }
  return null
}
