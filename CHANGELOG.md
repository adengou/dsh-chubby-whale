# 更新日志

## 1.0.1

- 补 `CHANGELOG.md`，README 顶部加 npm / 许可证徽章
- 仓库内新增发布工具（不进 npm 包体积的运行时路径）：
  - `tools/version-check.mjs`：比对 本地 / Gitee / GitHub / npm 四处版本，`--deep` 再比对包内 `dist/client.js`
  - `tools/gh-sync.mjs`：本机连不上 github.com 时，走 `api.github.com` 只传差异，幂等可重复跑
- `package.json` 新增 `npm run version:check`、`npm run sync:github`
- 新增 `docs/发布流程.md`：发版四步与常见坑（2FA、`0.0.0-stage` 占位、中文路径、包体积）

## 1.0.0

首发到 npm / GitHub / Gitee 三处。

- 网页桌宠：右下角常驻、拖拽带惯性、眨眼、气泡
- 语音对话：麦克风判停 → 硅基流动 Qwen3-ASR → DeepSeek 回复 → edge-tts 朗读
- 念诗 / 说书：本地诗词库与 17 本说书，连播、语速可调
- 记忆与成长：对话记忆、亲密度、成长经验、鱼粮统计
- 提醒：饭点提醒、到点主动开口
- 人设动作描写（`*甩甩尾巴*`）只在气泡里显示，不进语音通道
