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
 *
 * 诗名索引不在本文件里：634 个标题约 11 KB，改由 host 按需下发
 * （client/poem-titles.ts 负责拉取与缓存）。detectIntent 保持同步——
 * 标题没就绪时跳过诗名匹配、只认泛化意图，后台预热完成后下次调用即可点名诗。
 */

import { deepFreeze } from '../shared/immutable.js'
import { ensurePoemTitles, poemTitles } from './poem-titles.js'

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
deepFreeze(BOOK_ALIAS)

/** 判断"整句就是诗名/书名"时去掉空白与标点（两处共用一份字符集） */
const BARE_STRIP = /[\s。，！？、,.!?…~～]/g

/** 从一句话里认出诗名（认不出返回空串；标题未就绪时按认不出处理） */
export function matchPoemTitle(text: string): string {
  const t = String(text || '')
  if (!t) return ''
  for (const title of poemTitles()) {
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

  // ① 点名要某首诗：按标题取（"背雨霖铃""来首水调歌头"）。
  //    注意：诗名里有大量日常词（梅花/风雨/落花/春思/锦瑟…），只凭"句子里出现诗名"就劫持，
  //    会把「梅花开了」「落花人独立」这类普通陈述抢去念诗。必须有"点播动词"或整句就是诗名才算。
  //    标题索引是 host 按需下发的：第一次走到这里发起后台预热（不 await，同步函数不能等网络）；
  //    本次未就绪就跳过诗名匹配，下面 ②③④ 的泛化意图不受影响。
  if (poemTitles().length === 0) ensurePoemTitles()
  const byTitle = matchPoemTitle(t)
  if (byTitle) {
    const bare = t.replace(BARE_STRIP, '')
    const asks = bare === byTitle || /背|念|吟|朗读|朗诵|来(一)?首|听(一)?首|讲(一)?首|放(一)?首/.test(t)
    if (asks) return { kind: 'poem', title: byTitle }
  }

  // ② 念诗 / 背诗
  if (/背(一)?(首|下)?诗|念(一)?(首|下)?诗|来首诗|背诗|念诗|讲首诗/.test(t)) return { kind: 'poem' }

  // ③ 典故 / 成语：同样要有"点播证据"（"成语接龙"不是让我讲典故）
  if (/典故|成语/.test(t)) {
    const asksCulture = /讲|说|来|听|教|学|点|考/.test(t)
    // 与菜单口径一致：菜单「讲典故」取 chengyu（典故故事）、「成语辨析」取 idiom（易误用辨析）。
    // 点播同理：讲典故→chengyu、讲成语→idiom（2026-11-06 修：原来是对调的，「讲个典故」会念辨析文本）。
    if (asksCulture) return { kind: 'culture', sub: /成语/.test(t) ? 'idiom' : 'chengyu' }
  }

  // ④ 讲故事 / 说书（可带书名）
  //    书名同样是"日常词"（西游/水浒/红楼/三国…），"我小时候看过西游记"不是点播。
  //    要么有讲故事动词，要么整句就是书名（"红楼梦"这种直接报书名）。
  let book = ''
  for (const [re, name] of BOOK_ALIAS) { if (re.test(t)) { book = name; break } }
  if (book) {
    const bare = t.replace(BARE_STRIP, '')
    const asksBook = /讲|说书|听|来(一)?段|来(一)?回/.test(t) || bare.length <= book.length + 1
    if (asksBook) return { kind: 'story', book }
  }
  if (/讲故事|讲个故事|说书|来段|讲一段/.test(t)) return { kind: 'story', book: '' }
  return null
}
