# live-stream-chatbot

自用直播间弹幕语音播报中间件：连接 B 站弹幕姬与本地 GPT-SoVITS 的非阻塞 HTTP 服务。

## 模块结构

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| 配置热更新 | `src/config.js` | 内存中维护全局配置，监听配置文件变化并自动热重载 |
| 请求解析与清洗 | `src/request.js` | 安全解析 HTTP 请求体，屏蔽词拦截、长度限制、替换字典清洗、弹幕“xxx说”角色匹配 |
| TTS 引擎适配 | `src/tts.js` | 异步并发队列，将文本与角色映射为 GPT-SoVITS 参数并获取音频流 |
| 流式播放调度 | `src/player.js` | 将音频流桥接至本地播放器 stdin，顺序播报并处理退出事件 |
| 推理 API 守护 | `src/api.js` | 启动时探测 TTS 后端，未运行则按配置自动拉起并设置角色模型 |
| 内存 watchdog | `src/watchdog.js` | 可选：后端私有内存超阈值时自动重启并恢复默认模型 |
| 弹幕数据库 | `src/db/*` | SQLite 采集弹幕、TTS 状态、用户与场次；提供只读查询 API |
| 服务入口 | `src/index.js` | HTTP 服务、路由、角色匹配、任务流水线编排 |

## 快速开始

1. 安装依赖：

   ```powershell
   npm install
   ```

2. 复制示例配置并修改为本机参数：

   ```powershell
   Copy-Item config\config.example.json config\config.json
   ```

3. 启动服务：

   ```powershell
   npm start
   ```

   主程序启动时会先检查 `tts.baseUrl` 对应的推理 API；如果未运行，会根据 `gptSoVits.path` 自动启动 `API.bat` 并等待就绪。

4. 在弹幕姬中将 TTS 地址设为 `http://127.0.0.1:8899/tts`，请求体示例：

   ```json
   {
     "name": "用户名",
     "text": "要播报的内容"
   }
   ```

也可用 GET `http://127.0.0.1:8899/tts?text=你好` 快速测试。

> 端口说明：原默认 7788 在部分 Windows 上会被 Hyper-V/WSL 保留，导致 `EACCES: permission denied`。现在默认改为 8899。若仍遇到该错误，请运行 `netsh interface ipv4 show excludedportrange protocol=tcp` 查看被排除的端口段，并把 `config/config.json` 的 `server.port` 改成不在这些段内的端口。

## 配置说明

- `server`：中间件监听地址、端口、路径及请求体大小限制。默认端口 8899。
- `text`：文本清洗规则，包括最长长度、屏蔽词（`reject` 拦截 / `strip` 删除）与替换字典；所有规则统一放在同目录的 `config/replacements.json`，包含 `replacements`（基础字符串替换）、`startFilters`（弹幕以指定词开头时整条跳过）和 `entranceFilter`（弹幕以“欢迎”开头且包含机器人名时整条跳过）。
- `roles`：角色映射表。程序只检查弹幕文本开头的“角色名说”来切换角色，角色名可以是角色键或 `comment` 注释；角色匹配使用替换前的原始文本，文本替换/过滤只作用于最终合成文本，不会影响角色识别。未匹配时使用 `default`，也可通过请求参数 `role` 精确指定。
- `gptSoVits`：GPT-SoVITS 安装目录与自动启动配置。`path` 指向推理 API 所在目录，`autoStart` 为 `true` 时主程序会在 API 未运行时自动拉起；存在 `runtime\python.exe` 时直接以 `python -u api_v2.py` 隐藏启动（日志见 `logs/gpt-sovits-api.*.log`），否则回退到 `startScript`。`startupTimeoutMs` 为等待就绪的最长时间，当前为 600000ms（V3 CPU 卸载后冷启动较慢）。API 就绪后会用 `roles.default.params` 中的 `gpt_path`/`sovits_path` 设置模型。
- `tts`：后端地址与合成参数。`textLang` 为无假名文本使用的语言（中文直播间推荐 `all_zh`，避免短中文弹幕被引擎 `auto` 误判为日文）；`textLangWhenKana` 非空时，检测到平假名/片假名/半角假名的弹幕改用它（推荐 `auto`，保留中日混合弹幕识别）；`params` 为公共载荷扩展字段，各角色的 `params` 可覆盖，适配不同 GPT-SoVITS 封装版本；`promptLang` 应与参考文本语言一致（日文参考音频建议填 `ja`）。
- `database`：本地弹幕数据库（SQLite），控制开关、文件路径、保留天数和只读接口令牌。
- `hotPhrase`：高频弹幕统计与 TTS 文件缓存预生成参数；阶段 3 实施前保持 `enabled: false`。
- `player`：本地播放器命令，默认使用 ffplay（来自 FFmpeg），需已安装并加入 PATH。

配置文件保存后会自动热重载，无需重启服务；`server` 监听端口等基础参数改动需重启生效。

## 弹幕数据库（阶段 1/2 已实现）

- 数据库：SQLite + `better-sqlite3`，默认文件 `data/danmaku.sqlite3`（WAL 模式，已加入 `.gitignore`）。
- Windows 注意：如果启动日志出现 `better_sqlite3.node is not a valid Win32 application`，说明 `node_modules` 是 WSL/Linux 下安装的，请在 Windows PowerShell 执行 `npm rebuild better-sqlite3`（失败则删除 `node_modules` 后重新 `npm install`）。未修复前数据库会自动降级为不采集，TTS 不受影响。
- 采集内容：原始文本、清洗文本、最终合成文本、用户、角色、TTS 状态、拒绝原因；被屏蔽/拒绝的弹幕也会入库。
- 查询接口（默认仅本机）：
  - `GET /health`：服务与数据库健康信息。
  - `GET /db/danmaku?text=...&from=...&to=...&role=...&status=...`
  - `GET /db/hot?minutes=10&minCount=3`
  - `GET /db/users` / `GET /db/users/:id`
  - `GET /db/sessions`
- `database.readToken` 非空时，上述 `/db/*` 接口要求请求头 `X-DB-Token` 匹配。
- 备份：`npm run db:backup`，在线备份到 `data/backup/danmaku-<时间>.sqlite3`。
- 高频弹幕预生成文件缓存（TTS A5）尚未启用，见 `vibe-coding-reference/弹幕数据库构建计划.md` 阶段 3。

## 性能优化配置（按 `vibe-coding-reference/TTS性能优化计划.md` 实施）

- `tts.textSplitMethod`：建议保持 `cut5`，按标点分句合成，降低长文本激活显存峰值。
- V1 显存基线（V3 前）见 `vibe-coding-reference/gpt-sovits-vram-baseline.md`：启动空闲 4369MB，切换+合成峰值 4960MB；V3 应用后需要重测。
- `tts.streamHighWaterMark`：端到端流式缓冲高水位（默认 16MB）。中间件在收到响应体后立即把音频流交给播放器，但 TTS 队列槽位会持有到后端生成结束，避免角色切换破坏进行中的合成。注意：本机 GPT-SoVITS 把 `streamingMode:true` 解释为 `return_fragment`，首块音频仍要等整段生成完；真正增量流式需后续评估 `streaming_mode=2/3`。
- `tts.warmup`：启动/后端重启后自动合成一条极短文本并丢弃，把冷启动成本移出首条弹幕；V3 后首次预热约 90~120s，因此 `tts.requestTimeoutMs` 默认已提高到 300000ms。当前预热是同步的：API 冷启动约 3 分钟 + 切权重约 30s + 预热约 90~120s 完成后，8899 端口才监听。
- `tts.cache`：A4 内存 LRU 的过渡开关，现默认关闭（`enabled: false`），避免音频 Buffer 常驻 Node 堆；A5 文件缓存落地后该内存缓存将移除。磁盘缓存配置见 `tts.cache.disk`。
- `gptSoVits.env`：自动拉起 API 时注入的额外环境变量。默认留空；不要设置 `PYTORCH_CUDA_ALLOC_CONF=expandable_segments`，因为本机 GPT-SoVITS 自带 torch 2.0.0 不认识该选项，会直接报 `Unrecognized CachingAllocator option` 退出。
- 中间件自动拉起 API 时，stdout/stderr 会追加到 `logs/gpt-sovits-api.out.log` / `logs/gpt-sovits-api.err.log`；模型加载或合成启动失败时先看 `*.err.log`。
- `gptSoVits.watchdog`：可选后端内存 watchdog，私有内存超过阈值时自动重启并重新设置默认模型。
- `text.maxTextLength`：当前配置为 120（原 200），作为显存峰值的硬上限；如不接受长弹幕截断可改回 200。

## GPT-SoVITS V3 CPU 卸载补丁

显存不足（如 RTX 2060 6GB）时，可把 BERT / CNHubert / 声纹模型常驻 CPU，仅保留 t2s + SoVITS 在 GPU：

```powershell
# 预检查（不写盘）
pwsh -File scripts\apply_TTS_cpu_offload.ps1 -DryRun

# 应用（自动生成 TTS.py.v3-cpu-offload.bak 与 .json 状态文件）
pwsh -File scripts\apply_TTS_cpu_offload.ps1

# 回滚（会校验当前文件/备份的 SHA256 后恢复）
pwsh -File scripts\apply_TTS_cpu_offload.ps1 -Rollback
```

补丁源文件：`scripts/TTS_cpu_offload_v2pro.patch`（基于 20250604 v2Pro 版 TTS.py）。脚本不依赖 `git`，按 unified diff 逐 hunk 校验后替换；升级 GPT-SoVITS 后若版本不匹配会拒绝应用，需确认兼容或重新生成补丁。

显存基线探针（V1）：

```powershell
pwsh -File scripts\measure_gpt_sovits_vram.ps1
```

报告写入 `vibe-coding-reference/gpt-sovits-vram-baseline.md`。

如果你手工双击 `API.bat` 时出现“不按回车就不继续/卡住”，通常是 cmd 的 QuickEdit 模式或脚本末尾的 `pause` 造成的；推荐改用中间件隐藏启动，或关闭控制台属性里的“快速编辑模式”。

API 启动排障（窗口关闭看不到报错时）：

```powershell
cd F:\AiSound\GPT-SoVITS-v2pro-20250604
.\runtime\python.exe -u api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS\configs\tts_infer.yaml 2>&1 | Tee-Object -FilePath "$env:TEMP\gpt_sovits_diag.log"
```

该命令会在 PowerShell 窗口保留完整报错，并同时写入 `%TEMP%\gpt_sovits_diag.log`；若 API 正常启动则按 `Ctrl+C` 停止。

> 以上两个 PowerShell 脚本已保存为 **UTF-8 with BOM + CRLF**；Windows PowerShell 5.1 依赖 BOM 识别 UTF-8，如用编辑器另存请保持该编码，否则中文会乱码并导致解析失败。
