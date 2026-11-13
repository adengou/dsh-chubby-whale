/**
 * client/weather-ask.ts —— 「问天气」的本地识别（纯函数，不联网、不碰 React）
 *
 * 为什么单独成模块：这段判断最容易越界——把「天气晚来秋」这类诗句、
 * 「我喜欢这样的天气」这类闲聊当成实时天气请求，会抢走本该交给模型的对话。
 * 规则与反例都写在这里，`scripts/test-weather.mjs` 逐条钉住。
 *
 * 认成天气请求的条件（全部满足）：
 *   1. ≤30 字（长句多半是在聊天/讲道理，不是问天气）；
 *   2. 含 `天气|气温|温度|多少度|几度`；
 *   3. 形状是「[城市] + 天气词 + [问句后缀]」或「[城市] + 多少度/几度」；
 *      ——「天气晚来秋」在天气词后面还挂着「晚来秋」，形状不成立 → 不劫持；
 *   4. 没有抽出城市时，必须带问句后缀（怎么样/多少度/…），或者整句只是
 *      「今天天气」「今天的天气」这类**只有时间词/填充词 + 天气词**的短问句。
 *
 * 城市抽取：从天气词前面那段里剥掉时间/指代/口头填充词，剩下的 2–8 个汉字
 * （或英文地名）当城市；含「喜欢/觉得/这样」这类词的残段一律不算城市（多半是闲聊）。
 * 抽不出来就用主人的简报城市「北海」。
 */

/** 没提城市时默认查的城市（主人的简报城市） */
export const DEFAULT_WEATHER_CITY = '北海'

/** 问句后缀：天气词后面只允许这些（含空串——「北京天气」也算问天气） */
const ASK_TAIL = /^(?:怎么样|怎样|如何|多少度?|几度|热不热|冷不冷|热吗|冷吗|好吗|好不|下雨吗|下不下雨|下雪吗|要不要带伞|穿什么)?$/

/** 「多少度 / 几度」后面只允许语气词 */
const DEGREE_TAIL = /^(?:呢|啊|呀|了|现在|今天|大概|左右)*$/

/** 时间/指代/口头填充词：从「天气」前面那段里剥掉（按数组顺序，长的先剥） */
const FILLERS = [
  '请问', '问一下', '查一下', '看一下', '帮我看', '帮我查', '帮我', '给我', '麻烦', '说说', '报一下',
  '这几天', '这阵子', '最近', '今天', '明天', '后天', '昨天', '现在', '此刻', '刚才',
  '早上', '上午', '中午', '下午', '晚上', '夜里', '白天', '一早',
  '外面', '外边', '室外', '本地', '这里', '这儿', '那边', '咱们', '我们', '你们',
  '我', '你', '您', '这', '那', '的', '了', '呢', '吗', '啊', '呀', '哦', '嘛', '啦', '呗', '和', '跟', '在', '是',
]

/** 残段里出现这些词 → 不是城市，是闲聊/判断（「我喜欢这样的天气」） */
const NOT_CITY = /(喜欢|觉得|感觉|认为|讨厌|希望|好像|真的|特别|非常|有点|可能|应该|知道|告诉|看看|听听|说说|想要|要是|如果|这样|那样|怎么|什么|为什么|是不是|有没有)/

/** 以数量词开头 → 不是城市（「两天」「几天」） */
const NOT_CITY_HEAD = /^(?:这|那|哪|几|多|两|每|整|一|二|三|四|五|六|七|八|九|十)/

function charLen(s: string): number {
  return Array.from(s).length
}

function stripFillers(text: string): string {
  let s = String(text || '').trim()
  for (const f of FILLERS) {
    if (!s) break
    s = s.split(f).join('')
  }
  return s.replace(/[\s·\-—/、,，。.]+/g, '')
}

/** 抽城市：剥掉填充词后，剩下的整段必须像一个地名；否则返回空串 */
export function extractWeatherCity(prefix: string): string {
  const s = stripFillers(prefix)
  if (!s) return ''
  if (NOT_CITY.test(s) || NOT_CITY_HEAD.test(s)) return ''
  if (/^[\u4e00-\u9fa5]{2,8}$/.test(s)) return s
  if (/^[A-Za-z][A-Za-z ]{1,18}$/.test(s)) return s.trim()
  return ''
}

/** 整段只有时间词/填充词（「今天的」剥完为空）→ 主人没指定城市 */
function onlyFillers(prefix: string): boolean {
  return stripFillers(prefix) === ''
}

export type WeatherAsk = { city: string }

/**
 * 认「问天气」。命中返回 `{ city }`（已带默认城市），否则 null。
 * @param raw 主人原话（打字或语音转写）
 */
export function parseWeatherAsk(raw: string): WeatherAsk | null {
  const t = String(raw == null ? '' : raw)
    .trim()
    .replace(/[?？!！。.~～…]+$/, '')
    .trim()
  if (!t) return null
  if (charLen(t) > 30) return null
  if (!/(天气|气温|温度|多少度|几度)/.test(t)) return null

  // 形状 A：[城市] + 天气/气温/温度 + [问句后缀]
  //
  // 必须扫**所有**出现位置，不能只取第一个：「上海今天气温多少度」里
  // 「今天气温」跨词拼出了「天气」（今**天气**温）——按第一个「天气」切会得到
  // 尾巴「温多少度」，判成不命中。逐个切、取第一个「尾巴合法且抽得出城市」的。
  const weatherWord = /天气|气温|温度/g
  let m: RegExpExecArray | null = null
  let bestCity = ''
  let fallback: WeatherAsk | null = null
  while ((m = weatherWord.exec(t)) !== null) {
    // 允许重叠匹配：正则默认匹配到「天气」后从 index+2 继续，会漏掉紧接着的「气温」
    //（「今天气温」= 今**天气**温，两个词共享「气」字）。
    weatherWord.lastIndex = m.index + 1
    const prefix = t.slice(0, m.index)
    const tail = t.slice(m.index + m[0].length).trim()
    // 后缀不是问句（「天气晚来秋」「天气不错」）→ 这个切法不成立
    if (!ASK_TAIL.test(tail)) continue
    const city = extractWeatherCity(prefix)
    // 越靠后的天气词越可信：「今天气温」跨词拼出的「天气」会把「上海今」当城市，
    // 后面的「气温」切法能得到真正的「上海」。所以后者覆盖前者。
    if (city) { bestCity = city; continue }
    // 没抽到城市：带问句后缀（「今天天气怎么样」）或整句只有时间词（「今天天气」）才认
    if (tail || onlyFillers(prefix)) fallback = { city: DEFAULT_WEATHER_CITY }
  }
  if (bestCity) return { city: bestCity }
  if (fallback) return fallback

  // 形状 B：[城市] + 多少度/几度 + [语气词]
  const b = /^(.*?)(多少度|几度)\s*(.*)$/.exec(t)
  if (b) {
    const prefix = b[1] || ''
    const tail = b[3] || ''
    if (!DEGREE_TAIL.test(tail)) return null
    const city = extractWeatherCity(prefix)
    return { city: city || DEFAULT_WEATHER_CITY }
  }

  return null
}
