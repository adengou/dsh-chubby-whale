/**
 * client/menu-whale.ts —— 鲸式右键菜单的数据层：只生成「文案 + action」，不渲染、不执行
 *
 * 为什么单独成一层：菜单文案要跟着三个开关状态走，而渲染与动作分发都在主代码里。
 * 把「状态 → 菜单数据」收成一个纯函数，主代码每次右键现算即可，既不用缓存菜单，
 * 也不会出现「菜单显示开着、实际已经关掉」这类对不上的情况。
 *
 * 本文件的边界（与职责严格对齐）：
 *   · 零依赖零副作用：不碰浏览器环境（存储 / DOM / 全局对象），不读时钟、不联网、不弹提示；
 *   · 同样输入永远同样输出，而且每次返回全新对象 —— 调用方改了返回值也污染不到下一次；
 *   · 只产出数据：不渲染界面，也不执行 action；action 一律取自已注册的动作表，绝不现造 id。
 */

export type WhaleMenuState = { voiceOn: boolean; earOn: boolean; voiceChatOn: boolean }
export type WhaleMenuItem = { label: string; action: string } | { sep: true } | { sub: string; items: WhaleMenuItem[] }

/** 动作条目的构造器：label 与 action 成对出现，表里就不会漏字段 */
function act(label: string, action: string): WhaleMenuItem { return { label, action } }

/**
 * 二级分组：允许分层，但最多一层 —— 右键菜单再往下点就成了迷宫；
 * 鲸式花名只放在条目上，分组标题保持一眼能懂。
 */
function group(title: string, items: WhaleMenuItem[]): WhaleMenuItem { return { sub: title, items } }

/** 分隔线每次新建：复用同一个对象会让「每次返回全新数据」的承诺落空 */
function sep(): WhaleMenuItem { return { sep: true } }

/**
 * 开关条目的文案模板：鲸式叫法 + 括号里的功能名 + 当前状态。
 * 把状态直接写进文案而不是靠勾选标记，是因为右键菜单常在弹出后顺手一点就走，
 * 没有机会先看别的指示器。
 */
function toggle(on: boolean, whaleOn: string, whaleOff: string, func: string): string {
  return (on ? whaleOn : whaleOff) + '（' + func + '：' + (on ? '开' : '关') + '）'
}

/**
 * 右键菜单的完整数据。
 * 顺序按「先说话、再看内容、然后干活、喂饭、换皮、最后系统」排：
 * 越常用越靠上；quit 这类重动作压到最后，减少误点。
 */
export function buildWhaleMenu(state: WhaleMenuState): WhaleMenuItem[] {
  return [
    group('说话 ▸', [
      act(toggle(state.voiceOn, '鲸口已开', '鲸口闭着', '语音朗读'), 'voice'),
      act(toggle(state.earOn, '鲸耳竖着', '鲸耳耷拉', '语音待命'), 'ear'),
      act(toggle(state.voiceChatOn, '鲸言在线', '鲸言静默', '语音聊天'), 'voice-chat'),
      act('检查鱼鳃（语音自检）', 'test-tts'),
    ]),
    sep(),
    group('内容 ▸', [
      act('让她念首诗（念诗）', 'poem'),
      act('翻翻书堆（选本书）', 'story-books'),
      act('接着往下讲（自动续讲）', 'story-auto'),
      act('听她说句好话（今日一句）', 'daily-line'),
      act('听听今天的动静（今日简报）', 'briefing-card'),
    ]),
    sep(),
    // 需求里的「工作」组：用「干活」保持鲸鱼娘口吻，功能名逐条写在括号里
    group('干活 ▸', [
      act('把稿子念成音频（语音导出）', 'voice-export'),
      act('帮你挑挑错字（公文校对）', 'proofread'),
      act('记个钟点（加提醒）', 'remind-add'),
      act('鲸落（导出记忆胶囊）', 'capsule-export'),
      act('接住漂来的鲸（导入胶囊）', 'capsule-import'),
    ]),
    sep(),
    act('喂点数据（鱼粮账本）', 'fishfood'),
    sep(),
    group('皮肤 ▸', [
      act('鲸身定住（固定背景）', 'skin-fixed'),
      act('游回原来的水（恢复默认背景）', 'skin-bg-reset'),
    ]),
    sep(),
    group('系统 ▸', [
      act('忘掉这些（清除记忆）', 'clear-memory'),
      act('哄睡（让它游走）', 'quit'),
    ]),
  ]
}
