/**
 * client/menu.ts —— 菜单数据（1:1 复刻 dsh-fish-pet 的 menu.ps1，含中英双语）
 */
export type MenuItem =
  | { type: 'item'; label: string; action: string; note?: string }
  | { type: 'sep' }
  | { type: 'sub'; label: string; items: MenuItem[] }

export const MELODIES = ['小星星', '两只老虎', '生日快乐', '欢乐颂', '铃儿响叮当', '伦敦大桥', '斯卡布罗集市', '思君黯然', '绿袖子', '致爱丽丝', '友谊天长地久']

// 中 -> 英 字典（菜单界面）
export const EN_MAP: Record<string, string> = {
  '喂它一口': 'Feed it',
  '弹首曲子 ▸': 'Play a song ▸',
  '停止弹奏': 'Stop music',
  '打字说两句': 'Type a message',
  '语音朗读：开': 'Voice output: on',
  '换个声音 ▸': 'Change voice ▸',
  '聊天语言 ▸': 'Chat language ▸',
  '界面语言 ▸': 'Interface language ▸',
  '语音待命：开': 'Voice standby: on',
  '语音聊天：开': 'Voice chat: on',
  '余额：--': 'Balance: --',
  '停下歇会儿': 'Take a break',
  '回到右下角': 'Back to corner',
  '长大一点': 'Grow bigger',
  '变小一点': 'Shrink',
  '今日简报：开': 'Daily briefing: on',
  '现在简报一次': 'Brief me now',
  '最近简报 ▸': 'Recent briefings ▸',
  '口述公文：开始': 'Dictate: start',
  '交给 DSH 助手…': 'Send to DSH…',
  '加个提醒…': 'Add reminder…',
  '提醒清单…': 'Reminders…',
  '文化气 ▸': 'Culture ▸',
  '说书（连载）': 'Storytelling',
  '讲个民间故事': 'Folk tale',
  '讲个典故': 'Classic allusion',
  '成语辨析': 'Idiom',
  '出个对联': 'Couplet',
  '清除记忆…': 'Clear memory…',
  '让它游走（退出）': 'Let it go (exit)',
  '鱼粮账本': 'Token ledger',
  '成长：--': 'Growth: --',
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
  '暂无简报': 'No briefings yet',
}

export function tr(label: string, lang: string): string {
  if (lang !== 'en') return label
  return EN_MAP[label] || label
}

export function buildMenu(version: string, state?: { voiceOn?: boolean; balance?: string; growth?: string }): MenuItem[] {
  const voiceOn = state && state.voiceOn ? true : false
  const balanceText = (state && state.balance) ? state.balance : '--'
  const growthText = (state && state.growth) ? state.growth : '--'
  return [
    { type: 'item', label: '喂它一口', action: 'feed' },
    { type: 'sep' },
    { type: 'sub', label: '弹首曲子 ▸', items: MELODIES.map((m) => ({ type: 'item' as const, label: '弹《' + m + '》', action: 'music:' + m })) },
    { type: 'item', label: '停止弹奏', action: 'music-stop' },
    { type: 'sep' },
    { type: 'item', label: '打字说两句', action: 'type' },
    { type: 'item', label: voiceOn ? '语音朗读：开' : '语音朗读：关', action: 'voice' },
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
    { type: 'item', label: '语音待命：开', action: 'wake' },
    { type: 'item', label: '语音聊天：开', action: 'chatmode' },
    
    { type: 'item', label: '停下歇会儿', action: 'pause' },
    { type: 'item', label: '回到右下角', action: 'home' },
    { type: 'item', label: '长大一点', action: 'bigger' },
    { type: 'item', label: '变小一点', action: 'smaller' },
    { type: 'sep' },
    { type: 'item', label: '今日简报：开', action: 'briefing' },
    { type: 'item', label: '现在简报一次', action: 'briefing-now' },
    { type: 'sub', label: '最近简报 ▸', items: [
      { type: 'item', label: '暂无简报', action: 'briefing-recent' },
    ] },
    { type: 'sep' },
    { type: 'item', label: '口述公文：开始', action: 'dictate' },
    { type: 'item', label: '交给 DSH 助手…', action: 'dsh' },
    { type: 'item', label: '加个提醒…', action: 'remind-add' },
    { type: 'item', label: '提醒清单…', action: 'remind-list' },
    { type: 'sep' },
    { type: 'sub', label: '文化气 ▸', items: [
      { type: 'item', label: '说书（连载）', action: 'culture-story' },
      { type: 'item', label: '讲个民间故事', action: 'culture-tale' },
      { type: 'item', label: '讲个典故', action: 'culture-allusion' },
      { type: 'item', label: '成语辨析', action: 'culture-idiom' },
      { type: 'item', label: '出个对联', action: 'culture-couplet' },
    ] },
    { type: 'item', label: '清除记忆…', action: 'clear-memory' },
    { type: 'item', label: '让它游走（退出）', action: 'hide' },
    { type: 'sep' },
    { type: 'item', label: '鱼粮账本', action: 'fishfood' },
    { type: 'item', label: '成长：' + growthText, action: 'growth' },
    { type: 'item', label: '版本：v' + version, action: 'version' },
  ]
}
