# 手机简版扩展说明

> 位置：本插件内置的 `/whale-mobile/` 页面。本文说明它怎么接进来、能扩展什么、边界在哪。

## 1. 它是什么

一个**宿主插件自带的静态单页**：聊天 / 文化 / 提醒。
不是独立 App，也不是 dsh Web UI 的一部分；它由 `src/host/mobile.ts` 在 `apply()` 里挂一条 `prefix` 路由，静态文件直接读包根目录的 `mobile/`。

```
dsh web 进程
 └─ chubby-whale 插件（inject: ['webServer']）
     ├─ /api/chubby-whale/*   ← 桌面端也在用的原有接口
     └─ /whale-mobile/*       ← 本扩展
         ├─ 静态页 mobile/
         └─ /whale-mobile/api/*（本扩展自己的聊天/提醒接口）
```

## 2. 目录

| 路径 | 作用 |
|---|---|
| `src/host/mobile.ts` | 挂载层：建 llm/store/modules/router，注册 `prefix` 路由 |
| `src/mobile/core/deepseek.ts` | 直连 DeepSeek（复用本插件 `config.json` 的 Key） |
| `src/mobile/core/store.ts` | JSON 持久化（原子写） |
| `src/mobile/http/router.ts` | 本扩展的 HTTP 路由与 SSE |
| `src/mobile/modules/chat` | 聊天（会话记忆） |
| `src/mobile/modules/story` | **旧的 AI 编故事接口**（页面已不再调用，保留接口） |
| `src/mobile/modules/reminder` | 提醒（定时 + SSE 推送） |
| `mobile/` | 单页：index.html / app.js / styles.css / manifest / 图标 / duilian.json |

## 3. 接口

### 本扩展自己的（`/whale-mobile/api/*`）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/health` | 健康检查 + 依赖自述（dshWeb / chubbyWhale 版本） |
| POST | `/chat/stream` | 聊天 SSE（`delta` / `done` / `error`） |
| POST | `/chat` | 非流式聊天 |
| GET | `/chat/conversations`、`/chat/:id/history` | 会话列表 / 历史 |
| POST | `/story`、`GET /stories` | AI 编故事（旧接口，保留） |
| POST / GET / DELETE | `/reminders`(`/:id`) | 提醒增删查 |
| GET | `/events` | SSE：提醒到点推送 |

### 复用的插件原有接口（`/api/chubby-whale/*`）

页面直接调，不经过本扩展：

- 文化：`/story/books`、`/story/start`、`/story/next`、`/culture?type=chengyu|idiom|minsu`、`/poem`、`/daily`、`/briefing`
- 语音：`/tts`（edge-tts 合成）、`/asr`（硅基流动识别）
- 形象：`/asset`（whale.png）

## 4. 数据

| 文件 | 归属 |
|---|---|
| `$DSH_HOME/whale-mobile/state.json` | 本扩展的会话 + 提醒 |
| `mobile/duilian.json` | 对联库（客户端抽取，与桌面端同一份数据） |
| 插件的 `config.json` | DeepSeek Key / 硅基流动 Key / 模型名（与桌宠共用） |

## 5. 配置

```yaml
- id: whale-mobile
  config:
    basePath: /whale-mobile   # 页面地址
    token: ''                 # 非空则 /whale-mobile/api/* 要带 Bearer 或 ?token=
    dataDir: ''               # 默认 $DSH_HOME/whale-mobile
    model: deepseek-flash
```

`rawConfig.mobile === false` 可整体关掉本扩展。

## 6. 怎么扩展

**加一个文化分类**：在 `mobile/index.html` 的 `#cultureChips` 里加一个 `.chip[data-kind]`；在 `app.js` 的 `loadCultureItem()` 里加分支（调 `/api/chubby-whale/...` 或本地数据）。

**加一个底部 Tab**：`index.html` 加 `#panel-xxx` 与 `#tab-xxx`；`app.js` 的 `TABS` 数组加 `'xxx'`，并写 `setupXxx()` 在 `init()` 里调用。

**加一个新接口**：在 `src/mobile/http/router.ts` 的 `handleApi()` 里加分支，业务逻辑放 `src/mobile/modules/` 下的模块，路由只调模块接口。

## 7. 边界与限制

- **必须依赖电脑端 dsh web**：宿主一停，页面只是空壳。
- **录音要求安全上下文**（HTTPS 或 `http://localhost`）；`http://局域网IP` 时浏览器禁用麦克风，页面会退回「系统录音器」方式。
- 模型走本插件自己的 Key，不读 dsh 的 llm 服务（本插件本来就不用它）。
- 页面无构建：改完 `mobile/` 刷新即可；改 `src/` 需重新 `tsc` 并重启 dsh。

## 8. 验证

```bash
node --check mobile/app.js
npx tsc -p tsconfig.json
# 起实例后：
curl http://127.0.0.1:<port>/whale-mobile/api/health
curl http://127.0.0.1:<port>/api/chubby-whale/story/books
```
