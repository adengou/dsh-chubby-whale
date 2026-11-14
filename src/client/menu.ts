import { deepFreeze } from '../shared/immutable.js'
import { normalizeVoiceName } from './voice.js'
/**
 * client/menu.ts —— 菜单数据（1:1 复刻 C# 版 的 menu.ps1，含中英双语）
 *
 * 层级约定（2026-11-14 重构）：
 *   · 一级只放高频命令：说话、看图/读文档、干活、喂饭、成长、提醒、内容、曲子、
 *     位置、数据统计、账本、退出；
 *   · 所有开关/选择类（语言、音色、语音、语速、外观、缓存、行为开关、维护入口）
 *     统一收进一级「设置 ▸」，内部再分四组：
 *     显示与语言 / 语音与耳朵 / 行为开关 / 数据与维护。
 *   · 本次只调整树的位置与层级，action 字符串与处理逻辑一律不变。
 */
export type MenuItem =
  | { type: 'item'; label: string; action: string; note?: string }
  | { type: 'sep' }
  | { type: 'sub'; label: string; items: MenuItem[] }

/**
 * 三种菜单项各一个构造器：菜单表里只写「文案 + 动作」，
 * 不再重复 `{ type: 'item', label: …, action: … }` 这层结构（字段与顺序不变）。
 */
function item(label: string, action: string): MenuItem { return { type: 'item', label, action } }
function sub(label: string, items: MenuItem[]): MenuItem { return { type: 'sub', label, items } }
function sep(): MenuItem { return { type: 'sep' } }

/**
 * 语速子菜单（说书 / 聊天 / 叙述 / 念诗 共用）：
 * 标题是「<前缀><当前值> ▸」，每档「勾 + 档位说明」，动作是「<动作前缀><档位值>」。
 */
function rateSub(prefix: string, action: string, current: string, opts: Array<[string, string]>): MenuItem {
  return sub(prefix + current + ' ▸', opts.map(([rate, text]) => item((rate === current ? '✓ ' : '') + text, action + rate)))
}

export const MELODIES = ['小星星', '两只老虎', '生日快乐', '欢乐颂', '铃儿响叮当', '伦敦大桥', '斯卡布罗集市', '绿袖子', '致爱丽丝', '友谊天长地久', '阳关三叠', '茉莉花', '卡农', '土耳其进行曲', '平安夜']
deepFreeze(MELODIES)

// 简谱曲名 -> 英文（英文界面的「弹《X》」不能把中文曲名留在菜单里）
export const SONG_EN: Record<string, string> = {
  '小星星': 'Twinkle Twinkle Little Star',
  '阳关三叠': 'Yangguan Sandie',
  '茉莉花': 'Jasmine Flower',
  '卡农': 'Canon in D',
  '土耳其进行曲': 'Turkish March',
  '平安夜': 'Silent Night',
  '两只老虎': 'Two Tigers',
  '生日快乐': 'Happy Birthday',
  '欢乐颂': 'Ode to Joy',
  '铃儿响叮当': 'Jingle Bells',
  '伦敦大桥': 'London Bridge',
  '斯卡布罗集市': 'Scarborough Fair',
  '绿袖子': 'Greensleeves',
  '致爱丽丝': 'Fur Elise',
  '友谊天长地久': 'Auld Lang Syne',
}
deepFreeze(SONG_EN)

// 中 -> 英 字典（菜单界面；只放固定文案，动态拼出来的标签走 tr() 的前缀模板）
// 键必须与 buildMenu 里的文案逐字一致，否则就是永远匹配不到的死键。
export const EN_MAP: Record<string, string> = {
  '投喂一碗': 'Feed a bowl',
  '选本书 ▸': 'Choose a book ▸',
  '书单没取到，稍后再试': 'Book list unavailable, try again later',
  '正在翻书单…': 'Loading book list…',
  '今日一句': 'Daily quote',
  '今日简报': "Today's briefing",
  '数据导出…': 'Export data…',
  '数据导入…': 'Import data…',
  '使用统计': 'Usage stats',
  '设置 ▸': 'Settings ▸',
  '显示与语言 ▸': 'Display & language ▸',
  '语音与耳朵 ▸': 'Voice & hearing ▸',
  '行为开关 ▸': 'Behavior toggles ▸',
  '数据与维护 ▸': 'Data & maintenance ▸',
  '查看当前配置': 'View current config',
  '提醒管理…': 'Manage reminders…',
  '唤醒恢复': 'Wake recovery',
  '唤醒词 ▸': 'Wake word ▸',
  '默认（大肥鱼/肥鲸等）': 'Default (Da Fei Yu / Fei Jing)',
  '大肥鱼': 'Da Fei Yu',
  '肥鲸': 'Fei Jing',
  '小鲸': 'Xiao Jing',
  '自定义…': 'Custom…',
  '弹首曲子 ▸': 'Play a song ▸',
  '停止弹奏': 'Stop music',
  '跟她说两句': 'Talk to her',
  '换个声音 ▸': 'Change voice ▸',
  '聊天语言 ▸': 'Chat language ▸',
  '界面语言 ▸': 'Interface language ▸',
  '看张图…': 'Look at a picture…',
  '阅读文档 ▸': 'Read a file ▸',
  '读文档…': 'Read a document…',
  '停止说话': 'Stop talking',
  '让她歇会儿': 'Let her rest',
  '回碗里待着': 'Back in the bowl',
  '长大一点': 'Grow bigger',
  '变小一点': 'Shrink',
  '记个饭点…': 'Add a meal reminder…',
  '提醒清单…': 'Reminders…',
  '端点检测：经典/自适应': 'Endpoint detection: classic / adaptive',
  '耳朵自检（听力诊断）': 'Hearing self-test',
  '文化气 ▸': 'Culture ▸',
  '说书（连载）': 'Storytelling',
  '稍快 -25%': 'A bit faster -25%',
  '适中 -30%': 'Medium -30%',
  '偏慢 -35%（默认）': 'Slower -35% (default)',
  '更快 +10%': 'Faster +10%',
  '稍快 +0%': 'A bit faster +0%',
  '正常 -15%（默认）': 'Normal -15% (default)',
  '正常 -10%': 'Normal -10%',
  '固定背景：开': 'Fixed background: on',
  '固定背景：关': 'Fixed background: off',
  '恢复默认背景': 'Restore default background',
  '偏慢 -20%': 'Slow -20%',
  '稍快 -15%': 'A bit faster -15%',
  '适中 -20%': 'Medium -20%',
  '偏慢 -25%（默认）': 'Slower -25% (default)',
  '很慢 -30%': 'Very slow -30%',
  '很慢 -40%': 'Very slow -40%',
  '接着说': 'Continue story',
  '从头讲这本书': 'Restart this book',
  '念首诗': 'Recite a poem',
  '讲个民间故事': 'Folk tale',
  '讲个典故': 'Classic allusion',
  '成语辨析': 'Idiom',
  '出个对联 ▸': 'Couplets ▸',
  '随机一副': 'Random pair',
  '春联': 'Spring couplet',
  '格言': 'Motto',
  '谐趣': 'Witty',
  '名胜': 'Landmarks',
  '景观': 'Scenery',
  '书房': 'Study',
  '书院': 'Academy',
  '寿联': 'Birthday couplet',
  '中药': 'Herbs',
  '叠字': 'Repeated characters',
  '数字': 'Numerals',
  '把稿子念成音频…': 'Narrate script to audio…',
  '公文校对…': 'Proofread a document…',
  '神经感知：看一眼状态': 'Nervous system: status',
  '清除记忆…': 'Clear memory…',
  '清空聊天缓存…': 'Clear chat cache…',
  '让它游走（退出）': 'Let it go (exit)',
  '鱼粮账本': 'Token ledger',
  'English': 'English',
  '中文': 'Chinese',
  // 动态 label（音色勾选/聊天缓存开关/自动）需要的英文键
  '聊天缓存：开': 'Chat cache: on',
  '聊天缓存：关': 'Chat cache: off',
  '自动（按语言选音色）': 'Auto (by language)',
  '自动': 'Auto',
  '音色：晓伊（中·女）': 'Voice: Xiaoyi (CN F)',
  '音色：晓晓（中·女）': 'Voice: Xiaoxiao (CN F)',
  '音色：晓辰（中·女）': 'Voice: Xiaochen (CN F)',
  '音色：云希（中·男）': 'Voice: Yunxi (CN M)',
  '音色：云扬（中·男）': 'Voice: Yunyang (CN M)',
  '音色：Ana（英·女）': 'Voice: Ana (EN F)',
  '音色：Jenny（英·女）': 'Voice: Jenny (EN F)',
  '音色：Sonia（英·女·英式）': 'Voice: Sonia (EN-GB F)',
  '数据与统计 ▸': 'Data & Stats ▸',
}
deepFreeze(EN_MAP)

// 成长阶段名（来自 shared/growth.ts 的数据值）→ 英文；菜单"成长：熟悉（200）"要用
const STAGE_EN: Record<string, string> = {
  '初识': 'New', '熟悉': 'Familiar', '亲密': 'Close', '知心': 'Confidant', '家人': 'Family',
}
deepFreeze(STAGE_EN)

// 开关类菜单项：前缀 -> [开, 关]（标签是运行时拼的，精确字典永远匹配不到）
const TOGGLE_EN: Record<string, [string, string]> = {
  '语音朗读：': ['Voice output: on', 'Voice output: off'],
  '语音待命：': ['Voice standby: on', 'Voice standby: off'],
  '语音聊天：': ['Voice chat: on', 'Voice chat: off'],
  '流式回复：': ['Streaming replies: on', 'Streaming replies: off'],
  '神经感知：': ['Nervous system: on', 'Nervous system: off'],
  '鲸鱼看板：': ['Whale board: on', 'Whale board: off'],
  '鲸式解说：': ['Whale commentary: on', 'Whale commentary: off'],
  '联网搜索：': ['Web search: on', 'Web search: off'],
  '诗词弹幕：': ['Poem commentary: on', 'Poem commentary: off'],
}

export function tr(label: string, lang: string): string {
  if (lang !== 'en') return label
  const exact = EN_MAP[label]
  if (exact) return exact
  // 勾选项（'✓ ' + 文案）：剥前缀翻译再拼回去。
  // 原来靠 '✓ 自动' / '✓ 中文' 这类硬编码条目，音色菜单一带勾就又漏回中文。
  if (label.startsWith('✓ ')) {
    const base = label.slice(2)
    const en = tr(base, lang)
    return en === base ? label : '✓ ' + en
  }
  // 动态标签（曲名/成长/版本/余额/开关）用模板拼，别在 EN_MAP 里留永远匹配不到的死键
  if (label.startsWith('弹《') && label.endsWith('》')) {
    const song = label.slice(2, label.length - 1)
    return SONG_EN[song] ? 'Play "' + SONG_EN[song] + '"' : 'Play a song'
  }
  if (label.startsWith('成长：')) {
    const rest = label.slice(3)
    const m = rest.match(/^(初识|熟悉|亲密|知心|家人)([\s\S]*)$/)
    if (!m) return 'Growth: ' + rest
    const tail = String(m[2] || '').replace(/（/g, '(').replace(/）/g, ')')
    return 'Growth: ' + (STAGE_EN[m[1]] || m[1]) + tail
  }
  if (label.startsWith('版本：v')) return 'Version: v' + label.slice(4)
  if (label.startsWith('余额：')) return 'Balance: ' + label.slice(3)
  for (const prefix of Object.keys(TOGGLE_EN)) {
    if (label.startsWith(prefix)) {
      const pair = TOGGLE_EN[prefix]
      return label.slice(prefix.length) === '开' ? pair[0] : pair[1]
    }
  }
  // 动态标题前缀兼容（保持 tr 契约）：菜单现在用的是静态「界面语言 ▸」「聊天语言 ▸」，
  // 但若以后把当前值拼进标题（如「界面语言：中文 ▸」），前缀与取值都要能译，
  // 不能因为 title 是运行时拼的就把中文漏到英文界面里。
  if (label.startsWith('界面语言：') || label.startsWith('聊天语言：')) {
    const head = label.startsWith('界面语言：') ? 'Interface language: ' : 'Chat language: '
    const rest = label.slice(5)
    const tail = rest.endsWith(' ▸') ? ' ▸' : ''
    const value = tail ? rest.slice(0, -2) : rest
    const valueEn: Record<string, string> = { '中文': 'Chinese', 'English': 'English', '自动': 'Auto' }
    return head + (valueEn[value] || value) + tail
  }
  // 说书语速（运行时拼百分比）与连播（带说明括注）：动态标签，按前缀翻
  if (label.startsWith('说书语速：')) return label.replace('说书语速：', 'Story speed: ')
  if (label.startsWith('连播：')) return label.indexOf('开') >= 0 ? 'Auto-continue: on' : 'Auto-continue: off'
  if (label.startsWith('念诗语速：')) return label.replace('念诗语速：', 'Poem speed: ')
  if (label.startsWith('叙述语速：')) return label.replace('叙述语速：', 'Narration speed: ')
  if (label.startsWith('聊天语速：')) return label.replace('聊天语速：', 'Chat speed: ')
  return label
}

/** 「换个声音 ▸」的音色表：取值与 label 一一对应（label 同时是 EN_MAP 的键） */
const VOICE_ITEMS: Array<[string, string]> = [
  ['zh-CN-XiaoyiNeural', '音色：晓伊（中·女）'],
  ['zh-CN-XiaoxiaoNeural', '音色：晓晓（中·女）'],
  ['zh-CN-XiaochenNeural', '音色：晓辰（中·女）'],
  ['zh-CN-YunxiNeural', '音色：云希（中·男）'],
  ['zh-CN-YunyangNeural', '音色：云扬（中·男）'],
  ['en-US-AnaNeural', '音色：Ana（英·女）'],
  ['en-US-JennyNeural', '音色：Jenny（英·女）'],
  ['en-GB-SoniaNeural', '音色：Sonia（英·女·英式）'],
]

/** 语速档位：与 rates.ts 的 NARRATION_RATES / CHAT_RATES、story/poem 的合法值一致 */
const STORY_RATE_ITEMS: Array<[string, string]> = [['-25%', '稍快 -25%'], ['-30%', '适中 -30%'], ['-35%', '偏慢 -35%（默认）'], ['-40%', '很慢 -40%']]
const CHAT_RATE_ITEMS: Array<[string, string]> = [['+10%', '更快 +10%'], ['+0%', '稍快 +0%'], ['-15%', '正常 -15%（默认）'], ['-10%', '正常 -10%'], ['-20%', '偏慢 -20%'], ['-30%', '很慢 -30%']]
const NARRATION_RATE_ITEMS: Array<[string, string]> = [['-15%', '稍快 -15%'], ['-20%', '适中 -20%'], ['-25%', '偏慢 -25%（默认）'], ['-30%', '很慢 -30%']]

/** 菜单状态：开关/语音/语言等字段只用于菜单文案与勾选，缺省值保持旧行为 */
export interface MenuState {
  voiceOn?: boolean
  earOn?: boolean
  voiceChatOn?: boolean
  /** 聊天缓存开关（缺省视为开） */
  chatCacheOn?: boolean
  /** 聊天语言：'auto' | 'zh' | 'en'（缺省 auto） */
  chatLang?: string
  /** 当前音色（缺省晓伊） */
  ttsVoice?: string
  balance?: string
  growth?: string
  /** 说书书单：由 client.ts 打开菜单时拉取后传入（未拉到时为空数组） */
  storyBooks?: string[]
  /** 书单是否已经拉过：拉过但为空 → 菜单显示「书单没取到，稍后再试」 */
  storyBooksTried?: boolean
  /** 鲸式解说开关（默认开） */
  toolNarratorOn?: boolean

/** 诗词弹幕开关（默认开） */
  poemEchoOn?: boolean

/** 曲目列表（运行时从 /melodies 拉取；缺省用内置 MELODIES 兜底） */
  melodies?: string[]

/** 固定背景开关（true = 不随机） */
  skinFixed?: boolean
  /** 说书连播开关（缺省视为开：讲完一段自动接下一段） */
  storyAuto?: boolean
  /** 说书语速（缺省 -35%）：-25% / -30% / -35% / -40% */
  storyRate?: string
  /** 念诗语速（缺省 -25%） */
  poemRate?: string
  /** 叙述语速（缺省 -25%，典故/成语用） */
  narrationRate?: string
  /** 聊天语速（缺省 -15%，聊天回复/喊名字应答用） */
  chatRate?: string
  /** 流式回复开关（缺省视为开；关掉后等整段回复再开口） */
  streamOn?: boolean
  /** 神经感知开关（缺省视为开） */
  nervousOn?: boolean
  /** 联网搜索开关（缺省关；打开后聊天可搜网页并附来源） */
  webSearchOn?: boolean
  /** 鲸鱼看板开关（缺省开：只在 AgentTeam 启用且有任务时显示） */
  teamBoardOn?: boolean
}

export function buildMenu(version: string, state: MenuState = {}): MenuItem[] {
  const voiceOn = state.voiceOn ? true : false
  const earOn = state.earOn ? true : false
  const voiceChatOn = state.voiceChatOn ? true : false
  /** 神经感知缺省开：只有显式 false 才算关 */
  const nervousOn = !(state.nervousOn === false)
  // 脏值归一：菜单勾选必须和「运行时实际用的值」同口径，否则手改/旧版本留下的
  // 非法值会让三个选项都不打勾，而实际行为已经回落到默认。
  //   · 聊天语言：client/chat.ts 的 resolveChatLang 对非法值一律当 auto；
  //   · 音色：client/voice/voices.ts 的 normalizeVoiceName 白名单外一律回落晓伊。
  const chatLang = (() => {
    const v = state.chatLang ? String(state.chatLang) : ''
    return v === 'zh' || v === 'en' ? v : 'auto'
  })()
  const ttsVoice = normalizeVoiceName(state.ttsVoice)
  const chatCacheOn = !(state.chatCacheOn === false)
  const voiceTick = (voice: string): string => (ttsVoice === voice ? '✓ ' : '')
  const growthText = (state && state.growth) ? state.growth : '--'
  // 说书书单：书名原样作为菜单项，动作走 story-book:<书名>；
  // 拉不到（或拉回来是空列表）时给一条兜底项，点它会重试拉书单（story-books）
  const books = Array.isArray(state.storyBooks)
    ? state.storyBooks.map((b) => String(b || '').trim()).filter(Boolean)
    : []
  const bookItems: MenuItem[] = books.length
    ? books.map((b) => item(b, 'story-book:' + b))
    : [item(state.storyBooksTried ? '书单没取到，稍后再试' : '正在翻书单…', 'story-books')]
  return [

    sep(),
    // ══ 一级：高频命令（开关/选择类一律不放在这一层）══
    // ── 说话、看图、干活 ──
    item('跟她说两句', 'type'),
    sub('阅读文档 ▸', [
      item('看张图…', 'vision'),
      item('读文档…', 'read-doc'),
    ]),
    item('公文校对…', 'proofread'),
    sep(),
    // ── 吃饭与成长 ──
    item('投喂一碗', 'feed'),
    item('成长：' + growthText, 'growth'),
    sep(),
    // ── 饭点提醒（高频命令保留一级）──
    item('记个饭点…', 'remind-add'),
    item('提醒清单…', 'remind-list'),
    sep(),
    // ── 文化气：只留内容命令；连播与四类语速是开关/选择，已收进「设置」──
    sub('文化气 ▸', [
      item('说书（连载）', 'culture-story'),
      item('接着说', 'culture-story-next'),
      item('从头讲这本书', 'story-reset'),
      item('念首诗', 'poem'),
      item('讲个民间故事', 'culture-tale'),
      item('讲个典故', 'culture-allusion'),
      item('成语辨析', 'culture-idiom'),
      sub('出个对联 ▸', [
        item('随机一副', 'culture-couplet'),
        item('春联', 'culture-couplet:春联'),
        item('格言', 'culture-couplet:格言'),
        item('谐趣', 'culture-couplet:谐趣'),
        item('名胜', 'culture-couplet:名胜'),
        item('景观', 'culture-couplet:景观'),
        item('书院', 'culture-couplet:书院'),
        item('书房', 'culture-couplet:书房'),
        item('寿联', 'culture-couplet:寿联'),
        item('中药', 'culture-couplet:中药'),
        item('叠字', 'culture-couplet:叠字'),
        item('数字', 'culture-couplet:数字'),
      ]),
    ]),
    // ── 每日内容（说书选本 / 每日一句 / 今日简报）──
    sub('选本书 ▸', bookItems),
    item('今日一句', 'daily-line'),
    item('今日简报', 'briefing-card'),
    sep(),
    // ── 曲子 ──
    sub('弹首曲子 ▸', (state.melodies && state.melodies.length ? state.melodies : MELODIES).map((m) => item('弹《' + m + '》', 'music:' + m))),
    item('停止弹奏', 'music-stop'),
    sep(),
    // ── 位置（高频命令保留；大小调节是选择类，收进「设置 → 显示与语言」）──
    item('让她歇会儿', 'pause'),
    item('回碗里待着', 'home'),
    sep(),
    // ── 数据与统计（高频命令保留；只读配置归「设置 → 数据与维护」）──
    sub('数据与统计 ▸', [
      item('数据导出…', 'data-export'),
      item('数据导入…', 'data-import'),
      // 鲸落胶囊：只打包摘要里的抽象主题，不含对话原文
      item('使用统计', 'stats'),
    ]),
    item('鱼粮账本', 'fishfood'),
    sep(),
    // ══ 一级：设置（所有开关/选择类统一收在这里，放在靠近底部）══
    sub('设置 ▸', [
      // ── 显示与语言：语言、背景、大小 ──
      sub('显示与语言 ▸', [
        sub('界面语言 ▸', [
          item('中文', 'lang:zh'),
          item('English', 'lang:en'),
        ]),
        sub('聊天语言 ▸', [
          item((chatLang === 'auto' ? '✓ ' : '') + '自动', 'chat-lang:auto'),
          item((chatLang === 'zh' ? '✓ ' : '') + '中文', 'chat-lang:zh'),
          item((chatLang === 'en' ? '✓ ' : '') + 'English', 'chat-lang:en'),
        ]),
        item('固定背景：' + (state.skinFixed ? '开' : '关'), 'skin-fixed'),
        item('恢复默认背景', 'skin-bg-reset'),
        item('长大一点', 'bigger'),
        item('变小一点', 'smaller'),
      ]),
      // ── 语音与耳朵：语音开关、音色、唤醒、语速 ──
      sub('语音与耳朵 ▸', [
        item(voiceOn ? '语音朗读：开' : '语音朗读：关', 'voice'),
        item('停止说话', 'tts-stop'),
        item('语音待命：' + (earOn ? '开' : '关'), 'wake'),
        item('语音聊天：' + (voiceChatOn ? '开' : '关'), 'chatmode'),
        item('流式回复：' + (state.streamOn === false ? '关' : '开'), 'stream-toggle'),
        sub('换个声音 ▸', [
          ...VOICE_ITEMS.map(([voice, label]) => item(voiceTick(voice) + label, 'voice:' + voice)),
          item(voiceTick('auto') + '自动（按语言选音色）', 'voice:auto'),
        ]),
        sub('唤醒词 ▸', [
          item('默认（大肥鱼/肥鲸等）', 'wake-word:'),
          item('大肥鱼', 'wake-word:大肥鱼'),
          item('肥鲸', 'wake-word:肥鲸'),
          item('小鲸', 'wake-word:小鲸'),
          item('自定义…', 'wake-word:custom'),
        ]),
        item('端点检测：经典/自适应', 'endpoint'),
        item('耳朵自检（听力诊断）', 'ear-check'),
        item('把稿子念成音频…', 'voice-export'),
        rateSub('说书语速：', 'story-rate:', state.storyRate || '-35%', STORY_RATE_ITEMS),
        rateSub('聊天语速：', 'chat-rate:', state.chatRate || '-15%', CHAT_RATE_ITEMS),
        rateSub('叙述语速：', 'narration-rate:', state.narrationRate || '-25%', NARRATION_RATE_ITEMS),
        rateSub('念诗语速：', 'poem-rate:', state.poemRate || '-25%', NARRATION_RATE_ITEMS),
      ]),
      // ── 行为开关：解说、弹幕、感知、看板、联网、缓存、连播 ──
      sub('行为开关 ▸', [
        item('鲸式解说：' + (state.toolNarratorOn === false ? '关' : '开'), 'tool-narrator'),
        item('诗词弹幕：' + (state.poemEchoOn === false ? '关' : '开'), 'poem-echo'),
        item('神经感知：' + (nervousOn ? '开' : '关'), 'nervous'),
        item('神经感知：看一眼状态', 'nervous-status'),
        item('鲸鱼看板：' + (state.teamBoardOn === false ? '关' : '开'), 'team-board'),
        item('联网搜索：' + (state.webSearchOn ? '开' : '关'), 'web-search'),
        item(chatCacheOn ? '聊天缓存：开' : '聊天缓存：关', 'cache-toggle'),
        item('连播：' + (state.storyAuto === false ? '关' : '开') + '（讲完一段自动接下一段）', 'story-auto'),
      ]),
      // ── 数据与维护：只读配置、提醒管理、唤醒恢复、清缓存、清记忆 ──
      sub('数据与维护 ▸', [
        item('查看当前配置', 'config-view'),
        item('提醒管理…', 'remind-manage'),
        item('唤醒恢复', 'wake-recover'),
        item('清空聊天缓存…', 'cache-clear'),
        item('清除记忆…', 'clear-memory'),
      ]),
    ]),
    sep(),
    // ── 退出（永远在最底下，减少误点）──
    item('让它游走（退出）', 'hide'),
  ]
}
