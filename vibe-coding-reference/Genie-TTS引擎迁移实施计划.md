# Genie-TTS 引擎迁移实施计划

> **执行状态（2026-08-11）**：阶段 0 ✅ 已完成、阶段 1 ✅ 已完成、阶段 2 ✅ 已完成、阶段 3 ✅ 已完成。
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
- GPU 启用要点（2026-08-11 已回退 CPU，以下仅作历史记录）：genie_tts.ModelManager
  硬编码 CPU provider，需在服务器启动前改为 `CUDAExecutionProvider`；Windows 下还需
  先把 `site-packages\nvidia\*\bin` 加入 DLL 搜索路径。
- **推理已改回 CPU（2026-08-11，用户决定）**：`genie.useGpu=false`；
  onnxruntime-gpu 1.22.0 与 nvidia CUDA/cuDNN 运行时已卸载，恢复
  onnxruntime 1.22.1（CPU，genie-tts 锁定版本），不再占用显存。
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
  高松灯与 诗歌剧 的 mp3 参考音频已用 ffmpeg 转为 wav（Genie 不接受 mp3）。

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
- 首批转换对象：樱羽艾玛（ema）、二阶堂希罗（hiro）、高松灯（当时目录名 MyGO，
  阶段 2 已更名为 tomori）、诗歌剧、橘雪莉（sherry）。

### 阶段 2：配置结构改造 ✅ 已完成（2026-08-11）

执行结果摘要：

- `config/config.json`（及 `config.example.json`、`src/config.js` 默认值）已改造：
  - 每个角色新增 `characterName` / `onnxModelDir` / `language` 字段，
    `refAudio` 统一指向转换后的 `CharacterModels/<角色>/prompt_wav/` 文件。
  - `gptSoVits` 配置块替换为 `genie` 块（host/port、autoStart、startScript、
    preloadRoles、maxCachedCharacters、useGpu），旧 `params`（gpt/sovits 路径）保留作回滚。
  - `tts.baseUrl` 改为 `http://127.0.0.1:8000`。
- **角色更名**：高松灯的 `characterName` / 目录由 `MyGO` 改为 `tomori`，
  F 盘目录、`config.json`、`convert_to_onnx.py`、阶段 1 记录已同步。
- **合成语言**：`tts.textLang` 当前锁定为 `"zh"`（中文）。
  已为后续预留：每个角色保留 `language` 字段（当前均为 `jp`，匹配模型与参考音频），
  后续可支持 `textLang: "jp"`（日语）与混合语言（见风险 5）。

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
  ema / hiro / tomori / 诗歌剧 / sherry（ONNX 文件位于 `<角色>/tts_models`）。
- 参考音频一律使用 `prompt_wav/` 下的文件（mp3 已转 wav），不要再指向源 mp3。
- `tts` 配置改为 Genie 服务器地址，例如 `baseUrl: http://127.0.0.1:8000`。
- `gptSoVits` 相关配置改为 `genie` 配置：服务器端口、启动脚本/命令、角色预加载开关。
- `textLang` 决策：当前锁定 `"zh"`；后续取值 `"jp"` 或混合模式。注意 Genie 的
  `normalize_language` 只认 `zh` / `jp` / `en`，没有 `auto` / `mix`，
  中日混合文本需要中间件侧分句检测后决定交给哪个角色（阶段 3 预留该能力）。

### 阶段 3：TTS 引擎适配 ✅ 已完成（2026-08-11）

执行结果摘要：

- `src/tts.js` 已改造为 Genie 客户端：`load_character -> set_reference_audio -> /tts`，
  合成 body 为 `{ character_name, text, split_sentence: true }`（可经 `tts.params` 覆盖），
  音频流用 `Readable.fromWeb` 直接交给播放队列。
- 支持预加载（`preloadAll`）、按需加载（`preloadRoles: false`）与空闲卸载
  （`idleTimeoutMs` 到期后 `POST /unload_character`）。
- `set_gpt_weights` / `set_sovits_weights` 相关逻辑已从 `tts.js`、`api.js`、`index.js` 移除。
- **发现并修复 genie-tts 2.0.2 的 `LRUCacheDict` bug**：其继承 `OrderedDict` 并重写
  `__getitem__`，而 `OrderedDict.popitem` 的 C 实现会经 `self[key]` 取值，容量不足触发
  淘汰时抛 `KeyError` 并损坏内部状态（表现为多角色预加载后合成报 `KeyError: '<上一个角色>'`
  并导致服务器进程退出）。修复位于 `scripts/start_genie_server.py` 的 `_apply_lru_fix()`，
  用独立 `OrderedDict` 实现等价 LRU。
- **端到端验证通过**：中间件预加载 5 角色完成；5 个角色各触发一次合成，
  Genie 侧 5 条 `POST /tts 200`，无 KeyError / 加载失败 / “Missing model”。
  该验证在 GPU 推理下完成；推理改回 CPU 后已用 hiro 角色复测合成成功（约 4 秒音频）。
- 遗留（属阶段 5）：当前 `ffplay -i -` 按 WAV 头播放裸 PCM 会卡住，实测已确认，
  阶段 5 必须改为 `-f s16le -ar 32000 -ac 1 -` 或在中间件补 WAV 头。

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
- **推理方式（2026-08-11 修订）**：已改回 CPU 推理（`genie.useGpu=false`），
  显存不再是瓶颈；多角色预加载改为评估内存（RAM）占用。
  阶段 4 仍建议“仅缓存 1 个角色（`Max_Cached_Character_Models=1`）+ 按需加载/卸载”，
  是否扩大缓存容量需以 CPU 实测内存为准。
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
  不能沿用当前 `ffplay -i -`（阶段 3 实测：`ffplay -i -` 遇到裸 PCM 会一直卡住；
  验证脚本已演示客户端补头写法）。
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
2. 多角色同时加载的内存占用是否可接受。→ ⚠️ 待实测：推理已改回 CPU，
   显存不再是瓶颈，改为评估 RAM 占用。LRU bug 修复后 `maxCachedCharacters=1`
   可正常工作，切换角色会触发服务端自动重载（GPU 时约 8–23 秒，CPU 待实测）；
   阶段 4 需定策略（默认角色常驻 + 其余按需，或按内存实测放宽缓存容量）。
3. `/tts` 返回格式（WAV 头 / 裸 PCM）和采样率。→ ✅ 已解决：裸 PCM，32000 Hz / 单声道 / 16bit。
4. 是否有健康检查接口，现有“启动前探测”需要适配。→ ✅ 已解决：无健康检查接口，用 TCP 探测。
5. Genie 是否支持中日文混合文本自动识别；若不支持，需要为 `zh` 和 `jp` 分别准备角色。
   → 已确认 Genie 仅支持 `zh` / `jp` / `en`，无 `auto` / `mix`；当前 `textLang` 锁定 `zh`，
   日语与中日混合支持在阶段 3 中间件侧按句检测实现（配置字段已预留）。
6. 热重载角色配置时，已加载角色是否需要重新 `load_character` / `set_reference_audio`。→ 待阶段 2 实现时确认。
7. 参考音频是否必须为 5 秒左右；现有角色的 `.ogg` / `.mp3` 格式与时长是否需要统一转换。
   → ✅ 已确认：时长 3.3–7.4 秒均可正常合成；`.mp3` 必须转 `.wav`（已转换），其余保持原格式。
8. 项目内虚拟环境体积较大（尤其 torch 与 genie-tts），需预留磁盘空间，并避免将其纳入备份、同步或版本库。
   → ✅ 已处理：`.venv-genie/`、`.pip-cache/`、`GenieData/` 均已加入 `.gitignore`。
