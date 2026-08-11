# Genie-TTS 引擎迁移实施计划

> **执行状态（2026-08-11）**：阶段 0 ✅ 已完成、阶段 1 ✅ 已完成。
> 详细结果见《[阶段0-验证结果.md](阶段0-验证结果.md)》《[阶段1-转换记录.md](阶段1-转换记录.md)》。

## 1. 背景与目标

当前项目使用本地 GPT-SoVITS API（`api_v2.py`，默认 9880 端口）完成语音合成，通过 `set_gpt_weights` / `set_sovits_weights` 切换角色模型。Genie-TTS 提供内置 FastAPI 服务器，工作方式不同：先加载角色模型，再设置参考音频，最后按 `character_name` 请求 TTS。

迁移目标：

- 将现有每个角色的 `.ckpt` / `.pth` 模型转换为 Genie-TTS 所需的 ONNX 模型目录。
- 用 Genie-TTS 的 `load_character -> set_reference_audio -> tts` 工作流替换 GPT-SoVITS 的请求参数。
- 保留现有弹幕中间件能力：角色识别、文本替换/过滤、异步队列、流式播放、配置热重载、自动启动后端。
- 不改变弹幕姬调用方式：仍请求 `http://127.0.0.1:7788/tts?text=...`。

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

### 阶段 0：环境与可行性验证 ✅ 已完成（2026-08-06）

执行结果摘要（详见《阶段0-验证结果.md》）：

- 虚拟环境使用 Python 3.10（系统默认 3.8 不满足 genie-tts ≥ 3.9 要求），
  命令为 `D:\Python310\python.exe -m venv .venv-genie`。
- 已安装 genie-tts 2.0.2、torch、onnxruntime-gpu 1.22.0（GPU 版无 1.22.1），
  以及 nvidia CUDA 12.9 / cuDNN 9.24 运行时；首次导入自动下载 `GenieData/`（约 391MB）。
- GPU 启用要点：genie_tts.ModelManager 硬编码 CPU provider，需在服务器启动前改为
  `CUDAExecutionProvider`；Windows 下还需先把 `site-packages\nvidia\*\bin` 加入
  DLL 搜索路径，否则会静默回退 CPU（详见验证脚本 `run_server`）。
- 已确认 `/tts` 返回裸 PCM（32000 Hz、单声道、16bit），并非带 WAV 头的流。
- 已确认没有健康检查接口，采用 TCP 探测端口就绪。

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

### 阶段 1：模型转换 ✅ 已完成（2026-08-11）

执行结果摘要（详见《阶段1-转换记录.md》）：

- 5 个角色全部转换为 V2ProPlus ONNX 成功，并通过 GPU 端到端合成验证。
- 输出目录定为 `F:/AiSound/Genie-TTS-onnx/CharacterModels/<角色>/tts_models`
  （与 Genie-TTS GUI 结构一致），参考音频放入同目录下 `prompt_wav/`，
  并生成 `prompt_wav.json`。
- 发现并修正：高松灯参考音频实际为 `.mp3`（配置曾写 `.ogg`）；
  MyGO 与 诗歌剧 的 mp3 参考音频已用 ffmpeg 转为 wav（Genie 不接受 mp3）。

- 为每个角色执行 ONNX 转换，建议脚本统一遍历模型目录：
  - 输入：`GPT_weights_v2ProPlus/<角色>.ckpt`
  - 输入：`SoVITS_weights_v2ProPlus/<角色>.pth`
  - 输出：`F:/AiSound/Genie-TTS-onnx/CharacterModels/<角色>/tts_models`
- 转换脚本使用项目内虚拟环境执行：`.\.venv-genie\Scripts\python.exe scripts\convert_to_onnx.py`
  （支持 `--only <角色>` 单独重转；另有 `scripts/validate_converted.py` 做端到端验证）
- 转换接口（来自流程文档）：

  ```python
  import genie_tts as genie

  genie.convert_to_onnx(
      torch_pth_path=r"F:/AiSound/GPT-SoVITS-v2pro-20250604/SoVITS_weights_v2ProPlus/<角色>.pth",
      torch_ckpt_path=r"F:/AiSound/GPT-SoVITS-v2pro-20250604/GPT_weights_v2ProPlus/<角色>.ckpt",
      output_dir=r"F:/AiSound/Genie-TTS-onnx/CharacterModels/<角色>/tts_models"
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
  "characterName": "hiro",
  "onnxModelDir": "F:/AiSound/Genie-TTS-onnx/CharacterModels/hiro/tts_models",
  "language": "jp",
  "refAudio": "F:/AiSound/Genie-TTS-onnx/CharacterModels/hiro/prompt_wav/0101Adv02_Hiro003.ogg",
  "refText": "正しい説明がなされるのかな。それなら早く向かわないと……。"
}
```

- `characterName` 与 `onnxModelDir` 以《阶段1-转换记录.md》为准：
  ema / hiro / MyGO / 诗歌剧 / sherry（ONNX 文件位于 `<角色>/tts_models`）。
- 参考音频一律使用 `prompt_wav/` 下的文件（mp3 已转 wav），不要再指向源 mp3。
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

- **已知陷阱**：`/load_character` 即使模型加载失败也返回 200（服务端不检查
  `model_manager.load_character` 的返回值）。预加载后必须用 `/tts` 探测或
  检查服务端日志确认角色可用，不能只信 HTTP 状态码。
- **显存限制（已实测）**：RTX 2060 6GB 显存，单角色 GPU 加载峰值约 5.4GB
  （含常驻程序约 2.4GB），多角色同时 GPU 预加载不可行。
  阶段 4 采用“仅缓存 1 个角色（`Max_Cached_Character_Models=1`）+ 按需加载/卸载”。
- 中间件启动时遍历 `config.json` 中 `roles` 下所有角色，逐个执行：
  - `POST /load_character`
  - `POST /set_reference_audio`
- 所有配置角色预加载完成后再启动 7788 监听，确保第一条弹幕请求即可直接合成。
- 角色切换只改 `character_name`，不重新加载模型。
- 若某个角色加载失败，记录错误并继续加载其他角色；正式实施时再决定是否改为“失败即终止启动”。
- 关闭中间件时调用：
  - `POST /unload_character`
  - `POST /clear_reference_audio_cache`
  - `POST /stop`

### 阶段 5：流式播放适配

- 现有 `src/player.js` 已能把流桥接到 `ffplay`，大概率不需要大改。
- **已确认**：Genie `/tts` 返回裸 PCM（32000 Hz、单声道、16bit），不带 WAV 头。
  ffplay 参数需改为 `-f s16le -ar 32000 -ac 1 -`，或在中间件为流补 WAV 头；
  不能沿用当前 `ffplay -i -`（验证脚本已演示客户端补头写法）。
- 保留现有播放队列顺序，避免并发播放。

### 阶段 6：启动与守护

- 将 `src/api.js` 中启动 GPT-SoVITS `API.bat` 的逻辑改为启动 Genie 服务器：
  - 推荐用独立 Python 脚本调用 `genie.start_server(host, port, workers=1)`。
  - 启动脚本同样使用 `.\.venv-genie\Scripts\python.exe` 运行，确保加载的是项目内虚拟环境的 `genie_tts`。
  - 启动脚本需在 `import genie_tts` 前加入 nvidia DLL 路径，并设置
    `model_manager.providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]`
    （可参考 `scripts/phase0_verify.py` 的 `run_server` 实现）。
  - 保留“检查后端是否已启动，未启动则拉起并等待就绪”的现有机制。
- 启动顺序：
  1. 检查 Genie 服务器
  2. 加载所有角色并设置参考音频
  3. 启动 7788 弹幕中间件

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
  "character_name": "hiro",
  "onnx_model_dir": "F:/AiSound/Genie-TTS-onnx/CharacterModels/hiro/tts_models",
  "language": "jp"
}
```

### 设置参考音频

```http
POST /set_reference_audio
```

```json
{
  "character_name": "hiro",
  "audio_path": "F:/AiSound/Genie-TTS-onnx/CharacterModels/hiro/prompt_wav/0101Adv02_Hiro003.ogg",
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
  "character_name": "hiro",
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

- 弹幕姬 GET 调用 `http://127.0.0.1:7788/tts?text=...`
- 角色匹配规则：只匹配弹幕开头的“角色名说”，匹配原始文本，不因替换而失效
- `config/replacements.json`：基础替换、开头过滤、机器人进场过滤
- 播放队列顺序播放
- 配置文件与替换文件热重载

## 6. 风险与待确认事项

1. Genie-TTS 对当前 V2ProPlus 模型的 ONNX 转换兼容性。→ ✅ 已解决：5 个角色转换并合成通过。
2. 多角色同时加载的内存占用是否可接受。→ ⚠️ 未解决：6GB 显存仅够单角色，采用按需加载/卸载。
3. `/tts` 返回格式（WAV 头 / 裸 PCM）和采样率。→ ✅ 已解决：裸 PCM，32000 Hz / 单声道 / 16bit。
4. 是否有健康检查接口，现有“启动前探测”需要适配。→ ✅ 已解决：无健康检查接口，用 TCP 探测。
5. Genie 是否支持中日文混合文本自动识别；若不支持，需要为 `zh` 和 `jp` 分别准备角色。
6. 热重载角色配置时，已加载角色是否需要重新 `load_character` / `set_reference_audio`。→ 待阶段 2 实现时确认。
7. 参考音频是否必须为 5 秒左右；现有角色的 `.ogg` / `.mp3` 格式与时长是否需要统一转换。
   → ✅ 已确认：时长 3.3–7.4 秒均可正常合成；`.mp3` 必须转 `.wav`（已转换），其余保持原格式。
8. 项目内虚拟环境体积较大（尤其 torch 与 genie-tts），需预留磁盘空间，并避免将其纳入备份、同步或版本库。
   → ✅ 已处理：`.venv-genie/`、`.pip-cache/`、`GenieData/` 均已加入 `.gitignore`。
