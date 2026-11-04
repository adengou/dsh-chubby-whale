# dsh-chubby-whale（肥鲸）

DSH 网页版桌面宠物：蓝发女仆鲸鱼娘，常驻 harness 页面右下角。可拖拽（带惯性、位置记忆）、会眨眼、能说话、能说书念诗弹琴，也能听懂你说话。

> 语音待命的信号处理设计与调参：见 [docs/耳朵算法.md](docs/耳朵算法.md)

## 功能

| 分类 | 能力 |
| --- | --- |
| 陪伴 | 立绘常驻右下角、拖拽惯性、位置记忆、自动眨眼、说话时嘴动、喂食冒爱心 |
| 聊天 | 气泡对话（DeepSeek），人设固定（名字/爸妈/生日/出生地），支持中英双语，长期记忆摘要 |
| 语音 | 文字转语音（9 种音色、可关、可停）、语音待命（常驻听写）、语音聊天开关 |
| 文化 | 说书（17 本古籍，念原文、进度记忆、不重复）、念诗（739 首）、典故（261）、成语（834）、民间故事（690）、对联 |
| 音乐 | 11 首曲子 Web Audio 合成播放（含升降号与低/高音） |
| 工具 | 提醒（口语时间：9点 / 明天9点 / 半小时后 / 每天8点）、看图、拖文件（图片识别 / 文本总结）、成长与亲密度、鱼粮账本、余额、清除记忆 |

## 目录结构

```
dsh-chubby-whale/
  dist/            编译产物（已提交，安装无需构建）
  src/             源码（TS）
  data/            内容数据（必需，33MB）
    story/         17 本古籍 JSON
    culture/       典故 / 成语 / 民间故事
    poems.json     739 首诗
    melodies.json  11 首曲子
  assets/          立绘
  cordis.patch.yml 插件注册配置
```

## 依赖

| 依赖 | 用途 | 必需性 |
| --- | --- | --- |
| Node.js ≥ 22 | 运行宿主端 | 必需 |
| `~/.dsh/.credentials.yaml` 的 `DEEPSEEK_API_KEY`（或环境变量 / `config.json`） | 聊天、总结 | 聊天必需 |
| Python 3 + `edge_tts`（`pip install edge-tts`） | 语音合成 | 语音必需 |
| 硅基流动 Key（`config.json` 的 `siliconflowKey` 或环境变量 `SILICONFLOW_API_KEY`） | 语音识别（Qwen3-ASR） | 语音输入必需 |

> 没有 Key 也能用：说书、念诗、典故、成语、民间故事、弹琴、提醒、成长全部离线可用，**不消耗 token**。

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
  "siliconflowKey": ""
}
```

Key 读取优先级：`~/.dsh/.credentials.yaml` → 环境变量 → `config.json`。

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
- **说书/念诗没内容**：确认 `data/` 目录存在且完整（33MB）
- **数据存哪**：`memory.json`、`growth.json`、`reminders.json` 等运行数据都写在插件目录的 `data/` 下（已在 `.gitignore`）

## 开发

```
npm install
npm run build      # tsc + esbuild → dist/
```

`src/client.ts` 由 esbuild 单独打包成 IIFE（tsconfig 里 exclude），其余模块走 tsc。
