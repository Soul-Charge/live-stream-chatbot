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
| 服务入口 | `src/index.js` | HTTP 服务、路由、角色匹配、任务流水线编排 |

## 快速开始

1. 复制示例配置并修改为本机参数：

   ```powershell
   Copy-Item config\config.example.json config\config.json
   ```

2. 启动服务：

   ```powershell
   npm start
   ```

   主程序启动时会先检查 `tts.baseUrl` 对应的推理 API；如果未运行，会根据 `gptSoVits.path` 自动启动 `API.bat` 并等待就绪。

3. 在弹幕姬中将 TTS 地址设为 `http://127.0.0.1:7788/tts`，请求体示例：

   ```json
   {
     "name": "用户名",
     "text": "要播报的内容"
   }
   ```

也可用 GET `http://127.0.0.1:7788/tts?text=你好` 快速测试。

## 配置说明

- `server`：中间件监听地址、端口、路径及请求体大小限制。
- `text`：文本清洗规则，包括最长长度、屏蔽词（`reject` 拦截 / `strip` 删除）与替换字典；所有规则统一放在同目录的 `config/replacements.json`，包含 `replacements`（基础字符串替换）、`startFilters`（弹幕以指定词开头时整条跳过）和 `entranceFilter`（弹幕以“欢迎”开头且包含机器人名时整条跳过）。
- `roles`：角色映射表。程序只检查弹幕文本开头的“角色名说”来切换角色，角色名可以是角色键或 `comment` 注释；角色匹配使用替换前的原始文本，文本替换/过滤只作用于最终合成文本，不会影响角色识别。未匹配时使用 `default`，也可通过请求参数 `role` 精确指定。
- `gptSoVits`：GPT-SoVITS 安装目录与自动启动配置。`path` 指向推理 API 所在目录，`autoStart` 为 `true` 时主程序会在 API 未运行时自动执行 `startScript`，`startupTimeoutMs` 为等待就绪的最长时间。API 就绪后会用 `roles.default.params` 中的 `gpt_path`/`sovits_path` 设置模型。
- `tts`：后端地址与合成参数。`textLang` 设为 `auto` 时会自动识别中日文；`params` 为公共载荷扩展字段，各角色的 `params` 可覆盖，适配不同 GPT-SoVITS 封装版本；`promptLang` 应与参考文本语言一致（日文参考音频建议填 `ja`）。
- `player`：本地播放器命令，默认使用 ffplay（来自 FFmpeg），需已安装并加入 PATH。

配置文件保存后会自动热重载，无需重启服务；`server` 监听端口等基础参数改动需重启生效。
