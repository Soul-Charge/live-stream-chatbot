# live-stream-chatbot

自用直播间弹幕语音播报中间件：连接 B 站弹幕姬与本地 GPT-SoVITS 的非阻塞 HTTP 服务。

## 模块结构

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| 配置热更新 | `src/config.js` | 内存中维护全局配置，监听配置文件变化并自动热重载 |
| 请求解析与清洗 | `src/request.js` | 安全解析 HTTP 请求体，屏蔽词拦截、长度限制、替换字典清洗 |
| TTS 引擎适配 | `src/tts.js` | 异步并发队列，将文本与角色映射为 GPT-SoVITS 参数并获取音频流 |
| 流式播放调度 | `src/player.js` | 将音频流桥接至本地播放器 stdin，顺序播报并处理退出事件 |
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
- `text`：文本清洗规则，包括最长长度、屏蔽词（`reject` 拦截 / `strip` 删除）与替换字典。
- `roles`：角色映射表，`keywords` 按请求中的用户名或文本部分匹配；请求可显式传 `role` 精确指定；未匹配时使用 `default`。
- `tts`：后端地址与合成参数。`params` 为公共载荷扩展字段，各角色的 `params` 可覆盖，适配不同 GPT-SoVITS 封装版本。
- `player`：本地播放器命令，默认使用 ffplay（来自 FFmpeg），需已安装并加入 PATH。

配置文件保存后会自动热重载，无需重启服务；`server` 监听端口等基础参数改动需重启生效。
