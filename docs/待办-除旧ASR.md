# 已完成：全面接入官方，删除 旧 ASR 所有依赖

决定（2026-11-14）：**无兜底**，不再需要 旧 ASR 的任何依赖。

状态：**已完成**（2026-11-14 03:40 左右），全链测试通过，已部署 desktop profile。

## 改动清单（逐项已落地）

1. `host/config.ts`：删 `read旧 ASRKey`；`keyStatus` 只回 `{ deepseek }`；注释同步。
2. `host/ports.ts`：`AsrRouteDeps` 只留 `getDeepseekKey`（去掉 `getKey` / `engine`）。
3. `host/routes/asr.ts`：删 旧 ASR endpoint / model / language / 回退分支；
   只走官方 `/v1/tools/asr`；缓存 key 升 **v6**（固定 official）；
   非 WAV 直接回 `unsupported format` + 一句人话；缺省 `format` 按 WAV；
   脚本闸门、噪声过滤、断连中止、体积上限全部保留。
4. `index.ts`：删 `get旧 ASRKey`、`readAsrEngine`（`CHUBBY_WHALE_ASR_ENGINE` 与
   `config.json` 的 `asrEngine` 不再读取）；只注入 `getDeepseekKey`。
5. `host/routes/config.ts` + 客户端：去掉 `has旧 ASRKey`；文案改「聊天和语音都用这一个」；
   首次安装提示改「DeepSeek Key（deepseekKey）」。
6. README / `config.example.json` / CHANGELOG / `docs/坑.md` / `docs/模块接口清单.md`：同步删改。
7. 测试：`test-voice-routes` / `test-asr-abort` / `test.mjs` / `test-assembly` 的
   `getKey` → `getDeepseekKey`；`test-prefs-config` / `test-config-migrate` / `test-cloud-config` /
   `test-misc-routes` 去掉 旧 ASR 读取器与配置视图字段；新增
   「`src/` 无 旧 ASR 依赖」硬断言（`test-voice-routes` [F]）。

## 验收（已实测）

- `src/` 无 `read旧 ASRKey` / `旧 ASR_API_KEY` / `api.旧 ASR.cn` / `旧 ASRKey`
  （只剩注释里的「已下线」历史说明）。
- `tsc -p tsconfig.json` / `tsc -p tsconfig.client.json` 均 exit 0；`npm test` 全绿。
- 已部署 desktop profile（备份 `~/.dsh/backups/whale-no-sf-20261114-032307`）。
- 用**已部署的 dist** 跑真实外呼（脚本 `%TEMP%\whale-asr-verify.mjs`）：
  - 真 WAV（SAPI 合成「今天上海天气怎么样」）→ 官方转写返回「今天上海天气怎么样？」；
  - 外呼地址只有 `https://api.deepseek.com/v1/tools/asr`；
  - 同音频第二次命中缓存；webm 回 `unsupported format`；无 Key 回 `NO_KEY`。
- **运行中的桌面实例尚未重启**（宿主模块是进程内加载），重启后新代码才在界面里生效。

## 兼容说明

- 旧 `config.json` 里残留的旧 ASR字段不再读取、不告警、不影响启动。
- 环境变量 `旧 ASR_API_KEY` / `CHUBBY_WHALE_旧 ASR_KEY` 同样被忽略。
