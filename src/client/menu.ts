/**
 * client/menu.ts —— 菜单数据（1:1 复刻 dsh-fish-pet 的 menu.ps1，含中英双语）
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
export const EN_MAP: Record<string, string> = {
  '喂它一口': 'Feed it',
  '弹首曲子 ▸': 'Play a song ▸',
  '停止弹奏': 'Stop music',
  '打字说两句': 'Type a message',
  '换个声音 ▸': 'Change voice ▸',
  '聊天语言 ▸': 'Chat language ▸',
  '界面语言 ▸': 'Interface language ▸',
  '看张图…': 'Look at a picture…',
  '停止说话': 'Stop talking',
  '停下歇会儿': 'Take a break',
  '回到右下角': 'Back to corner',
  '长大一点': 'Grow bigger',
  '变小一点': 'Shrink',
  '加个提醒…': 'Add reminder…',
  '提醒清单…': 'Reminders…',
  '文化气 ▸': 'Culture ▸',
  '说书（连载）': 'Storytelling',
  '接着说': 'Continue story',
  '念首诗': 'Recite a poem',
  '讲个民间故事': 'Folk tale',
  '讲个典故': 'Classic allusion',
  '成语辨析': 'Idiom',
  '出个对联': 'Couplet',
  '清除记忆…': 'Clear memory…',
  '让它游走（退出）': 'Let it go (exit)',
  '鱼粮账本': 'Token ledger',
  '中文': '中文',
  'English': 'English',
  '自动（按语言选音色）': 'Auto (by language)',
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
  return label
}

export function buildMenu(version: string, state?: { voiceOn?: boolean; earOn?: boolean; voiceChatOn?: boolean; balance?: string; growth?: string }): MenuItem[] {
  const voiceOn = state && state.voiceOn ? true : false
  const earOn = state && state.earOn ? true : false
  const voiceChatOn = state && state.voiceChatOn ? true : false
  const balanceText = (state && state.balance) ? state.balance : '--'
  const growthText = (state && state.growth) ? state.growth : '--'
  return [
    { type: 'item', label: '喂它一口', action: 'feed' },
    { type: 'item', label: '看张图…', action: 'vision' },
    { type: 'sep' },
    { type: 'sub', label: '弹首曲子 ▸', items: MELODIES.map((m) => ({ type: 'item' as const, label: '弹《' + m + '》', action: 'music:' + m })) },
    { type: 'item', label: '停止弹奏', action: 'music-stop' },
    { type: 'sep' },
    { type: 'item', label: '打字说两句', action: 'type' },
    { type: 'item', label: voiceOn ? '语音朗读：开' : '语音朗读：关', action: 'voice' },
    { type: 'item', label: '停止说话', action: 'tts-stop' },
    { type: 'sub', label: '换个声音 ▸', items: [
      { type: 'item', label: '自动（按语言选音色）', action: 'voice:auto' },
      { type: 'item', label: '音色：晓伊（中·女）', action: 'voice:zh-CN-XiaoyiNeural' },
      { type: 'item', label: '音色：晓晓（中·女）', action: 'voice:zh-CN-XiaoxiaoNeural' },
      { type: 'item', label: '音色：晓辰（中·女）', action: 'voice:zh-CN-XiaochenNeural' },
      { type: 'item', label: '音色：云希（中·男）', action: 'voice:zh-CN-YunxiNeural' },
      { type: 'item', label: '音色：云扬（中·男）', action: 'voice:zh-CN-YunyangNeural' },
      { type: 'item', label: '音色：Ana（英·女）', action: 'voice:en-US-AnaNeural' },
      { type: 'item', label: '音色：Jenny（英·女）', action: 'voice:en-US-JennyNeural' },
      { type: 'item', label: '音色：Sonia（英·女·英式）', action: 'voice:en-GB-SoniaNeural' },
    ] },
    { type: 'sub', label: '聊天语言 ▸', items: [
      { type: 'item', label: '中文', action: 'chat-lang:zh' },
      { type: 'item', label: 'English', action: 'chat-lang:en' },
    ] },
    { type: 'sub', label: '界面语言 ▸', items: [
      { type: 'item', label: '中文', action: 'lang:zh' },
      { type: 'item', label: 'English', action: 'lang:en' },
    ] },
    { type: 'sep' },
    { type: 'item', label: '语音待命：' + (earOn ? '开' : '关'), action: 'wake' },
    { type: 'item', label: '语音聊天：' + (voiceChatOn ? '开' : '关'), action: 'chatmode' },
    
    { type: 'item', label: '停下歇会儿', action: 'pause' },
    { type: 'item', label: '回到右下角', action: 'home' },
    { type: 'item', label: '长大一点', action: 'bigger' },
    { type: 'item', label: '变小一点', action: 'smaller' },
    { type: 'sep' },
    { type: 'item', label: '加个提醒…', action: 'remind-add' },
    { type: 'item', label: '提醒清单…', action: 'remind-list' },
    { type: 'sep' },
    { type: 'sub', label: '文化气 ▸', items: [
      { type: 'item', label: '说书（连载）', action: 'culture-story' },
      { type: 'item', label: '接着说', action: 'culture-story-next' },
      { type: 'item', label: '念首诗', action: 'poem' },
      { type: 'item', label: '讲个民间故事', action: 'culture-tale' },
      { type: 'item', label: '讲个典故', action: 'culture-allusion' },
      { type: 'item', label: '成语辨析', action: 'culture-idiom' },
      { type: 'item', label: '出个对联', action: 'culture-couplet' },
    ] },
    { type: 'item', label: '清除记忆…', action: 'clear-memory' },
    { type: 'item', label: '让它游走（退出）', action: 'hide' },
    { type: 'sep' },
    { type: 'item', label: '余额：' + balanceText, action: 'balance' },
    { type: 'item', label: '鱼粮账本', action: 'fishfood' },
    { type: 'item', label: '成长：' + growthText, action: 'growth' },
    { type: 'item', label: '版本：v' + version, action: 'version' },
  ]
}
