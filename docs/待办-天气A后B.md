# 天气能力：先 A（本地 wttr.in）后 B（官方 web_search）

决策（2026-11-14，主人定）：**先 A，后面 B，记着。**

## A（已落地，2026-11-14）

- 目的：聊天里问「上海今天天气怎么样」能答，不再说「看不到外面的天」。
- 做法：
  1. 宿主新增 `GET /api/chubby-whale/weather?city=<城市>`：调 `https://wttr.in/<city>?format=j1&lang=zh-cn`（6s 超时），取 `current_condition[0]` 的 `temp_C`/`FeelsLikeC`/中文 `lang_zh-cn` 描述/`humidity`/`windspeedKmph`，拼一行中文；失败返回 `{ok:false}`。同城 10 分钟内存缓存（wttr.in 高频会限流回纯文本）。
  2. 客户端 `chat-route.ts` 在「问句一律交给模型」之前加天气意图（规则在 `client/weather-ask.ts`）：命中 `天气|气温|温度|多少度|几度` 且 ≤30 字 → 抽城市（剥 今天/现在/的/怎么样 等填充词）；没城市默认「北海」。
  3. 命中后：`getJson('/weather?city=…')` → 气泡 + 朗读；按温度/描述给一句穿衣提醒（只基于查到的事实）。
- 复用：`host/weather.ts` 的 wttr.in 清洗逻辑（单行、去控件字符、剥「待办/提醒」、40 字上限），`/briefing` 与 `/weather` 共用。
- 验收（已跑）：`scripts/test-weather.mjs` 54 项全过；真实外呼由部署后实测另行记录；「天气晚来秋」「我喜欢这样的天气」「今天天气不错」不劫持；查不到时明确说「天气没查到」。
- 成本：免费；只在命中天气意图时外呼。

## B（已落地：菜单「联网搜索」，默认关）

- 她的聊天请求可开启 `deepseek_web_search` + `deepseek_read_url`（只支持 `deepseek-flash`）；问答范围不再限于天气，任意实时问题都能查并附来源。
- 开关：右键菜单「联网搜索：开/关」，默认**关**（省钱）；打开后 `/chat` 带 `web:true`，走非流式并在末尾附来源。
- 成本 5 元/1000 次成功请求（搜索与抓取各计），已计入鱼粮账本；A 保留为免费兜底（wttr.in 天气，不受开关影响）。
