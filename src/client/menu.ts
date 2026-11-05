/**
 * client/menu.ts —— 菜单数据（1:1 复刻 C# 版 的 menu.ps1，含中英双语）
 */
export type MenuItem =
  | { type: 'item'; label: string; action: string; note?: string }
  | { type: 'sep' }
  | { type: 'sub'; label: string; items: MenuItem[] }

export const MELODIES = ['小星星', '两只老虎', '生日快乐', '欢乐颂', '铃儿响叮当', '伦敦大桥', '斯卡布罗集市', '思君黯然', '绿袖子', '致爱丽丝', '友谊天长地久']

// 简谱曲名 -> 英文（英文界面的「弹《X》」不能把中文曲名留在菜单里）
export const SONG_EN: Record<string, string> = {
  '小星星': 'Twinkle Twinkle Little Star',
  '两只老虎': 'Two Tigers',
  '生日快乐': 'Happy Birthday',
  '欢乐颂': 'Ode to Joy',
  '铃儿响叮当': 'Jingle Bells',
  '伦敦大桥': 'London Bridge',
  '斯卡布罗集市': 'Scarborough Fair',
  '思君黯然': 'Longing for You',
  '绿袖子': 'Greensleeves',
  '致爱丽丝': 'Fur Elise',
  '友谊天长地久': 'Auld Lang Syne',
}

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
  '提醒管理…': 'Manage reminders…',
  '唤醒恢复': 'Wake recovery',
  '弹首曲子 ▸': 'Play a song ▸',
  '停止弹奏': 'Stop music',
  '跟她说两句': 'Talk to her',
  '换个声音 ▸': 'Change voice ▸',
  '聊天语言 ▸': 'Chat language ▸',
  '界面语言 ▸': 'Interface language ▸',
  '看张图…': 'Look at a picture…',
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
  '寿联': 'Birthday couplet',
  '中药': 'Herbs',
  '叠字': 'Repeated characters',
  '数字': 'Numerals',
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
}

// 开关类菜单项：前缀 -> [开, 关]（标签是运行时拼的，精确字典永远匹配不到）
const TOGGLE_EN: Record<string, [string, string]> = {
  '语音朗读：': ['Voice output: on', 'Voice output: off'],
  '语音待命：': ['Voice standby: on', 'Voice standby: off'],
  '语音聊天：': ['Voice chat: on', 'Voice chat: off'],
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
  if (label.startsWith('成长：')) return 'Growth: ' + label.slice(3)
  if (label.startsWith('版本：v')) return 'Version: v' + label.slice(4)
  if (label.startsWith('余额：')) return 'Balance: ' + label.slice(3)
  for (const prefix of Object.keys(TOGGLE_EN)) {
    if (label.startsWith(prefix)) {
      const pair = TOGGLE_EN[prefix]
      return label.slice(prefix.length) === '开' ? pair[0] : pair[1]
    }
  }
  // 说书语速（运行时拼百分比）与连播（带说明括注）：动态标签，按前缀翻
  if (label.startsWith('说书语速：')) return label.replace('说书语速：', 'Story speed: ')
  if (label.startsWith('连播：')) return label.indexOf('开') >= 0 ? 'Auto-continue: on' : 'Auto-continue: off'
  return label
}

/** 默认音色：晓伊（与 C# 版一致） */
const DEFAULT_VOICE = 'zh-CN-XiaoyiNeural'

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
  /** 说书连播开关（缺省视为开：讲完一段自动接下一段） */
  storyAuto?: boolean
  /** 说书语速（缺省 -35%）：-25% / -30% / -35% / -40% */
  storyRate?: string
}

export function buildMenu(version: string, state: MenuState = {}): MenuItem[] {
  const voiceOn = state.voiceOn ? true : false
  const earOn = state.earOn ? true : false
  const voiceChatOn = state.voiceChatOn ? true : false
  const chatLang = state.chatLang ? String(state.chatLang) : 'auto'
  const ttsVoice = state.ttsVoice ? String(state.ttsVoice) : DEFAULT_VOICE
  const chatCacheOn = !(state.chatCacheOn === false)
  const voiceTick = (voice: string): string => (ttsVoice === voice ? '✓ ' : '')
  const balanceText = (state && state.balance) ? state.balance : '--'
  const growthText = (state && state.growth) ? state.growth : '--'
  // 说书书单：书名原样作为菜单项，动作走 story-book:<书名>；
  // 拉不到（或拉回来是空列表）时给一条兜底项，点它会重试拉书单（story-books）
  const books = Array.isArray(state.storyBooks)
    ? state.storyBooks.map((b) => String(b || '').trim()).filter(Boolean)
    : []
  const bookItems: MenuItem[] = books.length
    ? books.map((b) => ({ type: 'item' as const, label: b, action: 'story-book:' + b }))
    : [{ type: 'item', label: state.storyBooksTried ? '书单没取到，稍后再试' : '正在翻书单…', action: 'story-books' }]
  return [
    // ── 界面语言（主人定的位置：标题栏下方第一行）──
    { type: 'sub', label: '界面语言 ▸', items: [
      { type: 'item', label: '中文', action: 'lang:zh' },
      { type: 'item', label: 'English', action: 'lang:en' },
    ] },
    // ── 吃饭与看图 ──
    { type: 'item', label: '成长：' + growthText, action: 'growth' },
    { type: 'item', label: '投喂一碗', action: 'feed' },
    { type: 'item', label: '看张图…', action: 'vision' },
    { type: 'sep' },
    // ── 曲子 ──
    { type: 'sub', label: '弹首曲子 ▸', items: MELODIES.map((m) => ({ type: 'item' as const, label: '弹《' + m + '》', action: 'music:' + m })) },
    { type: 'item', label: '停止弹奏', action: 'music-stop' },
    { type: 'sep' },
    // ── 说话与耳朵（语音类全放一起）──
    { type: 'item', label: '跟她说两句', action: 'type' },
    { type: 'item', label: voiceOn ? '语音朗读：开' : '语音朗读：关', action: 'voice' },
    { type: 'item', label: '停止说话', action: 'tts-stop' },
    { type: 'sub', label: '换个声音 ▸', items: [
      { type: 'item', label: voiceTick('zh-CN-XiaoyiNeural') + '音色：晓伊（中·女）', action: 'voice:zh-CN-XiaoyiNeural' },
      { type: 'item', label: voiceTick('zh-CN-XiaoxiaoNeural') + '音色：晓晓（中·女）', action: 'voice:zh-CN-XiaoxiaoNeural' },
      { type: 'item', label: voiceTick('zh-CN-XiaochenNeural') + '音色：晓辰（中·女）', action: 'voice:zh-CN-XiaochenNeural' },
      { type: 'item', label: voiceTick('zh-CN-YunxiNeural') + '音色：云希（中·男）', action: 'voice:zh-CN-YunxiNeural' },
      { type: 'item', label: voiceTick('zh-CN-YunyangNeural') + '音色：云扬（中·男）', action: 'voice:zh-CN-YunyangNeural' },
      { type: 'item', label: voiceTick('en-US-AnaNeural') + '音色：Ana（英·女）', action: 'voice:en-US-AnaNeural' },
      { type: 'item', label: voiceTick('en-US-JennyNeural') + '音色：Jenny（英·女）', action: 'voice:en-US-JennyNeural' },
      { type: 'item', label: voiceTick('en-GB-SoniaNeural') + '音色：Sonia（英·女·英式）', action: 'voice:en-GB-SoniaNeural' },
      { type: 'item', label: voiceTick('auto') + '自动（按语言选音色）', action: 'voice:auto' },
    ] },
    { type: 'item', label: '语音待命：' + (earOn ? '开' : '关'), action: 'wake' },
    { type: 'item', label: '语音聊天：' + (voiceChatOn ? '开' : '关'), action: 'chatmode' },
    { type: 'item', label: '端点检测：经典/自适应', action: 'endpoint' },
    { type: 'item', label: '耳朵自检（听力诊断）', action: 'ear-check' },
    { type: 'sep' },
    // ── 语言 ──
    { type: 'sub', label: '聊天语言 ▸', items: [
      { type: 'item', label: (chatLang === 'auto' ? '✓ ' : '') + '自动', action: 'chat-lang:auto' },
      { type: 'item', label: (chatLang === 'zh' ? '✓ ' : '') + '中文', action: 'chat-lang:zh' },
      { type: 'item', label: (chatLang === 'en' ? '✓ ' : '') + 'English', action: 'chat-lang:en' },
    ] },
    { type: 'sep' },
    // ── 位置与大小 ──
    { type: 'item', label: '让她歇会儿', action: 'pause' },
    { type: 'item', label: '回碗里待着', action: 'home' },
    { type: 'item', label: '长大一点', action: 'bigger' },
    { type: 'item', label: '变小一点', action: 'smaller' },
    { type: 'sep' },
    // ── 饭点提醒 ──
    { type: 'item', label: '记个饭点…', action: 'remind-add' },
    { type: 'item', label: '提醒清单…', action: 'remind-list' },
    { type: 'sep' },
    // ── 文化气 ──
    { type: 'sub', label: '文化气 ▸', items: [
      { type: 'item', label: '说书（连载）', action: 'culture-story' },
      { type: 'item', label: '连播：' + (state.storyAuto === false ? '关' : '开') + '（讲完一段自动接下一段）', action: 'story-auto' },
      { type: 'sub', label: '说书语速：' + (state.storyRate || '-35%') + ' ▸', items: [
        { type: 'item', label: ((state.storyRate || '-35%') === '-25%' ? '✓ ' : '') + '稍快 -25%', action: 'story-rate:-25%' },
        { type: 'item', label: ((state.storyRate || '-35%') === '-30%' ? '✓ ' : '') + '适中 -30%', action: 'story-rate:-30%' },
        { type: 'item', label: ((state.storyRate || '-35%') === '-35%' ? '✓ ' : '') + '偏慢 -35%（默认）', action: 'story-rate:-35%' },
        { type: 'item', label: ((state.storyRate || '-35%') === '-40%' ? '✓ ' : '') + '很慢 -40%', action: 'story-rate:-40%' },
      ] },
      { type: 'item', label: '接着说', action: 'culture-story-next' },
      { type: 'item', label: '从头讲这本书', action: 'story-reset' },
      { type: 'item', label: '念首诗', action: 'poem' },
      { type: 'item', label: '讲个民间故事', action: 'culture-tale' },
      { type: 'item', label: '讲个典故', action: 'culture-allusion' },
      { type: 'item', label: '成语辨析', action: 'culture-idiom' },
          { type: 'sub', label: '出个对联 ▸', items: [
      { type: 'item', label: '随机一副', action: 'culture-couplet' },
      { type: 'item', label: '春联', action: 'culture-couplet:春联' },
      { type: 'item', label: '格言', action: 'culture-couplet:格言' },
      { type: 'item', label: '谐趣', action: 'culture-couplet:谐趣' },
      { type: 'item', label: '名胜', action: 'culture-couplet:名胜' },
      { type: 'item', label: '景观', action: 'culture-couplet:景观' },
      { type: 'item', label: '书房', action: 'culture-couplet:书房' },
      { type: 'item', label: '寿联', action: 'culture-couplet:寿联' },
      { type: 'item', label: '中药', action: 'culture-couplet:中药' },
      { type: 'item', label: '叠字', action: 'culture-couplet:叠字' },
      { type: 'item', label: '数字', action: 'culture-couplet:数字' },
    ] },
    ] },
    { type: 'sep' },
    // ── 每日内容（说书选本 / 每日一句 / 今日简报）──
    { type: 'sub', label: '选本书 ▸', items: bookItems },
    { type: 'item', label: '今日一句', action: 'daily-line' },
    { type: 'item', label: '今日简报', action: 'briefing-card' },
    { type: 'sep' },
    // ── 数据与统计（处理器由其他分身实现，未接上时走兜底提示）──
    { type: 'item', label: '数据导出…', action: 'data-export' },
    { type: 'item', label: '数据导入…', action: 'data-import' },
    { type: 'item', label: '使用统计', action: 'stats' },
    { type: 'item', label: '提醒管理…', action: 'remind-manage' },
    { type: 'item', label: '唤醒恢复', action: 'wake-recover' },
    { type: 'sep' },
    // ── 记忆、缓存与退出 ──
    { type: 'item', label: '清除记忆…', action: 'clear-memory' },
    { type: 'item', label: '清空聊天缓存…', action: 'cache-clear' },
    { type: 'item', label: (chatCacheOn ? '聊天缓存：开' : '聊天缓存：关'), action: 'cache-toggle' },
    { type: 'item', label: '让它游走（退出）', action: 'hide' },
    { type: 'sep' },
    // ── 账本与版本（版本永远在最底下）──
    { type: 'item', label: '鱼粮账本', action: 'fishfood' },
  ]
}
