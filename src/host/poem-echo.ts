/**
 * host/poem-echo.ts —— 诗词弹幕：从主人一句话里读出心绪，回一句应景的真诗
 *
 * 用途：肥鲸在对话里听到「坚持」「孤独」「离别」这类主题时，从本地诗库挑一句，
 * 让气泡冒一句「咕噜……『长风破浪会有时』——这句是不是有点像你？」。
 * 这是肥鲸独有的资源：737 首诗 + 17 本古籍，别家桌宠没有。
 *
 * 本模块自己守的三条规矩：
 *   ① 纯函数、零 import。诗句以常量内联，这里绝不读 data/poems.json；
 *      读文件、核诗句真伪只发生在 scripts/test-poem-echo.mjs 里。
 *   ② 诗句逐句摘自 data/poems.json 的 lines 原文（740 首唐诗/宋词/明诗），一字不改、
 *      不拼贴；每条后的 title + author 就是出处。
 *   ③ 不掷骰子、不看钟。命中后按「主题字符哈希 + 文本长度」对池大小取模轮换，
 *      同一句话永远得到同一句诗（可复现、可测试）。
 *
 * 匹配口径：
 *   · 文本先 trim；空白文本 / 非字符串一律返回 null。
 *   · 文本里「包含」任一触发词即命中该主题；多个主题同时命中时取【触发词字数最长】的那个，
 *     所以「喜欢一个人」走「一个人」（孤独），不会被「喜欢」（相思）抢走。
 *   · 触发词等长时按本表书写顺序先到先得（表顺序即优先级，如「努力奋斗」算坚持）。
 *
 * 主题取舍：规格里的「离别酒」（送别 / 饯行 / 践行）单独立表，没有并进「离别」——
 * 两者诗句池不重叠，阳关、金陵酒肆、雨霖铃这几句更适合送别那一口酒单独回。
 */

/** 一次诗词弹幕：主题 + 诗句 + 出处（title/author 即诗题与作者） */
export type PoemEcho = { theme: string; line: string; title: string; author: string }

/** 池里的一句诗（tooltip 之外不再加工，故 line 就是原句整行） */
type EchoLine = { line: string; title: string; author: string }

/** 一个主题：触发词 + 诗句池 */
type EchoPool = { words: readonly string[]; lines: readonly EchoLine[] }

/** 递归冻结：表、池、数组、条目全冻上，调用方 push / 改值一律抛错 */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

/** 主题名 → 诗句池（24 个主题，共 79 句；诗句均取自 data/poems.json 原文） */
export const POEM_ECHO_TABLE: Readonly<Record<string, EchoPool>> = deepFreeze({
  // 往事 —— 虞美人·春花秋月何时了（李煜）· 浪淘沙·往事只堪哀（李煜）
  '往事': {
    words: ['往事', '故国', '春花秋月', '一晌贪欢', '朱颜改', '天上人间'],
    lines: [
      { line: '春花秋月何时了，往事知多少。', title: '虞美人·春花秋月何时了', author: '李煜' },
      { line: '雕栏玉砌应犹在，只是朱颜改。', title: '虞美人·春花秋月何时了', author: '李煜' },
      { line: '流水落花春去也，天上人间。', title: '浪淘沙令·帘外雨潺潺', author: '李煜' },
      { line: '往事只堪哀，对景难排。', title: '浪淘沙·往事只堪哀', author: '李煜' },
    ],
  },
  // 清秋 —— 相见欢·无言独上西楼（李煜）
  '清秋': {
    words: ['清秋'],
    lines: [
      { line: '无言独上西楼，月如钩。寂寞梧桐深院锁清秋。', title: '相见欢·无言独上西楼', author: '李煜' },
    ],
  },
  // 秋愁 —— 长恨歌（白居易）· 鹧鸪天（周紫芝）· 长信怨（王昌龄）· 秋登宣城谢朓北楼（李白）
  '秋愁': {
    words: ['梧桐', '秋雨', '细雨', '离愁', '秋风'],
    lines: [
      { line: '春风桃李花开日，秋雨梧桐叶落时。', title: '长恨歌', author: '白居易' },
      { line: '梧桐叶上三更雨，叶叶声声是别离。', title: '鹧鸪天', author: '周紫芝' },
      { line: '金井梧桐秋叶黄，珠帘不卷夜来霜。', title: '长信怨', author: '王昌龄' },
      { line: '人烟寒橘柚，秋色老梧桐。', title: '秋登宣城谢朓北楼', author: '李白' },
    ],
  },
  // 羁旅 —— 天净沙·秋思（马致远）
  '羁旅': {
    words: ['昏鸦', '枯藤', '古道', '瘦马', '断肠', '天涯', '羁旅', '漂泊', '秋思'],
    lines: [
      { line: '枯藤老树昏鸦，小桥流水人家，古道西风瘦马。', title: '天净沙·秋思', author: '马致远' },
      { line: '夕阳西下，断肠人在天涯。', title: '天净沙·秋思', author: '马致远' },
      { line: '梦里不知身是客，一晌贪欢。', title: '浪淘沙令·帘外雨潺潺', author: '李煜' },
    ],
  },
  // 坚持 —— 行路难三首一（李白）· 感遇十二首七（张九龄）· 老将行（王维）
  '坚持': {
    words: ['坚持', '努力', '不放弃', '加油', '扛住', '撑住', '熬', '顶住'],
    lines: [
      { line: '长风破浪会有时，直挂云帆济沧海。', title: '行路难三首一', author: '李白' },
      { line: '岂伊地气暖，自有岁寒心。', title: '感遇十二首七', author: '张九龄' },
      { line: '莫嫌旧日云中守，犹堪一战取功勋。', title: '老将行', author: '王维' },
    ],
  },
  // 孤独 —— 江雪（柳宗元）· 竹里馆（王维）· 月下独酌四首一（李白）· 独坐敬亭山（李白）
  '孤独': {
    words: ['孤独', '一个人', '寂寞', '无人'],
    lines: [
      { line: '孤舟蓑笠翁，独钓寒江雪。', title: '江雪', author: '柳宗元' },
      { line: '独坐幽篁里，弹琴复长啸。', title: '竹里馆', author: '王维' },
      { line: '举杯邀明月，对影成三人。', title: '月下独酌四首一', author: '李白' },
      { line: '众鸟高飞尽，孤云独去闲。', title: '独坐敬亭山', author: '李白' },
    ],
  },
  // 离别 —— 杜少府之任蜀州（王勃）· 无题·相见时难别亦难（李商隐）· 黄鹤楼送孟浩然之广陵（李白）
  '离别': {
    words: ['离别', '分开', '告别', '离开', '分手'],
    lines: [
      { line: '无为在歧路，儿女共沾巾。', title: '杜少府之任蜀州', author: '王勃' },
      { line: '相见时难别亦难，东风无力百花残。', title: '无题·相见时难别亦难', author: '李商隐' },
      { line: '故人西辞黄鹤楼，烟花三月下扬州。', title: '黄鹤楼送孟浩然之广陵', author: '李白' },
      { line: '独自莫凭栏，无限江山，别时容易见时难。', title: '浪淘沙令·帘外雨潺潺', author: '李煜' },
    ],
  },
  // 思乡 —— 静夜思（李白）· 九月九日忆山东兄弟（王维）· 月夜忆舍弟（杜甫）· 次北固山下（王湾）
  '思乡': {
    words: ['思乡', '想家', '故乡', '家乡'],
    lines: [
      { line: '举头望明月，低头思故乡。', title: '静夜思', author: '李白' },
      { line: '独在异乡为异客，每逢佳节倍思亲。', title: '九月九日忆山东兄弟', author: '王维' },
      { line: '露从今夜白，月是故乡明。', title: '月夜忆舍弟', author: '杜甫' },
      { line: '乡书何处达，归雁洛阳边。', title: '次北固山下', author: '王湾' },
    ],
  },
  // 友情 —— 杜少府之任蜀州（王勃）· 送友人（李白）· 云阳馆与韩绅宿别（司空曙）
  '友情': {
    words: ['朋友', '友情', '兄弟', '知己'],
    lines: [
      { line: '海内存知己，天涯若比邻。', title: '杜少府之任蜀州', author: '王勃' },
      { line: '浮云游子意，落日故人情。', title: '送友人', author: '李白' },
      { line: '故人江海别，几度隔山川。', title: '云阳馆与韩绅宿别', author: '司空曙' },
    ],
  },
  // 豁达 —— 将进酒（李白）· 水调歌头（苏轼）· 晚楼闲坐（王安石）· 九日蓝田崔氏庄（杜甫）
  '豁达': {
    words: ['豁达', '看开', '放下', '无所谓', '随缘'],
    lines: [
      { line: '人生得意须尽欢，莫使金樽空对月。', title: '将进酒', author: '李白' },
      { line: '但愿人长久，千里共婵娟。', title: '水调歌头', author: '苏轼' },
      { line: '清风明月无人管，并作南来一味凉。', title: '晚楼闲坐', author: '王安石' },
      { line: '老去悲秋强自宽，兴来今日尽君欢。', title: '九日蓝田崔氏庄', author: '杜甫' },
    ],
  },
  // 时光 —— 金缕衣（不详）· 满江红（岳飞）· 锦瑟（李商隐）· 送魏万之京（李颀）
  '时光': {
    words: ['时光', '时间', '老了', '岁月', '青春', '春红', '太匆匆'],
    lines: [
      { line: '劝君莫惜金缕衣，劝君惜取少年时。', title: '金缕衣', author: '不详' },
      { line: '莫等闲、白了少年头，空悲切。', title: '满江红', author: '岳飞' },
      { line: '林花谢了春红，太匆匆。', title: '乌夜啼·林花谢了春红', author: '李煜' },
      { line: '锦瑟无端五十弦，一弦一柱思华年。', title: '锦瑟', author: '李商隐' },
      { line: '莫见长安行乐处，空令岁月易蹉跎。', title: '送魏万之京', author: '李颀' },
    ],
  },
  // 奋斗 —— 将进酒（李白）· 望岳（杜甫）· 望蓟门（祖咏）
  '奋斗': {
    words: ['奋斗', '拼搏', '打拼', '事业'],
    lines: [
      { line: '天生我材必有用，千金散尽还复来。', title: '将进酒', author: '李白' },
      { line: '会当凌绝顶，一览众山小。', title: '望岳', author: '杜甫' },
      { line: '少小虽非投笔吏，论功还欲请长缨。', title: '望蓟门', author: '祖咏' },
    ],
  },
  // 失败 —— 蜀相（杜甫）· 八阵图（杜甫）· 老将行（王维）
  '失败': {
    words: ['失败', '输了', '搞砸', '完蛋'],
    lines: [
      { line: '出师未捷身先死，长使英雄泪满襟。', title: '蜀相', author: '杜甫' },
      { line: '江流石不转，遗恨失吞吴。', title: '八阵图', author: '杜甫' },
      { line: '卫青不败由天幸，李广无功缘数奇。', title: '老将行', author: '王维' },
    ],
  },
  // 读书 —— 观书有感（其一）（朱熹）· 泛舟（朱熹）· 清明（王禹偁）· 暮春即事（叶采）
  '读书': {
    words: ['读书', '学习', '看书', '考试'],
    lines: [
      { line: '问渠那得清如许，为有源头活水来。', title: '观书有感（其一）', author: '朱熹' },
      { line: '向来枉费推移力，此日中流自在行。', title: '泛舟', author: '朱熹' },
      { line: '昨日邻家乞新火，晓窗分与读书灯。', title: '清明', author: '王禹偁' },
      { line: '闲坐小窗读周易，不知春去几多时。', title: '暮春即事', author: '叶采' },
    ],
  },
  // 烦恼 —— 宣州谢朓楼饯别校书叔云（李白）· 声声慢·寻寻觅觅（李清照）· 秋浦歌（李白）
  '烦恼': {
    words: ['烦恼', '烦', '焦虑', '压力', '郁闷'],
    lines: [
      { line: '抽刀断水水更流，举杯销愁愁更愁。', title: '宣州谢朓楼饯别校书叔云', author: '李白' },
      { line: '问君能有几多愁，恰似一江春水向东流。', title: '虞美人·春花秋月何时了', author: '李煜' },
      { line: '这次第，怎一个愁字了得！', title: '声声慢·寻寻觅觅', author: '李清照' },
      { line: '白发三千丈，缘愁似个长。', title: '秋浦歌', author: '李白' },
    ],
  },
  // 快乐 —— 闻官军收河南河北（杜甫）两联
  '快乐': {
    words: ['快乐', '开心', '高兴', '爽'],
    lines: [
      { line: '白日放歌须纵酒，青春作伴好还乡。', title: '闻官军收河南河北', author: '杜甫' },
      { line: '却看妻子愁何在，漫卷诗书喜欲狂。', title: '闻官军收河南河北', author: '杜甫' },
    ],
  },
  // 勇气 —— 凉州词（王翰）· 易水送别（骆宾王）· 答五陵太守（王昌龄）
  '勇气': {
    words: ['勇气', '勇敢', '怕', '恐惧'],
    lines: [
      { line: '醉卧沙场君莫笑，古来征战几人回？', title: '凉州词', author: '王翰' },
      { line: '此地别燕丹，壮士发冲冠。', title: '易水送别', author: '骆宾王' },
      { line: '仗剑行千里，微躯敢一言。', title: '答五陵太守', author: '王昌龄' },
    ],
  },
  // 归隐 —— 终南别业（王维）· 临江仙（苏轼）· 辋川闲居赠裴秀才迪（王维）· 过故人庄（孟浩然）
  '归隐': {
    words: ['归隐', '躺平', '退休', '清静'],
    lines: [
      { line: '行到水穷处，坐看云起时。', title: '终南别业', author: '王维' },
      { line: '小舟从此逝，江海寄余生。', title: '临江仙', author: '苏轼' },
      { line: '倚杖柴门外，临风听暮蝉。', title: '辋川闲居赠裴秀才迪', author: '王维' },
      { line: '开筵面场圃，把酒话桑麻。', title: '过故人庄', author: '孟浩然' },
    ],
  },
  // 山水 —— 早发白帝城（李白）· 登鹳雀楼（王之涣）· 饮湖上初晴后雨（苏轼）· 山居秋暝（王维）
  '山水': {
    words: ['山水', '风景', '旅游', '旅行'],
    lines: [
      { line: '两岸猿声啼不住，轻舟已过万重山。', title: '早发白帝城', author: '李白' },
      { line: '白日依山尽，黄河入海流。', title: '登鹳雀楼', author: '王之涣' },
      { line: '水光潋滟晴方好，山色空蒙雨亦奇。', title: '饮湖上初晴后雨', author: '苏轼' },
      { line: '明月松间照，清泉石上流。', title: '山居秋暝', author: '王维' },
    ],
  },
  // 明月 —— 望月怀远（张九龄）· 水调歌头（苏轼）· 枫桥夜泊（张继）· 静夜思（李白）
  '明月': {
    words: ['月亮', '明月', '月光'],
    lines: [
      { line: '海上生明月，天涯共此时。', title: '望月怀远', author: '张九龄' },
      { line: '明月几时有，把酒问青天。', title: '水调歌头', author: '苏轼' },
      { line: '月落乌啼霜满天，江枫渔火对愁眠。', title: '枫桥夜泊', author: '张继' },
      { line: '床前明月光，疑是地上霜。', title: '静夜思', author: '李白' },
    ],
  },
  // 酒 —— 凉州词（王翰）· 月下独酌四首一（李白）· 清明（杜牧）
  '酒': {
    words: ['喝酒', '酒', '醉了'],
    lines: [
      { line: '葡萄美酒夜光杯，欲饮琵琶马上催。', title: '凉州词', author: '王翰' },
      { line: '花间一壶酒，独酌无相亲。', title: '月下独酌四首一', author: '李白' },
      { line: '借问酒家何处有，牧童遥指杏花村。', title: '清明', author: '杜牧' },
    ],
  },
  // 雨 —— 清明（杜牧）· 初春小雨（韩愈）· 绝句（僧志南）
  '雨': {
    words: ['下雨', '雨', '阴天'],
    lines: [
      { line: '清明时节雨纷纷，路上行人欲断魂。', title: '清明', author: '杜牧' },
      { line: '天街小雨润如酥，草色遥看近却无。', title: '初春小雨', author: '韩愈' },
      { line: '帘外雨潺潺，春意阑珊。', title: '浪淘沙令·帘外雨潺潺', author: '李煜' },
      { line: '沾衣欲湿杏花雨，吹面不寒杨柳风。', title: '绝句', author: '僧志南' },
    ],
  },
  // 雪 —— 江雪（柳宗元）· 绝句（杜甫）· 问刘十九（白居易）
  '雪': {
    words: ['下雪', '雪', '冬天'],
    lines: [
      { line: '千山鸟飞绝，万径人踪灭。', title: '江雪', author: '柳宗元' },
      { line: '窗含西岭千秋雪，门泊东吴万里船。', title: '绝句', author: '杜甫' },
      { line: '晚来天欲雪，能饮一杯无。', title: '问刘十九', author: '白居易' },
    ],
  },
  // 春天 —— 春晓（孟浩然）· 春日（朱熹）· 江南春（杜牧）
  '春天': {
    words: ['春天', '花开', '踏青'],
    lines: [
      { line: '春眠不觉晓，处处闻啼鸟。', title: '春晓', author: '孟浩然' },
      { line: '等闲识得东风面，万紫千红总是春。', title: '春日', author: '朱熹' },
      { line: '千里莺啼绿映红，水村山郭酒旗风。', title: '江南春', author: '杜牧' },
    ],
  },
  // 秋天 —— 山居秋暝（王维）· 秋夕（杜牧）· 秋登宣城谢朓北楼（李白）
  '秋天': {
    words: ['秋天', '落叶', '秋'],
    lines: [
      { line: '空山新雨后，天气晚来秋。', title: '山居秋暝', author: '王维' },
      { line: '银烛秋光冷画屏，轻罗小扇扑流萤。', title: '秋夕', author: '杜牧' },
      { line: '人烟寒橘柚，秋色老梧桐。', title: '秋登宣城谢朓北楼', author: '李白' },
    ],
  },
  // 夜晚 —— 月夜（刘方平）· 夜雨寄北（李商隐）· 长相思·其一（李白）
  '夜晚': {
    words: ['晚上', '深夜', '失眠', '睡不着'],
    lines: [
      { line: '更深月色半人家，北斗阑干南斗斜。', title: '月夜', author: '刘方平' },
      { line: '何当共剪西窗烛，却话巴山夜雨时。', title: '夜雨寄北', author: '李商隐' },
      { line: '孤灯不明思欲绝，卷帷望月空长叹。', title: '长相思·其一', author: '李白' },
    ],
  },
  // 相思 —— 卜算子（李之仪）· 无题·昨夜星辰昨夜风（李商隐）· 无题·相见时难别亦难（李商隐）
  '相思': {
    words: ['想念', '思念', '相思', '喜欢'],
    lines: [
      { line: '只愿君心似我心，定不负相思意。', title: '卜算子', author: '李之仪' },
      { line: '身无彩凤双飞翼，心有灵犀一点通。', title: '无题·昨夜星辰昨夜风', author: '李商隐' },
      { line: '春蚕到死丝方尽，蜡炬成灰泪始干。', title: '无题·相见时难别亦难', author: '李商隐' },
    ],
  },
  // 离别酒 —— 送元二使安西（王维）· 金陵酒肆留别（李白）· 雨霖铃（柳永）
  '离别酒': {
    words: ['送别', '饯行', '践行'],
    lines: [
      { line: '劝君更尽一杯酒，西出阳关无故人。', title: '送元二使安西', author: '王维' },
      { line: '金陵子弟来相送，欲行不行各尽觞。', title: '金陵酒肆留别', author: '李白' },
      { line: '执手相看泪眼，竟无语凝噎。', title: '雨霖铃', author: '柳永' },
    ],
  },
})

/** 主题名（表内书写顺序 = 等长触发词时的优先级） */
export const POEM_ECHO_THEMES: readonly string[] = Object.freeze(Object.keys(POEM_ECHO_TABLE))

/**
 * 主题字符哈希（逐码点、31 进制、无符号 32 位）。
 * 只用来把不同主题错开轮换起点，不承担任何安全职责。
 */
function themeHash(theme: string): number {
  let h = 0
  for (const ch of theme) h = (h * 31 + (ch.codePointAt(0) || 0)) >>> 0
  return h
}

/**
 * 从一句话里认出主题，回一句应景的诗；认不出就 null。
 *
 * 纯函数：不读文件、不联网、不掷骰子、不看钟。
 * 轮换公式固定为 (主题哈希 + trim 后文本长度) % 诗句池大小，同一句话永远同一句诗。
 */
export function matchPoem(text: string): PoemEcho | null {
  // ① 没有文本就没有弹幕：非字符串、空串、纯空白一律 null
  if (typeof text !== 'string') return null
  const src = text.trim()
  if (!src) return null

  // ② 找主题：触发词最长者胜；等长时按表顺序先到先得
  let theme = ''
  let longest = 0
  let hitWord = ''
  for (const name of POEM_ECHO_THEMES) {
    for (const word of POEM_ECHO_TABLE[name].words) {
      if (word.length > longest && src.includes(word)) {
        theme = name
        longest = word.length
        hitWord = word
      }
    }
  }
  if (!theme) return null

  // ③ 先点题：池里有诗句包含命中的触发词，就优先那句（如「春红」→「林花谢了春红，太匆匆」）；
  //    没有包含的才按确定性轮换（主题哈希 + 文本长度）取模。
  const pool = POEM_ECHO_TABLE[theme].lines
  const exact = hitWord ? pool.find((p) => p.line.includes(hitWord)) : undefined
  const picked = exact || pool[(themeHash(theme) + src.length) % pool.length]
  return { theme, line: picked.line, title: picked.title, author: picked.author }
}
