# Genie-TTS 引擎迁移实施计划

## 1. 背景与目标

当前项目使用本地 GPT-SoVITS API（`api_v2.py`，默认 9880 端口）完成语音合成，通过 `set_gpt_weights` / `set_sovits_weights` 切换角色模型。Genie-TTS 提供内置 FastAPI 服务器，工作方式不同：先加载角色模型，再设置参考音频，最后按 `character_name` 请求 TTS。

迁移目标：

- 将现有每个角色的 `.ckpt` / `.pth` 模型转换为 Genie-TTS 所需的 ONNX 模型目录。
- 用 Genie-TTS 的 `load_character -> set_reference_audio -> tts` 工作流替换 GPT-SoVITS 的请求参数。
- 保留现有弹幕中间件能力：角色识别、文本替换/过滤、异步队列、流式播放、配置热重载、自动启动后端。
- 不改变弹幕姬调用方式：仍请求 `http://127.0.0.1:8899/tts?text=...`。

## 2. 现状与 Genie-TTS 差异

| 项目 | 当前 GPT-SoVITS | Genie-TTS |
| --- | --- | --- |
| 模型格式 | `.ckpt` + `.pth` | ONNX 模型目录 |
| 角色切换 | 请求前调用 `/set_gpt_weights`、`/set_sovits_weights` | 使用 `character_name` 选择已加载角色 |
| 参考音频 | 每次请求携带 `ref_audio_path`、`prompt_text` | 角色加载后单独调用 `/set_reference_audio` 注册 |
| 合成请求 | `POST /tts`，携带文本、参考信息、模型路径 | `POST /tts`，携带 `character_name` 和文本 |
| 语言控制 | `text_lang: auto` | 每个角色有 `language` 字段（如 `zh`、`jp`） |
| 后端启动 | `API.bat` 启动 `api_v2.py` | `genie.start_server(host, port, workers=1)` |

## 3. 迁移阶段

### 阶段 0：环境与可行性验证

- 在项目内创建虚拟环境，避免依赖写入 C 盘用户目录：

  ```powershell
  # 在项目根目录执行
  python -m venv .venv-genie

  # pip 缓存也放到项目内，避免占用 C 盘
  .\.venv-genie\Scripts\python.exe -m pip install --cache-dir .\.pip-cache --upgrade pip
  .\.venv-genie\Scripts\python.exe -m pip install --cache-dir .\.pip-cache genie-tts torch
  ```

- 后续所有模型转换、服务器启动命令统一使用 `.venv-genie\Scripts\python.exe`。
- 将 `.venv-genie/` 与 `.pip-cache/` 加入 `.gitignore`，避免提交到版本库。

- 流程文档说明 Genie-TTS 原生支持 GPT-SoVITS V2 和 V2ProPlus 模型转换，但仍需用当前实际模型文件验证兼容性。
- 用教程脚本启动空服务器，验证 `POST /load_character`、`POST /set_reference_audio`、`POST /tts` 三个接口可用。
- 确认 `/tts` 返回的是完整 WAV 流还是原始 PCM；确认采样率、声道数、位深。
- 确认是否有健康检查接口；若没有，规划用 TCP 探测或 `/tts` 的轻量调用代替现有 `isTtsApiUp`。

### 阶段 1：模型转换

- 为每个角色执行 ONNX 转换，建议脚本统一遍历模型目录：
  - 输入：`GPT_weights_v2ProPlus/<角色>.ckpt`
  - 输入：`SoVITS_weights_v2ProPlus/<角色>.pth`
  - 输出：`F:/AiSound/Genie-TTS-onnx/<角色>/` 或项目内 `models/onnx/<角色>/`
- 转换脚本使用项目内虚拟环境执行：`.\.venv-genie\Scripts\python.exe convert_to_onnx.py`
- 转换接口（来自流程文档）：

  ```python
  import genie_tts as genie

  genie.convert_to_onnx(
      torch_pth_path=r"F:/AiSound/GPT-SoVITS-v2pro-20250604/SoVITS_weights_v2ProPlus/<角色>.pth",
      torch_ckpt_path=r"F:/AiSound/GPT-SoVITS-v2pro-20250604/GPT_weights_v2ProPlus/<角色>.ckpt",
      output_dir=r"F:/AiSound/Genie-TTS-onnx/<角色>"
  )
  ```

- 转换后记录每个角色的：
  - `character_name`
  - `onnx_model_dir`
  - `language`
  - `refAudio`
  - `refText`
- 参考音频建议使用 5 秒左右的片段；转换或运行期间内存过高时，可调用 `/unload_character` 释放已加载角色。
- 首批转换对象：樱羽艾玛（ema）、二阶堂希罗（hiro）、高松灯（MyGO）、诗歌剧、橘雪莉（sherry）。

### 阶段 2：配置结构改造

在 `config/config.json` 的每个角色下增加或替换字段：

```json
{
  "comment": "二阶堂希罗",
  "characterName": "NTE0",
  "onnxModelDir": "F:/AiSound/Genie-TTS-onnx/NTE0",
  "language": "jp",
  "refAudio": "F:/AiSound/训练文件/自整理用音频/hiro/0101Adv02_Hiro003.ogg",
  "refText": "正しい説明がなされるのかな。それなら早く向かわないと……。"
}
```

- `tts` 配置改为 Genie 服务器地址，例如 `baseUrl: http://127.0.0.1:8000`。
- `gptSoVits` 相关配置改为 `genie` 配置：服务器端口、启动脚本/命令、角色预加载开关。
- `textLang` 的 `auto` 语义需要重新评估：Genie 按角色语言工作，可能需要为中日混合场景准备独立的 `zh` / `jp` 角色，或确认 Genie 是否支持按文本自动识别。

### 阶段 3：TTS 引擎适配

将 `src/tts.js` 从“构造 GPT-SoVITS payload”改为 Genie 客户端：

- 启动后按配置预加载角色：
  - `POST /load_character`
  - `POST /set_reference_audio`
- 合成时：
  - `POST /tts`
  - body：`{ character_name, text, split_sentence: true }`
  - 接收音频流并交给播放队列
- 若配置了按需加载：
  - 首次使用某角色时加载并设置参考音频
  - 空闲超时后 `POST /unload_character` 释放内存
- 移除现有 `set_gpt_weights` / `set_sovits_weights` 相关逻辑。
- 注意：旧流程文档中的 `/tts` payload 只有 `character_name` 和 `text`，并标注为“推测”；应以教程文件中的 `split_sentence`、`save_path` 字段为准。

### 阶段 4：角色生命周期管理

- 中间件启动时遍历 `config.json` 中 `roles` 下所有角色，逐个执行：
  - `POST /load_character`
  - `POST /set_reference_audio`
- 所有配置角色预加载完成后再启动 8899 监听，确保第一条弹幕请求即可直接合成。
- 角色切换只改 `character_name`，不重新加载模型。
- 若某个角色加载失败，记录错误并继续加载其他角色；正式实施时再决定是否改为“失败即终止启动”。
- 关闭中间件时调用：
  - `POST /unload_character`
  - `POST /clear_reference_audio_cache`
  - `POST /stop`

### 阶段 5：流式播放适配

- 现有 `src/player.js` 已能把流桥接到 `ffplay`，大概率不需要大改。
- 需要确认 Genie `/tts` 的流格式：
  - 若为带 WAV 头的流，可直接沿用当前 `ffplay -i -`。
  - 若为裸 PCM，需要调整 ffplay 参数（采样率、声道、位深）或在中间件补 WAV 头。
- 保留现有播放队列顺序，避免并发播放。

### 阶段 6：启动与守护

- 将 `src/api.js` 中启动 GPT-SoVITS `API.bat` 的逻辑改为启动 Genie 服务器：
  - 推荐用独立 Python 脚本调用 `genie.start_server(host, port, workers=1)`。
  - 启动脚本同样使用 `.\.venv-genie\Scripts\python.exe` 运行，确保加载的是项目内虚拟环境的 `genie_tts`。
  - 保留“检查后端是否已启动，未启动则拉起并等待就绪”的现有机制。
- 启动顺序：
  1. 检查 Genie 服务器
  2. 加载所有角色并设置参考音频
  3. 启动 8899 弹幕中间件

### 阶段 7：验证与回滚

- 功能验证：
  - 每个角色用 `角色名说...` 触发，确认声音正确
  - 文本替换、开头过滤、机器人进场过滤仍生效
  - 中日文文本合成符合预期
  - 连续切换角色无崩溃、无断流
- 性能验证：
  - 首次加载耗时
  - 多角色预加载内存占用
  - 长文本流式播放稳定性
- 回滚方案：保留当前 GPT-SoVITS 配置和 `API.bat`，迁移完成后若 Genie 不稳定，可切回 `baseUrl: http://127.0.0.1:9880` 并恢复旧 `tts.js` 逻辑。

## 4. Genie-TTS 接口契约（来自教程）

### 加载角色

```http
POST /load_character
```

```json
{
  "character_name": "NTE0",
  "onnx_model_dir": "F:/AiSound/Genie-TTS-onnx/NTE0",
  "language": "jp"
}
```

### 设置参考音频

```http
POST /set_reference_audio
```

```json
{
  "character_name": "NTE0",
  "audio_path": "F:/AiSound/训练文件/自整理用音频/hiro/0101Adv02_Hiro003.ogg",
  "audio_text": "正しい説明がなされるのかな。それなら早く向かわないと……。",
  "language": "jp"
}
```

### 合成

```http
POST /tts
```

```json
{
  "character_name": "NTE0",
  "text": "こんにちは",
  "split_sentence": true
}
```

### 释放资源

```http
POST /unload_character
POST /stop
POST /clear_reference_audio_cache
```

## 5. 需要保留的现有能力

- 弹幕姬 GET 调用 `http://127.0.0.1:8899/tts?text=...`
- 角色匹配规则：只匹配弹幕开头的“角色名说”，匹配原始文本，不因替换而失效
- `config/replacements.json`：基础替换、开头过滤、机器人进场过滤
- 播放队列顺序播放
- 配置文件与替换文件热重载

## 6. 风险与待确认事项

1. Genie-TTS 对当前 V2ProPlus 模型的 ONNX 转换兼容性。
2. 多角色同时加载的内存占用是否可接受。
3. `/tts` 返回格式（WAV 头 / 裸 PCM）和采样率。
4. 是否有健康检查接口，现有“启动前探测”需要适配。
5. Genie 是否支持中日文混合文本自动识别；若不支持，需要为 `zh` 和 `jp` 分别准备角色。
6. 热重载角色配置时，已加载角色是否需要重新 `load_character` / `set_reference_audio`。
7. 参考音频是否必须为 5 秒左右；现有角色的 `.ogg` / `.mp3` 格式与时长是否需要统一转换。
8. 项目内虚拟环境体积较大（尤其 torch 与 genie-tts），需预留磁盘空间，并避免将其纳入备份、同步或版本库。
