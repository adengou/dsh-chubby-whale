/**
 * client/duilian.ts —— 经典对联库（由 data/duilian.json 生成，公版；出处确切者署来源）
 */
export interface Couplet { upper: string; lower: string; source: string; cat: string }

export const COUPLETS: Couplet[] = [
  {
    "upper": "风声雨声读书声，声声入耳",
    "lower": "家事国事天下事，事事关心",
    "source": "明·顾宪成题无锡东林书院",
    "cat": "书院"
  },
  {
    "upper": "海纳百川，有容乃大",
    "lower": "壁立千仞，无欲则刚",
    "source": "清·林则徐自题联",
    "cat": "格言"
  },
  {
    "upper": "室雅何须大",
    "lower": "花香不在多",
    "source": "清·郑板桥",
    "cat": "格言"
  },
  {
    "upper": "删繁就简三秋树",
    "lower": "领异标新二月花",
    "source": "清·郑板桥",
    "cat": "格言"
  },
  {
    "upper": "墙上芦苇，头重脚轻根底浅",
    "lower": "山间竹笋，嘴尖皮厚腹中空",
    "source": "相传为明·解缙作",
    "cat": "谐趣"
  },
  {
    "upper": "铁肩担道义",
    "lower": "妙手著文章",
    "source": "李大钊《晨钟报》创刊号（1916）",
    "cat": "格言"
  },
  {
    "upper": "四面荷花三面柳",
    "lower": "一城山色半城湖",
    "source": "清·刘凤诰题济南大明湖铁公祠",
    "cat": "名胜"
  },
  {
    "upper": "青山有幸埋忠骨",
    "lower": "白铁无辜铸佞臣",
    "source": "杭州岳王庙墓阙联（传统）",
    "cat": "名胜"
  },
  {
    "upper": "一粥一饭，当思来处不易",
    "lower": "半丝半缕，恒念物力维艰",
    "source": "明末清初·朱柏庐《治家格言》",
    "cat": "格言"
  },
  {
    "upper": "读书好，耕田好，学好便好",
    "lower": "创业难，守成难，知难不难",
    "source": "清·吴敬梓《儒林外史》第二十二回",
    "cat": "格言"
  },
  {
    "upper": "春风大雅能容物",
    "lower": "秋水文章不染尘",
    "source": "清·邓石如",
    "cat": "格言"
  },
  {
    "upper": "雨过琴书润",
    "lower": "风来翰墨香",
    "source": "传统书房联",
    "cat": "书房"
  },
  {
    "upper": "大肚能容，容天下难容之事",
    "lower": "开口便笑，笑世间可笑之人",
    "source": "传统弥勒佛联",
    "cat": "谐趣"
  },
  {
    "upper": "天增岁月人增寿",
    "lower": "春满乾坤福满门",
    "source": "传统春联",
    "cat": "春联"
  },
  {
    "upper": "一元复始",
    "lower": "万象更新",
    "source": "传统春联",
    "cat": "春联"
  },
  {
    "upper": "春回大地",
    "lower": "福满人间",
    "source": "传统春联",
    "cat": "春联"
  },
  {
    "upper": "门迎百福",
    "lower": "户纳千祥",
    "source": "传统春联",
    "cat": "春联"
  },
  {
    "upper": "五湖四海皆春色",
    "lower": "万水千山尽得辉",
    "source": "传统春联",
    "cat": "春联"
  },
  {
    "upper": "松竹梅岁寒三友",
    "lower": "桃李杏春风一家",
    "source": "传统",
    "cat": "格言"
  },
  {
    "upper": "福如东海长流水",
    "lower": "寿比南山不老松",
    "source": "传统寿联",
    "cat": "寿联"
  },
  {
    "upper": "客上天然居",
    "lower": "居然天上客",
    "source": "传统回文联（顺读倒读同句）",
    "cat": "谐趣"
  },
  {
    "upper": "画上荷花和尚画",
    "lower": "书临汉帖翰林书",
    "source": "传统回文联",
    "cat": "谐趣"
  },
  {
    "upper": "因荷而得藕",
    "lower": "有杏不须梅",
    "source": "传统谐音联（荷=何、藕=偶；杏=幸、梅=媒）",
    "cat": "谐趣"
  },
  {
    "upper": "两舟并行，橹速不如帆快",
    "lower": "八音齐奏，笛清难比箫和",
    "source": "传统谐音联（橹速=鲁肃、帆快=樊哙；笛清=狄青、箫和=萧何）",
    "cat": "谐趣"
  },
  {
    "upper": "南通州，北通州，南北通州通南北",
    "lower": "东当铺，西当铺，东西当铺当东西",
    "source": "传统地名联",
    "cat": "谐趣"
  },
  {
    "upper": "天作棋盘星作子，谁人敢下",
    "lower": "地为琵琶路为弦，哪个能弹",
    "source": "传统（民间流传）",
    "cat": "谐趣"
  },
  {
    "upper": "墙上画马不能骑",
    "lower": "镜里烧饼难充饥",
    "source": "传统（民间俗联）",
    "cat": "谐趣"
  },
  {
    "upper": "水清石出鱼可数",
    "lower": "林深无人鸟相呼",
    "source": "宋·苏轼诗句（成联欣赏）",
    "cat": "景观"
  },
  {
    "upper": "青山不墨千秋画",
    "lower": "流水无弦万古琴",
    "source": "传统（流传甚广，作者待考）",
    "cat": "景观"
  },
  {
    "upper": "云带钟声穿树去",
    "lower": "月移塔影过江来",
    "source": "传统名胜联",
    "cat": "名胜"
  }
]

/** 随机取一副（可排除指定上联，避免连续重复） */
export function pickCouplet(excludeUpper?: string): Couplet {
  const pool = COUPLETS.length > 1 && excludeUpper ? COUPLETS.filter((c) => c.upper !== excludeUpper) : COUPLETS
  const src = pool.length > 0 ? pool : COUPLETS
  return src[Math.floor(Math.random() * src.length)]
}
