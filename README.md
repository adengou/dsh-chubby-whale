# dsh-chubby-whale

DSH 网页版桌面宠物「肥鲸」：蓝发女仆鲸鱼娘，固定在 harness 页面右下角。

## 功能
- 立绘常驻右下角（可拖拽，带惯性，位置记忆）
- 自动眨眼
- 点击打开聊天框，气泡对话（DeepSeek）

## 独立配置
本插件不读取任何其他插件的配置。聊天需要 DeepSeek Key，二选一：
1. 环境变量 `DEEPSEEK_API_KEY`
2. 本目录 `config.json` 的 `deepseekKey` 字段

## 安装
```
dsh plugin --profile web add link:<本目录>
```
然后重启 `dsh web`。