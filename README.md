# dsh-chubby-whale（肥鲸）

[![license](https://img.shields.io/npm/l/dsh-chubby-whale.svg)](LICENSE)
[![Gitee](https://gitee.com/adengou/dsh-chubby-whale/badge/star.svg?theme=dark)](https://gitee.com/adengou/dsh-chubby-whale)

DSH 网页版桌面宠物：蓝发女仆鲸鱼娘，常驻 harness 页面右下角。可拖拽（带惯性、位置记忆）、会眨眼、能说话、能说书念诗弹琴，也能听懂你说话。

| 渠道 | 地址 |
| --- | --- |
| 主仓库（Gitee） | <https://gitee.com/adengou/dsh-chubby-whale> |
| 更新日志 | [CHANGELOG.md](CHANGELOG.md) |

> 语音待命的信号处理设计与调参：见 [docs/耳朵算法.md](docs/耳朵算法.md)
> 发版规范（只发 Gitee）：见 [docs/发布规范.md](docs/发布规范.md)

## 安装（两种来源任选）

```powershell
# ① 从 Gitee 装（推荐）
dsh plugin --profile web add "git+https://gitee.com/adengou/dsh-chubby-whale.git"

# ② 本地 link（开发调试）
dsh plugin --profile web add "link:C:\Users\<你>\.dsh\plugins\dsh-chubby-whale"

# 装完重启 dsh web
dsh web
```


装完刷新页面即可看到肥鲸。Key 不随包分发，需要自己配：

```jsonc
// ~/.dsh/plugins/dsh-chubby-whale/config.json   （或包安装目录下的 config.json）
{
  "deepseekKey": "sk-...",        // 对话/看图
  "siliconflowKey": "sk-..."      // 语音识别 + 语音合成
}
```

也可用环境变量：`CHUBBY_WHALE_DEEPSEEK_KEY`、`CHUBBY_WHALE_SILICONFLOW_KEY`
（最后才回退到通用名 `DEEPSEEK_API_KEY` / `SILICONFLOW_API_KEY`）。

### 自我进化（可选，都能关）

肥鲸会随成长学一点东西，两个开关默认开启，写进 `config.json` 即可关闭：

| 配置键 | 默认 | 作用 |
| --- | --- | --- |
| `personalityLearning` | `true` | 每 20 次真实回复、且距上次 ≥6 小时，从最近对话里提取主人的**口头禅 / 偏好 / 备注**（各有条数与字数上限；名字、家人、生日、语言规则等**核心设定锁死，永不自动改**） |
| `personalityWriting` | `true` | 每 20 次真实回复、且距上次 ≥24 小时，写一句**≤80 字的「近期心境」**；输出里若出现「我是 / 改名 / 爸爸 / 妈妈 / 生日 / AI」等身份词，**整句丢弃不写盘** |

- 存储：`~/.dsh-chubby-whale/personality.json`（原子写；坏文件自动隔离为 `.bad-<时间戳>`；只保留最近 20 条变更历史）；
- 查看：`GET /api/chubby-whale/personality`；
- 回滚：`POST /api/chubby-whale/personality/revert`（一次撤一条，可连按；也支持回滚「近期心境」）；
- 关掉后**已存内容仍会注入**，只是不再学习、不再写新心境。
### 本地开发（link 方式）

```powershell
dsh plugin --profile web add "link:C:\Users\<你>\.dsh\plugins\dsh-chubby-whale"
```

### 卸载

```powershell
dsh plugin --profile web remove dsh-chubby-whale
```

运行数据在 `~/.dsh-chubby-whale/`（记忆、亲密度、成长、鱼粮、提醒、缓存），卸载插件不会删它。

## 功能

| 分类 | 能力 |
| --- | --- |
| 陪伴 | 立绘常驻右下角、拖拽惯性、位置记忆、自动眨眼、说话时嘴动、喂食冒爱心、情绪表情（🐳待机 / 🍚饿 / 💤困 / ✨兴奋 / 💗害羞 / 💢生气 / 🍙护食） |
| 聊天 | 气泡对话（DeepSeek），人设固定（名字/爸妈/生日/出生地），支持中英双语，长期记忆摘要；**流式与普通路径同口径记账**（亲密度/经验/摘要）；聊天框自动聚焦 |
| 语音 | 文字转语音（9 种音色、可关、可停）、语音待命（常驻听写）、语音聊天开关；时长估算按语种分离（中文按字/英文按词） |
| 文化 | 说书（17 本古籍，念原文、进度记忆、不重复、**进度按数据源隔离**）、念诗（737 首）、典故（261）、成语（834）、民间故事（696）、对联（51 副 11 类）；**选本书 ▸ 书单**、**今日一句**、**今日简报** |
| 音乐 | 11 首曲子 Web Audio 合成播放（含升降号与低/高音） |
| 工具 | 提醒（口语时间：9点 / 明天9点 / 半小时后 / 每天8点；**管理面板**：回数字删除、回 `d` 顺延 10 分钟）、看图、拖文件（图片识别 / 文本总结）、成长与亲密度、鱼粮账本、余额、清除记忆、**数据导出/导入**、**使用统计** |
| 界面 | **界面语言**（中文默认 / 英文）、右键菜单键盘导航（↑↓/Enter/Esc）、「让它游走」可逆（右下角「○」或 Ctrl+Shift+W 恢复）、多标签页各自独立 |

## 目录结构

```
dsh-chubby-whale/
  dist/            编译产物（已提交，安装无需构建）
  src/             源码（TS）
  data/            内容数据（必需，33MB）
    story/         17 本古籍 JSON
    culture/       典故 / 成语 / 民间故事
    poems.json     737 首诗
    melodies.json  11 首曲子
  assets/          立绘
  cordis.patch.yml 插件注册配置
```

## 依赖

| 依赖 | 用途 | 必需性 |
| --- | --- | --- |
| Node.js ≥ 22 | 运行宿主端 | 必需 |
| `config.json` 的 `deepseekKey`（或环境变量 `CHUBBY_WHALE_DEEPSEEK_KEY` / `DEEPSEEK_API_KEY`） | 聊天、总结 | 聊天必需 |
| Python 3 + `edge_tts`（`pip install edge-tts`） | 语音合成 | 语音必需 |
| 硅基流动 Key（`config.json` 的 `siliconflowKey` 或环境变量 `SILICONFLOW_API_KEY`） | 语音识别（Qwen3-ASR） | 语音输入必需 |

> 没有 Key 也能用：说书、念诗、典故、成语、民间故事、弹琴、提醒、成长全部离线可用，**不消耗 token**。

**首次安装没有 Key 会怎样**（实测行为）：

- 插件照常加载，不报错、不阻止使用离线功能
- 没配 DeepSeek Key：页面加载后会提示一次「还没配 Key」；聊天时回复会明确说缺 Key（不发模型请求）
- 没配 SiliconFlow Key：开语音后第一次识别会提示一次，并**停止继续上传识别**（不会反复重试、不刷屏）；打字和离线功能不受影响
- 语音合成（edge-tts）不需要 Key；若本机 python 环境缺依赖，客户端会自动回退浏览器朗读

## 安装

```
dsh plugin --profile web add link:<本目录>
```

然后重启 `dsh web`。首次打开页面点一下任意位置（浏览器要求用户手势才能开麦克风）。

## 配置

复制 `config.example.json` 为 `config.json`（`config.json` 已被 git 忽略，不会误提交）：

```json
{
  "deepseekKey": "",
  "siliconflowKey": "",
  "dataSource": "local"
}
```

Key 读取优先级：`config.json` → 专属环境变量（`CHUBBY_WHALE_DEEPSEEK_KEY` / `CHUBBY_WHALE_SILICONFLOW_KEY`）→ 通用环境变量（`DEEPSEEK_API_KEY` / `SILICONFLOW_API_KEY`）。
本插件刻意不读 `~/.dsh/.credentials.yaml`，避免与其他插件互相牵连。

### 数据源：本地 / 云端

说书、念诗、典故、成语、民间故事、对联的数据来自 `DataPort`，默认读插件包内 `data/`。
把 `dataSource` 改成 `cloud` 后，改为按需从 `https://adengou.cn/culture/v1/` 拉取：

```json
{
  "dataSource": "cloud"
}
```

- `local`（默认）：完全离线，行为与旧版一致。
- `cloud`：首次用到某本书/某类文化才下载，进程内缓存；清单 `manifest.json` 的 `version+generatedAt` 变化后才失效重拉。网络失败自动回退本地 `data/`，日志记一条 `CLOUD-DATA-FAIL`，60 秒内不再重试网络，错误不会冒到前端。
- 环境变量兜底：`CHUBBY_WHALE_DATA_SOURCE=cloud`。优先级：cordis 配置 `config.dataSource` → `config.json` → 环境变量 → `local`。
- 说书进度、念诗/文化已读记录仍写 `~/.dsh-chubby-whale/`，与数据源无关；前端接口与返回结构不变。
- 对联目前由前端内置库直接使用（构建时编入 `dist/client.js`），不经过宿主路由；`DataPort.readDuilian()` 已备好，但切换数据源不会替换前端对联库。

### 插件开关

`cordis.patch.yml` 里的 `config.enabled` 是本插件的总开关（默认 `true`）：

```yaml
- insert:
    - id: chubby-whale
      name: dsh-chubby-whale
      config:
        enabled: false
```

改成 `false` 后重启 `dsh web`：宿主端不再注册任何 `/api/chubby-whale/*` 路由（聊天、说书、语音、提醒等全部停用），启动日志会打印 `[chubby-whale] disabled by config`。它只停宿主端；要连前端 bundle 一起停用，用条目自带的 `disabled: true`（`dsh-client-modules` 只扫描启用的 entry）。

## 常见问题

- **没有声音**：检查本机是否装了 `python` 与 `edge-tts`（`python -m edge_tts --help` 能跑通即可）
- **听不懂说话**：检查 `siliconflowKey`；浏览器地址栏麦克风权限要允许
- **说书/念诗没内容**：`dataSource=local` 时确认 `data/` 目录存在且完整（33MB）；`cloud` 时看日志里的 `CLOUD-DATA-FAIL`（网络失败会自动回退本地）
- **数据存哪**：`memory.json`、`growth.json`、`reminders.json`、说书进度、已读记录都在 `~/.dsh-chubby-whale/`（插件升级不丢）

## 开发

```
npm install
npm run build      # 生成版本号 + tsc + 客户端 tsc + esbuild → dist/
npm test           # 导入规则/模块边界/诊断键/文字体检/单测/两端冒烟/判停基准
node tools/tts-bench.mjs           # TTS 耗时实测（对运行中的实例）
node tools/voice-bench.mjs --chat  # 语音链路测点（--chat 会花少量额度）
```

`src/client.ts` 由 esbuild 单独打包成 IIFE（tsconfig 里 exclude），其余模块走 tsc。
宿主侧改动要重启 dsh web 才生效，客户端改完 `Ctrl+F5` 即可；待生效清单见 `docs/待重启生效.md`。
## 数据热更新（改内容不用重启）

`data/story/*.json`、`data/culture/*.json`、`data/poems.json` 都按**文件修改时间**自动失效：
改完保存，下一次请求就会重新读取（无需重启 dsh web，也无需清缓存）。
运行数据（记忆/成长/鱼粮/提醒/说书进度/缓存）都在 `~/.dsh-chubby-whale/`，与插件包分离。