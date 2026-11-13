/**
 * client/intent.ts —— 点播意图识别（同步判定，可单测）
 *
 * 为什么单独抽出来：这套关键词原来写在 client.ts 的 tryLocalRoute 里，
 * 没法单测，也没法一眼看出"哪些话会被本地路由劫持"。
 *
 * 规则（与主人约定的一致）：
 *   · 只有明确的点播指令才走本地（讲故事 / 背诗 / 讲典故 / 报书名）
 *   · 只要句子里有问号、"为什么/怎么/如何"，一律交给模型，不劫持
 *   · 太长的一句（>30 字）也不劫持——那多半是在说话，不是在点播
 *
 * 注意口径（2026-11-07 修正）：说它「纯」指的是**判定同步、不等待网络、返回值只由输入决定**；
 * 但 detectIntent 会在诗名索引未就绪时触发一次 ensurePoemTitles() 的后台预热（有网络副作用）。
 * 所以单测要 stub 掉 poem-titles（scripts/test-utils-pure.mjs 就是这么做的），
 * 别把它当成零副作用函数。
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

/** 书名尾巴上允许出现的语气词（「三国吧」「西游记吧」仍是点播） */
const BARE_TAIL_PARTICLES = '吧啊呀呢么嘛哈哦嗯啦'

/**
 * 「点播一首」的动词表（与 ① 的 `asks`、② 的泛化意图共用一份口径）。
 *
 * 2026-11-13 补 «背诵»：主人语音说的是「背诵。」「背诵《梦》。」，旧表只认「背诗/念诗」，
 * 于是整句交给模型，模型没查库就答「背哪首？」「诗库里没这首」——本地念诗线路根本没接住。
 * 点播动词只在**有书名号标题**或整句就是诗名时才放行，不会把「我背了三个单词」劫走。
 */
const POEM_VERB = /背(一)?(首|下)|背诵|背|念(一)?(首|下)|念一下|吟|朗读|朗诵|来(一)?首|听(一)?首|讲(一)?首|放(一)?首/

/**
 * 不是点播诗的宾语：背课文 / 背单词 / 背台词 / 背歌词 / 背公式。
 * 这些说法带「背」字，但主人要的不是诗——交给模型，别念一首不相干的诗。
 */
const NOT_POEM_TARGET = /课文|单词|台词|歌词|公式|定义|拼音|九九表|作业|默写|考试/

/**
 * 从「背诵《梦》」「念〈如梦令〉」里取出书名号里的标题。
 * 只取 1–12 字、不含书名号本身的短标题；整句只是一个书名号（《小王子》。）不算——
 * 那是在聊书，不是点播诗（必须有 POEM_VERB 才成立，见 detectIntent）。
 * 内部函数：只服务 detectIntent，不对外暴露新符号。
 */
function matchBracketedTitle(text: string): string {
  const t = String(text || '')
  const m = /[《〈]([^》〉]{1,12})[》〉]/.exec(t)
  return m ? m[1].trim() : ''
}

/**
 * 「整句就是书名」的判定（别名表里的书名都是日常词，必须卡严）。
 *
 * 旧实现只比长度：`bare.length <= book.length + 1`，于是**任何**比书名长一个字的句子都算点播——
 * 「我在看三国」「三国好看」这类普通陈述被劫持去说书，模型的回复主人根本看不到。
 * 现在只认三种形态：
 *   ① 整句就是全名（「红楼梦」「世说新语」）；
 *   ② 去掉句末一个语气词后就是全名（「西游记吧」）；
 *   ③ 别名（「三国」「水浒」）从第一个字起，最多多出一个字（手误），且不能有多余的前缀/后文。
 */
function isBareBookName(bare: string, book: string, alias: RegExp): boolean {
  if (!bare) return false
  if (bare === book) return true
  const core = BARE_TAIL_PARTICLES.indexOf(bare.slice(-1)) >= 0 ? bare.slice(0, -1) : bare
  if (core === book) return true
  const m = alias.exec(core)
  return !!m && m.index === 0 && core.length <= m[0].length + 1
}

/**
 * 否定/劝阻式祈使（「不要讲故事了」「别背诗了」「不用念了」）不是点播。
 *
 * 旧实现只认动词，主人说「不要讲故事」反而被劫持去讲一段——意思正好相反。
 * 这条守卫只拦「不/别/甭/勿 + 可选的 要|用|想|再|许|必 + 点播动词」，
 * 「别客气，讲个故事」这类不受影响（别字后面不是点播动词）。
 */
const NEGATED_ASK = /(不|别|甭|勿|无需)(要|用|想|再|许|必)?\s*(讲|说|念|背|来|放|听|唱)/

/** 从一句话里认出诗名（认不出返回空串；标题未就绪时按认不出处理） */
export function matchPoemTitle(text: string): string {
  const t = String(text || '')
  if (!t) return ''
  for (const title of poemTitles()) {
    if (title.length >= 2 && t.indexOf(title) >= 0) return title
  }
  return ''
}

/**
 * 真提问的标记：命中则不劫持。
 * `吗/呢` 后面允许跟一个句末标点：「讲个故事吗。」和「讲个故事吗」一样是提问，
 * 旧实现只认裸的句尾「吗」，带句号的同一句话反而被劫持去讲故事。
 */
export function isQuestion(text: string): boolean {
  return /[?？]|为什么|怎么|如何|什么|谁|哪[儿里]?|多少|几点|几号|是不是|能不能|要不要|吗[。．.!！…~～]*\s*$|呢[。．.!！…~～]*\s*$/.test(String(text || ''))
}

/** 识别点播意图；返回 null 表示"交给模型" */
export function detectIntent(rawText: string): Intent {
  const t = String(rawText || '').trim()
  if (!t || t.length > 30) return null
  if (isQuestion(t)) return null
  // 否定式祈使不劫持：「不要讲故事」「别背诗了」交给模型，别反着做
  if (NEGATED_ASK.test(t)) return null

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

  // ①′ 书名号点诗（2026-11-13 补）：主人语音说的是「背诵《梦》」「背《将进酒》」。
  //    标题不要求先在诗名索引里（索引只有 634 个标题，词牌/别名常常不在），
  //    直接交给宿主 /poem?title= 做「完整标题优先、其次包含」匹配；
  //    宿主明确说没匹配到时，由路由照实回「诗库里没有《X》」，不回落随机（不拿别的凑数）。
  if (!NOT_POEM_TARGET.test(t)) {
    const bracketed = matchBracketedTitle(t)
    if (bracketed && POEM_VERB.test(t)) return { kind: 'poem', title: bracketed }

    // ② 念诗 / 背诗（含只问一句「背诵」——旧实现漏了它，整句被交给模型瞎答）
    if (/背(一)?(首|下)?诗|念(一)?(首|下)?诗|来首诗|背诗|念诗|讲首诗|背诵/.test(t)) return { kind: 'poem' }
  }

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
  let hit: [RegExp, string] | null = null
  for (const pair of BOOK_ALIAS) { if (pair[0].test(t)) { hit = pair; break } }
  if (hit) {
    const bare = t.replace(BARE_STRIP, '')
    const asksBook = /讲|说书|听|来(一)?段|来(一)?回/.test(t) || isBareBookName(bare, hit[1], hit[0])
    if (asksBook) return { kind: 'story', book: hit[1] }
  }
  if (/讲故事|讲个故事|说书|来段|讲一段/.test(t)) return { kind: 'story', book: '' }
  return null
}
